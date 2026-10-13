#!/usr/bin/env node
// ── 核心逻辑冒烟测试（帕尼尼版，不需要浏览器）─────────────────
//
// 覆盖最高风险的部分：
//   · 8 状态任务机与实际时间推导
//   · 真实计时器 + 跨"刷新"持久
//   · 积分账本的诚实性（空账本必须返回"尚未建立"）
//   · 打卡/复盘/规划/SOP 的强制约束
//   · 能力声明不得声称做不到的事
//   · 意图识别与工具下发
//   · 上下文组装把关键信息真的注入了
//   · Markdown 导出自包含

import 'fake-indexeddb/auto';

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();

const dbm = await import('../src/db.js');
const srs = await import('../src/srs.js');
const timer = await import('../src/timer.js');
const ledger = await import('../src/ledger.js');
const records = await import('../src/records.js');
const docs = await import('../src/docs.js');
const persona = await import('../src/persona.js');
const commands = await import('../src/commands.js');
const memory = await import('../src/memory.js');
const tools = await import('../src/tools.js');
const planner = await import('../src/planner.js');
const exportmd = await import('../src/exportmd.js');
const util = await import('../src/util.js');
const pendingMod = await import('../src/pending.js');
const chatApprovals = await import('../src/chat-approvals.js');
const daylog = await import('../src/daylog.js');
const { executeTool, TOOL_DEFS, toolsForTurn } = tools;
const { db } = dbm;

/* ── 迷你断言 ── */
let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const daysFromNow = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`运行日期：${daysFromNow(0)}\n`);

/* ══════════════ 1. Schema ══════════════ */
console.log('[1] 数据库结构');
eq('共 15 张表', dbm.ALL_STORES.length, 15);
check('8 个任务状态', Object.keys(dbm.TASK_STATES).length === 8, Object.keys(dbm.TASK_STATES).join(','));
check('4 个优先级 P0-P3', Object.keys(dbm.PRIORITIES).join(',') === 'P0,P1,P2,P3');
check('状态顺序覆盖全部状态',
  dbm.TASK_STATE_ORDER.length === 8 && dbm.TASK_STATE_ORDER.every(s => dbm.TASK_STATES[s]));

for (const name of dbm.ALL_STORES) {
  const exists = db.tables.some(t => t.name === name);
  if (!exists) check(`表 ${name} 存在`, false);
}
check('全部 15 张表都已建立', dbm.ALL_STORES.every(n => db.tables.some(t => t.name === n)));

/* ══════════════ 2. 任务状态机 ══════════════ */
console.log('\n[2] 任务状态机（§5）');

const t1 = await dbm.upsertTask({
  title: '把 CS229 第 3 章学完',
  goal: '能独立推导 logistic regression 的梯度下降',
  priority: 'P1',
  area: 'study',
  dueAt: daysFromNow(30),
  estimateMin: 120,
});
eq('新任务默认 INBOX', t1.state, 'INBOX');
eq('优先级已设置', t1.priority, 'P1');
eq('新建任务默认归入重要事情', t1.category, 'important');
check('未被直接标成 DONE', t1.state !== 'DONE');

const chore = await dbm.upsertTask({ title: '整理桌面', category: 'chore', priority: 'P3' });
eq('杂事分类可保存', chore.category, 'chore');
eq('未分类旧任务按优先级回填', dbm.normalizeTask({ title: '旧任务', priority: 'P3' }, { id: 'legacy', priority: 'P3' }).category, 'chore');
await dbm.deleteTask(chore.id);
eq('删除任务会留下跨设备删除标记', Boolean((await dbm.getMeta('deletedTasks', {}))[chore.id]), true);

let t = await dbm.setTaskState(t1.id, 'DOING');
check('转 DOING 自动写入 actualStart（不靠模型记）', Boolean(t.actualStart));
check('转 DOING 不会带 actualEnd', !t.actualEnd);

t = await dbm.setTaskState(t1.id, 'BLOCKED', { blocker: '不知道梯度怎么推' });
eq('阻碷已记录', t.blocker, '不知道梯度怎么推');
eq('状态为 BLOCKED', t.state, 'BLOCKED');
check('开始时间保留', Boolean(t.actualStart));

t = await dbm.setTaskState(t1.id, 'DONE');
check('转 DONE 自动写入 actualEnd', Boolean(t.actualEnd));
eq('转 DONE 进度归 100', t.progress, 100);

let threw = false;
try { await dbm.setTaskState(t1.id, 'INVALID_STATE'); } catch { threw = true; }
check('非法状态被拒绝', threw);

const t2 = await dbm.upsertTask({ title: '复习线代特征值', area: 'study', priority: 'P2' });
eq('第二个任务是 INBOX', t2.state, 'INBOX');

const checkboxTask = await dbm.upsertTask({ title: '勾选完成测试', state: 'READY', progress: 30 });
await dbm.setTaskCompletion(checkboxTask.id, true);
let checkedTask = await db.tasks.get(checkboxTask.id);
eq('勾选任务会标记完成', checkedTask.state, 'DONE');
eq('勾选前的状态和进度可恢复', checkedTask.completionState, 'READY');
await dbm.setTaskCompletion(checkboxTask.id, false);
checkedTask = await db.tasks.get(checkboxTask.id);
eq('取消勾选会恢复任务状态', checkedTask.state, 'READY');
eq('取消勾选会恢复原进度', checkedTask.progress, 30);

/* 关键任务 */
await dbm.setKeyTasks([t1.id, t2.id]);
const keys = await dbm.keyTaskRecords();
eq('今日关键任务 2 个', keys.length, 2);
await dbm.setKeyTasks([t1.id, t2.id, 'a', 'b']);
const rec3 = await dbm.getKeyTasks();
check('关键任务被截断到 3 个以内（§5.3，不整池塞进今天）', rec3.ids.length <= 3, `${rec3.ids.length} 个`);

/* ══════════════ 3. 真实计时器（§九）═════════════ */
console.log('\n[3] 计时器（代码独占的能力）');

check('初始没有计时', (await timer.getActiveTimer()) === null);

const timerTask = await dbm.upsertTask({ title: '推导梯度下降', area: 'study' });
const started = await timer.startTimer({ taskId: timerTask.id, plannedMin: 45 });
check('计时已启动', Boolean(started.startedAt));
eq('关联了任务', started.taskId, timerTask.id);
eq('计划时长已记', started.plannedMin, 45);
check('标签取的是任务标题', started.label === '推导梯度下降', started.label);

const afterStart = await db.tasks.get(timerTask.id);
eq('开始计时自动把任务转成 DOING', afterStart.state, 'DOING');
check('并写入 actualStart', Boolean(afterStart.actualStart));

threw = false;
try { await timer.startTimer({ note: '重复启动' }); } catch { threw = true; }
check('重复启动被拒绝（不会静默覆盖）', threw);

/* 关键：模拟"页面刷新" —— 重新从数据库读，计时仍在 */
await sleep(1100);
const reloaded = await timer.getActiveTimer();
check('**刷新页面后计时仍在**（存在 meta 而非内存）', reloaded !== null);
check('已过时间在增长', reloaded.elapsedMs > started.elapsedMs, `${started.elapsedMs} → ${reloaded.elapsedMs}`);
check('elapsedText 可读', /分钟|秒/.test(reloaded.elapsedText), reloaded.elapsedText);
check('未超过计划时长', reloaded.overPlanned === false);

