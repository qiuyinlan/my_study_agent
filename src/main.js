// ── 启动装配 ────────────────────────────────────────────────
//
// 一条消息的完整路径（§17 的"代码级 vs 模型级"分工在这里落地）：
//
//   1. detectIntent() 正则识别意图                          ← 零 token
//   2. 若是 panel_* → 纯 UI 切换，直接结束，不调模型
//   3. 若是计时/暂停/导出 → **代码先执行**，拿到精确结果
//   4. 把结果作为"事实"注入上下文，再交给模型处理并说话
//
// 这样时间、状态这类确定性数据永远精确；模型只负责判断和表达。

import {
  $, $$, toast, renderStats, renderBrand, renderTimerBar, renderNav, initChromeIcons,
  createChatView, renderPendingArea, markPendingDone,
} from './ui.js';
import { PANELS, showPanel, getCurrentPanel, setPanelSub, refreshPanel, panelBadges } from './panels.js';
import { computeToday, todayCards } from './planner.js';
import { runTurn } from './agent.js';
import {
  ensureSession, sessionMessages, getMeta, getProfile, saveProfile, createSession, setTaskCompletion, addMessage,
} from './db.js';
import { loadSettings } from './config.js';
import {
  openSettings, openBackup, openTask, openTopic, openReview, openSessions,
  openProfile, openKeyTasks, openPlan, openSop, openRewardEditor,
  openTimeEntry, openLogEntry,
} from './dialogs.js';
import { scheduleMirror, getMirrorState } from './backup.js';
import { startTimer, stopTimer, getActiveTimer } from './timer.js';
import { confirmAllPoints, redeemReward, getLedger, awardPoints } from './ledger.js';
import { upsertCheckin, setMedsEnabled } from './records.js';
import { initDailyReviewSync } from './dailyReview.js';
import { initTaskSync } from './taskSync.js';
import { downloadMarkdownExport, buildMarkdownExport, markdownStats } from './exportmd.js';
import { detectIntent, ALL_COMMANDS } from './commands.js';
import { executeTool } from './tools.js';
import { listPending, removePending, clearPending } from './pending.js';
import { listChatWrites, removeChatWrites } from './chat-approvals.js';
import { debounce } from './util.js';

const chat = createChatView($('#messages'));

let busy = false;
let controller = null;
let todayState = null;
let profile = null;
/** 上一次算好的卡片。switchPanel 复用它，避免在数据未就绪时用残缺对象重算而崩。 */
let lastCards = [];

/* ── 界面状态（折叠 + 宽度，记住上次的选择）── */
const UI_KEY = 'msa.ui.v1';
const WIDTH_LIMITS = {
  nav: { min: 148, max: 340, varName: '--nav-w' },
  panel: { min: 240, max: 620, varName: '--panel-w' },
};
let uiState = { navCollapsed: false, panelCollapsed: false, topbarCollapsed: false, navWidth: null, panelWidth: null };
let workspaceMode = 'content';
let chatContextOpen = false;

function loadUiState() {
  try {
    uiState = { ...uiState, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') };
  } catch { /* 用默认值 */ }
}

function applyUiState({ persist = true } = {}) {
  document.body.classList.toggle('nav-collapsed', uiState.navCollapsed);
  document.body.classList.toggle('panel-collapsed', uiState.panelCollapsed);
  document.body.classList.toggle('topbar-collapsed', uiState.topbarCollapsed);
  uiState.currentPanel = getCurrentPanel();
  uiState.workspaceMode = workspaceMode;
  const app = $('.app');
  app?.classList.toggle('chat-mode', workspaceMode === 'chat');
  app?.classList.toggle('chat-context', workspaceMode === 'chat' && chatContextOpen);
  const contextBtn = $('#btn-chat-context');
  if (contextBtn) {
    contextBtn.title = chatContextOpen ? '隐藏内容侧栏' : '显示内容侧栏';
    contextBtn.setAttribute('aria-label', contextBtn.title);
    contextBtn.classList.toggle('active', chatContextOpen);
  }

  const root = document.documentElement;
  for (const [key, lim] of Object.entries(WIDTH_LIMITS)) {
    const w = uiState[`${key}Width`];
    if (w) root.style.setProperty(lim.varName, `${Math.round(w)}px`);
    else root.style.removeProperty(lim.varName);
  }

  initChromeIcons(uiState);
  if (persist) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(uiState)); } catch { /* 无痕模式 */ }
  }
}

