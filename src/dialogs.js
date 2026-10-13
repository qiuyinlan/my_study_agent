// ── 弹窗：设置 / 备份 / 任务 / 知识点 / 复习 / 会话 / 档案 / 关键任务 / 规划 / SOP / 奖励 ──

import { $, $$, esc, toast, renderUsage, stateBadge } from './ui.js';
import { loadSettings, saveSettings, DEFAULTS } from './config.js';
import { testConnection } from './deepseek.js';
import {
  db, listTasks, upsertTask, deleteTask, setTaskState, listTopics, upsertTopic,
  deleteTopic, getUsage, getMeta, listSessions, switchSession, createSession,
  deleteSession, clearSessionMessages, deleteAllConversations, deleteProfile,
  getProfile, saveProfile, profileCompletion, setKeyTasks,
  TASK_STATES, PRIORITIES, AREAS, DEFAULT_PROFILE,
} from './db.js';
import { GRADES, gradeTopic, describeInterval, dueTopics } from './srs.js';
import { endOfToday, fmtDateTime, daysUntil, dateStr, toLocalInput, fromLocalInput } from './util.js';
import { getTimeEntry, updateTimeEntry, deleteTimeEntry, createManualEntry } from './timer.js';
import { getLog, updateLog, deleteLog, createLog } from './daylog.js';
import {
  mirrorSupported, getMirrorState, pickMirror, stopMirror, requestMirrorPermission,
  exportToDownload, pickImportFile, importFromObject, summarize,
} from './backup.js';
import { upsertReward, deleteReward } from './ledger.js';
import { savePlan, getPlan, deletePlan, listPlans, saveSop, getSop, deleteSop, checkFeasibility, normalizePlanItem } from './docs.js';
import { upsertCheckin } from './records.js';
import { runDiagnostics } from './diagnose.js';
import {
  getDailyReviewSyncStatus, signInDailyReview, signUpDailyReview, signOutDailyReview,
} from './dailyReview.js';
import { getPrivateSyncStatus, getStorageUsage, refreshPrivateSyncSession } from './privateSync.js';

const OFFICIAL_BASE = 'https://api.deepseek.com';

/* ══════════════ 设置 ══════════════ */

function updateBaseUrlNotice() {
  const note = $('#baseurl-note');
  const val = ($('#set-baseurl').value || '').trim().replace(/\/+$/, '');
  if (!note) return;
  if (!val || val === OFFICIAL_BASE) {
    note.innerHTML = '官方地址。你的 Key 只在浏览器和 DeepSeek 之间传递，不经过任何第三方。';
    note.className = 'hint';
    return;
  }
  note.innerHTML = `⚠️ <b>这不是官方地址。</b>你的 API Key 会随每次请求发送到 <code>${esc(val)}</code>，
    也就是说那台服务器能看到并记录你的 Key。除非那是你自己部署的反向代理，否则不要填第三方中转站。`;
  note.className = 'hint warn-note';
}

