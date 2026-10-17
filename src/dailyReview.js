import { esc, icon, toast } from './ui.js';
import { dateStr } from './util.js';
import { changeMicroHabit, pruneMicroHabitHistory } from './microhabit.js';
import { upsertTask } from './db.js';
import { getSupabaseClient } from './supabase.js';

const LOCAL_PREFIX = 'msa.daily-review.v1:';
const QUEUE_KEY = 'msa.daily-review-sync.v1';
const MICRO_HABIT_KEY = 'micro-habit-local-state-v1';
const FIELDS = [
  'events', 'review', 'positive', 'category', 'mistake', 'trigger',
  'countermeasure', 'verification', 'countermeasureType', 'countermeasureAddedAt', 'countermeasureRef', 'mistakeKey',
];
const REVIEW_CATEGORIES = [
  ['study', '学习'], ['routine', '生活作息'], ['work', '工作'], ['relationship', '人际'], ['other', '其他'],
];
const VERIFICATION_OPTIONS = [
  ['effective', '已执行，并且有效'], ['ineffective', '已执行，但没有效果'],
  ['missed', '没执行'], ['not_applicable', '不适用'],
];
const REVIEW_LABELS = {
  events: '事件', review: '改进', positive: '肯定', category: '分类',
  mistake: '今天最想避免重复的错误', trigger: '触发条件', countermeasure: '明天的防错动作',
};
const LABELS = { events: '事件', review: '改进', positive: '肯定' };
let session = null;
let changeHandler = null;
let flushPromise = null;
let microHabitSyncPromise = null;
let microHabitListenerReady = false;
let microHabitSyncError = '';
let reviewSyncError = '';

async function syncReviewHistory() {
  if (!session) return;
  try {
    const { data, error } = await getClient().from('user_donelist_entries')
      .select('entry_date,content').eq('user_id', session.user.id);
    if (error) throw error;
    reviewSyncError = '';
    const cloudDates = new Set((data || []).map(row => row.entry_date));
    const queue = readQueue();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const date = key?.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length)
        : key?.startsWith('donelist-') ? key.slice('donelist-'.length) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cloudDates.has(date) || queue[date]) continue;
      const entry = readLocal(date);
      if (FIELDS.some(field => entry[field]?.trim())) {
        queue[date] = Object.fromEntries(FIELDS.map(field => [field, String(entry[field] || '')]));
      }
    }
    writeQueue(queue);
    for (const row of data || []) {
      if (!queue[row.entry_date]) localStorage.setItem(localKey(row.entry_date), JSON.stringify({ ...blank(row.entry_date), ...row.content }));
    }
    await flushQueue();
  } catch (error) {
    reviewSyncError = error.message || String(error);
  }
}

const localKey = date => `${LOCAL_PREFIX}${date}`;
const monthKey = date => date.slice(0, 7);
const blank = date => ({
  date, events: '', review: '', positive: '', category: 'study', mistake: '', trigger: '',
  countermeasure: '', verification: '', countermeasureType: 'task', countermeasureAddedAt: '', countermeasureRef: '', mistakeKey: '',
});

function readLocal(date) {
  try {
    const value = JSON.parse(localStorage.getItem(localKey(date)) || 'null');
    const websiteValue = JSON.parse(localStorage.getItem(`donelist-${date}`) || 'null');
    const websiteEntry = websiteValue && typeof websiteValue === 'object' ? websiteValue : {};
    return { ...blank(date), ...websiteEntry, ...(value && typeof value === 'object' ? value : {}) };
  } catch {
    return blank(date);
  }
}

