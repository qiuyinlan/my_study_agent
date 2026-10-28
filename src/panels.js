// ── 面板：今日 / 记录 / 任务 / 打卡 / 积分 / 规划 / SOP / 复盘 / 档案 ──
//
// 每个面板一个 async 渲染函数，写进对应的 #view-* 容器。
// 所有数据都从数据库现读，不用缓存 —— 打开就是最新的。

import { $, $$, esc, toast, stateBadge, priorityBadge, masteryDots, fmtMin, icon } from './ui.js';
import {
  db, listTasks, listTopics, getProfile, profileCompletion,
  PRIORITIES, AREAS, DEFAULT_PROFILE,
  getMeta,
} from './db.js';
import { dueTopics } from './srs.js';
import { getLedger, listRewards, listPoints, POINT_RULES } from './ledger.js';
import { listCheckins, listReviews, patternStats, PROCRASTINATION_PATTERNS, isMedsEnabled, setMedsEnabled, effectiveStrategies } from './records.js';
import { listPlans, listSops, PLAN_STATUSES, PLAN_STAGE_STATUSES, planStages, getActivePlan, setActivePlan, schedulePlanTasks } from './docs.js';
import { estimationStats, listTimeEntries } from './timer.js';
import * as daylog from './daylog.js';
import { renderMicroHabit, getHabitSnapshot } from './microhabit.js';
import { renderDailyReview } from './dailyReview.js';
import {
  DAILY_LABELS, DAILY_SLOTS, getExactAlarmPermission, getNotificationPermission, getNotificationSettings,
  isNativeNotifications, notificationCounts, requestExactAlarmPermission, requestNotificationPermission,
  saveNotificationSettings, sendTestNotification,
} from './notifications.js';
import { renderLifeNav } from './life.js';
import {
  endOfToday, fmtDateTime, daysUntil, humanDue, dateStr,
  addDays, humanDate, hhmm, fmtMinutes,
} from './util.js';

/** 导航项的 id 同时就是图标名（见 ui.js 的 ICON_PATHS） */
export const PANELS = [
  { id: 'chat', title: 'AI 对话' },
  { id: 'tasks', title: '任务' },
  { id: 'today', title: '复盘' },
  { id: 'learning', title: '学习' },
  { id: 'records', title: '日志' },
  { id: 'life', title: '生活导航' },
  { id: 'notifications', title: '通知' },
];

const PANEL_META = [
  ...PANELS,
  { id: 'checkin', title: '打卡' },
  { id: 'points', title: '积分' },
  { id: 'plans', title: '计划' },
  { id: 'sops', title: 'SOP' },
  { id: 'reviews', title: '复盘' },
  { id: 'profile', title: '学习档案' },
];

let planScheduleBudget = 3;
let planScheduleResult = null;

export function renderHabits(s, h) {
  const el = $('#view-habits');
  if (!el) return;
  renderMicroHabit(el, { onChanged: h?.onMicroHabitChanged });
}

export function renderLife(s, h) {
  const el = $('#view-life');
  if (!el) return;
  renderLifeNav(el, { onChanged: h?.onLifeChanged, activeKind: el.dataset.lifeActive || null });
}

export function renderLearning(s, h) {
  const el = $('#view-learning');
  if (!el) return;
  const activeTasks = s.active || [];
  const important = activeTasks.filter(t => (t.category || (['P0', 'P1'].includes(t.priority) ? 'important' : 'chore')) === 'important').length;
  const chores = activeTasks.length - important;
  const habitSnapshot = getHabitSnapshot();
  const habits = Math.max(0, habitSnapshot.active.length - habitSnapshot.done.length);
  const active = `${important}|${chores}|${habits}`;
  const done = s.doneToday?.length || 0;
  const trackedMinutes = Math.max(0, Number(s.trackedMinutes) || 0);
  const focusDuration = fmtFocusDuration(trackedMinutes);
  el.innerHTML = `<div class="learning-workspace">
    <section class="learning-hero">
      <div><span class="habit-kicker">STUDY WORKSPACE</span><h3>学习</h3><p>任务负责推进，规划负责拆解，日志记录每天实际学了什么。</p></div>
      <div class="learning-stats"><strong>${done}<small> 完成</small></strong><span>主要任务 | 杂事 | 微习惯：${active}</span><strong class="learning-focus">${focusDuration}<small> 今日专注</small></strong></div>
    </section>
    <section class="learning-group"><h4>推进学习</h4><div class="learning-cards">
      <button class="learning-card primary-card" data-learning-panel="tasks"><span class="learning-card-top"><strong>任务</strong><b>${active}</b></span><small>主要任务 | 杂事 | 微习惯</small></button>
      <button class="learning-card" data-learning-panel="plans"><span class="learning-card-top"><strong>规划</strong><b>›</b></span><small>把较大的目标拆成阶段和行动步骤</small></button>
    </div></section>
    <section class="learning-group"><h4>记录与回顾</h4><div class="learning-cards">
      <button class="learning-card" data-learning-panel="records"><span class="learning-card-top"><strong>日志</strong><b>›</b></span><small>按日期查看和补记学习时长、内容与卡点</small></button>
      <button class="learning-card" data-learning-panel="reviews"><span class="learning-card-top"><strong>复盘</strong><b>›</b></span><small>回看学习中的反复阻碍和有效策略</small></button>
    </div></section>
    <section class="learning-group"><h4>积累</h4><div class="learning-cards">
      <button class="learning-card" data-learning-panel="points"><span class="learning-card-top"><strong>积分与奖励</strong><b>›</b></span><small>查看学习积分和已设置的奖励</small></button>
      <button class="learning-card" data-learning-panel="profile"><span class="learning-card-top"><strong>学习档案</strong><b>›</b></span><small>维护学习偏好、目标和监督方式</small></button>
    </div></section>
  </div>`;
  el.querySelectorAll('[data-learning-panel]').forEach(node => {
    node.addEventListener('click', () => h?.onNavigate?.(node.dataset.learningPanel));
  });
}

let currentPanel = 'today';

export const getCurrentPanel = () => currentPanel;

export function showPanel(id) {
  if (!PANEL_META.some(p => p.id === id)) return;
  currentPanel = id;
  $$('.panel-view').forEach(view => view.classList.toggle('active', view.id === `view-${id}`));
  const meta = PANEL_META.find(p => p.id === id);
  $('#panel-title').textContent = meta?.title || id;
}

export function setPanelSub(text) {
  const el = $('#panel-sub');
  if (el) el.textContent = text || '';
}

/* ══════════════ 今日 ══════════════ */

