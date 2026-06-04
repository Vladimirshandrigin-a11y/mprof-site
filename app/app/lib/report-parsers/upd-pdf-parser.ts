"use client";

/**
 * Парсер УПД (универсальный передаточный документ) в формате PDF.
 *
 * УПД от Ozon содержит таблицу с услугами/комиссиями и итоговую строку
 * «Всего к оплате», в которой колонка 9 — сумма с НДС. Эта сумма — то, что
 * мы списываем как РАСХОД.
 *
 * Стратегия:
 *  1. Загружаем PDF через pdfjs-dist (с отключённым worker'ом для простоты).
 *  2. Извлекаем все текстовые элементы с координатами x/y.
 *  3. Группируем в строки по y-координате (близкие y → одна строка).
 *  4. Ищем строку, содержащую «Всего к оплате».
 *  5. На этой строке находим все числовые значения.
 *  6. Берём самое правое число — это, как правило, итог с НДС (col 9).
 *  7. Возвращаем сумму + полный debugInfo для диагностики.
 *
 * Никогда не бросает — всегда `ParseResult` с `ok: false` и человекочитаемым
 * `error` при провале.
 */

// pdfjs-dist v5 импортируется ДИНАМИЧЕСКИ внутри parseUpdPdf — иначе
// Next.js пытается выполнить его при SSR/prerender и падает на
// `DOMMatrix is not defined` (это браузерный API).

const LOG = "[upd-parser]";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsLib = any;

// ============================================================================
// Public types
// ============================================================================

export interface UpdParsedReport {
  type: "upd";
  detected: true;
  /** Итоговая сумма (с НДС) — то, что списываем как расход. */
  totalAmount: number;
  /** Полный текст строки «Всего к оплате», на которой нашли сумму. */
  detectedRowText: string;
  /** Все числа на этой строке (для отладки). */
  rowNumbers: number[];
  /** Откуда взяли значение. */
  source: "rightmost-on-row" | "column-9" | "fallback-largest";
}

export interface UpdRowDebug {
  pageNum: number;
  y: number;
  cells: Array<{ x: number; text: string }>;
  joinedText: string;
}

export interface UpdDebugInfo {
  fileName: string;
  fileSize: number;
  pageCount: number;
  /** Первые 60 строк документа (для визуального скана). */
  firstRows: UpdRowDebug[];
  /** Все кандидаты на строку «Всего к оплате». */
  totalRowCandidates: Array<{
    pageNum: number;
    y: number;
    rowText: string;
    numbers: number[];
  }>;
  selectedRow: {
    pageNum: number;
    y: number;
    rowText: string;
    pickedValue: number;
    pickedAt: "rightmost-on-row" | "column-9" | "fallback-largest";
  } | null;
  failedAt: string | null;
}

export interface UpdParseResult {
  ok: boolean;
  report: UpdParsedReport | null;
  error: string | null;
  debugInfo: UpdDebugInfo;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Простой safeNumber для PDF: парсит «12 345,67», «12345.67», «12,345.67»,
 * учитывает NBSP, валюту. Возвращает 0 для не-числа.
 *
 * Дублируем логику asNumber из ozon-parser.ts — у PDF свой контекст.
 */
function asNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  let s = v.trim();
  if (!s) return 0;

