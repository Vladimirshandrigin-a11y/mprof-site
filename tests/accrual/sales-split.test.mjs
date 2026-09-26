// Разделение результата товара: продажи / возвраты / расходы без продаж / неразделённые.
// Реальные парсер, ядро, снимок и модель PDF на синтетическом отчёте (вымышленные
// артикулы). Ожидания — независимые литералы, посчитанные вручную (копейки):
//
//   L  продажа без возврата:   +100 −20 −90 = −10, себестоимость 50 → продажи −60;
//      реклама по номеру заказа (ADS-1) −15 — неразделённая (нет связи с продажей)
//   R  полный возврат в периоде: +300 −45 −30 −300 +45 −30 = −60, кол-во 0 → возвраты −60
//   M  прибыльная продажа +1000 −100 −50 = 850 − 300 = 550 (продажи);
//      возврат продажи прошлого периода −1000 +100 −80 −20 = −1000, кол-во −1 → +300 → −700;
//      полная прибыль −150 < 0, но продажи прибыльны → в рейтинг продаж НЕ попадает
//   S  только логистика −15 → расходы без продаж
//   P  частичный возврат (продано 2, вернули 1): +400 −40 −20 −200 +20 −10 = 150, кол-во 1,
//      себестоимость 80 → неразделённые +70 (не возврат и не продажа)
//   U  продажа +100 −130 = −30 − 10 = −40 и частичный возврат +300 −150 −20 = 130 − 10 = 120:
//      неразделённые могут вывести продажи в плюс → «не определено», исключён из рейтинга
//   K  возврат продажи прошлого периода −100 +15 −5 = −90, кол-во −1, себестоимость 200 → +110
//   X1, X2 — одно отправление X-1: X1 продажа +200 −10 − 20 = 170; X2 полный возврат
//      +100 −8 −100 −6 = −14
//   E  продажа +100 −10 − 30 = 60; эквайринг без ID −2 → неразделённые (нет ссылки)
//   A  «Выручка» +100 и «Обработка возвратов» −10 без «Возврата выручки» → неоднозначно, 90 − 40 = 50

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accrualRow, buildReport, buildReportWithoutRef } from "./helpers/fixtures.mjs";
import { toLegacy, viaJson } from "./helpers/snapshot-fixtures.mjs";
import { calc as C, parseBuf, pdfModel as P, salesSplit as SS, snapshot as S } from "./helpers/modules.mjs";

const d = "2026-06-12";
const SALE = ["Продажи", "Выручка"];
const RET = ["Возвраты", "Возврат выручки"];
const COMM = ["Вознаграждение Ozon", "Вознаграждение за продажу"];
const COMM_BACK = ["Вознаграждение Ozon", "Возврат вознаграждения"];
const LOG = ["Услуги доставки", "Логистика"];
const REV_LOG = ["Услуги доставки", "Обратная логистика"];
const RET_PROC = ["Услуги партнёров", "Обработка возвратов, отмен и невыкупов партнёрами"];
const ACQ = ["Услуги партнёров", "Эквайринг"];
const ADS = ["Продвижение и реклама", "Продвижение с оплатой за заказ"];

const r = (pair, art, qty, amount, id) => accrualRow(d, pair[0], pair[1], art, qty, amount, id, `${art}-sku`, `Товар ${art}`);

function scenarioRows() {
  return [
    r(SALE, "L", 1, "100.00", "L-1"), r(COMM, "L", 1, "-20.00", "L-1"), r(LOG, "L", 1, "-90.00", "L-1"),
    r(ADS, "L", 0, "-15.00", "ADS-1"),
    r(SALE, "R", 1, "300.00", "R-1"), r(COMM, "R", 1, "-45.00", "R-1"), r(LOG, "R", 1, "-30.00", "R-1"),
    r(RET, "R", 1, "-300.00", "R-1"), r(COMM_BACK, "R", 1, "45.00", "R-1"), r(REV_LOG, "R", 1, "-30.00", "R-1"),
    r(SALE, "M", 1, "1000.00", "M-1"), r(COMM, "M", 1, "-100.00", "M-1"), r(LOG, "M", 1, "-50.00", "M-1"),
    r(RET, "M", 1, "-1000.00", "M-2"), r(COMM_BACK, "M", 1, "100.00", "M-2"), r(REV_LOG, "M", 1, "-80.00", "M-2"),
    r(RET_PROC, "M", 1, "-20.00", "M-2"),
    r(LOG, "S", 1, "-15.00", "S-1"),
    r(SALE, "P", 2, "400.00", "P-1"), r(COMM, "P", 2, "-40.00", "P-1"), r(LOG, "P", 2, "-20.00", "P-1"),
    r(RET, "P", 1, "-200.00", "P-1"), r(COMM_BACK, "P", 1, "20.00", "P-1"), r(REV_LOG, "P", 1, "-10.00", "P-1"),
    r(SALE, "U", 1, "100.00", "U-1"), r(LOG, "U", 1, "-130.00", "U-1"),
    r(SALE, "U", 2, "300.00", "U-2"), r(RET, "U", 1, "-150.00", "U-2"), r(LOG, "U", 2, "-20.00", "U-2"),
    r(RET, "K", 1, "-100.00", "K-1"), r(COMM_BACK, "K", 1, "15.00", "K-1"), r(REV_LOG, "K", 1, "-5.00", "K-1"),
    r(SALE, "X1", 1, "200.00", "X-1"), r(LOG, "X1", 1, "-10.00", "X-1"),
    r(SALE, "X2", 1, "100.00", "X-1"), r(LOG, "X2", 1, "-8.00", "X-1"), r(RET, "X2", 1, "-100.00", "X-1"),
    r(REV_LOG, "X2", 1, "-6.00", "X-1"),
    r(SALE, "E", 1, "100.00", "E-1"), r(LOG, "E", 1, "-10.00", "E-1"), r(ACQ, "E", 0, "-2.00", ""),
    r(SALE, "A", 1, "100.00", "A-1"), r(RET_PROC, "A", 1, "-10.00", "A-1"),
  ];
}
const GENERAL = [
  accrualRow(d, "Продвижение и реклама", "Оплата за клик", null, 0, "-60.00", "G-1"),
  accrualRow(d, "Компенсации и декомпенсации", "Начисление по спору", null, 0, "30.01", "G-2"),
];
const CATALOG = [
  ["L", 50], ["R", 100], ["M", 300], ["P", 80], ["U", 10], ["K", 200], ["X1", 20], ["X2", 20], ["E", 30], ["A", 40],
].map(([sku, cost]) => ({ sku, name: `cat ${sku}`, cost_price: cost }));

