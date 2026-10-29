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
  await download(`学习助手备份-${dateStr()}.json`, prettyExport(data));
  return data;
}

/**
 * 备份文件名。带日期，方便按天找回；同一天导两次会提示覆盖（由系统文件选择器负责）。
 */
export function backupFileName(prefix = '学习助手备份') {
  return `${prefix}-${dateStr()}.json`;
}

/**
 * 系统文件选择器（Android 壳里注册的 AppFiles 插件）。
 * WebView 默认没有可靠的"选文件/存文件"能力：<input type=file> 在部分机型上
 * 根本不弹框，<a download> 也不会真的落盘。所以原生端走 SAF：
 *   · 导出 → ACTION_CREATE_DOCUMENT，用户自己挑保存位置
 *   · 导入 → ACTION_OPEN_DOCUMENT，用户自己挑文件
 * 网页端（含手机浏览器）仍用 Blob 下载 + <input type=file>。
 */
async function filesPlugin() {
  if (!globalThis.Capacitor?.isNativePlatform?.()) return null;
  const { Capacitor } = await import('@capacitor/core');
  return Capacitor.Plugins?.AppFiles || Capacitor.registerPlugin('AppFiles');
}

const isCancel = error => /cancel|abort/i.test(error?.message || String(error || ''));

/**
 * 导出备份。返回 { data, fileName, savedVia }，savedVia 说明这份文件是怎么交出去的：
 * 'native' 系统文件选择器 / 'share' 系统分享面板 / 'web' 浏览器下载。
 */
export async function exportBackup({ prefix = '学习助手备份' } = {}) {
  const data = await exportAll();
  const text = prettyExport(data);
  const fileName = backupFileName(prefix);
  const native = Boolean(globalThis.Capacitor?.isNativePlatform?.());

  const plugin = await filesPlugin().catch(() => null);
  if (plugin) {
    try {
      await plugin.saveTextFile({ name: fileName, text, mime: 'application/json' });
      return { data, fileName, savedVia: 'native', summary: summarize(data) };
    } catch (error) {
      if (isCancel(error)) return { data, fileName, savedVia: 'cancelled', cancelled: true };
      // 插件不在（旧版本 APK）或系统没有文件选择器：退回系统分享面板，别让用户白点一次。
      console.warn('[backup-save-native]', error);
    }
  }

  await download(fileName, text);
  return { data, fileName, savedVia: native ? 'share' : 'web', summary: summarize(data) };
}

/** 校验备份文件内容；不是这个应用导出的就直说，别静默合并出半套数据。 */
export function parseBackup(text, name = '') {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    throw new Error(`${name || '文件'} 不是合法 JSON（可能选错了文件）`);
  }
  if (!data?.stores) throw new Error(`${name || '文件'} 里没有 stores 字段，不像是本应用的备份`);
  return data;
}

/**
 * 选一个备份文件并解析。原生端优先用系统文件选择器，
 * 网页端退回 <input type=file>。用户取消返回 null。
 */
export async function pickBackupFile() {
  const plugin = await filesPlugin().catch(() => null);
  if (plugin) {
    try {
      const result = await plugin.pickTextFile({ mime: 'application/json' });
      if (!result?.text) return null;
      return { data: parseBackup(result.text, result.name), fileName: result.name || '' };
    } catch (error) {
      if (isCancel(error)) return null;
      throw error;
    }
  }
  const data = await pickImportFile();
  return data ? { data, fileName: '' } : null;
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
