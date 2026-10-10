/* 端到端验证：用 mock 服务器把三种协议各打一遍
   —— 校验 URL / headers / body 构造，以及 SSE 能不能正确变成前端要的事件 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'app/www/index.html'), 'utf8');
const ADAPTER = fs.readFileSync(path.join(__dirname, '..', 'app/www/adapter.js'), 'utf8');

const SEEN = [];           // 记下每个 mock 端点收到的请求

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
    SEEN.push({ path: req.url, headers: req.headers, body: parsed });

    const sse = (lines) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      lines.forEach((l, i) => setTimeout(() => res.write('data: ' + JSON.stringify(l) + '\n\n'), i * 12));
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, lines.length * 12 + 30);
    };

    if (/\/oai\/v1\/chat\/completions/.test(req.url)) {
      return sse([
        { choices: [{ delta: { reasoning_content: '让我先想一下…' } }] },
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: { content: '，我是' } }] },
        { choices: [{ delta: { content: '通的。' } }] },
      ]);
    }
    if (/\/anthro\/v1\/messages/.test(req.url)) {
      return sse([
        { type: 'message_start', message: { model: 'claude-x' } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想…' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '，我通了。' } },
      ]);
    }
    if (/streamGenerateContent/.test(req.url)) {
      return sse([
        { candidates: [{ content: { parts: [{ text: '你' }] } }] },
        { candidates: [{ content: { parts: [{ thought: true, text: '思考中' }, { text: '好' }] } }] },
        { candidates: [{ content: { parts: [{ text: '，通了。' }] } }] },
      ]);
    }
    if (/\/fail\//.test(req.url)) { res.writeHead(401, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:{message:'key 无效'}})); }
    res.writeHead(404); res.end('{}');
  });
});

const OK = [], BAD = [];
const t = (name, cond, extra) => (cond ? OK : BAD).push(name + (cond ? '' : '  ← ' + (extra || '')));

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const B = `http://127.0.0.1:${port}`;

  // 造一个浏览器环境
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
    <div class="mi-wrap"><button class="mi" data-act="settings">设置</button></div></body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.fetch = (u, o) => fetch(u.startsWith('http') ? u : B + '/' + u, o);
  win.Response = Response; win.Headers = Headers; win.Request = Request;
  win.TextDecoder = TextDecoder; win.ReadableStream = ReadableStream;
  win.AbortController = AbortController; win.console = console;
  win.localStorage.clear();

  win.eval(ADAPTER);
  const api = (p, o) => win.fetch(p, o).then(r => r.json());
  let cur = 0;
  // 把游标推过头 → 服务端立刻回空，用来排掉上一段残留的事件
  const drain = async () => (await api('api/poll?since=999999999')).next;

  try {
    /* ---- 1. 契约基本盘 ---- */
    let m = await api('api/model');
    t('api/model GET 有 model 字段', typeof m.model === 'string' && m.model.length > 0, JSON.stringify(m));

    m = await api('api/context');
    t('api/context 有 used/max', typeof m.used === 'number' && typeof m.max === 'number');

    t('api/status 报未配置', (await api('api/status')).has === false);
    t('api/authmode 未配置时 mode=sub', (await api('api/authmode')).mode === 'sub');

    /* ---- 2. 空数据端点不炸 ---- */
    for (const p of ['api/notes','api/whisper','api/dreams','api/herdiary','api/cal','api/news',
                     'api/nook','api/health','api/wall','api/todos','api/usage','api/gong','api/night',
                     'api/favlines','api/chats','api/repo/log']) {
      const r = await api(p);
      t('空端点 ' + p, r && typeof r === 'object');
    }

    /* ---- 3. OpenAI 兼容 ---- */
    await api('api/apiconf', { method:'POST', body: JSON.stringify({
      provider:'openai', base:`${B}/oai/v1`, token:'sk-test', model:'my-model' }) });
    t('apiconf 存了 mode=api', (await api('api/authmode')).mode === 'api');

    let evs = [];
    await api('api/send', { method:'POST', body: JSON.stringify({ text: '在吗' }) });
    for (let i = 0; i < 12; i++) {
      const d = await api('api/poll?since=' + (cur + evs.length));
      if (!d.events.length) break;
      evs = evs.concat(d.events);
      if (evs.some(e => e.type === 'result')) break;
    }
    if (process.env.DBG) console.log('DBG events:', JSON.stringify(evs, null, 1).slice(0, 2000));
    if (process.env.DBG) console.log('DBG seen paths:', SEEN.map(s=>s.path));
    const oai = SEEN.find(s => s.path.includes('/oai/v1/chat/completions'));
    t('OpenAI URL 拼对', !!oai && oai.path === '/oai/v1/chat/completions', oai && oai.path);
    t('OpenAI auth 头', oai && oai.headers.authorization === 'Bearer sk-test');
    t('OpenAI body 带 model', oai && oai.body.model === 'my-model');
    t('OpenAI body 是 messages[]', oai && Array.isArray(oai.body.messages));
    t('OpenAI system 进 messages[0]', oai && oai.body.messages[0].role === 'user',
        oai && JSON.stringify(oai.body.messages[0]));
    t('收到 echo 事件', evs.some(e => e.type === 'echo' && e.text === '在吗'));
    t('收到 text_delta', evs.some(e => e.event && e.event.delta && e.event.delta.type === 'text_delta'));
    t('reasoning_content 映射成 thinking_delta',
      evs.some(e => e.event && e.event.delta && e.event.delta.type === 'thinking_delta'));
    t('收到 assistant 定稿', evs.some(e => e.type === 'assistant'));
    t('收到 result', evs.some(e => e.type === 'result' && e.is_error === false));

    const streamed = evs.filter(e => e.event && e.event.delta && e.event.delta.type === 'text_delta')
                      .map(e => e.event.delta.text).join('');
    const final = evs.find(e => e.type === 'assistant').message.content.filter(c => c.type==='text')
                      .map(c => c.text).join('');
    t('流式拼接 == 定稿内容', streamed === final, `流式[${streamed}] vs 定稿[${final}]`);

    let msgs = (await api('api/messages?limit=400')).msgs;
    t('消息落库 me', msgs.some(x => x.kind === 'me' && x.text === '在吗'));
    t('消息落库 gu', msgs.some(x => x.kind === 'gu' && x.text === final));
    t('消息落库 think', msgs.some(x => x.kind === 'think'));

    /* ---- 4. Anthropic ---- */
    cur = await drain(); SEEN.length = 0; evs = [];
    await api('api/apiconf', { method:'POST', body: JSON.stringify({
      provider:'anthropic', base:`${B}/anthro`, token:'sk-ant-test', model:'claude-x', system:'你是住在这里的人。' }) });
    await api('api/send', { method:'POST', body: JSON.stringify({ text: '嗨' }) });
    for (let i = 0; i < 12; i++) {
      const d = await api('api/poll?since=' + (cur + evs.length));
      if (!d.events.length) break;
      evs = evs.concat(d.events);
      if (evs.some(e => e.type === 'result')) break;
    }
    const ant = SEEN.find(s => s.path.includes('/anthro/v1/messages'));
    t('Anthropic URL 拼对', !!ant && ant.path === '/anthro/v1/messages', ant && ant.path);
    t('Anthropic x-api-key 头', ant && ant.headers['x-api-key'] === 'sk-ant-test');
    t('Anthropic version 头', ant && ant.headers['anthropic-version'] === '2023-06-01');
    t('Anthropic 直连浏览器头', ant && ant.headers['anthropic-dangerous-direct-browser-access'] === 'true');
    t('Anthropic system 独立字段', ant && ant.body.system === '你是住在这里的人。');
    t('Anthropic body 带 max_tokens', ant && typeof ant.body.max_tokens === 'number');
    t('Anthropic 流式出字', evs.some(e => e.event && e.event.delta && e.event.delta.type === 'text_delta'));

    /* ---- 5. Gemini ---- */
    cur = await drain(); SEEN.length = 0; evs = [];
    await api('api/apiconf', { method:'POST', body: JSON.stringify({
      provider:'gemini', base:`${B}/gem`, token:'goog-key', model:'gemini-2.0-flash', system:'人设X' }) });
    await api('api/send', { method:'POST', body: JSON.stringify({ text: '在吗' }) });
    for (let i = 0; i < 12; i++) {
      const d = await api('api/poll?since=' + (cur + evs.length));
      if (!d.events.length) break;
      evs = evs.concat(d.events);
      if (evs.some(e => e.type === 'result')) break;
    }
    const gem = SEEN.find(s => s.path.includes('streamGenerateContent'));
    t('Gemini URL 拼对', !!gem && /\/gem\/v1beta\/models\/gemini-2\.0-flash:streamGenerateContent\?alt=sse/.test(gem.path),
        gem && gem.path);
    t('Gemini x-goog-api-key 头', gem && gem.headers['x-goog-api-key'] === 'goog-key');
    t('Gemini 用 contents[]', gem && Array.isArray(gem.body.contents));
    t('Gemini 角色是 user/model', gem && gem.body.contents[0].role === 'user');
    t('Gemini systemInstruction', gem && gem.body.systemInstruction.parts[0].text === '人设X');
    t('Gemini 流式出字', evs.some(e => e.event && e.event.delta && e.event.delta.type === 'text_delta'));

    /* ---- 6. apitest 真发一次 ---- */
    await api('api/apiconf', { method:'POST', body: JSON.stringify({
      provider:'openai', base:`${B}/fail`, token:'bad', model:'m' }) });
    const r1 = await api('api/apitest', { method:'POST', body: JSON.stringify({
      provider:'openai', base:`${B}/oai/v1`, token:'sk-test', model:'my-model' }) });
    t('apitest 通的时候 ok=true', r1.ok === true, JSON.stringify(r1));
    const r2 = await api('api/apitest', { method:'POST', body: JSON.stringify({
      provider:'openai', base:`${B}/fail`, token:'bad', model:'m' }) });
    t('apitest 不通时 ok=false 且带原因', r2.ok === false && !!r2.detail, JSON.stringify(r2));

    /* ---- 7. 搜索 / 停止 / 新窗口 ---- */
    await api('api/apiconf', { method:'POST', body: JSON.stringify({
      provider:'openai', base:`${B}/oai/v1`, token:'sk-test', model:'my-model' }) });
    await api('api/send', { method:'POST', body: JSON.stringify({ text: '找关键词的句子' }) });
    await new Promise(r => setTimeout(r, 400));
    const fd = await api('api/find?q=关键词');
    t('find 能搜到', fd.items && fd.items.length > 0, JSON.stringify(fd));

    await api('api/newchat', { method:'POST', body:'{"arm":false}' });
    t('newchat 清空历史', (await api('api/messages?limit=400')).msgs.length === 0);

    /* ---- 8. 设置面板 ---- */
    const sheet = win.document.getElementById('dwellSheet');
    t('设置面板注入了', !!sheet);
    t('协议下拉有三项',
      win.document.querySelectorAll('#dvProv option').length === 3);
    t('菜单里有入口', !!win.document.querySelector('.mi[data-act="settings"]')?.nextSibling);

    console.log('\n通过 ' + OK.length + ' 项：');
    OK.forEach(x => console.log('  ✓ ' + x));
    if (BAD.length) { console.log('\n失败 ' + BAD.length + ' 项：'); BAD.forEach(x => console.log('  ✗ ' + x)); }
    console.log('\n' + (BAD.length ? '❌ 有失败' : '✅ 全过'));
    server.close();
    process.exit(BAD.length ? 1 : 0);
  } catch (e) {
    console.error('测试崩了：', e);
    BAD.push('异常: ' + e.message);
    server.close();
    process.exit(1);
  }
});
