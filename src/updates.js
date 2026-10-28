// ── 应用自动更新（Android）───────────────────────────────────────
//
// 网页端不需要更新（刷新就是最新），所以这里查到的 supported 是 false。
// 原生调用一律懒加载：模块顶层不能出现裸模块导入（见 src/native.js）。
//
// 链路：启动 → 每天最多一次查 GitHub Releases → 有新版本就用系统
// DownloadManager 在 Wi-Fi 下下载 APK → 用户点「安装」走系统安装器覆盖升级
// （app data 保留）。

import { isAndroidPlatform } from './native.js';

const RELEASES_URL = 'https://api.github.com/repos/qiuyinlan/my_study_agent/releases?per_page=10';
const CHECKED_AT_KEY = 'msa.update.checked-at.v1';
const RESULT_KEY = 'msa.update.latest.v1';
const LAST_NOTICE_KEY = 'msa.update.notice-version.v1';
const DOWNLOAD_ID_KEY = 'msa.update.download-id.v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
export const isAndroidApp = () => isAndroidPlatform();

let updater = null;
/** 拿到自定义的 AppUpdater 插件（Android 壳里注册的）。 */
async function updaterPlugin() {
  if (updater) return updater;
  const module = await import('@capacitor/core');
  updater = module.Capacitor.registerPlugin('AppUpdater');
  return updater;
}

export function compareAppVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^[vV]/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function readCachedResult() {
  try { return JSON.parse(localStorage.getItem(RESULT_KEY) || 'null'); }
  catch { return null; }
}

function latestRelease(releases) {
  return releases
    .filter(release => !release.draft && !release.prerelease)
    .map(release => {
      const asset = release.assets?.find(item => item.name === 'MyStudyAgent.apk');
      const version = String(release.tag_name || '').replace(/^[vV]/, '');
      return { release, asset, version };
    })
    .filter(item => item.asset?.browser_download_url && parseVersion(item.version))
    .sort((a, b) => new Date(b.release.published_at || b.release.created_at) - new Date(a.release.published_at || a.release.created_at))[0] || null;
}

