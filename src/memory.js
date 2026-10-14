// ── 记忆组装 ────────────────────────────────────────────────
//
// 职责分工：
//   persona.js  → 提示词工程（人设、规则、能力声明、按需流程）
//   memory.js   → 数据组装（把 15 张表变成帕尼尼能读的快照）+ 检索 + 压缩
//
// 分层注入原则不变：稳定内容在前（吃 prompt 缓存），易变内容在后。
//
// §3「不虚构」在代码层的落点：**表为空就注入"未建立"，绝不给默认值让模型圆。**

import {
  db, getMeta, getProfile, listTasks, listTopics, recentLogs, getKeyTasks,
  ACTIVE_STATES, TASK_STATES, PRIORITIES, AREAS, profileCompletion,
  PROFILE_LABELS as DB_PROFILE_LABELS, notifyPrivateDataChanged,
} from './db.js';
import { dueTopics, masteryFromInterval } from './srs.js';
import { getActiveTimer } from './timer.js';
import { getLedger } from './ledger.js';
import { getCheckin, patternStats, checkinSummary, isMedsEnabled } from './records.js';
import { detectIntent } from './commands.js';
import { assembleSystemPrompt, promptStats } from './persona.js';
import { streamChat } from './deepseek.js';
import { endOfToday, dateStr, daysUntil, nowISO } from './util.js';

const CJK = /[\u4e00-\u9fff]/;

export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.round(cjk * 0.75 + (s.length - cjk) * 0.3);
}

/* ══════════════ 一、能力事实（喂给 persona.capabilityBlock）══════════════ */

export function computeCapabilities() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return {
    pageOpen: true,             // 能生成这个 prompt 就说明页面开着
    timerAvailable: true,
    persistentMemory: true,
    // 通知尚未实现 —— 保持 false，直到真的做出来。
    // 这样模型永远不会承诺"我 20 分钟后提醒你"。
    notificationsEnabled: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    localTime: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`,
  };
}

/* ══════════════ 二、数据块格式化 ══════════════ */

const NA = '未记录';
const or = (v, fallback = NA) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
};

/**
 * L3 长期记忆：高重要性 + 时间衰减排序，取前 N 条永远注入。
 *
 * ⚠️ 这段曾经在重写时被整个漏掉过 —— 结果是长期记忆只能靠 search_memory
 * 检索才拿得到，等于把"分层记忆"里最该常驻的一层删了。冒烟测试抓到了。
 * 空表时必须如实说"还没有"，不能给个默认值让模型圆。
 */
export function fmtMemories(mems) {
  if (!mems.length) {
    return '（还没有长期记忆。随着对话会自动积累，也可以用 save_memory 主动写。）';
  }
  const byKind = { preference: '偏好', insight: '洞察', fact: '事实', summary: '摘要' };
  return mems.map(m => {
    const star = (m.importance ?? 3) >= 4 ? ' **【重要】**' : '';
    const tags = (m.tags || []).length ? `　#${m.tags.join(' #')}` : '';
    return `- [${byKind[m.kind] || m.kind}]${star} ${m.text}${tags}`;
  }).join('\n');
}

export function fmtProfileBlock(profile) {
  if (!profile) return '（档案尚未建立。用户还没做过初始化。）';
  const c = profileCompletion(profile);

  const rows = [
    ['称呼', profile.userName],
    ['学习背景与当前情况', profile.about],
    ['学习目标', profile.goals],
    ['当前学习重点', profile.focusAreas],
    ['学习方式与节奏', profile.learningPreferences],
    ['可用学习时间', profile.availableTime],
    ['现实限制', profile.constraints],
    ['学习困难或拖延情境', profile.topProblems],
    ['常见拖延行为', profile.procrastinationPatterns],
    ['有效的奖励方式', profile.rewardPreference],
    ['可接受的纠偏方式', profile.acceptableCorrections],
    ['其他需求', profile.otherNeeds],
  ].filter(([, v]) => v && String(v).trim());

  const lines = rows.map(([k, v]) => `- ${k}：${v}`);
  if ((profile.taboos || []).length) {
    lines.push(`- **雷区（严格执行）**：${profile.taboos.join('；')}`);
  }

  lines.push('');
  lines.push(`档案完成度：必填 ${c.requiredDone}/${c.requiredTotal}，可选 ${c.optionalDone}/${c.optionalTotal}。`);
  if (!c.isOnboarded) {
    lines.push(c.canStart
      ? '**学习档案核心信息已齐。** 用户确认后即可用于个性化学习安排。'
      : `**学习档案还可补充。** 尚未记录：${c.missingRequired.map(k => PROFILE_LABELS[k] || k).join('、')}。`
        + '需要了解时邀请用户点击「聊聊我」，按访谈规则逐题询问。');
  }

  return lines.join('\n');
}

