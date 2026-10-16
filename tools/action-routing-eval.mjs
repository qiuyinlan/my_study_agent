import 'fake-indexeddb/auto';
import {
  createOperationReceipt, findActionByIdempotencyKey, isPotentialWriteRequest,
  shouldPlanGenericWriteActions,
  listActionLedger, listTurnEvents, getActionMetrics, makeIdempotencyKey, parseActionPlan, parseGenericWritePlan, recordAction, recordTurnEvent, shouldPlanActions,
} from '../src/operation-plan.js';
import { executeTool, validateToolArguments, verifyPersistedResult, TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/tools.js';
import { buildActionDiagnosticsExport } from '../src/action-diagnostics.js';
import fixture from './action-routing-cases.json' with { type: 'json' };

const cases = fixture.cases;
if (!Array.isArray(cases) || !cases.length) throw new Error('Routing fixture is empty or invalid');

let failures = 0;
const routingMetrics = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
const categoryCounts = Object.fromEntries(['positive', 'near-negative', 'multiple-intents', 'insufficient-information'].map(k => [k, 0]));
for (const sample of cases) {
  const actual = shouldPlanActions(sample.text);
  const expected = sample.expected.planner;
  categoryCounts[sample.category] = (categoryCounts[sample.category] || 0) + 1;
  if (actual !== expected) failures++;
  if (actual && expected) routingMetrics.truePositive++;
  else if (actual) routingMetrics.falsePositive++;
  else if (expected) routingMetrics.falseNegative++;
  else routingMetrics.trueNegative++;
  console.log(`${actual === expected ? '✓' : '✗'} ${sample.id} [${sample.category}]: expected ${expected}, got ${actual}`);
}
if (Object.values(categoryCounts).some(count => !count)) failures++;

const valid = parseActionPlan(JSON.stringify({
  actions: [
    { kind: 'log_time_entry', minutes: 30, note: '自报耗时' },
    { kind: 'save_task', title: '联系同学拿外网流量', dueAt: '2026-10-14' },
  ],
  questions: [],
}));
if (valid.actions.length !== 2 || valid.actions[0].args.selfReportedMin !== 30) failures++;
console.log(`${valid.actions.length === 2 ? '✓' : '✗'} multi-action plan parses and preserves reported-time source`);
const missingTaskDate = parseActionPlan({
  actions: [{ kind: 'save_task', title: '复习数组算法' }], questions: [],
});
if (missingTaskDate.actions[0].status !== 'needs_info' || !missingTaskDate.actions[0].missingFields.includes('date')) failures++;
console.log(`${missingTaskDate.actions[0].status === 'needs_info' ? '✓' : '✗'} new main tasks require a date before a draft is created`);
const unscheduledChore = parseActionPlan({
  actions: [{ kind: 'save_task', title: '整理桌面', category: 'chore' }], questions: [],
});
if (unscheduledChore.actions[0].status !== 'requested') failures++;
console.log(`${unscheduledChore.actions[0].status === 'requested' ? '✓' : '✗'} chores may be unscheduled`);
const genericMissingDate = parseGenericWritePlan({
  actions: [{ tool: 'save_task', arguments: { title: '准备面试' } }], questions: [],
});
const genericExistingUpdate = parseGenericWritePlan({
  actions: [{ tool: 'save_task', arguments: { title: '已有任务', nextAction: '打开文档' } }], questions: [],
}, { existingTaskTitles: ['已有任务'] });
if (genericMissingDate.actions[0].status !== 'needs_info' || !genericMissingDate.actions[0].missingFields.includes('date')
  || genericExistingUpdate.actions[0].status !== 'requested') failures++;
console.log(`${genericMissingDate.actions[0].status === 'needs_info' && genericExistingUpdate.actions[0].status === 'requested' ? '✓' : '✗'} generic planning requires dates only for new tasks`);
const partial = parseActionPlan({
  actions: [
    { kind: 'log_time_entry', minutes: 12 },
    { kind: 'log_time_entry' },
    { kind: 'save_task' },
  ],
  questions: ['缺少第二笔耗时和待办内容'],
});
const partialOk = partial.actions.map(a => a.status).join(',') === 'requested,needs_info,needs_info'
  && partial.actions[0].args.selfReportedMin === 12
  && partial.actions[1].missingFields.includes('minutes')
  && partial.actions[2].missingFields.includes('title');
if (!partialOk) failures++;
console.log(`${partialOk ? '✓' : '✗'} missing fields stay on their own operations without discarding valid actions`);
const routePrecision = routingMetrics.truePositive / Math.max(1, routingMetrics.truePositive + routingMetrics.falsePositive);
const routeRecall = routingMetrics.truePositive / Math.max(1, routingMetrics.truePositive + routingMetrics.falseNegative);
console.log(`Deterministic route baseline (n=${cases.length}; synthetic + one anonymized incident): precision=${routePrecision.toFixed(2)}, recall=${routeRecall.toFixed(2)}, FP=${routingMetrics.falsePositive}, FN=${routingMetrics.falseNegative}`);
console.log(`Sample classes: ${Object.entries(categoryCounts).map(([name, count]) => `${name}=${count}`).join(', ')}`);

for (const [label, text, expected] of [
  ['explicitly save a review', '帮我保存这次复盘', true],
  ['explicitly stop timer', '请结束当前计时', true],
  ['ask how to record time', '怎么记录专注时间？', false],
  ['discuss record keeping', '我们讨论一下如何保存复盘', false],
]) {
  const actual = isPotentialWriteRequest(text);
  if (actual !== expected) failures++;
  console.log(`${actual === expected ? '✓' : '✗'} write-reply gate ${label}: expected ${expected}, got ${actual}`);
}

for (const [label, text, expected] of [
  ['explicitly create a task', '帮我加个任务：原地更新测试任务', true],
  ['set today key tasks', '把刚那个设成今天的关键任务', true],
  ['export records stays on normal tool route', '帮我把记录导出来', false],
  ['diagnostics export stays on normal tool route', '导出工具调用诊断数据', false],
  ['explicit timer start stays on timer route', '帮我把计时开起来', false],
  ['timer stop stays on timer route', '结束当前计时', false],
  ['question about writing is not a write request', '要不要把这件事加到待办？', false],
  ['career preparation discussion is not a write request', '我打算11月前找到实习，先把项目学熟、准备八股和基础算法，下周约模拟面试，之后开始投递。最怕算法，但项目更重要。', false],
]) {
  const actual = shouldPlanGenericWriteActions(text);
  if (actual !== expected) failures++;
  console.log(`${actual === expected ? '✓' : '✗'} generic write planner ${label}: expected ${expected}, got ${actual}`);
}

for (const invalid of [
  { actions: [{ kind: 'delete_task', id: 'x' }], questions: [] },
  { actions: [{ kind: 'log_time_entry', minutes: 0 }], questions: [] },
]) {
  let rejected = false;
  try { parseActionPlan(invalid); } catch { rejected = true; }
  if (!rejected) failures++;
  console.log(`${rejected ? '✓' : '✗'} invalid or unsupported action is rejected`);
}

const operationId = 'fixture-turn:0';
const idempotencyKey = makeIdempotencyKey({ turnId: 'fixture-turn', kind: 'save_task', args: { title: '样例待办', priority: 'P1' } });
await recordAction({
  sessionId: 'fixture-session', turnId: 'fixture-turn', operationId, kind: 'save_task',
  args: { title: '样例待办' }, userText: '把样例待办加入任务', status: 'requested',
  parameterSources: { title: 'model_from_current_turn' }, idempotencyKey,
});
await recordAction({
  sessionId: 'fixture-session', turnId: 'fixture-turn', operationId, kind: 'save_task',
  args: { title: '样例待办' }, status: 'awaiting_confirmation', requiresConfirmation: true,
});
const ledgerEntry = (await listActionLedger({ sessionId: 'fixture-session' }))[0];
const ledgerOk = ledgerEntry?.originalRequest === '把样例待办加入任务'
  && ledgerEntry.target === '样例待办'
  && ledgerEntry.parameterSources.title === 'model_from_current_turn'
  && ledgerEntry.requiresConfirmation === true
  && ledgerEntry.status === 'awaiting_confirmation'
  && (await findActionByIdempotencyKey(idempotencyKey))?.operationId === operationId
  && idempotencyKey === makeIdempotencyKey({ turnId: 'fixture-turn', kind: 'save_task', args: { priority: 'P1', title: '样例待办' } });
if (!ledgerOk) failures++;
console.log(`${ledgerOk ? '✓' : '✗'} ledger keeps request, normalized target, parameter source and confirmation state across updates`);

const metrics = await getActionMetrics({ sessionId: 'fixture-session' });
const metricsOk = metrics.sampleSize === 1
  && metrics.awaitingConfirmation === 1
  && metrics.verifiedRate === 0
  && metrics.note.includes('漏调率');
if (!metricsOk) failures++;
console.log(`${metricsOk ? '✓' : '✗'} action ledger exposes honest execution metrics and labels unobservable routing metrics`);

await recordTurnEvent({
  sessionId: 'fixture-session', turnId: 'fixture-turn', userText: '把样例待办加入任务',
  finalContent: '本轮写入操作状态：等待确认', toolCallCount: 1, holdWriteReply: true,
});
const turnEvents = await listTurnEvents({ sessionId: 'fixture-session' });
const eventOk = turnEvents.length === 1
  && turnEvents[0].turnId === 'fixture-turn'
  && turnEvents[0].actionStatuses[0]?.status === 'awaiting_confirmation'
  && turnEvents[0].finalContent.includes('等待确认');
if (!eventOk) failures++;
console.log(`${eventOk ? '✓' : '✗'} turn event stores final feedback alongside tool outcomes for later review`);

const diagnostics = await buildActionDiagnosticsExport();
const diagnosticsJson = JSON.stringify(diagnostics);
const diagnosticsOk = diagnostics.actions.length === 1
  && diagnostics.turns.length === 1
  && !diagnosticsJson.includes('把样例待办加入任务')
  && !diagnosticsJson.includes('等待确认')
  && !diagnosticsJson.includes('fixture-session')
  && diagnostics.actions[0].parameterNames.includes('title');
if (!diagnosticsOk) failures++;
console.log(`${diagnosticsOk ? '✓' : '✗'} diagnostics export keeps structural evaluation fields and strips user content and identifiers`);
const diagnosticsTool = await executeTool('export_action_diagnostics', { limit: 10 });
const diagnosticsToolOk = !diagnosticsTool.error
  && diagnosticsTool.status === 'succeeded'
  && diagnosticsTool.content.includes('不包含原话');
if (!diagnosticsToolOk) failures++;
console.log(`${diagnosticsToolOk ? '✓' : '✗'} explicit diagnostics export tool returns a truthful generated-file receipt`);

const writeToolContractOk = [...WRITE_TOOL_NAMES].every(name => TOOL_NAMES.includes(name));
if (!writeToolContractOk) failures++;
console.log(`${writeToolContractOk ? '✓' : '✗'} generic write planner only exposes implemented write tools`);

const schemaChecks = [
  validateToolArguments('save_review', { kind: 'daily' }).includes('action 为必填项'),
  validateToolArguments('open_panel', { panel: 'not-a-panel' }).includes('必须是以下值之一'),
  validateToolArguments('list_tasks', { unexpected: true }).includes('未定义字段'),
  validateToolArguments('list_tasks', { limit: 'ten' }).includes('必须是整数'),
  validateToolArguments('list_tasks', { limit: 100000 }).includes('不能大于'),
].every(Boolean);
if (!schemaChecks) failures++;
console.log(`${schemaChecks ? '✓' : '✗'} tool execution schema rejects missing, invalid, unexpected and out-of-range arguments`);

const verifiedTime = await verifyPersistedResult('timeEntries', {
  id: 'time_fixture', taskId: '', actualMin: 30, selfReportedMin: 30,
  note: '资料整理', outcome: '', startedAt: '', endedAt: '2026-10-13T01:00:00.000Z',
}, { minutes: 30, selfReportedMin: 30, note: '资料整理' });
const mismatchedTime = await verifyPersistedResult('timeEntries', {
  id: 'time_fixture', taskId: '', actualMin: 25, selfReportedMin: 25,
  note: '错误内容', outcome: '', startedAt: '', endedAt: '',
}, { minutes: 30, selfReportedMin: 30, note: '资料整理' });
const readbackChecks = verifiedTime.ok && !mismatchedTime.ok
  && mismatchedTime.mismatches.includes('minutes') && mismatchedTime.mismatches.includes('note');
if (!readbackChecks) failures++;
console.log(`${readbackChecks ? '✓' : '✗'} readback verification compares persisted values, not only record existence`);
const receipt = createOperationReceipt({ operationId: 'receipt-op' }, {
  status: 'awaiting_confirmation', pending: true, pendingId: 'pending-1', content: '等待确认',
});
const receiptOk = receipt.operationId === 'receipt-op' && receipt.status === 'awaiting_confirmation'
  && receipt.requiresConfirmation && receipt.pendingId === 'pending-1' && receipt.retryable === false;
if (!receiptOk) failures++;
console.log(`${receiptOk ? '✓' : '✗'} structured operation receipt contains stable status, id, confirmation and retry fields`);

if (failures) {
  console.error(`Action routing evaluation failed: ${failures} issue(s)`);
  process.exitCode = 1;
} else {
  console.log(`Action routing evaluation passed (${cases.length + 11} checks)`);
}
