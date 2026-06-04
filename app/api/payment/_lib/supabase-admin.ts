// ============================================================================
// СЕРВЕРНЫЙ Supabase client с service-role ключом.
//
// Зачем: таблица public.subscriptions защищена RLS (есть только политика SELECT
// «свои строки»). INSERT/UPDATE с anon-клиента невозможен. Платёжный поток —
// серверный источник правды (создание pending-подписки, апдейт по webhook),
// поэтому пишем service-role клиентом, который обходит RLS.
//
// БЕЗОПАСНОСТЬ:
//   • SUPABASE_SERVICE_ROLE_KEY — СЕРВЕРНЫЙ секрет, без NEXT_PUBLIC.
//   • Импортировать ТОЛЬКО в серверных route-хендлерах (оплата, webhook).
//     Никогда не тянуть в клиентские компоненты.
//
// Возвращает null, если env не настроен — вызывающий код отдаёт понятную
// ошибку, ничего не падает на этапе сборки.
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