// 档案字段中文名统一定义在 db.js，这里只是转出来给别处用
export const PROFILE_LABELS = DB_PROFILE_LABELS;

function fmtTaskLine(t, { verbose = true } = {}) {
  const bits = [`\`${t.id}\``, `**${t.title}**`, `${t.state}/${t.priority}`, AREAS[t.area]?.label || t.area];
  if (t.state === 'DONE' || t.state === 'CANCELLED') {
    if (t.actualEnd) bits.push(`结束 ${t.actualEnd.slice(0, 16).replace('T', ' ')}`);
    if (t.actualMin != null) bits.push(`实际 ${t.actualMin} 分钟`);
    if (t.outcome) bits.push(`完成情况：${t.outcome}`);
    if (t.review) bits.push(`复盘：${t.review}`);
    return `- ${bits.join('　')}`;
  }
  if (!verbose) return `- ${bits.join('　')}`;

  if (t.goal) bits.push(`目标：${t.goal}`);
  if (t.dueAt) {
    const d = daysUntil(t.dueAt);
    bits.push(`截止 ${t.dueAt}${d < 0 ? `（逾期 ${-d} 天）` : d === 0 ? '（今天）' : `（${d} 天后）`}`);
  }
  if (t.estimateMin != null) bits.push(`预计 ${t.estimateMin} 分钟`);
  if (t.actualMin != null) bits.push(`实际 ${t.actualMin} 分钟`);
  if (t.actualStart) bits.push(`开始 ${t.actualStart.slice(0, 16).replace('T', ' ')}`);
  if (t.nextAction) bits.push(`下一步：${t.nextAction}`);
  if (t.blocker) bits.push(`**阻碍：${t.blocker}**`);
  if (t.progress) bits.push(`进度 ${t.progress}%`);
  return `- ${bits.join('　')}`;
}

