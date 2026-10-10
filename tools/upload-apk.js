const https = require('https'), fs = require('fs');
const REPO = 'Everett406/dwell-on-something';
const TOK = process.env.GITHUB_TOKEN;

function call(host, method, path, body, isRaw) {
  return new Promise((res, rej) => {
    const data = body ? (isRaw ? body : Buffer.from(JSON.stringify(body))) : null;
    const h = { 'User-Agent': 'dwell-release', 'Authorization': 'Bearer ' + TOK,
                'Accept': 'application/vnd.github+json' };
    if (data) { h['Content-Type'] = isRaw ? 'application/octet-stream' : 'application/json';
                h['Content-Length'] = data.length; }
    const req = https.request({ hostname: host, path, method, headers: h }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const apkPath = 'app/android/app/build/outputs/apk/release/app-release.apk';
  const apk = fs.readFileSync(apkPath);
  console.log('APK 大小:', (apk.length / 1048576).toFixed(2), 'MB');

  const list = await call('api.github.com', 'GET', `/repos/${REPO}/releases`);
  const rel = JSON.parse(list.body).find(r => r.tag_name === 'v0.1.0');
  if (!rel) { console.log('找不到 v0.1.0 release'); process.exit(1); }
  console.log('Release:', rel.html_url);
  console.log('已有资产:', rel.assets.map(a => a.name));

  const name = 'dwell-v0.1.0.apk';
  if (rel.assets.some(a => a.name === name)) {
    console.log('已存在同名资产，先删掉');
    const old = rel.assets.find(a => a.name === name);
    await call('api.github.com', 'DELETE', `/repos/${REPO}/releases/assets/${old.id}`);
  }

  const up = await call('uploads.github.com', 'POST',
    `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, apk, true);
  if (up.status > 201) { console.log('上传失败', up.status, up.body.slice(0, 400)); process.exit(1); }
  const a = JSON.parse(up.body);
  console.log('✅ APK 已上传:', a.name, (a.size / 1048576).toFixed(2), 'MB');
  console.log('   下载地址:', a.browser_download_url);
})();
