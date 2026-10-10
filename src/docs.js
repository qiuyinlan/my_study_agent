// ── 规划与 SOP（§十四、§十五）────────────────────────────────
//
// 两者都是"结构化文档"，共用编号、CRUD 和导出逻辑。
//
// 规划的核心约束来自 §14 第四轮：**必须主动检查可行性**。
// 如果预计总时长超过可用时间，代码要算出冲突（overBy），
// 而不是让模型自己感觉"应该差不多"。

import { db, getMeta, setMeta } from './db.js';
import { uid, nowISO, dateStr } from './util.js';

/* ══════════════ 一、规划（§十四）══════════════ */

export const PLAN_STATUSES = {
  draft:     { label: '草稿' },
  active:    { label: '进行中' },
  done:      { label: '已完成' },
  abandoned: { label: '已放弃' },
};

/** P-001、P-002… 自增编号，跨会话保持 */
export async function nextPlanCode() {
  const n = (await getMeta('planSeq', 0)) + 1;
  await setMeta('planSeq', n);
  return `P-${String(n).padStart(3, '0')}`;
}

export function emptyPlanItem() {
  return { text: '', minAction: '', estMin: null, done: false };
}

export function normalizePlanItem(raw) {
  if (typeof raw === 'string') {
    return { text: raw.trim(), minAction: '', estMin: null, done: false };
  }
  return {
    text: String(raw?.text ?? '').trim(),
    minAction: String(raw?.minAction ?? '').trim(),
    estMin: raw?.estMin === null || raw?.estMin === undefined || raw?.estMin === ''
      ? null
      : Math.max(0, Number(raw.estMin) || 0),
    done: Boolean(raw?.done),
  };
}

/**
 * 可行性检查（§14 第四轮）。
 * @returns {{totalMin:number, availableMin:number|null, overBy:number|null, feasible:boolean|null, verdict:string}}
 */
export function checkFeasibility(plan) {
  const items = (plan?.items || []).map(normalizePlanItem);
  const totalMin = items.reduce((s, it) => s + (it.estMin || 0), 0);
  const availableMin = plan?.availableMin === null || plan?.availableMin === undefined || plan?.availableMin === ''
    ? null
    : Number(plan.availableMin);

  const unestimated = items.filter(it => !it.estMin).length;

  if (availableMin === null || !items.length) {
    return {
      totalMin, availableMin, overBy: null, feasible: null, unestimated,
      verdict: availableMin === null
        ? '没有提供可用时间，无法判断可行性。'
        : '还没有任务项。',
    };
  }

  const overBy = totalMin - availableMin;
  if (overBy > 0) {
    return {
      totalMin, availableMin, overBy, feasible: false, unestimated,
      verdict: `**计划过载**：预计需要 ${totalMin} 分钟，但可用时间只有 ${availableMin} 分钟，超出 ${overBy} 分钟。必须缩减范围。`,
    };
  }
  if (overBy < -availableMin * 0.3) {
    return {
      totalMin, availableMin, overBy, feasible: true, unestimated,
      verdict: `计划偏轻：只用了 ${totalMin} / ${availableMin} 分钟。可以加一项，或者接受一个轻松的节奏。`,
    };
  }
  return {
    totalMin, availableMin, overBy, feasible: true, unestimated,
    verdict: `计划可行：${totalMin} / ${availableMin} 分钟${unestimated ? `（有 ${unestimated} 项没估时）` : ''}。`,
  };
}

export async function savePlan({
  id, code, name, goal = '', deadline = '', availableMin = null, constraints = '',
  items = [], breaks = '', risks = [], fallback = '', doneCriteria = '', status,
} = {}) {
  const cur = id ? await db.plans.get(id) : null;
  const rec = {
    id: cur?.id || uid('plan_'),
    code: cur?.code || code || await nextPlanCode(),
    name: String(name ?? cur?.name ?? '').trim(),
    goal: String(goal ?? cur?.goal ?? ''),
    deadline: String(deadline ?? cur?.deadline ?? ''),
    availableMin: availableMin === null || availableMin === undefined || availableMin === ''
      ? (cur?.availableMin ?? null)
      : Math.max(0, Number(availableMin) || 0),
    constraints: String(constraints ?? cur?.constraints ?? ''),
    items: (items && items.length ? items : cur?.items || []).map(normalizePlanItem),
    breaks: String(breaks ?? cur?.breaks ?? ''),
    risks: (Array.isArray(risks) && risks.length ? risks : cur?.risks || []).map(String).filter(Boolean),
    fallback: String(fallback ?? cur?.fallback ?? ''),
    doneCriteria: String(doneCriteria ?? cur?.doneCriteria ?? ''),
    status: PLAN_STATUSES[status] ? status : (cur?.status || 'draft'),
    createdAt: cur?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
  if (!rec.name) throw new Error('规划必须有名称');

  const feas = checkFeasibility(rec);
  rec.feasibility = { totalMin: feas.totalMin, overBy: feas.overBy, feasible: feas.feasible };

  await db.plans.put(rec);
  return { plan: rec, feasibility: feas };
}

export async function listPlans({ status, limit = 50 } = {}) {
  let all = await db.plans.toArray();
  if (status) all = all.filter(p => p.status === status);
  return all
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit);
}

export const getPlan = id => db.plans.get(id);
export const deletePlan = id => db.plans.delete(id);

