// ============================================================================
// Расчётное ядро «Отчёта по начислениям» (PR-1). ЧИСТАЯ функция: без Supabase,
// consume, сети, UI. Вход — результат парсера, каталог себестоимости, ставка
// налога, ручные расходы.
//
// Формулы (копейки, целые):
//   netOzonOperations = Σ signed «Сумма итого, руб.» по ВСЕМ строкам — ровно один раз
//   salesRevenue      = Σ строк «Выручка»           returnsRevenue = Σ строк «Возврат выручки» (≤ 0)
//   taxRevenueBase    = salesRevenue + returnsRevenue
//   productionCost    = Σ_товаров round(netQuantity × cost),  netQuantity = продано − возвращено
//   tax               = round-half-up(taxRevenueBase × ставка / 100)
//   manualExpenses    = упаковка + доставка до склада + зарплата + прочие + реклама вне Ozon
//   netProfit         = netOzonOperations − productionCost − tax − manualExpenses
//   margin            = netProfit / taxRevenueBase × 100  (null, если не вычислить)
//   taxRevenueBase ≤ 0 → ошибка no_tax_revenue (НЕ прибыль с нулевым налогом)
//
// Корзины (комиссия, логистика, реклама, компенсации, …) — только разбивка:
// они уже внутри netOzonOperations и второй раз в формулу НЕ входят; график
// выплат и ручная «реклама вне Ozon» в этом модуле не участвуют.
// ============================================================================

import type { AccrualBucketSums, AccrualRow, UnknownTaxonomyEntry } from "./types";
import { summarizeAccrualRows } from "./buckets";
import {
  percentOfKopecks,
  percentToBasisPoints,
  ratioPercent,
  rublesToKopecks,
} from "./money";
import {
  aggregateAccrualProducts,
  allocateAccrualProducts,
  type AccrualCostCoverage,
  type AccrualProductRow,
  type AccrualProductTotals,
} from "./product-analytics";
import type { CatalogEntry } from "../product-breakdown-calc";
import { splitAccrualProducts, splitMatchesProduct } from "./sales-split";

/**
 * Ручные расходы, ₽ (те же ключи, что в ProfitInputs старого режима).
 * adsOutsideOzon — «Реклама вне Ozon»: ТОЛЬКО расходы, не попавшие в загруженный
 * отчёт (реклама Ozon уже внутри «Итога начислений»). Входит в ручные расходы
 * РОВНО ОДИН РАЗ.
 */
export interface AccrualManualExpenses {
  packaging?: number;
  deliveryToWarehouse?: number;
  salary?: number;
  other?: number;
  adsOutsideOzon?: number;
}

/** Минимум, который нужен ядру от результата парсера (rows + period). */
export interface AccrualCalcReportInput {
  rows: readonly AccrualRow[];
  period: { month: string; periodComplete: boolean };
}

export interface AccrualCalcInput {
  report: AccrualCalcReportInput;
  catalog: readonly CatalogEntry[];
  /** Ставка налога, % (0…100, не более 2 знаков после запятой). */
  taxRatePercent: number;
  manualExpenses?: AccrualManualExpenses;
}

export type AccrualCalcErrorCode =
  | "empty_report"
  | "invalid_tax_rate"
  | "invalid_manual_expenses"
  | "no_tax_revenue"
  | "no_allocation_base"
  | "internal_invariant";

export interface AccrualCalcError {
  code: AccrualCalcErrorCode;
  message: string;
  /** Для no_tax_revenue: что получилось (копейки) — без товарных данных. */
  netOzonOperationsKopecks?: number;
  taxRevenueBaseKopecks?: number;
}

export interface AccrualProfitCalc {
  period: { month: string; periodComplete: boolean };

  netOzonOperationsKopecks: number;
  /** = netOzonOperations (алиас для UI «прибыль до себестоимости»). */
  profitBeforeCostKopecks: number;
  salesRevenueKopecks: number;
  returnsRevenueKopecks: number;
  taxRevenueBaseKopecks: number;
  /** Разбивка для отображения; Σ === netOzonOperationsKopecks. */
  buckets: AccrualBucketSums;
  quantities: { sold: number; returned: number; net: number };

  productionCostKopecks: number;
  costCoverage: AccrualCostCoverage;

  taxRatePercent: number;
  taxKopecks: number;
  manualExpenses: {
    packagingKopecks: number;
    deliveryToWarehouseKopecks: number;
    salaryKopecks: number;
    otherKopecks: number;
    /** «Реклама вне Ozon» (расходы, не включённые в отчёт). */
    adsOutsideOzonKopecks: number;
    /** Σ всех пяти статей ровно один раз. */
    totalKopecks: number;
  };

  netProfitKopecks: number;
  /** netProfit / taxRevenueBase × 100 (2 знака); null — вычислить нельзя. */
  marginPercent: number | null;

  /** true — себестоимость неполная: итог предварительный. */
  preliminary: boolean;
  /** Итог можно предлагать к сохранению: себестоимость полная. */
  readyToSave: boolean;

  products: AccrualProductRow[];
  /**
   * Разделение результата товаров доступно (в отчёте есть «ID начисления» и все
   * инварианты разделения сошлись). false — у товаров нет split.
   */
  salesSplitAvailable: boolean;
  /** Почему недоступно: нет колонки «ID начисления» / не сошёлся инвариант; null — доступно. */
  salesSplitReason: "no_ref_column" | "invariant" | null;
  productTotals: AccrualProductTotals;
  /**
   * Сверка «Σ прибыль товаров = чистая прибыль». reconciles = null, пока
   * себестоимость неполная (тогда у части товаров прибыль неизвестна).
   */
  reconciliation: {
    productProfitSumKopecks: number;
    netProfitKopecks: number;
    reconciles: boolean | null;
  };

