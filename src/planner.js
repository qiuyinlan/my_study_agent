// ── 今日看板：零 token 的"打开即提示" ─────────────────────────
//
// 这部分刻意不调用任何模型。状态本来就存在本地，打开页面直接算就行 ——
// 快、免费、离线可用。模型只在用户想聊的时候介入。
//
// 特别注意 §3 第 7 条「不把用户未回复视为任务失败」：
// 这里只做中性陈述（"已经 5 天没动"），**不产出任何失败判定**。

import {
  db, listTasks, listTopics, getKeyTasks, getMeta, ACTIVE_STATES, TASK_STATES,
} from './db.js';
import { dueTopics } from './srs.js';
import { getActiveTimer, estimationStats, STALE_HOURS } from './timer.js';
import { getLedger } from './ledger.js';
import { getCheckin, isMedsEnabled, patternStats } from './records.js';
import { dateStr, endOfToday, daysUntil } from './util.js';
import { listPlans } from './docs.js';

export const STALL_DAYS = 3;
/** 超过这个天数没动，就算"停滞" */
const SOON_DAYS = 3;

export async function computeToday() {
  const endISO = endOfToday();
  const today = dateStr();

  const [
    allTasks, topics, logs, timer, ledger, checkin, medsEnabled,
    estimation, patterns, allEntries,
  ] = await Promise.all([
    listTasks(), listTopics(), db.logs.toArray(),
    getActiveTimer(), getLedger({ recentLimit: 8 }), getCheckin(today), isMedsEnabled(),
    estimationStats(), patternStats(), db.timeEntries.toArray(),
  ]);

  /* ── 按状态分组 ── */
  const byState = {};
  for (const st of Object.keys(TASK_STATES)) byState[st] = [];
  for (const t of allTasks) {
    (byState[t.state] || (byState[t.state] = [])).push(t);
  }

  const active = allTasks.filter(t => ACTIVE_STATES.includes(t.state));
  const doing = byState.DOING || [];
  const blocked = byState.BLOCKED || [];

  /* ── 每个任务最后一次活动时间（用时间记录和日志算，不用猜）── */
  const lastTouch = new Map();
  const bump = (taskId, iso) => {
    if (!taskId || !iso) return;
    const prev = lastTouch.get(taskId);
    if (!prev || iso > prev) lastTouch.set(taskId, iso);
  };
  for (const l of logs) bump(l.taskId, l.createdAt);
  for (const e of await db.timeEntries.toArray()) bump(e.taskId, e.endedAt || e.createdAt);

  const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

  /* ── 停滞（中性陈述，不是失败判定）── */
  const stalled = active
    .map(t => {
      const last = lastTouch.get(t.id) || t.actualStart || t.createdAt;
      return { ...t, lastTouchedAt: last, idleDays: daysSince(last) };
    })
    .filter(t => t.idleDays >= STALL_DAYS)
    .sort((a, b) => b.idleDays - a.idleDays);

  /* ── 逾期 / 即将到期 ── */
  const overdue = active
    .filter(t => t.dueAt && daysUntil(t.dueAt) < 0)
    .map(t => ({ ...t, overdueDays: -daysUntil(t.dueAt) }))
    .sort((a, b) => b.overdueDays - a.overdueDays);

  const soon = active
    .filter(t => t.dueAt && daysUntil(t.dueAt) >= 0 && daysUntil(t.dueAt) <= SOON_DAYS)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  /* ── 今天完成的 ── */
  const doneToday = (byState.DONE || []).filter(t => (t.actualEnd || '').slice(0, 10) === today);

  /* ── 复习（学习模块）── */
  const dueReviews = dueTopics(topics, endISO);

  /* ── 连续天数 ── */
  const daySet = new Set(logs.map(l => l.date));
  const cursor = new Date();
  if (!daySet.has(dateStr(cursor))) cursor.setDate(cursor.getDate() - 1); // 今天还没学不算断
  let streak = 0;
  while (daySet.has(dateStr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const todayLogs = logs.filter(l => l.date === today);
  const studyMinutes = todayLogs.reduce((s, l) => s + (l.minutes || 0), 0);

  /* ── 今日动态 ──
     把今天发生的事汇成一条时间线。这是让「今日」面板真正反映
     对话结果的关键：log_study 建的知识点、记的时长、完成的任务，
     以前只在别的面板能看到，用户停在今日面板聊完会觉得"没反应"。 */
  const todayEntries = allEntries.filter(e => e.date === today);
  const trackedMinutes = todayEntries.reduce((s, e) => s + (e.actualMin || 0), 0);

  const activity = [];
  for (const l of todayLogs) {
    activity.push({
      at: l.createdAt,
      kind: 'log',
      id: l.id,            // 带上 id，今日面板里可以直接点开编辑
      text: l.minutes ? `${l.topicName || l.what}　${l.minutes} 分钟` : (l.topicName || l.what),
      sub: l.blockers || '',
    });
  }
  for (const e of todayEntries) {
    const task = allTasks.find(t => t.id === e.taskId);
    activity.push({
      at: e.createdAt,
      kind: 'time',
      id: e.id,
      text: `${task ? task.title : (e.note || '专注记录')}　${e.actualMin ?? '?'} 分钟`,
      sub: e.source === 'timer' ? '真实计时' : e.source === 'manual' ? '补记' : '自报',
    });
  }
  for (const t of doneToday) {
    activity.push({
      at: t.actualEnd || t.updatedAt,
      kind: 'done',
      id: t.id,
      text: `完成「${t.title}」`,
      sub: '',
    });
  }
  if (checkin) {
    activity.push({
      at: checkin.updatedAt || checkin.createdAt,
      kind: 'checkin',
      id: null,
      text: '完成今日打卡',
      sub: '',
    });
  }
  activity.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const todayActivity = activity.filter(a => a.text).slice(0, 10);

  /* ── 今日关键任务 ── */
  const keyRec = await getKeyTasks();
  const keyTasks = [];
  for (const id of keyRec.ids) {
    const t = await db.tasks.get(id);
    if (t) keyTasks.push(t);
  }

  /* ── 数据一致性检查 ──
     代码主动把"看起来矛盾"的地方摊出来，避免模型凭印象编状态。 */
  const integrity = [];

  if (doing.length && !timer) {
    integrity.push({
      level: 'warn',
      text: `有 ${doing.length} 个任务标着 DOING，但没有计时在跑。要么忘了开始计时，要么状态没更新。`,
    });
  }
  if (timer?.stale) {
    integrity.push({
      level: 'danger',
      text: `计时器已经跑了超过 ${STALE_HOURS} 小时（${timer.elapsedText}），多半是忘了停。需要确认一下。`,
    });
  }
  const doingNoStart = doing.filter(t => !t.actualStart);
  if (doingNoStart.length) {
    integrity.push({
      level: 'warn',
      text: `${doingNoStart.length} 个进行中的任务没有实际开始时间记录 —— 无法核验进行了多久。`,
    });
  }
  const blockedNoReason = blocked.filter(t => !t.blocker);
  if (blockedNoReason.length) {
    integrity.push({
      level: 'warn',
      text: `${blockedNoReason.length} 个任务处于 BLOCKED 但没写阻碍是什么。受阻说不出原因，等于没受阻。`,
    });
  }
  if (ledger.established && ledger.unconfirmed.length) {
    integrity.push({
      level: 'info',
      text: `有 ${ledger.unconfirmed.length} 笔积分还没经你确认（合计 ${ledger.pendingTotal > 0 ? '+' : ''}${ledger.pendingTotal}）。`,
    });
  }
  if (!keyRec.ids.length && active.length) {
    integrity.push({
      level: 'info',
      text: '今天还没指定关键任务。§5.3 的原则是每天只挑 1-3 个，不要把整个任务池塞进今天。',
    });
  }

  /* ── 规划过载 ── */
  const plans = await listPlans({});
  const activePlans = plans.filter(p => p.status === 'active' || p.status === 'draft');
  const overloaded = activePlans.filter(p => p.feasibility?.feasible === false);

  return {
    today,
    now: new Date(),
    timer,
    keyTasks,
    keyTaskIds: keyRec.ids,
    tasks: allTasks,
    byState,
    active,
    doing,
    blocked,
    deferred: byState.DEFERRED || [],
    inbox: byState.INBOX || [],
    ready: byState.READY || [],
    next: byState.NEXT || [],
    doneToday,
    overdue,
    soon,
    stalled,
    topics,
    dueReviews,
    dueCount: dueReviews.length,
    ledger,
    checkin,
    medsEnabled,
    patterns,
    streak,
    studyMinutes,
    trackedMinutes,
    minutes: studyMinutes,
    todayActivity,
    estimation,
    integrity,
    plans: activePlans,
    overloadedPlans: overloaded,
    idleNote: stalled.length
      ? `最久的一个已经 ${stalled[0].idleDays} 天没动`
      : null,
  };
}

/* ══════════════ 卡片生成 ══════════════ */

/**
 * 把状态翻译成侧栏卡片。
 * @returns {{level:string, title:string, sub:string, action?:string, payload?:any}[]}
 */
export function todayCards(s) {
  const cards = [];

  /* 正在跑的计时 —— 放最前，这是当下最真实的事实 */
  if (s.timer) {
    cards.push({
      level: s.timer.stale ? 'danger' : 'ok',
      title: s.timer.stale ? '计时器可能忘了停' : `正在计时：${s.timer.label}`,
      sub: s.timer.stale
        ? `已经跑了 ${s.timer.elapsedText}，确认一下是不是还在做`
        : `已过 ${s.timer.elapsedText}${s.timer.plannedMin ? `（计划 ${s.timer.plannedMin} 分钟${s.timer.overPlanned ? '，已超时' : `，还剩 ${s.timer.remainingMin} 分钟`}）` : ''}`,
      action: 'timer',
    });
  }

  /* 受阻：最需要干预的一类 */
  for (const t of s.blocked.slice(0, 2)) {
    cards.push({
      level: 'danger',
      title: `受阻：${t.title}`,
      sub: t.blocker || '没写阻碍是什么。先让他说清楚卡在哪。',
      action: 'task',
      payload: t.id,
    });
  }

  /* 逾期 */
  for (const t of s.overdue.slice(0, 3)) {
    cards.push({
      level: 'danger',
      title: `${t.title} 已逾期 ${t.overdueDays} 天`,
      sub: t.nextAction || '要么改截止日期，要么把它拆小',
      action: 'task',
      payload: t.id,
    });
  }

  /* 即将到期 */
  for (const t of s.soon.slice(0, 2)) {
    const d = daysUntil(t.dueAt);
    cards.push({
      level: 'warn',
      title: `${t.title} ${d === 0 ? '今天截止' : `${d} 天后截止`}`,
      sub: `状态 ${t.state}　进度 ${t.progress ?? 0}%`,
      action: 'task',
      payload: t.id,
    });
  }

  /* 停滞 */
  for (const t of s.stalled.slice(0, 3)) {
    cards.push({
      level: 'info',
      title: `${t.title} 已经 ${t.idleDays} 天没动`,
      sub: t.nextAction || '要不要今天推进一小步？',
      action: 'task',
      payload: t.id,
    });
  }

  /* 复习 */
  if (s.dueCount) {
    cards.push({
      level: 'warn',
      title: `${s.dueCount} 个知识点到期复习`,
      sub: `最急的是「${s.dueReviews[0].name}」`,
      action: 'review',
    });
  }

  /* 规划过载 */
  for (const p of s.overloadedPlans.slice(0, 2)) {
    cards.push({
      level: 'warn',
      title: `规划 ${p.code} 过载`,
      sub: `预计 ${p.feasibility.totalMin} 分钟，超时 ${p.feasibility.overBy} 分钟，需要缩范围`,
      action: 'plan',
      payload: p.id,
    });
  }

  /* 数据一致性问题 */
  for (const w of s.integrity.filter(i => i.level !== 'info').slice(0, 2)) {
    cards.push({ level: w.level, title: '数据需要核对', sub: w.text });
  }

  /* 什么都没提醒 */
  if (!cards.length) {
    if (!s.active.length) {
      cards.push({
        level: 'info',
        title: '任务池是空的',
        sub: '把要做的事情扔进来，我来帮你拆到能开始为止',
        action: 'pick_key',
      });
    } else {
      cards.push({
        level: 'ok',
        title: '没有逾期、没有受阻、没有停滞',
        sub: s.doneToday.length
          ? `今天已完成 ${s.doneToday.length} 项`
          : '可以推进主线，或者主动给今天挑个关键任务',
      });
    }
  }

  return cards;
}

/** 一行状态摘要，用于对话开场（零 token） */
export function todayLine(s) {
  const bits = [];
  if (s.timer) bits.push(`计时中 ${s.timer.elapsedText}`);
  if (s.streak > 1) bits.push(`连续 ${s.streak} 天`);
  if (s.doneToday.length) bits.push(`今日完成 ${s.doneToday.length} 项`);
  if (s.dueCount) bits.push(`${s.dueCount} 个待复习`);
  if (s.blocked.length) bits.push(`${s.blocked.length} 个受阻`);
  return bits.join(' · ') || '还没有记录';
}