/**
 * 拖动分隔条改宽度。
 * 用 pointer capture，这样鼠标移出把手也不会丢事件。
 * 拖动过程中只改样式不写 localStorage（每帧写一遍太浪费）。
 */
function setupResizer(handleId, key) {
  const handle = $(handleId);
  const lim = WIDTH_LIMITS[key];
  const target = key === 'nav' ? $('#nav') : $('#panel');
  if (!handle || !target) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  const onMove = e => {
    if (!dragging) return;
    const raw = startW + (e.clientX - startX);
    const w = Math.round(Math.min(lim.max, Math.max(lim.min, raw)));
    uiState[`${key}Width`] = w;
    applyUiState({ persist: false });
  };

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    applyUiState();   // 松手才落盘
  };

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = target.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    try { handle.setPointerCapture(e.pointerId); } catch { /* 不支持就算了 */ }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });

  // 双击复位到默认宽度
  handle.addEventListener('dblclick', () => {
    uiState[`${key}Width`] = null;
    applyUiState();
  });
}

/* ══════════════ 刷新 ══════════════ */

async function refreshAll() {
  try {
    profile = await getProfile();
    todayState = await computeToday();

    // 顶栏标题跟着档案走 —— 用户改完称呼不该看起来像没生效
    renderBrand(profile);
    renderStats(todayState);
    setPanelSub('');
    renderChrome();

    renderTimerBar(todayState.timer, { onStop: handleTimerBar });

    const plan = await getMeta('todayPlan', null);
    lastCards = todayCards(todayState);
    await refreshPanel(getCurrentPanel(), todayState, lastCards, plan, handlers);
    await refreshPending();

    markUpdated();
  } catch (e) {
    console.error('[refreshAll]', e);
    toast(`刷新失败：${e.message}`, 'err');
  }
}

/** 在面板标题旁显示"几点更新的"，并闪一下 —— 让用户看见刷新真的发生了 */
function markUpdated() {
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  const el = $('#panel-updated');
  if (el) el.textContent = `${p(t.getHours())}:${p(t.getMinutes())} 更新`;

  const panel = $('#panel');
  if (panel) {
    panel.classList.remove('flash');
    void panel.offsetWidth;   // 强制重排，让动画能重放
    panel.classList.add('flash');
    setTimeout(() => panel.classList.remove('flash'), 700);
  }
}

const refreshAllDebounced = debounce(refreshAll, 300);

/** 导航 + 折叠按钮统一重绘（角标依赖今天的统计，所以跟着 refreshAll 走） */
function renderChrome() {
  // 学习工作台的内部页面仍归属于“学习”，保持一级导航位置感。
  const current = getCurrentPanel();
  const learningPages = ['records', 'tasks', 'checkin', 'points', 'plans', 'sops', 'reviews', 'profile'];
  const activeNav = workspaceMode === 'chat' ? 'chat' : learningPages.includes(current) ? 'learning' : current;
  renderNav(PANELS, activeNav, switchPanel, panelBadges(todayState));
  const backLearning = $('#btn-back-learning');
  if (backLearning) backLearning.hidden = !learningPages.includes(current);
  initChromeIcons(uiState);
}

function setWorkspaceMode(mode) {
  workspaceMode = mode === 'chat' ? 'chat' : 'content';
  if (workspaceMode === 'content') chatContextOpen = false;
  if (workspaceMode === 'chat' && uiState.panelCollapsed) uiState.panelCollapsed = false;
  applyUiState();
  renderChrome();
}

