let client = null;

export function getSupabaseClient() {
  if (client) return client;
  const config = window.APP_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) return null;
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  return client;
}
