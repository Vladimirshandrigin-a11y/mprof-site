"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getCurrentUser,
  getUserProfile,
  type UserProfile,
} from "./supabase-cloud";

const STORAGE_KEY = "mprof_calc_count";

export const FREE_CALCULATIONS_LIMIT = 1;

export interface Entitlements {
  hasPremium: boolean;
  freeCalculationsLimit: number;
  /** Сколько расчётов уже сделал пользователь (persistent, не сбрасывается чисткой history). */
  calcCount: number;
  /** Можно ли запустить ещё один расчёт. */
  canCalculate: boolean;
  /** Загружены ли права (localStorage + профиль Supabase) — против мерцания UI. */
  loaded: boolean;
  /** Вызывать ОДИН раз после успешного завершения calculate(). */
  incrementCalcCount: () => void;
}

/**
 * Премиум активен, если профиль на платном тарифе и срок ещё не истёк:
 *   plan ∈ {single, unlimited}  И  premium_until существует  И  premium_until > now.
 * Поля profiles.plan / premium_until наполняет webhook ЮKassa
 * (/api/payment/webhook) после успешной оплаты.
 */
function isPremiumActive(profile: UserProfile | null): boolean {
  if (!profile) return false;
  if (profile.plan !== "single" && profile.plan !== "unlimited") return false;
  if (!profile.premium_until) return false;
  const until = Date.parse(profile.premium_until);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Источник энтайтлментов:
 *   - hasPremium — реальная проверка профиля Supabase (plan + premium_until).
 *     Не залогинен / нет профиля / ошибка Supabase → false, сайт не падает.
 *   - calcCount — localStorage, переживает clearHistory()/deleteHistoryItem().
 *
 * Контракт `Entitlements` стабилен — UI переписывать не нужно. `loaded`
 * становится true только когда готовы ОБА источника (localStorage + профиль),
 * чтобы premium-пользователь не увидел мигание paywall до загрузки прав.
 */
export function useEntitlements(): Entitlements {
  const [calcCount, setCalcCount] = useState(0);
  const [hasPremium, setHasPremium] = useState(false);
  const [calcLoaded, setCalcLoaded] = useState(false);
  const [premiumLoaded, setPremiumLoaded] = useState(false);

  // calcCount с устройства.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const n = stored ? parseInt(stored, 10) : 0;
      setCalcCount(Number.isFinite(n) && n > 0 ? n : 0);
    } catch {
      /* localStorage недоступен — оставляем 0 */
    }
    setCalcLoaded(true);
  }, []);

  // Реальные права: текущий пользователь → его профиль в Supabase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { user } = await getCurrentUser();
        if (!user) {
          if (!cancelled) setHasPremium(false);
          return;
        }
        const { data: profile } = await getUserProfile(user.id);
        if (!cancelled) setHasPremium(isPremiumActive(profile));
      } catch {
        // Любой сбой Supabase — нет премиума, но UI не падает.
        if (!cancelled) setHasPremium(false);
      } finally {
        if (!cancelled) setPremiumLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const incrementCalcCount = useCallback(() => {
    setCalcCount((prev) => {
      const next = prev + 1;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const loaded = calcLoaded && premiumLoaded;
  const canCalculate = hasPremium || calcCount < FREE_CALCULATIONS_LIMIT;

  return {
    hasPremium,
    freeCalculationsLimit: FREE_CALCULATIONS_LIMIT,
    calcCount,
    canCalculate,
    loaded,
    incrementCalcCount,
  };
}
