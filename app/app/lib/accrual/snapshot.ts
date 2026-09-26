// ============================================================================
// Снимок расчёта по XLSX «Отчёт по начислениям» для истории/восстановления/PDF
// (PR-2): kind = "ozon-accrual-xlsx-v1", version = 1.
//
// Снимок — ЕДИНСТВЕННЫЙ источник для показа сохранённого результата: ничего не
// пересчитывается ни по сегодняшнему каталогу, ни по формулам ядра. Хранится
// минимум для результата, таблиц, лучших/убыточных товаров и PDF: итог
// начислений, разбивка по корзинам, реализация после возвратов, себестоимость и
// её полнота, налог, ручные расходы, прибыль/маржа, предупреждения, ГОТОВЫЕ
// товарные строки. Исходный XLSX и его операции НЕ сохраняются.
//
// Строгий читатель readAccrualSnapshot различает три состояния:
//   • absent  — это не наш снимок (старые net-profit-3file / ozon-api-v1 / ручной);
//   • invalid — наш kind, но снимок повреждён/неполон/неподдерживаемой версии:
//               потребители обязаны показать «данные недоступны», а НЕ нули;
//   • ok      — снимок прошёл проверку структуры и инвариантов.
//
// Разделение результата товаров (продажи / возвраты / расходы без продаж /
// неразделённые, sales-split.ts) — АДДИТИВНЫЕ поля v1: salesSplit на верхнем уровне
// и split у товара. Их отсутствие = «разделение недоступно» (снимок сохранён до
// появления разделения), а НЕ нулевые возвраты. Ссылки «ID начисления» в снимок
// НЕ пишутся — только суммы и счётчики.
//
// Деньги — целые копейки. Модуль чистый: без React, Supabase, сети, DOM.
// Формулы расчёта здесь НЕ реализуются (они в profit-calc.ts); здесь только
// сборка снимка из результата ядра, проверка целостности и отображение.
// ============================================================================

import {
  ACCRUAL_BUCKETS,
  type AccrualBucket,
  type AccrualBucketSums,
  type UnknownTaxonomyEntry,
} from "./types";
import type { AccrualProfitCalc } from "./profit-calc";
import type { AccrualPeriod, AccrualWarning } from "../report-parsers/accrual-xlsx-parser";
import { kopecksToRub, ratioPercent } from "./money";
import { fmtDateRange, fmtMonthLabel, fmtRub, pluralRu } from "./format";
import { toBreakdownRow, type AccrualBreakdownRow } from "./product-analytics";
import { pickProfitableRows } from "../product-breakdown-calc";
import {
  SPLIT_PARTS,
  UNSPLIT_REASONS,
  assessSalesLoss,
  splitMatchesProduct,
  splitPartResult,
  type ProductSplit,
  type SplitPart,
  type SplitPartKey,
  type UnsplitReason,
} from "./sales-split";

export const ACCRUAL_SNAPSHOT_KIND = "ozon-accrual-xlsx-v1" as const;
export const ACCRUAL_SNAPSHOT_VERSION = 1 as const;
const KIND_PREFIX = "ozon-accrual-xlsx-";

// ---------------------------------------------------------------------------
// Схема снимка
// ---------------------------------------------------------------------------

export interface AccrualSnapshotProduct {
  /** Артикул как в отчёте (до 100 символов). */
  article: string;
  /** Название товара (до 200 символов) — только для показа. */
  name: string;
  /** Ozon SKU ("" если нет). */
  sku: string;
  /** Продажи + возвраты (реализация после возвратов), копейки. */
  revenueBaseKopecks: number;
  salesKopecks: number;
  /** ≤ 0. */
  returnsKopecks: number;
  soldQuantity: number;
  returnedQuantity: number;
  /** Нетто-количество = продано − возвращено (для себестоимости). */
  netQuantity: number;
  /** «Программы партнёров» по товару, копейки. */
  partnerProgramsKopecks: number;
  /** Σ всех строк отчёта с этим артикулом. */
  directKopecks: number;
  allocatedGeneralKopecks: number;
  allocatedTaxKopecks: number;
  allocatedManualKopecks: number;
  /** Себестоимость единицы из каталога НА МОМЕНТ РАСЧЁТА (₽); null — товара нет в каталоге. */
  unitCost: number | null;
  matched: boolean;
  hasCost: boolean;
  /** Себестоимость нужна (нетто-количество ≠ 0). */
  costRequired: boolean;
  /** Нет строк продажи/возврата — только услуги. */
  serviceOnly: boolean;
  /** null — себестоимость нужна, но неизвестна. */
  cogsKopecks: number | null;
  /** null — прибыль товара не посчитана (нет себестоимости). */
  profitKopecks: number | null;
  /** null — прибыль неизвестна или реализация товара ≤ 0. */
  marginPercent: number | null;
  /** Разделение результата товара; нет поля — разделение недоступно. */
  split?: ProductSplit;
}

export interface AccrualSnapshotWarning {
  code: string;
  message: string;
  count?: number;
}

export interface AccrualSnapshotV1 {
  kind: typeof ACCRUAL_SNAPSHOT_KIND;
  version: typeof ACCRUAL_SNAPSHOT_VERSION;
  /** Источник: XLSX «Отчёт по начислениям». Сам файл и его строки не сохраняются. */
  source: { type: "ozon-accrual-report-xlsx"; sheet: string; rowCount: number };
  /** ISO-время расчёта или null. */
  generatedAt: string | null;
  period: {
    month: string;
    dateFrom: string;
    dateTo: string;
    declaredFrom: string | null;
    declaredTo: string | null;
    periodComplete: boolean;
  };
  /** Итог начислений: Σ всех строк отчёта — ровно один раз. */
  netOzonOperationsKopecks: number;
  /** Разбивка итога по корзинам (только показ). Σ === netOzonOperationsKopecks. */
  buckets: AccrualBucketSums;
  salesRevenueKopecks: number;
  returnsRevenueKopecks: number;
  /** Реализация после возвратов = база налога и маржи. */
  taxRevenueBaseKopecks: number;
  quantities: { sold: number; returned: number; net: number };
  productionCostKopecks: number;
  costCoverage: {
    complete: boolean;
    requiredProducts: number;
    withCost: number;
    missingCost: number;
    unattributedNetQuantity: number;
  };
  tax: { ratePercent: number; kopecks: number };
  manualExpenses: {
    packagingKopecks: number;
    deliveryToWarehouseKopecks: number;
    salaryKopecks: number;
    otherKopecks: number;
    /**
     * «Реклама вне Ozon» — только расходы, не включённые в отчёт. Аддитивное поле
     * v1 (PR-3): в снимках, сохранённых до него, отсутствует и читается как 0.
     */
    adsOutsideOzonKopecks: number;
    totalKopecks: number;
  };
  netProfitKopecks: number;
  /** null — маржа не определена (показывается «—», НЕ 0 %). */
  marginPercent: number | null;
  /** true — себестоимость неполная, результат предварительный. */
  preliminary: boolean;
  warnings: AccrualSnapshotWarning[];
  unknownTaxonomy: UnknownTaxonomyEntry[];
  products: AccrualSnapshotProduct[];
  productTotals: {
    productCount: number;
    serviceOnlyCount: number;
    profitKopecks: number;
    profitComplete: boolean;
  };
  reconciliation: { productProfitSumKopecks: number; reconciles: boolean | null };
  /**
   * Разделение результата товаров. Нет поля — снимок сохранён до разделения
   * («недоступно»). available:false — в отчёте не было «ID начисления» (или не
   * сошёлся инвариант): split у товаров нет.
   */
  salesSplit?: { version: 1; available: boolean; reason: "no_ref_column" | "invariant" | null };
}

// ---------------------------------------------------------------------------
// Сборка снимка из результата ядра
// ---------------------------------------------------------------------------

const ARTICLE_MAX = 100;
const NAME_MAX = 200;
const WARN_MAX = 50;
const MSG_MAX = 500;

export interface BuildAccrualSnapshotInput {
  /** Результат computeAccrualProfit (ok:true). */
  calc: AccrualProfitCalc;
  /** Период из парсера (report.period). */
  period: AccrualPeriod;
  /** Предупреждения парсера. */
  warnings: readonly AccrualWarning[];
  source: { sheet: string; rowCount: number };
  generatedAt?: string | null;
}

/**
 * Собрать снимок из результата ядра. Ничего не пересчитывает — только копирует
 * готовые значения (себестоимость каталога фиксируется в снимке как есть).
 * Бросает Error, если calc и period противоречат друг другу (баг вызывающего).
 */
