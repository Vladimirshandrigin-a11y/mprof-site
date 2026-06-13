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
// withReadTimeout — страховка от «вечной загрузки».
//
// supabase-js НЕ ставит таймаут на запрос. Если маршрут до Supabase (AWS) висит
// без ответа (типично для РФ без VPN), `await supabase.from(...).select()` не
// завершается, и UI остаётся в loading навсегда. Здесь гоним запрос против
// таймера: не ответил за READ_TIMEOUT_MS → Error «Supabase не ответил вовремя»,
// который ловит обычный catch вызывающей функции и отдаёт его как
// CloudResult.error (UI уже умеет показать ошибку и погасить спиннер).
//
// Применяется ТОЛЬКО к read-функциям (история/каталог/аналитика). Запись и RPC
// списания квоты не трогаем. clearTimeout снимает таймер, если запрос успел
// ответить раньше; поздний ответ проигравшего гонку запроса игнорируется
// Promise.race (реакция уже навешана — unhandledrejection не возникает).
// ============================================================================
const READ_TIMEOUT_MS = 13000;

function withReadTimeout<T>(query: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Supabase не ответил вовремя")),
      READ_TIMEOUT_MS
    );
  });
  const wrapped = Promise.resolve(query).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return Promise.race([wrapped, timeout]);
}

// ============================================================================
// Cloud read-proxy — чтение истории/каталога/аналитики идёт через наши API
// routes на Timeweb (браузер → /api/cloud/... → Supabase server-side), а НЕ
// напрямую в Supabase. Зачем: из РФ без VPN прямой маршрут браузер→Supabase
// (AWS) виснет без ответа; серверный прокси на Timeweb ходит в Supabase сам.
//
// SERVICE_ROLE_KEY живёт ТОЛЬКО на сервере (в route), сюда не попадает. Клиент
// шлёт лишь свой access_token; user_id сервер берёт из токена и фильтрует по
// нему. withReadTimeout сохраняем — спиннер гаснет, даже если прокси молчит.
// ============================================================================

/** access_token текущей сессии для Authorization: Bearer. null — нет сессии. */
async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * GET к нашему cloud-proxy route. Возвращает CloudResult — тот же shape, что и
 * прямые supabase-функции, поэтому call-sites и fallback-UI не меняются. Весь
 * сетевой шаг (fetch + разбор тела) обёрнут в withReadTimeout: молчащий прокси
 * → Error «Supabase не ответил вовремя» → CloudResult.error, спиннер гаснет.
 */
async function cloudGet<T>(path: string): Promise<CloudResult<T>> {
  try {
    const token = await getAccessToken();
    if (!token) return { data: null, error: { message: "Требуется авторизация" } };
    const json = await withReadTimeout<{ data?: T; error?: string }>(
      (async () => {
        const res = await fetch(path, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const parsed = (await res.json().catch(() => ({}))) as {
          data?: T;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(parsed.error || `Ошибка сервера (${res.status})`);
        }
        return parsed;
      })()
    );
    return { data: (json.data ?? null) as T | null, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
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
  // eslint-disable-next-line no-console
  console.log("[cloud] loadCalculationsFromCloud", { userId, limit });
  const res = await cloudGet<CloudCalculation[]>(
    `/api/cloud/calculations?limit=${encodeURIComponent(limit)}`
  );
  if (res.error) {
    // eslint-disable-next-line no-console
    console.error("[cloud] loadCalculationsFromCloud error", res.error);
    return res;
  }
  // eslint-disable-next-line no-console
  console.log("[cloud] loadCalculationsFromCloud ok", {
    count: res.data?.length ?? 0,
  });
  return { data: res.data ?? [], error: null };
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
// Products — каталог товаров пользователя.
//
// RLS (см. supabase/schema.sql): пользователь видит/правит ТОЛЬКО свои строки
// (auth.uid() = user_id). Все функции возвращают CloudResult и не бросают.
// ============================================================================
export interface Product {
  id: string;
  user_id: string;
  /** Артикул. Может быть пустым. */
  sku: string | null;
  /** Название (обязательно на уровне UI). */
  name: string;
  /** Себестоимость, ₽. */
  cost_price: number;
  created_at: string;
  updated_at: string;
}

/** Поля для insert. user_id заполняется helper'ом из текущей сессии. */
export type ProductInsertInput = {
  sku: string | null;
  name: string;
  cost_price: number;
};

export type ProductUpdateInput = Partial<ProductInsertInput>;

export async function loadProductsFromCloud(
  userId: string
): Promise<CloudResult<Product[]>> {
  // eslint-disable-next-line no-console
  console.log("[cloud] loadProductsFromCloud", { userId });
  const res = await cloudGet<Product[]>("/api/cloud/products");
  if (res.error) return res;
  return { data: res.data ?? [], error: null };
}

export async function addProductToCloud(
  input: ProductInsertInput,
  userId: string
): Promise<CloudResult<Product>> {
  try {
    const payload = { ...input, user_id: userId };
    const { data, error } = await supabase
      .from("products")
      .insert([payload])
      .select()
      .single();
    if (error) return { data: null, error: fmtError(error) };
    return { data: (data as Product | null) ?? null, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

export async function updateProductInCloud(
  productId: string,
  fields: ProductUpdateInput,
  userId: string
): Promise<CloudResult<Product>> {
  try {
    const { data, error } = await supabase
      .from("products")
      .update(fields)
      .eq("id", productId)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) return { data: null, error: fmtError(error) };
    return { data: (data as Product | null) ?? null, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

export async function deleteProductFromCloud(
  productId: string,
  userId: string
): Promise<CloudResult<{ ok: true }>> {
  try {
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", productId)
      .eq("user_id", userId);
    if (error) return { data: null, error: fmtError(error) };
    return { data: { ok: true }, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

// ============================================================================
// report_history — помесячная история расчётов («Аналитика по месяцам»).
// Одна строка на сохранённый расчёт; UI группирует по report_month.
// ============================================================================
export interface CloudReportHistory {
  id: string;
  user_id: string;
  /** Первое число месяца отчёта, 'YYYY-MM-DD' (date в БД). */
  report_month: string;
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
  created_at: string;
}

/** Поля для insert. user_id добавляется helper'ом из текущей сессии. */
export type ReportHistoryInsertInput = Omit<
  CloudReportHistory,
  "id" | "user_id" | "created_at"
>;

export async function saveReportHistoryToCloud(
  input: ReportHistoryInsertInput,
  userId: string
): Promise<CloudResult<CloudReportHistory>> {
  try {
    const payload = { ...input, user_id: userId };
    const { data, error } = await supabase
      .from("report_history")
      .insert([payload])
      .select()
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[cloud] saveReportHistoryToCloud error", fmtError(error));
      return { data: null, error: fmtError(error) };
    }
    return { data: (data as CloudReportHistory | null) ?? null, error: null };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cloud] saveReportHistoryToCloud throw", fmtError(e));
    return { data: null, error: fmtError(e) };
  }
}

export async function loadReportHistoryFromCloud(
  userId: string
): Promise<CloudResult<CloudReportHistory[]>> {
  // eslint-disable-next-line no-console
  console.log("[cloud] loadReportHistoryFromCloud", { userId });
  const res = await cloudGet<CloudReportHistory[]>("/api/cloud/report-history");
  if (res.error) {
    // eslint-disable-next-line no-console
    console.error("[cloud] loadReportHistoryFromCloud error", res.error);
    return res;
  }
  return { data: res.data ?? [], error: null };
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