export function fmtTaskBoard(tasks, keyTaskIds = []) {
  if (!tasks.length) {
    return '（任务池是空的。用户还没记录过任何任务。）';
  }

  const blocks = [];
  const order = ['DOING', 'BLOCKED', 'READY', 'NEXT', 'INBOX', 'DEFERRED', 'DONE', 'CANCELLED'];
  const limits = { DOING: 20, BLOCKED: 20, READY: 15, NEXT: 15, INBOX: 10, DEFERRED: 10, DONE: 8, CANCELLED: 5 };

  for (const state of order) {
    const list = tasks.filter(t => t.state === state);
    if (!list.length) continue;
    const shown = list.slice(0, limits[state] ?? 10);
    const header = `## ${state}（${TASK_STATES[state].label}）— 共 ${list.length} 个`;
    const body = shown.map(t => fmtTaskLine(t, { verbose: !['DONE', 'CANCELLED', 'INBOX'].includes(state) }));
    if (list.length > shown.length) body.push(`- …还有 ${list.length - shown.length} 个`);
    blocks.push(`${header}\n${body.join('\n')}`);
  }

  if (keyTaskIds.length) {
    blocks.unshift(`**今日关键任务**（§5.3 每天最多 3 个）：${keyTaskIds.map(id => `\`${id}\``).join('、')}`);
  }

  return blocks.join('\n\n');
}

export function fmtKeyTasksBlock(keyTasks, keyIds) {
  if (!keyIds.length) {
    return '（今天还没指定关键任务。如果用户状态还行，可以主动帮他挑 1-3 个。）';
  }
  if (!keyTasks.length) {
    return '（关键任务列表里的任务已被删除，需要重新指定。）';
  }
  return keyTasks.map(t => fmtTaskLine(t, { verbose: true })).join('\n');
}

export function fmtLedgerBlock(ledger) {
  if (!ledger.established) {
    return '**尚未建立积分账本。** 没有任何积分记录。\n'
      + '→ 不要编造任何积分历史，不要假设"他有多少分"。要用就说清楚现在才开始记。';
  }
  const lines = [
    `累计：**${ledger.total}** 分（已确认 ${ledger.confirmedTotal} 分，待确认 ${ledger.pendingTotal} 分）`,
    `今天：${ledger.todayDelta > 0 ? '+' : ''}${ledger.todayDelta} 分　共 ${ledger.count} 笔记录`,
  ];
  if (ledger.unconfirmed.length) {
    lines.push(`⚠️ 有 ${ledger.unconfirmed.length} 笔尚未经用户确认，不要当成既成事实。`);
  }
  if (ledger.recent.length) {
    lines.push('最近记录：');
    lines.push(...ledger.recent.slice(0, 8).map(e =>
      `- ${e.date}　${e.delta > 0 ? '+' : ''}${e.delta}　${e.reason}${e.confirmed ? '' : '（未确认）'}`));
  }
  return lines.join('\n');
}

export function fmtCheckinBlock(checkin, medsEnabled) {
  if (!checkin) return '（今天还没有打卡记录。）';
  const rows = [
    ['睡眠时长', checkin.sleepHours ? `${checkin.sleepHours} 小时` : ''],
    ['起床时间', checkin.wakeAt],
    ['精力', checkin.energy ? `${checkin.energy}/5` : ''],
    ['情绪', checkin.mood ? `${checkin.mood}/5` : ''],
    ['注意力', checkin.attention ? `${checkin.attention}/5` : ''],
    ['饮水', checkin.water != null ? `${checkin.water} 杯` : ''],
    ['饮食', checkin.meals],
    ['洗漱', checkin.washed === null || checkin.washed === undefined ? '' : (checkin.washed ? '已完成' : '未完成')],
    ['运动', checkin.exercise],
    ['学习', checkin.studyMin != null ? `${checkin.studyMin} 分钟` : ''],
    ['工作', checkin.workMin != null ? `${checkin.workMin} 分钟` : ''],
    ['今日最重要任务', checkin.topTask],
    ['当前最大阻碍', checkin.blocker],
    ['今日已完成', checkin.doneToday],
    ['下一步', checkin.nextAction],
    ['备注', checkin.note],
  ];
  if (medsEnabled && checkin.meds) rows.push(['服药（用户主动记录）', checkin.meds]);

  return rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `- ${k}：${v}`).join('\n')
    || '（今天有打卡记录，但各字段都为空。）';
}

export function fmtDueBlock(due, allTopics) {
  if (!due.length) {
    return allTopics.length
      ? `（今天没有到期复习。另有 ${allTopics.length} 个知识点未到期。）`
      : '（还没有任何知识点。学习模块尚未开始使用。）';
  }
  return due.map(t => {
    const overdue = t.nextReviewAt < new Date().toISOString().slice(0, 10);
    return `- \`${t.id}\` **${t.name}**（掌握度 ${t.mastery ?? 0}/5，间隔 ${t.interval || 0} 天${overdue ? '，**已逾期**' : ''}）`
      + `${t.note ? `　备注：${t.note}` : ''}`;
  }).join('\n');
}

