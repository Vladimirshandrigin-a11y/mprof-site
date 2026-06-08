"use client";

/**
 * Парсер месячных XLSX-отчётов Ozon Seller.
 *
 * DEBUG-MODE: эта версия максимально многословна в console.log — каждый шаг
 * парсинга логируется с префиксом `[ozon-parser]`. Также возвращается
 * `debugInfo` в `ParseResult` — UI отрисует его в DEV MODE при ошибке.
 *
 * Pipeline поиска header (scoring-based, без strict-фильтра):
 *  1. Сканируем первые 80 строк выбранного листа.
 *  2. На каждой строке запускаем regex-матчинг колонок.
 *  3. Для каждой строки с >= 1 матчем считаем score:
 *       matchedCount * 10
 *       + nonEmptyCells
 *       + stringCells * 2
 *       - numericPenalty   (если чисел больше, чем текста)
 *       + specialWordsBoost (артикул / sku / наименование / …)
 *       + dataRowsFollowBoost (+20 если следом идут data rows)
 *  4. Best = max(score) при условии matchedCount >= 2.
 *  5. Confidence:
 *       high   — matchedCount >= 4 AND hasDataRowsAfter AND specialWordsBoost > 0
 *       medium — matchedCount >= 3 OR (matchedCount >= 2 AND hasDataRowsAfter)
 *       low    — иначе
 */

import * as XLSX from "xlsx";

const LOG = "[ozon-parser]";

// ============================================================================
// Public types
// ============================================================================

export interface OzonParsedTotals {
  revenue: number;
  quantity: number;
  returns: number;
  loyaltyPayouts: number;
  avgPrice: number;
  netRevenue: number;
  /**
   * Revenue извлечённый напрямую из итоговой строки «Итого реализовано
   * (за вычетом возвратов)». Это AUTHORITATIVE source для нового 3-file flow —
   * предпочитайте его, а не sum по product-rows.
   */
  revenueFromTotalsRow: number | null;
  /** Аналогично — из строки «Всего выплат от партнёров». */
  loyaltyPayoutsFromTotalsRow: number | null;
}

export interface TotalsRowCandidate {
  rowIdx: number;
  /** Текст label (может быть PUA-encoded). */
  labelText: string;
  labelColIdx: number;
  value: number;
  valueColIdx: number;
}

export interface OzonEstimate {
  revenue: number;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  tax: number;
  cost: number;
  other: number;
}

/**
 * Per-SKU строка из тела отчёта — для матчинга с каталогом товаров.
 * article — артикул продавца (offer_id), ключ для поиска по products.sku.
 */
export interface OzonProductRow {
  article: string;
  name: string;
  revenue: number;
  quantity: number;
}

export interface OzonParsedReport {
  marketplace: "ozon";
  detected: true;
  period: string | null;
  rowsCount: number;
  totals: OzonParsedTotals;
  estimate: OzonEstimate;
  /**
   * Per-SKU строки (артикул / наименование / выручка / кол-во) для подстановки
   * себестоимости из каталога. Best-effort: заполняется ТОЛЬКО когда колонки
   * артикула/наименования удалось распознать в шапке отчёта (clean-header
   * формат). Для PUA-mangled realization-формата с нечитаемыми заголовками
   * остаётся пустым — UI в этом случае показывает только агрегаты, не подставляя
   * сомнительные данные. НЕ влияет на totals/estimate — это отдельный слой.
   */
  products: OzonProductRow[];
}

export type HeaderConfidence = "low" | "medium" | "high";

export interface HeaderScoreBreakdown {
  matchedColumnsBonus: number;
  nonEmptyCellsBonus: number;
  stringCellsBonus: number;
  /** Отрицательное число (или 0) — штраф за переизбыток чисел/дат. */
  numericPenalty: number;
  specialWordsBoost: number;
  dataRowsFollowBoost: number;
  total: number;
}

export interface HeaderCandidateDebug {
  rowIdx: number;
  score: number;
  matchedCount: number;
  matchedFields: string[];
  rowPreview: unknown[];
  nonEmptyCells: number;
  stringCells: number;
  numericCells: number;
  hasDataRowsAfter: boolean;
  confidence: HeaderConfidence;
  scoreBreakdown: HeaderScoreBreakdown;
}

export interface ParsedRowSample {
  rowIdx: number;
  /** Полная raw-строка из листа (для DEV-диагностики). */
  rawRow: unknown[];
  qtyRaw: unknown;
  qty: number;
  priceRaw: unknown;
  price: number;
  revenueRaw: unknown;
  revenue: number;
  commissionRaw: unknown;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  tax: number;
  returns: number;
  loyalty: number;
  revenueSource: "column" | "qty*price" | "none";
}

export interface AggregationSkipReasons {
  /** Строка полностью пустая. */
  empty: number;
  /** Строка распознана как итоговая («Итого / Total / Всего»). */
  total: number;
  /** В строке найдены только нули — нет ни одного значимого значения. */
  noMeaningfulValue: number;
}

export interface OzonDebugInfo {
  fileName: string;
  fileSize: number;
  sheetNames: string[];
  selectedSheetName: string | null;
  selectedSheetRowCount: number;
  ozonDetected: boolean;
  ozonDetectionReason: string | null;
  /** Первые 60 строк выбранного листа — для визуальной диагностики. */
  firstRows: unknown[][];
  /** Сколько строк мы просканировали в поисках header (cap 80). */
  scannedRowsCount: number;
  /** Все кандидаты на header-row с регекс-матчами (без strict-фильтра). */
  headerCandidates: HeaderCandidateDebug[];
  /** Топ-5 кандидатов по score (для быстрого скана взглядом). */
  topHeaderCandidates: HeaderCandidateDebug[];
  selectedHeaderRowIdx: number;
  selectedHeaderRow: unknown[] | null;
  selectedHeaderScore: number | null;
  selectedHeaderConfidence: HeaderConfidence | null;
  matchedColumns: Record<string, number>;

  // ===== Aggregation phase =====
  /** Всего строк ниже header (до конца листа). */
  rowsAfterHeader: number;
  /** Сколько строк успешно распознано как data row. */
  rowsParsed: number;
  /** Сколько строк пропущено и почему. */
  skipReasons: AggregationSkipReasons;
  /** Первые 5 распознанных data rows с распарсенными числами. */
  firstParsedRows: ParsedRowSample[];
  /** Предупреждения по агрегации (нулевые суммы, fallback'и и т.д.). */
  aggregationWarnings: string[];
  /** Финальные totals (после агрегации). */
  finalTotals: OzonParsedTotals | null;
  /** Финальный estimate (то, что уходит в форму). */
  finalEstimate: OzonEstimate | null;
  /** Все «label + number» строки после header — кандидаты на итоговые строки. */
  totalsRowCandidates: TotalsRowCandidate[];
  /** Какой rowIdx был распознан как «Итого реализовано» (или null). */
  matchedRevenueTotalRowIdx: number | null;
  /** Какой rowIdx был распознан как «Всего выплат от партнёров» (или null). */
  matchedLoyaltyTotalRowIdx: number | null;
  /**
   * Полные детали best-match для revenue total (text-поиск со scoring).
   * null если text-search не нашёл — тогда сработал numeric fallback.
   */
  matchedRevenueTotalDetails: TotalMatch | null;
  /** Полные детали best-match для loyaltyPayouts total. */
  matchedLoyaltyTotalDetails: TotalMatch | null;

  /** @deprecated — оставлено для обратной совместимости, синоним rowsParsed. */
  productRowCount: number;
  /** Если парсер сошёл с дистанции — здесь причина. */
  failedAt: string | null;
}

export interface ParseResult {
  ok: boolean;
  report: OzonParsedReport | null;
  error: string | null;
  debugInfo: OzonDebugInfo;
}

// ============================================================================
// Header patterns
// ============================================================================

type FieldKey =
  | "qty"
  | "price"
  | "revenue"
  | "returns"
  | "loyalty"
  | "commission"
  | "logistics"
  | "storage"
  | "ads"
  | "tax";

const HEADER_PATTERNS: Record<FieldKey, RegExp[]> = {
  qty: [
    /кол[\s.\-_]*?во/i,
    /колич/i,
    /\bquantity\b/i,
    /\bqty\b/i,
    /шт\./i,
    /\bкол-во/i,
  ],
  price: [
    /цена\s*реализ/i,
    /цена\s*продаж/i,
    /цена\s*за\s*единиц/i,
    /цена\s*товар/i,
    /\bprice\b/i,
  ],
  revenue: [
    // «Реализовано на сумму, руб.» — ИТОГ по строке (выручка). Это ОТДЕЛЬНАЯ
    // колонка от «Цена реализации» (unit price → price). Стоит левее в шапке
    // Ozon realization, поэтому забирает revenue-слот (matcher берёт левейшую
    // подходящую колонку). Без неё /реализаци/ ошибочно ловил «Цена реализации»
    // и выручка считалась по цене за единицу (занижение для qty>1).
    /реализован.{0,12}сумм/i,
    /сумма\s*реализ/i,
    /стоимость\s*реализ/i,
    /сумма\s*продаж/i,
    /^выруч/i,
    /выруч/i,
    /к\s*перечислению/i,
    /итого\s*к\s*начислен/i,
    /итог\s*к\s*начислен/i,
    /^начислено/i,
    /сумма\s*начислен/i,
    /реализаци/i,
    /продаж/i,
    /\brevenue\b/i,
  ],
  returns: [/возврат/i, /\breturn/i],
  loyalty: [/баллы/i, /лояльност/i, /бонус/i],
  commission: [
    /комисси/i,
    /вознагражден/i,
    /услуги\s*ozon/i,
    /услуги\s*озон/i,
    /\bcommission\b/i,
  ],
  logistics: [
    /логистик/i,
    /доставк/i,
    /последн.{0,3}мил/i,
    /магистрал/i,
    /обработк.*отправлен/i,
    /\blogistic/i,
    /\bdelivery\b/i,
  ],
  storage: [/хранен/i, /\bstorage\b/i, /\bwarehouse\b/i],
  ads: [
    /реклам/i,
    /продвижен/i,
    /трафарет/i,
    /\bads?\b/i,
    /\bmarketing\b/i,
  ],
  tax: [/налог/i, /\btax\b/i, /\bндс\b/i],
};

