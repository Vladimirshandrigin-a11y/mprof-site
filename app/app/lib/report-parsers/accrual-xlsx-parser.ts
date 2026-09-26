// ============================================================================
// Парсер XLSX «Отчёт по начислениям» Ozon (PR-1: чистый разбор, без UI,
// сохранения, consume, истории).
//
// Контракт:
//  • лист «Начисления»; строка заголовков ищется по НАЗВАНИЯМ колонок (не по
//    индексу), названия нормализуются (регистр, ё/е, пробелы, знаки . , ; :);
//  • обязательные финансовые колонки: «Дата начисления», «Группа услуг»,
//    «Тип начисления», «Сумма итого, руб.»; обязательные товарные (для
//    полноценного расчёта себестоимости): «Артикул», «SKU», «Название товара»,
//    «Количество» — при отсутствии структурированная ошибка со списком колонок;
//  • суммы — ЦЕЛЫЕ КОПЕЙКИ; пустая/нечисловая сумма — ошибка, НЕ ноль;
//  • строки НЕ дедуплицируются: «ID начисления» у разных строк совпадает (193
//    разных на 1 220 заполненных в июньском отчёте). Колонка НЕобязательная и
//    читается как ссылка операции (row.ref) — номер отправления у товарных строк,
//    номер заказа у эквайринга, иные ID у рекламы/размещения; её наличие
//    сообщается в report.refColumn (разделение результата товара без неё недоступно);
//  • период — по «Дата начисления»; неполный календарный месяц →
//    periodComplete:false + warning (сам по себе НЕ блокирует); отчёт за
//    несколько месяцев — ошибка multiple_months (месячный расчёт неопределён);
//  • сообщения/warnings/ошибки НЕ содержат названий и артикулов товаров.
//
// Кириллица читается через общий reader (xlsx-safe-read.ts): SheetJS 0.18.5
// портит ячейки t="str" — обход вынесен из ozon-parser.ts без изменения логики.
// ============================================================================

import * as XLSX from "xlsx";
import { getSheetRawXml, readXlsxWorkbookSafe } from "./xlsx-safe-read";
import {
  parseMoneyText,
  rublesToKopecks,
  type KopecksParse,
} from "../accrual/money";
import { classifyAccrual, normalizeTaxonomyKey, summarizeAccrualRows } from "../accrual/buckets";
import type { AccrualRow, AccrualSummary } from "../accrual/types";

// ---------------------------------------------------------------------------
// Публичные типы
// ---------------------------------------------------------------------------

export type AccrualParseErrorCode =
  | "file_too_large"
  | "read_failed"
  | "sheet_not_found"
  | "header_not_found"
  | "missing_financial_columns"
  | "missing_product_columns"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_quantity"
  | "no_data_rows"
  | "multiple_months"
  | "read_incomplete";

export interface AccrualParseError {
  code: AccrualParseErrorCode;
  /** Безопасное сообщение для пользователя (без товарных данных). */
  message: string;
  /** Канонические названия отсутствующих колонок (не из файла). */
  columns?: string[];
  /** Номера строк листа (1-based), до 10 первых. */
  rows?: number[];
  /** Сколько строк затронуто. */
  count?: number;
  /** Месяцы YYYY-MM, охваченные отчётом (для multiple_months). */
  months?: string[];
  /** Имена листов файла (для sheet_not_found; до 10, обрезаны). */
  availableSheets?: string[];
}

export type AccrualWarningCode =
  | "period_incomplete"
  | "declared_period_missing"
  | "dates_outside_declared_period"
  | "unknown_taxonomy"
  | "sale_rows_without_article"
  | "amounts_rounded_to_kopecks";

export interface AccrualWarning {
  code: AccrualWarningCode;
  message: string;
  count?: number;
}

export interface AccrualPeriod {
  /** "YYYY-MM" — единственный месяц отчёта. */
  month: string;
  /** Первая/последняя «Дата начисления» в данных, YYYY-MM-DD. */
  dateFrom: string;
  dateTo: string;
  /** Период из строки «Период: ДД.ММ.ГГГГ-ДД.ММ.ГГГГ» над заголовком (YYYY-MM-DD) или null. */
  declaredFrom: string | null;
  declaredTo: string | null;
  /** Отчёт покрывает весь календарный месяц (по declared, иначе по датам данных). */
  periodComplete: boolean;
}