export async function checkForUpdates({ force = false } = {}) {
  if (!isAndroidApp()) return { supported: false, currentVersion: APP_VERSION };

  const checkedAt = Number(localStorage.getItem(CHECKED_AT_KEY) || 0);
  const cached = readCachedResult();
  if (!force && cached?.currentVersion === APP_VERSION && Date.now() - checkedAt < DAY_MS) {
    return { ...cached, cached: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    const item = latestRelease(await response.json());
    const currentVersion = APP_VERSION;
    const latestVersion = item?.version || currentVersion;
    const updateAvailable = Boolean(item && compareAppVersions(latestVersion, currentVersion) > 0);
    const result = {
      supported: true,
      checked: true,
      checkedAt: Date.now(),
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseUrl: item?.release.html_url || '',
      downloadUrl: item?.asset.browser_download_url || '',
      releaseName: item?.release.name || '',
    };
    localStorage.setItem(CHECKED_AT_KEY, String(result.checkedAt));
    localStorage.setItem(RESULT_KEY, JSON.stringify(result));
    return result;
  } catch (error) {
    return { supported: true, checked: false, currentVersion: APP_VERSION, error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/** 启动时调用：查一次，有新版本就在 Wi-Fi 下排队下载，并只提醒一次。 */
export async function checkForUpdatesDaily(onAvailable = () => {}) {
  const result = await checkForUpdates();
  if (result.updateAvailable) {
    try {
      const plugin = await updaterPlugin();
      const download = await plugin.getLatestDownload();
      const usable = download.version === result.latestVersion
        && ['pending', 'downloading', 'paused', 'complete'].includes(download.status);
      if (!usable) {
        await plugin.downloadUpdate({ url: result.downloadUrl, version: result.latestVersion });
      }
    } catch (error) {
      console.warn('[app-update-download]', error);
    }
    if (localStorage.getItem(LAST_NOTICE_KEY) !== result.latestVersion) {
      localStorage.setItem(LAST_NOTICE_KEY, result.latestVersion);
      onAvailable(result);
    }
  }
  return result;
}

/**
 * 设置页顶部的版本行。
 * 存在的理由：用户能一眼分清"我装的是哪一版"，不用靠数导航里有几项去猜
 * —— 之前就因为装的是旧构建（导航只有 6 项、没有通知页）而以为功能没做。
 */
export function renderVersionLine() {
  const line = document.querySelector('#app-version-line');
  if (!line) return;
  line.textContent = isAndroidApp()
    ? `My Study Agent v${APP_VERSION}（Android App）`
    : '网页版 · 刷新页面即最新。手机通知和自动更新只存在于 Android App。';
}

export function bindUpdateSettings() {
  renderVersionLine();
  const section = document.querySelector('#app-update-settings');
  const status = document.querySelector('#app-update-status');
  const checkButton = document.querySelector('#btn-check-app-update');
  const downloadButton = document.querySelector('#btn-download-app-update');
  const installButton = document.querySelector('#btn-install-app-update');
  if (!section || !status || !checkButton || !downloadButton || !installButton) return () => {};

  section.hidden = !isAndroidApp();
  if (!isAndroidApp()) {
    // 网页端也要看得到版本行，只是没有下载/安装按钮。
    return () => {};
  }

  let release = null;
  let downloadId = 0;
  let stopped = false;
  let pollTimer = 0;

  const setStatus = text => { status.textContent = text; };
  const showDownloadState = async () => {
    if (!release || !downloadId) return;
    try {
      const plugin = await updaterPlugin();
      const state = await plugin.getDownloadStatus({ downloadId, version: release.latestVersion });
      if (stopped) return;
      if (state.status === 'complete') {
        downloadButton.hidden = true;
        installButton.hidden = false;
        setStatus(`v${release.latestVersion} 已下载。点击安装后，Android 会要求你确认。`);
        return;
      }
      if (state.status === 'downloading' || state.status === 'pending' || state.status === 'paused') {
        const progress = state.totalBytes > 0 ? ` ${Math.floor(state.downloadedBytes * 100 / state.totalBytes)}%` : '';
        setStatus(`正在下载 v${release.latestVersion}${progress}。下载由 Android 管理，可在通知栏查看。`);
        downloadButton.hidden = true;
        installButton.hidden = true;
        pollTimer = setTimeout(showDownloadState, 1800);
        return;
      }
      downloadButton.hidden = false;
      installButton.hidden = true;
      setStatus(state.status === 'failed' ? '下载失败，请检查网络后重试。' : `发现新版本 v${release.latestVersion}。`);
    } catch (error) {
      setStatus(`读取下载状态失败：${error.message || String(error)}`);
    }
  };

  const check = async force => {
    checkButton.disabled = true;
    downloadButton.hidden = true;
    installButton.hidden = true;
    setStatus(force ? '正在检查更新…' : `当前版本 v${APP_VERSION}，正在读取更新状态…`);
    const result = await checkForUpdates({ force });
    if (stopped) return;
    checkButton.disabled = false;
    if (!result.checked) {
      setStatus(`检查更新失败：${result.error || '网络暂不可用'}`);
      return;
    }
    if (!result.updateAvailable) {
      setStatus(`当前为 v${APP_VERSION}，已经是最新版本。${result.cached ? '（最近 24 小时内检查过）' : ''}`);
      return;
    }
    release = result;
    setStatus(`发现 v${result.latestVersion}，当前版本为 v${APP_VERSION}。自动检查会在 Wi-Fi 下下载更新。`);
    downloadButton.hidden = false;
    try {
      const plugin = await updaterPlugin();
      const nativeDownload = await plugin.getLatestDownload();
      if (nativeDownload.version === result.latestVersion && nativeDownload.downloadId) {
        downloadId = nativeDownload.downloadId;
        await showDownloadState();
      }
    } catch { /* A missing background download is normal. */ }
  };

  const onCheck = () => { void check(true); };
  const onDownload = async () => {
    if (!release?.downloadUrl) return;
    downloadButton.disabled = true;
    try {
      const plugin = await updaterPlugin();
      const result = await plugin.downloadUpdate({ url: release.downloadUrl, version: release.latestVersion });
      downloadId = result.downloadId;
      localStorage.setItem(DOWNLOAD_ID_KEY, String(downloadId));
      setStatus(`已开始下载 v${release.latestVersion}。Android 会在下载完成后显示通知。`);
      await showDownloadState();
    } catch (error) {
      setStatus(`无法开始下载：${error.message || String(error)}`);
    } finally {
      downloadButton.disabled = false;
    }
  };
  const onInstall = async () => {
    if (!downloadId) return;
    installButton.disabled = true;
    try {
      const plugin = await updaterPlugin();
      const result = await plugin.installDownloadedApk({ downloadId });
      setStatus(result.permissionRequired
        ? '请在系统设置中允许 My Study Agent 安装应用，然后返回这里再次点安装。'
        : '已打开 Android 安装确认页。确认后更新会覆盖当前版本，应用数据会保留。');
    } catch (error) {
      setStatus(`无法打开安装程序：${error.message || String(error)}`);
    } finally {
      installButton.disabled = false;
    }
  };

  checkButton.addEventListener('click', onCheck);
  downloadButton.addEventListener('click', onDownload);
  installButton.addEventListener('click', onInstall);
  void check(false);

  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    checkButton.removeEventListener('click', onCheck);
    downloadButton.removeEventListener('click', onDownload);
    installButton.removeEventListener('click', onInstall);
  };
}
