const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'access-control-allow-origin': origin && origin !== 'null' ? origin : '*',
    'access-control-allow-headers': 'content-type, authorization, x-admin-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'vary': 'Origin',
  };
}

const respond = (request, body, status = 200) => json(body, status, cors(request));

async function sha256(value, normalize = true) {
  const input = normalize ? value.trim().toUpperCase() : value;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request) {
  return request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

async function authenticatedUser(request, env) {
  const token = bearerToken(request);
  if (token && env.SUPABASE_URL && env.SUPABASE_ANON_KEY && !env.SUPABASE_ANON_KEY.startsWith('SET_')) {
    try {
      const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const user = await response.json();
      return user?.id ? { id: user.id, email: user.email || null } : null;
    } catch {
      return null;
    }
  }
  if (env.APP_ENV !== 'production') {
    const testId = request.headers.get('x-test-user-id');
    return testId ? { id: testId, email: null } : null;
  }
  return null;
}

async function requireAdmin(request, env) {
  const token = request.headers.get('x-admin-token');
  if (!token || !env.ADMIN_API_TOKEN) return false;
  return token === env.ADMIN_API_TOKEN;
}

async function ensureUser(env, user, nowIso) {
  await env.DB.prepare(`INSERT INTO users (id, email, created_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at`)
    .bind(user.id, user.email, nowIso).run();
}

async function currentMembership(env, userId, nowIso) {
  return env.DB.prepare(`SELECT m.id, m.expires_at, m.request_limit, m.used_requests,
      m.daily_request_limit, c.code_type
    FROM memberships m JOIN redeem_codes c ON c.id = m.code_id
    WHERE m.user_id = ?1 AND m.status = 'active' AND c.status != 'disabled'
      AND m.expires_at > ?2
    ORDER BY m.expires_at DESC LIMIT 1`).bind(userId, nowIso).first();
}

async function session(request, env) {
  const user = await authenticatedUser(request, env);
  if (!user) return respond(request, { authenticated: false, entitled: false });
  const nowIso = new Date().toISOString();
  await ensureUser(env, user, nowIso);
  const membership = await currentMembership(env, user.id, nowIso);
  if (!membership) return respond(request, { authenticated: true, user: { id: user.id, email: user.email }, entitled: false });
  const today = nowIso.slice(0, 10);
  const daily = await env.DB.prepare('SELECT request_count AS count FROM daily_usage WHERE user_id = ?1 AND usage_date = ?2').bind(user.id, today).first();
  return respond(request, {
    authenticated: true,
    user: { id: user.id, email: user.email },
    entitled: true,
    expiresAt: membership.expires_at,
    remainingRequests: Math.max(0, membership.request_limit - membership.used_requests),
    dailyRemaining: Math.max(0, membership.daily_request_limit - Number(daily?.count || 0)),
    features: { ai: true },
  });
}

async function reserveRequest(env, userId, membership, now) {
  const day = now.toISOString().slice(0, 10);
  const daily = await env.DB.prepare(`INSERT INTO daily_usage (user_id, usage_date, request_count)
    VALUES (?1, ?2, 1)
    ON CONFLICT(user_id, usage_date) DO UPDATE SET request_count = request_count + 1
    WHERE request_count < ?3`).bind(userId, day, membership.daily_request_limit).run();
  if (!daily.meta.changes) return { ok: false, reason: 'daily_limit' };

  const total = await env.DB.prepare(`UPDATE memberships SET used_requests = used_requests + 1
    WHERE id = ?1 AND used_requests < request_limit AND status = 'active' AND expires_at > ?2`)
    .bind(membership.id, now.toISOString()).run();
  if (!total.meta.changes) {
    await env.DB.prepare('UPDATE daily_usage SET request_count = MAX(0, request_count - 1) WHERE user_id = ?1 AND usage_date = ?2').bind(userId, day).run();
    return { ok: false, reason: 'request_limit' };
  }
  return { ok: true };
}

function validateChatBody(body) {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) return 'invalid_request';
  if (!['deepseek-chat', 'deepseek-reasoner'].includes(body.model)) return 'model_not_allowed';
  if (!body.messages.length || body.messages.length > 100) return 'invalid_messages';
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 64)) return 'invalid_tools';
  const serialized = JSON.stringify(body);
  if (serialized.length > 512 * 1024) return 'request_too_large';
  if (body.max_tokens != null && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096)) return 'invalid_max_tokens';
  return null;
}