export async function renderToday(s, cards, plan, h) {
  const el = $('#view-today');
  if (!el) return;
  const out = [];

  /* 今日计划（模型写入的） */
  if (plan?.date === s.today && plan.items?.length) {
    out.push(`<div class="card ok">
      <div class="card-title">今日计划</div>
      <div class="card-sub">${plan.items.map((x, i) => `${i + 1}. ${esc(x)}`).join('<br>')}</div>
    </div>`);
  }

  /* 关键任务 */
  if (s.keyTaskIds.length) {
    const done = s.keyTasks.filter(t => t.state === 'DONE').length;
    out.push(`<div class="card ${done === s.keyTasks.length ? 'ok' : 'info'}">
      <div class="card-title">今日关键任务 ${done}/${s.keyTasks.length}</div>
      <div class="card-sub">${s.keyTasks.map(t =>
        `${t.state === 'DONE' ? '✓' : '·'} ${esc(t.title)}`).join('<br>')}</div>
    </div>`);
  } else if (s.active.length) {
    out.push(`<div class="card warn clickable" data-act="pick_key">
      <div class="card-title">今天还没挑关键任务</div>
      <div class="card-sub">进行中有 ${s.active.length} 个，但今天只该挑 1-3 个 → 点这里选</div>
    </div>`);
  }

  /* 提醒卡 */
  for (const c of cards) {
    const attrs = c.action ? ` data-act="${c.action}" data-payload="${esc(c.payload || '')}"` : '';
    out.push(`<div class="card ${c.level}${c.action ? ' clickable' : ''}"${attrs}>
      <div class="card-title">${esc(c.title)}</div>
      <div class="card-sub">${esc(c.sub)}</div>
    </div>`);
  }

  /* 今日动态 —— 让对话产生的结果在这里看得见，并且点一下就能改 */
  if (s.todayActivity?.length) {
    const editable = a => (a.kind === 'time' || a.kind === 'log') && a.id;
    out.push(`<div class="group-head">今日动态 <span class="n">${s.todayActivity.length}</span></div>`);
    out.push(`<div class="timeline">${s.todayActivity.map(a => `
      <div class="tl-item tl-${a.kind}${editable(a) ? ' tl-clickable' : ''}"
        ${editable(a) ? `data-act="${a.kind === 'time' ? 'edit_time' : 'edit_log'}" data-payload="${esc(a.id)}"` : ''}
        ${a.kind === 'done' && a.id ? `data-act="open_task" data-payload="${esc(a.id)}"` : ''}>
        <span class="tl-dot"></span>
        <span class="tl-body">
          <span class="tl-text">${esc(a.text)}</span>
          ${a.sub ? `<span class="tl-sub">${esc(a.sub)}</span>` : ''}
        </span>
      </div>`).join('')}</div>`);
  } else if (s.tasks.length) {
    out.push(`<div class="group-head">今日动态</div>
      <div class="empty">今天还没有任何记录。跟帕尼尼说一句「我做完了什么」，它会记下来。</div>`);
  }

  /* 预估能力 —— 让用户看见自己的时间感知偏差 */
  if (s.estimation?.established) {
    out.push(`<div class="card info">
      <div class="card-title">时间感知</div>
      <div class="card-sub">${esc(s.estimation.verdict)}（${s.estimation.samples} 个样本）</div>
    </div>`);
  }

  el.innerHTML = out.join('');
  const reviewRoot = document.createElement('div');
  reviewRoot.className = 'today-review-root';
  el.append(reviewRoot);
  await renderDailyReview(reviewRoot);
  el.querySelectorAll('[data-act]').forEach(node => {
    node.onclick = () => {
      const act = node.dataset.act;
      const payload = node.dataset.payload;
      if (act === 'review') h.onReview?.();
      else if (act === 'task') h.onOpenTask?.(payload);
      else if (act === 'pick_key') h.onPickKey?.();
      else if (act === 'plan') h.onOpenPlan?.(payload);
      else if (act === 'timer') h.onTimerDetail?.();
      // 今日动态里的条目点开就能改
      else if (act === 'edit_time') h.onEditTimeEntry?.(payload);
      else if (act === 'edit_log') h.onEditLog?.(payload);
      else if (act === 'open_task') h.onOpenTask?.(payload);
    };
  });
}

/* ══════════════ 记录（任意一天的专注明细，可编辑）══════════════ */

let recordsDate = null;
let recordsCtx = null;

/** 外部想跳到某天时用 */
export async function setRecordsDate(date) {
  recordsDate = date;
  if (recordsCtx) await renderRecords(recordsCtx.s, recordsCtx.h);
}

async function gotoDate({ shift = 0, absolute = null } = {}) {
  recordsDate = absolute || addDays(recordsDate || dateStr(), shift);
  if (recordsCtx) await renderRecords(recordsCtx.s, recordsCtx.h);
}

export async function renderRecords(s, h) {
  const el = $('#view-records');
  if (!el) return;
  recordsCtx = { s, h };

  // 第一次打开时跳到最近有记录的那天，比永远显示今天更实用
  if (!recordsDate) recordsDate = (await daylog.latestRecordDate()) || dateStr();
  const day = await daylog.daySummary(recordsDate);
  const isToday = day.date === dateStr();
  setPanelSub(isToday ? '今天' : humanDate(day.date));

  const out = [];

  /* ── 日期导航 ── */
  out.push(`<div class="day-nav">
    <button type="button" class="icon-btn" data-shift="-1" title="前一天">${icon('chevron-left')}</button>
    <input type="date" id="rec-date" value="${day.date}" aria-label="选择日期">
    <button type="button" class="icon-btn" data-shift="1" title="后一天">${icon('chevron-right')}</button>
    ${isToday ? '' : '<button type="button" class="ghost" data-today="1">回到今天</button>'}
  </div>`);

  out.push(`<div class="day-head">${esc(humanDate(day.date))}</div>`);

  /* ── 概览 ── */
  out.push(`<div class="day-stats">
    <span class="ds"><b>${day.focusedMinutes}</b> 分钟专注</span>
    <span class="ds">${day.entryCount} 段</span>
    ${day.taskIds.length ? `<span class="ds">${day.taskIds.length} 个任务</span>` : ''}
    ${day.doneTasks.length ? `<span class="ds">完成 ${day.doneTasks.length} 项</span>` : ''}
  </div>`);

  out.push(`<div class="dlg-actions" style="margin:10px 0 2px">
    <button type="button" class="ghost" id="rec-add-time">＋ 补记专注</button>
    <button type="button" class="ghost" id="rec-add-log">＋ 补记学习</button>
  </div>`);

  /* ── 专注记录（可编辑）── */
  out.push(`<div class="group-head">专注记录 <span class="n">${day.entries.length}</span></div>`);
  if (!day.entries.length) {
    out.push('<div class="empty">这天没有专注记录。<br>点上面「补记专注」，或者跟帕尼尼说「开始计时」。</div>');
  } else {
    out.push(`<div class="rec-list">${day.entries.map(e => {
      const range = (e.startedAt || e.endedAt)
        ? `${hhmm(e.startedAt) || '—'} – ${hhmm(e.endedAt) || '—'}`
        : '未记录起止时间';
      const tags = [
        `<span class="badge">${e.source === 'timer' ? '计时' : e.source === 'manual' ? '补记' : '自报'}</span>`,
      ];
      if (e.edited) tags.push('<span class="badge">已修正</span>');
      if (e.driftMin) {
        tags.push(`<span class="badge ${Math.abs(e.driftMin) >= 5 ? 'soon' : ''}">`
          + `自报差 ${e.driftMin > 0 ? '+' : ''}${e.driftMin} 分</span>`);
      }
      return `<div class="rec-item" data-time="${e.id}" title="点击编辑">
        <div class="rec-time">${esc(range)}</div>
        <div class="rec-main">
          <div class="rec-title">${esc(e.taskTitle || e.note || '（未关联任务）')}</div>
          ${e.taskTitle && e.note ? `<div class="rec-sub">${esc(e.note)}</div>` : ''}
          ${e.outcome ? `<div class="rec-sub">完成情况：${esc(e.outcome)}</div>` : ''}
          <div class="rec-tags">${tags.join('')}</div>
        </div>
        <div class="rec-min">${e.actualMin ?? '?'}<span>分钟</span></div>
        <span class="rec-edit">${icon('pencil')}</span>
      </div>`;
    }).join('')}</div>`);
  }

  /* ── 学习记录（可编辑）── */
  out.push(`<div class="group-head">学习记录 <span class="n">${day.logs.length}</span></div>`);
  if (!day.logs.length) {
    out.push('<div class="empty">这天没有学习记录。</div>');
  } else {
    out.push(`<div class="rec-list">${day.logs.map(l => `
      <div class="rec-item" data-log="${l.id}" title="点击编辑">
        <div class="rec-time">${hhmm(l.createdAt) || ''}</div>
        <div class="rec-main">
          <div class="rec-title">${esc(l.topicName || l.what || '（无标题）')}</div>
          ${l.topicName && l.what ? `<div class="rec-sub">${esc(l.what)}</div>` : ''}
          ${l.blockers ? `<div class="rec-sub">卡点：${esc(l.blockers)}</div>` : ''}
          ${l.edited ? '<div class="rec-tags"><span class="badge">已修正</span></div>' : ''}
        </div>
        <div class="rec-min">${l.minutes || 0}<span>分钟</span></div>
        <span class="rec-edit">${icon('pencil')}</span>
      </div>`).join('')}</div>`);
  }

  /* ── 那天完成的任务 ── */
  if (day.doneTasks.length) {
    out.push(`<div class="group-head">完成的任务 <span class="n">${day.doneTasks.length}</span></div>`);
    out.push(`<div class="list">${day.doneTasks.map(t => `
      <div class="task-item done" data-task="${t.id}">
        <div class="t-head"><span class="t-name">${esc(t.title)}</span>${stateBadge(t.state)}</div>
        ${t.outcome ? `<div class="t-meta">${esc(t.outcome)}</div>` : ''}
      </div>`).join('')}</div>`);
  }

  /* ── 那天的打卡 ── */
  if (day.checkin) {
    const bits = [
      day.checkin.sleepHours ? `睡眠 ${day.checkin.sleepHours} 小时` : '',
      day.checkin.mood ? `情绪 ${day.checkin.mood}/5` : '',
      day.checkin.attention ? `注意力 ${day.checkin.attention}/5` : '',
      day.checkin.topTask ? `最重要：${day.checkin.topTask}` : '',
    ].filter(Boolean);
    out.push(`<div class="group-head">打卡</div>
      <div class="card"><div class="card-sub">${bits.length ? esc(bits.join('　')) : '（这天打卡了，但字段都是空的）'}</div></div>`);
  }

  if (day.overlapNote) {
    out.push(`<div class="hint" style="margin-top:12px">${esc(day.overlapNote)}</div>`);
  }
  if (!day.entries.length && !day.logs.length && !day.doneTasks.length && !day.checkin) {
    out.push('<div class="empty" style="margin-top:12px">这天没有任何记录。</div>');
  }

  el.innerHTML = out.join('');

  /* ── 事件 ── */
  $$('[data-shift]', el).forEach(b => {
    b.onclick = () => gotoDate({ shift: Number(b.dataset.shift) });
  });
  $('[data-today]', el)?.addEventListener('click', () => gotoDate({ absolute: dateStr() }));
  $('#rec-date')?.addEventListener('change', e => gotoDate({ absolute: e.target.value }));
  $('#rec-add-time')?.addEventListener('click', () => h.onAddTimeEntry?.(day.date));
  $('#rec-add-log')?.addEventListener('click', () => h.onAddLogEntry?.(day.date));
  $$('[data-time]', el).forEach(n => { n.onclick = () => h.onEditTimeEntry?.(n.dataset.time); });
  $$('[data-log]', el).forEach(n => { n.onclick = () => h.onEditLog?.(n.dataset.log); });
  $$('[data-task]', el).forEach(n => { n.onclick = () => h.onOpenTask?.(n.dataset.task); });
}

