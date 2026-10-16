// ── 备份：把 IndexedDB 镜像到你磁盘上的真实文件 ────────────────
//
// 浏览器里的数据随时可能因为清缓存、换浏览器、换电脑而消失。手动导出
// 靠不住（人会忘），所以这里用 File System Access API 把每次改动自动写
// 到你自己选定的一个 JSON 文件上。这个文件是普通文件，可以 Git 管起来。

import { exportAll, importAll, getMeta, setMeta, prettyExport } from './db.js';
import { dateStr, debounce, download } from './util.js';

export const mirrorSupported = () =>
  typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/* ══════════ 手动导出 / 导入 ══════════ */

export async function exportToDownload() {
  const data = await exportAll();
  download(`学习助手备份-${dateStr()}.json`, prettyExport(data));
  return data;
}

export function pickImportFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch (e) {
          reject(new Error('文件不是合法 JSON'));
        }
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsText(file);
    };
    input.click();
  });
}

export async function importFromObject(data, { mode = 'merge' } = {}) {
  await importAll(data, { mode });
  return summarize(data);
}

export function summarize(data) {
  const s = data?.stores || {};
  return {
    exportedAt: data?.exportedAt || '(未知)',
    tasks: s.tasks?.length ?? 0,
    topics: s.topics?.length ?? 0,
    messages: s.messages?.length ?? 0,
    logs: s.logs?.length ?? 0,
    memories: s.memories?.length ?? 0,
  };
}

/* ══════════ 自动镜像 ══════════ */

async function ensurePermission(handle, { request = false } = {}) {
  if (!handle?.queryPermission) return true; // 老实现没有权限 API，直接试
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!request) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

export async function getMirrorState() {
  const handle = await getMeta('mirrorHandle', null);
  if (!handle) return { enabled: false, supported: mirrorSupported() };
  return {
    enabled: true,
    supported: true,
    fileName: handle.name || '(未知文件)',
    granted: await ensurePermission(handle, { request: false }),
    lastWriteAt: await getMeta('mirrorLastWrite', null),
    lastError: await getMeta('mirrorLastError', null),
  };
}

/** 让用户挑一个文件当镜像目标。必须是用户手势触发（按钮点击）。 */
export async function pickMirror() {
  if (!mirrorSupported()) {
    throw new Error('这个浏览器不支持文件写入（Chrome / Edge 可用）。请改用「导出 JSON」手动备份。');
  }
  const handle = await window.showSaveFilePicker({
    suggestedName: `学习助手-记忆镜像.json`,
    types: [{ description: 'JSON 备份', accept: { 'application/json': ['.json'] } }],
  });
  await setMeta('mirrorHandle', handle);
  await setMeta('mirrorLastError', null);
  await writeMirror({ force: true });
  return getMirrorState();
}

export async function stopMirror() {
  await setMeta('mirrorHandle', null);
  await setMeta('mirrorLastWrite', null);
}

/**
 * 写镜像。permissionGranted 为 false 时不报错，只是静默跳过 ——
 * 每次刷新页面后浏览器会重置写权限，需要用户点一下按钮重新授权。
 */
export async function writeMirror({ force = false } = {}) {
  const handle = await getMeta('mirrorHandle', null);
  if (!handle) return { written: false, reason: 'not-configured' };

  const granted = await ensurePermission(handle, { request: force });
  if (!granted) {
    await setMeta('mirrorLastError', '需要重新授权文件写入权限');
    return { written: false, reason: 'permission' };
  }

  try {
    const data = await exportAll();
    const writable = await handle.createWritable();
    await writable.write(prettyExport(data));
    await writable.close();
    const at = new Date().toISOString();
    await setMeta('mirrorLastWrite', at);
    await setMeta('mirrorLastError', null);
    return { written: true, at };
  } catch (e) {
    await setMeta('mirrorLastError', e?.message || String(e));
    return { written: false, reason: 'error', error: e };
  }
}

/** 数据变动后调用，2 秒内的连续改动合并成一次写入 */
export const scheduleMirror = debounce(() => {
  writeMirror().catch(e => console.warn('[mirror]', e));
}, 2000);

export async function requestMirrorPermission() {
  return writeMirror({ force: true });
}

/** 从镜像文件读回来（数据丢了或换电脑时的恢复路径） */
export async function loadFromMirror() {
  const handle = await getMeta('mirrorHandle', null);
  if (!handle) {
    throw new Error('还没有设置镜像文件。请先用「导入 JSON」手动选文件。');
  }
  const file = await handle.getFile();
  const text = await file.text();
  const data = JSON.parse(text);
  return data;
}
