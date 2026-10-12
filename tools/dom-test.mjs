#!/usr/bin/env node
// ── DOM 级测试：在 jsdom 里真的把应用跑起来 ────────────────────
//
// 为什么需要它：纯逻辑测试（smoke-test）从不执行 runTurn、从不碰 DOM。
// 曾经因此漏掉一个致命笔误 —— agent.js 里 buildMessages({ sessionId })
// 应为 session.id，导致整条发送链路直接抛错，而 263 项断言全绿。
//
// 这个脚本：
//   1. 用 jsdom 加载真实的 index.html
//   2. 注入 fake-indexeddb + localStorage
//   3. 桩掉 fetch，返回模拟的 DeepSeek SSE 流（含工具调用）
//   4. 像用户一样发消息、点按钮，然后检查界面到底发生了什么
//
// 运行：npm run test:dom
//
// ⚠️ 绝不要用 PowerShell 的 -replace / Set-Content 改这个项目的源文件：
//    PS 5.1 默认 ANSI 编码，会把 UTF-8 中文变成乱码、甚至吞掉换行符，
//    造成极难定位的语法错误。用编辑器或 edit / write 工具。

import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ══════════ 错误捕获 ══════════ */

const errors = [];
const warnings = [];

/**
 * jsdom 没实现的东西，不算应用的问题。**只放行明确已知的这几条**，
 * 不做大范围静默 —— 否则真 bug 会被一起吞掉。
 */
const JSDOM_LIMITATIONS = [
  // 导出功能点 <a download> 触发下载时，jsdom 会把它当成页面跳转并报错。
  // 真实浏览器里这是正常的下载行为。
  /Not implemented: navigation to another Document/,
];
const isJsdomLimitation = msg => JSDOM_LIMITATIONS.some(re => re.test(msg));

const realError = console.error;
console.error = (...a) => {
  const msg = a.map(String).join(' ');
  if (isJsdomLimitation(msg)) { warnings.push(`[jsdom限制] ${msg}`); return; }
  errors.push(msg);
  realError('  [console.error]', ...a);
};
console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };

process.on('unhandledRejection', e => {
  const msg = `unhandledRejection: ${e?.stack || e}`;
  if (isJsdomLimitation(msg)) { warnings.push(msg); return; }
  errors.push(msg);
  realError('  [unhandledRejection]', e);
});
process.on('uncaughtException', e => {
  const msg = `uncaughtException: ${e?.stack || e}`;
  if (isJsdomLimitation(msg)) { warnings.push(msg); return; }
  errors.push(msg);
  realError('  [uncaughtException]', e);
});

/* ══════════ DOM 环境 ══════════ */

const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8000/', pretendToBeVisual: true });
const { window } = dom;

/** Node 24 里 navigator / localStorage 是只读 getter，直接赋值会抛错 */
function defineGlobal(name, value) {
  try {
    globalThis[name] = value;
    if (globalThis[name] === value) return;
  } catch { /* 落到 defineProperty */ }
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

defineGlobal('window', window);
defineGlobal('document', window.document);
defineGlobal('navigator', window.navigator);
// 有些模块会读 location.protocol（例如诊断里的协议检查），补上
defineGlobal('location', window.location);
defineGlobal('HTMLElement', window.HTMLElement);
defineGlobal('Element', window.Element);
defineGlobal('Node', window.Node);
defineGlobal('Event', window.Event);
defineGlobal('CustomEvent', window.CustomEvent);
defineGlobal('localStorage', window.localStorage);
defineGlobal('sessionStorage', window.sessionStorage);
defineGlobal('requestAnimationFrame', cb => window.setTimeout(() => cb(Date.now()), 0));
defineGlobal('cancelAnimationFrame', id => window.clearTimeout(id));
defineGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
defineGlobal('confirm', () => true);
defineGlobal('alert', () => {});
defineGlobal('prompt', () => null);

// jsdom 没实现 dialog 的 showModal / close
if (window.HTMLDialogElement) {
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.show = function show() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close(v) {
    this.open = false;
    this.returnValue = v ?? '';
    this.dispatchEvent(new window.Event('close'));
  };
}

/* ══════════ fetch 桩：模拟 DeepSeek SSE ══════════ */

const fetchLog = [];
let script = [];

const sseChunks = chunks => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
};

const chunk = obj => `data: ${JSON.stringify(obj)}\n\n`;

/** 一段纯文本回复的流 */
function textStream(text, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  const mid = Math.floor(text.length / 2);
  return sseChunks([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, mid) } }] }),
    chunk({ choices: [{ index: 0, delta: { content: text.slice(mid) } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ choices: [], usage }),
    'data: [DONE]\n\n',
  ]);
}

/** 一段工具调用的流 */
function toolStream(name, argsJson) {
  return sseChunks([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] } }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]);
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { /* ignore */ }

  fetchLog.push({ url: u, model: body?.model, stream: body?.stream, tools: body?.tools?.length ?? 0, toolChoice: body?.tool_choice });

  if (u.endsWith('/models')) {
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      text: async () => '{"object":"list","data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}',
    };
  }

  /* 非流式请求（诊断模块用的就是这种）*/
  if (body && body.stream !== true) {
    const payload = JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      model: body.model,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '通' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    });
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => JSON.parse(payload),
      text: async () => payload,
    };
  }

  const next = script.shift();
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: next || textStream('（桩：没有预设的下一步响应）'),
    text: async () => 'data: {"choices":[{"index":0,"delta":{"content":"通"}}]}\n\ndata: [DONE]\n\n',
  };
};

/* ══════════ 预置设置（有 Key，跳过设置弹窗）══════════ */

window.localStorage.setItem('msa.apikey', 'sk-test-key-for-trace');
window.localStorage.setItem('msa.settings.v1', JSON.stringify({
  persistKey: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  reasonModel: 'deepseek-reasoner',
  enableTools: true,
  includeUsage: true,
}));

/* ══════════ 小工具 ══════════ */

const $ = sel => window.document.querySelector(sel);
const $$ = sel => [...window.document.querySelectorAll(sel)];
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeout = 6000, label = '条件' } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch { /* 继续等 */ }
    await wait(40);
  }
  throw new Error(`等待超时：${label}`);
};

let pass = 0;
const fails = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const click = (sel) => {
  const el = $(sel);
  if (!el) throw new Error(`找不到 ${sel}`);
  el.dispatchEvent(new window.Event('click', { bubbles: true }));
};

// 一级导航只保留四项；学习内页通过学习工作台卡片进入。
const openPanel = async (panel) => {
  if (['today', 'learning', 'habits', 'life'].includes(panel)) {
    click(`.nav-btn[data-panel="${panel === 'habits' ? 'tasks' : panel}"]`);
  } else {
    click('.nav-btn[data-panel="learning"]');
    await wait(80);
    click(`[data-learning-panel="${panel}"]`);
  }
  await wait(180);
};

const sendText = (text) => {
  $('#input').value = text;
  $('#composer').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
};

/**
 * 等一个回合真正结束。
 *
 * 不能只等"助手气泡出现" —— 气泡在流式输出中途就存在了，而 send() 的
 * finally 还要 await refreshAll()（一堆数据库操作）。在那之前 busy 仍是
 * true，下一条消息会被静默丢弃，测试就会随机失败。按钮文案恢复才是信号。
 */
const waitIdle = (timeout = 12000) =>
  waitFor(() => $('#btn-send')?.textContent === '发送',
    { label: '回合结束（发送按钮恢复）', timeout });

