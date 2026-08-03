# 全球 AI 资讯日报

一个自动更新的中文 AI 技术日报网站。每个工作日早上 09:00（Asia/Shanghai），GitHub Actions 会检索前一天的全球 AI 技术进展，最多选择 5 条，按重要性与先进性排序，并生成：

- GitHub Pages 网站内容；
- 对应日期的 JSON 数据；
- `yyyy.MM/mm.dd.txt` 文本备份。

每条内容包含简要总结、通俗解释和原始来源。

## 发布前配置

1. 在 GitHub 创建仓库并推送本项目。
2. 在 `Settings → Pages → Build and deployment` 中选择 `GitHub Actions`。
3. 手动运行一次 `生成 AI 日报` 或 `发布网站` 工作流。

不需要配置 OpenAI API Key 或其他模型密钥。日报会在公开仓库的 GitHub Actions 标准运行器中启动 Qwen3-4B 开源模型，在临时运行器本地完成筛选、排序和中文总结。模型量化文件来自 Qwen 的公开 Hugging Face 仓库，并在运行前校验 SHA-256；首次运行需要下载约 2.5 GB，之后会使用 Actions 缓存。

## 自动化

- `.github/workflows/daily.yml`：每个工作日 09:00 自动生成日报，也支持手动补生成指定日期。
- `.github/workflows/pages.yml`：网站内容变化后自动发布到 GitHub Pages。

生成流程先从官方博客、研究机构与 arXiv 的 RSS/Atom 源抓取候选内容，再由本地开源模型完成筛选、排序、中文总结和通俗解释。模型只能引用候选列表中的来源 URL，避免凭空添加资讯。整个过程不调用 OpenAI、GitHub Models 或其他云端模型 API。

## 本地检查

```bash
node scripts/validate-content.mjs
node scripts/generate-daily.mjs --self-test
node scripts/generate-daily.mjs --collect-only --date=2026-08-03
```

完整生成依赖一个本地 OpenAI 兼容接口；GitHub Actions 会通过官方 `llama.cpp` 容器自动提供，无需在个人电脑安装。

运行 `node scripts/serve-static.mjs` 后，访问 `http://127.0.0.1:4173/` 即可预览 GitHub Pages 版本。
