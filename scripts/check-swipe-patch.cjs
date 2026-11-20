// 锚点守护：上游更新/rebase 后如果这些挂钩被改名或删除，本脚本会失败。
// 用途：滑动推荐功能依赖 4 个上游文件的最小改动；CI 与 build:swipe 都会运行它。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [
  ['src/App.jsx', "id: 'swipe'", '导航菜单项'],
  ['src/App.jsx', "case 'swipe'", '页面渲染分支'],
  ['src/App.jsx', '<SwipeRecommend', '页面组件引用'],
  ['preload.js', 'recommendFeed:', '渲染层 IPC 暴露'],
  ['main.js', "ipcMain.handle('recommend-feed'", '推荐流 IPC 处理器'],
  ['main.js', 'initMetadataDevice', '匿名设备身份初始化'],
  ['src/native/hongguo-app-catalog.js', "'recommend'", '目录游标 scope 白名单'],
  ['src/components/SwipeRecommend.jsx', 'swipe-page', '滑动推荐页面'],
  ['src/components/swipeRecommendModel.mjs', 'mergeFeedItems', '推荐队列纯逻辑'],
  ['src/native/recommend-feed.js', 'recommendFeed', '推荐流数据源'],
];

const missing = [];
for (const [file, needle, label] of checks) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { missing.push(`${file}（文件缺失，${label}）`); continue; }
  if (!read(file).includes(needle)) missing.push(`${file} 缺少 ${needle}（${label}）`);
}

if (missing.length) {
  console.error('滑动推荐锚点校验失败：');
  for (const item of missing) console.error(' - ' + item);
  console.error('上游更新可能改动了挂钩点，请对照 docs/swipe-recommend.md 重新应用补丁。');
  process.exit(1);
}
console.log(`滑动推荐锚点校验通过（${checks.length} 项）`);
