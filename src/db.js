// ── 数据层：IndexedDB via Dexie。这就是"数据库"，只是它跑在浏览器里 ──
//
// v2：从「学习助手」扩展为「帕尼尼个人执行监督系统」。
//   8 张表 → 15 张表；tasks 从 3 状态/11 字段 → 8 状态/23 字段。
//
// 为什么不用 localStorage：同步阻塞、只能整存整取字符串、没有索引。
// 记录会长到上万条，没有索引就只能全表扫。

// 注意扩展名必须是 .js 而不是 .mjs：浏览器加载 ES 模块时严格检查 MIME 类型，
// 而 `python -m http.server` 把 .mjs 当 text/plain 返回，会直接拒绝执行。
import Dexie from '../vendor/dexie.js';
import { uid, nowISO, dateStr } from './util.js';

export const db = new Dexie('my_study_agent');

/* ══════════════ 枚举常量 ══════════════
   刻意与提示词里的词汇完全一致（大写），减少模型翻译成本 */

export const TASK_STATES = {
  INBOX:     { label: '待整理', short: 'INBOX',     desc: '还没想清楚，先扔进来' },
  NEXT:      { label: '下一步', short: 'NEXT',      desc: '确定了要做，但还没排期' },
  READY:     { label: '可执行', short: 'READY',     desc: '条件齐了，随时能开始' },
  DOING:     { label: '进行中', short: 'DOING',     desc: '正在做' },
  BLOCKED:   { label: '受阻',   short: 'BLOCKED',   desc: '卡住了，有明确阻碍' },
  DONE:      { label: '已完成', short: 'DONE',      desc: '经用户确认完成' },
  CANCELLED: { label: '已取消', short: 'CANCELLED', desc: '主动决定不做了' },
  DEFERRED:  { label: '已延期', short: 'DEFERRED',  desc: '推迟，通常会带新日期' },
};
export const TASK_STATE_ORDER = [
  'DOING', 'BLOCKED', 'READY', 'NEXT', 'INBOX', 'DEFERRED', 'DONE', 'CANCELLED',
];
export const ACTIVE_STATES = ['DOING', 'BLOCKED', 'READY', 'NEXT', 'INBOX'];

export const PRIORITIES = {
  P0: { label: '紧急且后果严重', color: 'danger' },
  P1: { label: '重要，应优先处理', color: 'warn' },
  P2: { label: '正常待办', color: '' },
  P3: { label: '可选事项', color: '' },
};
export const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'];

export const AREAS = {
  study: { label: '学习', icon: '📖' },
  work:  { label: '工作', icon: '💼' },
  life:  { label: '生活', icon: '🏠' },
  other: { label: '其他', icon: '·' },
};

/* ══════════════ Schema ══════════════ */

db.version(1).stores({
  profile:  'id',
  tasks:    'id, status, kind, updatedAt, dueAt, createdAt',
  topics:   'id, name, taskId, nextReviewAt, mastery, updatedAt',
  sessions: 'id, createdAt, updatedAt',
  messages: 'id, sessionId, createdAt',
  logs:     'id, date, topicId, taskId, createdAt',
  memories: 'id, kind, taskId, createdAt, lastUsedAt',
  meta:     'key',
});

