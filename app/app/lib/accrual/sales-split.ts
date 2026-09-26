// ============================================================================
// Разделение результата товара по «Отчёту по начислениям»: продажи, возвраты,
// расходы без продаж и неразделённые операции. ЧИСТЫЙ модуль (без UI/сети).
//
// Связь операций. «ID начисления» (row.ref) — НЕ уникальный ID строки и НЕ
// обязательно номер отправления: в реальных отчётах это номер отправления у товарных
// операций, номер заказа у эквайринга, иные ID у рекламы и размещения. Поэтому ссылка
// используется только как ключ связи: строки товара группируются по (ссылка, артикул),
// строки не дедуплицируются. Товар (артикул) уже фиксирован агрегацией ядра.
//
// Классы групп (S — штук «Выручка», R — штук «Возврат выручки» в группе):
//   • продажа          — есть «Выручка», нет «Возврата выручки» и нет строк возврата;
//   • полный возврат   — есть «Возврат выручки» и либо нет «Выручки» (возврат продажи
//                        другого периода), либо S = R > 0 (вернули всё проданное);
//   • без продаж        — нет ни «Выручки», ни «Возврата выручки», и ВСЕ строки группы —
//                        доставка/обработка (корзина «логистика»): невыкуп, отмена или
//                        доставка, выручка по которой не попала в период;
//   • неразделённые    — всё остальное: частичный возврат (0 < R < S), неоднозначная связь
//                        (R > S; строки возврата без «Возврата выручки»), операции без связи
//                        с продажей (реклама, эквайринг по номеру заказа, размещение…) и
//                        строки товара без ссылки. Это КОНКРЕТНЫЕ строки отчёта — не остаток.
//   Частичный возврат НЕ относится к возвратам целиком и не делится на «оставшуюся
//   продажу» и «возврат»: затраты отправления по единицам без подтверждения не делятся.
//
// Себестоимость части = количество части (продано − возвращено) × себестоимость единицы
// на момент расчёта — то же правило, что у товара. Копеечное расхождение округления
// (только при себестоимости единицы с долями копейки) относится к части с наибольшим
// по модулю количеством — так Σ частей = себестоимость товара ровно.
//
// Налог, ручные расходы и общие начисления без товара — ТЕ ЖЕ суммы, что уже
// распределены на товар; внутри товара они делятся между частями пропорционально
// ПОЛОЖИТЕЛЬНОЙ выручке части (метод наибольших остатков). Это правило распределения,
// а не доказанная привязка расхода к отправлению. Часть без положительной выручки
// (возвраты, расходы без продаж, продажи при их отсутствии) общих расходов не получает —
// «результат продаж» не создаётся из одних общих расходов.
//
// Результат части = прямые строки + доля общих начислений − себестоимость − налог −
// ручные. Σ результатов частей = прибыль товара ДО КОПЕЙКИ; итог периода, себестоимость
// и распределение между товарами не меняются.
// ============================================================================

import { ACCRUAL_BUCKETS, type AccrualBucketSums, type AccrualRow } from "./types";
import { emptyBucketSums, normalizeTaxonomyKey } from "./buckets";
import { allocateLargestRemainder, ratioPercent } from "./money";
import { normArticleKey } from "../product-breakdown-calc";

export const SPLIT_PARTS = ["sales", "returns", "noSale", "unsplit"] as const;
export type SplitPartKey = (typeof SPLIT_PARTS)[number];

export interface SplitPart {
  /** Σ исходных строк части (со знаком), копейки. */
  directKopecks: number;
  /** Σ строк «Выручка» и «Возврат выручки» части (со знаком). */
  revenueKopecks: number;
  /** Продано − возвращено в части (для себестоимости). */
  quantity: number;
  /** Себестоимость части; null — себестоимость единицы неизвестна. */
  cogsKopecks: number | null;
  /** Доли распределённых на товар сумм (правило — см. шапку). */
  generalKopecks: number;
  taxKopecks: number;
  manualKopecks: number;
  /** Строк отчёта в части. */
  rows: number;
}

export const UNSPLIT_REASONS = ["partial_return", "ambiguous_link", "no_sale_link", "no_ref"] as const;
export type UnsplitReason = (typeof UNSPLIT_REASONS)[number];

