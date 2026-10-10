#!/usr/bin/env node
// 工具描述审计。
//
// 背景：以前用正则决定"下发哪些工具"，模型只能从被给的里面挑。那个机制
// 废弃之后，工具选择完全交给模型 —— 而模型唯一的判断依据就是**工具描述**。
//
// 所以描述的质量直接等于"模型能不能选对工具"。这个脚本把描述当成一件
// 需要验证的工程产物来查：
//
//   1. 每个工具是否说清了"什么时候该调我"（而不是只说"我干什么"）
//   2. 每个参数是否有说明、必填项是否真的存在
//   3. 有没有一组工具长得太像，容易混（这是废弃正则之后的主要风险）
//
// 运行：node tools/tool-audit.mjs

import { TOOL_DEFS } from '../src/tools.js';

const CJK = /[\u4e00-\u9fff]/;
const cjkLen = s => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;

/* ── 判据 ── */

/** 描述里有没有"什么时候用"的信号 */
const WHEN_PATTERNS = [
  /用户.{0,34}时/,        // "用户说…时调用"
  /(需要|要|想|准备|打算|完成|走完|判断|确认|遇到|出现|发生|发现|提到|说|问).{0,26}时/,
  /(之?前先|之前必须|前必须先调)/,   // "要回忆细节之前必须先调这个"
  /用于/, /适用于/, /在.{0,20}时/, /当你/,
  /(说|问|提到).{0,26}(就|时|则)/,
];
const hasWhen = d => WHEN_PATTERNS.some(re => re.test(d));

/** 摘出描述里的"触发短语"，方便人工看 */
const extractTriggers = d => {
  const m = String(d).match(/(用户.{0,40}?时)/g);
  return m ? m.map(s => s.replace(/\s+/g, '')).slice(0, 2) : [];
};

/* ── 跑 ── */

const problems = [];
const weak = [];

console.log(`共 ${TOOL_DEFS.length} 个工具\n`);

console.log('── 1. 描述是否说清"什么时候调我" ──\n');
const noWhen = [];
for (const t of TOOL_DEFS) {
  const f = t.function;
  const d = f.description || '';
  const len = cjkLen(d);
  const ok = hasWhen(d);
  if (!ok) noWhen.push(f.name);
  if (!ok || len < 12) weak.push({ name: f.name, len, d });
  const trig = extractTriggers(d).join(' / ');
  console.log(`  ${ok ? '✓' : '✗'} ${f.name.padEnd(22)} ${String(len).padStart(3)} 字`
    + (trig ? `   ← ${trig.slice(0, 46)}` : ''));
}
if (noWhen.length) {
  problems.push(`这些工具的描述没说清什么时候用：${noWhen.join('、')}`);
}

console.log('\n── 2. 参数描述与必填项 ──\n');
for (const t of TOOL_DEFS) {
  const { name, parameters: p } = t.function;
  const props = p?.properties || {};
  const noDesc = Object.entries(props).filter(([, v]) => !v.description).map(([k]) => k);
  const missing = (p?.required || []).filter(r => !props[r]);
  const badType = Object.entries(props).filter(([, v]) => !v.type && !v.anyOf).map(([k]) => k);
  const flags = [];
  if (noDesc.length) flags.push(`缺说明: ${noDesc.join(',')}`);
  if (missing.length) flags.push(`required 不存在: ${missing.join(',')}`);
  if (badType.length) flags.push(`缺 type: ${badType.join(',')}`);
  if (flags.length) {
    problems.push(`${name}: ${flags.join('；')}`);
    console.log(`  ✗ ${name.padEnd(22)} ${flags.join('；')}`);
  }
}
if (!problems.some(p => p.includes('缺说明') || p.includes('required'))) {
  console.log('  ✓ 全部参数的说明、type、required 都齐全');
}

