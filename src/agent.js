// ── Agent 循环 ───────────────────────────────────────────────
//
// 一次用户发言的完整路径：
//
//   1. 页面侧先跑「代码动作」（计时/暂停/打开面板）—— 确定性操作不交给模型
//   2. 把代码执行结果作为**事实**注入上下文
//   3. 模型带工具开始循环：调工具 → 执行 → 结果回灌 → 直到给出文本答复
//   4. 回合结束后按需压缩历史、沉淀长期记忆
//
// 工具在一次回合内用局部 working 数组串起来（保证 tool 消息和它对
// 应的 assistant.tool_calls 严格配对），只有最终文本才落库。

import {
  addMessage, ensureSession, db, renameSession, addUsage,
} from './db.js';
import { buildMessages, compactSession } from './memory.js';
import { streamChat, ApiError } from './deepseek.js';
import { toolsForTurn, executeTool, WRITE_TOOL_NAMES } from './tools.js';
import { listChatWrites, parseChatWriteDecision, removeChatWrites } from './chat-approvals.js';
import { isExplicitTimerStartRequest } from './commands.js';
import {
  ACTION_PLAN_TOOL, GENERIC_WRITE_PLAN_TOOL, isPotentialWriteRequest, listActionLedger,
  parseActionPlan, parseGenericWritePlan, shouldPlanGenericWriteActions, WRITE_TOOL_CATALOG,
  createOperationReceipt, findActionByIdempotencyKey, makeIdempotencyKey,
  recordAction, recordTurnEvent, shouldPlanActions,
} from './operation-plan.js';

const MAX_ITERATIONS = 8;

const PROFILE_INTRO_RE = /(?:我叫|我的名字(?:是|叫)|称呼我(?:为|叫)?|你可以叫我|以后叫我)\s*[\p{L}\p{N}_-]{1,20}|(?:我的(?:情况|背景|目标|经历|困扰)(?:是|：|:)|我(?:目前|最近|一直|平时|长期以来)(?:在|有|都|总是|容易|经常|会|是)|我不喜欢.{0,30}(?:说法|提醒|称呼|表达|语气)|我希望你.{0,20}(?:提醒|监督|称呼|说话|对我))/iu;
const PROFILE_QUESTION_RE = /(?:怎么称呼你|你叫什么|你的名字|希望我(?:怎么|如何)称呼你|你(?:目前|现在|最近)的?(?:情况|背景|目标|困扰|工作|学习)|你(?:目前|现在)(?:在做什么|是什么情况|最困扰什么)|说说你的(?:情况|背景|目标|经历|困扰)|介绍一下你自己|你希望我(?:怎么|如何)(?:提醒|监督|称呼))/iu;
const PROFILE_DONT_SAVE_RE = /不要.{0,18}(?:记|保存|存).{0,18}(?:档案|名字|个人信息|背景|情况)/u;
const PROFILE_SKIP_RE = /不想(?:说|回答|告诉)|不方便说|暂时不想|先跳过|跳过这个问题/u;

function shouldForceProfileUpdate(text, messages) {
  const value = String(text || '');
  if (PROFILE_DONT_SAVE_RE.test(value) || PROFILE_SKIP_RE.test(value)) return false;
  if (PROFILE_INTRO_RE.test(value)) return true;

  const lastUserIndex = messages.findLastIndex(m => m.role === 'user');
  const previousAssistant = messages
    .slice(0, lastUserIndex < 0 ? messages.length : lastUserIndex)
    .findLast(m => m.role === 'assistant');
  const previousText = String(previousAssistant?.content || '');
  return /[？?]/.test(previousText) && PROFILE_QUESTION_RE.test(previousText);
}

async function autoTitle(session, firstUserText) {
  if (session.title) return;
  const title = String(firstUserText).replace(/\s+/g, ' ').trim().slice(0, 24);
  if (title) {
    await renameSession(session.id, title);
    session.title = title;
  }
}