export async function openSettings({ onChange, profile, onBackup, onExport }) {
  const dlg = $('#dlg-settings');
  const s = loadSettings();

  /** 收集表单并落盘。诊断前也要先存，否则测的是旧 Key。 */
  const collectAndSave = async () => {
    const next = saveSettings({
      apiKey: $('#set-key').value.trim(),
      persistKey: $('#set-persist').checked,
      baseUrl: $('#set-baseurl').value.trim() || DEFAULTS.baseUrl,
      model: $('#set-model').value.trim() || DEFAULTS.model,
      enableTools: $('#set-tools').checked,
    });
    await saveProfile({
      toneLevel: Math.min(5, Math.max(1, Number($('#set-tone').value) || 5)),
      allowProfanity: $('#set-profanity').checked,
    });
    return next;
  };

  $('#set-key').value = s.apiKey;
  $('#set-persist').checked = s.persistKey;
  $('#set-baseurl').value = s.baseUrl;
  $('#set-model').value = s.model;
  $('#set-tools').checked = s.enableTools;
  $('#set-tone').value = String(profile?.toneLevel ?? 5);
  $('#set-profanity').checked = profile?.allowProfanity ?? true;
  $('#set-status').textContent = '';
  $('#set-status').className = 'status';
  $('#diag-result').innerHTML = '';
  $('#btn-diag-copy').disabled = true;
  updateBaseUrlNotice();
  renderUsage(await getUsage());
  const updateReviewSyncStatus = () => {
    const status = getDailyReviewSyncStatus();
    const node = $('#review-sync-status');
    if (node) node.textContent = status.connected ? `已登录：${status.email} · ${status.message}` : status.message;
  };
  const updatePrivateSyncStatus = event => {
    const status = event?.detail || getPrivateSyncStatus();
    const node = $('#private-sync-status');
    if (node) node.textContent = status.connected ? `对话与档案：已登录 ${status.email} · ${status.message}` : status.message;
  };
  const formatBytes = value => {
    if (!Number.isFinite(value)) return '不可用';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  };
  const updateStorageUsage = async () => {
    const node = $('#storage-usage');
    if (!node) return;
    node.style.whiteSpace = 'pre-line';
    node.textContent = '正在读取存储用量…';
    try {
      const usage = await getStorageUsage();
      const browserText = usage.browserUsed == null
        ? '浏览器存储用量：当前浏览器不提供统计'
        : `当前网站浏览器存储：${formatBytes(usage.browserUsed)} / ${formatBytes(usage.browserQuota)} 配额`;
      const syncText = usage.syncedBytes == null
        ? usage.syncError ? `Supabase 同步存储：读取失败（${usage.syncError}）` : 'Supabase 同步存储：登录后可查看'
        : `Supabase 同步内容估算：${formatBytes(usage.syncedBytes)} · ${usage.syncedRows} 条记录`;
      node.textContent = `${syncText}\n${browserText}`;
    } catch (error) {
      node.textContent = `存储用量读取失败：${error.message || String(error)}`;
    }
  };
  updateReviewSyncStatus();
  updatePrivateSyncStatus();
  await updateStorageUsage();
  window.addEventListener('msa:private-sync-status', updatePrivateSyncStatus);

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-test').onclick = null;
      $('#btn-settings-close').onclick = null;
      $('#set-baseurl').oninput = null;
      $('#btn-clear-chat').onclick = null;
      $('#btn-diag').onclick = null;
      $('#btn-diag-copy').onclick = null;
      $('#btn-settings-export').onclick = null;
      $('#btn-settings-backup').onclick = null;
      $('#review-sync-login').onclick = null;
      $('#review-sync-signup').onclick = null;
      $('#review-sync-logout').onclick = null;
      $('#btn-refresh-storage').onclick = null;
      $('#btn-delete-all-conversations').onclick = null;
      $('#btn-delete-profile').onclick = null;
      window.removeEventListener('msa:private-sync-status', updatePrivateSyncStatus);
      if (dlg.returnValue === 'ok') {
        await collectAndSave();
        toast('设置已保存', 'ok');
        await onChange?.();
      }
      resolve(true);
    };
    dlg.addEventListener('close', onClose);
    $('#btn-settings-close').onclick = () => dlg.close('cancel');
    $('#btn-settings-export').onclick = () => onExport?.();
    $('#btn-settings-backup').onclick = () => onBackup?.();
    $('#set-baseurl').oninput = updateBaseUrlNotice;

    const runReviewAuth = async action => {
      const node = $('#review-sync-status');
      node.textContent = '正在连接…';
      try {
        const email = $('#review-sync-email').value.trim();
        const password = $('#review-sync-password').value;
        const result = action === 'login'
          ? await signInDailyReview(email, password)
          : action === 'signup'
            ? await signUpDailyReview(email, password)
            : await signOutDailyReview();
        await refreshPrivateSyncSession();
        updateReviewSyncStatus();
        updatePrivateSyncStatus();
        await updateStorageUsage();
        if (result?.needsConfirmation) node.textContent = '注册已提交，请按 Supabase 邮件提示完成验证。';
      } catch (error) {
        node.textContent = `连接失败：${error.message}`;
      }
    };
    $('#review-sync-login').onclick = () => runReviewAuth('login');
    $('#review-sync-signup').onclick = () => runReviewAuth('signup');
    $('#review-sync-logout').onclick = () => runReviewAuth('logout');
    $('#btn-refresh-storage').onclick = () => { void updateStorageUsage(); };
    $('#btn-delete-all-conversations').onclick = async () => {
      if (!confirm('删除本机保存的全部对话；登录云同步后也会删除云端副本。学习档案、任务和复盘不会删除。')) return;
      const count = await deleteAllConversations();
      toast(`已删除全部对话（${count} 个会话）`, 'ok');
      await onChange?.();
      await updateStorageUsage();
    };
    $('#btn-delete-profile').onclick = async () => {
      if (!confirm('删除本机学习档案；登录云同步后也会删除云端副本。任务、复盘和对话不会删除。')) return;
      await deleteProfile();
      toast('学习档案已删除', 'ok');
      await onChange?.();
      dlg.close('cancel');
    };

    $('#btn-test').onclick = async () => {
      const el = $('#set-status');
      el.className = 'status';
      el.textContent = '正在测试连接…';
      try {
        const r = await testConnection({
          baseUrl: $('#set-baseurl').value.trim(),
          apiKey: $('#set-key').value.trim(),
        });
        el.className = 'status ok';
        el.textContent = `连接成功。可用模型：${r.models.join('、') || '(未返回列表)'}`;
      } catch (e) {
        el.className = 'status err';
        el.textContent = `失败：${e.message}`;
      }
    };

    /* ── 诊断：分步定位到底哪一层断了 ── */
    let diagReport = '';

    const paintDiag = (steps, verdict) => {
      const box = $('#diag-result');
      const rows = steps.map(st => {
        const cls = st.ok === true ? 'ok' : st.ok === false ? 'bad' : '';
        const mark = st.ok === true ? '✅' : st.ok === false ? '❌' : 'ℹ️';
        return `<div class="diag-step ${cls}">
          <span class="d-mark">${mark}</span>
          <span>
            <span class="d-name">${esc(st.name)}</span>
            ${st.ms != null ? ` <span class="d-ms">${st.ms}ms</span>` : ''}
            <br><span class="d-detail">${esc(st.detail)}</span>
          </span>
        </div>`;
      }).join('');
      box.innerHTML = rows + (verdict ? `<div class="diag-verdict">${esc(verdict)}</div>` : '');
    };

    $('#btn-diag').onclick = async () => {
      const btn = $('#btn-diag');
      const copyBtn = $('#btn-diag-copy');
      btn.disabled = true;
      copyBtn.disabled = true;
      diagReport = '';
      const collected = [];
      paintDiag([{ name: '开始诊断', ok: null, detail: '会用真实请求依次检查：鉴权 → 基础对话 → 带工具 → 流式。稍等十几秒。' }]);

      try {
        // 先保存，保证测的是表单里填的 Key 和地址
        await collectAndSave();
        const result = await runDiagnostics((step) => {
          collected.push(step);
          paintDiag(collected);
        });
        diagReport = result.report;
        paintDiag(result.steps, result.verdict);
        copyBtn.disabled = false;
      } catch (e) {
        paintDiag(collected, `诊断过程本身出错了：${e.message}`);
      } finally {
        btn.disabled = false;
      }
    };

    $('#btn-diag-copy').onclick = async () => {
      if (!diagReport) return;
      try {
        await navigator.clipboard.writeText(diagReport);
        toast('诊断报告已复制到剪贴板', 'ok');
      } catch {
        // 剪贴板不可用（非 https / 无权限）时退回手动选择
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(`<pre style="white-space:pre-wrap;font:13px/1.6 monospace;padding:16px">${
            diagReport.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
          }</pre>`);
          w.document.title = '帕尼尼诊断报告';
        } else {
          toast('复制失败，请手动选中下方报告', 'err');
        }
      }
    };

    $('#btn-clear-chat').onclick = async () => {
      const sess = await getMeta('currentSession', null);
      if (sess) {
        await clearSessionMessages(sess);
      }
      toast('当前对话已清空', 'ok');
      await onChange?.();
    };
  });
}