async function recordUsage(env, userId, requestId, model, usage, status) {
  const input = Number(usage?.prompt_tokens || 0);
  const output = Number(usage?.completion_tokens || 0);
  const pricing = await env.DB.prepare('SELECT input_usd_per_million, output_usd_per_million FROM model_pricing WHERE model = ?1').bind(model).first();
  const cost = pricing && usage
    ? (input * pricing.input_usd_per_million + output * pricing.output_usd_per_million) / 1_000_000
    : null;
  await env.DB.prepare(`INSERT INTO usage_logs
    (id, user_id, request_id, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, status, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(crypto.randomUUID(), userId, requestId, model, input, output,
      Number(usage?.total_tokens || input + output), cost, status, new Date().toISOString()).run();
}

async function chat(request, env, ctx) {
  const user = await authenticatedUser(request, env);
  if (!user) return respond(request, { error: 'login_required' }, 401);
  if (!env.DEEPSEEK_API_KEY) return respond(request, { error: 'ai_not_configured' }, 503);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 512 * 1024) return respond(request, { error: 'request_too_large' }, 413);
  const body = await request.json().catch(() => null);
  const validationError = validateChatBody(body);
  if (validationError) return respond(request, { error: validationError }, validationError === 'request_too_large' ? 413 : 400);
  body.max_tokens = Math.min(body.max_tokens || 2048, 2048);

  const now = new Date();
  const nowIso = now.toISOString();
  await ensureUser(env, user, nowIso);
  const membership = await currentMembership(env, user.id, nowIso);
  if (!membership) return respond(request, { error: 'membership_required' }, 403);
  const reserved = await reserveRequest(env, user.id, membership, now);
  if (!reserved.ok) return respond(request, { error: reserved.reason }, 429);

  const requestId = crypto.randomUUID();
  let upstream;
  try {
    upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    ctx.waitUntil(recordUsage(env, user.id, requestId, body.model, null, 'network_error'));
    return respond(request, { error: 'upstream_unavailable' }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const errorBody = await upstream.text().catch(() => '');
    ctx.waitUntil(recordUsage(env, user.id, requestId, body.model, null, `upstream_${upstream.status}`));
    return new Response(errorBody || JSON.stringify({ error: 'upstream_error' }), {
      status: upstream.status || 502,
      headers: { ...cors(request), 'content-type': upstream.headers.get('content-type') || 'application/json' },
    });
  }

  let usage = null;
  let lineBuffer = '';
  const decoder = new TextDecoder();
  let recordPromise;
  const finish = status => {
    if (!recordPromise) {
      recordPromise = recordUsage(env, user.id, requestId, body.model, usage, status);
      ctx.waitUntil(recordPromise);
    }
  };
  const stream = upstream.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event.usage) usage = event.usage;
        } catch { /* Ignore incomplete or non-JSON SSE lines. */ }
      }
      controller.enqueue(chunk);
    },
    flush() { finish('ok'); },
    cancel() { finish('client_cancelled'); },
  }));
  return new Response(stream, { status: upstream.status, headers: { ...cors(request), 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache' } });
}

async function adminUsage(request, env) {
  if (!await requireAdmin(request, env)) return respond(request, { error: 'admin_required' }, 401);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
  const rows = await env.DB.prepare(`SELECT u.user_id, users.email, u.model, COUNT(*) AS requests,
      SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens,
      SUM(u.total_tokens) AS total_tokens, SUM(u.estimated_cost_usd) AS estimated_cost_usd,
      SUM(CASE WHEN u.estimated_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_requests
    FROM usage_logs u LEFT JOIN users ON users.id = u.user_id
    GROUP BY u.user_id, u.model ORDER BY MAX(u.created_at) DESC LIMIT ?1`).bind(limit).all();
  return respond(request, { items: rows.results || [] });
}

async function setPricing(request, env) {
  if (!await requireAdmin(request, env)) return respond(request, { error: 'admin_required' }, 401);
  const body = await request.json().catch(() => null);
  if (!body || !['deepseek-chat', 'deepseek-reasoner'].includes(body.model)
      || !Number.isFinite(body.inputUsdPerMillion) || body.inputUsdPerMillion < 0
      || !Number.isFinite(body.outputUsdPerMillion) || body.outputUsdPerMillion < 0) {
    return respond(request, { error: 'invalid_pricing' }, 400);
  }
  await env.DB.prepare(`INSERT INTO model_pricing (model, input_usd_per_million, output_usd_per_million, updated_at)
    VALUES (?1, ?2, ?3, ?4) ON CONFLICT(model) DO UPDATE SET input_usd_per_million = excluded.input_usd_per_million,
      output_usd_per_million = excluded.output_usd_per_million, updated_at = excluded.updated_at`)
    .bind(body.model, body.inputUsdPerMillion, body.outputUsdPerMillion, new Date().toISOString()).run();
  return respond(request, { ok: true, model: body.model });
}

async function redemptionHistory(request, env) {
  const user = await authenticatedUser(request, env);
  if (!user) return respond(request, { error: 'login_required' }, 401);
  const rows = await env.DB.prepare(`SELECT c.code_type, m.status, m.starts_at, m.expires_at,
      m.request_limit, m.used_requests, m.created_at
    FROM memberships m JOIN redeem_codes c ON c.id = m.code_id
    WHERE m.user_id = ?1 ORDER BY m.created_at DESC LIMIT 50`).bind(user.id).all();
  return respond(request, { items: rows.results || [] });
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const raw = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `TEST-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

async function redeem(request, env) {
  const user = await authenticatedUser(request, env);
  if (!user) return respond(request, { error: 'login_required' }, 401);
  const body = await request.json().catch(() => null);
  if (!body?.code || typeof body.code !== 'string' || body.code.length > 80) return respond(request, { error: 'invalid_code' }, 400);
  const codeHash = await sha256(body.code);
  const now = new Date();
  const nowIso = now.toISOString();
  const code = await env.DB.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?1').bind(codeHash).first();
  if (!code || code.status !== 'active') return respond(request, { error: 'code_unavailable' }, 403);
  if (code.expires_at && code.expires_at <= nowIso) return respond(request, { error: 'code_expired' }, 403);
  const existing = await env.DB.prepare('SELECT id FROM memberships WHERE user_id = ?1 AND code_id = ?2').bind(user.id, code.id).first();
  if (existing) return respond(request, { error: 'already_redeemed' }, 409);
  await ensureUser(env, user, nowIso);

  const membershipId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + code.duration_days * 86400000).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO memberships
      (id, user_id, code_id, starts_at, expires_at, request_limit, daily_request_limit, created_at)
      SELECT ?1, ?2, id, ?3, ?4, request_limit, daily_request_limit, ?3
      FROM redeem_codes
      WHERE id = ?5 AND status = 'active' AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?3)
        AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?2 AND code_id = ?5)`)
      .bind(membershipId, user.id, nowIso, expiresAt, code.id),
    env.DB.prepare(`UPDATE redeem_codes SET used_count = used_count + 1,
      status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END
      WHERE id = ?1 AND EXISTS (SELECT 1 FROM memberships WHERE id = ?2)`)
      .bind(code.id, membershipId),
  ]);
  if (!results[0]?.meta?.changes) return respond(request, { error: 'code_unavailable' }, 403);
  return respond(request, { entitled: true, expiresAt, remainingRequests: code.request_limit, dailyRemaining: code.daily_request_limit });
}

async function generateCodes(request, env) {
  if (!await requireAdmin(request, env)) return respond(request, { error: 'admin_required' }, 401);
  const body = await request.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count || 1), 1), 50);
  const durationDays = Math.min(Math.max(Number(body.durationDays || 60), 1), 3650);
  const requestLimit = Math.min(Math.max(Number(body.requestLimit || 300), 1), 100000);
  const dailyRequestLimit = Math.min(Math.max(Number(body.dailyRequestLimit || 30), 1), requestLimit);
  const codeType = typeof body.codeType === 'string' ? body.codeType.slice(0, 30) : 'trial';
  const expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
  const createdAt = new Date().toISOString();
  const codes = [];
  const statements = [];
  for (let i = 0; i < count; i += 1) {
    const code = randomCode();
    codes.push(code);
    statements.push(env.DB.prepare(`INSERT INTO redeem_codes
      (id, code_hash, code_type, expires_at, duration_days, max_uses, request_limit, daily_request_limit, created_by, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, 'admin', ?8)`)
      .bind(crypto.randomUUID(), await sha256(code), codeType, expiresAt, durationDays, requestLimit, dailyRequestLimit, createdAt));
  }
  await env.DB.batch(statements);
  return respond(request, { codes, count, durationDays, requestLimit, dailyRequestLimit, expiresAt });
}

async function listCodes(request, env) {
  if (!await requireAdmin(request, env)) return respond(request, { error: 'admin_required' }, 401);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
  const rows = status
    ? await env.DB.prepare('SELECT id, code_type, expires_at, duration_days, max_uses, used_count, request_limit, daily_request_limit, status, created_at, disabled_at FROM redeem_codes WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2').bind(status, limit).all()
    : await env.DB.prepare('SELECT id, code_type, expires_at, duration_days, max_uses, used_count, request_limit, daily_request_limit, status, created_at, disabled_at FROM redeem_codes ORDER BY created_at DESC LIMIT ?1').bind(limit).all();
  return respond(request, { items: rows.results || [] });
}

async function disableCode(request, env, codeId) {
  if (!await requireAdmin(request, env)) return respond(request, { error: 'admin_required' }, 401);
  const result = await env.DB.prepare(`UPDATE redeem_codes SET status = 'disabled', disabled_at = ?1
    WHERE id = ?2 AND status IN ('active', 'exhausted')`).bind(new Date().toISOString(), codeId).run();
  return result.meta.changes ? respond(request, { ok: true }) : respond(request, { error: 'code_not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const headers = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return respond(request, { ok: true, env: env.APP_ENV || 'unknown' });
      if (url.pathname === '/api/session' && request.method === 'GET') return session(request, env);
      if (url.pathname === '/api/chat' && request.method === 'POST') return chat(request, env, ctx);
      if (url.pathname === '/api/redeem/history' && request.method === 'GET') return redemptionHistory(request, env);
      if (url.pathname === '/api/redeem' && request.method === 'POST') return redeem(request, env);
      if (url.pathname === '/admin/codes' && request.method === 'POST') return generateCodes(request, env);
      if (url.pathname === '/admin/codes' && request.method === 'GET') return listCodes(request, env);
      if (url.pathname === '/admin/usage' && request.method === 'GET') return adminUsage(request, env);
      if (url.pathname === '/admin/pricing' && request.method === 'POST') return setPricing(request, env);
      const disableMatch = url.pathname.match(/^\/admin\/codes\/([^/]+)\/disable$/);
      if (disableMatch && request.method === 'POST') return disableCode(request, env, disableMatch[1]);
      return respond(request, { error: 'not_found' }, 404);
    } catch (error) {
      console.error('[worker]', error);
      return respond(request, { error: 'internal_error' }, 500);
    }
  },
};
