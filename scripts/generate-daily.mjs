import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requestedDate = process.argv.find((arg) => arg.startsWith("--date="))?.split("=")[1];
const issueDate = requestedDate || todayInShanghai();
const coverageDate = shiftDate(issueDate, -1);
const collectOnly = process.argv.includes("--collect-only");
const selfTest = process.argv.includes("--self-test");
const prepareLocal = process.argv.includes("--prepare-local");
const finalizeLocal = process.argv.includes("--finalize-local");
const localLlmUrl = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8080/v1/chat/completions";
const workDir = path.join(root, ".daily-work");
const requestPath = path.join(workDir, "request.json");

const NEWS_SOURCES = [
  { label: "OpenAI News", url: "https://openai.com/news/rss.xml", authority: 10, kind: "official" },
  { label: "Google AI", url: "https://blog.google/technology/ai/rss/", authority: 10, kind: "official" },
  { label: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", authority: 10, kind: "research" },
  { label: "Apple Machine Learning Research", url: "https://machinelearning.apple.com/rss.xml", authority: 9, kind: "research" },
  { label: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/", authority: 9, kind: "research" },
  { label: "NVIDIA Technical Blog", url: "https://developer.nvidia.com/blog/feed/", authority: 9, kind: "official" },
  { label: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", authority: 9, kind: "official" },
  { label: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/", authority: 8, kind: "official" },
  { label: "GitHub AI & ML", url: "https://github.blog/ai-and-ml/feed/", authority: 8, kind: "official" },
  { label: "Meta AI Research", url: "https://engineering.fb.com/category/ai-research/feed/", authority: 9, kind: "research" },
  {
    label: "arXiv AI/ML/CL/CV",
    url: "https://export.arxiv.org/api/query?search_query=cat%3Acs.AI%20OR%20cat%3Acs.LG%20OR%20cat%3Acs.CL%20OR%20cat%3Acs.CV&start=0&max_results=75&sortBy=submittedDate&sortOrder=descending",
    authority: 6,
    kind: "research"
  }
];

if (selfTest) {
  runSelfTest();
} else if (prepareLocal) {
  await prepareForLocalModel();
} else if (finalizeLocal) {
  await finalizeWithLocalModel();
} else {
  await main();
}

async function main() {
  const candidates = await collectDailyCandidates();
  if (collectOnly) return;
  const items = candidates.length ? await createDigestWithLocalModel({ candidates, coverageDate }) : [];
  await finalizeIssue(items, candidates, "Qwen3-4B 本地开源模型");
}

async function prepareForLocalModel() {
  const candidates = await collectDailyCandidates();
  if (collectOnly) return;
  await mkdir(workDir, { recursive: true });
  await writeFile(requestPath, `${JSON.stringify({ issueDate, coverageDate, candidates }, null, 2)}\n`, "utf8");
  if (!candidates.length) await finalizeIssue([], candidates, "未调用模型");
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `has_candidates=${candidates.length ? "true" : "false"}\n`, "utf8");
  }
  console.log(candidates.length ? "候选内容已准备，等待本地开源模型生成。" : "没有候选内容，已生成空日报。 ");
}

async function finalizeWithLocalModel() {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  if (!Array.isArray(request.candidates) || !request.candidates.length) {
    throw new Error("本地模型请求文件不存在候选内容。");
  }
  const items = await createDigestWithLocalModel(request);
  await finalizeIssue(items, request.candidates, "Qwen3-4B 本地开源模型");
}

async function collectDailyCandidates() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    throw new Error("--date 必须使用 YYYY-MM-DD 格式。");
  }

  const previouslyReportedUrls = await loadPreviouslyReportedUrls();
  const { candidates, failures } = await collectCandidates(coverageDate, previouslyReportedUrls);
  console.log(`已检查 ${NEWS_SOURCES.length} 个资讯源，找到 ${candidates.length} 条候选内容；${failures.length} 个源暂时不可用。`);
  failures.forEach((failure) => console.warn(`- ${failure.label}: ${failure.reason}`));

  if (collectOnly) {
    console.log(JSON.stringify({ issueDate, coverageDate, candidates, failures }, null, 2));
    return candidates;
  }
  return candidates;
}