/* ══════════════ 任务 ══════════════ */

function taskItemHtml(t) {
  const badges = [];
  badges.push(stateBadge(t.state));
  badges.push(priorityBadge(t.priority));
  if (t.dueAt) {
    const d = daysUntil(t.dueAt);
    const cls = d < 0 ? 'overdue' : d <= 3 ? 'soon' : '';
    badges.push(`<span class="badge ${cls}">${esc(humanDue(t.dueAt))}</span>`);
  }

  const meta = [];
  if (t.goal) meta.push(esc(t.goal));
  if (t.nextAction) meta.push(`下一步：${esc(t.nextAction)}`);
  if (t.blocker) meta.push(`<b style="color:var(--danger)">阻碍：${esc(t.blocker)}</b>`);

  const times = [];
  if (t.estimateMin != null) times.push(`预计 ${t.estimateMin} 分钟`);
  if (t.actualMin != null) times.push(`实际 ${t.actualMin} 分钟`);
  if (t.actualStart) times.push(`开始 ${fmtDateTime(t.actualStart)}`);

  return `<div class="task-item ${t.state === 'DONE' ? 'done' : ''}" data-task="${esc(t.id)}">
    <div class="t-head"><button type="button" class="task-check ${t.state === 'DONE' ? 'checked' : ''}" data-task-check="${esc(t.id)}" aria-label="${t.state === 'DONE' ? '标记未完成' : '标记完成'}：${esc(t.title)}" title="${t.state === 'DONE' ? '取消完成' : '点击标记完成'}" aria-pressed="${t.state === 'DONE'}">${t.state === 'DONE' ? icon('check') : ''}</button><span class="t-name">${esc(t.title)}</span>${badges.join('')}</div>
    ${meta.length ? `<div class="t-meta">${meta.join('　·　')}</div>` : ''}
    ${times.length ? `<div class="t-meta">${times.join('　·　')}</div>` : ''}
    ${t.progress ? `<div class="progress"><i style="width:${Math.min(100, t.progress)}%"></i></div>` : ''}
  </div>`;
}

let selectedTaskDate = dateStr();

function tasksForDate(tasks, date) {
  return tasks.filter(task => {
    if (task.state === 'CANCELLED') return false;
    if (task.state === 'DONE') return task.actualEnd && dateStr(new Date(task.actualEnd)) === date;
    const scheduled = (task.dueAt || task.plannedStart || '').slice(0, 10);
    return scheduled && scheduled <= date;
  });
}

function taskCategory(task) {
  return task.category || (['P0', 'P1'].includes(task.priority) ? 'important' : 'chore');
}

function taskDateForStrip(task) {
  if (!task || task.state === 'CANCELLED') return '';
  if (task.state === 'DONE') return task.actualEnd ? dateStr(new Date(task.actualEnd)) : '';
  return (task.dueAt || task.plannedStart || '').slice(0, 10);
}

export function renderTasks(s, h) {
  const el = $('#view-tasks');
  if (!el) return;
  const dayTasks = tasksForDate(s.tasks, selectedTaskDate);
  const out = ['<div class="tasks-workspace">'];
  const week = Array.from({ length: 7 }, (_, index) => addDays(selectedTaskDate, index - 2));
  const shortDays = ['日', '一', '二', '三', '四', '五', '六'];
  const dateCount = date => s.tasks.filter(task => taskDateForStrip(task) === date).length;
  out.push(`<div class="task-date-head"><strong>任务日期</strong><div class="task-date-actions"><button type="button" class="task-record-done" data-record-done>＋ 记录完成</button><label class="task-calendar" title="选择具体日期">${icon('today')}<input type="date" value="${selectedTaskDate}" data-task-date-picker aria-label="选择任务日期"></label></div></div>`);
  out.push(`<nav class="task-date-strip" aria-label="任务日期">${week.map(date => {
    const d = new Date(`${date}T00:00:00`);
    const today = date === dateStr();
    return `<button type="button" class="task-date ${today ? 'today' : ''} ${date === selectedTaskDate ? 'selected' : ''}" data-task-date="${date}" aria-pressed="${date === selectedTaskDate}"><small>${today ? '今天' : `周${shortDays[d.getDay()]}`}</small><strong>${Number(date.slice(-2))}</strong><i>${dateCount(date)} 项</i></button>`;
  }).join('')}</nav>`);
  const unplanned = s.tasks.filter(task => !['DONE', 'CANCELLED'].includes(task.state) && !task.dueAt && !task.plannedStart);
  const visibleTasks = [...new Map([...dayTasks, ...unplanned].map(task => [task.id, task])).values()]
    .sort((a, b) => {
      const dateA = (a.dueAt || a.plannedStart || '').slice(0, 10);
      const dateB = (b.dueAt || b.plannedStart || '').slice(0, 10);
      if (!dateA) return dateB ? 1 : 0;
      if (!dateB) return -1;
      return dateB.localeCompare(dateA);
    });
  const openTasks = visibleTasks.filter(task => task.state !== 'DONE');
  const doneTasks = visibleTasks.filter(task => task.state === 'DONE');
  const renderTaskGroup = (category, title) => {
    const tasks = openTasks.filter(task => taskCategory(task) === category);
    out.push(`<section class="task-category"><div class="group-head">${title}</div>`);
    out.push(tasks.length
      ? `<div class="list task-list-${category}">${tasks.map(task => taskItemHtml(task)).join('')}</div>`
      : '<div class="empty">暂无任务</div>');
    out.push('</section>');
  };
  renderTaskGroup('important', '主要任务');
  renderTaskGroup('chore', '杂事');
  out.push(`<section class="task-category task-done-list"><div class="group-head">已完成 <span class="n">${doneTasks.length}</span></div>`);
  out.push(doneTasks.length
    ? `<div class="list">${doneTasks.map(task => taskItemHtml(task)).join('')}</div>`
    : '<div class="empty">所选日期还没有完成记录</div>');
  out.push('</section>');

  /* 知识点放在任务面板底部，作为学习模块的一部分 */
  if (s.topics.length) {
    out.push('<div class="group-head">知识点 <span class="n">' + s.topics.length + '</span></div>');
    out.push(`<div class="list">${s.topics.slice(0, 20).map(t => `
      <div class="task-item" data-topic="${t.id}" style="padding:7px 10px">
        <div class="t-head">${masteryDots(t.mastery)}<span class="t-name" style="font-weight:500">${esc(t.name)}</span></div>
        <div class="t-meta">掌握度 ${t.mastery ?? 0}/5　复习 ${t.reps || 0} 次　下次 ${(t.nextReviewAt || '').slice(0, 10) || '—'}</div>
      </div>`).join('')}</div>`);
  }
  out.push('<section class="task-category task-microhabits"><div class="group-head">微习惯任务 <span class="n">每天</span></div><div data-task-microhabits></div></section>');
  out.push('<button type="button" class="habit-add-fab task-add-fab" data-new-task aria-label="添加任务" title="添加任务">＋</button>');
  out.push('</div>');
  el.innerHTML = out.join('');
  const strip = el.querySelector('.task-date-strip');
  if (strip) {
    const nav = document.createElement('div');
    nav.className = 'task-date-nav';
    const makeShiftButton = (shift, label, name) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn';
      button.dataset.taskDateShift = String(shift);
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = icon(name);
      return button;
    };
    const previous = makeShiftButton(-1, '前一天', 'chevron-left');
    const next = makeShiftButton(1, '后一天', 'chevron-right');
    strip.replaceWith(nav);
    nav.append(previous, strip, next);
  }
  renderMicroHabit(el.querySelector('[data-task-microhabits]'), {
    onChanged: h?.onMicroHabitChanged,
    showAddButton: false,
    date: selectedTaskDate,
  });
  el.querySelector('[data-new-task]')?.addEventListener('click', () => h.onNewTask?.());
  el.querySelector('[data-record-done]')?.addEventListener('click', () => h.onRecordDone?.(selectedTaskDate));
  el.querySelectorAll('[data-task-date]').forEach(button => button.addEventListener('click', () => {
    selectedTaskDate = button.dataset.taskDate;
    renderTasks(s, h);
    h.onTaskDateChanged?.();
  }));
  el.querySelector('[data-task-date-picker]')?.addEventListener('change', event => {
    if (!event.target.value) return;
    selectedTaskDate = event.target.value;
    renderTasks(s, h);
    h.onTaskDateChanged?.();
  });
  el.querySelectorAll('[data-task-date-shift]').forEach(button => button.addEventListener('click', () => {
    selectedTaskDate = addDays(selectedTaskDate, Number(button.dataset.taskDateShift));
    renderTasks(s, h);
    h.onTaskDateChanged?.();
  }));
  el.querySelectorAll('[data-task-check]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    h.onToggleTask?.(button.dataset.taskCheck, button.getAttribute('aria-pressed') !== 'true');
  }));
  $$('[data-task]', el).forEach(n => { n.onclick = event => {
    if (event.target.closest('[data-task-check]')) return;
    h.onOpenTask?.(n.dataset.task);
  }; });
  $$('[data-topic]', el).forEach(n => { n.onclick = () => h.onOpenTopic?.(n.dataset.topic); });
}

