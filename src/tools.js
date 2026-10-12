// ── 工具集（§五–§十五）────────────────────────────────────
//
// 39 个工具全部实现，**每一轮全量下发**。
//
// 曾经做过"分组按需下发"（核心常驻 + 按意图正则匹配的组），后来移除了 ——
// 见下方 toolsForTurn 的说明。省 token 要靠"别把历史日志全塞进 prompt"，
// 不能靠"把工具藏起来一半"。
//
// 另一个原则：错误不抛给用户，而是回灌给模型让它自己改参数重试。

import {
  db, listTasks, upsertTask, deleteTask, setTaskState, setKeyTasks, keyTaskRecords,
  findOrCreateTopic, upsertTopic, addLog, addMemory, deleteMemory,
  getProfile, saveProfile, getMeta, setMeta, TASK_STATES, PRIORITIES, AREAS,
  ACTIVE_STATES, ADHD_STATUS, PROFILE_LABELS,
} from './db.js';
import { gradeTopic, describeInterval, dueTopics } from './srs.js';
import { searchMemory } from './memory.js';
import {
  startTimer, stopTimer, getActiveTimer, cancelTimer, logTimeEntry,
  listTimeEntries, taskTimeSummary, estimationStats, todayTrackedMinutes,
} from './timer.js';
import {
  awardPoints, getLedger, listPoints, confirmPoints, confirmAllPoints,
  upsertReward, deleteReward, redeemReward, listRewards, POINT_RULES,
} from './ledger.js';
import {
  upsertCheckin, getCheckin, listCheckins, checkinSummary,
  saveReview, listReviews, recordProcrastination, patternStats,
  PROCRASTINATION_PATTERNS, isMedsEnabled, setMedsEnabled,
} from './records.js';
import {
  savePlan, listPlans, getPlan, deletePlan, togglePlanItem, nextPlanAction,
  checkFeasibility, saveSop, listSops, getSop, deleteSop, toggleSopStep,
  SOP_FIELDS, PLAN_STATUSES,
} from './docs.js';
import { computeToday } from './planner.js';
import { addPending } from './pending.js';
import { stageChatWrite } from './chat-approvals.js';
import { buildMarkdownExport, markdownStats } from './exportmd.js';
import { listMicroHabits, changeMicroHabit, getTodayHabitSnapshot } from './microhabit.js';
import { listLifeNavigation, changeLifeNavigation } from './life.js';
import { endOfToday, dateStr, nowISO, daysUntil, download } from './util.js';

/* ══════════════ 辅助 ══════════════ */

async function resolveTask(idOrTitle) {
  if (!idOrTitle) return null;
  const s = String(idOrTitle).trim();
  if (!s) return null;
  const all = await listTasks();
  return all.find(t => t.id === s)
    || all.find(t => t.title === s)
    || all.find(t => t.title.includes(s) || s.includes(t.title))
    || null;
}

async function needTask(idOrTitle) {
  const t = await resolveTask(idOrTitle);
  if (!t) throw new Error(`找不到任务「${idOrTitle}」。先用 list_tasks 看一下有哪些。`);
  return t;
}

async function resolveTopic(idOrName) {
  if (!idOrName) return null;
  const s = String(idOrName).trim();
  const all = await db.topics.toArray();
  return all.find(t => t.id === s)
    || all.find(t => t.name === s)
    || all.find(t => t.name.toLowerCase() === s.toLowerCase())
    || all.find(t => t.name.includes(s) || s.includes(t.name))
    || null;
}

const taskLine = t => {
  const bits = [`\`${t.id}\``, `**${t.title}**`, `${t.state}/${t.priority}`, AREAS[t.area]?.label || t.area];
  if (t.nextAction) bits.push(`下一步：${t.nextAction}`);
  if (t.blocker) bits.push(`阻碍：${t.blocker}`);
  if (t.dueAt) bits.push(`截止 ${t.dueAt}`);
  if (t.estimateMin != null) bits.push(`预计 ${t.estimateMin} 分钟`);
  if (t.actualMin != null) bits.push(`实际 ${t.actualMin} 分钟`);
  if (t.progress) bits.push(`进度 ${t.progress}%`);
  return bits.join('　');
};

const lock = (content, summary, extra = {}) => ({ content, summary, ...extra });

/* ══════════════ 工具实现 ══════════════ */

