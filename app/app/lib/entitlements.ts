"use client";

import { useCallback, useEffect, useState } from "react";
import {
  consumeCalculation as consumeCalculationRpc,
  countActiveSingleCredits,
  getCurrentUser,
  getUserProfile,
  type UserProfile,
} from "./supabase-cloud";

const STORAGE_KEY = "mprof_calc_count";

export const FREE_CALCULATIONS_LIMIT = 1;

export interface Entitlements {
  /** Активный безлимит (тариф unlimited). single «премиумом» НЕ считается. */
  hasPremium: boolean;
  /** Число активных оплаченных разовых расчётов (single-кредитов). Для анонима 0. */
  singleCredits: number;
  /** ISO-срок окончания безлимита (profiles.premium_until) либо null. Только для показа статуса. */
  premiumUntil: string | null;
  freeCalculationsLimit: number;
  /** Сколько расчётов уже израсходовано (profiles.calculations_used; для анонима — localStorage). */
  calcCount: number;
  /** Можно ли запустить ещё один расчёт. */
  canCalculate: boolean;
  /** Загружены ли права — против мерцания paywall до ответа Supabase. */
  loaded: boolean;
  /**
   * Списать один расчёт. Для залогиненного — server-authoritative (RPC
   * consume_calculation, инкремент в БД под row-lock); для анонима — localStorage.
   * Вызывать ПЕРЕД сохранением/выдачей результата; при ok=false → paywall, результат
   * не показывать.
   */
  consumeCalculation: () => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Безлимит активен только для тарифа unlimited со свежим сроком:
 *   plan === 'unlimited'  И  premium_until существует  И  premium_until > now.
 * single сюда НЕ входит — он даёт разовые расчёты-кредиты, а не премиум по
 * времени. premium_until наполняет webhook ЮKassa только для unlimited.
 */
function isUnlimitedActive(profile: UserProfile | null): boolean {
  if (!profile) return false;
  if (profile.plan !== "unlimited") return false;
  if (!profile.premium_until) return false;
  const until = Date.parse(profile.premium_until);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Модель квоты:
 *   • free      — 1 бесплатный расчёт (FREE_CALCULATIONS_LIMIT);
 *   • single    — +1 оплаченный расчёт за каждую активную single-подписку
 *                 (реестр кредитов в таблице subscriptions, НЕ premium_until);
 *   • unlimited — безлимит, пока premium_until > now.
 *
 * Источник правды для залогиненного пользователя — Supabase:
 *   calcCount      = profiles.calculations_used (израсходовано);
 *   singleCredits  = число активных single-подписок (докуплено);
 *   hasPremium     = активный unlimited.
 * canCalculate = hasPremium ИЛИ calcCount < (1 + singleCredits).
 *
 * Аноним (не залогинен) считается по localStorage, как раньше: 1 бесплатный
 * расчёт на устройство. Платные тарифы требуют входа, так что кредитов у него нет.
 * `loaded` становится true только после ответа Supabase — чтобы premium-/credit-
 * пользователь не увидел мигание paywall до загрузки прав.
 */
export function useEntitlements(): Entitlements {
  const [calcCount, setCalcCount] = useState(0);
  const [hasPremium, setHasPremium] = useState(false);
  const [singleCredits, setSingleCredits] = useState(0);
  const [premiumUntil, setPremiumUntil] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Страховка от вечного !loaded: getCurrentUser()/getSession в supabase-js
    // может зависнуть (navigator-lock / refresh токена). Пока loaded=false,
    // тарифный блок и paywall не отрисуются — поэтому гарантированно снимаем флаг
    // максимум через 8с. Премиум/кредиты подтянутся, когда запрос всё же ответит.
    const safety = setTimeout(() => {
      if (!cancelled) setLoaded(true);
    }, 8000);
    (async () => {
      try {
        const { user } = await getCurrentUser();

        // Аноним — лимит из localStorage (переживает чистку history).
        if (!user) {
          let n = 0;
          try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            const parsed = stored ? parseInt(stored, 10) : 0;
            n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          } catch {
            /* localStorage недоступен — оставляем 0 */
          }
          if (!cancelled) {
            setUserId(null);
            setCalcCount(n);
            setHasPremium(false);
            setSingleCredits(0);
            setPremiumUntil(null);
          }
          return;
        }

        // Залогинен — источник правды Supabase: профиль + реестр single-кредитов.
        const [{ data: profile }, credits] = await Promise.all([
          getUserProfile(user.id),
          countActiveSingleCredits(user.id),
        ]);
        if (!cancelled) {
          setUserId(user.id);
          setCalcCount(profile?.calculations_used ?? 0);
          setHasPremium(isUnlimitedActive(profile));
          setSingleCredits(credits);
          setPremiumUntil(profile?.premium_until ?? null);
        }
      } catch {
        // Любой сбой Supabase — нет премиума/кредитов, но UI не падает.
        if (!cancelled) {
          setHasPremium(false);
          setSingleCredits(0);
          setPremiumUntil(null);
        }
      } finally {
        if (!cancelled) {
          clearTimeout(safety);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(safety);
    };
  }, []);

  const consumeCalculation = useCallback(async (): Promise<{
    ok: boolean;
    reason?: string;
  }> => {
    // Залогинен — авторитетное списание на сервере (RPC). Локальный счётчик
    // синхронизируем из ответа и при успехе, и при limit_reached — чтобы кнопка
    // мгновенно стала paywall, если другой таб уже израсходовал кредит.
    if (userId) {
      const res = await consumeCalculationRpc();
      if (typeof res.used === "number") setCalcCount(res.used);
      else if (res.ok && !res.unlimited) setCalcCount((prev) => prev + 1);
      return { ok: res.ok, reason: res.reason };
    }

    // Аноним — лимит из localStorage, без сервера: кредитов/премиума нет,
    // allowance = FREE_CALCULATIONS_LIMIT. Проверяем и инкрементим локально.
    if (calcCount >= FREE_CALCULATIONS_LIMIT) {
      return { ok: false, reason: "limit_reached" };
    }
    const next = calcCount + 1;
    setCalcCount(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
    return { ok: true };
  }, [userId, calcCount]);

  const allowance = FREE_CALCULATIONS_LIMIT + singleCredits;
  const canCalculate = hasPremium || calcCount < allowance;

  return {
    hasPremium,
    singleCredits,
    premiumUntil,
    freeCalculationsLimit: FREE_CALCULATIONS_LIMIT,
    calcCount,
    canCalculate,
    loaded,
    consumeCalculation,
  };
}