/** 勾掉/取消勾掉某一项 */
export async function togglePlanItem(planId, index) {
  const plan = await db.plans.get(planId);
  if (!plan) throw new Error('找不到这个规划');
  const items = (plan.items || []).map(normalizePlanItem);
  if (!items[index]) throw new Error('没有这一项');
  items[index].done = !items[index].done;
  await db.plans.update(planId, { items, updatedAt: nowISO() });
  return db.plans.get(planId);
}

/** 第一项还没做完的工作 —— §14 第五轮"推动他开始第一项" */
export function nextPlanAction(plan) {
  const items = (plan?.items || []).map(normalizePlanItem);
  const idx = items.findIndex(it => !it.done);
  if (idx < 0) return null;
  const it = items[idx];
  return { index: idx, ...it, startWith: it.minAction || it.text };
}

/* ══════════════ 二、SOP（§十五）══════════════ */

/** §15 规定的 12 项，顺序即展示顺序 */
export const SOP_FIELDS = [
  { key: 'name',         label: 'SOP 名称',     required: true,  kind: 'text' },
  { key: 'scene',        label: '适用场景',     required: true,  kind: 'text' },
  { key: 'goal',         label: '执行目标',     required: true,  kind: 'text' },
  { key: 'materials',    label: '所需材料',     required: false, kind: 'list' },
  { key: 'estimateMin',  label: '预计耗时',     required: false, kind: 'number' },
  { key: 'prep',         label: '执行前准备',   required: false, kind: 'list' },
  { key: 'steps',        label: '详细步骤',     required: true,  kind: 'steps' },
  { key: 'blockers',     label: '常见阻碍',     required: false, kind: 'list' },
  { key: 'exceptions',   label: '异常处理',     required: false, kind: 'text' },
  { key: 'doneCriteria', label: '完成标准',     required: true,  kind: 'text' },
  { key: 'checklist',    label: '检查清单',     required: false, kind: 'steps' },
  { key: 'review',       label: '复盘与改进',   required: false, kind: 'text' },
];

/** §15 额外强制要求：必须有一个"一分钟就能启动"的版本 */
export const SOP_EXTRA = [
  { key: 'quickStart', label: '一分钟启动版', required: true, kind: 'text' },
];

function toStepList(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(x => (typeof x === 'string'
      ? { text: x.trim(), done: false }
      : { text: String(x?.text ?? '').trim(), done: Boolean(x?.done) }))
    .filter(x => x.text);
}

function toStringList(raw) {
  return (Array.isArray(raw) ? raw : []).map(String).map(s => s.trim()).filter(Boolean);
}

export async function saveSop({
  id, name, scene = '', goal = '', materials = [], estimateMin = null, prep = [],
  steps = [], blockers = [], exceptions = '', doneCriteria = '', checklist = [],
  review = '', quickStart = '',
} = {}) {
  const cur = id ? await db.sops.get(id) : null;
  const rec = {
    id: cur?.id || uid('sop_'),
    name: String(name ?? cur?.name ?? '').trim(),
    scene: String(scene ?? cur?.scene ?? ''),
    goal: String(goal ?? cur?.goal ?? ''),
    materials: materials.length ? toStringList(materials) : (cur?.materials || []),
    estimateMin: estimateMin === null || estimateMin === undefined || estimateMin === ''
      ? (cur?.estimateMin ?? null)
      : Math.max(0, Number(estimateMin) || 0),
    prep: prep.length ? toStringList(prep) : (cur?.prep || []),
    steps: steps.length ? toStepList(steps) : (cur?.steps || []),
    blockers: blockers.length ? toStringList(blockers) : (cur?.blockers || []),
    exceptions: String(exceptions ?? cur?.exceptions ?? ''),
    doneCriteria: String(doneCriteria ?? cur?.doneCriteria ?? ''),
    checklist: checklist.length ? toStepList(checklist) : (cur?.checklist || []),
    review: String(review ?? cur?.review ?? ''),
    quickStart: String(quickStart ?? cur?.quickStart ?? '').trim(),
    createdAt: cur?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };

  /* ── 校验：§15 要求的必填项和"一分钟启动版" ──
     注意空数组也算缺 —— 早先这里写成 !rec[k]，而 ![] === false，
     导致"steps: []"能通过校验。测试抓到了这个漏洞。 */
  const isBlank = x => (Array.isArray(x) ? x.length === 0 : !x);
  const missing = SOP_FIELDS
    .filter(f => f.required && isBlank(rec[f.key]))
    .map(f => f.label);
  if (missing.length) throw new Error(`SOP 缺少必填项：${missing.join('、')}`);
  if (!rec.quickStart) {
    throw new Error('SOP 必须包含「一分钟启动版」—— 这是给启动困难时用的入口，不能省。');
  }

  await db.sops.put(rec);
  return rec;
}

export async function listSops({ limit = 50 } = {}) {
  const all = await db.sops.toArray();
  return all
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit);
}

export const getSop = id => db.sops.get(id);
export const deleteSop = id => db.sops.delete(id);

export async function toggleSopStep(sopId, field, index) {
  if (!['steps', 'checklist'].includes(field)) throw new Error('只能勾选 steps 或 checklist');
  const sop = await db.sops.get(sopId);
  if (!sop) throw new Error('找不到这个 SOP');
  const list = toStepList(sop[field]);
  if (!list[index]) throw new Error('没有这一项');
  list[index].done = !list[index].done;
  await db.sops.update(sopId, { [field]: list, updatedAt: nowISO() });
  return db.sops.get(sopId);
}