const IMPL = {
  /* ────────── 任务 ────────── */

  async list_tasks({ state = '', area = '', limit = 30 }) {
    let list = await listTasks();
    if (state) list = list.filter(t => t.state === state.toUpperCase());
    if (area) list = list.filter(t => t.area === area);
    if (!list.length) return lock('没有符合条件的任务。', 'list_tasks → 0');

    const keyIds = (await keyTaskRecords()).map(t => t.id);
    const shown = list.slice(0, limit);
    const body = ['DOING', 'BLOCKED', 'READY', 'NEXT', 'INBOX', 'DEFERRED', 'DONE', 'CANCELLED']
      .map(st => {
        const group = shown.filter(t => t.state === st);
        if (!group.length) return '';
        return `${st}（${TASK_STATES[st].label}）：\n${group.map(t => `${keyIds.includes(t.id) ? '★ ' : '- '}${taskLine(t)}`).join('\n')}`;
      })
      .filter(Boolean).join('\n\n');

    return lock(
      `${list.length} 个任务（★ 是今日关键任务）：\n\n${body}`,
      `list_tasks → ${list.length} 个`,
    );
  },

  async get_task({ id }) {
    const t = await needTask(id);
    const time = await taskTimeSummary(t.id);
    const rows = Object.entries({
      任务ID: t.id, 名称: t.title, 状态: t.state, 优先级: t.priority, 领域: AREAS[t.area]?.label,
      目标: t.goal, 截止时间: t.dueAt, 计划开始: t.plannedStart, 实际开始: t.actualStart,
      实际结束: t.actualEnd, 预计耗时: t.estimateMin != null ? `${t.estimateMin} 分钟` : '',
      实际耗时: t.actualMin != null ? `${t.actualMin} 分钟` : '', 下一步行动: t.nextAction,
      当前阻碍: t.blocker, 情绪: t.mood ? `${t.mood}/5` : '', 注意力: t.attention ? `${t.attention}/5` : '',
      完成情况: t.outcome, 复盘结论: t.review, 进度: `${t.progress ?? 0}%`,
      里程碑: (t.milestones || []).join(' → '), 备注: t.notes,
      创建时间: t.createdAt, 最后更新: t.updatedAt,
    }).filter(([, v]) => v !== '' && v != null);

    const lines = rows.map(([k, v]) => `- ${k}：${v}`);
    lines.push('');
    lines.push(`时间记录：${time.entries} 笔，合计 ${time.totalActualMin} 分钟${time.hasTimerData ? '（含真实计时）' : '（全部为自报）'}`);
    if (time.driftSamples) lines.push(`自报与计时平均差 ${time.avgDriftMin > 0 ? '+' : ''}${Math.round(time.avgDriftMin)} 分钟`);

    return lock(lines.join('\n'), `get_task(${t.title})`);
  },

  async save_task({ id = '', title = '', state, priority, category, area, goal, dueAt, estimateMin,
    plannedStart, nextAction, blocker, progress, milestones, notes, mood, attention, outcome, review }) {
    let target = id ? await resolveTask(id) : null;
    if (!target && title) target = await resolveTask(title);

    const patch = { id: target?.id };
    const set = (k, v) => { if (v !== undefined) patch[k] = v; };
    set('title', title || undefined);
    set('state', state ? String(state).toUpperCase() : undefined);
    set('priority', priority ? String(priority).toUpperCase() : undefined);
    set('category', category);
    set('area', area);
    set('goal', goal); set('dueAt', dueAt); set('plannedStart', plannedStart);
    set('nextAction', nextAction); set('blocker', blocker); set('notes', notes);
    set('outcome', outcome); set('review', review);
    if (estimateMin !== undefined) patch.estimateMin = estimateMin === null || estimateMin === '' ? null : Number(estimateMin);
    if (progress !== undefined) patch.progress = Math.min(100, Math.max(0, Number(progress) || 0));
    if (milestones !== undefined) patch.milestones = Array.isArray(milestones) ? milestones : String(milestones).split('\n');
    if (mood !== undefined) patch.mood = mood === null || mood === '' ? null : Math.min(5, Math.max(1, Number(mood)));
    if (attention !== undefined) patch.attention = attention === null || attention === '' ? null : Math.min(5, Math.max(1, Number(attention)));

    if (!patch.title && !target) throw new Error('新建任务必须提供 title');

    // 走 setTaskState 以便正确推导实际开始/结束时间
    let saved;
    if (patch.state && target && patch.state !== target.state) {
      const { state: newState, ...rest } = patch;
      await upsertTask({ ...rest, id: target.id });
      saved = await setTaskState(target.id, newState);
      await upsertTask({ ...rest, id: target.id }); // 状态之外的其他字段再落一次
      saved = await db.tasks.get(target.id);
    } else {
      saved = await upsertTask(patch);
    }

    // 状态推进相关的记录提醒
    const hints = [];
    if (saved.state === 'BLOCKED' && !saved.blocker) hints.push('⚠️ 标成 BLOCKED 但没写 blocker —— 说清卡在哪才有意义。');
    if (saved.state === 'DOING' && !saved.actualStart) hints.push('⚠️ 标成 DOING 但没有开始时间，建议用 timer_start 记真实开始。');
    if (saved.state === 'DONE' && !saved.outcome) hints.push('提示：可以补一句完成情况（outcome），复盘时有用。');

    return lock(
      `已保存：${taskLine(saved)}${hints.length ? `\n${hints.join('\n')}` : ''}`,
      `save_task(${saved.title})`,
      { refresh: true },
    );
  },

  async set_task_state({ id, state, blocker = '', outcome = '', note = '' }) {
    const t = await needTask(id);
    const st = String(state || '').toUpperCase();
    if (!TASK_STATES[st]) throw new Error(`无效状态 ${state}。可用：${Object.keys(TASK_STATES).join('/')}`);

    const extra = { updatedAt: nowISO() };
    if (blocker) extra.blocker = blocker;
    if (outcome) extra.outcome = outcome;
    if (note) extra.notes = [t.notes, note].filter(Boolean).join('\n');

    const saved = await setTaskState(t.id, st, extra);

    // 顺手记一笔活动，让停滞检测准确
    await addLog({ taskId: t.id, minutes: 0, what: `状态 ${t.state} → ${st}${note ? `：${note}` : ''}` });

    const hints = [];
    if (st === 'DONE') hints.push('已记录完成。记得按 §9 核验：完成内容、实际耗时、是否达到完成标准。');
    if (st === 'BLOCKED' && !saved.blocker) hints.push('⚠️ 现在是 BLOCKED 但没写阻碍是什么，追问一下。');
    if (st === 'DEFERRED') hints.push('延期必须说明原因和新日期，否则就是无限期推到明天。');

    return lock(
      `「${saved.title}」现在状态 ${st}（${TASK_STATES[st].label}）${hints.length ? `\n${hints.join('\n')}` : ''}`,
      `set_task_state(${saved.title} → ${st})`,
      { refresh: true },
    );
  },

  async delete_task({ id }) {
    const t = await needTask(id);
    await deleteTask(t.id);
    return lock(`已删除任务「${t.title}」。知识点、时间记录和学习日志都保留。`, `delete_task(${t.title})`, { refresh: true });
  },

  async set_key_tasks({ ids = [] }) {
    const resolved = [];
    for (const x of ids) {
      const t = await resolveTask(x);
      if (t) resolved.push(t.id);
    }
    if (!resolved.length) throw new Error('至少要指定一个存在的任务');
    if (resolved.length > 3) throw new Error('§5.3：每天最多 3 个关键任务，不要把整个任务池塞进今天');
    const rec = await setKeyTasks(resolved);
    const list = await keyTaskRecords();
    return lock(
      `今日关键任务已设定（${rec.ids.length} 个）：\n${list.map(t => `- ${taskLine(t)}`).join('\n')}`,
      `set_key_tasks(${rec.ids.length})`,
      { refresh: true },
    );
  },

  /* ────────── 计时（§九）────────── */

  async timer_start({ task = '', plannedMin = null, note = '' }) {
    let t = task ? await resolveTask(task) : null;
    if (task && !t) throw new Error(`找不到任务「${task}」`);
    if (!t) {
      const keyTasks = await keyTaskRecords();
      if (keyTasks.length === 1) t = keyTasks[0];
    }
    const timer = await startTimer({ taskId: t?.id || '', plannedMin, note: note || (t ? '' : '') });
    return lock(
      `计时已开始：**${timer.label}**\n开始时间：${timer.startedAt.slice(0, 19).replace('T', ' ')}\n`
      + `${timer.plannedMin ? `计划 ${timer.plannedMin} 分钟\n` : ''}`
      + '让用户自己设个闹钟（我做不到主动提醒）。做完回来汇报，我会算出真实耗时。',
      `timer_start(${timer.label})`,
      { refresh: true },
    );
  },

  async timer_stop({ note = '', selfReportedMin = null, outcome = '', discard = false }) {
    if (discard) {
      const a = await cancelTimer();
      return lock(`已放弃计时（${a.label}，跑了 ${a.elapsedText}），没有留下记录。`, 'timer_stop(discard)', { refresh: true });
    }
    const r = await stopTimer({ note, selfReportedMin, outcome });
    const lines = [
      `计时结束。`,
      `- 实际耗时（墙钟）：**${r.actualMin} 分钟**`,
    ];
    if (r.plannedMin) {
      const diff = r.actualMin - r.plannedMin;
      lines.push(`- 计划耗时：${r.plannedMin} 分钟　→　相差 ${diff > 0 ? '+' : ''}${diff} 分钟（${diff > 0 ? '比预估慢' : diff < 0 ? '比预估快' : '完全吻合'}）`);
    }
    if (r.selfReportedMin !== null) {
      lines.push(`- 用户自报：${r.selfReportedMin} 分钟　→　与计时差 **${r.driftMin > 0 ? '+' : ''}${r.driftMin} 分钟**`);
      if (Math.abs(r.driftMin) >= 5) {
        lines.push('⚠️ 自报和计时差距明显。不要直接认定他说谎，按 §9.3 问一句："这个耗时比预期短/长很多，你完成了全部内容还是其中一部分？"');
      }
    }
    lines.push('');
    lines.push('按 §9 继续核验：完成内容是什么？是否达到完成标准？要不要更新任务状态？');
    return lock(lines.join('\n'), `timer_stop(${r.actualMin}min)`, { refresh: true });
  },

  async timer_status({}) {
    const t = await getActiveTimer();
    const est = await estimationStats();
    const todayMin = await todayTrackedMinutes();
    const lines = [];
    if (t) {
      lines.push(`**计时中**：${t.label}`);
      lines.push(`- 开始于 ${t.startedAt.slice(0, 19).replace('T', ' ')}`);
      lines.push(`- 已过 **${t.elapsedText}**`);
      if (t.plannedMin) lines.push(`- 计划 ${t.plannedMin} 分钟，${t.overPlanned ? `**已超时 ${t.elapsedMin - t.plannedMin} 分钟**` : `还剩 ${t.remainingMin} 分钟`}`);
      if (t.stale) lines.push('- ⚠️ 超过 8 小时，大概率忘了停，先确认一下。');
    } else {
      lines.push('当前没有正在运行的计时。');
    }
    lines.push('');
    lines.push(`今日已记录实际耗时：${todayMin} 分钟`);
    lines.push(est.established
      ? `预估能力：${est.samples} 个样本，${est.verdict}`
      : '预估能力：样本不足，还看不出他估时的偏差倾向。');
    return lock(lines.join('\n'), t ? `timer_status(${t.elapsedText})` : 'timer_status(无)');
  },

  async log_time_entry({ task = '', minutes, selfReportedMin = null, note = '', outcome = '', startedAt = '', endedAt = '' }) {
    const t = task ? await resolveTask(task) : null;
    if (task && !t) throw new Error(`找不到任务「${task}」`);
    const entry = await logTimeEntry({ taskId: t?.id || '', minutes, selfReportedMin, note, outcome, startedAt, endedAt });
    return lock(
      `已记录一笔${entry.source === 'reported_range' ? '起止时间' : '自报'}耗时：${entry.actualMin ?? entry.selfReportedMin} 分钟`
      + `${t ? `（任务：${t.title}）` : ''}${note ? `　备注：${note}` : ''}\n`
      + '注意：这不是计时结果，是用户报告的时间。核验时要说清来源。',
      `log_time_entry(${entry.actualMin ?? entry.selfReportedMin}min)`,
      { refresh: true },
    );
  },

  /* ────────── 积分（§十二）────────── */

  async get_ledger({ includeRewards = true }) {
    const ledger = await getLedger({ recentLimit: 15 });
    if (!ledger.established) {
      return lock(
        '**尚未建立积分账本。** 没有任何积分记录，不要虚构任何历史积分。\n'
        + '要用的话就从现在开始记：完成任务 +3（关键）/+1（普通），按计划开始 +1，主动报告阻碍 +1，完成每日复盘 +1。',
        'get_ledger(未建立)',
      );
    }
    const lines = [
      `累计积分：**${ledger.total}**（已确认 ${ledger.confirmedTotal}，待确认 ${ledger.pendingTotal}）`,
      `今天：${ledger.todayDelta > 0 ? '+' : ''}${ledger.todayDelta}　共 ${ledger.count} 笔`,
    ];
    if (ledger.unconfirmed.length) lines.push(`\n⚠️ ${ledger.unconfirmed.length} 笔尚未经用户确认：`);
    for (const e of ledger.unconfirmed.slice(0, 5)) lines.push(`- \`${e.id}\` ${e.date} ${e.delta > 0 ? '+' : ''}${e.delta} ${e.reason}`);

    lines.push('\n最近记录：');
    for (const e of ledger.recent.slice(0, 10)) {
      lines.push(`- ${e.date}　${e.delta > 0 ? '+' : ''}${e.delta}　${e.reason}${e.confirmed ? '' : '（未确认）'}`);
    }

    if (includeRewards) {
      const rewards = await listRewards();
      lines.push(`\n可兑换奖励：${rewards.length ? '' : '（还没设置）'}`);
      for (const r of rewards) lines.push(`- \`${r.id}\` ${r.name}　${r.cost} 分${r.note ? `　${r.note}` : ''}`);
    }
    return lock(lines.join('\n'), `get_ledger(${ledger.total})`);
  },

  async award_points({ ruleKey = '', delta = null, reason, task = '', confirmed = false }) {
    const t = task ? await resolveTask(task) : null;
    const entry = await awardPoints({
      ruleKey: ruleKey || undefined,
      delta: delta === null ? undefined : Number(delta),
      kind: delta !== null && Number(delta) < 0 ? 'penalty' : 'task',
      reason,
      taskId: t?.id || '',
      confirmed,
    });
    return lock(
      `已记账：${entry.delta > 0 ? '+' : ''}${entry.delta}　${entry.reason}${entry.confirmed ? '' : '（**待用户确认**）'}\n`
      + '提醒：这只是记录，不代表任何真实惩罚或权限限制。',
      `award_points(${entry.delta})`,
      { refresh: true },
    );
  },

  async confirm_points({ id = '', all = false }) {
    if (all) {
      const n = await confirmAllPoints();
      return lock(`已确认全部 ${n} 笔积分。`, `confirm_points(全部 ${n} 笔)`, { refresh: true });
    }
    if (!id) throw new Error('需要提供 id，或设 all=true 确认全部');
    const e = await confirmPoints(id, true);
    return lock(`已确认：${e.date} ${e.delta > 0 ? '+' : ''}${e.delta} ${e.reason}`, 'confirm_points', { refresh: true });
  },

  async upsert_reward({ id = '', name = '', cost = null, note = '', remove = false }) {
    if (remove) {
      if (!id) throw new Error('删除需要 id');
      await deleteReward(id);
      return lock('已删除该奖励。', 'upsert_reward(删除)', { refresh: true });
    }
    const r = await upsertReward({ id: id || undefined, name, cost, note });
    return lock(`已保存奖励：${r.name}　${r.cost} 分${r.note ? `　${r.note}` : ''}`, `upsert_reward(${r.name})`, { refresh: true });
  },

  async redeem_reward({ id }) {
    const r = await redeemReward(id);
    return lock(
      `已兑换「${r.reward.name}」，扣 ${r.reward.cost} 分，剩余 ${r.remaining} 分。\n`
      + '这是应得的，好好享受，不用有负罪感。',
      `redeem_reward(${r.reward.name})`,
      { refresh: true },
    );
  },

  /* ────────── 生活打卡（§十三）────────── */

  async save_checkin({ date = '', medsEnabled, ...fields }) {
    if (medsEnabled !== undefined) await setMedsEnabled(medsEnabled);
    const rec = await upsertCheckin(fields, { date: date || undefined });
    const filled = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '' && v !== null);
    return lock(
      `打卡已记录（${rec.date}）：\n${filled.map(([k, v]) => `- ${k}：${v}`).join('\n') || '（本次没填任何字段）'}\n`
      + '用户可以跳过任何项目，不要追问没填的。',
      `save_checkin(${rec.date})`,
      { refresh: true },
    );
  },

  async get_checkin({ date = '', days = 0 }) {
    if (days > 0) {
      const summary = await checkinSummary(days);
      const list = (await listCheckins(days)).slice(0, days);
      if (!summary.established) return lock(`最近 ${days} 天没有任何打卡记录。`, 'get_checkin(无记录)');
      const lines = [`近 ${summary.samples} 天（${summary.from} → ${summary.to}）：`];
      if (summary.avgSleep) lines.push(`- 平均睡眠 ${summary.avgSleep.toFixed(1)} 小时`);
      if (summary.avgEnergy) lines.push(`- 平均精力 ${summary.avgEnergy.toFixed(1)}/5`);
      if (summary.avgAttention) lines.push(`- 平均注意力 ${summary.avgAttention.toFixed(1)}/5`);
      if (summary.avgMood) lines.push(`- 平均情绪 ${summary.avgMood.toFixed(1)}/5`);
      if (summary.note) lines.push(`- ${summary.note}`);
      lines.push('');
      lines.push('提示：睡眠/精力与执行力的关联可以说，但相关不等于因果，不要拿它当借口也不要下诊断。');
      lines.push('');
      for (const c of list) {
        lines.push(`${c.date}：${[c.sleepHours ? `睡眠${c.sleepHours}h` : '', c.mood ? `情绪${c.mood}` : '', c.attention ? `注意力${c.attention}` : '', c.topTask || ''].filter(Boolean).join('　')}`);
      }
      return lock(lines.join('\n'), `get_checkin(${days} 天趋势)`);
    }

    const c = await getCheckin(date || dateStr());
    if (!c) return lock(`${date || '今天'}没有打卡记录。`, 'get_checkin(无)');
    const rows = Object.entries(c)
      .filter(([k, v]) => !['id', 'date', 'createdAt', 'updatedAt'].includes(k) && v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => `- ${k}：${v}`);
    return lock(`${c.date} 打卡：\n${rows.join('\n')}`, 'get_checkin');
  },

  /* ────────── 复盘 / 拖延（§十、§十一）────────── */

  async save_review({ kind = 'blackroom', date = '', planned = '', actual = '', deviationStart = '',
    whatHappened = '', triggers = [], thoughts = [], reframes = [], action, lesson = '', task = '' }) {
    const t = task ? await resolveTask(task) : null;
    const rec = await saveReview({
      kind, date: date || undefined,
      facts: { planned, actual, deviationStart, whatHappened },
      triggers, thoughts, reframes, action, lesson,
      taskId: t?.id || '',
    });
    return lock(
      `复盘已保存（${rec.kind}，${rec.date}）。\n`
      + `- 事实：${rec.facts.whatHappened || '（未填）'}\n`
      + `- 触发因素：${rec.triggers.join('、') || '（未填）'}\n`
      + `- 重构：${rec.reframes.join(' / ') || '（未填）'}\n`
      + `- **立即行动：${rec.action}**\n`
      + (rec.lesson ? `- 预防措施：${rec.lesson}\n` : '')
      + '\n§11 要求：不要让复盘变成没有行动出口的自我批评。最后确认一下他会不会真的去做那个 action。',
      `save_review(${rec.kind})`,
      { refresh: true },
    );
  },

  async record_procrastination({ pattern, evidence = '', intervention = '', outcome = '', task = '' }) {
    const t = task ? await resolveTask(task) : null;
    const rec = await recordProcrastination({ pattern, evidence, intervention, outcome, taskId: t?.id || '' });
    const info = PROCRASTINATION_PATTERNS[rec.pattern];
    const stats = await patternStats();
    const lines = [
      `已记录拖延模式：**${rec.pattern} ${info.label}**（应对：${info.fix}）`,
    ];
    if (stats.established && stats.top) {
      lines.push(`目前最常见的模式是 ${stats.top.pattern} ${stats.top.label}，共 ${stats.top.count} 次。`);
    }
    return lock(lines.join('\n'), `record_procrastination(${rec.pattern})`, { refresh: true });
  },

  async list_reviews({ kind = '', limit = 20 }) {
    const list = await listReviews({ kind: kind || undefined, limit });
    const stats = await patternStats();
    const lines = [];
    if (stats.established) {
      lines.push(`拖延模式统计（共 ${stats.samples} 次）：`);
      for (const c of stats.counts) lines.push(`- ${c.pattern} ${c.label}：${c.count} 次　应对：${c.fix}`);
      lines.push('');
    }
    if (!list.length) return lock(`${lines.join('\n')}还没有复盘记录。`, 'list_reviews(0)');
    lines.push(`${list.length} 条复盘记录：`);
    for (const r of list) {
      lines.push(`- \`${r.id}\` ${r.date} [${r.kind}]${r.pattern ? ` 模式${r.pattern}` : ''} ${r.facts?.whatHappened || r.action || ''}`);
    }
    return lock(lines.join('\n'), `list_reviews(${list.length})`);
  },

  /* ────────── 规划（§十四）────────── */

  async save_plan({ id = '', name, goal = '', deadline = '', availableMin = null, constraints = '',
    items = [], breaks = '', risks = [], fallback = '', doneCriteria = '', status }) {
    const { plan, feasibility } = await savePlan({
      id: id || undefined, name, goal, deadline, availableMin, constraints,
      items, breaks, risks, fallback, doneCriteria, status,
    });
    const lines = [
      `已保存规划 **${plan.code}｜${plan.name}**`,
      '',
      feasibility.verdict,
      '',
      '任务项：',
      ...plan.items.map((it, i) =>
        `${i + 1}. ${it.done ? '✓' : '·'} ${it.text}${it.estMin ? `（${it.estMin} 分钟）` : ''}${it.minAction ? `　启动动作：${it.minAction}` : ''}`),
    ];
    if (feasibility.feasible === false) {
      lines.push('');
      lines.push('⚠️ §14 第四轮要求：**必须先缩减范围再开始**，不要维持一个不可能完成的计划然后责怪自己。');
    }
    const next = nextPlanAction(plan);
    if (next) lines.push(`\n下一步：**${next.startWith}**`);
    return lock(lines.join('\n'), `save_plan(${plan.code})`, { refresh: true });
  },

  async list_plans({ status = '' }) {
    const list = await listPlans({ status: status || undefined });
    if (!list.length) return lock('还没有任何规划。', 'list_plans(0)');
    const lines = list.map(p => {
      const items = p.items || [];
      const done = items.filter(i => i.done).length;
      const over = p.feasibility?.feasible === false ? '　⚠️ 过载' : '';
      return `- \`${p.id}\` **${p.code}｜${p.name}**　${PLAN_STATUSES[p.status]?.label || p.status}　${done}/${items.length} 项完成${over}`;
    });
    return lock(lines.join('\n'), `list_plans(${list.length})`);
  },

  async get_plan({ id, toggleIndex = null }) {
    let plan = id ? await getPlan(id) : null;
    if (!plan) {
      const list = await listPlans({});
      plan = list[0];
      if (!plan) throw new Error('还没有任何规划');
    }
    if (toggleIndex !== null && toggleIndex !== undefined && toggleIndex !== '') {
      plan = await togglePlanItem(plan.id, Number(toggleIndex));
    }
    const feas = checkFeasibility(plan);
    const next = nextPlanAction(plan);
    const lines = [
      `**${plan.code}｜${plan.name}**　${PLAN_STATUSES[plan.status]?.label || plan.status}`,
      plan.goal ? `目标：${plan.goal}` : '',
      plan.deadline ? `截止：${plan.deadline}` : '',
      plan.availableMin ? `可用时间：${plan.availableMin} 分钟` : '',
      plan.constraints ? `约束：${plan.constraints}` : '',
      '',
      feas.verdict,
      '',
      '任务项：',
      ...(plan.items || []).map((it, i) => `${i + 1}. ${it.done ? '✓' : '·'} ${it.text}${it.estMin ? `（${it.estMin} 分钟）` : ''}${it.minAction ? `　启动：${it.minAction}` : ''}`),
    ];
    if (plan.breaks) lines.push('', `休息安排：${plan.breaks}`);
    if ((plan.risks || []).length) lines.push(`可能阻碍：${plan.risks.join('、')}`);
    if (plan.fallback) lines.push(`备用方案：${plan.fallback}`);
    if (plan.doneCriteria) lines.push(`完成标准：${plan.doneCriteria}`);
    if (next) lines.push('', `**下一步：${next.startWith}**（第 ${next.index + 1} 项）`);
    return lock(lines.filter(x => x !== '').join('\n'), `get_plan(${plan.code})`, { refresh: true });
  },

  /* ────────── SOP（§十五）────────── */

  async save_sop({ id = '', name, scene = '', goal = '', materials = [], estimateMin = null,
    prep = [], steps = [], blockers = [], exceptions = '', doneCriteria = '',
    checklist = [], review = '', quickStart = '' }) {
    const sop = await saveSop({
      id: id || undefined, name, scene, goal, materials, estimateMin, prep, steps,
      blockers, exceptions, doneCriteria, checklist, review, quickStart,
    });
    return lock(
      `已保存 SOP：**${sop.name}**（${sop.steps.length} 个步骤）\n`
      + `一分钟启动版：**${sop.quickStart}**\n`
      + '提醒：启动困难的时候直接用那个一分钟版本，不要从头看步骤。',
      `save_sop(${sop.name})`,
      { refresh: true },
    );
  },

  async list_sops({}) {
    const list = await listSops({});
    if (!list.length) return lock('还没有任何 SOP。', 'list_sops(0)');
    return lock(
      list.map(s => `- \`${s.id}\` **${s.name}**　${s.scene || ''}　${s.steps?.length || 0} 步　启动版：${s.quickStart || '（缺）'}`).join('\n'),
      `list_sops(${list.length})`,
    );
  },

  async get_sop({ id, toggleStep = null, field = 'steps' }) {
    let sop = id ? await getSop(id) : null;
    if (!sop) {
      const list = await listSops({});
      sop = list[0];
      if (!sop) throw new Error('还没有任何 SOP');
    }
    if (toggleStep !== null && toggleStep !== undefined && toggleStep !== '') {
      sop = await toggleSopStep(sop.id, field, Number(toggleStep));
    }
    const lines = [
      `# ${sop.name}`,
      sop.scene ? `适用场景：${sop.scene}` : '',
      sop.goal ? `执行目标：${sop.goal}` : '',
      (sop.materials || []).length ? `所需材料：${sop.materials.join('、')}` : '',
      sop.estimateMin ? `预计耗时：${sop.estimateMin} 分钟` : '',
      (sop.prep || []).length ? `执行前准备：${sop.prep.join('、')}` : '',
      '',
      `**一分钟启动版：${sop.quickStart}**`,
      '',
      '详细步骤：',
      ...(sop.steps || []).map((s, i) => `${i + 1}. ${s.done ? '☑' : '☐'} ${s.text}`),
    ];
    if ((sop.blockers || []).length) lines.push('', `常见阻碍：${sop.blockers.join('、')}`);
    if (sop.exceptions) lines.push(`异常处理：${sop.exceptions}`);
    if (sop.doneCriteria) lines.push(`完成标准：${sop.doneCriteria}`);
    if ((sop.checklist || []).length) {
      lines.push('', '检查清单：');
      for (const c of sop.checklist) lines.push(`- ${c.done ? '[x]' : '[ ]'} ${c.text}`);
    }
    if (sop.review) lines.push('', `复盘与改进：${sop.review}`);
    return lock(lines.filter(x => x !== '').join('\n'), `get_sop(${sop.name})`, { refresh: true });
  },

  /* ────────── 档案（§四）────────── */

  async get_profile({}) {
    const p = await getProfile();
    const rows = Object.entries({
      userName: '称呼', supervisorName: '监督员称呼', supervisorImage: '偏好形象',
      adhdStatus: `ADHD 状态（${ADHD_STATUS[p.adhdStatus] || '未记录'}）`,
      topProblems: '最困扰的三个问题', focusAreas: '重点监督', procrastinationPatterns: '常见拖延行为',
      rewardPreference: '有效奖励', acceptableCorrections: '可接受纠偏', selfWords: '自我描述',
      otherNeeds: '其他需求', about: '个人背景', goals: '个人目标',
      toneLevel: '表达强度', allowProfanity: '粗口授权',
    }).filter(([k]) => p[k] !== '' && p[k] != null)
      .map(([k, label]) => `- ${label}：${p[k]}`);
    if ((p.taboos || []).length) rows.push(`- 雷区：${p.taboos.join('；')}`);
    if (!rows.length) return lock('档案是空的。按 §4 开始初始化，每轮问 1-3 个问题。', 'get_profile(空)');
    return lock(rows.join('\n'), 'get_profile');
  },

  async update_profile(args) {
    const patch = {};
    for (const k of ['userName', 'supervisorName', 'supervisorImage', 'adhdStatus', 'topProblems',
      'focusAreas', 'procrastinationPatterns', 'rewardPreference', 'acceptableCorrections',
      'selfWords', 'otherNeeds', 'about', 'goals']) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) patch[k] = v.trim();
    }
    if (args.taboos !== undefined) {
      patch.taboos = Array.isArray(args.taboos)
        ? args.taboos.map(String).filter(Boolean)
        : String(args.taboos).split(/[；;\n]/).map(s => s.trim()).filter(Boolean);
    }
    if (args.toneLevel !== undefined) patch.toneLevel = Math.min(5, Math.max(1, Number(args.toneLevel) || 5));
    if (args.allowProfanity !== undefined) patch.allowProfanity = Boolean(args.allowProfanity);
    if (args.markOnboarded) patch.onboardedAt = nowISO();

    if (!Object.keys(patch).length) throw new Error('没有提供任何要更新的字段');

    await saveProfile(patch);

    // 回执里带上"改成了什么"，界面据此弹提示 ——
    // 否则用户说完称呼，只能靠自己翻档案面板确认到底存没存上。
    const readable = Object.entries(patch)
      .filter(([k]) => k !== 'onboardedAt')
      .map(([k, v]) => `${PROFILE_LABELS[k] || k} → ${Array.isArray(v) ? v.join('；') : v}`);
    const toastText = readable.length
      ? `档案已更新：${readable.slice(0, 3).join('；')}${readable.length > 3 ? ` 等 ${readable.length} 项` : ''}`
      : '档案已更新';

    return lock(
      `档案已更新：\n${Object.entries(patch).map(([k, v]) => `- ${k}：${Array.isArray(v) ? v.join('；') : v}`).join('\n')}\n\n`
      + '界面右侧「档案」面板随时能看到当前值。',
      `update_profile(${Object.keys(patch).join(',')})`,
      { refresh: true, toast: toastText },
    );
  },

  /* ────────── 暂停监督（§三）────────── */

  async suspend_supervision({ until = '', reason = '' }) {
    let value = 'indefinite';
    if (until) {
      const d = new Date(until);
      if (Number.isNaN(d.getTime())) throw new Error('until 必须是可解析的时间，或留空表示一直暂停到用户解除');
      value = d.toISOString();
    }
    await saveProfile({ suspendUntil: value });
    return lock(
      `监督已暂停（${value === 'indefinite' ? '直到用户解除' : value.slice(0, 16)}）。${reason ? `原因：${reason}\n` : ''}`
      + '接下来只回应他说的，不催任务、不算积分、不做复盘、不用冷嘲。\n'
      + '这是 §3 的安全要求，优先级高于人设和语气强度设定。',
      'suspend_supervision',
      { refresh: true, suspended: true },
    );
  },

  async resume_supervision({}) {
    await saveProfile({ suspendUntil: null });
    return lock('监督已恢复。可以正常推进任务了 —— 但先问一句他现在状态怎么样，别一上来就催。', 'resume_supervision', { refresh: true });
  },

  /* ────────── 长期记忆 ────────── */

  async save_memory({ text, kind = 'fact', importance = 3, tags = [] }) {
    const mem = await addMemory({
      text,
      kind: ['fact', 'insight', 'preference', 'summary'].includes(kind) ? kind : 'fact',
      importance: Math.min(5, Math.max(1, Number(importance) || 3)),
      tags: Array.isArray(tags) ? tags.slice(0, 6).map(String) : [],
    });
    return lock(`已写入长期记忆（${mem.kind}，重要度 ${mem.importance}/5）：${mem.text}`, `save_memory(${mem.text.slice(0, 20)}…)`, { refresh: true });
  },

  async search_memory({ query, limit = 8 }) {
    const hits = await searchMemory(query, { limit: Math.min(20, Math.max(1, Number(limit) || 8)) });
    if (!hits.length) {
      return lock(`没有找到跟「${query}」相关的记录。**不要编造**，直接说没记到。`, `search_memory("${query}") → 0`);
    }
    return lock(
      `找到 ${hits.length} 条：\n${hits.map((h, i) => `${i + 1}. [${h.title}｜${(h.when || '').slice(0, 10)}] ${h.text}`).join('\n')}`,
      `search_memory("${query}") → ${hits.length}`,
    );
  },

  async list_memories({ limit = 30 }) {
    const all = await db.memories.toArray();
    const sorted = all
      .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3) || (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, Math.min(60, Number(limit) || 30));
    if (!sorted.length) return lock('还没有任何长期记忆。', 'list_memories(0)');
    return lock(
      sorted.map(m => `\`${m.id}\` [${m.kind}/重要度${m.importance}] ${m.text}`).join('\n'),
      `list_memories(${sorted.length})`,
    );
  },

  async forget_memory({ id }) {
    const mem = await db.memories.get(String(id).trim());
    if (!mem) throw new Error('找不到这条记忆');
    await deleteMemory(mem.id);
    return lock(`已删除记忆：${mem.text}`, 'forget_memory', { refresh: true });
  },

  /* ────────── 学习模块 ────────── */

  async log_study({ topic, minutes = 0, what = '', blockers = '', task = '', grade = null }) {
    const t = task ? await resolveTask(task) : null;
    const topicRec = await findOrCreateTopic(topic, { taskId: t?.id || '' });
    let extra = '';
    const g = grade === null || grade === '' ? null : Number(grade);
    if (g !== null && Number.isFinite(g) && g >= 0 && g <= 5) {
      const r = await gradeTopic(topicRec.id, g, { minutes, note: what || `学习「${topicRec.name}」` });
      extra = `　→ 自评 ${g}/5，下次复习安排在${describeInterval(r.dueInDays)}`;
    } else {
      await addLog({
        topicId: topicRec.id, topicName: topicRec.name,
        taskId: topicRec.taskId || t?.id || '', minutes,
        what: what || `学习「${topicRec.name}」`, blockers,
      });
    }
    const lines = [`已记录：${topicRec.name}　${minutes} 分钟　${what}${extra}`];
    if (blockers) lines.push(`卡点：${blockers}`);
    if (t) lines.push(`关联任务：${t.title}（状态 ${t.state}，进度 ${t.progress ?? 0}%）`);
    return lock(lines.join('\n'), `log_study(${topicRec.name}, ${minutes}min)`, { refresh: true });
  },

  async grade_review({ topic, grade, note = '' }) {
    const g = Number(grade);
    if (!Number.isFinite(g) || g < 0 || g > 5) throw new Error('grade 必须是 0-5');
    const topicRec = await resolveTopic(topic);
    if (!topicRec) throw new Error(`找不到知识点「${topic}」。要新建用 add_topic。`);
    const r = await gradeTopic(topicRec.id, g, { note });
    return lock(
      `「${topicRec.name}」评分 ${g}/5，掌握度 ${r.topic.mastery}/5，下次复习${describeInterval(r.dueInDays)}。`,
      `grade_review(${topicRec.name}, ${g}/5)`,
      { refresh: true },
    );
  },

  async add_topic({ name, task = '', note = '' }) {
    const existing = await resolveTopic(name);
    if (existing) {
      return lock(`知识点「${existing.name}」已存在（掌握度 ${existing.mastery ?? 0}/5）。`, `add_topic(${existing.name})已存在`, { refresh: true });
    }
    const t = task ? await resolveTask(task) : null;
    const rec = await upsertTopic({ name, taskId: t?.id || '', note });
    return lock(`已新建知识点「${rec.name}」，首次复习安排到明天${t ? `，归属任务「${t.title}」` : ''}。`, `add_topic(${rec.name})`, { refresh: true });
  },

  async list_topics({ dueOnly = false }) {
    const all = await db.topics.toArray();
    const list = dueOnly ? dueTopics(all, endOfToday()) : all;
    if (!list.length) return lock(dueOnly ? '今天没有到期复习。' : '还没有知识点。', 'list_topics(0)');
    return lock(
      list.slice(0, 60).map(t =>
        `- \`${t.id}\` ${t.name}　掌握度 ${t.mastery ?? 0}/5　下次复习 ${(t.nextReviewAt || '').slice(0, 10)}${t.note ? `　${t.note}` : ''}`).join('\n'),
      `list_topics(${list.length})`,
    );
  },

  async list_micro_habits({}) {
    const habits = listMicroHabits();
    if (!habits.length) return lock('还没有设置微习惯。', 'list_micro_habits(0)');
    const todayIds = getTodayHabitSnapshot().doneIds;
    return lock(habits.map(habit => `- ${habit.title}（${habit.active ? '启用' : '停用'}；今天${todayIds.has(habit.id) ? '已完成' : '未完成'}；id: ${habit.id}）`).join('\n'), `list_micro_habits(${habits.length})`);
  },

  async manage_micro_habit({ action, id = '', title = '', date = '' }) {
    const habit = changeMicroHabit({ action, id, title, date: date || dateStr() });
    const labels = { add: '新增', update: '修改', delete: '删除', complete: '标记完成', uncomplete: '取消完成', activate: '启用', deactivate: '停用' };
    return lock(`已${labels[action]}微习惯「${habit.title}」。`, `manage_micro_habit(${action}:${habit.title})`, { refresh: true });
  },

  async manage_life_navigation({ action, kind = '', id = '', target = '', text = '' }) {
    if (action === 'list') {
      const data = listLifeNavigation();
      const kinds = kind ? [kind] : Object.keys(data);
      const labels = { mainlines: '主线', principles: '原则', interests: '兴趣', boredom: '无聊清单' };
      const lines = kinds.map(key => {
        if (!data[key]) throw new Error(`生活导航类型无效：${key}`);
        return `## ${labels[key]}\n${data[key].length ? data[key].map(item => `- ${item?.title || item?.content || item?.text || ''}（id: ${item.id}）`).join('\n') : '（暂无内容）'}`;
      });
      return lock(lines.join('\n\n'), `manage_life_navigation(list:${kind || 'all'})`);
    }
    const item = changeLifeNavigation({ action, kind, id: id || target, text });
    const value = item?.title || item?.content || item?.text || text;
    const labels = { add: '新增', update: '修改', delete: '删除' };
    return lock(`已${labels[action]}生活导航中的「${value}」。`, `manage_life_navigation(${action}:${kind})`, { refresh: true });
  },

  /* ────────── 导出与界面导航 ──────────
     这两个动作以前**只**能通过 commands.js 的正则触发，模型自己没有工具。
     于是"帮我把记录导出来"匹配不到正则 → 交给模型 → 模型手上没这个能力，
     要么说"我做不到"（那还好），要么编一句"已导出"（那就成了静默失败）。
     给它们补上工具，能力就不再被正则把守。 */

  async export_records({ includeAll = false }) {
    const stats = await buildMarkdownExportStats(includeAll);
    return lock(
      `已生成并开始下载结构化 Markdown 记录：${stats.lines} 行、约 ${stats.chars} 字符。\n`
      + '内容包含：用户档案、任务与状态、计划与实际时间、生活打卡、积分账本、规划、SOP、'
      + '复盘与拖延模式、知识点、下次继续监督的事项、数据说明。\n'
      + '这份文档是自包含的，用户换到别的 AI 会话时整份贴进去就能接着用。',
      `export_records(${stats.lines} 行)`,
      { toast: `已导出记录（${stats.lines} 行）`, refresh: false },
    );
  },

  async open_panel({ panel }) {
    const key = String(panel || '').trim().toLowerCase();
    if (!PANEL_IDS.includes(key)) {
      throw new Error(`没有这个面板：${panel}。可用：${PANEL_IDS.join(' / ')}`);
    }
    return lock(
      `已帮用户打开「${PANEL_IDS_LABEL[key]}」面板。`,
      `open_panel(${key})`,
      { openPanel: key },
    );
  },

  /* ────────── 汇总（§十六）────────── */

  async get_daily_summary({}) {
    const s = await computeToday();
    const lines = [
      `## 已确认事实（代码从数据库算出，不是推测）`,
      `- 日期：${s.today}`,
      `- 任务：共 ${s.tasks.length} 个　进行中 ${s.active.length}　受阻 ${s.blocked.length}　今天完成 ${s.doneToday.length}`,
      s.keyTaskIds.length
        ? `- 今日关键任务：${s.keyTasks.map(t => `${t.state === 'DONE' ? '✓' : '·'} ${t.title}`).join('　')}`
        : '- 今日关键任务：未指定',
      `- 时间：自报学习 ${s.studyMinutes} 分钟，计时记录 ${s.trackedMinutes} 分钟`,
      `- 连续记录天数：${s.streak}`,
      `- 积分：${s.ledger.established ? `${s.ledger.total} 分（${s.ledger.count} 笔）` : '**尚未建立积分账本**'}`,
      `- 打卡：今天${s.checkin ? '已打卡' : '未打卡'}`,
      `- 复习：${s.dueCount} 个到期　知识点共 ${s.topicCount ?? s.topics.length} 个`,
      `- 预估能力：${s.estimation.established ? s.estimation.verdict : '样本不足'}`,
    ];

    if (s.blocked.length) lines.push('', '## 受阻', ...s.blocked.map(t => `- ${t.title}：${t.blocker || '⚠️ 未写原因'}`));
    if (s.overdue.length) lines.push('', '## 逾期', ...s.overdue.map(t => `- ${t.title}（逾期 ${t.overdueDays} 天）`));
    if (s.stalled.length) lines.push('', '## 停滞（中性陈述，不是失败判定）', ...s.stalled.map(t => `- ${t.title}：${t.idleDays} 天没动`));
    if (s.patterns?.established) {
      lines.push('', '## 拖延模式', `- 最常见：${s.patterns.top.pattern} ${s.patterns.top.label}（${s.patterns.top.count} 次）`);
    }
    if (s.estimation.established) lines.push('', `## 时间感知`, `- ${s.estimation.verdict}`);
    if (s.integrity.length) {
      lines.push('', '## 数据需要核对');
      for (const i of s.integrity) lines.push(`- ${i.text}`);
    }

    return lock(lines.join('\n'), 'get_daily_summary');
  },
};