/** 发一条并等它跑完 */
const sendAndWait = async (text, { timeout = 12000 } = {}) => {
  sendText(text);
  await waitIdle(timeout).catch(e => console.log(`    ⚠️ ${e.message}`));
  await wait(100);
};

/* ══════════ 1. 启动 ══════════ */

console.log('\n[1] 启动');

script = [textStream('启动占位')];
localStorage.setItem('msa.ui.v1', JSON.stringify({ currentPanel: 'tasks', workspaceMode: 'chat' }));
await import('../src/main.js');
check('深度模式入口已移除', $('#btn-depth') === null && $('#set-reason-model') === null);
check('AI 对话有「聊聊我」入口', $('#btn-about-me')?.textContent === '聊聊我');
await waitFor(() => $('#view-tasks')?.classList.contains('active') && $('.app')?.classList.contains('chat-mode'), { label: 'restore workspace' });
check('Saved panel restored on boot', $('#view-tasks').classList.contains('active'));
check('Saved chat mode restored on boot', $('.app').classList.contains('chat-mode'));
await waitFor(() => $('.nav-btn[data-panel="today"]') && $('#view-tasks')?.innerHTML.length > 0, { label: 'boot complete' });
await openPanel('today');
await waitFor(() => $('#view-today')?.innerHTML.length > 0, { label: '今日面板渲染' });
await waitFor(() => $('#messages')?.innerHTML.length > 0, { label: '对话区渲染' });
await waitFor(() => $('#view-today [data-daily-review]') !== null, { label: '每日复盘和日历渲染' });
await wait(120);

check('应用启动没有抛错', errors.length === 0, errors[0]);
check('顶栏品牌已渲染', $('#brand-name')?.textContent === '帕尼尼', $('#brand-name')?.textContent);
check('今日面板有内容', $('#view-today').innerHTML.length > 20);
check('今日复盘只包含事件、改进、肯定三项',
  $$('#view-today [data-review-field]').map(field => field.dataset.reviewField).join(',') === 'events,review,positive');
check('今日复盘显示月历日期', $$('#view-today [data-review-date]').length >= 28);
const reviewEventField = $('#view-today [data-review-field="events"]');
let copiedReview = '';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async text => { copiedReview = text; },
} });
reviewEventField.value = '刚写完，还未自动保存\n第二行';
click('#view-today [data-review-copy]');
await waitFor(() => copiedReview.length > 0, { label: '复制复盘' });
const { dateStr: reviewDateStr } = await import('../src/util.js');
eq('复制复盘包含日期标签和未保存的多行内容', copiedReview,
  `#${reviewDateStr().replaceAll('-', '/')}/日记\n\n事件\n刚写完，还未自动保存\n第二行`);
reviewEventField.value = 'DOM 测试复盘事件';
reviewEventField.dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor(() => Object.keys(localStorage).some(key => key.startsWith('msa.daily-review.v1:')),
  { label: '复盘自动保存到本机' });
const savedReviewKey = Object.keys(localStorage).find(key => key.startsWith('msa.daily-review.v1:'));
const savedReview = JSON.parse(localStorage.getItem(savedReviewKey));
eq('复盘事件自动保存', savedReview.events, 'DOM 测试复盘事件');
check('复盘保存队列只包含三项内容',
  Object.keys(JSON.parse(localStorage.getItem('msa.daily-review-sync.v1'))[savedReview.date]).sort().join(',') === 'events,positive,review');
const reviewDate = $('#view-today [data-review-date]:not(.is-selected)');
const selectedHistoryDate = reviewDate.dataset.reviewDate;
reviewDate.dispatchEvent(new window.Event('click', { bubbles: true }));
await waitFor(() => $('#view-today [data-review-date].is-selected')?.dataset.reviewDate === selectedHistoryDate,
  { label: '日历切换日期' });
check('点击日历日期可打开历史复盘', $('#view-today [data-review-field="events"]')?.value !== 'DOM 测试复盘事件');
copiedReview = '';
$('#view-today [data-review-field="positive"]').value = '历史肯定';
click('#view-today [data-review-copy]');
await waitFor(() => copiedReview.length > 0, { label: '复制历史复盘' });
eq('历史复盘复制使用选中日期并省略空项', copiedReview,
  `#${selectedHistoryDate.replaceAll('-', '/')}/日记\n\n肯定\n历史肯定`);
check('对话区显示空状态提示', $('#messages .placeholder') !== null);

/* ══════════ 2. 界面结构 ══════════ */

console.log('\n[2] 界面结构（左导航带文字 + SVG 图标 + 可折叠）');

const navBtns = $$('.nav-btn');
check('导航渲染 AI 对话、任务和三个内容入口', navBtns.length === 5, String(navBtns.length));

const labels = navBtns.map(b => b.querySelector('.nav-label')?.textContent?.trim());
check('每项都有文字标签', labels.every(Boolean), labels.join(','));
check('标签就是一级面板名',
  labels.join(',') === 'AI 对话,任务,复盘,学习,生活导航', labels.join(','));
check('**使用内联 SVG 图标，不再是 emoji**',
  navBtns.every(b => b.querySelector('.nav-icon svg')), '有项目缺 SVG');
check('导航区完全没有 emoji',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test($('#nav')?.textContent || ''),
  ($('#nav')?.textContent || '').slice(0, 40));
check('图标用 currentColor（跟随主题色）',
  navBtns[0]?.querySelector('svg')?.getAttribute('stroke') === 'currentColor');
check('导航没有「指令」项', !labels.includes('指令'));
click('.nav-btn[data-panel="chat"]');
await wait(60);
check('点击左栏首项进入独立 AI 对话页', $('.app')?.classList.contains('chat-mode'));
check('AI 对话页的左栏入口保持高亮', $('.nav-btn[data-panel="chat"]')?.classList.contains('active'));
check('顶栏不再显示返回内容和显示内容文字按钮',
  $('#btn-return-content') === null && !$$('.workspace-switch').length);
check('聊聊我和历史记录位于对话操作区',
  $('#btn-about-me')?.parentElement === $('.chat-actions')
    && $('#btn-sessions')?.parentElement === $('.chat-actions'));
check('新对话、历史记录和设置使用图标按钮',
  ['#btn-new-chat', '#btn-sessions', '#btn-settings']
    .every(sel => $(sel)?.querySelector('svg') && !$(sel).textContent.trim()));
check('设置按钮与聊天操作分组独立',
  $('#btn-settings')?.parentElement !== $('#btn-new-chat')?.parentElement
    && $('.chat-actions')?.contains($('#btn-settings')) === false);
check('聊天页不再提供内容侧栏展开入口', $('#btn-chat-context') === null);
click('.nav-btn[data-panel="tasks"]');
await wait(100);
check('从 AI 对话选择内容入口后返回任务页面', !$('.app')?.classList.contains('chat-mode') && $('#view-tasks')?.classList.contains('active'));
check('品牌标识不含 emoji', !/[\u{1F300}-\u{1FAFF}]/u.test($('.brand')?.textContent || ''));
check('三个折叠控件都有图标',
  ['#btn-collapse-nav', '#btn-collapse-panel', '#btn-reveal-panel']
    .every(sel => $(sel)?.querySelector('svg')));
check('顶栏折叠按钮也有图标', $('#btn-collapse-topbar')?.querySelector('svg') !== null);
check('顶栏折叠按钮是两条横线菜单图标',
  $('#btn-collapse-topbar svg path')?.getAttribute('d') === 'M4 8h16M4 16h16');
