// 验证 HTTP 送达的字节确实是 UTF-8，且中文没坏
const BASE = 'http://127.0.0.1:8000';

const targets = [
  ['/index.html', ['帕尼尼', 'baseurl-note', 'view-today', 'view-records',
    'dlg-sop', 'dlg-time', 'dlg-log', 'set-tone',
    'nav-items', 'btn-collapse-topbar', 'btn-collapse-panel', 'btn-reveal-panel',
    'btn-new-chat', 'pending-area']],
  ['/src/persona.js', ['你是「帕尼尼」', '平台实际能力', '暂停监督', '一分钟就能启动',
    '长期记忆（高重要性，常驻）', '必须用户自己点按钮']],
  ['/src/memory.js', ['需要处理的信号', '本轮代码已执行', 'fmtMemories', '还没有长期记忆']],
  ['/src/tools.js', ['timer_start', 'save_sop', 'toolsForTurn', 'CONFIRM_RULES', 'PROFILE_LABELS']],
  ['/src/panels.js', ['renderToday', 'renderRecords', 'renderCheckin', 'renderReviews', "id: 'profile'"]],
  ['/src/ui.js', ['ICON_PATHS', 'renderNav', 'initChromeIcons', 'renderPendingArea', 'currentColor']],
  ['/src/daylog.js', ['daySummary', 'daysWithRecords', 'latestRecordDate', 'updateLog']],
  ['/src/timer.js', ['syncTaskMinutes', 'updateTimeEntry', 'createManualEntry', 'deleteTimeEntry']],
  ['/styles.css', ['--accent', 'timerbar', '#ffffff', '--nav-w', 'nav-collapsed', 'panel-collapsed',
    'rec-item', 'pending-card', 'timeline']],
];

let bad = 0;
for (const [path, needles] of targets) {
  const res = await fetch(BASE + path);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');

  // 出现了 U+FFFD 说明字节不是合法 UTF-8
  const mojibake = text.includes('\uFFFD');
  const missing = needles.filter(n => !text.includes(n));

  const ok = !mojibake && !missing.length;
  if (!ok) bad++;

  console.log(`${ok ? '✓' : '✗'} ${path.padEnd(16)} ${res.status}  ${(buf.length / 1024).toFixed(1)} KB`
    + (mojibake ? '  ❌ 含替换字符(非UTF-8)' : '')
    + (missing.length ? `  ❌ 缺少: ${missing.join(', ')}` : ''));
}

/* 反向检查：已删除的东西不该再出现在送达内容里 */
const mustBeGone = [
  ['/src/panels.js', ['renderCommands', 'view-commands'], '指令面板已删除'],
  ['/index.html', ['view-commands'], '指令面板容器已删除'],
  ['/styles.css', ['cmd-item', 'ci-kind'], '指令面板样式已删除'],
  ['/src/main.js', ['panel_commands'], '指令面板动作已删除'],
];
for (const [path, needles, why] of mustBeGone) {
  const text = await (await fetch(BASE + path)).text();
  const found = needles.filter(n => text.includes(n));
  if (found.length) {
    bad++;
    console.log(`✗ ${path.padEnd(16)} 仍存在应删除的内容: ${found.join(', ')}（${why}）`);
  } else {
    console.log(`✓ ${path.padEnd(16)} ${why}`);
  }
}

// 确认 charset 声明在浏览器会读到的前 1024 字节内
const html = await (await fetch(BASE + '/index.html')).text();
const idx = html.search(/charset\s*=\s*["']?utf-8["']?/i);
console.log(`\ncharset 声明位置: 第 ${idx} 字节 ${idx >= 0 && idx < 1024 ? '✓（浏览器能识别）' : '❌ 太靠后或缺失'}`);
if (idx < 0 || idx >= 1024) bad++;

console.log(bad ? `\n❌ ${bad} 个文件有问题` : '\n✅ 编码与内容全部正确');
// 用 exitCode 而不是 process.exit()，避免 libuv 在句柄未清理时报断言噪音
process.exitCode = bad ? 1 : 0;
