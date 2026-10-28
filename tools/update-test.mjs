#!/usr/bin/env node
// ── 版本比较 + 更新检查的兜底行为 ────────────────────────────────
//
// 真机上最容易出问题的不是版本比较，而是**查不到版本**：
// GitHub 的 Releases API 未登录每小时只有 60 次、按出口 IP 算，
// 挂 VPN / 运营商 NAT 很容易被人打满，直接 403。
// 这里把三种情况都用桩 fetch 跑一遍：
//   1) API 正常 → 用 API 的结果
//   2) API 403 → 用备用版本源（jsDelivr / raw 的 package.json），仍然能拿到版本
//   3) 全挂 → 明确返回"没检查成"，并给出能点的手动下载入口

import assert from 'node:assert/strict';

/* localStorage 桩 */
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  writable: true,
  configurable: true,
});

/* 假装在 Android 壳里，否则 checkForUpdates 会直接返回 supported:false */
globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: () => ({}) };
/* Vite 打包时注入 __APP_VERSION__；测试里自己塞一个，才能验证"有新版本"这条分支 */
globalThis.__APP_VERSION__ = '1.3.1';

const { compareAppVersions, checkForUpdates, checkForUpdatesDaily, releaseDownloadUrl, __setUpdaterPluginForTest } = await import('../src/updates.js');

/* ── 1) 版本比较 ── */
assert.equal(compareAppVersions('1.2.0', '1.1.0'), 1);
assert.equal(compareAppVersions('v1.2.0', '1.2.0'), 0);
assert.equal(compareAppVersions('1.2.0', '1.2.1'), -1);
assert.equal(compareAppVersions('1.10.0', '1.9.9'), 1);
assert.equal(compareAppVersions('1.3.1', '1.3.0'), 1);
assert.equal(compareAppVersions('development', '1.0.0'), null);
assert.equal(
  releaseDownloadUrl('v1.9.9'),
  'https://github.com/qiuyinlan/my_study_agent/releases/download/v1.9.9/MyStudyAgent.apk',
  '拼出来的下载地址要符合原生插件的校验（https + github.com + /releases/download/）',
);

const reset = () => { store.clear(); };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/* ── 2) API 正常 ── */
reset();
globalThis.fetch = async url => {
  assert.match(String(url), /api\.github\.com/, 'API 正常时应该先问 API');
  return jsonResponse([{
    tag_name: 'v1.9.0',
    draft: false,
    prerelease: false,
    name: 'My Study Agent 1.9.0',
    html_url: 'https://github.com/qiuyinlan/my_study_agent/releases/tag/v1.9.0',
    published_at: '2099-01-01T00:00:00Z',
    assets: [{ name: 'MyStudyAgent.apk', browser_download_url: 'https://github.com/qiuyinlan/my_study_agent/releases/download/v1.9.0/MyStudyAgent.apk' }],
  }]);
};
let result = await checkForUpdates({ force: true });
assert.equal(result.checked, true);
assert.equal(result.source, 'api');
assert.equal(result.latestVersion, '1.9.0');
assert.equal(result.rateLimited, false);
assert.match(result.downloadUrl, /releases\/download\/v1\.9\.0\/MyStudyAgent\.apk$/);

/* ── 3) API 403（限流）→ 备用源兜底 ── */
reset();
let apiHits = 0;
globalThis.fetch = async url => {
  const target = String(url);
  if (target.includes('api.github.com')) { apiHits += 1; return jsonResponse({ message: 'API rate limit exceeded' }, 403); }
  if (target.includes('jsdelivr')) return jsonResponse({ version: '2.0.0' });
  return jsonResponse({ message: 'raw should not be needed' }, 500);
};
result = await checkForUpdates({ force: true });
assert.equal(apiHits, 1, 'API 只该试一次');
assert.equal(result.checked, true, '限流也必须给出结果，不能直接失败');
assert.equal(result.rateLimited, true, '要能告诉用户这次是被限流了');
assert.equal(result.source, 'repo');
assert.equal(result.latestVersion, '2.0.0');
assert.equal(result.downloadUrl, 'https://github.com/qiuyinlan/my_study_agent/releases/download/v2.0.0/MyStudyAgent.apk');
assert.equal(result.releaseUrl, 'https://github.com/qiuyinlan/my_study_agent/releases/tag/v2.0.0');

/* ── 4) 限流后的冷却：半小时内不再撞 API ── */
reset();
apiHits = 0;
globalThis.fetch = async url => {
  const target = String(url);
  if (target.includes('api.github.com')) { apiHits += 1; return jsonResponse({}, 403); }
  return jsonResponse({ version: '2.0.0' });
};
await checkForUpdates({ force: true });     // 第一次：撞 API → 403 → 冷却
apiHits = 0;
await checkForUpdates();                    // 第二次（非强制）：应该直接走备用源
assert.equal(apiHits, 0, '冷却期内不该再消耗 API 配额');

/* ── 5) 全挂 → 明确说没查成，并留手动入口 ── */
reset();
globalThis.fetch = async () => jsonResponse({ message: 'blocked' }, 403);
result = await checkForUpdates({ force: true });
assert.equal(result.checked, false);
assert.equal(result.rateLimited, true);
assert.match(result.releasesPage, /\/releases$/, '失败时也要给出能点的手动下载页');
assert.ok(result.error && /403|限流/.test(result.error), `错误信息要能说明原因，实际：${result.error}`);

/* ── 6) 备用的 raw 源也能兜底（jsDelivr 被墙时） ── */
reset();
globalThis.fetch = async url => {
  const target = String(url);
  if (target.includes('api.github.com')) return jsonResponse({}, 429);
  if (target.includes('jsdelivr')) throw new TypeError('Failed to fetch');
  if (target.includes('raw.githubusercontent.com')) return jsonResponse({ version: '2.1.0' });
  return jsonResponse({}, 404);
};
result = await checkForUpdates({ force: true });
assert.equal(result.checked, true);
assert.equal(result.latestVersion, '2.1.0', 'jsDelivr 挂了还要能落到 raw');

/* ── 7) 自动下载必须只在 Wi-Fi 下；手动下载才允许流量 ──
   真机上的教训：DownloadManager 被写死 NETWORK_WIFI 时，用户在流量下点
   「下载更新」会一直排队等 Wi-Fi，界面看起来就是"点了没反应"。 */
reset();
globalThis.fetch = async () => jsonResponse({ version: '2.2.0' });
const downloadCalls = [];
__setUpdaterPluginForTest({
  async getLatestDownload() { return { downloadId: -1, version: '', status: 'missing' }; },
  async downloadUpdate(options) { downloadCalls.push(options); return { downloadId: 42, version: options.version }; },
});
await checkForUpdatesDaily(() => {});
assert.equal(downloadCalls.length, 1, '发现新版本时自动排一次下载');
assert.equal(downloadCalls[0].allowMobileData, false, '自动下载不能烧流量，必须只允许 Wi-Fi');
assert.match(downloadCalls[0].url, /releases\/download\/v2\.2\.0\/MyStudyAgent\.apk$/);

/* 已经有可用下载时不要重复排队 */
downloadCalls.length = 0;
__setUpdaterPluginForTest({
  async getLatestDownload() { return { downloadId: 42, version: '2.2.0', status: 'downloading' }; },
  async downloadUpdate(options) { downloadCalls.push(options); return { downloadId: 43 }; },
});
await checkForUpdatesDaily(() => {});
assert.equal(downloadCalls.length, 0, '已在下载就别再开一个任务');

console.log('Update version comparison and fallback passed.');
