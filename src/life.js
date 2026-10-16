import { esc, icon } from './ui.js';
import { loadMicroHabitState } from './microhabit.js';

const BOREDOM_KEY = 'micro-habit-boredom-v1';
const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function loadBoredom() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOREDOM_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(Boolean).map(item => typeof item === 'string' ? ({ id: uid('boredom'), text: item }) : ({ id: item.id || uid('boredom'), text: String(item.text || item.title || '').trim() })).filter(item => item.text) : [];
  } catch { return []; }
}

function saveBoredom(items) { localStorage.setItem(BOREDOM_KEY, JSON.stringify(items)); }
function saveState(state) {
  localStorage.setItem('micro-habit-local-state-v1', JSON.stringify({ ...state, mainline: state.mainlines?.[0]?.title || '' }));
}

function itemTitle(item, fallback) { return String(item?.title || item?.content || item?.text || '').trim() || fallback; }

const LIFE_KINDS = ['principles', 'interests', 'boredom'];
const LIFE_LABELS = { principles: '原则', interests: '兴趣', boredom: '无聊清单' };

export function listLifeNavigation() {
  const state = loadMicroHabitState();
  return {
    principles: state.principles || [],
    interests: state.interests || [],
    boredom: loadBoredom(),
  };
}

export function changeLifeNavigation({ action, kind, id = '', text = '' }) {
  if (!LIFE_KINDS.includes(kind)) throw new Error(`生活导航类型无效：${kind}`);
  const value = String(text || '').trim();
  const targetId = String(id || '').trim();
  const itemsByKind = listLifeNavigation();
  const items = itemsByKind[kind];
  if (action === 'add') {
    if (!value) throw new Error(`新增${LIFE_LABELS[kind]}需要 text`);
    if (kind === 'boredom') {
      const item = { id: uid('boredom'), text: value };
      saveBoredom([...items, item]);
      return item;
    }
    const state = loadMicroHabitState();
    const item = kind === 'interests'
      ? { id: uid('interest'), content: value, order: items.length }
      : { id: uid(kind.slice(0, -1)), title: value, order: items.length };
    state[kind] = [...items, item];
    saveState(state);
    return item;
  }
  const item = items.find(entry => entry.id === targetId || (targetId && itemTitle(entry, '') === targetId) || (value && itemTitle(entry, '') === value));
  if (!item) throw new Error(`找不到${LIFE_LABELS[kind]}「${targetId || value}」`);
  if (action === 'update') {
    if (!value) throw new Error(`修改${LIFE_LABELS[kind]}需要 text`);
    if (kind === 'boredom') saveBoredom(items.map(entry => entry.id === item.id ? { ...entry, text: value } : entry));
    else {
      const state = loadMicroHabitState();
      state[kind] = items.map(entry => entry.id === item.id ? { ...entry, ...(kind === 'interests' ? { content: value } : { title: value }) } : entry);
      saveState(state);
    }
  } else if (action === 'delete') {
    if (kind === 'boredom') saveBoredom(items.filter(entry => entry.id !== item.id));
    else {
      const state = loadMicroHabitState();
      state[kind] = items.filter(entry => entry.id !== item.id);
      saveState(state);
    }
  } else {
    throw new Error(`不支持的生活导航操作：${action}`);
  }
  return action === 'update'
    ? { ...item, ...(kind === 'boredom' ? { text: value } : kind === 'interests' ? { content: value } : { title: value }) }
    : item;
}

function listEditor(kind, title, items, placeholder) {
  return `<section class="life-section workspace-card" data-life-kind="${kind}"><div class="workspace-card-head"><div><h3>${title}</h3><p class="card-sub">${items.length ? `${items.length} 条内容` : '还没有内容'}</p></div></div><div class="life-list">${items.map((item, i) => {
    const value = esc(itemTitle(item, `未命名${title}${i + 1}`));
    return `<div class="life-item" data-life-id="${esc(item.id || '')}"><input value="${value}" data-life-input placeholder="${placeholder}"><button type="button" class="icon-text danger" data-life-delete title="删除">删除</button></div>`;
  }).join('')}</div><form class="life-add-panel" data-life-add hidden><input name="text" placeholder="${placeholder}" required><button type="submit" class="primary">新增</button></form></section>`;
}