function calcFor(buf, { tax = 0, manual = {}, catalog = CATALOG } = {}) {
  const parsed = parseBuf(buf);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.errors));
  const res = C.computeAccrualProfit({ report: parsed.report, catalog, taxRatePercent: tax, manualExpenses: manual });
  assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.error));
  const snap = S.buildAccrualSnapshot({
    calc: res.calc,
    period: parsed.report.period,
    warnings: parsed.warnings,
    source: { sheet: parsed.report.sheetName, rowCount: parsed.report.summary.rowCount },
    generatedAt: "2026-07-01T10:00:00.000Z",
  });
  return { parsed, calc: res.calc, snap };
}
const byArt = (c, a) => c.products.find((p) => p.article === a);
const partResult = (p, k) => {
  const x = p.split.parts[k];
  return x.cogsKopecks === null ? null : x.directKopecks + x.generalKopecks - x.cogsKopecks - x.taxKopecks - x.manualKopecks;
};

describe("разделение: четыре основных сценария и крайние случаи", () => {
  const { calc, snap, parsed } = calcFor(buildReport(scenarioRows()));
  const view = S.accrualSalesSplitView(S.asAccrualSnapshot(viaJson(S.serializeAccrualSnapshot(snap))));

  it("«ID начисления» читается как необязательная ссылка; строки не дедуплицируются", () => {
    assert.equal(parsed.report.refColumn, true);
    assert.equal(parsed.report.rows.length, scenarioRows().length);
    assert.equal(parsed.report.rows.filter((x) => x.ref === "X-1").length, 6);
    assert.equal(parsed.report.rows.find((x) => x.article === "E" && x.type === "Эквайринг").ref, "");
    assert.equal(calc.salesSplitAvailable, true);
  });

  it("1) убыточная продажа без возврата: убыток продаж доказан, но реклама без связи делает величину диапазоном −75…−60 ₽", () => {
    const L = byArt(calc, "L");
    assert.equal(partResult(L, "sales"), -6000);
    assert.equal(partResult(L, "unsplit"), -1500); // реклама по номеру заказа — без связи
    assert.equal(L.split.unsplitReasons.no_sale_link, 1);
    assert.equal(L.profitKopecks, -7500);
    const row = view.losses.find((x) => x.article === "L");
    // Реклама может относиться к продаже: знак доказан, величина — нет → одно число не выдаётся.
    assert.deepEqual(
      [row.salesRevenueKopecks, row.salesResultKopecks, row.salesMarginPercent, row.exact, row.lowerKopecks, row.upperKopecks],
      [10000, null, null, false, -7500, -6000]
    );
  });

  it("2) полный возврат в периоде: результат возвратов −60 ₽, в рейтинг продаж не попадает", () => {
    const R = byArt(calc, "R");
    assert.equal(R.split.groups.returns, 1);
    assert.equal(partResult(R, "returns"), -6000);
    assert.equal(R.split.groups.sales, 0);
    assert.ok(!view.losses.some((x) => x.article === "R"));
    assert.equal(view.returns.rows.find((x) => x.article === "R").resultKopecks, -6000);
  });

  it("3) прибыльные продажи + возврат, увёдший товар в минус: продажи +550, возвраты −700, полная прибыль −150 — не в рейтинге продаж", () => {
    const M = byArt(calc, "M");
    assert.equal(partResult(M, "sales"), 55000);
    assert.equal(partResult(M, "returns"), -70000);
    assert.equal(M.profitKopecks, -15000);
    assert.equal(M.marginPercent, null, "выручка товара после возвратов = 0 → «—»");
    assert.ok(!view.losses.some((x) => x.article === "M"));
    assert.ok(!view.excluded.some((x) => x.article === "M"));
  });

  it("4) только услуги, продаж нет: расходы без продаж −15 ₽, не в рейтинге", () => {
    const Sx = byArt(calc, "S");
    assert.equal(partResult(Sx, "noSale"), -1500);
    assert.equal(Sx.split.groups.sales, 0);
    assert.equal(view.noSale.rows.find((x) => x.article === "S").resultKopecks, -1500);
    assert.ok(!view.losses.some((x) => x.article === "S"));
  });

  it("частичный возврат (продано 2, вернули 1) не относится к возвратам целиком: конкретные суммы в «неразделённых»", () => {
    const Pp = byArt(calc, "P");
    assert.equal(Pp.split.parts.returns.rows, 0);
    assert.equal(Pp.split.parts.sales.rows, 0);
    assert.equal(Pp.split.unsplitReasons.partial_return, 1);
    assert.equal(partResult(Pp, "unsplit"), 7000);
    assert.deepEqual(
      [Pp.split.unsplitBuckets.salesRevenue, Pp.split.unsplitBuckets.returnsRevenue, Pp.split.unsplitBuckets.commission, Pp.split.unsplitBuckets.logistics],
      [40000, -20000, -2000, -3000]
    );
    const u = view.unsplit.rows.find((x) => x.article === "P");
    assert.equal(u.resultKopecks, 7000);
    assert.deepEqual(u.components.map((c) => [c.label, c.kopecks]), [
      ["Продажи до возвратов", 40000],
      ["Возвраты выручки", -20000],
      ["Комиссия Ozon (вознаграждение)", -2000],
      ["Доставка и связанные услуги", -3000],
      ["Себестоимость", -8000],
    ]);
  });

  it("неразделённые операции могут изменить вывод → товар исключён из рейтинга с причиной", () => {
    const U = byArt(calc, "U");
    assert.equal(partResult(U, "sales"), -4000);
    assert.equal(partResult(U, "unsplit"), 12000);
    assert.ok(!view.losses.some((x) => x.article === "U"));
    const ex = view.excluded.find((x) => x.article === "U");
    // Элементы U-2 (строка + себестоимость её единиц): +300 − 2×10 = +280; −150 + 10 = −140; −20.
    assert.deepEqual([ex.lowerKopecks, ex.upperKopecks], [-4000 - 14000 - 2000, -4000 + 28000]);
    const ranking = S.accrualSalesLossRanking(S.asAccrualSnapshot(viaJson(snap)));
    const reason = ranking.excluded.find((x) => x.article === "U").reason.replace(/[\u00a0\u202f]/g, " ");
    assert.equal(reason, "результат продаж не определён: от −200,00 ₽ до 240,00 ₽ — неразделённые операции могут изменить его знак");
  });

  it("вывод об убыточности: без продаж — «нет продаж» (не отрицательный результат продаж из общих расходов)", () => {
    for (const a of ["P", "A", "R", "S", "K"]) {
      const x = SS.assessSalesLoss(byArt(calc, a).split);
      assert.deepEqual([x.status, x.salesResultKopecks, x.salesMarginPercent], ["no_sales", null, null], a);
    }
    assert.equal(SS.assessSalesLoss(byArt(calc, "L").split).status, "loss");
    assert.equal(SS.assessSalesLoss(byArt(calc, "M").split).status, "not_loss");
    assert.equal(SS.assessSalesLoss(byArt(calc, "U").split).status, "undetermined");
  });

  it("возврат прошлого периода с ПОЛОЖИТЕЛЬНЫМ результатом: +110 ₽, знак сохраняется", () => {
    const K = byArt(calc, "K");
    assert.equal(partResult(K, "returns"), 11000);
    assert.equal(K.profitKopecks, 11000);
    assert.equal(view.returns.rows.find((x) => x.article === "K").resultKopecks, 11000);
  });

  it("несколько артикулов в одном «ID начисления»: связь по ссылке + артикулу", () => {
    const X1 = byArt(calc, "X1");
    const X2 = byArt(calc, "X2");
    assert.deepEqual([X1.split.groups.sales, X1.split.groups.returns, partResult(X1, "sales")], [1, 0, 17000]);
    assert.deepEqual([X2.split.groups.sales, X2.split.groups.returns, partResult(X2, "returns")], [0, 1, -1400]);
  });

  it("пустой ID и неоднозначная связь → неразделённые с причинами", () => {
    const E = byArt(calc, "E");
    assert.deepEqual([partResult(E, "sales"), partResult(E, "unsplit"), E.split.unsplitReasons.no_ref], [6000, -200, 1]);
    const A = byArt(calc, "A");
    assert.deepEqual([A.split.unsplitReasons.ambiguous_link, A.split.groups.sales, partResult(A, "unsplit")], [1, 0, 5000]);
  });

  it("рейтинг «Продажи в минус»: только L (диапазоном); «самого убыточного» с точной величиной нет", () => {
    assert.deepEqual(view.losses.map((x) => x.article), ["L"]);
    assert.deepEqual(view.excluded.map((x) => x.article), ["U"], "без продаж (P, A, R, S, K) не исключаются — они вне рейтинга");
    assert.equal(view.sales.products, 5, "товары с группой продаж: L, M, U, X1, E (у A связь неоднозначна)");
    assert.equal(view.exactSalesProducts, 2, "точный результат только у M и X1");
    assert.deepEqual([view.worst, view.worstScope], [null, null]);
    const kp = S.accrualKeyProducts(S.asAccrualSnapshot(viaJson(snap)));
    assert.equal(kp.worst, null);
    const t = S.accrualWorstSalesText(view);
    assert.deepEqual(
      [t.note, t.emptyText, t.emptyShort, t.emptyTone],
      [null, "Убыток от продаж доказан у 1 товара, но точная величина не определена — см. «Продажи в минус».", "Точный убыток не определён", "warn"]
    );
  });

  it("сумма частей = полная прибыль каждого товара; сверка по всем товарам = чистая прибыль", () => {
    for (const p of calc.products) {
      const sum = ["sales", "returns", "noSale", "unsplit"].reduce((a, k) => a + partResult(p, k), 0);
      assert.equal(sum, p.profitKopecks, p.article);
    }
    const rec = view.reconciliation;
    assert.equal(rec.salesKopecks + rec.returnsKopecks + rec.noSaleKopecks + rec.unsplitKopecks, rec.productProfitKopecks);
    assert.equal(rec.productProfitKopecks, calc.netProfitKopecks);
  });
});

