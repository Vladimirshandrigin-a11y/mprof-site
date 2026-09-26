// Синтетические ОБЕЗЛИЧЕННЫЕ сценарии отчёта по начислениям (артикулы ART-A/B/C,
// названия «Товар А/Б/В» — вымышленные). Реальных данных продавца здесь нет.

import { buildExcelStyleXlsx, buildOzonStyleXlsx, D, EMPTY, N, TXT } from "./xlsx-builder.mjs";

export const HEADER16 = [
  "ID начисления",
  "Дата начисления",
  "Группа услуг",
  "Тип начисления",
  "Артикул",
  "SKU",
  "Название товара",
  "Количество",
  "Цена продавца",
  "Дата принятия заказа в обработку или оказания услуги",
  "Платформа продажи",
  "Схема работы",
  "Вознаграждение Ozon, %",
  "Индекс локализации, %",
  "Среднее время доставки, часы",
  "Сумма итого, руб.",
];

/** Строка отчёта. art = null → строка без товара (общее начисление). */
export function accrualRow(date, group, type, art, qty, amount, id = "X-1", sku = null, name = null, price = null) {
  return [
    id,
    D(date),
    group,
    type,
    art ? art : EMPTY,
    art && sku ? sku : EMPTY,
    art && name ? name : EMPTY,
    qty !== null && qty !== undefined ? N(qty) : null,
    N(price || "0"),
    D(date),
    "Ozon",
    "FBO",
    N("0.15"),
    null,
    null,
    N(amount),
  ];
}

const G_S = "Продажи";
const T_S = "Выручка";

/**
 * Базовый отчёт: 15 строк.
 *   A: продажа qty 3 + услуги (qty ПОВТОРЯЕТСЯ на строках услуг) + возврат qty 1
 *   B: продажа qty 1 + услуги + «Баллы за скидки» + «Программы партнёров»
 *   C: только услуга (нет продаж)
 *   3 общие строки без артикула (реклама, компенсация, неизвестный тип)
 * Одинаковый «ID начисления» у разных строк — дедупликации быть не должно.
 */
export function basicRows(d = "2026-06-10") {
  return [
    accrualRow(d, G_S, T_S, "ART-A", 3, "1000.00", "ID-1", "111", "Товар А"),
    accrualRow(d, "Вознаграждение Ozon", "Вознаграждение за продажу", "ART-A", 3, "-150.00", "ID-1", "111", "Товар А"),
    accrualRow(d, "Услуги доставки", "Логистика", "ART-A", 3, "-40.00", "ID-1", "111", "Товар А"),
    accrualRow(d, "Услуги партнёров", "Эквайринг", "ART-A", 3, "-10.00", "ID-1", "111", "Товар А"),
    accrualRow(d, "Возвраты", "Возврат выручки", "ART-A", 1, "-300.00", "ID-1", "111", "Товар А"),
    accrualRow(d, "Вознаграждение Ozon", "Возврат вознаграждения", "ART-A", 1, "45.00", "ID-1", "111", "Товар А"),
    accrualRow(d, G_S, T_S, "ART-B", 1, "500.00", "ID-2", "222", "Товар Б"),
    accrualRow(d, "Вознаграждение Ozon", "Вознаграждение за продажу", "ART-B", 1, "-75.00", "ID-2", "222", "Товар Б"),
    accrualRow(d, "Услуги доставки", "Логистика", "ART-B", 1, "-20.00", "ID-2", "222", "Товар Б"),
    accrualRow(d, G_S, "Баллы за скидки", "ART-B", 1, "25.00", "ID-2", "222", "Товар Б"),
    accrualRow(d, G_S, "Программы партнёров", "ART-B", 1, "5.00", "ID-2", "222", "Товар Б"),
    accrualRow(d, "Услуги доставки", "Логистика", "ART-C", 1, "-7.00", "ID-3", "333", "Товар В"),
    accrualRow(d, "Продвижение и реклама", "Продвижение с оплатой за заказ", null, 0, "-60.00", "ID-4"),
    accrualRow(d, "Компенсации и декомпенсации", "Начисление по спору", null, 0, "30.01", "ID-5"),
    accrualRow(d, "Новая группа", "Новый тип начисления", null, 0, "-5.55", "ID-6"),
  ];
}

const PREAMBLE_FULL = [["Период: 01.06.2026-30.06.2026"]];

const build = (rows, { header = HEADER16, preamble = PREAMBLE_FULL, ...opts } = {}) =>
  buildOzonStyleXlsx([...preamble, header, ...rows], opts);

/** Сборка XLSX из произвольных строк (для сценариев разделения результата). */
export const buildReport = (rows, opts) => build(rows, opts);

/** Тот же отчёт без колонки «ID начисления» (первая колонка HEADER16). */
export const buildReportWithoutRef = (rows, opts = {}) =>
  build(
    rows.map((r) => r.slice(1)),
    { ...opts, header: HEADER16.slice(1) }
  );

/** Копия строк с заменой значения одной ячейки. */
const withCell = (rows, rowIdx, colIdx, value) =>
  rows.map((r, i) => (i === rowIdx ? r.map((v, j) => (j === colIdx ? value : v)) : r));

const COL = { date: 1, article: 4, qty: 7, amount: 15 };

