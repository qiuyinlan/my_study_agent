// ── 生活打卡 + 复盘记录 + 拖延模式识别 ────────────────────────
//
// §十三 生活打卡、§十一 小黑屋复盘，都在这里。
// 复盘的目的是识别逃避的触发条件，不是让用户自我批评 —— 所以数据
// 结构里强制留了 action（补救行动）字段，没有行动出口的复盘不算完整。

import { db, getMeta, setMeta, upsertTask, addLog } from './db.js';
import { uid, nowISO, dateStr } from './util.js';

/* ══════════════ 一、生活打卡（§十三）══════════════ */

/** 打卡模板。服药字段默认关闭 —— §13 要求仅在用户主动要求时记录 */
export const CHECKIN_TEMPLATE = {
  sleepHours: null,   // 睡眠时长（小时）
  wakeAt: '',         // 起床时间 HH:MM
  energy: null,       // 当前精力 1-5
  mood: null,         // 当前情绪 1-5
  attention: null,    // 注意力 1-5
  water: null,        // 饮水（杯）
  meals: '',          // 饮食
  washed: null,       // 洗漱
  exercise: '',       // 运动
  studyMin: null,     // 学习（分钟）
  workMin: null,      // 工作（分钟）
  meds: '',           // 服药（仅 medsEnabled 时显示）
  topTask: '',        // 今日最重要的任务
  blocker: '',        // 当前最大阻碍
  doneToday: '',      // 今日已完成事项
  nextAction: '',     // 下一步行动
  note: '',
};

const NUMERIC = ['sleepHours', 'energy', 'mood', 'attention', 'water', 'studyMin', 'workMin'];

/**
 * 打卡是一天一条，用日期当主键，重复提交就是更新。
 * 用户可以跳过任何项目 —— 传 undefined 的字段保持原值。
 */