export function buildAccrualSnapshot(input: BuildAccrualSnapshotInput): AccrualSnapshotV1 {
  const { calc, period } = input;
  if (calc.period.month !== period.month) {
    throw new Error("buildAccrualSnapshot: месяц расчёта не совпадает с периодом отчёта");
  }
  const snap: AccrualSnapshotV1 = {
    kind: ACCRUAL_SNAPSHOT_KIND,
    version: ACCRUAL_SNAPSHOT_VERSION,
    source: {
      type: "ozon-accrual-report-xlsx",
      sheet: input.source.sheet.slice(0, 60),
      rowCount: input.source.rowCount,
    },
    generatedAt: input.generatedAt ?? null,
    period: {
      month: period.month,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      declaredFrom: period.declaredFrom,
      declaredTo: period.declaredTo,
      periodComplete: period.periodComplete,
    },
    netOzonOperationsKopecks: calc.netOzonOperationsKopecks,
    buckets: { ...calc.buckets },
    salesRevenueKopecks: calc.salesRevenueKopecks,
    returnsRevenueKopecks: calc.returnsRevenueKopecks,
    taxRevenueBaseKopecks: calc.taxRevenueBaseKopecks,
    quantities: { ...calc.quantities },
    productionCostKopecks: calc.productionCostKopecks,
    costCoverage: { ...calc.costCoverage },
    tax: { ratePercent: calc.taxRatePercent, kopecks: calc.taxKopecks },
    manualExpenses: { ...calc.manualExpenses },
    netProfitKopecks: calc.netProfitKopecks,
    marginPercent: calc.marginPercent,
    preliminary: calc.preliminary,
    warnings: input.warnings.slice(0, WARN_MAX).map((w) => ({
      code: w.code,
      message: w.message.slice(0, MSG_MAX),
      ...(w.count !== undefined ? { count: w.count } : {}),
    })),
    unknownTaxonomy: calc.unknownTaxonomy.map((u) => ({ ...u })),
    products: calc.products.map((p) => ({
      article: p.article.slice(0, ARTICLE_MAX),
      name: p.name.slice(0, NAME_MAX),
      sku: p.sku.slice(0, ARTICLE_MAX),
      revenueBaseKopecks: p.revenueBaseKopecks,
      salesKopecks: p.salesKopecks,
      returnsKopecks: p.returnsKopecks,
      soldQuantity: p.soldQuantity,
      returnedQuantity: p.returnedQuantity,
      netQuantity: p.netQuantity,
      partnerProgramsKopecks: p.buckets.partnerPrograms,
      directKopecks: p.directKopecks,
      allocatedGeneralKopecks: p.allocatedGeneralKopecks,
      allocatedTaxKopecks: p.allocatedTaxKopecks,
      allocatedManualKopecks: p.allocatedManualKopecks,
      unitCost: p.unitCost,
      matched: p.matched,
      hasCost: p.hasCost,
      costRequired: p.costRequired,
      serviceOnly: p.serviceOnly,
      cogsKopecks: p.cogsKopecks,
      profitKopecks: p.profitKopecks,
      marginPercent: p.marginPercent,
      ...(calc.salesSplitAvailable && p.split ? { split: cloneSplit(p.split) } : {}),
    })),
    productTotals: {
      productCount: calc.productTotals.productCount,
      serviceOnlyCount: calc.productTotals.serviceOnlyCount,
      profitKopecks: calc.productTotals.profitKopecks,
      profitComplete: calc.productTotals.profitComplete,
    },
    reconciliation: {
      productProfitSumKopecks: calc.reconciliation.productProfitSumKopecks,
      reconciles: calc.reconciliation.reconciles,
    },
    salesSplit: {
      version: 1,
      available: calc.salesSplitAvailable,
      reason: calc.salesSplitAvailable ? null : calc.salesSplitReason ?? "no_ref_column",
    },
  };
  return snap;
}

function cloneSplit(sp: ProductSplit): ProductSplit {
  return JSON.parse(JSON.stringify(sp)) as ProductSplit;
}

/** JSON-безопасная копия для записи в jsonb (ai_insights). Через неё же проверяется round-trip. */
export function serializeAccrualSnapshot(s: AccrualSnapshotV1): Record<string, unknown> {
  return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Строгое чтение
// ---------------------------------------------------------------------------

export type AccrualSnapshotRead =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; snapshot: AccrualSnapshotV1 };

const MAX_ABS_KOPECKS = 1e13;

class Bad extends Error {}
const bad = (reason: string): never => {
  throw new Bad(reason);
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > MAX_ABS_KOPECKS) {
    return bad(`${what}: ожидалось целое число`);
  }
  return v + 0;
}
function intGE0(v: unknown, what: string): number {
  const n = int(v, what);
  if (n < 0) bad(`${what}: ожидалось число ≥ 0`);
  return n;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") bad(`${what}: ожидалось boolean`);
  return v as boolean;
}
function str(v: unknown, what: string, max: number, allowEmpty = true): string {
  if (typeof v !== "string") return bad(`${what}: ожидалась строка`);
  if (!allowEmpty && v.trim() === "") bad(`${what}: пустая строка`);
  return v.slice(0, max);
}
function nullableNum(v: unknown, what: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(`${what}: ожидалось число или null`);
  return v;
}
function isoDate(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad(`${what}: ожидалась дата YYYY-MM-DD`);
  return v;
}

function readProduct(v: unknown, i: number): AccrualSnapshotProduct {
  const w = `products[${i}]`;
  if (!isObj(v)) return bad(`${w}: ожидался объект`);
  const cogs = v.cogsKopecks === null ? null : int(v.cogsKopecks, `${w}.cogsKopecks`);
  const profit = v.profitKopecks === null ? null : int(v.profitKopecks, `${w}.profitKopecks`);
  const unitCost = nullableNum(v.unitCost, `${w}.unitCost`);
  return {
    article: str(v.article, `${w}.article`, ARTICLE_MAX, false),
    name: str(v.name, `${w}.name`, NAME_MAX),
    sku: str(v.sku, `${w}.sku`, ARTICLE_MAX),
    revenueBaseKopecks: int(v.revenueBaseKopecks, `${w}.revenueBaseKopecks`),
    salesKopecks: int(v.salesKopecks, `${w}.salesKopecks`),
    returnsKopecks: int(v.returnsKopecks, `${w}.returnsKopecks`),
    soldQuantity: int(v.soldQuantity, `${w}.soldQuantity`),
    returnedQuantity: int(v.returnedQuantity, `${w}.returnedQuantity`),
    netQuantity: int(v.netQuantity, `${w}.netQuantity`),
    partnerProgramsKopecks: int(v.partnerProgramsKopecks, `${w}.partnerProgramsKopecks`),
    directKopecks: int(v.directKopecks, `${w}.directKopecks`),
    allocatedGeneralKopecks: int(v.allocatedGeneralKopecks, `${w}.allocatedGeneralKopecks`),
    allocatedTaxKopecks: int(v.allocatedTaxKopecks, `${w}.allocatedTaxKopecks`),
    allocatedManualKopecks: int(v.allocatedManualKopecks, `${w}.allocatedManualKopecks`),
    unitCost,
    matched: bool(v.matched, `${w}.matched`),
    hasCost: bool(v.hasCost, `${w}.hasCost`),
    costRequired: bool(v.costRequired, `${w}.costRequired`),
    serviceOnly: bool(v.serviceOnly, `${w}.serviceOnly`),
    cogsKopecks: cogs,
    profitKopecks: profit,
    marginPercent: nullableNum(v.marginPercent, `${w}.marginPercent`),
    ...(v.split !== undefined ? { split: readSplitRaw(v.split, `${w}.split`) } : {}),
  };
}

function readPart(v: unknown, w: string): SplitPart {
  if (!isObj(v)) return bad(`${w}: ожидался объект`);
  return {
    directKopecks: int(v.directKopecks, `${w}.directKopecks`),
    revenueKopecks: int(v.revenueKopecks, `${w}.revenueKopecks`),
    quantity: int(v.quantity, `${w}.quantity`),
    cogsKopecks: v.cogsKopecks === null ? null : int(v.cogsKopecks, `${w}.cogsKopecks`),
    generalKopecks: int(v.generalKopecks, `${w}.generalKopecks`),
    taxKopecks: intGE0(v.taxKopecks, `${w}.taxKopecks`),
    manualKopecks: intGE0(v.manualKopecks, `${w}.manualKopecks`),
    rows: intGE0(v.rows, `${w}.rows`),
  };
}

