// Парсер XLSX «Отчёт по начислениям» + классификатор корзин на синтетических
// (обезличенных) XLSX в стиле Ozon. Вызываются реальные модули проекта.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { EXPECTED_BASIC as E } from "./helpers/expected.mjs";
import { buckets as K, parseBuf } from "./helpers/modules.mjs";

const parse = (name) => parseBuf(scenario(name));
const codes = (r) => (r.ok ? [] : r.errors.map((e) => e.code));
const warnCodes = (r) => r.warnings.map((w) => w.code);

describe("базовый отчёт: продажа + возврат + услуги + общие строки", () => {
  const basic = parse("basic");
  const s = basic.ok ? basic.report.summary : null;

  it("разбирается (кириллица в t=\"str\" читается)", () => {
    assert.equal(basic.ok, true, basic.ok ? "" : JSON.stringify(basic.errors));
  });
  it("15 строк данных: одинаковый «ID начисления» не приводит к дедупликации", () => {
    assert.equal(s.rowCount, E.rowCount);
    assert.equal(basic.report.rows.length, E.rowCount);
  });
  it("netOzonOperations = 937,46 ₽", () => {
    assert.equal(s.netOzonOperationsKopecks, E.net);
  });
  for (const [bucket, kop] of Object.entries(E.buckets)) {
    it(`корзина ${bucket} = ${kop / 100} ₽`, () => {
      assert.equal(s.buckets[bucket], kop);
    });
  }
  it("Σ корзин === netOzonOperations", () => {
    assert.equal(s.bucketsSumKopecks, s.netOzonOperationsKopecks);
  });
  it("штуки: продано 4, возвращено 1, нетто 3 (количество берётся только со строк выручки/возврата)", () => {
    assert.deepEqual(s.quantities, E.quantities);
  });
  it("неизвестный тип → корзина other + warning unknown_taxonomy; сумма остаётся в итоге", () => {
    assert.equal(s.unknownTaxonomyRows, 1);
    assert.equal(s.unknownTaxonomyAmountKopecks, -555);
    assert.ok(warnCodes(basic).includes("unknown_taxonomy"));
    assert.equal(s.unknownTaxonomy[0].group, "Новая группа");
    assert.equal(s.unknownTaxonomy[0].type, "Новый тип начисления");
  });
  it("warnings не содержат товарных данных", () => {
    assert.doesNotMatch(JSON.stringify(basic.warnings), /ART-|Товар/);
  });
  it("период 2026-06, полный месяц (строка «Период»)", () => {
    assert.equal(basic.report.period.month, "2026-06");
    assert.equal(basic.report.period.periodComplete, true);
    assert.equal(basic.report.period.declaredFrom, "2026-06-01");
    assert.equal(basic.report.period.declaredTo, "2026-06-30");
  });
  it("строки без артикула: 3 шт. на −35,54 ₽; уникальных артикулов 3", () => {
    assert.equal(s.rowsWithoutArticle, 3);
    assert.equal(s.amountWithoutArticleKopecks, -3554);
    assert.equal(s.productCount, 3);
  });
});

describe("shared strings (t=\"s\") читаются так же, как t=\"str\"", () => {
  it("тот же результат без обхода бага SheetJS", () => {
    const r = parse("basic_sst");
    assert.equal(r.ok, true);
    assert.equal(r.report.summary.netOzonOperationsKopecks, E.net);
    assert.equal(r.report.summary.buckets.commission, E.buckets.commission);
  });
});

describe("структурированные ошибки парсера", () => {
  it("пустая сумма → invalid_amount (не ноль): счётчик и номер строки", () => {
    const r = parse("missing_amount");
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes("invalid_amount"));
    assert.equal(r.errors[0].count, 1);
    assert.equal(r.errors[0].rows.length, 1);
  });
  it("нечисловая сумма «н/д» → invalid_amount", () => {
    assert.ok(codes(parse("garbage_amount")).includes("invalid_amount"));
  });
  it("нет товарных колонок → missing_product_columns с перечнем", () => {
    const r = parse("no_product_columns");
    assert.deepEqual(codes(r), ["missing_product_columns"]);
    assert.deepEqual(r.errors[0].columns, ["Артикул", "SKU", "Название товара", "Количество"]);
  });
  it("нет колонки «Сумма итого» → missing_financial_columns", () => {
    const r = parse("no_amount_column");
    assert.ok(codes(r).includes("missing_financial_columns"));
    assert.deepEqual(r.errors[0].columns, ["Сумма итого, руб."]);
  });
  it("нет листа «Начисления» → sheet_not_found (список листов)", () => {
    const r = parse("wrong_sheet");
    assert.deepEqual(codes(r), ["sheet_not_found"]);
    assert.equal(r.errors[0].availableSheets[0], "Лист1");
  });
  it("только заголовок → no_data_rows", () => {
    assert.deepEqual(codes(parse("empty_data")), ["no_data_rows"]);
  });
  it("пустая «Дата начисления» → invalid_date", () => {
    assert.ok(codes(parse("missing_date")).includes("invalid_date"));
  });
  it("«Выручка» без количества → invalid_quantity", () => {
    assert.deepEqual(codes(parse("sale_qty_missing")), ["invalid_quantity"]);
  });
  it("дробное количество на «Выручка» → invalid_quantity", () => {
    assert.deepEqual(codes(parse("sale_qty_fractional")), ["invalid_quantity"]);
  });
  it("мусор в «Количество» на строке УСЛУГИ допустим (в расчёте не участвует)", () => {
    const r = parse("service_qty_garbage");
    assert.equal(r.ok, true);
    assert.equal(r.report.summary.netOzonOperationsKopecks, E.net);
  });
  it("отчёт за несколько месяцев → multiple_months", () => {
    const r = parse("multi_month");
    assert.deepEqual(codes(r), ["multiple_months"]);
    assert.deepEqual(r.errors[0].months, ["2026-06", "2026-07"]);
  });
  it("SheetJS отрезал строки (неверный dimension) → read_incomplete, а не тихая потеря", () => {
    assert.deepEqual(codes(parse("bad_dimension")), ["read_incomplete"]);
  });
  it("повреждённый/обрезанный XLSX → read_failed", () => {
    const full = scenario("basic");
    for (const len of [50, 600, Math.floor(full.length / 2), full.length - 30]) {
      assert.deepEqual(codes(parseBuf(full.slice(0, len))), ["read_failed"], `обрезка до ${len} байт`);
    }
  });
  it("файл не в формате XLSX (произвольные байты; SheetJS читает их как текст) → sheet_not_found", () => {
    assert.deepEqual(codes(parseBuf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))), ["sheet_not_found"]);
    assert.deepEqual(codes(parseBuf(new Uint8Array([]))), ["sheet_not_found"]);
  });
  it("ошибки не содержат товарных данных", () => {
    assert.doesNotMatch(JSON.stringify(parse("missing_amount").errors), /ART-|Товар/);
  });
});