const stopped = await timer.stopTimer({ note: '推了一半', selfReportedMin: 3, outcome: '推到链式法则卡住' });
check('停止后产生时间记录', Boolean(stopped.entry.id));
eq('来源标记为 timer', stopped.entry.source, 'timer');
check('记录了实际耗时', stopped.actualMin >= 0, String(stopped.actualMin));
eq('保留了用户自报值', stopped.selfReportedMin, 3);
check('算出与自报的差额（不抹平）', stopped.driftMin !== null, String(stopped.driftMin));
check('停止后没有活动计时', (await timer.getActiveTimer()) === null);

const taskAfterStop = await db.tasks.get(timerTask.id);
check('实际耗时回填到任务', taskAfterStop.actualMin !== null, String(taskAfterStop.actualMin));

const entries = await timer.listTimeEntries({ taskId: timerTask.id });
eq('时间记录可查', entries.length, 1);

threw = false;
try { await timer.stopTimer({}); } catch { threw = true; }
check('没有计时时停止会报错（不静默成功）', threw);

/* 自报记录 */
await timer.logTimeEntry({ taskId: timerTask.id, minutes: 25, note: '用户自报' });
const manual = await timer.listTimeEntries({ taskId: timerTask.id });
eq('自报记录也存下来（来源可区分）', manual.length, 2);
eq('自报来源标记正确', manual.find(e => e.source === 'reported')?.source, 'reported');

/* 预估偏差 */
await dbm.upsertTask({ id: timerTask.id, title: '推导梯度下降' });
await timer.logTimeEntry({ taskId: timerTask.id, minutes: 60 });
const est = await timer.estimationStats();
check('预估统计可用', est.established === true);
check('给出了可读结论', typeof est.verdict === 'string' && est.verdict.length > 4, est.verdict);

/* ══════════════ 3.5 按天查看与编辑（记录面板的数据层）═════════════ */
console.log('\n[3.5] 按天查看与编辑专注记录');

const todayStr = util.dateStr();

/* 「实际耗时」必须是派生的，不能是累加的 —— 否则一改记录就错 */
const taskActual = async () => (await db.tasks.get(timerTask.id))?.actualMin;
const beforeEdit = await taskActual();
const entriesNow = await timer.listTimeEntries({ taskId: timerTask.id });
const sumNow = entriesNow.reduce((s, e) => s + (e.actualMin || 0), 0);
// 有记录就是合计值（哪怕为 0），完全没记录才是 null
eq('**任务实际耗时 = 它所有记录之和（派生而非累加）**',
  beforeEdit, entriesNow.length ? sumNow : null);

/* 按天聚合 */
let day = await daylog.daySummary(todayStr);
check('当天聚合有记录', day.entries.length >= 2, `${day.entries.length} 条`);
check('聚合带上了任务标题', day.entries.some(e => e.taskTitle === '推导梯度下降'),
  JSON.stringify(day.entries.map(e => e.taskTitle)));
check('专注时长已汇总', day.focusedMinutes > 0, String(day.focusedMinutes));
eq('专注时长 = 各条之和', day.focusedMinutes,
  day.entries.reduce((s, e) => s + (e.actualMin || 0), 0));
check('区分了计时与自报段数', day.timerCount >= 1 && day.manualCount >= 0,
  `计时 ${day.timerCount} / 其他 ${day.manualCount}`);

const emptyDay = await daylog.daySummary('2000-01-01');
eq('没有记录的日期返回空列表', emptyDay.entries.length, 0);
eq('空日期专注时长为 0', emptyDay.focusedMinutes, 0);
check('空日期不报错', emptyDay.logs.length === 0);

/* 编辑一条记录 */
const target = day.entries.find(e => e.source !== 'timer') || day.entries[0];
const edited = await timer.updateTimeEntry(target.id, { actualMin: 42, note: '改过时长' });
eq('时长已改', edited.actualMin, 42);
eq('备注已改', edited.note, '改过时长');
check('**打上了「已修正」标记**（保留人工改过这个事实）', edited.edited === true);
check('清空了自报差额（人工改过之后它没意义了）', edited.driftMin === null);

const afterEditActual = await taskActual();
const entriesAfter = await timer.listTimeEntries({ taskId: timerTask.id });
eq('任务实际耗时跟着重算', afterEditActual,
  entriesAfter.length ? entriesAfter.reduce((s, e) => s + (e.actualMin || 0), 0) : null);
check('任务耗时确实变了', afterEditActual !== beforeEdit, `${beforeEdit} → ${afterEditActual}`);

/* 校验 */
threw = false;
try { await timer.updateTimeEntry(target.id, { actualMin: 99999 }); } catch { threw = true; }
check('超过 24 小时被拒绝', threw);
threw = false;
try { await timer.updateTimeEntry(target.id, { actualMin: -5 }); } catch { threw = true; }
check('负数时长被拒绝', threw);
threw = false;
try { await timer.updateTimeEntry('不存在的id', { actualMin: 10 }); } catch { threw = true; }
check('不存在的记录被拒绝', threw);

/* 只改起止时间 → 自动算时长 */
const resolved = await timer.updateTimeEntry(target.id, {
  startedAt: new Date(`${todayStr}T10:00:00`).toISOString(),
  endedAt: new Date(`${todayStr}T10:30:00`).toISOString(),
});
eq('留空时长时按起止时间算出 30 分钟', resolved.actualMin, 30);

/* 跨天：日期跟着起止时间走 */
const crossDay = await timer.updateTimeEntry(target.id, {
  startedAt: new Date('2026-03-05T09:00:00').toISOString(),
  endedAt: new Date('2026-03-05T09:45:00').toISOString(),
});
eq('起止时间换天后，记录日期跟着变', crossDay.date, '2026-03-05');
const mar5 = await daylog.daySummary('2026-03-05');
check('能在新日期下查到它', mar5.entries.some(e => e.id === target.id));
check('原日期下已经查不到', !(await daylog.daySummary(todayStr)).entries.some(e => e.id === target.id));

/* 手动补记 */
const manualEntry = await timer.createManualEntry({
  taskId: timerTask.id, date: todayStr, actualMin: 25, note: '忘开计时器',
});
eq('补记的时长为 25', manualEntry.actualMin, 25);
eq('来源标为 manual', manualEntry.source, 'manual');
eq('落在指定日期', manualEntry.date, todayStr);
threw = false;
try { await timer.createManualEntry({ date: todayStr }); } catch { threw = true; }
check('既没时长也没开始时间被拒绝', threw);

const withManual = await daylog.daySummary(todayStr);
check('补记出现在当天列表里', withManual.entries.some(e => e.id === manualEntry.id));

/* 删除后重算 */
const beforeDel = await taskActual();
await timer.deleteTimeEntry(manualEntry.id);
const afterDel = await taskActual();
check('删除后任务耗时重算变小', afterDel < beforeDel, `${beforeDel} → ${afterDel}`);
check('删除的记录查不到了', !(await timer.listTimeEntries({ taskId: timerTask.id })).some(e => e.id === manualEntry.id));

/* 学习记录的编辑 —— 先自己造一条，不依赖前面有没有跑过 log_study */
const seedLog = await daylog.createLog({
  date: todayStr, topicName: '待编辑的知识点', minutes: 20, what: '原始内容',
});
check('能补记学习记录', Boolean(seedLog.id));

const upd = await daylog.updateLog(seedLog.id, { minutes: 33, what: '改过的内容' });
eq('学习记录时长已改', upd.minutes, 33);
eq('学习记录内容已改', upd.what, '改过的内容');
check('学习记录也打上已修正', upd.edited === true);

const seedDay = await daylog.daySummary(todayStr);
check('学习记录出现在当天列表里', seedDay.logs.some(l => l.id === seedLog.id));