function readSplitRaw(v: unknown, w: string): ProductSplit {
  if (!isObj(v)) return bad(`${w}: ожидался объект`);
  const rp = isObj(v.parts) ? v.parts : bad(`${w}.parts`);
  const rg = isObj(v.groups) ? v.groups : bad(`${w}.groups`);
  const rr = isObj(v.unsplitReasons) ? v.unsplitReasons : bad(`${w}.unsplitReasons`);
  const rb = isObj(v.unsplitBuckets) ? v.unsplitBuckets : bad(`${w}.unsplitBuckets`);
  const parts = {} as Record<SplitPartKey, SplitPart>;
  const groups = {} as Record<SplitPartKey, number>;
  for (const k of SPLIT_PARTS) {
    parts[k] = readPart(rp[k], `${w}.parts.${k}`);
    groups[k] = intGE0(rg[k], `${w}.groups.${k}`);
  }
  const unsplitReasons = {} as Record<UnsplitReason, number>;
  for (const k of UNSPLIT_REASONS) unsplitReasons[k] = intGE0(rr[k], `${w}.unsplitReasons.${k}`);
  const unsplitBuckets = {} as AccrualBucketSums;
  for (const k of ACCRUAL_BUCKETS) unsplitBuckets[k] = int(rb[k], `${w}.unsplitBuckets.${k}`);
  return {
    parts,
    groups,
    unsplitReasons,
    unsplitBuckets,
    unsplitUpKopecks: intGE0(v.unsplitUpKopecks, `${w}.unsplitUpKopecks`),
    unsplitDownKopecks: int(v.unsplitDownKopecks, `${w}.unsplitDownKopecks`),
  };
}

/** Инварианты разделения против товара: Σ частей = товару до копейки. */
function checkProductSplit(p: AccrualSnapshotProduct, i: number): void {
  const sp = p.split;
  if (!sp) return;
  const ok = splitMatchesProduct(sp, {
    key: "",
    directKopecks: p.directKopecks,
    revenueBaseKopecks: p.revenueBaseKopecks,
    netQuantity: p.netQuantity,
    unitCost: p.unitCost,
    hasCost: p.hasCost,
    cogsKopecks: p.cogsKopecks,
    allocatedGeneralKopecks: p.allocatedGeneralKopecks,
    allocatedTaxKopecks: p.allocatedTaxKopecks,
    allocatedManualKopecks: p.allocatedManualKopecks,
  });
  if (!ok) bad(`products[${i}].split: части не сходятся с товаром`);
  if (p.profitKopecks !== null && sp.parts.sales.cogsKopecks !== null) {
    let sum = 0;
    for (const k of SPLIT_PARTS) sum += splitPartResult(sp.parts[k]) as number;
    if (sum !== p.profitKopecks) bad(`products[${i}].split: сумма частей не равна прибыли товара`);
  }
}

function parseStrict(v: Record<string, unknown>): AccrualSnapshotV1 {
  if (v.version !== ACCRUAL_SNAPSHOT_VERSION) bad("неподдерживаемая версия снимка");

  const src = isObj(v.source) ? v.source : bad("source: ожидался объект");
  if (src.type !== "ozon-accrual-report-xlsx") bad("source.type");
  const source = {
    type: "ozon-accrual-report-xlsx" as const,
    sheet: str(src.sheet, "source.sheet", 60),
    rowCount: intGE0(src.rowCount, "source.rowCount"),
  };
  const generatedAt =
    v.generatedAt === null ? null : str(v.generatedAt, "generatedAt", 40);

  const p = isObj(v.period) ? v.period : bad("period: ожидался объект");
  if (typeof p.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) bad("period.month");
  const period = {
    month: p.month as string,
    dateFrom: isoDate(p.dateFrom, "period.dateFrom"),
    dateTo: isoDate(p.dateTo, "period.dateTo"),
    declaredFrom: p.declaredFrom === null ? null : isoDate(p.declaredFrom, "period.declaredFrom"),
    declaredTo: p.declaredTo === null ? null : isoDate(p.declaredTo, "period.declaredTo"),
    periodComplete: bool(p.periodComplete, "period.periodComplete"),
  };

  const rawBuckets = isObj(v.buckets) ? v.buckets : bad("buckets: ожидался объект");
  const buckets = {} as AccrualBucketSums;
  let bucketsSum = 0;
  for (const k of ACCRUAL_BUCKETS) {
    buckets[k] = int(rawBuckets[k], `buckets.${k}`);
    bucketsSum += buckets[k];
  }
  const net = int(v.netOzonOperationsKopecks, "netOzonOperationsKopecks");
  if (bucketsSum !== net) bad("сумма корзин не равна итогу начислений");

  const sales = int(v.salesRevenueKopecks, "salesRevenueKopecks");
  const returns = int(v.returnsRevenueKopecks, "returnsRevenueKopecks");
  const base = int(v.taxRevenueBaseKopecks, "taxRevenueBaseKopecks");
  if (sales !== buckets.salesRevenue || returns !== buckets.returnsRevenue) {
    bad("продажи/возвраты не совпадают с корзинами");
  }
  if (base !== sales + returns) bad("база налога не равна продажам с возвратами");
  if (base <= 0) bad("база налога ≤ 0 — такой расчёт не сохраняется");

  const q = isObj(v.quantities) ? v.quantities : bad("quantities: ожидался объект");
  const quantities = {
    sold: int(q.sold, "quantities.sold"),
    returned: intGE0(q.returned, "quantities.returned"),
    net: int(q.net, "quantities.net"),
  };
  if (quantities.net !== quantities.sold - quantities.returned) bad("нетто-количество не сходится");

  const cost = int(v.productionCostKopecks, "productionCostKopecks");

  const cc = isObj(v.costCoverage) ? v.costCoverage : bad("costCoverage: ожидался объект");
  const costCoverage = {
    complete: bool(cc.complete, "costCoverage.complete"),
    requiredProducts: intGE0(cc.requiredProducts, "costCoverage.requiredProducts"),
    withCost: intGE0(cc.withCost, "costCoverage.withCost"),
    missingCost: intGE0(cc.missingCost, "costCoverage.missingCost"),
    unattributedNetQuantity: int(cc.unattributedNetQuantity, "costCoverage.unattributedNetQuantity"),
  };
  if (costCoverage.withCost + costCoverage.missingCost !== costCoverage.requiredProducts) {
    bad("покрытие себестоимости не сходится");
  }
  const preliminary = bool(v.preliminary, "preliminary");
  if (preliminary === costCoverage.complete) bad("признак предварительности противоречит покрытию");
  if (costCoverage.complete && (costCoverage.missingCost !== 0 || costCoverage.unattributedNetQuantity !== 0)) {
    bad("полное покрытие противоречит недостающей себестоимости");
  }

  const t = isObj(v.tax) ? v.tax : bad("tax: ожидался объект");
  const ratePercent = t.ratePercent;
  if (typeof ratePercent !== "number" || !Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    bad("tax.ratePercent");
  }
  const tax = { ratePercent: ratePercent as number, kopecks: intGE0(t.kopecks, "tax.kopecks") };

  const me = isObj(v.manualExpenses) ? v.manualExpenses : bad("manualExpenses: ожидался объект");
  const manualExpenses = {
    packagingKopecks: intGE0(me.packagingKopecks, "manualExpenses.packagingKopecks"),
    deliveryToWarehouseKopecks: intGE0(me.deliveryToWarehouseKopecks, "manualExpenses.deliveryToWarehouseKopecks"),
    salaryKopecks: intGE0(me.salaryKopecks, "manualExpenses.salaryKopecks"),
    otherKopecks: intGE0(me.otherKopecks, "manualExpenses.otherKopecks"),
    // Аддитивное поле: у прежних v1-снимков его нет → 0 (сумма ниже всё равно сверяется).
    adsOutsideOzonKopecks:
      me.adsOutsideOzonKopecks === undefined
        ? 0
        : intGE0(me.adsOutsideOzonKopecks, "manualExpenses.adsOutsideOzonKopecks"),
    totalKopecks: intGE0(me.totalKopecks, "manualExpenses.totalKopecks"),
  };
  if (
    manualExpenses.totalKopecks !==
    manualExpenses.packagingKopecks +
      manualExpenses.deliveryToWarehouseKopecks +
      manualExpenses.salaryKopecks +
      manualExpenses.otherKopecks +
      manualExpenses.adsOutsideOzonKopecks
  ) {
    bad("ручные расходы не сходятся");
  }

  const netProfit = int(v.netProfitKopecks, "netProfitKopecks");
  if (netProfit !== net - cost - tax.kopecks - manualExpenses.totalKopecks) {
    bad("чистая прибыль не сходится с составляющими");
  }
  const margin = nullableNum(v.marginPercent, "marginPercent");
  if (margin !== null) {
    const expected = ratioPercent(netProfit, base);
    if (expected === null || Math.abs(expected - margin) > 0.005) bad("маржа не сходится с прибылью и базой");
  }

  if (!Array.isArray(v.warnings) || v.warnings.length > WARN_MAX) bad("warnings");
  const warnings: AccrualSnapshotWarning[] = (v.warnings as unknown[]).map((w, i) => {
    if (!isObj(w)) return bad(`warnings[${i}]`);
    return {
      code: str(w.code, `warnings[${i}].code`, 60, false),
      message: str(w.message, `warnings[${i}].message`, MSG_MAX),
      ...(w.count !== undefined ? { count: intGE0(w.count, `warnings[${i}].count`) } : {}),
    };
  });

  if (!Array.isArray(v.unknownTaxonomy) || v.unknownTaxonomy.length > 50) bad("unknownTaxonomy");
  const unknownTaxonomy: UnknownTaxonomyEntry[] = (v.unknownTaxonomy as unknown[]).map((u, i) => {
    if (!isObj(u)) return bad(`unknownTaxonomy[${i}]`);
    return {
      group: str(u.group, `unknownTaxonomy[${i}].group`, 100),
      type: str(u.type, `unknownTaxonomy[${i}].type`, 100),
      rows: intGE0(u.rows, `unknownTaxonomy[${i}].rows`),
      amountKopecks: int(u.amountKopecks, `unknownTaxonomy[${i}].amountKopecks`),
    };
  });

  if (!Array.isArray(v.products)) bad("products: ожидался массив");
  const products = (v.products as unknown[]).map(readProduct);
  const pt = isObj(v.productTotals) ? v.productTotals : bad("productTotals: ожидался объект");
  const productTotals = {
    productCount: intGE0(pt.productCount, "productTotals.productCount"),
    serviceOnlyCount: intGE0(pt.serviceOnlyCount, "productTotals.serviceOnlyCount"),
    profitKopecks: int(pt.profitKopecks, "productTotals.profitKopecks"),
    profitComplete: bool(pt.profitComplete, "productTotals.profitComplete"),
  };
  if (productTotals.productCount !== products.length) bad("число товаров не сходится");

  // Разделение: нет поля — снимок до разделения (у товаров split быть не должно).
  let salesSplit: AccrualSnapshotV1["salesSplit"];
  if (v.salesSplit === undefined) {
    if (products.some((p) => p.split)) bad("split у товара без salesSplit");
  } else {
    const ss = isObj(v.salesSplit) ? v.salesSplit : bad("salesSplit: ожидался объект");
    if (ss.version !== 1) bad("salesSplit.version");
    const available = bool(ss.available, "salesSplit.available");
    const reason = ss.reason;
    if (available ? reason !== null : reason !== "no_ref_column" && reason !== "invariant") bad("salesSplit.reason");
    if (available ? products.some((p) => !p.split) : products.some((p) => p.split)) {
      bad("salesSplit.available противоречит товарам");
    }
    products.forEach(checkProductSplit);
    salesSplit = { version: 1, available, reason: reason as "no_ref_column" | "invariant" | null };
  }

  const rc = isObj(v.reconciliation) ? v.reconciliation : bad("reconciliation: ожидался объект");
  if (rc.reconciles !== null && typeof rc.reconciles !== "boolean") bad("reconciliation.reconciles");
  const reconciliation = {
    productProfitSumKopecks: int(rc.productProfitSumKopecks, "reconciliation.productProfitSumKopecks"),
    reconciles: rc.reconciles as boolean | null,
  };

  return {
    kind: ACCRUAL_SNAPSHOT_KIND,
    version: ACCRUAL_SNAPSHOT_VERSION,
    source,
    generatedAt,
    period,
    netOzonOperationsKopecks: net,
    buckets,
    salesRevenueKopecks: sales,
    returnsRevenueKopecks: returns,
    taxRevenueBaseKopecks: base,
    quantities,
    productionCostKopecks: cost,
    costCoverage,
    tax,
    manualExpenses,
    netProfitKopecks: netProfit,
    marginPercent: margin,
    preliminary,
    warnings,
    unknownTaxonomy,
    products,
    productTotals,
    reconciliation,
    ...(salesSplit ? { salesSplit } : {}),
  };
}