export function renderLifeNav(el, { onChanged, activeKind = null } = {}) {
  el.dataset.lifeActive = activeKind || '';
  const state = loadMicroHabitState();
  const principles = Array.isArray(state.principles) ? state.principles : [];
  const interests = Array.isArray(state.interests) ? state.interests : [];
  const boredom = loadBoredom();
  const sections = [
    ['principles', '原则', '帮助你做决定的信念', principles, '例如：先做最小可行动的一步', 'principle'],
    ['interests', '兴趣', '想研究或体验的事', interests, '例如：想研究的主题或想体验的事', 'interest'],
    ['boredom', '无聊清单', '无聊时可以直接做的事', boredom, '无聊时可以做的事', 'boredom'],
  ];
  const active = sections.find(item => item[0] === activeKind);
  el.innerHTML = `<div class="life-workspace">
    <section class="life-hero workspace-card"><span class="habit-kicker">LIFE NAVIGATION</span><h3>生活导航</h3><p>${active ? `${active[1]}：${active[2]}` : '先选一个入口，再进入具体内容。这里管理生活方向，不和每日记录混在一起。'}</p></section>
    ${active ? `<div class="life-detail-toolbar"><button type="button" class="ghost" data-life-back>← 返回生活导航</button><span class="card-sub">${active[3].length ? `${active[3].length} 条内容` : '还没有内容'}</span></div>${listEditor(active[0], active[1], active[3], active[4])}<button type="button" class="life-add-fab" data-life-fab aria-label="新增${active[1]}">＋</button>` : `<div class="life-entry-grid">${sections.map(([kind, title, desc, items, placeholder, symbol]) => `<button type="button" class="life-entry-card" data-life-entry="${kind}"><span class="life-entry-icon">${icon(symbol)}</span><span class="life-entry-copy"><strong>${title}</strong><small>${desc}</small></span><span class="life-entry-count"><b>${items.length}</b><small>条内容</small></span></button>`).join('')}</div>`}
  </div>`;

  el.querySelectorAll('[data-life-kind]').forEach(section => {
    const kind = section.dataset.lifeKind;
    section.querySelectorAll('[data-life-input]').forEach(input => input.addEventListener('change', () => {
      const id = input.closest('[data-life-id]')?.dataset.lifeId;
      if (!id) return;
      if (kind === 'boredom') {
        const items = loadBoredom().map(item => item.id === id ? { ...item, text: input.value.trim() } : item).filter(item => item.text);
        saveBoredom(items);
      } else {
        const next = loadMicroHabitState();
        const key = kind;
        next[key] = (next[key] || []).map(item => item.id === id ? { ...item, ...(key === 'interests' ? { content: input.value.trim() } : { title: input.value.trim() }) } : item).filter(item => itemTitle(item, '').trim());
        saveState(next);
      }
      onChanged?.();
    }));
    section.querySelectorAll('[data-life-delete]').forEach(button => button.addEventListener('click', () => {
      const id = button.closest('[data-life-id]')?.dataset.lifeId;
      if (!id) return;
      if (kind === 'boredom') saveBoredom(loadBoredom().filter(item => item.id !== id));
      else {
        const next = loadMicroHabitState();
        next[kind] = (next[kind] || []).filter(item => item.id !== id);
        saveState(next);
      }
      renderLifeNav(el, { onChanged, activeKind });
      onChanged?.();
    }));
    section.querySelector('[data-life-add]')?.addEventListener('submit', event => {
      event.preventDefault();
      const text = new FormData(event.currentTarget).get('text')?.toString().trim();
      if (!text) return;
      if (kind === 'boredom') {
        saveBoredom([...loadBoredom(), { id: uid('boredom'), text }]);
      } else {
        const next = loadMicroHabitState();
        const item = kind === 'interests' ? { id: uid('interest'), content: text, order: (next[kind] || []).length } : { id: uid(kind.slice(0, -1)), title: text, order: (next[kind] || []).length };
        next[kind] = [...(next[kind] || []), item];
        saveState(next);
      }
      renderLifeNav(el, { onChanged, activeKind });
      onChanged?.();
    });
  });
  el.querySelectorAll('[data-life-entry]').forEach(button => button.addEventListener('click', () => {
    renderLifeNav(el, { onChanged, activeKind: button.dataset.lifeEntry });
  }));
  el.querySelector('[data-life-back]')?.addEventListener('click', () => renderLifeNav(el, { onChanged }));
  el.querySelector('[data-life-fab]')?.addEventListener('click', () => {
    const form = el.querySelector('[data-life-add]');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  });
}