let threwLog = false;
try { await daylog.updateLog(seedLog.id, { minutes: -1 }); } catch { threwLog = true; }
check('学习记录也会拒绝负数时长', threwLog);

await daylog.deleteLog(seedLog.id);
check('能删除学习记录', !(await db.logs.get(seedLog.id)));
threwLog = false;
try { await daylog.deleteLog(seedLog.id); } catch { threwLog = true; }
check('删除不存在的记录会报错', threwLog);

/* 交叉冒烟：chat 里的 log_study 写下的记录，记录面板要能查到 */
const studyArgs = { topic: '面板可见性测试', minutes: 15, what: '测试' };
const studySession = 'smoke-study-approval';
const studyOut = await executeTool('log_study', JSON.stringify(studyArgs), { sessionId: studySession });
check('log_study 先生成聊天确认草稿', studyOut.chatApproval === true && !studyOut.error);
check('学习记录确认前没有写入', !(await daylog.daySummary(todayStr)).logs.some(l => l.topicName === studyArgs.topic));
eq('确认语句能识别', chatApprovals.parseChatWriteDecision('确认保存'), 'confirm');
eq('取消语句能识别', chatApprovals.parseChatWriteDecision('取消'), 'cancel');
const studyDrafts = await chatApprovals.listChatWrites(studySession);
eq('待确认草稿按会话保存', studyDrafts.length, 1);
const studySaved = await executeTool(studyDrafts[0].tool, studyDrafts[0].args, { confirmed: true, sessionId: studySession });
check('用户确认后学习记录写入成功', !studySaved.error);
await chatApprovals.removeChatWrites(studyDrafts.map(item => item.id));
const afterStudy = await daylog.daySummary(todayStr);
check('**聊天写入的学习记录能在记录面板查到**',
  afterStudy.logs.some(l => l.topicName === '面板可见性测试'),
  afterStudy.logs.map(l => l.topicName).join(','));

/* 有记录的日子 */
const days = await daylog.daysWithRecords();
check('能列出有记录的日子', days.size >= 1, `${days.size} 天`);
const latest = await daylog.latestRecordDate();
check('能取到最近有记录的一天', Boolean(latest), String(latest));

/* ══════════════ 4. 积分账本（§十二）═════════════ */
console.log('\n[4] 积分账本的诚实性');

let led = await ledger.getLedger();
eq('空账本：established = false', led.established, false);
eq('空账本：total 必须是 null 而不是 0', led.total, null);
check('空账本给出明确提示', /尚未建立/.test(led.note), led.note);

const p1 = await ledger.awardPoints({ ruleKey: 'key_task', reason: '完成关键任务', taskId: t1.id });
eq('按规则加分 = +3', p1.delta, 3);
eq('默认未确认（§12 要求记录是否经确认）', p1.confirmed, false);

await ledger.awardPoints({ ruleKey: 'start_on_plan', reason: '按计划开始', confirmed: true });
await ledger.awardPoints({ delta: -2, kind: 'penalty', reason: '纠偏记录' });

led = await ledger.getLedger();
eq('账本已建立', led.established, true);
eq('累计 = 3+1-2 = 2', led.total, 2);
// key_task(+3) 和 penalty(-2) 都默认未确认，start_on_plan 传了 confirmed:true
eq('待确认笔数 = 2', led.unconfirmed.length, 2);
eq('待确认合计 = 3 + (-2) = 1', led.pendingTotal, 1);
eq('已确认合计 = 1', led.confirmedTotal, 1);

threw = false;
try { await ledger.awardPoints({ delta: 0, reason: '无效' }); } catch { threw = true; }
check('0 分被拒绝', threw);
threw = false;
try { await ledger.awardPoints({ delta: 5 }); } catch { threw = true; }
check('没有原因的积分被拒绝', threw);

const confirmed = await ledger.confirmPoints(p1.id);
eq('确认后 confirmed = true', confirmed.confirmed, true);

/* 奖励 */
const rw = await ledger.upsertReward({ name: '看一集剧', cost: 10 });
const rwLedger = await ledger.getLedger();
eq('积分不够时不可兑换（10 > 2）', rwLedger.total < rw.cost, true);
threw = false;
try { await ledger.redeemReward(rw.id); } catch (e) { threw = /积分不够/.test(e.message); }
check('兑换积分不足时被拒绝并给出原因', threw);

await ledger.awardPoints({ delta: 20, reason: '补足测试' });
const redeemed = await ledger.redeemReward(rw.id);
eq('兑换后剩余正确', redeemed.remaining >= 0, true);
check('兑换记了一笔流水', redeemed.entry.kind === 'redeem' && redeemed.entry.delta < 0);
eq('奖励兑换次数 +1', (await db.rewards.get(rw.id)).redeemedCount, 1);

/* ══════════════ 5. 打卡（§十三）═════════════ */
console.log('\n[5] 生活打卡');

check('服药字段默认关闭（§13 只在用户主动要求时记录）', (await records.isMedsEnabled()) === false);

const ck = await records.upsertCheckin({
  sleepHours: 6.5, wakeAt: '08:30', energy: 3, mood: 2, attention: 4,
  water: 2, topTask: '推导梯度下降', blocker: '链式法则不熟', doneToday: '看了视频',
});
eq('打卡日期是今天', ck.date, util.dateStr());
eq('睡眠已记', ck.sleepHours, 6.5);
eq('精力已记', ck.energy, 3);
eq('未填的字段保持 null', ck.exercise, '');

const ck2 = await records.upsertCheckin({ energy: 5, nextAction: '先看链式法则' });
eq('同一天再打卡是更新而不是新增', (await records.listCheckins(10)).length, 1);
eq('原有的睡眠没被覆盖', ck2.sleepHours, 6.5);
eq('新字段已更新', ck2.energy, 5);

const ck3 = await records.upsertCheckin({ energy: 99, mood: -5 });
eq('精力被钳到 5', ck3.energy, 5);
eq('情绪被钳到 1', ck3.mood, 1);

const trend = await records.checkinSummary(14);
check('趋势统计可用', trend.established === true);
eq('样本数 1', trend.samples, 1);

/* ══════════════ 6. 复盘与拖延模式（§十、§十一）═════════════ */
console.log('\n[6] 复盘与拖延模式');

threw = false;
try { await records.saveReview({ kind: 'blackroom', planned: '写论文' }); } catch (e) { threw = /action/.test(e.message); }
check('没有 action 的复盘被拒绝（§11 禁止没有出口的自我批评）', threw);

const rev = await records.saveReview({
  kind: 'blackroom',
  planned: '写完论文引言',
  actual: '刷了两小时手机',
  deviationStart: '打开文档之后',
  whatHappened: '打开文档看到空白页就切去刷手机了',
  triggers: ['怕写得不好', '手机在桌上'],
  thoughts: ['我必须一次写好'],
  reframes: ['可以先写一坨垃圾初稿'],
  action: '现在只写标题和三个小标题，十分钟',
  lesson: '开始前把手机放到另一个房间',
});
check('复盘已保存', Boolean(rev.id));
eq('触发因素记录正确', rev.triggers.length, 2);
check('立即行动必填且已存', rev.action.includes('十分钟'));

const proc = await records.recordProcrastination({
  pattern: 'C', evidence: '怕写得不好所以不动手', intervention: '设置垃圾初稿目标',
});
eq('拖延模式归一化为大写', proc.pattern, 'C');
threw = false;
try { await records.recordProcrastination({ pattern: 'Z' }); } catch { threw = true; }
check('非法模式被拒绝', threw);

