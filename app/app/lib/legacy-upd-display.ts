// ============================================================================
// Старые расчёты по документам (отчёт о реализации + УПД) — только отображение.
//
// Такие записи сохранялись (app/app/page.tsx, saveProfitResult) с колонками:
//   commission = updServicesTotal  — расходы Ozon по УПД (услуги, в т.ч. логистика);
//   logistics  = updCommissionTotal — агентское вознаграждение Ozon.
// То есть в колонке logistics лежит НЕ логистика. Узнаём их надёжно: каждая такая
// запись сохранялась вместе со снимком ai_insights.kind === "net-profit-3file".
// У ручного расчёта, XLSX «Отчёта по начислениям», Ozon API и прежней загрузки
// одного отчёта колонки commission / logistics — настоящие комиссия и логистика.
//
// Для аналитики «Отчётов» суммы старой записи переносятся в свои категории:
// числа не меняются и не пересчитываются, сумма всех категорий записи — прежняя.
// ============================================================================

export const UPD_SERVICES_LABEL = "Расходы Ozon по УПД";
export const UPD_AGENT_FEE_LABEL = "Агентское вознаграждение (УПД)";

/** Запись сохранена прежним расчётом по документам (реализация + УПД). */
export function isLegacyUpdRecord(aiInsights: unknown): boolean {
  return (
    !!aiInsights &&
    typeof aiInsights === "object" &&
    (aiInsights as Record<string, unknown>).kind === "net-profit-3file"
  );
}

export interface ExpenseColumnsLike {
  commission: number;
  logistics: number;
  aiInsights?: unknown;
}

export type WithUpdCategories<T> = T & {
  /** Расходы Ozon по УПД старой записи (колонка commission); иначе 0. */
  updServices: number;
  /** Агентское вознаграждение по УПД старой записи (колонка logistics); иначе 0. */
  updAgentFee: number;
};

/**
 * Копия записи для аналитики: у старой УПД-записи суммы колонок commission и
 * logistics показываются как «Расходы Ozon по УПД» и «Агентское вознаграждение»,
 * а комиссия и логистика этой записи — 0 (их в ней нет). Остальные записи — без
 * изменений. Исходная запись не меняется.
 */
export function withUpdCategories<T extends ExpenseColumnsLike>(h: T): WithUpdCategories<T> {
  if (!isLegacyUpdRecord(h.aiInsights)) return { ...h, updServices: 0, updAgentFee: 0 };
  return { ...h, commission: 0, logistics: 0, updServices: h.commission, updAgentFee: h.logistics };
}