const TOTAL_ROW_PATTERNS = [/^итог/i, /^total$/i, /^всего/i];

/**
 * Паттерны для колонок per-SKU слоя (артикул / наименование). НЕ входят в
 * HEADER_PATTERNS / FieldKey — это отдельный, изолированный матчинг,
 * чтобы не возмущать настроенный scorer выбора header-row. Используется
 * только для подстановки себестоимости из каталога.
 */
const ARTICLE_HEADER_PATTERNS: RegExp[] = [
  /артикул/i,
  /\bsku\b/i,
  /offer[\s._-]*id/i,
  /\barticle\b/i,
];
const NAME_HEADER_PATTERNS: RegExp[] = [
  /наименован/i,
  /название\s*товар/i,
  /^название$/i,
  /^товар$/i,
  /^наименование$/i,
  /product\s*name/i,
];

/**
 * Найти индексы колонок «Артикул» и «Наименование».
 *
 * Ozon realization-отчёт имеет ДВУХ-СТРОЧНУЮ шапку: текстовые ярлыки
 * («Артикул», «Название товара», «SKU», «Штрих-код») лежат на 1–3 строки ВЫШЕ
 * числовой под-шапки («Кол-во», «Цена реализации»), которую scorer выбирает как
 * header-row. Поэтому ярлыки ищем в ОКНЕ строк [headerRowIdx-3 .. headerRowIdx],
 * выравнивая по индексу колонки. Скан изолирован от scorer'а header-row и на
 * агрегаты/итоги НЕ влияет.
 *
 * Возвращает null для колонки, если ярлык не найден (например, PUA-mangled
 * realization-fallback) — тогда per-SKU слой пуст и UI показывает только агрегаты.
 */
function detectArticleNameCols(
  rows: unknown[][],
  headerRowIdx: number
): { articleCol: number | null; nameCol: number | null } {
  let articleCol: number | null = null;
  let nameCol: number | null = null;
  if (!Array.isArray(rows) || headerRowIdx < 0) {
    return { articleCol, nameCol };
  }
  const startIdx = Math.max(0, headerRowIdx - 3);
  let width = 0;
  for (let r = startIdx; r <= headerRowIdx && r < rows.length; r++) {
    const row = rows[r];
    if (Array.isArray(row) && row.length > width) width = row.length;
  }
  // Слева-направо по колонкам: при двух кандидатах («Артикул» в col2 и «SKU» в
  // col3) выигрывает левый — это и есть колонка «Артикул», как в UI-таблице.
  for (let col = 0; col < width; col++) {
    for (let r = headerRowIdx; r >= startIdx; r--) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      const text = asCellString(row[col]).toLowerCase().trim();
      if (!text) continue;
      if (articleCol === null && ARTICLE_HEADER_PATTERNS.some((p) => p.test(text))) {
        articleCol = col;
      }
      if (nameCol === null && NAME_HEADER_PATTERNS.some((p) => p.test(text))) {
        nameCol = col;
      }
    }
  }
  return { articleCol, nameCol };
}

/**
 * Строка-легенда нумерации колонок Ozon («1 2 3 4 …»), которую Ozon вставляет
 * между двух-строчной шапкой и данными. Это не товар — исключаем из per-SKU слоя.
 * На агрегаты/итоги НЕ влияет (та логика нетронута, строку считает как и раньше).
 */
function isColumnNumberLegendRow(row: unknown[]): boolean {
  if (!Array.isArray(row)) return false;
  const nums: number[] = [];
  for (const cell of row) {
    const t = asCellString(cell).trim();
    if (t === "") continue;
    if (!/^\d{1,3}$/.test(t)) return false;
    nums.push(Number(t));
  }
  if (nums.length < 3) return false;
  for (let k = 1; k < nums.length; k++) {
    if (nums[k] <= nums[k - 1]) return false;
  }
  return true;
}

/**
 * Boost-слова — почти гарантированно встречаются в шапке таблицы Ozon.
 * +5 к score за каждое (макс 1 буст на ячейку).
 */
const BOOST_WORDS: RegExp[] = [
  /артикул/i,
  /\bsku\b/i,
  /наименован/i,
  /^сумма\b/i,
  /реализац/i,
  /количеств/i,
  /\bкол-во\b/i,
  /товар/i,
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Преобразование значения ячейки в число с учётом локалей.
 *
 * Поддерживаемые форматы (см. self-tests ниже):
 *   "54 856,21"   → 54856.21   (русский: пробел = thousands, запятая = decimal)
 *   "54856,21"    → 54856.21
 *   "54856.21"    → 54856.21
 *   "1 234,56"    → 1234.56
 *   "1 234"       → 1234
 *   "0,00"        → 0
 *   "54 856.21"   → 54856.21   (смешанный: пробел thousands, точка decimal)
 *   "1,234.56"    → 1234.56    (US: запятая thousands, точка decimal)
 *   "1.234,56"    → 1234.56    (DE/EU: точка thousands, запятая decimal)
 *   "(123)"       → -123       (бухгалтерская нотация)
 *
 * Ключевая идея: ПОСЛЕДНИЙ из разделителей `,` / `.` — это десятичный.
 * Все остальные — thousands separators (пробелы тоже).
 * Если разделитель один и после него 1–2 цифры — это decimal.
 * Если разделитель один и после него 3 цифры — thousands.
 */
function asNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "boolean") return 0;
  if (typeof v !== "string") return 0;

  let s = v.trim();
  if (!s) return 0;

  // Бухгалтерская нотация: «(123)» = -123
  let negative = false;
  if (/^\(.+\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Знак спереди
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Выкидываем всё, кроме цифр, точек и запятых.
  // Это автоматически срезает пробелы (включая NBSP), валюты, проценты,
  // буквы — всё лишнее уйдёт.
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let normalized: string;

  if (lastComma === -1 && lastDot === -1) {
    // Нет разделителей — чистое целое
    normalized = s;
  } else if (lastComma >= 0 && lastDot >= 0) {
    // И точка, и запятая. Последний по позиции — десятичный.
    if (lastComma > lastDot) {
      // Запятая — decimal, точки — thousands. «1.234.567,89»
      normalized =
        s.slice(0, lastComma).replace(/[.,]/g, "") + "." + s.slice(lastComma + 1);
    } else {
      // Точка — decimal, запятые — thousands. «1,234,567.89»
      normalized =
        s.slice(0, lastDot).replace(/[.,]/g, "") + "." + s.slice(lastDot + 1);
    }
  } else if (lastComma >= 0) {
    // Только запятые
    const tail = s.length - lastComma - 1;
    if (tail >= 1 && tail <= 2) {
      // 1–2 цифры после последней запятой → decimal (kopecks)
      normalized =
        s.slice(0, lastComma).replace(/,/g, "") + "." + s.slice(lastComma + 1);
    } else {
      // 3+ цифр или 0 цифр после → запятая(ые) как thousands sep
      normalized = s.replace(/,/g, "");
    }
  } else {
    // Только точки
    const tail = s.length - lastDot - 1;
    if (tail >= 1 && tail <= 2) {
      // 1–2 цифры после последней точки → decimal
      normalized =
        s.slice(0, lastDot).replace(/\./g, "") + "." + s.slice(lastDot + 1);
    } else {
      // 3+ или 0 → точка(и) как thousands sep
      normalized = s.replace(/\./g, "");
    }
  }

  if (!normalized || normalized === "." || normalized === "-") return 0;

  const n = parseFloat(normalized);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

// ============================================================================
// Self-tests для asNumber — выполняются один раз в dev-сессии. Если хоть один
// кейс упадёт, console.warn с разбивкой; иначе тихий ✓ лог.
// ============================================================================
let asNumberTestsRan = false;
function runAsNumberTests(): void {
  if (asNumberTestsRan) return;
  asNumberTestsRan = true;

  const NBSP = "\u00A0";
  const cases: ReadonlyArray<readonly [unknown, number]> = [
    // === Базовые кейсы из ТЗ ===
    ["54 856,21", 54856.21],
    ["54856,21", 54856.21],
    ["54856.21", 54856.21],
    ["1 234,56", 1234.56],
    ["1 234", 1234],
    ["0,00", 0],
    // === Дополнительные ===
    ["", 0],
    [null, 0],
    [undefined, 0],
    [0, 0],
    [54856.21, 54856.21],
    ["54 856.21", 54856.21],                  // mixed: space=thousands, dot=decimal
    ["1,234.56", 1234.56],                    // US
    ["1.234,56", 1234.56],                    // DE
    ["1 234 567,89", 1234567.89],             // big number RU
    ["1 234 567,890", 1234567890],            // 3 digits after comma → thousands
    ["1.234.567,89", 1234567.89],             // DE thousands+decimal
    ["54 856,21 ₽", 54856.21],                // с валютой
    [`54${NBSP}856,21`, 54856.21],            // NBSP как thousands
    ["(123,45)", -123.45],                    // accounting parens
    ["-99,99", -99.99],                       // negative
    ["1.234", 1234],                           // 3 digits after dot → thousands
    ["1,234", 1234],                           // 3 digits after comma → thousands
    ["NaN", 0],
    [NaN, 0],
  ];

  type Failure = { input: unknown; expected: number; got: number };
  const failures: Failure[] = [];
  let pass = 0;
  for (const [input, expected] of cases) {
    const got = asNumber(input);
    if (Math.abs(got - expected) < 0.001) {
      pass++;
    } else {
      failures.push({ input, expected, got });
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      LOG,
      `asNumber self-tests: \u2717 ${failures.length} failed / ${pass} passed`,
      failures
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `asNumber self-tests: \u2713 ${pass}/${cases.length} passed`
    );
  }
}

// Запускаем тесты только в dev в браузере — в проде/SSR не шумим.
if (
  typeof window !== "undefined" &&
  process.env.NODE_ENV === "development"
) {
  runAsNumberTests();
}

/**
 * Безопасное приведение к number. Гарантирует:
 *  - null      → 0
 *  - undefined → 0
 *  - ""        → 0
 *  - NaN       → 0
 *  - всё остальное → asNumber()
 */
function safeNumber(v: unknown): number {
  if (v == null) return 0;
  if (v === "") return 0;
  const n = asNumber(v);
  return Number.isFinite(n) ? n : 0;
}

/** Приведение значения ячейки к строке (для матчинга заголовков). */
function asCellString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Проверить, что строка — итоговая / служебная. */
function isTotalRow(row: unknown[]): boolean {
  for (let i = 0; i < Math.min(row.length, 3); i++) {
    const s = asCellString(row[i]).toLowerCase().trim();
    if (!s) continue;
    if (TOTAL_ROW_PATTERNS.some((p) => p.test(s))) return true;
  }
  return false;
}

type CellKind = "empty" | "string" | "numeric" | "date";

/** Классификация одной ячейки для scoring системы. */
function classifyCell(s: string): CellKind {
  if (!s || s.length === 0) return "empty";
  // Дата: 01.04.2026, 2026-04-01, 01/04/26
  if (/^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/.test(s)) return "date";
  // Время: 14:30, 14:30:00
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return "date";
  // Сначала уберём NBSP/обычные пробелы и валюту для проверки на «число»
  const normalized = s
    .replace(/ /g, "")
    .replace(/\s/g, "")
    .replace(/[₽$€%]/g, "")
    .replace(/[₠-⃏]/g, "");
  if (/^-?\(?[\d,.\-]+\)?$/.test(normalized) && /\d/.test(normalized)) {
    return "numeric";
  }
  // Любая непустая ячейка, которая НЕ дата и НЕ число — считается строкой.
  // Раньше требовали /[a-zа-яё]/i → PUA-encoded ячейки (font substitution
  // в Ozon XLSX) попадали в "empty" и не распознавались как label'ы тоталов.
  // Теперь PUA, символы, UTF-8 любого диапазона → "string".
  return "string";
}

/** Похожа ли строка на data row? Условие: >=3 numeric-ячеек. */
function looksLikeDataRow(row: unknown[] | undefined): boolean {
  if (!row || row.length === 0) return false;
  let numericCount = 0;
  for (const cell of row) {
    if (classifyCell(asCellString(cell).trim()) === "numeric") {
      numericCount++;
      if (numericCount >= 3) return true;
    }
  }
  return false;
}

/** Эвристика: похож ли workbook на Ozon-отчёт. */
function detectOzon(workbook: XLSX.WorkBook): {
  detected: boolean;
  reason: string | null;
} {
  const names = workbook.SheetNames.join(" ").toLowerCase();
  if (/ozon|озон/i.test(names)) {
    return { detected: true, reason: `sheet name contains ozon: "${names}"` };
  }
  if (/реестр|финансов|транзакц/i.test(names)) {
    return {
      detected: true,
      reason: `sheet name looks like Ozon report: "${names}"`,
    };
  }

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet || !sheet["!ref"]) continue;
    let range: XLSX.Range;
    try {
      range = XLSX.utils.decode_range(sheet["!ref"]);
    } catch {
      continue;
    }
    const maxR = Math.min(range.s.r + 20, range.e.r);
    const maxC = Math.min(range.s.c + 12, range.e.c);
    for (let r = range.s.r; r <= maxR; r++) {
      for (let c = range.s.c; c <= maxC; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const v = asCellString(cell.v).toLowerCase();
        if (!v) continue;
        if (/ozon|озон/i.test(v)) {
          return {
            detected: true,
            reason: `cell ${XLSX.utils.encode_cell({ r, c })} on "${name}" contains "ozon/озон"`,
          };
        }
      }
    }
  }
  return { detected: false, reason: null };
}

