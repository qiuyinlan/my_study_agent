import { esc, icon } from './ui.js';

const STATE_KEY = 'micro-habit-local-state-v1';
const DONELIST_KEY = 'micro-habit-donelist-v2';

const today = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function uid(prefix = 'habit') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function loadMicroHabitState() {
  const raw = readJson(STATE_KEY, {});
  return {
    habits: Array.isArray(raw.habits) ? raw.habits.filter(Boolean).map((h, i) => ({
      id: h.id || uid(),
      title: String(h.title || h.name || '').trim(),
      active: h.active !== false,
      order: Number.isFinite(h.order) ? h.order : i,
    })).filter(h => h.title) : [],
    completions: raw.completions && typeof raw.completions === 'object' ? raw.completions : {},
    mainlines: Array.isArray(raw.mainlines) ? raw.mainlines : [],
    principles: Array.isArray(raw.principles) ? raw.principles : [],
    interests: Array.isArray(raw.interests) ? raw.interests : [],
    scoreRules: Array.isArray(raw.scoreRules) ? raw.scoreRules : [],
  };
}

export function listMicroHabits() {
  const state = loadMicroHabitState();
  return state.habits.slice().sort((a, b) => a.order - b.order);
}

export function changeMicroHabit({ action, id = '', title = '', active = true, date = today() }) {
  const state = loadMicroHabitState();
  const name = String(title || '').trim();
  const targetId = String(id || '').trim();
  if (action === 'add') {
    if (!name) throw new Error('新增微习惯需要 title');
    const habit = { id: uid(), title: name, active: true, order: state.habits.length };
    state.habits.push(habit);
    saveMicroHabitState(state);
    return habit;
  }
  const habit = state.habits.find(item => item.id === targetId || (name && item.title === name));
  if (!habit) throw new Error(`找不到微习惯「${targetId || name}」`);
  if (action === 'update') {
    if (!name) throw new Error('修改微习惯需要 title');
    habit.title = name;
  } else if (action === 'complete' || action === 'uncomplete') {
    const completed = new Set(Array.isArray(state.completions[date]) ? state.completions[date] : []);
    if (action === 'complete') completed.add(habit.id);
    else completed.delete(habit.id);
    state.completions[date] = [...completed];
  } else if (action === 'activate' || action === 'deactivate') {
    habit.active = action === 'activate';
  } else if (action === 'delete') {
    state.habits = state.habits.filter(item => item.id !== habit.id);
    for (const [day, ids] of Object.entries(state.completions)) {
      if (Array.isArray(ids)) state.completions[day] = ids.filter(itemId => itemId !== habit.id);
    }
  } else {
    throw new Error(`不支持的微习惯操作：${action}`);
  }
  saveMicroHabitState(state);
  return habit;
}

function saveMicroHabitState(state) {
  const next = {
    ...state,
    mainline: state.mainlines?.[0]?.title || '',
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(next));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('msa:micro-habits-changed', {
      detail: { habits: next.habits, completions: next.completions },
    }));
  }
}