await records.recordProcrastination({ pattern: 'C', evidence: 'again' });
await records.recordProcrastination({ pattern: 'E', evidence: '手机' });
const stats = await records.patternStats();
check('模式统计可用', stats.established === true);
eq('共 3 次记录', stats.samples, 3);
eq('最常见是 C（出现 2 次）', stats.top.pattern, 'C');
eq('C 出现了 2 次', stats.top.count, 2);
check('统计附带应对建议', Boolean(stats.top.fix));

const strategies = await records.effectiveStrategies(10);
check('有效策略可提取', strategies.length >= 1 && strategies.some(s => s.action));

/* ══════════════ 7. 规划（§十四）═════════════ */
console.log('\n[7] 规划与可行性检查');

const planA = await docs.savePlan({
  name: '考试复习计划',
  goal: '把第 3 章吃透',
  availableMin: 120,
  items: [
    { text: '看视频', minAction: '打开视频第一集', estMin: 40 },
    { text: '推导公式', minAction: '翻到笔记上次停的地方', estMin: 40 },
    { text: '写代码', minAction: '打开编辑器建个空文件', estMin: 40 },
  ],
});
eq('自动编号 P-001', planA.plan.code, 'P-001');
eq('可行性：120/120 可行', planA.feasibility.feasible, true);
check('可行性给出了结论文本', planA.feasibility.verdict.length > 4);

const overload = await docs.savePlan({
  name: '超载计划',
  availableMin: 60,
  items: [{ text: 'A', estMin: 90 }, { text: 'B', estMin: 60 }],
});
eq('第二个自动编号 P-002', overload.plan.code, 'P-002');
eq('**过载被检出**', overload.feasibility.feasible, false);
eq('算出超出 90 分钟', overload.feasibility.overBy, 90);
check('过载结论明确说"必须缩减范围"', /缩减范围|过载/.test(overload.feasibility.verdict));

const nextA = docs.nextPlanAction(planA.plan);
eq('下一步是第一项', nextA.text, '看视频');
eq('给的启动动作是最小动作', nextA.startWith, '打开视频第一集');

const toggled = await docs.togglePlanItem(planA.plan.id, 0);
eq('勾选后第一项已完成', toggled.items[0].done, true);
eq('下一步推进到第二项', docs.nextPlanAction(toggled).text, '推导公式');

const noEst = await docs.savePlan({ name: '没估时的计划', availableMin: 60, items: ['只写内容'] });
check('没提供估时也能保存', Boolean(noEst.plan.id));
check('并把未估时数量报出来', noEst.feasibility.unestimated === 1, String(noEst.feasibility.unestimated));

/* ══════════════ 8. SOP（§十五）═════════════ */
console.log('\n[8] SOP 结构强制');

threw = false;
try {
  await docs.saveSop({ name: '残缺 SOP', scene: 'x', goal: 'y', steps: ['a'], doneCriteria: 'z' });
} catch (e) { threw = /一分钟/.test(e.message); }
check('缺少「一分钟启动版」被拒绝（§15 强制要求）', threw);

threw = false;
try {
  await docs.saveSop({ name: '缺步骤', scene: 'x', goal: 'y', doneCriteria: 'z', quickStart: 'q' });
} catch (e) { threw = /必填/.test(e.message); }
check('缺少必填项被拒绝', threw);

const sop = await docs.saveSop({
  name: '每天开始学习',
  scene: '晚上坐下但不想动的时候',
  goal: '把自己弄到书桌前',
  materials: ['教材', '笔记本'],
  estimateMin: 10,
  prep: ['手机放到另一个房间'],
  steps: ['把书翻开', '读第一段', '写下三个不懂的地方'],
  blockers: ['想先刷手机'],
  exceptions: '如果实在不行，只做第一步',
  doneCriteria: '书翻开了并且读了一段',
  checklist: ['手机已放远', '书已翻开'],
  review: '连续三天做不到就把第一步再缩小',
  quickStart: '只把书翻开放在桌上，然后回来报告',
});
check('SOP 保存成功', Boolean(sop.id));
eq('步骤数', sop.steps.length, 3);
eq('步骤初始未完成', sop.steps[0].done, false);
check('一分钟启动版已存', sop.quickStart.includes('翻开'));

const stepToggled = await docs.toggleSopStep(sop.id, 'steps', 0);
eq('步骤可勾选', stepToggled.steps[0].done, true);
threw = false;
try { await docs.toggleSopStep(sop.id, 'badField', 0); } catch { threw = true; }
check('非法字段被拒绝', threw);

/* ══════════════ 9. 帕尼尼人设与能力声明 ══════════════ */
console.log('\n[9] 人设、语气、能力声明');

check('学习档案核心项包括学习方式', dbm.REQUIRED_PROFILE_KEYS.includes('learningPreferences'));
check('学习档案不依赖诊断信息', !dbm.REQUIRED_PROFILE_KEYS.includes('adhdStatus'));
check('没有诊断信息也能完成档案核心项', dbm.profileCompletion({
  about: '正在学习前端开发', goals: '完成作品集', focusAreas: '项目练习',
  learningPreferences: '先看例子再动手',
}).canStart);
check('人设不会询问 ADHD 或其他诊断状态', persona.SAFETY_RULES.includes('不询问用户的 ADHD 或其他诊断状态'));

const prof = await dbm.saveProfile({
  userName: '小陈',
  adhdStatus: 'diagnosed',
  topProblems: '晚上起不来、计划太多、论文卡住',
  focusAreas: '每天开始学习、论文推进',
  learningPreferences: '短时专注，边做边学',
  availableTime: '工作日晚上',
  constraints: '暂时只有手机',
  procrastinationPatterns: '一坐下先刷手机',
  taboos: ['不要拿我跟别人比'],
  toneLevel: 5,
  allowProfanity: true,
});

const safeProfileBlock = memory.fmtProfileBlock(prof);
check('旧档案中的 ADHD 字段不会注入模型上下文',
  !safeProfileBlock.includes('ADHD') && !safeProfileBlock.includes('diagnosed'));
const safeProfileRead = await executeTool('get_profile', {});
check('档案读取工具不暴露旧诊断字段',
  !safeProfileRead.content.includes('ADHD') && !safeProfileRead.content.includes('diagnosed'));

const tone5 = persona.toneBlock(prof);
check('强度 5 生效', tone5.includes('完全放开'));
check('粗口授权被写入', tone5.includes('已授权'));
check('**雷区被当作最高优先级注入**', tone5.includes('雷区') && tone5.includes('不要拿我跟别人比'));

const tone1 = persona.toneBlock({ ...prof, toneLevel: 1 });
check('强度 1 会变成温和模式', tone1.includes('温和'));

const toneNP = persona.toneBlock({ ...prof, allowProfanity: false });
check('未授权粗口时明确禁止', toneNP.includes('不要说脏话'));

/* 能力声明 —— 这是"不虚构"的结构性保证 */
const caps = memory.computeCapabilities();
check('时区已获取', typeof caps.timeZone === 'string' && caps.timeZone.length > 0, caps.timeZone);
check('本地时间已生成', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(caps.localTime), caps.localTime);

const capText = persona.capabilityBlock(caps);
check('**明确承认没有时钟**', capText.includes('你没有时钟'));
check('**明确承认无法主动提醒**（通知未实现）', capText.includes('无法主动发消息'));
check('明确承认关掉页面后什么都不做', capText.includes('页面关闭后你什么都不做'));
check('声明了真实计时可用', capText.includes('真实的计时'));
check('说明了时间来自设备本地时钟', capText.includes('本地时钟'));

const capNotif = persona.capabilityBlock({ ...caps, notificationsEnabled: true });
check('通知开启后说法随之改变（能力声明由代码驱动）', !capNotif.includes('无法主动发消息'));

