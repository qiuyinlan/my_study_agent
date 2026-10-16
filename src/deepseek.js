// ── DeepSeek API 客户端：浏览器直连官方接口（官方支持 CORS）──
// 流式 SSE 解析 + function calling 增量拼接 + 中文错误提示 + 超时保护
//
// 超时这件事很关键：早先这里完全没有超时。一旦请求挂住（网络抖动、
// 服务端不响应），runTurn 永远不会 resolve，busy 就永远停在 true，
// **之后每一条消息都会被静默丢弃** —— 表现为"突然就不回答了"。

import { loadSettings, apiUrl } from './config.js';
import { getWorkerSession, workerChat, workerConfigured } from './workerApi.js';

export class ApiError extends Error {
  constructor(message, { status, raw, kind } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.raw = raw;
    this.kind = kind; // 'http' | 'timeout' | 'network' | 'config'
  }
}

const STATUS_MESSAGES = {
  400: '请求格式有误',
  401: 'API Key 无效或未填写 —— 去「设置」里检查一下',
  402: '账户余额不足，请到 DeepSeek 开放平台充值',
  403: '没有权限访问该模型',
  404: '接口地址不对 —— 检查「设置」里的 API 地址',
  413: '请求内容太大',
  422: '请求参数不被接受',
  429: '请求太频繁或超出配额，等几秒再试',
  500: 'DeepSeek 服务端错误，稍后重试',
  502: 'DeepSeek 网关错误，稍后重试',
  503: 'DeepSeek 服务暂时不可用（高峰期常见），稍后重试',
  504: 'DeepSeek 服务端超时，稍后重试',
};

function errFromText(status, raw) {
  let detail = '';
  try {
    const j = JSON.parse(raw);
    detail = typeof j?.error === 'string' ? j.error : j?.error?.message || j?.message || '';
  } catch { /* 非 JSON，忽略 */ }
  const base = STATUS_MESSAGES[status] || `请求失败（HTTP ${status}）`;
  return new ApiError(detail ? `${base}：${detail}` : base, { status, raw, kind: 'http' });
}

async function readError(res) {
  let raw = '';
  try { raw = await res.text(); } catch { /* ignore */ }
  return errFromText(res.status, raw);
}

const isReasoner = model => /reasoner|r1|think/i.test(model || '');

/* ══════════ 超时参数 ══════════ */

/** 从发出请求到拿到响应头的时间上限 */
const CONNECT_TIMEOUT_MS = 30000;
/** 两个数据分片之间的最长间隔；超过就认定连接已经死了 */
const IDLE_TIMEOUT_MS = 90000;