/** Все сценарии. Ключ — имя, значение — функция → Uint8Array XLSX. */
export const SCENARIOS = {
  basic: () => build(basicRows()),
  basic_sst: () => build(basicRows(), { mode: "sst" }),
  incomplete_month: () => build(basicRows(), { preamble: [["Период: 01.06.2026-20.06.2026"]] }),
  no_declared_period: () => build(basicRows(), { preamble: [] }),
  multi_month: () =>
    build([...basicRows(), accrualRow("2026-07-02", G_S, T_S, "ART-B", 1, "10.00", "ID-9", "222", "Товар Б")], {
      preamble: [["Период: 01.06.2026-31.07.2026"]],
    }),
  missing_amount: () => build(withCell(basicRows(), 2, COL.amount, null)),
  garbage_amount: () => build(withCell(basicRows(), 3, COL.amount, TXT("н/д"))),
  no_product_columns: () => {
    const idx = [0, 1, 2, 3, 9, 15];
    return build(
      basicRows().map((r) => idx.map((i) => r[i])),
      { header: idx.map((i) => HEADER16[i]) }
    );
  },
  no_amount_column: () =>
    build(
      basicRows().map((r) => r.slice(0, 15)),
      { header: HEADER16.filter((h) => h !== "Сумма итого, руб.") }
    ),
  // регистр, двойные пробелы, nbsp, без точки в «руб», преамбула из 3 строк
  header_variants: () =>
    build(basicRows(), {
      header: [
        "ID начисления",
        "ДАТА  НАЧИСЛЕНИЯ",
        "группа услуг",
        "Тип начисления ",
        "АРТИКУЛ",
        "sku",
        "Название товара",
        "Количество",
        "Цена продавца",
        "Дата принятия заказа в обработку или оказания услуги",
        "Платформа продажи",
        "Схема работы",
        "Вознаграждение Ozon, %",
        "Индекс локализации, %",
        "Среднее время доставки, часы",
        "Сумма итого, руб",
      ],
      preamble: [["Отчёт"], ["Период: 01.06.2026-30.06.2026"], [null]],
    }),
  reordered_columns: () => {
    const perm = [15, 3, 2, 1, 4, 5, 6, 7, 0, 8, 9, 10, 11, 12, 13, 14];
    return build(
      basicRows().map((r) => perm.map((i) => r[i])),
      { header: perm.map((i) => HEADER16[i]) }
    );
  },
  wrong_sheet: () => build(basicRows(), { sheetName: "Лист1" }),
  empty_data: () => build([]),
  missing_date: () => build(withCell(basicRows(), 0, COL.date, null)),
  sale_qty_missing: () => build(withCell(basicRows(), 0, COL.qty, null)),
  sale_qty_fractional: () => build(withCell(basicRows(), 0, COL.qty, N("2.5"))),
  service_qty_garbage: () => build(withCell(basicRows(), 1, COL.qty, TXT("много"))),
  text_amounts: () =>
    build(withCell(withCell(basicRows(), 0, COL.amount, TXT("1 000,00")), 4, COL.amount, TXT("−300,00"))),
  sub_kopeck: () => build(withCell(basicRows(), 2, COL.amount, N("-40.004"))),
  sale_without_article: () => build([...basicRows(), accrualRow("2026-06-11", G_S, T_S, null, 2, "200.00", "ID-7")]),
  article_normalization: () => {
    let rows = basicRows();
    for (let i = 0; i < 6; i++) rows = withCell(rows, i, COL.article, "  art-a ");
    rows = withCell(rows, 6, COL.article, "Art-A"); // «Выручка» товара B попадает в A
    return build(rows);
  },
  tax_zero: () =>
    build([
      accrualRow("2026-06-10", G_S, T_S, "ART-A", 1, "100.00", "I1"),
      accrualRow("2026-06-10", "Возвраты", "Возврат выручки", "ART-A", 1, "-100.00", "I1"),
      accrualRow("2026-06-10", "Услуги доставки", "Логистика", "ART-A", 1, "-5.00", "I1"),
    ]),
  tax_negative: () =>
    build([
      accrualRow("2026-06-10", G_S, T_S, "ART-A", 1, "100.00", "I1"),
      accrualRow("2026-06-10", "Возвраты", "Возврат выручки", "ART-A", 2, "-250.00", "I1"),
    ]),
  // dimension короче реальных данных → SheetJS отрежет строки → read_incomplete
  bad_dimension: () => build(basicRows(), { dimension: "A1:P5" }),
  return_only_product: () =>
    build([
      accrualRow("2026-06-10", G_S, T_S, "ART-B", 5, "800.00", "I2"),
      accrualRow("2026-06-10", "Возвраты", "Возврат выручки", "ART-A", 1, "-100.00", "I1"),
    ]),
  excel_style: () => {
    const data = basicRows();
    return buildExcelStyleXlsx([
      ["Период: 01.06.2026-30.06.2026"],
      null,
      HEADER16,
      ...data.slice(0, 5),
      null,
      ...data.slice(5),
    ]);
  },
};

export function scenario(name) {
  const f = SCENARIOS[name];
  if (!f) throw new Error(`unknown scenario ${name}`);
  return f();
}
