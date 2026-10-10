// 把 Dexie 的 ESM 构建下载到 vendor/ 目录，避免运行时依赖 CDN
// （少一个第三方源 = 少一个能读走你 localStorage 里 API Key 的入口）
//
// 输出必须是 .js 而不是 .mjs：浏览器加载 ES 模块时严格检查 MIME 类型，
// 而 python -m http.server 把 .mjs 当 text/plain 返回，会直接拒绝执行。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.cwd(), 'vendor', 'dexie.js');

const candidates = [
  'https://cdn.jsdelivr.net/npm/dexie@4/dist/modern/dexie.mjs',
  'https://unpkg.com/dexie@4/dist/modern/dexie.mjs',
  'https://cdn.jsdelivr.net/npm/dexie@4.0.11/dist/modern/dexie.mjs',
  'https://registry.npmmirror.com/dexie/-/dexie-4.0.11.tgz',
];

let ok = false;
for (const url of candidates) {
  process.stdout.write(`尝试 ${url} ... `);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) {
      console.log(`HTTP ${r.status}`);
      continue;
    }
    const text = await r.text();
    if (url.endsWith('.tgz')) {
      console.log('拿到 tgz，但需要解包，跳过');
      continue;
    }
    if (!text.includes('Dexie')) {
      console.log('内容可疑，跳过');
      continue;
    }
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, text, 'utf8');
    console.log(`✅ 成功，${(text.length / 1024).toFixed(0)} KB → ${OUT}`);
    ok = true;
    break;
  } catch (e) {
    console.log(`❌ ${e.cause?.code ?? e.message}`);
  }
}

if (!ok) {
  console.log('\n⚠️ 所有 CDN 都不可达，将改用项目内置的极简 IndexedDB 封装。');
  process.exitCode = 1;
}
