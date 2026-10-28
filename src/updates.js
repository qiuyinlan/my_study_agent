// ── 应用自动更新（Android）───────────────────────────────────────
//
// 网页端不需要更新（刷新就是最新），所以这里查到的 supported 是 false。
// 原生调用一律懒加载：模块顶层不能出现裸模块导入（见 src/native.js）。
//
// 链路：启动 → 每天最多一次查版本 → 有新版本就用系统 DownloadManager
// 在 Wi-Fi 下下载 APK → 用户点「安装」走系统安装器覆盖升级（app data 保留）。
//
// 两个来源，按可靠性排序：
//   1. GitHub Releases API —— 信息最全（版本、资产、发布说明），但**未登录每小时只有
//      60 次、按 IP 算**。手机走运营商 NAT 时很容易被别人用光，直接 403。
//   2. raw.githubusercontent 上的 package.json —— 就是个静态文本，CDN 直出、
//      带 CORS，没有那 60 次/小时的限制。版本号与 tag 一一对应
//      （发版流程：先改 package.json，再打 v<version> 的 tag），
//      APK 下载地址可以按版本号拼出来。
// API 挂了就用 2 兜底，绝不把"403"直接甩给用户。

import { isAndroidPlatform } from './native.js';

const REPO = 'qiuyinlan/my_study_agent';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
// 备用版本源：都是静态文件 + 带 CORS，不受 API 那 60 次/小时的按 IP 限流影响。
// 顺序按国内可达性排：jsDelivr(CDN) 通常最稳，raw.githubusercontent 有时被污染。
const MANIFEST_URLS = [
  `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json`,
  `https://fastly.jsdelivr.net/gh/${REPO}@main/package.json`,
  `https://raw.githubusercontent.com/${REPO}/main/package.json`,
];
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const CHECKED_AT_KEY = 'msa.update.checked-at.v1';
const RESULT_KEY = 'msa.update.latest.v1';
const LAST_NOTICE_KEY = 'msa.update.notice-version.v1';
const DOWNLOAD_ID_KEY = 'msa.update.download-id.v1';
const RATE_LIMIT_KEY = 'msa.update.ratelimit-until.v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

export const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
export const isAndroidApp = () => isAndroidPlatform();

/** 资产名固定，地址可以按版本号拼出来（原生插件会校验域名与 /releases/download/ 路径）。 */
export const releaseDownloadUrl = version => `${RELEASES_PAGE}/download/v${String(version).replace(/^[vV]/, '')}/MyStudyAgent.apk`;
export const releasePageUrl = version => `${RELEASES_PAGE}/tag/v${String(version).replace(/^[vV]/, '')}`;
export const releasesPageUrl = () => RELEASES_PAGE;

let updater = null;
/** 拿到自定义的 AppUpdater 插件（Android 壳里注册的）。 */
async function updaterPlugin() {
  if (updater) return updater;
  const module = await import('@capacitor/core');
  updater = module.Capacitor.registerPlugin('AppUpdater');
  return updater;
}