describe("распределённые расходы и неизменность общего результата", () => {
  const rows = [...scenarioRows(), ...GENERAL];
  const withRef = calcFor(buildReport(rows), { tax: 6, manual: { packaging: 100, other: 3.33 } });
  const noRef = calcFor(buildReportWithoutRef(rows), { tax: 6, manual: { packaging: 100, other: 3.33 } });

  it("без колонки «ID начисления»: разделение недоступно, но прибыль, себестоимость и распределение те же", () => {
    assert.equal(noRef.parsed.report.refColumn, false);
    assert.equal(noRef.calc.salesSplitAvailable, false);
    assert.equal(noRef.calc.salesSplitReason, "no_ref_column");
    for (const k of ["netProfitKopecks", "productionCostKopecks", "taxKopecks", "netOzonOperationsKopecks"]) {
      assert.equal(withRef.calc[k], noRef.calc[k], k);
    }
    const strip = (c) =>
      c.products.map((p) => [p.article, p.profitKopecks, p.cogsKopecks, p.allocatedGeneralKopecks, p.allocatedTaxKopecks, p.allocatedManualKopecks]);
    assert.deepEqual(strip(withRef.calc), strip(noRef.calc));
    assert.equal(S.accrualSalesSplitView(noRef.snap).availability, "no_ref_column");
    assert.equal(S.accrualSalesLossRanking(noRef.snap).salesBasis, false);
  });

  it("доли налога, ручных и общих начислений: Σ по частям = доле товара; части без положительной выручки — 0", () => {
    for (const p of withRef.calc.products) {
      const parts = p.split.parts;
      const sum = (f) => ["sales", "returns", "noSale", "unsplit"].reduce((a, k) => a + parts[k][f], 0);
      assert.equal(sum("generalKopecks"), p.allocatedGeneralKopecks, p.article);
      assert.equal(sum("taxKopecks"), p.allocatedTaxKopecks, p.article);
      assert.equal(sum("manualKopecks"), p.allocatedManualKopecks, p.article);
      for (const k of ["returns", "noSale"]) {
        if (parts[k].revenueKopecks <= 0) {
          assert.deepEqual([parts[k].generalKopecks, parts[k].taxKopecks, parts[k].manualKopecks], [0, 0, 0], `${p.article}.${k}`);
        }
      }
      const sumRes = ["sales", "returns", "noSale", "unsplit"].reduce((a, k) => a + partResult(p, k), 0);
      assert.equal(sumRes, p.profitKopecks, p.article);
    }
  });

  it("нет продаж → «результат продаж» не создаётся из общих расходов (P, A: всё в неразделённых)", () => {
    for (const a of ["P", "A"]) {
      const p = byArt(withRef.calc, a);
      const s = p.split.parts.sales;
      assert.deepEqual([s.rows, s.generalKopecks, s.taxKopecks, s.manualKopecks], [0, 0, 0, 0], a);
      assert.equal(p.split.parts.unsplit.taxKopecks, p.allocatedTaxKopecks, a);
    }
  });

  it("U: доли делятся между продажами и неразделёнными пропорционально положительной выручке (100 : 150)", () => {
    const U = byArt(withRef.calc, "U");
    const tax = U.allocatedTaxKopecks;
    assert.ok(tax > 0);
    assert.equal(U.split.parts.sales.taxKopecks + U.split.parts.unsplit.taxKopecks, tax);
    assert.ok(Math.abs(U.split.parts.sales.taxKopecks - Math.round((tax * 100) / 250)) <= 1);
  });

  it("общий результат периода не изменился: Σ частей по всем товарам = чистая прибыль", () => {
    const v = S.accrualSalesSplitView(withRef.snap);
    const r = v.reconciliation;
    assert.equal(r.productProfitKopecks, withRef.calc.netProfitKopecks);
    assert.equal(r.salesKopecks + r.returnsKopecks + r.noSaleKopecks + r.unsplitKopecks, withRef.calc.netProfitKopecks);
  });
});

