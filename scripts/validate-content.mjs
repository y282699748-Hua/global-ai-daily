import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const issueDir = path.join(root, "public", "data", "issues");
const files = (await readdir(issueDir)).filter((name) => name.endsWith(".json"));

if (!files.length) throw new Error("没有找到日报 JSON 文件。");

for (const file of files) {
  const issue = JSON.parse(await readFile(path.join(issueDir, file), "utf8"));
  validateIssue(issue, file);
}

const index = JSON.parse(await readFile(path.join(root, "public", "data", "index.json"), "utf8"));
if (!index.latest || !Array.isArray(index.issues) || !index.issues.length) {
  throw new Error("日报索引缺少 latest 或 issues。");
}

console.log(`内容校验通过：${files.length} 期日报，最新一期 ${index.latest}。`);

function validateIssue(issue, file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue.date)) throw new Error(`${file}: date 格式错误。`);
  if (!/^\d{2}\.\d{2}$/.test(issue.label)) throw new Error(`${file}: label 格式错误。`);
  if (!Array.isArray(issue.items) || issue.items.length > 5) {
    throw new Error(`${file}: 每期必须包含 0–5 条内容。`);
  }

  issue.items.forEach((item, index) => {
    for (const key of ["category", "title", "summary", "explanation"]) {
      if (typeof item[key] !== "string" || !item[key].trim()) {
        throw new Error(`${file}: 第 ${index + 1} 条缺少 ${key}。`);
      }
    }
    const languageProblems = findChineseLanguageProblems(item);
    if (languageProblems.length) {
      throw new Error(`${file}: 第 ${index + 1} 条必须使用简体中文（${languageProblems.join("、")}）。`);
    }
    const editorialProblems = findEditorialQualityProblems(item);
    if (editorialProblems.length) {
      throw new Error(`${file}: 第 ${index + 1} 条未通过编辑质量检查（${editorialProblems.join("、")}）。`);
    }
    if (!Array.isArray(item.sources) || !item.sources.length) {
      throw new Error(`${file}: 第 ${index + 1} 条至少需要一个来源。`);
    }
    item.sources.forEach((source) => {
      if (!source.label || !/^https?:\/\//.test(source.url)) {
        throw new Error(`${file}: 第 ${index + 1} 条存在无效来源。`);
      }
    });
  });
}

function findChineseLanguageProblems(item) {
  const requirements = {
    category: { minHan: 2, minShare: 0.5 },
    title: { minHan: 4, minShare: 0.2 },
    summary: { minHan: 12, minShare: 0.35 },
    explanation: { minHan: 10, minShare: 0.35 }
  };
  const problems = [];
  for (const [key, requirement] of Object.entries(requirements)) {
    const value = String(item[key] || "");
    const han = (value.match(/\p{Script=Han}/gu) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    const share = han / Math.max(1, han + latin);
    if (han < requirement.minHan || share < requirement.minShare) problems.push(key);
  }
  return problems;
}
function findEditorialQualityProblems(item) {
  const summary = normalizeReaderText(item.summary);
  const explanation = normalizeReaderText(item.explanation);
  const problems = [];
  if (summary.length < 90) {
    problems.push("总结信息量不足");
  }
  if (summary.length > 260) {
    problems.push("总结过长");
  }
  if (summary && explanation && (summary === explanation || textSimilarity(summary, explanation) >= 0.72)) {
    problems.push("通俗解释与总结相同或过于相似");
  }
  if (summary && explanation.length > summary.length * 1.35) {
    problems.push("通俗解释不够简洁");
  }
  return problems;
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
