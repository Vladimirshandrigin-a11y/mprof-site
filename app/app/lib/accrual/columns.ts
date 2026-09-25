// ============================================================================
// Сопоставление снимка расчёта по «Отчёту по начислениям» с числовыми колонками
// calculations / report_history (PR-3). Чистые функции, без Supabase.
//
// Источник правды — снимок в ai_insights (ozon-accrual-xlsx-v1); колонки нужны
// спискам, графикам и агрегатам «Отчётов». Смысл колонок (рубли):
//
//   revenue         = реализация ПОСЛЕ ВОЗВРАТОВ (taxRevenueBase = продажи + возвраты).
//                     НЕ «итог начислений»: net начислений (376 741,67 в июне) —
//                     это результат ВСЕХ операций Ozon, а не выручка.
//   commission      = списание по корзине «Комиссия Ozon» (модуль отрицательной суммы)
//   logistics       = списание по корзине «Доставка и связанные услуги»
//   ads             = списание по «Продвижение и реклама» + «Реклама вне Ozon»
//   storage         = 0 (отдельной корзины хранения в отчёте нет — сборы в other)
//   tax             = налог
//   cost            = себестоимость (нетто-количество × каталог на момент расчёта)
//   other_expenses  = списание по «Прочие начисления и сборы» + упаковка + доставка до
//                     склада + зарплата + прочие ручные расходы
//   total_expenses  = revenue − profit — расходы НЕТТО: все категории учтены ровно
//                     ОДИН раз; доходные категории (программы партнёров, баллы за
//                     скидки, компенсации, положительные части категорий) уменьшают
//                     расходы. Поэтому Σ колонок расходов может ОТЛИЧАТЬСЯ от
//                     total_expenses на эти доходные статьи — это не двойной счёт, а
//                     разница «списания gross» и «расходы нетто». Тождество
//                     revenue − total_expenses = profit выполняется до копейки.
//   profit          = чистая прибыль (netProfit)
//   margin          = маржа; NOT NULL DEFAULT 0 → null-маржа пишется как 0 (тех.
//                     замена), а показывается «—» из снимка (приоритет снимка, PR #96)
//
// report_history: report_month = первое число месяца отчёта; revenue/expenses/
// profit/margin — те же значения, что в calculations.
// ============================================================================

import { kopecksToRub } from "./money";
import { serializeAccrualSnapshot, type AccrualSnapshotV1 } from "./snapshot";

/** Поля новой строки calculations (структурно совместимы с CalculationInsertInput). */
export interface AccrualCalculationColumns {
  marketplace: "ozon";
  mode: "upload";
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
  ai_insights: Record<string, unknown>;
}

/** Поля новой строки report_history (структурно совместимы с ReportHistoryInsertInput). */
export interface AccrualReportHistoryColumns {
  /** Первое число месяца отчёта, YYYY-MM-01. */
  report_month: string;
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
}

/** Списание: модуль отрицательной суммы корзины; положительная (доходная) сумма — не расход. */
const charge = (kopecks: number): number => (kopecks < 0 ? -kopecks : 0);

/** Колонки строки calculations из снимка. */
export function accrualSnapshotToCalculationColumns(s: AccrualSnapshotV1): AccrualCalculationColumns {
  const m = s.manualExpenses;
  const revenueKop = s.taxRevenueBaseKopecks;
  const totalExpensesKop = revenueKop - s.netProfitKopecks; // нетто: тождество revenue − expenses = profit
  return {
    marketplace: "ozon",
    mode: "upload",
    revenue: kopecksToRub(revenueKop),
    commission: kopecksToRub(charge(s.buckets.commission)),
    logistics: kopecksToRub(charge(s.buckets.logistics)),
    ads: kopecksToRub(charge(s.buckets.advertising) + m.adsOutsideOzonKopecks),
    storage: 0,
    tax: kopecksToRub(s.tax.kopecks),
    cost: kopecksToRub(s.productionCostKopecks),
    other_expenses: kopecksToRub(
      charge(s.buckets.other) +
        m.packagingKopecks +
        m.deliveryToWarehouseKopecks +
        m.salaryKopecks +
        m.otherKopecks
    ),
    total_expenses: kopecksToRub(totalExpensesKop),
    profit: kopecksToRub(s.netProfitKopecks),
    margin: s.marginPercent ?? 0,
    ai_insights: serializeAccrualSnapshot(s),
  };
}

/** Строка report_history из снимка. */
export function accrualSnapshotToReportHistoryColumns(s: AccrualSnapshotV1): AccrualReportHistoryColumns {
  return {
    report_month: `${s.period.month}-01`,
    revenue: kopecksToRub(s.taxRevenueBaseKopecks),
    expenses: kopecksToRub(s.taxRevenueBaseKopecks - s.netProfitKopecks),
    profit: kopecksToRub(s.netProfitKopecks),
    margin: s.marginPercent ?? 0,
  };
}