async function finishPlannedTurn({ sessionId, turnId = '', userText = '', response, emit, toolCallCount, aborted = false }) {
  if (response.trim()) {
    await addMessage({ sessionId, role: 'assistant', content: response });
    emit({ type: 'delta', text: response });
  }
  if (turnId) await recordTurnEvent({ sessionId, turnId, userText, finalContent: response, toolCallCount, holdWriteReply: true });
  let compacted = null;
  if (!aborted) {
    try {
      compacted = await compactSession(sessionId);
      if (compacted?.memories?.length) emit({ type: 'memories_saved', memories: compacted.memories });
      if (compacted?.compacted) emit({ type: 'compacted', count: compacted.count });
    } catch (e) {
      console.warn('[compact] 跳过压缩:', e?.message);
    }
  }
  emit({ type: 'done', content: response, toolCallCount, hitLimit: false, aborted, compacted });
  return { sessionId, content: response, toolCallCount, aborted };
}

async function executeGenericWritePlan({ plan, session, userMessage, userText, emit }) {
  emit({ type: 'operation_plan', actions: plan.actions.map(a => ({ kind: a.kind, args: a.args, status: a.status })), questions: plan.questions });
  if (!plan.actions.length && !plan.questions.length) {
    await recordAction({
      sessionId: session.id, turnId: userMessage.id, operationId: `${userMessage.id}:write-plan`,
      kind: 'plan_requested_write_actions', args: { userText }, userText, status: 'failed', detail: '空操作清单',
    });
    return finishPlannedTurn({
      sessionId: session.id, turnId: userMessage.id, userText, response: '操作清单为空，没有执行任何写入。请说明具体要做的操作。',
      emit, toolCallCount: 0,
    });
  }
  if (!plan.actions.length) {
    await recordAction({
      sessionId: session.id, turnId: userMessage.id, operationId: `${userMessage.id}:write-needs-info`,
      kind: 'unresolved_actions', args: {}, userText, status: 'needs_info',
      missingFields: ['action_details'], detail: plan.questions.join('；'),
    });
  }

  const labels = {
    save_task: '任务', set_task_state: '任务状态', delete_task: '删除任务', set_key_tasks: '今日重点',
    timer_start: '开始计时', timer_stop: '结束计时', timer_cancel: '取消计时',
    update_time_entry: '修正耗时', save_checkin: '生活打卡', save_review: '复盘',
    record_procrastination: '拖延记录', save_plan: '计划', delete_plan: '删除计划',
    toggle_plan_item: '计划步骤', save_sop: 'SOP', delete_sop: '删除 SOP',
    toggle_sop_step: 'SOP 步骤', save_memory: '长期记忆', forget_memory: '删除记忆',
    update_profile: '档案', add_topic: '知识点', grade_review: '复习评价',
    award_points: '积分', confirm_points: '积分确认', confirm_all_points: '积分确认',
    upsert_reward: '奖励设置', redeem_reward: '兑换奖励', manage_micro_habit: '微习惯',
    manage_life_navigation: '生活导航',
  };
  const statusLabels = {
    verified: '已写入并核验', succeeded: '已执行但未完成持久化核验',
    awaiting_confirmation: '尚未写入，等待你确认', needs_info: '缺少必要信息，尚未执行',
    failed: '执行失败，未报告完成', deduplicated: '已合并重复操作，未重复写入',
  };
  const outcomes = [];
  let executedCount = 0;
  for (const [index, action] of plan.actions.entries()) {
    const operationId = `${userMessage.id}:write:${index}`;
    const idempotencyKey = makeIdempotencyKey({
      turnId: userMessage.id, kind: action.kind, args: action.args,
    });
    const target = action.args.title || action.args.task || action.args.id || action.args.name || action.args.topic || null;
    const parameterSources = Object.fromEntries(Object.keys(action.args).map(key => [key, 'model_from_current_turn']));
    const entry = {
      sessionId: session.id, turnId: userMessage.id, operationId, kind: action.kind,
      args: action.args, userText, target, parameterSources,
      missingFields: action.missingFields, idempotencyKey,
    };
    const previousWrite = await findActionByIdempotencyKey(idempotencyKey);
    if (previousWrite && previousWrite.operationId !== operationId
      && ['requested', 'executing', 'awaiting_confirmation', 'succeeded', 'verified', 'deduplicated'].includes(previousWrite.status)) {
      const detail = `与操作 ${previousWrite.operationId} 相同，本轮没有重复执行。`;
      await recordAction({
        ...entry, status: 'deduplicated', detail,
        result: { status: 'deduplicated', content: detail, retryable: false },
      });
      outcomes.push({ action, status: 'deduplicated', detail });
      continue;
    }
    await recordAction({ ...entry, status: action.status });

    if (action.status === 'needs_info' || action.status === 'failed') {
      const detail = action.status === 'needs_info'
        ? `缺少必填信息：${action.missingFields.map(field => ({ date: '日期/可执行时间' }[field] || field)).join('、')}`
        : action.validationError;
      await recordAction({
        ...entry, status: action.status, detail,
        result: { status: action.status, errorCode: action.status === 'failed' ? 'invalid_arguments' : '', retryable: false, content: detail },
      });
      outcomes.push({ action, status: action.status, detail });
      continue;
    }

    await recordAction({ ...entry, status: 'executing' });
    emit({ type: 'tool_start', name: action.kind, args: JSON.stringify(action.args), operationId });
    const out = await executeTool(action.kind, action.args, { sessionId: session.id, operationId, userText });
    executedCount++;
    const status = out.status || (out.error ? 'failed' : out.pending || out.chatApproval ? 'awaiting_confirmation' : 'succeeded');
    await recordAction({
      ...entry, status, detail: out.content || '', entity: out.entity || null,
      requiresConfirmation: Boolean(out.requiresConfirmation || out.pending || out.chatApproval),
      result: createOperationReceipt({ operationId }, out),
    });
    emit({
      type: 'tool_result', name: action.kind, ok: !out.error, status, operationId,
      summary: out.error ? (out.content || out.summary || action.kind) : (out.summary || action.kind),
      pending: Boolean(out.pending || out.chatApproval), toast: out.toast || '',
    });
    if (out.pending) emit({ type: 'pending', pendingId: out.pendingId, name: action.kind, summary: out.summary });
    if (out.chatApproval) emit({ type: 'pending', name: action.kind, summary: out.summary });
    if (out.refresh) emit({ type: 'refresh' });
    if (out.openPanel) emit({ type: 'open_panel', panel: out.openPanel });
    outcomes.push({ action, status, detail: out.content || '' });
  }

  const lines = ['已逐项处理本轮写操作：'];
  for (const { action, status, detail } of outcomes) {
    const target = action.args.title || action.args.name || action.args.topic || action.args.task || '';
    const missing = action.missingFields.map(field => ({ minutes: '时长', title: '待办内容', date: '日期/可执行时间' }[field] || field)).join('、');
    lines.push(`- ${labels[action.kind] || '写入操作'}${target ? `「${target}」` : ''}：${statusLabels[status] || '状态未知'}${status === 'needs_info' && missing ? `（缺少：${missing}）` : ''}${status === 'failed' && detail ? `（${detail}）` : ''}`);
    if (status === 'needs_info' && action.missingFields.includes('date')) lines.push('  请问这项任务哪天、什么时间方便安排？');
  }
  for (const question of plan.questions) lines.push(`- 还需补充：${question}`);
  if (executedCount) emit({ type: 'tools_used', names: outcomes.filter(item => !['needs_info', 'failed'].includes(item.status)).map(item => item.action.kind) });
  return finishPlannedTurn({ sessionId: session.id, turnId: userMessage.id, userText, response: lines.join('\n'), emit, toolCallCount: executedCount });
}

