import { getMeta, setMeta } from './db.js';
import { uid, nowISO } from './util.js';
import {
  getToolArgumentSchema, TOOL_DEFS, validateToolArguments, WRITE_TOOL_NAMES,
} from './tools.js';

export const ACTION_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_requested_actions',
    description: '将用户明确要求的记录和待办操作拆成完整清单。只规划自报耗时记录和新建待办；不要推断未提供的时长、日期或任务内容。信息不足时写入 questions。即使没有操作也必须返回空 actions。',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: '按用户表达顺序列出全部明确要求的操作，不得合并或省略。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['log_time_entry', 'save_task'] },
              task: { type: 'string', description: '耗时归属任务；没有明确任务时留空。' },
              minutes: { type: 'integer', description: '用户明确报告的分钟数；未知时省略并列入 questions。' },
              note: { type: 'string', description: '耗时记录备注，只能取自对话事实。' },
              title: { type: 'string', description: '新待办的简洁标题，保留用户原意；未知时省略并列入 questions。' },
              goal: { type: 'string', description: '用户明确表达的目标，可留空。' },
              dueAt: { type: 'string', description: '明确日期 YYYY-MM-DD；未说明时留空。' },
              estimateMin: { type: 'integer', description: '明确预计时长；未说明时省略。' },
              area: { type: 'string', enum: ['study', 'work', 'life', 'other'] },
              category: { type: 'string', enum: ['important', 'chore'] },
              priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        questions: {
          type: 'array',
          description: '执行前必须补充的信息；无需追问时返回空数组。',
          items: { type: 'string' },
        },
      },
      required: ['actions', 'questions'],
      additionalProperties: false,
    },
  },
};

export const GENERIC_WRITE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan_requested_write_actions',
    description: '将用户明确要求的写入拆成逐项清单。tool 只能选允许的写工具；arguments 必须符合系统提供的该工具参数定义。不得加入用户未要求的动作；缺必填信息的操作仍列出并提问。',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: [...WRITE_TOOL_NAMES] },
              arguments: { type: 'object', description: '此工具的完整参数对象；仅填用户明确提供的信息。' },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
          },
        },
        questions: { type: 'array', items: { type: 'string' } },
      },
      required: ['actions', 'questions'],
      additionalProperties: false,
    },
  },
};

export const WRITE_TOOL_CATALOG = TOOL_DEFS
  .filter(item => WRITE_TOOL_NAMES.has(item.function.name))
  .map(item => `${item.function.name}: ${item.function.description}\n${JSON.stringify(item.function.parameters)}`)
  .join('\n');

export function parseGenericWritePlan(raw) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch (error) {
    throw new Error(`操作清单不是合法 JSON：${error.message}`);
  }
  if (!value || !Array.isArray(value.actions) || !Array.isArray(value.questions)) {
    throw new Error('操作清单缺少 actions 或 questions 数组');
  }
  if (value.actions.length > 10) throw new Error('单次最多处理 10 项操作');

  const actions = value.actions.map((item, index) => {
    if (!item || typeof item.tool !== 'string' || !WRITE_TOOL_NAMES.has(item.tool)) {
      throw new Error(`第 ${index + 1} 项不是允许的写入工具`);
    }
    const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
      ? item.arguments
      : {};
    const schema = getToolArgumentSchema(item.tool);
    const missingFields = (schema?.required || []).filter(key => !Object.hasOwn(args, key));
    const validationError = validateToolArguments(item.tool, args);
    if (missingFields.length) {
      return { kind: item.tool, args, status: 'needs_info', missingFields, validationError };
    }
    if (validationError) {
      return { kind: item.tool, args, status: 'failed', missingFields: [], validationError };
    }
    return { kind: item.tool, args, status: 'requested', missingFields: [], validationError: '' };
  });

  return {
    actions,
    questions: value.questions.map(question => String(question || '').trim()).filter(Boolean).slice(0, 10),
  };
}

const ACTION_INTENT = /(?:帮我|替我|请|需要|顺便|现在)?\s*(?:把.{0,48})?(?:登记|补记|记下|记录下来|加入待办|添加到待办|加到待办|放进待办|新建待办|创建待办|新增任务|创建任务|加进任务|加到任务)/iu;
const REPORT_CORRECTION = /(?:你|刚才|之前|上次).{0,30}(?:没(?:有)?(?:登记|记下|记录)|漏(?:了)?(?:登记|记录)).{0,24}(?:\d+\s*(?:分钟|min)|专注|耗时)/iu;
const QUESTION_ONLY = /(?:(?:怎么|如何|为什么|为何|是否|能不能|可不可以|有没有).{0,16}(?:登记|补记|记录|待办|任务)|(?:要不要|要.{0,10}(?:登记|补记|记录|加到待办).{0,8}(?:吗|呢)))/iu;
const WRITE_VERBS = /(?:保存|登记|补记|记录|新建|创建|添加|加入|更新|修改|删除|移除|开始|启动|结束|停止|暂停|恢复|完成|标记|设定|设为|设成|打卡|复盘|归档|兑换)/u;
const WRITE_TARGETS = /(?:任务|待办|记录|耗时|时间|计时|计划|复盘|打卡|档案|记忆|奖励|积分|知识点|步骤|习惯|导航|方案|监督)/u;