/* ══════════════ 导出与导航的辅助 ══════════════ */

/** 面板 id。要与 panels.js 的 PANELS 保持一致；main.js 会忽略未知值，所以不会崩。 */
const PANEL_IDS = ['today', 'learning', 'habits', 'life', 'records', 'tasks', 'checkin', 'points', 'plans', 'sops', 'reviews', 'profile'];
const PANEL_IDS_LABEL = {
  today: '今日', learning: '学习', habits: '微习惯', life: '生活导航', records: '记录', tasks: '任务', checkin: '打卡',
  points: '积分', plans: '规划', sops: 'SOP', reviews: '复盘', profile: '档案',
};

/** 生成 Markdown 并触发下载。终端环境（测试）里没有 document，就只生成不下载。 */
async function buildMarkdownExportStats(includeAll) {
  const md = await buildMarkdownExport({ includeAll });
  const stats = markdownStats(md);
  if (typeof document !== 'undefined' && typeof URL?.createObjectURL === 'function') {
    download(`帕尼尼监督记录-${dateStr()}.md`, md, 'text/markdown');
  }
  return stats;
}

/* ══════════════ 工具定义 ══════════════ */

const P = (props, required) => ({
  type: 'object',
  properties: props,
  ...(required?.length ? { required } : {}),
});
const S = d => ({ type: 'string', description: d });
const N = d => ({ type: 'integer', description: d });
const B = d => ({ type: 'boolean', description: d });
const A = (d, items = { type: 'string' }) => ({ type: 'array', description: d, items });
const ENUM = (d, values) => ({ type: 'string', description: d, enum: values });