/**
 * 跑一个完整回合。
 * @param {object} o
 * @param {string} o.userText
 * @param {string} [o.codeNote]  页面侧已执行的代码动作的结果（作为事实注入）
 * @param {string} [o.model]     指定模型（"深度"模式用 reasoner）
 * @param {AbortSignal} [o.signal]
 * @param {(e:object)=>void} [o.onEvent]
 */
export async function runTurn({ userText, codeNote = '', model = null, signal, onEvent, profileInterview = false }) {
  const emit = e => { try { return onEvent?.(e); } catch (err) { console.error('[onEvent]', err); } };

  const session = await ensureSession();
  const userMessage = await addMessage({ sessionId: session.id, role: 'user', content: userText });
  await autoTitle(session, userText);

  emit({ type: 'start', sessionId: session.id });

  const stagedWrites = await listChatWrites(session.id);
  const decision = parseChatWriteDecision(userText);
  let actionNote = '';
  if (stagedWrites.length && decision === 'confirm') {
    const completedIds = [];
    const results = [];
    for (const item of stagedWrites) {
      const out = await executeTool(item.tool, item.args, {
        confirmed: true, sessionId: session.id, operationId: item.operationId || '',
      });
      if (out.error) {
        results.push(`保存 ${item.tool} 失败：${out.content}`);
      } else {
        completedIds.push(item.id);
        if (item.operationId) {
          await recordAction({
            sessionId: session.id, turnId: item.operationId.split(':')[0], operationId: item.operationId,
            kind: item.tool, args: item.args, status: out.status || 'succeeded',
            detail: out.content || '', entity: out.entity || null,
          });
        }
        results.push('用户已确认。');
        emit({ type: 'tool_start', name: item.tool, args: JSON.stringify(item.args) });
        emit({ type: 'tool_result', name: item.tool, ok: true, summary: out.summary || item.tool, toast: out.toast || '', confirmed: true });
        if (out.refresh) emit({ type: 'refresh' });
      }
    }
    await removeChatWrites(completedIds);
    actionNote = `用户已在聊天中确认保存。页面侧执行结果：\n${results.join('\n')}`;
  } else if (stagedWrites.length && decision === 'cancel') {
    await removeChatWrites(stagedWrites.map(item => item.id));
    actionNote = '用户已在聊天中取消待保存草稿。没有写入任何数据。';
  } else if (stagedWrites.length) {
    actionNote = `当前有 ${stagedWrites.length} 条记录草稿等待用户确认。用户本轮没有明确确认或取消，禁止执行这些草稿。`;
  }

  // 注意是 session.id，不是 sessionId —— 这个笔误曾让整条发送链路直接抛错，
  // 而当时的测试全都绕过了 runTurn，所以没人发现。
  const turnCodeNote = [codeNote, actionNote].filter(Boolean).join('\n\n');
  const { messages, debug, intent } = await buildMessages({ sessionId: session.id, userText, codeNote: turnCodeNote });
  emit({ type: 'context', debug, intent });
  let plannerConfirmedNoWrite = false;

  if (shouldPlanActions(userText)) {
    emit({ type: 'operation_plan_start' });
    let plan;
    try {
      const planned = await streamChat({
        messages: [
          ...messages,
          {
            role: 'system',
            content: '你是操作规划器，不负责回复用户。完整阅读本轮用户请求和上下文，只把明确要求的自报耗时登记与新建待办列入 actions，逐项列出，不得遗漏或合并。只能使用提供的操作类型。不得编造时长、日期、任务标题或数据来源；上下文没有明确依据时写入 questions。用户纠正之前漏记并要求补记，也属于明确操作。用户只讨论方法、询问如何操作或明确拒绝时，不创建操作。',
          },
        ],
        tools: [ACTION_PLAN_TOOL],
        toolChoice: { type: 'function', function: { name: ACTION_PLAN_TOOL.function.name } },
        model,
        signal,
      });
      if (planned.usage) await addUsage(planned.usage);
      const call = planned.toolCalls.find(tc => tc.function?.name === ACTION_PLAN_TOOL.function.name);
      if (!call) throw new Error('模型没有返回强制要求的操作清单');
      plan = parseActionPlan(call.function.arguments, { userText });
    } catch (error) {
      const operationId = `${userMessage.id}:plan`;
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId,
        kind: 'plan_requested_actions', args: { userText }, userText, status: 'failed', detail: error.message,
      });
      const response = `我没有拿到可验证的操作清单，因此没有执行任何写入。${error.message} 请把需要登记的每一项和时长/内容再发我一次。`;
      return finishPlannedTurn({ sessionId: session.id, turnId: userMessage.id, userText, response, emit, toolCallCount: 0 });
    }

    emit({ type: 'operation_plan', actions: plan.actions.map(a => ({ kind: a.kind, args: a.args })), questions: plan.questions });
    if (!plan.actions.length && !plan.questions.length) {
      const operationId = `${userMessage.id}:plan`;
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId,
        kind: 'plan_requested_actions', args: { userText }, userText, status: 'failed', detail: '空操作清单',
      });
      const response = '我识别到你提出了记录或待办操作，但操作清单为空，所以没有执行写入。请说明具体要登记的内容。';
      return finishPlannedTurn({ sessionId: session.id, turnId: userMessage.id, userText, response, emit, toolCallCount: 0 });
    }

    if (!plan.actions.length && plan.questions.length) {
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId: `${userMessage.id}:needs-info`,
        kind: 'unresolved_actions', args: {}, userText, status: 'needs_info',
        missingFields: ['action_details'], detail: plan.questions.join('；'),
      });
    }

    const outcomes = [];
    for (const [index, action] of plan.actions.entries()) {
      const operationId = `${userMessage.id}:${index}`;
      const idempotencyKey = makeIdempotencyKey({
        turnId: userMessage.id, kind: action.kind, args: action.args,
      });
      const previousWrite = action.status === 'needs_info' ? null : await findActionByIdempotencyKey(idempotencyKey);
      if (previousWrite && previousWrite.operationId !== operationId
        && ['requested', 'executing', 'awaiting_confirmation', 'succeeded', 'verified', 'deduplicated'].includes(previousWrite.status)) {
        const detail = `与操作 ${previousWrite.operationId} 相同，本轮没有重复执行。`;
        await recordAction({
          sessionId: session.id, turnId: userMessage.id, operationId, kind: action.kind,
          args: action.args, userText, target: action.args.title || action.args.task || null,
          parameterSources: Object.fromEntries(Object.keys(action.args).map(key => [key, 'model_from_current_turn'])),
          idempotencyKey, status: 'deduplicated', detail,
          result: { status: 'deduplicated', content: detail, retryable: false },
        });
        outcomes.push({ action, out: { content: detail }, status: 'deduplicated' });
        continue;
      }
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId,
        kind: action.kind, args: action.args, userText, status: action.status, idempotencyKey,
        target: action.args.title || action.args.task || null,
        parameterSources: Object.fromEntries(Object.keys(action.args).map(key => [key, 'model_from_current_turn'])),
        missingFields: action.missingFields,
        requiresConfirmation: action.kind === 'log_time_entry',
      });
      if (action.status === 'needs_info') {
        const fieldNames = action.missingFields.map(field => ({ minutes: '时长', title: '待办内容', date: '日期/可执行时间' }[field] || field));
        const out = { content: `缺少${fieldNames.join('、')}`, status: 'needs_info' };
        outcomes.push({ action, out, status: 'needs_info' });
        continue;
      }
      emit({ type: 'tool_start', name: action.kind, args: JSON.stringify(action.args), operationId });
      const out = await executeTool(action.kind, action.args, { sessionId: session.id, operationId, userText });
      const status = out.status || (out.error ? 'failed' : out.pending || out.chatApproval ? 'awaiting_confirmation' : 'succeeded');
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId,
        kind: action.kind, args: action.args, userText, status, detail: out.content || '', entity: out.entity || null,
        idempotencyKey,
        target: action.args.title || action.args.task || action.args.id || null,
        parameterSources: Object.fromEntries(Object.keys(action.args).map(key => [key, 'model_from_current_turn'])),
        requiresConfirmation: Boolean(out.pending || out.chatApproval),
        result: createOperationReceipt({ operationId }, out),
      });
      emit({
        type: 'tool_result', name: action.kind, ok: !out.error, status, operationId,
        summary: out.summary || action.kind, pending: Boolean(out.pending || out.chatApproval),
        toast: out.toast || '',
      });
      if (out.pending) emit({ type: 'pending', pendingId: out.pendingId, name: action.kind, summary: out.summary });
      if (out.chatApproval) emit({ type: 'pending', name: action.kind, summary: out.summary });
      if (out.refresh) emit({ type: 'refresh' });
      outcomes.push({ action, out, status });
    }

    const lines = ['已逐项处理这份操作清单：'];
    for (const { action, out, status } of outcomes) {
      const label = action.kind === 'log_time_entry'
        ? (action.args.minutes ? `自报耗时 ${action.args.minutes} 分钟` : '自报耗时记录')
        : (action.args.title ? `待办「${action.args.title}」` : '新建待办');
      const state = status === 'verified' ? '已写入并核验'
        : status === 'awaiting_confirmation' ? '草稿已生成，等待你确认'
          : status === 'deduplicated' ? '与本轮相同操作合并，未重复执行'
          : status === 'needs_info' ? `尚未执行，缺少${action.missingFields.map(field => ({ minutes: '时长', title: '待办内容', date: '日期/可执行时间' }[field] || field)).join('、')}`
          : status === 'failed' ? '未完成'
            : '已执行，尚未做持久化核验';
      lines.push(`- ${label}：${state}${out.error ? `（${out.content}）` : ''}`);
      if (status === 'needs_info' && action.missingFields.includes('date')) lines.push('  请问这项任务哪天、什么时间方便安排？');
    }
    for (const question of plan.questions) lines.push(`- 还需补充：${question}`);
    const response = lines.join('\n');
    const executed = outcomes.filter(item => !['needs_info', 'deduplicated'].includes(item.status));
    if (executed.length) emit({ type: 'tools_used', names: executed.map(item => item.action.kind) });
    return finishPlannedTurn({ sessionId: session.id, turnId: userMessage.id, userText, response, emit, toolCallCount: executed.length });
  }

  const timerLifecycleRequest = /(?:开始|启动|开启|结束|停止|取消).{0,8}计时/u.test(userText);
  if (shouldPlanGenericWriteActions(userText) && !isExplicitTimerStartRequest(userText) && !timerLifecycleRequest) {
    emit({ type: 'operation_plan_start' });
    try {
      const planned = await streamChat({
        messages: [
          ...messages,
          {
            role: 'system',
            content: `你是写操作规划器，不回复用户。只规划用户本轮明确要求的写入，逐项列出，不能加入用户未要求的动作或省略操作。tool 必须来自允许列表，arguments 必须符合该工具参数定义；只填用户明确提供的信息，缺必填字段仍列出操作并提出问题。讨论、提问或询问是否要做时返回空 actions。\n\n允许的写工具及参数：\n${WRITE_TOOL_CATALOG}`,
          },
        ],
        tools: [GENERIC_WRITE_PLAN_TOOL],
        toolChoice: { type: 'function', function: { name: GENERIC_WRITE_PLAN_TOOL.function.name } },
        model,
        signal,
      });
      if (planned.usage) await addUsage(planned.usage);
      const call = planned.toolCalls.find(tc => tc.function?.name === GENERIC_WRITE_PLAN_TOOL.function.name);
      if (!call) throw new Error('模型没有返回强制要求的写操作清单');
      const existingTaskTitles = (await db.tasks.toArray()).map(task => task.title);
      const plan = parseGenericWritePlan(call.function.arguments, { userText, existingTaskTitles });
      if (plan.actions.length || plan.questions.length) {
        return executeGenericWritePlan({ plan, session, userMessage, userText, emit });
      }
      // The planner's empty result means this was discussion, not a write request.
      // Continue through the normal assistant turn instead of surfacing planner internals.
      plannerConfirmedNoWrite = true;
    } catch (error) {
      await recordAction({
        sessionId: session.id, turnId: userMessage.id, operationId: `${userMessage.id}:write-plan`,
        kind: 'plan_requested_write_actions', args: { userText }, userText, status: 'failed', detail: error.message,
      });
      return finishPlannedTurn({
        sessionId: session.id, turnId: userMessage.id, userText,
        response: `我没有拿到可验证的写操作清单，因此没有执行写入。${error.message}`,
        emit, toolCallCount: 0,
      });
    }
  }

  const working = [...messages];
  let accumulated = '';
  let toolCallCount = 0;
  let hitLimit = false;
  let aborted = false;
  const usedTools = [];
  const forceTimerStart = isExplicitTimerStartRequest(userText);
  const holdWriteReply = !plannerConfirmedNoWrite && isPotentialWriteRequest(userText);

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // 全部工具每轮都下发 —— 见 tools.js 里关于"分组下发为什么被移除"的说明
      const { tools } = toolsForTurn();
      if (iter === 0) emit({ type: 'tools_selected', count: tools.length });
      const forceProfileUpdate = iter === 0 && !decision && !profileInterview && shouldForceProfileUpdate(userText, working);

      const res = await streamChat({
        messages: working,
        tools,
        toolChoice: iter === 0 && forceTimerStart
          ? { type: 'function', function: { name: 'timer_start' } }
          : forceProfileUpdate
          ? { type: 'function', function: { name: 'update_profile' } }
          : 'auto',
        model,
        signal,
        onDelta: text => { accumulated += text; if (!holdWriteReply) emit({ type: 'delta', text }); },
        onReasoning: text => emit({ type: 'reasoning', text }),
      });

      if (res.usage) {
        await addUsage(res.usage);
        emit({ type: 'usage', usage: res.usage });
      }

      if (!res.toolCalls.length) {
        if (iter === MAX_ITERATIONS - 1) hitLimit = true;
        break;
      }

      // 带 tool_calls 的 assistant 消息压回 working，保持配对
      working.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls,
      });

      for (const tc of res.toolCalls) {
        const name = tc.function?.name || '(未命名)';
        emit({ type: 'tool_start', name, args: tc.function?.arguments || '{}' });

        // 错误会被 executeTool 吞成 {error:true} 并回灌给模型，让它自己改参数重试。
        // 承诺类动作（计时、暂停监督、删除…）不会执行，只登记成待确认项等用户点。
        const operationId = `${userMessage.id}:tool:${tc.id}`;
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* executeTool reports the parse error */ }
        const idempotencyKey = WRITE_TOOL_NAMES.has(name)
          ? makeIdempotencyKey({ turnId: userMessage.id, kind: name, args: parsedArgs })
          : '';
        const previousWrite = idempotencyKey ? await findActionByIdempotencyKey(idempotencyKey) : null;
        await recordAction({
          sessionId: session.id, turnId: userMessage.id, operationId, kind: name,
          args: parsedArgs, userText, status: 'requested', idempotencyKey,
        });
        const failedRetryExhausted = previousWrite?.status === 'failed'
          && (!previousWrite.result?.retryable || previousWrite.attemptCount >= 2);
        const previousNeedsInfo = previousWrite?.status === 'needs_info';
        const previousAlreadyHandled = previousWrite
          && (['requested', 'executing', 'awaiting_confirmation', 'succeeded', 'verified', 'deduplicated'].includes(previousWrite.status)
            || failedRetryExhausted || previousNeedsInfo);
        const out = previousAlreadyHandled
          ? previousNeedsInfo
            ? {
                status: 'needs_info',
                errorCode: '',
                retryable: false,
                content: previousWrite.result?.content || previousWrite.detail || '仍需先询问用户哪天、什么时间方便安排任务。',
                summary: '等待补充任务时间',
              }
            : previousWrite.status === 'failed'
            ? {
                error: true,
                status: 'failed',
                errorCode: previousWrite.result?.errorCode || 'execution_failed',
                retryable: false,
                content: `操作 ${previousWrite.operationId} 已失败，且不会自动重试：${previousWrite.result?.content || previousWrite.detail || '无错误详情'}`,
                summary: '失败操作已停止重试',
              }
            : {
              status: 'deduplicated',
              content: `同一轮中相同的 ${name} 写入已由操作 ${previousWrite.operationId} 处理，本次没有重复执行。`,
              summary: '相同写入已合并',
              reusedOperationId: previousWrite.operationId,
            }
          : name === 'timer_start' && !isExplicitTimerStartRequest(userText)
          ? {
              error: true,
              status: 'failed',
              errorCode: 'unauthorized_action',
              retryable: false,
              content: '用户本轮没有明确要求开始计时，不得创建计时确认项，也不得启动计时。请直接回答用户的问题。',
              summary: '没有明确的计时请求',
            }
          : await executeTool(name, tc.function?.arguments, {
            sessionId: session.id, operationId: `${userMessage.id}:tool:${tc.id}`, userText,
          });
        toolCallCount++;
        usedTools.push(name);

        await recordAction({
          sessionId: session.id, turnId: userMessage.id, operationId, kind: name,
          args: parsedArgs, userText, status: out.status || (out.error ? 'failed' : out.pending || out.chatApproval ? 'awaiting_confirmation' : 'succeeded'),
          detail: out.content || '', entity: out.entity || null,
          idempotencyKey,
          requiresConfirmation: Boolean(out.pending || out.chatApproval),
          result: createOperationReceipt({ operationId }, out),
        });

        emit({ type: 'tool_result', name, ok: !out.error, status: out.status, operationId,
          summary: out.error ? (out.content || out.summary || name) : (out.summary || name),
          pending: Boolean(out.pending || out.chatApproval), toast: out.toast || '' });
        if (out.pending) {
          await emit({ type: 'pending', pendingId: out.pendingId, name, summary: out.summary });
        }
        if (out.chatApproval) await emit({ type: 'pending', name, summary: out.summary });
        if (out.refresh) emit({ type: 'refresh' });
        if (out.suspended !== undefined) emit({ type: 'suspended', value: out.suspended });
        if (out.openPanel) emit({ type: 'open_panel', panel: out.openPanel });

        working.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: out.content,
        });
      }

      if (iter === MAX_ITERATIONS - 1) hitLimit = true;
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      aborted = true;
      emit({ type: 'aborted' });
    } else {
      emit({
        type: 'error',
        error: e instanceof ApiError ? e.message : (e?.message || String(e)),
        raw: e?.raw || '',
        kind: e?.kind || (e instanceof ApiError ? 'http' : ''),
        status: e?.status ?? null,
      });
      if (accumulated && !holdWriteReply) {
        await addMessage({ sessionId: session.id, role: 'assistant', content: accumulated });
      }
      throw e;
    }
  }

  if (usedTools.length) emit({ type: 'tools_used', names: usedTools });

  if (holdWriteReply) {
    const actions = (await listActionLedger({ sessionId: session.id, limit: 100 }))
      .filter(item => item.turnId === userMessage.id && WRITE_TOOL_NAMES.has(item.kind));
    const statusText = {
      verified: '已写入并核验',
      awaiting_confirmation: '尚未写入，等待你确认',
      failed: '执行失败',
      deduplicated: '与本轮相同操作合并，未重复写入',
      succeeded: '已执行，但未完成持久化核验',
      executing: '仍在执行',
      requested: '尚未执行',
      needs_info: '缺少必要信息',
    };
    const toolLabel = {
      save_task: '任务记录', set_task_state: '任务状态更新', set_key_tasks: '今日重点设置',
      delete_task: '删除任务', timer_start: '开始计时', timer_stop: '结束计时', timer_cancel: '取消计时',
      log_time_entry: '耗时记录', update_time_entry: '耗时修正', log_study: '学习记录',
      save_checkin: '生活打卡', save_review: '复盘记录', record_procrastination: '拖延记录',
      save_plan: '计划保存', delete_plan: '删除计划', toggle_plan_item: '计划步骤更新',
      save_sop: '流程保存', delete_sop: '删除流程', toggle_sop_step: '流程步骤更新',
      save_memory: '长期记忆', forget_memory: '删除记忆', update_profile: '档案更新',
      add_topic: '知识点记录', grade_review: '复习评价', award_points: '积分记录',
      confirm_points: '积分确认', confirm_all_points: '积分批量确认', upsert_reward: '奖励设置',
      redeem_reward: '兑换奖励', manage_micro_habit: '微习惯更新', manage_life_navigation: '生活导航更新',
    };
    if (!actions.length) {
      accumulated = '这项写入请求没有调用到对应的写入操作，因此尚未执行。';
    } else {
      accumulated = [
        '本轮写入操作状态：',
        ...actions.map((item, index) => `- ${index + 1}. ${toolLabel[item.kind] || '写入操作'}：${statusText[item.status] || '状态未知'}${item.status === 'failed' && item.detail ? `（${item.detail}）` : ''}`),
      ].join('\n');
    }
    emit({ type: 'delta', text: accumulated });
  }

  // 迭代打满还没给出答复 → 去掉工具强制产出文本
  if (hitLimit && !accumulated.trim() && toolCallCount) {
    emit({ type: 'notice', text: '工具调用已达上限，正在整理结论…' });
    try {
      const res = await streamChat({
        messages: [
          ...working,
          { role: 'user', content: '（系统：工具调用次数已达上限。基于上面的结果直接给用户结论，不要再调工具。）' },
        ],
        tools: [],
        model,
        signal,
        onDelta: text => { accumulated += text; if (!holdWriteReply) emit({ type: 'delta', text }); },
      });
      if (res.usage) await addUsage(res.usage);
    } catch (e) {
      if (e?.name !== 'AbortError') throw e;
    }
  }

  if (accumulated.trim()) {
    await addMessage({ sessionId: session.id, role: 'assistant', content: accumulated });
  }

  await recordTurnEvent({
    sessionId: session.id,
    turnId: userMessage.id,
    userText,
    finalContent: accumulated,
    toolCallCount,
    holdWriteReply,
  });

  // 回合结束后看要不要压缩历史 + 沉淀长期记忆
  let compacted = null;
  if (!aborted) {
    try {
      compacted = await compactSession(session.id);
      if (compacted?.memories?.length) emit({ type: 'memories_saved', memories: compacted.memories });
      if (compacted?.compacted) emit({ type: 'compacted', count: compacted.count });
    } catch (e) {
      console.warn('[compact] 跳过压缩:', e?.message);
    }
  }

  emit({
    type: 'done',
    content: accumulated,
    toolCallCount,
    hitLimit,
    aborted,
    compacted,
  });

  return { sessionId: session.id, content: accumulated, toolCallCount, aborted };
}