click('#btn-collapse-topbar');
await wait(60);
check('顶栏可折叠且状态持久化', document.body.classList.contains('topbar-collapsed')
  && JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').topbarCollapsed === true);
check('顶栏折叠后按钮标签更新', $('#btn-collapse-topbar')?.getAttribute('aria-label') === '展开顶栏');
check('顶栏折叠按钮位于品牌图标之前',
  $('#btn-collapse-topbar')?.parentElement === $('.brand')
    && $('#btn-collapse-topbar')?.nextElementSibling?.id === 'btn-new-chat');
click('#btn-collapse-topbar');
await wait(60);
check('顶栏可以重新展开', !document.body.classList.contains('topbar-collapsed'));

check('初始未折叠', !document.body.classList.contains('nav-collapsed'));
click('#btn-collapse-nav');
await wait(60);
check('导航可折叠', document.body.classList.contains('nav-collapsed'));
check('折叠状态写进了 localStorage（刷新能恢复）',
  JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').navCollapsed === true);

click('#btn-collapse-nav');
await wait(60);
check('再点可展开', !document.body.classList.contains('nav-collapsed'));

click('#btn-collapse-panel');
await wait(60);
check('面板可收起', document.body.classList.contains('panel-collapsed'));
click('#btn-reveal-panel');
await wait(60);
check('面板可重新展开', !document.body.classList.contains('panel-collapsed'));

/* ══════════ 3. 发普通消息 ══════════ */

console.log('\n[3] 发普通消息');

script = [textStream('知道自己在拖延，不算完成了任何事。\n\n告诉我，你原本准备做什么。')];
await sendAndWait('我又拖延了');

const input = $('#input');
const beforeEnter = fetchLog.length;
input.value = '第一行';
const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
input.dispatchEvent(enter);
check('Enter 不会提交且保留输入内容', !enter.defaultPrevented && input.value === '第一行' && fetchLog.length === beforeEnter);
check('聊天输入框是多行文本框', input instanceof window.HTMLTextAreaElement);
script = [textStream('点击发送后收到')];
input.value = '通过点击按钮发送';
$('#btn-send').click();
await waitIdle();
check('点击发送按钮仍会提交', fetchLog.length > beforeEnter && $$('.msg.user .bubble').at(-1)?.textContent === '通过点击按钮发送');

const userText = $('#messages .msg.user .bubble')?.textContent || '';
const assistantBubbles = $$('.msg.assistant .bubble');
const assistantText = assistantBubbles.map(b => b.textContent).join(' | ');

check('用户消息已显示', userText.includes('我又拖延了'), userText.slice(0, 40));
check('**助手回复气泡已出现**', assistantBubbles.length > 0, `找到 ${assistantBubbles.length} 个`);
check('回复有实际内容', assistantText.includes('拖延'), assistantText.slice(0, 60));
check('流式已结束（没有残留光标）', !$('#messages .msg.assistant .bubble .cursor'));
check('发送按钮恢复为「发送」', $('#btn-send')?.textContent === '发送', $('#btn-send')?.textContent);
check('过程中没有 JS 报错', errors.length === 0, errors[0]);
check('用户消息带 user 类（右对齐浅蓝气泡）', $('.msg.user') !== null);
check('助手消息带 assistant 类（无气泡底色）', $('.msg.assistant') !== null);

/* ══════════ 4. 工具调用回合 ══════════ */

console.log('\n[4] 工具调用（agent 循环）');

const beforeCalls = fetchLog.length;
script = [
  toolStream('save_task', JSON.stringify({ title: '写论文引言', priority: 'P0', area: 'work' })),
  textStream('行，任务建好了。现在只做一件事：打开文档，写下标题和三个小标题。'),
];
sendText('帮我把写论文加进任务');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(100);

const traces = $$('#messages .tool-call').map(e => e.textContent);
check('界面显示工具调用轨迹', traces.some(t => t.includes('save_task')), traces.join(' | ').slice(0, 120));
check('工具执行标记为成功', traces.some(t => t.includes('✓')));
check('工具调用后产出了文本回复',
  ($('#messages').textContent || '').includes('标题和三个小标题'));
check('本回合发了 2 次请求（工具 + 最终答复）', fetchLog.length - beforeCalls === 2,
  String(fetchLog.length - beforeCalls));
check('请求都带上了工具定义', fetchLog.slice(beforeCalls).every(f => f.tools > 0),
  JSON.stringify(fetchLog.slice(beforeCalls).map(f => f.tools)));
check('**下发的是全量工具（分组下发已移除）**',
  fetchLog.slice(beforeCalls).every(f => f.tools >= 35),
  JSON.stringify(fetchLog.slice(beforeCalls).map(f => f.tools)));

await openPanel('tasks');
check('新建的任务出现在任务面板', ($('#view-tasks')?.textContent || '').includes('写论文引言'));
check('任务显示 P0 优先级', ($('#view-tasks')?.textContent || '').includes('P0'));
check('任务页提供最近七天日期切换', Boolean($('#view-tasks [data-task-date]')));
check('任务页提供日历日期选择器', Boolean($('#view-tasks [data-task-date-picker]')));
check('任务卡片提供完成勾选框', Boolean($('#view-tasks [data-task-check]')));
check('手动任务状态不再显示可选下拉', !$('#task-state')?.matches('select'));
check('新建任务的隐藏状态默认未完成', $('#task-state')?.value === 'INBOX');

/* ══════════ 5. 代码动作路径 ══════════ */

console.log('\n[5] 代码动作（计时）');

await openPanel('today');

script = [textStream('计时开始了。做完回来汇报，我会算出真实耗时。')];
sendText('当前任务：面试题调研\n目标：弄清目标公司近半年 Agent 开发岗到底考什么\n预计耗时：15 分钟\n状态：DOING\n下一步：打开一个面经平台，搜 "agent 开发 面经"\n完成标准：写下 3 家公司 + 出现频率最高的 5 个问题\n\n现在开始，计时 15 分钟');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(120);

check('**计时条已出现**', $('#timerbar')?.classList.contains('on'), $('#timerbar')?.className);
const runningTimer = await (await import('../src/timer.js')).getActiveTimer();
check('计时记录了计划时长 15 分钟', runningTimer?.plannedMin === 15, String(runningTimer?.plannedMin));
check('计时记录了当前任务名称', runningTimer?.label === '面试题调研', runningTimer?.label);
check('计时条显示时钟', /\d{2}:\d{2}/.test($('#timerbar')?.textContent || ''),
  ($('#timerbar')?.textContent || '').slice(0, 40));
check('计时条有结束按钮', $('#btn-timer-stop') !== null);
check('计时条有查看任务按钮', $('#btn-timer-detail') !== null);

script = [textStream('好，比计划多了 7 分钟。')];
sendText('结束计时');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(200);
check('结束后计时条消失', !$('#timerbar')?.classList.contains('on'), $('#timerbar')?.className);

/* ══════════ 6. 面板切换 ══════════ */

console.log('\n[6] 全部面板可切换并渲染');

await openPanel('learning');
check('学习入口按推进、回顾、积累分组', $$('#view-learning .learning-group').length === 3);
check('学习工作台入口在桌面布局中完整呈现', $$('#view-learning [data-learning-panel]').length === 6);
check('学习入口任务数按主要任务|杂事展示', /\d+\|\d+/.test($('#view-learning [data-learning-panel="tasks"]')?.textContent || ''),
  $('#view-learning [data-learning-panel="tasks"]')?.textContent);

let panelOk = 0;
for (const panel of ['today', 'learning', 'life', 'records', 'tasks', 'points', 'plans', 'reviews', 'profile']) {
  await openPanel(panel);
  const view = $(`#view-${panel}`);
  const active = view?.classList.contains('active');
  const rendered = (view?.innerHTML.length || 0) > 10;
  const navActive = $(`.nav-btn[data-panel="${['today', 'learning', 'habits', 'life', 'tasks'].includes(panel) ? panel : 'learning'}"]`)?.classList.contains('active');
  const titled = ($('#panel-title')?.textContent || '').length > 0;
  check(`Panel ${panel} persisted`, JSON.parse(localStorage.getItem('msa.ui.v1')).currentPanel === panel);
  if (active && rendered && navActive && titled) panelOk++;
  else check(`面板 ${panel} 可切换并渲染`, false,
    `active=${active} rendered=${rendered} navActive=${navActive} titled=${titled}`);
}
check('全部面板都能切换、渲染、导航高亮同步', panelOk === 9, `${panelOk}/9`);
await openPanel('tasks');
check('任务页显示待完成主要任务数量', $('#view-tasks [data-pending-important]') !== null);
check('任务页显示待完成杂事数量', $('#view-tasks [data-pending-chore]') !== null);
check('切换面板期间没有报错', errors.length === 0, errors[0]);
check('任务页底部包含每日微习惯任务', $('#view-tasks [data-task-microhabits]') !== null);
check('微习惯区只显示简洁标题，不显示说明文案',
  $('#view-tasks [data-task-microhabits] .habit-hero h3')?.textContent === '微习惯'
    && !$('#view-tasks [data-task-microhabits] .habit-hero')?.textContent.includes('MICRO HABITS')
    && !$('#view-tasks [data-task-microhabits] .habit-hero')?.textContent.includes('小步完成'));
await openPanel('life');
const lifeEntries = $$('.life-entry-card');
check('生活导航显示四个入口和 SVG 图标', lifeEntries.length === 4 && lifeEntries.every(card => card.querySelector('.life-entry-icon svg')));
check('生活导航入口使用不同图标', new Set(lifeEntries.map(card => card.querySelector('.life-entry-icon').innerHTML)).size === 4);
click('[data-life-entry="principles"]');
check('生活导航入口可以进入详情', $('#view-life [data-life-kind="principles"]') !== null);
click('[data-life-back]');
check('生活导航详情可以返回入口', $$('.life-entry-card').length === 4);

/* ══════════ 7. 纯导航不消耗模型调用 ══════════ */

console.log('\n[7] 纯导航指令不消耗模型调用');

await openPanel('today');
const beforeNav = fetchLog.length;

sendText('查看积分');
await wait(700);

check('「查看积分」没有发起模型请求', fetchLog.length === beforeNav, `${beforeNav} → ${fetchLog.length}`);
check('「查看积分」切到了积分面板', $('#view-points')?.classList.contains('active'));

/* ══════════ 8. 档案面板的诚实性 ══════════ */

console.log('\n[8] 档案面板');

await openPanel('profile');
const profileText = $('#view-profile')?.textContent || '';
check('档案面板渲染了字段名', profileText.includes('称呼'));
check('未填项显示「未记录」而不是留空', profileText.includes('未记录'), profileText.slice(0, 120));
check('显示表达强度', profileText.includes('表达强度'));
check('显示初始化进度', profileText.includes('必填'));

/* ══════════ 9. 新对话 ══════════ */

console.log('\n[9] 新对话 / 对话列表');

check('顶栏有「新对话」按钮', $('#btn-new-chat') !== null);
check('顶栏有「对话列表」按钮', $('#btn-sessions') !== null);

const beforeMsgs = $$('#messages .msg').length;
check('当前对话里已有消息', beforeMsgs > 0, String(beforeMsgs));

click('#btn-new-chat');
await waitFor(() => $$('#messages .msg').length === 0,
  { label: '新对话后消息清空', timeout: 6000 }).catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(150);

check('**「新对话」清空了对话区**', $$('#messages .msg').length === 0,
  `还剩 ${$$('#messages .msg').length} 条`);
check('新对话显示空状态提示', $('#messages .placeholder') !== null);
check('新对话后没有报错', errors.length === 0, errors[0]);

/* 新对话真的能用 */
script = [textStream('新对话里也能正常回复。')];
await sendAndWait('新对话测试');
check('新对话里可以正常发消息并收到回复',
  ($('#messages').textContent || '').includes('新对话里也能正常回复'));

/* 对话列表弹窗 */
click('#btn-sessions');
await wait(220);
const sessItems = $$('#session-list .task-item');
check('对话列表能列出多个对话', sessItems.length >= 2, `${sessItems.length} 个`);
check('对话列表标记了当前对话', ($('#session-list')?.textContent || '').includes('当前'));
$('#dlg-session')?.close();

/* ══════════ 10. 拖动改宽度 ══════════ */

console.log('\n[10] 拖动改宽度');

check('导航有拖动把手', $('#resize-nav') !== null);
check('面板有拖动把手', $('#resize-panel') !== null);

/** jsdom 没有 PointerEvent，用 MouseEvent 触发同名事件即可 */
const pointer = (el, type, x) => el.dispatchEvent(
  new window.MouseEvent(type, { clientX: x, clientY: 40, bubbles: true, cancelable: true }),
);

const navEl = $('#nav');
const startNavW = navEl.getBoundingClientRect().width;
const handle = $('#resize-nav');

pointer(handle, 'pointerdown', 200);
await wait(40);
check('按下时进入拖动状态', document.body.classList.contains('resizing'));
pointer(handle, 'pointermove', 260);
await wait(40);
const dragged = parseInt(document.documentElement.style.getPropertyValue('--nav-w') || '0', 10);
check('拖动改变了导航宽度（--nav-w）', dragged > 0, `--nav-w = ${dragged}px`);
pointer(handle, 'pointerup', 260);
await wait(80);

check('松手后退出拖动状态', !document.body.classList.contains('resizing'));
const savedW = JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').navWidth;
check('**宽度已持久化到 localStorage**', typeof savedW === 'number' && savedW > 0, String(savedW));

/* 边界钳制 */
pointer(handle, 'pointerdown', 200);
pointer(handle, 'pointermove', 5000);
pointer(handle, 'pointerup', 5000);
await wait(80);
const maxW = JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').navWidth;
check('宽度有上限，不会被拖到失控', maxW <= 340, `${maxW}px`);

pointer(handle, 'pointerdown', 200);
pointer(handle, 'pointermove', -5000);
pointer(handle, 'pointerup', -5000);
await wait(80);
const minW = JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').navWidth;
check('宽度有下限，不会被拖没', minW >= 148, `${minW}px`);

/* 双击复位 */
pointer(handle, 'dblclick', 200);
await wait(80);
const resetW = JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').navWidth;
check('双击复位到默认宽度', resetW === null, String(resetW));

/* 面板也能拖 */
const panelHandle = $('#resize-panel');
pointer(panelHandle, 'pointerdown', 400);
pointer(panelHandle, 'pointermove', 480);
pointer(panelHandle, 'pointerup', 480);
await wait(80);
const panelW = JSON.parse(window.localStorage.getItem('msa.ui.v1') || '{}').panelWidth;
check('面板宽度也能拖动并持久化', typeof panelW === 'number' && panelW > 0, String(panelW));
check('拖动过程没有报错', errors.length === 0, errors[0]);

/* ══════════ 11. 诊断界面 ══════════ */

console.log('\n[11] 设置里的诊断');

click('#btn-settings');
await wait(250);
check('设置弹窗打开了', $('#dlg-settings')?.open === true);
check('清空对话和关闭按钮位置已互换',
  $('#btn-clear-chat')?.compareDocumentPosition($('#btn-settings-close'))
    & window.Node.DOCUMENT_POSITION_FOLLOWING);
check('备份和导出入口位于设置内',
  $('#dlg-settings')?.contains($('#btn-settings-export'))
    && $('#dlg-settings')?.contains($('#btn-settings-backup'))
    && $('#btn-export') === null && $('#btn-backup') === null);
check('有「开始诊断」按钮', $('#btn-diag') !== null);
check('有「复制报告」按钮', $('#btn-diag-copy') !== null);
check('复制按钮初始为禁用', $('#btn-diag-copy')?.disabled === true);

click('#btn-diag');
await waitFor(() => ($('#diag-result')?.textContent || '').length > 40,
  { label: '诊断出结果', timeout: 20000 }).catch(e => console.log(`    ⚠️ ${e.message}`));
await waitFor(() => $('#btn-diag-copy')?.disabled === false,
  { label: '诊断完成，可复制', timeout: 20000 }).catch(e => console.log(`    ⚠️ ${e.message}`));

const diagText = $('#diag-result')?.textContent || '';
check('诊断渲染了分步结果', $$('#diag-result .diag-step').length >= 4,
  `${$$('#diag-result .diag-step').length} 步`);
check('诊断包含了鉴权检查', diagText.includes('鉴权'),
  diagText.replace(/\s+/g, ' ').slice(0, 200));
check('诊断包含了带工具的检查', diagText.includes('带工具'),
  diagText.replace(/\s+/g, ' ').slice(0, 200));
check('诊断没有提前中断', !diagText.includes('诊断过程本身出错了'),
  diagText.replace(/\s+/g, ' ').slice(0, 200));
check('诊断给出了结论', $('.diag-verdict') !== null, diagText.slice(-80));
check('诊断期间没有报错', errors.length === 0, errors[0]);

$('#dlg-settings')?.close();

/* ══════════ 12. 可见面板原地更新 ══════════ */

console.log('\n[12] 聊完后面板会不会原地更新');

/* 之前的测试只验证了"切过去能看到新数据"，没验证"当前正看着的面板会刷新"。
   这两件事不一样 —— 后者才决定用户聊完有没有感觉。 */

// 场景 A：停在任务面板，让模型建一个任务
await openPanel('tasks');
const tasksBefore = $('#view-tasks')?.textContent || '';
check('任务面板初始不含待测任务', !tasksBefore.includes('原地更新测试任务'),
  tasksBefore.slice(0, 60).replace(/\s+/g, ' '));

script = [
  toolStream('save_task', JSON.stringify({ title: '原地更新测试任务', priority: 'P1', area: 'work' })),
  textStream('建好了。现在开始第一件事。'),
];
sendText('帮我加个任务：原地更新测试任务');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(500);   // 给 refreshAll 留出时间（它在 setBusy(false) 之后才 await）

const tasksAfter = $('#view-tasks')?.textContent || '';
check('**停在任务面板时，新任务自动出现在面板上**', tasksAfter.includes('原地更新测试任务'),
  tasksAfter.slice(0, 80).replace(/\s+/g, ' '));
check('面板副标题（任务数）也更新了',
  ($('#panel-sub')?.textContent || '').length > 0, $('#panel-sub')?.textContent);

// 场景 B：顶栏统计
check('顶栏统计已更新', ($('#stats')?.textContent || '').length > 0,
  $('#stats')?.textContent);

// 场景 C：停在积分面板，让模型记积分
await openPanel('points');
const pointsBefore = $('#view-points')?.textContent || '';

script = [
  toolStream('award_points', JSON.stringify({ ruleKey: 'task', reason: '原地更新测试积分' })),
  textStream('记上了。'),
];
sendText('给我加一分');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(500);

const pointsAfter = $('#view-points')?.textContent || '';
check('**停在积分面板时，新积分自动出现**', pointsAfter.includes('原地更新测试积分'),
  pointsAfter.slice(0, 100).replace(/\s+/g, ' '));
check('积分面板内容确实变了', pointsAfter !== pointsBefore);

// 场景 D：停在今日面板，设定关键任务（也走确认）
await openPanel('today');

/* 先清掉前面残留的待确认项，否则计数会互相干扰 */
const pendingMod = await import('../src/pending.js');
await pendingMod.clearPending();
click('#btn-refresh-panel');
await wait(450);
check('待确认区已清空', $$('#pending-area .pending-card').length === 0);

script = [
  toolStream('set_key_tasks', JSON.stringify({ ids: ['原地更新测试任务'] })),
  textStream('今天的关键任务就是它了。'),
];
sendText('把刚那个设成今天的关键任务');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);

check('**设定今日关键任务也要用户确认**（模型不替你决定今天做什么）',
  $$('#pending-area .pending-card').length === 1,
  `${$$('#pending-area .pending-card').length} 张`);
check('确认卡片写明了要设什么',
  ($('#pending-area .pending-card')?.textContent || '').includes('关键任务'),
  $('#pending-area .pending-card')?.textContent);
check('关键任务确认卡显示任务名而不是 task 编号',
  ($('#pending-area .pending-card')?.textContent || '').includes('原地更新测试任务'),
  $('#pending-area .pending-card')?.textContent);

click('#pending-area [data-confirm]');
await waitFor(() => ($('#view-today')?.textContent || '').includes('原地更新测试任务'),
  { label: '确认后关键任务出现在今日面板', timeout: 8000 })
  .catch(e => console.log(`    ⚠️ ${e.message}`));

const todayAfter = $('#view-today')?.textContent || '';
check('**确认后关键任务出现在今日面板**', todayAfter.includes('原地更新测试任务'),
  todayAfter.replace(/\s+/g, ' ').slice(0, 120));

await pendingMod.clearPending();
click('#btn-refresh-panel');
await wait(400);

// 场景 E：手动刷新 + 更新时间指示
check('面板标题旁有更新时间指示', $('#panel-updated') !== null);
check('更新时间已填内容', /\d{2}:\d{2} 更新/.test($('#panel-updated')?.textContent || ''),
  $('#panel-updated')?.textContent);
check('面板有手动刷新按钮', $('#btn-refresh-panel') !== null);
check('刷新按钮有图标', $('#btn-refresh-panel')?.querySelector('svg') !== null);

const beforeRefreshStamp = $('#panel-updated')?.textContent;
click('#btn-refresh-panel');
await wait(600);
check('点刷新按钮后时间戳仍在（刷新成功）',
  /\d{2}:\d{2} 更新/.test($('#panel-updated')?.textContent || ''),
  `${beforeRefreshStamp} → ${$('#panel-updated')?.textContent}`);

check('整段原地更新期间没有报错', errors.length === 0, errors[0]);

/* ══════════ 13. 今日动态 ══════════ */

console.log('\n[13] 今日动态（让对话结果在默认面板上看得见）');

await openPanel('today');
check('今日面板有「今日动态」区块',
  ($('#view-today')?.textContent || '').includes('今日动态'),
  ($('#view-today')?.textContent || '').slice(0, 80).replace(/\s+/g, ' '));

script = [
  toolStream('log_study', JSON.stringify({
    topic: '动态测试知识点', minutes: 25, what: '看了第三节',
  })),
  textStream('整理好了：动态测试知识点，25 分钟，看了第三节。确认保存吗？'),
];
sendText('我学了动态测试知识点，25 分钟');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);