db.version(2).stores({
  profile:    'id',
  tasks:      'id, state, priority, area, updatedAt, dueAt, createdAt, actualStart',
  topics:     'id, name, taskId, nextReviewAt, mastery, updatedAt',
  sessions:   'id, createdAt, updatedAt',
  messages:   'id, sessionId, createdAt',
  logs:       'id, date, topicId, taskId, createdAt',
  memories:   'id, kind, taskId, createdAt, lastUsedAt',
  meta:       'key',
  // ── v2 新增 ──
  timeEntries: 'id, taskId, startedAt, endedAt, createdAt',
  points:      'id, date, kind, taskId, confirmed, createdAt',
  rewards:     'id, cost, createdAt',
  checkins:    'id, date, updatedAt',
  plans:       'id, code, status, updatedAt, createdAt',
  sops:        'id, name, updatedAt, createdAt',
  reviews:     'id, kind, date, pattern, createdAt',
}).upgrade(async tx => {
  // v1 → v2：旧的三状态映射到新状态机，并回填缺失字段
  const STATE_MAP = { active: 'READY', paused: 'DEFERRED', done: 'DONE' };
  await tx.table('tasks').toCollection().modify(t => {
    t.state = STATE_MAP[t.status] || t.status || 'INBOX';
    t.priority = t.priority || 'P2';
    // 旧数据没有领域概念：主线任务当成学习，其余归到其他
    t.area = t.area || (t.kind === 'mainline' ? 'study' : 'other');
    t.estimateMin = t.estimateMin ?? null;
    t.plannedStart = t.plannedStart || '';
    t.actualStart = t.actualStart || '';
    t.actualEnd = t.actualEnd || '';
    t.actualMin = t.actualMin ?? null;
    t.nextAction = t.nextAction || '';
    t.blocker = t.blocker || '';
    t.mood = t.mood ?? null;
    t.attention = t.attention ?? null;
    t.outcome = t.outcome || '';
    t.review = t.review || '';
    delete t.status;
    delete t.kind;
  });

  // 档案：补齐 12 项之外的监督相关字段
  await tx.table('profile').toCollection().modify(p => {
    p.supervisorName = p.supervisorName || '帕尼尼';
    p.toneLevel = p.toneLevel ?? 5;
    p.allowProfanity = p.allowProfanity ?? true;
    p.taboos = p.taboos || [];
    p.suspendUntil = p.suspendUntil || null;
    p.onboardedAt = p.onboardedAt || null;
  });
});

/* ══════════════ 档案（§四 用户档案表）══════════════ */

export const DEFAULT_PROFILE = {
  id: 'me',
  // 学习档案
  userName: '',            // 1  希望被如何称呼
  supervisorName: '帕尼尼', // 2  希望如何称呼监督员
  topProblems: '',         // 5  当前最困扰的三个问题
  focusAreas: '',          // 6  希望重点监督的事项
  procrastinationPatterns: '', // 7  最容易出现的拖延行为
  learningPreferences: '', // 学习方式与节奏偏好
  availableTime: '',       // 可用于学习的时间
  constraints: '',         // 现实限制与暂时做不了的情况
  rewardPreference: '',    // 8  最有效的奖励方式（可选）
  acceptableCorrections: '', // 9  可接受的提醒/纠偏方式（可选）
  taboos: [],              // 11 不喜欢的表达方式与交互雷区（可选，数组）
  otherNeeds: '',          // 12 其他需求（可选）

  // 监督运行参数
  toneLevel: 5,            // 表达强度 1-5；5 = 完全放开（含冷嘲与粗口）
  allowProfanity: true,    // 粗口总开关
  suspendUntil: null,      // 危机暂停：ISO 时间或 'indefinite'
  onboardedAt: null,       // 初始化完成时间

  // 学习模块沿用
  about: '',
  goals: '',
  updatedAt: null,
};

/** 学习档案的核心信息；其余偏好可后补。 */
export const REQUIRED_PROFILE_KEYS = [
  'about', 'goals', 'focusAreas', 'learningPreferences',
];
export const OPTIONAL_PROFILE_KEYS = [
  'userName', 'topProblems', 'procrastinationPatterns', 'availableTime', 'constraints',
  'rewardPreference', 'acceptableCorrections', 'taboos', 'otherNeeds',
];

/** 档案字段的中文名。提示词、工具回执、界面共用一份，免得各写一遍写岔。 */
export const PROFILE_LABELS = {
  userName: '希望被如何称呼',
  supervisorName: '希望如何称呼监督员',
  topProblems: '学习困难或拖延情境',
  focusAreas: '当前学习重点',
  procrastinationPatterns: '最容易出现的拖延行为',
  rewardPreference: '最有效的奖励方式',
  acceptableCorrections: '可接受的提醒或纠偏方式',
  taboos: '不喜欢的表达方式和交互雷区',
  otherNeeds: '其他需求',
  about: '学习背景与当前情况',
  goals: '学习目标',
  learningPreferences: '学习方式与节奏偏好',
  availableTime: '可用学习时间',
  constraints: '现实限制',
};