/** Попытка вытащить период отчёта из первых строк. */
function parsePeriod(rows: unknown[][]): string | null {
  const MONTHS = [
    "январ",
    "феврал",
    "март",
    "апрел",
    "май",
    "июн",
    "июл",
    "август",
    "сентябр",
    "октябр",
    "ноябр",
    "декабр",
  ];
  for (const row of rows.slice(0, 25)) {
    for (const cell of row) {
      const s = asCellString(cell);
      if (!s) continue;

      const m1 = s.match(
        /(?:с|от|from)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}).+?(?:по|до|to)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i
      );
      if (m1) return `${m1[1]} — ${m1[2]}`;

      const m2 = s.match(/(?:период|за|month)[:\s]*([а-яё]+\s+\d{4})/i);
      if (m2) return m2[1];

      const lower = s.toLowerCase();
      if (MONTHS.some((m) => lower.includes(m)) && /\b\d{4}\b/.test(s)) {
        const m3 = s.match(/([а-яё]+\s+\d{4})/i);
        if (m3) return m3[1];
      }
    }
  }
  return null;
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  const arr = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  return arr as unknown[][];
}

/**
 * Decode XML numeric character references and the five predefined entities.
 * Used to recover original text from `<v>...</v>` payloads of `t="str"` cells
 * that SheetJS 0.18.5 corrupts (see {@link patchStrCellsFromRawXml}).
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Workaround for SheetJS 0.18.5 bug on `<c t="str">` cells: values containing
 * Unicode codepoints > 0xFF are truncated to their low byte. E.g. Ozon's label
 * "Итого реализовано (за вычетом возвратов) (руб.):" comes out as
 * "B>3> @50;87>20=> ..." (И U+0418 → , т U+0442 → B, …) which
 * breaks all keyword-based totals matching.
 *
 * Ozon's monthly XLSX puts every label cell (headers, totals, "М.П." etc.)
 * inside `t="str"` cells, so without this patch revenue extraction is dead.
 *
 * We re-parse the raw worksheet XML, walk cells in document order (Ozon files
 * omit `r="..."` attributes on most cells, so positional inference is required),
 * decode `<v>` content as proper XML, and override the broken values directly on
 * the SheetJS sheet object before `sheet_to_json` is called.
 *
 * Returns the number of cells patched (for diagnostics).
 */
function patchStrCellsFromRawXml(
  sheet: XLSX.WorkSheet,
  rawXml: string
): number {
  let patched = 0;
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let inferredRowIdx = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(rawXml)) !== null) {
    const rowAttrs = rowMatch[1];
    const rowBody = rowMatch[2];
    const rAttr = rowAttrs.match(/\br="(\d+)"/);
    let curRow: number;
    if (rAttr) {
      curRow = parseInt(rAttr[1], 10) - 1;
      inferredRowIdx = curRow;
    } else {
      curRow = inferredRowIdx;
    }
    inferredRowIdx++;

    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let inferredColIdx = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowBody)) !== null) {
      const cAttrs = cellMatch[1];
      const cBody = cellMatch[2] ?? "";
      const cRef = cAttrs.match(/\br="([A-Z]+\d+)"/);
      let curCol: number;
      if (cRef) {
        curCol = XLSX.utils.decode_cell(cRef[1]).c;
        inferredColIdx = curCol;
      } else {
        curCol = inferredColIdx;
      }
      inferredColIdx++;

      const tAttr = cAttrs.match(/\bt="([^"]+)"/);
      if (!tAttr || tAttr[1] !== "str") continue;
      const vMatch = cBody.match(/<v>([\s\S]*?)<\/v>/);
      if (!vMatch) continue;

      const decoded = decodeXmlEntities(vMatch[1]);
      const addr = XLSX.utils.encode_cell({ r: curRow, c: curCol });
      const existing = sheet[addr];
      if (existing) {
        existing.t = "s";
        existing.v = decoded;
        existing.w = decoded;
      } else {
        sheet[addr] = { t: "s", v: decoded, w: decoded };
      }
      patched++;
    }
  }
  return patched;
}

/**
 * Apply {@link patchStrCellsFromRawXml} to every worksheet in the workbook.
 * Requires `XLSX.read(..., { bookFiles: true })` so `wb.files` is populated.
 * The order of `wb.Directory.sheets` matches `wb.SheetNames`.
 */
function patchAllStrCells(workbook: XLSX.WorkBook): {
  patchedPerSheet: Record<string, number>;
  total: number;
} {
  const out: Record<string, number> = {};
  let total = 0;
  const files = (workbook as XLSX.WorkBook & {
    files?: Record<string, { content?: Uint8Array | Buffer }>;
  }).files;
  const dirSheets = (workbook as XLSX.WorkBook & {
    Directory?: { sheets?: string[] };
  }).Directory?.sheets;
  if (!files || !dirSheets) return { patchedPerSheet: out, total: 0 };

  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const name = workbook.SheetNames[i];
    const sheet = workbook.Sheets[name];
    const rawPath = dirSheets[i];
    if (!sheet || !rawPath) continue;
    const key = rawPath.replace(/^\/+/, "");
    const file = files[key];
    const content = file?.content;
    if (!content) continue;
    const xml = new TextDecoder("utf-8").decode(
      content instanceof Uint8Array ? content : new Uint8Array(content)
    );
    const n = patchStrCellsFromRawXml(sheet, xml);
    out[name] = n;
    total += n;
  }
  return { patchedPerSheet: out, total };
}