/* ══════════════ 备份 ══════════════ */

async function refreshMirrorUI() {
  const state = await getMirrorState();
  const stateEl = $('#mirror-state');
  const helpEl = $('#mirror-help');

  if (!state.supported) {
    stateEl.textContent = '这个浏览器不支持自动镜像';
    helpEl.innerHTML = '自动镜像需要 File System Access API（Chrome / Edge 支持）。其他浏览器请定期手动导出。';
    $('#btn-mirror-on').disabled = true;
    return;
  }
  $('#btn-mirror-on').disabled = false;

  if (!state.enabled) {
    stateEl.textContent = '未开启';
    helpEl.innerHTML = '开启后每次数据变动会自动写到你选的 JSON 文件。<br>'
      + '<b>注意：</b>浏览器每次重新打开页面都会重置文件写权限，需要点一下「重新授权」。这是浏览器的安全限制，绕不过去。';
    return;
  }
  stateEl.textContent = `${state.fileName}　最后写入：${state.lastWriteAt ? state.lastWriteAt.slice(0, 19).replace('T', ' ') : '尚未写入'}`
    + (state.granted ? '' : '　⚠️ 需重新授权');
  helpEl.innerHTML = state.granted
    ? '镜像正常工作中。这个文件是普通 JSON，可以用 Git 管理你的记录历史。'
    : '浏览器已重置写权限，点「选择镜像文件」重新授权即可继续。';
}

export async function openBackup({ onChanged }) {
  const dlg = $('#dlg-backup');
  const status = $('#backup-status');
  status.textContent = '';
  status.className = 'status';
  await refreshMirrorUI();
  dlg.showModal();

  return new Promise(resolve => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-mirror-on').onclick = null;
      $('#btn-mirror-off').onclick = null;
      $('#btn-export-json').onclick = null;
      $('#btn-import').onclick = null;
      resolve(true);
    };
    dlg.addEventListener('close', onClose);

    $('#btn-mirror-on').onclick = async () => {
      try {
        const st = await getMirrorState();
        if (st.enabled) { await requestMirrorPermission(); toast('已重新授权', 'ok'); }
        else { await pickMirror(); toast('自动镜像已开启', 'ok'); }
        await refreshMirrorUI();
      } catch (e) {
        if (e.name === 'AbortError') return;
        status.className = 'status err';
        status.textContent = `失败：${e.message}`;
      }
    };

    $('#btn-mirror-off').onclick = async () => {
      await stopMirror();
      await refreshMirrorUI();
      toast('已停止自动镜像');
    };

    $('#btn-export-json').onclick = async () => {
      try {
        const data = await exportToDownload();
        const s = summarize(data);
        status.className = 'status ok';
        status.textContent = `已导出：${s.tasks} 任务 / ${s.topics} 知识点 / ${s.messages} 消息 / ${s.logs} 日志 / ${s.memories} 记忆`;
      } catch (e) {
        status.className = 'status err';
        status.textContent = `导出失败：${e.message}`;
      }
    };

    $('#btn-import').onclick = async () => {
      try {
        let data;
        try { data = await pickImportFile(); } catch (e) {
          status.className = 'status err';
          status.textContent = `读取失败：${e.message}`;
          return;
        }
        if (!data) return;
        const s = summarize(data);
        if (!confirm(`即将导入：\n${s.tasks} 任务 / ${s.topics} 知识点 / ${s.messages} 消息 / ${s.logs} 日志 / ${s.memories} 记忆\n\n方式：合并（同 id 以文件为准，不删除现有数据）\n\n继续？`)) return;
        await importFromObject(data, { mode: 'merge' });
        status.className = 'status ok';
        status.textContent = '导入成功。';
        toast('数据已导入', 'ok');
        await onChanged?.();
      } catch (e) {
        status.className = 'status err';
        status.textContent = `导入失败：${e.message}`;
      }
    };
  });
}

/* ══════════════ 任务 ══════════════ */