if (typeof window !== 'undefined') {
}

/* ══════════════ 打卡 ══════════════ */

const SCALE_LABEL = ['很差', '较差', '一般', '不错', '很好'];

function scaleHtml(field, value) {
  return `<div class="scale" data-scale="${field}">
    ${[1, 2, 3, 4, 5].map(n =>
      `<button type="button" data-v="${n}" class="${value === n ? 'on' : ''}" title="${SCALE_LABEL[n - 1]}">${n}</button>`).join('')}
  </div>`;
}

export async function renderCheckin(s, h) {
  const el = $('#view-checkin');
  if (!el) return;
  const c = s.checkin || {};
  const meds = s.medsEnabled;

  el.innerHTML = `
    <div class="section-title">今天（${s.today}）</div>

    <div class="form-grid">
      <div class="field"><label>睡眠时长（小时）</label>
        <input type="number" id="ck-sleep" step="0.5" min="0" max="24" value="${c.sleepHours ?? ''}"></div>
      <div class="field"><label>起床时间</label>
        <input type="time" id="ck-wake" value="${esc(c.wakeAt || '')}"></div>
    </div>

    <div class="field" style="margin-top:12px"><label>精力</label>${scaleHtml('energy', c.energy)}</div>
    <div class="field" style="margin-top:10px"><label>情绪</label>${scaleHtml('mood', c.mood)}</div>
    <div class="field" style="margin-top:10px"><label>注意力</label>${scaleHtml('attention', c.attention)}</div>

    <div class="form-grid" style="margin-top:12px">
      <div class="field"><label>饮水（杯）</label>
        <input type="number" id="ck-water" min="0" step="1" value="${c.water ?? ''}"></div>
      <div class="field"><label>学习（分钟）</label>
        <input type="number" id="ck-study" min="0" step="10" value="${c.studyMin ?? ''}"></div>
    </div>

    <div class="field" style="margin-top:12px"><label>饮食</label>
      <input type="text" id="ck-meals" value="${esc(c.meals || '')}" placeholder="吃了什么"></div>
    <div class="field" style="margin-top:10px"><label>运动</label>
      <input type="text" id="ck-exercise" value="${esc(c.exercise || '')}" placeholder="做了什么运动"></div>

    <div class="field" style="margin-top:12px">
      <label class="row-inline"><input type="checkbox" id="ck-washed" ${c.washed ? 'checked' : ''}> 已洗漱</label>
    </div>

    ${meds ? `<div class="field" style="margin-top:12px"><label>服药（仅作记录，不构成医疗建议）</label>
      <input type="text" id="ck-meds" value="${esc(c.meds || '')}" placeholder="按你自己的方式记"></div>` : ''}

    <div class="section-title">今天的关键信息</div>
    <div class="field"><label>今日最重要的任务</label>
      <input type="text" id="ck-top" value="${esc(c.topTask || '')}"></div>
    <div class="field" style="margin-top:10px"><label>当前最大阻碍</label>
      <input type="text" id="ck-blocker" value="${esc(c.blocker || '')}"></div>
    <div class="field" style="margin-top:10px"><label>今日已完成</label>
      <textarea id="ck-done" rows="2">${esc(c.doneToday || '')}</textarea></div>
    <div class="field" style="margin-top:10px"><label>下一步行动</label>
      <input type="text" id="ck-next" value="${esc(c.nextAction || '')}"></div>
    <div class="field" style="margin-top:10px"><label>备注</label>
      <textarea id="ck-note" rows="2">${esc(c.note || '')}</textarea></div>

    <div class="dlg-actions" style="margin-top:14px">
      <button class="primary" id="ck-save">保存打卡</button>
      <button class="ghost" id="ck-meds-toggle">${meds ? '关闭服药字段' : '开启服药字段'}</button>
    </div>
    <div class="hint" style="margin-top:8px">任何一项都可以跳过。跳过不会被记为失败。</div>

    <div class="section-title">近期趋势</div>
    <div id="ck-trend" class="hint">加载中…</div>`;

  /* 量表交互 */
  $$('[data-scale]', el).forEach(group => {
    group.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        group.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      };
    });
  });

  $('#ck-save').onclick = async () => {
    const val = id => $(id)?.value;
    const numOrNull = v => (v === '' || v === undefined ? null : Number(v));
    const scaleOf = field =>
      Number($(`[data-scale="${field}"] .on`)?.dataset.v) || null;

    await h.onCheckinSave?.({
      sleepHours: numOrNull(val('#ck-sleep')),
      wakeAt: val('#ck-wake') || '',
      energy: scaleOf('energy'),
      mood: scaleOf('mood'),
      attention: scaleOf('attention'),
      water: numOrNull(val('#ck-water')),
      studyMin: numOrNull(val('#ck-study')),
      meals: val('#ck-meals') || '',
      exercise: val('#ck-exercise') || '',
      washed: $('#ck-washed')?.checked ?? null,
      meds: meds ? (val('#ck-meds') || '') : undefined,
      topTask: val('#ck-top') || '',
      blocker: val('#ck-blocker') || '',
      doneToday: val('#ck-done') || '',
      nextAction: val('#ck-next') || '',
      note: val('#ck-note') || '',
    });
  };

  $('#ck-meds-toggle').onclick = async () => {
    await h.onMedsToggle?.(!meds);
  };

  /* 趋势 */
  const list = await listCheckins(14);
  const trend = $('#ck-trend');
  if (!list.length) {
    trend.textContent = '还没有历史打卡记录。';
  } else {
    const avg = k => {
      const v = list.map(x => x[k]).filter(n => typeof n === 'number' && n > 0);
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '—';
    };
    trend.innerHTML = `近 ${list.length} 天平均：睡眠 <b>${avg('sleepHours')}</b> 小时　`
      + `精力 <b>${avg('energy')}</b>　情绪 <b>${avg('mood')}</b>　注意力 <b>${avg('attention')}</b>`
      + `<br>${list.slice(0, 7).map(x => `${x.date.slice(5)}：睡眠 ${x.sleepHours ?? '—'}h　情绪 ${x.mood ?? '—'}　注意力 ${x.attention ?? '—'}`).join('<br>')}`;
  }
}

