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
  listTasks, deleteTask, upsertTask,
  cleanupOldCompletedTasks,
} from './db.js';
import { loadSettings } from './config.js';
import { workerConfigured } from './workerApi.js';
import {
  openSettings, openBackup, openTask, openTopic, openReview, openSessions,
  openProfile, openKeyTasks, openPlan, openSop, openRewardEditor,
  openTimeEntry, openLogEntry,
} from './dialogs.js';
import { scheduleMirror, getMirrorState } from './backup.js';
import { stopTimer, getActiveTimer } from './timer.js';
import { confirmAllPoints, redeemReward, getLedger, awardPoints } from './ledger.js';
import { upsertCheckin, setMedsEnabled } from './records.js';
import { initDailyReviewSync } from './dailyReview.js';
import { initTaskSync } from './taskSync.js';
import { initPrivateSync } from './privateSync.js';
import { pruneMicroHabitHistory } from './microhabit.js';
import { downloadMarkdownExport, buildMarkdownExport, markdownStats } from './exportmd.js';
import { detectIntent, ALL_COMMANDS } from './commands.js';
import { executeTool } from './tools.js';
import { listPending, removePending, clearPending } from './pending.js';
import { listChatWrites, removeChatWrites } from './chat-approvals.js';
import { recordAction } from './operation-plan.js';
import { debounce, dateStr } from './util.js';
import { togglePlanTask, completePlanTaskSlice, movePlanStage, activatePlanStage, planStages, schedulePlanTasks, getPlan } from './docs.js';

const chat = createChatView($('#messages'));

let busy = false;
let controller = null;
let turnErrorRendered = false;
let todayState = null;
let profile = null;
/** 上一次算好的卡片。switchPanel 复用它，避免在数据未就绪时用残缺对象重算而崩。 */
let lastCards = [];

/* ── 界面状态（折叠 + 宽度，记住上次的选择）── */
const UI_KEY = 'msa.ui.v1';
const ABOUT_ME_KEY = 'msa.about-me.v1';
const WIDTH_LIMITS = {
  panel: { min: 240, max: 620, varName: '--panel-w' },
};
let uiState = { navCollapsed: true, panelCollapsed: false, topbarCollapsed: false, navWidth: null, panelWidth: null };
let workspaceMode = 'content';
let aboutInterview = { active: false, startedAt: null };