describe("себестоимость единицы с долями копейки: округление не ломает сумму", () => {
  it("Σ себестоимости частей = себестоимость товара", () => {
    const cat = CATALOG.map((c) => (c.sku === "U" ? { ...c, cost_price: 33.335 } : c));
    const { calc } = calcFor(buildReport(scenarioRows()), { catalog: cat });
    const U = byArt(calc, "U");
    const sum = ["sales", "returns", "noSale", "unsplit"].reduce((a, k) => a + U.split.parts[k].cogsKopecks, 0);
    assert.equal(sum, U.cogsKopecks);
    assert.equal(U.cogsKopecks, 6667);
  });
});

describe("нет себестоимости: разделение не выдаёт результат продаж", () => {
  it("товар с продажами без себестоимости: результат продаж неизвестен, в рейтинг не входит", () => {
    const cat = CATALOG.filter((c) => c.sku !== "L");
    const { snap } = calcFor(buildReport(scenarioRows()), { catalog: cat });
    const v = S.accrualSalesSplitView(snap);
    assert.ok(!v.losses.some((x) => x.article === "L"));
    assert.ok(v.salesWithoutCost >= 1);
    assert.equal(v.reconciliation, null, "сверка не показывается, пока есть неизвестная себестоимость");
  });
});

describe("снимок: разделение сохраняется, старые снимки — «недоступно»", () => {
  const { snap } = calcFor(buildReport(scenarioRows()));
  const stored = viaJson(S.serializeAccrualSnapshot(snap));

  it("после JSON читается без потерь; ссылки «ID начисления» в снимок не пишутся", () => {
    const r = S.readAccrualSnapshot(stored);
    assert.equal(r.status, "ok", r.reason);
    assert.deepEqual(r.snapshot, snap);
    assert.deepEqual(stored.salesSplit, { version: 1, available: true, reason: null });
    assert.doesNotMatch(JSON.stringify(stored), /"(L|R|M|U|K|X|E|A|P|S|ADS)-\d"/);
  });

  it("старый снимок без новых полей: «разделение недоступно», рейтинг не выдаётся за продажи", () => {
    const legacy = S.asAccrualSnapshot(toLegacy(snap));
    assert.ok(legacy);
    const v = S.accrualSalesSplitView(legacy);
    assert.equal(v.availability, "legacy");
    assert.deepEqual([v.losses.length, v.returns.rows.length, v.reconciliation], [0, 0, null]);
    const ranking = S.accrualSalesLossRanking(legacy);
    assert.equal(ranking.salesBasis, false);
    assert.match(ranking.note, /^Рейтинг по полной прибыли товара, включая возвраты/);
    assert.match(S.accrualSplitUnavailableText(v.availability), /сохранён до появления этого разделения/);
    assert.equal(S.accrualKeyProducts(legacy).worst.basis, "full_profit");
  });

  it("повреждения ловятся: часть не сходится / split без salesSplit / нет split при available", () => {
    const a = viaJson(stored);
    a.products[0].split.parts.sales.directKopecks += 1;
    assert.equal(S.readAccrualSnapshot(a).status, "invalid");
    const b = viaJson(stored);
    delete b.salesSplit;
    assert.equal(S.readAccrualSnapshot(b).status, "invalid");
    const r2 = viaJson(stored);
    r2.products[0].split.parts.sales.revenueKopecks += 1; // Σ выручки частей ≠ выручке товара
    assert.equal(S.readAccrualSnapshot(r2).status, "invalid");
    const c = viaJson(stored);
    delete c.products[1].split;
    assert.equal(S.readAccrualSnapshot(c).status, "invalid");
    const e = viaJson(stored);
    e.products[0].split.parts.sales.taxKopecks += 1;
    e.products[0].split.parts.unsplit.taxKopecks -= 1;
    const re = S.readAccrualSnapshot(e);
    assert.equal(re.status, e.products[0].split.parts.unsplit.taxKopecks < 0 ? "invalid" : "ok");
  });
});

