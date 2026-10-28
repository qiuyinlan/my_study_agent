// ── 原生能力探测（网站和 Android 壳共用同一套判断）────────────────
//
// 这个项目在浏览器里是"零构建"的：index.html 直接 <script type="module"
// src="src/main.js">，浏览器按 URL 解析 import。而 @capacitor/core 是裸模块名，
// 只有打包器（Android 壳的 Vite 构建）能解析 —— 一旦在 src/ 里写
//   import { Capacitor } from '@capacitor/core';
// 网站就会在加载期报
//   Failed to resolve module specifier "@capacitor/core"
// 整个 app 白屏。所以这里统一改成：
//
//   1. 同步判断走运行时全局 Capacitor（Android 壳里由注入脚本提前设好）
//   2. 需要插件实例时，在函数内部用**字面量**动态 import（Vite 能静态分析并分包，
//      浏览器端因为前面的 isNativePlatform() 判断根本不会执行到）
//
// tools/check.mjs 会拦住 src/ 下任何静态裸模块导入，防止再退化回去。

const core = () => (typeof globalThis === 'undefined' ? null : globalThis.Capacitor || null);

/** 是否运行在原生壳里（Android）。网页永远是 false。 */
export const isNativePlatform = () => Boolean(core()?.isNativePlatform?.());

/** 'android' | 'ios' | 'web' */
export const nativePlatform = () => core()?.getPlatform?.() || 'web';

/** 是否 Android App。 */
export const isAndroidPlatform = () => isNativePlatform() && nativePlatform() === 'android';

/**
 * 懒加载一个原生插件。loader 必须是字面量动态 import，
 * 这样 Vite 才能把它打成独立的 chunk；网页端不会走到这里。
 */
export async function loadNativePlugin(loader) {
  if (!isNativePlatform()) throw new Error('该功能仅在手机 App 中可用。');
  return loader();
}
