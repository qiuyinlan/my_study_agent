#!/usr/bin/env node
// 量一下工具定义占多少 token。
//
// 这个脚本记录了一个已经做过的决策，免得以后又有人（包括我自己）想当然地
// 去"优化"它：
//
//   曾经实现过"分组按需下发"：核心 14 个工具常驻，其余按意图正则匹配的组
//   临时注入。看着很聪明，实际是错的 —— 正则必然漏。用户说"我叫小明"，
//   而 profile 组的正则里只有"叫我"，于是 update_profile 根本没被下发，
//   模型想存也存不了。它不会说"我没有这个工具"，只会说"好的小明"，然后
//   什么都没发生。用户看到的是"说了称呼但一直没更新"。
//
// 实测成本：全部工具 ≈ 5600 token，核心 14 个 ≈ 1900 token。差额约 3700 token。
// 但工具 schema 是**稳定前缀**，会被 DeepSeek 的上下文缓存命中，命中部分
// 便宜约一个数量级 —— 实际增量只相当于约 370 token。
//
// 结论：用 370 token 换"不会静默丢能力"，非常划算。省 token 的正确姿势是
// 别把历史日志全塞进 prompt，而不是把工具藏起来一半。
//
// 运行：node tools/tool-cost.mjs

import { TOOL_DEFS, toolsForTurn } from '../src/tools.js';

const CJK = /[\u4e00-\u9fff]/;
const tokens = text => {
  let cjk = 0;
  const s = String(text);
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.round(cjk * 0.75 + (s.length - cjk) * 0.3);
};

/* 拿去做对比的假想"核心集"：任何监督回合都可能用到的那些 */
const HYPOTHETICAL_CORE = [
  'list_tasks', 'save_task', 'set_task_state', 'set_key_tasks',
  'timer_start', 'timer_stop', 'timer_status',
  'get_ledger', 'award_points',
  'search_memory', 'save_memory',
  'get_daily_summary',
  'suspend_supervision', 'resume_supervision',
];

const sizeOf = names => {
  const defs = TOOL_DEFS.filter(d => names.includes(d.function.name));
  const json = JSON.stringify(defs);
  return { count: defs.length, chars: json.length, tokens: tokens(json) };
};

const { tools, names } = toolsForTurn();
const all = sizeOf(names);
const core = sizeOf(HYPOTHETICAL_CORE);
const diff = all.tokens - core.tokens;

console.log('当前下发策略：每一轮全量下发');
console.log(`  实际下发 ${tools.length} 个工具　${all.chars} 字符　≈ ${all.tokens} token\n`);

console.log('作为对比 —— 假设只下发"核心 14 个"：');
console.log(`  ${core.count} 个　${core.chars} 字符　≈ ${core.tokens} token`);
console.log(`  差额 ≈ ${diff} token\n`);

console.log('但工具 schema 是稳定前缀，会被上下文缓存命中：');
console.log(`  缓存命中部分便宜约一个数量级 → 实际增量 ≈ ${Math.round(diff / 10)} token 当量`);
console.log(`  换算成占比：全量下发比"核心集"贵约 ${(diff / all.tokens * 100).toFixed(0)}% 的 schema，`);
console.log('  但这是唯一一次请求的成本，之后每轮都命中缓存。\n');

console.log(`各工具体积（前 10 大，共 ${all.count} 个）：`);
const ranked = TOOL_DEFS
  .map(d => ({ name: d.function.name, ...sizeOf([d.function.name]) }))
  .sort((a, b) => b.tokens - a.tokens)
  .slice(0, 10);
for (const r of ranked) console.log(`  ${r.name.padEnd(22)} ≈ ${String(r.tokens).padStart(4)} token`);

console.log('\n如果以后又想把工具藏起来省 token，先回来看看这段注释。');