async function switchPanel(id) {
  if (id === 'chat') {
    setWorkspaceMode('chat');
    $('#input')?.focus();
    return;
  }
  if (workspaceMode === 'chat') setWorkspaceMode('content');
  showPanel(id);
  applyUiState();
  renderChrome();

  // 数据还没就绪时只切视图，别用残缺对象去渲染（会崩）
  if (!todayState) return;
  try {
    const plan = await getMeta('todayPlan', null);
    await refreshPanel(id, todayState, lastCards, plan, handlers);
  } catch (e) {
    toast(`面板加载失败：${e.message}`, 'err');
    console.error('[switchPanel]', e);
  }
  $('#panel-body').scrollTop = 0;
}

async function refreshChat() {
  const s = await ensureSession();
  const messages = await sessionMessages(s.id);
  chat.renderHistory(messages, profile || await getProfile());
}

/* ══════════════ 待确认动作 ══════════════ */

/**
 * 承诺类动作（开始计时、暂停监督、删除…）不直接执行，而是渲染成按钮。
 * 这是 §21「用户拥有最终决定权」的落点 —— 模型可以提议，但按下开始键的
 * 必须是用户本人。
 */
async function refreshPending() {
  const s = await ensureSession();
  const [actions, drafts] = await Promise.all([listPending(s.id), listChatWrites(s.id)]);
  const draftActions = drafts.map(item => ({
    ...item,
    label: `保存${({ save_memory: '长期记忆', update_profile: '档案', save_task: '任务', log_study: '学习记录', save_checkin: '打卡', save_review: '复盘', add_topic: '知识点' })[item.tool] || '记录'}`,
    detail: describeChatDraft(item),
    danger: false,
    chatDraft: true,
  }));
  renderPendingArea([...draftActions, ...actions], {
    onConfirm: confirmPending,
    onDismiss: async (id) => {
      if (id.startsWith('chat_approval_')) await removeChatWrites([id]);
      else await removePending(id);
      await refreshPending();
    },
  });
}

function describeChatDraft(item) {
  const args = item.args || {};
  if (item.tool === 'save_memory') return args.text || '长期记忆草稿';
  if (item.tool === 'save_task') return args.title || '新任务';
  if (item.tool === 'log_study') return [args.topic, args.what, args.minutes && `${args.minutes} 分钟`].filter(Boolean).join(' · ');
  if (item.tool === 'save_checkin') return Object.entries(args).filter(([, value]) => value !== '' && value != null).map(([key, value]) => `${key}：${value}`).join(' · ');
  if (item.tool === 'save_review') return [args.kind, args.action, args.actual].filter(Boolean).join(' · ');
  if (item.tool === 'add_topic') return args.name || '新知识点';
  if (item.tool === 'update_profile') return Object.entries(args).filter(([, value]) => value !== '' && value != null).map(([, value]) => value).join(' · ');
  return Object.entries(args).filter(([, value]) => value !== '' && value != null).map(([, value]) => String(value)).join(' · ');
}