/**
 * Прочитать ai_insights (jsonb → unknown). НИКОГДА не подставляет нули вместо
 * отсутствующих/битых полей: повреждённый снимок нашего kind → status "invalid".
 */
export function readAccrualSnapshot(v: unknown): AccrualSnapshotRead {
  if (!isObj(v)) return { status: "absent" };
  const kind = v.kind;
  if (typeof kind !== "string" || !kind.startsWith(KIND_PREFIX)) return { status: "absent" };
  if (kind !== ACCRUAL_SNAPSHOT_KIND) return { status: "invalid", reason: "неподдерживаемый вид снимка" };
  try {
    return { status: "ok", snapshot: parseStrict(v) };
  } catch (e) {
    if (e instanceof Bad) return { status: "invalid", reason: e.message };
    throw e;
  }
}

/** Удобная обёртка: снимок или null (absent и invalid). Различать состояния — readAccrualSnapshot. */
export function asAccrualSnapshot(v: unknown): AccrualSnapshotV1 | null {
  const r = readAccrualSnapshot(v);
  return r.status === "ok" ? r.snapshot : null;
}

/** Это снимок нового вида (даже повреждённый)? */
export function isAccrualSnapshotKind(v: unknown): boolean {
  return readAccrualSnapshot(v).status !== "absent";
}

/** Месяц «YYYY-MM» из валидного снимка; повреждённый/чужой → null. */
export function accrualSnapshotMonthKey(v: unknown): string | null {
  const r = readAccrualSnapshot(v);
  return r.status === "ok" ? r.snapshot.period.month : null;
}

// ---------------------------------------------------------------------------
// Показ: маржа, ROI, подписи, разбивка, предупреждения, пояснения
// ---------------------------------------------------------------------------

/** Маржа снимка (null → «—»). */
export function accrualSnapshotMargin(s: AccrualSnapshotV1): number | null {
  return s.marginPercent;
}

/**
 * Маржа записи истории с ПРИОРИТЕТОМ снимка нового вида. dbMargin — техническая
 * числовая колонка БД (там 0 может быть заменой null). Для чужого снимка —
 * колонка как есть; для повреждённого нашего — null (колонке доверять нельзя).
 * Не использует `||`: настоящий 0 % допустим и остаётся 0.
 */
export function effectiveHistoryMargin(aiInsights: unknown, dbMargin: number): number | null {
  const r = readAccrualSnapshot(aiInsights);
  if (r.status === "ok") return r.snapshot.marginPercent;
  if (r.status === "invalid") return null;
  return Number.isFinite(dbMargin) ? dbMargin : null;
}

/** ROI = чистая прибыль / себестоимость × 100; null при нулевой себестоимости. */
export function accrualSnapshotRoi(s: AccrualSnapshotV1): number | null {
  return ratioPercent(s.netProfitKopecks, s.productionCostKopecks);
}

/** Подпись итога: предварительный результат не называется «чистой прибылью». */
export function accrualProfitLabel(s: AccrualSnapshotV1): string {
  return s.preliminary ? "Предварительная прибыль" : "Чистая прибыль";
}

/**
 * Однозначные названия выручки в расчёте по начислениям (экран, история, PDF):
 * продажи до возвратов, возвраты со своим знаком и их сумма — выручка после
 * возвратов, от которой считаются налог и маржа расчёта.
 */
export const ACCRUAL_REVENUE_LABELS = {
  sales: "Продажи до возвратов",
  returns: "Возвраты выручки",
  afterReturns: "Выручка после возвратов",
} as const;

/** Короткая подпись базы маржи расчёта (экран, история). */
export const ACCRUAL_MARGIN_BASE_NOTE = "от выручки после возвратов";

export const ACCRUAL_BUCKET_LABELS: Record<AccrualBucket, string> = {
  salesRevenue: ACCRUAL_REVENUE_LABELS.sales,
  returnsRevenue: ACCRUAL_REVENUE_LABELS.returns,
  partnerPrograms: "Программы партнёров",
  discountPoints: "Баллы за скидки",
  commission: "Комиссия Ozon (вознаграждение)",
  logistics: "Доставка и связанные услуги",
  advertising: "Продвижение и реклама",
  compensations: "Компенсации",
  other: "Прочие начисления и сборы",
};