describe("варианты заголовков и форматов", () => {
  it("регистр, nbsp, двойные пробелы, «руб» без точки, преамбула из 3 строк", () => {
    const r = parse("header_variants");
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.errors));
    assert.equal(r.report.summary.netOzonOperationsKopecks, E.net);
    assert.equal(r.report.headerRowNumber, 4);
  });
  it("другой порядок колонок (поиск по названиям, не по индексу)", () => {
    const r = parse("reordered_columns");
    assert.equal(r.ok, true);
    assert.equal(r.report.summary.netOzonOperationsKopecks, E.net);
    assert.equal(r.report.summary.buckets.commission, E.buckets.commission);
  });
  it("«Excel-style» файл (r-атрибуты, sharedStrings, dimension, пустые self-closing строки) — без ложного read_incomplete", () => {
    const r = parse("excel_style");
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.errors));
    assert.equal(r.report.summary.netOzonOperationsKopecks, E.net);
    assert.equal(r.report.summary.rowCount, 15);
    assert.equal(r.report.headerRowNumber, 3);
  });
  it("суммы текстом «1 000,00» и «−300,00»", () => {
    const r = parse("text_amounts");
    assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.errors));
    assert.equal(r.report.summary.buckets.salesRevenue, E.sales);
    assert.equal(r.report.summary.buckets.returnsRevenue, E.returns);
  });
  it("доли копейки округляются с warning amounts_rounded_to_kopecks (не ошибка)", () => {
    const r = parse("sub_kopeck");
    assert.equal(r.ok, true);
    assert.ok(warnCodes(r).includes("amounts_rounded_to_kopecks"));
    assert.equal(r.report.rows[2].amountKopecks, -4000);
  });
});

describe("период отчёта", () => {
  it("неполный месяц: ok, periodComplete=false, warning period_incomplete, не блокирует", () => {
    const r = parse("incomplete_month");
    assert.equal(r.ok, true);
    assert.equal(r.report.period.periodComplete, false);
    assert.ok(warnCodes(r).includes("period_incomplete"));
  });
  it("нет строки «Период»: warning declared_period_missing, полнота — по датам данных", () => {
    const r = parse("no_declared_period");
    assert.equal(r.ok, true);
    assert.ok(warnCodes(r).includes("declared_period_missing"));
    assert.equal(r.report.period.declaredFrom, null);
    assert.equal(r.report.period.periodComplete, false);
  });
});

describe("строки продажи без артикула", () => {
  it("парсер предупреждает sale_rows_without_article", () => {
    const r = parse("sale_without_article");
    assert.equal(r.ok, true);
    assert.ok(warnCodes(r).includes("sale_rows_without_article"));
  });
  it("артикулы «  art-a », «Art-A», «ART-A» — один товар (нормализованный ключ)", () => {
    const r = parse("article_normalization");
    assert.equal(r.ok, true);
    assert.equal(r.report.summary.productCount, 3);
  });
});

describe("классификатор корзин", () => {
  it("нормализация: регистр, ё/е, пробелы", () => {
    assert.equal(K.classifyAccrual("  ПРОДАЖИ ", "выручка").bucket, "salesRevenue");
    assert.equal(K.classifyAccrual("Возвраты", "Программы партнеров").bucket, "partnerPrograms");
  });
  it("неизвестная пара → other, known=false", () => {
    assert.deepEqual(K.classifyAccrual("Продажи", "Что-то новое"), { bucket: "other", known: false });
  });
  it("известные «прочие» начисления → other без warning (known=true)", () => {
    assert.deepEqual(K.classifyAccrual("Услуги партнёров", "Эквайринг"), { bucket: "other", known: true });
  });
  it("одна и та же пара учитывается один раз: каждая строка в ровно одной корзине", () => {
    const r = parse("basic");
    const perRow = r.report.rows.map((row) => K.classifyAccrual(row.group, row.type).bucket === row.bucket);
    assert.ok(perRow.every(Boolean));
  });
});