/* 危机暂停 */
check('未暂停时没有暂停段', persona.suspendBlock({ suspendUntil: null }) === '');
const susp = persona.suspendBlock({ suspendUntil: 'indefinite' });
check('暂停时注入强指令', susp.includes('暂停监督') && susp.includes('禁止催促'));
check('暂停覆盖语气强度设定', susp.includes('失效'));
const past = persona.suspendBlock({ suspendUntil: '2020-01-01T00:00:00Z' });
check('过期暂停自动失效', past === '');

/* 安全规则硬约束 */
const sysFull = persona.assembleSystemPrompt({ profile: prof, caps, blocks: {} });
check('包含安全硬约束', sysFull.includes('最高优先级'));
check('禁止攻击人格', sysFull.includes('不攻击用户的基本人格'));
check('禁止用羞辱替代任务管理', sysFull.includes('不用羞辱替代真正的任务管理'));
check('禁止剥夺睡眠饮食', sysFull.includes('剥夺睡眠'));
check('不诊断疾病/不建议药物', sysFull.includes('不诊断疾病'));
check('学习困难不归咎于懒惰', sysFull.includes('不将注意力或执行困难简单归结为懒惰'));
check('未回复不算失败', sysFull.includes('不把用户未回复视为任务失败'));
check('拖延流程不预设用户正在逃避', sysFull.includes('不要预设这是逃避'));
check('当前做不了时先接受并提供灵活选项',
  sysFull.includes('停止催促，询问他想等条件恢复、改期、换成现在能做的其他事'));
check('包含核心信条', sysFull.includes('计划不是成果'));
check('声明了承诺类动作要用户点确认', sysFull.includes('必须用户自己点按钮'));
check('学习档案访谈逐题进行且不询问诊断',
  sysFull.includes('只问一个问题') && sysFull.includes('不询问 ADHD 或其他诊断状态'));
check('访谈回答不会每题自动生成草稿', sysFull.includes('不要每答一题就生成保存草稿'));
check('访谈结束需用户确认后保存', sysFull.includes('只有用户明确确认后才保存'));
check('用户说现在做不了时无需证明且先接受',
  sysFull.includes('这本身就是当前现实限制') && sysFull.includes('不要求他解释、证明')
    && sysFull.includes('先接受并停止催促'));
check('含糊改做杂事时只中性追问，不直接定性逃避',
  sysFull.includes('不要直接断言这是逃避'));
check('工具结果冲突时必须纠正并以结果为准',
  sysFull.includes('工具结果是本轮事实的唯一依据')
    && sysFull.includes('先清楚纠正错误再继续'));
check('不向用户解释工具回执是自己完成的证据',
  sysFull.includes('工具回执只用于核对事实')
    && sysFull.includes('不要向用户强调'));
check('背景资料和目标有明确的档案字段', sysFull.includes('存入 about') && sysFull.includes('存入 goals'));
const profileTool = tools.TOOL_DEFS.find(d => d.function.name === 'update_profile');
check('档案工具 schema 暴露背景和目标字段',
  'about' in profileTool.function.parameters.properties && 'goals' in profileTool.function.parameters.properties
    && 'learningPreferences' in profileTool.function.parameters.properties
    && 'availableTime' in profileTool.function.parameters.properties
    && !('adhdStatus' in profileTool.function.parameters.properties));

/* 段落顺序：稳定 → 半稳定 → 易变。顺序错了会让上下文缓存整段失效。
   注意用带 `# ` 的标题去定位，否则会命中安全规则里对「平台实际能力」的引用。 */
const sysOrdered = persona.assembleSystemPrompt({
  profile: prof, caps, blocks: { profile: '- 称呼：小明' },
});
const iPersona = sysOrdered.indexOf('你是「帕尼尼」');
const iFlows = sysOrdered.indexOf('# 你的标准流程');
const iTone = sysOrdered.indexOf('# 表达强度');
const iCap = sysOrdered.indexOf('# 平台实际能力');
const iProfile = sysOrdered.indexOf('# 用户档案');
const iToday = sysOrdered.indexOf('# 当下的情况');

check('人设在最前面', iPersona >= 0 && iPersona < 60);
check('各段落定位都找到了', [iFlows, iTone, iCap, iProfile].every(i => i > 0),
  `flows=${iFlows} tone=${iTone} cap=${iCap} profile=${iProfile}`);
check('纯静态的流程段落排在语气/能力之前', iFlows < iTone && iFlows < iCap,
  `flows=${iFlows} tone=${iTone} cap=${iCap}`);
check('档案排在设置之后（它比设置变得勤）', iProfile > iTone && iProfile > iCap,
  `profile=${iProfile} tone=${iTone} cap=${iCap}`);

/* 稳定层里绝不能出现会变的东西 —— 尤其是当前时间。
   一旦有，上下文缓存从那一行往后全废。 */
const stablePrefix = sysOrdered.slice(0, iTone);
const timeLike = stablePrefix.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
check('**稳定层里没有任何时间戳（否则上下文缓存全废）**', timeLike === null,
  timeLike ? `发现「${timeLike[0]}」` : '');
const capTextNow = persona.capabilityBlock(memory.computeCapabilities());
check('能力声明里也不再嵌时间', !/\d{2}:\d{2}/.test(capTextNow),
  capTextNow.match(/\d{2}:\d{2}/)?.[0] || '');
check('能力声明里保留时区（静态，无害）',
  capTextNow.includes('时区') || capTextNow.includes('本地时钟'));
if (iToday > 0) {
  check('时间只出现在最后的易变段里', iToday > iTone,
    `today=${iToday} tone=${iTone}`);
}

/* 流程：全量注入，不再按需挑 */
check('**全部流程都注入了（不再按需挑）**',
  ['HOPE 推进流程', '小黑屋：深度复盘', '任务启动流程', 'SOP 制定']
    .every(h => sysFull.includes(h)),
  persona.FLOW_ORDER.join(','));
check('小黑屋强调不是羞辱', sysFull.includes('不是羞辱'));
check('小黑屋有六步', sysFull.includes('第六步'));
check('规划流程限制最多 3 个关键任务', sysFull.includes('最多 3 个'));
check('规划流程要求检查可行性', sysFull.includes('检查可行性'));
check('流程带选择指引', sysFull.includes('一段都没对上'));
check('流程明确「一次只走一段」', sysFull.includes('不要把几段混在一起'));

/* ══════════════ 10. 意图识别与代码快路径 ══════════════ */
console.log('\n[10] 意图识别与代码快路径');

let it = commands.detectIntent('开始计时');
it = commands.detectIntent('当前任务：面试题调研\n现在开始，计时 15 分钟');
check('识别明确的定时启动指令', it.codeAction === 'timer_start', it.codeAction);
it = commands.detectIntent('开始计时');
check('识别出代码动作 timer_start', it.codeAction === 'timer_start', it.codeAction);

it = commands.detectIntent('暂停监督，我现在状态很差');
check('识别出暂停监督', it.codeAction === 'suspend');

it = commands.detectIntent('查看积分');
check('识别出打开积分面板', it.codeAction === 'panel_points');
it = commands.detectIntent('面试资料的任务列表里有几条？');
eq('普通句子提到任务列表不触发面板导航', it.codeAction, null);
it = commands.detectIntent('请打开我的任务列表');
eq('明确的查看任务指令仍走快路径', it.codeAction, 'panel_tasks');

it = commands.detectIntent('你能做什么');
eq('「能做什么」不走代码快路径（交给模型用话讲）', it.codeAction, null);

check('指令表里不存在 panel_commands 这个面板动作',
  !commands.ALL_COMMANDS.some(c => c.codeAction === 'panel_commands'));