function readQueue() {
  try {
    const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeQueue(queue) {
  if (Object.keys(queue).length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  else localStorage.removeItem(QUEUE_KEY);
}

function getClient() {
  return getSupabaseClient();
}

async function loadSession() {
  const supabase = getClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  microHabitSyncError = '';
  session = data.session;
  return session;
}

function localMicroHabitState() {
  try {
    const value = JSON.parse(localStorage.getItem(MICRO_HABIT_KEY) || '{}');
    return {
      habits: Array.isArray(value.habits) ? value.habits : [],
      completions: value.completions && typeof value.completions === 'object' ? value.completions : {},
    };
  } catch {
    return { habits: [], completions: {} };
  }
}

async function saveMicroHabitStateToCloud(state = localMicroHabitState()) {
  if (!session) return;
  const { error } = await getClient().from('user_micro_habit_states').upsert({
    user_id: session.user.id,
    state: { habits: state.habits || [], completions: state.completions || {} },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function syncMicroHabitState() {
  if (!session) return;
  if (microHabitSyncPromise) return microHabitSyncPromise;
  microHabitSyncPromise = (async () => {
    const supabase = getClient();
    const { data, error } = await supabase.from('user_micro_habit_states')
      .select('state').eq('user_id', session.user.id).maybeSingle();
    if (error) throw error;
    microHabitSyncError = '';
    if (data?.state && typeof data.state === 'object') {
      const local = (() => {
        try { return JSON.parse(localStorage.getItem(MICRO_HABIT_KEY) || '{}'); }
        catch { return {}; }
      })();
      localStorage.setItem(MICRO_HABIT_KEY, JSON.stringify({
        ...local,
        habits: Array.isArray(data.state.habits) ? data.state.habits : [],
        completions: data.state.completions && typeof data.state.completions === 'object'
          ? data.state.completions : {},
      }));
    } else {
      const local = localMicroHabitState();
      if (local.habits.length || Object.keys(local.completions).length) {
        await saveMicroHabitStateToCloud(local);
      }
    }
    pruneMicroHabitHistory();
  })().catch(error => {
    microHabitSyncError = error.message || String(error);
    console.warn('[micro-habit-sync]', error);
  }).finally(() => { microHabitSyncPromise = null; });
  return microHabitSyncPromise;
}

export async function initDailyReviewSync(onChange) {
  changeHandler = onChange || null;
  const supabase = getClient();
  if (!supabase) return getDailyReviewSyncStatus();
  if (!microHabitListenerReady && typeof window !== 'undefined') {
    window.addEventListener('msa:micro-habits-changed', event => {
      if (session) void saveMicroHabitStateToCloud(event.detail).catch(error => {
        microHabitSyncError = error.message || String(error);
        console.warn('[micro-habit-sync]', error);
        changeHandler?.();
      });
    });
    microHabitListenerReady = true;
  }
  try {
    await loadSession();
    supabase.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession;
      if (session) {
        setTimeout(() => {
          void Promise.all([syncReviewHistory(), syncMicroHabitState()]).finally(() => changeHandler?.());
        }, 0);
      } else changeHandler?.();
    });
    if (session) {
      await syncReviewHistory();
      await syncMicroHabitState();
    }
  } catch (error) {
    console.warn('[daily-review-sync]', error);
  }
  return getDailyReviewSyncStatus();
}

export function getDailyReviewSyncStatus() {
  if (!getClient()) return { connected: false, email: '', message: '未配置 Supabase，当前保存在本机' };
  if (!session) return { connected: false, email: '', message: '登录后同步到 Website 和其他设备' };
  const waiting = Object.keys(readQueue()).length;
  return {
    connected: true,
    email: session.user?.email || '',
    message: reviewSyncError ? `复盘同步失败：${reviewSyncError}` : microHabitSyncError
      ? `微习惯同步失败，请执行 supabase/micro-habits.sql：${microHabitSyncError}`
      : waiting ? `已登录 · ${waiting} 条等待同步` : '每日复盘与微习惯已连接 Supabase',
  };
}

export async function signInDailyReview(email, password) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase 配置或 SDK 尚未加载');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  session = data.session;
  changeHandler?.();
  return getDailyReviewSyncStatus();
}

export async function signUpDailyReview(email, password) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase 配置或 SDK 尚未加载');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  session = data.session;
  if (session) {
    void Promise.all([syncReviewHistory(), syncMicroHabitState()]).finally(() => changeHandler?.());
  }
  changeHandler?.();
  return { ...getDailyReviewSyncStatus(), needsConfirmation: !session };
}

export async function signOutDailyReview() {
  const supabase = getClient();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  session = null;
  changeHandler?.();
}

export async function loadDailyReview(date) {
  const local = readLocal(date);
  const queued = readQueue()[date];
  if (queued) return { ...local, ...queued };
  if (!session) return local;
  try {
    const { data, error } = await getClient().from('user_donelist_entries')
      .select('content').eq('user_id', session.user.id).eq('entry_date', date).maybeSingle();
    if (error) throw error;
    if (!data?.content || typeof data.content !== 'object') return local;
    const merged = { ...local, ...data.content, date };
    localStorage.setItem(localKey(date), JSON.stringify(merged));
    return merged;
  } catch (error) {
    console.warn('[daily-review-load]', error);
    return local;
  }
}

async function flushQueue() {
  if (flushPromise || !session) return flushPromise;
  flushPromise = (async () => {
    const supabase = getClient();
    const queue = readQueue();
    for (const [date, patch] of Object.entries(queue).sort(([a], [b]) => a.localeCompare(b))) {
      const { data, error: readError } = await supabase.from('user_donelist_entries')
        .select('content').eq('user_id', session.user.id).eq('entry_date', date).maybeSingle();
      if (readError) throw readError;
      const content = { ...(data?.content || {}), ...patch, date };
      const { error } = await supabase.from('user_donelist_entries').upsert({
        user_id: session.user.id,
        entry_date: date,
        content,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,entry_date' });
      if (error) throw error;
      reviewSyncError = '';
      const latest = readQueue();
      if (JSON.stringify(latest[date]) === JSON.stringify(patch)) {
        delete latest[date];
        writeQueue(latest);
      }
    }
  })().catch(error => {
    reviewSyncError = error.message || String(error);
    console.warn('[daily-review-sync]', error);
  }).finally(() => { flushPromise = null; });
  return flushPromise;
}

export function saveDailyReview(date, patch) {
  const safePatch = Object.fromEntries(FIELDS
    .filter(key => Object.prototype.hasOwnProperty.call(patch || {}, key))
    .map(key => [key, String(patch[key] ?? '')]));
  const next = { ...readLocal(date), ...safePatch, date };
  localStorage.setItem(localKey(date), JSON.stringify(next));
  const queue = readQueue();
  queue[date] = { ...(queue[date] || {}), ...safePatch };
  writeQueue(queue);
  if (session) void flushQueue();
  return next;
}

export async function listDailyReviewDates(month) {
  const dates = new Set();
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const entry = readLocal(date);
    if (FIELDS.some(key => String(entry[key] || '').trim()) || readQueue()[date]) dates.add(date);
  }
  if (session) {
    const first = `${month}-01`;
    const last = `${month}-${String(days).padStart(2, '0')}`;
    try {
      const { data, error } = await getClient().from('user_donelist_entries')
        .select('entry_date,content').eq('user_id', session.user.id).gte('entry_date', first).lte('entry_date', last);
      if (error) throw error;
      for (const row of data || []) {
        const content = row.content || {};
        if (FIELDS.some(key => String(content[key] || '').trim())) dates.add(row.entry_date);
        localStorage.setItem(localKey(row.entry_date), JSON.stringify({ ...blank(row.entry_date), ...content, date: row.entry_date }));
      }
    } catch (error) {
      console.warn('[daily-review-calendar]', error);
    }
  }
  return dates;
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const value = new Date(year, monthNumber - 1 + offset, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

let selectedDate = dateStr();
let renderToken = 0;
let saveTimer = null;

function categoryLabel(value) {
  return REVIEW_CATEGORIES.find(([key]) => key === value)?.[1] || '其他';
}

function dateOffset(value, amount) {
  const d = new Date(`${value}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entryForDate(date) {
  return { ...readLocal(date), ...(readQueue()[date] || {}), date };
}

function reviewHistory(entries) {
  return entries.filter(item => String(item.mistake || '').trim());
}

function categoryCards(entries) {
  const grouped = new Map(REVIEW_CATEGORIES.map(([key, label]) => [key, []]));
  entries.forEach(entry => grouped.get(entry.category || 'other')?.push(entry));
  return REVIEW_CATEGORIES.map(([key, label]) => {
    const items = grouped.get(key) || [];
    const latest = items.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    return `<article class="review-category-card ${items.length ? 'has-entry' : ''}">
      <div class="review-category-card-head"><strong>${label}</strong><span>${items.length} 条</span></div>
      ${latest ? `<small>${esc(latest.date)} · ${esc(latest.mistake || '未写重复错误')}</small><p>${esc(latest.countermeasure || '还没有防错动作')}</p>` : '<p class="review-muted">还没有记录</p>'}
    </article>`;
  }).join('');
}

function repeatCards(entries) {
  const groups = new Map();
  entries.forEach(entry => {
    const key = entry.mistakeKey || String(entry.mistake || '').trim().toLowerCase();
    if (!key) return;
    const item = groups.get(key) || { title: entry.mistake, count: 0, latest: entry.date, action: entry.countermeasure };
    item.count += 1;
    if (entry.date >= item.latest) { item.latest = entry.date; item.action = entry.countermeasure; }
    groups.set(key, item);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latest.localeCompare(a.latest)).slice(0, 5)
    .map(item => `<article class="review-repeat-card"><strong>${esc(item.title)}</strong><span>出现 ${item.count} 次 · 最近 ${esc(item.latest)}</span><small>${item.count >= 3 ? '需要升级' : `当前方案：${item.action ? esc(item.action) : '待生成'}`}</small></article>`).join('');
}

function verificationOptions(entry) {
  return VERIFICATION_OPTIONS.map(([value, label]) => `<label class="review-verification-option"><input type="radio" name="review-verification" value="${value}" ${entry.verification === value ? 'checked' : ''}><span>${label}</span></label>`).join('');
}

async function addCountermeasure(entry) {
  const action = String(entry.countermeasure || '').trim();
  if (!action) return;
  const tomorrow = dateOffset(entry.date, 1);
  const category = entry.category === 'study' ? 'study' : 'other';
  let target;
  if (entry.countermeasureType === 'microhabit') {
    target = changeMicroHabit({ action: 'add', title: action });
  } else {
    target = await upsertTask({
      title: action,
      category: 'important',
      area: category,
      dueAt: tomorrow,
      estimateMin: 5,
      notes: `来自 ${entry.date} 复盘 · 防错动作`,
    });
  }
  saveDailyReview(entry.date, { countermeasureAddedAt: new Date().toISOString(), countermeasureRef: target?.id || '' });
  toast(entry.countermeasureType === 'microhabit' ? '已加入微习惯' : '已加入明天任务', 'ok');
}

export async function renderDailyReview(root) {
  const token = ++renderToken;
  const date = selectedDate;
  const month = monthKey(date);
  const [entry, days] = await Promise.all([loadDailyReview(date), listDailyReviewDates(month)]);
  if (token !== renderToken) return;
  const history = reviewHistory([...days].map(entryForDate));
  const effective = history.filter(item => item.verification === 'effective').slice().sort((a, b) => b.date.localeCompare(a.date));
  const sameMistakes = entry.mistakeKey
    ? history.filter(item => item.mistakeKey === entry.mistakeKey)
    : history.filter(item => String(item.mistake || '').trim() === String(entry.mistake || '').trim());
  const previous = await loadDailyReview(dateOffset(date, -1));
  const awaitingVerification = previous.countermeasure && !previous.verification && previous.date !== date;
  const [year, monthNumber] = month.split('-').map(Number);
  const weekDates = Array.from({ length: 7 }, (_, index) => dateOffset(date, index - 2));
  const dateSet = new Set(days);
  for (const dayDate of weekDates) {
    const dayEntry = entryForDate(dayDate);
    if (FIELDS.some(key => String(dayEntry[key] || '').trim())) dateSet.add(dayDate);
  }
  const cells = weekDates.map(value => {
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${value}T12:00:00`).getDay()];
    const selected = value === date;
    return `<button type="button" class="review-calendar-day review-week-day ${selected ? 'is-selected' : ''} ${dateSet.has(value) ? 'has-entry' : ''}" data-review-date="${value}" aria-current="${selected ? 'date' : 'false'}"><span>${value === dateStr() ? '今天' : `周${weekday}`}</span><strong>${Number(value.slice(-2))}</strong><i></i></button>`;
  }).join('');
  const sync = getDailyReviewSyncStatus();
  const categorySelect = REVIEW_CATEGORIES.map(([key, label]) => `<option value="${key}" ${entry.category === key ? 'selected' : ''}>${label}</option>`).join('');
  const typeSelect = `<option value="task" ${entry.countermeasureType !== 'microhabit' ? 'selected' : ''}>明天任务</option><option value="microhabit" ${entry.countermeasureType === 'microhabit' ? 'selected' : ''}>临时微习惯</option>`;
  root.innerHTML = `<section class="daily-review-workspace review-loop-workspace" data-daily-review>
    <div class="daily-review-main">
      <header class="daily-review-heading"><div><span class="habit-kicker">DAILY REVIEW</span><h3>${date === dateStr() ? '今日复盘' : '每日复盘'}</h3><p>${esc(date)}</p></div><span class="review-sync-status" data-review-sync>${esc(sync.message)}</span></header>
      <div class="review-loop-note">每天只处理一个最重要的重复错误，把复盘变成明天能执行的一个动作。</div>
      <div class="review-loop-fields">
        <label class="daily-review-field"><span>分类</span><select data-review-loop-field="category">${categorySelect}</select></label>
        <label class="daily-review-field review-wide-field"><span>今天最想避免重复的错误</span><textarea rows="2" data-review-loop-field="mistake" placeholder="例如：明知道要做，却一直拖到晚上">${esc(entry.mistake || '')}</textarea></label>
        <label class="daily-review-field"><span>触发条件</span><textarea rows="2" data-review-loop-field="trigger" placeholder="错误发生前发生了什么？">${esc(entry.trigger || '')}</textarea></label>
        <label class="daily-review-field review-wide-field"><span>明天的防错动作</span><textarea rows="2" data-review-loop-field="countermeasure" placeholder="具体到动作和时间，能在明天判断是否执行">${esc(entry.countermeasure || '')}</textarea></label>
      </div>
      <div class="review-countermeasure-line"><label>加入方式<select data-review-loop-field="countermeasureType">${typeSelect}</select></label><button type="button" class="primary" data-add-countermeasure ${entry.countermeasureAddedAt ? 'disabled' : ''}>${entry.countermeasureAddedAt ? '已加入明天' : '确认加入明天'}</button><span class="hint">任务页面只显示当天需要执行的动作</span></div>
      ${sameMistakes.length >= 3 ? `<div class="review-escalation"><strong>这个问题已出现 ${sameMistakes.length} 次，需要升级处理。</strong><span>重新定义问题，检查环境和任务安排，必要时增加外部限制或寻求现实中的帮助。</span></div>` : ''}
      ${awaitingVerification ? `<section class="review-verification"><div><strong>昨天的防错规则</strong><p>${esc(previous.countermeasure)}</p></div><div class="review-verification-options">${verificationOptions(previous)}</div><small>已执行且有效会保留；无效则修改规则，没执行则降低动作门槛。</small></section>` : ''}
      <details class="review-more-fields"><summary>补充今天的记录</summary><div class="daily-review-fields">${['events', 'review', 'positive'].map(key => `<label class="daily-review-field"><span>${key === 'events' ? '事件' : key === 'review' ? '改进' : '肯定'}</span><textarea rows="3" data-review-field="${key}" placeholder="${key === 'events' ? '今天发生了什么？' : key === 'review' ? '下次可以怎样调整？' : '今天哪些地方值得肯定？'}">${esc(entry[key] || '')}</textarea></label>`).join('')}</div></details>
      <div class="daily-review-save-line"><span data-review-save-state>自动保存</span><button type="button" class="ghost" data-review-copy>复制复盘</button></div>
    </div>
    <aside class="daily-review-calendar" aria-label="复盘日历">
      <div class="review-calendar-head"><button type="button" data-review-month="-1" aria-label="上个月">${icon('chevron-left')}</button><strong>${year}年${monthNumber}月</strong><button type="button" data-review-month="1" aria-label="下个月">${icon('chevron-right')}</button></div>
      <div class="review-week-strip">${cells}</div><button type="button" class="review-calendar-today" data-review-today>回到今天</button>
      <section class="review-category-summary"><h4>分类查看</h4><div class="review-category-grid">${categoryCards(history)}</div></section>
      <section class="review-category-summary"><h4>重复问题</h4><div class="review-repeat-grid">${repeatCards(history) || '<p class="review-muted">还没有重复问题记录</p>'}</div></section>
      <section class="review-category-summary"><h4>有效方案</h4><div class="review-repeat-grid">${effective.length ? effective.slice(0, 5).map(item => `<article class="review-repeat-card"><strong>${esc(item.countermeasure)}</strong><span>${categoryLabel(item.category)} · ${esc(item.date)}</span></article>`).join('') : '<p class="review-muted">完成次日验证后会沉淀在这里</p>'}</div></section>
    </aside>
  </section>`;
  root.querySelector('[data-add-countermeasure]')?.addEventListener('click', async () => {
    await saveVisibleReview(root);
    await addCountermeasure(entryForDate(date));
    await renderDailyReview(root);
  });
  root.querySelectorAll('[data-review-verification]').forEach(node => node.addEventListener('change', () => {}));
  root.querySelectorAll('.review-verification-option input').forEach(node => node.addEventListener('change', () => {
    saveDailyReview(previous.date, { verification: node.value });
    toast('已记录昨天的验证结果', 'ok');
  }));
  root.querySelector('[data-review-copy]')?.addEventListener('click', async () => {
    const sections = ['events', 'review', 'positive', 'mistake', 'trigger', 'countermeasure'].map(key => {
      const field = root.querySelector(`[data-review-field="${key}"], [data-review-loop-field="${key}"]`);
      const value = field?.value?.trim();
      return value && REVIEW_LABELS[key] ? `${REVIEW_LABELS[key]}\n${value}` : '';
    }).filter(Boolean);
    try { await navigator.clipboard.writeText([`#${date.replaceAll('-', '/')}/日记`, ...sections].join('\n\n')); toast('复盘已复制'); }
    catch { toast('复制失败，请检查浏览器剪贴板权限', 'err'); }
  });
  root.querySelectorAll('[data-review-date]').forEach(button => button.addEventListener('click', async () => {
    await saveVisibleReview(root); selectedDate = button.dataset.reviewDate; await renderDailyReview(root);
  }));
  root.querySelectorAll('[data-review-month]').forEach(button => button.addEventListener('click', async () => {
    await saveVisibleReview(root); const nextMonth = shiftMonth(selectedDate.slice(0, 7), Number(button.dataset.reviewMonth));
    const [nextYear, nextMonthNumber] = nextMonth.split('-').map(Number);
    selectedDate = `${nextMonth}-${String(Math.min(Number(selectedDate.slice(-2)), new Date(nextYear, nextMonthNumber, 0).getDate())).padStart(2, '0')}`;
    await renderDailyReview(root);
  }));
  root.querySelector('[data-review-today]')?.addEventListener('click', async () => { await saveVisibleReview(root); selectedDate = dateStr(); await renderDailyReview(root); });
  root.querySelectorAll('[data-review-field], [data-review-loop-field]').forEach(field => field.addEventListener('input', () => {
    const status = root.querySelector('[data-review-save-state]'); if (status) status.textContent = '正在保存…';
    clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveVisibleReview(root); }, 650);
  }));
  root.querySelectorAll('[data-review-field], [data-review-loop-field]').forEach(field => field.addEventListener('change', () => { void saveVisibleReview(root); }));
  root.querySelectorAll('[data-review-field], [data-review-loop-field]').forEach(field => field.addEventListener('blur', () => { if (saveTimer) void saveVisibleReview(root); }));
}

