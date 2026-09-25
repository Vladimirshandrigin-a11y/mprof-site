/**
 * Общий безопасный reader XLSX для парсеров отчётов Ozon.
 *
 * Зачем: SheetJS 0.18.5 портит ячейки `<c t="str">` — Unicode-символы выше
 * U+00FF обрезаются до младшего байта (кириллица превращается в мусор), из-за
 * чего теряются ВСЕ текстовые подписи/заголовки отчёта (Ozon кладёт их именно в
 * `t="str"`). Обход — перечитать сырой XML листа и восстановить значения. Он
 * был внутри `ozon-parser.ts`; здесь вынесен БЕЗ изменения логики, чтобы им
 * пользовались и парсер отчёта реализации, и парсер отчёта по начислениям
 * (`accrual-xlsx-parser.ts`) — одна реализация, а не две копии.
 *
 * Три функции ниже перенесены из `ozon-parser.ts` дословно (добавлен только
 * `export`). {@link readXlsxWorkbookSafe} — тонкая обёртка для новых
 * потребителей; старый парсер продолжает вызывать `XLSX.read` +
 * `patchAllStrCells` сам (свои сообщения об ошибках/debug), поведение не
 * менялось.
 */

import * as XLSX from "xlsx";

/**
 * Decode XML numeric character references and the five predefined entities.
 * Used to recover original text from `<v>...</v>` payloads of `t="str"` cells
 * that SheetJS 0.18.5 corrupts (see {@link patchStrCellsFromRawXml}).
 */
export function decodeXmlEntities(s: string): string {
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
export function patchStrCellsFromRawXml(
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
export function patchAllStrCells(workbook: XLSX.WorkBook): {
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

/**
 * Прочитать XLSX и сразу исправить `t="str"`-ячейки (см. выше). Бросает
 * исключение, если файл не читается (вызывающий код превращает его в
 * структурированную ошибку). `bookFiles: true` обязателен — иначе сырые
 * XML-части листов недоступны и обход невозможен.
 */
export function readXlsxWorkbookSafe(data: ArrayBuffer | Uint8Array): {
  workbook: XLSX.WorkBook;
  strPatch: { patchedPerSheet: Record<string, number>; total: number };
} {
  const workbook = XLSX.read(data, { type: "array", bookFiles: true });
  const strPatch = patchAllStrCells(workbook);
  return { workbook, strPatch };
}

/**
 * Сырой XML листа по имени (нужен `XLSX.read(..., { bookFiles: true })`, т.е.
 * `readXlsxWorkbookSafe`). null — сырых частей нет / лист не найден. Порядок
 * `wb.Directory.sheets` совпадает с `wb.SheetNames` (как в patchAllStrCells).
 */
export function getSheetRawXml(
  workbook: XLSX.WorkBook,
  sheetName: string
): string | null {
  const files = (workbook as XLSX.WorkBook & {
    files?: Record<string, { content?: Uint8Array | Buffer }>;
  }).files;
  const dirSheets = (workbook as XLSX.WorkBook & {
    Directory?: { sheets?: string[] };
  }).Directory?.sheets;
  if (!files || !dirSheets) return null;
  const i = workbook.SheetNames.indexOf(sheetName);
  if (i < 0) return null;
  const rawPath = dirSheets[i];
  if (!rawPath) return null;
  const content = files[rawPath.replace(/^\/+/, "")]?.content;
  if (!content) return null;
  return new TextDecoder("utf-8").decode(
    content instanceof Uint8Array ? content : new Uint8Array(content)
  );
}
