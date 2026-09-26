// ============================================================================
// Чистая функция расчёта «Чистая прибыль по товарам» — вынесена из
// OzonProductBreakdown.tsx, чтобы:
//   (а) React-компонент и локальные проверочные тесты вызывали ОДНУ И ТУ ЖЕ
//       функцию (никаких копий формулы);
//   (б) логика была тестируемой без рендера React/загрузки каталога.
//
// Формулы — см. заголовочный комментарий OzonProductBreakdown.tsx.
// ============================================================================

import type { OzonProductRow } from "./report-parsers/ozon-parser";

/** Минимально необходимые поля каталога для расчёта (подмножество Product). */
export interface CatalogEntry {
  sku: string | null;
  name: string;
  cost_price: number;
}

export interface ProductBreakdownRow {
  article: string;
  name: string;
  /** Чистая выручка (revenue − returnsAmount). ЕДИНСТВЕННОЕ определение
   *  выручки здесь. */
  revenue: number;
  /** Сумма возвратов артикула (₽) — уже вычтена из revenue, для отображения. */
  returnsAmount: number;
  /**
   * Выплаты по механикам лояльности этого артикула (G − K, агрегировано по
   * повторным строкам). Учтены в profit НАПРЯМУЮ (не пропорционально), когда
   * opts.loyaltyPayoutPerSkuKnown=true; иначе 0 здесь (доля из
   * loyaltyPayoutsTotal учтена в profit пропорционально, а не в этом поле —
   * см. computeProductBreakdownRows).
   */
  loyaltyPayout: number;
  quantity: number;
  matched: boolean;
  unitCost: number | null;
  cogs: number | null;
  profit: number | null;
  margin: number | null;
  hasCost: boolean;
}

export interface ProductBreakdownOpts {
  /** УПД целиком + налог + прочие ручные расходы — распределяются по SKU. */
  distributableExpenses?: number;
  /**
   * Выплаты от партнёров (после возвратов), основной итог. Используется
   * ТОЛЬКО как fallback — распределяется по SKU пропорционально net-выручке,
   * когда loyaltyPayoutPerSkuKnown=false (реальные per-SKU G−K недоступны,
   * репорт другого формата / группировка колонок не распознана).
   */
  loyaltyPayoutsTotal?: number;
  /**
   * true — products[].loyaltyPayout (G−K) достоверен для каждой строки
   * (report.loyaltyPayoutPerSkuKnown из ozon-parser.ts) — тогда выплаты по
   * SKU берутся НАПРЯМУЮ (Σ известных G−K), не пропорционально: известное
   * значение точнее распределения по доле выручки и не искажает прибыль
   * конкретного товара. false/undefined — используется fallback
   * loyaltyPayoutsTotal, распределённый пропорционально (как раньше).
   */
  loyaltyPayoutPerSkuKnown?: boolean;
  /** Корректировка графика выплат Ozon (знак сохраняется) — распределяется по SKU. */
  payoutAdjustmentTotal?: number;
  /**
   * false — снапшот восстановлен из БД БЕЗ подтверждённых returnsAmount/
   * loyaltyPayout по строкам (старый формат, до этого поля). unitCost/cogs
   * остаются достоверными (себестоимость не зависит от возвратов/лояльности),
   * но profit/margin форсируются в null для ВСЕХ строк — «чистая прибыль» и
   * рейтинги (которые из неё выводятся) не должны показываться как
   * достоверные на неполных данных. undefined/true — данные полные (все
   * свежие расчёты; восстановленные новые снапшоты).
   */
  productDetailComplete?: boolean;
}

/** Нормализация артикула/sku для матчинга: trim + lower + схлопывание пробелов. */
export function normArticleKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Прибыль товара известна: себестоимость есть и прибыль посчитана (неизвестная ≠ 0). */
export function isKnownProfit(r: { profit: number | null; hasCost: boolean }): boolean {
  return r.hasCost && r.profit !== null && Number.isFinite(r.profit);
}

export type ProfitableEmptyKind = "no_products" | "all_unknown" | "known_none_positive" | "none_positive";

export interface ProfitableEmptyState {
  kind: ProfitableEmptyKind;
  /** Главная фраза пустого состояния. */
  text: string;
  /** Уточнение (сколько товаров без рассчитанной прибыли); null — не нужно. */
  detail: string | null;
  unknownCount: number;
}

const tovar = (n: number): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "товар";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "товара";
  return "товаров";
};