export interface ProductSplit {
  parts: Record<SplitPartKey, SplitPart>;
  /** Групп (ссылка + артикул) каждого класса. */
  groups: Record<SplitPartKey, number>;
  /** Неразделённые по причинам: группы; для «no_ref» — строки без ссылки. */
  unsplitReasons: Record<UnsplitReason, number>;
  /** Неразделённые строки по корзинам (Σ = parts.unsplit.directKopecks). */
  unsplitBuckets: AccrualBucketSums;
  /** Σ положительных / отрицательных исходных строк неразделённой части. */
  unsplitPositiveKopecks: number;
  unsplitNegativeKopecks: number;
}

/** Что нужно от товара (результат allocateAccrualProducts). */
export interface SplitProductInput {
  key: string;
  directKopecks: number;
  revenueBaseKopecks: number;
  netQuantity: number;
  unitCost: number | null;
  hasCost: boolean;
  cogsKopecks: number | null;
  allocatedGeneralKopecks: number;
  allocatedTaxKopecks: number;
  allocatedManualKopecks: number;
}

function emptyPart(): SplitPart {
  return {
    directKopecks: 0,
    revenueKopecks: 0,
    quantity: 0,
    cogsKopecks: 0,
    generalKopecks: 0,
    taxKopecks: 0,
    manualKopecks: 0,
    rows: 0,
  };
}

/** Строка — сторона возврата (группа «Возвраты», возврат вознаграждения, обратная логистика, обработка возвратов). */
function isReturnSide(r: AccrualRow): boolean {
  if (r.bucket === "returnsRevenue") return true;
  if (normalizeTaxonomyKey(r.group) === "возвраты") return true;
  const t = normalizeTaxonomyKey(r.type);
  return t.includes("возврат") || t.includes("обратн");
}

type GroupClass = { part: SplitPartKey; reason?: UnsplitReason };

function classifyGroup(rows: readonly AccrualRow[]): GroupClass {
  let hasSale = false;
  let hasReturnRevenue = false;
  let sold = 0;
  let returned = 0;
  let returnSide = false;
  let allLogistics = true;
  for (const r of rows) {
    if (r.bucket === "salesRevenue") {
      hasSale = true;
      sold += r.quantity ?? 0;
    } else if (r.bucket === "returnsRevenue") {
      hasReturnRevenue = true;
      returned += Math.abs(r.quantity ?? 0);
    }
    if (r.bucket !== "salesRevenue" && isReturnSide(r)) returnSide = true;
    if (r.bucket !== "logistics") allLogistics = false;
  }
  if (!hasSale && !hasReturnRevenue) {
    return allLogistics ? { part: "noSale" } : { part: "unsplit", reason: "no_sale_link" };
  }
  if (hasSale && !hasReturnRevenue) {
    return returnSide ? { part: "unsplit", reason: "ambiguous_link" } : { part: "sales" };
  }
  if (!hasSale) return { part: "returns" };
  if (sold > 0 && returned === sold) return { part: "returns" };
  if (returned > 0 && returned < sold) return { part: "unsplit", reason: "partial_return" };
  return { part: "unsplit", reason: "ambiguous_link" };
}

/**
 * Разделить результат каждого товара. null — разделение недоступно (в отчёте нет
 * колонки «ID начисления»: у строк нет поля ref). Результат выровнен с products.
 */
export function splitAccrualProducts(
  rows: readonly AccrualRow[],
  products: readonly SplitProductInput[]
): ProductSplit[] | null {
  if (!rows.some((r) => r.ref !== undefined)) return null;

  const byProduct = new Map<string, AccrualRow[]>();
  for (const r of rows) {
    const key = normArticleKey(r.article);
    if (!key) continue; // общие строки — распределены на товары как раньше
    const list = byProduct.get(key);
    if (list) list.push(r);
    else byProduct.set(key, [r]);
  }

  return products.map((p) => splitOne(byProduct.get(p.key) ?? [], p));
}

