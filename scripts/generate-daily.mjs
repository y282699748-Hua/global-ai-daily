import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
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

  validateIssue(issue, candidates);
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

  const shortlist = [...unique.values()].slice(0, 12).map(({ score, ...candidate }) => candidate);
  const candidates = await Promise.all(shortlist.map(enrichCandidate));
  return { candidates, failures };
}

async function enrichCandidate(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
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
    const scope = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
      || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
      || html;
    const blocks = [...scope.matchAll(/<(?:p|li)\b[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)]
      .map((match) => cleanText(match[1]))
      .filter((text) => text.length >= 40);
    const combinedSource = [candidate.summary, metaDescription, ...blocks].filter(Boolean).join(" ");
    const evidence = extractEvidenceSnippets(combinedSource).join(" ").slice(0, 1600);
    const selectedBlocks = [...new Set([...blocks.slice(0, 6), ...blocks.filter(hasQuantitativeEvidence).slice(0, 6)])];
    const evidenceText = selectedBlocks.join(" ");
    const enriched = [...new Set([evidence, candidate.summary, metaDescription, evidenceText].filter(Boolean))].join(" ").slice(0, 3600);
    return enriched ? { ...candidate, summary: enriched, evidence } : candidate;
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
  const selectedCandidates = await selectCandidatesWithLocalModel(candidates, coverageDate);
  const items = [];
  for (const [index, candidate] of selectedCandidates.entries()) {
    try {
      items.push(await createItemWithLocalModel(candidate, coverageDate, index + 1));
    } catch (error) {
      console.warn(`跳过连续未通过质量检查的候选：${candidate.title}（${conciseError(error)}）`);
    }
  }
  return items;
}

async function selectCandidatesWithLocalModel(candidates, coverageDate, attempt = 1) {
  const compactCandidates = candidates.map((candidate, index) => ({
    id: index + 1,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    source: candidate.sourceLabel,
    excerpt: candidate.summary.slice(0, 900)
  }));
  const prompt = `/no_think
你是“全球 AI 资讯日报”的选题编辑。候选内容来自官方博客、研究机构和 arXiv，日期与 ${coverageDate} 相符。
只完成选题，不撰写日报：选择 0–5 条真正重要的 AI 技术进展，并按重要性、技术先进性和行业影响从高到低排列。优先模型与算法突破、智能体、训练/推理系统、芯片与基础设施、AI 安全、开放标准及高可信研究；排除普通营销、融资、观点文章和没有技术增量的内容。
只返回合法 JSON：{"selected":[候选 id]}
候选内容：
${JSON.stringify(compactCandidates)}`.trim();

  try {
    const parsed = await requestJsonFromLocalModel(prompt, { temperature: 0.05, maxTokens: 300 });
    if (!Array.isArray(parsed.selected)) throw new Error("选题结果缺少 selected 数组。");
    const ids = [...new Set(parsed.selected.map(Number))];
    if (ids.length > 5 || ids.some((id) => !Number.isInteger(id) || id < 1 || id > candidates.length)) {
      throw new Error("选题结果包含无效候选编号。");
    }
    return ids.map((id) => candidates[id - 1]);
  } catch (error) {
    if (attempt < 2) {
      console.warn(`选题输出无效，正在重试：${conciseError(error)}`);
      return selectCandidatesWithLocalModel(candidates, coverageDate, attempt + 1);
    }
    throw error;
  }
}

async function createItemWithLocalModel(candidate, coverageDate, rank, attempt = 1) {
  const retryWarning = attempt > 1
    ? "\n重要纠错：上一次输出未通过质量检查。summary 必须达到规定的信息量，并保留材料中的关键数字、适用条件和限制；explanation 必须换成日常表达，不能照抄总结。\n"
    : "";
  const prompt = `/no_think
你是“全球 AI 资讯日报”的中文科技编辑。请把下面第 ${rank} 条入选资讯写成一条日报，只能使用给定材料，不得增加材料中没有的事实或数字。
1. category、title、summary、explanation 全部使用简体中文；产品名可以保留原文，但不要输出完整英文句子。
2. summary 写成 120–220 个中文字符、2–4 句，说明技术机制或主要变化、重要性以及适用条件或限制。
3. 材料含百分比、参数规模、基准成绩、成本、速度、数据规模或覆盖范围时，至少保留一个最重要的阿拉伯数字及其单位；厂商自报结果写明“官方称”或“仍需独立验证”。材料没有可靠量化结果时，明确说明“原文未给出可比较的量化结果”，绝不编造。
4. explanation 面向不了解 AI 的读者，用日常语言或恰当类比简短解释核心意义，不能复制、缩写或轻微改写 summary。
5. 只返回合法 JSON，不要 Markdown：{"item":{"category":"分类","title":"标题","summary":"总结","explanation":"通俗解释"}}
${retryWarning}
材料：
${JSON.stringify({
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    source: candidate.sourceLabel,
    url: candidate.url,
    quantitativeEvidence: candidate.evidence || "原文未提取到明确量化信息",
    excerpt: candidate.summary.slice(0, 1800)
  })}`.trim();

  try {
    const parsed = await requestJsonFromLocalModel(prompt, {
      temperature: attempt === 1 ? 0.15 : 0.05,
      maxTokens: 1400
    });
    const rawItem = parsed.item || parsed.items?.[0];
    if (!rawItem || typeof rawItem !== "object") throw new Error("模型返回结果缺少 item 对象。");
    const item = {
      category: String(rawItem.category || "").trim(),
      title: String(rawItem.title || "").trim(),
      summary: String(rawItem.summary || "").trim(),
      explanation: String(rawItem.explanation || "").trim(),
      sources: [{ label: candidate.sourceLabel, url: candidate.url }]
    };
    const sourceLookup = new Map([[canonicalUrl(candidate.url), candidate]]);
    const qualityProblems = [
      ...findChineseLanguageProblems([item]),
      ...findEditorialQualityProblems([item]),
      ...findEvidenceCoverageProblems([item], sourceLookup)
    ];
    if (qualityProblems.length) throw new Error(qualityProblems.join("；"));
    return item;
  } catch (error) {
    if (attempt < 3) {
      console.warn(`第 ${rank} 条未通过质量检查，正在进行第 ${attempt + 1} 次生成：${conciseError(error)}`);
      return createItemWithLocalModel(candidate, coverageDate, rank, attempt + 1);
    }
    throw new Error(`第 ${rank} 条连续 3 次未通过质量检查：${conciseError(error)}`);
  }
}

async function requestJsonFromLocalModel(prompt, { temperature, maxTokens }) {
  const body = {
    model: "Qwen3-4B-Q4_K_M.gguf",
    messages: [
      { role: "system", content: "你是严谨的中文科技编辑。只使用给定证据，输出合法 JSON。" },
      { role: "user", content: prompt }
    ],
    temperature,
    max_tokens: maxTokens,
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
  return JSON.parse(extractJsonObject(content));
}
function requestLocalInference(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const endpoint = new URL(localLlmUrl);
    const request = http.request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 5 * 60 * 1000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text)
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("本地开源模型单批推理超过 5 分钟。")));
    request.on("error", reject);
    request.end(payload);
  });
}

