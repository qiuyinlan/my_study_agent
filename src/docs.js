// ── 规划与 SOP（§十四、§十五）────────────────────────────────
//
// 两者都是"结构化文档"，共用编号、CRUD 和导出逻辑。
//
// 规划的核心约束来自 §14 第四轮：**必须主动检查可行性**。
// 如果预计总时长超过可用时间，代码要算出冲突（overBy），
// 而不是让模型自己感觉"应该差不多"。

import { db, getMeta, setMeta, notifyPrivateDataChanged } from './db.js';
import { uid, nowISO, dateStr } from './util.js';

/* ══════════════ 一、规划（§十四）══════════════ */

export const PLAN_STATUSES = {
  draft:     { label: '搁置' },
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

export const PLAN_STAGE_STATUSES = {
  not_started: '未开始', active: '进行中', partial: '部分完成', done: '完成',
};

export function normalizePlanTask(raw = {}) {
  const item = normalizePlanItem(raw);
  return {
    ...item,
    id: String(raw?.id || uid('ptask_')),
    priority: raw?.priority === undefined || raw?.priority === null || raw?.priority === '' ? 3 : Math.max(0, Number(raw.priority) || 0),
    earlyStart: Boolean(raw?.earlyStart),
    remainingMin: raw?.remainingMin === undefined || raw?.remainingMin === null || raw?.remainingMin === ''
      ? null : Math.max(0, Number(raw.remainingMin) || 0),
  };
}

export function normalizePlanStage(raw = {}, index = 0) {
  const status = PLAN_STAGE_STATUSES[raw?.status] ? raw.status : 'not_started';
  const id = String(raw?.id || `stage_${index + 1}`);
  return {
    id,
    name: String(raw?.name || '').trim(),
    status,
    dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(String) : [],
    exception: String(raw?.exception || ''),
    estimate: String(raw?.estimate || ''),
    risks: Array.isArray(raw?.risks) ? raw.risks.map(String).filter(Boolean) : [],
    tasks: (Array.isArray(raw?.tasks) ? raw.tasks : []).map((task, taskIndex) => normalizePlanTask({
      ...task, id: task?.id || `${id}_task_${taskIndex + 1}`,
    })).filter(x => x.text),
  };
}

export function planStages(plan) {
  if (Array.isArray(plan?.stages) && plan.stages.length) return plan.stages.map(normalizePlanStage);
  const tasks = (plan?.items || []).map((task, index) => normalizePlanTask({ ...task, id: task?.id || `legacy-task-${index + 1}` }));
  return tasks.length ? [normalizePlanStage({ id: 'legacy-stage', name: '执行阶段', status: plan.status === 'done' ? 'done' : 'active', tasks })] : [];
}

/**
 * 可行性检查（§14 第四轮）。
 * @returns {{totalMin:number, availableMin:number|null, capacityMin?:number|null, periodDays?:number|null, overBy:number|null, feasible:boolean|null, verdict:string}}
 */
export function checkFeasibility(plan) {
  const hasStages = Array.isArray(plan?.stages) && plan.stages.length > 0;
  const stages = hasStages ? plan.stages.map(normalizePlanStage) : [];
  const items = (hasStages
    ? plan.stages.flatMap(stage => stage.tasks || [])
    : (plan?.items || [])).map(normalizePlanItem);
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

  let periodDays = null;
  if (hasStages) {
    const deadline = String(plan?.deadline || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      const today = new Date(`${dateStr()}T00:00:00`);
      const due = new Date(`${deadline}T00:00:00`);
      if (!Number.isNaN(due.getTime())) {
        periodDays = Math.max(0, Math.floor((due - today) / 86400000) + 1);
      }
    }
    if (periodDays === null) {
      const durations = stages.map(stage => {
        const match = String(stage.estimate || '').match(/(\d+(?:\.\d+)?)\s*(天|日|周|星期)/);
        if (!match) return null;
        return Number(match[1]) * (match[2] === '周' || match[2] === '星期' ? 7 : 1);
      });
      if (durations.length && durations.every(days => days !== null)) {
        periodDays = Math.ceil(durations.reduce((sum, days) => sum + days, 0));
      }
    }
    if (periodDays === null) {
      return {
        totalMin, availableMin, capacityMin: null, periodDays: null,
        overBy: null, feasible: null, unestimated,
        verdict: `阶段任务共预计 ${totalMin} 分钟；没有截止日期或阶段周期，无法拿单日可用时间判断整个规划是否过载。`,
      };
    }
  }

  const capacityMin = hasStages ? availableMin * periodDays : availableMin;
  const overBy = totalMin - capacityMin;
  if (overBy > 0) {
    return {
      totalMin, availableMin, capacityMin, periodDays, overBy, feasible: false, unestimated,
      verdict: `**计划过载**：预计需要 ${totalMin} 分钟，但${hasStages ? `到截止日期共 ${periodDays} 天，按每天 ${availableMin} 分钟可用 ${capacityMin} 分钟` : `可用时间只有 ${capacityMin} 分钟`}，超出 ${overBy} 分钟。需要调整范围或周期。`,
    };
  }
  if (overBy < -capacityMin * 0.3) {
    return {
      totalMin, availableMin, capacityMin, periodDays, overBy, feasible: true, unestimated,
      verdict: `计划可行：预计 ${totalMin} 分钟，周期容量 ${capacityMin} 分钟${periodDays ? `（${periodDays} 天 × 每天 ${availableMin} 分钟）` : ''}。可以加任务，或保持当前节奏。`,
    };
  }
  return {
    totalMin, availableMin, capacityMin, periodDays, overBy, feasible: true, unestimated,
    verdict: `计划可行：预计 ${totalMin} / ${capacityMin} 分钟${periodDays ? `（${periodDays} 天 × 每天 ${availableMin} 分钟）` : ''}${unestimated ? `（有 ${unestimated} 项没估时）` : ''}。`,
  };
}

export async function savePlan({
  id, code, name, goal, deadline, availableMin, constraints,
  items, stages, replaceStages = false, priorities, rules, breaks, risks, fallback, doneCriteria, status,
} = {}) {
  const cur = id ? await db.plans.get(id) : null;
  const mergeStages = incoming => {
    const existing = (cur?.stages || []).map(normalizePlanStage);
    if (replaceStages || !existing.length) return (incoming || []).map(normalizePlanStage);
    const merged = [...existing];
    for (const raw of incoming || []) {
      const index = merged.findIndex(stage => (raw.id && stage.id === raw.id) || (raw.name && stage.name === raw.name));
      if (index < 0) { merged.push(normalizePlanStage(raw)); continue; }
      const previous = merged[index];
      const tasks = raw.tasks === undefined ? previous.tasks : (() => {
        const list = [...previous.tasks];
        for (const task of raw.tasks || []) {
          const taskIndex = list.findIndex(item => (task.id && item.id === task.id) || item.text === task.text);
          if (taskIndex < 0) list.push(normalizePlanTask(task));
          else list[taskIndex] = normalizePlanTask({ ...list[taskIndex], ...task, done: task.done ?? list[taskIndex].done });
        }
        return list;
      })();
      merged[index] = normalizePlanStage({ ...previous, ...raw, id: raw.id || previous.id, tasks });
    }
    return merged;
  };
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
    items: items === undefined ? (cur?.items || []).map(normalizePlanItem) : items.map(normalizePlanItem),
    stages: stages === undefined ? (cur?.stages || []).map(normalizePlanStage) : mergeStages(Array.isArray(stages) ? stages : []),
    priorities: priorities === undefined ? (cur?.priorities || {}) : (priorities || {}),
    rules: rules === undefined ? (cur?.rules || '') : String(rules || ''),
    breaks: String(breaks ?? cur?.breaks ?? ''),
    risks: risks === undefined ? (cur?.risks || []) : (Array.isArray(risks) ? risks.map(String).filter(Boolean) : []),
    fallback: String(fallback ?? cur?.fallback ?? ''),
    doneCriteria: String(doneCriteria ?? cur?.doneCriteria ?? ''),
    status: PLAN_STATUSES[status] ? status : (cur?.status || 'draft'),
    createdAt: cur?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };
  if (!rec.name) throw new Error('规划必须有名称');

  const feas = checkFeasibility(rec);
  rec.feasibility = {
    totalMin: feas.totalMin, capacityMin: feas.capacityMin ?? null,
    periodDays: feas.periodDays ?? null, overBy: feas.overBy, feasible: feas.feasible,
  };

  await db.plans.put(rec);
  notifyPrivateDataChanged();
  return { plan: rec, feasibility: feas };
}