async function confirmPending(pendingId) {
  if (pendingId.startsWith('chat_approval_')) {
    const s = await ensureSession();
    const item = (await listChatWrites(s.id)).find(p => p.id === pendingId);
    if (!item) { toast('这条草稿已失效', 'warn'); await refreshPending(); return; }
    try {
      const out = await executeTool(item.tool, item.args, { confirmed: true, sessionId: item.sessionId || s.id });
      if (out.error) throw new Error(out.content || '保存失败');
      await removeChatWrites([pendingId]);
      await addMessage({ sessionId: item.sessionId || s.id, role: 'assistant', content: out.content || `已保存：${item.tool}` });
      toast(out.summary || '已保存', 'ok');
      await refreshChat();
      await refreshAll();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
    await refreshPending();
    return;
  }

  const items = await listPending();
  const item = items.find(p => p.id === pendingId);
  if (!item) {
    toast('这个待确认项已经失效了', 'warn');
    await refreshPending();
    return;
  }

  try {
    const out = await executeTool(item.tool, item.args, {
      confirmed: true,
      sessionId: item.sessionId || '',
    });
    await removePending(pendingId);
    markPendingDone(pendingId, out.error ? '执行失败' : (out.summary || item.label));
    toast(out.error ? `执行失败：${out.content}` : (out.summary || '已执行'),
      out.error ? 'err' : 'ok');

    await refreshAll();                       // 计时条、面板都跟着更新
    setTimeout(() => { refreshPending(); }, 1100);  // 让"已执行"停留一会儿再收走
  } catch (e) {
    toast(`执行失败：${e.message}`, 'err');
    console.error('[confirmPending]', e);
  }
}

/* ══════════════ 代码动作（§17 代码级指令）═════════════ */

/**
 * 执行确定性操作，返回给模型的事实描述。
 * @returns {Promise<{note:string|null, uiOnly:boolean}>}
 */
async function runCodeAction(action, rawText) {
  const fmt = iso => (iso ? iso.slice(0, 19).replace('T', ' ') : '');

  switch (action) {
    case 'timer_start': {
      const existing = await getActiveTimer();
      if (existing) {
        toast(`已经在计时了（${existing.label}，已过 ${existing.elapsedText}）`, 'warn');
        return { note: `已有计时在跑（${existing.label}，已过 ${existing.elapsedText}），没有重复启动。`, uiOnly: false };
      }
      const plannedMin = Number(rawText.match(/计时\s*(\d+)\s*分钟/i)?.[1]) || null;
      const task = rawText.match(/当前任务\s*[：:]\s*([^\r\n]+)/i)?.[1]?.trim();
      const note = task || rawText.slice(0, 40);
      const t = await startTimer({ note, plannedMin });
      toast(`计时开始：${t.label}`, 'ok');
      await refreshAll();
      return {
        note: `页面侧已执行 timer_start。开始时间 ${fmt(t.startedAt)}，标签「${t.label}」，${t.plannedMin ? `计划 ${t.plannedMin} 分钟` : '未设计划时长'}。这是真实的墙钟计时，页面刷新也不会丢。`,
        uiOnly: false,
      };
    }

    case 'timer_stop': {
      const active = await getActiveTimer();
      if (!active) {
        toast('当前没有计时在跑', 'warn');
        return { note: '页面侧尝试 timer_stop，但没有正在运行的计时器。', uiOnly: false };
      }
      const r = await stopTimer({});
      toast(`计时结束：实际 ${r.actualMin} 分钟`, 'ok');
      await refreshAll();
      return {
        note: `页面侧已执行 timer_stop。真实耗时 **${r.actualMin} 分钟**（墙钟，不是自报）`
          + `${r.plannedMin ? `，计划 ${r.plannedMin} 分钟，相差 ${r.actualMin - r.plannedMin > 0 ? '+' : ''}${r.actualMin - r.plannedMin} 分钟` : ''}。`
          + `按 §9 继续核验：完成内容、是否达到完成标准、要不要更新任务状态。`,
        uiOnly: false,
      };
    }

    case 'suspend': {
      await saveProfile({ suspendUntil: 'indefinite' });
      toast('监督已暂停', 'ok');
      await refreshAll();
      return {
        note: '页面侧已执行 suspend_supervision：监督暂停状态已写入（直到用户主动解除）。接下来不要催任务、不要算积分、不要做复盘、不要用冷嘲。',
        uiOnly: false,
      };
    }

    case 'unsuspend': {
      await saveProfile({ suspendUntil: null });
      toast('监督已恢复', 'ok');
      await refreshAll();
      return { note: '页面侧已执行 resume_supervision：暂停状态已解除。可以先问一句他现在的状态，别一上来就催。', uiOnly: false };
    }

    case 'export_md': {
      const md = await downloadMarkdownExport({});
      const st = markdownStats(md);
      toast(`已导出 Markdown（${st.lines} 行）`, 'ok');
      return { note: `页面侧已生成并下载结构化 Markdown 记录：${st.lines} 行、约 ${st.chars} 字符。内容包含档案、任务、时间记录、打卡、积分、规划、SOP、复盘、拖延模式、待续事项。`, uiOnly: false };
    }

    /* ── 纯 UI 导航：不调模型 ── */
    case 'panel_tasks':   switchPanel('tasks');    return { note: null, uiOnly: true };
    case 'panel_checkin': switchPanel('checkin');  return { note: null, uiOnly: true };
    case 'panel_points':  switchPanel('points');   return { note: null, uiOnly: true };
    case 'panel_plans':   switchPanel('plans');    return { note: null, uiOnly: true };
    case 'panel_sops':    switchPanel('sops');     return { note: null, uiOnly: true };
    case 'panel_profile': switchPanel('profile');  return { note: null, uiOnly: true };

    default:
      return { note: null, uiOnly: false };
  }
}

/* ══════════════ 发送 ══════════════ */

function setBusy(state) {
  busy = state;
  const btn = $('#btn-send');
  btn.textContent = state ? '停止' : '发送';
}

function handleEvent(e) {
  switch (e.type) {
    case 'delta': chat.appendDelta(e.text); break;
    case 'reasoning': chat.appendReasoning(e.text); break;
    case 'tool_start': chat.toolStart(e.name, e.args); break;
    case 'tool_result':
      chat.toolResult(e.name, e.ok, e.summary);
      // 有些工具（比如更新档案）会带回一句给用户看的回执 ——
      // 否则他说完"叫我小明"，只能自己翻面板确认到底存没存上
      if (e.toast) toast(e.toast, e.ok === false ? 'err' : 'ok');
      break;
    case 'pending': refreshPending(); break;
    // 模型可以帮用户切到相关面板（工具层返回 openPanel，不直接碰 DOM）
    case 'open_panel': switchPanel(e.panel); break;
    case 'notice': chat.notice(e.text); break;
    case 'aborted': chat.notice('已中断'); break;
    case 'error':
      chat.fail(e.error, { raw: e.raw, kind: e.kind, status: e.status });
      break;
    case 'refresh': refreshAllDebounced(); break;
    case 'tools_selected':
      console.info(`[tools] 本轮下发 ${e.count} 个工具（全量）`);
      break;
    case 'memories_saved': toast(`沉淀了 ${e.memories.length} 条长期记忆`, 'ok'); break;
    case 'compacted': toast(`已把 ${e.count} 条历史消息压缩成摘要`); break;
    case 'usage':
      if (e.usage?.prompt_cache_hit_tokens) {
        console.info(`[usage] 缓存命中 ${e.usage.prompt_cache_hit_tokens} / 输入 ${e.usage.prompt_tokens}`);
      }
      break;
    case 'done': chat.finish(); break;
    default: break;
  }
}

async function send(text, { skipIntent = false } = {}) {
  const content = String(text || '').trim();
  if (!content || busy) return;

  const settings = loadSettings();
  if (!settings.apiKey) {
    toast('还没填 API Key，先打开设置填一下', 'err');
    await openSettings({ onChange: refreshAll, profile });
    return;
  }

  /* 1) 意图识别（零 token） */
  const intent = detectIntent(content);
  let codeNote = '';

  /* 2) 代码动作优先执行 */
  if (!skipIntent && intent.codeAction) {
    const r = await runCodeAction(intent.codeAction, content);
    if (r.uiOnly) {
      toast('已在侧栏打开', 'ok');
      return;   // 纯导航不调模型
    }
    codeNote = r.note || '';
  }

  /* 3) 交给模型 */
  busy = true;
  setBusy(true);
  controller = new AbortController();

  chat.appendUser(content, profile);

  try {
    await runTurn({
      userText: content,
      codeNote,
      model: null,
      signal: controller.signal,
      onEvent: handleEvent,
    });
  } catch (e) {
    if (e?.name === 'AbortError') chat.notice('已中断');
    else {
      console.error('[send]', e);
      chat.fail(e?.message || String(e), { raw: e?.raw || '', kind: e?.kind || '', status: e?.status ?? null });
    }
  } finally {
    busy = false;
    controller = null;
    // 先把侧栏刷新到位，再把按钮恢复成「发送」。
    // 反过来的话，按钮已经显示空闲、侧栏却还是旧数据，用户就会觉得"没更新"。
    await refreshAll();
    setBusy(false);
    scheduleMirror();
    $('#input')?.focus();
  }
}

/* ══════════════ 面板回调 ══════════════ */

const handlers = {
  onNavigate: id => switchPanel(id),
  onMicroHabitChanged: () => refreshAll(),
  onLifeChanged: () => refreshAll(),
  onDaybookChanged: () => refreshAll(),
  onOpenTask: id => openTask(id, { onChanged: refreshAll, onKeyTask: refreshAll }),
  onNewTask: () => openTask(null, { onChanged: refreshAll }),
  onToggleTask: async (id, completed) => {
    await setTaskCompletion(id, completed);
    await refreshAll();
  },
  onOpenTopic: id => openTopic(id, { onChanged: refreshAll }),
  onPickKey: () => openKeyTasks({ onChanged: refreshAll }),
  onReview: () => openReview({ onChanged: refreshAll }),
  onOpenPlan: id => openPlan(id, { onChanged: refreshAll }),
  onNewPlan: () => openPlan(null, { onChanged: refreshAll }),
  onOpenSop: id => openSop(id, { onChanged: refreshAll }),
  onNewSop: () => openSop(null, { onChanged: refreshAll }),
  onEditProfile: () => openProfile({ onChanged: refreshAll }),
  onTimerDetail: () => { if (todayState?.timer?.taskId) openTask(todayState.timer.taskId, { onChanged: refreshAll }); },

  /* 专注记录 / 学习记录的编辑与补记（记录面板和今日动态都用这几个） */
  onEditTimeEntry: id => openTimeEntry(id, { onChanged: refreshAll }),
  onAddTimeEntry: date => openTimeEntry(null, { onChanged: refreshAll, date }),
  onEditLog: id => openLogEntry(id, { onChanged: refreshAll }),
  onAddLogEntry: date => openLogEntry(null, { onChanged: refreshAll, date }),

  onCommand: cmdId => runCommand(cmdId),

  onCheckinSave: async fields => {
    try {
      await upsertCheckin(fields);
      toast('打卡已保存', 'ok');
      await refreshAll();
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    }
  },

  onMedsToggle: async v => {
    await setMedsEnabled(v);
    toast(v ? '已开启服药字段' : '已关闭服药字段');
    await refreshAll();
  },

  onConfirmAllPoints: async () => {
    const n = await confirmAllPoints();
    toast(`已确认 ${n} 笔积分`, 'ok');
    await refreshAll();
  },

  onRedeem: async id => {
    try {
      const r = await redeemReward(id);
      toast(`已兑换「${r.reward.name}」，剩余 ${r.remaining} 分`, 'ok');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'err');
    }
  },

  onNewReward: () => openRewardEditor({ onChanged: refreshAll }),
};

