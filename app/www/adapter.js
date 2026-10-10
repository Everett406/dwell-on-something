/* ==========================================================================
   dwell 适配层 —— 把「前端要的 fetch 契约」接到「任意一家的模型 API」上

   原作者的 web/index.html 里有一段演示模式 IIFE，它拦截 fetch、喂写死数据，
   并且在注释里写明：接自己的后端时把这一整块删掉即可，其余代码不用动。
   我们就是照这个口子来的——把那段演示换成本文件，前端一行不改。

   干的事：
     1. 拦住 window.fetch，按路径分派到本地实现
     2. 存消息、存配置（localStorage），所以关掉再开还在
     3. 事件队列 + 长轮询，喂给前端的 api/poll → handle()
     4. 三种协议：OpenAI 兼容 / Anthropic Messages / Google Gemini
   ========================================================================== */
(function () {
  'use strict';

  var realFetch = window.fetch.bind(window);

  /* ---------- 小工具 ---------- */
  function J(o) {
    return new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  }
  function ls(k, v) {
    try {
      if (arguments.length === 1) {
        var raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : v;
      }
      localStorage.setItem(k, JSON.stringify(v));
      return v;
    } catch (e) { return v; }
  }
  function trimBase(s) { return String(s || '').trim().replace(/\/+$/, ''); }

  /* ==========================================================================
     一、配置
     ========================================================================== */

  var DEFAULT_CFG = {
    provider: 'openai',        // openai | anthropic | gemini
    base: '',                  // 留空 = 用该家的官方地址
    key: '',
    model: '',
    system: '',                // 人设 / 系统提示词
    temperature: 0.8,
    maxTokens: 4096,
    effort: 'high',            // 前端顶上的"用力档"
    historyLimit: 60           // 送进上下文的历史轮数
  };

  var CFG = Object.assign({}, DEFAULT_CFG, ls('dwell.cfg', {}));

  function saveCfg(patch) {
    Object.assign(CFG, patch || {});
    ls('dwell.cfg', CFG);
    return CFG;
  }

  // 每家的默认地址和默认模型
  var PRESET = {
    openai: {
      base: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      hint: 'OpenAI 官方地址。所有 OpenAI 兼容的中转站也都走这个：' +
            'OpenRouter → https://openrouter.ai/api/v1，DeepSeek → https://api.deepseek.com/v1，' +
            'Kimi → https://api.moonshot.cn/v1，智谱 → https://open.bigmodel.cn/api/paas/v4，' +
            '硅基流动 → https://api.siliconflow.cn/v1'
    },
    anthropic: {
      base: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      hint: 'Anthropic 官方地址。中转站走 OpenAI 兼容格式的话，请改用「OpenAI 兼容」。'
    },
    gemini: {
      base: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      hint: 'Google Gemini 官方地址。拿的是 Google AI Studio 的 key，不是 Cloud 那把。'
    }
  };

  function curPreset() { return PRESET[CFG.provider] || PRESET.openai; }
  function effBase() { return trimBase(CFG.base) || curPreset().base; }
  function effModel() { return (CFG.model || '').trim() || curPreset().model; }
  function effKey() { return (CFG.key || '').trim(); }
  function hasCfg() { return !!effKey(); }

  /* ==========================================================================
     二、消息仓库
     kind 取值必须和前端 renderSaid() 对得上：me / gu / think / tool
     ========================================================================== */

  var SEQ = { n: ls('dwell.seq', 0) };
  var MSGS = ls('dwell.msgs', []);
  var CHATS = ls('dwell.chats', null);

  function saveMsgs() { ls('dwell.msgs', MSGS); ls('dwell.seq', SEQ.n); }

  function addMsg(kind, text, extra) {
    var m = { seq: ++SEQ.n, kind: kind, text: text, at: Math.floor(Date.now() / 1000) };
    if (extra) m.extra = extra;
    MSGS.push(m);
    // 只留最近 800 条，防止 localStorage 撑爆
    if (MSGS.length > 800) MSGS.splice(0, MSGS.length - 800);
    saveMsgs();
    return m;
  }

  function resetMsgs() { MSGS = []; SEQ.n = 0; saveMsgs(); }

  function upto() { return MSGS.length ? MSGS[MSGS.length - 1].seq : 0; }

  function messagesSlice(limit, before) {
    var list = MSGS;
    if (before) {
      list = list.filter(function (m) { return m.seq < before; });
    }
    var more = false;
    if (list.length > limit) { more = true; list = list.slice(list.length - limit); }
    return { msgs: list, upto: upto(), more: more };
  }

  /* 会话列表：给前端那个 chats 面板用 */
  function chatList() {
    if (!CHATS) {
      CHATS = [{ id: 'default', title: '默认窗口', at: Date.now() / 1000 }];
      ls('dwell.chats', CHATS);
    }
    return CHATS;
  }
  function touchChat(title) {
    var c = chatList()[0];
    if (title && title !== c.title) {
      c.title = String(title).slice(0, 24);
      c.at = Date.now() / 1000;
      ls('dwell.chats', CHATS);
    }
  }

  /* ==========================================================================
     三、事件总线
     前端靠 api/poll?since=N 拉事件，N 就是游标。游标要单调递增，
     所以事件数组只追加、不删除；发够了就整体重置（游标也会跟着归零，
     前端那边 handle 完就不再关心旧事件了）。
     ========================================================================== */

  var EV = [];
  var WAITERS = [];

  function emit(ev) {
    EV.push(ev);
    WAITERS.splice(0).forEach(function (w) { w(); });
  }

  function resetEvents() { EV = []; WAITERS.splice(0).forEach(function (w) { w(); }); }

  function waitEvent(timeout) {
    return new Promise(function (resolve) {
      var done = false;
      function fire() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }
      var timer = setTimeout(fire, timeout);
      WAITERS.push(fire);
    });
  }

  /* ==========================================================================
     四、SSE 解析
     坑：网络分块跟语义边界不对齐，一条 data: 可能被切成两半。
     所以要按 \n\n 切事件、buffer 里留半条，切完再拼 JSON。
     ========================================================================== */

  async function* sseLines(resp) {
    var reader = resp.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r$/, '');
        if (ln.slice(0, 5) === 'data:') yield ln.slice(5).trim();
      }
    }
    buf += dec.decode();
    var tail = buf.replace(/\r$/, '').trim();
    if (tail.slice(0, 5) === 'data:') yield tail.slice(5).trim();
  }

  /* ==========================================================================
     五、三种协议的请求构造
     统一输出：{url, headers, body, kind}
     ========================================================================== */

  // 把我们的历史翻成 OpenAI 格式
  function toOpenAI(msgs, sys) {
    var out = [];
    if (sys) out.push({ role: 'system', content: sys });
    var pendingImage = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.kind === 'me') {
        pendingImage = null;
        out.push({ role: 'user', content: m.text || '' });
      } else if (m.kind === 'gu') {
        if (m.text) out.push({ role: 'assistant', content: m.text });
      }
    }
    return out;
  }

  function buildRequest() {
    var model = effModel();
    var sys = (CFG.system || '').trim();
    var history = buildHistory();
    var temp = Number(CFG.temperature);
    var max = Number(CFG.maxTokens) || 4096;

    if (CFG.provider === 'anthropic') {
      var msgs = [];
      history.forEach(function (m) {
        if (m.kind === 'me') msgs.push({ role: 'user', content: m.text || '' });
        else if (m.kind === 'gu' && m.text) msgs.push({ role: 'assistant', content: m.text });
      });
      if (!msgs.length) msgs.push({ role: 'user', content: '（说句话）' });
      var body = {
        model: model,
        max_tokens: max,
        messages: msgs,
        stream: true
      };
      if (sys) body.system = sys;
      if (!isNaN(temp)) body.temperature = temp;
      return {
        kind: 'anthropic',
        url: effBase() + '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': effKey(),
          'anthropic-version': '2023-06-01',
          // 浏览器/WebView 直连 Anthropic 官方必须带这个，否则 403
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: body
      };
    }

    if (CFG.provider === 'gemini') {
      // Gemini 的历史叫 contents，角色是 user / model
      var contents = [];
      history.forEach(function (m) {
        if (m.kind === 'me') contents.push({ role: 'user', parts: [{ text: m.text || '' }] });
        else if (m.kind === 'gu' && m.text) contents.push({ role: 'model', parts: [{ text: m.text }] });
      });
      if (!contents.length) contents.push({ role: 'user', parts: [{ text: '（说句话）' }] });
      var gbody = {
        contents: contents,
        generationConfig: { temperature: isNaN(temp) ? 0.8 : temp, maxOutputTokens: max }
      };
      if (sys) gbody.systemInstruction = { parts: [{ text: sys }] };
      return {
        kind: 'gemini',
        url: effBase() + '/v1beta/models/' + encodeURIComponent(model)
              + ':streamGenerateContent?alt=sse',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': effKey()
        },
        body: gbody
      };
    }

    // 默认 OpenAI 兼容（OpenAI / OpenRouter / DeepSeek / Kimi / 智谱 / 硅基流动 …）
    var base = effBase();
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    var oheaders = {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + effKey()
    };
    // OpenRouter 会拒绝没有 Referer 的匿名调用，带上就没事
    if (/openrouter\.ai/.test(base)) {
      oheaders['HTTP-Referer'] = 'https://dwell.local';
      oheaders['X-Title'] = 'dwell';
    }
    var obody = {
      model: model,
      messages: toOpenAI(history, sys),
      stream: true,
      max_tokens: max
    };
    if (!isNaN(temp)) obody.temperature = temp;
    return { kind: 'openai', url: url, headers: oheaders, body: obody };
  }

  // 拼上下文：system + 最近 N 轮。注意 kind='think' 是思维链，不往回送
  function buildHistory() {
    var n = Number(CFG.historyLimit) || 60;
    var turns = [];
    for (var i = MSGS.length - 1; i >= 0 && turns.length < n * 2; i--) {
      var m = MSGS[i];
      if (m.kind === 'me' || m.kind === 'gu') turns.unshift(m);
    }
    return turns;
  }

  function estTokens() {
    var chars = 0;
    buildHistory().forEach(function (m) { chars += (m.text || '').length; });
    chars += (CFG.system || '').length;
    return { used: Math.ceil(chars / 3.2), max: 200000 };
  }

  /* ==========================================================================
     六、发一轮
     ========================================================================== */

  var ABORT = null;

  /* 跨域兜底
     官方 API（OpenAI / Anthropic / Gemini）都发 CORS 头，浏览器直连没问题。
     但自建中转站不一定发——那种情况下 fetch 会直接以 TypeError 收场。
     所以：真流式先试一次，被拦了就退回原生 HTTP 拿全文，再自己切片模拟流式。
     代价只是打字机变成假的，聊还是能聊。 */
  var NATIVE = (function () {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform
                   && window.Capacitor.isNativePlatform()); }
    catch (e) { return false; }
  })();

  function looksLikeCors(e) {
    if (!e) return false;
    if (e.name === 'TypeError') return true;
    var m = String(e.message || '');
    return /Failed to fetch|NetworkError|Load failed|network error/i.test(m);
  }

  // 走原生通道要复刻请求：CapacitorHttp 用 method/headers/data，url 必须是全的
  async function nativeRequest(req, signal) {
    if (NATIVE && window.CapacitorHttp && window.CapacitorHttp.request) {
      var r = await window.CapacitorHttp.request({
        url: req.url,
        method: 'POST',
        headers: req.headers,
        data: req.body,
        responseType: 'text',
        connectTimeout: 20000,
        readTimeout: 300000
      });
      if (r.status < 200 || r.status >= 300) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        e.raw = r.data;
        throw e;
      }
      return { text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
    }
    throw new Error('no-native');
  }

  /* 拿全文之后，把三种协议的响应拆成 [{t:'think'|'text', v:'...'}] */
  function unpackFullText(req, raw) {
    var out = [];
    var j;
    try { j = JSON.parse(raw); } catch (e) { return { text: raw || '' }; }

    if (req.kind === 'gemini') {
      ((j.candidates || [])[0] ? (((j.candidates[0]).content || {}).parts || []) : [])
        .forEach(function (p) {
          if (p.thought && p.text) out.push({ t: 'think', v: p.text });
          else if (p.text) out.push({ t: 'text', v: p.text });
        });
      return out;
    }
    if (req.kind === 'anthropic') {
      (j.content || []).forEach(function (p) {
        if (p.type === 'thinking') out.push({ t: 'think', v: p.thinking || '' });
        else if (p.type === 'text') out.push({ t: 'text', v: p.text || '' });
      });
      return out;
    }
    if (j.error) throw new Error((j.error.message || '模型报错'));
    var m = (((j.choices || [])[0] || {}).message || {});
    var rsn = m.reasoning_content || m.reasoning;
    if (rsn) out.push({ t: 'think', v: rsn });
    if (m.content) out.push({ t: 'text', v: m.content });
    return out;
  }

  async function runTurn(userText, attachments) {
    var req = buildRequest();
    var text = '';
    var think = '';

    function deltaText(t) {
      if (!t) return;
      text += t;
      emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: t } } });
    }
    function deltaThink(t) {
      if (!t) return;
      think += t;
      emit({ type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: t } } });
    }

    try {
      ABORT = new AbortController();
      var resp = null, native = false;

      try {
        resp = await realFetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: ABORT.signal
        });
      } catch (e) {
        // 被 CORS 拦了就换原生通道再试一次
        if (NATIVE && looksLikeCors(e)) native = true; else throw e;
      }

      if (native) {
        emit({ type: 'system', subtype: 'init', model: effModel() + ' · 原生通道' });
        var nreq = { url: req.url, headers: req.headers, body: JSON.parse(JSON.stringify(req.body)) };
        nreq.body.stream = false;
        var nat = await nativeRequest(nreq);
        var parts = unpackFullText(req, nat.text);
        var got = false;
        for (var pi = 0; pi < parts.length; pi++) {
          var vv = String(parts[pi].v || '');
          if (!vv) continue;
          got = true;
          var isThink = parts[pi].t === 'think';
          for (var ci = 0; ci < vv.length; ci += 20) {
            if (isThink) deltaThink(vv.slice(ci, ci + 20)); else deltaText(vv.slice(ci, ci + 20));
            await new Promise(function (r) { setTimeout(r, 14); });
          }
        }
        if (!got) emit({ type: 'stderr', text: '模型这轮什么都没说。' });
      } else {
      if (!resp.ok) {
        var raw = '';
        try { raw = await resp.text(); } catch (e) {}
        var detail = raw;
        try { detail = (JSON.parse(raw).error || {}).message || raw; } catch (e) {}
        emit({ type: 'stderr', text: '模型那边没接住（HTTP ' + resp.status + '）：'
              + String(detail).slice(0, 300) });
        emit({ type: 'result', is_error: true, result: 'HTTP ' + resp.status });
        return;
      }

      var ct = resp.headers.get('content-type') || '';

      /* ---- Gemini：SSE，每行一个 candidates ---- */
      if (req.kind === 'gemini') {
        for await (var g of sseLines(resp)) {
          if (!g || g === '[DONE]') continue;
          var gd;
          try { gd = JSON.parse(g); } catch (e) { continue; }
          var cands = gd.candidates || [];
          for (var ci = 0; ci < cands.length; ci++) {
            var parts = ((cands[ci].content || {}).parts) || [];
            for (var pi = 0; pi < parts.length; pi++) {
              var pt = parts[pi];
              // Gemini 的"思考"标记有两种，都试着认一下
              if (pt.thought && pt.text) deltaThink(pt.text);
              else if (pt.text) deltaText(pt.text);
            }
          }
        }
      }
      /* ---- Anthropic：SSE，带 event 名的 data 行 ---- */
      else if (req.kind === 'anthropic') {
        for await (var a of sseLines(resp)) {
          if (!a || a === '[DONE]') continue;
          var ad;
          try { ad = JSON.parse(a); } catch (e) { continue; }
          if (ad.type === 'content_block_delta' && ad.delta) {
            if (ad.delta.type === 'text_delta') deltaText(ad.delta.text);
            else if (ad.delta.type === 'thinking_delta') deltaThink(ad.delta.thinking);
          } else if (ad.type === 'error') {
            emit({ type: 'stderr', text: '模型报错：' + ((ad.error || {}).message || '未知') });
          }
        }
      }
      /* ---- OpenAI 兼容 ---- */
      else if (/text\/event-stream/.test(ct) || req.kind === 'openai') {
        for await (var o of sseLines(resp)) {
          if (!o || o === '[DONE]') continue;
          var od;
          try { od = JSON.parse(o); } catch (e) { continue; }
          if (od.error) {
            emit({ type: 'stderr', text: '模型报错：' + (od.error.message || '未知') });
            continue;
          }
          var ch = (od.choices || [])[0];
          if (!ch) continue;
          var dl = ch.delta || {};
          // DeepSeek / Kimi / OpenRouter 的思维链字段名五花八门
          var rsn = dl.reasoning_content || dl.reasoning || (dl.reasoning_details || [])[0];
          if (typeof rsn === 'string' && rsn) deltaThink(rsn);
          if (typeof dl.content === 'string' && dl.content) deltaText(dl.content);
        }
      }
      /* ---- 兜底：不是流式，整段拿回来自己切片 ---- */
      else {
        var jd = await resp.json();
        var pick = '';
        if (jd.candidates) {
          ((jd.candidates[0] || {}).content || {}).parts
            .forEach(function (p) { pick += p.text || ''; });
        } else if (jd.choices) {
          pick = (((jd.choices[0] || {}).message || {}).content) || '';
        } else if (jd.content) {
          (Array.isArray(jd.content) ? jd.content : []).forEach(function (p) {
            if (p.type === 'text') pick += p.text;
          });
        }
        // 一大段硬切成小块吐出来，前端的打字机效果就有了
        for (var i2 = 0; i2 < pick.length; i2 += 24) {
          deltaText(pick.slice(i2, i2 + 24));
          await new Promise(function (r) { setTimeout(r, 16); });
        }
      }
      }   // ← native 降级分支到此为止

      /* ---- 定稿：落库 + 发权威消息 ---- */
      if (think) addMsg('think', think);
      var finalText = text.trim();
      if (finalText) {
        addMsg('gu', finalText);
        touchChat(finalText);
        var content = [];
        if (think) content.push({ type: 'thinking', thinking: think });
        content.push({ type: 'text', text: finalText });
        emit({ type: 'assistant', message: { content: content } });
      } else if (!think) {
        emit({ type: 'stderr', text: '模型这轮什么都没说。' });
      }
      emit({ type: 'result', is_error: false, result: finalText });
    } catch (e) {
      if (ABORT && ABORT.signal.aborted) {
        // 主动停：已经说的半截照样存住
        var t2 = text.trim();
        if (t2) { addMsg('gu', t2); emit({ type: 'system', subtype: 'stopped', text: t2 }); }
        emit({ type: 'result', is_error: false, result: t2 });
        return;
      }
      emit({ type: 'stderr', text: '请求失败：' + (e && e.message ? e.message : String(e)) });
      emit({ type: 'result', is_error: true, result: (e && e.message) || '连不上' });
    } finally {
      ABORT = null;
    }
  }

  /* ==========================================================================
     七、路由：把前端那些 api/xxx 接到本地实现
     ========================================================================== */

  var EMPTY = {
    'api/notes': { gu: [], her: [] },
    'api/whisper': { items: [] },
    'api/dreams': { items: [] },
    'api/herdiary': { items: [] },
    'api/gong': { msgs: [] },
    'api/night': { days: [] },
    'api/cal': { ok: true, events: [], period: null },
    'api/news': { ok: false },
    'api/nook': { ok: false },
    'api/health': { ok: false },
    'api/wall': { ok: true, bricks: [] },
    'api/favlines': { ok: true, text: '' },
    'api/todos': { ok: true, mine: [], yours: [] },
    'api/music': { ok: false },
    'api/repo/log': { ok: true, total: 0, skip: 0, items: [] },
    'api/repo/tree': { ok: true, path: '', items: [] },
    'api/usage': { ok: true, items: [] }
  };

  function find(q) {
    var out = [];
    var k = String(q || '').toLowerCase();
    if (!k) return { ok: true, items: [] };
    MSGS.forEach(function (m) {
      if (m.text && m.text.toLowerCase().indexOf(k) >= 0) {
        out.push({ seq: m.seq, kind: m.kind, text: m.text.slice(0, 200), at: m.at });
      }
    });
    return { ok: true, items: out.slice(-60) };
  }

  function status() {
    return {
      ok: true,
      has: hasCfg(),
      provider: CFG.provider,
      model: effModel(),
      busy: !!ABORT,
      msgs: MSGS.length
    };
  }

  function authmode() {
    return {
      mode: hasCfg() ? 'api' : 'sub',
      base: hasCfg() ? (trimBase(CFG.base) || curPreset().base) : '',
      models: { model_opus: CFG.model || '' },
      provider: CFG.provider
    };
  }

  // 「试一试」：真发一次最小请求
  async function apitest(v) {
    var provider = v.provider || CFG.provider;
    var prev = Object.assign({}, CFG);
    Object.assign(CFG, {
      provider: provider,
      base: (v.base || '').trim(),
      key: (v.token || '').trim() || effKey(),
      model: (v.model || v.model_opus || '').trim() || effModel()
    });
    var req = buildRequest();
    req.body.stream = false;
    try {
      var r = await realFetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body)
      });
      var t = '';
      try { t = await r.text(); } catch (e) {}
      if (!r.ok) {
        var d = '';
        try { d = (JSON.parse(t).error || {}).message || t; } catch (e) { d = t; }
        return { ok: false, code: 'HTTP ' + r.status, detail: String(d).slice(0, 300), url: req.url };
      }
      var j = {};
      try { j = JSON.parse(t); } catch (e) {}
      var name = j.model || (j.candidates && ((j.candidates[0] || {}).model || ''))
                 || ((j.choices || [])[0] || {}).model || '';
      return { ok: true, model: name || effModel(), url: req.url };
    } catch (e) {
      return { ok: false, code: '连不上', detail: (e && e.message) || String(e), url: req.url };
    } finally {
      Object.assign(CFG, prev);
    }
  }

  async function route(input, init) {
    init = init || {};
    var url = String(typeof input === 'string' ? input : (input && input.url) || '');
    var path = url.split('?')[0].replace(/^\.\//, '');
    var qs = {};
    var qi = url.indexOf('?');
    if (qi >= 0) {
      url.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        qs[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    var method = (init.method || 'GET').toUpperCase();

    function body() {
      try { return init.body ? JSON.parse(init.body) : {}; } catch (e) { return {}; }
    }

    /* --- 聊天主链路 --- */
    if (path === 'api/said') return J(messagesSlice(400, 0));
    if (path === 'api/messages') return J(messagesSlice(
      parseInt(qs.limit, 10) || 400, parseInt(qs.before, 10) || 0));

    if (path === 'api/poll') {
      var since = parseInt(qs.since, 10) || 0;
      // 游标跑到前头（事件被重置过）：返回空的，别把整段历史重放一遍——
      // 前端 loadSaid() 已经把历史摆出来了，重放会让它渲染两次。
      if (since > EV.length) return J({ ver: 'dwell-1', next: EV.length, events: [] });
      if (since < EV.length) {
        return J({ ver: 'dwell-1', next: EV.length, events: EV.slice(since) });
      }
      await waitEvent(25000);              // 长轮询，最多挂 25 秒
      since = Math.min(since, EV.length);
      return J({ ver: 'dwell-1', next: EV.length, events: EV.slice(since) });
    }

    if (path === 'api/events') {
      var s2 = parseInt(qs.since, 10) || 0;
      if (s2 >= EV.length) await waitEvent(25000);
      s2 = Math.min(s2, EV.length);
      return J({ next: EV.length, events: EV.slice(s2) });
    }

    if (path === 'api/send') {
      var b = body();
      var text = (b.text || '').trim();
      if (!text && !(b.attachments && b.attachments.length)) return J({ ok: false });

      addMsg('me', text);
      emit({ type: 'echo', text: text });

      if (!hasCfg()) {
        emit({ type: 'stderr', text: '还没配模型。菜单 → 设置 → 模型接入，填上地址和令牌。' });
        emit({ type: 'result', is_error: true, result: '没配模型' });
        return J({ ok: true });
      }

      runTurn(text, b.attachments);          // 不 await：让它在后台跑，事件走 poll
      return J({ ok: true });
    }

    if (path === 'api/stop') {
      if (ABORT) { try { ABORT.abort(); } catch (e) {} }
      return J({ ok: true });
    }

    if (path === 'api/newchat') {
      var armed = (body() || {}).arm;
      resetMsgs();
      resetEvents();
      if (armed !== false) {
        emit({ type: 'system', subtype: 'newchat', text: '新开了一页，干净的。' });
      }
      return J({ ok: true });
    }

    /* --- 模型 / 配置 --- */
    if (path === 'api/model') {
      if (method === 'POST') {
        var mb = body();
        if (mb.model) CFG.model = mb.model;
        if (mb.effort) CFG.effort = mb.effort;
        saveCfg();
        emit({ type: 'system', subtype: 'init', model: effModel() });
        emit({ type: 'result', is_error: false, result: effModel() });
      }
      return J({ model: effModel(), name: effModel(), effort: CFG.effort,
                 provider: CFG.provider, configured: hasCfg() });
    }

    if (path === 'api/apiconf') {
      var cb = body();
      if (cb.clear) {
        saveCfg({ key: '', base: '', model: '' });
        return J({ mode: 'sub', ok: true });
      }
      var patch = {};
      if (cb.provider) patch.provider = cb.provider;
      if (typeof cb.base === 'string') patch.base = cb.base.trim();
      if (typeof cb.token === 'string' && cb.token.trim()) patch.key = cb.token.trim();
      if (cb.model || cb.model_opus) patch.model = (cb.model || cb.model_opus).trim();
      if (typeof cb.system === 'string') patch.system = cb.system;
      if (cb.temperature != null) patch.temperature = Number(cb.temperature);
      if (cb.maxTokens != null) patch.maxTokens = Number(cb.maxTokens);
      if (cb.historyLimit != null) patch.historyLimit = Number(cb.historyLimit);
      saveCfg(patch);
      emit({ type: 'system', subtype: 'switched', text: '换好了。' });
      return J({ mode: hasCfg() ? 'api' : 'sub',
                 base: trimBase(CFG.base) || curPreset().base, ok: true });
    }

    if (path === 'api/authmode') return J(authmode());
    if (path === 'api/apitest') return J(await apitest(body()));

    if (path === 'api/context') return J(estTokens());
    if (path === 'api/status') return J(status());

    if (path === 'api/chats') {
      if (method === 'POST') {
        var ab = body();
        if (ab && ab.title) { touchChat(ab.title); }
        return J({ ok: true });
      }
      return J({ items: chatList() });
    }

    if (path === 'api/find') return J(find(qs.q));
    if (path === 'api/notes') return J(EMPTY['api/notes']);
    if (path === 'api/upload') return J({ ok: true });

    if (path === 'api/rewake') { resetEvents(); return J({ ok: true }); }
    if (path === 'api/wake') return J({ ok: true });
    if (path === 'api/dreams') return J(EMPTY['api/dreams']);
    if (path === 'api/said_list') return J({ msgs: [] });

    if (EMPTY[path]) return J(EMPTY[path]);
    if (path.indexOf('api/') === 0) return J({ ok: true });

    return realFetch.apply(null, arguments);
  }

  /* ==========================================================================
     八、设置面板
     原来的「备用通道」只给 Anthropic 订阅用（base/token/model_opus 三个框），
     接不了别家。这里另开一页，三种协议都能配。
     ========================================================================== */

  function injectUI() {
    if (document.getElementById('dwellSheet')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#dwellSheet{position:fixed;inset:0;z-index:9998;display:none}',
      '#dwellSheet.open{display:block}',
      '#dwellSheet .dv-bd{position:absolute;inset:0;background:rgba(40,38,34,.4)}',
      '#dwellSheet .dv-pn{position:absolute;left:0;right:0;bottom:0;max-height:88vh;overflow:auto;',
      'background:var(--card);border-radius:18px 18px 0 0;padding:22px 20px 30px;',
      'border-top:1px solid var(--line);box-shadow:0 -8px 40px rgba(0,0,0,.18)}',
      '#dwellSheet h1{font-size:19px;margin:0 0 4px;font-weight:650}',
      '#dwellSheet .sub{color:var(--dim);font-size:13px;margin-bottom:16px;line-height:1.55}',
      '#dwellSheet .lb{font-size:12px;color:var(--dim);margin:14px 0 5px}',
      '#dwellSheet input,#dwellSheet select,#dwellSheet textarea{width:100%;box-sizing:border-box;',
      'padding:11px 12px;font-size:15px;border-radius:10px;border:1px solid var(--line);',
      'background:var(--bg);color:var(--text);font-family:inherit}',
      '#dwellSheet textarea{min-height:88px;resize:vertical;line-height:1.6}',
      '#dwellSheet .btns{display:flex;gap:10px;margin-top:20px}',
      '#dwellSheet button{flex:1;padding:12px;border-radius:11px;border:1px solid var(--line);',
      'background:var(--panel);color:var(--text);font-size:15px;font-family:inherit}',
      '#dwellSheet button.go{background:var(--accent);color:#fff;border-color:transparent}',
      '#dwellSheet .msg{margin-top:12px;font-size:13px;line-height:1.6;white-space:pre-wrap}',
      '#dwellSheet .msg.bad{color:var(--red)}',
      '#dwellSheet .msg.ok{color:var(--green)}',
      '#dwellSheet .note{margin-top:16px;font-size:12px;color:var(--dim);line-height:1.65}',
      '#dwellSheet .row2{display:flex;gap:10px}',
      '#dwellSheet .row2>*{flex:1}',
      '#dwellSheet .back{margin-bottom:8px}'
    ].join('');
    document.head.appendChild(style);

    var sheet = document.createElement('div');
    sheet.id = 'dwellSheet';
    sheet.innerHTML =
      '<div class="dv-bd" id="dvBack"></div>'
      + '<div class="dv-pn">'
      + '<button class="back" id="dvBack2">‹ 返回</button>'
      + '<h1>模型接入</h1>'
      + '<div class="sub">三种协议随便挑，配好就能聊。令牌只存在这台设备上。</div>'
      + '<div class="lb">协议</div>'
      + '<select id="dvProv">'
      + '<option value="openai">OpenAI 兼容（含绝大多数中转站）</option>'
      + '<option value="anthropic">Anthropic Messages</option>'
      + '<option value="gemini">Google Gemini</option>'
      + '</select>'
      + '<div class="lb">接口地址</div>'
      + '<input id="dvBase" placeholder="">'
      + '<div class="lb">令牌（API Key）</div>'
      + '<input id="dvKey" type="password" placeholder="留空=沿用已保存的">'
      + '<div class="lb">模型名</div>'
      + '<input id="dvModel" placeholder="">'
      + '<div class="row2">'
      + '<div><div class="lb">温度</div><input id="dvTemp" type="number" step="0.1" min="0" max="2"></div>'
      + '<div><div class="lb">最大长度</div><input id="dvMax" type="number" step="256" min="256"></div>'
      + '</div>'
      + '<div class="lb">人设 / 系统提示词</div>'
      + '<textarea id="dvSys" placeholder="你希望他是什么样子。留空就是默认助手。"></textarea>'
      + '<div class="lb">带进上下文的轮数</div>'
      + '<input id="dvHist" type="number" min="2" max="400">'
      + '<div class="btns">'
      + '<button id="dvTest">试一试</button>'
      + '<button class="go" id="dvSave">保存</button>'
      + '</div>'
      + '<div class="msg" id="dvMsg"></div>'
      + '<div class="note" id="dvHint"></div>'
      + '</div>';
    document.body.appendChild(sheet);

    var $ = function (id) { return document.getElementById(id); };

    function fill() {
      $('dvProv').value = CFG.provider;
      $('dvBase').value = CFG.base || '';
      $('dvModel').value = CFG.model || '';
      $('dvKey').value = '';
      $('dvTemp').value = CFG.temperature;
      $('dvMax').value = CFG.maxTokens;
      $('dvSys').value = CFG.system || '';
      $('dvHist').value = CFG.historyLimit;
      $('dvHint').textContent = curPreset().hint
        + '\n当前对话上下文约 ' + estTokens().used + ' 字符量级。'
        + '保存后会自动新开一轮。';
    }

    function vals() {
      return {
        provider: $('dvProv').value,
        base: $('dvBase').value.trim(),
        token: $('dvKey').value.trim(),
        model: $('dvModel').value.trim(),
        system: $('dvSys').value,
        temperature: $('dvTemp').value,
        maxTokens: $('dvMax').value,
        historyLimit: $('dvHist').value
      };
    }
    function say(t, cls) { $('dvMsg').textContent = t; $('dvMsg').className = 'msg ' + (cls || ''); }

    function close() { sheet.classList.remove('open'); }

    $('dvBack').onclick = close;
    $('dvBack2').onclick = close;
    $('dvProv').onchange = function () {
      var p = PRESET[this.value];
      $('dvBase').placeholder = p.base;
      $('dvModel').placeholder = p.model;
      $('dvHint').textContent = p.hint;
    };

    $('dvTest').onclick = async function () {
      say('正在敲门…');
      var r = await apitest(vals());
      if (r.ok) say('通了 —— 对面回的模型是 ' + (r.model || '(没报名字)'), 'ok');
      else say('没通（' + (r.code || '连不上') + '）\n' + (r.detail || ''), 'bad');
    };

    $('dvSave').onclick = async function () {
      var v = vals();
      saveCfg({
        provider: v.provider, base: v.base, model: v.model, system: v.system,
        temperature: v.temperature, maxTokens: v.maxTokens, historyLimit: v.historyLimit
      });
      if (v.token) saveCfg({ key: v.token });
      say('存好了，正在重开一轮…', 'ok');
      setTimeout(function () {
        close();
        resetMsgs();
        resetEvents();
        emit({ type: 'system', subtype: 'switched',
               text: '换好了。现在是 ' + (CFG.provider) + ' · ' + effModel() });
      }, 700);
    };

    // 在设置菜单里塞一个入口
    var menuItem = document.querySelector('.mi[data-act="settings"]');
    if (menuItem && menuItem.parentNode) {
      var mi = document.createElement('button');
      mi.className = 'mi';
      mi.innerHTML = '<span class="ic">◇</span>模型接入';
      mi.onclick = function (e) {
        e.stopPropagation();
        fill();
        say('');
        sheet.classList.add('open');
      };
      menuItem.parentNode.insertBefore(mi, menuItem.nextSibling);
    }

    // 键盘/返回键关掉
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheet.classList.contains('open')) close();
    });
  }

  /* ==========================================================================
     九、挂上
     ========================================================================== */

  window.fetch = function (input, init) {
    try { return route(input, init); }
    catch (e) {
      console.error('[dwell] 路由异常', e);
      return J({ ok: false, error: String(e) });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }

  // 给原生层留个口：把 key 交出去用原生请求（CORS 兜底）
  window.dwellConfig = function () {
    return { provider: CFG.provider, base: effBase(), key: effKey(), model: effModel(),
             system: CFG.system, temperature: CFG.temperature, maxTokens: CFG.maxTokens,
             history: buildHistory(), seq: upto() };
  };

  console.log('[dwell] 适配层已接管 fetch');
})();
