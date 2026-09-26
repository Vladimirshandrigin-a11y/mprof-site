// ============================================================================
// Чистая товарная аналитика по «Отчёту по начислениям» (PR-1).
//
// Два этапа (оба чистые, без Supabase/сети/consume):
//   1) aggregateAccrualProducts — по артикулам: прямые суммы, выручка/возвраты,
//      НЕТТО-количество, себестоимость из каталога;
//   2) allocateAccrualProducts — раздача «общих» строк (без артикула), налога
//      и ручных расходов по товарам и итоговая прибыль товара.
//
// Формулы товара (копейки, целые):
//   direct_i    = Σ сумм ВСЕХ строк с этим артикулом
//   general     = Σ сумм строк БЕЗ артикула
//   w_i         = max(revenueBase_i, 0),  revenueBase_i = продажи_i + возвраты_i
//   cogs_i      = round(netQuantity_i × cost_i)         (только строки продажи/возврата)
//   profit_i    = direct_i + G_i − cogs_i − T_i − M_i
//   G/T/M       — general / налог / ручные расходы, распределённые ОДНИМИ весами w_i
//                 методом наибольших остатков (money.ts) — Σ_i G_i = general и т.д. РОВНО.
//   margin_i    = revenueBase_i > 0 ? profit_i / revenueBase_i × 100 : null
//
// Reconciliation: Σ direct_i + general = netOzonOperations (каждая строка — либо
// с артикулом, либо без); Σ cogs_i = productionCost; Σ T_i = tax; Σ M_i = manual.
// Значит при полном покрытии себестоимости Σ profit_i === netProfit до копейки —
// БЕЗ остатка/поправки/искусственной корзины (проверяется, а не подгоняется).
//
// Количество для себестоимости берётся ТОЛЬКО со строк «Выручка»/«Возврат
// выручки»: на строках комиссий/логистики/услуг «Количество» повторяется и
// умножать на него себестоимость нельзя.
// ============================================================================

import type { AccrualBucketSums, AccrualRow } from "./types";
import type { ProductSplit } from "./sales-split";
import { emptyBucketSums } from "./buckets";
import { allocateLargestRemainder, kopecksToRub, ratioPercent } from "./money";
import {
  normArticleKey,
  type CatalogEntry,
  type ProductBreakdownRow,
} from "../product-breakdown-calc";

/** Товар после этапа 1 (агрегация, себестоимость), ещё без распределения. */
export interface AccrualProductAggregate {
  key: string;
  /** Артикул как в отчёте (первый непустой, trim). */
  article: string;
  sku: string;
  name: string;
  buckets: AccrualBucketSums;
  /** Σ сумм всех строк с этим артикулом. */
  directKopecks: number;
  salesKopecks: number;
  /** Отрицательное число (или 0). */
  returnsKopecks: number;
  /** salesKopecks + returnsKopecks — «реализация после возвратов» товара. */
  revenueBaseKopecks: number;
  soldQuantity: number;
  returnedQuantity: number;
  /** soldQuantity − returnedQuantity — количество для себестоимости. */
  netQuantity: number;
  /** Нет ни одной строки «Выручка»/«Возврат выручки» — только услуги (безопасный флаг). */
  serviceOnly: boolean;
  /** Себестоимость нужна (нетто-количество ≠ 0). */
  costRequired: boolean;
  matched: boolean;
  /** Себестоимость единицы из каталога (₽) или null, если товара нет в каталоге. */
  unitCost: number | null;
  /** Себестоимость известна и > 0. */
  hasCost: boolean;
  /**
   * Себестоимость строки, копейки: 0 если не требуется; число если требуется и
   * известна; null если требуется, но в каталоге нет (НЕ подставляем 0).
   */
  cogsKopecks: number | null;
}

export interface AccrualCostCoverage {
  /** Все нужные себестоимости известны и все строки продажи/возврата привязаны к артикулу. */
  complete: boolean;
  /** Товаров, где себестоимость нужна (нетто-количество ≠ 0). */
  requiredProducts: number;
  withCost: number;
  missingCost: number;
  /** Нетто-штуки строк продажи/возврата БЕЗ артикула (себестоимость не посчитать). */
  unattributedNetQuantity: number;
}

