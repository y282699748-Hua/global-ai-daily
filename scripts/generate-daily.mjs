import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const requestedDate = process.argv.find((arg) => arg.startsWith("--date="))?.split("=")[1];
const issueDate = requestedDate || todayInShanghai();
const coverageDate = shiftDate(issueDate, -1);

if (!apiKey) {
  throw new Error("缺少 OPENAI_API_KEY。请在 GitHub 仓库的 Actions secrets 中配置该密钥。");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
  throw new Error("--date 必须使用 YYYY-MM-DD 格式。");
}

const prompt = `
你是“全球 AI 资讯日报”的主编。请使用网络检索，研究 ${coverageDate}（以各来源当地发布日期为准）全球范围内真正重要的 AI 技术进展。

选择标准：
1. 最多 5 条，宁缺毋滥；按重要性、技术先进性和行业影响从高到低排序。
2. 优先：模型与算法突破、智能体、训练/推理系统、芯片与基础设施、AI 安全、重要开放标准及高可信研究。
3. 排除：普通产品促销、融资传闻、重复报道、没有技术增量的观点文章。
4. 每条至少给出一个可直接访问的来源 URL；优先论文、官方技术博客、标准组织或公司公告。媒体报道只能用于补充。
5. 区分事实与厂商自述；尚未独立验证的基准、传闻或推断必须在 summary 中明确说明。
6. summary 用简洁中文说明“发生了什么、为什么重要、有什么限制”；explanation 用更通俗的中文解释，尽量简短。
7. 不要把来源放进 summary 或 explanation；来源只放在 sources 中。
8. 如果当天合格进展不足 5 条，只输出实际合格数量，不要凑数。
`.trim();

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "summary", "explanation", "sources"],
        properties: {
          category: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          explanation: { type: "string" },
          sources: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "url"],
              properties: {
                label: { type: "string" },
                url: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model,
    input: prompt,
    tools: [{ type: "web_search", search_context_size: "high" }],
    reasoning: { effort: "medium" },
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "global_ai_daily",
        strict: true,
        schema
      }
    },
    max_output_tokens: 7000
  })
});

if (!response.ok) {
  throw new Error(`OpenAI API 请求失败（${response.status}）：${await response.text()}`);
}

const payload = await response.json();
const outputText = extractOutputText(payload);
const generated = JSON.parse(outputText);
const issue = {
  date: issueDate,
  label: labelFor(issueDate),
  year: issueDate.slice(0, 4),
  coverageDate,
  coverageLabel: labelFor(coverageDate),
  items: generated.items
};

validateIssue(issue);
await writeOutputs(issue);
console.log(`已生成 ${issue.label} 日报，共 ${issue.items.length} 条，模型：${model}。`);

function extractOutputText(payload) {
  const parts = [];
  for (const item of payload.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  if (!parts.length) throw new Error("OpenAI API 未返回可解析的正文。");
  return parts.join("");
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
  const blocks = issue.items.map((item, index) => {
    const sources = item.sources
      .map((source, sourceIndex) => `${sourceIndex === 0 ? "来源" : "参考"}：${source.url}`)
      .join("\n");
    return `${index + 1}. ${item.title}\n\n${item.summary}\n\n通俗解释：${item.explanation}\n\n${sources}`;
  });
  return `${issue.label}（检索范围：${issue.coverageLabel}）\n\n${blocks.join("\n\n\n\n")}\n`;
}

function validateIssue(issue) {
  if (!Array.isArray(issue.items) || issue.items.length < 1 || issue.items.length > 5) {
    throw new Error("生成结果必须包含 1–5 条日报。");
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
      if (!source.label || !/^https?:\/\//.test(source.url)) {
        throw new Error(`第 ${index + 1} 条存在无效来源。`);
      }
    }
  }
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function labelFor(date) {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}