export function shouldPlanActions(text) {
  const value = String(text || '').trim();
  const explicitRequest = /(?:帮我|替我|请|需要|要我|顺便).{0,24}(?:登记|补记|记下|记录|待办|任务)/iu.test(value);
  if (!value || ((QUESTION_ONLY.test(value) || /(?:吗|呢)\s*[?？]?$/u.test(value)) && !explicitRequest)) return false;
  return ACTION_INTENT.test(value) || REPORT_CORRECTION.test(value);
}

export function isPotentialWriteRequest(text) {
  const value = String(text || '').trim();
  if (!value || QUESTION_ONLY.test(value)) return false;
  if (/(?:导出|下载|备份).{0,12}(?:记录|数据|档案)?/u.test(value)
    && !/(?:保存|登记|补记|新建|创建|添加|加入|更新|修改|删除|移除|设定|设为|设成|打卡|复盘|兑换)/u.test(value)) return false;
  if (/(?:帮我|替我|请|麻烦|把|将|给我).{0,36}(?:保存|登记|补记|记录|新建|创建|添加|加入|更新|修改|删除|移除|开始|启动|结束|停止|暂停|恢复|完成|标记|设定|设为|设成|打卡|复盘|归档|兑换)/u.test(value)) return true;
  return WRITE_VERBS.test(value) && WRITE_TARGETS.test(value) && !/(?:怎么|如何|为什么|为何|是否|能不能|可不可以|有没有)/u.test(value);
}

export function shouldPlanGenericWriteActions(text) {
  const timerLifecycleRequest = /(?:开始|启动|开启|结束|停止|取消).{0,8}计时/u.test(String(text || ''));
  return isPotentialWriteRequest(text) && !shouldPlanActions(text) && !timerLifecycleRequest;
}

export function parseActionPlan(raw) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  } catch (error) {
    throw new Error(`操作清单不是合法 JSON：${error.message}`);
  }
  if (!value || !Array.isArray(value.actions) || !Array.isArray(value.questions)) {
    throw new Error('操作清单缺少 actions 或 questions 数组');
  }
  if (value.actions.length > 10) throw new Error('单次最多处理 10 项操作');

  const actions = value.actions.map((item, index) => {
    if (!item || !['log_time_entry', 'save_task'].includes(item.kind)) {
      throw new Error(`第 ${index + 1} 项操作类型无效`);
    }
    if (item.kind === 'log_time_entry') {
      const missingFields = item.minutes == null ? ['minutes'] : [];
      const minutes = Number(item.minutes);
      if (!missingFields.length && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
        throw new Error(`第 ${index + 1} 项耗时必须是 1 到 1440 的整数分钟`);
      }
      return {
        kind: item.kind,
        status: missingFields.length ? 'needs_info' : 'requested',
        missingFields,
        args: {
          task: String(item.task || '').trim(),
          ...(missingFields.length ? {} : { minutes, selfReportedMin: minutes }),
          note: String(item.note || '').trim(),
        },
      };
    }
    const title = String(item.title || '').trim();
    const missingFields = title ? [] : ['title'];
    const args = title ? { title } : {};
    for (const key of ['goal', 'dueAt', 'area', 'category', 'priority']) {
      if (typeof item[key] === 'string' && item[key].trim()) args[key] = item[key].trim();
    }
    if (Number.isInteger(item.estimateMin) && item.estimateMin >= 0) args.estimateMin = item.estimateMin;
    return { kind: item.kind, status: missingFields.length ? 'needs_info' : 'requested', missingFields, args };
  });

  const questions = value.questions.map(q => String(q || '').trim()).filter(Boolean).slice(0, 10);
  return { actions, questions };
}

const LEDGER_KEY = 'actionLedger';
const TURN_EVENTS_KEY = 'actionTurnEvents';
const MAX_LEDGER_ITEMS = 300;

async function readLedger() {
  const value = await getMeta(LEDGER_KEY, []);
  return Array.isArray(value) ? value : [];
}

export async function recordTurnEvent({ sessionId, turnId, userText = '', finalContent = '', toolCallCount = 0, holdWriteReply = false } = {}) {
  const events = await getMeta(TURN_EVENTS_KEY, []);
  const next = Array.isArray(events) ? events : [];
  const event = {
    sessionId, turnId, userText, finalContent, toolCallCount, holdWriteReply,
    actionStatuses: (await listActionLedger({ sessionId, limit: MAX_LEDGER_ITEMS }))
      .filter(item => item.turnId === turnId)
      .map(item => ({ operationId: item.operationId, kind: item.kind, status: item.status, errorCode: item.result?.errorCode || '' })),
    createdAt: nowISO(),
  };
  const index = next.findIndex(item => item.sessionId === sessionId && item.turnId === turnId);
  if (index >= 0) next[index] = event;
  else next.push(event);
  await setMeta(TURN_EVENTS_KEY, next.slice(-MAX_LEDGER_ITEMS));
  return event;
}