async function renderLegacyDailyReview(root) {
  const token = ++renderToken;
  const date = selectedDate;
  const month = monthKey(date);
  const [entry, days] = await Promise.all([loadDailyReview(date), listDailyReviewDates(month)]);
  if (token !== renderToken) return;
  const [year, monthNumber] = month.split('-').map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const dayCount = new Date(year, monthNumber, 0).getDate();
  const cells = Array.from({ length: Math.ceil((firstWeekday + dayCount) / 7) * 7 }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > dayCount) return '<span class="review-calendar-empty"></span>';
    const value = `${month}-${String(day).padStart(2, '0')}`;
    return `<button type="button" class="review-calendar-day ${value === date ? 'is-selected' : ''} ${days.has(value) ? 'has-entry' : ''}" data-review-date="${value}" aria-label="${year}年${monthNumber}月${day}日${days.has(value) ? '，有复盘' : ''}">${day}<i></i></button>`;
  }).join('');
  const sync = getDailyReviewSyncStatus();
  root.innerHTML = `<section class="daily-review-workspace" data-daily-review>
    <div class="daily-review-main">
      <header class="daily-review-heading"><div><span class="habit-kicker">DAILY REVIEW</span><h3>${date === dateStr() ? '今日复盘' : '每日复盘'}</h3><p>${date.replaceAll('-', '年').replace(/年(\d{2})$/, '月$1日')}</p></div><span class="review-sync-status" data-review-sync>${esc(sync.message)}</span></header>
      <div class="daily-review-fields">${FIELDS.map(key => `<label class="daily-review-field"><span>${LABELS[key]}</span><textarea rows="5" data-review-field="${key}" placeholder="${key === 'events' ? '今天发生了什么？' : key === 'review' ? '下次可以怎样调整？' : '今天哪些地方值得肯定？'}">${esc(entry[key] || '')}</textarea></label>`).join('')}</div>
      <div class="daily-review-save-line"><span data-review-save-state>自动保存</span><button type="button" class="ghost" data-review-copy>复制复盘</button></div>
    </div>
    <aside class="daily-review-calendar" aria-label="复盘日历">
      <div class="review-calendar-head"><button type="button" data-review-month="-1" aria-label="上个月">${icon('chevron-left')}</button><strong>${year}年${monthNumber}月</strong><button type="button" data-review-month="1" aria-label="下个月">${icon('chevron-right')}</button></div>
      <div class="review-calendar-grid review-calendar-weekdays">${['日','一','二','三','四','五','六'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="review-calendar-grid">${cells}</div>
      <button type="button" class="review-calendar-today" data-review-today>回到今天</button>
    </aside>
  </section>`;
  root.querySelector('[data-review-copy]').addEventListener('click', async () => {
    const sections = FIELDS.map(key => {
      const value = root.querySelector(`[data-review-field="${key}"]`).value.trim();
      return value ? `${LABELS[key]}\n${value}` : '';
    }).filter(Boolean);
    const text = [`#${date.replaceAll('-', '/')}/日记`, ...sections].join('\n\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement('textarea');
        field.value = text;
        field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.append(field);
        const focused = document.activeElement;
        try {
          field.select();
          if (!document.execCommand('copy')) throw new Error('copy failed');
        } finally {
          field.remove();
          focused?.focus();
        }
      }
      toast('复盘已复制');
    } catch {
      toast('复制失败，请允许网页访问剪贴板后重试', 'err');
    }
  });
  root.querySelectorAll('[data-review-date]').forEach(button => button.addEventListener('click', async () => {
    await saveVisibleReview(root, { immediate: true });
    selectedDate = button.dataset.reviewDate;
    await renderDailyReview(root);
  }));
  root.querySelectorAll('[data-review-month]').forEach(button => button.addEventListener('click', async () => {
    await saveVisibleReview(root, { immediate: true });
    const base = selectedDate.slice(0, 7);
    const nextMonth = shiftMonth(base, Number(button.dataset.reviewMonth));
    const [nextYear, nextMonthNumber] = nextMonth.split('-').map(Number);
    const day = Math.min(Number(selectedDate.slice(-2)), new Date(nextYear, nextMonthNumber, 0).getDate());
    selectedDate = `${nextMonth}-${String(day).padStart(2, '0')}`;
    await renderDailyReview(root);
  }));
  root.querySelector('[data-review-today]')?.addEventListener('click', async () => {
    await saveVisibleReview(root, { immediate: true });
    selectedDate = dateStr();
    await renderDailyReview(root);
  });
  root.querySelectorAll('[data-review-field]').forEach(field => field.addEventListener('input', () => {
    const status = root.querySelector('[data-review-save-state]');
    status.textContent = '正在保存…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveVisibleReview(root); }, 650);
  }));
  root.querySelectorAll('[data-review-field]').forEach(field => field.addEventListener('blur', () => {
    if (saveTimer) void saveVisibleReview(root);
  }));
}

