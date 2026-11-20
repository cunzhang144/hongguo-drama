# 滑动推荐（Swipe Recommend）

对齐红果手机 App「推荐」tab 的桌面实现：单列全屏竖屏、上下滑切集、播完自动连播、整剧播完切下一部推荐，推荐流使用 App 个性化 landpage 接口。

## 1. 功能范围（v1）

- 新增侧边栏页面「滑动推荐」（`src/components/SwipeRecommend.jsx`）。
- 推荐来源：App `POST /reading/distribution/category/landpage/v/`（经 `src/native/hongguo-app-catalog.js` 的签名与游标实现），支持 **综合 / 真人剧 / 漫剧 / AI剧** 四种流；综合为三路交错。
- 交互：
  - 滚轮/触控板累计位移、`↑/↓`、`J/K`、竖直拖拽 → 上一集/下一集。
  - 一集播完自动下一集；整剧播完自动切下一部推荐（第 1 集）。
  - `Space` 播放/暂停、`←/→` ±5 秒、`F` 全屏、`M` 静音、`L` 收藏、`S` 不感兴趣。
  - 右侧栏：收藏、选集、不感兴趣、静音、全屏；底部剧名/集数/简介/进度条。
- 预取：播放到 70% 或剩余 ≤10 秒时预取下一集（`prepareOnlinePlay({prefetch:true})`），切换时 promote，离开时 release。
- 进度：每 5 秒、暂停、切集、离开页面时写入现有观看记录；回到页面按上次进度续播。
- 不感兴趣：本地隐藏该剧并立即切下一部（v1 不回传 App）。
- 匿名设备身份：`%APPDATA%/hongguo-downloader/app-device.json` 持久化 `iid/device_id`，让 App 推荐流跨启动累积偏好。

未包含（可作为 v2）：App「不感兴趣」接口回传（`/reading/articleapi/relation/update/v1/`）、观看进度回传（`/reading/bookapi/read_history/update/v`）、推荐页弹幕/评论。

## 2. 改动清单与锚点

新增文件：

| 文件 | 作用 |
| --- | --- |
| `src/native/recommend-feed.js` | 推荐流数据源：多类型交错、已看过滤、游标耗尽重开 |
| `src/components/SwipeRecommend.jsx` / `.css` | 滑动推荐页面与样式 |
| `src/components/swipeRecommendModel.mjs` | 队列/切集/预取纯逻辑（可单测） |
| `src/components/__tests__/swipe-recommend.test.mjs` | 纯逻辑测试 |
| `scripts/check-swipe-patch.cjs` | 锚点守护脚本 |
| `.github/workflows/swipe-release.yml` | fork 自动构建与发布（更新通道） |

上游文件只做最小改动（共 6 处）：

1. `src/App.jsx`：`MENU` 增加 `{ id: 'swipe', label: '滑动推荐' }`、`renderPage` 增加 `case 'swipe'`、引入组件。
2. `preload.js`：暴露 `recommendFeed(options)`。
3. `main.js`：注册 `ipcMain.handle('recommend-feed', …)`；启动时 `initMetadataDevice(...)`。
4. `src/native/app-source.js`：`metadataDevice` 支持持久化身份，导出 `initMetadataDevice`。
5. `src/native/hongguo-app-catalog.js`：`catalogScope` 白名单增加 `'recommend'`，避免与发现页共享游标。
6. `scripts/setup-software-player.cjs`：支持 `SOFTWARE_ASSETS_TEMPLATE` 镜像（仅构建便利性，不影响功能）。

`npm run check:swipe` 会逐项验证上述锚点与新文件；任一失效即退出码 1。

## 3. 更新不覆盖方案（自建 fork 通道）

已把 `package.json` 的 `build.publish` 改为：

```json
"publish": { "provider": "github", "owner": "${env.GH_OWNER}", "repo": "${env.GH_REPO}" }
```

