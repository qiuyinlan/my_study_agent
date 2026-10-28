#!/usr/bin/env node
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(root, 'icons/app-icon-512.png');
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

await Promise.all(densities.flatMap(density => {
  const folder = resolve(root, `android/app/src/main/res/mipmap-${density}`);
  return ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']
    .map(name => copyFile(source, resolve(folder, name)));
}));
console.log('Android launcher icons updated.');
