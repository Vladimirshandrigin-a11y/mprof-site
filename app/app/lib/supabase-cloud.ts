"use client";

import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

// ============================================================================
// Supabase client — module-scope с placeholder fallback'ом, чтобы build
// (Railway/CI без env) не падал на module-eval. При наличии env ходит в
// настоящий Supabase. Module-scope const (а не factory) — чтобы TypeScript
// корректно выводил типы Row для .from(...).insert(...).
// ============================================================================
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "placeholder-anon-key";

/**
 * Единственный экземпляр Supabase client для всего приложения.
 * Экспортируется, чтобы dashboard и helpers использовали один клиент
 * (иначе supabase-js пишет warning: "Multiple GoTrueClient instances detected
 * in the same browser context").
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// ============================================================================
// Public types — отражают schema из supabase/schema.sql
// ============================================================================
export type Marketplace = "ozon" | "wb";
export type CalcMode = "manual" | "upload" | "api";

export type SubscriptionPlan = "single" | "unlimited";
export type SubscriptionStatus =
  | "pending"
  | "active"
  | "expired"
  | "cancelled"
  | "failed";

export type UserPlan = "free" | "single" | "unlimited";

export interface UserProfile {
  id: string;
  email: string | null;
  plan: UserPlan;
  premium_until: string | null;
  calculations_used: number;
  created_at: string;
}

export interface CloudCalculation {
  id: string;
  user_id: string;
  marketplace: Marketplace;
  mode: CalcMode;
  revenue: number;
  commission: number;
  logistics: number;
  ads: number;
  storage: number;
  tax: number;
  cost: number;
  other_expenses: number;
  total_expenses: number;
  profit: number;
  margin: number;
  ai_score: number | null;
  ai_insights: unknown | null;
  created_at: string;
}

export interface CloudUploadedReport {
  id: string;
  user_id: string;
  file_name: string | null;
  file_size: string | null;
  marketplace: Marketplace | null;
  period: string | null;
  rows_count: number | null;
  status: "processed" | "failed" | "pending";
  calculation_id: string | null;
  created_at: string;
}

/** Поля для insert calculation. user_id обязателен (заполняется helper'ом из текущей сессии). */
export type CalculationInsertInput = Omit<
  CloudCalculation,
  "id" | "user_id" | "created_at" | "ai_score" | "ai_insights"
> & {
  ai_score?: number | null;
  ai_insights?: unknown | null;
};

export type UploadedReportInsertInput = Omit<
  CloudUploadedReport,
  "id" | "user_id" | "created_at" | "status"
> & {
  status?: "processed" | "failed" | "pending";
};

// ============================================================================
// CloudResult — единый shape для всех функций. Никогда не бросает исключение.
// ============================================================================
export interface CloudErrorInfo {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface CloudResult<T> {
  data: T | null;
  error: CloudErrorInfo | null;
}

function fmtError(err: unknown): CloudErrorInfo {
  if (!err) return { message: "Неизвестная ошибка" };
  if (typeof err === "string") return { message: err };
  if (err instanceof Error) return { message: err.message };
  const e = err as Record<string, unknown>;
  return {
    message: (e.message as string) || "Неизвестная ошибка",
    code: e.code as string | undefined,
    details: e.details as string | undefined,
    hint: e.hint as string | undefined,
  };
}

// ============================================================================
// Auth
// ============================================================================
export async function getCurrentUser(): Promise<{
  user: User | null;
  error: CloudErrorInfo | null;
}> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return { user: null, error: fmtError(error) };
    return { user: data.session?.user ?? null, error: null };
  } catch (e) {
    return { user: null, error: fmtError(e) };
  }
}

