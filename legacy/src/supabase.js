let client = null;

export function getSupabaseClient() {
  if (client) return client;
  const config = window.APP_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    console.warn('[supabase] 缺少 supabase-config.js 配置');
    return null;
  }
  if (!window.supabase?.createClient) {
    console.warn('[supabase] SDK 未加载，通常是 CDN 被网络拦截或连接中断');
    return null;
  }
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  return client;
}