function fmtRecentActivity(logs, entries) {
  const items = [];
  for (const l of logs.slice(0, 10)) {
    const bits = [l.date, l.topicName || '', l.minutes ? `${l.minutes} 分钟` : '', l.what || '', l.blockers ? `卡点：${l.blockers}` : ''];
    items.push(`- ${bits.filter(Boolean).join('　')}`);
  }
  for (const e of entries.slice(0, 6)) {
    const bits = [
      e.date,
      e.actualMin != null ? `实际 ${e.actualMin} 分钟` : '',
      e.plannedMin ? `（计划 ${e.plannedMin}）` : '',
      e.source === 'timer' ? '计时' : '自报',
      e.note || '',
      e.driftMin ? `自报与计时差 ${e.driftMin > 0 ? '+' : ''}${e.driftMin} 分钟` : '',
    ];
    items.push(`- ${bits.filter(Boolean).join('　')}`);
  }
  return items.length ? items.join('\n') : '（还没有任何活动记录。）';
}

/** §6/§10 的信号：停滞、逾期、受阻 —— 中性陈述，不作失败判定 */
function fmtSignals(state) {
  const rows = [];
  const t = state.timer;
  if (t) {
    rows.push(`- **计时中**：${t.label}，已过 ${t.elapsedText}${t.plannedMin ? `（计划 ${t.plannedMin} 分钟）` : ''}${t.stale ? '　⚠️ 超过 8 小时，多半忘了停' : ''}`);
  }
  for (const x of state.blocked.slice(0, 4)) {
    rows.push(`- **受阻**：${x.title}　${x.blocker ? `原因：${x.blocker}` : '⚠️ 没写阻碍是什么'}`);
  }
  for (const x of state.overdue.slice(0, 4)) {
    rows.push(`- **逾期 ${x.overdueDays} 天**：${x.title}　截止 ${x.dueAt}`);
  }
  for (const x of state.stalled.slice(0, 4)) {
    rows.push(`- **停滞 ${x.idleDays} 天**：${x.title}　最后活动 ${x.lastTouchedAt?.slice(0, 10)}`);
  }
  for (const x of state.overloadedPlans.slice(0, 2)) {
    rows.push(`- **规划过载**：${x.code} ${x.name}　预计 ${x.feasibility.totalMin} 分钟但可用只有 ${x.availableMin} 分钟，超 ${x.feasibility.overBy} 分钟`);
  }
  if (!rows.length) return '（没有受阻、逾期、停滞或过载的信号。）';
  return `${rows.join('\n')}\n\n→ 这些是本次对话应当处理的重点。**停滞和逾期要如实指出，但不要把它说成"你失败了"**（§3 第 7 条）。`;
}

export function fmtPatternBlock(patterns, checkinTrend) {
  const lines = [];
  if (patterns.established) {
    lines.push(`近 ${patterns.samples} 次记录里，最常见的拖延模式是 **${patterns.top.pattern} ${patterns.top.label}**（${patterns.top.count} 次）。`);
    lines.push(patterns.counts.slice(0, 4).map(c => `- ${c.pattern} ${c.label}：${c.count} 次（应对：${c.fix}）`).join('\n'));
  } else {
    lines.push('（还没有拖延模式记录。判断出来后用 record_procrastination 记下来，攒够才能看出规律。）');
  }
  if (checkinTrend?.established && (checkinTrend.avgEnergy || checkinTrend.avgSleep)) {
    lines.push('');
    const bits = [];
    if (checkinTrend.avgSleep) bits.push(`平均睡眠 ${checkinTrend.avgSleep.toFixed(1)} 小时`);
    if (checkinTrend.avgEnergy) bits.push(`精力 ${checkinTrend.avgEnergy.toFixed(1)}/5`);
    if (checkinTrend.avgAttention) bits.push(`注意力 ${checkinTrend.avgAttention.toFixed(1)}/5`);
    if (checkinTrend.avgMood) bits.push(`情绪 ${checkinTrend.avgMood.toFixed(1)}/5`);
    lines.push(`近 ${checkinTrend.samples} 天打卡：${bits.join('　')}`);
    if (checkinTrend.note) lines.push(`（${checkinTrend.note}。睡眠与执行力的关系可以提，但**相关不等于因果**，不要下诊断。）`);
  }
  return lines.join('\n');
}

/* ══════════════ 三、总装 ══════════════ */

/**
 * 组装发给模型的消息数组。
 * @returns {Promise<{messages:Array, debug:object, intent:object}>}
 */