因此构建时必须提供 `GH_OWNER` / `GH_REPO`，生成的 `resources/app-update.yml` 指向你的 fork。官方 Release 不再被检查，官方更新不会覆盖本功能。

### 一次性设置

1. 在 GitHub fork `jackotom/hongguo-drama`（保持仓库名可自定义）。
2. 把本仓库代码推到 fork 的 `main`。
3. 打 tag（例如 `v7.6.1-swipe.1`）或手动运行 `swipe-release` 工作流；CI 会用 `GITHUB_TOKEN` 构建 NSIS 并发布 Release + `latest.yml`。
4. 安装该 Release 的安装包（同 appId，可直接覆盖现有安装并保留用户数据）。
5. 以后发新版本只需 tag；客户端自动从 fork 更新。

### 本地构建

```bat
set GH_OWNER=你的GitHub用户名
set GH_REPO=你的仓库名
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set SOFTWARE_ASSETS_TEMPLATE=https://fastly.jsdelivr.net/gh/zhaohappy/libmedia@{commit}/dist/{name}
npm ci
npm run build:swipe
```

产物：`dist/hongguo-downloader-7.7-win-x64-setup.exe`（及 `latest.yml`）。

> 版本策略：与上游同步开发时保持上游版本（如 `7.6.0`，`buildVersion 7.6.1`），便于 `check-release-version` / `check-windows-installer` 通过；
> 发布到 fork 时把 `package.json`、`package-lock.json` 与 artifactName 改为下一个公开版本（本项目首个自建版本为 `7.7.0` / `buildVersion 7.7.1`），客户端只比较 fork 的 Release，因此不会被官方版本覆盖。

## 4. 同步上游

```bat
git remote add upstream https://github.com/jackotom/hongguo-drama.git
git fetch upstream
git rebase upstream/main
npm run check:swipe   :: 锚点缺失会立即失败
npm run test:swipe
```

若锚点失败：按第 2 节清单手工重新挂接，再跑 `check:swipe`。

## 5. 验证清单

- [ ] `npm run test:swipe` 全绿（队列去重、切集边界、预取阈值、滚轮方向）。
- [ ] `npm run check:swipe` 通过。
- [ ] 开发模式：滑动推荐首屏 15–30 部，滚轮/↑↓ 连切 ≥2 部剧各 ≥3 集。
- [ ] 一集播完自动下一集；整剧末集播完自动下一部。
- [ ] 切到其他页面音频停止；返回后按原进度续播。
- [ ] 综合/真人/漫剧/AI 四类均能出流并播放。
- [ ] 不感兴趣后当前剧不再出现（`hongguo:swipe:hidden:v1`）。
- [ ] 安装包覆盖安装后功能仍在，`app-update.yml` 指向 fork。

## 6. 当前自建通道（本机已落地）

- fork：`https://github.com/cunzhang144/hongguo-drama`（分支 `swipe`）
- Release：`v7.7.0`（安装包 + `latest.yml` + SHA256）
- 客户端更新源：`src/native/repo-info.js` 统一提供 owner/repo，默认 `cunzhang144/hongguo-drama`；
  `app-update.yml`、electron-updater feed、检查更新 API/发布页、公告地址都从这里取。
  可用 `HONGGUO_REPO_OWNER` / `HONGGUO_REPO_NAME` 覆盖，便于再次迁移。
- 已安装版本：`7.7.0`（build 7.7.1），`D:\Apps\hongguo-downloader`；更新检查已验证返回本 fork 的 Release URL。

### 发新版本

1. 改 `package.json`、`package-lock.json` 与各 `artifactName` 到下一个 `X.Y.0`（如 `7.8.0`），`buildVersion` 同步。
2. `npm run check:swipe && npm run test:swipe`。
3. 打 tag（如 `v7.8.0`）推送；`swipe-release` 工作流会取 ffmpeg、构建 NSIS 并发布到本仓库。
4. 若 Actions 不可用，本地 `npm run build:swipe` 后 `gh release upload` 替换 Release 资产即可。
