// ── 配置：只放小东西。API Key 在这里，学习数据一律进 IndexedDB ──

const LS_SETTINGS = 'msa.settings.v1';
const LS_APIKEY = 'msa.apikey';
const SS_APIKEY = 'msa.apikey.session';

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  reasonModel: 'deepseek-reasoner',
  enableTools: true,
  persistKey: true,
  recentMessages: 14,   // 携带多少条原文消息
  memoryLimit: 6,       // 额外注入多少条长期记忆
  includeUsage: true,   // 请求返回 token 用量
};

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
  } catch {
    stored = {};
  }
  const s = { ...DEFAULTS, ...stored };
  s.apiKey = (
    localStorage.getItem(LS_APIKEY) ||
    sessionStorage.getItem(SS_APIKEY) ||
    ''
  );
  return s;
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };

  const { apiKey, ...rest } = next;
  localStorage.setItem(LS_SETTINGS, JSON.stringify(rest));

  // Key 单独存：勾了"持久化"才落 localStorage，否则只活在这个标签页里
  if (next.persistKey) {
    sessionStorage.removeItem(SS_APIKEY);
    if (apiKey) localStorage.setItem(LS_APIKEY, apiKey);
    else localStorage.removeItem(LS_APIKEY);
  } else {
    localStorage.removeItem(LS_APIKEY);
    if (apiKey) sessionStorage.setItem(SS_APIKEY, apiKey);
    else sessionStorage.removeItem(SS_APIKEY);
  }

  return next;
}

export function maskedKey(key) {
  if (!key) return '(未设置)';
  if (key.length <= 12) return key.slice(0, 3) + '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export const apiUrl = base => `${String(base || DEFAULTS.baseUrl).replace(/\/+$/, '')}/chat/completions`;