export type AccrualRowKind = "income" | "expense" | "subtotal" | "total" | "neutral";

export interface AccrualDisplayRow {
  key: string;
  label: string;
  /** Со знаком, копейки. */
  kopecks: number;
  kind: AccrualRowKind;
  /** Короткое пояснение под строкой (экран/PDF). */
  note?: string;
}

/**
 * Полная разбивка расчёта — единый список для экрана, деталей истории и PDF.
 * Категории начислений уже ВНУТРИ итога начислений (отдельная строка-подытог);
 * вычитаются только себестоимость, налог и ручные расходы.
 */
export function accrualBreakdownRows(s: AccrualSnapshotV1): AccrualDisplayRow[] {
  const rows: AccrualDisplayRow[] = [];
  for (const k of ACCRUAL_BUCKETS) {
    const v = s.buckets[k];
    if (v === 0 && k !== "salesRevenue") continue;
    rows.push({
      key: k,
      label: ACCRUAL_BUCKET_LABELS[k],
      kopecks: v,
      // Выручку показываем без ведущего «+» (настоящий минус сохраняется) —
      // нейтральная строка; прочие категории — доход/расход со знаком.
      kind: k === "salesRevenue" ? "neutral" : v >= 0 ? "income" : "expense",
    });
  }
  // Выручка после возвратов (= продажи до возвратов + возвраты) — справочная строка
  // сразу после продаж/возвратов: база налога и маржи, в итог отдельно не входит.
  const afterIdx = rows.reduce((at, r, i) => (r.key === "salesRevenue" || r.key === "returnsRevenue" ? i + 1 : at), 0);
  rows.splice(afterIdx, 0, {
    key: "revenueAfterReturns",
    label: ACCRUAL_REVENUE_LABELS.afterReturns,
    kopecks: s.taxRevenueBaseKopecks,
    kind: "neutral",
    note: "Продажи до возвратов + возвраты. От неё считаются налог и маржа расчёта; справочная строка — в итог начислений отдельно не добавляется.",
  });
  rows.push({
    key: "net",
    label: "Итог начислений Ozon",
    kopecks: s.netOzonOperationsKopecks,
    kind: "subtotal",
    note: "Сумма всех строк отчёта. Все категории выше уже включены в этот итог.",
  });
  const cc = s.costCoverage;
  rows.push({
    key: "cost",
    label: s.preliminary ? "Себестоимость (неполная)" : "Себестоимость",
    kopecks: s.productionCostKopecks,
    kind: "expense",
    note: s.preliminary
      ? `Учтена только у ${cc.withCost} из ${cc.requiredProducts} ${pluralRu(cc.requiredProducts, "товара", "товаров", "товаров")} — нужна себестоимость остальных.`
      : "Нетто-количество (продано − возвращено) × себестоимость из каталога на момент расчёта.",
  });
  rows.push({
    key: "tax",
    label:
      s.tax.ratePercent > 0
        ? `Налог (${s.tax.ratePercent.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%)`
        : "Налог",
    kopecks: s.tax.kopecks,
    kind: "expense",
    note: "Считается от выручки после возвратов.",
  });
  if (s.manualExpenses.totalKopecks > 0) {
    rows.push({
      key: "manual",
      label: "Ручные расходы",
      kopecks: s.manualExpenses.totalKopecks,
      kind: "expense",
      note: "Упаковка, доставка до склада, зарплата, реклама вне Ozon и прочие расходы, не включённые в отчёт.",
    });
  }
  rows.push({
    key: "profit",
    label: s.preliminary ? "Предварительная прибыль" : "Итоговая чистая прибыль",
    kopecks: s.netProfitKopecks,
    kind: "total",
  });
  return rows;
}

/** Строка мини-разбивки «Последних расчётов»: рубли (abs для income/expense), null → «—». */
export interface AccrualHistRow {
  label: string;
  value: number | null;
  kind: AccrualRowKind;
}

export function accrualHistDetailRows(s: AccrualSnapshotV1): AccrualHistRow[] {
  return accrualBreakdownRows(s).map((r) => ({
    label:
      r.key === "net"
        ? "Итог начислений Ozon (включает все категории выше)"
        : r.key === "revenueAfterReturns"
        ? `${r.label} (справочно, база маржи)`
        : r.label,
    value: kopecksToRub(r.kind === "income" || r.kind === "expense" ? Math.abs(r.kopecks) : r.kopecks),
    kind: r.kind,
  }));
}

export interface AccrualNotice {
  tone: "warn" | "info";
  text: string;
}

/** Предупреждения для экрана/PDF: сохранённые + производные от полей снимка. */
export function accrualNotices(s: AccrualSnapshotV1): AccrualNotice[] {
  const out: AccrualNotice[] = [];
  const seen = new Set<string>();
  const push = (tone: AccrualNotice["tone"], text: string) => {
    if (!seen.has(text)) {
      seen.add(text);
      out.push({ tone, text });
    }
  };
  if (s.preliminary) {
    const cc = s.costCoverage;
    if (cc.missingCost > 0) {
      push(
        "warn",
        `Предварительный результат: у ${cc.missingCost} из ${cc.requiredProducts} ${pluralRu(cc.requiredProducts, "товара", "товаров", "товаров")} нет себестоимости, поэтому реальная прибыль может быть ниже расчётной.`
      );
    }
    if (cc.unattributedNetQuantity !== 0) {
      push("warn", "В отчёте есть продажи или возвраты без артикула — себестоимость по ним не учтена.");
    }
  }
  const WARN_CODES = new Set(["period_incomplete", "sale_rows_without_article", "dates_outside_declared_period"]);
  for (const w of s.warnings) push(WARN_CODES.has(w.code) ? "warn" : "info", w.message);
  if (!s.period.periodComplete && !s.warnings.some((w) => w.code === "period_incomplete")) {
    push("warn", "Отчёт охватывает не весь календарный месяц — итоги неполные.");
  }
  return out;
}

/** Пояснения «Как считаем» (одинаковые для экрана и PDF). */
export function accrualExplanations(s: AccrualSnapshotV1): string[] {
  return [
    "Итог начислений Ozon — сумма всех строк отчёта «Сумма итого, руб.». Комиссия, логистика, реклама, компенсации и остальные категории уже входят в этот итог и второй раз не вычитаются.",
    `${accrualProfitLabel(s)} = итог начислений − себестоимость − налог − ручные расходы.`,
    "Выручка после возвратов = продажи до возвратов + возвраты (возвраты — со своим знаком). От неё считается налог. Себестоимость — по нетто-количеству (продано − возвращено) из каталога на момент расчёта.",
    "Маржа расчёта = прибыль / выручка после возвратов; если выручка после возвратов ≤ 0, маржа не определяется и показывается «—».",
    "По товарам: начисления с артикулом учтены напрямую; общие начисления без товара (реклама, компенсации), налог и ручные расходы распределены пропорционально положительной выручке товара после возвратов.",
    "Это сохранённый результат: значения не пересчитываются по текущему каталогу и ценам.",
  ];
}

export function accrualPeriodLabel(s: AccrualSnapshotV1): string {
  return fmtMonthLabel(s.period.month);
}

export function accrualPeriodRange(s: AccrualSnapshotV1): string {
  const from = s.period.declaredFrom ?? s.period.dateFrom;
  const to = s.period.declaredTo ?? s.period.dateTo;
  return fmtDateRange(from, to);
}

// ---------------------------------------------------------------------------
// Товары: строки для существующей товарной аналитики, лучший/худший, покрытие
// ---------------------------------------------------------------------------

/** Готовые строки (рубли) для OzonProductBreakdown — из СНИМКА, без каталога. */
export function accrualProductBreakdownRows(s: AccrualSnapshotV1): AccrualBreakdownRow[] {
  return s.products.map((p) => toBreakdownRow(p));
}

export interface AccrualKeyProduct {
  article: string;
  name: string;
  profitKopecks: number;
  /** null → «—». */
  marginPercent: number | null;
  /**
   * На чём основан показатель: «sales» — расчётная прибыль от продаж (разделение
   * доступно); «full_profit» — полная прибыль товара с возвратами и расходами без
   * продаж (старый снимок / нет «ID начисления»). Подписи обязаны это различать.
   */
  basis: "sales" | "full_profit";
  /**
   * Только для basis «sales»: подпись охвата, если позиция «самый убыточный» доказана
   * лишь среди товаров с точным результатом продаж (см. accrualWorstSalesText). null —
   * позиция доказана среди всех товаров с продажами (или basis «full_profit»).
   */
  scopeNote: string | null;
}