  unknownTaxonomy: UnknownTaxonomyEntry[];
}

export type AccrualCalcResult =
  | { ok: true; calc: AccrualProfitCalc }
  | { ok: false; error: AccrualCalcError };

function manualToKopecks(v: number | undefined): number | null {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const k = rublesToKopecks(v);
  return k ? k.kopecks : null;
}

export function computeAccrualProfit(input: AccrualCalcInput): AccrualCalcResult {
  const err = (code: AccrualCalcErrorCode, message: string, extra?: Partial<AccrualCalcError>): AccrualCalcResult => ({
    ok: false,
    error: { code, message, ...extra },
  });

  const rows = input.report.rows;
  if (rows.length === 0) return err("empty_report", "В отчёте нет строк для расчёта.");

  // --- входные параметры ---
  const rate = input.taxRatePercent;
  const rateBp = percentToBasisPoints(rate);
  if (rateBp === null || rate < 0 || rate > 100) {
    return err("invalid_tax_rate", "Ставка налога должна быть числом от 0 до 100 (не более двух знаков после запятой).");
  }
  const me = input.manualExpenses ?? {};
  const packaging = manualToKopecks(me.packaging);
  const delivery = manualToKopecks(me.deliveryToWarehouse);
  const salary = manualToKopecks(me.salary);
  const other = manualToKopecks(me.other);
  const adsOutside = manualToKopecks(me.adsOutsideOzon);
  if (
    packaging === null ||
    delivery === null ||
    salary === null ||
    other === null ||
    adsOutside === null
  ) {
    return err("invalid_manual_expenses", "Ручные расходы должны быть неотрицательными числами.");
  }
  const manualTotal = packaging + delivery + salary + other + adsOutside;

  // --- итоги из строк (ядро не доверяет чужим агрегатам) ---
  const summary = summarizeAccrualRows(rows);
  const net = summary.netOzonOperationsKopecks;
  if (summary.bucketsSumKopecks !== net) {
    return err("internal_invariant", "Сумма корзин не равна итогу начислений.");
  }
  const sales = summary.buckets.salesRevenue;
  const returns = summary.buckets.returnsRevenue;
  const base = sales + returns;
  if (base <= 0) {
    return err(
      "no_tax_revenue",
      "Нет выручки для базы налога: продажи за вычетом возвратов ≤ 0. Расчёт прибыли невозможен.",
      { netOzonOperationsKopecks: net, taxRevenueBaseKopecks: base }
    );
  }

  // --- себестоимость (только строки продажи/возврата, нетто-количество) ---
  const agg = aggregateAccrualProducts(rows, input.catalog);
  const productionCost = agg.productionCostKopecks;

  // --- налог, чистая прибыль, маржа ---
  const tax = percentOfKopecks(base, rateBp);
  const netProfit = net - productionCost - tax - manualTotal;
  const margin = ratioPercent(netProfit, base);

  // --- товарная аналитика ---
  const alloc = allocateAccrualProducts(agg, { taxKopecks: tax, manualExpensesKopecks: manualTotal });
  if (!alloc.ok) {
    return err("no_allocation_base", "Ни у одного товара нет положительной реализации — распределить общие суммы по товарам нельзя.");
  }

  const complete = agg.coverage.complete;
  const productProfitSum = alloc.totals.profitKopecks;

  // --- разделение результата товаров (только отображение; прибыль не меняет) ---
  // Если какой-то инвариант не сошёлся (Σ частей ≠ товару), разделение целиком
  // считается недоступным — основной расчёт при этом не блокируется.
  const splits = splitAccrualProducts(rows, alloc.rows);
  const splitOk = splits !== null && splits.every((sp, i) => splitMatchesProduct(sp, alloc.rows[i]));
  const products = splitOk ? alloc.rows.map((r, i) => ({ ...r, split: splits[i] })) : alloc.rows;

  return {
    ok: true,
    calc: {
      period: { month: input.report.period.month, periodComplete: input.report.period.periodComplete },
      netOzonOperationsKopecks: net,
      profitBeforeCostKopecks: net,
      salesRevenueKopecks: sales,
      returnsRevenueKopecks: returns,
      taxRevenueBaseKopecks: base,
      buckets: summary.buckets,
      quantities: summary.quantities,
      productionCostKopecks: productionCost,
      costCoverage: agg.coverage,
      taxRatePercent: rate,
      taxKopecks: tax,
      manualExpenses: {
        packagingKopecks: packaging,
        deliveryToWarehouseKopecks: delivery,
        salaryKopecks: salary,
        otherKopecks: other,
        adsOutsideOzonKopecks: adsOutside,
        totalKopecks: manualTotal,
      },
      netProfitKopecks: netProfit,
      marginPercent: margin,
      preliminary: !complete,
      readyToSave: complete,
      products,
      salesSplitAvailable: splitOk,
      salesSplitReason: splitOk ? null : splits === null ? "no_ref_column" : "invariant",
      productTotals: alloc.totals,
      reconciliation: {
        productProfitSumKopecks: productProfitSum,
        netProfitKopecks: netProfit,
        reconciles: complete ? productProfitSum === netProfit : null,
      },
      unknownTaxonomy: summary.unknownTaxonomy,
    },
  };
}
