// ── 诊断：用真实的请求去定位"为什么没回复" ────────────────────
//
// 设计原则：**绝不吞掉任何原始信息**。
// 每一步都保留 HTTP 状态码、响应体原文、耗时。定位不了问题时，
// 至少能让用户把这段报告复制出来给别人看。
//
// 分步的意义在于隔离变量：
//   1. 本地检查（Key、地址、工具 Schema 结构）
//   2. GET /models          → 网络 + 鉴权通不通
//   3. 最小对话（不带工具）  → 模型本身能不能答
//   4. 最小对话（带工具）    → **工具定义是不是被拒绝**
//   5. 非流式 + 带工具       → 区分是工具的问题还是流式的问题

import { loadSettings, apiUrl, DEFAULTS } from './config.js';
import { TOOL_DEFS, toolsForTurn } from './tools.js';
import { getTestAccess, workerConfigured } from './workerApi.js';

const truncate = (s, n = 700) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…（共 ${t.length} 字符）` : t;
};

/** 带超时的原始请求，非 2xx 不抛错，把状态和原文都带回来 */
async function rawFetch(url, init = {}, timeoutMs = 30000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text, ms: Date.now() - t0, timeout: false };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: e?.name === 'AbortError'
        ? `请求超时（超过 ${timeoutMs / 1000} 秒）`
        : `网络错误：${e?.message || e}`,
      ms: Date.now() - t0,
      timeout: e?.name === 'AbortError',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本地静态检查：工具定义本身有没有结构问题。
 * 这类问题只会在真实请求里暴露（本地测试用的是桩），所以值得单独查。
 */
export function validateToolSchemas() {
  const problems = [];
  for (const t of TOOL_DEFS) {
    const f = t?.function;
    const name = f?.name || '(未命名)';

    if (t.type !== 'function') problems.push(`${name}: type 必须是 "function"`);
    if (!f?.name) problems.push('有工具缺少 function.name');
    if (!f?.description) problems.push(`${name}: 缺少 description`);

    const p = f?.parameters;
    if (!p || typeof p !== 'object') { problems.push(`${name}: 缺少 parameters`); continue; }
    if (p.type !== 'object') problems.push(`${name}: parameters.type 必须是 "object"`);
    if (!p.properties || typeof p.properties !== 'object') {
      problems.push(`${name}: 缺少 properties`);
      continue;
    }

    for (const [k, v] of Object.entries(p.properties)) {
      if (!v || typeof v !== 'object') { problems.push(`${name}.${k}: 不是对象`); continue; }
      if (!v.type && !v.anyOf && !v.oneOf) problems.push(`${name}.${k}: 缺少 type`);
      if (v.type === 'array' && !v.items) problems.push(`${name}.${k}: array 缺少 items`);
      if (v.type === 'enum') problems.push(`${name}.${k}: 用了 type:"enum"，应为 type:"string" + enum`);
    }

    if (Array.isArray(p.required)) {
      for (const r of p.required) {
        if (!p.properties[r]) problems.push(`${name}: required 里的 "${r}" 不在 properties 中`);
      }
    }

    const size = JSON.stringify(t).length;
    if (size > 5000) problems.push(`${name}: 定义过长（${size} 字符）`);
  }
  return problems;
}

const ok = (name, detail, extra = {}) => ({ name, ok: true, detail, ...extra });
const bad = (name, detail, extra = {}) => ({ name, ok: false, detail, ...extra });
const info = (name, detail, extra = {}) => ({ name, ok: null, detail, ...extra });

/**
 * 跑完整诊断。
 * @param {(step: object, index: number, total: number) => void} [onStep]
 */
export async function runDiagnostics(onStep = () => {}) {
  const s = loadSettings();
  const steps = [];
  const push = (step) => { steps.push(step); onStep(step, steps.length); return step; };

  /* ── 0. 本地配置 ── */
  push(workerConfigured()
    ? info('DeepSeek API Key', '由站点 Worker 保存，浏览器不接触站长密钥')
    : s.apiKey
    ? ok('API Key 已填写', `${s.apiKey.slice(0, 6)}…${s.apiKey.slice(-4)}（共 ${s.apiKey.length} 字符）`)
    : bad('API Key 已填写', '没有填写。先去设置里填上。'));
  push(info('API 地址', s.baseUrl));
  push(info('对话模型', s.model));
  push(info('工具调用', s.enableTools ? `已启用，本轮下发全部 ${TOOL_DEFS.length} 个` : '已关闭'));

  // 注意别直接写 location：某些运行环境（例如测试用的 jsdom 沙箱）没有这个全局，
  // 裸引用会抛 ReferenceError 把整个诊断打断。
  const proto = globalThis.location?.protocol ?? '未知';
  push(info('页面协议', proto === 'file:'
    ? 'file:// —— ES 模块和 IndexedDB 在此协议下会被浏览器拦截，请改用本地服务器（npm run serve）'
    : proto));

  /* ── 1. 工具 Schema 本地校验 ── */
  const schemaProblems = validateToolSchemas();
  push(schemaProblems.length
    ? bad('工具定义结构检查', `发现 ${schemaProblems.length} 个问题：${schemaProblems.slice(0, 3).join('；')}`)
    : ok('工具定义结构检查', `${TOOL_DEFS.length} 个工具结构合法`));

  if (workerConfigured()) {
    try {
      const { access } = await getTestAccess();
      if (!access.authenticated) push(bad('后端账号登录', '请先登录测试账号'));
      else if (!access.entitled) push(bad('后端体验权限', '账号尚未兑换有效体验码'));
      else push(ok('后端体验权限', `有效至 ${access.expiresAt}；剩余 ${access.remainingRequests} 次，今日剩余 ${access.dailyRemaining} 次`));
    } catch (error) {
      push(bad('Worker 后端连接', error.message || String(error)));
    }
    push(info('DeepSeek 请求', '诊断没有发送计费请求；正式对话由 Worker 代理并记录用量'));
    return { steps, verdict: '后端模式诊断完成；设置中的「测试连接」会验证登录与体验权限。', raw: '', report: '' };
  }

  if (!s.apiKey) {
    return { steps, verdict: '没填 API Key，后面的网络测试跳过。', raw: '', report: '' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${s.apiKey}`,
  };
  const base = String(s.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');

  /* ── 2. 鉴权与网络 ── */
  const models = await rawFetch(`${base}/models`, { headers, method: 'GET' }, 20000);
  if (models.ok) {
    let ids = [];
    try { ids = (JSON.parse(models.text).data || []).map(m => m.id); } catch { /* ignore */ }
    push(ok('鉴权与网络（GET /models）', `${models.status}　可用模型：${ids.join('、') || '(未返回列表)'}`, { ms: models.ms }));
  } else {
    push(bad('鉴权与网络（GET /models）', `${models.status}　${truncate(models.text, 300)}`, { ms: models.ms, raw: models.text }));
  }

  const minimal = model => ({
    model,
    messages: [{ role: 'user', content: '只回一个字：通' }],
  });

  /* ── 3. 最小对话（非流式、不带工具）── */
  const plain = await rawFetch(apiUrl(base), {
    method: 'POST', headers, body: JSON.stringify(minimal(s.model)),
  }, 60000);
  if (plain.ok) {
    let content = '';
    try { content = JSON.parse(plain.text).choices?.[0]?.message?.content ?? ''; } catch { /* ignore */ }
    push(ok('基础对话（非流式、不带工具）', `模型回了「${content}」`, { ms: plain.ms }));
  } else {
    push(bad('基础对话（非流式、不带工具）',
      `${plain.status}　${truncate(plain.text, 400)}`, { ms: plain.ms, raw: plain.text }));
  }

  /* ── 4. 非流式 + 带工具 ── */
  const { tools, names } = toolsForTurn();
  const withTools = await rawFetch(apiUrl(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...minimal(s.model),
      tools,
      tool_choice: 'auto',
    }),
  }, 90000);
  if (withTools.ok) {
    let msg = null;
    try { msg = JSON.parse(withTools.text).choices?.[0]?.message; } catch { /* ignore */ }
    push(ok('带工具定义（非流式）',
      `接受全部 ${tools.length} 个工具定义，无报错。返回 ${msg?.tool_calls ? '工具调用' : `文本「${truncate(msg?.content ?? '', 40)}」`}`,
      { ms: withTools.ms }));
  } else {
    push(bad('带工具定义（非流式）',
      `${withTools.status}　${truncate(withTools.text, 600)}`,
      { ms: withTools.ms, raw: withTools.text }));
    push(info('被下发的工具清单', names.join('、')));
  }

  /* ── 5. 流式 + 带工具（这才是应用真正用的路径）── */
  const streamRes = await rawFetch(apiUrl(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'user', content: '只回一个字：通' }],
      stream: true,
      tools,
      tool_choice: 'auto',
    }),
  }, 90000);

  if (streamRes.ok) {
    const looksLikeSSE = /^data:/m.test(streamRes.text);
    const hasDelta = /"delta"/.test(streamRes.text);
    if (looksLikeSSE && hasDelta) {
      push(ok('流式 + 带工具（应用实际路径）',
        `收到 SSE 数据流，含 delta 分片。首 120 字符：${truncate(streamRes.text.replace(/\s+/g, ' '), 120)}`,
        { ms: streamRes.ms }));
    } else {
      push(bad('流式 + 带工具（应用实际路径）',
        `返回 200 但不是预期的 SSE 格式，首 300 字符：${truncate(streamRes.text.replace(/\s+/g, ' '), 300)}`,
        { ms: streamRes.ms, raw: streamRes.text }));
    }
  } else {
    push(bad('流式 + 带工具（应用实际路径）',
      `${streamRes.status}　${truncate(streamRes.text, 600)}`,
      { ms: streamRes.ms, raw: streamRes.text }));
  }

  /* ── 6. stream_options 兼容性 ── */
  const withUsage = await rawFetch(apiUrl(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'user', content: '通' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  }, 60000);
  push(withUsage.ok
    ? ok('stream_options.include_usage 支持', '端点接受该参数')
    : info('stream_options.include_usage 支持',
      `${withUsage.status}　${truncate(withUsage.text, 300)}（应用会自动回退到不带它的请求）`));

  /* ── 结论 ── */
  const failed = steps.filter(x => x.ok === false);
  let verdict;
  if (!failed.length) {
    verdict = '全部通过。如果应用里仍然收不到回复，问题在浏览器端 —— 打开开发者工具（F12）看 Console 里有没有红色报错，把内容发出来。';
  } else if (failed.some(f => /鉴权与网络/.test(f.name))) {
    verdict = '卡在鉴权或网络。检查 Key 是否正确、余额是否充足、网络能否访问该地址。';
  } else if (failed.some(f => /带工具|流式/.test(f.name)) && !failed.some(f => /基础对话/.test(f.name))) {
    verdict = '**基础对话正常，但带工具就失败 —— 问题出在工具定义或工具数量上。**'
      + '可以先去设置里暂时关闭「工具调用」，确认对话能通。';
  } else if (failed.some(f => /基础对话/.test(f.name))) {
    verdict = '连最小的对话请求都失败。多半是 Key、余额或模型名的问题。';
  } else {
    verdict = '有步骤失败，详见上面的原始响应。';
  }

  return { steps, verdict, raw: buildRaw(steps), report: buildReport(steps, verdict, s) };
}

/* ══════════ 报告生成 ══════════ */

function buildRaw(steps) {
  return steps
    .filter(x => x.raw)
    .map(x => `### ${x.name}\n状态/内容：${x.detail}\n原始响应：\n${x.raw}`)
    .join('\n\n');
}

function buildReport(steps, verdict, s) {
  const L = [];
  L.push('## 帕尼尼 · 连接诊断报告');
  L.push(`时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`浏览器：${navigator.userAgent}`);
  L.push(`API 地址：${s.baseUrl}`);
  L.push(`模型：${s.model}`);
  L.push('');
  L.push('### 检查项');
  for (const st of steps) {
    const mark = st.ok === true ? '✅' : st.ok === false ? '❌' : 'ℹ️';
    L.push(`${mark} **${st.name}**${st.ms != null ? `（${st.ms}ms）` : ''}`);
    L.push(`   ${String(st.detail).replace(/\n/g, '\n   ')}`);
    if (st.raw) L.push(`   原始响应：\n   \`\`\`\n   ${truncate(st.raw, 1500).replace(/\n/g, '\n   ')}\n   \`\`\``);
  }
  L.push('');
  L.push('### 结论');
  L.push(verdict);
  return L.join('\n');
}