/* 仅用于测试：注入假插件，验证"自动下载只走 Wi-Fi"这类参数契约。 */
export function __setUpdaterPluginForTest(fake) {
  updater = fake;
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 来源 1：Releases API。403/429 就是限流，单独标出来，别当成"没网"。 */
async function queryReleasesApi() {
  try {
    const response = await fetchWithTimeout(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      const rateLimited = response.status === 403 || response.status === 429;
      return {
        ok: false,
        rateLimited,
        status: response.status,
        error: rateLimited
          ? `GitHub 接口限流（HTTP ${response.status}，未登录每小时只能查 60 次）`
          : `GitHub 返回 HTTP ${response.status}`,
      };
    }
    const item = latestRelease(await response.json());
    if (!item) return { ok: false, rateLimited: false, status: response.status, error: '没有找到带 APK 的正式版本' };
    return {
      ok: true,
      info: {
        version: item.version,
        downloadUrl: item.asset.browser_download_url,
        releaseUrl: item.release.html_url || releasePageUrl(item.version),
        releaseName: item.release.name || '',
      },
    };
  } catch (error) {
    return { ok: false, rateLimited: false, status: 0, error: error?.message || String(error) };
  }
}

/**
 * 来源 2：仓库里的 package.json。
 * 静态文件、CDN 直出、带 CORS，既不消耗 API 配额，也不受"未登录 60 次/小时"限制。
 * 发版流程保证 version 与 tag 一致（先改 package.json，再打 v<version>），
 * 所以 APK 地址可以按版本号拼出来。
 */
async function queryRepoManifest() {
  const failures = [];
  for (const url of MANIFEST_URLS) {
    try {
      const response = await fetchWithTimeout(url, {}, 8000);
      if (!response.ok) { failures.push(`${new URL(url).host} HTTP ${response.status}`); continue; }
      const data = await response.json();
      const version = String(data?.version || '').trim();
      if (!parseVersion(version)) { failures.push(`${new URL(url).host} 版本号不合法`); continue; }
      return {
        ok: true,
        info: {
          version,
          downloadUrl: releaseDownloadUrl(version),
          releaseUrl: releasePageUrl(version),
          releaseName: `My Study Agent ${version}`,
        },
      };
    } catch (error) {
      failures.push(`${new URL(url).host} ${error?.message || error}`);
    }
  }
  return { ok: false, error: failures.join('；') };
}

export async function checkForUpdates({ force = false } = {}) {
  if (!isAndroidApp()) return { supported: false, currentVersion: APP_VERSION };

  const checkedAt = Number(localStorage.getItem(CHECKED_AT_KEY) || 0);
  const cached = readCachedResult();
  if (!force && cached?.currentVersion === APP_VERSION && Date.now() - checkedAt < DAY_MS) {
    return { ...cached, cached: true };
  }
  // 刚被限流过就先别去撞：半小时内直接用兜底源。
  const rateLimitedUntil = Number(localStorage.getItem(RATE_LIMIT_KEY) || 0);
  const skipApi = !force && Date.now() < rateLimitedUntil;

  const api = skipApi ? { ok: false, rateLimited: true, error: '接口限流冷却中' } : await queryReleasesApi();
  let source = api.ok ? 'api' : '';
  let info = api.ok ? api.info : null;
  if (!info) {
    const repo = await queryRepoManifest();
    if (repo.ok) {
      info = repo.info;
      source = 'repo';
    }
  }

  if (api.rateLimited) localStorage.setItem(RATE_LIMIT_KEY, String(Date.now() + RATE_LIMIT_BACKOFF_MS));

  if (!info) {
    return {
      supported: true,
      checked: false,
      currentVersion: APP_VERSION,
      error: api.error || '网络暂不可用，稍后再试',
      rateLimited: Boolean(api.rateLimited),
      releasesPage: RELEASES_PAGE,
    };
  }

  const currentVersion = APP_VERSION;
  const updateAvailable = compareAppVersions(info.version, currentVersion) > 0;
  const result = {
    supported: true,
    checked: true,
    checkedAt: Date.now(),
    currentVersion,
    latestVersion: info.version,
    updateAvailable,
    releaseUrl: info.releaseUrl,
    downloadUrl: updateAvailable ? info.downloadUrl : '',
    releaseName: info.releaseName,
    source,
    rateLimited: Boolean(api.rateLimited),
  };
  localStorage.setItem(CHECKED_AT_KEY, String(result.checkedAt));
  localStorage.setItem(RESULT_KEY, JSON.stringify(result));
  return result;
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
        // 自动下载只走 Wi-Fi：别在用户不知情时烧流量。
        await plugin.downloadUpdate({ url: result.downloadUrl, version: result.latestVersion, allowMobileData: false });
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

  const setStatus = text => {
    status.textContent = text;
    delete status.dataset.withLink;
  };
  const setDownloadLabel = text => {
    downloadButton.textContent = text;
    downloadButton.dataset.allowMobile = text === '用流量下载' ? '1' : '';
  };
  /**
   * 失败时不要只甩一句 HTTP 403 让用户干瞪眼：
   * 说明原因，并给一个能点的"手动下载"出口。
   */
  const setStatusWithLink = (text, href, label) => {
    status.textContent = text;
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    link.style.cssText = 'display:inline-block;margin-top:6px;font-weight:600';
    status.append(document.createElement('br'), link);
  };
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
      /* 自动下载只允许 Wi-Fi：在流量下它其实在排队。这里必须说清楚，
         并给出「用流量下载」的出口，否则用户只会看到"点了没反应"。 */
      if (state.waitingForNetwork) {
        downloadButton.hidden = false;
        installButton.hidden = true;
        setDownloadLabel('用流量下载');
        setStatus(`v${release.latestVersion} 正在等你连 Wi-Fi（自动更新不烧流量）。想现在就要，点「用流量下载」。`);
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
      setDownloadLabel('下载更新');
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
      const reason = result.rateLimited
        ? 'GitHub 接口限流（未登录每小时 60 次，按出口 IP 算；挂 VPN / 共享 IP 时几乎必被打满）'
        : (result.error || '网络暂不可用');
      setStatusWithLink(`检查更新失败：${reason}。备用版本源也没读到，可手动下载。`,
        result.releasesPage || RELEASES_PAGE, '打开 Releases 页手动更新');
      return;
    }
    if (!result.updateAvailable) {
      const viaFallback = result.source === 'repo' ? '（GitHub 接口限流，已用备用源核对）' : '';
      setStatus(`当前为 v${APP_VERSION}，已经是最新版本。${viaFallback}${result.cached ? '（最近 24 小时内检查过）' : ''}`);
      return;
    }
    release = result;
    const fallbackNote = result.source === 'repo' ? '（GitHub 接口限流，已改用备用版本源）' : '';
    setStatus(`发现 v${result.latestVersion}，当前版本为 v${APP_VERSION}${fallbackNote}。自动更新只在 Wi-Fi 下下载；想用流量就点「下载更新」。`);
    downloadButton.hidden = false;
    setDownloadLabel('下载更新');
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
    const viaMobile = downloadButton.dataset.allowMobile === '1';
    try {
      const plugin = await updaterPlugin();
      // 用户主动点下载 = 明确同意用当前网络（含流量）。
      const result = await plugin.downloadUpdate({
        url: release.downloadUrl,
        version: release.latestVersion,
        allowMobileData: true,
      });
      downloadId = result.downloadId;
      localStorage.setItem(DOWNLOAD_ID_KEY, String(downloadId));
      setStatus(`已开始下载 v${release.latestVersion}${viaMobile ? '（使用当前网络，可能是流量）' : ''}。Android 会在下载完成后显示通知。`);
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