export interface AccrualReport {
  sheetName: string;
  /** В файле есть колонка «ID начисления» (ссылки операций в row.ref). */
  refColumn: boolean;
  /** Номер строки заголовков (1-based). */
  headerRowNumber: number;
  rows: AccrualRow[];
  period: AccrualPeriod;
  summary: AccrualSummary;
}

export type AccrualParseResult =
  | { ok: true; report: AccrualReport; warnings: AccrualWarning[] }
  | { ok: false; errors: AccrualParseError[]; warnings: AccrualWarning[] };

// ---------------------------------------------------------------------------
// Колонки
// ---------------------------------------------------------------------------

const SHEET_NAME = "Начисления";
/** Сколько первых строк листа просматриваем в поисках заголовков. */
const HEADER_SCAN_ROWS = 50;
/** Защита от заведомо не тех файлов. */
const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** Максимум номеров строк в сообщении об ошибке. */
const ROW_SAMPLE = 10;

const FINANCIAL_COLUMNS = [
  { key: "date", label: "Дата начисления" },
  { key: "group", label: "Группа услуг" },
  { key: "type", label: "Тип начисления" },
  { key: "amount", label: "Сумма итого, руб." },
] as const;

const PRODUCT_COLUMNS = [
  { key: "article", label: "Артикул" },
  { key: "sku", label: "SKU" },
  { key: "name", label: "Название товара" },
  { key: "quantity", label: "Количество" },
] as const;

/** Необязательные колонки: отсутствие — не ошибка. */
const OPTIONAL_COLUMNS = [{ key: "ref", label: "ID начисления" }] as const;

type ColKey =
  | (typeof FINANCIAL_COLUMNS)[number]["key"]
  | (typeof PRODUCT_COLUMNS)[number]["key"]
  | (typeof OPTIONAL_COLUMNS)[number]["key"];

/** Нормализация заголовка: регистр, ё/е, пробелы + без знаков . , ; : */
function normHeader(s: string): string {
  return normalizeTaxonomyKey(s).replace(/[.,;:]/g, "").replace(/\s+/g, " ").trim();
}

const HEADER_NORM: Record<ColKey, string> = (() => {
  const o = {} as Record<ColKey, string>;
  for (const c of [...FINANCIAL_COLUMNS, ...PRODUCT_COLUMNS, ...OPTIONAL_COLUMNS]) o[c.key] = normHeader(c.label);
  return o;
})();

// ---------------------------------------------------------------------------
// Ячейки и даты
// ---------------------------------------------------------------------------

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return "";
}

function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // дней в месяце
  if (d > dim) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Excel-serial → YYYY-MM-DD (UTC, время отбрасывается). */
function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  const d = new Date(ms);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Значение ячейки даты → YYYY-MM-DD (serial, Date, ISO, ДД.ММ.ГГГГ). null — не дата. */
function parseDateCell(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return isoDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === "number") return excelSerialToIso(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s.*)?$/.exec(s);
  if (m) return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

function parseAmountCell(v: unknown): KopecksParse | null {
  if (typeof v === "number") return rublesToKopecks(v);
  if (typeof v === "string") return parseMoneyText(v);
  return null;
}

/** Количество штук: конечное число (число или числовая строка); null — пусто/мусор. */
function parseQuantityCell(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^[+\-\u2212]?\s*\d+(?:[.,]\d+)?$/.test(v.trim())) {
    n = Number(v.trim().replace("−", "-").replace(",", ".").replace(/\s+/g, ""));
  } else return null;
  return Number.isFinite(n) ? n + 0 : null;
}

