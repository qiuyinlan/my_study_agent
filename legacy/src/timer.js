// ── 计时器：整个系统里最不能交给模型的部分 ────────────────────
//
// 提示词第九节明确要求"不得声称拥有独立的后台计时能力"、"不得伪造计时
// 结果"，同时要求区分：计划时间 / 用户自报时间 / 平台时间 / 计算耗时。
//
// 模型没有时钟。让它承担计时，它只能编。所以这里用真实的时间戳做：
//   · 计时状态存在 IndexedDB 里 → 刷新页面、关掉重开都能恢复
//   · 实际耗时来自墙钟，不是自报
//   · 自报耗时单独存一列，两者不一致时系统能发现，不抹平

import { db, getMeta, setMeta, delMeta, upsertTask, notifyTaskChanged } from './db.js';
import { uid, nowISO, dateStr } from './util.js';

/** 超过这个时长还在跑的计时器，基本可以认定是忘了停 */
export const STALE_HOURS = 8;

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
}

const toMin = ms => Math.max(0, Math.round(ms / 60000));

/* ══════════════ 运行中的计时器 ══════════════ */

/**
 * 取当前计时状态。注意它是从 meta 读的，所以页面刷新后依然存在。
 * @returns {Promise<null|object>} 无计时返回 null
 */
export async function getActiveTimer() {
  const t = await getMeta('activeTimer', null);
  if (!t) return null;

  const startedAtMs = new Date(t.startedAt).getTime();
  const elapsedMs = Date.now() - startedAtMs;
  const elapsedMin = toMin(elapsedMs);

  let label = t.note || '';
  if (t.taskId) {
    const task = await db.tasks.get(t.taskId);
    if (task) label = task.title;
  }

  return {
    ...t,
    label: label || '(未命名)',
    elapsedMs,
    elapsedMin,
    elapsedText: fmtDuration(elapsedMs),
    stale: elapsedMs > STALE_HOURS * 3600_000,
    overPlanned: t.plannedMin ? elapsedMin > t.plannedMin : false,
    remainingMin: t.plannedMin ? Math.max(0, t.plannedMin - elapsedMin) : null,
  };
}

export async function startTimer({ taskId = '', plannedMin = null, note = '' } = {}) {
  const existing = await getActiveTimer();
  if (existing) {
    throw new Error(`已经有一个计时在进行中（「${existing.label}」，已过 ${existing.elapsedText}）。先停掉它再开新的。`);
  }

  const timer = {
    id: uid('tmr_'),
    taskId: String(taskId || '').trim(),
    plannedMin: plannedMin === null || plannedMin === '' ? null : Number(plannedMin),
    note: String(note || '').trim(),
    startedAt: nowISO(),
  };
  if (timer.plannedMin !== null && (!Number.isFinite(timer.plannedMin) || timer.plannedMin < 0)) {
    throw new Error('plannedMin 必须是非负数');
  }

  await setMeta('activeTimer', timer);

  // 同步任务状态：开始计时就意味着在做了
  if (timer.taskId) {
    const task = await db.tasks.get(timer.taskId);
    if (task && task.state !== 'DOING') {
      const patch = { state: 'DOING', updatedAt: nowISO() };
      patch.actualStart = task.actualStart || timer.startedAt;
      if (timer.plannedMin !== null) patch.estimateMin = timer.plannedMin;
      if (!patch.actualStart) patch.actualStart = timer.startedAt;
      await db.tasks.update(timer.taskId, patch);
      notifyTaskChanged();
    }
  }

  return getActiveTimer();
}

/**
 * 结束计时并落一条 timeEntry。
 * @param {object} o
 * @param {number} [o.selfReportedMin] 用户自报耗时；与计时结果不一致时两者都保留
 */