export async function listTurnEvents({ sessionId, limit = 100 } = {}) {
  const events = await getMeta(TURN_EVENTS_KEY, []);
  return (Array.isArray(events) ? events : [])
    .filter(item => !sessionId || item.sessionId === sessionId)
    .slice(-Math.max(1, limit));
}


export async function recordAction({
  sessionId, turnId, operationId, kind, args, status, detail = '', entity = null,
  userText, target, parameterSources, missingFields, requiresConfirmation, result, idempotencyKey,
}) {
  const ledger = await readLedger();
  const index = ledger.findIndex(item => item.operationId === operationId);
  const previous = index >= 0 ? ledger[index] : {};
  const normalizedArgs = args ?? previous.args ?? {};
  const normalizedTarget = target ?? normalizedArgs.title ?? normalizedArgs.task ?? normalizedArgs.id ?? previous.target ?? null;
  const item = {
    ...previous,
    operationId,
    sessionId,
    turnId,
    kind,
    args: normalizedArgs,
    originalRequest: userText ?? previous.originalRequest ?? '',
    target: normalizedTarget,
    parameterSources: parameterSources ?? previous.parameterSources ?? {},
    missingFields: missingFields ?? previous.missingFields ?? [],
    requiresConfirmation: requiresConfirmation ?? (status === 'awaiting_confirmation' ? true : previous.requiresConfirmation ?? false),
    result: result ?? (detail ? { ...(previous.result || {}), status, detail, entity } : previous.result ?? null),
    idempotencyKey: idempotencyKey ?? previous.idempotencyKey ?? '',
    status,
    detail,
    entity,
    updatedAt: nowISO(),
    createdAt: index >= 0 ? ledger[index].createdAt : nowISO(),
  };
  if (index >= 0) ledger[index] = item;
  else ledger.push(item);
  await setMeta(LEDGER_KEY, ledger.slice(-MAX_LEDGER_ITEMS));
  return item;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function makeIdempotencyKey({ turnId, kind, args, slot = '' }) {
  return `${turnId}:${kind}:${slot}:${JSON.stringify(stableValue(args || {}))}`;
}

export async function findActionByIdempotencyKey(idempotencyKey) {
  if (!idempotencyKey) return null;
  const ledger = await readLedger();
  const matches = ledger.filter(item => item.idempotencyKey === idempotencyKey);
  return matches.length ? { ...matches.at(-1), attemptCount: matches.length } : null;
}

export function createOperationReceipt(action, out) {
  return {
    status: out.status || (out.error ? 'failed' : out.pending || out.chatApproval ? 'awaiting_confirmation' : 'succeeded'),
    operationId: action.operationId,
    recordId: out.recordId || out.entity?.id || '',
    summary: out.summary || '',
    requiresConfirmation: Boolean(out.requiresConfirmation || out.pending || out.chatApproval),
    errorCode: out.errorCode || '',
    retryable: Boolean(out.retryable),
    content: out.content || '',
    entity: out.entity || null,
    pendingId: out.pendingId || '',
  };
}

export async function listActionLedger({ sessionId, limit = 100 } = {}) {
  const ledger = await readLedger();
  return ledger
    .filter(item => !sessionId || item.sessionId === sessionId)
    .slice(-Math.max(1, limit));
}

/**
 * 从操作账本计算当前可比较的运行指标。没有人工标注时，不把“漏调”伪装成
 * 可观测事实；漏调/误调需要把预期操作写入评测样本，账本只负责执行结果指标。
 */
export async function getActionMetrics({ sessionId, limit = MAX_LEDGER_ITEMS } = {}) {
  const items = await listActionLedger({ sessionId, limit });
  const count = items.length;
  const countStatus = status => items.filter(item => item.status === status).length;
  const countError = code => items.filter(item => item.result?.errorCode === code || item.errorCode === code).length;
  const attempted = items.filter(item => !['requested', 'needs_info'].includes(item.status)).length;
  const verified = countStatus('verified');
  return {
    sampleSize: count,
    attempted,
    verified,
    verifiedRate: attempted ? verified / attempted : null,
    awaitingConfirmation: countStatus('awaiting_confirmation'),
    needsInfo: countStatus('needs_info'),
    failed: countStatus('failed'),
    deduplicated: countStatus('deduplicated'),
    invalidArguments: countError('invalid_arguments'),
    businessRejected: countError('business_rejected'),
    networkErrors: countError('network_error'),
    persistenceErrors: countError('persistence_error'),
    readbackFailures: items.filter(item => ['readback_missing', 'readback_mismatch'].includes(item.result?.errorCode || item.errorCode)).length,
    note: '漏调率、误调率和反馈误报率需要带预期标签的评测样本；仅凭运行账本无法可靠推断。',
  };
}
