import { esc, icon, toast } from './ui.js';
import { dateStr } from './util.js';
import { pruneMicroHabitHistory } from './microhabit.js';

const LOCAL_PREFIX = 'msa.daily-review.v1:';
const QUEUE_KEY = 'msa.daily-review-sync.v1';
const MICRO_HABIT_KEY = 'micro-habit-local-state-v1';
const FIELDS = ['events', 'review', 'positive'];
const LABELS = { events: '事件', review: '改进', positive: '肯定' };
let client = null;
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
const blank = date => ({ date, events: '', review: '', positive: '' });

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
  if (client) return client;
  const config = window.APP_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) return null;
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  return client;
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
  await syncReviewHistory();
  await syncMicroHabitState();
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
    await syncReviewHistory();
    await syncMicroHabitState();
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
  const safePatch = Object.fromEntries(FIELDS.map(key => [key, String(patch[key] ?? '')]));
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

export async function renderDailyReview(root) {
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
  const patch = Object.fromEntries(Array.from(root.querySelectorAll('[data-review-field]'), field => [field.dataset.reviewField, field.value]));
  saveDailyReview(selectedDate, patch);
  const status = root.querySelector('[data-review-save-state]');
  if (status) status.textContent = session ? '已保存 · 正在同步' : '已保存在本机';
  if (session) {
    await flushQueue();
    if (status?.isConnected) status.textContent = Object.keys(readQueue()).length ? '已保存 · 等待同步' : '已保存并同步';
  }
}

export { loadDailyReview as getDailyReview };