let todayText = $('#view-today')?.textContent || '';
check('学习记录先在聊天里请求确认',
  $$('#messages .msg.assistant').at(-1)?.textContent.includes('确认保存'));
check('确认前今日动态没有新学习记录', !todayText.includes('动态测试知识点'),
  todayText.replace(/\s+/g, ' ').slice(0, 140));

script = [textStream('学习记录已保存。')];
sendText('确认保存');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);

todayText = $('#view-today')?.textContent || '';
check('**确认后学习记录出现在今日动态里**', todayText.includes('动态测试知识点'),
  todayText.replace(/\s+/g, ' ').slice(0, 140));
check('动态条目带上了时长', todayText.includes('25 分钟'), todayText.replace(/\s+/g, ' ').slice(0, 140));
check('今日动态渲染成时间线', $$('#view-today .tl-item').length > 0,
  `${$$('#view-today .tl-item').length} 条`);

/* ══════════ 14. 承诺类动作要用户点确认 ══════════ */

console.log('\n[14] 计时不该由模型替你按开始键');

const pendingArea = $('#pending-area');
check('对话区和输入框之间有待确认区', pendingArea !== null);

script = [
  toolStream('timer_start', JSON.stringify({ task: '原地更新测试任务', plannedMin: 20 })),
  textStream('点下面的按钮就能开始计时。'),
];
sendText('帮我把计时开起来');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);