export interface AccrualProductAggregation {
  products: AccrualProductAggregate[];
  /** Σ строк без артикула, копейки (со знаком). */
  generalKopecks: number;
  generalRows: number;
  /** Σ известных cogs (товары без известной себестоимости вносят 0 → итог предварительный). */
  productionCostKopecks: number;
  coverage: AccrualCostCoverage;
}

function catalogIndex(catalog: readonly CatalogEntry[]): Map<string, CatalogEntry> {
  const idx = new Map<string, CatalogEntry>();
  for (const c of catalog) {
    const key = normArticleKey(c.sku);
    if (key && !idx.has(key)) idx.set(key, c); // первый побеждает — как в product-breakdown-calc
  }
  return idx;
}

/** Этап 1: агрегация по артикулам и себестоимость. Каталог не изменяется. */
export function aggregateAccrualProducts(
  rows: readonly AccrualRow[],
  catalog: readonly CatalogEntry[]
): AccrualProductAggregation {
  interface Acc {
    key: string;
    article: string;
    sku: string;
    name: string;
    buckets: AccrualBucketSums;
    direct: number;
    sold: number;
    returned: number;
    hasSaleReturn: boolean;
  }
  const map = new Map<string, Acc>();
  let general = 0;
  let generalRows = 0;
  let unattributedSold = 0;
  let unattributedReturned = 0;

  for (const r of rows) {
    const key = normArticleKey(r.article);
    if (!key) {
      general += r.amountKopecks;
      generalRows++;
      if (r.bucket === "salesRevenue") unattributedSold += r.quantity ?? 0;
      else if (r.bucket === "returnsRevenue") unattributedReturned += Math.abs(r.quantity ?? 0);
      continue;
    }
    let a = map.get(key);
    if (!a) {
      a = {
        key,
        article: r.article.trim(),
        sku: "",
        name: "",
        buckets: emptyBucketSums(),
        direct: 0,
        sold: 0,
        returned: 0,
        hasSaleReturn: false,
      };
      map.set(key, a);
    }
    if (!a.sku && r.sku) a.sku = r.sku;
    if (!a.name && r.name) a.name = r.name;
    a.direct += r.amountKopecks;
    a.buckets[r.bucket] += r.amountKopecks;
    // Количество — ТОЛЬКО со строк продажи/возврата (на строках услуг оно повторяется).
    if (r.bucket === "salesRevenue") {
      a.sold += r.quantity ?? 0;
      a.hasSaleReturn = true;
    } else if (r.bucket === "returnsRevenue") {
      a.returned += Math.abs(r.quantity ?? 0);
      a.hasSaleReturn = true;
    }
  }

  const idx = catalogIndex(catalog);
  const products: AccrualProductAggregate[] = [];
  let productionCost = 0;
  let required = 0;
  let withCost = 0;

  for (const a of map.values()) {
    const netQuantity = a.sold - a.returned;
    const costRequired = netQuantity !== 0;
    const match = idx.get(a.key);
    const unitCost = match ? match.cost_price : null;
    const hasCost =
      match !== undefined && Number.isFinite(match.cost_price) && match.cost_price > 0;

    let cogs: number | null;
    if (!costRequired) cogs = 0;
    else if (hasCost) cogs = Math.round(netQuantity * (unitCost as number) * 100) + 0;
    else cogs = null;

    if (costRequired) {
      required++;
      if (hasCost) withCost++;
    }
    if (cogs !== null) productionCost += cogs;

    products.push({
      key: a.key,
      article: a.article,
      sku: a.sku,
      name: a.name || (match?.name ?? "") || a.article,
      buckets: a.buckets,
      directKopecks: a.direct,
      salesKopecks: a.buckets.salesRevenue,
      returnsKopecks: a.buckets.returnsRevenue,
      revenueBaseKopecks: a.buckets.salesRevenue + a.buckets.returnsRevenue,
      soldQuantity: a.sold,
      returnedQuantity: a.returned,
      netQuantity,
      serviceOnly: !a.hasSaleReturn,
      costRequired,
      matched: match !== undefined,
      unitCost: match ? (Number.isFinite(match.cost_price) ? match.cost_price : null) : null,
      hasCost,
      cogsKopecks: cogs,
    });
  }

  // Детерминированный порядок: по реализации ↓, затем по ключу артикула ↑.
  products.sort((x, y) =>
    y.revenueBaseKopecks !== x.revenueBaseKopecks
      ? y.revenueBaseKopecks - x.revenueBaseKopecks
      : x.key < y.key
        ? -1
        : x.key > y.key
          ? 1
          : 0
  );

  const unattributedNet = unattributedSold - unattributedReturned;
  return {
    products,
    generalKopecks: general,
    generalRows,
    productionCostKopecks: productionCost,
    coverage: {
      complete: required - withCost === 0 && unattributedNet === 0,
      requiredProducts: required,
      withCost,
      missingCost: required - withCost,
      unattributedNetQuantity: unattributedNet,
    },
  };
}