export async function stopTimer({ note = '', selfReportedMin = null, outcome = '' } = {}) {
  const active = await getActiveTimer();
  if (!active) throw new Error('当前没有正在运行的计时。');

  const endedAt = nowISO();
  const actualMin = active.elapsedMin;
  const self =
    selfReportedMin === null || selfReportedMin === '' ? null : Number(selfReportedMin);
  if (self !== null && (!Number.isFinite(self) || self < 0)) {
    throw new Error('selfReportedMin 必须是非负数');
  }

  const entry = {
    id: uid('time_'),
    taskId: active.taskId || '',
    plannedMin: active.plannedMin,
    startedAt: active.startedAt,
    endedAt,
    actualMin,
    actualMs: active.elapsedMs,
    selfReportedMin: self,
    // 差额：正数表示用户自报比实际长（可能漏停），负数表示自报比实际短（可能低估）
    driftMin: self === null ? null : self - actualMin,
    source: 'timer',
    timerId: active.id,
    note: String(note || '').trim(),
    outcome: String(outcome || '').trim(),
    date: dateStr(new Date(active.startedAt)),
    createdAt: endedAt,
  };
  await db.timeEntries.put(entry);
  await delMeta('activeTimer');

  // 回填任务的开始时间/完成情况，实际耗时统一由 syncTaskMinutes 从记录派生
  if (entry.taskId) {
    const task = await db.tasks.get(entry.taskId);
    if (task) {
      const patch = { updatedAt: endedAt };
      patch.actualStart = task.actualStart || active.startedAt;
      if (outcome) patch.outcome = outcome;
      await db.tasks.update(entry.taskId, patch);
      notifyTaskChanged();
    }
    await syncTaskMinutes(entry.taskId);
  }

  return { entry, plannedMin: active.plannedMin, actualMin, selfReportedMin: self, driftMin: entry.driftMin };
}

/** 放弃计时，不留记录（误点的情况） */
export async function cancelTimer() {
  const active = await getActiveTimer();
  if (!active) throw new Error('当前没有正在运行的计时。');
  await delMeta('activeTimer');
  return active;
}

/* ══════════════ 手工/自报的时间记录 ══════════════ */

/** 用户没走计时器，只报了个耗时（§9.1 的"用户报告时间"） */
export async function logTimeEntry({
  taskId = '', minutes, selfReportedMin = null, note = '', outcome = '',
  startedAt = '', endedAt = '',
} = {}) {
  const self = selfReportedMin === null || selfReportedMin === '' ? null : Number(selfReportedMin);
  const actual = minutes === undefined || minutes === null || minutes === '' ? null : Number(minutes);
  const value = actual ?? self;
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new Error('必须提供非负的 minutes（或用 selfReportedMin）');
  }

  const entry = {
    id: uid('time_'),
    taskId: String(taskId || '').trim(),
    plannedMin: null,
    startedAt: startedAt || '',
    endedAt: endedAt || nowISO(),
    actualMin: actual,
    actualMs: actual === null ? null : actual * 60000,
    selfReportedMin: self,
    driftMin: null,
    source: startedAt && endedAt ? 'reported_range' : 'reported',
    timerId: null,
    note: String(note || '').trim(),
    outcome: String(outcome || '').trim(),
    date: dateStr(startedAt ? new Date(startedAt) : new Date()),
    createdAt: nowISO(),
  };
  await db.timeEntries.put(entry);

  if (entry.taskId) {
    // 任务的实际耗时从记录派生，不做加法 —— 否则编辑/删除记录后就会算错
    await syncTaskMinutes(entry.taskId);
    if (outcome) {
      await db.tasks.update(entry.taskId, { outcome, updatedAt: nowISO() });
      notifyTaskChanged();
    }
  }

  return entry;
}

/* ══════════════ 查询 ══════════════ */

export const getTimeEntry = id => db.timeEntries.get(id);

export async function listTimeEntries({ taskId, date, limit = 200 } = {}) {
  let all = await db.timeEntries.toArray();
  if (taskId) all = all.filter(e => e.taskId === taskId);
  if (date) all = all.filter(e => e.date === date);
  return all
    .sort((a, b) => String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)))
    .slice(0, limit);
}

/**
 * 把任务的实际耗时按它的时间记录重算。
 *
 * 早先 task.actualMin 是一路累加出来的（logTimeEntry 里做加法），
 * 结果记录一被编辑或删除就会算错。改成从记录派生，就不可能再对不上。
 */