async function finalizeIssue(items, candidates, model) {
  const issue = {
    date: issueDate,
    label: labelFor(issueDate),
    year: issueDate.slice(0, 4),
    coverageDate,
    coverageLabel: labelFor(coverageDate),
    items
  };

  validateIssue(issue, new Set(candidates.map((candidate) => canonicalUrl(candidate.url))));
  await writeOutputs(issue);
  console.log(`已生成 ${issue.label} 日报，共 ${issue.items.length} 条，模型：${model}。`);
}

async function collectCandidates(targetDate, previouslyReportedUrls) {
  const settled = await Promise.allSettled(NEWS_SOURCES.map((source) => fetchFeed(source)));
  const failures = [];
  const all = [];

  settled.forEach((result, index) => {
    const source = NEWS_SOURCES[index];
    if (result.status === "rejected") {
      failures.push({ label: source.label, reason: conciseError(result.reason) });
      return;
    }
    for (const entry of result.value) {
      if (!matchesCoverageDate(entry.publishedAt, targetDate)) continue;
      if (!isPotentiallyTechnical(entry, source)) continue;
      if (previouslyReportedUrls.has(canonicalUrl(entry.url))) continue;
      all.push({ ...entry, score: scoreCandidate(entry, source) });
    }
  });

  const unique = new Map();
  for (const candidate of all.sort((a, b) => b.score - a.score)) {
    const key = canonicalUrl(candidate.url) || normalizeTitle(candidate.title);
    if (!unique.has(key)) unique.set(key, candidate);
  }

  const shortlist = [...unique.values()].slice(0, 18).map(({ score, ...candidate }) => candidate);
  const candidates = await Promise.all(shortlist.map(enrichCandidate));
  return { candidates, failures };
}

async function enrichCandidate(candidate) {
  if (candidate.summary.length >= 120) return candidate;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(candidate.url, {
      headers: { "User-Agent": "global-ai-daily/1.0 (+https://github.com/y282699748-Hua/global-ai-daily)" },
      signal: controller.signal
    });
    if (!response.ok) return candidate;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html")) return candidate;
    const html = await response.text();
    const metaDescription = extractMetaDescription(html);
    const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || "";
    const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => cleanText(match[1]))
      .filter((text) => text.length >= 40)
      .slice(0, 3)
      .join(" ");
    const summary = (metaDescription || paragraphs).slice(0, 1800);
    return summary ? { ...candidate, summary } : candidate;
  } catch {
    return candidate;
  } finally {
    clearTimeout(timer);
  }
}

function extractMetaDescription(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!["description", "og:description", "twitter:description"].includes(name)) continue;
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (content) return cleanText(content);
  }
  return "";
}

