// ============================================================================
// Доступ к расчёту через Ozon API — ТОЛЬКО для отображения (какую кнопку и какое
// окно оплаты показать). Решает сервер: RPC consume_api_calculation пускает при
// активном безлимите ИЛИ пока не израсходована общая первая бесплатная попытка.
// Разовые кредиты (149 ₽) API не открывают, поэтому здесь их нет вовсе.
//
//   • права ещё загружаются → "loading": обычная кнопка, без требования оплаты;
//   • активный безлимит или бесплатная попытка не израсходована → "allowed";
//   • иначе → "needs_unlimited": предлагаем только «Безлимит — 449 ₽».
// ============================================================================

export type ApiCalcAccess = "loading" | "allowed" | "needs_unlimited";

export interface ApiCalcAccessInput {
  /** Права загружены (useEntitlements().loaded). */
  loaded: boolean;
  /** Активный безлимит: plan unlimited и premium_until > now. */
  hasPremium: boolean;
  /** Израсходовано расчётов (profiles.calculations_used) — счётчик общий для всех способов. */
  calcCount: number;
  /** Бесплатных попыток (FREE_CALCULATIONS_LIMIT). */
  freeLimit: number;
}

export function apiCalcAccess(i: ApiCalcAccessInput): ApiCalcAccess {
  if (!i.loaded) return "loading";
  if (i.hasPremium) return "allowed";
  return Math.max(0, i.calcCount) < i.freeLimit ? "allowed" : "needs_unlimited";
}