export async function syncTaskMinutes(taskId) {
  if (!taskId) return null;
  const entries = await db.timeEntries.where('taskId').equals(taskId).toArray();
  const total = entries.reduce((s, e) => s + (e.actualMin || 0), 0);
  const task = await db.tasks.get(taskId);
  if (!task) return null;
  await db.tasks.update(taskId, {
    // 用 entries.length 判断有没有记录，而不是 total || null ——
    // 后者会把"有记录但合计 0 分钟"和"完全没有记录"混成同一个 null
    actualMin: entries.length ? total : null,
    updatedAt: nowISO(),
  });
  notifyTaskChanged();
  return total;
}

/* ══════════════ 编辑与删除 ══════════════ */

const dateOf = iso => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateStr(d);
};

/**
 * 修改一条时间记录。改过之后打上 edited 标记 —— 保留"这是人工修正过的"
 * 这个事实，而不是让它看起来和自动记录的一模一样。
 */
export async function updateTimeEntry(id, patch = {}) {
  const cur = await db.timeEntries.get(id);
  if (!cur) throw new Error('找不到这条时间记录');

  const next = { ...cur };
  if (patch.taskId !== undefined) next.taskId = String(patch.taskId || '').trim();
  if (patch.note !== undefined) next.note = String(patch.note || '').trim();
  if (patch.outcome !== undefined) next.outcome = String(patch.outcome || '').trim();
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt || '';
  if (patch.endedAt !== undefined) next.endedAt = patch.endedAt || '';
  for (const value of [next.startedAt, next.endedAt]) {
    if (value && !Number.isFinite(new Date(value).getTime())) throw new Error('时间格式无效');
  }

  const explicitMin = patch.actualMin !== undefined;
  let requestedMin = null;
  if (explicitMin) {
    if (patch.actualMin === null || patch.actualMin === '') {
      next.actualMin = null;
    } else {
      const n = Number(patch.actualMin);
      // 负数必须报错，不能静默钳成 0 —— 不然用户填错了还以为存上了
      if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw new Error('时长必须在 0 到 24 小时之间');
      requestedMin = Math.round(n);
    }
  }

  const rangeChanged = patch.startedAt !== undefined || patch.endedAt !== undefined;
  if (rangeChanged && next.startedAt && next.endedAt) {
    // 起止时间是明细的来源；同时提交时以时间范围为准，避免字段互相矛盾。
    const a = new Date(next.startedAt).getTime();
    const b = new Date(next.endedAt).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('结束时间必须晚于开始时间');
    next.actualMin = Math.round((b - a) / 60000);
  } else if (explicitMin) {
    next.actualMin = requestedMin;
    // 只改时长时同步结束时间，保持明细与累计耗时一致。
    if (requestedMin !== null && next.startedAt) {
      const startMs = new Date(next.startedAt).getTime();
      if (Number.isFinite(startMs)) next.endedAt = new Date(startMs + requestedMin * 60000).toISOString();
    }
  }

  if (next.actualMin === null || !Number.isFinite(next.actualMin)) {
    throw new Error('实际时长不能为空，也无法从起止时间推出');
  }
  if (next.actualMin > 24 * 60) throw new Error('单条记录的时长不能超过 24 小时');

  // 起止时间跨天时，日期跟着走
  next.date = dateOf(next.startedAt) || dateOf(next.endedAt) || next.date;

  next.edited = true;
  next.editedAt = nowISO();
  next.actualMs = next.actualMin * 60000;
  // 人工改过之后，"自报与计时的差额"就没有意义了
  next.driftMin = null;

  await db.timeEntries.put(next);
  await syncTaskMinutes(next.taskId);
  return next;
}

export async function deleteTimeEntry(id) {
  const cur = await db.timeEntries.get(id);
  if (!cur) throw new Error('找不到这条时间记录');
  await db.timeEntries.delete(id);
  await syncTaskMinutes(cur.taskId);
  return cur;
}