function monthBounds(month: string): { first: string; last: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${pad2(dim)}` };
}

function ruDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** «Период: ДД.ММ.ГГГГ-ДД.ММ.ГГГГ» в строках над заголовком. */
function findDeclaredPeriod(rows: unknown[][], headerIdx: number): { from: string; to: string } | null {
  const re = /период[:\s]*(\d{1,2})[./](\d{1,2})[./](\d{4})\s*[-–—]\s*(\d{1,2})[./](\d{1,2})[./](\d{4})/i;
  for (let r = 0; r < headerIdx && r < 10; r++) {
    for (const c of rows[r] ?? []) {
      if (typeof c !== "string") continue;
      const m = re.exec(c);
      if (!m) continue;
      const from = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
      const to = isoDate(Number(m[6]), Number(m[5]), Number(m[4]));
      if (from && to && from <= to) return { from, to };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Поиск заголовков
// ---------------------------------------------------------------------------

interface HeaderMatch {
  rowIdx: number;
  cols: Partial<Record<ColKey, number>>;
  financialFound: number;
}

function matchHeaderRow(row: unknown[]): { cols: Partial<Record<ColKey, number>>; financialFound: number } {
  const cols: Partial<Record<ColKey, number>> = {};
  for (let c = 0; c < row.length; c++) {
    const v = row[c];
    if (typeof v !== "string") continue;
    const n = normHeader(v);
    if (!n) continue;
    for (const key of Object.keys(HEADER_NORM) as ColKey[]) {
      if (cols[key] === undefined && HEADER_NORM[key] === n) cols[key] = c;
    }
  }
  let financialFound = 0;
  for (const f of FINANCIAL_COLUMNS) if (cols[f.key] !== undefined) financialFound++;
  return { cols, financialFound };
}

function findHeader(rows: unknown[][]): HeaderMatch | null {
  let best: HeaderMatch | null = null;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const m = matchHeaderRow(rows[r] ?? []);
    if (m.financialFound === FINANCIAL_COLUMNS.length) {
      return { rowIdx: r, cols: m.cols, financialFound: m.financialFound };
    }
    if (m.financialFound >= 2 && (!best || m.financialFound > best.financialFound)) {
      best = { rowIdx: r, cols: m.cols, financialFound: m.financialFound };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Контроль полноты чтения (страховка от тихой потери строк)
// ---------------------------------------------------------------------------

/**
 * Число строк сырого XML листа, в которых есть хотя бы одно непустое значение
 * (<v>…</v> с текстом или <is><t>…</t></is>). Считается независимо от SheetJS —
 * сверяется с числом непустых строк, которые вернул SheetJS: расхождение значит,
 * что часть строк потеряна при чтении (например, неверный <dimension>), и
 * молча считать по неполным данным нельзя.
 */
function countRawNonEmptyRows(xml: string): number {
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml)) !== null) {
    const body = m[1];
    if (!body) continue;
    const hasValue = /<v>\s*[^<\s][^<]*<\/v>/.test(body);
    const hasInlineText = /<is\b[^>]*>[\s\S]*?<t\b[^>]*>\s*[^<\s]/.test(body);
    if (hasValue || hasInlineText) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Разбор листа
// ---------------------------------------------------------------------------

function sampleRows(rows: number[]): number[] {
  return rows.slice(0, ROW_SAMPLE);
}

export function parseAccrualWorkbook(workbook: XLSX.WorkBook): AccrualParseResult {
  const warnings: AccrualWarning[] = [];
  const fail = (...errors: AccrualParseError[]): AccrualParseResult => ({
    ok: false,
    errors,
    warnings,
  });

  // 1) Лист «Начисления».
  const sheetName = workbook.SheetNames.find(
    (n) => normalizeTaxonomyKey(n) === normalizeTaxonomyKey(SHEET_NAME)
  );
  if (!sheetName) {
    return fail({
      code: "sheet_not_found",
      message: `В файле нет листа «${SHEET_NAME}». Загрузите XLSX «Отчёт по начислениям» из личного кабинета Ozon.`,
      availableSheets: workbook.SheetNames.slice(0, 10).map((n) => n.slice(0, 60)),
    });
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet["!ref"]) {
    return fail({ code: "header_not_found", message: `Лист «${SHEET_NAME}» пуст.` });
  }
  const rowOffset = XLSX.utils.decode_range(sheet["!ref"]).s.r; // 0-based первая строка диапазона
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  }) as unknown[][];

  // 2) Заголовки.
  const header = findHeader(rows);
  if (!header) {
    return fail({
      code: "header_not_found",
      message:
        "Не найдена строка заголовков отчёта по начислениям. Проверьте, что это XLSX «Отчёт по начислениям».",
    });
  }
  const errors: AccrualParseError[] = [];
  const missingFin = FINANCIAL_COLUMNS.filter((c) => header.cols[c.key] === undefined).map((c) => c.label);
  if (missingFin.length > 0) {
    errors.push({
      code: "missing_financial_columns",
      message: `В отчёте нет обязательных колонок: ${missingFin.map((c) => `«${c}»`).join(", ")}.`,
      columns: missingFin,
    });
  }
  const missingProd = PRODUCT_COLUMNS.filter((c) => header.cols[c.key] === undefined).map((c) => c.label);
  if (missingProd.length > 0) {
    errors.push({
      code: "missing_product_columns",
      message:
        `В отчёте нет товарных колонок: ${missingProd.map((c) => `«${c}»`).join(", ")}. ` +
        "Без них нельзя посчитать себестоимость и прибыль по товарам — скачайте полный отчёт по начислениям.",
      columns: missingProd,
    });
  }
  if (errors.length > 0) return fail(...errors);

  const col = header.cols as Record<ColKey, number>;
  const refIdx = header.cols.ref;
  const declared = findDeclaredPeriod(rows, header.rowIdx);

  // 3) Строки данных.
  const out: AccrualRow[] = [];
  const badAmount: number[] = [];
  const badDate: number[] = [];
  const badQty: number[] = [];
  let badAmountCount = 0;
  let badDateCount = 0;
  let badQtyCount = 0;
  let roundedCount = 0;
  // Непустые строки листа (преамбула + заголовок + данные) — для сверки с сырым XML.
  let parsedNonBlank = 0;
  for (let r = 0; r <= header.rowIdx; r++) {
    if ((rows[r] ?? []).some((c) => !isBlankCell(c))) parsedNonBlank++;
  }

  for (let r = header.rowIdx + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((c) => isBlankCell(c))) continue; // полностью пустая строка
    parsedNonBlank++;
    const rowNumber = rowOffset + r + 1;

    const amount = parseAmountCell(row[col.amount]);
    if (!amount) {
      badAmountCount++;
      badAmount.push(rowNumber);
    } else if (!amount.exact) roundedCount++;

    const date = parseDateCell(row[col.date]);
    if (!date) {
      badDateCount++;
      badDate.push(rowNumber);
    }

    const group = cellText(row[col.group]);
    const type = cellText(row[col.type]);
    const cls = classifyAccrual(group, type);

    const quantity = parseQuantityCell(row[col.quantity]);
    if (cls.bucket === "salesRevenue" || cls.bucket === "returnsRevenue") {
      // Себестоимость считается ТОЛЬКО по этим строкам — количество обязано быть
      // конечным целым числом (пустое/дробное/мусор — ошибка, а не 0).
      if (quantity === null || !Number.isInteger(quantity)) {
        badQtyCount++;
        badQty.push(rowNumber);
      }
    }

    if (amount && date) {
      out.push({
        rowNumber,
        date,
        group,
        type,
        bucket: cls.bucket,
        knownTaxonomy: cls.known,
        article: cellText(row[col.article]),
        sku: cellText(row[col.sku]),
        name: cellText(row[col.name]),
        quantity,
        amountKopecks: amount.kopecks,
        ...(refIdx !== undefined ? { ref: cellText(row[refIdx]) } : {}),
      });
    }
  }

  const rowErrors: AccrualParseError[] = [];
  if (badAmountCount > 0) {
    rowErrors.push({
      code: "invalid_amount",
      message: `В колонке «Сумма итого, руб.» пустые или нечисловые значения (строк: ${badAmountCount}). Такие строки нельзя считать нулём — расчёт остановлен.`,
      rows: sampleRows(badAmount),
      count: badAmountCount,
    });
  }
  if (badDateCount > 0) {
    rowErrors.push({
      code: "invalid_date",
      message: `В колонке «Дата начисления» пустые или нераспознанные даты (строк: ${badDateCount}) — период отчёта определить нельзя.`,
      rows: sampleRows(badDate),
      count: badDateCount,
    });
  }
  if (badQtyCount > 0) {
    rowErrors.push({
      code: "invalid_quantity",
      message: `В строках «Выручка»/«Возврат выручки» пустое или нецелое «Количество» (строк: ${badQtyCount}) — себестоимость по ним посчитать нельзя.`,
      rows: sampleRows(badQty),
      count: badQtyCount,
    });
  }
  if (rowErrors.length > 0) return fail(...rowErrors);

  if (out.length === 0) {
    return fail({ code: "no_data_rows", message: "В отчёте по начислениям нет строк с данными." });
  }

  // 4) Контроль полноты чтения (независимый счёт строк сырого XML).
  const rawXml = getSheetRawXml(workbook, sheetName);
  if (rawXml !== null) {
    const rawRows = countRawNonEmptyRows(rawXml);
    if (rawRows !== parsedNonBlank) {
      return fail({
        code: "read_incomplete",
        message:
          "Файл прочитан не полностью (число строк не сошлось с исходным файлом). Скачайте отчёт заново из личного кабинета Ozon и загрузите ещё раз.",
      });
    }
  }

  // 5) Период.
  let minDate = out[0].date;
  let maxDate = out[0].date;
  const months = new Set<string>();
  for (const r of out) {
    if (r.date < minDate) minDate = r.date;
    if (r.date > maxDate) maxDate = r.date;
    months.add(r.date.slice(0, 7));
  }
  if (declared) {
    months.add(declared.from.slice(0, 7));
    months.add(declared.to.slice(0, 7));
  }
  if (months.size > 1) {
    const list = Array.from(months).sort();
    return fail({
      code: "multiple_months",
      message: `Отчёт охватывает несколько месяцев (${list.join(", ")}). Скачайте отчёт за один календарный месяц.`,
      months: list,
    });
  }
  const month = Array.from(months)[0];
  const bounds = monthBounds(month);
  const rangeFrom = declared ? declared.from : minDate;
  const rangeTo = declared ? declared.to : maxDate;
  const periodComplete = rangeFrom === bounds.first && rangeTo === bounds.last;

  if (!periodComplete) {
    warnings.push({
      code: "period_incomplete",
      message: `Отчёт охватывает не весь календарный месяц (${ruDate(rangeFrom)} — ${ruDate(rangeTo)}), итоги неполные.`,
    });
  }
  if (!declared) {
    warnings.push({
      code: "declared_period_missing",
      message:
        "В отчёте не найдена строка «Период: …»; полнота месяца определена по датам начислений и может быть неточной.",
    });
  } else {
    const outside = out.filter((r) => r.date < declared.from || r.date > declared.to).length;
    if (outside > 0) {
      warnings.push({
        code: "dates_outside_declared_period",
        message: `Есть начисления с датой вне заявленного периода отчёта (строк: ${outside}).`,
        count: outside,
      });
    }
  }

  // 6) Итоги и предупреждения по содержимому.
  const summary = summarizeAccrualRows(out);
  if (summary.unknownTaxonomyRows > 0) {
    warnings.push({
      code: "unknown_taxonomy",
      message: `Есть начисления неизвестных типов (строк: ${summary.unknownTaxonomyRows}) — они учтены в итоге и показаны в группе «Прочее».`,
      count: summary.unknownTaxonomyRows,
    });
  }
  if (summary.saleReturnRowsWithoutArticle > 0) {
    warnings.push({
      code: "sale_rows_without_article",
      message: `Есть строки «Выручка»/«Возврат выручки» без артикула (строк: ${summary.saleReturnRowsWithoutArticle}) — себестоимость по ним не посчитать, итог будет предварительным.`,
      count: summary.saleReturnRowsWithoutArticle,
    });
  }
  if (roundedCount > 0) {
    warnings.push({
      code: "amounts_rounded_to_kopecks",
      message: `Суммы с долями копейки округлены до копейки (строк: ${roundedCount}).`,
      count: roundedCount,
    });
  }

  return {
    ok: true,
    report: {
      sheetName,
      headerRowNumber: rowOffset + header.rowIdx + 1,
      refColumn: refIdx !== undefined,
      rows: out,
      period: {
        month,
        dateFrom: minDate,
        dateTo: maxDate,
        declaredFrom: declared ? declared.from : null,
        declaredTo: declared ? declared.to : null,
        periodComplete,
      },
      summary,
    },
    warnings,
  };
}

/** Разбор XLSX из буфера: чтение с обходом бага SheetJS + parseAccrualWorkbook. */
export function parseAccrualXlsxBuffer(data: ArrayBuffer | Uint8Array): AccrualParseResult {
  if (data.byteLength > MAX_FILE_BYTES) {
    return {
      ok: false,
      warnings: [],
      errors: [
        {
          code: "file_too_large",
          message: "Файл слишком большой для отчёта по начислениям.",
        },
      ],
    };
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = readXlsxWorkbookSafe(data).workbook;
  } catch {
    return {
      ok: false,
      warnings: [],
      errors: [
        {
          code: "read_failed",
          message: "Не удалось прочитать файл. Загрузите отчёт в формате XLSX, скачанный из личного кабинета Ozon.",
        },
      ],
    };
  }
  return parseAccrualWorkbook(workbook);
}

/** Разбор XLSX-файла из браузера (File/Blob). */
export async function parseAccrualXlsx(file: Blob): Promise<AccrualParseResult> {
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      warnings: [],
      errors: [{ code: "file_too_large", message: "Файл слишком большой для отчёта по начислениям." }],
    };
  }
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    return {
      ok: false,
      warnings: [],
      errors: [{ code: "read_failed", message: "Не удалось прочитать файл." }],
    };
  }
  return parseAccrualXlsxBuffer(buf);
}
