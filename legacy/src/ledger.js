// ── 积分账本（§十二）────────────────────────────────────────
//
// 两条硬约束直接落在数据结构上：
//
// 1. §12 "不得擅自执行真实的账户封锁、设备限制或其他外部惩罚"
//    → 这个模块**只记数，不执行任何惩罚**。扣分只是一行记录。
//
// 2. §12 "不要虚构积分历史。没有记录时，应标注*尚未建立积分账本*"
//    → 表为空时 getLedger() 返回 established:false，模型拿不到可以乱圆的数字。

import { db, getMeta, setMeta } from './db.js';
import { uid, nowISO, dateStr } from './util.js';

/** §12 建议的积分规则 */
export const POINT_RULES = [
  { key: 'key_task',      label: '完成关键任务',               delta: 3 },
  { key: 'task',          label: '完成普通任务',               delta: 1 },
  { key: 'report_blocker', label: '主动报告阻碍并及时调整计划', delta: 1 },
  { key: 'start_on_plan', label: '按计划开始任务',             delta: 1 },
  { key: 'daily_review',  label: '完成每日复盘',               delta: 1 },
];

export const ruleByKey = key => POINT_RULES.find(r => r.key === key) || null;

/**
 * 记一笔积分。
 * @param {object} o
 * @param {number} [o.delta]      显式增减值；给了 ruleKey 就按规则算
 * @param {string} [o.ruleKey]    规则 key
 * @param {string} o.reason       原因（必填，账本没有原因就没意义）
 * @param {boolean} [o.confirmed] 是否已经过用户确认
 */
export async function awardPoints({
  delta, ruleKey, kind = 'task', reason, taskId = '', confirmed = false,
} = {}) {
  const rule = ruleKey ? ruleByKey(ruleKey) : null;
  let value = delta;
  if (value === undefined || value === null) {
    if (!rule) throw new Error('必须提供 delta 或有效的 ruleKey');
    value = rule.delta;
  }
  value = Number(value);
  if (!Number.isFinite(value) || value === 0) throw new Error('delta 必须是非零数字');

  const text = String(reason || '').trim() || (rule ? rule.label : '');
  if (!text) throw new Error('必须说明积分原因');

  const entry = {
    id: uid('pt_'),
    date: dateStr(),
    delta: value,
    kind: ['task', 'bonus', 'penalty', 'redeem'].includes(kind) ? kind : 'task',
    ruleKey: rule?.key || '',
    reason: text,
    taskId,
    confirmed: Boolean(confirmed),
    confirmedAt: confirmed ? nowISO() : null,
    createdAt: nowISO(),
  };
  await db.points.put(entry);
  return entry;
}

/**
 * 纠偏记录。**这只是记账，不执行任何真实惩罚。**
 * §12 明确禁止账户封锁、设备限制、剥夺睡眠饮食等做法。
 */
export async function deductPoints({ delta, reason, confirmed = false } = {}) {
  const amount = Math.abs(Number(delta));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('扣分必须给正数');
  return awardPoints({ delta: -amount, kind: 'penalty', reason, confirmed });
}

/**
 * 读账本。
 * @returns {Promise<object>} established 为 false 时表示**从未有过任何记录**，
 *   调用方（和模型）必须如实说"尚未建立积分账本"，不能用 0 冒充。
 */
export async function getLedger({ recentLimit = 20 } = {}) {
  const all = (await db.points.toArray())
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (!all.length) {
    return {
      established: false,
      total: null,
      confirmedTotal: null,
      pendingTotal: null,
      count: 0,
      unconfirmed: [],
      recent: [],
      todayDelta: null,
      note: '尚未建立积分账本。不要虚构任何历史积分。',
    };
  }

  const sum = list => list.reduce((s, e) => s + (e.delta || 0), 0);
  const unconfirmed = all.filter(e => !e.confirmed);
  const today = dateStr();

  return {
    established: true,
    total: sum(all),
    confirmedTotal: sum(all.filter(e => e.confirmed)),
    pendingTotal: sum(unconfirmed),
    count: all.length,
    unconfirmed,
    recent: all.slice(0, recentLimit),
    todayDelta: sum(all.filter(e => e.date === today)),
  };
}

export async function listPoints({ limit = 50, unconfirmedOnly = false } = {}) {
  let all = await db.points.toArray();
  if (unconfirmedOnly) all = all.filter(e => !e.confirmed);
  return all
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);
}

export async function confirmPoints(id, confirmed = true) {
  const entry = await db.points.get(id);
  if (!entry) throw new Error('找不到这条积分记录');
  await db.points.update(id, { confirmed, confirmedAt: confirmed ? nowISO() : null });
  return db.points.get(id);
}

export async function confirmAllPoints() {
  const all = await db.points.toArray();
  const pending = all.filter(e => !e.confirmed);
  for (const e of pending) {
    await db.points.update(e.id, { confirmed: true, confirmedAt: nowISO() });
  }
  return pending.length;
}

export const deletePointEntry = id => db.points.delete(id);

/* ══════════════ 奖励（§十二 可兑换奖励）══════════════ */

export async function listRewards() {
  const all = await db.rewards.toArray();
  return all.sort((a, b) => (a.cost || 0) - (b.cost || 0));
}

export async function upsertReward({ id, name, cost, note = '' } = {}) {
  const cur = id ? await db.rewards.get(id) : null;
  const rec = {
    id: cur?.id || uid('rwd_'),
    name: String(name ?? cur?.name ?? '').trim(),
    cost: Number(cost ?? cur?.cost ?? 0),
    note: String(note ?? cur?.note ?? ''),
    redeemedCount: cur?.redeemedCount || 0,
    createdAt: cur?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
  if (!rec.name) throw new Error('奖励名称不能为空');
  if (!Number.isFinite(rec.cost) || rec.cost < 0) throw new Error('兑换成本必须是非负数');
  await db.rewards.put(rec);
  return rec;
}

export const deleteReward = id => db.rewards.delete(id);

/**
 * 兑换奖励：扣分并记一笔。分不够就拒绝 —— 这是账本唯一"有牙齿"的地方，
 * 但它约束的是积分，不是用户的人身自由。
 */
export async function redeemReward(id) {
  const reward = await db.rewards.get(id);
  if (!reward) throw new Error('找不到这个奖励');
  const ledger = await getLedger();
  if (!ledger.established) throw new Error('还没有积分账本，先积累一些积分');
  if (ledger.total < reward.cost) {
    throw new Error(`积分不够：「${reward.name}」需要 ${reward.cost}，当前 ${ledger.total}`);
  }

  const entry = await awardPoints({
    delta: -reward.cost,
    kind: 'redeem',
    reason: `兑换奖励：${reward.name}`,
    confirmed: true,
  });
  await db.rewards.update(id, { redeemedCount: (reward.redeemedCount || 0) + 1 });
  return { reward, entry, remaining: ledger.total - reward.cost };
}