check('「能做什么」是模型级而非代码级',
  commands.ALL_COMMANDS.find(c => c.id === 'help')?.handler === 'model');

it = commands.detectIntent('随便聊聊天气');
eq('闲聊不触发任何动作', it.codeAction, null);
check('闲聊的 matched 是空的', it.matched.length === 0);
check('意图识别不再返回 flows 字段（流程正则已删除）',
  commands.detectIntent('小黑屋').flows === undefined);
check('「你都能干啥」不再需要正则命中也能正常处理',
  commands.detectIntent('你都能干啥').codeAction === null);

/* 关键不变量：每条代码动作都必须有工具能替代。
   否则正则一漏，用户就会遇到"说了但没反应"—— 这正是"称呼没更新"的根因。 */
const toolNames = new Set(tools.TOOL_DEFS.map(d => d.function.name));
const fallbacks = Object.entries(commands.ACTION_FALLBACK_TOOL);
check('每条代码动作都登记了兜底工具', fallbacks.length >= 10, `${fallbacks.length} 条`);
check('**所有代码动作都有对应工具兜底（正则漏了也不会丢能力）**',
  fallbacks.every(([, tool]) => toolNames.has(tool)),
  fallbacks.filter(([, t]) => !toolNames.has(t)).map(([a, t]) => `${a}→${t}`).join(','));

check('指令表覆盖 §17 的主要分组', commands.COMMAND_GROUPS.length >= 6);
check('每条指令都有 handler', commands.ALL_COMMANDS.every(c => c.handler === 'code' || c.handler === 'model'));
check('代码级指令都有 codeAction', commands.ALL_COMMANDS.filter(c => c.handler === 'code').every(c => c.codeAction));

/* 工具下发：全量，不做分组 */
check('全部工具已定义', TOOL_DEFS.length >= 35, String(TOOL_DEFS.length));
check('工具名无重复', new Set(TOOL_DEFS.map(d => d.function.name)).size === TOOL_DEFS.length);

const turn = toolsForTurn();
eq('**每轮下发全部工具**', turn.tools.length, TOOL_DEFS.length);
eq('工具名单与定义一致', turn.names.length, TOOL_DEFS.length);

/* 回归：曾经按意图正则分组下发，导致"我叫小明"匹配不到 profile 组，
   update_profile 根本没下发，模型想存也存不了 —— 表现为"说了称呼但没更新"。
   这条断言保证无论用户怎么措辞，档案工具都在。 */
for (const phrase of ['叫我小明', '我叫小明', '你好', '随便聊聊', '今天天气不错', '你能做什么']) {
  const t = toolsForTurn(phrase);
  if (!t.names.includes('update_profile')) {
    check(`措辞「${phrase}」下 update_profile 仍可用`, false, t.names.join(','));
  }
}
check('**无论怎么措辞，档案工具都在（分组下发已移除）**',
  ['update_profile', 'get_profile'].every(n => turn.names.includes(n)));

check('其余易漏的工具也都在',
  ['save_checkin', 'log_study', 'save_review', 'record_procrastination', 'save_plan', 'save_sop']
    .every(n => turn.names.includes(n)),
  turn.names.join(','));

/* ══════════════ 11. 工具执行 ══════════════ */
console.log('\n[11] 工具执行');

let out = await executeTool('list_tasks', '{}');
check('list_tasks 成功', !out.error, out.content?.slice(0, 60));
check('列出了任务', out.content.includes('CS229'));

out = await executeTool('save_task', JSON.stringify({
  title: '写论文引言', priority: 'P0', area: 'work', nextAction: '打开文档写三行',
}));
check('save_task 新建成功', !out.error, out.content?.slice(0, 80));
check('save_task 成功回执包含真实保存对象',
  out.content.includes('写论文引言') && (await dbm.listTasks()).some(t => t.title === '写论文引言'));
out = await executeTool('set_key_tasks', JSON.stringify({ ids: ['写论文引言'] }));
check('关键任务实际挂载前只能显示待确认',
  out.pending === true && out.content.includes('尚未执行') && !(await dbm.getKeyTasks()).length);
out = await executeTool('save_task', JSON.stringify({
  title: '整理桌面杂事', priority: 'P3', category: 'chore', area: 'life',
}));
check('save_task 会保存 AI 指定的杂事分类', !out.error && (await dbm.listTasks()).find(t => t.title === '整理桌面杂事')?.category === 'chore');

out = await executeTool('manage_micro_habit', JSON.stringify({ action: 'add', title: '读书五分钟' }));
check('AI 能新增全局微习惯', !out.error && out.content.includes('读书五分钟'));
out = await executeTool('list_micro_habits', '{}');
check('AI 能读取全局微习惯和状态', !out.error && out.content.includes('读书五分钟'));
out = await executeTool('manage_micro_habit', JSON.stringify({ action: 'complete', title: '读书五分钟' }));
check('AI 能记录微习惯今日完成', !out.error && out.content.includes('标记完成'));
out = await executeTool('manage_micro_habit', JSON.stringify({ action: 'delete', title: '读书五分钟' }));
check('刪除微习惯会等用户确认', out.pending === true && out.content.includes('尚未执行'));

out = await executeTool('manage_life_navigation', JSON.stringify({ action: 'add', kind: 'boredom', text: '出去散步十分钟' }));
check('AI 能新增生活导航全局内容', !out.error && out.content.includes('出去散步十分钟'));
out = await executeTool('manage_life_navigation', JSON.stringify({ action: 'list', kind: 'boredom' }));
check('AI 能查看生活导航内容', !out.error && out.content.includes('出去散步十分钟'));
out = await executeTool('manage_life_navigation', JSON.stringify({ action: 'update', kind: 'boredom', target: '出去散步十分钟', text: '出去散步十五分钟' }));
check('AI 能修改生活导航内容', !out.error && out.content.includes('出去散步十五分钟'));
out = await executeTool('manage_life_navigation', JSON.stringify({ action: 'delete', kind: 'boredom', target: '出去散步十五分钟' }));
check('刪除生活导航内容会等用户确认', out.pending === true && out.content.includes('尚未执行'));
out = await executeTool('open_panel', JSON.stringify({ panel: 'life' }));
check('AI 可以导航到生活导航页面', !out.error && out.openPanel === 'life');
out = await executeTool('open_panel', JSON.stringify({ panel: 'habits' }));
check('AI 可以导航到微习惯页面', !out.error && out.openPanel === 'habits');

out = await executeTool('set_task_state', JSON.stringify({ id: '写论文引言', state: 'BLOCKED' }));
check('set_task_state 可用标题匹配', !out.error);
check('**提示 BLOCKED 缺阻碍**', out.content.includes('阻碍'), out.content.slice(0, 120));

out = await executeTool('set_task_state', JSON.stringify({ id: '写论文引言', state: 'DOING', note: '开始写了' }));
check('转 DOING 成功', !out.error);

out = await executeTool('timer_start', JSON.stringify({ task: '写论文引言', plannedMin: 30 }));
check('**timer_start 默认不再直接执行，而是等用户点确认**', out.pending === true, out.content?.slice(0, 80));
check('被拦截时明确告诉模型「尚未执行」', out.content.includes('尚未执行'));
check('并要求用提议语气，不许说成已完成', out.content.includes('绝对不能'));
check('登记了待确认项', Boolean(out.pendingId));
check('计时确实没有启动', (await timer.getActiveTimer()) === null);

const pendingList = await pendingMod.listPending();
check('待确认项已入库', pendingList.some(p => p.tool === 'timer_start'));
check('待确认项带了可读描述', pendingList[0]?.detail?.includes('写论文引言'), pendingList[0]?.detail);