check('**出现确认卡片**', $$('#pending-area .pending-card').length === 1,
  `${$$('#pending-area .pending-card').length} 张`);
check('待确认区已激活', pendingArea?.classList.contains('on'));

const card = $('#pending-area .pending-card');
check('卡片说明要做什么', (card?.textContent || '').includes('开始计时'), card?.textContent);
check('卡片带上了具体任务', (card?.textContent || '').includes('原地更新测试任务'), card?.textContent);
check('卡片有「确认」按钮', card?.querySelector('[data-confirm]') !== null);
check('卡片有「不用」按钮', card?.querySelector('[data-dismiss]') !== null);
check('卡片说明这是用户的决定', (card?.textContent || '').includes('这是你的决定'));

check('**计时没有自动开始**', !$('#timerbar')?.classList.contains('on'), $('#timerbar')?.className);
check('模型用了提议语气（没说成已开始）',
  ($('#messages').textContent || '').includes('点下面的按钮'),
  ($('#messages').textContent || '').slice(-90).replace(/\s+/g, ' '));

/* 刷新后卡片仍在 —— 证明它是从数据库重建的，不是 DOM 里的残留 */
click('#btn-refresh-panel');
await wait(900);
check('**刷新后确认卡片依然在（存在数据库里）**',
  $$('#pending-area .pending-card').length === 1,
  `${$$('#pending-area .pending-card').length} 张`);