  let negative = false;
  if (/^\(.+\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  s = s.replace(/[^\d.,]/g, "");
  if (!s) return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;

  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized =
        s.slice(0, lastComma).replace(/[.,]/g, "") + "." + s.slice(lastComma + 1);
    } else {
      normalized =
        s.slice(0, lastDot).replace(/[.,]/g, "") + "." + s.slice(lastDot + 1);
    }
  } else if (lastComma >= 0) {
    const tail = s.length - lastComma - 1;
    if (tail >= 1 && tail <= 2) {
      normalized = s.slice(0, lastComma).replace(/,/g, "") + "." + s.slice(lastComma + 1);
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else {
    const tail = s.length - lastDot - 1;
    if (tail >= 1 && tail <= 2) {
      normalized = s.slice(0, lastDot).replace(/\./g, "") + "." + s.slice(lastDot + 1);
    } else {
      normalized = s.replace(/\./g, "");
    }
  }
  if (!normalized || normalized === "." || normalized === "-") return 0;
  const n = parseFloat(normalized);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

interface PdfTextItem {
  pageNum: number;
  x: number;
  y: number;
  text: string;
}

/** Сгруппировать текстовые элементы в строки по y-координате. */
function groupIntoRows(items: PdfTextItem[]): UpdRowDebug[] {
  // Сортируем: страница → -y (top to bottom) → x (left to right)
  const sorted = [...items].sort((a, b) => {
    if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
    if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });

  const rows: UpdRowDebug[] = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (
      last &&
      last.pageNum === item.pageNum &&
      Math.abs(last.y - item.y) <= 3
    ) {
      last.cells.push({ x: item.x, text: item.text });
    } else {
      rows.push({
        pageNum: item.pageNum,
        y: item.y,
        cells: [{ x: item.x, text: item.text }],
        joinedText: "",
      });
    }
  }
  // Финализируем joinedText
  for (const row of rows) {
    row.joinedText = row.cells
      .map((c) => c.text.trim())
      .filter((t) => t.length > 0)
      .join(" ");
  }
  return rows;
}

// ============================================================================
// Public API
// ============================================================================

let pdfjsLibPromise: Promise<PdfjsLib> | null = null;

async function loadPdfjs(): Promise<PdfjsLib> {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const mod = await import("pdfjs-dist");
      // Worker подгружается с CDN — Next.js / Turbopack не должен бандлить его.
      try {
        const version = mod.version;
        mod.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
      } catch {
        // ignore
      }
      return mod;
    })();
  }
  return pdfjsLibPromise;
}