/* ══════════════ 指令执行 ══════════════ */

async function runCommand(cmdId) {
  const cmd = ALL_COMMANDS.find(c => c.id === cmdId);
  if (!cmd) return;

  if (cmd.handler === 'code' && cmd.codeAction) {
    const r = await runCodeAction(cmd.codeAction, cmd.label);
    if (r.uiOnly) { toast(`已打开「${cmd.label}」`, 'ok'); return; }
    if (r.note) {
      // 代码动作有结果 → 也让模型说一句
      await send(cmd.label, { skipIntent: true });
    }
    return;
  }

  // 模型级：把指令名当作用户发言发出去，由模型按注入的流程处理
  await send(cmd.label, { skipIntent: true });
}

/* ══════════════ 计时条回调 ══════════════ */

async function handleTimerBar(kind) {
  if (kind === 'detail') {
    const t = await getActiveTimer();
    if (t?.taskId) openTask(t.taskId, { onChanged: refreshAll });
    else toast('这次计时没有关联任务');
    return;
  }
  try {
    const r = await stopTimer({});
    toast(`计时结束：实际 ${r.actualMin} 分钟`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  await refreshAll();
}

/* ══════════════ 输入框 ══════════════ */

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

function wireComposer() {
  const form = $('#composer');
  const input = $('#input');

  input.addEventListener('input', autoGrow);
  // Enter 只换行；发送必须点击按钮。

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (busy) { controller?.abort(); return; }
    const text = input.value;
    input.value = '';
    autoGrow();
    send(text);
  });
}

