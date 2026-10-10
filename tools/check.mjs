#!/usr/bin/env node
// ── 静态一致性检查 ────────────────────────────────────────────
//
// 浏览器里最容易踩的两类低级错误，Node 语法检查抓不到：
//   1. import 了一个模块没有导出的名字  → 加载期直接报错，白屏
//   2. $('#xxx') 引用了 HTML 里不存在的 id → 静默拿到 null，点击没反应
//
// 这个脚本把这两类都查出来，不需要跑浏览器。

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const rel = p => relative(ROOT, p).replace(/\\/g, '/');

/* ── 收集源文件 ── */
async function collect(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...await collect(full, exts));
    else if (exts.some(x => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

const srcFiles = await collect(resolve(ROOT, 'src'), ['.js']);
const toolFiles = await collect(resolve(ROOT, 'tools'), ['.mjs']);

/* ── 1) 导出/导入一致性 ── */
const exportCache = new Map();

async function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    exportCache.set(file, null);
    return null;
  }
  const names = new Set(['default']);
  // 注意：\w 不含 $，而本项目导出了 $ 和 $$，所以字符类要写成 [\w$]
  for (const re of [
    /export\s+(?:async\s+)?function\s+([\w$]+)/g,
    /export\s+(?:const|let|var)\s+([\w$]+)/g,
    /export\s+class\s+([\w$]+)/g,
  ]) {
    for (const m of text.matchAll(re)) names.add(m[1]);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  exportCache.set(file, names);
  return names;
}

const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

for (const file of [...srcFiles, ...toolFiles]) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const [, clause, spec] = m;
    if (!spec.startsWith('.')) continue; // 裸模块名（如 vendor 之外的），跳过

    const target = resolve(dirname(file), spec);
    const available = await exportsOf(target);
    if (!available) {
      problems.push(`${rel(file)}: 导入的文件不存在 → ${spec}`);
      continue;
    }

    const braced = clause.match(/\{([^}]*)\}/);
    if (!braced) continue;

    for (const raw of braced[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name) continue;
      if (!available.has(name)) {
        problems.push(`${rel(file)}: 从 ${spec} 导入了 "${name}"，但该模块没有导出它`);
      }
    }
  }
}

/* ── 2) DOM id 一致性 ── */
const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

// 面板是 JS 用 innerHTML 动态生成的，那些 id 不在 index.html 里。
// 必须把它们也当成"合法 id"，否则误报会盖住真正的拼写错误。
const dynamicIds = new Set();
for (const file of srcFiles) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(/id="([\w-]+)"/g)) dynamicIds.add(m[1]);
}
const knownIds = new Set([...htmlIds, ...dynamicIds]);

for (const file of srcFiles) {
  const text = await readFile(file, 'utf8');
  const used = new Set();
  for (const re of [
    /\$\('#([\w-]+)'\)/g,
    /getElementById\(\s*'([\w-]+)'\s*\)/g,
    // 选择器也可能以字符串形式传给辅助函数，例如 setupResizer('#resize-nav', 'nav')
    /'#([\w-]+)'/g,
  ]) {
    for (const m of text.matchAll(re)) used.add(m[1]);
  }
  for (const id of used) {
    if (!knownIds.has(id)) {
      problems.push(`${rel(file)}: 引用了不存在的 id → #${id}（静态 HTML 和动态生成里都没有）`);
    }
  }
}

/* ── 3) 没被任何地方引用的 id（提示，不算错误）── */
const usedIds = new Set();
for (const file of srcFiles) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(/\$\('#([\w-]+)'\)/g)) usedIds.add(m[1]);
}
const orphanIds = [...htmlIds].filter(id =>
  !usedIds.has(id)
  && !html.includes(`for="${id}"`)
  && !html.includes(`data-${id}`));

/* ── 输出 ── */
console.log(`检查了 ${srcFiles.length} 个源文件、${toolFiles.length} 个脚本、`
  + `${htmlIds.size} 个静态 id + ${dynamicIds.size} 个动态生成 id`);

if (problems.length) {
  console.log(`\n❌ 发现 ${problems.length} 个问题：\n`);
  for (const p of problems) console.log(`   · ${p}`);
  process.exit(1);
}

console.log('\n✅ 导入/导出一致性、DOM id 引用全部通过。');

if (orphanIds.length) {
  console.log(`\nℹ️  以下 id 定义了但没有被 JS 直接引用（可能只用于 CSS 或纯 HTML 交互，供参考）：`);
  for (const id of orphanIds) console.log(`   · #${id}`);
}
