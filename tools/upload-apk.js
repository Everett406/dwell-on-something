#!/usr/bin/env node
/* 发版脚本：把本地构建好的 APK 挂到 GitHub Release 上
 *
 *   node tools/upload-apk.js           用当前 git tag
 *   node tools/upload-apk.js v0.2.0   指定版本
 *
 * 为什么不用 CI 自动发：这是 fork 仓库，GitHub 不给 fork 的 workflow 发
 * GITHUB_TOKEN（安全策略，防止别人改 fork 的 workflow 偷凭据）。
 * 需要 token 环境变量：export GITHUB_TOKEN=...
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.env.DWELL_REPO || 'Everett406/dwell-on-something';
const TOK = process.env.GITHUB_TOKEN;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'app/android/app/build/outputs/apk/release');

if (!TOK) {
  console.error('缺少 GITHUB_TOKEN。先 export GITHUB_TOKEN=xxx 再跑。');
  process.exit(1);
}

function call(host, method, apiPath, body, isRaw) {
  return new Promise((res, rej) => {
    const data = body ? (isRaw ? body : Buffer.from(JSON.stringify(body))) : null;
    const h = { 'User-Agent': 'dwell-release', 'Authorization': 'Bearer ' + TOK,
                'Accept': 'application/vnd.github+json' };
    if (data) {
      h['Content-Type'] = isRaw ? 'application/octet-stream' : 'application/json';
      h['Content-Length'] = data.length;
    }
    const req = https.request({ hostname: host, path: apiPath, method, headers: h }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

/* 版本从哪来：命令行 > git describe > 解析 APK 里的 versionName */
function pickVersion(arg) {
  if (arg) return arg;
  try {
    return execSync('git describe --tags --abbrev=0', { cwd: ROOT }).toString().trim();
  } catch (e) { return null; }
}

function findApk() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const apks = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.apk'))
                   .sort((a, b) => fs.statSync(path.join(OUT_DIR, b)).mtimeMs
                                - fs.statSync(path.join(OUT_DIR, a)).mtimeMs);
  if (!apks.length) return null;
  return path.join(OUT_DIR, apks[0]);
}

(async () => {
  const apkPath = findApk();
  if (!apkPath) {
    console.error(`没找到 APK。先构建：\n  cd app/android && ./gradlew assembleRelease`);
    process.exit(1);
  }
  const apk = fs.readFileSync(apkPath);
  const apkName = path.basename(apkPath);
  console.log('安装包：', apkPath.replace(ROOT + '/', ''), `(${(apk.length / 1048576).toFixed(2)} MB)`);

  const version = pickVersion(process.argv[2]);
  if (!version) {
    console.error('定不出版本号：命令行没给，git 里也没有 tag。');
    process.exit(1);
  }
  console.log('版本：', version);

  const list = await call('api.github.com', 'GET', `/repos/${REPO}/releases`);
  const all = JSON.parse(list.body);
  let rel = all.find(r => r.tag_name === version);

  if (rel && rel.draft) {
    console.log('（这个 Release 之前是草稿，先发布出来）');
    const p = await call('api.github.com', 'PATCH', `/repos/${REPO}/releases/${rel.id}`,
      { draft: false, tag_name: version });
    rel = JSON.parse(p.body);
  }

  if (!rel) {
    const notes = fs.readFileSync(path.join(ROOT, 'build-notes.md'), 'utf8');
    const r = await call('api.github.com', 'POST', `/repos/${REPO}/releases`, {
      tag_name: version, name: `dwell ${version}`, body: notes,
      draft: false, prerelease: false
    });
    if (r.status > 201) { console.error('创建失败', r.status, r.body.slice(0, 300)); process.exit(1); }
    rel = JSON.parse(r.body);
    console.log('✅ 新建 Release');
  } else {
    console.log('✅ Release 已存在，覆盖安装包');
  }

  const old = (rel.assets || []).find(a => a.name === apkName);
  if (old) await call('api.github.com', 'DELETE', `/repos/${REPO}/releases/assets/${old.id}`);

  const up = await call('uploads.github.com', 'POST',
    `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(apkName)}`, apk, true);
  if (up.status > 201) { console.error('上传失败', up.status, up.body.slice(0, 300)); process.exit(1); }
  const a = JSON.parse(up.body);

  console.log('✅ 上传完成：', a.name, (a.size / 1048576).toFixed(2), 'MB');
  console.log('   下载：', a.browser_download_url);
  console.log('   页面：', rel.html_url);
})();