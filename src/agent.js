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
import { toolsForTurn, executeTool } from './tools.js';
import { listChatWrites, parseChatWriteDecision, removeChatWrites } from './chat-approvals.js';

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
  const emit = e => { try { onEvent?.(e); } catch (err) { console.error('[onEvent]', err); } };

  const session = await ensureSession();
  await addMessage({ sessionId: session.id, role: 'user', content: userText });
  await autoTitle(session, userText);

  emit({ type: 'start', sessionId: session.id });

  const stagedWrites = await listChatWrites(session.id);
  const decision = parseChatWriteDecision(userText);
  let actionNote = '';
  if (stagedWrites.length && decision === 'confirm') {
    const completedIds = [];
    const results = [];
    for (const item of stagedWrites) {
      const out = await executeTool(item.tool, item.args, { confirmed: true, sessionId: session.id });
      if (out.error) {
        results.push(`保存 ${item.tool} 失败：${out.content}`);
      } else {
        completedIds.push(item.id);
        results.push(out.content || `已保存 ${item.tool}`);
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

  const working = [...messages];
  let accumulated = '';
  let toolCallCount = 0;
  let hitLimit = false;
  let aborted = false;
  const usedTools = [];

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // 全部工具每轮都下发 —— 见 tools.js 里关于"分组下发为什么被移除"的说明
      const { tools } = toolsForTurn();
      if (iter === 0) emit({ type: 'tools_selected', count: tools.length });
      const forceProfileUpdate = iter === 0 && !decision && !profileInterview && shouldForceProfileUpdate(userText, working);

      const res = await streamChat({
        messages: working,
        tools,
        toolChoice: forceProfileUpdate
          ? { type: 'function', function: { name: 'update_profile' } }
          : 'auto',
        model,
        signal,
        onDelta: text => { accumulated += text; emit({ type: 'delta', text }); },
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
        const out = await executeTool(name, tc.function?.arguments, { sessionId: session.id });
        toolCallCount++;
        usedTools.push(name);

        emit({ type: 'tool_result', name, ok: !out.error, summary: out.summary || name, toast: out.toast || '' });
        if (out.pending) {
          emit({ type: 'pending', pendingId: out.pendingId, name, summary: out.summary });
        }
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
      if (accumulated) {
        await addMessage({ sessionId: session.id, role: 'assistant', content: accumulated });
      }
      throw e;
    }
  }

  if (usedTools.length) emit({ type: 'tools_used', names: usedTools });

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
        onDelta: text => { accumulated += text; emit({ type: 'delta', text }); },
      });
      if (res.usage) await addUsage(res.usage);
    } catch (e) {
      if (e?.name !== 'AbortError') throw e;
    }
  }

  if (accumulated.trim()) {
    await addMessage({ sessionId: session.id, role: 'assistant', content: accumulated });
  }

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
