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
import { fmtDateRange, fmtMonthLabel, pluralRu } from "./format";
import { toBreakdownRow, type AccrualBreakdownRow } from "./product-analytics";

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
  };
  return snap;
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
  };
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
    totalKopecks: intGE0(me.totalKopecks, "manualExpenses.totalKopecks"),
  };
  if (
    manualExpenses.totalKopecks !==
    manualExpenses.packagingKopecks +
      manualExpenses.deliveryToWarehouseKopecks +
      manualExpenses.salaryKopecks +
      manualExpenses.otherKopecks
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

export const ACCRUAL_BUCKET_LABELS: Record<AccrualBucket, string> = {
  salesRevenue: "Реализация (выручка)",
  returnsRevenue: "Возвраты выручки",
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
      kind: v >= 0 ? "income" : "expense",
    });
  }
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
    note: "Считается от реализации после возвратов.",
  });
  if (s.manualExpenses.totalKopecks > 0) {
    rows.push({
      key: "manual",
      label: "Ручные расходы",
      kopecks: s.manualExpenses.totalKopecks,
      kind: "expense",
      note: "Упаковка, доставка до склада, зарплата и прочие расходы вне отчёта.",
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
    label: r.key === "net" ? "Итог начислений Ozon (включает все категории выше)" : r.label,
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
    "Налог считается от реализации после возвратов (продажи − возвраты). Себестоимость — по нетто-количеству (продано − возвращено) из каталога на момент расчёта.",
    "Маржа = прибыль / реализация после возвратов; если реализация ≤ 0, маржа не определяется и показывается «—».",
    "По товарам: начисления с артикулом учтены напрямую; общие начисления без товара (реклама, компенсации), налог и ручные расходы распределены пропорционально положительной реализации.",
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
}

/** Самый прибыльный / самый убыточный (только отрицательный) — как в существующей аналитике. */
export function accrualKeyProducts(s: AccrualSnapshotV1): {
  best: AccrualKeyProduct | null;
  worst: AccrualKeyProduct | null;
} {
  const scored = s.products.filter(
    (p) => p.profitKopecks !== null && (p.costRequired ? p.hasCost : true)
  );
  if (scored.length === 0) return { best: null, worst: null };
  const toKey = (p: AccrualSnapshotProduct): AccrualKeyProduct => ({
    article: p.article,
    name: p.name,
    profitKopecks: p.profitKopecks ?? 0,
    marginPercent: p.marginPercent,
  });
  const best = scored.reduce((b, p) => ((p.profitKopecks ?? 0) > (b.profitKopecks ?? 0) ? p : b));
  const min = scored.reduce((w, p) => ((p.profitKopecks ?? 0) < (w.profitKopecks ?? 0) ? p : w));
  return {
    best: toKey(best),
    worst: (min.profitKopecks ?? 0) < 0 ? toKey(min) : null,
  };
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
    ads: 0,
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