// ============================================================================
// Profile
// ============================================================================
export async function getUserProfile(
  userId: string
): Promise<CloudResult<UserProfile>> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error) return { data: null, error: fmtError(error) };
    return { data: (data as UserProfile | null) ?? null, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

/**
 * Сколько ОПЛАЧЕННЫХ разовых расчётов (тариф single) есть у пользователя.
 * Каждая активная single-подписка = +1 расчёт сверх бесплатного лимита.
 * Это «реестр кредитов»: webhook ЮKassa переводит подписку в active, а сам
 * факт использования считается через profiles.calculations_used. Не зависит
 * от записи в profiles — поэтому single работает, даже если premium_until/plan
 * в профиле по какой-то причине не обновились.
 * RLS subscriptions_select_own отдаёт только свои строки. Сбой → 0 (fail-closed).
 */
export async function countActiveSingleCredits(userId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("plan", "single")
      .eq("status", "active");
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/** Ответ RPC consume_calculation() (см. supabase/schema.sql). */
export interface ConsumeResult {
  ok: boolean;
  /** При ok=false: 'limit_reached' | 'not_authenticated' | текст ошибки RPC. */
  reason?: string;
  /** Новое значение profiles.calculations_used после списания. */
  used?: number;
  /** Текущий лимит = 1 бесплатный + число активных single-кредитов. */
  allowance?: number;
  /** true, если списания не было — активный unlimited. */
  unlimited?: boolean;
}

/**
 * Server-authoritative списание одного расчёта через RPC consume_calculation().
 * Единственный путь расхода квоты для залогиненного пользователя: клиент больше
 * НЕ пишет profiles.calculations_used напрямую (UPDATE на profiles ему отозван
 * в schema.sql). Сервер атомарно под row-lock проверяет право и инкрементит
 * счётчик; для unlimited со свежим premium_until — не списывает.
 *
 * Fail-closed: любая ошибка RPC → ok=false (не выдаём бесплатный расчёт при сбое).
 * Вызывать РОВНО один раз на расчёт, ПЕРЕД сохранением/выдачей результата.
 */
export async function consumeCalculation(): Promise<ConsumeResult> {
  try {
    const { data, error } = await supabase.rpc("consume_calculation");
    if (error) return { ok: false, reason: error.message };
    const r = (data ?? {}) as Partial<ConsumeResult>;
    return {
      ok: r.ok === true,
      reason: r.reason,
      used: typeof r.used === "number" ? r.used : undefined,
      allowance: typeof r.allowance === "number" ? r.allowance : undefined,
      unlimited: r.unlimited === true,
    };
  } catch (e) {
    return { ok: false, reason: fmtError(e).message };
  }
}

// ============================================================================
// Calculations
// ============================================================================
export async function saveCalculationToCloud(
  input: CalculationInsertInput,
  userId: string
): Promise<CloudResult<CloudCalculation>> {
  try {
    const payload = { ...input, user_id: userId };
    // eslint-disable-next-line no-console
    console.log("[cloud] saveCalculationToCloud payload", payload);
    const { data, error } = await supabase
      .from("calculations")
      .insert([payload])
      .select()
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[cloud] saveCalculationToCloud error", fmtError(error));
      return { data: null, error: fmtError(error) };
    }
    // eslint-disable-next-line no-console
    console.log("[cloud] saveCalculationToCloud ok", { id: (data as { id?: string } | null)?.id });
    return { data: (data as CloudCalculation | null) ?? null, error: null };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cloud] saveCalculationToCloud throw", fmtError(e));
    return { data: null, error: fmtError(e) };
  }
}

/**
 * Точечный UPDATE существующего calculation. Используется, чтобы «черновик»
 * 3-файлового анализа превратить в финальную чистую прибыль, не создавая
 * вторую строку. RLS-политика `calculations_update_own` разрешает апдейт
 * только своих строк (auth.uid() = user_id). Никогда не бросает.
 * Если строка не найдена (например, была удалена) — `.single()` вернёт error,
 * вызывающий код делает fallback на insert.
 */
