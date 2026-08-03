# 全球 AI 资讯日报

一个自动更新的中文 AI 技术日报网站。每个工作日早上 09:00（Asia/Shanghai），GitHub Actions 会检索前一天的全球 AI 技术进展，最多选择 5 条，按重要性与先进性排序，并生成：

- GitHub Pages 网站内容；
- 对应日期的 JSON 数据；
- `yyyy.MM/mm.dd.txt` 文本备份。

每条内容包含简要总结、通俗解释和原始来源。

## 发布前配置

1. 在 GitHub 创建仓库并推送本项目。
2. 在仓库 `Settings → Secrets and variables → Actions` 中添加名为 `OPENAI_API_KEY` 的 secret。
3. 在 `Settings → Pages → Build and deployment` 中选择 `GitHub Actions`。
4. 手动运行一次 `生成 AI 日报` 或 `发布网站` 工作流。

## 自动化

- `.github/workflows/daily.yml`：每个工作日 09:00 自动生成日报，也支持手动补生成指定日期。
- `.github/workflows/pages.yml`：网站内容变化后自动发布到 GitHub Pages。

生成流程默认使用 `gpt-5.6-terra` 与 OpenAI Responses API 的网页搜索能力。可在工作流中修改 `OPENAI_MODEL`。

## 本地检查

```bash
node scripts/validate-content.mjs
```

运行 `node scripts/serve-static.mjs` 后，访问 `http://127.0.0.1:4173/` 即可预览 GitHub Pages 版本。
