import { db, getMeta, setMeta } from './db.js';
import { getSupabaseClient } from './supabase.js';

let session = null;
let onChange = null;
let syncing = null;
let pending = false;
let taskSyncTimer = null;
let status = { connected: false, message: '任务保存在本机' };

function getClient() {
  return getSupabaseClient();
}

function publish(message, connected = Boolean(session)) {
  status = { connected, message };
  window.dispatchEvent(new CustomEvent('msa:task-sync-status', { detail: status }));
}

function timestamp(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function sameTask(a, b) {
  return Boolean(a && b) && Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([key, value]) => JSON.stringify(b[key]) === JSON.stringify(value));
}

function mergeTasks(localTasks, cloudTasks, localDeletes, cloudDeletes) {
  const deleted = { ...cloudDeletes };
  for (const [id, value] of Object.entries(localDeletes)) {
    if (timestamp(value) > timestamp(deleted[id])) deleted[id] = value;
  }
  const merged = new Map();
  for (const task of [...cloudTasks, ...localTasks]) {
    const current = merged.get(task.id);
    if (!current || timestamp(task.updatedAt) >= timestamp(current.updatedAt)) merged.set(task.id, task);
  }
  for (const [id, task] of merged) {
    if (timestamp(deleted[id]) >= timestamp(task.updatedAt)) merged.delete(id);
    else delete deleted[id];
  }
  return { tasks: [...merged.values()], deleted };
}

async function synchronize(quiet = false) {
  if (!session) return;
  if (syncing) {
    pending = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      pending = false;
      const userId = session.user.id;
      if (!quiet) publish('正在同步任务…');
      const { data, error } = await getClient().from('user_tasks')
        .select('task_id,content,deleted_at,updated_at').eq('user_id', userId);
      if (error) throw error;
      if (session?.user.id !== userId) return;

      const localTasks = await db.tasks.toArray();
      const owner = await getMeta('taskSyncOwner', null);
      const canMergeLocal = !owner || owner === userId;
      const ownedTasks = canMergeLocal ? localTasks : [];
      const localDeletes = canMergeLocal ? await getMeta('deletedTasks', {}) : {};
      const cloudRows = new Map((data || []).map(row => [row.task_id, row]));
      const cloudTasks = (data || []).filter(row => !row.deleted_at && row.content)
        .map(row => ({ ...row.content, id: row.task_id }));
      const cloudDeletes = Object.fromEntries((data || []).filter(row => row.deleted_at)
        .map(row => [row.task_id, row.deleted_at]));
      const merged = mergeTasks(ownedTasks, cloudTasks, localDeletes, cloudDeletes);
      const mergedIds = new Set(merged.tasks.map(task => task.id));
      const changed = localTasks.length !== merged.tasks.length
        || merged.tasks.some(task => !sameTask(localTasks.find(local => local.id === task.id), task));

      if (session?.user.id !== userId) return;
      for (const task of localTasks) {
        if (!mergedIds.has(task.id)) await db.tasks.delete(task.id);
      }
      if (merged.tasks.length) await db.tasks.bulkPut(merged.tasks);
      await setMeta('deletedTasks', merged.deleted);
      await setMeta('taskSyncOwner', userId);

      const writes = [];
      for (const task of merged.tasks) {
        const row = cloudRows.get(task.id);
        const sameContent = sameTask(row?.content, task);
        if (sameContent && !row.deleted_at) continue;
        writes.push({ user_id: userId, task_id: task.id, content: task, deleted_at: null, updated_at: task.updatedAt || new Date().toISOString() });
      }
      for (const [id, deletedAt] of Object.entries(merged.deleted)) {
        const row = cloudRows.get(id);
        if (row?.deleted_at === deletedAt) continue;
        writes.push({ user_id: userId, task_id: id, content: null, deleted_at: deletedAt, updated_at: deletedAt });
      }
      if (writes.length) {
        if (session?.user.id !== userId) return;
        const { error: writeError } = await getClient().from('user_tasks').upsert(writes, { onConflict: 'user_id,task_id' });
        if (writeError) throw writeError;
      }
      if (!quiet || changed || writes.length || status.message.startsWith('任务同步失败')) publish('任务已同步');
      if (changed) onChange?.();
    } while (pending && session);
  })().catch(error => {
    const message = `任务同步失败：${error.message || String(error)}（请检查 supabase/tasks.sql）`;
    if (!quiet || status.message !== message) {
      publish(message);
      console.warn('[task-sync]', error);
    }
  }).finally(() => {
    syncing = null;
    if (pending && session) {
      pending = false;
      void synchronize();
    }
  });
  return syncing;
}

export async function initTaskSync(onSyncChange) {
  onChange = onSyncChange || null;
  const supabase = getClient();
  if (!supabase) {
    publish('未配置云同步，任务保存在本机', false);
    return status;
  }
  window.addEventListener('msa:tasks-changed', () => { void synchronize(); });
  if (!taskSyncTimer) taskSyncTimer = setInterval(() => { if (session) void synchronize(true); }, 30000);
  const { data, error } = await supabase.auth.getSession();
  if (error) publish(`任务同步失败：${error.message || String(error)}`, false);
  else session = data.session;
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    if (session) void synchronize();
    else publish('登录后同步任务', false);
  });
  if (session) await synchronize();
  else publish('登录后同步任务', false);
  return status;
}

export function getTaskSyncStatus() {
  return status;
}