function pickDataSheet(workbook: XLSX.WorkBook): {
  sheet: XLSX.WorkSheet | null;
  rows: unknown[][];
  name: string | null;
} {
  let best: {
    sheet: XLSX.WorkSheet | null;
    rows: unknown[][];
    name: string | null;
  } = {
    sheet: null,
    rows: [],
    name: null,
  };
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = sheetToRows(sheet);
    if (rows.length > best.rows.length) {
      best = { sheet, rows, name };
    }
  }
  return best;
}

interface HeaderCandidate {
  rowIdx: number;
  matchedCount: number;
  matchedFields: string[];
  rowPreview: unknown[];
  colMap: Partial<Record<FieldKey, number>>;
  score: number;
  scoreBreakdown: HeaderScoreBreakdown;
  nonEmptyCells: number;
  stringCells: number;
  numericCells: number;
  hasDataRowsAfter: boolean;
  confidence: HeaderConfidence;
}

/**
 * Найти ВСЕХ кандидатов на header-row (для дебага) и выбрать лучшего по score.
 * Никакого strict-фильтра до regex matching — heuristic используется только
 * как часть scoring системы.
 */
function findHeaderRow(rows: unknown[][]): {
  candidates: HeaderCandidate[];
  best: HeaderCandidate | null;
  scannedRowsCount: number;
} {
  // eslint-disable-next-line no-console
  console.log(LOG, "NEW FIND HEADER ROW ACTIVE v3");

  const candidates: HeaderCandidate[] = [];
  const scannedRowsCount = Math.min(rows.length, 80);

  for (let i = 0; i < scannedRowsCount; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    // ===== regex matching (на ВСЕХ строках) =====
    const map: Partial<Record<FieldKey, number>> = {};
    row.forEach((cell, idx) => {
      const text = asCellString(cell).toLowerCase().trim();
      if (!text) return;
      for (const field of Object.keys(HEADER_PATTERNS) as FieldKey[]) {
        if (map[field] !== undefined) continue;
        if (HEADER_PATTERNS[field].some((p) => p.test(text))) {
          map[field] = idx;
        }
      }
    });

    const matchedFields = Object.keys(map);
    if (matchedFields.length === 0) continue;

    // ===== Cell classification =====
    let nonEmpty = 0;
    let stringCells = 0;
    let numericCells = 0;
    let specialWordsBoost = 0;

    for (const cell of row) {
      const s = asCellString(cell).trim();
      const kind = classifyCell(s);
      if (kind === "empty") continue;
      nonEmpty++;
      if (kind === "string") stringCells++;
      if (kind === "numeric" || kind === "date") numericCells++;

      // Boost: до +5 за ячейку, остановка после первого совпадения
      for (const re of BOOST_WORDS) {
        if (re.test(s)) {
          specialWordsBoost += 5;
          break;
        }
      }
    }

    // ===== Look-ahead: следующие 3 строки — data rows? =====
    let hasDataRowsAfter = false;
    for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
      if (looksLikeDataRow(rows[j])) {
        hasDataRowsAfter = true;
        break;
      }
    }

    // ===== Score =====
    const matchedColumnsBonus = matchedFields.length * 10;
    const stringCellsBonus = stringCells * 2;
    const numericPenaltyRaw =
      numericCells > stringCells ? (numericCells - stringCells) * 3 : 0;
    const dataRowsFollowBoost = hasDataRowsAfter ? 20 : 0;

    const breakdown: HeaderScoreBreakdown = {
      matchedColumnsBonus,
      nonEmptyCellsBonus: nonEmpty,
      stringCellsBonus,
      numericPenalty: -numericPenaltyRaw,
      specialWordsBoost,
      dataRowsFollowBoost,
      total:
        matchedColumnsBonus +
        nonEmpty +
        stringCellsBonus -
        numericPenaltyRaw +
        specialWordsBoost +
        dataRowsFollowBoost,
    };

    // ===== Confidence =====
    let confidence: HeaderConfidence;
    if (
      matchedFields.length >= 4 &&
      hasDataRowsAfter &&
      specialWordsBoost > 0
    ) {
      confidence = "high";
    } else if (
      matchedFields.length >= 3 ||
      (matchedFields.length >= 2 && hasDataRowsAfter)
    ) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    candidates.push({
      rowIdx: i,
      matchedCount: matchedFields.length,
      matchedFields,
      rowPreview: row.slice(0, 14),
      colMap: map,
      score: breakdown.total,
      scoreBreakdown: breakdown,
      nonEmptyCells: nonEmpty,
      stringCells,
      numericCells,
      hasDataRowsAfter,
      confidence,
    });
  }

  // Лучший — кандидат с максимальным score. При равенстве — тот, что выше.
  let best: HeaderCandidate | null = null;
  for (const c of candidates) {
    if (!best || c.score > best.score) best = c;
  }

  // Минимальный порог: >= 2 регекс-матчей. Случайный 1-матч — не header.
  if (best && best.matchedCount < 2) best = null;

  return { candidates, best, scannedRowsCount };
}

// ============================================================================
// Totals row extraction (для 3-file flow: revenue + loyaltyPayouts из итогов)
// ============================================================================

/**
 * Регекс-паттерны для распознавания итоговых строк по тексту label.
 * Применимо к файлам с НОРМАЛЬНОЙ кириллицей. PUA-encoded файлы не пройдут
 * текстовый матч — для них смотрите debug.totalsRowCandidates.
 */
const TOTAL_LABEL_PATTERNS = {
  revenue: [
    /итого\s*реализован/i,
    /итог\s*реализован/i,
    /реализован.*за\s+вычет/i,
    /за\s+вычетом\s+возврат/i,
    /итого\s+реализ/i,          // "Итого реализ. за период"
    /итог.*реализ/i,             // расширенный
  ],
  loyaltyPayouts: [
    /всего\s+выплат\s+от\s+партн/i,
    /выплат\s+от\s+партн/i,
    /программ.*лояльност/i,
    /бонус.*партн/i,
    /^всего\s+выплат/i,          // "Всего выплат"
    /итого\s+выплат/i,           // "Итого выплат"
  ],
};

/**
 * Широкий keyword-фильтр: «эта строка — итоговая?».
 * Используется только для DEV-логирования totalsRowCandidates;
 * matchKnownTotals использует более узкие паттерны выше.
 */
const TOTAL_KEYWORDS = /итого|реализ|выплат|перечис/i;

/**
 * STRICT scoring keywords для best-match label detection.
 *
 * Каждое ключевое слово даёт +1 к score у label-ячейки. Финальный candidate
 * выбирается по MAX(score) — а не по «первому совпадению». Это защита от
 * случаев, когда `/реализ/` матчится на промежуточные строки итогов
 * («Реализовано», «По реализации» и т.д.) вместо главного «Итого реализовано
 * (за вычетом возвратов) (руб.)».
 *
 * Для нашего эталонного label строка матчит все 3 ключа → score=3.
 */
const REVENUE_KEYWORDS: RegExp[] = [
  /итого\s*реализован/i,        // primary marker
  /за\s+вычет.*возврат/i,        // secondary marker
  /руб/i,                         // currency suffix
];
const LOYALTY_KEYWORDS: RegExp[] = [
  /всего\s+выплат\s+от\s+партн/i, // primary
  /выплат.*партн/i,                // secondary
  /руб/i,                          // currency suffix
];

/**
 * Содержит ли raw-строка ячейки десятичный разделитель + цифру?
 * «157300.15» → true. «157300» → false. «157 300,00» → true (есть «,0»).
 */
function hasDecimalsInString(s: string): boolean {
  return /[.,]\d/.test(s);
}

/**
 * Нормализация текста ячейки для regex-поиска: lowercase + NBSP→space +
 * убрать zero-width chars + collapse whitespace.
 *
 * Это устраняет ложные «нет совпадения» когда между словами в label
 * стоит   (NBSP) или ​ (zero-width space) — JS regex `\s` хоть и
 * матчит NBSP, но некоторые ручные паттерны без \s могут сломаться.
 */
function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/ /g, " ")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Является ли число «ID-подобным» (ИНН, КПП, номер заказа, штрих-код)?
 *
 * Critical для numeric fallback: без этого фильтра ИНН 7704217370 будет
 * выбран как max revenue вместо реального 157300.15.
 *
 * Эвристика: целое число с абсолютным значением >= 1 миллиарда.
 *  - ИНН (10 цифр), КПП (9 цифр), order ID — попадают в фильтр
 *  - Большие, но реалистичные суммы (10М, 100М рублей) — пройдут
 *  - Любое значение с дробной частью — пройдёт (157300.15, 1095.58 OK)
 */
function isLikelyIdValue(v: number): boolean {
  if (!Number.isFinite(v)) return false;
  if (!Number.isInteger(v)) return false;
  return Math.abs(v) >= 1_000_000_000;
}

/** Результат strict text-поиска итоговой строки. */
export interface TotalMatch {
  rowIdx: number;
  value: number;
  /** Текст label-ячейки (часть, что заматчилась). */
  labelText: string;
  labelColIdx: number;
  valueColIdx: number;
  /** Скольким keyword'ам матчится label. */
  score: number;
  /** Превью первых ~10 ячеек строки — для DEV debug. */
  rowPreview: unknown[];
}

interface FindOpts {
  /** Сколько keyword'ов минимум должно матчиться (иначе candidate пропускается). */
  minScore?: number;
  /** Максимальное значение value. Сверху отсекаем нереалистично большие числа. */
  maxValue?: number;
  /** Требовать decimal-часть в raw-строке value (например "157300.15", а не "157300"). */
  requireDecimals?: boolean;
}

