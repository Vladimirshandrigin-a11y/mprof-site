import { type SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Серверная ПРОВЕРКА права на расчёт (check-only, БЕЗ списания) — PR #20.
//
// Зеркалит клиентский useEntitlements (app/app/lib/entitlements.ts) и SQL-RPC
// consume_calculation() (supabase/schema.sql), но на сервере и из авторитетных
// источников (service-role admin + .eq(user_id) — числам с фронтенда не верим):
//   • hasPremium    — активный безлимит: profiles.plan='unlimited' И
//                     premium_until > now();
//   • singleCredits — число активных single-кредитов (subscriptions
//                     plan='single', status='active'); каждый = +1 расчёт;
//   • used          — profiles.calculations_used (израсходовано);
//   • allowance     — FREE_CALCULATIONS_LIMIT + singleCredits;
//   • hasAccess     — hasPremium ИЛИ used < allowance.
//
// Это НЕ списание и НЕ источник правды для расхода квоты. Авторитетное списание —
// RPC consume_calculation() (под row-lock) в /api/ozon/save-calculation. Здесь
// только ГЕЙТ preview, чтобы полный API-расчёт не отдавался без права. Никаких
// цен/тарифов не хардкодим — только лимиты, идентичные клиенту и RPC.
//
// Fail-closed: реальная ошибка чтения профиля → hasAccess=false (при сбое расчёт
// не отдаём). Отсутствие строки profiles (новый пользователь) — это НЕ ошибка:
// used=0, бесплатный пробный расчёт доступен (как в useEntitlements и в RPC,
// который сам создаёт профиль). Ошибка чтения кредитов → 0 (как на клиенте).
// ============================================================================

/** 1 бесплатный расчёт на пользователя (как FREE_CALCULATIONS_LIMIT на клиенте). */
export const FREE_CALCULATIONS_LIMIT = 1;

export type EntitlementCheck = {
  hasAccess: boolean;
  hasPremium: boolean;
  used: number;
  allowance: number;
  singleCredits: number;
};

const NO_ACCESS: EntitlementCheck = {
  hasAccess: false,
  hasPremium: false,
  used: 0,
  allowance: FREE_CALCULATIONS_LIMIT,
  singleCredits: 0,
};

/**
 * Проверить, есть ли у пользователя право на ОДИН расчёт, НЕ списывая попытку.
 * admin — service-role клиент; userId берётся ТОЛЬКО из токена вызывающим роутом.
 */
export async function checkCalculationEntitlement(
  admin: SupabaseClient,
  userId: string
): Promise<EntitlementCheck> {
  // 1) профиль: plan / premium_until / calculations_used
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("plan, premium_until, calculations_used")
    .eq("id", userId)
    .maybeSingle();

  if (profErr) {
    // eslint-disable-next-line no-console
    console.error("[entitlement] profile select error", profErr);
    return { ...NO_ACCESS }; // fail-closed: при сбое чтения профиля доступа нет
  }

  const plan = (profile?.plan as string | null) ?? null;
  const premiumUntil = (profile?.premium_until as string | null) ?? null;
  const used =
    typeof profile?.calculations_used === "number"
      ? (profile.calculations_used as number)
      : 0;

  // Безлимит активен только для unlimited со свежим сроком (как isUnlimitedActive).
  const parsedUntil = premiumUntil ? Date.parse(premiumUntil) : NaN;
  const hasPremium =
    plan === "unlimited" &&
    Number.isFinite(parsedUntil) &&
    parsedUntil > Date.now();

  // 2) активные single-кредиты (сбой → 0, как fail-closed на клиенте)
  let singleCredits = 0;
  const { count, error: credErr } = await admin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("plan", "single")
    .eq("status", "active");
  if (credErr) {
    // eslint-disable-next-line no-console
    console.error("[entitlement] single-credits count error", credErr);
    singleCredits = 0;
  } else {
    singleCredits = count ?? 0;
  }

  const allowance = FREE_CALCULATIONS_LIMIT + singleCredits;
  const hasAccess = hasPremium || used < allowance;

  return { hasAccess, hasPremium, used, allowance, singleCredits };
}