describe("единый смысл в PDF и рекомендациях", () => {
  const { snap } = calcFor(buildReport(scenarioRows()));
  const m = P.buildAccrualPdfModel(snap, new Date(2026, 6, 1, 10, 30));
  const nb = (s) => s.replace(/[\u00a0\u202f]/g, " ");

  it("карточка PDF: точного «самого убыточного» нет — нейтральный текст, L диапазоном; сводка частей и сверка", () => {
    assert.equal(m.keyProducts.worstTitle, "САМЫЙ УБЫТОЧНЫЙ ПО ПРОДАЖАМ");
    assert.equal(m.keyProducts.worst, null);
    assert.deepEqual([m.keyProducts.worstEmptyText, m.keyProducts.worstEmptyTone], ["Точный убыток не определён", "warn"]);
    assert.equal(m.keyProducts.worstNote, "Убыток от продаж доказан у 1 товара, но точная величина не определена — см. «Продажи в минус».");
    const lines = m.splitLines.map(nb);
    assert.ok(lines.includes("Продажи в минус (убыток доказан): 1, из них с точной величиной: 0, только диапазоном: 1; не включены в рейтинг — неразделённые операции могут изменить вывод: 1."));
    assert.ok(lines.includes("L · Товар L: результат продаж от −75,00 ₽ до −60,00 ₽."));
    assert.ok(lines.includes(S.ACCRUAL_RANGE_NOTE));
    assert.ok(lines.some((l) => /Расчётная прибыль от продаж/.test(l)));
    assert.ok(lines.some((l) => /Результат возвратов — по начислениям этого периода/.test(l)));
    assert.ok(lines.some((l) => /Неразделённые операции/.test(l)));
    // Знак операции — из знака части, без «+ −»: 680 − 664 − 15 + 223 = 224 (ручной расчёт выше).
    assert.ok(lines.includes("Сверка: 680,00 ₽ − 664,00 ₽ − 15,00 ₽ + 223,00 ₽ = прибыль товаров 224,00 ₽."));
    assert.equal(
      nb(S.accrualSplitReconciliationText(S.accrualSalesSplitView(snap))),
      "680,00 ₽ − 664,00 ₽ − 15,00 ₽ + 223,00 ₽ = прибыль товаров 224,00 ₽"
    );
    assert.ok(lines.some((l) => /не включены в рейтинг — неразделённые операции могут изменить вывод: 1/.test(l)));
  });

  it("рекомендации: то же правило — без точного результата «худшего» нет", () => {
    assert.equal(S.accrualRecoProps(snap).worst, null);
  });

  it("выручка без ведущего плюса, настоящий минус сохраняется", () => {
    const rev = m.rows.find((x) => x.label === "Продажи до возвратов");
    assert.equal(rev.kind, "neutral");
    assert.equal(nb(rev.value), "2 700,00 ₽");
    const ret = m.rows.find((x) => x.label === "Возвраты выручки");
    assert.match(nb(ret.value), /^−/);
  });
});

