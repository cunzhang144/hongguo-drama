// Keep upstream ESM chunks intact: AVPlayer loads its own worker/pipeline chunks by URL.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const manifest = require('./software-player-assets.json');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public/software');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// 允许通过镜像下载官方 Wasm 资源（raw.githubusercontent.com 在部分网络不可达）。
// 支持 {commit}/{name} 占位符，例如 jsDelivr：https://fastly.jsdelivr.net/gh/zhaohappy/libmedia@{commit}/dist/{name}
const assetTemplate = process.env.SOFTWARE_ASSETS_TEMPLATE || '';
const assetUrl = (commit, name) => assetTemplate
  ? assetTemplate.replace('{commit}', commit).replace('{name}', name)
  : `https://raw.githubusercontent.com/zhaohappy/libmedia/${commit}/dist/${name}`;

async function setup() {
  const entry = require.resolve('@libmedia/avplayer');
  const pkgRoot = path.resolve(path.dirname(entry), '../..');
  if (JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'))).version !== manifest.version)
    throw new Error('软件播放器依赖版本与资源清单不一致');
  const scripts = path.join(output, 'avplayer');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(root, 'build/licenses/LIBMEDIA-LGPL-3.0.txt'), path.join(output, 'LIBMEDIA-LGPL-3.0.txt'));
  for (const name of fs.readdirSync(path.join(pkgRoot, 'dist/esm'))) {
    if (name.endsWith('.js')) fs.copyFileSync(path.join(pkgRoot, 'dist/esm', name), path.join(scripts, name));
  }
  await Promise.all(Object.entries(manifest.files).map(async ([name, sha256]) => {
    const target = path.join(output, name);
    if (fs.existsSync(target) && digest(fs.readFileSync(target)) === sha256) return;
    const response = await fetch(assetUrl(manifest.commit, name),
      { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`软件解码资源下载失败：${name} HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== sha256) throw new Error(`软件解码资源SHA256不符：${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }));
  console.log(`Software player: ${manifest.version}, ${Object.keys(manifest.files).length} verified local Wasm assets`);
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; });
