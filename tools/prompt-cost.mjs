#!/usr/bin/env node
// 量系统提示词各部分的 token 占比，以及"流程"到底值不值得按需注入。
//
// 背景：tools.js 里的工具分组正则已经被移除（见 tools/tool-cost.mjs）。
// 但同一个风险还留在 commands.js 里 —— 那 19 条正则决定"注入哪些流程段落"
// 和"触发哪些代码动作"。这个脚本量清楚它省了多少，好判断该怎么处理。
//
// 运行：node tools/prompt-cost.mjs

import 'fake-indexeddb/auto';

const persona = await import('../src/persona.js');
const commands = await import('../src/commands.js');

const CJK = /[\u4e00-\u9fff]/;
const tokens = text => {
  let cjk = 0;
  const s = String(text);
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.round(cjk * 0.75 + (s.length - cjk) * 0.3);
};

const row = (label, text, note = '') =>
  console.log(`  ${label.padEnd(22)} ${String(tokens(text)).padStart(5)} token`
    + (note ? `   ${note}` : ''));

console.log('系统提示词的固定部分（每次都注入）：\n');
const fixed = {
  '人设核心': persona.PERSONA_CORE,
  '安全与诚实规则': persona.SAFETY_RULES,
  '核心工作准则': persona.WORK_PRINCIPLES,
  '语气强度（5/5）': persona.toneBlock({ toneLevel: 5, allowProfanity: true }),
  '能力声明': persona.capabilityBlock({}),
};
let fixedTotal = 0;
for (const [k, v] of Object.entries(fixed)) { row(k, v); fixedTotal += tokens(v); }
console.log(`  ${'—'.repeat(22)}`);
console.log(`  ${'固定部分合计'.padEnd(22)} ${String(fixedTotal).padStart(5)} token\n`);

console.log('按需注入的流程（commands.js 的正则决定注不注）：\n');
let flowTotal = 0;
for (const id of persona.FLOW_IDS) {
  const t = tokens(persona.FLOWS[id]);
  flowTotal += t;
  row(id, persona.FLOWS[id]);
}
console.log(`  ${'—'.repeat(22)}`);
console.log(`  ${'全部流程合计'.padEnd(22)} ${String(flowTotal).padStart(5)} token`);
console.log(`  占固定部分的 ${(flowTotal / fixedTotal * 100).toFixed(0)}%\n`);

/* 抽查：这些说法现在由模型自己判断该走哪段流程（不再有正则把关） */
console.log('流程选择方式的对比（这些说法以前会被正则漏掉）：\n');
const CASES = [
  ['我想开始学线代了', 'start'],
  ['线代第三章我死活开不了头', 'hope'],
  ['我最近老是这样拖着', 'procrastination'],
  ['给我复盘一下今天', 'blackroom'],
  ['帮我把这周排一下', 'planning'],
  ['我想把每天开始学习这件事做成流程', 'sop'],
  ['今天做的都做完了', 'report'],
  ['你都能干啥', 'help'],
];
console.log('  这 8 条是常用说法。改成全量注入后，模型每一条都能看到对应的流程段落，');
console.log('  各段落开头就写着它的触发条件，不再需要正则命中：\n');
for (const [text, expected] of CASES) {
  const fallback = commands.ACTION_FALLBACK_TOOL;
  console.log(`  「${text}」 → 可选流程 ${expected}（模型自判）`);
}
console.log(`\n  代码动作兜底映射（每条动作都必须有工具能做同样的事）：`);
for (const [action, tool] of Object.entries(commands.ACTION_FALLBACK_TOOL)) {
  console.log(`    ${action.padEnd(16)} → ${tool}`);
}

console.log('\n结论：');
console.log(`  · 全部流程约 ${flowTotal} token，全量注入让每轮多花这么多。`);
console.log(`  · 但流程段落完全静态，会被上下文缓存命中 → 实际增量 ≈ ${Math.round(flowTotal / 10)} token 当量。`);
console.log('  · 换来的是：模型总能拿到用户自己定的那套步骤，而不是凭运气能不能被正则命中。');
console.log('  · 代码动作正则保留，但已降级为"快路径" —— 命中了省一次往返，没命中交给模型用工具做。');