function splitOne(rows: readonly AccrualRow[], p: SplitProductInput): ProductSplit {
  const parts = {} as Record<SplitPartKey, SplitPart>;
  const groups = {} as Record<SplitPartKey, number>;
  for (const k of SPLIT_PARTS) {
    parts[k] = emptyPart();
    groups[k] = 0;
  }
  const unsplitReasons = {} as Record<UnsplitReason, number>;
  for (const k of UNSPLIT_REASONS) unsplitReasons[k] = 0;
  const unsplitBuckets = emptyBucketSums();
  let pos = 0;
  let neg = 0;

  const add = (part: SplitPartKey, r: AccrualRow) => {
    const t = parts[part];
    t.directKopecks += r.amountKopecks;
    t.rows++;
    if (r.bucket === "salesRevenue") {
      t.revenueKopecks += r.amountKopecks;
      t.quantity += r.quantity ?? 0;
    } else if (r.bucket === "returnsRevenue") {
      t.revenueKopecks += r.amountKopecks;
      t.quantity -= Math.abs(r.quantity ?? 0);
    }
    if (part === "unsplit") {
      unsplitBuckets[r.bucket] += r.amountKopecks;
      if (r.amountKopecks > 0) pos += r.amountKopecks;
      else neg += r.amountKopecks;
    }
  };

  // Группы по ссылке (строки без ссылки — неразделённые поштучно).
  const byRef = new Map<string, AccrualRow[]>();
  for (const r of rows) {
    const ref = (r.ref ?? "").trim();
    if (!ref) {
      add("unsplit", r);
      unsplitReasons.no_ref++;
      continue;
    }
    const g = byRef.get(ref);
    if (g) g.push(r);
    else byRef.set(ref, [r]);
  }
  for (const g of byRef.values()) {
    const cls = classifyGroup(g);
    groups[cls.part]++;
    if (cls.reason) unsplitReasons[cls.reason]++;
    for (const r of g) add(cls.part, r);
  }

  // Себестоимость частей.
  const anyQty = SPLIT_PARTS.some((k) => parts[k].quantity !== 0);
  const uc = p.unitCost;
  const ucKnown = p.hasCost && uc !== null && Number.isFinite(uc) && uc > 0;
  if (p.cogsKopecks === null || (anyQty && !ucKnown)) {
    for (const k of SPLIT_PARTS) parts[k].cogsKopecks = null;
  } else if (!anyQty) {
    for (const k of SPLIT_PARTS) parts[k].cogsKopecks = 0;
  } else {
    let sum = 0;
    for (const k of SPLIT_PARTS) {
      const c = Math.round(parts[k].quantity * (uc as number) * 100) + 0;
      parts[k].cogsKopecks = c;
      sum += c;
    }
    const diff = p.cogsKopecks - sum;
    if (diff !== 0) {
      let target: SplitPartKey = "sales";
      let best = -1;
      for (const k of SPLIT_PARTS) {
        const q = Math.abs(parts[k].quantity);
        if (q > best) {
          best = q;
          target = k;
        }
      }
      parts[target].cogsKopecks = (parts[target].cogsKopecks as number) + diff;
    }
  }

  // Распределённые суммы товара → части по положительной выручке части.
  const weights = SPLIT_PARTS.map((k) => Math.max(parts[k].revenueKopecks, 0));
  const tie = SPLIT_PARTS.map((k, i) => String(i));
  const spread = (total: number): number[] => {
    if (total === 0) return SPLIT_PARTS.map(() => 0);
    const a = allocateLargestRemainder(total, weights, tie);
    // Недостижимо: товар получает долю только при положительной реализации, а тогда
    // хотя бы у одной части выручка положительна. Страховка — в неразделённые.
    return a ?? SPLIT_PARTS.map((k) => (k === "unsplit" ? total : 0));
  };
  const general = spread(p.allocatedGeneralKopecks);
  const tax = spread(p.allocatedTaxKopecks);
  const manual = spread(p.allocatedManualKopecks);
  SPLIT_PARTS.forEach((k, i) => {
    parts[k].generalKopecks = general[i];
    parts[k].taxKopecks = tax[i];
    parts[k].manualKopecks = manual[i];
  });

  return {
    parts,
    groups,
    unsplitReasons,
    unsplitBuckets,
    unsplitPositiveKopecks: pos,
    unsplitNegativeKopecks: neg,
  };
}

/** Результат части; null — себестоимость части неизвестна. */
export function splitPartResult(part: SplitPart): number | null {
  if (part.cogsKopecks === null) return null;
  return part.directKopecks + part.generalKopecks - part.cogsKopecks - part.taxKopecks - part.manualKopecks;
}