// ---------------------------------------------------------------------------
// Неопределённость рейтинга: доказанный знак ≠ известная величина ≠ доказанная позиция.
// Ожидания — ручной расчёт (копейки, налог 0, себестоимость единицы в каталоге):
//   OA: +100 −150 − 10 = −60; реклама под своим ID −50 → диапазон −110…−60
//   OB: +100 −140 − 10 = −50; эквайринг по номеру заказа −40 → −90…−50
//   OC: +100 −170 − 10 = −80 точно;  OD: +100 −210 − 10 = −120 точно
//   Y:  +100 −120 − 10 = −30; неразделённые +50 и −60 одной ссылкой (нетто −10) → −90…+20
//   Z:  +200 −10 − 300 = −110; частичный возврат Z-2 (продано 2 за 100, возвращено 1 за −50,
//       себестоимость 300): «Выручка» 100 − 2×300 = −500, «Возврат выручки» −50 + 300 = +250
//       → −610…+140 (свёртка в нетто давала −460…−10 и ложный «доказанный убыток»)
// ---------------------------------------------------------------------------
describe("неопределённость рейтинга: пересекающиеся диапазоны и разнознаковые неразделённые", () => {
  const COMP = ["Компенсации и декомпенсации", "Начисление по спору"];
  const OA = [r(SALE, "OA", 1, "100.00", "OA-1"), r(LOG, "OA", 1, "-150.00", "OA-1"), r(ADS, "OA", 0, "-50.00", "ADS-OA")];
  const OB = [r(SALE, "OB", 1, "100.00", "OB-1"), r(LOG, "OB", 1, "-140.00", "OB-1"), r(ACQ, "OB", 0, "-40.00", "ORD-OB")];
  const OC = [r(SALE, "OC", 1, "100.00", "OC-1"), r(LOG, "OC", 1, "-170.00", "OC-1")];
  const OD = [r(SALE, "OD", 1, "100.00", "OD-1"), r(LOG, "OD", 1, "-210.00", "OD-1")];
  const NC = [r(SALE, "NC", 1, "100.00", "NC-1"), r(LOG, "NC", 1, "-500.00", "NC-1")];
  const cat = (arts, extra = []) => [...arts.map((sku) => ({ sku, name: sku, cost_price: 10 })), ...extra];
  const run = (rows, catalog) => {
    const { snap } = calcFor(buildReport(rows), { catalog });
    const s = S.asAccrualSnapshot(viaJson(S.serializeAccrualSnapshot(snap)));
    return { s, v: S.accrualSalesSplitView(s), m: P.buildAccrualPdfModel(s, new Date(2026, 6, 1)) };
  };
  const nb = (x) => x.replace(/[\u00a0\u202f]/g, " ");
  const bounds = (v) => v.losses.map((l) => [l.article, l.exact, l.salesResultKopecks, l.lowerKopecks, l.upperKopecks]);

  it("два доказанных убытка с пересекающимися диапазонами: оба в списке диапазоном, «самый убыточный» не выбирается", () => {
    const { s, v, m } = run([...OA, ...OB], cat(["OA", "OB"]));
    assert.deepEqual(bounds(v), [["OA", false, null, -11000, -6000], ["OB", false, null, -9000, -5000]]);
    assert.deepEqual([v.worst, v.worstScope, v.exactSalesProducts], [null, null, 0]);
    assert.equal(S.accrualKeyProducts(s).worst, null);
    assert.equal(S.accrualRecoProps(s).worst, null);
    const rk = S.accrualSalesLossRanking(s);
    assert.deepEqual(rk.rows.map((x) => [x.article, x.profit, x.margin, x.range]), [
      ["OA", null, null, { lower: -110, upper: -60 }],
      ["OB", null, null, { lower: -90, upper: -50 }],
    ]);
    assert.deepEqual([rk.worst, rk.worstEmpty.tone], [null, "warn"]);
    assert.equal(rk.worstEmpty.text, "Убыток от продаж доказан у 2 товаров, но точная величина не определена — см. «Продажи в минус».");
    assert.equal(rk.rangeNote, S.ACCRUAL_RANGE_NOTE);
    assert.deepEqual([m.keyProducts.worst, m.keyProducts.worstEmptyText, m.keyProducts.worstEmptyTone], [null, "Точный убыток не определён", "warn"]);
    const lines = m.splitLines.map(nb);
    assert.ok(lines.includes("OA · Товар OA: результат продаж от −110,00 ₽ до −60,00 ₽."));
    assert.ok(lines.includes("OB · Товар OB: результат продаж от −90,00 ₽ до −50,00 ₽."));
  });

  it("точный OC −80 внутри диапазона OA: выбран OC, но только «среди точных» — с подписью охвата везде", () => {
    const { s, v, m } = run([...OA, ...OB, ...OC], cat(["OA", "OB", "OC"]));
    assert.deepEqual(bounds(v), [["OC", true, -8000, -8000, -8000], ["OA", false, null, -11000, -6000], ["OB", false, null, -9000, -5000]]);
    assert.deepEqual([v.worst.article, v.worstScope, v.exactSalesProducts], ["OC", "exact_only", 1]);
    const note =
      "Выбран только среди товаров с точно определённым результатом продаж (1 из 3 с продажами). " +
      "У остальных результат известен лишь диапазоном — доказать, кто из них убыточнее, нельзя.";
    const kp = S.accrualKeyProducts(s).worst;
    assert.deepEqual([kp.article, kp.profitKopecks, kp.marginPercent, kp.basis, kp.scopeNote], ["OC", -8000, -80, "sales", note]);
    const rk = S.accrualSalesLossRanking(s);
    assert.deepEqual([rk.worst.article, rk.worst.profit, rk.worst.margin, rk.worstNote], ["OC", -80, -80, note]);
    const reco = S.accrualRecoProps(s).worst;
    assert.deepEqual([reco.article, reco.profit, reco.margin, reco.scopeNote], ["OC", -80, -80, note]);
    assert.deepEqual([m.keyProducts.worst.article, nb(m.keyProducts.worst.profit), nb(m.keyProducts.worst.margin)], ["OC", "−80,00 ₽", "−80,0 %"]);
    assert.equal(
      m.keyProducts.worstNote,
      "Самый убыточный по продажам: выбран только среди товаров с точно определённым результатом продаж (1 из 3 с продажами). " +
        "У остальных результат известен лишь диапазоном — доказать, кто из них убыточнее, нельзя."
    );
  });

  it("позиция доказана для всех: точный OD −120 ниже всех нижних границ, себестоимость известна у всех — подписи охвата нет", () => {
    const { s, v, m } = run([...OA, ...OB, ...OD], cat(["OA", "OB", "OD"]));
    assert.deepEqual([v.worst.article, v.worstScope], ["OD", "all"]);
    assert.equal(S.accrualKeyProducts(s).worst.scopeNote, null);
    assert.equal(S.accrualSalesLossRanking(s).worstNote, null);
    assert.equal(m.keyProducts.worstNote, null);
  });

  it("товар с продажами без себестоимости может оказаться убыточнее — позиция только «среди точных»", () => {
    const { v } = run([...OA, ...OB, ...OD, ...NC], cat(["OA", "OB", "OD"]));
    assert.deepEqual([v.worst.article, v.worstScope, v.salesWithoutCost], ["OD", "exact_only", 1]);
    assert.match(S.accrualWorstSalesText(v).note, /\(1 из 4 с продажами\)\. У остальных результат известен лишь диапазоном или неизвестна себестоимость/);
  });

  it("неразделённые +50 и −60 одной ссылкой не сворачиваются в нетто −10: знак не определён, товар исключён", () => {
    const rows = [r(SALE, "Y", 1, "100.00", "Y-1"), r(LOG, "Y", 1, "-120.00", "Y-1"), r(COMP, "Y", 0, "50.00", "ORD-Y"), r(ACQ, "Y", 0, "-60.00", "ORD-Y")];
    const { s, v } = run(rows, cat(["Y"]));
    const y = s.products.find((p) => p.article === "Y");
    assert.deepEqual([y.split.unsplitUpKopecks, y.split.unsplitDownKopecks], [5000, -6000]);
    const a = SS.assessSalesLoss(y.split);
    assert.deepEqual([a.status, a.exact, a.lowerKopecks, a.upperKopecks], ["undetermined", false, -9000, 2000]);
    assert.deepEqual(v.losses, []);
    assert.deepEqual(v.excluded.map((x) => [x.article, x.lowerKopecks, x.upperKopecks]), [["Y", -9000, 2000]]);
    const t = S.accrualWorstSalesText(v);
    assert.deepEqual([t.emptyText, t.emptyTone], ["Доказанно убыточных продаж нет; у 1 товара знак результата продаж не определён.", "warn"]);
  });

  it("частичный возврат: себестоимость не сворачивается по нетто-количеству — «доказанного убытка» нет", () => {
    const rows = [
      r(SALE, "Z", 1, "200.00", "Z-1"), r(LOG, "Z", 1, "-10.00", "Z-1"),
      r(SALE, "Z", 2, "100.00", "Z-2"), r(RET, "Z", 1, "-50.00", "Z-2"),
    ];
    const { s, v } = run(rows, [{ sku: "Z", name: "Z", cost_price: 300 }]);
    const z = s.products.find((p) => p.article === "Z");
    assert.equal(z.profitKopecks, -36000, "полная прибыль не меняется: −110 + (100 − 50 − 300)");
    assert.equal(z.split.unsplitReasons.partial_return, 1);
    assert.deepEqual([z.split.unsplitUpKopecks, z.split.unsplitDownKopecks], [25000, -50000]);
    const a = SS.assessSalesLoss(z.split);
    assert.deepEqual([a.status, a.salesResultKopecks, a.lowerKopecks, a.upperKopecks], ["undetermined", -11000, -61000, 14000]);
    assert.deepEqual(v.losses, []);
    assert.deepEqual([v.worst, S.accrualKeyProducts(s).worst, S.accrualRecoProps(s).worst], [null, null, null]);
    assert.equal(
      nb(S.accrualSalesLossRanking(s).excluded[0].reason),
      "результат продаж не определён: от −610,00 ₽ до 140,00 ₽ — неразделённые операции могут изменить его знак"
    );
  });

  it("список: сначала точные (по величине), затем диапазоны — даже если верхняя граница диапазона ниже", () => {
    const OE = [r(SALE, "OE", 1, "100.00", "OE-1"), r(LOG, "OE", 1, "-140.00", "OE-1")]; // −50 точно
    const { v } = run([...OA, ...OE], cat(["OA", "OE"]));
    assert.deepEqual(bounds(v), [["OE", true, -5000, -5000, -5000], ["OA", false, null, -11000, -6000]]);
    assert.deepEqual([v.worst.article, v.worstScope], ["OE", "exact_only"]);
  });

  it("себестоимость единицы с долями копейки: копейка округления расширяет границу, а не сужает", () => {
    // 0,334 ₽: «Выручка» 2 шт → 67 коп., «Возврат выручки» 1 шт → 33 коп.; себестоимость
    // неразделённой части 33 коп. (копейка округления товара ушла в продажи): 67 − 33 = 34 ≠ 33.
    const rows = [
      r(SALE, "W", 1, "100.00", "W-1"),
      r(SALE, "W", 2, "10.00", "W-2"), r(RET, "W", 1, "-5.00", "W-2"),
    ];
    const { s } = run(rows, [{ sku: "W", name: "W", cost_price: 0.334 }]);
    const w = s.products.find((p) => p.article === "W");
    assert.deepEqual([w.split.parts.sales.cogsKopecks, w.split.parts.unsplit.cogsKopecks, w.cogsKopecks], [34, 33, 67]);
    // Элементы: 1000 − 67 = 933 и −500 + 33 = −467; остаток +1 → вверх.
    assert.deepEqual([w.split.unsplitUpKopecks, w.split.unsplitDownKopecks], [934, -467]);
  });

  it("снимок: границы неразделённых проверяются при чтении", () => {
    const { snap } = calcFor(buildReport([...OA, ...OB]), { catalog: cat(["OA", "OB"]) });
    const bad = viaJson(S.serializeAccrualSnapshot(snap));
    bad.products[0].split.unsplitUpKopecks += 100; // up + down ≠ прямые − себестоимость
    assert.equal(S.readAccrualSnapshot(bad).status, "invalid");
    const neg = viaJson(S.serializeAccrualSnapshot(snap));
    neg.products[0].split.unsplitDownKopecks = 1;
    assert.equal(S.readAccrualSnapshot(neg).status, "invalid");
  });
});