console.log('\n── 3. 容易混淆的工具组 ──\n');
/* 名字同族的工具最容易混。列出来让人过一眼，而不是自动判定。 */
const FAMILIES = [
  ['log_study', 'log_time_entry', 'save_checkin'],
  ['save_memory', 'save_review', 'record_procrastination'],
  ['save_task', 'set_task_state', 'set_key_tasks'],
  ['list_tasks', 'get_task', 'get_daily_summary'],
  ['list_topics', 'add_topic', 'grade_review'],
  ['award_points', 'confirm_points', 'redeem_reward', 'upsert_reward'],
  ['timer_start', 'timer_stop', 'timer_status', 'log_time_entry'],
  ['open_panel', 'export_records', 'get_daily_summary'],
  ['save_plan', 'save_sop', 'list_plans', 'list_sops'],
];
for (const fam of FAMILIES) {
  const tools = fam.map(n => TOOL_DEFS.find(d => d.function.name === n)).filter(Boolean);
  if (tools.length < 2) continue;
  console.log(`  【${fam.join(' / ')}】`);
  for (const t of tools) {
    const d = t.function.description || '';
    console.log(`    ${t.function.name.padEnd(22)} ${d.replace(/\s+/g, ' ').slice(0, 64)}…`);
  }
  console.log('');
}

console.log('── 4. 描述里有没有"兄弟工具"的指引 ──\n');
/* 最容易搞错的几对，看描述里有没有互相点名 */
const SHOULD_POINT = [
  ['log_study', 'log_time_entry', '记录学习内容时用它；只想补时长用 log_time_entry'],
  ['log_time_entry', 'log_study', '只想记时长用这个；记学了什么用 log_study'],
  ['save_memory', 'save_review', '长期事实用这个；一次复盘的结论用 save_review'],
  ['save_review', 'save_memory', '复盘结论用这个；通用长期事实用 save_memory'],
  ['set_task_state', 'save_task', '只改状态用这个；改其他字段用 save_task'],
  ['list_tasks', 'get_task', '看列表用这个；看单个任务完整字段用 get_task'],
  ['get_task', 'list_tasks', '看单个任务详情用这个；看列表用 list_tasks'],
];
for (const [name, sibling, advice] of SHOULD_POINT) {
  const t = TOOL_DEFS.find(d => d.function.name === name);
  if (!t) continue;
  const mentions = t.function.description.includes(sibling)
    || Object.values(t.function.parameters?.properties || {}).some(v => v.description?.includes(sibling));
  console.log(`  ${mentions ? '✓' : '✗'} ${name.padEnd(20)} 是否点名了 ${sibling.padEnd(20)} ${advice}`);
  if (!mentions) weak.push({ name, len: 0, d: `未点名兄弟工具 ${sibling}：${advice}` });
}

/* ── 结论 ── */
console.log(`\n${'─'.repeat(62)}`);
const missingPointers = weak.filter(w => w.d.startsWith('未点名'));

if (missingPointers.length) {
  problems.push(`这些工具没点名易混的兄弟工具：${missingPointers.map(w => w.name).join('、')}`);
}

if (problems.length) {
  console.log(`❌ ${problems.length} 项硬问题（描述质量直接等于"模型能不能选对工具"）：`);
  for (const p of problems) console.log(`   · ${p}`);
  console.log('\n工具选择没有代码兜底 —— 模型唯一的依据就是这些描述。修好再提交。');
  process.exitCode = 1;
} else {
  console.log('✅ 工具描述的硬性要求全部通过：');
  console.log('   · 每个工具都说清了"什么时候该调我"');
  console.log('   · 参数说明、type、required 齐全');
  console.log('   · 易混的兄弟工具互相点名了');
}

console.log('\n提醒：描述质量只能靠这个脚本查形式，"模型会不会选对"无法自动测试 ——');
console.log('      只能靠真实使用观察。所以界面上保留了工具调用轨迹，方便你看出它调了什么。');
