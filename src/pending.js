// ── 待确认动作 ──────────────────────────────────────────────
//
// 有一类工具模型不该自己执行：它们不是"记录"，而是"决定"。
//
//   事实记录类（档案、学习与生活记录）→ 聊天里确认后执行
//     log_study / save_checkin / save_memory / save_task …
//
//   承诺类（模型替用户决定接下来做什么）→ 必须用户点确认
//     timer_start（决定接下来 25 分钟干什么）
//     set_key_tasks（决定今天只做这几件）
//     suspend_supervision（改变模型自己的行为）
//     delete_* / redeem_reward（破坏性或消耗性的）
//
// 这是 §21「用户拥有最终决定权」在代码层的落点 —— 光写进提示词不够，
// 模型仍然会顺手替你按下开始键。必须让它变成按钮。
//
// 待确认项存在 IndexedDB 而非内存，这样刷新页面还在（否则模型说的话会
// 变成指向一个已经消失的按钮的死引用）。

import { getMeta, setMeta } from './db.js';
import { uid, nowISO } from './util.js';

const META_KEY = 'pendingActions';
/** 超过这个时长还没点的，自动作废（避免几天后突然冒出来） */
const EXPIRE_MS = 24 * 3600 * 1000;

async function readAll() {
  const raw = await getMeta(META_KEY, []);
  const list = Array.isArray(raw) ? raw : [];
  const cutoff = Date.now() - EXPIRE_MS;
  return list.filter(p => new Date(p.createdAt).getTime() > cutoff);
}

async function writeAll(list) {
  await setMeta(META_KEY, list);
  return list;
}

/**
 * 登记一个待确认动作。
 * 同一个工具只保留最新的一条 —— 否则模型一轮里调两次就会冒出两个按钮。
 */
export async function addPending({ tool, args, label, detail = '', danger = false, sessionId = '' }) {
  const list = await readAll();
  const rest = list.filter(p => p.tool !== tool);
  const rec = {
    id: uid('pend_'),
    tool,
    args: args || {},
    label,
    detail,
    danger: Boolean(danger),
    sessionId,
    createdAt: nowISO(),
    status: 'pending',
  };
  await writeAll([rec, ...rest].slice(0, 10));
  return rec;
}

export async function listPending(sessionId = null) {
  const list = await readAll();
  const filtered = sessionId ? list.filter(p => !p.sessionId || p.sessionId === sessionId) : list;
  return filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function removePending(id) {
  const list = await readAll();
  await writeAll(list.filter(p => p.id !== id));
}

export async function clearPending(sessionId = null) {
  if (!sessionId) { await writeAll([]); return 0; }
  const list = await readAll();
  const keep = list.filter(p => p.sessionId && p.sessionId !== sessionId);
  await writeAll(keep);
  return list.length - keep.length;
}

export const countPending = async (sessionId = null) => (await listPending(sessionId)).length;