/* ══════════════ 积分 ══════════════ */

export async function renderPoints(s, h) {
  const el = $('#view-points');
  if (!el) return;
  const ledger = s.ledger;
  const rewards = await listRewards();
  setPanelSub(ledger.established ? `${ledger.total} 分` : '未建立');

  const out = [];

  if (!ledger.established) {
    out.push(`<div class="card warn">
      <div class="card-title">尚未建立积分账本</div>
      <div class="card-sub">没有任何积分记录。这不是"0 分"，是还没开始记。</div>
    </div>`);
    out.push(`<div class="section-title">§12 建议的积分规则</div>`);
    for (const r of POINT_RULES) {
      out.push(`<div class="point-row"><span class="delta plus">+${r.delta}</span><span class="reason">${esc(r.label)}</span></div>`);
    }
  } else {
    out.push(`<div class="ledger-total">
      <span class="big">${ledger.total}</span>
      <span class="lbl">累计积分<br>已确认 ${ledger.confirmedTotal}　待确认 ${ledger.pendingTotal}</span>
    </div>`);

    if (ledger.unconfirmed.length) {
      out.push(`<div class="card warn clickable" data-act="confirm-all">
        <div class="card-title">${ledger.unconfirmed.length} 笔待确认</div>
        <div class="card-sub">合计 ${ledger.pendingTotal > 0 ? '+' : ''}${ledger.pendingTotal} → 点这里全部确认</div>
      </div>`);
    }

    out.push(`<div class="section-title">流水（最近 ${Math.min(20, ledger.count)} 笔）</div>`);
    const recent = await listPoints({ limit: 20 });
    out.push(recent.map(e => `
      <div class="point-row ${e.confirmed ? '' : 'pending'}">
        <span class="delta ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+' : ''}${e.delta}</span>
        <span class="reason">${esc(e.reason)}${e.confirmed ? '' : ' <span class="badge">待确认</span>'}</span>
        <span class="when">${e.date.slice(5)}</span>
      </div>`).join(''));
  }

  out.push(`<div class="section-title">奖励兑换</div>`);
  if (!rewards.length) {
    out.push(`<div class="empty">还没有设置奖励。</div>`);
  } else {
    out.push(rewards.map(r => `
      <div class="reward-row">
        <span class="r-name">${esc(r.name)}${r.note ? `<br><span class="hint">${esc(r.note)}</span>` : ''}</span>
        <span class="r-cost">${r.cost}</span>
        <button class="mini" data-redeem="${r.id}"
          ${ledger.established && ledger.total >= r.cost ? '' : 'disabled'}>兑换</button>
      </div>`).join(''));
  }
  out.push(`<div class="dlg-actions" style="margin-top:10px">
    <button class="ghost" id="btn-new-reward">＋ 添加奖励</button>
  </div>`);

  out.push(`<div class="hint" style="margin-top:14px">
    积分只用来强化行为，不衡量你的价值。<br>
    扣分也只是一行记录 —— 系统不会、也无法封锁你的账户或设备。
  </div>`);

  el.innerHTML = out.join('');
  el.querySelector('[data-act="confirm-all"]')?.addEventListener('click', () => h.onConfirmAllPoints?.());
  $$('[data-redeem]', el).forEach(b => { b.onclick = () => h.onRedeem?.(b.dataset.redeem); });
  $('#btn-new-reward')?.addEventListener('click', () => h.onNewReward?.());
}

/* ══════════════ 规划 ══════════════ */

