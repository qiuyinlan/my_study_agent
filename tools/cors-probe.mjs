#!/usr/bin/env node
// ── DeepSeek（或任意 OpenAI 兼容端点）CORS 探针 ──────────────────
//
// 为什么要有这个脚本：关于"某家 API 支不支持浏览器直连"，网上的说法
// 高度矛盾，而且大量是 SEO 农场批量生成的模板文章，不可信。CORS 头是
// CDN 边缘配置，能随时改且不改文档 —— 所以任何二手结论都会过期。
//
// 唯一可靠的做法是现场测。这个脚本 30 秒给你带 CORS 头原文的结论。
//
// 用法：
//   node tools/cors-probe.mjs                                   # 测官方，只做预检
//   node tools/cors-probe.mjs https://your-proxy.workers.dev    # 测任意兼容端点
//   node tools/cors-probe.mjs --key sk-xxxx                     # 加真实请求端到端验证
//   node tools/cors-probe.mjs https://xxx --key sk-xxxx
//
// 退出码：0 = 支持浏览器直连；1 = 不支持（需要代理）；2 = 网络不通，无法判断

const args = process.argv.slice(2);
let base = 'https://api.deepseek.com';
let key = '';

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--key') { key = args[++i] || ''; continue; }
  if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  if (!a.startsWith('--')) base = a;
}

const HELP = `用法: node tools/cors-probe.mjs [baseUrl] [--key sk-xxx]`;

const ORIGIN = 'https://study.example.com';
const url = `${base.replace(/\/+$/, '')}/chat/completions`;

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(64));

line();
line(`目标端点: ${url}`);
line(`模拟来源: ${ORIGIN}`);
rule();

/* ── 1) OPTIONS 预检：浏览器在真正发请求前一定会先问这一句 ── */
let preflightOk = false;
let preflightSeen = false;

line('\n[1/3] OPTIONS 预检（浏览器发出跨域请求前的必经一步）');
try {
  const r = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
    signal: AbortSignal.timeout(20000),
  });
  preflightSeen = true;
  const acao = r.headers.get('access-control-allow-origin');
  const acah = r.headers.get('access-control-allow-headers');
  const acam = r.headers.get('access-control-allow-methods');

  line(`    HTTP ${r.status}   (server: ${r.headers.get('server') ?? '未知'})`);
  line(`    access-control-allow-origin : ${acao ?? '❌ 缺失'}`);
  line(`    access-control-allow-headers: ${acah ?? '缺失'}`);
  line(`    access-control-allow-methods: ${acam ?? '缺失'}`);

  // 回显本来源 或 通配 * 都算放行
  preflightOk = acao === ORIGIN || acao === '*';
  await r.text();
} catch (e) {
  line(`    ❌ 请求失败: ${e.cause?.code ?? e.message}`);
}

/* ── 2) 故意不带 Key 的真实 POST：验证「错误响应」也带 CORS 头 ──
   这一步很重要：如果只在成功响应上加 CORS 头，浏览器里所有报错都会
   退化成不可读的 "TypeError: Failed to fetch"，用户根本看不到原因。 */
line('\n[2/3] 不带 Key 的 POST（预期 401）—— 验证报错是否也可读');
let errorReadable = false;
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  const acao = r.headers.get('access-control-allow-origin');
  const body = await r.text().catch(() => '');
  let msg = '';
  try { msg = JSON.parse(body)?.error?.message ?? ''; } catch { /* 非 JSON */ }

  line(`    HTTP ${r.status}`);
  line(`    access-control-allow-origin: ${acao ?? '❌ 缺失'}`);
  if (msg) line(`    错误信息: ${msg.slice(0, 90)}`);
  errorReadable = acao === ORIGIN || acao === '*';
} catch (e) {
  line(`    ❌ 请求失败: ${e.cause?.code ?? e.message}`);
}

/* ── 3) 带真 Key 的端到端最小请求 ── */
let e2e = null;
line('\n[3/3] 端到端真实请求');
if (!key) {
  line('    跳过（没提供 --key）。加 --key sk-xxx 可做完整验证。');
} else {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '说"通"一个字' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(40000),
    });
    const acao = r.headers.get('access-control-allow-origin');
    const j = await r.json().catch(() => null);
    if (r.ok) {
      line(`    HTTP ${r.status} ✅`);
      line(`    回复: ${j?.choices?.[0]?.message?.content ?? '(空)'}`);
      line(`    用量: ${JSON.stringify(j?.usage ?? {})}`);
      e2e = true;
    } else {
      line(`    HTTP ${r.status} ❌  ${j?.error?.message ?? ''}`);
      line(`    access-control-allow-origin: ${acao ?? '缺失'}`);
      e2e = false;
    }
  } catch (e) {
    line(`    ❌ 请求失败: ${e.cause?.code ?? e.message}`);
    e2e = false;
  }
}

/* ── 结论 ── */
rule();
line('\n结论');
if (!preflightSeen) {
  line('  ⚠️  连不上目标端点，无法判断（检查网络 / 地址是否正确）。');
  line('     注意：网络不通和 CORS 被拦在浏览器里都可能表现为 "Failed to fetch"，');
  line('     所以不要在不通的环境里下"CORS 不支持"的结论。');
  process.exit(2);
}

if (preflightOk) {
  line('  ✅ 支持浏览器直连。预检放行，前端可以纯静态直连，不需要任何代理。');
  if (errorReadable) line('  ✅ 报错响应也带 CORS 头，前端能读到真实错误原因（体验更好）。');
  else line('  ⚠️  报错响应缺少 CORS 头：成功路径可用，但失败时浏览器会吞掉错误信息。');
  if (e2e === true) line('  ✅ 端到端已验证通过。');
  if (e2e === false) line('  ⚠️  端到端失败（可能是 Key 或余额问题，与 CORS 无关）。');
  line('\n  提醒：CORS 头是边缘配置，随时可能变且不会改文档。');
  line('        所以前端要留一个可覆盖的 API 地址设置，撤了 CORS 也能切代理。');
  process.exit(0);
} else {
  line('  ❌ 未回显 CORS 头 → 浏览器直连会被拦。');
  line('     方案：自建反代（Cloudflare Worker 免费额度足够），或换端点。');
  line('     注意：走代理意味着你的 API Key 会经过那台服务器。');
  process.exit(1);
}