/**
 * Пустое состояние «Самых прибыльных» и «лучшего товара» — по ВСЕМ исходным товарам,
 * до отбора. null — прибыльные есть. Неизвестная прибыль не считается нулём:
 *   нет товаров → «Нет данных о товарах»; прибыль неизвестна у всех → «Прибыль товаров
 *   пока не рассчитана»; часть неизвестна, среди известных прибыльных нет → «Среди
 *   товаров с известной прибылью прибыльных не найдено» + число без прибыли; все
 *   известны и ни одна не > 0 → «Прибыльных товаров нет».
 */
export function profitableEmptyState(
  rows: readonly { profit: number | null; hasCost: boolean }[]
): ProfitableEmptyState | null {
  if (rows.length === 0) return { kind: "no_products", text: "Нет данных о товарах", detail: null, unknownCount: 0 };
  const known = rows.filter(isKnownProfit);
  if (known.some((r) => (r.profit as number) > 0)) return null;
  const unknownCount = rows.length - known.length;
  if (known.length === 0) {
    return { kind: "all_unknown", text: "Прибыль товаров пока не рассчитана", detail: null, unknownCount };
  }
  if (unknownCount > 0) {
    return {
      kind: "known_none_positive",
      text: "Среди товаров с известной прибылью прибыльных не найдено",
      detail: `Без рассчитанной прибыли: ${unknownCount} ${tovar(unknownCount)}`,
      unknownCount,
    };
  }
  return { kind: "none_positive", text: "Прибыльных товаров нет", detail: null, unknownCount: 0 };
}

/** Размер списка «Самые прибыльные товары». */
export const TOP_PROFITABLE_LIMIT = 10;

/**
 * «Самые прибыльные товары» и «лучший товар» — одно правило для экрана, PDF и
 * рекомендаций. Показатель — полная чистая прибыль товара (`profit`), та же, что в
 * колонке «Чистая прибыль». Сначала отбор: себестоимость известна и прибыль
 * известна и строго > 0 (нулевая, отрицательная и неизвестная не попадают), затем
 * сортировка по убыванию прибыли (при равенстве — по артикулу), затем ограничение.
 * Пустой результат — «прибыльных товаров нет», без подстановки убыточных.
 */
