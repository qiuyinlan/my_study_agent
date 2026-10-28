#!/usr/bin/env node
// ── 把"网站 + APK"打包到同一个目录，供下载页使用 ────────────────
//
// 一定要先清空目标目录：上一版留在 assets/ 里的旧 chunk 不会被 Vite 删掉，
// 攒几次之后 release/ 里会有多套 index-*.js，很容易以为是"没更新"。

import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const webDir = resolve(root, 'capacitor-www');
const releaseDir = resolve(root, 'release');
const apkPath = resolve(root, process.argv[2] || 'android/app/build/outputs/apk/debug/app-debug.apk');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

await Promise.all([
  access(resolve(webDir, 'index.html')),
  access(apkPath),
]).catch(() => {
  throw new Error('Build the Android APK and run `npm run android:sync` before staging the release.');
});

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
await cp(webDir, releaseDir, { recursive: true, force: true });
await cp(apkPath, resolve(releaseDir, 'MyStudyAgent.apk'));

const indexPath = resolve(releaseDir, 'index.html');
const html = await readFile(indexPath, 'utf8');
if (!html.includes('class="actions"')) throw new Error('Could not find the topbar actions in the built website.');
if (!html.includes('MyStudyAgent.apk')) {
  await writeFile(indexPath, html.replace(
    'class="actions"',
    `class="actions"><a href="./MyStudyAgent.apk" download style="display:inline-flex;align-items:center;padding:5px 9px;color:#236340;font-size:13px;text-decoration:none" aria-label="下载安卓 APK">下载 APK</a`,
  ));
}
console.log(`Website and APK v${version} staged together: ${releaseDir}`);