/**
 * Strict text-поиск итоговой строки с BEST-MATCH scoring.
 *
 * Алгоритм:
 *   1. Скан ВСЕХ строк листа.
 *   2. На каждой строке для КАЖДОЙ ячейки считаем score = число матчей
 *      keyword'ов. Берём label-ячейку с максимальным score.
 *   3. Если score >= minScore, ищем первое числовое значение СПРАВА от label
 *      в той же row.
 *   4. Числовое значение валидно, если:
 *        - > 0
 *        - не ID-like (isLikelyIdValue)
 *        - не превышает sanity limit (maxValue, если задан)
 *        - содержит decimal-разделитель в raw-строке (если requireDecimals)
 *   5. Из всех валидных candidate'ов возвращаем тот, что с НАИБОЛЬШИМ score.
 *      Tie-break: меньший rowIdx (более вероятно primary total, не дубль).
 *
 * Это устраняет ошибку «text-search матчится не на ту строку» — раньше
 * возвращался первый row с `/реализ/` (даже промежуточные «Реализовано
 * за период» и т.п.), теперь только row с максимальной полнотой совпадения.
 */
function findTotalByKeywords(
  rows: unknown[][],
  keywords: RegExp[],
  opts: FindOpts = {}
): TotalMatch | null {
  const minScore = opts.minScore ?? 1;
  const candidates: TotalMatch[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    // Собираем нормализованный текст по каждой непустой ячейке + общую строку.
    // Это даёт нам два сценария матчинга:
    //   (a) одна ячейка содержит весь label («Итого реализовано (за вычетом …)»)
    //   (b) label разбит на несколько ячеек («Итого реализовано» | «(за вычетом возвратов)» | «(руб.)»)
    const cellsMeta: { idx: number; raw: string; normalized: string }[] = [];
    for (let c = 0; c < row.length; c++) {
      const raw = asCellString(row[c]).trim();
      if (!raw) continue;
      cellsMeta.push({ idx: c, raw, normalized: normalizeForSearch(raw) });
    }
    if (cellsMeta.length === 0) continue;

    const joinedNormalized = cellsMeta.map((c) => c.normalized).join(" ");

    // Score = сколько keyword'ов матчатся в JOINED тексте строки.
    // Это покрывает случай (b) — label разбит на ячейки.
    let rowScore = 0;
    for (const kw of keywords) {
      if (kw.test(joinedNormalized)) rowScore++;
    }
    if (rowScore < minScore) continue;

    // Anchor = ПОСЛЕДНЯЯ ячейка строки, которая матчит хотя бы один keyword.
    // Это «хвост label», после которого должно идти числовое значение.
    let anchorIdx = -1;
    let anchorText = "";
    for (let k = cellsMeta.length - 1; k >= 0; k--) {
      const meta = cellsMeta[k];
      if (keywords.some((kw) => kw.test(meta.normalized))) {
        anchorIdx = meta.idx;
        anchorText = meta.raw;
        break;
      }
    }
    if (anchorIdx === -1) continue; // safety

    // Найти первое валидное numeric значение СПРАВА от anchor.
    for (let c = anchorIdx + 1; c < row.length; c++) {
      const raw = asCellString(row[c]).trim();
      if (!raw) continue;
      if (classifyCell(raw) !== "numeric") continue;
      const v = safeNumber(raw);
      if (v <= 0) continue;
      if (isLikelyIdValue(v)) continue;
      if (opts.maxValue !== undefined && v > opts.maxValue) continue;
      if (opts.requireDecimals && !hasDecimalsInString(raw)) continue;

      candidates.push({
        rowIdx: i,
        value: v,
        labelText: anchorText,
        labelColIdx: anchorIdx,
        valueColIdx: c,
        score: rowScore,
        rowPreview: row.slice(0, Math.min(row.length, 10)),
      });
      break; // одно валидное число на строку — достаточно
    }
  }

  if (candidates.length === 0) return null;

  // BEST MATCH: max(score). Tie-break — earlier rowIdx.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.rowIdx - b.rowIdx;
  });

  return candidates[0];
}

/** Поиск revenue total по тексту. STRICT — best match по REVENUE_KEYWORDS. */
function findRevenueByText(rows: unknown[][]): TotalMatch | null {
  return findTotalByKeywords(rows, REVENUE_KEYWORDS, {
    minScore: 1,
    // Sanity: monthly revenue реального продавца Ozon не превышает 100М ₽.
    // Любой матч больше — почти гарантированно ID/нечисловой артефакт.
    maxValue: 100_000_000,
    // Итог реализации всегда с копейками: «157300.15» или «157300,15».
    requireDecimals: true,
  });
}

/** Поиск loyaltyPayouts total по тексту. STRICT — best match по LOYALTY_KEYWORDS. */
function findLoyaltyByText(rows: unknown[][]): TotalMatch | null {
  return findTotalByKeywords(rows, LOYALTY_KEYWORDS, {
    minScore: 1,
    maxValue: 10_000_000,
    requireDecimals: true,
  });
}

/**
 * Просканировать ВЕСЬ лист и собрать все «label + 1-3 numeric» строки —
 * кандидаты на итоговые строки. Не привязываемся к headerRowIdx, потому
 * что некоторые итоги могут быть выше header (например, метаданные).
 *
 * Структура итоговой строки в Ozon-отчёте:
 *   ['', 'Итого реализовано (за вычетом возвратов) (руб.):', '157300.15', '', …]
 *   мало непустых ячеек, одна — текст-label, одна-три — числовые значения.
 *
 * `classifyCell` ТЕПЕРЬ возвращает "string" для PUA-encoded ячеек, поэтому
 * label-ячейки с font-substitution распознаются как текст.
 */
function extractTotalsRows(rows: unknown[][]): TotalsRowCandidate[] {
  const out: TotalsRowCandidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    let nonEmptyCount = 0;
    let bestTextIdx = -1;
    let bestTextLen = 0;
    const numericCells: { idx: number; value: number }[] = [];

    for (let c = 0; c < row.length; c++) {
      const cellStr = asCellString(row[c]).trim();
      if (!cellStr) continue;
      nonEmptyCount++;
      const kind = classifyCell(cellStr);
      if (kind === "string") {
        if (cellStr.length > bestTextLen) {
          bestTextIdx = c;
          bestTextLen = cellStr.length;
        }
      } else if (kind === "numeric") {
        const v = safeNumber(cellStr);
        // Отсекаем ID-подобные значения (ИНН, КПП, № заказа) —
        // они не могут быть итоговыми суммами.
        if (v !== 0 && !isLikelyIdValue(v)) {
          numericCells.push({ idx: c, value: v });
        }
      }
    }

    // Условие: ≥1 текстовая ячейка + 1—3 числовые. Итого ≤ 8 непустых
    // ячеек (защита от полноценных data rows).
    if (
      bestTextIdx !== -1 &&
      numericCells.length >= 1 &&
      numericCells.length <= 3 &&
      nonEmptyCount <= 8
    ) {
      // Берём первое числовое значение как primary (обычно сразу после label).
      const firstNum = numericCells[0];
      out.push({
        rowIdx: i,
        labelText: asCellString(row[bestTextIdx]),
        labelColIdx: bestTextIdx,
        value: firstNum.value,
        valueColIdx: firstNum.idx,
      });
    }
  }

  return out;
}

/**
 * Просканировать НИЖНИЕ N строк листа и собрать все положительные числа.
 * Используется как numeric fallback: если text-match не нашёл revenue total,
 * берём максимальное значение из этой выборки.
 *
 * Сюда попадают любые числовые ячейки — даже без label-ячейки в той же
 * строке (то есть это шире, чем extractTotalsRows).
 */
interface BottomRowNumeric {
  rowIdx: number;
  cellIdx: number;
  value: number;
  /** Превью первых 6 ячеек строки — для контекста в DEV debug. */
  rowPreview: unknown[];
}
function extractBottomNumerics(
  rows: unknown[][],
  windowSize: number = 30
): BottomRowNumeric[] {
  const out: BottomRowNumeric[] = [];
  const startIdx = Math.max(0, rows.length - windowSize);
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    for (let c = 0; c < row.length; c++) {
      const cellStr = asCellString(row[c]).trim();
      if (!cellStr) continue;
      if (classifyCell(cellStr) !== "numeric") continue;
      const v = safeNumber(cellStr);
      // Только положительные не-ID-подобные значения.
      // 7704217370 (ИНН) и подобные — гарантированно отсекаются.
      if (v > 0 && !isLikelyIdValue(v)) {
        out.push({
          rowIdx: i,
          cellIdx: c,
          value: v,
          rowPreview: row.slice(0, 6),
        });
      }
    }
  }
  return out;
}

/**
 * Распознать revenue и loyaltyPayouts среди totals-кандидатов по regex
 * паттернам. Возвращает rowIdx (для UI debug) и значение для каждого.
 */
function matchKnownTotals(
  candidates: TotalsRowCandidate[]
): {
  revenue: { rowIdx: number; value: number } | null;
  loyaltyPayouts: { rowIdx: number; value: number } | null;
} {
  let revenue: { rowIdx: number; value: number } | null = null;
  let loyaltyPayouts: { rowIdx: number; value: number } | null = null;

  for (const c of candidates) {
    const label = c.labelText.toLowerCase();
    if (!revenue) {
      for (const p of TOTAL_LABEL_PATTERNS.revenue) {
        if (p.test(label)) {
          revenue = { rowIdx: c.rowIdx, value: c.value };
          break;
        }
      }
    }
    if (!loyaltyPayouts) {
      for (const p of TOTAL_LABEL_PATTERNS.loyaltyPayouts) {
        if (p.test(label)) {
          loyaltyPayouts = { rowIdx: c.rowIdx, value: c.value };
          break;
        }
      }
    }
  }

  return { revenue, loyaltyPayouts };
}

// ============================================================================
// Public API
// ============================================================================

