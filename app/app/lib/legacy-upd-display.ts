import type { ProductBreakdownRow } from "./product-breakdown-calc";

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

export const LEGACY_DETAIL_UNAVAILABLE = "Историческая детализация по товарам недоступна: себестоимость товаров не была сохранена. Общий финансовый итог сохранён.";

/** Read persisted financial rows only. Raw Ozon rows are not historical costs. */
export function readLegacyUpdProductDetail(
  snapshot: unknown, totals: { cost: number; profit: number; revenue: number }
): ProductBreakdownRow[] | null {
  if (!isLegacyUpdRecord(snapshot)) return null;
  const s = snapshot as Record<string, unknown>;
  const rows = s.productBreakdownRows ?? s.products;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out: ProductBreakdownRow[] = [];
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    if (typeof r.article !== "string" || typeof r.name !== "string" ||
        typeof r.matched !== "boolean" || r.hasCost !== true) return null;
    for (const key of ["revenue", "returnsAmount", "loyaltyPayout", "quantity", "unitCost", "cogs", "profit", "margin"]) {
      if (typeof r[key] !== "number" || !Number.isFinite(r[key])) return null;
    }
    out.push({ ...r } as unknown as ProductBreakdownRow);
  }
  // Do not mix saved rows from a different revision with this financial result.
  const cents = (n: number) => Math.round(n * 100);
  for (const [key, total] of [["cogs", totals.cost], ["profit", totals.profit], ["revenue", totals.revenue]] as const) {
    if (!Number.isFinite(total) || Math.abs(cents(out.reduce((sum, r) => sum + (r[key] ?? 0), 0)) - cents(total)) > 1) return null;
  }
  return out;
}
