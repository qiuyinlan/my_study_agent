// ── 共享渲染：对话视图、统计、计时条、图标导航、toast ──────────

import { renderMarkdown, escapeHtml, fmtDateTime } from './util.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = escapeHtml;

/* ══════════ toast ══════════ */

export function toast(message, kind = '') {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 7000 : 3400);
}

/* ══════════ 顶栏标题 ══════════ */

/**
 * 用户在档案里改了"希望如何称呼监督员"，顶栏这里要立刻跟着变。
 * 早先只在启动时设了一次，所以改完名字看起来像没生效。
 */
export function renderBrand(profile) {
  const el = $('#brand-name');
  if (!el) return;
  const name = profile?.supervisorName || '帕尼尼';
  if (el.textContent !== name) el.textContent = name;
}

/* ══════════ 顶栏统计 ══════════ */

export function renderStats(s) {
  const el = $('#stats');
  if (!el) return;
  const items = [];

  if (s.blocked.length) {
    items.push(`<span class="stat bad">受阻 <b>${s.blocked.length}</b></span>`);
  }
  if (s.overdue.length) {
    items.push(`<span class="stat bad">逾期 <b>${s.overdue.length}</b></span>`);
  }
  if (s.streak > 0) {
    items.push(`<span class="stat ${s.streak >= 3 ? 'hot' : ''}">连续 <b>${s.streak}</b> 天</span>`);
  }
  if (s.keyTaskIds.length) {
    const done = s.keyTasks.filter(t => t.state === 'DONE').length;
    items.push(`<span class="stat ${done === s.keyTasks.length ? '' : 'hot'}">关键任务 <b>${done}/${s.keyTasks.length}</b></span>`);
  }
  if (s.doneToday.length) {
    items.push(`<span class="stat">今日完成 <b>${s.doneToday.length}</b></span>`);
  }
  if (s.trackedMinutes) {
    items.push(`<span class="stat">已记录 <b>${s.trackedMinutes}</b> 分钟</span>`);
  }
  if (s.dueCount) {
    items.push(`<span class="stat hot">待复习 <b>${s.dueCount}</b></span>`);
  }
  if (s.active.length) {
    items.push(`<span class="stat">进行中 <b>${s.active.length}</b></span>`);
  }
  el.innerHTML = items.join('');
}

/* ══════════ 计时条 ══════════ */

let timerTickHandle = null;

/**
 * 计时条每 500ms 自己刷新，不依赖数据库 ——
 * 走的是 startedAt 到现在的墙钟差，和真实计时器同源。
 */