export async function renderPlans(s, h) {
  const el = $('#view-plans');
  if (!el) return;
  const plans = await listPlans({});
  const active = await getActivePlan();
  const selected = plans.find(plan => plan.id === active?.id) || plans[0];
  const stages = selected ? planStages(selected) : [];
  const current = selected && (selected.currentStageId
    ? stages.find(stage => stage.id === selected.currentStageId)
    : (stages.find(stage => stage.status === 'active') || stages.find(stage => stage.status !== 'done')));
  const generated = selected && planScheduleResult?.planId === selected.id
    && planScheduleResult.planUpdatedAt === selected.updatedAt ? planScheduleResult : null;
  setPanelSub(`${plans.length} 条主线`);

  const out = [`<div class="plan-workspace">
    <section class="plan-section">
      <div class="plan-section-head"><h3>主线目标池</h3><button class="ghost" id="btn-new-plan">＋ 新建主线</button></div>
      ${plans.length ? `<div class="grid2 plan-mainline-fields">
        <label>当前激活主线<select id="plan-active-select">${plans.map(plan => `<option value="${esc(plan.id)}" ${plan.id === selected?.id ? 'selected' : ''}>${esc(plan.name)}</option>`).join('')}</select></label>
        <div class="plan-mainline-meta"><strong>${esc(PLAN_STATUSES[selected?.status]?.label || '进行中')}</strong><span>目标大期限：${esc(selected?.deadline || '未设置')}</span><button class="ghost" data-plan-edit="${esc(selected.id)}">编辑主线与阶段</button></div>
      </div>` : '<div class="empty">还没有主线规划。</div>'}
    </section>
    <section class="plan-section">
      <div class="plan-section-head"><h3>阶段目标与可执行子任务</h3><span class="hint">${current ? `当前激活：${esc(current.name)}` : '选择或创建一条主线开始规划'}</span></div>
      ${stages.length ? `<ol class="plan-stage-list">${stages.map((stage, index) => {
        const doneCount = stage.tasks.filter(task => task.done).length;
        const activeStage = stage.id === current?.id;
        const dependencies = stage.dependsOn.map(id => stages.find(item => item.id === id)?.name || id).join('、');
        return `<li class="plan-stage ${activeStage ? 'is-active' : ''}" draggable="true" data-stage-card="${esc(stage.id)}">
          <div class="plan-stage-head"><div><strong>${index + 1}. ${esc(stage.name || '未命名阶段')}</strong><span class="plan-stage-state">${PLAN_STAGE_STATUSES[stage.status] || PLAN_STAGE_STATUSES[activeStage ? 'active' : 'not_started']}${activeStage ? ' · 当前阶段' : ''}</span></div>
            <div class="plan-stage-actions"><button class="icon-btn" data-stage-move="${esc(stage.id)}" data-offset="-1" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-stage-move="${esc(stage.id)}" data-offset="1" title="下移" ${index === stages.length - 1 ? 'disabled' : ''}>↓</button>${!activeStage ? `<button class="ghost" data-stage-activate="${esc(stage.id)}">设为当前</button>` : ''}</div>
          </div>
          ${dependencies ? `<div class="plan-stage-dependency">依赖：${esc(dependencies)}</div>` : ''}
          ${stage.exception ? `<div class="plan-stage-dependency">例外：${esc(stage.exception)}</div>` : ''}
          ${stage.estimate ? `<div class="plan-stage-dependency">周期：${esc(stage.estimate)}</div>` : ''}
          ${stage.risks.length ? `<div class="plan-risk">风险：${esc(stage.risks.join('、'))}</div>` : ''}
          <div class="plan-stage-tasks">${stage.tasks.length ? stage.tasks.map(task => `<label class="plan-task"><input type="checkbox" data-plan-task="${esc(task.id)}" data-stage-id="${esc(stage.id)}" ${task.done ? 'checked' : ''}><span class="${task.done ? 'is-done' : ''}">${esc(task.text)}</span>${(task.remainingMin ?? task.estMin) ? `<small>${task.remainingMin !== null && task.remainingMin !== undefined ? `剩余 ${fmtMin(task.remainingMin)}` : fmtMin(task.estMin)}</small>` : ''}<small>优先级 ${task.priority}</small></label>`).join('') : '<span class="hint">暂无子任务</span>'}</div>
          <small class="hint">${doneCount}/${stage.tasks.length} 个子任务完成</small>
        </li>`;
      }).join('')}</ol>` : '<div class="empty">还没有阶段目标。在主线编辑中添加阶段和子任务。</div>'}
    </section>
    <section class="plan-section">
      <div class="plan-section-head"><h3>今日自动规划</h3><div class="plan-schedule-controls"><label>今日可用时长（小时）<input id="plan-day-minutes" type="number" min="0.5" step="0.5" value="${planScheduleBudget}"></label><button class="primary" id="btn-generate-plan" ${!selected ? 'disabled' : ''}>重新生成</button></div></div>
      ${generated?.complete ? `<div class="plan-schedule-note">当前阶段的子任务都已完成。确认后可以切换到下一阶段。</div>` : ''}
      ${generated?.tasks?.length ? `<ul class="plan-generated-list">${generated.tasks.map(task => {
        const addedToday = s.tasks.some(item => item.notes === `plan:${selected.id}:${task.sourceStageId}:${task.id}` && item.dueAt === dateStr() && item.state !== 'CANCELLED');
        return `<li><input type="checkbox" data-plan-task="${esc(task.id)}" data-stage-id="${esc(task.sourceStageId)}" data-allocation="${task.allocatedMin}" data-plan-generated="1" ${addedToday ? 'checked' : ''} title="加入今日任务"><strong>${fmtMin(task.allocatedMin)}</strong><span>${esc(task.text)}${task.partial ? '（完成后保留剩余时长）' : ''}${task.exceptionTask ? ` · 例外提前自「${esc(task.sourceStage)}」` : ''}</span></li>`;
      }).join('')}</ul>` : (selected ? '<div class="hint">点击“重新生成”按当前阶段优先级安排今日任务。</div>' : '')}
      ${selected ? `<div class="plan-schedule-note">依据主线「${esc(selected.name)}」·${esc(generated?.stage?.name || current?.name || '当前阶段')}；规则：${esc(typeof selected.priorities === 'string' ? selected.priorities : '按子任务优先级')}。${generated?.remainingMin > 0 ? `剩余 ${fmtMin(generated.remainingMin)}。` : ''}</div>` : ''}
    </section>
    <section class="plan-section">
      <div class="plan-section-head"><h3>约束与备注</h3>${selected ? `<button class="ghost" data-plan-edit="${esc(selected.id)}">编辑规则</button>` : ''}</div>
      ${selected ? `<div class="plan-constraints-grid"><div><b>优先级规则</b><p>${esc(selected.priorities || '未设置')}</p></div><div><b>时间约束 / 特殊例外</b><p>${esc(selected.rules || selected.constraints || '未设置')}</p></div><div><b>风险点</b><p>${esc((selected.risks || []).join('、') || '未设置')}</p></div></div>` : '<div class="hint">选择一条主线后显示调度约束。</div>'}
    </section>
  </div>`];
  el.innerHTML = out.join('');
  $('#btn-new-plan')?.addEventListener('click', () => h.onNewPlan?.());
  $('#plan-active-select')?.addEventListener('change', async e => { await setActivePlan(e.target.value); planScheduleResult = null; await renderPlans(s, h); });
  $$('[data-plan-edit]', el).forEach(n => { n.onclick = () => h.onOpenPlan?.(n.dataset.planEdit); });
  $$('[data-plan-task]', el).forEach(n => { n.onchange = async () => h.onTogglePlanTask?.(selected.id, n.dataset.stageId, n.dataset.planTask, n.dataset.allocation ? Number(n.dataset.allocation) : null, n.checked, n.dataset.planGenerated === '1'); });
  $$('[data-stage-move]', el).forEach(n => { n.onclick = () => h.onMovePlanStage?.(selected.id, n.dataset.stageMove, Number(n.dataset.offset)); });
  $$('[data-stage-activate]', el).forEach(n => { n.onclick = () => h.onActivatePlanStage?.(selected.id, n.dataset.stageActivate); });
  let draggedStageId = '';
  $$('[data-stage-card]', el).forEach(card => {
    card.addEventListener('dragstart', event => {
      draggedStageId = card.dataset.stageCard;
      event.dataTransfer?.setData('text/plain', draggedStageId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', event => event.preventDefault());
    card.addEventListener('drop', async event => {
      event.preventDefault();
      const from = stages.findIndex(stage => stage.id === (draggedStageId || event.dataTransfer?.getData('text/plain')));
      const to = stages.findIndex(stage => stage.id === card.dataset.stageCard);
      if (from >= 0 && to >= 0 && from !== to) await h.onMovePlanStage?.(selected.id, stages[from].id, to - from);
      draggedStageId = '';
    });
  });
  $('#plan-day-minutes')?.addEventListener('input', e => { planScheduleBudget = Math.max(0.5, Number(e.target.value) || 0.5); });
  $('#btn-generate-plan')?.addEventListener('click', async () => {
    planScheduleBudget = Math.max(0.5, Number($('#plan-day-minutes')?.value) || 0.5);
    planScheduleResult = { ...schedulePlanTasks(selected, planScheduleBudget * 60), planId: selected.id, planUpdatedAt: selected.updatedAt };
    await renderPlans(s, h);
  });
}

/* ══════════════ SOP ══════════════ */

export async function renderSops(s, h) {
  const el = $('#view-sops');
  if (!el) return;
  const sops = await listSops({});
  setPanelSub(`${sops.length} 个`);

  const out = [`<div class="dlg-actions" style="margin-bottom:12px">
    <button class="ghost" id="btn-new-sop">＋ 新建 SOP</button>
  </div>`];

  if (!sops.length) {
    out.push('<div class="empty">还没有 SOP。<br>跟帕尼尼说「制定 SOP」，或者自己建一个。<br><br>每个 SOP 都会有一个「一分钟启动版」—— 起不来的时候直接用那个。</div>');
  } else {
    for (const sp of sops) {
      const steps = sp.steps || [];
      const done = steps.filter(x => x.done).length;
      out.push(`<div class="doc-item" data-sop="${sp.id}">
        <div class="d-name">${esc(sp.name)}</div>
        <div class="d-meta">${esc(sp.scene || '（未填场景）')}　${done}/${steps.length} 步${sp.estimateMin ? `　约 ${sp.estimateMin} 分钟` : ''}</div>
        ${sp.quickStart ? `<div class="quickstart" style="margin:8px 0 0;padding:6px 9px;font-size:12.5px">
          <span class="qs-label">一分钟启动</span>${esc(sp.quickStart)}</div>` : ''}
      </div>`);
    }
  }
  el.innerHTML = out.join('');
  $('#btn-new-sop')?.addEventListener('click', () => h.onNewSop?.());
  $$('[data-sop]', el).forEach(n => { n.onclick = () => h.onOpenSop?.(n.dataset.sop); });
}

/* ══════════════ 复盘 ══════════════ */

export async function renderReviews(s, h) {
  const el = $('#view-reviews');
  if (!el) return;
  const patterns = await patternStats();
  const reviews = await listReviews({ limit: 20 });
  const strategies = await effectiveStrategies(8);
  setPanelSub(`${reviews.length} 条`);

  const out = [];

  /* 拖延模式统计 */
  out.push('<div class="section-title">拖延模式（哪种反复出现）</div>');
  if (!patterns.established) {
    out.push('<div class="empty">还没有拖延模式记录。<br>帕尼尼判断出模式后会自动记下来，攒够才能看出规律。</div>');
  } else {
    const max = patterns.counts[0].count;
    for (const c of patterns.counts) {
      out.push(`<div class="pattern-bar">
        <span class="p-label">${c.pattern} · ${esc(c.label)}</span>
        <span class="p-track"><i style="width:${Math.round(c.count / max * 100)}%"></i></span>
        <span class="p-count">${c.count}</span>
      </div>`);
    }
    out.push(`<div class="hint" style="margin-top:8px">最常见的模式：<b>${patterns.top.pattern} ${esc(patterns.top.label)}</b>　建议应对：${esc(patterns.top.fix)}</div>`);
  }

  /* 有效策略 */
  if (strategies.length) {
    out.push('<div class="section-title">沉淀下来的有效策略</div>');
    out.push(strategies.map(x =>
      `<div class="review-item"><div class="r-date">${x.date}</div><div class="r-act"><b>${esc(x.action)}</b>${x.lesson ? `<br>${esc(x.lesson)}` : ''}</div></div>`).join(''));
  }

  /* 复盘记录 */
  out.push('<div class="section-title">复盘记录</div>');
  if (!reviews.length) {
    out.push('<div class="empty">还没有复盘记录。<br>输入「小黑屋」可以做一次深度复盘。</div>');
  } else {
    out.push(reviews.map(r => `
      <div class="review-item">
        <div class="r-date">${r.date}　${esc(r.kind)}${r.pattern ? `　模式 ${r.pattern}` : ''}</div>
        ${r.facts?.whatHappened ? `<div class="r-act" style="color:var(--fg-dim)">${esc(r.facts.whatHappened)}</div>` : ''}
        ${(r.triggers || []).length ? `<div class="r-act" style="color:var(--fg-dim)">触发：${esc(r.triggers.join('、'))}</div>` : ''}
        <div class="r-act"><b>→ ${esc(r.action)}</b></div>
      </div>`).join(''));
  }

  out.push(`<div class="dlg-actions" style="margin-top:14px">
    <button class="ghost" id="btn-blackroom">开始小黑屋</button>
  </div>`);

  el.innerHTML = out.join('');
  const dailyRoot = document.createElement('div');
  dailyRoot.className = 'review-loop-panel-root';
  el.prepend(dailyRoot);
  await renderDailyReview(dailyRoot);
  $('#btn-blackroom')?.addEventListener('click', () => h.onCommand?.('blackroom'));
}

/* ══════════════ 档案 ══════════════ */

const PROFILE_ROWS = [
  ['about', '学习背景与当前情况'],
  ['goals', '学习目标'],
  ['focusAreas', '当前学习重点'],
  ['learningPreferences', '学习方式与节奏'],
  ['availableTime', '可用学习时间'],
  ['constraints', '现实限制'],
  ['topProblems', '学习困难或拖延情境'],
  ['procrastinationPatterns', '常见拖延行为'],
  ['userName', '称呼'],
  ['supervisorName', '学习助手称呼'],
  ['rewardPreference', '有效奖励方式'],
  ['acceptableCorrections', '可接受的纠偏方式'],
  ['otherNeeds', '其他需求'],
];

const PERMISSION_TEXT = {
  granted: '系统通知权限已允许',
  denied: '系统通知权限被拒绝，去系统设置里允许通知',
  unsupported: '网页可以设置时间，但只有 Android App 能在后台发送通知',
  unavailable: '暂时读不到系统通知权限（重开后仍不行，就去系统设置里手动允许）',
  unknown: '首次打开开关时会请求系统通知权限',
};

export async function renderNotifications() {
  const el = $('#view-notifications');
  if (!el) return;

  /* 先用本地设置把界面画出来 —— 绝不在画之前 await 任何原生接口。
     Capacitor 的桥在某些情况下不 settle（插件没注册、系统设置页没返回），
     一旦在首屏前 await，用户看到的就是一片白。 */
  let settings;
  try {
    settings = await getNotificationSettings();
  } catch (error) {
    console.warn('[notifications-settings]', error);
    settings = { enabled: false, morning: { enabled: true, time: '09:00' }, noon: { enabled: true, time: '13:00' }, evening: { enabled: true, time: '21:00' }, taskNotifications: true };
  }
  const native = isNativeNotifications();

  const slot = key => `<label class="notification-slot"><span><input type="checkbox" data-notification-enabled="${key}" ${settings[key].enabled ? 'checked' : ''}><strong>${DAILY_LABELS[key]}</strong></span><input type="time" data-notification-time="${key}" value="${esc(settings[key].time)}" aria-label="${DAILY_LABELS[key]}时间" ${settings.enabled ? '' : 'disabled'}></label>`;

  el.innerHTML = `<div class="notification-settings">
    <section class="notification-section"><h3>复盘提醒</h3>
      <label class="notification-master"><input type="checkbox" id="notifications-enabled" ${settings.enabled ? 'checked' : ''}><span><strong>启用手机通知</strong><small id="notification-permission-status">${native ? '正在读取通知权限…' : PERMISSION_TEXT.unsupported}</small></span></label>
      <div class="notification-times">${DAILY_SLOTS.map(slot).join('')}</div>
    </section>
    <section class="notification-section"><h3>任务提醒</h3>
      <label class="notification-master"><input type="checkbox" id="task-notifications-enabled" ${settings.taskNotifications ? 'checked' : ''}><span><strong>按计划开始时间提醒</strong><small>有具体执行时间的未完成任务会在开始时提醒；修改或完成任务后自动更新。</small></span></label>
    </section>
    <section class="notification-section"><h3>检查</h3>
      <div class="notification-actions" style="justify-content:flex-start;gap:10px;padding:0;flex-wrap:wrap">
        <button type="button" class="ghost" id="btn-test-notification">发送测试提醒</button>
        <button type="button" class="ghost" id="btn-exact-alarm" hidden>让提醒更准时</button>
      </div>
      <div class="hint" id="notification-status-line" aria-live="polite" style="margin-top:10px">${native ? '正在读取待发送提醒…' : '这些设置在网页上只会被保存；提醒要装 Android App 才会真的发出来。'}</div>
    </section>
    <div class="notification-actions"><button class="primary" id="save-notification-settings">保存设置</button></div>
  </div>`;

  const setStatus = text => {
    const node = $('#notification-status-line', el);
    if (node) node.textContent = text;
  };
  const setPermissionStatus = text => {
    const node = $('#notification-permission-status', el);
    if (node) node.textContent = text;
  };

  /* 界面已经在屏幕上了，再去问原生补状态。任何一步失败或超时都只影响这行字。 */
  if (native) {
    void (async () => {
      const [permission, exactAlarm, counts] = await Promise.all([
        getNotificationPermission(),
        getExactAlarmPermission(),
        notificationCounts(),
      ]);
      if (!el.isConnected) return;
      setPermissionStatus(PERMISSION_TEXT[permission] || PERMISSION_TEXT.unknown);
      const exact = $('#btn-exact-alarm', el);
      if (exact) exact.hidden = exactAlarm === 'granted';
      setStatus(`待发送提醒 ${counts.pending} 条 · ${exactAlarm === 'granted' ? '精确提醒已允许' : '精确提醒未允许（可能晚几分钟）'}${counts.error ? ` · ${counts.error}` : ''}`);
    })();
  }
  const toggleTimes = enabled => {
    el.querySelectorAll('[data-notification-time]').forEach(input => { input.disabled = !enabled; });
  };

  /* 打开任一开关都立刻要权限：点完马上有系统弹窗，而不是点保存才有反应。 */
  const requestPermissionOnEnable = async event => {
    const checkbox = event.currentTarget;
    if (!checkbox.checked) return;
    if (!native) {
      checkbox.checked = false;
      if (checkbox.id === 'notifications-enabled') toggleTimes(false);
      toast('手机系统通知需要在 Android App 中启用。', 'err');
      return;
    }
    checkbox.disabled = true;
    setStatus('正在请求系统通知权限…');
    try {
      await requestNotificationPermission();
      setPermissionStatus('系统通知权限已允许');
      setStatus('权限已开启，记得点「保存设置」让排期生效。');
      toast('通知权限已开启，请保存设置。', 'ok');
    } catch (error) {
      checkbox.checked = false;
      if (checkbox.id === 'notifications-enabled') toggleTimes(false);
      setStatus(error.message || '无法开启通知权限');
      toast(error.message || '无法开启通知权限', 'err');
    } finally {
      checkbox.disabled = false;
    }
  };

  $('#notifications-enabled', el).addEventListener('change', event => {
    toggleTimes(event.target.checked);
    void requestPermissionOnEnable(event);
  });
  $('#task-notifications-enabled', el).addEventListener('change', event => {
    void requestPermissionOnEnable(event);
  });
  el.querySelectorAll('[data-notification-enabled]').forEach(checkbox => {
    checkbox.addEventListener('change', event => { void requestPermissionOnEnable(event); });
  });

  $('#btn-exact-alarm', el).addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus('正在打开系统的「闹钟和提醒」设置…');
    try {
      const result = await requestExactAlarmPermission();
      button.hidden = result === 'granted';
      setStatus(result === 'granted' ? '精确提醒已允许。' : '「闹钟和提醒」仍未允许，提醒可能会晚几分钟。');
      toast(result === 'granted' ? '精确提醒已允许' : '「闹钟和提醒」未允许', result === 'granted' ? 'ok' : 'warn');
    } catch (error) {
      setStatus(error.message || '无法打开「闹钟和提醒」设置');
      toast(error.message || '无法打开「闹钟和提醒」设置', 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#btn-test-notification', el).addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus('正在安排一条 5 秒后的测试提醒…');
    try {
      const at = await sendTestNotification();
      setStatus(`测试提醒已安排：${at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 到达。锁屏或退出应用都能收到；点它应该回到复盘页。`);
      toast('5 秒后会收到一条测试提醒', 'ok');
    } catch (error) {
      setStatus(error.message || '测试提醒发送失败');
      toast(error.message || '测试提醒发送失败', 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#save-notification-settings', el).addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    setStatus('正在保存并重排提醒…');
    try {
      const value = {
        enabled: $('#notifications-enabled', el).checked,
        taskNotifications: $('#task-notifications-enabled', el).checked,
      };
      for (const key of DAILY_SLOTS) {
        value[key] = {
          enabled: el.querySelector('[data-notification-enabled="' + key + '"]').checked,
          time: el.querySelector('[data-notification-time="' + key + '"]').value,
        };
      }
      const saved = await saveNotificationSettings(value);
      toast(saved.scheduled ? `通知设置已保存，已排 ${saved.scheduled.daily} 条复盘提醒、${saved.scheduled.tasks} 条任务提醒` : '通知设置已保存');
      await renderNotifications();
    } catch (error) {
      setStatus(error.message || '通知设置保存失败');
      toast(error.message || '通知设置保存失败', 'err');
    } finally {
      button.disabled = false;
    }
  });
}

export async function renderProfile(s, h) {
  const el = $('#view-profile');
  if (!el) return;
  const p = await getProfile();
  const c = profileCompletion(p);
  setPanelSub(c.isOnboarded ? '已初始化' : `${c.requiredDone}/${c.requiredTotal}`);

  const pct = Math.round(c.requiredDone / c.requiredTotal * 100);
  const out = [];

  out.push('<div class="section-title">学习情况</div>');

  out.push(`<div class="completion-bar">
    <span>核心 ${c.requiredDone}/${c.requiredTotal}</span>
    <span class="track"><i style="width:${pct}%"></i></span>
    <span>补充 ${c.optionalDone}/${c.optionalTotal}</span>
  </div>`);

  if (!c.isOnboarded) {
    out.push(`<div class="card warn">
      <div class="card-title">学习档案还可补充</div>
      <div class="card-sub">还可补充：${c.missingRequired.map(k => PROFILE_ROWS.find(r => r[0] === k)?.[1] || k).join('、') || `（可标记整理完成）`}</div>
    </div>`);
  }

  if (p.suspendUntil) {
    out.push(`<div class="card danger">
      <div class="card-title">⛔ 监督已暂停</div>
      <div class="card-sub">${p.suspendUntil === 'indefinite' ? '直到你主动解除' : `到 ${fmtDateTime(p.suspendUntil)}`}　期间不催任务、不算积分、不做复盘</div>
    </div>`);
  }

  const supportFields = new Set(['userName', 'supervisorName', 'rewardPreference', 'acceptableCorrections', 'otherNeeds']);
  let supportHeadingShown = false;
  for (const [k, label] of PROFILE_ROWS) {
    if (supportFields.has(k) && !supportHeadingShown) {
      out.push('<div class="section-title">沟通与支持偏好</div>');
      supportHeadingShown = true;
    }
    const v = p[k];
    const text = v;
    out.push(`<div class="profile-row">
      <span class="pk">${label}</span>
      <span class="pv ${text ? '' : 'missing'}">${text ? esc(text) : '未记录'}</span>
    </div>`);
  }

  out.push(`<div class="profile-row">
    <span class="pk">雷区</span>
    <span class="pv ${(p.taboos || []).length ? '' : 'missing'}">${(p.taboos || []).length ? esc(p.taboos.join('；')) : '未记录'}</span>
  </div>`);

  out.push(`<div class="profile-row">
    <span class="pk">表达强度</span>
    <span class="pv">${p.toneLevel ?? 5}/5　${p.allowProfanity ? '已授权粗口' : '未授权粗口'}</span>
  </div>`);

  out.push(`<div class="dlg-actions" style="margin-top:14px">
    <button class="primary ghost" id="btn-edit-profile">编辑学习档案</button>
    ${p.suspendUntil ? '<button class="ghost" id="btn-resume">解除暂停监督</button>' : ''}
  </div>`);

  out.push(`<div class="hint" style="margin-top:12px">
    档案会注入每一轮对话。没填的项会显示「未记录」，帕尼尼不会凭空猜。
  </div>`);

  el.innerHTML = out.join('');
  $('#btn-edit-profile')?.addEventListener('click', () => h.onEditProfile?.());
  // 用 unsuspend（代码动作）而不是 resume（模型级），避免"解除"还要绕一圈模型
  $('#btn-resume')?.addEventListener('click', () => h.onCommand?.('unsuspend'));
}

/* ══════════════ 统一刷新 ══════════════ */

export async function refreshPanel(panelId, s, cards, plan, h) {
  switch (panelId) {
    case 'today':   await renderToday(s, cards, plan, h); break;
    case 'learning': renderLearning(s, h); break;
    case 'habits':  renderHabits(s, h); break;
    case 'life':    renderLife(s, h); break;
    case 'records': await renderRecords(s, h); break;
    case 'tasks':   renderTasks(s, h); break;
    case 'checkin': await renderCheckin(s, h); break;
    case 'points':  await renderPoints(s, h); break;
    case 'plans':   await renderPlans(s, h); break;
    case 'sops':    await renderSops(s, h); break;
    case 'reviews': await renderReviews(s, h); break;
    case 'profile': await renderProfile(s, h); break;
    case 'notifications': await renderNotifications(); break;
    default: break;
  }
}

/** 导航上的角标。数据没就绪时也要安全返回。 */
export function panelBadges(s) {
  if (!s) return {};
  const blocked = s.blocked?.length || 0;
  const overdue = s.overdue?.length || 0;
  const stale = s.timer?.stale ? 1 : 0;
  const unfinished = tasksForDate(s.tasks || [], selectedTaskDate)
    .filter(t => !['DONE', 'CANCELLED'].includes(t.state));
  const important = unfinished.filter(t => taskCategory(t) === 'important').length;
  const chores = unfinished.filter(t => taskCategory(t) === 'chore').length;
  const habitSnapshot = getHabitSnapshot(selectedTaskDate);
  const pendingHabits = Math.max(0, habitSnapshot.active.length - habitSnapshot.done.length);
  const trackedMinutes = Math.max(0, Number(s.trackedMinutes) || 0);
  const focusDuration = fmtFocusDuration(trackedMinutes);
  return {
    today: { label: blocked + overdue + stale, title: '需要留意', tone: 'urgent' },
    tasks: {
      label: `${important}|${chores}|${pendingHabits}`,
      title: `${selectedTaskDate === dateStr() ? '今日' : '所选日期'}待完成主要任务 | 杂事 | 微习惯`,
      tone: 'count',
    },
    records: { label: focusDuration, title: '今日专注时长', tone: 'duration' },
    habits: 0,
    life: 0,
  };
}

function fmtFocusDuration(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  return hours ? `${hours}h${String(remainder).padStart(2, '0')}min` : `${remainder}min`;
}