function loadUiState() {
  try {
    uiState = { ...uiState, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') };
    uiState.navCollapsed = true;
    uiState.topbarCollapsed = false;
  } catch { /* 用默认值 */ }
  try {
    const saved = JSON.parse(localStorage.getItem(ABOUT_ME_KEY) || '{}');
    aboutInterview = { ...aboutInterview, ...saved };
  } catch { /* 用默认值 */ }
}

function saveAboutInterview() {
  try { localStorage.setItem(ABOUT_ME_KEY, JSON.stringify(aboutInterview)); } catch { /* 无痕模式 */ }
}

function setAboutInterviewActive(active) {
  aboutInterview = { active: Boolean(active), startedAt: active ? (aboutInterview.startedAt || new Date().toISOString()) : null };
  saveAboutInterview();
  updateAboutButton();
}

function updateAboutButton() {
  const btn = $('#btn-about-me');
  if (!btn) return;
  btn.textContent = window.innerWidth <= 840 ? '我' : '聊聊我';
  btn.title = aboutInterview.active ? '继续关于我的逐题访谈' : '开始关于我的逐题访谈';
  btn.setAttribute('aria-pressed', String(aboutInterview.active));
}

function updateNavigationBackdrop() {
  const backdrop = $('#nav-backdrop');
  const hidden = uiState.navCollapsed || window.innerWidth > 840;
  backdrop?.setAttribute('aria-hidden', String(hidden));
  if (backdrop) backdrop.tabIndex = hidden ? -1 : 0;
}

function applyUiState({ persist = true } = {}) {
  document.body.classList.toggle('nav-collapsed', uiState.navCollapsed);
  document.body.classList.toggle('panel-collapsed', uiState.panelCollapsed);
  document.body.classList.toggle('topbar-collapsed', uiState.topbarCollapsed);
  uiState.currentPanel = getCurrentPanel();
  uiState.workspaceMode = workspaceMode;
  const app = $('.app');
  app?.classList.toggle('chat-mode', workspaceMode === 'chat');
  updateAboutButton();
  updateNavigationBackdrop();

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

function setNavigationCollapsed(collapsed) {
  const value = Boolean(collapsed);
  uiState.navCollapsed = value;
  uiState.topbarCollapsed = false;
  applyUiState();
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
  const learningPages = ['checkin', 'points', 'plans', 'sops', 'reviews', 'profile'];
  const activeNav = workspaceMode === 'chat' ? 'chat' : learningPages.includes(current) ? 'learning' : current;
  renderNav(PANELS, activeNav, switchPanel, panelBadges(todayState));
  const backLearning = $('#btn-back-learning');
  if (backLearning) backLearning.hidden = !learningPages.includes(current);
  initChromeIcons(uiState);
}

function setWorkspaceMode(mode) {
  workspaceMode = mode === 'chat' ? 'chat' : 'content';
  if (workspaceMode === 'chat' && uiState.panelCollapsed) uiState.panelCollapsed = false;
  applyUiState();
  renderChrome();
}

async function switchPanel(id) {
  if (window.innerWidth <= 840) setNavigationCollapsed(true);
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
  const previousIds = new Set($$('#pending-area [data-pending]').map(node => node.dataset.pending));
  const draftActions = drafts.map(item => ({
    ...item,
    label: `保存${({ save_memory: '长期记忆', update_profile: '档案', save_task: '任务', log_study: '学习记录', save_checkin: '打卡', save_review: '复盘', add_topic: '知识点' })[item.tool] || '记录'}`,
    detail: describeChatDraft(item),
    danger: false,
    chatDraft: true,
  }));
  const draftLabels = {
    save_memory: '长期记忆', update_profile: '档案', save_task: '任务', set_task_state: '任务状态',
    log_study: '学习记录', log_time_entry: '耗时记录', save_checkin: '打卡', save_review: '复盘',
    save_plan: '计划', save_sop: '流程', add_topic: '知识点', manage_micro_habit: '微习惯',
    manage_life_navigation: '生活导航', upsert_reward: '奖励',
  };
  draftActions.forEach((item, index) => {
    const tool = drafts[index]?.tool;
    if (draftLabels[tool]) item.label = `保存${draftLabels[tool]}`;
  });
  if ((draftActions.length || actions.length) && workspaceMode !== 'chat') setWorkspaceMode('chat');
  renderPendingArea([...draftActions, ...actions], {
    onConfirm: confirmPending,
    onConfirmAll: confirmAllPending,
    onDismiss: async (id) => {
      if (id.startsWith('chat_approval_')) {
        const draft = drafts.find(item => item.id === id);
        if (draft?.operationId) {
          await recordAction({
            sessionId: draft.sessionId || s.id, turnId: draft.operationId.split(':')[0],
            operationId: draft.operationId, kind: draft.tool, args: draft.args,
            status: 'cancelled', detail: '用户取消待保存草稿',
          });
        }
        await removeChatWrites([id]);
      }
      else {
        const action = actions.find(item => item.id === id);
        if (action?.operationId) {
          await recordAction({
            sessionId: action.sessionId || s.id, turnId: action.operationId.split(':')[0],
            operationId: action.operationId, kind: action.tool, args: action.args,
            status: 'cancelled', detail: '用户取消待确认操作',
          });
        }
        await removePending(id);
      }
      await refreshPending();
    },
  });
  if ([...drafts, ...actions].some(item => !previousIds.has(item.id))) chat.revealPending();
}

let confirmingAllPending = false;

/** Execute a snapshot serially so IndexedDB writes and panel refreshes do not race. */
async function confirmAllPending() {
  if (confirmingAllPending) return;
  confirmingAllPending = true;
  try {
    const s = await ensureSession();
    const [actions, drafts] = await Promise.all([listPending(s.id), listChatWrites(s.id)]);
    const ids = [...drafts.map(item => item.id), ...actions.map(item => item.id)];
    for (const id of ids) await confirmPending(id);
    await refreshPending();
  } finally {
    confirmingAllPending = false;
  }
}

function describeChatDraft(item) {
  const args = item.args || {};
  if (item.tool === 'save_memory') return args.text || '长期记忆草稿';
  if (item.tool === 'save_task') {
    const categories = { important: '任务', chore: '杂事' };
    return [
      args.title || '新任务',
      `分类：${categories[args.category] || args.category || '任务'}`,
      args.dueAt && `日期：${args.dueAt}`,
      args.plannedStart && `执行时间：${args.plannedStart}`,
      args.estimateMin != null && args.estimateMin !== '' && `预计耗时：${args.estimateMin} 分钟`,
      args.dateMode === 'unscheduled' && '日期：不记录',
    ].filter(Boolean).join(' · ');
  }
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
      const out = await executeTool(item.tool, item.args, {
        confirmed: true, sessionId: item.sessionId || s.id, operationId: item.operationId || '',
      });
      if (item.operationId) {
        await recordAction({
          sessionId: item.sessionId || s.id, turnId: item.operationId.split(':')[0],
          operationId: item.operationId, kind: item.tool, args: item.args,
          status: out.status || (out.error ? 'failed' : 'succeeded'),
          detail: out.content || '', entity: out.entity || null,
        });
      }
      if (out.error) throw new Error(out.content || '保存失败');
      if (item.tool === 'update_profile' && aboutInterview.active) setAboutInterviewActive(false);
      await removeChatWrites([pendingId]);
      // Keep detailed tool output in the ledger, and keep the chat receipt concise.
      await addMessage({ sessionId: item.sessionId || s.id, role: 'assistant', content: '用户已确认，任务已保存。' });
      toast('已保存', 'ok');
      await refreshChat();
      await refreshAll();
      if (out.openPanel) await switchPanel(out.openPanel);
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
      operationId: item.operationId || '',
    });
    if (item.operationId) {
      await recordAction({
        sessionId: item.sessionId || '', turnId: item.operationId.split(':')[0],
        operationId: item.operationId, kind: item.tool, args: item.args,
        status: out.status || (out.error ? 'failed' : 'succeeded'),
        detail: out.content || '', entity: out.entity || null,
      });
    }
    await removePending(pendingId);
    markPendingDone(pendingId, out.error ? '执行失败' : (out.summary || item.label));
    toast(out.error ? `执行失败：${out.content}` : (out.summary || '已执行'),
      out.error ? 'err' : 'ok');

    await refreshAll();                       // 计时条、面板都跟着更新
    if (out.openPanel) await switchPanel(out.openPanel);
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

async function handleEvent(e) {
  switch (e.type) {
    case 'delta': chat.appendDelta(e.text); break;
    case 'reasoning': chat.appendReasoning(e.text); break;
    case 'tool_start': chat.toolStart(e.name, e.args); break;
    case 'tool_result':
      chat.toolResult(e.name, e.ok, e.summary, e.pending);
      // 有些工具（比如更新档案）会带回一句给用户看的回执 ——
      // 否则他说完"叫我小明"，只能自己翻面板确认到底存没存上
      if (e.toast) toast(e.toast, e.ok === false ? 'err' : 'ok');
      if (e.name === 'update_profile' && e.confirmed) setAboutInterviewActive(false);
      break;
    case 'pending': return refreshPending();
    // 模型可以帮用户切到相关面板（工具层返回 openPanel，不直接碰 DOM）
    case 'open_panel': switchPanel(e.panel); break;
    case 'notice': chat.notice(e.text); break;
    case 'aborted': chat.notice('已中断'); break;
    case 'error':
      turnErrorRendered = true;
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

  const endingAboutInterview = aboutInterview.active
    && /^(?:暂停|先暂停|暂停关于我|结束关于我|完成关于我|结束访谈|完成访谈|先到这里)(?:访谈)?[。.!！?？]*$/i.test(content);
  if (endingAboutInterview) {
    setAboutInterviewActive(false);
  }

  const settings = loadSettings();
  if (!workerConfigured() && !settings.apiKey) {
    toast('还没填 API Key，先打开设置填一下', 'err');
    await openSettings({ onChange: refreshAll, profile });
    return;
  }

  /* 1) 意图识别（零 token） */
  const intent = detectIntent(content);
  let codeNote = '';
  if (aboutInterview.active || endingAboutInterview) {
    codeNote = '【聊聊我访谈状态】正在逐题建立学习档案。先用 get_profile 查看已有资料，并结合本次访谈历史检查哪些内容还没问清：学习背景和当前进度、学习目标、当前重点、适合的学习方式与节奏、可用时间、现实限制，以及拖延情境中的触发因素/通常反应/什么帮助有效。每轮只问一个具体问题，不要把多个子问题塞在同一轮；跳过已有信息。用户表示现在做不了、想暂停或不想回答时直接接受，不要求解释或证明。不要询问 ADHD 或任何诊断状态。访谈中先将回答保留在对话上下文，不要每答一题就调用 update_profile；用户要求结束或上述内容已充分覆盖后，整理明确的信息调用 update_profile 生成待确认草稿，并让用户核对。确认前不能说已保存。';
  }

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
  turnErrorRendered = false;

  chat.appendUser(content, profile);
  chat.startAssistant(profile);

  try {
    await runTurn({
      userText: content,
      codeNote,
      profileInterview: aboutInterview.active || endingAboutInterview,
      model: null,
      signal: controller.signal,
      onEvent: handleEvent,
    });
  } catch (e) {
    if (e?.name === 'AbortError') chat.notice('已中断');
    else {
      console.error('[send]', e);
      if (!turnErrorRendered) {
        chat.fail(e?.message || String(e), { raw: e?.raw || '', kind: e?.kind || '', status: e?.status ?? null });
      }
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
  onTaskDateChanged: () => renderChrome(),
  onToggleTask: async (id, completed) => {
    await setTaskCompletion(id, completed);
    await refreshAll();
  },
  onOpenTopic: id => openTopic(id, { onChanged: refreshAll }),
  onPickKey: () => openKeyTasks({ onChanged: refreshAll }),
  onReview: () => openReview({ onChanged: refreshAll }),
  onOpenPlan: id => openPlan(id, { onChanged: refreshAll }),
  onNewPlan: () => openPlan(null, { onChanged: refreshAll }),
  onTogglePlanTask: async (planId, stageId, taskId, allocatedMin = null, checked = true, generated = false) => {
    let updated;
    if (allocatedMin === null || !generated) {
      updated = await togglePlanTask(planId, stageId, taskId);
    } else {
      const planBefore = await getPlan(planId);
      const stageBefore = planBefore ? planStages(planBefore).find(item => item.id === stageId) : null;
      const taskBefore = stageBefore?.tasks.find(item => item.id === taskId);
      const marker = `plan:${planId}:${stageId}:${taskId}`;
      const existing = (await listTasks()).find(item => item.notes === marker && item.dueAt === dateStr() && item.state !== 'CANCELLED');
      if (taskBefore && checked && !existing) {
        await upsertTask({ title: taskBefore.text, category: 'important', dueAt: dateStr(), estimateMin: allocatedMin, area: 'study', notes: marker });
      } else if (!checked && existing) {
        await deleteTask(existing.id);
      }
      updated = planBefore;
    }
    planScheduleResult = { ...schedulePlanTasks(updated, planScheduleBudget * 60), planId, planUpdatedAt: updated.updatedAt };
    const stage = planStages(updated).find(item => item.id === stageId);
    if (stage?.status === 'done') {
      const ordered = planStages(updated);
      const next = ordered[ordered.findIndex(item => item.id === stageId) + 1];
      if (next && window.confirm(`本阶段任务已完成。要切换到下一阶段「${next.name}」吗？`)) {
        await activatePlanStage(planId, next.id);
      }
    }
    await refreshAll();
  },
  onMovePlanStage: async (planId, stageId, offset) => { await movePlanStage(planId, stageId, offset); await refreshAll(); },
  onActivatePlanStage: async (planId, stageId) => { await activatePlanStage(planId, stageId); await refreshAll(); },
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

  input.placeholder = '说点什么…';
  input.setAttribute('enterkeyhint', 'enter');
  const updateKeyboardHint = () => {
    input.title = window.innerWidth <= 840
      ? '换行键输入新行，点击发送按钮发送'
      : 'Enter 发送，Ctrl+Enter 换行';
  };
  updateKeyboardHint();
  window.addEventListener('resize', updateKeyboardHint);
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;

    if (window.innerWidth <= 840 || e.ctrlKey) {
      e.preventDefault();
      input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    e.preventDefault();
    form.requestSubmit();
  });

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
    setNavigationCollapsed(!uiState.navCollapsed);
  };
  $('#nav-backdrop').onclick = () => setNavigationCollapsed(true);
  $('#btn-about-me').onclick = async () => {
    if (busy) { toast('等当前对话说完再开始访谈', 'warn'); return; }
    setWorkspaceMode('chat');
    const prompt = aboutInterview.active
      ? '继续“聊聊我”学习档案访谈。请根据已有档案和访谈对话，只问下一个最重要的问题；一次只问一个，允许我跳过、暂停或结束。不要重复已经回答过的问题。'
      : '开始“聊聊我”学习档案访谈。先读取已有档案，再逐题了解我的学习背景和当前进度、目标、当前重点、适合的学习方式与节奏、可用时间、现实限制，以及拖延情境里的触发因素、我通常怎么做、什么支持有效。每次只问一个具体问题，不重复已有信息；允许我跳过、暂停或结束。不要询问 ADHD 或诊断状态。信息已覆盖或我提出结束后，整理完整档案草稿给我核对，得到确认后再保存。';
    setAboutInterviewActive(true);

    // “聊聊我”使用独立会话，避免把档案访谈混进日常对话。
    // 没有 API Key 时先沿用 send() 的设置提示，不额外创建空会话。
    if (!workerConfigured() && !loadSettings().apiKey) {
      await send(prompt);
      return;
    }
    await createSession('聊聊我');
    await refreshChat();
    await refreshPending();
    await send(prompt);
  };
  const exportMarkdown = async () => {
    const md = await downloadMarkdownExport({});
    toast(`已导出 Markdown（${markdownStats(md).lines} 行）`, 'ok');
  };
  $('#btn-settings').onclick = () => openSettings({
    onChange: refreshAll,
    profile,
    onBackup: () => openBackup({ onChanged: refreshAll }),
    onExport: exportMarkdown,
  });

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

  /* 面板可独立收起 */
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

window.addEventListener('resize', () => {
  updateAboutButton();
  updateNavigationBackdrop();
});

/* ══════════════ 启动 ══════════════ */

async function boot() {
  loadUiState();
  await cleanupOldCompletedTasks();
  pruneMicroHabitHistory();
  // 每次打开应用先进入任务页；用户仍可从导航进入 AI 对话。
  showPanel('tasks');
  workspaceMode = 'content';
  applyUiState();
  wireComposer();
  wireTopbar();
  setBusy(false);
  setupResizer('#resize-panel', 'panel');

  profile = await getProfile();
  $('#brand-name').textContent = profile.supervisorName || '帕尼尼';

  profile = await getProfile();
  $('#brand-name').textContent = profile.supervisorName || '帕尼尼';

  await ensureSession();
  await refreshAll();
  await refreshChat();

  // Render browser data first; account checks and cloud merges continue in the background.
  void initDailyReviewSync(() => { void refreshAll(); })
    .then(() => refreshAll())
    .catch(error => console.warn('[daily-review-sync]', error));
  void initTaskSync(() => { void refreshAll(); })
    .catch(error => console.warn('[task-sync-init]', error))
    .finally(() => { void refreshAll(); });
  void initPrivateSync(() => { void refreshAll(); })
    .then(() => refreshAll())
    .catch(error => console.warn('[private-sync-init]', error));

  // 镜像权限：浏览器每次重开页面都会重置
  try {
    const st = await getMirrorState();
    if (st.enabled && !st.granted) toast('自动镜像需要重新授权：打开「备份」点一下即可', 'warn');
  } catch (e) {
    console.warn('[mirror]', e);
  }

  // 没有 Key 时不再每次启动强制弹出设置；发送消息时会按需打开。
  if ((workerConfigured() || loadSettings().apiKey) && !profile.onboardedAt) {
    // §4：初始化没完成就提示开始
    toast('学习档案还未整理。点击「聊聊我」开始逐题访谈。');
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