/* 点「不用」：什么都不该发生 */
click('#pending-area [data-dismiss]');
await wait(600);
check('点「不用」后卡片消失', $$('#pending-area .pending-card').length === 0);
check('点「不用」后计时仍未开始', !$('#timerbar')?.classList.contains('on'));

/* 再来一次，这次点确认 */
script = [
  toolStream('timer_start', JSON.stringify({ task: '原地更新测试任务', plannedMin: 20 })),
  textStream('点按钮就开始。'),
];
sendText('那就开计时吧');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);
check('再次出现确认卡片', $$('#pending-area .pending-card').length === 1,
  `${$$('#pending-area .pending-card').length} 张`);

click('#pending-area [data-confirm]');
await waitFor(() => $('#timerbar')?.classList.contains('on'),
  { label: '确认后计时启动', timeout: 8000 }).catch(e => console.log(`    ⚠️ ${e.message}`));

check('**点确认后计时真的开始**', $('#timerbar')?.classList.contains('on'), $('#timerbar')?.className);
check('计时条显示了任务名', ($('#timerbar')?.textContent || '').includes('原地更新测试任务'),
  ($('#timerbar')?.textContent || '').slice(0, 50));

await waitFor(() => $$('#pending-area .pending-card').length === 0,
  { label: '已执行的卡片自动收走', timeout: 4000 }).catch(e => console.log(`    ⚠️ ${e.message}`));
check('已执行的卡片自动收走', $$('#pending-area .pending-card').length === 0);

/* 收尾：停掉计时 */
script = [textStream('好，停了。')];
sendText('结束计时');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(400);
check('确认流程全程没有报错', errors.length === 0, errors[0]);

/* ══════════ 15. 记录面板：按天查看与编辑 ══════════ */

console.log('\n[15] 记录面板：选一天、看明细、直接改');

const utilMod = await import('../src/util.js');
const timerMod = await import('../src/timer.js');
const daylogMod = await import('../src/daylog.js');
const stamp = String(Date.now()).slice(-6);
const todayDate = utilMod.dateStr();

/* 先造一条确定的数据，不依赖前面测试的残留 */
const seed = await timerMod.createManualEntry({
  date: todayDate,
  startedAt: new Date(`${todayDate}T08:00:00`).toISOString(),
  actualMin: 33,
  note: `记录面板测试-${stamp}`,
});
check('测试数据已写入', Boolean(seed.id));

await openPanel('records');

const recText = () => $('#view-records')?.textContent || '';
check('记录面板渲染出来了', ($('#view-records')?.innerHTML.length || 0) > 100);
check('有日期选择器', $('#rec-date') !== null);
eq('日期默认是今天', $('#rec-date')?.value, todayDate);
check('标题显示「今天」', recText().includes('今天'), recText().slice(0, 60));
check('显示专注时长概览', recText().includes('分钟专注'), recText().slice(0, 80));
check('列出了刚补记的那一段', recText().includes(`记录面板测试-${stamp}`));
check('有「补记专注」按钮', $('#rec-add-time') !== null);
check('有「补记学习」按钮', $('#rec-add-log') !== null);

/* 点条目打开编辑 */
const recItems = $$('#view-records .rec-item[data-time]');
check('专注记录条目可点击', recItems.length > 0, `${recItems.length} 条`);
const targetNode = recItems.find(n => n.textContent.includes(`记录面板测试-${stamp}`));
check('找到目标条目', Boolean(targetNode));

targetNode?.dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(350);

check('**点条目打开编辑弹窗**', $('#dlg-time')?.open === true);
check('标题是「编辑专注记录」', ($('#time-title')?.textContent || '').includes('编辑'));
eq('时长已回填', $('#time-minutes')?.value, '33');
check('备注已回填', ($('#time-note')?.value || '').includes(`记录面板测试-${stamp}`));
check('开始时间已回填', ($('#time-start')?.value || '').includes(todayDate), $('#time-start')?.value);
check('显示了来源等元信息', ($('#time-meta')?.textContent || '').length > 0, $('#time-meta')?.textContent);
check('编辑时有删除按钮', $('#btn-del-time')?.style.display !== 'none');