/** Товар после распределения: итоговая прибыль/маржа. */
export interface AccrualProductRow extends AccrualProductAggregate {
  /**
   * Разделение результата товара (sales-split.ts): продажи, возвраты, расходы без
   * продаж, неразделённые операции. undefined — разделение недоступно (нет колонки
   * «ID начисления»). Прибыль/маржа товара ниже от него НЕ зависят.
   */
  split?: ProductSplit;
  /** Доля «общих» строк (без артикула), копейки со знаком. */
  allocatedGeneralKopecks: number;
  allocatedTaxKopecks: number;
  allocatedManualKopecks: number;
  /** null — себестоимость нужна, но неизвестна (прибыль не считается, НЕ ноль). */
  profitKopecks: number | null;
  /** null — прибыль неизвестна или реализация товара ≤ 0. */
  marginPercent: number | null;
}

export interface AccrualProductTotals {
  productCount: number;
  serviceOnlyCount: number;
  revenueBaseKopecks: number;
  cogsKopecks: number;
  /** Σ известных profitKopecks. */
  profitKopecks: number;
  /** У всех товаров прибыль известна (иначе profitKopecks — лишь часть). */
  profitComplete: boolean;
  allocatedGeneralKopecks: number;
  allocatedTaxKopecks: number;
  allocatedManualKopecks: number;
}

export type AllocateProductsResult =
  | { ok: true; rows: AccrualProductRow[]; totals: AccrualProductTotals }
  | { ok: false; code: "no_allocation_base" };

/**
 * Этап 2: распределить «общие» строки, налог и ручные расходы по товарам с
 * положительной реализацией (одни и те же веса, метод наибольших остатков) и
 * посчитать прибыль/маржу товара. no_allocation_base — ни у одного товара нет
 * положительной базы (распределять нечего).
 */
export function allocateAccrualProducts(
  agg: AccrualProductAggregation,
  totals: { taxKopecks: number; manualExpensesKopecks: number }
): AllocateProductsResult {
  const products = agg.products;
  const weights = products.map((p) => Math.max(p.revenueBaseKopecks, 0));
  const tie = products.map((p) => p.key);

  const general = allocateLargestRemainder(agg.generalKopecks, weights, tie);
  const tax = allocateLargestRemainder(totals.taxKopecks, weights, tie);
  const manual = allocateLargestRemainder(totals.manualExpensesKopecks, weights, tie);
  if (!general || !tax || !manual) return { ok: false, code: "no_allocation_base" };

  const rows: AccrualProductRow[] = [];
  const t: AccrualProductTotals = {
    productCount: products.length,
    serviceOnlyCount: 0,
    revenueBaseKopecks: 0,
    cogsKopecks: 0,
    profitKopecks: 0,
    profitComplete: true,
    allocatedGeneralKopecks: 0,
    allocatedTaxKopecks: 0,
    allocatedManualKopecks: 0,
  };

  products.forEach((p, i) => {
    const profit =
      p.cogsKopecks === null
        ? null
        : p.directKopecks + general[i] - p.cogsKopecks - tax[i] - manual[i];
    rows.push({
      ...p,
      allocatedGeneralKopecks: general[i],
      allocatedTaxKopecks: tax[i],
      allocatedManualKopecks: manual[i],
      profitKopecks: profit,
      marginPercent: profit === null ? null : ratioPercent(profit, p.revenueBaseKopecks),
    });
    if (p.serviceOnly) t.serviceOnlyCount++;
    t.revenueBaseKopecks += p.revenueBaseKopecks;
    t.cogsKopecks += p.cogsKopecks ?? 0;
    if (profit === null) t.profitComplete = false;
    else t.profitKopecks += profit;
    t.allocatedGeneralKopecks += general[i];
    t.allocatedTaxKopecks += tax[i];
    t.allocatedManualKopecks += manual[i];
  });

  return { ok: true, rows, totals: t };
}