const fillSelect = (sel, map, current) => {
  sel.innerHTML = Object.entries(map)
    .map(([k, v]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${k} · ${v.label || v}</option>`)
    .join('');
};

export async function openTask(taskId = null, { onChanged, onKeyTask } = {}) {
  const dlg = $('#dlg-task');
  const isNew = !taskId;
  const task = isNew ? null : await db.tasks.get(taskId);
  if (!isNew && !task) { toast('找不到这个任务', 'err'); return false; }

  $('#task-title').textContent = isNew ? '新建任务' : '编辑任务';
  $('#task-id').value = task?.id || '';
  $('#task-name').value = task?.title || '';
  $('#task-goal').value = task?.goal || '';
  $('#task-state').value = task?.state || 'INBOX';
  $('#task-category').value = task?.category || (isNew || ['P0', 'P1'].includes(task?.priority) ? 'important' : 'chore');
  fillSelect($('#task-priority'), PRIORITIES, task?.priority || 'P2');
  fillSelect($('#task-area'), AREAS, task?.area || 'other');
  $('#task-due').value = task?.dueAt || '';
  $('#task-planned').value = task?.plannedStart ? task.plannedStart.slice(0, 16) : '';
  $('#task-estimate').value = task?.estimateMin ?? '';
  $('#task-next').value = task?.nextAction || '';
  $('#task-blocker').value = task?.blocker || '';
  $('#task-progress').value = task?.progress ?? 0;
  $('#task-outcome').value = task?.outcome || '';
  $('#task-review').value = task?.review || '';
  $('#btn-del-task').style.display = isNew ? 'none' : '';
  $('#btn-key-task').style.display = isNew ? 'none' : '';

  /* 时间信息只读展示 —— 这些字段由代码写，不让手改 */
  const meta = [];
  if (task?.actualStart) meta.push(`实际开始 ${fmtDateTime(task.actualStart)}`);
  if (task?.actualEnd) meta.push(`实际结束 ${fmtDateTime(task.actualEnd)}`);
  if (task?.actualMin != null) meta.push(`实际耗时 ${task.actualMin} 分钟`);
  if (task?.createdAt) meta.push(`创建 ${fmtDateTime(task.createdAt)}`);
  $('#task-meta').innerHTML = meta.length
    ? `<span class="hint">${meta.join('　·　')}<br>（这些字段由代码记录，不手工修改）</span>`
    : '';

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-task').onclick = null;
      $('#btn-key-task').onclick = null;
      if (dlg.returnValue !== 'ok') return resolve(false);

      try {
        const name = $('#task-name').value.trim();
        if (!name) { toast('任务名称不能为空', 'err'); return resolve(false); }

        const newState = $('#task-state').value;
        const payload = {
          id: task?.id,
          title: name,
          goal: $('#task-goal').value.trim(),
          category: $('#task-category').value,
          priority: $('#task-priority').value,
          area: $('#task-area').value,
          dueAt: $('#task-due').value,
          plannedStart: $('#task-planned').value,
          estimateMin: $('#task-estimate').value === '' ? null : Number($('#task-estimate').value),
          nextAction: $('#task-next').value.trim(),
          blocker: $('#task-blocker').value.trim(),
          progress: Number($('#task-progress').value) || 0,
          outcome: $('#task-outcome').value.trim(),
          review: $('#task-review').value.trim(),
        };

        const saved = await upsertTask(payload);
        if (task && newState !== task.state) {
          await setTaskState(saved.id, newState);
        }
        if (newState === 'BLOCKED' && !payload.blocker) {
          toast('标成 BLOCKED 但没写阻碍是什么 —— 说清卡在哪才有意义', 'warn');
        }
        toast(isNew ? '任务已创建' : '任务已保存', 'ok');
        await onChanged?.();
        resolve(true);
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-key-task').onclick = async () => {
      if (!task) return;
      const rec = await getMeta('keyTasks', null);
      const ids = (rec?.date === new Date().toISOString().slice(0, 10) ? rec.ids : []) || [];
      if (ids.includes(task.id)) { toast('它已经在今日关键任务里了'); return; }
      if (ids.length >= 3) { toast('每天最多 3 个关键任务', 'err'); return; }
      await setKeyTasks([...ids, task.id]);
      toast('已设为今日关键任务', 'ok');
      dlg.close('cancel');
      await onChanged?.();
      onKeyTask?.();
    };

    $('#btn-del-task').onclick = async () => {
      if (!task) return;
      await deleteTask(task.id);
      dlg.close('cancel');
      toast('任务已删除');
      await onChanged?.();
    };
  });
}

/* ══════════════ 知识点 ══════════════ */

export async function openTopic(topicId = null, { onChanged } = {}) {
  const dlg = $('#dlg-topic');
  const isNew = !topicId;
  const topic = isNew ? null : await db.topics.get(topicId);
  if (!isNew && !topic) { toast('找不到这个知识点', 'err'); return false; }
  const tasks = await listTasks();

  $('#topic-title').textContent = isNew ? '新建知识点' : '编辑知识点';
  $('#topic-id').value = topic?.id || '';
  $('#topic-name').value = topic?.name || '';
  $('#topic-note').value = topic?.note || '';
  $('#topic-task').innerHTML = '<option value="">（不归属任何任务）</option>'
    + tasks.map(t => `<option value="${t.id}" ${topic?.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  $('#btn-del-topic').style.display = isNew ? 'none' : '';
  $('#topic-meta').innerHTML = topic
    ? `<span class="hint">掌握度 ${topic.mastery ?? 0}/5　复习 ${topic.reps || 0} 次　间隔 ${topic.interval || 0} 天　下次 ${(topic.nextReviewAt || '').slice(0, 10)}<br>（掌握度和复习排期由间隔重复算法算，不手工改）</span>`
    : '';

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-topic').onclick = null;
      if (dlg.returnValue !== 'ok') return resolve(false);
      try {
        const name = $('#topic-name').value.trim();
        if (!name) { toast('知识点名称不能为空', 'err'); return resolve(false); }
        await upsertTopic({
          id: topic?.id, name,
          note: $('#topic-note').value.trim(),
          taskId: $('#topic-task').value,
        });
        toast(isNew ? '已创建，明天安排首次复习' : '已保存', 'ok');
        await onChanged?.();
        resolve(true);
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-del-topic').onclick = async () => {
      if (!topic) return;
      await deleteTopic(topic.id);
      dlg.close('cancel');
      toast('已删除');
      await onChanged?.();
    };
  });
}

/* ══════════════ 复习 ══════════════ */

export async function openReview({ onChanged } = {}) {
  const dlg = $('#dlg-review');
  const body = $('#review-body');
  const endISO = endOfToday();
  let queue = dueTopics(await listTopics(), endISO);
  const total = queue.length;
  let done = 0;

  const render = () => {
    if (!queue.length) {
      body.innerHTML = total
        ? `<div class="card ok"><div class="card-title">复习完了 🎉</div>
           <div class="card-sub">这次处理了 ${done} 个知识点。下次到期时我会在侧栏提醒。</div></div>`
        : '<div class="empty">今天没有到期的复习。</div>';
      return;
    }
    const t = queue[0];
    const dots = [0, 1, 2, 3, 4].map(i => `<i class="dot ${i < (t.mastery ?? 0) ? 'on' : ''}"></i>`).join('');
    body.innerHTML = `
      <div class="hint" style="margin-bottom:8px">还剩 ${queue.length} / ${total} 个</div>
      <div class="review-card">
        <div class="r-name">${esc(t.name)}</div>
        <div class="hint" style="margin-bottom:8px">掌握度 <span class="dots">${dots}</span>　已复习 ${t.reps || 0} 次　间隔 ${t.interval || 0} 天</div>
        ${t.note ? `<div class="r-note">${esc(t.note)}</div>` : '<div class="hint">（没有备注）</div>'}
      </div>
      <div class="hint" style="margin-bottom:6px">先在脑子里回想一遍，再如实选 —— 评得越诚实，排期越准。</div>
      <div class="grades">
        ${GRADES.map(g => `<button data-grade="${g.g}"><b>${g.label}</b><span>${g.hint}</span></button>`).join('')}
      </div>`;
    $$('[data-grade]', body).forEach(btn => {
      btn.onclick = async () => {
        const grade = Number(btn.dataset.grade);
        const cur = queue.shift();
        try {
          const r = await gradeTopic(cur.id, grade);
          done++;
          toast(`「${cur.name}」→ 下次${describeInterval(r.dueInDays)}`, 'ok');
        } catch (e) {
          toast(`记录失败：${e.message}`, 'err');
        }
        await onChanged?.();
        render();
      };
    });
  };

  render();
  dlg.showModal();
  return new Promise(resolve => {
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(done); };
    dlg.addEventListener('close', onClose);
  });
}

