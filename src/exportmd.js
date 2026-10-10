// ── Markdown 结构化导出（§十六、§十九）──────────────────────
//
// §19 要求导出的记录至少包含：用户档案、当前任务、任务状态、计划与实际
// 时间、已完成、进行中、规划、SOP、积分、主要拖延模式、有效策略、下次
// 继续监督的事项。
//
// 设计要点：**导出的内容必须自包含**。换一个 AI、换一台电脑，光靠这份
// Markdown 就能接着监督。所以不做引用、不省略、"未记录"要如实写。

import {
  db, listTasks, listTopics, getProfile, getKeyTasks, profileCompletion,
  ADHD_STATUS, TASK_STATES, PRIORITIES, AREAS,
} from './db.js';
import { listTimeEntries, estimationStats } from './timer.js';
import { getLedger, listRewards } from './ledger.js';
import { listCheckins, listReviews, patternStats, PROCRASTINATION_PATTERNS, effectiveStrategies, isMedsEnabled } from './records.js';
import { listPlans, listSops, PLAN_STATUSES } from './docs.js';
import { computeToday } from './planner.js';
import { dateStr, download, fmtDateTime, daysUntil } from './util.js';

const NA = '未记录';
const v = x => {
  if (x === null || x === undefined) return NA;
  const s = String(x).trim();
  return s || NA;
};
const num = x => (x === null || x === undefined || x === '' ? NA : String(x));

const fmtMin = m => (m === null || m === undefined ? NA : `${m} 分钟`);

/**
 * 生成完整的 Markdown 记录。
 * @param {object} [opts]
 * @param {boolean} [opts.includeAll] 是否包含全部历史（默认只含近期）
 */