const DEF = {
  /* 任务 */
  list_tasks: ['列出任务及状态。用户问"我有哪些任务""现在进度怎么样"，或你需要先看清全局再决定下一步时调用。只想看某一个任务的完整细节，用 get_task。', P({
    state: ENUM('按状态筛选', Object.keys(TASK_STATES)),
    area: ENUM('按领域筛选', Object.keys(AREAS)),
    limit: N('最多返回几条，默认 30'),
  })],
  get_task: ['查看单个任务的完整字段和时间记录。需要某个任务的全部细节（实际耗时、复盘、阻碍、里程碑）时用。只是想知道有哪些任务，用 list_tasks。', P({ id: S('任务 id 或标题') }, ['id'])],
  save_task: ['新建或更新任务。用户定目标、改截止、推进度、写下一步或阻碍时调用；他描述出一件要做的事、你判断该记下来时也调它。必须按用户说的分类传 category：杂事用 chore，主要任务用 important；不要默认把杂事存成主要任务。只是改状态请用 set_task_state。', P({
    id: S('已有任务的 id 或标题；新建时不传'),
    title: S('任务名称'),
    state: ENUM('状态，仅新建时用；改状态请用 set_task_state', Object.keys(TASK_STATES)),
    category: ENUM('分类：important 重要事情，chore 杂事（简单、随手、不太抵触的事项）', ['important', 'chore']),
    priority: ENUM('优先级 P0 紧急且后果严重 / P1 重要 / P2 正常 / P3 可选', Object.keys(PRIORITIES)),
    area: ENUM('领域', Object.keys(AREAS)),
    goal: S('想达成什么，越具体越好'),
    dueAt: S('截止日期 YYYY-MM-DD'),
    estimateMin: N('预计耗时（分钟）'),
    plannedStart: S('计划开始时间'),
    nextAction: S('下一步行动 —— 必须具体到看着就知道怎么做'),
    blocker: S('当前阻碍。标 BLOCKED 时必须写'),
    progress: N('进度 0-100'),
    milestones: A('里程碑列表'),
    notes: S('备注'),
    mood: N('用户当时情绪 1-5'),
    attention: N('用户当时注意力 1-5'),
    outcome: S('完成情况'),
    review: S('复盘结论'),
  })],
  set_task_state: ['改任务状态。用户明确说做完了 → DONE；说卡住了 → BLOCKED；说要推迟 → DEFERRED。**DONE 只能在他明确说做完时设**，不能替他判断"应该算完成了"。改其他字段（标题、截止、下一步）用 save_task。', P({
    id: S('任务 id 或标题'),
    state: ENUM('目标状态', Object.keys(TASK_STATES)),
    blocker: S('设成 BLOCKED 时必填：卡在哪'),
    outcome: S('设成 DONE 时填：完成了什么'),
    note: S('状态变更备注'),
  }, ['id', 'state'])],
  delete_task: ['删除任务。**只在用户明确要求删除时调用**，不要因为觉得某个任务过时、没用、或者他很久没动，就自己删掉 —— 那是他的任务。删之前先跟他确认是哪一个。', P({ id: S('任务 id 或标题') }, ['id'])],
  set_key_tasks: ['指定今日关键任务（§5.3：每天最多 3 个）。用户问"今天先做什么"，或你和他一起排定了今天要推进的几件事时调用。不要替他决定今天做什么。', P({
    ids: A('任务 id 或标题列表，最多 3 个'),
  }, ['ids'])],

  /* 计时 */
  timer_start: ['开始真实计时。用户选定具体任务并准备开始时调用，必须传入该任务的标题或 id 以关联记录；若今日恰有一个关键任务且用户明确在推进它，可以省略 task，由程序关联该唯一关键任务。调用后先给出该任务的下一步和计划时长，再提示用户点界面确认按钮；不能声称计时已开始，直到确认执行结果返回。', P({
    task: S('关联任务 id 或标题'),
    plannedMin: N('计划时长（分钟），用于后续对比'),
    note: S('不关联任务时的说明'),
  })],
  timer_stop: ['结束计时并算出真实耗时。用户汇报做完、结束、收工时优先用它。**不要用 log_time_entry 代替它** —— 那会把一次真实计时降级成自报。', P({
    note: S('本次备注'),
    selfReportedMin: N('用户自报的耗时。用于和计时结果对比，不要替代它'),
    outcome: S('完成情况'),
    discard: B('true 表示放弃这次计时（误点），不留记录'),
  })],
  timer_status: ['查看当前计时状态、今日已记录时长、以及用户的预估偏差倾向。用户问"我做了多久了""计时到哪了"，或你要判断他是否习惯低估任务耗时时调用。', P({})],
  log_time_entry: ['整理一笔自报耗时的待保存草稿（用户没走计时器、只是口头报了个时长）；在聊天里确认后才落库。**正在计时就用 timer_stop，不要用这个。** 记录学了什么内容用 log_study。', P({
    task: S('关联任务'),
    minutes: N('耗时分钟数'),
    selfReportedMin: N('自报分钟数'),
    note: S('备注'),
    outcome: S('完成情况'),
    startedAt: S('用户报告的开始时间'),
    endedAt: S('用户报告的结束时间'),
  }, ['minutes'])],

  /* 积分 */
  get_ledger: ['查看积分账本和可兑换奖励。用户问"我有多少分""能换什么"时调用。**表是空的时候它会明确说"尚未建立积分账本" —— 如实转告，不要编数字。**', P({ includeRewards: B('是否附带奖励列表，默认 true') })],
  award_points: ['记录积分增减。用户完成了一件事、或你按 §12 规则该给他记分时调用。**这是记账，不代表任何真实惩罚。** 扣分需要他点确认。', P({
    ruleKey: ENUM('按规则加分', POINT_RULES.map(r => r.key)),
    delta: N('显式增减值。负数表示扣分'),
    reason: S('原因 —— 必填'),
    task: S('关联任务'),
    confirmed: B('是否已经过用户确认'),
  }, ['reason'])],
  confirm_points: ['确认积分记录（§12 要求记录是否经用户确认）。用户说"这分我认""算上吧"，或他主动核对账本时调用。', P({
    id: S('积分记录 id'),
    all: B('true 表示确认全部待确认记录'),
  })],
  upsert_reward: ['新建或修改可兑换奖励。用户说"我想拿 X 当奖励""把 X 的分数改一下"时调用。真的去兑换用 redeem_reward。', P({
    id: S('已有奖励 id'),
    name: S('奖励名称'),
    cost: N('兑换所需积分'),
    note: S('备注'),
    remove: B('true 表示删除这个奖励（同样只在用户明确要求时）'),
  })],
  redeem_reward: ['兑换奖励（扣积分并记一笔）。用户说"我要换 X"时调用。需要他点确认；积分不够会被拒绝并告知差多少，不要自己改分数凑。', P({ id: S('奖励 id') }, ['id'])],

  /* 打卡 */
  save_checkin: ['整理生活打卡待保存草稿（睡眠/精力/情绪/注意力等），在聊天里确认后才落库。**只在用户自己提到这些数值时调用** —— 不要主动逐项问他、更不要替他填。任何一项都可以跳过。', P({
    date: S('日期 YYYY-MM-DD，默认今天'),
    sleepHours: N('睡眠时长（小时）'),
    wakeAt: S('起床时间 HH:MM'),
    energy: N('当前精力 1-5'),
    mood: N('当前情绪 1-5'),
    attention: N('注意力 1-5'),
    water: N('饮水杯数'),
    meals: S('饮食'),
    washed: B('是否洗漱'),
    exercise: S('运动'),
    studyMin: N('学习分钟数'),
    workMin: N('工作分钟数'),
    meds: S('服药情况 —— 仅当用户主动要求记录时才填，不要主动问'),
    topTask: S('今日最重要的任务'),
    blocker: S('当前最大阻碍'),
    doneToday: S('今日已完成事项'),
    nextAction: S('下一步行动'),
    note: S('备注'),
    medsEnabled: B('是否开启服药字段记录'),
  })],
  get_checkin: ['查看打卡记录。用户问"我最近睡得怎么样""这几天状态如何"时传 days（趋势统计）；只想看某一天就不传 days。', P({
    date: S('查某一天，默认今天'),
    days: N('查最近 N 天的趋势，例如 14'),
  })],

  /* 微习惯与生活导航：浏览器本地全局数据，跨会话保留 */
  list_micro_habits: ['查看全部微习惯、启停状态和今天的完成情况。用户问有哪些习惯、今天做完哪些时调用；新增或修改用 manage_micro_habit。', P({})],
  manage_micro_habit: ['管理用户的微习惯。用户明确要求新增、修改、删除、启用/停用，或汇报今天已完成/取消完成时调用；删除会要求用户确认。列表先用 list_micro_habits。', P({
    action: ENUM('操作', ['add', 'update', 'delete', 'complete', 'uncomplete', 'activate', 'deactivate']),
    id: S('已有微习惯 id；也可用 title 精确匹配'),
    title: S('微习惯标题；add/update 时必填'),
    date: S('完成日期 YYYY-MM-DD，默认今天'),
  }, ['action'])],
  manage_life_navigation: ['查看或维护生活导航的全局内容，包括主线、原则、兴趣、无聊清单。用户问相关内容时用 action=list；明确要求新增、修改或删除时用对应操作。删除需要用户确认。', P({
    action: ENUM('操作', ['list', 'add', 'update', 'delete']),
    kind: ENUM('分类', ['mainlines', 'principles', 'interests', 'boredom']),
    id: S('已有条目 id'),
    target: S('已有条目的原文；update/delete 时在没有 id 时用于定位'),
    text: S('条目内容；add/update 时必填'),
  }, ['action'])],

  /* 复盘 */
  save_review: ['整理一次复盘待保存草稿（小黑屋或每日复盘）。走完小黑屋六步、或完成每日复盘时调用；聊天确认后才落库。**action（补救行动）必填** —— 没有行动出口的复盘不算完成。要记通用的长期事实，用 save_memory。', P({
    kind: ENUM('类型', ['blackroom', 'daily']),
    date: S('日期'),
    planned: S('原本要做什么'),
    actual: S('实际做了什么'),
    deviationStart: S('从什么时候开始偏离'),
    whatHappened: S('发生了什么'),
    triggers: A('触发因素'),
    thoughts: A('自动化思维原话'),
    reframes: A('重构后的想法'),
    action: S('立即能执行的补救动作 —— 必填'),
    lesson: S('预防措施'),
    task: S('关联任务'),
  }, ['action'])],
  record_procrastination: ['整理一次拖延记录待保存草稿及其模式分类（A–H），聊天确认后才落库。**你判断出这次拖延属于哪一类时调用**，攒够才能看出他反复踩什么坑。用户自己做完整复盘用 save_review。', P({
    pattern: ENUM('A 任务太大 / B 不知道怎么做 / C 担心做不好 / D 怕开始后停不下来 / E 注意力受干扰 / F 身体疲劳 / G 情绪阻塞 / H 单纯不愿意做',
      Object.keys(PROCRASTINATION_PATTERNS)),
    evidence: S('具体发生了什么'),
    intervention: S('用了什么应对方式'),
    outcome: S('结果'),
    task: S('关联任务'),
  }, ['pattern'])],
  list_reviews: ['列出历史复盘和拖延模式统计。用户问"我老犯什么毛病""以前复盘过什么"，或你要引用他过去的教训时调用。', P({
    kind: S('按类型筛选'),
    limit: N('返回条数'),
  })],

  /* 规划 */
  save_plan: ['新建或更新规划（自动编号 P-001、P-002…）。走完规划流程、或用户明确想要一份书面计划时调用。它会当场做可行性检查并指出是否过载。要做 SOP 用 save_sop。', P({
    id: S('已有规划 id'),
    name: S('规划名称'),
    goal: S('目标'),
    deadline: S('截止时间'),
    availableMin: N('今天/本周期可用时间（分钟）—— 给了才会做可行性检查'),
    constraints: S('现实约束'),
    items: A('任务项数组，每项 {text, minAction, estMin}', P({
      text: S('任务内容'),
      minAction: S('最小启动动作'),
      estMin: N('预计分钟'),
    })),
    breaks: S('休息安排'),
    risks: A('可能的阻碍'),
    fallback: S('备用方案'),
    doneCriteria: S('完成标准'),
    status: ENUM('状态', Object.keys(PLAN_STATUSES)),
  }, ['name'])],
  list_plans: ['列出已有规划。用户问"我之前排的计划呢"时调用。要看某一份的完整条目用 get_plan。', P({ status: S('按状态筛选') })],
  get_plan: ['查看某份规划的详情，或勾掉其中某一项（传 toggleIndex）。用户问"那计划具体是哪几步""第一条做完了"，或你要推动他开始第一项时调用。只想知道有哪些规划，用 list_plans。', P({
    id: S('规划 id，留空取最近的'),
    toggleIndex: N('要勾选/取消的任务项序号（从 0 开始）'),
  })],

  /* SOP */
  save_sop: ['制定 SOP（§15 的 12 项结构）。用户想把某件常做的事固化成流程时调用。**quickStart（一分钟启动版）必填** —— 那是给启动困难时用的入口。要写规划用 save_plan。', P({
    id: S('已有 SOP id'),
    name: S('SOP 名称'),
    scene: S('适用场景'),
    goal: S('执行目标'),
    materials: A('所需材料'),
    estimateMin: N('预计耗时（分钟）'),
    prep: A('执行前准备'),
    steps: A('详细步骤（字符串数组）'),
    blockers: A('常见阻碍'),
    exceptions: S('异常处理'),
    doneCriteria: S('完成标准'),
    checklist: A('检查清单'),
    review: S('复盘与改进'),
    quickStart: S('一分钟就能启动的版本 —— 必填，给启动困难时用'),
  }, ['name'])],
  list_sops: ['列出已有 SOP。用户问"我有哪些流程"时调用。要看某一份的完整步骤用 get_sop。', P({})],
  get_sop: ['查看某份 SOP 的完整内容，或勾掉某一步（传 toggleStep）。用户问"那个流程第一步是什么""我做到哪了"，或你要带他走一遍某个 SOP 时调用。只想知道有哪些 SOP，用 list_sops。', P({
    id: S('SOP id，留空取最近的'),
    toggleStep: N('要勾选的步骤序号（从 0 开始）'),
    field: ENUM('勾选哪个列表', ['steps', 'checklist']),
  })],

  /* 档案 */
  get_profile: ['查看用户档案。调用前先调取以了解用户填写的称呼、偏好和雷区；ADHD 状态是可选隐私信息，不要追问或推测，只在用户主动填写后用于调整建议。', P({})],
  update_profile: ['整理用户档案的待保存草稿。用户透露背景、目标、偏好、雷区、称呼时调用；工具会暂存草稿，你必须在聊天里展示并请求确认，收到确认后程序才落库。', P({
    userName: S('希望被如何称呼'),
    supervisorName: S('希望如何称呼监督员'),
    supervisorImage: S('偏好的监督员性别或形象'),
    adhdStatus: ENUM('ADHD 状态', Object.keys(ADHD_STATUS)),
    topProblems: S('当前最困扰的三个问题'),
    focusAreas: S('希望重点监督的事项'),
    procrastinationPatterns: S('最容易出现的拖延行为'),
    rewardPreference: S('最有效的奖励方式'),
    acceptableCorrections: S('可接受的提醒或纠偏方式'),
    selfWords: S('用三个词描述自己'),
    taboos: A('不喜欢的表达方式和交互雷区'),
    otherNeeds: S('其他需求'),
    about: S('用户明确描述的个人背景、经历或当前情况；不确定归属时可原意记录在这里'),
    goals: S('用户明确表达的个人目标'),
    toneLevel: N('表达强度 1-5。用户明确要求调整语气时改'),
    allowProfanity: B('是否允许粗口。用户说不喜欢脏话时设 false'),
    markOnboarded: B('true 表示初始化流程已走完'),
  })],

  /* 暂停 */
  suspend_supervision: ['暂停监督。用户情绪崩溃、明确说"别管我""先别催"时调用。会立刻停掉所有催促、积分判定和复盘。', P({
    until: S('暂停到什么时候，留空表示直到用户主动解除'),
    reason: S('原因（内部记录）'),
  })],
  resume_supervision: ['解除暂停监督。用户说"可以继续了""恢复吧"时调用。恢复后先问一句他现在的状态，别一上来就催。', P({})],

  /* 记忆 */
  save_memory: ['整理长期记忆的待保存草稿。发现三个月后还有用的事实、偏好、有效策略时调用；聊天确认后才落库。只记一次复盘的结论，用 save_review。', P({
    text: S('一句话说清要记住什么'),
    kind: ENUM('类型', ['fact', 'insight', 'preference', 'summary']),
    importance: N('1-5，5 表示对理解这个人最关键'),
    tags: A('标签'),
  }, ['text'])],
  search_memory: ['检索过去的记录（任务、时间、复盘、打卡、记忆、对话）。**要回忆任何细节前必须先调这个**，不要凭印象编 —— 没查到就说没查到。', P({
    query: S('检索关键词'),
    limit: N('返回条数，默认 8'),
  }, ['query'])],
  list_memories: ['列出已积累的长期记忆。你想先看看"关于这个人我已经知道什么"时调用。', P({ limit: N('返回条数') })],
  forget_memory: ['删除一条过时或错误的长期记忆。**只在用户明确要求删除，或他指正某条记错了时调用** —— 不要自己判断哪条没用就删。', P({ id: S('记忆 id') }, ['id'])],

  /* 学习 */
  log_study: ['整理学习活动记录草稿（学了什么、多久、卡在哪）。用户说"我学了""看完了""练了 X"时调用；聊天确认后才落库。只想补一个时长、不记内容的，用 log_time_entry。带 grade 会同时更新复习排期。', P({
    topic: S('知识点名称'),
    minutes: N('花费分钟数'),
    what: S('具体做了什么'),
    blockers: S('卡在哪里'),
    task: S('关联任务'),
    grade: N('掌握程度自评 0-5'),
  }, ['topic'])],
  grade_review: ['整理知识点间隔重复评分待保存草稿。用户复习完并自评掌握程度（"记住了""全忘了"）时调用；聊天确认后才更新。新建知识点用 add_topic。', P({
    topic: S('知识点名称或 id'),
    grade: N('0 完全忘了 / 1 想不起来 / 2 很吃力 / 3 想起来了 / 4 顺利 / 5 秒答'),
    note: S('备注'),
  }, ['topic', 'grade'])],
  add_topic: ['整理新建知识点待保存草稿并纳入复习计划；聊天确认后才创建。用户开始学一个新主题、需要单独跟踪掌握度时调用。**只是记录一次学习用 log_study，它会自动建知识点。**', P({
    name: S('知识点名称'),
    task: S('归属任务'),
    note: S('备注：卡点或关键结论'),
  }, ['name'])],
  list_topics: ['列出知识点及掌握度、下次复习时间。用户问"我要复习什么""我学到了哪些东西"时调用。dueOnly=true 只列今天到期的。', P({ dueOnly: B('只看今天到期的') })],

  /* 汇总 */
  get_daily_summary: ['取代码算好的当日汇总事实（§16 总结用）。**要总结、复盘、写报告或引用任何数字之前先调这个**，拿到真实数据再动笔，不要凭对话记忆编。', P({})],

  /* 导出与导航 */
  export_records: ['导出结构化 Markdown 记录（自包含，可迁移到别的 AI）。用户说"导出记录""把数据拿出来""我要换个 AI 接着用"时调用。', P({
    includeAll: B('true 表示导出全部历史；默认只含近期记录'),
  })],
  open_panel: ['帮用户切换到他正在问的那个面板。例如他问积分就打开积分面板，问微习惯或生活导航就打开对应模块。**他只是随口提到某事、并不是想看那个面板时不要调。**', P({
    panel: ENUM('要打开的面板', PANEL_IDS),
  }, ['panel'])],
};

