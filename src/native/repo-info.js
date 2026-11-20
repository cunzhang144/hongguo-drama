// 自建 fork 的仓库信息：应用更新、发布页与公告都从这里取，避免多处硬编码。
// 换 fork 或改名时只需改环境变量 HONGGUO_REPO_OWNER / HONGGUO_REPO_NAME（或在源码里改默认值）。
const OWNER = String(process.env.HONGGUO_REPO_OWNER || 'cunzhang144').trim();
const REPO = String(process.env.HONGGUO_REPO_NAME || 'hongguo-drama').trim();
const GITHUB_URL = `https://github.com/${OWNER}/${REPO}`;

module.exports = {
  OWNER,
  REPO,
  GITHUB_URL,
  RELEASES_URL: `${GITHUB_URL}/releases`,
  LATEST_RELEASE_API: `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
  LATEST_RELEASE_PAGE: `${GITHUB_URL}/releases/latest`,
  ANNOUNCEMENT_BASE: `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/announcements`,
};