function doFetch(body, signal) {
  if (workerConfigured()) return workerChat(body, signal);
  const s = loadSettings();
  if (!s.apiKey) {
    throw new ApiError('还没填 API Key —— 点右上角「设置」填入。', { status: 401, kind: 'config' });
  }
  return fetch(apiUrl(s.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * 流式对话。
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, usage:object|null, finishReason:string|null}>}
 */
export async function streamChat({
  messages,
  tools,
  model,
  signal,
  onDelta,
  onReasoning,
  includeUsage,
  toolChoice = 'auto',
  idleMs = IDLE_TIMEOUT_MS,
}) {
  const s = loadSettings();
  const useModel = model || s.model;
  const wantUsage = includeUsage ?? s.includeUsage;
  const allowTools = Boolean(tools?.length) && s.enableTools && !isReasoner(useModel);

  const build = withUsage => {
    const body = { model: useModel, messages, stream: true };
    if (withUsage) body.stream_options = { include_usage: true };
    if (allowTools) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    return body;
  };

  /* ── 超时控制：外部 signal 与内部看门狗合并 ── */
  const ctl = new AbortController();
  let timedOut = false;
  let idleTimer = null;

  const armIdle = (ms) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  };
  const disarm = () => { clearTimeout(idleTimer); idleTimer = null; };

  const relayAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', relayAbort, { once: true });
  }

  let res;
  try {
    armIdle(CONNECT_TIMEOUT_MS);
    res = await doFetch(build(wantUsage), ctl.signal);

    // 少数兼容端点不认 stream_options，遇到就退回不带用量的请求
    if (!res.ok && res.status === 400 && wantUsage) {
      const text = await res.text().catch(() => '');
      if (/stream_options/i.test(text)) {
        armIdle(CONNECT_TIMEOUT_MS);
        res = await doFetch(build(false), ctl.signal);
      } else {
    throw errFromText(res.status, text);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const workerErrors = {
        login_required: '请先登录测试账号',
        membership_required: '当前账号没有有效体验权限，请在设置中兑换测试码',
        daily_limit: '今日 AI 请求次数已用完',
        request_limit: '体验 AI 总请求次数已用完',
        ai_not_configured: '站点 AI 服务尚未配置',
        upstream_unavailable: 'AI 服务暂时无法连接，请稍后重试',
        model_not_allowed: '当前模型未开放；请在设置中使用 deepseek-chat 或 deepseek-reasoner',
        invalid_request: '后端收到的请求格式不正确，请刷新页面后重试',
        invalid_messages: '本轮对话内容无效或过长，请新建对话后重试',
        invalid_tools: '工具定义超出后端限制，请刷新页面后重试',
        request_too_large: '本轮上下文超过后端大小限制，请新建对话或减少历史内容',
        invalid_max_tokens: '请求的最大回复长度不被接受',
      };
      let code = '';
      try { code = JSON.parse(text)?.error || ''; } catch { /* non-JSON upstream error */ }
      if (workerErrors[code]) throw new ApiError(workerErrors[code], { status: res.status, raw: text, kind: 'http' });
      throw errFromText(res.status, text);
    }
    if (!res.body) throw new ApiError('服务端没有返回数据流', { status: res.status, kind: 'http' });
  } catch (e) {
    disarm();
    if (e instanceof ApiError) throw e;
    if (e?.name === 'AbortError') {
      if (signal?.aborted) throw e;                    // 用户主动中断，原样抛出
      throw new ApiError(
        `等待响应超时（${CONNECT_TIMEOUT_MS / 1000} 秒内没有拿到回复）。`
        + '可能是网络不稳或服务端繁忙 —— 直接重发一次通常就好。',
        { kind: 'timeout' },
      );
    }
    throw new ApiError(`网络错误：${e?.message || e}（检查网络连接，或 API 地址是否可达）`, { kind: 'network' });
  }

  /* ── 读流 ── */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  const toolCalls = [];

  try {
    for (;;) {
      armIdle(idleMs);   // 每收到一片就重置看门狗
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        if (json.usage) usage = json.usage;

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const d = choice.delta;
        if (!d) continue;

        if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
          reasoning += d.reasoning_content;
          onReasoning?.(d.reasoning_content);
        }
        if (typeof d.content === 'string' && d.content) {
          content += d.content;
          onDelta?.(d.content);
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) {
              toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            const slot = toolCalls[i];
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name = tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      if (signal?.aborted) throw e;
      if (timedOut) {
        throw new ApiError(
          `回复中断：连续 ${Math.round(idleMs / 1000)} 秒没有收到新内容，连接可能已经断开。`
          + (content ? `（已收到 ${content.length} 个字符，内容不完整）` : ''),
          { kind: 'timeout' },
        );
      }
      throw new ApiError('读取响应流时中断了', { kind: 'network' });
    }
    throw e;
  } finally {
    disarm();
    if (signal) signal.removeEventListener('abort', relayAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (buf.trim().startsWith('data:')) {
    const payload = buf.trim().slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        const json = JSON.parse(payload);
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoning?.(delta.reasoning_content);
        }
      } catch { /* Ignore an incomplete trailing event. */ }
    }
  }

  if (!content.trim() && !reasoning.trim() && toolCalls.length === 0) {
    throw new ApiError(`AI 服务返回了空响应${finishReason ? `（结束原因：${finishReason}）` : ''}。请稍后重试；若再次发生，请检查设置中的后端连接状态。`, {
      kind: 'http', status: res.status,
    });
  }

  return {
    content,
    reasoning,
    usage,
    finishReason,
    model: useModel,
    toolCalls: toolCalls.filter(Boolean).map(tc => ({
      ...tc,
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    })),
  };
}

/** 设置面板里的"测试连接" */
export async function testConnection({ baseUrl, apiKey } = {}) {
  if (workerConfigured()) {
    let result;
    try {
      result = await Promise.race([
        getWorkerSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时')), 20000)),
      ]);
    } catch (error) {
      throw new ApiError(`后端连接失败：${error.message || String(error)}`, { kind: 'network' });
    }
    if (!result.authenticated) throw new ApiError('请先登录测试账号', { status: 401, kind: 'config' });
    if (!result.entitled) throw new ApiError('已连接后端，但当前账号还没有体验权限', { kind: 'config' });
    return { ok: true, models: [loadSettings().model], proxy: true };
  }
  const s = { ...loadSettings(), ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
  if (!s.apiKey) throw new ApiError('请先填入 API Key', { status: 401, kind: 'config' });

  const url = `${String(s.baseUrl).replace(/\/+$/, '')}/models`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${s.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new ApiError('连接超时（20 秒内无响应）：网络不通，或地址不可达。', { kind: 'timeout' });
    }
    throw new ApiError(`连不上 ${s.baseUrl}（${e.message}）`, { kind: 'network' });
  }

  if (!res.ok) throw await readError(res);
  const json = await res.json().catch(() => ({}));
  const models = (json.data || []).map(m => m.id);
  return { ok: true, models };
}
