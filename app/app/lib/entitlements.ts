"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mprof_calc_count";

export const FREE_CALCULATIONS_LIMIT = 1;

export interface Entitlements {
  hasPremium: boolean;
  freeCalculationsLimit: number;
  /** Сколько расчётов уже сделал пользователь (persistent, не сбрасывается чисткой history). */
  calcCount: number;
  /** Можно ли запустить ещё один расчёт. */
  canCalculate: boolean;
  /** Загружен ли стейт с устройства (для избежания мерцания UI). */
  loaded: boolean;
  /** Вызывать ОДИН раз после успешного завершения calculate(). */
  incrementCalcCount: () => void;
}

/**
 * MVP-источник энтайтлментов:
 *   - hasPremium всегда false (константа). Перевести на true, когда подключим billing.
 *   - calcCount хранится в localStorage и переживает clearHistory()/deleteHistoryItem().
 *
 * Когда подключим биллинг (Stripe / ЮKassa / Tinkoff), заменим источники:
 *   - hasPremium  → проверка подписки в supabase profile / billing API
 *   - calcCount   → колонка в supabase или backend-counter
 * Контракт `Entitlements` останется тем же — UI не нужно будет переписывать.
 */
export function useEntitlements(): Entitlements {
  const [calcCount, setCalcCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const n = stored ? parseInt(stored, 10) : 0;
      setCalcCount(Number.isFinite(n) && n > 0 ? n : 0);
    } catch {
      /* localStorage недоступен — оставляем 0 */
    }
    setLoaded(true);
  }, []);

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║ 🛠 DEV MODE — payment restrictions ОТКЛЮЧЕНЫ                     ║
  // ║                                                                  ║
  // ║ Все расчёты доступны, AI Аналитика разблокирована, paywall не    ║
  // ║ всплывает. Тарифные карточки и onboarding modal остаются видимы. ║
  // ║                                                                  ║
  // ║ Чтобы ВЕРНУТЬ оплату:                                            ║
  // ║   1. Замени `const hasPremium = true;` на `false`                ║
  // ║      (или подключи реальный billing-источник).                   ║
  // ║   2. Билд → проверь paywall flow + AI PRO lock.                  ║
  // ╚══════════════════════════════════════════════════════════════════╝
  const hasPremium = true;

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

  const canCalculate =
    hasPremium || calcCount < FREE_CALCULATIONS_LIMIT;

  return {
    hasPremium,
    freeCalculationsLimit: FREE_CALCULATIONS_LIMIT,
    calcCount,
    canCalculate,
    loaded,
    incrementCalcCount,
  };
}
