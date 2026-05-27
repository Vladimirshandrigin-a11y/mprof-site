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

// ============================================================================
// Calculations
// ============================================================================
export async function saveCalculationToCloud(
  input: CalculationInsertInput,
  userId: string
): Promise<CloudResult<CloudCalculation>> {
  try {
    const payload = { ...input, user_id: userId };
    const { data, error } = await supabase
      .from("calculations")
      .insert([payload])
      .select()
      .single();
    if (error) return { data: null, error: fmtError(error) };
    return { data: (data as CloudCalculation | null) ?? null, error: null };
  } catch (e) {
    return { data: null, error: fmtError(e) };
  }
}

export async function loadCalculationsFromCloud(
  userId: string,
  limit = 50
): Promise<CloudResult<CloudCalculation[]>> {
  try {
    const { data, error } = await supabase
      .from("calculations")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { data: null, error: fmtError(error) };
    return { data: ((data as CloudCalculation[]) ?? []), error: null };
  } catch (e) {
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
    const { data, error } = await supabase
      .from("uploaded_reports")
      .insert([payload])
      .select()
      .single();
    if (error) return { data: null, error: fmtError(error) };
    return { data: (data as CloudUploadedReport | null) ?? null, error: null };
  } catch (e) {
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