export function profileCompletion(p) {
  const filled = k => {
    const v = p?.[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
  };
  const requiredDone = REQUIRED_PROFILE_KEYS.filter(filled);
  const optionalDone = OPTIONAL_PROFILE_KEYS.filter(filled);
  return {
    requiredDone: requiredDone.length,
    requiredTotal: REQUIRED_PROFILE_KEYS.length,
    optionalDone: optionalDone.length,
    optionalTotal: OPTIONAL_PROFILE_KEYS.length,
    missingRequired: REQUIRED_PROFILE_KEYS.filter(k => !filled(k)),
    isOnboarded: REQUIRED_PROFILE_KEYS.every(filled) && Boolean(p?.onboardedAt),
    canStart: REQUIRED_PROFILE_KEYS.every(filled),
  };
}

export async function getProfile() {
  return (await db.profile.get('me')) || { ...DEFAULT_PROFILE };
}

export function notifyPrivateDataChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('msa:private-data-changed'));
}

export async function markPrivateRecordDeleted(type, id) {
  const key = `${type}:${id}`;
  const deletes = await getMeta('privateSyncDeletes', {});
  deletes[key] = nowISO();
  await setMeta('privateSyncDeletes', deletes);
}

async function clearPrivateRecordDeletion(type, id) {
  const key = `${type}:${id}`;
  const deletes = await getMeta('privateSyncDeletes', {});
  if (!(key in deletes)) return;
  delete deletes[key];
  await setMeta('privateSyncDeletes', deletes);
}

export async function saveProfile(patch) {
  const cur = await getProfile();
  const next = { ...cur, ...patch, id: 'me', updatedAt: nowISO() };
  await db.profile.put(next);
  await clearPrivateRecordDeletion('profile', 'me');
  notifyPrivateDataChanged();
  return next;
}

export async function deleteProfile() {
  await markPrivateRecordDeleted('profile', 'me');
  await db.profile.delete('me');
  notifyPrivateDataChanged();
}

/* ══════════════ 任务（§5.2 数据结构）══════════════ */

export const DEFAULT_TASK_FIELDS = {
  category: 'important',
  priority: 'P2',
  area: 'other',
  state: 'INBOX',
  goal: '',
  dueAt: '',
  estimateMin: null,      // 预计耗时（分钟）
  plannedStart: '',       // 计划开始时间
  actualStart: '',        // 实际开始时间
  actualEnd: '',          // 实际结束时间
  actualMin: null,        // 实际耗时（分钟）
  nextAction: '',         // 下一步行动
  blocker: '',            // 当前阻碍
  mood: null,             // 1-5
  attention: null,        // 1-5
  outcome: '',            // 完成情况
  review: '',             // 复盘结论
  progress: 0,
  milestones: [],
  notes: '',
};

export function normalizeTask(input, cur = null) {
  const now = nowISO();
  const t = { ...DEFAULT_TASK_FIELDS, ...(cur || {}) };
  for (const [k, v] of Object.entries(input || {})) {
    if (v !== undefined) t[k] = v;
  }
  t.id = cur?.id || input?.id || uid('task_');
  t.title = String(t.title || '').trim();
  t.state = TASK_STATES[t.state] ? t.state : (cur?.state || 'INBOX');
  t.priority = PRIORITIES[t.priority] ? t.priority : (cur?.priority || 'P2');
  const category = input?.category ?? cur?.category;
  t.category = ['important', 'chore'].includes(category)
    ? category
    : (cur ? (['P0', 'P1'].includes(t.priority) ? 'important' : 'chore') : DEFAULT_TASK_FIELDS.category);
  t.area = AREAS[t.area] ? t.area : (cur?.area || 'other');
  t.createdAt = cur?.createdAt || now;
  t.updatedAt = now;
  if (Array.isArray(t.milestones)) t.milestones = t.milestones.map(String).filter(Boolean);
  return t;
}

export async function listTasks({ state, area, states } = {}) {
  let all = await db.tasks.toArray();
  if (state) all = all.filter(t => t.state === state);
  if (states) all = all.filter(t => states.includes(t.state));
  if (area) all = all.filter(t => t.area === area);
  return sortTasks(all);
}