/**
 * Лучший товар — по полной прибыли, только среди прибыльных (profit > 0; правило
 * pickProfitableRows — то же, что у списка «Самые прибыльные товары»); прибыльных нет
 * → null. Самый убыточный — по расчётной
 * прибыли от продаж, если разделение доступно: только товар с ТОЧНЫМ отрицательным
 * результатом продаж (правило — accrualSalesSplitView); иначе — по полной прибыли с
 * пометкой basis:"full_profit" (не выдаётся за продажи).
 */
export function accrualKeyProducts(s: AccrualSnapshotV1): {
  best: AccrualKeyProduct | null;
  worst: AccrualKeyProduct | null;
  /** Товаров с известной прибылью (есть что показывать в блоке ключевых товаров). */
  scoredCount: number;
} {
  const scored = s.products.filter(
    (p) => p.profitKopecks !== null && (p.costRequired ? p.hasCost : true)
  );
  const toKey = (p: AccrualSnapshotProduct): AccrualKeyProduct => ({
    article: p.article,
    name: p.name,
    profitKopecks: p.profitKopecks ?? 0,
    marginPercent: p.marginPercent,
    basis: "full_profit",
    scopeNote: null,
  });
  const top = pickProfitableRows(
    scored.map((p, i) => ({ article: p.article, profit: p.profitKopecks, hasCost: true, i })),
    1
  )[0];
  const best = top ? toKey(scored[top.i]) : null;
  const scoredCount = scored.length;

  const view = accrualSalesSplitView(s);
  if (view.availability === "ok") {
    const w = view.worst;
    return {
      best,
      scoredCount,
      worst:
        w && w.salesResultKopecks !== null
          ? {
              article: w.article,
              name: w.name,
              profitKopecks: w.salesResultKopecks,
              marginPercent: w.salesMarginPercent,
              basis: "sales",
              scopeNote: accrualWorstSalesText(view).note,
            }
          : null,
    };
  }
  if (scored.length === 0) return { best: null, worst: null, scoredCount };
  const min = scored.reduce((w, p) => ((p.profitKopecks ?? 0) < (w.profitKopecks ?? 0) ? p : w));
  return { best, worst: (min.profitKopecks ?? 0) < 0 ? toKey(min) : null, scoredCount };
}

// ---------------------------------------------------------------------------
// Разделение результата товаров: единый вид для экрана, рекомендаций и PDF
// ---------------------------------------------------------------------------

/** ok — разделение есть; legacy — снимок до разделения; no_ref_column — в отчёте нет «ID начисления»; invariant — не сошлось. */
export type AccrualSplitAvailability = "ok" | "legacy" | "no_ref_column" | "invariant";

/**
 * Доказанно убыточные продажи (верхняя граница результата < 0). Доказанный знак ≠
 * известная величина: при exact=false известен только диапазон, одно число прибыли и
 * маржи не показывается (salesResultKopecks/salesMarginPercent = null).
 */
export interface AccrualSalesLossRow {
  article: string;
  name: string;
  /** Выручка продаж (строки «Выручка» групп продаж), > 0. */
  salesRevenueKopecks: number;
  /** Точная «Расчётная прибыль от продаж» (< 0); null — известен только диапазон. */
  salesResultKopecks: number | null;
  /** Маржа продаж; null — выручка ≤ 0 или результат известен только диапазоном. */
  salesMarginPercent: number | null;
  exact: boolean;
  /** Диапазон результата продаж; при exact lower = upper = результат. */
  lowerKopecks: number;
  upperKopecks: number;
}

export interface AccrualSalesExcludedRow {
  article: string;
  name: string;
  /** Диапазон результата продаж при разном отнесении неразделённых операций (lower < 0 ≤ upper). */
  lowerKopecks: number;
  upperKopecks: number;
}

export interface AccrualSplitBlockRow {
  article: string;
  name: string;
  /** null — себестоимость неизвестна. */
  resultKopecks: number | null;
  rows: number;
  groups: number;
}

export interface AccrualUnsplitComponent {
  label: string;
  kopecks: number;
}

export interface AccrualUnsplitRow extends AccrualSplitBlockRow {
  reasons: { reason: UnsplitReason; label: string; count: number }[];
  /** Конкретные суммы: строки отчёта по корзинам, себестоимость и распределённые суммы. */
  components: AccrualUnsplitComponent[];
}

export interface AccrualSalesSplitView {
  availability: AccrualSplitAvailability;
  /**
   * Доказанно убыточные продажи: сначала с точным результатом (по возрастанию), затем
   * известные только диапазоном (по верхней границе) — их порядок позицией не является.
   */
  losses: AccrualSalesLossRow[];
  /**
   * «Самый убыточный по продажам»: минимум среди товаров с ТОЧНЫМ отрицательным
   * результатом. Товар с диапазоном в выбор не входит — его величина неизвестна.
   */
  worst: AccrualSalesLossRow | null;
  /**
   * all — позиция доказана среди всех товаров с продажами (ни у кого нижняя граница не
   * ниже, себестоимость известна у всех); exact_only — только среди товаров с точным
   * результатом (подписывается охват). null — worst нет.
   */
  worstScope: "all" | "exact_only" | null;
  /** Товаров с продажами и точным результатом продаж — охват выбора. */
  exactSalesProducts: number;
  /** Не ранжированы: неразделённые операции могут изменить вывод об убыточности. */
  excluded: AccrualSalesExcludedRow[];
  /** Товаров с продажами, но без себестоимости (в рейтинг не входят). */
  salesWithoutCost: number;
  sales: { totalKopecks: number | null; products: number };
  returns: { totalKopecks: number | null; rows: AccrualSplitBlockRow[] };
  noSale: { totalKopecks: number | null; rows: AccrualSplitBlockRow[] };
  unsplit: { totalKopecks: number | null; rows: AccrualUnsplitRow[] };
  /** Σ частей по всем товарам = прибыль товаров; null — у части товаров результат неизвестен. */
  reconciliation: {
    salesKopecks: number;
    returnsKopecks: number;
    noSaleKopecks: number;
    unsplitKopecks: number;
    productProfitKopecks: number;
  } | null;
}

export const UNSPLIT_REASON_LABELS: Record<UnsplitReason, string> = {
  partial_return: "частичный возврат по одному ID (затраты по единицам не разделить)",
  ambiguous_link: "неоднозначная связь продажи и возврата",
  no_sale_link: "операции без связи с продажей (реклама, эквайринг по номеру заказа, размещение)",
  no_ref: "строки без «ID начисления»",
};

function emptyView(availability: AccrualSplitAvailability): AccrualSalesSplitView {
  return {
    availability,
    losses: [],
    worst: null,
    worstScope: null,
    exactSalesProducts: 0,
    excluded: [],
    salesWithoutCost: 0,
    sales: { totalKopecks: null, products: 0 },
    returns: { totalKopecks: null, rows: [] },
    noSale: { totalKopecks: null, rows: [] },
    unsplit: { totalKopecks: null, rows: [] },
    reconciliation: null,
  };
}

const sumOrNull = (vals: (number | null)[]): number | null =>
  vals.some((v) => v === null) ? null : vals.reduce<number>((a, v) => a + (v as number), 0);