export async function upsertCheckin(patch = {}, { date } = {}) {
  const d = date || dateStr();
  const cur = await db.checkins.get(d);
  const now = nowISO();

  const next = {
    id: d,
    date: d,
    ...CHECKIN_TEMPLATE,
    ...(cur || {}),
  };

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'id' || k === 'date') continue;
    if (NUMERIC.includes(k)) {
      if (v === '' || v === null) { next[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} 必须是数字`);
      // 1-5 量表做边界钳制
      next[k] = ['energy', 'mood', 'attention'].includes(k)
        ? Math.min(5, Math.max(1, Math.round(n)))
        : Math.max(0, n);
    } else if (['washed', 'medsEnabled'].includes(k)) {
      next[k] = Boolean(v);
    } else {
      next[k] = String(v);
    }
  }

  next.createdAt = cur?.createdAt || now;
  next.updatedAt = now;
  await db.checkins.put(next);
  return next;
}

export const getCheckin = date => db.checkins.get(date || dateStr());

export async function listCheckins(limit = 30) {
  const all = await db.checkins.toArray();
  return all.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, limit);
}

/** 服药字段是否已由用户主动开启 */
export const isMedsEnabled = () => getMeta('medsEnabled', false);
export const setMedsEnabled = v => setMeta('medsEnabled', Boolean(v));

/** 趋势统计：给"反复出现的阻碍"和"情绪注意力趋势"用（§十六） */
export async function checkinSummary(days = 14) {
  const list = (await listCheckins(90)).slice(0, days);
  if (!list.length) return { samples: 0, established: false };

  const avg = key => {
    const vals = list.map(c => c[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const sleepSamples = list.map(c => c.sleepHours).filter(v => typeof v === 'number' && v > 0);
  const shortSleep = sleepSamples.filter(v => v < 7).length;

  return {
    samples: list.length,
    established: true,
    from: list[list.length - 1].date,
    to: list[0].date,
    avgSleep: sleepSamples.length ? sleepSamples.reduce((a, b) => a + b, 0) / sleepSamples.length : null,
    shortSleepNights: shortSleep,
    avgEnergy: avg('energy'),
    avgMood: avg('mood'),
    avgAttention: avg('attention'),
    // 相关不等于因果，这里只做陈述，不下结论
    note: shortSleep && sleepSamples.length >= 3
      ? `${sleepSamples.length} 天里有 ${shortSleep} 天睡眠不足 7 小时`
      : null,
  };
}

/* ══════════════ 二、拖延模式（§十）══════════════ */

export const PROCRASTINATION_PATTERNS = {
  A: { label: '任务太大',           fix: '继续拆分' },
  B: { label: '不知道怎么做',       fix: '给出明确步骤或示例' },
  C: { label: '担心做不好',         fix: '设低质量初稿目标，先完成再优化' },
  D: { label: '怕开始后停不下来',   fix: '明确时间上限与结束条件' },
  E: { label: '注意力受干扰',       fix: '移除最明显的干扰源' },
  F: { label: '身体疲劳',           fix: '评估是否需要休息、进食或睡眠' },
  G: { label: '情绪阻塞',           fix: '先命名情绪，再降低任务难度' },
  H: { label: '单纯不愿意做',       fix: '承认事实，分析后果，让用户在开始/延期/取消之间选' },
};

/**
 * 记一次拖延。模式判断由模型做，这里只负责落库 ——
 * 攒够了才能看出"哪种反复出现"。
 */
export async function recordProcrastination({
  pattern, evidence = '', intervention = '', outcome = '', taskId = '',
} = {}) {
  const key = String(pattern || '').toUpperCase().slice(0, 1);
  if (!PROCRASTINATION_PATTERNS[key]) {
    throw new Error(`模式必须是 A-H 之一（当前：${pattern}）`);
  }
  const rec = {
    id: uid('rev_'),
    kind: 'procrastination',
    date: dateStr(),
    pattern: key,
    facts: { whatHappened: String(evidence).trim() },
    triggers: [],
    thoughts: [],
    reframes: [],
    action: String(intervention).trim(),
    lesson: '',
    outcome: String(outcome).trim(),
    taskId,
    createdAt: nowISO(),
  };
  await db.reviews.put(rec);
  return rec;
}

/** 哪种拖延模式反复出现 —— §十六 的"反复出现的阻碍" */
export async function patternStats() {
  const all = (await db.reviews.toArray()).filter(r => r.kind === 'procrastination');
  if (!all.length) return { established: false, samples: 0, counts: [], top: null };

  const counts = {};
  for (const r of all) counts[r.pattern] = (counts[r.pattern] || 0) + 1;
  const sorted = Object.entries(counts)
    .map(([k, n]) => ({ pattern: k, ...PROCRASTINATION_PATTERNS[k], count: n }))
    .sort((a, b) => b.count - a.count);

  return { established: true, samples: all.length, counts: sorted, top: sorted[0] };
}

/* ══════════════ 三、复盘记录（§十一 小黑屋 / §十六 每日复盘）══════════════ */

/**
 * 保存一次复盘。
 * action 是必填的 —— §11 明确禁止"没有行动出口的自我批评"，
 * 所以这里用数据结构强制它存在。
 */
export async function saveReview({
  kind = 'blackroom', date, facts = {}, triggers = [], thoughts = [],
  reframes = [], action, lesson = '', taskId = '', pointsAwarded = false,
} = {}) {
  const act = String(action || '').trim();
  if (!act) {
    throw new Error('复盘必须包含一个可以立即执行的动作（action）。没有行动出口的复盘不算完成。');
  }

  const rec = {
    id: uid('rev_'),
    kind: ['blackroom', 'daily', 'procrastination'].includes(kind) ? kind : 'blackroom',
    date: date || dateStr(),
    facts: {
      planned: String(facts.planned || '').trim(),
      actual: String(facts.actual || '').trim(),
      deviationStart: String(facts.deviationStart || '').trim(),
      whatHappened: String(facts.whatHappened || '').trim(),
    },
    triggers: (Array.isArray(triggers) ? triggers : []).map(String).filter(Boolean),
    thoughts: (Array.isArray(thoughts) ? thoughts : []).map(String).filter(Boolean),
    reframes: (Array.isArray(reframes) ? reframes : []).map(String).filter(Boolean),
    action: act,
    lesson: String(lesson || '').trim(),
    outcome: '',
    taskId,
    pointsAwarded: Boolean(pointsAwarded),
    createdAt: nowISO(),
  };
  await db.reviews.put(rec);

  // 复盘也算一次学习/工作记录，进 logs 便于趋势统计
  await addLog({
    date: rec.date,
    taskId,
    minutes: 0,
    what: `完成复盘（${rec.kind}）`,
    topicName: '',
  });

  return rec;
}

export async function listReviews({ kind, limit = 30 } = {}) {
  let all = await db.reviews.toArray();
  if (kind) all = all.filter(r => r.kind === kind);
  return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
}

export const getReview = id => db.reviews.get(id);
export const deleteReview = id => db.reviews.delete(id);

/** §十六 的"有效的应对策略"：从复盘里把 action 和 lesson 摊出来 */
export async function effectiveStrategies(limit = 10) {
  const all = (await db.reviews.toArray())
    .filter(r => r.kind !== 'procrastination')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);
  return all.map(r => ({ date: r.date, action: r.action, lesson: r.lesson })).filter(x => x.action || x.lesson);
}

/* ══════════════ 四、每日复盘是否已完成 ══════════════ */

export async function hasDailyReviewToday() {
  const all = await db.reviews.toArray();
  const today = dateStr();
  return all.some(r => r.date === today && r.kind === 'daily');
}