export async function listPlans({ status, limit = 50 } = {}) {
  let all = await db.plans.toArray();
  if (status) all = all.filter(p => p.status === status);
  all = all.map(plan => {
    const feasibility = checkFeasibility(plan);
    return {
      ...plan,
      feasibility: {
        totalMin: feasibility.totalMin,
        capacityMin: feasibility.capacityMin ?? null,
        periodDays: feasibility.periodDays ?? null,
        overBy: feasibility.overBy,
        feasible: feasibility.feasible,
      },
    };
  });
  return all
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, limit);
}

export async function getPlan(id) {
  const plan = await db.plans.get(id);
  if (!plan) return undefined;
  const feasibility = checkFeasibility(plan);
  return {
    ...plan,
    feasibility: {
      totalMin: feasibility.totalMin,
      capacityMin: feasibility.capacityMin ?? null,
      periodDays: feasibility.periodDays ?? null,
      overBy: feasibility.overBy,
      feasible: feasibility.feasible,
    },
  };
}
export async function deletePlan(id) {
  await db.plans.delete(id);
  notifyPrivateDataChanged();
}

export async function setActivePlan(planId) {
  await setMeta('activePlanId', planId || '');
  return planId ? getPlan(planId) : null;
}

export async function getActivePlan() {
  const id = await getMeta('activePlanId', '');
  const selected = id ? await getPlan(id) : null;
  if (selected && selected.status !== 'abandoned' && selected.status !== 'done') return selected;
  return (await listPlans({})).find(p => p.status === 'active') || (await listPlans({}))[0] || null;
}