/* ══════════════ 会话 ══════════════ */

export async function openSessions({ onChanged } = {}) {
  const dlg = $('#dlg-session');
  const el = $('#session-list');

  const refresh = async () => {
    const sessions = await listSessions();
    const current = await getMeta('currentSession', null);
    if (!sessions.length) { el.innerHTML = '<div class="empty">还没有会话。</div>'; return; }

    el.innerHTML = sessions.map(s => `
      <div class="task-item" data-sess="${s.id}" style="padding:8px 10px">
        <div class="t-head">
          <span class="t-name">${esc(s.title || '(未命名会话)')}</span>
          ${s.id === current ? '<span class="badge st-doing">当前</span>' : ''}
          <button class="mini" data-del="${s.id}" title="删除这个会话">×</button>
        </div>
        <div class="t-meta">${s.messageCount} 条消息　更新于 ${fmtDateTime(s.updatedAt)}</div>
      </div>`).join('');

    $$('[data-sess]', el).forEach(node => {
      const id = node.dataset.sess;
      node.onclick = async e => {
        if (e.target.closest('[data-del]')) return;
        if (id === current) { dlg.close(); return; }
        const s = await db.sessions.get(id);
        if (!(await confirmSessionSwitch(s.title || '未命名会话'))) return;
        await switchSession(id);
        dlg.close();
        toast('已切换会话', 'ok');
        await onChanged?.();
      };
    });

    $$('[data-del]', el).forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        await deleteSession(btn.dataset.del);
        toast('会话已删除', 'ok');
        await refresh();
        await onChanged?.();
      };
    });
  };

  await refresh();
  dlg.showModal();
  return new Promise(resolve => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-new-session').onclick = null;
      resolve(true);
    };
    dlg.addEventListener('close', onClose);
    $('#btn-new-session').onclick = async () => {
      await createSession();
      dlg.close();
      toast('已新建会话', 'ok');
      await onChanged?.();
    };
  });
}

/* ══════════════ 档案（§四）═════════════ */