async function saveVisibleReview(root) {
  if (!root.querySelector('[data-daily-review]')) return;
  clearTimeout(saveTimer);
  const previous = entryForDate(selectedDate);
  const fields = [...root.querySelectorAll('[data-review-field], [data-review-loop-field]')];
  const patch = Object.fromEntries(fields.map(field => [field.dataset.reviewField || field.dataset.reviewLoopField, field.value]));
  for (const key of ['category', 'countermeasureType', 'mistake', 'trigger', 'countermeasure']) {
    const value = String(patch[key] || '');
    const defaultValue = key === 'category' ? 'study' : key === 'countermeasureType' ? 'task' : '';
    if (value === defaultValue && String(previous[key] || defaultValue) === defaultValue) delete patch[key];
  }
  if (patch.mistake) patch.mistakeKey = patch.mistake.trim().toLowerCase();
  saveDailyReview(selectedDate, patch);
  const status = root.querySelector('[data-review-save-state]');
  if (status) status.textContent = session ? '已保存 · 正在同步' : '已保存在本机';
  if (session) {
    await flushQueue();
    if (status?.isConnected) status.textContent = Object.keys(readQueue()).length ? '已保存 · 等待同步' : '已保存并同步';
  }
}

export { loadDailyReview as getDailyReview };