export function sortTasks(all) {
  return all.slice().sort((a, b) => {
    const ds = TASK_STATE_ORDER.indexOf(a.state) - TASK_STATE_ORDER.indexOf(b.state);
    if (ds) return ds;
    const dp = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
    if (dp) return dp;
    if ((a.dueAt || '') !== (b.dueAt || '')) return (a.dueAt || '9999').localeCompare(b.dueAt || '9999');
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

export async function upsertTask(input) {
  const id = input?.id;
  const cur = id ? await db.tasks.get(id) : null;
  const task = normalizeTask(input, cur);
  if (!task.title) throw new Error('任务名称不能为空');
  await db.tasks.put(task);
  notifyTaskChanged();
  return task;
}

export function notifyTaskChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('msa:tasks-changed'));
}

export async function setTaskState(id, state, extra = {}) {
  const cur = await db.tasks.get(id);
  if (!cur) throw new Error('任务不存在');
  if (!TASK_STATES[state]) throw new Error(`无效状态：${state}（可用：${Object.keys(TASK_STATES).join('/')}）`);
  const now = nowISO();
  const patch = { state, updatedAt: now, ...extra };

  // 开始/结束时间由状态推导，不靠模型记
  if (state === 'DOING' && !cur.actualStart) patch.actualStart = now;
  if ((state === 'DONE' || state === 'CANCELLED') && !cur.actualEnd) patch.actualEnd = now;
  if (state === 'DONE') patch.progress = 100;

  await db.tasks.update(id, patch);
  notifyTaskChanged();
  return db.tasks.get(id);
}

export async function setTaskCompletion(id, completed) {
  const task = await db.tasks.get(id);
  if (!task) throw new Error('任务不存在');
  if (completed) {
    if (task.state === 'DONE') return task;
    await db.tasks.update(id, {
      state: 'DONE', actualEnd: nowISO(), progress: 100,
      completionState: task.state, completionProgress: task.progress ?? 0, updatedAt: nowISO(),
    });
  } else {
    if (task.state !== 'DONE') return task;
    const state = TASK_STATES[task.completionState] ? task.completionState : 'NEXT';
    await db.tasks.update(id, {
      state, actualEnd: '', progress: task.completionProgress ?? 0,
      completionState: null, completionProgress: null, updatedAt: nowISO(),
    });
  }
  notifyTaskChanged();
  return db.tasks.get(id);
}

export async function deleteTask(id) {
  const deleted = await getMeta('deletedTasks', {});
  deleted[id] = nowISO();
  await setMeta('deletedTasks', deleted);
  await db.tasks.delete(id);
  notifyTaskChanged();
}

export async function cleanupOldCompletedTasks({ now = Date.now(), retentionDays = 60 } = {}) {
  const cutoff = now - retentionDays * 86400000;
  const tasks = await db.tasks.toArray();
  const old = tasks.filter(task => ['DONE', 'CANCELLED'].includes(task.state)
    && Date.parse(task.actualEnd || task.updatedAt || task.createdAt || '') < cutoff);
  if (!old.length) return 0;
  const deleted = await getMeta('deletedTasks', {});
  const deletedAt = nowISO();
  for (const task of old) {
    deleted[task.id] = deletedAt;
    await db.tasks.delete(task.id);
  }
  await setMeta('deletedTasks', deleted);
  notifyTaskChanged();
  return old.length;
}

/** 今日关键任务（§5.3：每天原则上只指定 1-3 个）。存在 meta 里，跨天自动失效。 */
export async function getKeyTasks() {
  const rec = await getMeta('keyTasks', null);
  if (!rec || rec.date !== dateStr()) return { date: dateStr(), ids: [] };
  return rec;
}

export async function setKeyTasks(ids) {
  const clean = [...new Set((ids || []).filter(Boolean))].slice(0, 3);
  const rec = { date: dateStr(), ids: clean, updatedAt: nowISO() };
  await setMeta('keyTasks', rec);
  return rec;
}

export async function keyTaskRecords() {
  const { ids } = await getKeyTasks();
  const out = [];
  for (const id of ids) {
    const t = await db.tasks.get(id);
    if (t) out.push(t);
  }
  return out;
}

/* ══════════════ 知识点（学习模块，保留）══════════════ */

export async function listTopics() {
  const all = await db.topics.toArray();
  return all.sort((a, b) => {
    const ad = a.nextReviewAt || '9999';
    const bd = b.nextReviewAt || '9999';
    if (ad !== bd) return ad.localeCompare(bd);
    return a.name.localeCompare(b.name, 'zh');
  });
}

/** 新知识点默认"明天复习一次"——刚学完就标成今天到期会很吵 */
function firstReviewDue() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export async function upsertTopic(input) {
  const now = nowISO();
  const id = input.id || uid('topic_');
  const cur = input.id ? await db.topics.get(id) : null;
  const topic = {
    id,
    name: (input.name ?? cur?.name ?? '').trim(),
    taskId: input.taskId ?? cur?.taskId ?? '',
    note: input.note ?? cur?.note ?? '',
    ease: input.ease ?? cur?.ease ?? 2.5,
    interval: input.interval ?? cur?.interval ?? 0,
    reps: input.reps ?? cur?.reps ?? 0,
    lapses: input.lapses ?? cur?.lapses ?? 0,
    nextReviewAt: input.nextReviewAt ?? cur?.nextReviewAt ?? firstReviewDue(),
    lastReviewedAt: input.lastReviewedAt ?? cur?.lastReviewedAt ?? null,
    mastery: input.mastery ?? cur?.mastery ?? 0,
    createdAt: cur?.createdAt ?? now,
    updatedAt: now,
  };
  if (!topic.name) throw new Error('知识点名称不能为空');
  await db.topics.put(topic);
  return topic;
}

export const deleteTopic = id => db.topics.delete(id);

export async function findOrCreateTopic(name, { taskId = '', note = '' } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('知识点名称不能为空');
  const all = await db.topics.toArray();
  const hit = all.find(t => t.name === clean)
    || all.find(t => t.name.toLowerCase() === clean.toLowerCase());
  if (hit) return hit;
  return upsertTopic({ name: clean, taskId, note });
}

/* ══════════════ 学习日志 ══════════════ */

export async function addLog(entry) {
  const log = {
    id: uid('log_'),
    date: entry.date || dateStr(),
    createdAt: nowISO(),
    topicId: entry.topicId || '',
    topicName: entry.topicName || '',
    taskId: entry.taskId || '',
    minutes: Number(entry.minutes) || 0,
    what: (entry.what || '').trim(),
    blockers: (entry.blockers || '').trim(),
    grade: entry.grade ?? null,
  };
  await db.logs.put(log);
  return log;
}
export const recentLogs = (n = 30) =>
  db.logs.orderBy('createdAt').reverse().limit(n).toArray();

/* ══════════════ 长期记忆 ══════════════ */

export async function addMemory(entry) {
  const mem = {
    id: uid('mem_'),
    kind: entry.kind || 'fact',
    text: (entry.text || '').trim(),
    tags: entry.tags || [],
    taskId: entry.taskId || '',
    importance: entry.importance ?? 3,
    sourceRefs: entry.sourceRefs || [],
    createdAt: nowISO(),
    lastUsedAt: null,
  };
  if (!mem.text) throw new Error('记忆内容不能为空');
  await db.memories.put(mem);
  return mem;
}
export const deleteMemory = id => db.memories.delete(id);

/* ══════════════ 会话 ══════════════ */

export async function ensureSession() {
  const cur = await db.meta.get('currentSession');
  if (cur?.value) {
    const s = await db.sessions.get(cur.value);
    if (s) return s;
  }
  return createSession();
}

export async function createSession(title = '') {
  const now = nowISO();
  const session = {
    id: uid('sess_'),
    title,
    summary: '',
    summarizedUpTo: 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.sessions.put(session);
  await db.meta.put({ key: 'currentSession', value: session.id });
  await clearPrivateRecordDeletion('session', session.id);
  notifyPrivateDataChanged();
  return session;
}

export async function addMessage(msg) {
  const m = {
    id: uid('msg_'),
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content ?? '',
    reasoning: msg.reasoning ?? '',
    toolCalls: msg.toolCalls ?? null,
    toolCallId: msg.toolCallId ?? null,
    toolName: msg.toolName ?? null,
    usage: msg.usage ?? null,
    kind: msg.kind ?? 'chat',   // chat | system_notice
    createdAt: nowISO(),
  };
  await db.messages.put(m);
  await db.sessions.update(m.sessionId, { updatedAt: m.createdAt });
  await clearPrivateRecordDeletion('message', m.id);
  notifyPrivateDataChanged();
  return m;
}

export const sessionMessages = sessionId =>
  db.messages.where('sessionId').equals(sessionId).sortBy('createdAt');

export async function listSessions() {
  const all = await db.sessions.toArray();
  const current = await getMeta('currentSession', null);
  const withCounts = await Promise.all(all.map(async s => ({
    ...s,
    messageCount: await db.messages.where('sessionId').equals(s.id).count(),
    isCurrent: s.id === current,
  })));
  return withCounts
    .filter(s => s.messageCount > 0 || s.isCurrent)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function switchSession(id) {
  const s = await db.sessions.get(id);
  if (!s) throw new Error('会话不存在');
  await setMeta('currentSession', id);
  return s;
}

export async function renameSession(id, title) {
  await db.sessions.update(id, { title: String(title || '').slice(0, 60) });
  notifyPrivateDataChanged();
}

export async function clearSessionMessages(id) {
  const messages = await db.messages.where('sessionId').equals(id).toArray();
  const deletes = await getMeta('privateSyncDeletes', {});
  const deletedAt = nowISO();
  for (const message of messages) deletes[`message:${message.id}`] = deletedAt;
  await setMeta('privateSyncDeletes', deletes);
  await db.messages.where('sessionId').equals(id).delete();
  await db.sessions.update(id, { summary: '', summarizedUpTo: 0, updatedAt: deletedAt });
  notifyPrivateDataChanged();
  return messages.length;
}

export async function deleteAllConversations() {
  const sessions = await db.sessions.toArray();
  const messages = await db.messages.toArray();
  const deletes = await getMeta('privateSyncDeletes', {});
  const deletedAt = nowISO();
  for (const item of sessions) deletes[`session:${item.id}`] = deletedAt;
  for (const item of messages) deletes[`message:${item.id}`] = deletedAt;
  await setMeta('privateSyncDeletes', deletes);
  await db.messages.clear();
  await db.sessions.clear();
  await db.meta.delete('currentSession');
  await createSession();
  notifyPrivateDataChanged();
  return sessions.length;
}

export async function deleteSession(id) {
  const messages = await db.messages.where('sessionId').equals(id).toArray();
  const deletes = await getMeta('privateSyncDeletes', {});
  const deletedAt = nowISO();
  deletes[`session:${id}`] = deletedAt;
  for (const item of messages) deletes[`message:${item.id}`] = deletedAt;
  await setMeta('privateSyncDeletes', deletes);
  await db.messages.where('sessionId').equals(id).delete();
  await db.sessions.delete(id);
  notifyPrivateDataChanged();
  const current = await getMeta('currentSession', null);
  if (current === id) {
    await db.meta.delete('currentSession');
    return createSession();
  }
  return null;
}

/* ══════════════ token 用量 ══════════════ */

export async function addUsage(usage) {
  if (!usage) return;
  const cur = (await db.meta.get('usage'))?.value || { prompt: 0, completion: 0, cached: 0, calls: 0 };
  cur.prompt += usage.prompt_tokens || 0;
  cur.completion += usage.completion_tokens || 0;
  cur.cached += usage.prompt_cache_hit_tokens || 0;
  cur.calls += 1;
  await db.meta.put({ key: 'usage', value: cur });
}

export const getUsage = async () =>
  (await db.meta.get('usage'))?.value || { prompt: 0, completion: 0, cached: 0, calls: 0 };

/* ══════════════ meta ══════════════ */

export async function getMeta(key, fallback = null) {
  return (await db.meta.get(key))?.value ?? fallback;
}
export const setMeta = (key, value) => db.meta.put({ key, value });
export const delMeta = key => db.meta.delete(key);

/* ══════════════ 全量导出 / 导入 ══════════════ */

export const ALL_STORES = [
  'profile', 'tasks', 'topics', 'sessions', 'messages', 'logs', 'memories', 'meta',
  'timeEntries', 'points', 'rewards', 'checkins', 'plans', 'sops', 'reviews',
];

export async function exportAll() {
  const data = { schema: 2, app: 'panini-supervisor', exportedAt: nowISO(), stores: {} };
  for (const name of ALL_STORES) {
    data.stores[name] = await db.table(name).toArray();
  }
  return data;
}

export async function importAll(data, { mode = 'merge' } = {}) {
  if (!data?.stores) throw new Error('文件格式不对：缺少 stores 字段');
  for (const name of ALL_STORES) {
    const rows = data.stores[name];
    if (!Array.isArray(rows)) continue;
    const table = db.table(name);
    if (mode === 'replace') await table.clear();
    await table.bulkPut(rows);
  }
}

/** 让镜像文件看起来像人写的，而不是一行巨型 JSON */
export function prettyExport(data) {
  return JSON.stringify(data, null, 2);
}

/* ══════════════ 清空全部（危险操作）══════════════ */

export async function wipeEverything() {
  for (const name of ALL_STORES) {
    if (name === 'meta') continue;
    await db.table(name).clear();
  }
  await db.meta.clear();
}
