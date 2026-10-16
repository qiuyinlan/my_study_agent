import { getSupabaseClient } from './supabase.js';

function workerBaseUrl() {
  return String(window.APP_CONFIG?.workerUrl || '').trim().replace(/\/+$/, '');
}

async function workerRequest(path, { method = 'GET', body } = {}) {
  const base = workerBaseUrl();
  if (!base) throw new Error('后端尚未配置；部署 Worker 后在 supabase-config.js 设置 workerUrl');
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase 尚未配置');
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error('请先在上方登录测试账号');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      login_required: '请先登录测试账号',
      code_unavailable: '兑换码无效、已停用或已被兑换',
      code_expired: '兑换码已过期',
      code_exhausted: '兑换码已达到使用次数上限',
      already_redeemed: '这个兑换码已由当前账号兑换',
    };
    throw new Error(messages[result.error] || `后端请求失败 (${response.status})`);
  }
  return result;
}

export function workerConfigured() {
  return Boolean(workerBaseUrl());
}

export async function workerChat(body, signal) {
  const base = workerBaseUrl();
  if (!base) throw new Error('后端尚未配置');
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase 尚未配置');
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error('请先登录测试账号');
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export async function getWorkerSession() {
  return workerRequest('/api/session');
}

export async function getTestAccess() {
  const [access, history] = await Promise.all([
    workerRequest('/api/session'),
    workerRequest('/api/redeem/history'),
  ]);
  return { access, history: history.items || [] };
}

export function redeemTestCode(code) {
  return workerRequest('/api/redeem', { method: 'POST', body: { code } });
}