export async function buildMessages({ sessionId, userText = '', codeNote = '' }) {
  const [profile, tasks, topics, logs, session, messages, memories] = await Promise.all([
    getProfile(),
    listTasks(),
    listTopics(),
    recentLogs(30),
    db.sessions.get(sessionId),
    db.messages.where('sessionId').equals(sessionId).sortBy('createdAt'),
    db.memories.toArray(),
  ]);

  // 重要性 + 时间衰减排序，取前 40 条常驻
  const topMemories = memories
    .slice()
    .sort((a, b) => {
      const sa = (a.importance ?? 3) * 2 + recencyFactor(a.createdAt);
      const sb = (b.importance ?? 3) * 2 + recencyFactor(b.createdAt);
      return sb - sa;
    })
    .slice(0, 40);

  const [keyRec, timer, ledger, checkin, patterns, checkinTrend, timeEntries, medsEnabled] = await Promise.all([
    getKeyTasks(),
    getActiveTimer(),
    getLedger({ recentLimit: 10 }),
    getCheckin(),
    patternStats(),
    checkinSummary(14),
    db.timeEntries.toArray(),
    isMedsEnabled(),
  ]);

  const keyTasks = [];
  for (const id of keyRec.ids) {
    const t = await db.tasks.get(id);
    if (t) keyTasks.push(t);
  }

  const endISO = endOfToday();
  const due = dueTopics(topics, endISO);
  const now = new Date();
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  /* 状态对象：给 fmtSignals 用 */
  const state = {
    timer, blocked: [], overdue: [], stalled: [], overloadedPlans: [], tasks,
  };
  const lastTouch = new Map();
  for (const l of logs) if (l.taskId && (!lastTouch.get(l.taskId) || l.createdAt > lastTouch.get(l.taskId))) lastTouch.set(l.taskId, l.createdAt);
  for (const e of timeEntries) if (e.taskId) { const k = e.endedAt || e.createdAt; if (!lastTouch.get(e.taskId) || k > lastTouch.get(e.taskId)) lastTouch.set(e.taskId, k); }
  const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

  const activeTasks = tasks.filter(t => ACTIVE_STATES.includes(t.state));
  state.blocked = tasks.filter(t => t.state === 'BLOCKED');
  state.overdue = activeTasks.filter(t => t.dueAt && daysUntil(t.dueAt) < 0);
  state.stalled = activeTasks
    .map(t => ({ ...t, idleDays: daysSince(lastTouch.get(t.id) || t.actualStart || t.createdAt) }))
    .filter(t => t.idleDays >= 3);

  const plans = (await db.plans.toArray()).filter(p => p.status === 'active' || p.status === 'draft');
  state.overloadedPlans = plans.filter(p => p.feasibility?.feasible === false);
  const activePlanId = await getMeta('activePlanId', '');
  const activePlan = plans.find(p => p.id === activePlanId) || plans.find(p => p.status === 'active') || plans[0] || null;
  const planningContext = activePlan ? (() => {
    const stages = Array.isArray(activePlan.stages) ? activePlan.stages : [];
    const current = stages.find(s => s.id === activePlan.currentStageId)
      || stages.find(s => s.status === 'active') || stages.find(s => s.status !== 'done');
    return [
      `当前主线：${activePlan.name}${activePlan.deadline ? `（目标期限：${activePlan.deadline}）` : ''}`,
      `全局优先级：${activePlan.priorities || '未设置'}`,
      `时间约束与例外：${activePlan.rules || activePlan.constraints || '未设置'}`,
      ...stages.map((stage, index) => `${index + 1}. ${stage.name} [${stage.status}]${stage.id === current?.id ? ' ← 当前激活阶段' : ''}${stage.dependsOn?.length ? `；依赖：${stage.dependsOn.join('、')}` : ''}\n${(stage.tasks || []).map(task => `  - [${task.done ? 'x' : ' '}] ${task.text}（优先级 ${task.priority || 3}${task.estMin ? `；${task.estMin} 分钟` : ''}）`).join('\n')}`),
    ].join('\n');
  })() : '尚无激活的主线规划。';

  /* ── 数据块 ── */
  const blocks = {
    profile: fmtProfileBlock(profile),
    memories: fmtMemories(topMemories),
    keyTasks: fmtKeyTasksBlock(keyTasks, keyRec.ids),
    board: fmtTaskBoard(tasks, keyRec.ids),
    points: fmtLedgerBlock(ledger),
    today: [
      `现在是 ${dateStr(now)}（星期${WEEKDAYS[now.getDay()]}）${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`,
      // 页面侧刚执行的确定性操作 —— 这是事实，不是模型推测的时间
      codeNote ? `\n## ⚙️ 本轮代码已执行（这是事实，直接采信，不要自己推算时间）\n${codeNote}` : '',
      `\n## 需要处理的信号\n${fmtSignals(state)}`,
      `\n## 主线与阶段规划（调度依据）\n${planningContext}\n空闲时只从当前激活阶段选择未完成子任务；遵守优先级和例外规则，不跨阶段派发。更新已有规划时只改用户明确提到的部分，保留其他阶段、任务和完成状态。`,
      `\n## 今天的打卡\n${fmtCheckinBlock(checkin, medsEnabled)}`,
      `\n## 到期复习（学习模块）\n${fmtDueBlock(due, topics)}`,
      `\n## 拖延模式与身心趋势\n${fmtPatternBlock(patterns, checkinTrend)}`,
      `\n## 最近的活动记录\n${fmtRecentActivity(logs, timeEntries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 6))}`,
      `\n## 本会话更早的内容摘要\n${session?.summary || '（本次会话刚开始，没有更早的内容。）'}`,
    ].join('\n'),
  };

  /* ── 流程：全量注入，不再按意图正则挑 ──
     见 persona.assembleSystemPrompt 的注释：正则实测漏掉 50% 的常用说法，
     而流程段落完全静态、缓存友好，全量注入的实际成本约 200 token 当量。 */
  const intent = detectIntent(userText);

  const systemPrompt = assembleSystemPrompt({
    profile,
    caps: computeCapabilities(),
    blocks,
  });

  /* ── 历史消息 ── */
  const recent = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => m.content)
    .slice(-14);

  const history = recent.map(m => ({ role: m.role, content: m.content }));
  if (userText && history[history.length - 1]?.content !== userText) {
    history.push({ role: 'user', content: userText });
  }

  const stats = promptStats(systemPrompt);

  return {
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    intent,
    debug: {
      systemTokens: stats.tokens,
      systemChars: stats.chars,
      historyCount: history.length,
      dueCount: due.length,
      taskCount: tasks.length,
      codeAction: intent.codeAction,
      keyTasks: keyRec.ids.length,
      ledgerEstablished: ledger.established,
      timerRunning: Boolean(timer),
    },
  };
}