/* ══════════════ 顶栏 ══════════════ */

function wireTopbar() {
  $('#btn-collapse-topbar').onclick = () => {
    uiState.topbarCollapsed = !uiState.topbarCollapsed;
    applyUiState();
  };
  $('#btn-chat-context').onclick = () => {
    chatContextOpen = !chatContextOpen;
    uiState.panelCollapsed = false;
    applyUiState();
  };
  $('#btn-settings').onclick = () => openSettings({ onChange: refreshAll, profile });
  $('#btn-backup').onclick = () => openBackup({ onChanged: refreshAll });
  $('#btn-export').onclick = async () => {
    const md = await downloadMarkdownExport({});
    toast(`已导出 Markdown（${markdownStats(md).lines} 行）`, 'ok');
  };

  /* 新对话：直接开一条，不弹窗、不确认 —— 这是最常用的动作 */
  $('#btn-new-chat').onclick = async () => {
    if (busy) { toast('等这一轮说完再开新对话', 'warn'); return; }
    try {
      await createSession();
      await refreshChat();
      await refreshAll();
      toast('已开新对话', 'ok');
      $('#input')?.focus();
    } catch (e) {
      toast(`新建失败：${e.message}`, 'err');
    }
  };

  /* 对话列表：切换 / 删除 */
  $('#btn-sessions').onclick = () => openSessions({
    onChanged: async () => { await refreshChat(); await refreshAll(); },
  });

  /* 折叠：导航和面板各自独立，状态持久化 */
  $('#btn-collapse-nav').onclick = () => {
    uiState.navCollapsed = !uiState.navCollapsed;
    applyUiState();
  };
  $('#btn-collapse-panel').onclick = () => {
    uiState.panelCollapsed = true;
    applyUiState();
  };
  $('#btn-back-learning').onclick = () => switchPanel('learning');
  $('#btn-reveal-panel').onclick = () => {
    uiState.panelCollapsed = false;
    applyUiState();
  };

  /* 手动刷新：面板标题旁的刷新按钮 */
  $('#btn-refresh-panel').onclick = async () => {
    const btn = $('#btn-refresh-panel');
    btn.classList.add('spinning');
    try {
      await refreshAll();
      toast('已刷新', 'ok');
    } finally {
      btn.classList.remove('spinning');
    }
  };

}