export async function togglePlanTask(planId, stageId, taskId) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('找不到这个规划');
  const stages = planStages(plan).map(stage => ({
    ...stage,
    tasks: stage.tasks.map(task => task.id === taskId ? { ...task, done: !task.done } : task),
  }));
  const updated = stages.find(stage => stage.id === stageId);
  if (updated?.tasks.length && updated.tasks.every(task => task.done)) updated.status = 'done';
  else if (updated?.tasks.some(task => task.done)) updated.status = 'partial';
  else if (updated) updated.status = 'active';
  await db.plans.update(planId, { stages, updatedAt: nowISO() });
  notifyPrivateDataChanged();
  return getPlan(planId);
}

export async function completePlanTaskSlice(planId, stageId, taskId, allocatedMin) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('找不到这个规划');
  const stages = planStages(plan);
  const stage = stages.find(item => item.id === stageId);
  const task = stage?.tasks.find(item => item.id === taskId);
  if (!task) throw new Error('找不到这个子任务');
  const initial = Number(task.remainingMin ?? task.estMin ?? allocatedMin) || 0;
  const remainingMin = Math.max(0, initial - Math.max(0, Number(allocatedMin) || 0));
  task.remainingMin = remainingMin;
  task.done = remainingMin === 0;
  if (stage.tasks.length && stage.tasks.every(item => item.done)) stage.status = 'done';
  else if (stage.tasks.some(item => item.done)) stage.status = 'partial';
  await db.plans.update(planId, { stages, updatedAt: nowISO() });
  notifyPrivateDataChanged();
  return getPlan(planId);
}

export async function activatePlanStage(planId, stageId) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('找不到这个规划');
  const stages = planStages(plan).map(stage => stage.id === stageId
    ? { ...stage, status: stage.tasks.some(task => task.done) ? 'partial' : 'active' }
    : (stage.status === 'active' ? { ...stage, status: 'not_started' } : stage));
  await db.plans.update(planId, { stages, currentStageId: stageId, updatedAt: nowISO() });
  notifyPrivateDataChanged();
  return getPlan(planId);
}

export async function movePlanStage(planId, stageId, offset) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('找不到这个规划');
  const stages = planStages(plan);
  const index = stages.findIndex(stage => stage.id === stageId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= stages.length) return plan;
  const [stage] = stages.splice(index, 1);
  stages.splice(target, 0, stage);
  await db.plans.update(planId, { stages, updatedAt: nowISO() });
  return getPlan(planId);
}

export function activePlanStage(plan) {
  const stages = planStages(plan);
  if (plan?.currentStageId) return stages.find(stage => stage.id === plan.currentStageId) || null;
  return stages.find(stage => stage.status === 'active')
    || stages.find(stage => stage.status === 'partial')
    || stages.find(stage => stage.status !== 'done') || null;
}

export function schedulePlanTasks(plan, availableMin) {
  const budget = Math.max(0, Number(availableMin) || 0);
  const stage = activePlanStage(plan);
  if (!stage) return { stage: null, tasks: [], complete: true, remainingMin: budget };
  const stages = planStages(plan);
  const stageIndex = stages.findIndex(item => item.id === stage.id);
  const regular = stage.tasks.filter(task => !task.done).map(task => ({ ...task, sourceStage: stage.name, sourceStageId: stage.id }));
  const exceptions = stages.slice(stageIndex + 1).flatMap(later => later.tasks
    .filter(task => !task.done && task.earlyStart)
    .map(task => ({ ...task, sourceStage: later.name, sourceStageId: later.id, exceptionTask: true })));
  const pending = [...exceptions, ...regular]
    .sort((a, b) => a.priority - b.priority);
  const tasks = [];
  let remainingMin = budget;
  for (const task of pending) {
    if (remainingMin <= 0) break;
    const estimate = Math.max(0, Number(task.remainingMin ?? task.estMin) || remainingMin);
    const allocatedMin = Math.min(estimate || remainingMin, remainingMin);
    if (allocatedMin <= 0) continue;
    tasks.push({ ...task, allocatedMin, partial: estimate > allocatedMin });
    remainingMin -= allocatedMin;
  }
  return { stage, tasks, complete: pending.length === 0, remainingMin };
}

/** 勾掉/取消勾掉某一项 */
export async function togglePlanItem(planId, index) {
  const plan = await db.plans.get(planId);
  if (!plan) throw new Error('找不到这个规划');
  const items = (plan.items || []).map(normalizePlanItem);
  if (!items[index]) throw new Error('没有这一项');
  items[index].done = !items[index].done;
  await db.plans.update(planId, { items, updatedAt: nowISO() });
  notifyPrivateDataChanged();
  return db.plans.get(planId);
}

/** 第一项还没做完的工作 —— §14 第五轮"推动他开始第一项" */
export function nextPlanAction(plan) {
  const stage = activePlanStage(plan);
  if (stage) {
    const task = stage.tasks.find(item => !item.done);
    return task ? { ...task, stageId: stage.id, stageName: stage.name, startWith: task.minAction || task.text } : null;
  }
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
