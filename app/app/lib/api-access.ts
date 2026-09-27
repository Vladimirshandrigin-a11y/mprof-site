// ============================================================================
// Доступ к расчёту через Ozon API — ТОЛЬКО для отображения (какую кнопку и какое
// окно оплаты показать). Решает сервер: RPC consume_api_calculation пускает при
// активном безлимите ИЛИ пока не израсходована общая первая бесплатная попытка.
// Разовые кредиты (149 ₽) API не открывают, поэтому здесь их нет вовсе.
//
//   • права ещё загружаются → "loading": обычная кнопка, без требования оплаты;
//   • активный безлимит или бесплатная попытка не израсходована → "allowed";
//   • иначе, пока идёт повторная проверка прав → "checking" (без предложения
//     покупки: права могли устареть, например после оплаты в другой вкладке);
//   • иначе, если последняя проверка не удалась → "check_failed" (не «доступа
//     нет», а «не удалось проверить» с возможностью повторить);
//   • иначе → "needs_unlimited": предлагаем только «Безлимит — 449 ₽».
// ============================================================================

export type ApiCalcAccess =
  | "loading"
  | "allowed"
  | "checking"
  | "check_failed"
  | "needs_unlimited";

export interface ApiCalcAccessInput {
  /** Права загружены (useEntitlements().loaded). */
  loaded: boolean;
  /** Активный безлимит: plan unlimited и premium_until > now. */
  hasPremium: boolean;
  /** Израсходовано расчётов (profiles.calculations_used) — счётчик общий для всех способов. */
  calcCount: number;
  /** Бесплатных попыток (FREE_CALCULATIONS_LIMIT). */
  freeLimit: number;
  /** Идёт повторная проверка прав (useEntitlements().checking). */
  checking?: boolean;
  /** Последняя проверка прав не удалась (useEntitlements().checkFailed). */
  checkFailed?: boolean;
}

export function apiCalcAccess(i: ApiCalcAccessInput): ApiCalcAccess {
  if (!i.loaded) return "loading";
  if (i.hasPremium) return "allowed";
  if (Math.max(0, i.calcCount) < i.freeLimit) return "allowed";
  if (i.checking) return "checking";
  if (i.checkFailed) return "check_failed";
  return "needs_unlimited";
}