/* ══════════════ 四、检索 ══════════════ */

/** 中文按字和二元组切，英文按词切 */
function queryTerms(q) {
  const lower = String(q || '').toLowerCase();
  const out = new Set();
  for (const w of lower.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || [];
  for (const c of cjk) out.add(c);
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk[i] + cjk[i + 1]);
  return [...out];
}

function hitScore(text, terms) {
  const hay = String(text || '').toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!hay.includes(t)) continue;
    const weight = t.length >= 2 && CJK.test(t) ? 2.2 : 1;
    s += weight * Math.min(hay.split(t).length - 1, 4);
  }
  return s;
}

function recencyFactor(iso) {
  if (!iso) return 1;
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Math.max(0.5, 1 - days / 180);
}

/**
 * 关键词检索：在长期记忆、任务、时间记录、复盘、打卡、日志、知识点、历史对话里找。
 * 刻意不用向量 —— 零依赖、离线可用、结果可解释。
 */
export async function searchMemory(query, { limit = 8, from = null, to = null } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];

  const [memories, logs, topics, tasks, entries, reviews, checkins] = await Promise.all([
    db.memories.toArray(),
    db.logs.toArray(),
    db.topics.toArray(),
    db.tasks.toArray(),
    db.timeEntries.toArray(),
    db.reviews.toArray(),
    db.checkins.toArray(),
  ]);

  const results = [];
  const push = (o) => { if (o.score > 0) results.push(o); };

  for (const m of memories) {
    if (from && m.createdAt < from) continue;
    if (to && m.createdAt > to) continue;
    push({
      type: 'memory', score: hitScore(`${m.text} ${(m.tags || []).join(' ')}`, terms) * recencyFactor(m.createdAt) * (1 + (m.importance ?? 3) * 0.08),
      when: m.createdAt, title: `长期记忆 · ${m.kind}`, text: m.text,
    });
  }

  for (const t of tasks) {
    push({
      type: 'task', score: hitScore(`${t.title} ${t.goal} ${t.nextAction} ${t.blocker} ${t.outcome} ${t.review} ${t.notes}`, terms) * recencyFactor(t.updatedAt) * 1.1,
      when: t.updatedAt,
      title: `任务 · ${t.state}/${t.priority}`,
      text: [t.title, t.goal && `目标：${t.goal}`, t.blocker && `阻碍：${t.blocker}`, t.outcome && `完成情况：${t.outcome}`, t.review && `复盘：${t.review}`, t.actualMin != null && `实际 ${t.actualMin} 分钟`, t.dueAt && `截止 ${t.dueAt}`].filter(Boolean).join('　'),
    });
  }

  for (const l of logs) {
    push({
      type: 'log', score: hitScore(`${l.topicName} ${l.what} ${l.blockers}`, terms) * recencyFactor(l.createdAt) * 0.9,
      when: l.createdAt, title: `记录 · ${l.date}`,
      text: [l.topicName && `知识点：${l.topicName}`, l.minutes && `${l.minutes} 分钟`, l.what, l.blockers && `卡点：${l.blockers}`, l.grade != null && `自评 ${l.grade}/5`].filter(Boolean).join('　'),
    });
  }

  for (const e of entries) {
    push({
      type: 'time', score: hitScore(`${e.note} ${e.outcome}`, terms) * recencyFactor(e.createdAt) * 0.95,
      when: e.createdAt, title: `时间记录 · ${e.date}`,
      text: [e.note, e.outcome, e.actualMin != null && `实际 ${e.actualMin} 分钟`, e.plannedMin && `计划 ${e.plannedMin}`, e.driftMin != null && `自报差 ${e.driftMin}`].filter(Boolean).join('　'),
    });
  }

  for (const r of reviews) {
    const blob = `${r.facts?.planned} ${r.facts?.actual} ${r.facts?.whatHappened} ${(r.triggers || []).join(' ')} ${(r.thoughts || []).join(' ')} ${(r.reframes || []).join(' ')} ${r.action} ${r.lesson}`;
    push({
      type: 'review', score: hitScore(blob, terms) * recencyFactor(r.createdAt) * 1.15,
      when: r.createdAt, title: `复盘 · ${r.date}${r.pattern ? ` · 模式 ${r.pattern}` : ''}`,
      text: [r.facts?.whatHappened, (r.triggers || []).length && `触发：${r.triggers.join('、')}`, r.action && `行动：${r.action}`, r.lesson && `教训：${r.lesson}`].filter(Boolean).join('　'),
    });
  }

  for (const c of checkins) {
    push({
      type: 'checkin', score: hitScore(`${c.topTask} ${c.blocker} ${c.doneToday} ${c.note} ${c.meals} ${c.exercise}`, terms) * recencyFactor(c.updatedAt) * 0.85,
      when: c.updatedAt, title: `打卡 · ${c.date}`,
      text: [c.topTask && `最重要：${c.topTask}`, c.blocker && `阻碍：${c.blocker}`, c.sleepHours && `睡眠 ${c.sleepHours}h`, c.mood && `情绪 ${c.mood}/5`, c.attention && `注意力 ${c.attention}/5`].filter(Boolean).join('　'),
    });
  }

  for (const t of topics) {
    push({
      type: 'topic', score: hitScore(`${t.name} ${t.note}`, terms) * recencyFactor(t.updatedAt) * 1.05,
      when: t.updatedAt, title: `知识点 · 掌握度 ${t.mastery ?? 0}/5`,
      text: `${t.name}${t.note ? `　备注：${t.note}` : ''}`,
    });
  }

  if (results.length < 3) {
    const msgs = await db.messages.orderBy('createdAt').reverse().limit(400).toArray();
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      push({
        type: 'message', score: hitScore(m.content, terms) * recencyFactor(m.createdAt) * 0.7,
        when: m.createdAt, title: '你以前说过', text: m.content.slice(0, 300),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ══════════════ 五、滚动压缩 ══════════════ */

const COMPACT_THRESHOLD = 24;
const KEEP_RECENT = 10;

const COMPACT_PROMPT = `把下面这段「监督员 ↔ 用户」的对话压缩成结构化记忆。只输出 JSON，不要解释，不要代码块标记：

{
  "summary": "150 字以内。保留：用户原本要做什么、实际做了什么、卡在哪、做了什么决定、得出什么结论、还有什么没解决、他的状态（情绪/精力）。不要客套话。",
  "memories": [
    { "text": "值得长期记住的一句话（事实/偏好/结论/有效的应对策略）", "kind": "fact|insight|preference", "importance": 3, "tags": ["标签"] }
  ]
}

判断标准：一条记忆值不值得记，看它"三个月后还有用吗"。流水账不要记。
importance 取 1-5，5 表示对理解这个人最关键的事。

特别注意：如果对话里出现了有效的应对策略（哪种拆解方式他接受、哪个时间点他状态好、哪种催促反而让他更抵触），这类信息最值得记。`;

const stripFence = s => String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

export async function compactSession(sessionId, { force = false, signal } = {}) {
  const session = await db.sessions.get(sessionId);
  if (!session) return { compacted: false };

  const all = (await db.messages.where('sessionId').equals(sessionId).sortBy('createdAt'))
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content);

  const unsummarized = all.slice(session.summarizedUpTo || 0);
  if (!force && unsummarized.length <= COMPACT_THRESHOLD) {
    return { compacted: false, pending: unsummarized.length };
  }
  if (unsummarized.length <= 2) return { compacted: false, pending: unsummarized.length };

  const batch = force ? unsummarized : unsummarized.slice(0, unsummarized.length - KEEP_RECENT);
  if (batch.length < 3) return { compacted: false, pending: unsummarized.length };

  const transcript = batch.map(m => `${m.role === 'user' ? '用户' : '帕尼尼'}：${m.content}`).join('\n\n');
  const prior = session.summary ? `已有的更早摘要：\n${session.summary}\n\n---\n\n` : '';

  const res = await streamChat({
    messages: [
      { role: 'system', content: COMPACT_PROMPT },
      { role: 'user', content: `${prior}需要压缩的对话：\n\n${transcript}` },
    ],
    model: null,
    signal,
  });

  let parsed;
  try {
    parsed = JSON.parse(stripFence(res.content));
  } catch {
    parsed = { summary: res.content.trim().slice(0, 800), memories: [] };
  }

  const summary = String(parsed.summary || '').trim();
  const saved = [];
  for (const m of Array.isArray(parsed.memories) ? parsed.memories : []) {
    const text = String(m?.text || '').trim();
    if (text.length < 4) continue;
    const existing = await db.memories.toArray();
    if (existing.some(x => x.text === text)) continue;
    const mem = {
      id: `mem_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      kind: ['fact', 'insight', 'preference', 'summary'].includes(m.kind) ? m.kind : 'fact',
      text,
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 5).map(String) : [],
      taskId: '',
      importance: Math.min(5, Math.max(1, Number(m.importance) || 3)),
      sourceRefs: [],
      createdAt: nowISO(),
      lastUsedAt: null,
    };
    await db.memories.put(mem);
    saved.push(mem);
  }

  await db.sessions.update(sessionId, {
    summary: summary || session.summary,
    summarizedUpTo: (session.summarizedUpTo || 0) + batch.length,
    updatedAt: nowISO(),
  });
  notifyPrivateDataChanged();

  return { compacted: true, count: batch.length, memories: saved, summary };
}
