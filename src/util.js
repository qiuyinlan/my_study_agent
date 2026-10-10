// ── 通用工具 ────────────────────────────────────────────────

export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...rnd].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${Date.now().toString(36)}${hex}`;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 本地时区的 YYYY-MM-DD */
export function dateStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const nowISO = () => new Date().toISOString();

/** 今天 23:59:59.999 的 ISO 时刻（用于和 nextReviewAt 做字符串比较） */
export function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** 'YYYY-MM-DD' → 距离今天还有几天（负数=已过期） */
export function daysUntil(dateOnly) {
  if (!dateOnly) return null;
  const [y, m, d] = dateOnly.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  target.setHours(0, 0, 0, 0);
  const today = startOfDay();
  return Math.round((target - today) / 86400000);
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' 加减天数，仍返回 'YYYY-MM-DD' */
export function addDays(dateOnly, n) {
  const [y, m, d] = String(dateOnly).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dateStr(dt);
}

/** 人类可读的日期：今天 / 昨天 / 明天 / 10月10日 周五 */
export function humanDate(dateOnly) {
  if (!dateOnly) return '';
  const n = daysUntil(dateOnly);
  if (n === 0) return '今天';
  if (n === -1) return '昨天';
  if (n === 1) return '明天';
  const [y, m, d] = dateOnly.split('-').map(Number);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
  const year = new Date().getFullYear() !== y ? `${y}年` : '';
  return `${year}${m}月${d}日 周${wd}`;
}

/** ISO 时刻 → HH:MM（本地） */
export function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO 时刻 → 'YYYY-MM-DDTHH:MM'，可直接喂给 datetime-local 输入框 */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的值 → ISO 时刻 */
export function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function fmtMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分钟` : `${h} 小时`;
}

/** 人类可读的"还有几天/逾期几天" */
export function humanDue(dateOnly) {
  const n = daysUntil(dateOnly);
  if (n === null) return '';
  if (n === 0) return '今天截止';
  if (n === 1) return '明天截止';
  if (n > 1) return `还有 ${n} 天`;
  if (n === -1) return '昨天已过期';
  return `逾期 ${-n} 天`;
}

export function debounce(fn, ms = 300) {
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.flush = (...a) => { clearTimeout(t); return fn(...a); };
  return wrapped;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 极简 Markdown 渲染。先整体转义 HTML，再按块级/行内规则还原，
 * 因此模型输出里的任何标签都不会变成可执行 HTML。
 */
export function renderMarkdown(src) {
  const blocks = [];
  // 1) 先摘出代码块，避免其中内容被后续规则误伤
  let text = String(src ?? '').replace(/\r\n/g, '\n').replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_m, lang, code) => {
      const i = blocks.push(
        `<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
      ) - 1;
      return `\u0000BLOCK${i}\u0000`;
    }
  );

  text = escapeHtml(text);

  // 2) 行内规则
  const inline = s => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 3) 块级规则（用索引遍历，因为表格需要向前看一行）
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  const lines = text.split('\n');
  const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isTableSep = l => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-') && l.includes('|');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    if (/^\u0000BLOCK\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    if (!line.trim()) { closeList(); continue; }

    /* 表格：当前行是表头且下一行是分隔行 */
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--; // 抵消外层 i++
      out.push('<table><thead><tr>'
        + head.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lv = Math.min(h[1].length + 2, 6); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }

    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return out.join('\n').replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fmtNum(n) {
  return new Intl.NumberFormat('zh-CN').format(n);
}