export async function parseOzonReport(file: File): Promise<ParseResult> {
  const debugInfo: OzonDebugInfo = {
    fileName: file.name,
    fileSize: file.size,
    sheetNames: [],
    selectedSheetName: null,
    selectedSheetRowCount: 0,
    ozonDetected: false,
    ozonDetectionReason: null,
    firstRows: [],
    scannedRowsCount: 0,
    headerCandidates: [],
    topHeaderCandidates: [],
    selectedHeaderRowIdx: -1,
    selectedHeaderRow: null,
    selectedHeaderScore: null,
    selectedHeaderConfidence: null,
    matchedColumns: {},
    rowsAfterHeader: 0,
    rowsParsed: 0,
    skipReasons: { empty: 0, total: 0, noMeaningfulValue: 0 },
    firstParsedRows: [],
    aggregationWarnings: [],
    finalTotals: null,
    finalEstimate: null,
    totalsRowCandidates: [],
    matchedRevenueTotalRowIdx: null,
    matchedLoyaltyTotalRowIdx: null,
    matchedRevenueTotalDetails: null,
    matchedLoyaltyTotalDetails: null,
    productRowCount: 0,
    failedAt: null,
  };

  // eslint-disable-next-line no-console
  console.log(LOG, "→ parseOzonReport start", {
    name: file.name,
    size: file.size,
  });

  // Финальный return debug — каждый раз пишем в console.log что именно отдаём.
  // Это страховка: если UI уходит в error при `ok: true`, проблема не в парсере.
  const finish = (result: ParseResult): ParseResult => {
    // eslint-disable-next-line no-console
    console.log(LOG, "RETURN", {
      ok: result.ok,
      hasReport: !!result.report,
      error: result.error,
      estimate: result.report?.estimate ?? null,
      rowsParsed: result.debugInfo.rowsParsed,
      failedAt: result.debugInfo.failedAt,
    });
    return result;
  };

  try {
    const buf = await file.arrayBuffer();

    let workbook: XLSX.WorkBook;
    try {
      // bookFiles: true keeps raw zip entries on workbook.files, used by
      // patchAllStrCells() to fix the SheetJS 0.18.5 t="str" encoding bug.
      workbook = XLSX.read(buf, { type: "array", bookFiles: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "неизвестная ошибка";
      debugInfo.failedAt = `XLSX.read threw: ${msg}`;
      // eslint-disable-next-line no-console
      console.error(LOG, "XLSX.read failed", msg);
      return finish({
        ok: false,
        report: null,
        error: `Не удалось прочитать файл: ${msg}`,
        debugInfo,
      });
    }

    const strPatch = patchAllStrCells(workbook);
    // eslint-disable-next-line no-console
    console.log(
      LOG,
      "patched t=\"str\" cells:",
      strPatch.total,
      strPatch.patchedPerSheet
    );

    debugInfo.sheetNames = workbook.SheetNames;
    // eslint-disable-next-line no-console
    console.log(LOG, "workbook.SheetNames =", workbook.SheetNames);

    if (!workbook.SheetNames.length) {
      debugInfo.failedAt = "no sheets in workbook";
      return finish({
        ok: false,
        report: null,
        error: "Файл пустой — нет ни одного листа.",
        debugInfo,
      });
    }

    const detection = detectOzon(workbook);
    debugInfo.ozonDetected = detection.detected;
    debugInfo.ozonDetectionReason = detection.reason;
    // eslint-disable-next-line no-console
    console.log(LOG, "Ozon detection:", detection);

    if (!detection.detected) {
      debugInfo.failedAt = "not recognized as Ozon (sheet names + cell scan)";
      return finish({
        ok: false,
        report: null,
        error:
          "Не удалось распознать отчёт Ozon. Проверьте, что это XLSX-файл из личного кабинета Ozon.",
        debugInfo,
      });
    }

    const {
      sheet: dataSheet,
      rows: dataRows,
      name: dataSheetName,
    } = pickDataSheet(workbook);
    debugInfo.selectedSheetName = dataSheetName;
    debugInfo.selectedSheetRowCount = dataRows.length;
    debugInfo.firstRows = dataRows.slice(0, 60);

    // eslint-disable-next-line no-console
    console.log(LOG, "selectedSheetName =", dataSheetName);
    // eslint-disable-next-line no-console
    console.log(LOG, "selectedSheetRowCount =", dataRows.length);
    // eslint-disable-next-line no-console
    console.log(LOG, "first 60 rows of selected sheet:");
    // eslint-disable-next-line no-console
    console.table(dataRows.slice(0, 60));

    if (!dataSheet || dataRows.length < 2) {
      debugInfo.failedAt = "no sheet with data (< 2 rows)";
      return finish({
        ok: false,
        report: null,
        error: "В файле нет листа с данными.",
        debugInfo,
      });
    }

    const { candidates, best, scannedRowsCount } = findHeaderRow(dataRows);

    debugInfo.scannedRowsCount = scannedRowsCount;
    const candidatesDebug: HeaderCandidateDebug[] = candidates.map((c) => ({
      rowIdx: c.rowIdx,
      score: c.score,
      matchedCount: c.matchedCount,
      matchedFields: c.matchedFields,
      rowPreview: c.rowPreview,
      nonEmptyCells: c.nonEmptyCells,
      stringCells: c.stringCells,
      numericCells: c.numericCells,
      hasDataRowsAfter: c.hasDataRowsAfter,
      confidence: c.confidence,
      scoreBreakdown: c.scoreBreakdown,
    }));
    debugInfo.headerCandidates = candidatesDebug;
    debugInfo.topHeaderCandidates = [...candidatesDebug]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // eslint-disable-next-line no-console
    console.log(LOG, `scannedRowsCount = ${scannedRowsCount}`);
    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `header candidates (${candidates.length} total) sorted by score:`,
      debugInfo.topHeaderCandidates.map((c) => ({
        rowIdx: c.rowIdx,
        score: c.score,
        matchedCount: c.matchedCount,
        matchedFields: c.matchedFields,
        confidence: c.confidence,
      }))
    );

    // ===== Header selection (auto-detect, then fallback) =====
    let headerRowIdx: number;
    let colMap: Partial<Record<FieldKey, number>>;
    let usedRealizationFallback = false;

    if (best) {
      headerRowIdx = best.rowIdx;
      colMap = best.colMap;
    } else {
      // Fallback под реальный Ozon-отчёт «Отчет о реализации товара».
      // SheetJS возвращает Cyrillic-заголовки этого отчёта как PUA-мусор
      // (font substitution внутри XLSX), поэтому auto-detection ничего не
      // находит. Если имя листа/файла указывает на этот формат и в листе
      // достаточно строк (>= 15), форсим известный header mapping.
      const reportLooksLikeRealization =
        workbook.SheetNames.some((n) =>
          /отчет\s*о\s*реализаци/i.test(n)
        ) ||
        (typeof dataSheetName === "string" &&
          /отчет\s*о\s*реализаци/i.test(dataSheetName)) ||
        /отчет\s*о\s*реализаци/i.test(file.name);

      if (reportLooksLikeRealization && dataRows.length >= 15) {
        headerRowIdx = 12;
        // Реальный mapping колонок для отчёта «Отчет о реализации товара»
        // (получен из console.table на живом файле — qtyRaw="1", priceRaw="3678.8",
        // commissionRaw="36.54" совпадают со столбцами 7, 5, 6 соответственно).
        // Cols 2-4 содержат SKU/идентификаторы — НЕ числовые суммы.
        // Price column отсутствует — price вычисляется как revenue/qty для avgPrice.
        colMap = {
          qty: 7,
          revenue: 5,
          commission: 6,
        };
        usedRealizationFallback = true;
        // eslint-disable-next-line no-console
        console.warn(
          LOG,
          "using Ozon realization fallback header mapping (qty:7, revenue:5, commission:6)"
        );
      } else {
        debugInfo.failedAt = "no header row matched >= 2 known columns";
        // eslint-disable-next-line no-console
        console.warn(LOG, "HEADER DEBUG HARD FAIL", {
          candidates,
          topHeaderCandidates: debugInfo.topHeaderCandidates,
          firstRows: debugInfo.firstRows,
        });
        // eslint-disable-next-line no-console
        console.warn(
          LOG,
          "no header row matched >= 2 columns. Dumping first 60 rows for diagnosis:"
        );
        // eslint-disable-next-line no-console
        console.table(dataRows.slice(0, 60));
        // eslint-disable-next-line no-console
        console.log(LOG, "full debugInfo:", debugInfo);
        return finish({
          ok: false,
          report: null,
          error: "Формат отчёта пока не поддерживается",
          debugInfo,
        });
      }
    }

    const headerRow = dataRows[headerRowIdx] ?? null;
    debugInfo.selectedHeaderRowIdx = headerRowIdx;
    debugInfo.selectedHeaderRow = headerRow;
    debugInfo.selectedHeaderScore = best?.score ?? null;
    // Realization fallback теперь имеет проверенный mapping (qty:7, revenue:5,
    // commission:6) — confidence = "medium". Это разрешает autofill через
    // confidence-gate, при этом всё ещё видно в UI badge'е что это fallback.
    // Если в будущем добавится новый неизвестный формат, он начнётся с "low".
    debugInfo.selectedHeaderConfidence = usedRealizationFallback
      ? "medium"
      : best?.confidence ?? null;
    debugInfo.matchedColumns = colMap as Record<string, number>;
    // failedAt должен оставаться null если fallback применился — иначе UI
    // прочитает старое значение и подумает, что мы упали.
    debugInfo.failedAt = null;

    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `selected header row idx=${headerRowIdx} score=${best?.score ?? "(fallback)"} confidence=${
        debugInfo.selectedHeaderConfidence
      }${usedRealizationFallback ? " [fallback]" : ""}`
    );
    // eslint-disable-next-line no-console
    console.log(LOG, "selected header row content:", headerRow);
    if (best) {
      // eslint-disable-next-line no-console
      console.log(LOG, "scoreBreakdown:", best.scoreBreakdown);
    }
    // eslint-disable-next-line no-console
    console.log(LOG, "matchedColumns =", colMap);
    // eslint-disable-next-line no-console
    console.log(LOG, "header confidence =", debugInfo.selectedHeaderConfidence);

    // ===== Aggregation =====
    let totalRevenue = 0;
    let totalQty = 0;
    let totalReturns = 0;
    let totalLoyalty = 0;
    let totalCommission = 0;
    let totalLogistics = 0;
    let totalStorage = 0;
    let totalAds = 0;
    let totalTax = 0;

    let priceSum = 0;
    let priceCount = 0;
    let productRowCount = 0;
    let qtyPriceFallbackCount = 0; // сколько раз использовали qty*price вместо revenue колонки

    // ===== Per-SKU слой (для каталога) =====
    // Колонки артикул/наименование ищем в ОКНЕ строк над под-шапкой (Ozon
    // realization имеет двух-строчную шапку — ярлыки на строку выше числовой).
    // В realization-fallback заголовки — PUA-мусор, поэтому per-SKU слой
    // намеренно пуст: лучше показать только агрегаты, чем подставить garbage.
    const { articleCol, nameCol } = usedRealizationFallback
      ? { articleCol: null, nameCol: null }
      : detectArticleNameCols(dataRows, headerRowIdx);
    const products: OzonProductRow[] = [];
    // eslint-disable-next-line no-console
    console.log(LOG, "per-SKU columns:", { articleCol, nameCol });

    const rowsAfterHeader = Math.max(0, dataRows.length - headerRowIdx - 1);
    debugInfo.rowsAfterHeader = rowsAfterHeader;

    const skipReasons: AggregationSkipReasons = {
      empty: 0,
      total: 0,
      noMeaningfulValue: 0,
    };
    const firstParsedRows: ParsedRowSample[] = [];
    const aggregationWarnings: string[] = [];

    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `aggregation start — rowsAfterHeader=${rowsAfterHeader}, headerRowIdx=${headerRowIdx}`
    );

    for (let i = headerRowIdx + 1; i < dataRows.length; i++) {
      const row = dataRows[i];

      // empty
      if (!row || row.length === 0) {
        skipReasons.empty++;
        continue;
      }
      // empty (whitespace-only тоже считаем пустыми)
      if (
        row.every(
          (c) => c == null || asCellString(c).trim() === ""
        )
      ) {
        skipReasons.empty++;
        continue;
      }
      // total row
      if (isTotalRow(row)) {
        skipReasons.total++;
        if (skipReasons.total <= 3) {
          // eslint-disable-next-line no-console
          console.log(LOG, `skip row ${i} (total row):`, row.slice(0, 8));
        }
        continue;
      }
      // Сводная строка-итог БЕЗ текстовой метки в первых ячейках (напр. строка
      // с Σ «Реализовано на сумму» в col5, но пустыми артикулом/названием) и
      // строка-легенда «1 2 3 …» — это НЕ товары. После исправления revenue→col5
      // их деньги задваивали бы totalRevenue (итог Ozon попадал бы в сумму ещё
      // раз). Скипаем из агрегата И из per-SKU слоя одинаково, чтобы выполнялось
      // totals.revenue == Σ(per-SKU) == Ozon «Итого реализовано».
      if (
        isColumnNumberLegendRow(row) ||
        (articleCol !== null && asCellString(row[articleCol]).trim() === "")
      ) {
        skipReasons.total++;
        if (skipReasons.total <= 6) {
          // eslint-disable-next-line no-console
          console.log(
            LOG,
            `skip row ${i} (non-product summary/legend):`,
            row.slice(0, 8)
          );
        }
        continue;
      }

      // Захватываем RAW значения отдельно — для DEV debug видно, что именно
      // лежит в ячейке (до парсинга), и можно проверить корректность mapping.
      const qtyRaw = colMap.qty !== undefined ? row[colMap.qty] : 0;
      const priceRaw = colMap.price !== undefined ? row[colMap.price] : 0;
      const revenueRaw =
        colMap.revenue !== undefined ? row[colMap.revenue] : 0;
      const commissionRaw =
        colMap.commission !== undefined ? row[colMap.commission] : 0;

      // safeNumber — null/undefined/""/NaN всегда дадут 0
      const qty = safeNumber(qtyRaw);
      let price = safeNumber(priceRaw);
      let rev = safeNumber(revenueRaw);

      const commissionVal = safeNumber(commissionRaw);
      const logisticsVal = safeNumber(
        colMap.logistics !== undefined ? row[colMap.logistics] : 0
      );
      const adsVal = safeNumber(
        colMap.ads !== undefined ? row[colMap.ads] : 0
      );
      const taxVal = safeNumber(
        colMap.tax !== undefined ? row[colMap.tax] : 0
      );
      const storageVal = safeNumber(
        colMap.storage !== undefined ? row[colMap.storage] : 0
      );
      const returnsVal = safeNumber(
        colMap.returns !== undefined ? row[colMap.returns] : 0
      );
      const loyaltyVal = safeNumber(
        colMap.loyalty !== undefined ? row[colMap.loyalty] : 0
      );

      // Если в revenue-колонке 0, но есть qty * price — используем расчётное.
      // Также покрывает случай, когда colMap.revenue === undefined вообще.
      let revenueSource: "column" | "qty*price" | "none" =
        rev !== 0 ? "column" : "none";
      if (rev === 0 && qty > 0 && price > 0) {
        rev = qty * price;
        revenueSource = "qty*price";
        qtyPriceFallbackCount++;
      }

      // Обратная ситуация: revenue известен, price колонки нет.
      // Считаем price = revenue / qty (полезно для avgPrice и sample).
      if (price === 0 && rev > 0 && qty > 0) {
        price = rev / qty;
      }

      const hasMeaningfulValue =
        rev !== 0 ||
        qty !== 0 ||
        price !== 0 ||
        commissionVal !== 0 ||
        logisticsVal !== 0 ||
        adsVal !== 0 ||
        taxVal !== 0 ||
        storageVal !== 0 ||
        returnsVal !== 0 ||
        loyaltyVal !== 0;
      if (!hasMeaningfulValue) {
        skipReasons.noMeaningfulValue++;
        if (skipReasons.noMeaningfulValue <= 3) {
          // eslint-disable-next-line no-console
          console.log(
            LOG,
            `skip row ${i} (no meaningful value):`,
            row.slice(0, 10)
          );
        }
        continue;
      }

      productRowCount++;

      // Per-SKU захват: артикул обязателен (это ключ матчинга с каталогом).
      // Используем уже посчитанные rev/qty этой строки — никаких новых сумм.
      if (articleCol !== null && !isColumnNumberLegendRow(row)) {
        const article = asCellString(row[articleCol]).trim();
        if (article) {
          products.push({
            article,
            name: nameCol !== null ? asCellString(row[nameCol]).trim() : "",
            revenue: rev,
            quantity: qty,
          });
        }
      }

      // Лог + сэмпл первых 5 распознанных строк (с raw-значениями для DEV)
      if (firstParsedRows.length < 5) {
        const sample: ParsedRowSample = {
          rowIdx: i,
          rawRow: row,
          qtyRaw,
          qty,
          priceRaw,
          price,
          revenueRaw,
          revenue: rev,
          commissionRaw,
          commission: commissionVal,
          logistics: logisticsVal,
          storage: storageVal,
          ads: adsVal,
          tax: taxVal,
          returns: returnsVal,
          loyalty: loyaltyVal,
          revenueSource,
        };
        firstParsedRows.push(sample);
        // eslint-disable-next-line no-console
        console.log(LOG, `parsed row ${i}:`, sample);
      }

      totalRevenue += rev;
      totalQty += qty;
      totalReturns += Math.abs(returnsVal);
      totalLoyalty += Math.abs(loyaltyVal);
      totalCommission += Math.abs(commissionVal);
      totalLogistics += Math.abs(logisticsVal);
      totalStorage += Math.abs(storageVal);
      totalAds += Math.abs(adsVal);
      totalTax += Math.abs(taxVal);

      if (price > 0) {
        priceSum += price;
        priceCount++;
      }
    }

    debugInfo.productRowCount = productRowCount;
    debugInfo.rowsParsed = productRowCount;
    debugInfo.skipReasons = skipReasons;
    debugInfo.firstParsedRows = firstParsedRows;

    // ===== Aggregation warnings =====
    if (usedRealizationFallback) {
      aggregationWarnings.push(
        "auto-detect header не сработал — использован hard-coded fallback для отчёта Ozon «Отчет о реализации товара» (header @ row 12, cols qty:7, revenue:5, commission:6)"
      );
      aggregationWarnings.push(
        "price column отсутствует — price вычисляется как revenue / qty"
      );
    }
    if (qtyPriceFallbackCount > 0 && !usedRealizationFallback) {
      aggregationWarnings.push(
        `revenue колонка была 0 в ${qtyPriceFallbackCount} строках — использован fallback qty*price`
      );
    }
    if (totalRevenue === 0) {
      aggregationWarnings.push(
        "totalRevenue = 0 — ни одна строка не дала выручку. Проверьте колонку revenue/price/qty."
      );
    }
    if (
      totalCommission === 0 &&
      colMap.commission !== undefined &&
      totalRevenue > 0
    ) {
      aggregationWarnings.push(
        "totalCommission = 0, хотя колонка комиссии была найдена — все ячейки нули или нечисловые."
      );
    }
    if (
      totalLogistics === 0 &&
      colMap.logistics !== undefined &&
      totalRevenue > 0
    ) {
      aggregationWarnings.push(
        "totalLogistics = 0, хотя колонка логистики была найдена — все ячейки нули или нечисловые."
      );
    }

    debugInfo.aggregationWarnings = aggregationWarnings;

    // eslint-disable-next-line no-console
    console.log(LOG, "aggregation done:", {
      rowsAfterHeader,
      rowsParsed: productRowCount,
      skipReasons,
      qtyPriceFallbackCount,
    });
    // eslint-disable-next-line no-console
    console.log(LOG, "first 5 parsed data rows:");
    // eslint-disable-next-line no-console
    console.table(firstParsedRows);
    // eslint-disable-next-line no-console
    console.log(LOG, "aggregated totals:", {
      totalRevenue,
      totalQty,
      totalCommission,
      totalLogistics,
      totalStorage,
      totalAds,
      totalTax,
      totalReturns,
      totalLoyalty,
    });
    if (aggregationWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(LOG, "aggregation warnings:", aggregationWarnings);
    }

    // Fail только если rowsParsed === 0. Нулевая выручка — НЕ fail-кейс,
    // показываем результат как есть с предупреждениями.
    if (productRowCount === 0) {
      debugInfo.failedAt = "rowsParsed === 0 — no data rows aggregated";
      return finish({
        ok: false,
        report: null,
        error:
          "В отчёте не найдено строк со сделками. Проверьте файл — возможно, он пустой.",
        debugInfo,
      });
    }

    const avgPrice = priceCount > 0 ? priceSum / priceCount : 0;
    const netRevenue = totalRevenue - totalReturns - totalLoyalty;
    const period = parsePeriod(dataRows);
    // eslint-disable-next-line no-console
    console.log(LOG, "period =", period);

    // ===== Totals row extraction =====
    //
    // Приоритеты (строгие):
    //   1. ABSOLUTE TEXT MATCH: ищем строку, где есть слова «итого реализован»
    //      / «всего выплат» во ВСЕХ строках листа. Если найдено — берём
    //      ближайшее число справа от label. Это authoritative source.
    //   2. NUMERIC FALLBACK — только если text match НЕ сработал. Сначала
    //      пробуем totalsRowCandidates (с фильтром ID-like), затем
    //      bottomNumerics (тоже без ID-like).
    //
    // ID-like значения (ИНН, КПП, № заказа — integer ≥ 1e9) исключены ВЕЗДЕ:
    // и из numeric fallback'ов, и из results текстового search.
    const totalsRowCandidates = extractTotalsRows(dataRows);
    const bottomNumerics = extractBottomNumerics(dataRows, 30);
    debugInfo.totalsRowCandidates = totalsRowCandidates;

    // ===== 1. ABSOLUTE PRIORITY: direct text search =====
    const revenueTextHit = findRevenueByText(dataRows);
    const loyaltyTextHit = findLoyaltyByText(dataRows);

    // Сохраняем полные детали best-match в debug для UI
    debugInfo.matchedRevenueTotalDetails = revenueTextHit;
    debugInfo.matchedLoyaltyTotalDetails = loyaltyTextHit;

    let revenueFromTotalsRow: {
      rowIdx: number;
      value: number;
      via: "text" | "puaHeuristic" | "bottomNumericMax";
    } | null = revenueTextHit
      ? {
          rowIdx: revenueTextHit.rowIdx,
          value: revenueTextHit.value,
          via: "text",
        }
      : null;
    let loyaltyPayoutsFromTotalsRow: {
      rowIdx: number;
      value: number;
      via: "text" | "puaHeuristic" | "bottomNumericMax";
    } | null = loyaltyTextHit
      ? {
          rowIdx: loyaltyTextHit.rowIdx,
          value: loyaltyTextHit.value,
          via: "text",
        }
      : null;

    // ===== STRICT POLICY: revenue + loyaltyPayouts могут быть взяты ТОЛЬКО
    // из text-match. Никакого numeric fallback'а (max/ID-like/bottomNumeric)
    // здесь нет — это критично для целостности данных. Если text-match не
    // нашёл «Итого реализовано» — revenueFromTotalsRow остаётся null, и
    // analyzeAllThree вернёт ошибку анализа.
    //
    // Раньше fallback мог выбрать `997750001` (КПП-подобное число, не
    // отфильтрованное isLikelyIdValue), что недопустимо для финансовой логики.
    // bottomNumerics / totalsRowCandidates остаются в debugInfo для DEV-диагностики.
    if (!revenueFromTotalsRow) {
      aggregationWarnings.push(
        "revenue: text-match для «Итого реализовано (за вычетом возвратов)» не сработал. Numeric fallback ОТКЛЮЧЁН (строгая политика). revenue не заполняется."
      );
    }
    if (!loyaltyPayoutsFromTotalsRow) {
      aggregationWarnings.push(
        "loyaltyPayouts: text-match для «Всего выплат от партнёров» не сработал. Numeric fallback ОТКЛЮЧЁН. loyaltyPayouts = 0."
      );
    }

    // eslint-disable-next-line no-console
    console.log(LOG, "revenueTextHit:", revenueTextHit);
    // eslint-disable-next-line no-console
    console.log(LOG, "loyaltyTextHit:", loyaltyTextHit);

    debugInfo.matchedRevenueTotalRowIdx =
      revenueFromTotalsRow?.rowIdx ?? null;
    debugInfo.matchedLoyaltyTotalRowIdx =
      loyaltyPayoutsFromTotalsRow?.rowIdx ?? null;

    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `totalsRowCandidates: ${totalsRowCandidates.length} rows`,
      totalsRowCandidates
    );
    // eslint-disable-next-line no-console
    console.log(
      LOG,
      `bottomNumerics (last 30 rows): ${bottomNumerics.length} positive values`
    );
    if (bottomNumerics.length > 0) {
      // eslint-disable-next-line no-console
      console.table(
        bottomNumerics.map((b) => ({
          rowIdx: b.rowIdx,
          cellIdx: b.cellIdx,
          value: b.value,
          rowPreview: JSON.stringify(b.rowPreview).slice(0, 80),
        }))
      );
    }
    // eslint-disable-next-line no-console
    console.log(LOG, "matched revenue:", revenueFromTotalsRow);
    // eslint-disable-next-line no-console
    console.log(LOG, "matched loyaltyPayouts:", loyaltyPayoutsFromTotalsRow);

    if (totalsRowCandidates.length > 0) {
      // eslint-disable-next-line no-console
      console.table(
        totalsRowCandidates.map((c) => ({
          rowIdx: c.rowIdx,
          labelText: c.labelText.slice(0, 80),
          labelCol: c.labelColIdx,
          value: c.value,
          valueCol: c.valueColIdx,
        }))
      );
    }

    const finalTotals: OzonParsedTotals = {
      revenue: totalRevenue,
      quantity: totalQty,
      returns: totalReturns,
      loyaltyPayouts: totalLoyalty,
      avgPrice,
      netRevenue,
      revenueFromTotalsRow: revenueFromTotalsRow?.value ?? null,
      loyaltyPayoutsFromTotalsRow: loyaltyPayoutsFromTotalsRow?.value ?? null,
    };
    const finalEstimate: OzonEstimate = {
      revenue: totalRevenue,
      commission: totalCommission,
      logistics: totalLogistics,
      storage: totalStorage,
      ads: totalAds,
      tax: totalTax,
      cost: 0,
      other: totalReturns + totalLoyalty,
    };
    debugInfo.finalTotals = finalTotals;
    debugInfo.finalEstimate = finalEstimate;

    const report: OzonParsedReport = {
      marketplace: "ozon",
      detected: true,
      period,
      rowsCount: productRowCount,
      totals: finalTotals,
      estimate: finalEstimate,
      products,
    };

    // eslint-disable-next-line no-console
    console.log(LOG, `per-SKU products captured: ${products.length}`);

    // eslint-disable-next-line no-console
    console.log(LOG, "FINAL ESTIMATE:", finalEstimate);
    // eslint-disable-next-line no-console
    console.log(LOG, "FINAL TOTALS:", finalTotals);

    // === Полный dump первых 5 распарсенных строк (raw + parsed) ===
    // eslint-disable-next-line no-console
    console.log(
      LOG,
      "firstParsedRows[0].rawRow (full):",
      firstParsedRows[0]?.rawRow ?? null
    );
    // eslint-disable-next-line no-console
    console.table(
      firstParsedRows.map((r) => ({
        rowIdx: r.rowIdx,
        rawRow: JSON.stringify(r.rawRow),
        qtyRaw: r.qtyRaw,
        priceRaw: r.priceRaw,
        revenueRaw: r.revenueRaw,
        commissionRaw: r.commissionRaw,
        qty: r.qty,
        price: r.price,
        revenue: r.revenue,
        commission: r.commission,
        revenueSource: r.revenueSource,
      }))
    );

    // === Confidence gate ===
    // Если header confidence низкий — НЕ автозаполняем форму, возвращаем error.
    // debugInfo сохраняется со всеми данными (finalEstimate, firstParsedRows,
    // matchedColumns), пользователь может проверить в [DEV] debug блоке.
    // Это покрывает realization fallback и любой другой случай, когда мы не
    // уверены в правильности column mapping.
    if (debugInfo.selectedHeaderConfidence === "low") {
      debugInfo.failedAt =
        "header confidence low — manual verification needed";
      // eslint-disable-next-line no-console
      console.warn(
        LOG,
        "header confidence is LOW — blocking autofill. Inspect [DEV] debugInfo."
      );
      return finish({
        ok: false,
        report: null,
        error: "Нужно проверить структуру отчёта. Откройте DEV debug.",
        debugInfo,
      });
    }

    // eslint-disable-next-line no-console
    console.log(LOG, "✓ parse ok", report);

    return finish({ ok: true, report, error: null, debugInfo });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "неизвестная ошибка";
    debugInfo.failedAt = `unhandled exception: ${msg}`;
    // eslint-disable-next-line no-console
    console.error(LOG, "unhandled exception:", e);
    return finish({
      ok: false,
      report: null,
      error: `Ошибка при обработке файла: ${msg}`,
      debugInfo,
    });
  }
}
