// ============================================================================
// Общие типы расчёта по XLSX «Отчёт по начислениям» (PR-1: только чистые
// модули, без UI/сохранения/consume/истории).
// Все суммы — ЦЕЛЫЕ КОПЕЙКИ (см. money.ts).
// ============================================================================

/**
 * Отображаемые корзины. Каждая строка отчёта попадает РОВНО в одну; Σ корзин
 * === netOzonOperations. Корзины нужны для разбивки/аналитики и в формулу
 * прибыли повторно НЕ входят (итог — одна сумма netOzonOperations).
 */
export const ACCRUAL_BUCKETS = [
  "salesRevenue",
  "returnsRevenue",
  "partnerPrograms",
  "discountPoints",
  "commission",
  "logistics",
  "advertising",
  "compensations",
  "other",
] as const;

export type AccrualBucket = (typeof ACCRUAL_BUCKETS)[number];

/** Суммы по корзинам, копейки (со знаком). */
export type AccrualBucketSums = Record<AccrualBucket, number>;

/** Одна строка отчёта после разбора (детальная строка = одно начисление). */
export interface AccrualRow {
  /** Номер строки листа (1-based) — для безопасных сообщений об ошибках. */
  rowNumber: number;
  /** Дата начисления, YYYY-MM-DD. */
  date: string;
  group: string;
  type: string;
  bucket: AccrualBucket;
  /** false — пара (группа, тип) не из справочника → корзина other + warning. */
  knownTaxonomy: boolean;
  /** «Артикул» (trim; "" — строка без товара). */
  article: string;
  /** «SKU» Ozon ("" если нет). */
  sku: string;
  /** «Название товара» ("" если нет). Только для отображения. */
  name: string;
  /**
   * «Количество» как в файле (null — пусто/не число). Достоверно ТОЛЬКО для
   * строк salesRevenue/returnsRevenue (там валидируется); на строках услуг
   * поле повторяет количество строки продажи и в расчёте НЕ участвует.
   */
  quantity: number | null;
  /** «Сумма итого, руб.» в копейках, со знаком. */
  amountKopecks: number;
  /**
   * «ID начисления» как в файле (trim; "" — пусто; undefined — колонки нет). НЕ
   * уникальный ID строки и НЕ обязательно номер отправления: в реальных отчётах это
   * номер отправления у товарных операций, номер заказа у эквайринга и иные ID у
   * рекламы/размещения. Используется только как ссылка для связи операций (вместе с
   * артикулом) при разделении результата товара; в снимок не сохраняется.
   */
  ref?: string;
}

export interface UnknownTaxonomyEntry {
  /** Значения колонок «Группа услуг»/«Тип начисления» (не товарные данные). */
  group: string;
  type: string;
  rows: number;
  amountKopecks: number;
}

export interface AccrualSummary {
  rowCount: number;
  /** Σ signed «Сумма итого, руб.» по ВСЕМ строкам — ровно один раз. */
  netOzonOperationsKopecks: number;
  buckets: AccrualBucketSums;
  /** Σ корзин; ОБЯЗАНА равняться netOzonOperationsKopecks. */
  bucketsSumKopecks: number;
  /** Штуки: продано (Σ «Количество» строк «Выручка»), возвращено (Σ |·| строк «Возврат выручки»). */
  quantities: { sold: number; returned: number; net: number };
  saleRows: number;
  returnRows: number;
  /** Уникальных нормализованных артикулов. */
  productCount: number;
  /** Строки без артикула (общие начисления) — количество и сумма. */
  rowsWithoutArticle: number;
  amountWithoutArticleKopecks: number;
  /** Строки продажи/возврата без артикула — себестоимость по ним не считается. */
  saleReturnRowsWithoutArticle: number;
  /** Пары (группа, тип), которых нет в справочнике (до 50 записей; суммы уже в other). */
  unknownTaxonomy: UnknownTaxonomyEntry[];
  /** Всего строк/копеек по неизвестным парам (не урезается лимитом списка). */
  unknownTaxonomyRows: number;
  unknownTaxonomyAmountKopecks: number;
}