const CHAT_CONFIRM_TOOLS = new Set([
  'update_profile', 'save_memory', 'save_checkin', 'save_review',
  'record_procrastination', 'log_study', 'log_time_entry', 'add_topic', 'grade_review',
]);

export const TOOL_DEFS = Object.entries(DEF).map(([name, [description, parameters]]) => ({
  type: 'function',
  function: { name, description, parameters },
}));

export const TOOL_NAMES = TOOL_DEFS.map(t => t.function.name);

const DEF_MAP = Object.fromEntries(TOOL_DEFS.map(d => [d.function.name, d]));

/* ══════════════ 下发哪些工具 ══════════════
   曾经这里是"分组按需下发"：核心 14 个常驻，其余按意图正则匹配的组临时注入。

   **那个设计是错的，已移除。** 正则必然漏：用户说"我叫小明"，而 profile 组的
   正则里只有"叫我"，update_profile 就没被下发 —— 模型想存也存不了，但他自己
   不会说"我没有这个工具"，于是表现为"说了称呼但一直没更新"。

   量过成本：全部 39 个工具 ≈ 5600 token，核心 14 个 ≈ 1900 token。差额 3700
   token，但工具 schema 是稳定前缀、会被 DeepSeek 的上下文缓存命中，实际增量
   只相当于约 370 token。

   **用 370 token 换"不会静默丢能力"，很划算。** 省 token 的正确姿势是别把
   历史日志全塞进 prompt，而不是把工具藏起来一半。 */