export async function parseUpdPdf(file: File): Promise<UpdParseResult> {
  const debugInfo: UpdDebugInfo = {
    fileName: file.name,
    fileSize: file.size,
    pageCount: 0,
    firstRows: [],
    totalRowCandidates: [],
    selectedRow: null,
    failedAt: null,
  };

  // eslint-disable-next-line no-console
  console.log(LOG, "→ parseUpdPdf start", {
    name: file.name,
    size: file.size,
  });

  const finish = (result: UpdParseResult): UpdParseResult => {
    // eslint-disable-next-line no-console
    console.log(LOG, "RETURN", {
      ok: result.ok,
      error: result.error,
      totalAmount: result.report?.totalAmount ?? null,
      failedAt: result.debugInfo.failedAt,
    });
    return result;
  };

  try {
    const data = await file.arrayBuffer();
    const pdfjsLib = await loadPdfjs();

    // pdfjs-dist getDocument возвращает loading task; ждём promise
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(data),
      verbosity: 0,
    }).promise;

    debugInfo.pageCount = pdf.numPages;
    // eslint-disable-next-line no-console
    console.log(LOG, "pageCount =", pdf.numPages);

    // Извлекаем все текстовые элементы со всех страниц
    const items: PdfTextItem[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      for (const it of textContent.items) {
        // TextItem имеет str + transform[4..5] = x, y
        const item = it as { str?: string; transform?: number[] };
        if (typeof item.str !== "string") continue;
        if (!item.str.trim()) continue;
        const t = item.transform;
        if (!Array.isArray(t) || t.length < 6) continue;
        items.push({
          pageNum,
          x: t[4],
          y: t[5],
          text: item.str,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log(LOG, `extracted ${items.length} text items`);

    const rows = groupIntoRows(items);
    debugInfo.firstRows = rows.slice(0, 60);
    // eslint-disable-next-line no-console
    console.log(LOG, `grouped into ${rows.length} rows`);
    // eslint-disable-next-line no-console
    console.log(LOG, "first 15 rows:");
    // eslint-disable-next-line no-console
    console.table(
      rows.slice(0, 15).map((r) => ({
        page: r.pageNum,
        y: Math.round(r.y),
        text: r.joinedText.slice(0, 120),
      }))
    );

    // Ищем строки, содержащие «Всего к оплате»
    const candidates: typeof debugInfo.totalRowCandidates = [];
    for (const row of rows) {
      if (!/всего\s+к\s+оплате/i.test(row.joinedText)) continue;
      // Извлекаем все числа из ячеек этой строки
      const numbers: number[] = [];
      for (const cell of row.cells) {
        const n = asNumber(cell.text);
        if (n !== 0) numbers.push(n);
      }
      candidates.push({
        pageNum: row.pageNum,
        y: row.y,
        rowText: row.joinedText,
        numbers,
      });
    }
    debugInfo.totalRowCandidates = candidates;
    // eslint-disable-next-line no-console
    console.log(LOG, `total row candidates: ${candidates.length}`, candidates);

    if (candidates.length === 0) {
      debugInfo.failedAt = "no «Всего к оплате» row found";
      // eslint-disable-next-line no-console
      console.warn(LOG, "no «Всего к оплате» row. First 30 rows for diagnosis:");
      // eslint-disable-next-line no-console
      console.table(
        rows.slice(0, 30).map((r) => ({
          page: r.pageNum,
          y: Math.round(r.y),
          text: r.joinedText.slice(0, 160),
        }))
      );
      return finish({
        ok: false,
        report: null,
        error: "Не найдена строка «Всего к оплате» в PDF.",
        debugInfo,
      });
    }

    // Берём ПОСЛЕДНЕГО кандидата (обычно итог в конце документа)
    const chosen = candidates[candidates.length - 1];

    if (chosen.numbers.length === 0) {
      debugInfo.failedAt = "«Всего к оплате» row has no numeric values";
      return finish({
        ok: false,
        report: null,
        error:
          "В строке «Всего к оплате» не найдено числовых значений.",
        debugInfo,
      });
    }

    // Эвристика выбора значения:
    // — Если 9+ чисел: берём 9-е (счёт с 1) → col 9 «Стоимость с налогом, всего».
    // — Иначе: берём максимальное (типично столбец с НДС итог).
    // Сортировка нужна по x, а не по value, чтобы соответствовать табличной структуре.
    const numbersSortedByX = [...chosen.numbers]; // numbers собирались в порядке x (cells sorted)
    let pickedValue: number;
    let pickedAt: "rightmost-on-row" | "column-9" | "fallback-largest";

    if (numbersSortedByX.length >= 9) {
      pickedValue = numbersSortedByX[8]; // 9-е (zero-indexed 8)
      pickedAt = "column-9";
    } else if (numbersSortedByX.length > 0) {
      // Самое правое (последнее в списке после x-sort) — обычно итог с НДС
      pickedValue = numbersSortedByX[numbersSortedByX.length - 1];
      pickedAt = "rightmost-on-row";
    } else {
      pickedValue = 0;
      pickedAt = "fallback-largest";
    }

    // Защита: если выбранное значение подозрительно маленькое,
    // а в строке есть значительно большие — берём максимальное (вероятно, общий итог).
    const max = Math.max(...numbersSortedByX);
    if (pickedValue < max * 0.5 && max > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        LOG,
        `picked value ${pickedValue} suspiciously small vs max ${max} — switching to max`
      );
      pickedValue = max;
      pickedAt = "fallback-largest";
    }

    debugInfo.selectedRow = {
      pageNum: chosen.pageNum,
      y: chosen.y,
      rowText: chosen.rowText,
      pickedValue,
      pickedAt,
    };

    // eslint-disable-next-line no-console
    console.log(LOG, "selected row:", debugInfo.selectedRow);
    // eslint-disable-next-line no-console
    console.log(LOG, "row numbers (by x):", numbersSortedByX);

    return finish({
      ok: true,
      error: null,
      report: {
        type: "upd",
        detected: true,
        totalAmount: pickedValue,
        detectedRowText: chosen.rowText,
        rowNumbers: chosen.numbers,
        source: pickedAt,
      },
      debugInfo,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugInfo.failedAt = `unhandled exception: ${msg}`;
    // eslint-disable-next-line no-console
    console.error(LOG, "unhandled exception:", e);
    return finish({
      ok: false,
      report: null,
      error: `Ошибка при обработке PDF: ${msg}`,
      debugInfo,
    });
  }
}