function confirmSessionSwitch(title) {
  const dlg = $('#dlg-session-switch');
  $('#session-switch-message').textContent = `切换到「${title}」？每个会话有自己的对话上下文和摘要，但任务、打卡、积分、复盘、档案都是共享的。`;

  return new Promise(resolve => {
    let settled = false;
    const confirmButton = $('#btn-session-switch-confirm');
    const cancelButton = $('#btn-session-switch-cancel');
    const finish = value => {
      if (settled) return;
      settled = true;
      confirmButton.onclick = null;
      cancelButton.onclick = null;
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(value);
    };
    const onCancel = event => {
      event.preventDefault();
      finish(false);
    };

    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

export async function openProfile({ onChanged } = {}) {
  const dlg = $('#dlg-profile');
  const p = await getProfile();
  const c = profileCompletion(p);

  const set = (id, v) => { $(id).value = v ?? ''; };
  set('#pf-username', p.userName);
  set('#pf-supervisor', p.supervisorName);
  set('#pf-problems', p.topProblems);
  set('#pf-about', p.about);
  set('#pf-goals', p.goals);
  set('#pf-focus', p.focusAreas);
  set('#pf-learning-preferences', p.learningPreferences);
  set('#pf-available-time', p.availableTime);
  set('#pf-constraints', p.constraints);
  set('#pf-procrast', p.procrastinationPatterns);
  set('#pf-reward', p.rewardPreference);
  set('#pf-corrections', p.acceptableCorrections);
  set('#pf-taboos', (p.taboos || []).join('\n'));
  set('#pf-other', p.otherNeeds);

  $('#profile-status').innerHTML = c.isOnboarded
    ? `<span class="hint">学习档案已整理。核心信息 ${c.requiredDone}/${c.requiredTotal}，补充信息 ${c.optionalDone}/${c.optionalTotal}。</span>`
    : `<span class="hint">核心信息 ${c.requiredDone}/${c.requiredTotal}。还可补充：${c.missingRequired.map(k => ({ about: '学习背景', goals: '学习目标', focusAreas: '当前学习重点', learningPreferences: '学习方式' })[k] || k).join('、') || '可标记整理完成'}。</span>`;

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-pf-onboarded').onclick = null;
      if (dlg.returnValue !== 'ok') return resolve(false);
      try {
        const patch = {
          userName: $('#pf-username').value.trim(),
          supervisorName: $('#pf-supervisor').value.trim() || '帕尼尼',
          topProblems: $('#pf-problems').value.trim(),
          about: $('#pf-about').value.trim(),
          goals: $('#pf-goals').value.trim(),
          focusAreas: $('#pf-focus').value.trim(),
          learningPreferences: $('#pf-learning-preferences').value.trim(),
          availableTime: $('#pf-available-time').value.trim(),
          constraints: $('#pf-constraints').value.trim(),
          procrastinationPatterns: $('#pf-procrast').value.trim(),
          rewardPreference: $('#pf-reward').value.trim(),
          acceptableCorrections: $('#pf-corrections').value.trim(),
          taboos: $('#pf-taboos').value.split('\n').map(x => x.trim()).filter(Boolean),
          otherNeeds: $('#pf-other').value.trim(),
        };
        const saved = await saveProfile(patch);
        const after = profileCompletion(saved);
        if (after.canStart && !saved.onboardedAt) {
          if (confirm('学习档案核心信息已经齐了。标记为「整理完成」吗？')) {
            await saveProfile({ onboardedAt: new Date().toISOString() });
          }
        }
        toast('档案已保存', 'ok');
        await onChanged?.();
        resolve(true);
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-pf-onboarded').onclick = async () => {
      await saveProfile({ onboardedAt: new Date().toISOString() });
      toast('已标记学习档案整理完成', 'ok');
      dlg.close('cancel');
      await onChanged?.();
    };
  });
}

/* ══════════════ 选今日关键任务 ══════════════ */

export async function openKeyTasks({ onChanged } = {}) {
  const dlg = $('#dlg-key');
  const el = $('#key-list');
  const tasks = (await listTasks()).filter(t => !['DONE', 'CANCELLED'].includes(t.state));
  const rec = await getMeta('keyTasks', null);
  const today = new Date().toISOString().slice(0, 10);
  let selected = new Set((rec?.date === today ? rec.ids : []) || []);

  const render = () => {
    if (!tasks.length) {
      el.innerHTML = '<div class="empty">没有可选的活跃任务。先去建一个。</div>';
      return;
    }
    el.innerHTML = tasks.map(t => `
      <div class="task-item" data-pick="${t.id}" style="padding:8px 10px;${selected.has(t.id) ? 'border-color:var(--warn);background:var(--warn-soft)' : ''}">
        <div class="t-head">
          <span class="t-name">${selected.has(t.id) ? '★ ' : '　'}${esc(t.title)}</span>
          ${stateBadge(t.state)}
          ${t.dueAt ? `<span class="badge ${daysUntil(t.dueAt) < 0 ? 'overdue' : ''}">${esc(t.dueAt)}</span>` : ''}
        </div>
      </div>`).join('');
    $$('[data-pick]', el).forEach(n => {
      n.onclick = () => {
        const id = n.dataset.pick;
        if (selected.has(id)) { selected.delete(id); render(); return; }
        if (selected.size >= 3) { toast('§5.3：每天最多 3 个关键任务', 'err'); return; }
        selected.add(id);
        render();
      };
    });
  };

  render();
  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      await setKeyTasks([...selected]);
      await onChanged?.();
      resolve(true);
    };
    dlg.addEventListener('close', onClose);
  });
}

/* ══════════════ 规划 ══════════════ */

export async function openPlan(planId = null, { onChanged } = {}) {
  const dlg = $('#dlg-plan');
  const isNew = !planId;
  let plan = isNew ? null : await getPlan(planId);
  if (!isNew && !plan) {
    const list = await listPlans({});
    plan = list[0] || null;
  }

  $('#plan-title').textContent = plan ? `编辑规划 ${plan.code}` : '新建规划';
  $('#plan-id').value = plan?.id || '';
  $('#plan-name').value = plan?.name || '';
  $('#plan-available').value = plan?.availableMin ?? '';
  $('#plan-deadline').value = plan?.deadline || '';
  $('#plan-goal').value = plan?.goal || '';
  $('#plan-items').value = (plan?.items || []).map(i =>
    [i.text, i.minAction, i.estMin ?? ''].join(' | ').replace(/ \| $/, '')).join('\n');
  $('#plan-risks').value = (plan?.risks || []).join('、');
  $('#plan-fallback').value = plan?.fallback || '';
  $('#plan-criteria').value = plan?.doneCriteria || '';
  $('#btn-del-plan').style.display = plan ? '' : 'none';

  const updateMeta = () => {
    const items = parseItems($('#plan-items').value);
    const check = checkFeasibility({ items, availableMin: $('#plan-available').value });
    $('#plan-meta').innerHTML = `<span class="hint">${esc(check.verdict)}</span>`;
  };
  const parseItems = text => text.split('\n').map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (!parts[0]) return null;
    return normalizePlanItem({ text: parts[0], minAction: parts[1] || '', estMin: parts[2] || null });
  }).filter(Boolean);

  updateMeta();
  $('#plan-items').oninput = updateMeta;
  $('#plan-available').oninput = updateMeta;

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-plan').onclick = null;
      $('#plan-items').oninput = null;
      $('#plan-available').oninput = null;
      if (dlg.returnValue !== 'ok') return resolve(false);
      try {
        const name = $('#plan-name').value.trim();
        if (!name) { toast('规划必须有名称', 'err'); return resolve(false); }
        const { plan: saved, feasibility } = await savePlan({
          id: plan?.id,
          name,
          goal: $('#plan-goal').value.trim(),
          deadline: $('#plan-deadline').value.trim(),
          availableMin: $('#plan-available').value === '' ? null : Number($('#plan-available').value),
          items: parseItems($('#plan-items').value),
          risks: $('#plan-risks').value.split(/[、,，]/).map(x => x.trim()).filter(Boolean),
          fallback: $('#plan-fallback').value.trim(),
          doneCriteria: $('#plan-criteria').value.trim(),
        });
        toast(`${saved.code} 已保存${feasibility.feasible === false ? '（⚠️ 计划过载）' : ''}`, feasibility.feasible === false ? 'warn' : 'ok');
        await onChanged?.();
        resolve(true);
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-del-plan').onclick = async () => {
      if (!plan) return;
      await deletePlan(plan.id);
      dlg.close('cancel');
      toast('已删除');
      await onChanged?.();
    };
  });
}