export function toolsForTurn() {
  return { tools: TOOL_DEFS, names: TOOL_NAMES };
}

/* ══════════════ 需要用户确认的动作 ══════════════
   档案与事实记录类动作先暂存草稿，用户点保存按钮或明确回复确认后才写入。
   下面这些是「承诺类」：模型在替用户决定接下来做什么，或者会删东西、花
   积分、改变自己的行为。这类必须变成按钮让用户自己点。

   §21「用户拥有最终决定权」靠提示词是保证不了的 —— 模型会顺手替你按下开始键。 */

export const CONFIRM_RULES = {
  timer_start: {
    label: '开始计时',
    describe: a => `开始计时：${a.task || a.note || '未指定任务'}`
      + (a.plannedMin ? `　计划 ${a.plannedMin} 分钟` : ''),
  },
  timer_stop: {
    label: '结束并记录',
    describe: () => '结束当前计时，把真实耗时记下来',
  },
  set_key_tasks: {
    label: '设定今日关键任务',
    describe: a => `把今天的关键任务设为：${(Array.isArray(a.ids) ? a.ids : [a.ids]).filter(Boolean).join('、') || '（空）'}`,
  },
  suspend_supervision: {
    label: '暂停监督',
    describe: a => `暂停监督${a.until ? `到 ${a.until}` : '，直到你主动恢复'}`,
  },
  resume_supervision: {
    label: '恢复监督',
    describe: () => '恢复任务催促与积分判定',
  },
  redeem_reward: {
    label: '兑换奖励',
    danger: true,
    describe: () => '消耗积分兑换奖励',
  },
  delete_task: {
    label: '删除任务',
    danger: true,
    describe: a => `删除任务「${a.id}」（时间记录和复盘会保留）`,
  },
  manage_micro_habit: {
    when: a => a.action === 'delete',
    label: '删除微习惯',
    danger: true,
    describe: a => `删除微习惯「${a.title || a.id || ''}」`,
  },
  manage_life_navigation: {
    when: a => a.action === 'delete',
    label: '删除生活导航条目',
    danger: true,
    describe: a => `删除${({ mainlines: '主线', principles: '原则', interests: '兴趣', boredom: '无聊清单' })[a.kind] || '生活导航'}条目「${a.text || a.target || a.id || ''}」`,
  },
  forget_memory: {
    label: '删除这条记忆',
    danger: true,
    describe: a => `删除长期记忆 ${a.id}`,
  },
  upsert_reward: {
    when: a => a.remove === true,
    label: '删除奖励',
    danger: true,
    describe: a => `删除奖励条目 ${a.id || ''}`,
  },
  award_points: {
    when: a => Number(a.delta) < 0,
    label: '扣除积分',
    danger: true,
    describe: a => `扣除 ${Math.abs(Number(a.delta))} 分：${a.reason || ''}`,
  },
};

