// ============================================================================
// Классификатор начислений «Отчёта по начислениям» → отображаемые корзины.
//
// Справочник построен по РЕАЛЬНОМУ июньскому файлу 2026 (26 пар «Группа услуг» /
// «Тип начисления»); имена реклам/компенсаций совпадают с уже подтверждёнными
// в API-режиме (accrual.ts: ADS_TYPE_NAMES/ADJUSTMENT_TYPE_NAMES). Неизвестная
// пара НЕ теряется: идёт в корзину other, попадает в unknownTaxonomy (только
// названия группы/типа — без товарных данных) и сумма остаётся в итоге.
//
// ЕДИНСТВЕННОЕ место, где строка отображаемой корзины определяется, — функция
// classifyAccrual. Корзины — только отображение: в формулу прибыли они
// повторно не входят (см. profit-calc.ts).
// ============================================================================

import {
  ACCRUAL_BUCKETS,
  type AccrualBucket,
  type AccrualBucketSums,
  type AccrualRow,
  type AccrualSummary,
  type UnknownTaxonomyEntry,
} from "./types";
import { normArticleKey } from "../product-breakdown-calc";

/** Нормализация подписей: NFKC, ё→е, регистр, схлопывание пробелов/nbsp, trim. */
export function normalizeTaxonomyKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

const PAIR_SEP = "\u0000";

function pairKey(group: string, type: string): string {
  return `${normalizeTaxonomyKey(group)}${PAIR_SEP}${normalizeTaxonomyKey(type)}`;
}

/** [корзина, группа, типы...] по данным июньского файла 2026. */
const KNOWN_PAIRS: ReadonlyArray<readonly [AccrualBucket, string, readonly string[]]> = [
  ["salesRevenue", "Продажи", ["Выручка"]],
  ["returnsRevenue", "Возвраты", ["Возврат выручки"]],
  ["partnerPrograms", "Продажи", ["Программы партнёров"]],
  ["partnerPrograms", "Возвраты", ["Программы партнёров"]],
  ["discountPoints", "Продажи", ["Баллы за скидки"]],
  ["discountPoints", "Возвраты", ["Баллы за скидки"]],
  ["commission", "Вознаграждение Ozon", ["Вознаграждение за продажу", "Возврат вознаграждения"]],
  [
    "logistics",
    "Услуги доставки",
    [
      "Обработка отправления Drop-off (ПВЗ)",
      "Логистика",
      "Обратная логистика",
      "Доставка до места выдачи силами Ozon",
    ],
  ],
  [
    "logistics",
    "Услуги партнёров",
    [
      "Обработка отправления Drop-off партнёрами (ПВЗ)",
      "Доставка до места выдачи",
      "Обработка возвратов, отмен и невыкупов партнёрами",
    ],
  ],
  [
    "advertising",
    "Продвижение и реклама",
    ["Продвижение с оплатой за заказ", "Ускоренный сбор отзывов", "Оплата за клик"],
  ],
  [
    "compensations",
    "Компенсации и декомпенсации",
    ["Начисление по спору", "Потеря по вине Ozon в логистике"],
  ],
  // Известные, но отдельной корзины не имеющие начисления → other (known:true,
  // без warning). Это сборы, штрафы, эквайринг, размещение, упаковка Ozon.
  [
    "other",
    "Другие услуги и штрафы",
    ["Отгрузка в нерекомендованный слот", "Обеспечение материалами для упаковки товара"],
  ],
  ["other", "Прочие начисления", ["Корректировка стоимости услуг"]],
  [
    "other",
    "Услуги партнёров",
    ["Эквайринг", "Временное размещение товара партнерами", "Упаковка товара партнёрами"],
  ],
];

const PAIR_TO_BUCKET: ReadonlyMap<string, AccrualBucket> = (() => {
  const m = new Map<string, AccrualBucket>();
  for (const [bucket, group, types] of KNOWN_PAIRS) {
    for (const t of types) m.set(pairKey(group, t), bucket);
  }
  return m;
})();

/** Ровно одна корзина для пары (группа, тип). Неизвестная пара → other, known:false. */
export function classifyAccrual(
  group: string,
  type: string
): { bucket: AccrualBucket; known: boolean } {
  const b = PAIR_TO_BUCKET.get(pairKey(group, type));
  return b ? { bucket: b, known: true } : { bucket: "other", known: false };
}

export function emptyBucketSums(): AccrualBucketSums {
  const o = {} as AccrualBucketSums;
  for (const k of ACCRUAL_BUCKETS) o[k] = 0;
  return o;
}

/** Лимит записей в списке неизвестной таксономии (защита размера ответа). */
const UNKNOWN_TAXONOMY_LIMIT = 50;
const LABEL_MAX = 80;

function safeLabel(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t === "") return "(пусто)";
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX)}…` : t;
}

/**
 * Итоги по строкам: netOzonOperations (Σ всех сумм ровно один раз), суммы
 * корзин, штуки продано/возвращено, строки без артикула, неизвестная
 * таксономия. Чистая функция; вызывается и парсером, и расчётным ядром (ядро
 * пересчитывает итоги из строк само, не доверяя чужим агрегатам).
 */
export function summarizeAccrualRows(rows: readonly AccrualRow[]): AccrualSummary {
  const buckets = emptyBucketSums();
  let net = 0;
  let sold = 0;
  let returned = 0;
  let saleRows = 0;
  let returnRows = 0;
  let noArticleRows = 0;
  let noArticleAmount = 0;
  let saleReturnNoArticle = 0;
  const products = new Set<string>();
  const unknown = new Map<string, UnknownTaxonomyEntry>();
  let unknownRows = 0;
  let unknownAmount = 0;

  for (const r of rows) {
    net += r.amountKopecks;
    buckets[r.bucket] += r.amountKopecks;

    const key = normArticleKey(r.article);
    if (key) products.add(key);
    else {
      noArticleRows++;
      noArticleAmount += r.amountKopecks;
    }

    if (r.bucket === "salesRevenue") {
      saleRows++;
      sold += r.quantity ?? 0;
      if (!key) saleReturnNoArticle++;
    } else if (r.bucket === "returnsRevenue") {
      returnRows++;
      returned += Math.abs(r.quantity ?? 0);
      if (!key) saleReturnNoArticle++;
    }

    if (!r.knownTaxonomy) {
      unknownRows++;
      unknownAmount += r.amountKopecks;
      const k = pairKey(r.group, r.type);
      const ex = unknown.get(k);
      if (ex) {
        ex.rows++;
        ex.amountKopecks += r.amountKopecks;
      } else if (unknown.size < UNKNOWN_TAXONOMY_LIMIT) {
        unknown.set(k, {
          group: safeLabel(r.group),
          type: safeLabel(r.type),
          rows: 1,
          amountKopecks: r.amountKopecks,
        });
      }
    }
  }

  let bucketsSum = 0;
  for (const k of ACCRUAL_BUCKETS) bucketsSum += buckets[k];

  return {
    rowCount: rows.length,
    netOzonOperationsKopecks: net,
    buckets,
    bucketsSumKopecks: bucketsSum,
    quantities: { sold, returned, net: sold - returned },
    saleRows,
    returnRows,
    productCount: products.size,
    rowsWithoutArticle: noArticleRows,
    amountWithoutArticleKopecks: noArticleAmount,
    saleReturnRowsWithoutArticle: saleReturnNoArticle,
    unknownTaxonomy: Array.from(unknown.values()),
    unknownTaxonomyRows: unknownRows,
    unknownTaxonomyAmountKopecks: unknownAmount,
  };
}
