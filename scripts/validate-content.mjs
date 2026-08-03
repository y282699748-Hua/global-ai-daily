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
