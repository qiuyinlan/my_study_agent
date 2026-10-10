// 判别 DeepSeek 的 CORS 是「白名单」还是「无脑回显 Origin」
// 这决定了前端能不能用 file:// 直接打开，还是必须挂一个静态服务器

const origins = [
  ['null（file:// 双击打开时的 Origin）', 'null'],
  ['http://localhost:8000（本地静态服务器）', 'http://localhost:8000'],
  ['http://127.0.0.1:5500（VSCode Live Server）', 'http://127.0.0.1:5500'],
  ['https://随便一个域名.github.io（线上静态托管）', 'https://random-abc123xyz.github.io'],
  ['（不发送 Origin 头）', null],
];

for (const [label, origin] of origins) {
  const headers = {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type',
  };
  if (origin !== null) headers.Origin = origin;

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'OPTIONS',
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const acao = r.headers.get('access-control-allow-origin');
    console.log(`${label}`);
    console.log(`   → ACAO: ${acao === null ? '❌ 缺失（被拒绝）' : `✅ ${acao}`}`);
    await r.text();
  } catch (e) {
    console.log(`${label}\n   → ❌ ${e.name}: ${e.cause?.code ?? e.message}`);
  }
}
