// Сборка СИНТЕТИЧЕСКИХ XLSX «в стиле Ozon» прямо в памяти (без файлов, Python и
// реальных данных): ячейки без r-атрибутов, строки как t="str" с числовыми
// ссылками &#x…; (именно они ломают SheetJS 0.18.5), даты — Excel-serial без t,
// числа t="n". Плюс «Excel-style» вариант (r-атрибуты, sharedStrings,
// корректный dimension, пустые self-closing строки).
//
// Модель значения ячейки:
//   null             — пустая ячейка
//   "текст"          — строка (в режиме "str" → t="str", в режиме "sst" → sharedStrings)
//   число            — t="n"
//   { date: "ГГГГ-ММ-ДД" } — дата (Excel-serial без t)
//   { n: "1.50" }    — число, записанное КАК ТЕКСТ в <v> (точное представление)
//   { txt: "…" }     — строка t="str" (даже в режиме "sst")
//   EMPTY            — t="str" с пустым <v> (как у Ozon в незаполненных ячейках)

import { zipStore } from "./zip.mjs";

export const EMPTY = { emptyStr: true };
export const D = (iso) => ({ date: iso });
export const N = (s) => ({ n: String(s) });
export const TXT = (s) => ({ txt: s });

export function escText(s) {
  let out = "";
  for (const ch of s) {
    const o = ch.codePointAt(0);
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (o > 127) out += `&#x${o.toString(16).toUpperCase()};`;
    else out += ch;
  }
  return out;
}

/** Excel-serial (дней от 1899-12-30) для ГГГГ-ММ-ДД. */
export function serial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function ozonCell(v, mode, sst) {
  if (v === null || v === undefined) return '<c s="3"></c>';
  if (typeof v === "number") return `<c t="n" s="10"><v>${v}</v></c>`;
  if (typeof v === "object") {
    if ("date" in v) return `<c s="6"><v>${serial(v.date)}</v></c>`;
    if ("n" in v) return `<c t="n" s="10"><v>${v.n}</v></c>`;
    if ("txt" in v) return `<c t="str" s="7"><v>${escText(v.txt)}</v></c>`;
    if ("emptyStr" in v) return '<c t="str" s="7"><v></v></c>';
    throw new Error("unknown cell kind");
  }
  if (mode === "sst") {
    if (!sst.idx.has(v)) {
      sst.idx.set(v, sst.list.length);
      sst.list.push(v);
    }
    return `<c t="s" s="7"><v>${sst.idx.get(v)}</v></c>`;
  }
  return `<c t="str" s="7"><v>${escText(v)}</v></c>`;
}

const CT_OZON =
  '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" /><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" PartName="/xl/sharedStrings.xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
const RELS_OZON =
  '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="R1" /></Relationships>';
const WBRELS_OZON =
  '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="sheet1"/><Relationship Id="styles1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" /><Relationship Id="sharedStrings1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml" /></Relationships>';

function stylesXml() {
  const xfs = Array.from(
    { length: 11 },
    (_, i) => `<xf numFmtId="${i === 6 ? 164 : 0}" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  ).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.MM.yyyy"/></numFmts><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11">' +
    xfs +
    "</cellXfs></styleSheet>"
  );
}

function sstXml(list) {
  return `<?xml version="1.0" encoding="utf-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${list
    .map((s) => `<si><t>${escText(s)}</t></si>`)
    .join("")}</sst>`;
}

/**
 * XLSX «как у Ozon»: строки без r-атрибутов, t="str" (mode "str") или sharedStrings
 * (mode "sst"). rows — массив строк-массивов значений (см. модель выше).
 */
export function buildOzonStyleXlsx(rows, { mode = "str", sheetName = "Начисления", dimension = null } = {}) {
  const sst = { idx: new Map(), list: [] };
  const body = rows
    .map((r) => `<row ht="19.5" customHeight="1">${r.map((v) => ozonCell(v, mode, sst)).join("")}</row>`)
    .join("");
  const dim = dimension ? `<dimension ref="${dimension}"/>` : "";
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${dim}<sheetData>${body}</sheetData></worksheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="${escText(sheetName)}" sheetId="1" r:id="sheet1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;
  return zipStore([
    { name: "[Content_Types].xml", data: CT_OZON },
    { name: "_rels/.rels", data: RELS_OZON },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: WBRELS_OZON },
    { name: "xl/styles.xml", data: stylesXml() },
    { name: "xl/sharedStrings.xml", data: sstXml(sst.list) },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

function colLetter(i) {
  let s = "";
  let n = i + 1;
  while (n) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * XLSX «как после Excel»: r-атрибуты у строк и ячеек, только sharedStrings,
 * корректный dimension, пустые строки — self-closing `<row r="N"/>` (null).
 */
export function buildExcelStyleXlsx(rows, sheetName = "Начисления") {
  const idx = new Map();
  const list = [];
  const sstRef = (s) => {
    if (!idx.has(s)) {
      idx.set(s, list.length);
      list.push(s);
    }
    return idx.get(s);
  };
  const body = rows
    .map((r, i) => {
      const ri = i + 1;
      if (r === null) return `<row r="${ri}"/>`;
      const cells = [];
      r.forEach((v, ci) => {
        const ref = `${colLetter(ci)}${ri}`;
        if (v === null || v === undefined) return;
        if (typeof v === "number") cells.push(`<c r="${ref}" t="n"><v>${v}</v></c>`);
        else if (typeof v === "object") {
          if ("date" in v) cells.push(`<c r="${ref}" s="6"><v>${serial(v.date)}</v></c>`);
          else if ("n" in v) cells.push(`<c r="${ref}" t="n"><v>${v.n}</v></c>`);
          else if ("txt" in v) cells.push(`<c r="${ref}" t="s"><v>${sstRef(v.txt)}</v></c>`);
          // EMPTY — в Excel-стиле пустая ячейка просто отсутствует
        } else cells.push(`<c r="${ref}" t="s"><v>${sstRef(v)}</v></c>`);
      });
      return `<row r="${ri}">${cells.join("")}</row>`;
    })
    .join("");
  const ncols = Math.max(...rows.filter(Boolean).map((r) => r.length));
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colLetter(ncols - 1)}${rows.length}"/><sheetData>${body}</sheetData></worksheet>`;
  const ct =
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escText(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbrels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
  return zipStore([
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: wb },
    { name: "xl/_rels/workbook.xml.rels", data: wbrels },
    { name: "xl/sharedStrings.xml", data: sstXml(list) },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
