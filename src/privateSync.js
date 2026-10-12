import { db, getMeta, setMeta } from './db.js';

const TABLE = 'user_private_records';
const OWNER_KEY = 'privateSyncOwner';
const DELETES_KEY = 'privateSyncDeletes';
const RETENTION_DAYS = 60;

let client = null;
let session = null;
let syncing = null;
let pendingSync = false;
let onChange = null;
let status = { connected: false, email: '', message: '个人资料和对话保存在本机' };
let syncTimer = null;
let changeTimeout = null;

function getClient() {
  if (client) return client;
  const config = window.APP_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) return null;
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  return client;
}

function publish(message, connected = Boolean(session)) {
  status = { connected, email: session?.user?.email || '', message };
  window.dispatchEvent(new CustomEvent('msa:private-sync-status', { detail: status }));
}

function stamp(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : 0;
}

function recordKey(type, id) { return `${type}:${id}`; }

function safeProfile(profile) {
  const { adhdStatus, supervisorImage, selfWords, ...safe } = profile;
  return safe;
}

async function readLocalRecords() {
  const [profiles, sessions, messages] = await Promise.all([
    db.profile.toArray(), db.sessions.toArray(), db.messages.toArray(),
  ]);
  return [
    ...profiles.map(content => ({ type: 'profile', id: 'me', content: safeProfile(content), updated_at: content.updatedAt || '' })),
    ...sessions.map(content => ({ type: 'session', id: content.id, content, updated_at: content.updatedAt || content.createdAt || '' })),
    ...messages.map(content => ({ type: 'message', id: content.id, content, updated_at: content.createdAt || '' })),
  ];
}

async function readAllRemote(userId) {
  const rows = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const { data, error } = await getClient().from(TABLE)
      .select('record_type,record_id,content,deleted_at,updated_at')
      .eq('user_id', userId).order('record_type').order('record_id').range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

async function applyRecords(records) {
  const sessions = records.filter(row => row.type === 'session').map(row => row.content);
  const messages = records.filter(row => row.type === 'message').map(row => row.content);
  const profile = records.find(row => row.type === 'profile')?.content;
  const sessionIds = new Set(sessions.map(item => item.id));
  const messageIds = new Set(messages.map(item => item.id));
  const localSessions = await db.sessions.toArray();
  const localMessages = await db.messages.toArray();

  await db.sessions.bulkDelete(localSessions.filter(item => !sessionIds.has(item.id)).map(item => item.id));
  await db.messages.bulkDelete(localMessages.filter(item => !messageIds.has(item.id)).map(item => item.id));
  if (sessions.length) await db.sessions.bulkPut(sessions);
  if (messages.length) await db.messages.bulkPut(messages);
  if (profile) await db.profile.put(profile);
  else await db.profile.delete('me');

  const current = await getMeta('currentSession', null);
  if (!sessionIds.has(current)) {
    const latest = sessions.slice().sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt))[0];
    if (latest) await setMeta('currentSession', latest.id);
    else await db.meta.delete('currentSession');
  }
}