export function renderTimerBar(timer, { onStop }) {
  const el = $('#timerbar');
  if (!el) return;

  if (timerTickHandle) { clearInterval(timerTickHandle); timerTickHandle = null; }

  if (!timer) {
    el.className = 'timerbar';
    el.innerHTML = '';
    return;
  }

  const paint = () => {
    const el2 = $('#timerbar');
    if (!el2) return;
    const elapsedMs = Date.now() - new Date(timer.startedAt).getTime();
    const total = Math.max(0, Math.floor(elapsedMs / 1000));
    const h = Math.floor(total / 3600);
    const mn = Math.floor((total % 3600) / 60);
    const sc = total % 60;
    const clock = h
      ? `${h}:${String(mn).padStart(2, '0')}:${String(sc).padStart(2, '0')}`
      : `${String(mn).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;

    const over = timer.plannedMin ? total / 60 > timer.plannedMin : false;
    const stale = total > 8 * 3600;

    el2.className = `timerbar on${stale ? ' stale' : ''}${over && !stale ? ' over' : ''}`;
    el2.innerHTML = `
      <span class="dot"></span>
      <span class="t-name">${esc(timer.label)}</span>
      <span class="t-clock">${clock}</span>
      <span class="t-plan">${timer.plannedMin
        ? (over ? `已超计划 ${timer.plannedMin} 分钟` : `计划 ${timer.plannedMin} 分钟`)
        : '未设计划时长'}</span>
      ${stale ? '<span class="t-plan">⚠️ 超过 8 小时，多半忘了停</span>' : ''}
      <span class="spacer"></span>
      <button class="ghost" id="btn-timer-stop">结束计时</button>
      <button class="ghost" id="btn-timer-detail">查看任务</button>`;
    $('#btn-timer-stop')?.addEventListener('click', () => onStop?.('stop'));
    $('#btn-timer-detail')?.addEventListener('click', () => onStop?.('detail'));
  };

  paint();
  timerTickHandle = setInterval(paint, 1000);
}

/* ══════════ 图标（内联 SVG，无依赖、无 emoji）══════════════ */

const ICON_PATHS = {
  chat:    '<path d="M20 11.5a7.5 7.5 0 01-7.5 7.5H6l-3 2v-5.2A7.5 7.5 0 1112.5 19"/><path d="M8 10h8M8 14h5"/>',
  today:   '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  learning:'<path d="M4 5.5a2 2 0 012-2h12a2 2 0 012 2v13H6a2 2 0 00-2 2z"/><path d="M6 18.5h14M8 8h8M8 12h6"/>',
  habits:  '<path d="M12 20.5c-3.4-2.4-5.6-5.3-5.6-8.6 0-2.3 1.5-4.3 3.7-4.8 1.1-.2 1.7.6 1.9 1.5.2-.9.8-1.7 1.9-1.5 2.2.5 3.7 2.5 3.7 4.8 0 3.3-2.2 6.2-5.6 8.6z"/><path d="M12 19.5V5M12 9c-1.8-1.6-3.4-2.3-5.1-2.3M12 12.5c1.6-1.7 3.1-2.4 4.7-2.4"/>',
  life:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2L18 18"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2l-2.4 5.2-5.2 2.4 2.4-5.2z"/>',
  principle: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M8.5 12l2.2 2.2 4.8-5"/>',
  interest: '<path d="M12 3.5l1.8 5.1 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2L5 10.4l5.2-1.8z"/><path d="M19 15.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/>',
  boredom: '<path d="M5 4.5h14v15H5z"/><path d="M9 8.5h6M9 12h6M9 15.5h3"/><path d="M8 2.5v4M16 2.5v4"/>',
  tasks:   '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
  checkin: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/>',
  menu:     '<path d="M4 8h16M4 16h16"/>',
  compose:  '<path d="M13.5 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-7.5"/><path d="M18.4 2.8a2.1 2.1 0 013 3L12 15.2l-4 1 1-4z"/>',
  history:  '<path d="M3 12a9 9 0 109-9 9.2 9.2 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 00.12-.62l-1.92-3.32a.5.5 0 00-.59-.21l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54A.5.5 0 0013.9 2h-3.8a.5.5 0 00-.5.42l-.36 2.54c-.59.25-1.13.56-1.62.94l-2.39-.96a.5.5 0 00-.59.21L2.72 8.47a.5.5 0 00.12.62l2.03 1.58c-.05.3-.07.61-.07.94s.02.64.07.94l-2.03 1.58a.5.5 0 00-.12.62l1.92 3.32a.5.5 0 00.59.21l2.39-.96c.49.38 1.03.69 1.62.94l.36 2.54a.5.5 0 00.5.42h3.8a.5.5 0 00.5-.42l.36-2.54c.59-.25 1.13-.56 1.62-.94l2.39.96a.5.5 0 00.59-.21l1.92-3.32a.5.5 0 00-.12-.62z"/><circle cx="12" cy="12" r="3.5"/>',
  tool: '<path d="M14.5 6.2a4.2 4.2 0 00-5.6 5.6L3.8 17a2.3 2.3 0 103.2 3.2l5.2-5.1a4.2 4.2 0 005.6-5.6l-2.5 2.5-3.2-3.2z"/>',
  points:  '<circle cx="12" cy="9" r="5.6"/><path d="M9 13.8L7.4 21.5l4.6-2.6 4.6 2.6L15 13.8"/>',
  plans:   '<path d="M9 3.6L3.5 5.6v14.8L9 18.4l6 2 5.5-2V3.6l-5.5 2-6-2z"/><path d="M9 3.6v14.8M15 5.6v14.8"/>',
  sops:    '<path d="M5 4.8A2.3 2.3 0 017.3 2.5H19v19H7.3A2.3 2.3 0 015 19.2z"/><path d="M9 7.5h6.5M9 11.5h4.5"/>',
  reviews: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M20.5 20.5l-4.4-4.4"/>',
  records: '<circle cx="12" cy="12" r="8.7"/><path d="M12 7.2V12l3.1 1.9"/>',
  pencil:  '<path d="M4.2 19.8h3.9L19.6 8.3l-3.9-3.9L4.2 15.9z"/><path d="M14.6 5.5l3.9 3.9"/>',
  trash:   '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 14h11l1-14M9 7V4h6v3"/>',
  profile: '<circle cx="12" cy="8" r="3.8"/><path d="M4.6 21v-.9A5.4 5.4 0 0110 14.7h4A5.4 5.4 0 0119.4 20v.9"/>',
  'chevron-left':  '<path d="M14.5 6L8.5 12l6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'arrow-down': '<path d="M12 4v16M5 13l7 7 7-7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  panel:   '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/>',
  refresh: '<path d="M21 3.5v5.5h-5.5"/><path d="M20.6 14.5a8.7 8.7 0 11-1.9-9.1L21 9"/>',
  play:    '<path d="M8 5.5v13l10-6.5z"/>',
  check:   '<path d="M4.5 12.5l5 5 10-11"/>',
  alert:   '<path d="M12 3.5l9 15.5H3z"/><path d="M12 9.5v4.5M12 17h.01"/>',
  doc:     '<path d="M6 2.5h7.5L19 8v13.5H6z"/><path d="M13 2.5V8h6"/>',
};

export function icon(name, cls = '') {
  const p = ICON_PATHS[name];
  if (!p) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/** 把顶栏/面板上的图标按钮填好（HTML 里只留空按钮，避免手写 SVG 重复） */
const TOOL_LABELS = {
  list_tasks: '查看任务', get_task: '查看任务详情', save_task: '保存任务', set_task_state: '更新任务状态',
  delete_task: '删除任务', set_key_tasks: '设置今日关键任务', timer_start: '开始计时', timer_stop: '结束计时',
  timer_status: '查看计时', log_time_entry: '记录耗时', get_ledger: '查看积分', award_points: '记录积分',
  confirm_points: '确认积分', upsert_reward: '管理奖励', redeem_reward: '兑换奖励', save_checkin: '保存打卡',
  get_checkin: '查看打卡', list_micro_habits: '查看微习惯', manage_micro_habit: '更新微习惯',
  manage_life_navigation: '更新生活导航', save_review: '保存复盘', record_procrastination: '记录拖延情况',
  list_reviews: '查看复盘', save_plan: '保存计划', list_plans: '查看计划', get_plan: '查看计划详情',
  save_sop: '保存流程', list_sops: '查看流程', get_sop: '查看流程详情', get_profile: '查看学习档案',
  update_profile: '更新学习档案', suspend_supervision: '暂停监督', resume_supervision: '恢复监督',
  save_memory: '保存长期记忆', search_memory: '搜索记忆', list_memories: '查看记忆', forget_memory: '删除记忆',
  log_study: '记录学习', grade_review: '更新复习进度', add_topic: '添加知识点', list_topics: '查看知识点',
  get_daily_summary: '整理今日摘要', export_records: '导出记录', open_panel: '打开页面',
};

export function initChromeIcons({ navCollapsed = true, panelCollapsed = false } = {}) {
  const set = (sel, name, title) => {
    const el = $(sel);
    if (!el) return;
    el.innerHTML = icon(name);
    if (title) {
      el.title = title;
      el.setAttribute('aria-label', title);
    }
  };
  set('#btn-collapse-panel', panelCollapsed ? 'chevron-right' : 'chevron-left',
    panelCollapsed ? '展开面板' : '收起面板');
  set('#btn-reveal-panel', 'chevron-right', '展开面板');
  set('#btn-refresh-panel', 'refresh', '立即刷新');
  set('#btn-collapse-topbar', 'menu', navCollapsed ? '打开导航' : '关闭导航');
  set('#btn-new-chat', 'compose', '新对话');
  set('#btn-sessions', 'history', '历史记录');
  set('#btn-settings', 'settings', '设置');
}

/* ══════════ 左侧导航 ══════════ */

export function renderNav(panels, current, onSelect, badges = {}) {
  const el = $('#nav-items');
  if (!el) return;
  el.innerHTML = panels.map(p => {
    const badge = badges[p.id];
    const label = badge && typeof badge === 'object' ? badge.label : badge;
    const tone = badge && typeof badge === 'object' ? badge.tone : '';
    const badgeTitle = badge && typeof badge === 'object' ? badge.title : '';
    const showBadge = label !== undefined && label !== null && label !== ''
      && (tone === 'count' || tone === 'duration' || Number(label) > 0);
    const badgeLabel = typeof label === 'number' && label > 99 ? '99' : label;
    return `<button class="nav-btn ${p.id === current ? 'active' : ''}" data-panel="${p.id}" title="${esc(p.title)}">
      <span class="nav-icon">${icon(p.id)}</span>
      <span class="nav-label">${esc(p.title)}</span>
      ${showBadge ? `<span class="nav-badge ${esc(tone)}"${badgeTitle ? ` title="${esc(badgeTitle)}"` : ''}>${esc(badgeLabel)}</span>` : ''}
    </button>`;
  }).join('');
  $$('.nav-btn', el).forEach(btn => {
    btn.onclick = () => onSelect(btn.dataset.panel);
  });
}

/* ══════════ 待确认动作区 ══════════ */

/**
 * 渲染"需要你点一下"的按钮条。
 * 放在对话区和输入框之间 —— 它是"当前待办"，不是历史消息，
 * 所以放在底部而不是塞进某个气泡里。刷新页面也会重新渲染出来。
 */
export function renderPendingArea(items, { onConfirm, onDismiss } = {}) {
  const el = $('#pending-area');
  if (!el) return;

  if (!items.length) {
    el.classList.remove('on');
    el.innerHTML = '';
    return;
  }

  el.classList.add('on');
  el.innerHTML = `<div class="msg assistant pending-message">
    <div class="who">帕尼尼</div>
    <div class="bubble">${items.map(p => `
    <div class="pending-card ${p.danger ? 'danger' : ''}" data-pending="${p.id}">
      <div class="p-icon">${icon(p.danger ? 'alert' : 'play')}</div>
      <div class="p-main">
        <div class="p-label">${esc(p.label)}</div>
        ${p.detail ? `<div class="p-detail">${esc(p.detail)}</div>` : ''}
        <div class="p-hint">这是你的决定，点一下才会执行</div>
      </div>
      <button type="button" class="${p.danger ? 'danger' : 'primary'}" data-confirm="${p.id}">${p.chatDraft ? '保存' : p.tool === 'timer_start' ? '开始计时' : '确认'}</button>
      <button type="button" class="ghost" data-dismiss="${p.id}">不用</button>
    </div>`).join('')}</div>
  </div>`;

  $$('[data-confirm]', el).forEach(b => { b.onclick = () => onConfirm?.(b.dataset.confirm); });
  $$('[data-dismiss]', el).forEach(b => { b.onclick = () => onDismiss?.(b.dataset.dismiss); });
}

/** 把一个待确认项就地标成"已执行"，而不是整块重建（避免视觉跳动） */
export function markPendingDone(pendingId, text) {
  const el = $(`#pending-area [data-pending="${pendingId}"]`);
  if (!el) return;
  el.classList.add('done');
  el.classList.remove('danger');
  const m = $('.p-main', el);
  if (m) {
    m.innerHTML = `<div class="p-label">${icon('check')} ${esc(text || '已执行')}</div>`;
  }
  el.querySelectorAll('button').forEach(b => b.remove());
}

/* ══════════ 对话视图 ══════════ */

function bubble(role, html, who = '') {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `${who ? `<div class="who">${esc(who)}</div>` : ''}
    <div class="tools"></div><div class="think"></div><div class="bubble"></div>`;
  if (html !== undefined) $('.bubble', wrap).innerHTML = html;
  return wrap;
}

function emptyState(profile) {
  const name = profile?.userName || '你';
  const el = document.createElement('div');
  el.className = 'placeholder';
  el.style.cssText = 'margin:auto;max-width:520px;text-align:center;color:var(--fg-dim);line-height:1.9';
  el.innerHTML = `
    <div style="width:40px;height:40px;margin:0 auto 14px;color:var(--line-strong)">${icon('doc')}</div>
    <div style="font-size:15px;font-weight:650;color:var(--fg);margin-bottom:8px">帕尼尼待命</div>
    <div style="font-size:13.5px">
      计划不是成果，意图不是行动，承诺不是完成。<br><br>
      ${name === '你' ? '' : `${esc(name)}，`}说一句就开始：<br>
      <span style="color:var(--fg)">「我要开始学线代了」</span><br>
      <span style="color:var(--fg)">「我又拖延了，卡在第一步」</span><br>
      <span style="color:var(--fg)">「小黑屋」</span>　<span style="color:var(--fg)">「帮我安排今天」</span><br>
      <span style="color:var(--fg)">「开始计时」</span>　<span style="color:var(--fg)">「你能做什么」</span>
    </div>`;
  return el;
}

export function createChatView(container) {
  let current = null;
  let raw = '';
  let reasoning = '';
  let tools = null;
  let rafPending = false;
  let pinned = true;
  let mobileStream = false;

  const jumpButton = document.createElement('button');
  jumpButton.type = 'button';
  jumpButton.className = 'chat-jump-bottom';
  jumpButton.title = '回到最新消息';
  jumpButton.setAttribute('aria-label', '回到最新消息');
  jumpButton.innerHTML = icon('arrow-down');
  jumpButton.hidden = true;
  container.closest('.chat')?.appendChild(jumpButton);

  function setPinned(value) {
    pinned = value;
    jumpButton.hidden = pinned;
  }

  function scrollToBottom() {
    if (!pinned || (window.innerWidth <= 840 && mobileStream)) return;
    container.scrollTop = container.scrollHeight;
  }

  container.addEventListener('scroll', () => {
    setPinned(container.scrollHeight - container.scrollTop - container.clientHeight < 90);
  });

  jumpButton.addEventListener('click', () => {
    mobileStream = false;
    setPinned(true);
    container.scrollTop = container.scrollHeight;
  });

  const flush = () => {
    rafPending = false;
    if (!current) return;
    const b = $('.bubble', current);
    if (b) b.innerHTML = renderMarkdown(raw) + '<span class="cursor"></span>';
    if (reasoning) {
      const t = $('.think', current);
      if (t) { t.textContent = reasoning; t.scrollTop = t.scrollHeight; }
    }
    scrollToBottom();
  };

  const schedule = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(flush);
  };

  return {
    renderHistory(messages, profile) {
      mobileStream = false;
      const pendingArea = $('#pending-area');
      container.innerHTML = '';
      if (!messages.length) {
        container.appendChild(emptyState(profile));
        if (pendingArea) container.appendChild(pendingArea);
        return;
      }
      for (const m of messages) {
        const who = m.role === 'user' ? (profile?.userName || '你') : (profile?.supervisorName || '帕尼尼');
        container.appendChild(bubble(
          m.role,
          m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : renderMarkdown(m.content),
          who,
        ));
      }
      if (pendingArea) container.appendChild(pendingArea);
      setPinned(true);
      scrollToBottom();
    },

    reset(profile) {
      const pendingArea = $('#pending-area');
      container.innerHTML = '';
      container.appendChild(emptyState(profile));
      if (pendingArea) container.appendChild(pendingArea);
    },

    appendUser(text, profile) {
      mobileStream = false;
      $('.placeholder', container)?.remove();
      setPinned(true);
      container.appendChild(bubble('user', esc(text).replace(/\n/g, '<br>'), profile?.userName || '你'));
      scrollToBottom();
    },

    startAssistant(profile) {
      mobileStream = true;
      $('.placeholder', container)?.remove();
      raw = '';
      reasoning = '';
      current = bubble('assistant', '<span class="cursor"></span>', profile?.supervisorName || '帕尼尼');
      tools = $('.tools', current);
      container.appendChild(current);
      scrollToBottom();
    },

    appendDelta(text) { if (!current) this.startAssistant(); raw += text; schedule(); },
    appendReasoning(text) { if (!current) this.startAssistant(); reasoning += text; schedule(); },

    toolStart(name, args) {
      if (!current) this.startAssistant();
      const el = document.createElement('div');
      el.className = 'tool-call tool-running';
      el.innerHTML = `${icon('tool')}<span>执行中 · ${esc(TOOL_LABELS[name] || '处理中')}</span>`;
      tools?.appendChild(el);
      scrollToBottom();
    },

    toolResult(name, ok, summary, pending = false) {
      if (!tools) return;
      const el = document.createElement('div');
      el.className = `tool-call ${pending ? 'tool-pending' : ok ? 'tool-success' : 'tool-error'}`;
      const status = pending ? '待确认' : ok ? '执行完成' : '执行失败';
      el.innerHTML = `${icon('tool')}<span>${status} · ${esc(TOOL_LABELS[name] || '处理中')}</span>`;
      tools.appendChild(el);
      scrollToBottom();
    },

    notice(text) {
      if (!current) this.startAssistant();
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.textContent = `ⓘ ${text}`;
      tools?.appendChild(el);
    },

    finish() {
      if (!current) return;
      const b = $('.bubble', current);
      if (b) {
        b.innerHTML = raw.trim()
          ? renderMarkdown(raw)
          : '<em style="color:var(--fg-faint)">（没有产生文本回复）</em>';
      }
      current = null; raw = ''; reasoning = '';
      scrollToBottom();
    },

    /**
     * 把失败摊开给用户看，而不是一句干巴巴的提示。
     * @param {string} message
     * @param {{raw?:string, kind?:string, status?:number}} [info]
     */
    fail(message, { raw = '', kind = '', status = null } = {}) {
      if (!current) current = bubble('assistant', '', '');
      const b = $('.bubble', current);
      const title = kind === 'timeout' ? '请求超时'
        : kind === 'network' ? '网络错误'
          : kind === 'config' ? '配置缺失'
            : status ? `请求失败（HTTP ${status}）` : '出错了';

      if (b) {
        b.innerHTML = `<div class="err-box">
          <div class="err-title">⚠️ ${esc(title)}</div>
          <div class="err-msg">${esc(message)}</div>
          <div class="err-actions">
            ${raw ? '<button type="button" class="ghost err-copy">复制原始响应</button>' : ''}
          </div>
          <div class="err-hint">想定位原因：设置 → 底部「开始诊断」，会分步告诉你哪一层断了。</div>
        </div>`;

        $('.err-copy', b)?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(raw);
            toast('原始响应已复制', 'ok');
          } catch {
            toast('复制失败：浏览器拒绝了剪贴板权限', 'err');
          }
        });
      }
      current = null;
      scrollToBottom();
    },

    get hasStream() { return Boolean(current); },
  };
}

/* ══════════ 通用小部件 ══════════ */

export const stateBadge = state =>
  `<span class="badge st-${String(state).toLowerCase()}">${state}</span>`;

export const priorityBadge = p =>
  `<span class="badge ${String(p).toLowerCase()}">${p}</span>`;

export function masteryDots(mastery) {
  return `<span class="dots">${[0, 1, 2, 3, 4]
    .map(i => `<i class="dot ${i < (mastery ?? 0) ? 'on' : ''}"></i>`).join('')}</span>`;
}

export const fmtMin = m => (m === null || m === undefined || m === '' ? '' : `${m} 分钟`);

/** token 用量（设置面板里显示） */
export function renderUsage(usage) {
  const el = $('#usage-line');
  if (!el) return;
  if (!usage?.calls) {
    el.textContent = '还没有调用记录。';
    return;
  }
  const n = v => new Intl.NumberFormat('zh-CN').format(v);
  el.textContent = `累计 ${n(usage.calls)} 次调用　输入 ${n(usage.prompt)} tokens`
    + `　输出 ${n(usage.completion)} tokens`
    + (usage.cached ? `　缓存命中 ${n(usage.cached)} tokens` : '');
}

export { fmtDateTime };