/** Разделение результата товаров из снимка. Ничего не пересчитывает по каталогу. */
export function accrualSalesSplitView(s: AccrualSnapshotV1): AccrualSalesSplitView {
  if (!s.salesSplit) return emptyView("legacy");
  if (!s.salesSplit.available) return emptyView(s.salesSplit.reason === "invariant" ? "invariant" : "no_ref_column");

  const view = emptyView("ok");
  const salesResults: (number | null)[] = [];
  const retRows: AccrualSplitBlockRow[] = [];
  const noSaleRows: AccrualSplitBlockRow[] = [];
  const unsplitRows: AccrualUnsplitRow[] = [];
  let allKnown = true;
  const totals = { sales: 0, returns: 0, noSale: 0, unsplit: 0, profit: 0 };
  /** Нижние границы товаров с продажами, чей результат известен только диапазоном. */
  const rangedLowers: number[] = [];

  for (const p of s.products) {
    const sp = p.split;
    if (!sp) continue;
    const name = p.name || p.article;
    const a = assessSalesLoss(sp);
    if (sp.groups.sales > 0) {
      view.sales.products++;
      salesResults.push(a.salesResultKopecks);
      if (a.status !== "no_cost" && a.status !== "no_sales") {
        if (a.exact) view.exactSalesProducts++;
        else rangedLowers.push(a.lowerKopecks as number);
      }
      if (a.status === "loss") {
        view.losses.push({
          article: p.article,
          name,
          salesRevenueKopecks: a.salesRevenueKopecks,
          salesResultKopecks: a.exact ? a.salesResultKopecks : null,
          salesMarginPercent: a.exact ? a.salesMarginPercent : null,
          exact: a.exact,
          lowerKopecks: a.lowerKopecks as number,
          upperKopecks: a.upperKopecks as number,
        });
      } else if (a.status === "undetermined") {
        view.excluded.push({
          article: p.article,
          name,
          lowerKopecks: a.lowerKopecks as number,
          upperKopecks: a.upperKopecks as number,
        });
      } else if (a.status === "no_cost") {
        view.salesWithoutCost++;
      }
    }
    const block = (k: SplitPartKey): AccrualSplitBlockRow => ({
      article: p.article,
      name,
      resultKopecks: splitPartResult(sp.parts[k]),
      rows: sp.parts[k].rows,
      groups: sp.groups[k],
    });
    if (sp.parts.returns.rows > 0) retRows.push(block("returns"));
    if (sp.parts.noSale.rows > 0) noSaleRows.push(block("noSale"));
    if (sp.parts.unsplit.rows > 0) {
      const u = sp.parts.unsplit;
      const components: AccrualUnsplitComponent[] = [];
      for (const b of ACCRUAL_BUCKETS) {
        if (sp.unsplitBuckets[b] !== 0) components.push({ label: ACCRUAL_BUCKET_LABELS[b], kopecks: sp.unsplitBuckets[b] });
      }
      if (u.cogsKopecks !== null && u.cogsKopecks !== 0) components.push({ label: "Себестоимость", kopecks: -u.cogsKopecks });
      if (u.generalKopecks !== 0) components.push({ label: "Доля общих начислений без товара", kopecks: u.generalKopecks });
      if (u.taxKopecks !== 0) components.push({ label: "Доля налога", kopecks: -u.taxKopecks });
      if (u.manualKopecks !== 0) components.push({ label: "Доля ручных расходов", kopecks: -u.manualKopecks });
      unsplitRows.push({
        ...block("unsplit"),
        reasons: UNSPLIT_REASONS.filter((r) => sp.unsplitReasons[r] > 0).map((r) => ({
          reason: r,
          label: UNSPLIT_REASON_LABELS[r],
          count: sp.unsplitReasons[r],
        })),
        components,
      });
    }
    const parts = SPLIT_PARTS.map((k) => splitPartResult(sp.parts[k]));
    if (p.profitKopecks === null || parts.some((v) => v === null)) allKnown = false;
    else {
      totals.sales += parts[0] as number;
      totals.returns += parts[1] as number;
      totals.noSale += parts[2] as number;
      totals.unsplit += parts[3] as number;
      totals.profit += p.profitKopecks;
    }
  }

  const byArticle = (x: { article: string }, y: { article: string }) => (x.article < y.article ? -1 : 1);
  view.losses.sort(
    (x, y) =>
      Number(y.exact) - Number(x.exact) ||
      x.upperKopecks - y.upperKopecks ||
      x.lowerKopecks - y.lowerKopecks ||
      byArticle(x, y)
  );
  view.excluded.sort((x, y) => x.lowerKopecks - y.lowerKopecks || x.upperKopecks - y.upperKopecks || byArticle(x, y));
  // Правило «самого убыточного»: только точный результат; позиция доказана для всех,
  // если ни одна нижняя граница «диапазонных» товаров не ниже и себестоимость известна у всех.
  const w = view.losses.find((l) => l.exact) ?? null;
  view.worst = w;
  view.worstScope = w
    ? view.salesWithoutCost === 0 && rangedLowers.every((lo) => lo >= w.lowerKopecks)
      ? "all"
      : "exact_only"
    : null;
  const byResult = (x: AccrualSplitBlockRow, y: AccrualSplitBlockRow) =>
    (x.resultKopecks ?? 0) - (y.resultKopecks ?? 0) || (x.article < y.article ? -1 : 1);
  view.sales.totalKopecks = sumOrNull(salesResults);
  view.returns = { totalKopecks: sumOrNull(retRows.map((r) => r.resultKopecks)), rows: retRows.sort(byResult) };
  view.noSale = { totalKopecks: sumOrNull(noSaleRows.map((r) => r.resultKopecks)), rows: noSaleRows.sort(byResult) };
  view.unsplit = { totalKopecks: sumOrNull(unsplitRows.map((r) => r.resultKopecks)), rows: unsplitRows.sort(byResult) };
  view.reconciliation = allKnown
    ? {
        salesKopecks: totals.sales,
        returnsKopecks: totals.returns,
        noSaleKopecks: totals.noSale,
        unsplitKopecks: totals.unsplit,
        productProfitKopecks: totals.profit,
      }
    : null;
  return view;
}

/**
 * Рейтинг убыточных для экрана (рубли). salesBasis=true — «Продажи в минус» по
 * расчётной прибыли от продаж; false — разделение недоступно, рейтинг строит сам
 * блок товаров по полной прибыли с подписью note.
 */
export interface AccrualSalesLossRanking {
  salesBasis: boolean;
  note: string | null;
  /**
   * profit/margin — только при точном результате; range — известен лишь диапазон (рубли),
   * тогда profit и margin = null и показывается «от … до …».
   */
  rows: {
    article: string;
    name: string;
    revenue: number;
    profit: number | null;
    margin: number | null;
    range: { lower: number; upper: number } | null;
  }[];
  excluded: { article: string; name: string; reason: string }[];
  /** «Самый убыточный по продажам» (только точный результат) — то же правило, что PDF и рекомендации. */
  worst: AccrualSalesLossRanking["rows"][number] | null;
  /** Подпись охвата под карточкой; null — не нужна. */
  worstNote: string | null;
  /** Текст карточки без товара и его тон (ok — убытка нет; warn — есть неопределённость). */
  worstEmpty: { text: string; tone: "ok" | "warn" };
  /** Пояснение к строкам-диапазонам списка; null — таких строк нет. */
  rangeNote: string | null;
}

export function accrualSalesLossRanking(s: AccrualSnapshotV1): AccrualSalesLossRanking {
  const v = accrualSalesSplitView(s);
  if (v.availability !== "ok") {
    // Причина недоступности показана ниже блоком разделения — здесь только основание рейтинга.
    return {
      salesBasis: false,
      note: "Рейтинг по полной прибыли товара, включая возвраты: разделение продаж и возвратов для этого расчёта недоступно (причина — ниже).",
      rows: [],
      excluded: [],
      worst: null,
      worstNote: null,
      worstEmpty: { text: "Убыточных товаров не найдено", tone: "ok" },
      rangeNote: null,
    };
  }
  const toRow = (l: AccrualSalesLossRow): AccrualSalesLossRanking["rows"][number] => ({
    article: l.article,
    name: l.name,
    revenue: kopecksToRub(l.salesRevenueKopecks),
    profit: l.salesResultKopecks === null ? null : kopecksToRub(l.salesResultKopecks),
    margin: l.salesMarginPercent,
    range: l.exact ? null : { lower: kopecksToRub(l.lowerKopecks), upper: kopecksToRub(l.upperKopecks) },
  });
  const t = accrualWorstSalesText(v);
  return {
    salesBasis: true,
    note:
      "Рейтинг по расчётной прибыли от продаж: в него попадают товары с продажами, известной себестоимостью и доказанно отрицательным результатом продаж. Возвраты, расходы без продаж и неразделённые операции показаны ниже отдельно и учтены в полной прибыли товара.",
    rows: v.losses.map(toRow),
    excluded: v.excluded.map((x) => ({
      article: x.article,
      name: x.name,
      reason: `результат продаж не определён: от ${fmtRub(x.lowerKopecks)} до ${fmtRub(x.upperKopecks)} — неразделённые операции могут изменить его знак`,
    })),
    worst: v.worst ? toRow(v.worst) : null,
    worstNote: t.note,
    worstEmpty: { text: t.emptyText, tone: t.emptyTone },
    rangeNote: v.losses.some((l) => !l.exact) ? ACCRUAL_RANGE_NOTE : null,
  };
}

/** Пояснение к строкам «от … до …» (экран и PDF). */
export const ACCRUAL_RANGE_NOTE =
  "«от … до …» — убыток от продаж доказан, но точная величина не определена: неразделённые операции товара (например, реклама или эквайринг под другим ID, частичный возврат) могут относиться к продажам полностью, частично или не относиться. Такие товары не участвуют в выборе самого убыточного, их порядок в списке — не позиция.";

