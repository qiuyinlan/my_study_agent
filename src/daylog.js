// ── 某一天的记录聚合 ────────────────────────────────────────
//
// 「记录」面板的数据层：给定一个日期，把它那天发生的所有东西捞出来，
// 并且允许修正。
//
// 一个刻意的设计：专注时长和学习记录时长**分开显示，不做合并**。
//   timeEntries.actualMin → 一段专注实际花了多久（计时或补记）
//   logs.minutes          → 一次学习记录里自报的时长
// 两者经常同时存在（用户开着计时器，同时又让帕尼尼记一条学习记录），
// 合并会重复计算。所以各算各的，并明确写出来，而不是编一个"总计"。

import { db, listTasks } from './db.js';
import { nowISO } from './util.js';

/* ══════════════ 聚合 ══════════════ */

/**
 * 取某一天的全部记录。
 * @param {string} date 'YYYY-MM-DD'
 */
export async function daySummary(date) {
  const [allEntries, allLogs, tasks, checkin] = await Promise.all([
    db.timeEntries.toArray(),
    db.logs.toArray(),
    listTasks(),
    db.checkins.get(date),
  ]);

  const entries = allEntries
    .filter(e => e.date === date)
    .sort((a, b) => String(a.startedAt || a.createdAt).localeCompare(String(b.startedAt || b.createdAt)));

  const logs = allLogs
    .filter(l => l.date === date)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const taskById = new Map(tasks.map(t => [t.id, t]));
  const withTask = list => list.map(x => ({
    ...x,
    taskTitle: x.taskId ? (taskById.get(x.taskId)?.title || '（任务已删除）') : '',
  }));

  const doneTasks = tasks.filter(t =>
    t.state === 'DONE' && String(t.actualEnd || '').slice(0, 10) === date);

  const focusedMinutes = entries.reduce((s, e) => s + (e.actualMin || 0), 0);
  const loggedMinutes = logs.reduce((s, l) => s + (l.minutes || 0), 0);
  const timerMinutes = entries.filter(e => e.source === 'timer').reduce((s, e) => s + (e.actualMin || 0), 0);

  return {
    date,
    entries: withTask(entries),
    logs: withTask(logs),
    doneTasks,
    checkin: checkin || null,
    focusedMinutes,
    loggedMinutes,
    timerMinutes,
    entryCount: entries.length,
    timerCount: entries.filter(e => e.source === 'timer').length,
    manualCount: entries.filter(e => e.source !== 'timer').length,
    /** 两条线都有数据时提醒一句，别让用户以为某个数字漏了 */
    overlapNote: entries.length && logs.length
      ? '专注记录和学习记录可能重叠（开着计时又记了学习），所以不合并成一个总数。'
      : null,
    taskIds: [...new Set(entries.map(e => e.taskId).filter(Boolean))],
  };
}

/** 有记录的那些日子（用于给日期选择器加标记） */
export async function daysWithRecords() {
  const [entries, logs] = await Promise.all([db.timeEntries.toArray(), db.logs.toArray()]);
  const set = new Set();
  for (const e of entries) if (e.date) set.add(e.date);
  for (const l of logs) if (l.date) set.add(l.date);
  return set;
}

/** 最近一条记录落在哪天 —— 打开面板时默认跳到那天更实用 */
export async function latestRecordDate() {
  const [entries, logs] = await Promise.all([db.timeEntries.toArray(), db.logs.toArray()]);
  const dates = [
    ...entries.map(e => e.date),
    ...logs.map(l => l.date),
  ].filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/* ══════════════ 学习记录的编辑 ══════════════ */

export async function getLog(id) {
  return db.logs.get(id);
}

/**
 * 修改一条学习记录。同样打 edited 标记，保留"人工改过"这个事实。
 */
export async function updateLog(id, patch = {}) {
  const cur = await db.logs.get(id);
  if (!cur) throw new Error('找不到这条学习记录');

  const next = { ...cur };
  if (patch.topicName !== undefined) next.topicName = String(patch.topicName || '').trim();
  if (patch.what !== undefined) next.what = String(patch.what || '').trim();
  if (patch.blockers !== undefined) next.blockers = String(patch.blockers || '').trim();
  if (patch.taskId !== undefined) next.taskId = String(patch.taskId || '').trim();
  if (patch.date !== undefined && patch.date) next.date = patch.date;
  if (patch.minutes !== undefined) {
    const m = patch.minutes === null || patch.minutes === '' ? 0 : Math.round(Number(patch.minutes));
    if (!Number.isFinite(m) || m < 0) throw new Error('时长必须是非负数字');
    if (m > 24 * 60) throw new Error('单条记录的时长不能超过 24 小时');
    next.minutes = m;
  }

  next.edited = true;
  next.editedAt = nowISO();
  await db.logs.put(next);
  return next;
}

export async function deleteLog(id) {
  const cur = await db.logs.get(id);
  if (!cur) throw new Error('找不到这条学习记录');
  await db.logs.delete(id);
  return cur;
}

/** 手动补一条学习记录 */
export async function createLog({ date, topicName = '', what = '', blockers = '', minutes = 0, taskId = '' } = {}) {
  if (!date) throw new Error('必须给日期');
  const text = String(what || topicName || '').trim();
  if (!text) throw new Error('至少写一句做了什么');
  const m = Math.round(Number(minutes) || 0);
  if (m < 0 || m > 24 * 60) throw new Error('时长必须介于 0 和 24 小时之间');

  const rec = {
    id: `log_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    date,
    createdAt: nowISO(),
    topicId: '',
    topicName: String(topicName || '').trim(),
    taskId: String(taskId || '').trim(),
    minutes: m,
    what: text,
    blockers: String(blockers || '').trim(),
    grade: null,
    edited: true,
    editedAt: nowISO(),
  };
  await db.logs.put(rec);
  return rec;
}
