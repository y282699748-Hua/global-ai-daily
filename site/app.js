const state = { index: null, activeDate: null };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderArchive(index) {
  const archive = document.querySelector("#archive");
  archive.replaceChildren(node("p", "section-kicker", "日报存档"));

  const months = index.issues.reduce((groups, issue) => {
    if (!groups.has(issue.month)) groups.set(issue.month, []);
    groups.get(issue.month).push(issue);
    return groups;
  }, new Map());
  for (const [month, issues] of months.entries()) {
    archive.append(node("h2", "", month));
    for (const issue of issues) {
      const link = node("a", `issue-link${issue.date === state.activeDate ? " active" : ""}`);
      link.href = `?date=${issue.date}#daily`;
      link.append(node("span", "", issue.label), node("small", "", `${issue.count} 条`));
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        history.pushState({}, "", link.href);
        await loadIssue(issue.date);
        document.querySelector("#daily").scrollIntoView();
      });
      archive.append(link);
    }
  }
  archive.append(node("p", "archive-note", "更多日报将在每天更新后自动加入。"));
}

function renderIssue(issue) {
  document.querySelector("#item-count").textContent = issue.items.length;
  document.querySelector("#coverage-date").textContent = issue.coverageLabel;
  document.querySelector("#hero-date").textContent = issue.label;
  document.querySelector("#hero-year").textContent = issue.year;
  document.querySelector("#issue-date").textContent = issue.label;
  document.querySelector("#issue-coverage").textContent = issue.coverageLabel;
  document.title = `${issue.label}｜全球 AI 资讯日报`;

  const list = document.querySelector("#story-list");
  list.replaceChildren();
  issue.items.forEach((item, index) => {
    const article = node("article", "story");
    article.append(node("div", "story-rank", String(index + 1).padStart(2, "0")));

    const body = node("div", "story-body");
    const topline = node("div", "story-topline");
    topline.append(node("span", "category", item.category), node("span", "", `重要性排序 #${index + 1}`));
    body.append(topline, node("h3", "", item.title), node("p", "summary", item.summary));

    const plain = node("div", "plain-language");
    plain.append(node("span", "plain-label", "通俗解释"), node("p", "", item.explanation));
    body.append(plain);

    const sources = node("div", "sources");
    sources.append(node("span", "", "来源"));
    const sourceList = node("div");
    item.sources.forEach((source) => {
      const link = node("a", "", source.label);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.append(node("span", "", "↗"));
      sourceList.append(link);
    });
    sources.append(sourceList);
    body.append(sources);
    article.append(body);
    list.append(article);
  });
}

async function loadIssue(date) {
  const entry = state.index.issues.find((issue) => issue.date === date) || state.index.issues[0];
  const response = await fetch(entry.file, { cache: "no-store" });
  if (!response.ok) throw new Error(`日报载入失败：${response.status}`);
  const issue = await response.json();
  state.activeDate = issue.date;
  renderIssue(issue);
  renderArchive(state.index);
}

async function start() {
  try {
    const response = await fetch("data/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`索引载入失败：${response.status}`);
    state.index = await response.json();
    const requestedDate = new URLSearchParams(location.search).get("date");
    await loadIssue(requestedDate || state.index.latest);
  } catch (error) {
    const list = document.querySelector("#story-list");
    list.replaceChildren(node("p", "load-error", "日报暂时无法载入，请稍后刷新页面。"));
    console.error(error);
  }
}

window.addEventListener("popstate", () => {
  const requestedDate = new URLSearchParams(location.search).get("date");
  loadIssue(requestedDate || state.index.latest);
});

start();