async function fetchFeed(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(source.url, {
      headers: {
        "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.2",
        "User-Agent": "global-ai-daily/1.0 (+https://github.com/y282699748-Hua/global-ai-daily)"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const entries = parseFeed(xml, source);
    if (!entries.length) throw new Error("未识别到 RSS/Atom 条目");
    return entries;
  } finally {
    clearTimeout(timer);
  }
}

function parseFeed(xml, source) {
  const blocks = [...extractBlocks(xml, "item"), ...extractBlocks(xml, "entry")];
  return blocks.map((block) => {
    const title = cleanText(firstTag(block, ["title"]));
    const publishedAt = cleanText(firstTag(block, ["published", "updated", "pubDate", "dc:date", "date"]));
    const summary = cleanText(firstTag(block, ["summary", "description", "content:encoded", "content"])).slice(0, 1800);
    const url = extractLink(block);
    return {
      title,
      summary,
      url,
      publishedAt,
      sourceLabel: source.label,
      sourceKind: source.kind,
      sourceAuthority: source.authority
    };
  }).filter((entry) => entry.title && /^https?:\/\//.test(entry.url) && entry.publishedAt);
}

function extractBlocks(xml, tag) {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...xml.matchAll(expression)].map((match) => match[1]);
}

function firstTag(block, tags) {
  for (const tag of tags) {
    const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = block.match(expression);
    if (match) return match[1];
  }
  return "";
}

function extractLink(block) {
  const atomAlternate = block.match(/<link\b(?=[^>]*\b(?:rel=["']alternate["']|type=["']text\/html["']))[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i);
  const atomAny = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i);
  const rssLink = firstTag(block, ["link"]);
  const guid = firstTag(block, ["guid"]);
  return decodeEntities((atomAlternate?.[1] || atomAny?.[1] || cleanText(rssLink) || cleanText(guid)).trim());
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value = "") {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“"
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function matchesCoverageDate(rawDate, targetDate) {
  const literal = rawDate.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (literal) return literal === targetDate;
  const instant = new Date(rawDate);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === targetDate;
}

function formatDateInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isPotentiallyTechnical(entry, source) {
  if (source.kind === "research") return true;
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  const include = /\b(model|algorithm|agent|inference|training|benchmark|architecture|multimodal|robot|reasoning|chip|gpu|accelerator|open[ -]?source|framework|protocol|safety|alignment|eval|dataset|research|paper|weights|context|token|memory|compiler)\b/;
  const exclude = /\b(podcast|webinar|event recap|hiring|job opening|customer story|partner spotlight|weekly roundup)\b/;
  return include.test(text) && !exclude.test(text);
}

function scoreCandidate(entry, source) {
  const title = entry.title.toLowerCase();
  const text = `${entry.title} ${entry.summary}`.toLowerCase();
  let score = source.authority * 10;
  const signals = [
    [18, /\b(release|released|launch|launched|introduc|announce|open[ -]?source)\w*\b/],
    [16, /\b(model|architecture|algorithm|framework|protocol|chip|accelerator)\b/],
    [12, /\b(agent|inference|training|benchmark|multimodal|robot|safety|alignment|reasoning)\w*\b/],
    [8, /\b(state[- ]of[- ]the[- ]art|sota|first|new)\b/]
  ];
  for (const [weight, pattern] of signals) if (pattern.test(text)) score += weight;
  if (/\b(podcast|webinar|recap|opinion|interview|newsletter)\b/.test(title)) score -= 45;
  if (entry.summary.length < 80) score -= 8;
  return score;
}

async function createDigestWithLocalModel({ candidates, coverageDate }) {
  const allowedSources = new Map(candidates.map((candidate) => [canonicalUrl(candidate.url), candidate]));
  const compactCandidates = candidates.map((candidate, index) => ({
    id: index + 1,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    source: candidate.sourceLabel,
    url: candidate.url,
    excerpt: candidate.summary.slice(0, 1200)
  }));
  const prompt = `/no_think
你是“全球 AI 资讯日报”的主编。下面是从官方博客、研究机构和 arXiv RSS/Atom 中抓取、日期与 ${coverageDate} 相符的候选内容。

请严格只依据候选内容工作：
1. 选择 0–5 条真正重要的 AI 技术进展，按重要性、技术先进性和行业影响从高到低排序；宁缺毋滥。
2. 优先模型与算法突破、智能体、训练/推理系统、芯片与基础设施、AI 安全、开放标准及高可信研究。
3. 排除普通营销、融资、观点文章、活动预告和没有技术增量的内容。
4. 不得增加候选内容没有提供的事实、数字或 URL；厂商自报结果须明确写成“官方称”或“尚待独立验证”。
5. summary 用简洁中文说明“发生了什么、为什么重要、有什么限制”；explanation 用更通俗、尽量简短的中文解释。
6. 每条 sources 至少一个来源，url 必须原样复制候选内容中的 URL，label 使用对应来源名称。
7. 只返回合法 JSON，不要 Markdown，不要前后说明。格式如下：
{"items":[{"category":"分类","title":"标题","summary":"总结","explanation":"通俗解释","sources":[{"label":"来源名称","url":"候选 URL"}]}]}

候选内容：
${JSON.stringify(compactCandidates)}
`.trim();

  const body = {
    model: "Qwen3-4B-Q4_K_M.gguf",
    messages: [
      { role: "system", content: "你是严谨的中文科技编辑。只使用给定证据，输出合法 JSON。" },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  let response = await requestLocalInference(body);
  if (!response.ok && [400, 422].includes(response.status)) {
    const firstError = await response.text();
    console.warn(`模型不接受 JSON 输出参数，改用纯提示重试：${firstError.slice(0, 300)}`);
    const { response_format, ...compatibleBody } = body;
    response = await requestLocalInference(compatibleBody);
  }
  if (!response.ok) {
    throw new Error(`本地开源模型推理失败（${response.status}）：${await response.text()}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("本地开源模型未返回可解析的正文。");
  const parsed = JSON.parse(extractJsonObject(content));
  if (!Array.isArray(parsed.items)) throw new Error("本地开源模型返回结果缺少 items 数组。");

  return parsed.items.map((item, index) => {
    const sources = (item.sources || []).map((source) => {
      const candidate = allowedSources.get(canonicalUrl(source.url));
      if (!candidate) throw new Error(`第 ${index + 1} 条引用了候选列表之外的来源：${source.url}`);
      return { label: candidate.sourceLabel, url: candidate.url };
    });
    return {
      category: String(item.category || "").trim(),
      title: String(item.title || "").trim(),
      summary: String(item.summary || "").trim(),
      explanation: String(item.explanation || "").trim(),
      sources
    };
  });
}

function requestLocalInference(body) {
  return fetch(localLlmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function extractJsonObject(content) {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?|```/gi, "").trim();
  const start = withoutThink.indexOf("{");
  const end = withoutThink.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型返回内容不包含 JSON 对象。");
  return withoutThink.slice(start, end + 1);
}

async function loadPreviouslyReportedUrls() {
  const issueDir = path.join(root, "public", "data", "issues");
  const urls = new Set();
  try {
    const files = (await readdir(issueDir)).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      const issue = JSON.parse(await readFile(path.join(issueDir, file), "utf8"));
      for (const item of issue.items || []) {
        for (const source of item.sources || []) urls.add(canonicalUrl(source.url));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return urls;
}

async function writeOutputs(issue) {
  const publicIssueDir = path.join(root, "public", "data", "issues");
  const siteIssueDir = path.join(root, "site", "data", "issues");
  await Promise.all([mkdir(publicIssueDir, { recursive: true }), mkdir(siteIssueDir, { recursive: true })]);

  const issueJson = `${JSON.stringify(issue, null, 2)}\n`;
  const issueName = `${issue.date}.json`;
  await Promise.all([
    writeFile(path.join(publicIssueDir, issueName), issueJson, "utf8"),
    writeFile(path.join(siteIssueDir, issueName), issueJson, "utf8")
  ]);

  const indexPath = path.join(root, "public", "data", "index.json");
  const currentIndex = JSON.parse(await readFile(indexPath, "utf8"));
  const entry = {
    date: issue.date,
    label: issue.label,
    month: `${issue.date.slice(0, 4)}.${issue.date.slice(5, 7)}`,
    file: `data/issues/${issueName}`,
    count: issue.items.length
  };
  const issues = [entry, ...currentIndex.issues.filter((item) => item.date !== issue.date)]
    .sort((a, b) => b.date.localeCompare(a.date));
  const nextIndex = { latest: issues[0].date, issues };
  const indexJson = `${JSON.stringify(nextIndex, null, 2)}\n`;
  await Promise.all([
    writeFile(indexPath, indexJson, "utf8"),
    writeFile(path.join(root, "site", "data", "index.json"), indexJson, "utf8")
  ]);

  const monthDir = path.join(root, `${issue.date.slice(0, 4)}.${issue.date.slice(5, 7)}`);
  await mkdir(monthDir, { recursive: true });
  await writeFile(path.join(monthDir, `${issue.label}.txt`), formatTxt(issue), "utf8");
}

function formatTxt(issue) {
  if (!issue.items.length) {
    return `${issue.label}（检索范围：${issue.coverageLabel}）\n\n经自动核验，未筛得在 ${issue.coverageDate} 发布、且由当前高可信资讯源可靠佐证的重大 AI 技术进展。本期不以旧闻、营销内容或未经证实的消息凑数。\n`;
  }
  const blocks = issue.items.map((item, index) => {
    const sources = item.sources
      .map((source, sourceIndex) => `${sourceIndex === 0 ? "来源" : "参考"}：${source.url}`)
      .join("\n");
    return `${index + 1}. ${item.title}\n\n${item.summary}\n\n通俗解释：${item.explanation}\n\n${sources}`;
  });
  return `${issue.label}（检索范围：${issue.coverageLabel}）\n\n${blocks.join("\n\n\n\n")}\n`;
}

function validateIssue(issue, allowedUrls = null) {
  if (!Array.isArray(issue.items) || issue.items.length > 5) {
    throw new Error("生成结果必须包含 0–5 条日报。");
  }
  const seenUrls = new Set();
  for (const [index, item] of issue.items.entries()) {
    for (const key of ["category", "title", "summary", "explanation"]) {
      if (typeof item[key] !== "string" || !item[key].trim()) {
        throw new Error(`第 ${index + 1} 条缺少 ${key}。`);
      }
    }
    if (!Array.isArray(item.sources) || !item.sources.length) {
      throw new Error(`第 ${index + 1} 条缺少来源。`);
    }
    for (const source of item.sources) {
      const url = canonicalUrl(source.url);
      if (!source.label || !/^https?:\/\//.test(source.url)) throw new Error(`第 ${index + 1} 条存在无效来源。`);
      if (allowedUrls && !allowedUrls.has(url)) throw new Error(`第 ${index + 1} 条存在候选列表之外的来源。`);
      if (seenUrls.has(url)) throw new Error(`第 ${index + 1} 条与前文重复引用同一进展。`);
      seenUrls.add(url);
    }
  }
}

function canonicalUrl(value = "") {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function normalizeTitle(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, "").slice(0, 120);
}

function conciseError(error) {
  if (error?.name === "AbortError") return "请求超时";
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 180);
}

function todayInShanghai() {
  return formatDateInZone(new Date(), "Asia/Shanghai");
}

function shiftDate(date, days) {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function labelFor(date) {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

function runSelfTest() {
  const fixture = `<?xml version="1.0"?><feed><entry><title>New multimodal model &amp; benchmark</title><published>2026-08-02T10:30:00Z</published><link rel="alternate" href="https://example.com/research?id=1&amp;utm_source=rss"/><summary><![CDATA[<p>A technical model release with a new benchmark.</p>]]></summary></entry></feed>`;
  const source = { label: "Fixture", url: "https://example.com/feed", authority: 10, kind: "research" };
  const entries = parseFeed(fixture, source);
  if (entries.length !== 1) throw new Error("自检失败：Atom 解析数量错误。");
  if (entries[0].title !== "New multimodal model & benchmark") throw new Error("自检失败：实体解码错误。");
  if (!matchesCoverageDate(entries[0].publishedAt, "2026-08-02")) throw new Error("自检失败：日期匹配错误。");
  if (canonicalUrl(entries[0].url) !== "https://example.com/research?id=1") throw new Error("自检失败：URL 规范化错误。");
  const txt = formatTxt({ label: "08.03", coverageLabel: "08.02", coverageDate: "2026-08-02", items: [] });
  if (!txt.includes("不以旧闻")) throw new Error("自检失败：空日报文本错误。");
  console.log("generate-daily.mjs 自检通过。");
}