/** 手动补记一段专注（忘了开计时器的补救） */
export async function createManualEntry({
  taskId = '', date = null, startedAt = '', endedAt = '', actualMin = null,
  note = '', outcome = '',
} = {}) {
  let start = startedAt;
  let end = endedAt;
  let minutes = actualMin === null || actualMin === '' ? null : Number(actualMin);
  if (minutes !== null) {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('时长必须是非负数字');
    minutes = Math.round(minutes);
  }

  // 只给了日期 + 时长：补一段 09:00 起的虚拟时间，让它落在正确的日子上
  if (!start && date) start = new Date(`${date}T09:00:00`).toISOString();
  if (!start && minutes === null) throw new Error('至少要给开始时间或时长');

  if (!end && start && minutes !== null) {
    end = new Date(new Date(start).getTime() + minutes * 60000).toISOString();
  }
  if (minutes === null && start && end) {
    const d = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
    if (!Number.isFinite(d) || d <= 0) throw new Error('结束时间必须晚于开始时间');
    minutes = Math.round(d);
  }
  if (minutes === null || !Number.isFinite(minutes)) throw new Error('无法确定时长');
  if (minutes > 24 * 60) throw new Error('单条记录的时长不能超过 24 小时');

  const entry = {
    id: uid('time_'),
    taskId: String(taskId || '').trim(),
    plannedMin: null,
    startedAt: start || '',
    endedAt: end || '',
    actualMin: minutes,
    actualMs: minutes * 60000,
    selfReportedMin: null,
    driftMin: null,
    source: 'manual',
    timerId: null,
    note: String(note || '').trim(),
    outcome: String(outcome || '').trim(),
    date: date || dateOf(start) || dateStr(),
    createdAt: nowISO(),
    edited: true,
    editedAt: nowISO(),
  };
  await db.timeEntries.put(entry);
  await syncTaskMinutes(entry.taskId);
  return entry;
}

/** 今日已记录的实际耗时合计（分钟） */
export async function todayTrackedMinutes(today = dateStr()) {
  const entries = await db.timeEntries.toArray();
  return entries
    .filter(e => e.date === today)
    .reduce((sum, e) => sum + (e.actualMin || 0), 0);
}

/** 计划 vs 实际的偏差统计 —— 用来让用户看见自己的时间感知误差 */
export async function estimationStats(limit = 30) {
  const entries = (await db.timeEntries.toArray())
    .filter(e => e.plannedMin && e.actualMin !== null && e.actualMin !== undefined)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);

  if (!entries.length) {
    return { samples: 0, established: false };
  }
  const ratios = entries.map(e => e.actualMin / e.plannedMin);
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const under = ratios.filter(r => r > 1.25).length;   // 比预估慢很多
  const over = ratios.filter(r => r < 0.75).length;    // 比预估快很多

  return {
    samples: entries.length,
    established: true,
    avgRatio,
    // 人类可读的结论：平均而言他把任务估成了实际的多少
    verdict: avgRatio > 1.25
      ? `平均比预估多用 ${Math.round((avgRatio - 1) * 100)}% 的时间（倾向于低估）`
      : avgRatio < 0.75
        ? `平均比预估少用 ${Math.round((1 - avgRatio) * 100)}% 的时间（倾向于高估）`
        : '预估整体比较准',
    underestimatedCount: under,
    overestimatedCount: over,
  };
}

/** 任务的实际耗时汇总（含自报与计时的差异） */
export async function taskTimeSummary(taskId) {
  const entries = await listTimeEntries({ taskId, limit: 200 });
  const totalActual = entries.reduce((s, e) => s + (e.actualMin || 0), 0);
  const withDrift = entries.filter(e => e.driftMin !== null && e.driftMin !== undefined);
  return {
    entries: entries.length,
    totalActualMin: totalActual,
    hasTimerData: entries.some(e => e.source === 'timer'),
    driftSamples: withDrift.length,
    avgDriftMin: withDrift.length
      ? withDrift.reduce((s, e) => s + e.driftMin, 0) / withDrift.length
      : null,
  };
}