function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function pruneMicroHabitHistory({ now = Date.now(), retentionDays = 60 } = {}) {
  const state = loadMicroHabitState();
  const cutoff = localDate(new Date(now - retentionDays * 86400000));
  const before = Object.keys(state.completions).length;
  const completions = Object.fromEntries(Object.entries(state.completions)
    .filter(([date]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= cutoff));
  const removed = before - Object.keys(completions).length;
  if (removed) saveMicroHabitState({ ...state, completions });
  return removed;
}

export function getTodayHabitSnapshot() {
  const state = loadMicroHabitState();
  const active = state.habits.filter(h => h.active !== false).sort((a, b) => a.order - b.order);
  const doneIds = new Set(Array.isArray(state.completions[today()]) ? state.completions[today()] : []);
  return { active, doneIds, done: active.filter(h => doneIds.has(h.id)) };
}

export function loadDailyEntry(date = today()) {
  const raw = readJson(`donelist-${date}`, null) || (date === today() ? readJson(DONELIST_KEY, null) : null);
  return {
    date,
    freeform: '', diet: '', events: '', positive: '', morning: '', afternoon: '', evening: '',
    gratitude: '', selfPraise: '', review: '', body: '', emotion: '', emotionKit: '', vent: '',
    tomorrowPlan: '', frogs: [], scoreEntries: [],
    moodRating: '', sleptEarly: false,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
}

export function saveDailyEntry(entry, date = today()) {
  const next = { ...loadDailyEntry(date), ...entry, date };
  localStorage.setItem(`donelist-${date}`, JSON.stringify(next));
  if (date === today()) localStorage.setItem(DONELIST_KEY, JSON.stringify(next));
  return next;
}

function scoreTotal(entry) {
  return (Array.isArray(entry.scoreEntries) ? entry.scoreEntries : [])
    .reduce((sum, item) => sum + (Number(item?.points) || 0), 0);
}

export function todayJournalMarkup(checkin = {}, medsEnabled = false) {
  const entry = loadDailyEntry();
  const score = scoreTotal(entry);
  const scoreEntries = Array.isArray(entry.scoreEntries) ? entry.scoreEntries : [];
  const extraFields = [
    ['emotionKit', '今日收获', '今天收获了什么？'],
    ['positive', '正向链接', '今天遇到的美好事物...'],
    ['events', '具体事件', '今天发生了什么？'],
    ['gratitude', '感谢', '今天想感谢什么？'],
    ['selfPraise', '夸夸自己', '今天做得好的地方...'],
    ['body', '身体', '身体状况、运动、睡眠...'],
    ['emotion', '情绪', '今天情绪如何？'],
    ['vent', '自由发泄区', '随便写点什么...'],
  ];
  return `<section class="today-journal workspace-card" data-today-journal>
    <div class="workspace-card-head"><div><span class="habit-kicker">DAYBOOK</span><h3>今天的内容</h3></div><span class="journal-score ${score < 0 ? 'negative' : ''}">${score > 0 ? '+' : ''}${score} 分</span></div>
    <div class="journal-metrics">
      <label>心情<select data-journal="moodRating"><option value="">未记录</option>${[1,2,3,4,5].map(n => `<option value="${n}" ${String(entry.moodRating) === String(n) ? 'selected' : ''}>${n}/5</option>`).join('')}</select></label>
      <label class="journal-check"><input type="checkbox" data-journal="sleptEarly" ${entry.sleptEarly ? 'checked' : ''}> 昨晚按计划早睡</label>
      <span class="journal-hint">${Array.isArray(entry.scoreEntries) ? entry.scoreEntries.length : 0} 条打分</span>
    </div>
    <label class="journal-field">每日复盘<textarea rows="3" data-journal="review" placeholder="今天发生了什么？什么值得保留，明天调整什么？">${esc(entry.review || '')}</textarea></label>
    <label class="journal-field">明日计划<textarea rows="2" data-journal="tomorrowPlan" placeholder="写下明天最重要的一步">${esc(entry.tomorrowPlan || '')}</textarea></label>
    <label class="journal-field">当天记录<textarea rows="2" data-journal="freeform" placeholder="随手记下今天的想法、情绪或事件">${esc(entry.freeform || '')}</textarea></label>
    <details class="journal-more today-checkin" data-today-checkin><summary>今日状态打卡${checkin && (checkin.sleepHours != null || checkin.energy) ? '（已有记录）' : ''}</summary>
      <div class="checkin-compact-grid">
        <label class="journal-field">睡眠（小时）<input type="number" step="0.5" min="0" max="24" data-checkin="sleepHours" value="${checkin?.sleepHours ?? ''}"></label>
        <label class="journal-field">起床时间<input type="time" data-checkin="wakeAt" value="${esc(checkin?.wakeAt || '')}"></label>
        <label class="journal-field">饮水（杯）<input type="number" min="0" step="1" data-checkin="water" value="${checkin?.water ?? ''}"></label>
        <label class="journal-field">学习（分钟）<input type="number" min="0" step="10" data-checkin="studyMin" value="${checkin?.studyMin ?? ''}"></label>
      </div>
      <div class="checkin-scale-grid">
        ${[['energy', '精力'], ['mood', '情绪'], ['attention', '注意力']].map(([key, label]) => `<label class="checkin-scale-field">${label}<select data-checkin="${key}"><option value="">未记录</option>${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${Number(checkin?.[key]) === n ? 'selected' : ''}>${n}/5</option>`).join('')}</select></label>`).join('')}
      </div>
      <div class="checkin-compact-grid">
        <label class="journal-field">饮食<input type="text" data-checkin="meals" value="${esc(checkin?.meals || '')}" placeholder="吃了什么"></label>
        <label class="journal-field">运动<input type="text" data-checkin="exercise" value="${esc(checkin?.exercise || '')}" placeholder="做了什么运动"></label>
      </div>
      <label class="journal-check"><input type="checkbox" data-checkin="washed" ${checkin?.washed ? 'checked' : ''}> 已洗漱</label>
      ${medsEnabled ? '<label class="journal-field">服药（仅作记录）<input type="text" data-checkin="meds" value="' + esc(checkin?.meds || '') + '"></label><button type="button" class="micro-text-link" data-toggle-meds>关闭服药记录字段</button>' : '<button type="button" class="micro-text-link" data-toggle-meds>添加服药记录字段</button>'}
      <label class="journal-field">今天最重要的任务<input type="text" data-checkin="topTask" value="${esc(checkin?.topTask || '')}"></label>
      <label class="journal-field">当前最大阻碍<input type="text" data-checkin="blocker" value="${esc(checkin?.blocker || '')}"></label>
      <label class="journal-field">下一步行动<input type="text" data-checkin="nextAction" value="${esc(checkin?.nextAction || '')}"></label>
      <label class="journal-field">状态备注<textarea rows="2" data-checkin="note">${esc(checkin?.note || '')}</textarea></label>
      <div class="journal-actions"><button type="button" class="primary" data-save-checkin>保存状态</button><span class="hint" data-checkin-status></span></div>
    </details>
    <details class="journal-more"><summary>更多今日记录</summary><div class="journal-more-grid">${extraFields.map(([key, label, placeholder]) => `
      <label class="journal-field"><span>${label}</span><textarea rows="2" data-journal="${key}" placeholder="${placeholder}">${esc(entry[key] || '')}</textarea></label>`).join('')}</div></details>
    <details class="journal-more journal-score-details"><summary>今日打分明细（${scoreEntries.length} 条）</summary>
      ${scoreEntries.length ? `<ul class="journal-score-list">${scoreEntries.map(item => `<li><span>${esc(item.title || '未命名')}</span><strong class="${Number(item.points) < 0 ? 'negative' : ''}">${Number(item.points) > 0 ? '+' : ''}${Number(item.points) || 0}</strong></li>`).join('')}</ul>` : '<p class="journal-empty-hint">今天还没有打分明细，可在学习里的积分页记录。</p>'}
    </details>
    <div class="journal-actions"><button type="button" class="primary" data-save-journal>保存今日内容</button><span class="hint" data-journal-status></span></div>
  </section>`;
}

export function bindTodayJournal(root, { onChanged, onCheckinSave, onMedsToggle } = {}) {
  const box = root.querySelector('[data-today-journal]');
  if (!box) return;
  box.querySelector('[data-save-journal]')?.addEventListener('click', () => {
    const patch = {};
    box.querySelectorAll('[data-journal]').forEach(node => {
      patch[node.dataset.journal] = node.type === 'checkbox' ? node.checked : node.value;
    });
    saveDailyEntry(patch);
    const status = box.querySelector('[data-journal-status]');
    if (status) status.textContent = '已保存';
    onChanged?.();
    setTimeout(() => { if (status) status.textContent = ''; }, 1800);
  });
  const checkin = root.querySelector('[data-today-checkin]');
  checkin?.querySelector('[data-toggle-meds]')?.addEventListener('click', () => onMedsToggle?.(checkin.querySelector('[data-checkin="meds"]') === null));
  checkin?.querySelector('[data-save-checkin]')?.addEventListener('click', async () => {
    const value = key => checkin.querySelector(`[data-checkin="${key}"]`)?.value || '';
    const number = key => value(key) === '' ? null : Number(value(key));
    const fields = {
      sleepHours: number('sleepHours'), wakeAt: value('wakeAt'), energy: number('energy'), mood: number('mood'),
      attention: number('attention'), water: number('water'), studyMin: number('studyMin'), meals: value('meals'),
      exercise: value('exercise'), washed: checkin.querySelector('[data-checkin="washed"]')?.checked ?? null,
      meds: value('meds'), topTask: value('topTask'), blocker: value('blocker'), nextAction: value('nextAction'), note: value('note'),
    };
    await onCheckinSave?.(fields);
    const status = checkin.querySelector('[data-checkin-status]');
    if (status) status.textContent = '已保存';
  });
}

export function renderMicroHabit(el, { onChanged, showAddButton = true } = {}) {
  const state = loadMicroHabitState();
  const active = state.habits.filter(h => h.active !== false).sort((a, b) => a.order - b.order);
  const doneIds = new Set(Array.isArray(state.completions[today()]) ? state.completions[today()] : []);
  const done = active.filter(h => doneIds.has(h.id)).length;
  const percent = active.length ? Math.round(done / active.length * 100) : 0;
  el.innerHTML = `<div class="habit-workspace">
    <section class="habit-hero workspace-card"><div><h3>微习惯</h3></div><div class="habit-progress-ring" style="--progress:${percent * 3.6}deg"><span>${percent}%</span><small>今日完成</small></div></section>
    <section class="workspace-card"><div class="workspace-card-head"><div><h3>今日习惯</h3><p class="card-sub">${done}/${active.length || 0} 个已完成</p></div></div>
      ${active.length ? `<div class="habit-list">${active.map(h => `<article class="habit-item" data-habit-row="${esc(h.id)}">
        <div class="habit-row ${doneIds.has(h.id) ? 'done' : ''}">
          <button type="button" class="habit-complete" data-habit-id="${esc(h.id)}" aria-label="${doneIds.has(h.id) ? '取消完成' : '标记完成'}：${esc(h.title)}" aria-pressed="${doneIds.has(h.id)}"><span class="habit-check">${doneIds.has(h.id) ? icon('check') : ''}</span><span class="habit-copy"><strong>${esc(h.title)}</strong><small>${doneIds.has(h.id) ? '今天已完成' : '点击标记完成'}</small></span></button>
          <div class="habit-row-actions"><button type="button" class="habit-icon-btn" data-habit-edit title="编辑微习惯" aria-label="编辑微习惯：${esc(h.title)}">${icon('pencil')}</button><button type="button" class="habit-icon-btn danger" data-habit-delete title="删除微习惯" aria-label="删除微习惯：${esc(h.title)}">${icon('trash')}</button></div>
        </div>
        <form class="habit-edit-form" data-habit-edit-form hidden><input name="title" value="${esc(h.title)}" maxlength="100" required aria-label="修改习惯名称"><button type="submit" class="habit-edit-save" aria-label="保存修改" title="保存修改">${icon('check')}</button><button type="button" class="habit-edit-cancel" data-habit-edit-cancel>取消</button></form>
      </article>`).join('')}</div>` : `<div class="habit-empty"><strong>还没有微习惯</strong><p>从一个每天都能做到的小动作开始。</p></div>`}
    </section>
    ${showAddButton ? '<button type="button" class="habit-add-fab" data-habit-fab aria-label="添加微习惯">＋</button><form class="habit-add-panel" data-add-habit hidden><input name="title" placeholder="添加一个小习惯，例如：读书 5 分钟" required><button class="primary" type="submit">添加</button></form>' : ''}
  </div>`;
  el.querySelectorAll('[data-habit-id]').forEach(node => node.addEventListener('click', () => {
    const id = node.dataset.habitId;
    const next = loadMicroHabitState();
    const list = Array.isArray(next.completions[today()]) ? next.completions[today()] : [];
    next.completions[today()] = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
    saveMicroHabitState(next);
    renderMicroHabit(el, { onChanged });
    onChanged?.();
  }));
  el.querySelectorAll('[data-habit-edit]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('[data-habit-row]');
    const form = row?.querySelector('[data-habit-edit-form]');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const input = form.querySelector('input');
      input?.focus();
      input?.select();
    }
  }));
  el.querySelectorAll('[data-habit-edit-form]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const row = form.closest('[data-habit-row]');
    const title = form.elements.namedItem('title')?.value?.trim();
    if (!title || !row) return;
    changeMicroHabit({ action: 'update', id: row.dataset.habitRow, title });
    renderMicroHabit(el, { onChanged });
    onChanged?.();
  }));
  el.querySelectorAll('[data-habit-edit-cancel]').forEach(button => button.addEventListener('click', () => {
    const form = button.closest('[data-habit-edit-form]');
    if (form) form.hidden = true;
  }));
  el.querySelectorAll('[data-habit-delete]').forEach(button => button.addEventListener('click', () => {
    const row = button.closest('[data-habit-row]');
    if (!row) return;
    changeMicroHabit({ action: 'delete', id: row.dataset.habitRow });
    renderMicroHabit(el, { onChanged });
    onChanged?.();
  }));
  el.querySelector('[data-add-habit]')?.addEventListener('submit', event => {
    event.preventDefault();
    const title = event.currentTarget.elements.namedItem('title')?.value?.trim();
    if (!title) return;
    const next = loadMicroHabitState();
    next.habits.push({ id: uid(), title, active: true, order: next.habits.length });
    saveMicroHabitState(next);
    renderMicroHabit(el, { onChanged });
    onChanged?.();
  });
  el.querySelector('[data-habit-fab]')?.addEventListener('click', () => {
    const form = el.querySelector('[data-add-habit]');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  });
}