function confirmRequirement(name, args) {
  const rule = CONFIRM_RULES[name];
  if (!rule) return null;
  if (typeof rule.when === 'function' && !rule.when(args)) return null;
  return rule;
}

/* ══════════════ 执行器 ══════════════ */

/**
 * @param {string} name
 * @param {string|object} rawArgs
 * @param {{confirmed?:boolean, sessionId?:string}} [opts]
 *   confirmed=false 时，命中 CONFIRM_RULES 的动作**不会执行**，只登记成待确认项。
 */
export async function executeTool(name, rawArgs, { confirmed = false, sessionId = '' } = {}) {
  let args;
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
  } catch (e) {
    return { content: `参数不是合法 JSON，请重新调用：${e.message}`, error: true, summary: `${name} ✗ JSON` };
  }
  const fn = IMPL[name];
  if (!fn) return { content: `不存在名为 "${name}" 的工具。`, error: true, summary: `${name} ✗ 不存在` };

  /* ── 需要用户点确认的动作：先不执行 ── */
  const rule = confirmRequirement(name, args);
  if (rule && !confirmed) {
    let detail = rule.describe ? rule.describe(args) : '';
    if (name === 'set_key_tasks') {
      const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
      const titles = (await Promise.all(ids.filter(Boolean).map(resolveTask))).filter(Boolean).map(t => t.title);
      if (titles.length) detail = `设为今日关键任务：${titles.join('、')}`;
    } else if (name === 'delete_task') {
      const task = await resolveTask(args.id);
      if (task) detail = `删除任务「${task.title}」（时间记录和复盘会保留）`;
    }
    const item = await addPending({
      tool: name,
      args,
      label: rule.label,
      detail,
      danger: rule.danger,
      sessionId,
    });
    return {
      pending: true,
      pendingId: item.id,
      content: `「${rule.label}」需要用户自己点按钮确认，**尚未执行**。\n`
        + '界面上已经给他生成了一个确认按钮。你的回复要用**提议**的语气'
        + '（例如"点下面的按钮就能开始"），**绝对不能说成已经开始了**。\n'
        + '等他点了按钮它才会真的执行。他不点也没关系，不要催。',
      summary: `${rule.label} · 等你点确认`,
    };
  }

  if (CHAT_CONFIRM_TOOLS.has(name) && !confirmed) {
    if (name === 'save_review' && !String(args.action || '').trim()) {
      return { content: '复盘必须包含一个可以立即执行的动作（action）。没有行动出口的复盘不算完成。', error: true, summary: 'save_review 缺少行动' };
    }
    await stageChatWrite({ tool: name, args, sessionId });
    return {
      chatApproval: true,
      content: `这条记录已整理成待确认草稿，尚未写入正式数据。草稿内容：${JSON.stringify(args)}。`
        + '界面会提供一个保存按钮。请简要说明草稿内容并提示用户点击按钮；不要要求用户再输入「确认保存」。用户也可以回复「取消」。'
        + '不要说成已经保存；确认前不要重试同一条记录。',
      summary: `${name} · 等待点击保存`,
    };
  }

  try {
    const out = await fn(args);
    return typeof out === 'string' ? { content: out } : out;
  } catch (e) {
    // 错误回灌给模型让它自己改参数重试，而不是让整个回合失败
    return { content: `执行 ${name} 失败：${e.message}`, error: true, summary: `${name} ✗ ${e.message}` };
  }
}

export async function runToolsConcurrently(calls) {
  return Promise.all(calls.map(c => executeTool(c.name, c.args)));
}