/* 改时长并保存 */
$('#time-minutes').value = '55';
$('#time-minutes').dispatchEvent(new window.Event('input', { bubbles: true }));
eq('手动改时长会更新结束时间', $('#time-end')?.value, `${todayDate}T08:55`);
$('#time-end').value = `${todayDate}T09:00`;
$('#time-end').dispatchEvent(new window.Event('input', { bubbles: true }));
eq('手动改结束时间会更新时长', $('#time-minutes')?.value, '60');
$('#time-note').value = `改过-${stamp}`;
$('#dlg-time').close('ok');
await wait(900);

const afterEdit = await timerMod.getTimeEntry(seed.id);
eq('**编辑已落库：时长 33 → 60**', afterEdit?.actualMin, 60);
check('备注已更新', afterEdit?.note === `改过-${stamp}`, afterEdit?.note);
check('打上了「已修正」标记', afterEdit?.edited === true);
check('面板已反映新时长', recText().includes('60'), recText().replace(/\s+/g, ' ').slice(0, 120));

/* 补记一段新的 */
click('#rec-add-time');
await wait(350);
check('补记弹窗打开', $('#dlg-time')?.open === true);
check('标题是「补记一段专注」', ($('#time-title')?.textContent || '').includes('补记'));
check('补记时没有删除按钮', $('#btn-del-time')?.style.display === 'none');

const beginCount = (await daylogMod.daySummary(todayDate)).entries.length;
$('#time-minutes').value = '12';
$('#time-note').value = `补记-${stamp}`;
$('#dlg-time').close('ok');
await wait(900);

const dayAfter = await daylogMod.daySummary(todayDate);
eq('补记后条目 +1', dayAfter.entries.length, beginCount + 1);
check('补记内容正确', dayAfter.entries.some(e => e.note === `补记-${stamp}`));
check('补记来源标为 manual',
  dayAfter.entries.find(e => e.note === `补记-${stamp}`)?.source === 'manual');

/* 日期导航 */
click('#view-records [data-shift="-1"]');
await wait(450);
const prevDate = $('#rec-date')?.value;
check('**能切到前一天**', prevDate !== todayDate && Boolean(prevDate), `${todayDate} → ${prevDate}`);
check('非今天时出现「回到今天」', recText().includes('回到今天'));

click('#view-records [data-today="1"]');
await wait(450);
eq('能一键回到今天', $('#rec-date')?.value, todayDate);

/* 直接改日期输入框 */
$('#rec-date').value = '2026-03-05';
$('#rec-date').dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(500);
eq('可以直接跳任意日期', $('#rec-date')?.value, '2026-03-05');
check('空日期给出空状态',
  recText().includes('没有专注记录') || recText().includes('没有任何记录'),
  recText().replace(/\s+/g, ' ').slice(0, 100));

click('#view-records [data-today="1"]');
await wait(450);

/* 学习记录的编辑 */
const seedLog = await daylogMod.createLog({
  date: todayDate, topicName: `学习记录测试-${stamp}`, minutes: 20, what: '原始内容',
});
click('#btn-refresh-panel');
await wait(800);

const logNodes = $$('#view-records .rec-item[data-log]');
check('学习记录条目可点击', logNodes.length > 0, `${logNodes.length} 条`);
const logNode = logNodes.find(n => n.textContent.includes(`学习记录测试-${stamp}`));
check('找到目标学习记录', Boolean(logNode));

logNode?.dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(350);
check('学习记录编辑弹窗打开', $('#dlg-log')?.open === true);
eq('学习记录时长已回填', $('#log-minutes')?.value, '20');
check('知识点已回填', ($('#log-topic')?.value || '').includes(`学习记录测试-${stamp}`));

$('#log-minutes').value = '45';
$('#log-what').value = `改过内容-${stamp}`;
$('#dlg-log').close('ok');
await wait(900);

const afterLog = await daylogMod.getLog(seedLog.id);
eq('**学习记录编辑已落库**', afterLog?.minutes, 45);
check('内容已更新', afterLog?.what === `改过内容-${stamp}`, afterLog?.what);

/* 今日动态的条目也能点开编辑 */
await openPanel('today');
const tlNodes = $$('#view-today .tl-clickable');
check('**今日动态里有可点击编辑的条目**', tlNodes.length > 0, `${tlNodes.length} 条`);

tlNodes[0]?.dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(350);
const openedEdit = $('#dlg-time')?.open === true || $('#dlg-log')?.open === true;
check('点今日动态能打开对应的编辑弹窗', openedEdit);
if ($('#dlg-time')?.open) $('#dlg-time').close('cancel');
if ($('#dlg-log')?.open) $('#dlg-log').close('cancel');
await wait(300);

/* 收尾清理 */
await timerMod.deleteTimeEntry(seed.id);
await daylogMod.deleteLog(seedLog.id);
for (const e of (await daylogMod.daySummary(todayDate)).entries) {
  if (e.note?.includes(`补记-${stamp}`)) await timerMod.deleteTimeEntry(e.id);
}
check('记录面板流程全程没有报错', errors.length === 0, errors[0]);

/* ══════════ 16. 说称呼要真的存下来，并且看得见 ══════════ */

console.log('\n[16] 说称呼 → 真的存下来 → 界面上看得见');

const dbMod = await import('../src/db.js');
const profBefore = await dbMod.getProfile();
check('测试前档案里没有称呼', !profBefore.userName, profBefore.userName);

/* 场景一：先询问，再用不含固定自我介绍句式的回答 */
script = [textStream('我该怎么称呼你？你目前在做什么？')];
sendText('我想和你认识一下');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(400);

script = [
  toolStream('update_profile', JSON.stringify({ userName: '小明', about: '正在准备 Agent 开发岗面试' })),
  textStream('我整理了档案草稿：称呼是小明，最近在准备 Agent 开发岗面试。确认保存吗？'),
];
const profileCallStart = fetchLog.length;
sendText('小明，最近在准备 Agent 开发岗面试。');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(700);

check('明确自我介绍会强制调用档案更新工具',
  fetchLog[profileCallStart]?.toolChoice?.function?.name === 'update_profile',
  JSON.stringify(fetchLog[profileCallStart]?.toolChoice));

const profDrafted = await dbMod.getProfile();
check('聊天确认前档案保持不变', !profDrafted.userName && !profDrafted.about);
check('档案草稿在聊天里请求确认',
  $$('#messages .msg.assistant').at(-1)?.textContent.includes('确认保存'));

script = [textStream('档案已保存。')];
sendText('确认保存');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(700);

const profAfter = await dbMod.getProfile();
eq('**确认后「叫我小明」存进档案**', profAfter.userName, '小明');
eq('个人背景在确认后写入档案', profAfter.about, '正在准备 Agent 开发岗面试');

const toastText = $('#toasts')?.textContent || '';
check('**弹出了回执提示，不用自己去翻面板**', toastText.includes('档案已更新'),
  toastText.replace(/\s+/g, ' ').slice(0, 80));
check('回执里写清了改成了什么', toastText.includes('小明'),
  toastText.replace(/\s+/g, ' ').slice(0, 80));

/* 换个措辞（曾经因为工具没下发而失败的那种）*/
script = [
  toolStream('update_profile', JSON.stringify({ topProblems: '晚上起不来、计划太多' })),
  textStream('档案草稿：最困扰的是晚上起不来、计划总是排太多。确认保存吗？'),
];
sendText('我最困扰的是晚上起不来，还有计划总是排太多');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(700);
check('第二条档案草稿确认前没有写入', !(await dbMod.getProfile()).topProblems);
script = [textStream('已保存这项档案。')];
sendText('确认保存');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(500);
const prof3 = await dbMod.getProfile();
check('换种措辞也能存下（工具不再按关键词下发）',
  (prof3.topProblems || '').includes('晚上起不来'), prof3.topProblems);