function extractJsonObject(content) {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?|```/gi, "").trim();
  const start = withoutThink.indexOf("{");
  const end = withoutThink.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型返回内容不包含 JSON 对象。");
  return withoutThink.slice(start, end + 1);
}

function findChineseLanguageProblems(items) {
  const requirements = {
    category: { minHan: 2, minShare: 0.5 },
    title: { minHan: 4, minShare: 0.2 },
    summary: { minHan: 12, minShare: 0.35 },
    explanation: { minHan: 10, minShare: 0.35 }
  };
  const problems = [];
  for (const [index, item] of items.entries()) {
    for (const [key, requirement] of Object.entries(requirements)) {
      const value = String(item[key] || "");
      const han = (value.match(/\p{Script=Han}/gu) || []).length;
      const latin = (value.match(/[A-Za-z]/g) || []).length;
      const share = han / Math.max(1, han + latin);
      if (han < requirement.minHan || share < requirement.minShare) {
        problems.push(`第 ${index + 1} 条 ${key} 不是以中文为主`);
      }
    }
  }
  return problems;
}

function findEditorialQualityProblems(items) {
  const problems = [];
  for (const [index, item] of items.entries()) {
    const summary = normalizeReaderText(item.summary);
    const explanation = normalizeReaderText(item.explanation);
    const similarity = textSimilarity(summary, explanation);
    if (summary.length < 90) {
      problems.push(`第 ${index + 1} 条总结信息量不足`);
    }
    if (summary.length > 260) {
      problems.push(`第 ${index + 1} 条总结过长`);
    }
    if (summary && explanation && (summary === explanation || similarity >= 0.72)) {
      problems.push(`第 ${index + 1} 条通俗解释与总结相同或过于相似`);
    }
    if (summary && explanation.length > summary.length * 1.35) {
      problems.push(`第 ${index + 1} 条通俗解释不够简洁`);
    }
  }
  return problems;
}

function findEvidenceCoverageProblems(items, sourceLookup) {
  if (!sourceLookup) return [];
  const problems = [];
  for (const [index, item] of items.entries()) {
    const sourceTexts = (item.sources || [])
      .map((source) => {
        const candidate = sourceLookup.get(canonicalUrl(source.url));
        return candidate ? `${candidate.evidence || ""} ${candidate.summary || ""}` : "";
      })
      .filter(Boolean);
    const evidenceNumbers = new Set(sourceTexts.flatMap(extractEvidenceNumbers));
    const summaryNumbers = new Set(extractEvidenceNumbers(item.summary));
    if (evidenceNumbers.size && ![...summaryNumbers].some((value) => evidenceNumbers.has(value))) {
      problems.push(`第 ${index + 1} 条遗漏了来源中的关键量化数据`);
      continue;
    }
    if (!evidenceNumbers.size && sourceTexts.some(hasWrittenScale) && !hasQuantitativeEvidence(item.summary)) {
      problems.push(`第 ${index + 1} 条遗漏了来源中的数据规模或覆盖范围`);
    }
  }
  return problems;
}

function extractEvidenceSnippets(text = "") {
  const sentences = String(text).match(/[^.!?。！？;；]+[.!?。！？;；]?/gu) || [];
  return [...new Set(sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 25 && hasQuantitativeEvidence(sentence)))].slice(0, 6);
}

function hasQuantitativeEvidence(text = "") {
  return extractEvidenceNumbers(text).length > 0 || hasWrittenScale(text);
}

function hasWrittenScale(text = "") {
  return /\b(?:hundreds? of )?(?:billions?|millions?|thousands?)\b|数十亿|数亿|数百万|数十万|数万|数千|数百/iu.test(String(text));
}

function extractEvidenceNumbers(text = "") {
  const value = String(text);
  const numbers = [];
  for (const match of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = match[0];
    const numeric = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(numeric)) continue;
    if (numeric >= 2000 && numeric <= 2099 && raw.length === 4) continue;
    const before = value.slice(Math.max(0, match.index - 12), match.index);
    const after = value.slice(match.index + raw.length, match.index + raw.length + 24);
    const unitText = after.replace(/^\s*(?:[-–—]\s*)?/, "").toLowerCase();
    const hasUnit = /[$€£¥￥]\s*$/u.test(before)
      || /^(?:%|％|x|×|[kmb]\b|billions?|millions?|thousands?|千|万|亿|百|百万|十亿|参数|tokens?|queries|images?|videos?|samples?|actions?|cameras?|hz|fps|ms|s\b|meters?|m\b|gb|tb|美元|次|项|个|张|段|小时)/iu.test(unitText);
    if (hasUnit || numeric >= 10 || raw.includes(".") || raw.includes(",")) {
      numbers.push(String(numeric));
      const factor = /^(?:billions?|b\b|十亿)/iu.test(unitText) ? 1e9
        : /^(?:millions?|m\b|百万)/iu.test(unitText) ? 1e6
          : /^(?:thousands?|k\b|千)/iu.test(unitText) ? 1e3
            : /^亿/u.test(unitText) ? 1e8
              : /^万/u.test(unitText) ? 1e4
                : 1;
      if (factor > 1) numbers.push(String(numeric * factor));
    }
  }
  return [...new Set(numbers)];
}

function normalizeReaderText(value = "") {
  return String(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function textSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftPairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    leftPairs.set(pair, (leftPairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const remaining = leftPairs.get(pair) || 0;
    if (remaining > 0) {
      overlap += 1;
      leftPairs.set(pair, remaining - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
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

}

function validateIssue(issue, candidates = null) {
  const allowedSources = Array.isArray(candidates)
    ? new Map(candidates.map((candidate) => [canonicalUrl(candidate.url), candidate]))
    : null;
  if (!Array.isArray(issue.items) || issue.items.length > 5) {
    throw new Error("生成结果必须包含 0–5 条日报。");
  }
  const seenUrls = new Set();
  const languageProblems = findChineseLanguageProblems(issue.items);
  if (languageProblems.length) {
    throw new Error(`生成结果必须使用简体中文：${languageProblems.join("；")}`);
  }
  const editorialProblems = [
    ...findEditorialQualityProblems(issue.items),
    ...findEvidenceCoverageProblems(issue.items, allowedSources)
  ];
  if (editorialProblems.length) {
    throw new Error(`生成结果未通过编辑质量检查：${editorialProblems.join("；")}`);
  }
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
      if (allowedSources && !allowedSources.has(url)) throw new Error(`第 ${index + 1} 条存在候选列表之外的来源。`);
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
  const chineseItem = [{
    category: "智能体",
    title: "开源智能体训练框架取得新进展",
    summary: "研究团队发布了面向复杂任务的开源智能体训练框架。该框架统一任务环境、训练流程和评测接口，可用于软件工程及网页操作等场景。官方测试显示核心基准达到 69.7%，但结果来自项目方披露，仍需在更多任务和独立环境中验证。",
    explanation: "可以把它理解成一套帮助智能体练习和考试的通用工具。"
  }];
  if (findChineseLanguageProblems(chineseItem).length) throw new Error("自检失败：中文内容被错误拒绝。");
  if (findEditorialQualityProblems(chineseItem).length) throw new Error("自检失败：合格的通俗解释被错误拒绝。");
  const duplicatedExplanation = [{ ...chineseItem[0], explanation: chineseItem[0].summary }];
  if (!findEditorialQualityProblems(duplicatedExplanation).length) throw new Error("自检失败：重复总结的解释未被拒绝。");
  const lightlyRewordedExplanation = [{ ...chineseItem[0], explanation: chineseItem[0].summary.replace("统一", "整合") }];
  if (!findEditorialQualityProblems(lightlyRewordedExplanation).some((problem) => problem.includes("过于相似"))) throw new Error("自检失败：轻微改写总结的解释未被拒绝。");
  const evidenceUrl = "https://example.com/evidence";
  const evidenceSources = new Map([[evidenceUrl, { summary: "Official benchmark score reached 69.7% with 3 billion active parameters." }]]);
  const evidenceItem = [{ ...chineseItem[0], sources: [{ label: "Fixture", url: evidenceUrl }] }];
  if (findEvidenceCoverageProblems(evidenceItem, evidenceSources).length) throw new Error("自检失败：已保留的数据被错误判定为遗漏。");
  const missingEvidenceItem = [{ ...evidenceItem[0], summary: evidenceItem[0].summary.replace("69.7%", "较好成绩") }];
  if (!findEvidenceCoverageProblems(missingEvidenceItem, evidenceSources).length) throw new Error("自检失败：来源中的关键数据遗漏后未被拒绝。");
  const scaledEvidenceSources = new Map([[evidenceUrl, { summary: "The dataset contains 2 billion tokens." }]]);
  const scaledEvidenceItem = [{ ...evidenceItem[0], summary: evidenceItem[0].summary.replace("69.7%", "20 亿个 token") }];
  if (findEvidenceCoverageProblems(scaledEvidenceItem, scaledEvidenceSources).length) throw new Error("自检失败：中英文单位换算后的数据未被识别。");
  const englishItem = [{
    category: "Agent",
    title: "An open framework for scalable agentic AI",
    summary: "The research team released an open framework for training and evaluating agents.",
    explanation: "It helps researchers build agents more efficiently."
  }];
  if (!findChineseLanguageProblems(englishItem).length) throw new Error("自检失败：英文内容未被拒绝。");
  console.log("generate-daily.mjs 自检通过。");
}