export async function buildMarkdownExport({ includeAll = false } = {}) {
  const today = await computeToday();
  const [
    profile, tasks, topics, plans, sops, checkins, reviews, ledger,
    rewards, patterns, strategies, entries, estimation, keyRec, medsEnabled,
  ] = await Promise.all([
    getProfile(), listTasks(), listTopics(), listPlans({}), listSops({}),
    listCheckins(includeAll ? 500 : 30), listReviews({ limit: includeAll ? 500 : 40 }),
    getLedger({ recentLimit: includeAll ? 500 : 40 }), listRewards(),
    patternStats(), effectiveStrategies(20), listTimeEntries({ limit: includeAll ? 1000 : 60 }),
    estimationStats(), getKeyTasks(), isMedsEnabled(),
  ]);

  const comp = profileCompletion(profile);
  const L = [];
  const h = (lvl, text) => L.push(`${'#'.repeat(lvl)} ${text}`, '');
  const p = text => { if (text) L.push(text, ''); };

  /* ── 头部 ── */
  h(1, '帕尼尼 · 监督记录导出');
  p(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  p(`数据范围：${includeAll ? '全部历史' : '近期记录（最近 30 天打卡 / 40 条复盘 / 60 条时间记录）'}`);
  p('> 这份文档是自包含的。换到新的 AI 会话时，把它整份贴进去即可继续监督。');

  /* ── 一、用户档案（§四）── */
  h(2, '一、用户档案');
  p(`档案完成度：必填 ${comp.requiredDone}/${comp.requiredTotal}，可选 ${comp.optionalDone}/${comp.optionalTotal}`);
  if (!comp.isOnboarded) p(`⚠️ 初始化尚未完成。缺少：${comp.missingRequired.join('、') || '（无）'}`);
  L.push('| 项目 | 内容 |', '| --- | --- |');
  const pf = [
    ['称呼', profile.userName],
    ['监督员称呼', profile.supervisorName],
    ['偏好形象', profile.supervisorImage],
    ['ADHD 状态', ADHD_STATUS[profile.adhdStatus] || ''],
    ['当前最困扰的三个问题', profile.topProblems],
    ['希望重点监督', profile.focusAreas],
    ['最常见的拖延行为', profile.procrastinationPatterns],
    ['有效的奖励方式', profile.rewardPreference],
    ['可接受的提醒/纠偏方式', profile.acceptableCorrections],
    ['用三个词描述自己', profile.selfWords],
    ['不喜欢的表达方式（雷区）', (profile.taboos || []).join('；')],
    ['其他需求', profile.otherNeeds],
    ['表达强度设定', `${profile.toneLevel ?? 5}/5`],
    ['粗口授权', profile.allowProfanity ? '已授权' : '未授权'],
    ['当前监督状态', profile.suspendUntil ? `⛔ 暂停中（${profile.suspendUntil}）` : '正常'],
  ];
  for (const [k, val] of pf) L.push(`| ${k} | ${v(val)} |`);
  L.push('');

  /* ── 二、任务总览 ── */
  h(2, '二、任务与状态');
  p(`共 ${tasks.length} 个任务。进行中 ${today.active.length}，受阻 ${today.blocked.length}，今天完成 ${today.doneToday.length}。`);

  h(3, '今日关键任务');
  if (!keyRec.ids.length) p('未记录（今天没有指定关键任务）');
  else {
    for (const id of keyRec.ids) {
      const t = tasks.find(x => x.id === id);
      p(t ? `- [${t.state === 'DONE' ? 'x' : ' '}] ${t.title}　${t.state}/${t.priority}` : `- （任务 ${id} 已被删除）`);
    }
  }

  const stateOrder = ['DOING', 'BLOCKED', 'READY', 'NEXT', 'INBOX', 'DEFERRED', 'DONE', 'CANCELLED'];
  for (const st of stateOrder) {
    const list = tasks.filter(t => t.state === st);
    if (!list.length) continue;
    h(3, `${st}｜${TASK_STATES[st].label}（${list.length}）`);
    for (const t of list.slice(0, includeAll ? 999 : 20)) {
      L.push(`**${t.title}**　\`${t.id}\``);
      L.push('');
      L.push('| 字段 | 值 |', '| --- | --- |');
      const rows = [
        ['优先级', `${t.priority}（${PRIORITIES[t.priority]?.label || ''}）`],
        ['领域', AREAS[t.area]?.label || t.area],
        ['目标', t.goal],
        ['计划开始时间', t.plannedStart],
        ['实际开始时间', t.actualStart ? fmtDateTime(t.actualStart) : ''],
        ['实际结束时间', t.actualEnd ? fmtDateTime(t.actualEnd) : ''],
        ['预计耗时', fmtMin(t.estimateMin)],
        ['实际耗时', fmtMin(t.actualMin)],
        ['截止时间', t.dueAt ? `${t.dueAt}${daysUntil(t.dueAt) !== null ? `（${daysUntil(t.dueAt) < 0 ? `逾期 ${-daysUntil(t.dueAt)} 天` : daysUntil(t.dueAt) === 0 ? '今天' : `${daysUntil(t.dueAt)} 天后`}）` : ''}` : ''],
        ['下一步行动', t.nextAction],
        ['当前阻碍', t.blocker],
        ['情绪', t.mood ? `${t.mood}/5` : ''],
        ['注意力', t.attention ? `${t.attention}/5` : ''],
        ['进度', `${t.progress ?? 0}%`],
        ['完成情况', t.outcome],
        ['复盘结论', t.review],
        ['里程碑', (t.milestones || []).join(' → ')],
        ['备注', t.notes],
        ['创建时间', fmtDateTime(t.createdAt)],
        ['最后更新', fmtDateTime(t.updatedAt)],
      ];
      for (const [k, val] of rows) if (v(val) !== NA) L.push(`| ${k} | ${val} |`);
      L.push('');
    }
    if (list.length > 20 && !includeAll) p(`…还有 ${list.length - 20} 个，完整导出请用「全部历史」`);
  }

  /* ── 三、时间记录 ── */
  h(2, '三、计划与实际时间');
  if (!entries.length) p('未记录（还没有任何时间记录）');
  else {
    p(`共 ${entries.length} 笔。其中真实计时 ${entries.filter(e => e.source === 'timer').length} 笔，用户自报 ${entries.filter(e => e.source !== 'timer').length} 笔。`);
    p(`预估能力：${estimation.established ? estimation.verdict + `（${estimation.samples} 个样本）` : '样本不足，尚未建立'}`);
    L.push('| 日期 | 任务 | 计划 | 实际 | 来源 | 自报 | 差额 | 备注 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const e of entries.slice(0, includeAll ? 999 : 40)) {
      const t = tasks.find(x => x.id === e.taskId);
      L.push(`| ${e.date || NA} | ${v(t?.title)} | ${num(e.plannedMin)} | ${num(e.actualMin)} | ${e.source === 'timer' ? '计时' : '自报'} | ${num(e.selfReportedMin)} | ${e.driftMin === null || e.driftMin === undefined ? NA : (e.driftMin > 0 ? `+${e.driftMin}` : e.driftMin)} | ${v(e.note)} |`);
    }
    L.push('');
  }

  /* ── 四、生活打卡 ── */
  h(2, '四、生活打卡');
  if (!checkins.length) p('未记录（还没有打卡记录）');
  else {
    L.push('| 日期 | 睡眠 | 起床 | 精力 | 情绪 | 注意力 | 饮水 | 学习 | 工作 | 最重要任务 | 最大阻碍 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of checkins) {
      L.push(`| ${c.date} | ${num(c.sleepHours)} | ${v(c.wakeAt)} | ${num(c.energy)} | ${num(c.mood)} | ${num(c.attention)} | ${num(c.water)} | ${num(c.studyMin)} | ${num(c.workMin)} | ${v(c.topTask)} | ${v(c.blocker)} |`);
    }
    L.push('');
    if (medsEnabled) p('（服药记录字段已开启。**导出仅作记录，不构成任何医疗建议。**）');
  }

  /* ── 五、积分账本 ── */
  h(2, '五、积分账本');
  if (!ledger.established) {
    p('**尚未建立积分账本。** 没有任何积分记录。');
  } else {
    p(`累计：**${ledger.total}** 分（已确认 ${ledger.confirmedTotal}，待确认 ${ledger.pendingTotal}）　共 ${ledger.count} 笔`);
    L.push('| 日期 | 增减 | 原因 | 类型 | 已确认 |', '| --- | --- | --- | --- | --- |');
    for (const e of ledger.recent.slice(0, includeAll ? 999 : 40)) {
      L.push(`| ${e.date} | ${e.delta > 0 ? '+' : ''}${e.delta} | ${e.reason} | ${e.kind} | ${e.confirmed ? '是' : '否'} |`);
    }
    L.push('');
    if (rewards.length) {
      p('**可兑换奖励：**');
      for (const r of rewards) p(`- ${r.name}　${r.cost} 分${r.note ? `　${r.note}` : ''}${r.redeemedCount ? `（已兑换 ${r.redeemedCount} 次）` : ''}`);
    } else p('可兑换奖励：未记录（还没设置）');
  }

  /* ── 六、规划 ── */
  h(2, '六、规划');
  if (!plans.length) p('未记录（还没有任何规划）');
  else {
    for (const pl of plans) {
      const items = pl.items || [];
      const done = items.filter(i => i.done).length;
      h(3, `${pl.code}｜${pl.name}`);
      p(`状态：${PLAN_STATUSES[pl.status]?.label || pl.status}　进度：${done}/${items.length}`);
      if (pl.goal) p(`目标：${pl.goal}`);
      if (pl.deadline) p(`截止：${pl.deadline}`);
      if (pl.availableMin) p(`可用时间：${pl.availableMin} 分钟`);
      if (pl.constraints) p(`约束：${pl.constraints}`);
      if (pl.feasibility) {
        p(pl.feasibility.feasible === false
          ? `⚠️ **可行性：过载**（预计 ${pl.feasibility.totalMin} 分钟，超出 ${pl.feasibility.overBy} 分钟）`
          : `可行性：可接受（预计 ${pl.feasibility.totalMin} 分钟）`);
      }
      for (const [i, it] of items.entries()) {
        p(`${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}${it.estMin ? `　(${it.estMin} 分钟)` : ''}${it.minAction ? `\n   - 启动动作：${it.minAction}` : ''}`);
      }
      if (pl.breaks) p(`休息安排：${pl.breaks}`);
      if ((pl.risks || []).length) p(`可能阻碍：${pl.risks.join('、')}`);
      if (pl.fallback) p(`备用方案：${pl.fallback}`);
      if (pl.doneCriteria) p(`完成标准：${pl.doneCriteria}`);
    }
  }

  /* ── 七、SOP ── */
  h(2, '七、SOP');
  if (!sops.length) p('未记录（还没有任何 SOP）');
  else {
    for (const s of sops) {
      h(3, s.name);
      p(`- 适用场景：${v(s.scene)}`);
      p(`- 执行目标：${v(s.goal)}`);
      p(`- 所需材料：${(s.materials || []).join('、') || NA}`);
      p(`- 预计耗时：${fmtMin(s.estimateMin)}`);
      p(`- 执行前准备：${(s.prep || []).join('、') || NA}`);
      p(`- **一分钟启动版：${v(s.quickStart)}**`);
      p('');
      p('详细步骤：');
      for (const [i, st] of (s.steps || []).entries()) p(`${i + 1}. [${st.done ? 'x' : ' '}] ${st.text}`);
      if ((s.blockers || []).length) p(`常见阻碍：${s.blockers.join('、')}`);
      if (s.exceptions) p(`异常处理：${s.exceptions}`);
      if (s.doneCriteria) p(`完成标准：${s.doneCriteria}`);
      if ((s.checklist || []).length) {
        p('检查清单：');
        for (const c of s.checklist) p(`- [${c.done ? 'x' : ' '}] ${c.text}`);
      }
      if (s.review) p(`复盘与改进：${s.review}`);
    }
  }

  /* ── 八、复盘与拖延模式 ── */
  h(2, '八、复盘记录与拖延模式');

  h(3, '拖延模式统计');
  if (!patterns.established) p('未记录（还没有拖延模式记录）');
  else {
    p(`共 ${patterns.samples} 次记录。**最常见的模式是 ${patterns.top.pattern} ${patterns.top.label}**（${patterns.top.count} 次）。`);
    L.push('| 模式 | 名称 | 次数 | 建议应对 |', '| --- | --- | --- | --- |');
    for (const c of patterns.counts) L.push(`| ${c.pattern} | ${c.label} | ${c.count} | ${c.fix} |`);
    L.push('');
  }

  h(3, '有效策略');
  if (!strategies.length) p('未记录（还没有沉淀出有效策略）');
  else for (const s of strategies) p(`- ${s.date}：${s.action}${s.lesson ? `　→ ${s.lesson}` : ''}`);

  h(3, '复盘明细');
  if (!reviews.length) p('未记录');
  else {
    for (const r of reviews.slice(0, includeAll ? 999 : 20)) {
      h(4, `${r.date}｜${r.kind}${r.pattern ? `｜模式 ${r.pattern} ${PROCRASTINATION_PATTERNS[r.pattern]?.label || ''}` : ''}`);
      if (r.facts?.planned) p(`- 原本要做什么：${r.facts.planned}`);
      if (r.facts?.actual) p(`- 实际做了什么：${r.facts.actual}`);
      if (r.facts?.deviationStart) p(`- 偏离起点：${r.facts.deviationStart}`);
      if (r.facts?.whatHappened) p(`- 发生了什么：${r.facts.whatHappened}`);
      if ((r.triggers || []).length) p(`- 触发因素：${r.triggers.join('、')}`);
      if ((r.thoughts || []).length) p(`- 自动化思维：${r.thoughts.join(' / ')}`);
      if ((r.reframes || []).length) p(`- 重构：${r.reframes.join(' / ')}`);
      p(`- **补救行动：${r.action}**`);
      if (r.lesson) p(`- 预防措施：${r.lesson}`);
    }
  }

  /* ── 九、学习模块 ── */
  h(2, '九、知识点与复习');
  if (!topics.length) p('未记录（还没有知识点）');
  else {
    p(`共 ${topics.length} 个知识点，今天到期 ${today.dueCount} 个。`);
    L.push('| 知识点 | 掌握度 | 复习次数 | 间隔 | 下次复习 | 备注 |', '| --- | --- | --- | --- | --- | --- |');
    for (const t of topics.slice(0, includeAll ? 999 : 50)) {
      L.push(`| ${t.name} | ${t.mastery ?? 0}/5 | ${t.reps ?? 0} | ${t.interval || 0} 天 | ${(t.nextReviewAt || '').slice(0, 10) || NA} | ${v(t.note)} |`);
    }
    L.push('');
  }

  /* ── 十、待续 ── */
  h(2, '十、下次继续监督的事项');
  const todo = [];
  if (!comp.isOnboarded) todo.push(`**完成用户初始化**（还差：${comp.missingRequired.join('、')}）`);
  if (!keyRec.ids.length && today.active.length) todo.push('**给今天指定 1-3 个关键任务**');
  for (const t of today.blocked) todo.push(`解除受阻：${t.title}（${t.blocker || '⚠️ 阻碍未记录'}）`);
  for (const t of today.overdue) todo.push(`处理逾期：${t.title}（逾期 ${t.overdueDays} 天）`);
  for (const t of today.stalled.slice(0, 5)) todo.push(`推进停滞：${t.title}（${t.idleDays} 天没动）`);
  for (const pl of today.overloadedPlans) todo.push(`缩减规划 ${pl.code}｜${pl.name}（超出 ${pl.feasibility.overBy} 分钟）`);
  if (today.dueCount) todo.push(`复习 ${today.dueCount} 个到期知识点`);
  if (patterns.established) todo.push(`针对高频拖延模式 ${patterns.top.pattern} ${patterns.top.label} 制定预防动作`);
  if (ledger.established && ledger.unconfirmed.length) todo.push(`确认 ${ledger.unconfirmed.length} 笔待确认积分`);
  if (profile.suspendUntil) todo.push('⚠️ 当前处于暂停监督状态，先确认用户是否要恢复');
  if (!todo.length) todo.push('没有待办事项。可以推进主线或开新的目标。');

  for (const [i, t] of todo.entries()) p(`${i + 1}. ${t}`);

  /* ── 十一、数据完整性声明 ── */
  h(2, '十一、数据说明');
  p(`- 所有"未记录"表示**数据库里确实没有这条信息**，不是遗漏，也不是零值。`);
  p(`- 时间记录区分来源：「计时」是程序记录的真实墙钟时间，「自报」是用户报告的。两者不一致时两侧都保留，不抹平。`);
  p(`- 本导出不含任何推测。凡是推断性内容都会明确标注。`);
  if (today.integrity.length) {
    p('- 导出时发现以下数据需要核对：');
    for (const i of today.integrity) p(`  - ${i.text}`);
  }

  return L.join('\n');
}

export async function downloadMarkdownExport(opts) {
  const md = await buildMarkdownExport(opts);
  download(`帕尼尼监督记录-${dateStr()}.md`, md, 'text/markdown');
  return md;
}

export function markdownStats(md) {
  return {
    chars: md.length,
    lines: md.split('\n').length,
    tokensApprox: Math.round(md.length / 2),
  };
}