/* 场景二：改"怎么称呼监督员" → 顶栏标题要跟着变 */
const brandBefore = $('#brand-name')?.textContent;
script = [
  toolStream('update_profile', JSON.stringify({ supervisorName: '老陈' })),
  textStream('档案草稿：监督员称呼改为老陈。确认保存吗？'),
];
sendText('以后你就叫老陈');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(900);
check('监督员称呼确认前没有修改', (await dbMod.getProfile()).supervisorName !== '老陈');
script = [textStream('监督员称呼已保存。')];
sendText('确认保存');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(900);

eq('**监督员名字已存**', (await dbMod.getProfile()).supervisorName, '老陈');
eq('**顶栏标题立刻跟着变了**', $('#brand-name')?.textContent, '老陈');
check('确实和之前不一样', $('#brand-name')?.textContent !== brandBefore,
  `${brandBefore} → ${$('#brand-name')?.textContent}`);

script = [
  toolStream('update_profile', JSON.stringify({ otherNeeds: '仅用于取消流程测试' })),
  textStream('档案草稿：其他需求是“仅用于取消流程测试”。确认保存吗？'),
];
sendText('我还希望你记住这项需求');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(500);
check('取消前需求没有写进档案', !(await dbMod.getProfile()).otherNeeds);
script = [textStream('已取消，这条内容没有保存。')];
sendText('取消');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);
check('聊天中取消后档案仍未修改', !(await dbMod.getProfile()).otherNeeds);
const chatApprovalsMod = await import('../src/chat-approvals.js');
const activeSessionId = (await dbMod.ensureSession()).id;
check('取消后当前会话没有待保存草稿',
  (await chatApprovalsMod.listChatWrites(activeSessionId)).length === 0);

/* 场景三：档案面板能看到 */
await openPanel('profile');
const profPanel = $('#view-profile')?.textContent || '';
check('**档案面板显示称呼**', profPanel.includes('小明'), profPanel.slice(0, 140).replace(/\s+/g, ' '));
check('档案面板显示个人背景', profPanel.includes('正在准备 Agent 开发岗面试'));
check('档案面板显示新的监督员名字', profPanel.includes('老陈'));

/* 场景四：对话里的用户名标签跟着变 */
await openPanel('today');
script = [textStream('在。')];
sendText('在吗');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(400);
const userLabels = $$('#messages .msg.user .who').map(n => n.textContent);
check('**后续对话的用户标签用的是新称呼**',
  userLabels.some(t => t.includes('小明')), userLabels.slice(-3).join(','));

/* 收尾：把档案改回去，免得影响别的测试 */
await dbMod.saveProfile({ userName: '', supervisorName: '帕尼尼', topProblems: '' });
click('#btn-refresh-panel');
await wait(500);
eq('顶栏恢复', $('#brand-name')?.textContent, '帕尼尼');
check('档案流程全程没有报错', errors.length === 0, errors[0]);

/* 记录草稿由保存按钮一次点击确认 */
console.log('\n[16.5] 点击保存长期记忆草稿');
const clickSaveMemory = `按钮保存记忆-${stamp}`;
script = [
  toolStream('save_memory', JSON.stringify({ text: clickSaveMemory, kind: 'preference', importance: 3 })),
  textStream(`我整理了长期记忆草稿：${clickSaveMemory}。点下面的保存按钮即可写入。`),
];
sendText('把这条整理成长期记忆');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(450);
check('长期记忆草稿显示单击保存按钮',
  $('#pending-area [data-confirm]')?.textContent === '保存', $('#pending-area')?.textContent);
click('#pending-area [data-confirm]');
await wait(600);
const savedClickMemory = (await dbMod.db.memories.toArray()).some(m => m.text === clickSaveMemory);
check('点一次保存后记忆已写入且按钮收起', savedClickMemory && !$('#pending-area [data-confirm]'));

/* ══════════ 17. 模型能自己开面板、导记录（不再只靠正则） ══════════ */

console.log('\n[17] 导出与开面板：模型自己也能做，不再被正则把关');

/* 先切到别的面板，才能看出 open_panel 真的起作用 */
await openPanel('today');
check('起始在今日面板', $('#view-today')?.classList.contains('active'));

script = [
  toolStream('open_panel', JSON.stringify({ panel: 'points' })),
  textStream('帮你打开了积分面板。'),
];
sendText('我积分怎么样了');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(600);

check('**模型能自己打开对应面板**', $('#view-points')?.classList.contains('active'),
  $('#panel-title')?.textContent);
check('学习导航高亮同步了', $('.nav-btn[data-panel="learning"]')?.classList.contains('active'));
check('工具轨迹里能看到 open_panel',
  $$('#messages .tool-call').some(e => e.textContent.includes('open_panel')));

/* 非法面板名要被拒绝，而不是静默失败 */
script = [
  toolStream('open_panel', JSON.stringify({ panel: '不存在的面板' })),
  textStream('好，不开了。'),
];
sendText('开个乱七八糟的面板');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(500);
check('非法面板名被拒绝且给出可读错误',
  $$('#messages .tool-call').some(e => e.textContent.includes('open_panel ✗')),
  $$('#messages .tool-call').slice(-3).map(e => e.textContent).join(' | '));

/* 导出：以前只有正则那一条路，现在有工具 */
script = [
  toolStream('export_records', JSON.stringify({})),
  textStream('导出好了，文件在下载里。'),
];
sendText('帮我把记录导出来');
await waitIdle().catch(e => console.log(`    ⚠️ ${e.message}`));
await wait(800);

const exportTrace = $$('#messages .tool-call').map(e => e.textContent).filter(t => t.includes('export_records'));
check('**模型能自己触发导出（不再依赖「导出记录」正则）**', exportTrace.length > 0,
  exportTrace.join(' | '));
check('导出工具执行成功（没有 ✗）',
  exportTrace.some(t => t.includes('✓') || t.includes('行')), exportTrace.join(' | '));

/* 而正则那条快路径也还在，且效果一致 */
await openPanel('today');
const beforePanel = fetchLog.length;
sendText('查看任务');
await wait(600);
check('「查看任务」走代码快路径，不消耗模型调用', fetchLog.length === beforePanel,
  `${beforePanel} → ${fetchLog.length}`);
check('快路径确实切了面板', $('#view-tasks')?.classList.contains('active'));

check('导出与导航流程全程没有报错', errors.length === 0, errors[0]);

/* ══════════ 结果 ══════════ */

console.log(`\n${'─'.repeat(60)}`);
console.log(`fetch 调用 ${fetchLog.length} 次，模型：${[...new Set(fetchLog.map(f => f.model))].join(', ')}`);
if (warnings.length) console.log(`console.warn ${warnings.length} 条（正常）：${warnings.slice(0, 2).join(' | ')}`);

if (errors.length) {
  console.log(`\n❌ 捕获到 ${errors.length} 个 JS 错误：`);
  for (const e of errors.slice(0, 10)) console.log(`   · ${e.slice(0, 300)}`);
}
if (fails.length) {
  console.log(`\n❌ ${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exitCode = 1;
} else if (!errors.length) {
  console.log(`\n✅ 全部 ${pass} 项通过，无 JS 错误。`);
}