out = await executeTool('timer_start', JSON.stringify({ task: '写论文引言', plannedMin: 30 }),
  { confirmed: true });
check('用户确认后才真的执行', !out.error, out.content?.slice(0, 60));
check('提醒用户自己设闹钟（因为无法主动提醒）', out.content.includes('闹钟'));
check('计时真的启动了', (await timer.getActiveTimer()) !== null);

out = await executeTool('timer_stop', '{}', { confirmed: true });
check('timer_stop 确认后执行成功', !out.error);
check('给出真实耗时', /\d+ 分钟/.test(out.content));

const autoTimerTask = await dbm.upsertTask({ title: '唯一关键任务计时测试', state: 'READY', category: 'important' });
await dbm.setKeyTasks([autoTimerTask.id]);
out = await executeTool('timer_start', JSON.stringify({ plannedMin: 15 }), { confirmed: true });
check('唯一关键任务下启动的计时自动关联该任务', !out.error && (await timer.getActiveTimer())?.taskId === autoTimerTask.id);
await executeTool('timer_stop', '{}', { confirmed: true });

/* 同一个工具重复请求，不该冒出多个按钮 */
await executeTool('timer_start', JSON.stringify({ note: '重复测试1' }));
await executeTool('timer_start', JSON.stringify({ note: '重复测试2' }));
const dbl = await pendingMod.listPending();
eq('同一工具只保留最新一条待确认', dbl.filter(p => p.tool === 'timer_start').length, 1);
await pendingMod.clearPending();

out = await executeTool('award_points', JSON.stringify({ ruleKey: 'key_task', reason: '完成关键任务' }));
check('正向加分直接执行（记录类）', !out.pending && !out.error);
check('标注了待用户确认（积分确认是另一回事）', out.content.includes('待用户确认'));

out = await executeTool('award_points', JSON.stringify({ delta: -3, reason: '扣分测试' }));
check('**扣分需要用户确认**', out.pending === true, out.content?.slice(0, 60));
await pendingMod.clearPending();

out = await executeTool('delete_task', JSON.stringify({ id: '写论文引言' }));
check('**删除任务需要用户确认**', out.pending === true, out.content?.slice(0, 60));
check('删除确认项标为危险操作', (await pendingMod.listPending())[0]?.danger === true);
await pendingMod.clearPending();
check('确认项能正确清空', (await pendingMod.listPending()).length === 0);

const checkinArgs = { energy: 4, mood: 3, topTask: '聊天确认专用打卡内容' };
out = await executeTool('save_checkin', JSON.stringify(checkinArgs), { sessionId: 'smoke-checkin-approval' });
check('save_checkin 先生成聊天确认草稿', out.chatApproval === true && !out.error);
check('打卡确认前没有写入', (await records.getCheckin(util.dateStr()))?.topTask !== checkinArgs.topTask);
const checkinDrafts = await chatApprovals.listChatWrites('smoke-checkin-approval');
const checkinSaved = await executeTool(checkinDrafts[0].tool, checkinDrafts[0].args, { confirmed: true });
check('确认后打卡写入成功', !checkinSaved.error);
await chatApprovals.removeChatWrites(checkinDrafts.map(item => item.id));

out = await executeTool('save_review', JSON.stringify({ whatHappened: '刷手机', action: '' }));
check('复盘无 action 时工具报错（不静默）', out.error === true, out.content);

out = await executeTool('record_procrastination', JSON.stringify({ pattern: 'e' }));
check('拖延记录先进入聊天确认', out.chatApproval === true && !out.error, out.content);
out = await executeTool('record_procrastination', JSON.stringify({ pattern: 'e' }), { confirmed: true });
check('确认后小写拖延模式也能识别', !out.error, out.content);
check('给出了模式名与应对', out.content.includes('注意力') || out.content.includes('应对'));

out = await executeTool('save_plan', JSON.stringify({
  name: '工具建的规划', availableMin: 30,
  items: [{ text: 'A', estMin: 40 }],
}));
check('save_plan 成功', !out.error);
check('**过载被指出**', out.content.includes('过载') || out.content.includes('超'), out.content.slice(0, 200));

out = await executeTool('save_sop', JSON.stringify({ name: '测试 SOP' }));
check('save_sop 缺字段时报错而非静默', out.error === true);

out = await executeTool('suspend_supervision', '{}');
check('**暂停监督也需要用户确认**（它改变模型自己的行为）', out.pending === true, out.content?.slice(0, 60));
eq('确认前档案未改动', (await dbm.getProfile()).suspendUntil, null);

out = await executeTool('suspend_supervision', '{}', { confirmed: true });
check('确认后暂停成功', !out.error);
check('返回 suspended 标记供 UI 用', out.suspended === true);
eq('档案里暂停已写入', (await dbm.getProfile()).suspendUntil, 'indefinite');

out = await executeTool('resume_supervision', '{}', { confirmed: true });
check('resume_supervision 确认后成功', !out.error);
eq('暂停已解除', (await dbm.getProfile()).suspendUntil, null);
await pendingMod.clearPending();

/* 错误路径 */
out = await executeTool('set_task_state', '{坏 JSON');
check('非法 JSON 被吞成可读错误', out.error === true);
out = await executeTool('set_task_state', JSON.stringify({ id: '不存在的任务', state: 'DOING' }));
check('找不到任务时给出可读错误', out.error === true && out.content.includes('找不到'));
out = await executeTool('不存在的工具', '{}');
check('不存在的工具返回错误', out.error === true);

/* ══════════════ 12. 上下文组装 ══════════════ */
console.log('\n[12] 上下文组装');

const session = await dbm.ensureSession();
await dbm.addMessage({ sessionId: session.id, role: 'user', content: '我该做什么' });

const built = await memory.buildMessages({ sessionId: session.id, userText: '我该做什么？' });
const sys = built.messages[0].content;

eq('第一条是 system', built.messages[0].role, 'system');
check('注入了用户档案', sys.includes('小陈'));
check('注入了雷区', sys.includes('不要拿我跟别人比'));
check('注入了能力声明', sys.includes('平台实际能力'));
check('注入了任务板', sys.includes('CS229'));
check('注入了状态分组', sys.includes('DOING'));
check('注入了积分账本', sys.includes('积分账本'));
check('注入了需要处理的信号', sys.includes('需要处理的信号'));
check('注入了拖延模式', sys.includes('拖延模式'));
check('注入了打卡', sys.includes('打卡'));
check('注入了工作准则', sys.includes('核心工作准则'));
check('带上用户这条输入', built.messages.at(-1).content === '我该做什么？');

/* codeNote 注入 */
const built2 = await memory.buildMessages({
  sessionId: session.id, userText: '结束计时',
  codeNote: '页面侧已执行 timer_stop。真实耗时 **37 分钟**。',
});
check('代码执行结果作为事实注入', built2.messages[0].content.includes('37 分钟'));
check('并明确标注不要自行推算时间', built2.messages[0].content.includes('不要自己推算时间'));

/* 空数据必须诚实 */
await db.memories.clear();
const built3 = await memory.buildMessages({ sessionId: session.id, userText: 'x' });
check('无记忆时说明还没积累', built3.messages[0].content.includes('还没有长期记忆') || built3.messages[0].content.includes('还没有任何长期记忆'));

check('上下文规模合理（< 12000 token）', built.debug.systemTokens < 12000, `${built.debug.systemTokens} tokens`);

