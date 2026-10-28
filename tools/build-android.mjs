#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'capacitor-www');

await build({ configFile: resolve(root, 'vite.android.config.js') });
await mkdir(output, { recursive: true });
await Promise.all([
  cp(resolve(root, 'icons'), resolve(output, 'icons'), { recursive: true }),
  cp(resolve(root, 'supabase-config.js'), resolve(output, 'supabase-config.js')),
  cp(resolve(root, 'manifest.webmanifest'), resolve(output, 'manifest.webmanifest')),
]);

const html = await readFile(resolve(output, 'index.html'), 'utf8');
if (html.includes("if ('serviceWorker' in navigator)")) {
  throw new Error('Android build still contains the PWA service worker registration.');
}
await writeFile(resolve(output, 'index.html'), html);
console.log(`Android web assets ready: ${output}`);