export type SalesLossStatus = "loss" | "not_loss" | "undetermined" | "no_sales" | "no_cost";

export interface SalesLossAssessment {
  status: SalesLossStatus;
  /** «Расчётная прибыль от продаж»; null — нет продаж или себестоимость неизвестна. */
  salesResultKopecks: number | null;
  /** Выручка продаж (строки «Выручка» групп продаж). */
  salesRevenueKopecks: number;
  /** Маржа продаж; null — не вычислить. */
  salesMarginPercent: number | null;
  /** Диапазон результата продаж, если неразделённые операции отнести к продажам по-разному. */
  lowerKopecks: number | null;
  upperKopecks: number | null;
}

/**
 * Вывод об убыточности продаж товара. «loss» — только если результат продаж
 * отрицателен ПРИ ЛЮБОМ отнесении неразделённых операций (их положительные суммы
 * не могут вывести его в плюс). «undetermined» — неразделённые операции могут
 * изменить знак: товар не ранжируется как доказанно убыточный.
 */
export function assessSalesLoss(split: ProductSplit): SalesLossAssessment {
  const sales = split.parts.sales;
  const base = {
    salesRevenueKopecks: sales.revenueKopecks,
    lowerKopecks: null,
    upperKopecks: null,
  };
  if (split.groups.sales === 0) {
    return { status: "no_sales", salesResultKopecks: null, salesMarginPercent: null, ...base };
  }
  const result = splitPartResult(sales);
  const u = split.parts.unsplit;
  if (result === null || u.cogsKopecks === null) {
    return { status: "no_cost", salesResultKopecks: null, salesMarginPercent: null, ...base };
  }
  const items = [u.generalKopecks, -u.cogsKopecks, -u.taxKopecks, -u.manualKopecks];
  let upSum = split.unsplitPositiveKopecks;
  let downSum = split.unsplitNegativeKopecks;
  for (const v of items) {
    if (v > 0) upSum += v;
    else downSum += v;
  }
  const upper = result + upSum;
  const lower = result + downSum;
  const status: SalesLossStatus = upper < 0 ? "loss" : lower >= 0 ? "not_loss" : "undetermined";
  return {
    status,
    salesResultKopecks: result,
    salesRevenueKopecks: sales.revenueKopecks,
    salesMarginPercent: ratioPercent(result, sales.revenueKopecks),
    lowerKopecks: lower,
    upperKopecks: upper,
  };
}

/** Проверка инвариантов разделения против товара (для ядра, чтеца снимка и тестов). */
export function splitMatchesProduct(split: ProductSplit, p: SplitProductInput): boolean {
  let direct = 0;
  let revenue = 0;
  let qty = 0;
  let general = 0;
  let tax = 0;
  let manual = 0;
  let cogs = 0;
  let cogsNull = 0;
  for (const k of SPLIT_PARTS) {
    const t = split.parts[k];
    direct += t.directKopecks;
    revenue += t.revenueKopecks;
    qty += t.quantity;
    general += t.generalKopecks;
    tax += t.taxKopecks;
    manual += t.manualKopecks;
    if (t.cogsKopecks === null) cogsNull++;
    else cogs += t.cogsKopecks;
  }
  if (cogsNull !== 0 && cogsNull !== SPLIT_PARTS.length) return false;
  if (cogsNull === 0 && (p.cogsKopecks === null || cogs !== p.cogsKopecks)) return false;
  let buckets = 0;
  for (const b of ACCRUAL_BUCKETS) buckets += split.unsplitBuckets[b];
  return (
    direct === p.directKopecks &&
    revenue === p.revenueBaseKopecks &&
    qty === p.netQuantity &&
    general === p.allocatedGeneralKopecks &&
    tax === p.allocatedTaxKopecks &&
    manual === p.allocatedManualKopecks &&
    buckets === split.parts.unsplit.directKopecks &&
    split.unsplitPositiveKopecks >= 0 &&
    split.unsplitNegativeKopecks <= 0 &&
    split.unsplitPositiveKopecks + split.unsplitNegativeKopecks === split.parts.unsplit.directKopecks
  );
}