/* 检索覆盖新实体 */
const hits = await memory.searchMemory('论文', { limit: 10 });
check('检索能召回任务', hits.some(h => h.type === 'task'), JSON.stringify([...new Set(hits.map(h => h.type))]));
const hits2 = await memory.searchMemory('手机 干扰', { limit: 10 });
check('检索能召回复盘', hits2.some(h => h.type === 'review'));
const hits3 = await memory.searchMemory('梯度下降', { limit: 10 });
check('检索能召回时间记录', hits3.some(h => h.type === 'time') || hits3.some(h => h.type === 'task'));

/* ══════════════ 13. 今日看板 ══════════════ */
console.log('\n[13] 今日看板（零 token）');

const today = await planner.computeToday();
check('统计完成', Boolean(today.today));
check('按状态分组齐全', Object.keys(today.byState).length === 8);
check('检出了进行中任务', today.doing.length >= 1);
check('带上了积分账本', today.ledger.established === true);
check('带上了打卡', Boolean(today.checkin));
check('带上了计时状态字段', 'timer' in today);
check('带上了数据一致性检查', Array.isArray(today.integrity) && today.integrity.length >= 0);

const cards = planner.todayCards(today);
check('生成了卡片', cards.length > 0);
check('卡片都有 level 和 title', cards.every(c => c.level && c.title));
check('**卡片不产生失败判定**', !cards.some(c => /失败|失败了/.test(c.title + c.sub)));

const line = planner.todayLine(today);
check('一行摘要可用', typeof line === 'string' && line.length > 0, line);

/* ══════════════ 14. Markdown 导出（§十九）═════════════ */
console.log('\n[14] Markdown 结构化导出');

const exportSession = await dbm.createSession('导出会话测试');
await dbm.addMessage({ sessionId: exportSession.id, role: 'user', content: '对话导出验证用户消息' });
await dbm.addMessage({ sessionId: exportSession.id, role: 'assistant', content: '对话导出验证助手消息' });

const md = await exportmd.buildMarkdownExport({ includeAll: true });
check('导出非空', md.length > 500);
for (const [label, needle] of [
  ['用户档案', '一、用户档案'],
  ['任务与状态', '二、任务与状态'],
  ['计划与实际时间', '三、计划与实际时间'],
  ['生活打卡', '四、生活打卡'],
  ['积分账本', '五、积分账本'],
  ['规划', '六、规划'],
  ['SOP', '七、SOP'],
  ['复盘与拖延模式', '八、复盘记录与拖延模式'],
  ['知识点', '九、知识点与复习'],
  ['下次继续监督', '十、下次继续监督的事项'],
  ['数据说明', '十一、数据说明'],
  ['对话记录', '十二、对话记录'],
]) check(`包含「${label}」章节`, md.includes(needle), needle);
check('Markdown 导出包含会话消息', md.includes('对话导出验证用户消息') && md.includes('对话导出验证助手消息'));

check('导出记住了用户名', md.includes('小陈'));
check('导出包含任务标题', md.includes('CS229'));
check('导出包含一分钟启动版', md.includes('一分钟启动版'));
check('导出含规划编号', md.includes('P-001'));
check('导出标明数据来源区别', md.includes('自报') && md.includes('计时'));
check('导出区分结构化事实和对话原文', md.includes('助手说法不代表已核实事实'));
const st = exportmd.markdownStats(md);
check('统计可用', st.lines > 30, `${st.lines} 行`);

/* ══════════════ 15. 备份往返 ══════════════ */
console.log('\n[15] 备份往返');

const dump = await dbm.exportAll();
eq('schema 版本 = 2', dump.schema, 2);
eq('导出 15 张表', Object.keys(dump.stores).length, 15);
check('积分被导出', dump.stores.points.length >= 1);
check('时间记录被导出', dump.stores.timeEntries.length >= 1);
check('打卡被导出', dump.stores.checkins.length >= 1);
check('复盘被导出', dump.stores.reviews.length >= 1);
check('规划被导出', dump.stores.plans.length >= 2);
check('SOP 被导出', dump.stores.sops.length >= 1);

const beforeCounts = {
  tasks: (await db.tasks.toArray()).length,
  points: (await db.points.toArray()).length,
  reviews: (await db.reviews.toArray()).length,
};
await db.tasks.clear(); await db.points.clear(); await db.reviews.clear();
await dbm.importAll(dump, { mode: 'merge' });
eq('任务已恢复', (await db.tasks.toArray()).length, beforeCounts.tasks);
eq('积分已恢复', (await db.points.toArray()).length, beforeCounts.points);
eq('复盘已恢复', (await db.reviews.toArray()).length, beforeCounts.reviews);

const pretty = dbm.prettyExport(dump);
check('美化导出是合法 JSON', (() => { try { JSON.parse(pretty); return true; } catch { return false; } })());

console.log('\n[15.5] 60 天历史清理');
const retentionNow = Date.UTC(2026, 0, 1);
await db.tasks.bulkPut([
  { id: 'task_old_done', title: '旧完成任务', state: 'DONE', actualEnd: '2025-10-01T00:00:00.000Z', updatedAt: '2025-10-01T00:00:00.000Z', createdAt: '2025-09-01T00:00:00.000Z' },
  { id: 'task_old_active', title: '长期任务', state: 'DOING', actualEnd: '', updatedAt: '2025-10-01T00:00:00.000Z', createdAt: '2025-09-01T00:00:00.000Z' },
  { id: 'task_recent_done', title: '最近完成任务', state: 'DONE', actualEnd: '2025-12-20T00:00:00.000Z', updatedAt: '2025-12-20T00:00:00.000Z', createdAt: '2025-12-01T00:00:00.000Z' },
]);
eq('只清理 60 天前已完成或取消的任务', await dbm.cleanupOldCompletedTasks({ now: retentionNow }), 1);
check('旧完成任务已清理', !(await db.tasks.get('task_old_done')));
check('未完成任务不会自动删除', Boolean(await db.tasks.get('task_old_active')));
check('60 天内完成的任务会保留', Boolean(await db.tasks.get('task_recent_done')));
const microhabit = await import('../src/microhabit.js');
localStorage.setItem('micro-habit-local-state-v1', JSON.stringify({
  habits: [{ id: 'habit_keep', title: '每天读书', active: true, order: 0 }],
  completions: { '2025-12-31': ['habit_keep'], '2026-01-01': ['habit_keep'], '2026-02-28': ['habit_keep'] },
}));
eq('微习惯只清理 60 天前的完成历史', microhabit.pruneMicroHabitHistory({ now: Date.UTC(2026, 2, 2, 12) }), 1);
check('微习惯定义和近期完成历史保留', microhabit.loadMicroHabitState().habits.length === 1
  && '2026-02-28' in microhabit.loadMicroHabitState().completions);

/* ══════════════ 16. Markdown 安全 ══════════════ */
console.log('\n[16] Markdown 安全（模型输出不能变成可执行 HTML）');

const evil = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
let rendered = util.renderMarkdown(evil);
check('HTML 标签被转义', !rendered.includes('<img') && !rendered.includes('<script'));
check('代码块正常', util.renderMarkdown('```js\nconst a=1;\n```').includes('<pre><code'));
check('行内代码正常', util.renderMarkdown('用 `log_study` 记录').includes('<code>log_study</code>'));
check('粗体正常', util.renderMarkdown('**重点**').includes('<strong>重点</strong>'));
check('列表正常', util.renderMarkdown('- a\n- b').includes('<li>a</li>'));
check('表格正常', util.renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<td>'));

/* ══════════════ 结果 ══════════════ */
console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`❌ ${pass} 项通过，${failures.length} 项失败：\n`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✅ 全部 ${pass} 项断言通过。`);
}