/**
 * Тексты правила «самого убыточного по продажам» — одни для экрана, PDF и рекомендаций.
 * note — подпись охвата, если позиция доказана только среди товаров с точным результатом;
 * emptyText/emptyShort/emptyTone — карточка без товара (short — для узкой карточки PDF).
 */
export function accrualWorstSalesText(v: AccrualSalesSplitView): {
  note: string | null;
  emptyText: string;
  emptyShort: string;
  emptyTone: "ok" | "warn";
} {
  const ranged = v.losses.filter((l) => !l.exact).length;
  const note =
    v.worst && v.worstScope === "exact_only"
      ? `Выбран только среди товаров с точно определённым результатом продаж (${v.exactSalesProducts} из ${v.sales.products} с продажами). ` +
        `У остальных результат известен лишь диапазоном${v.salesWithoutCost > 0 ? " или неизвестна себестоимость" : ""} — доказать, кто из них убыточнее, нельзя.`
      : null;
  if (ranged > 0) {
    return {
      note,
      emptyText: `Убыток от продаж доказан у ${ranged} ${pluralRu(ranged, "товара", "товаров", "товаров")}, но точная величина не определена — см. «Продажи в минус».`,
      emptyShort: "Точный убыток не определён",
      emptyTone: "warn",
    };
  }
  if (v.excluded.length > 0) {
    return {
      note,
      emptyText: `Доказанно убыточных продаж нет; у ${v.excluded.length} ${pluralRu(v.excluded.length, "товара", "товаров", "товаров")} знак результата продаж не определён.`,
      emptyShort: "Доказанного убытка нет",
      emptyTone: "warn",
    };
  }
  return { note, emptyText: "Убыточных продаж не найдено", emptyShort: "Убыточных продаж не найдено", emptyTone: "ok" };
}

/**
 * Сверка частей одной строкой (экран/PDF): «632,11 ₽ − 664,00 ₽ − 15,00 ₽ + 179,90 ₽ =
 * 133,01 ₽» — знак операции берётся из знака части, без «+ −». Неразделённые — только
 * если они есть. null — сверка недоступна (у части товаров нет себестоимости).
 */
export function accrualSplitReconciliationText(view: AccrualSalesSplitView): string | null {
  const r = view.reconciliation;
  if (!r) return null;
  const parts = [r.salesKopecks, r.returnsKopecks, r.noSaleKopecks];
  if (view.unsplit.rows.length > 0) parts.push(r.unsplitKopecks);
  const expr = parts
    .map((k, i) => (i === 0 ? fmtRub(k) : (k < 0 ? "− " : "+ ") + fmtRub(Math.abs(k))))
    .join(" ");
  return `${expr} = прибыль товаров ${fmtRub(r.productProfitKopecks)}`;
}

/** Короткое объяснение недоступности разделения (экран/PDF). null — доступно. */
export function accrualSplitUnavailableText(a: AccrualSplitAvailability): string | null {
  switch (a) {
    case "ok":
      return null;
    case "legacy":
      return "Разделение продаж, возвратов и расходов без продаж недоступно: расчёт сохранён до появления этого разделения. Рейтинг убыточных товаров ниже — по полной прибыли товара, включая возвраты.";
    case "no_ref_column":
      return "Разделение продаж и возвратов недоступно: в загруженном отчёте нет колонки «ID начисления», связать операции нельзя. Рейтинг убыточных товаров — по полной прибыли товара, включая возвраты.";
    case "invariant":
      return "Разделение продаж и возвратов недоступно: суммы частей не сошлись с прибылью товара. Рейтинг убыточных товаров — по полной прибыли товара, включая возвраты.";
  }
}

/** Покрытие каталога на момент расчёта (для «Проверки расчёта» и подписей). */
export function accrualCostCoverageView(s: AccrualSnapshotV1): {
  total: number;
  withCost: number;
  withoutCost: number;
  serviceOnly: number;
} {
  return {
    total: s.productTotals.productCount,
    withCost: s.costCoverage.withCost,
    withoutCost: s.costCoverage.missingCost,
    serviceOnly: s.productTotals.serviceOnlyCount,
  };
}

// ---------------------------------------------------------------------------
// Контекст для рекомендаций / AI (без УПД: только реальные категории начислений)
// ---------------------------------------------------------------------------

/** Расходные категории начислений (положительные суммы = списания, ₽). */
export interface AccrualChargeCategories {
  commission: number;
  logistics: number;
  advertising: number;
  other: number;
  /** База для долей: реализация после возвратов + положительные «баллы за скидки». */
  shareBase: number;
}

const charge = (kop: number): number => (kop < 0 ? kopecksToRub(-kop) : 0);

export function accrualChargeCategories(s: AccrualSnapshotV1): AccrualChargeCategories {
  const points = s.buckets.discountPoints > 0 ? s.buckets.discountPoints : 0;
  return {
    commission: charge(s.buckets.commission),
    logistics: charge(s.buckets.logistics),
    advertising: charge(s.buckets.advertising),
    other: charge(s.buckets.other),
    shareBase: kopecksToRub(s.taxRevenueBaseKopecks + points),
  };
}

/** Топ товаров для AI-контекста: только имя, артикул, прибыль, маржа — без файлов и операций. */
export function accrualAiProducts(
  s: AccrualSnapshotV1,
  limit = 15
): { name: string; sku: string; profit: number; margin?: number }[] {
  return s.products
    .filter((p) => p.profitKopecks !== null)
    .sort((a, b) => (b.profitKopecks ?? 0) - (a.profitKopecks ?? 0))
    .slice(0, limit)
    .map((p) => ({
      name: (p.name || p.article).slice(0, 80),
      sku: p.article.slice(0, 40),
      profit: Math.round(kopecksToRub(p.profitKopecks ?? 0)),
      ...(p.marginPercent !== null ? { margin: Math.round(p.marginPercent * 10) / 10 } : {}),
    }));
}

/** Сколько товаров, где себестоимость нужна, но неизвестна. */
export function accrualProductsWithoutCost(s: AccrualSnapshotV1): number {
  return s.costCoverage.missingCost;
}

// ---------------------------------------------------------------------------
// Пропсы «умных рекомендаций» (ProfitRecommendations) из снимка
// ---------------------------------------------------------------------------

/** Ссылка на товар для рекомендаций (рубли; margin null → «—»). */
export interface AccrualRecoProductRef {
  article: string;
  name: string;
  profit: number;
  margin: number | null;
  /** sales — прибыль от продаж; full_profit — полная прибыль товара (с возвратами). */
  basis: "sales" | "full_profit";
  /** Подпись охвата «самого убыточного» (то же правило, что экран и PDF); null — не нужна. */
  scopeNote: string | null;
}

/**
 * Данные для блока рекомендаций при просмотре сохранённого расчёта. Структура
 * совпадает с ProfitRecommendationsProps. УПД в этом режиме нет: поля УПД = 0,
 * вместо них — accrualCategories (реальные категории начислений).
 */
export function accrualRecoProps(s: AccrualSnapshotV1) {
  const kp = accrualKeyProducts(s);
  const cov = accrualCostCoverageView(s);
  const toRef = (p: AccrualKeyProduct | null): AccrualRecoProductRef | null =>
    p
      ? {
          article: p.article,
          name: p.name,
          profit: kopecksToRub(p.profitKopecks),
          margin: p.marginPercent,
          basis: p.basis,
          scopeNote: p.scopeNote,
        }
      : null;
  return {
    hasReport: true,
    ready: s.productionCostKopecks > 0,
    revenue: kopecksToRub(s.taxRevenueBaseKopecks),
    profitBeforeCost: kopecksToRub(s.netOzonOperationsKopecks),
    updServicesTotal: 0,
    updCommissionTotal: 0,
    netProfit: kopecksToRub(s.netProfitKopecks),
    margin: s.marginPercent ?? 0,
    marginKnown: s.marginPercent !== null,
    roi: accrualSnapshotRoi(s) ?? 0,
    costPrice: kopecksToRub(s.productionCostKopecks),
    tax: kopecksToRub(s.tax.kopecks),
    taxPercent: s.tax.ratePercent,
    ads: kopecksToRub(s.manualExpenses.adsOutsideOzonKopecks),
    otherExpenses: kopecksToRub(s.manualExpenses.totalKopecks),
    coverage: {
      total: cov.withCost + cov.withoutCost,
      withCost: cov.withCost,
      withoutCost: cov.withoutCost,
    },
    best: toRef(kp.best),
    worst: toRef(kp.worst),
    accrualCategories: accrualChargeCategories(s),
  };
}
