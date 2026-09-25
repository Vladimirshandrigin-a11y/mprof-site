// Общий XLSX-reader (xlsx-safe-read.ts) и СТАРЫЙ парсер отчёта реализации
// (ozon-parser.ts, который теперь импортирует обход бага SheetJS из общего
// модуля). Синтетические файлы: подписи — t="str" с числовыми ссылками, без
// r-атрибутов, как у Ozon. Ожидания по старому парсеру — независимые: значения
// заданы в самом фикстуре (helpers/realization-fixture.mjs).

import assert from "node:assert/strict";
import { File } from "node:buffer";
import { before, describe, it } from "node:test";
import { HEADER16, scenario } from "./helpers/fixtures.mjs";
import { REALIZATION_PRODUCTS, buildRealizationXlsx } from "./helpers/realization-fixture.mjs";
import { XLSX, oldParser, quietly, safeRead } from "./helpers/modules.mjs";

const rowsOf = (workbook) =>
  XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: true });

describe("decodeXmlEntities", () => {
  it("числовые ссылки (hex/dec) и предопределённые сущности", () => {
    assert.equal(safeRead.decodeXmlEntities("&#x41F;&#1088;&#x438;&amp;&lt;&gt;&quot;&apos;"), "При&<>\"'");
  });
  it("&amp;#x41F; остаётся литералом «&#x41F;» (числовые ссылки раскрываются до &amp;)", () => {
    assert.equal(safeRead.decodeXmlEntities("&amp;#x41F;"), "&#x41F;");
  });
});

describe("readXlsxWorkbookSafe: t=\"str\" с кириллицей", () => {
  const buf = scenario("basic");
  const plain = XLSX.read(buf, { type: "array" });
  const safe = safeRead.readXlsxWorkbookSafe(buf);

  it("без обхода SheetJS 0.18.5 портит кириллицу (обход действительно нужен)", () => {
    const headerPlain = rowsOf(plain)[1];
    assert.notEqual(headerPlain[3], "Тип начисления");
  });
  it("с обходом заголовки и значения читаются точно", () => {
    const rows = rowsOf(safe.workbook);
    assert.deepEqual(rows[1], HEADER16); // строка заголовков (после строки «Период»)
    assert.equal(rows[2][2], "Продажи");
    assert.equal(rows[2][3], "Выручка");
    assert.equal(rows[2][6], "Товар А");
    assert.equal(rows[0][0], "Период: 01.06.2026-30.06.2026");
  });
  it("позиционный обход (ячейки без r-атрибутов): текст попал в нужный адрес", () => {
    const sheet = safe.workbook.Sheets[safe.workbook.SheetNames[0]];
    assert.equal(sheet.D2.v, "Тип начисления");
    assert.equal(sheet.C3.v, "Продажи");
    assert.equal(sheet.D3.v, "Выручка");
  });
  it("число исправленных ячеек = числу <c t=\"str\"> с <v> в сыром XML листа (независимый подсчёт)", () => {
    const xml = safeRead.getSheetRawXml(safe.workbook, safe.workbook.SheetNames[0]);
    const expected = (xml.match(/<c\b[^>]*\bt="str"[^>]*>\s*<v>/g) ?? []).length;
    assert.ok(expected > 100);
    assert.equal(safe.strPatch.total, expected);
  });
  it("getSheetRawXml возвращает сырой XML листа; для неизвестного листа — null", () => {
    const xml = safeRead.getSheetRawXml(safe.workbook, safe.workbook.SheetNames[0]);
    assert.match(xml, /<sheetData>/);
    assert.equal(safeRead.getSheetRawXml(safe.workbook, "нет такого листа"), null);
    assert.equal(safeRead.getSheetRawXml(plain, plain.SheetNames[0]), null); // без bookFiles сырых частей нет
  });
  it("файл без t=\"str\" (Excel-style, sharedStrings): читается без правок, patch = 0", () => {
    const excel = safeRead.readXlsxWorkbookSafe(scenario("excel_style"));
    assert.equal(excel.strPatch.total, 0);
    assert.deepEqual(rowsOf(excel.workbook)[2], HEADER16);
  });
  it("обрезанный архив → readXlsxWorkbookSafe бросает исключение (вызывающий код превращает его в ошибку)", () => {
    assert.throws(() => safeRead.readXlsxWorkbookSafe(buf.slice(0, 600)));
  });
});

describe("старый parseOzonReport (отчёт реализации) читает кириллицу через общий reader", () => {
  const buf = buildRealizationXlsx();
  let result;
  before(async () => {
    result = await quietly(() => oldParser.parseOzonReport(new File([buf], "synthetic-realization.xlsx")));
  });

  it("разбирается без ошибок", () => {
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.debugInfo.failedAt, null);
  });
  it("Ozon распознан, период прочитан из подписи (t=\"str\")", () => {
    assert.equal(result.debugInfo.ozonDetected, true);
    assert.equal(result.report.period, "01.06.2026 — 30.06.2026");
  });
  it("товары: артикул, название, выручка, количество, возвраты, выплаты G−K", () => {
    const got = result.report.products.map((p) => ({
      article: p.article,
      name: p.name,
      revenue: p.revenue,
      quantity: p.quantity,
      returnsAmount: p.returnsAmount,
      loyaltyPayout: p.loyaltyPayout,
    }));
    // Независимо из фикстуры: G−K по товару = колонка выплат продаж − колонка выплат возвратов.
    const expected = REALIZATION_PRODUCTS.map((p) => ({
      article: p[2],
      name: p[1],
      revenue: p[5],
      quantity: p[7],
      returnsAmount: p[9] ?? 0,
      loyaltyPayout: Math.round((p[6] - (p[10] ?? 0)) * 100) / 100,
    }));
    assert.deepEqual(got, expected);
    assert.equal(result.report.loyaltyPayoutPerSkuKnown, true);
  });
  it("итоги: выручка 1750,50 ₽, возвраты 300,00 ₽, 6 шт.", () => {
    const t = result.report.totals;
    assert.equal(t.revenue, 1750.5);
    assert.equal(t.returns, 300);
    assert.equal(t.quantity, 6);
  });
  it("итоговые строки отчёта: «Итого реализовано» 1450,50 ₽ и «Всего выплат от партнёров» 12,25 ₽", () => {
    assert.equal(result.report.totals.revenueFromTotalsRow, 1450.5);
    assert.equal(result.report.totals.loyaltyPayoutsFromTotalsRow, 12.25);
  });
  it("характеристика (снято с mprof-production e71c97a): netRevenue = 1435,25 ₽", () => {
    assert.equal(result.report.totals.netRevenue, 1435.25);
  });
});