async function synchronize() {
  if (!session) return;
  if (syncing) { pendingSync = true; return syncing; }
  syncing = (async () => {
    do {
      pendingSync = false;
      const userId = session.user.id;
      publish('正在同步对话和学习档案…');
      const [remoteRows, localRows, owner, savedDeletes] = await Promise.all([
        readAllRemote(userId), readLocalRecords(), getMeta(OWNER_KEY, null), getMeta(DELETES_KEY, {}),
      ]);
      if (session?.user.id !== userId) return;

      const canMergeLocal = !owner || owner === userId;
      const local = canMergeLocal ? localRows : [];
      const deletes = { ...(canMergeLocal ? savedDeletes : {}) };
      const remoteByKey = new Map(remoteRows.map(row => [recordKey(row.record_type, row.record_id), row]));
      for (const row of remoteRows) {
        if (row.deleted_at && stamp(row.deleted_at) >= stamp(deletes[recordKey(row.record_type, row.record_id)])) {
          deletes[recordKey(row.record_type, row.record_id)] = row.deleted_at;
        }
      }

      const merged = new Map();
      for (const row of [...remoteRows.filter(item => item.content && !item.deleted_at), ...local]) {
        const key = recordKey(row.record_type || row.type, row.record_id || row.id);
        const current = merged.get(key);
        const rowStamp = stamp(row.updated_at || row.content?.updatedAt || row.content?.createdAt);
        const currentStamp = stamp(current?.updated_at || current?.content?.updatedAt || current?.content?.createdAt);
        if (!current || rowStamp >= currentStamp) {
          const [type, ...idParts] = key.split(':');
          merged.set(key, { type, id: idParts.join(':'), content: row.content, updated_at: row.updated_at || row.content?.updatedAt || row.content?.createdAt || '' });
        }
      }

      for (const [key, row] of merged) {
        if (stamp(deletes[key]) >= stamp(row.updated_at)) merged.delete(key);
        else if (deletes[key]) delete deletes[key];
      }

      const activeSessions = new Set([...merged.values()].filter(row => row.type === 'session').map(row => row.id));
      for (const [key, row] of [...merged]) {
        if (row.type === 'message' && !activeSessions.has(row.content.sessionId)) {
          merged.delete(key);
          deletes[key] = deletes[`session:${row.content.sessionId}`] || new Date().toISOString();
        }
      }

      const rows = [...merged.values()];
      await applyRecords(rows);
      const writes = [];
      for (const [key, row] of merged) {
        const cloud = remoteByKey.get(key);
        const content = JSON.stringify(row.content);
        if (cloud && !cloud.deleted_at && JSON.stringify(cloud.content) === content) continue;
        writes.push({ user_id: userId, record_type: row.type, record_id: row.id, content: row.content, deleted_at: null, updated_at: row.updated_at || new Date().toISOString() });
      }
      for (const [key, deletedAt] of Object.entries(deletes)) {
        const [type, ...idParts] = key.split(':');
        const id = idParts.join(':');
        const cloud = remoteByKey.get(key);
        if (cloud?.deleted_at === deletedAt) continue;
        writes.push({ user_id: userId, record_type: type, record_id: id, content: null, deleted_at: deletedAt, updated_at: deletedAt });
      }
      for (let index = 0; index < writes.length; index += 200) {
        if (session?.user.id !== userId) return;
        const { error } = await getClient().from(TABLE).upsert(writes.slice(index, index + 200), { onConflict: 'user_id,record_type,record_id' });
        if (error) throw error;
      }
      await setMeta(DELETES_KEY, deletes);
      await setMeta(OWNER_KEY, userId);
      publish('对话和学习档案已同步');
      onChange?.();
    } while (pendingSync && session);
  })().catch(error => {
    publish(`对话/档案同步失败：${error.message || String(error)}（请执行 supabase/private-sync.sql）`);
    console.warn('[private-sync]', error);
  }).finally(() => {
    syncing = null;
    if (pendingSync && session) { pendingSync = false; void synchronize(); }
  });
  return syncing;
}

export async function initPrivateSync(onSyncChange) {
  onChange = onSyncChange || null;
  const supabase = getClient();
  if (!supabase) {
    publish('未配置云同步，对话和学习档案保存在本机', false);
    return status;
  }
  window.addEventListener('msa:private-data-changed', () => {
    clearTimeout(changeTimeout);
    changeTimeout = setTimeout(() => { void synchronize(); }, 700);
  });
  if (!syncTimer) syncTimer = setInterval(() => { if (session) void synchronize(); }, 30000);
  const { data, error } = await supabase.auth.getSession();
  if (error) publish(`同步失败：${error.message}`, false);
  else session = data.session;
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    if (session) void synchronize();
    else publish('登录后同步对话和学习档案', false);
  });
  if (session) await synchronize();
  else publish('登录后同步对话和学习档案', false);
  return status;
}

export function getPrivateSyncStatus() { return status; }

export async function refreshPrivateSyncSession() {
  const supabase = getClient();
  if (!supabase) return status;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  session = data.session;
  if (session) await synchronize();
  else publish('登录后同步对话和学习档案', false);
  return status;
}

async function readRemoteTable(table, fields, userId) {
  const rows = [];
  const size = 500;
  const orderBy = table === 'user_tasks' ? 'task_id'
    : table === 'user_donelist_entries' ? 'entry_date'
      : table === TABLE ? 'record_id' : 'user_id';
  for (let from = 0; ; from += size) {
    const { data, error } = await getClient().from(table).select(fields).eq('user_id', userId)
      .order(orderBy).range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) return rows;
  }
}

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function getStorageUsage() {
  let browser = null;
  try {
    const estimate = globalThis.navigator?.storage?.estimate;
    if (typeof estimate === 'function') browser = await estimate.call(globalThis.navigator.storage);
  } catch { /* 某些浏览器禁用存储配额统计 */ }
  const result = {
    browserUsed: browser?.usage ?? null,
    browserQuota: browser?.quota ?? null,
    syncedBytes: null,
    syncedRows: null,
    syncError: '',
  };
  if (!session) return result;
  try {
    const userId = session.user.id;
    const [tasks, reviews, habits, privateRows] = await Promise.all([
      readRemoteTable('user_tasks', 'task_id,content,deleted_at,updated_at', userId),
      readRemoteTable('user_donelist_entries', 'entry_date,content,updated_at', userId),
      readRemoteTable('user_micro_habit_states', 'state,updated_at', userId),
      readRemoteTable(TABLE, 'record_type,record_id,content,deleted_at,updated_at', userId),
    ]);
    const groups = [tasks, reviews, habits, privateRows];
    result.syncedRows = groups.reduce((sum, group) => sum + group.length, 0);
    result.syncedBytes = groups.reduce((sum, group) => sum + bytes(group), 0);
  } catch (error) {
    result.syncError = error.message || String(error);
  }
  return result;
}