/* ══════════════ SOP ══════════════ */

export async function openSop(sopId = null, { onChanged } = {}) {
  const dlg = $('#dlg-sop');
  const isNew = !sopId;
  let sop = isNew ? null : await getSop(sopId);
  if (!isNew && !sop) {
    const list = await (await import('./docs.js')).listSops({});
    sop = list[0] || null;
  }

  const toLines = arr => (arr || []).map(x => (typeof x === 'string' ? x : x.text)).join('\n');

  $('#sop-title').textContent = sop ? '编辑 SOP' : '新建 SOP';
  $('#sop-id').value = sop?.id || '';
  $('#sop-name').value = sop?.name || '';
  $('#sop-scene').value = sop?.scene || '';
  $('#sop-goal').value = sop?.goal || '';
  $('#sop-estimate').value = sop?.estimateMin ?? '';
  $('#sop-quick').value = sop?.quickStart || '';
  $('#sop-materials').value = (sop?.materials || []).join('、');
  $('#sop-prep').value = toLines(sop?.prep);
  $('#sop-steps').value = toLines(sop?.steps);
  $('#sop-blockers').value = toLines(sop?.blockers);
  $('#sop-exceptions').value = sop?.exceptions || '';
  $('#sop-criteria').value = sop?.doneCriteria || '';
  $('#sop-checklist').value = toLines(sop?.checklist);
  $('#sop-review').value = sop?.review || '';
  $('#btn-del-sop').style.display = sop ? '' : 'none';
  $('#sop-meta').innerHTML = '<span class="hint">§15 要求的 12 项：名称/适用场景/执行目标/所需材料/预计耗时/执行前准备/详细步骤/常见阻碍/异常处理/完成标准/检查清单/复盘与改进。<br>「一分钟启动版」是为启动困难时准备的入口，必填。</span>';

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-sop').onclick = null;
      if (dlg.returnValue !== 'ok') return resolve(false);
      const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
      try {
        const saved = await saveSop({
          id: sop?.id,
          name: $('#sop-name').value.trim(),
          scene: $('#sop-scene').value.trim(),
          goal: $('#sop-goal').value.trim(),
          materials: $('#sop-materials').value.split(/[、,，]/).map(x => x.trim()).filter(Boolean),
          estimateMin: $('#sop-estimate').value === '' ? null : Number($('#sop-estimate').value),
          prep: lines('#sop-prep'),
          steps: lines('#sop-steps'),
          blockers: lines('#sop-blockers'),
          exceptions: $('#sop-exceptions').value.trim(),
          doneCriteria: $('#sop-criteria').value.trim(),
          checklist: lines('#sop-checklist'),
          review: $('#sop-review').value.trim(),
          quickStart: $('#sop-quick').value.trim(),
        });
        toast(`SOP「${saved.name}」已保存`, 'ok');
        await onChanged?.();
        resolve(true);
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-del-sop').onclick = async () => {
      if (!sop) return;
      await deleteSop(sop.id);
      dlg.close('cancel');
      toast('已删除');
      await onChanged?.();
    };
  });
}

/* ══════════════ 专注记录（编辑 / 补记）═════════════ */

const SOURCE_LABEL = {
  timer: '真实计时', reported: '用户自报', reported_range: '自报起止', manual: '手动补记',
};

/**
 * 打开一条专注记录的编辑框。
 * @param {string|null} entryId 传 null 表示补记新的一条
 */
