import { getMeta, setMeta } from './db.js';
import { uid, nowISO } from './util.js';

const META_KEY = 'chatWriteApprovals';
const EXPIRE_MS = 24 * 60 * 60 * 1000;

async function readAll() {
  const raw = await getMeta(META_KEY, []);
  const cutoff = Date.now() - EXPIRE_MS;
  return (Array.isArray(raw) ? raw : [])
    .filter(item => new Date(item.createdAt).getTime() > cutoff);
}

export async function stageChatWrite({ tool, args, sessionId, operationId = '' }) {
  const all = await readAll();
  const existing = operationId && all.find(item => item.operationId === operationId);
  if (existing) return existing;
  const item = { id: uid('chat_approval_'), tool, args, sessionId, operationId, createdAt: nowISO() };
  await setMeta(META_KEY, [...all, item].slice(-30));
  return item;
}

export async function listChatWrites(sessionId) {
  return (await readAll()).filter(item => item.sessionId === sessionId);
}

export async function removeChatWrites(ids) {
  const remove = new Set(ids);
  await setMeta(META_KEY, (await readAll()).filter(item => !remove.has(item.id)));
}

export function parseChatWriteDecision(text) {
  const value = String(text || '').trim().replace(/[。.!！?？]+$/g, '');
  if (/^(?:确认保存|确认|保存|同意|按这个记录|就这样保存|好的?确认)$/.test(value)) return 'confirm';
  if (/^(?:取消保存|取消|不保存|不用保存|不要记录|先不记|算了)$/.test(value)) return 'cancel';
  return null;
}