export function pickProfitableRows<T extends { article: string; profit: number | null; hasCost: boolean }>(
  rows: readonly T[],
  limit: number = TOP_PROFITABLE_LIMIT
): T[] {
  return rows
    .filter((r) => isKnownProfit(r) && (r.profit as number) > 0)
    .sort(
      (a, b) =>
        (b.profit as number) - (a.profit as number) ||
        (a.article < b.article ? -1 : a.article > b.article ? 1 : 0)
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Считает per-SKU разбивку чистой прибыли. Единственная реализация формулы —
 * и React-компонент, и локальные тесты вызывают ИМЕННО эту функцию.
 */
export function computeProductBreakdownRows(
  products: OzonProductRow[],
  catalog: CatalogEntry[],
  opts: ProductBreakdownOpts = {}
): ProductBreakdownRow[] {
  const bySku = new Map<string, CatalogEntry>();
  for (const p of catalog) {
    const key = normArticleKey(p.sku);
    if (key && !bySku.has(key)) bySku.set(key, p);
  }

  // Агрегируем строки отчёта по артикулу: выручка (до возвратов), ВОЗВРАТЫ
  // (сумма) и количество. Строка «только возврат» (revenue=0,
  // returnsAmount>0, quantity=0) НЕ отбрасывается — попадает в тот же агрегат.
  const agg = new Map<
    string,
    {
      article: string;
      name: string;
      grossRevenue: number;
      returnsAmount: number;
      quantity: number;
      loyaltyPayout: number;
    }
  >();
  for (const pr of products) {
    const key = normArticleKey(pr.article);
    if (!key) continue;
    const ex = agg.get(key);
    if (ex) {
      ex.grossRevenue += pr.revenue;
      ex.returnsAmount += pr.returnsAmount;
      ex.quantity += pr.quantity;
      ex.loyaltyPayout += pr.loyaltyPayout;
      if (!ex.name && pr.name) ex.name = pr.name;
    } else {
      agg.set(key, {
        article: pr.article.trim(),
        name: pr.name.trim(),
        grossRevenue: pr.revenue,
        returnsAmount: pr.returnsAmount,
        quantity: pr.quantity,
        loyaltyPayout: pr.loyaltyPayout,
      });
    }
  }

  // Знаменатель для пропорционального распределения — сумма ТЕХ ЖЕ
  // net-значений (самосогласовано).
  let totalNetRevenue = 0;
  for (const a of agg.values()) totalNetRevenue += a.grossRevenue - a.returnsAmount;

  const expensesTotal = opts.distributableExpenses ?? 0;
  const loyaltyTotal = opts.loyaltyPayoutsTotal ?? 0;
  const payoutAdjTotal = opts.payoutAdjustmentTotal ?? 0;
  // Известные per-SKU G−K точнее распределения по доле выручки — используем
  // их напрямую, а НЕ пропорционально, когда они достоверны (см. doc-comment
  // ProductBreakdownOpts.loyaltyPayoutPerSkuKnown). Иначе — старый fallback.
  const loyaltyKnown = opts.loyaltyPayoutPerSkuKnown === true;
  // false ТОЛЬКО для снапшотов старого формата (см. doc-comment
  // productDetailComplete) — profit/margin форсируются в null ниже.
  const detailComplete = opts.productDetailComplete !== false;

  const out: ProductBreakdownRow[] = [];
  for (const [key, a] of agg) {
    const netRevenue = a.grossRevenue - a.returnsAmount;
    const share = totalNetRevenue !== 0 ? netRevenue / totalNetRevenue : 0;
    const allocatedExpenses = expensesTotal * share;
    const loyaltyForRow = loyaltyKnown ? a.loyaltyPayout : loyaltyTotal * share;
    const allocatedPayoutAdj = payoutAdjTotal * share;

    const match = bySku.get(key);
    const unitCost = match ? match.cost_price : null;
    const hasCost = unitCost !== null && unitCost > 0;

    if (match && hasCost) {
      // cogs НЕ зависит от возвратов/лояльности — достоверна даже при
      // detailComplete=false (себестоимость = unitCost × проданных единиц).
      const cogs = unitCost * a.quantity;
      const profit = detailComplete
        ? netRevenue + loyaltyForRow - cogs - allocatedExpenses + allocatedPayoutAdj
        : null;
      // Маржа не определена при нулевой/отрицательной выручке (возвраты
      // превысили продажи) — null, а НЕ 0%, иначе выглядит как «маржа
      // ровно ноль» вместо «не считается». profit НЕ меняется.
      const margin = !detailComplete
        ? null
        : netRevenue > 0
          ? (profit! / netRevenue) * 100
          : null;
      out.push({
        article: a.article,
        name: a.name || match.name || a.article,
        revenue: netRevenue,
        returnsAmount: a.returnsAmount,
        loyaltyPayout: loyaltyForRow,
        quantity: a.quantity,
        matched: true,
        unitCost,
        cogs,
        profit,
        margin,
        hasCost: true,
      });
    } else {
      out.push({
        article: a.article,
        name: (match ? a.name || match.name : a.name) || a.article,
        revenue: netRevenue,
        returnsAmount: a.returnsAmount,
        loyaltyPayout: loyaltyForRow,
        quantity: a.quantity,
        matched: !!match,
        unitCost,
        cogs: null,
        profit: null,
        margin: null,
        hasCost: false,
      });
    }
  }

  out.sort((x, y) => y.revenue - x.revenue);
  return out;
}

export interface ProductBreakdownTotals {
  revenue: number;
  returnsAmount: number;
  /** Σ loyaltyPayout по ВСЕМ строкам (не только hasCost) — для сверки с
   *  основным итогом (combinedResult.loyaltyPayouts), см. requirement. */
  loyaltyPayout: number;
  cogs: number;
  profit: number;
  /** false — profit выше НЕ достоверна (восстановленный снапшот старого
   *  формата, см. ProductBreakdownOpts.productDetailComplete) — UI должен
   *  показать «—»/пояснение, а не число, похожее на точное. */
  profitKnown: boolean;
  withCost: number;
  total: number;
  withoutCost: number;
}

/** Итоги по уже посчитанным строкам — та же функция, что использует компонент. */
export function computeProductBreakdownTotals(
  rows: ProductBreakdownRow[]
): ProductBreakdownTotals {
  let revenue = 0;
  let returnsAmount = 0;
  let loyaltyPayout = 0;
  let cogs = 0;
  let profit = 0;
  let withCost = 0;
  let profitKnown = true;
  for (const r of rows) {
    revenue += r.revenue;
    returnsAmount += r.returnsAmount;
    loyaltyPayout += r.loyaltyPayout;
    if (r.hasCost) {
      cogs += r.cogs ?? 0;
      profit += r.profit ?? 0;
      withCost++;
      if (r.profit === null) profitKnown = false;
    }
  }
  return {
    revenue,
    returnsAmount,
    loyaltyPayout,
    cogs,
    profit,
    profitKnown,
    withCost,
    total: rows.length,
    withoutCost: rows.length - withCost,
  };
}