export async function openTimeEntry(entryId = null, { onChanged, date = null } = {}) {
  const dlg = $('#dlg-time');
  const isNew = !entryId;
  const entry = isNew ? null : await getTimeEntry(entryId);
  if (!isNew && !entry) { toast('找不到这条记录', 'err'); return false; }

  const tasks = await listTasks();
  $('#time-title').textContent = isNew ? '补记一段专注' : '编辑专注记录';
  $('#time-id').value = entry?.id || '';
  $('#time-task').innerHTML = '<option value="">（不关联任务）</option>'
    + tasks.map(t => `<option value="${t.id}" ${entry?.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  $('#time-note').value = entry?.note || '';
  $('#time-outcome').value = entry?.outcome || '';
  $('#btn-del-time').style.display = isNew ? 'none' : '';

  if (isNew) {
    // 补记：给一个当天 09:00 起、30 分钟的空档，用户自己改
    const base = date || dateStr();
    $('#time-start').value = `${base}T09:00`;
    $('#time-end').value = `${base}T09:30`;
    $('#time-minutes').value = '';
  } else {
    $('#time-start').value = toLocalInput(entry.startedAt);
    $('#time-end').value = toLocalInput(entry.endedAt);
    $('#time-minutes').value = entry.actualMin ?? '';
  }

  const asLocalInput = date => {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const minutesBetween = () => {
    const s = fromLocalInput($('#time-start').value);
    const e = fromLocalInput($('#time-end').value);
    if (!s || !e) return null;
    const diff = Math.round((new Date(e) - new Date(s)) / 60000);
    return diff > 0 && diff <= 24 * 60 ? diff : null;
  };
  const refreshDerived = () => {
    const el = $('#time-derived');
    const duration = minutesBetween();
    const minutes = $('#time-minutes').value;
    el.innerHTML = duration !== null
      ? `记录时长：<b>${duration} 分钟</b>。改时长会同步结束时间。`
      : minutes !== '' && Number(minutes) > 0
        ? '请检查起止时间，或填写有效时长。'
        : '<span style="color:var(--danger)">结束时间必须晚于开始时间，或填写有效时长。</span>';
  };
  const syncFromRange = () => {
    const duration = minutesBetween();
    if (duration !== null) $('#time-minutes').value = String(duration);
    refreshDerived();
  };
  const syncEndFromDuration = () => {
    const start = fromLocalInput($('#time-start').value);
    const minutes = Number($('#time-minutes').value);
    if (start && Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60) {
      $('#time-end').value = asLocalInput(new Date(new Date(start).getTime() + minutes * 60000));
    }
    refreshDerived();
  };
  refreshDerived();

  const meta = [];
  if (!isNew) {
    meta.push(`来源：${SOURCE_LABEL[entry.source] || entry.source}`);
    if (entry.source === 'timer' && entry.plannedMin) meta.push(`当时计划 ${entry.plannedMin} 分钟`);
    if (entry.driftMin) meta.push(`自报与计时相差 ${entry.driftMin > 0 ? '+' : ''}${entry.driftMin} 分钟`);
    if (entry.edited) meta.push(`上次修正 ${fmtDateTime(entry.editedAt)}`);
    meta.push(`创建于 ${fmtDateTime(entry.createdAt)}`);
  }
  $('#time-meta').innerHTML = meta.length ? `<span class="hint">${esc(meta.join('　·　'))}</span>` : '';

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-time').onclick = null;
      $('#time-start').oninput = null;
      $('#time-end').oninput = null;
      $('#time-minutes').oninput = null;
      if (dlg.returnValue !== 'ok') return resolve(false);

      try {
        const s = fromLocalInput($('#time-start').value);
        const e = fromLocalInput($('#time-end').value);
        const minRaw = $('#time-minutes').value;
        const minutes = minRaw === '' ? null : Number(minRaw);

        if (isNew) {
          await createManualEntry({
            taskId: $('#time-task').value,
            startedAt: s,
            endedAt: e,
            actualMin: minutes,
            note: $('#time-note').value,
            outcome: $('#time-outcome').value,
            date: date || dateStr(),
          });
          toast('已补记一段专注', 'ok');
        } else {
          await updateTimeEntry(entry.id, {
            taskId: $('#time-task').value,
            startedAt: s,
            endedAt: e,
            // 留空时不传 actualMin，让代码按起止时间推导
            ...(minutes === null ? {} : { actualMin: minutes }),
            note: $('#time-note').value,
            outcome: $('#time-outcome').value,
          });
          toast('记录已更新', 'ok');
        }
        await onChanged?.();
        resolve(true);
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
        resolve(false);
      }
    };

    $('#time-start').oninput = syncFromRange;
    $('#time-end').oninput = syncFromRange;
    $('#time-minutes').oninput = syncEndFromDuration;
    dlg.addEventListener('close', onClose);

    $('#btn-del-time').onclick = async () => {
      if (!entry) return;
      await deleteTimeEntry(entry.id);
      dlg.close('cancel');
      toast('已删除', 'ok');
      await onChanged?.();
    };
  });
}

/* ══════════════ 学习记录（编辑 / 补记）═════════════ */

export async function openLogEntry(logId = null, { onChanged, date = null } = {}) {
  const dlg = $('#dlg-log');
  const isNew = !logId;
  const rec = isNew ? null : await getLog(logId);
  if (!isNew && !rec) { toast('找不到这条学习记录', 'err'); return false; }

  const tasks = await listTasks();
  $('#log-title').textContent = isNew ? '补记一条学习记录' : '编辑学习记录';
  $('#log-id').value = rec?.id || '';
  $('#log-date').value = rec?.date || date || dateStr();
  $('#log-minutes').value = rec?.minutes ?? (isNew ? 30 : '');
  $('#log-topic').value = rec?.topicName || '';
  $('#log-what').value = rec?.what || '';
  $('#log-blockers').value = rec?.blockers || '';
  $('#log-task').innerHTML = '<option value="">（不关联任务）</option>'
    + tasks.map(t => `<option value="${t.id}" ${rec?.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  $('#btn-del-log').style.display = isNew ? 'none' : '';
  $('#log-meta').innerHTML = (!isNew && rec?.edited)
    ? `<span class="hint">上次修正 ${fmtDateTime(rec.editedAt)}</span>` : '';

  dlg.showModal();
  return new Promise(resolve => {
    const onClose = async () => {
      dlg.removeEventListener('close', onClose);
      $('#btn-del-log').onclick = null;
      if (dlg.returnValue !== 'ok') return resolve(false);
      try {
        const patch = {
          date: $('#log-date').value,
          minutes: $('#log-minutes').value,
          topicName: $('#log-topic').value,
          what: $('#log-what').value,
          blockers: $('#log-blockers').value,
          taskId: $('#log-task').value,
        };
        if (isNew) {
          await createLog({ ...patch, date: patch.date || dateStr() });
          toast('已补记一条学习记录', 'ok');
        } else {
          await updateLog(rec.id, patch);
          toast('记录已更新', 'ok');
        }
        await onChanged?.();
        resolve(true);
      } catch (err) {
        toast(`保存失败：${err.message}`, 'err');
        resolve(false);
      }
    };
    dlg.addEventListener('close', onClose);

    $('#btn-del-log').onclick = async () => {
      if (!rec) return;
      await deleteLog(rec.id);
      dlg.close('cancel');
      toast('已删除', 'ok');
      await onChanged?.();
    };
  });
}

/* ══════════════ 奖励编辑 ══════════════ */

export async function openRewardEditor({ onChanged } = {}) {
  const name = prompt('奖励名称：', '');
  if (!name) return;
  const costRaw = prompt('需要多少积分兑换：', '10');
  if (costRaw === null) return;
  try {
    const r = await upsertReward({ name: name.trim(), cost: Number(costRaw) || 0 });
    toast(`奖励「${r.name}」已添加（${r.cost} 分）`, 'ok');
    await onChanged?.();
  } catch (e) {
    toast(`添加失败：${e.message}`, 'err');
  }
}