export async function updateCalculationInCloud(
  calculationId: string,
  fields: Partial<CalculationInsertInput>,
  userId: string
): Promise<CloudResult<CloudCalculation>> {
  try {
    // eslint-disable-next-line no-console
    console.log("[cloud] updateCalculationInCloud", { calculationId });
    const { data, error } = await supabase
      .from("calculations")
      .update(fields)
      .eq("id", calculationId)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[cloud] updateCalculationInCloud error", fmtError(error));
      return { data: null, error: fmtError(error) };
    }
    // eslint-disable-next-line no-console
    console.log("[cloud] updateCalculationInCloud ok", { id: (data as { id?: string } | null)?.id });
    return { data: (data as CloudCalculation | null) ?? null, error: null };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cloud] updateCalculationInCloud throw", fmtError(e));
    return { data: null, error: fmtError(e) };
  }
}

export async function loadCalculationsFromCloud(
  userId: string,
  limit = 50
): Promise<CloudResult<CloudCalculation[]>> {
  try {
    // eslint-disable-next-line no-console
    console.log("[cloud] loadCalculationsFromCloud", { userId, limit });
    const { data, error } = await supabase
      .from("calculations")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[cloud] loadCalculationsFromCloud error", fmtError(error));
      return { data: null, error: fmtError(error) };
    }
    // eslint-disable-next-line no-console
    console.log("[cloud] loadCalculationsFromCloud ok", { count: data?.length ?? 0 });
    return { data: ((data as CloudCalculation[]) ?? []), error: null };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cloud] loadCalculationsFromCloud throw", fmtError(e));
    return { data: null, error: fmtError(e) };
  }
}

export async function deleteCalculationFromCloud(
  calculationId: string,
  userId: string
): Promise<CloudResult<{ ok: true }>> {
  try {
    const { error } = await supabase
      .from("calculations")
      .delete()
      .eq("id", calculationId)
      .eq("user_id", userId);
    if (error) return { data: null, error: fmtError(error) };
    return { data: { ok: true }, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

/** Удалить ВСЕ расчёты пользователя. Используется кнопкой «Очистить историю». */
export async function clearCalculationsFromCloud(
  userId: string
): Promise<CloudResult<{ ok: true }>> {
  try {
    const { error } = await supabase
      .from("calculations")
      .delete()
      .eq("user_id", userId);
    if (error) return { data: null, error: fmtError(error) };
    return { data: { ok: true }, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

// ============================================================================
// Uploaded reports
// ============================================================================
export async function saveUploadedReportToCloud(
  input: UploadedReportInsertInput,
  userId: string
): Promise<CloudResult<CloudUploadedReport>> {
  try {
    const payload = { ...input, user_id: userId };
    // eslint-disable-next-line no-console
    console.log("[cloud] saveUploadedReportToCloud payload", payload);
    const { data, error } = await supabase
      .from("uploaded_reports")
      .insert([payload])
      .select()
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[cloud] saveUploadedReportToCloud error", fmtError(error));
      return { data: null, error: fmtError(error) };
    }
    // eslint-disable-next-line no-console
    console.log("[cloud] saveUploadedReportToCloud ok", { id: (data as { id?: string } | null)?.id });
    return { data: (data as CloudUploadedReport | null) ?? null, error: null };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cloud] saveUploadedReportToCloud throw", fmtError(e));
    return { data: null, error: fmtError(e) };
  }
}

export async function loadUploadedReportsFromCloud(
  userId: string,
  limit = 20
): Promise<CloudResult<CloudUploadedReport[]>> {
  try {
    const { data, error } = await supabase
      .from("uploaded_reports")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { data: null, error: fmtError(error) };
    return { data: ((data as CloudUploadedReport[]) ?? []), error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

// ============================================================================
// Convenience: проверить доступен ли cloud-режим
// (есть env и есть залогиненный пользователь). При false — UI остаётся в
// localStorage fallback'е.
// ============================================================================
export function isCloudConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}