/* ══════════════ 启动 ══════════════ */

async function boot() {
  loadUiState();
  showPanel(uiState.currentPanel || 'learning');
  workspaceMode = uiState.workspaceMode === 'chat' ? 'chat' : 'content';
  applyUiState();
  void initDailyReviewSync(() => { void refreshAll(); })
    .then(() => refreshAll())
    .catch(error => console.warn('[daily-review-sync]', error));
  void initTaskSync(() => { void refreshAll(); })
    .catch(error => console.warn('[task-sync-init]', error))
    .finally(() => { void refreshAll(); });

  wireComposer();
  wireTopbar();
  setBusy(false);
  setupResizer('#resize-nav', 'nav');
  setupResizer('#resize-panel', 'panel');

  profile = await getProfile();
  $('#brand-name').textContent = profile.supervisorName || '帕尼尼';

  await ensureSession();
  await refreshAll();
  await refreshChat();

  // 镜像权限：浏览器每次重开页面都会重置
  try {
    const st = await getMirrorState();
    if (st.enabled && !st.granted) toast('自动镜像需要重新授权：打开「备份」点一下即可', 'warn');
  } catch (e) {
    console.warn('[mirror]', e);
  }

  // 没有 Key 时不再每次启动强制弹出设置；发送消息时会按需打开。
  if (loadSettings().apiKey && !profile.onboardedAt) {
    // §4：初始化没完成就提示开始
    toast('档案还没建立。跟帕尼尼说句话，他会开始问你。');
  }

  $('#input')?.focus();
  window.addEventListener('beforeunload', () => scheduleMirror.flush());

  // 页面重新可见时刷新（计时条在切回来时要立刻对上）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAllDebounced();
  });
}

boot().catch(e => {
  console.error('[boot]', e);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:14px 18px;color:#cf222e;background:#ffeff0;border-bottom:1px solid #f3c2c5">
      启动失败：${String(e?.message || e)}
     </div>`);
});