/** Строка, совместимая с ProductBreakdownRow (+ безопасные флаги для нового UI). */
export interface AccrualBreakdownRow extends ProductBreakdownRow {
  /** Только услуги в периоде (нет продажи/возврата) — товар не теряется, но помечен. */
  serviceOnly: boolean;
  /** Себестоимость для этого товара вообще нужна (нетто-количество ≠ 0). */
  costRequired: boolean;
}

/**
 * Плоский источник для одной строки ProductBreakdownRow. Его умеют выдавать и
 * рассчитанный товар (AccrualProductRow), и товар из сохранённого снимка
 * истории (snapshot.ts) — mapping полей в ОДНОМ месте (toBreakdownRow).
 */
export interface AccrualBreakdownSource {
  article: string;
  name: string;
  revenueBaseKopecks: number;
  /** Отрицательное число (или 0). */
  returnsKopecks: number;
  partnerProgramsKopecks: number;
  netQuantity: number;
  matched: boolean;
  unitCost: number | null;
  hasCost: boolean;
  costRequired: boolean;
  serviceOnly: boolean;
  cogsKopecks: number | null;
  profitKopecks: number | null;
  marginPercent: number | null;
}

/**
 * Адаптер к существующему ProductBreakdownRow (рубли). Соответствие полей:
 *   revenue = реализация после возвратов; returnsAmount = |возвраты|;
 *   loyaltyPayout = выплаты «Программы партнёров» по товару;
 *   quantity = НЕТТО-количество; cogs/profit/margin — как в источнике.
 * hasCost = «себестоимость известна ИЛИ не требуется» (товар только с услугами
 * с нулевым нетто-количеством не считается «без себестоимости»).
 * ВНИМАНИЕ: существующий computeProductBreakdownTotals суммирует прибыль лишь по
 * hasCost-строкам; точная сверка — AccrualProductTotals/ reconciliation в calc.
 */
export function toBreakdownRow(r: AccrualBreakdownSource): AccrualBreakdownRow {
  return {
    article: r.article,
    name: r.name,
    revenue: kopecksToRub(r.revenueBaseKopecks),
    returnsAmount: kopecksToRub(Math.abs(r.returnsKopecks)),
    loyaltyPayout: kopecksToRub(r.partnerProgramsKopecks),
    quantity: r.netQuantity,
    matched: r.matched,
    unitCost: r.unitCost,
    cogs: r.cogsKopecks === null ? null : kopecksToRub(r.cogsKopecks),
    profit: r.profitKopecks === null ? null : kopecksToRub(r.profitKopecks),
    margin: r.marginPercent,
    hasCost: r.costRequired ? r.hasCost : true,
    serviceOnly: r.serviceOnly,
    costRequired: r.costRequired,
  };
}

export function toProductBreakdownRows(rows: readonly AccrualProductRow[]): AccrualBreakdownRow[] {
  return rows.map((r) =>
    toBreakdownRow({
      article: r.article,
      name: r.name,
      revenueBaseKopecks: r.revenueBaseKopecks,
      returnsKopecks: r.returnsKopecks,
      partnerProgramsKopecks: r.buckets.partnerPrograms,
      netQuantity: r.netQuantity,
      matched: r.matched,
      unitCost: r.unitCost,
      hasCost: r.hasCost,
      costRequired: r.costRequired,
      serviceOnly: r.serviceOnly,
      cogsKopecks: r.cogsKopecks,
      profitKopecks: r.profitKopecks,
      marginPercent: r.marginPercent,
    })
  );
}
