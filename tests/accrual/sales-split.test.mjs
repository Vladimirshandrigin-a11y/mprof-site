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

  it("1) убыточная продажа без возврата: продажи −60 ₽, маржа продаж −60 %, товар в рейтинге", () => {
    const L = byArt(calc, "L");
    assert.equal(partResult(L, "sales"), -6000);
    assert.equal(partResult(L, "unsplit"), -1500); // реклама по номеру заказа — без связи
    assert.equal(L.split.unsplitReasons.no_sale_link, 1);
    assert.equal(L.profitKopecks, -7500);
    const row = view.losses.find((x) => x.article === "L");
    assert.deepEqual([row.salesRevenueKopecks, row.salesResultKopecks, row.salesMarginPercent], [10000, -6000, -60]);
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
      ["Реализация (выручка)", 40000],
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
    assert.deepEqual([ex.salesResultKopecks, ex.lowerKopecks, ex.upperKopecks], [-4000, -22000, 26000]);
    const ranking = S.accrualSalesLossRanking(S.asAccrualSnapshot(viaJson(snap)));
    assert.match(ranking.excluded.find((x) => x.article === "U").reason, /могут изменить его знак/);
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

  it("рейтинг «Продажи в минус»: только L; самый убыточный по продажам — L", () => {
    assert.deepEqual(view.losses.map((x) => x.article), ["L"]);
    assert.deepEqual(view.excluded.map((x) => x.article), ["U"], "без продаж (P, A, R, S, K) не исключаются — они вне рейтинга");
    assert.equal(view.sales.products, 5, "товары с группой продаж: L, M, U, X1, E (у A связь неоднозначна)");
    assert.equal(view.worst.article, "L");
    const kp = S.accrualKeyProducts(S.asAccrualSnapshot(viaJson(snap)));
    assert.deepEqual([kp.worst.article, kp.worst.profitKopecks, kp.worst.marginPercent, kp.worst.basis], ["L", -6000, -60, "sales"]);
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

  it("карточка «самый убыточный по продажам» = L; сводка частей и сверка в PDF", () => {
    assert.equal(m.keyProducts.worstTitle, "САМЫЙ УБЫТОЧНЫЙ ПО ПРОДАЖАМ");
    assert.equal(m.keyProducts.worst.article, "L");
    assert.equal(nb(m.keyProducts.worst.profit), "−60,00 ₽");
    assert.equal(nb(m.keyProducts.worst.margin), "−60,0 %");
    const lines = m.splitLines.map(nb);
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

  it("рекомендации получают того же «худшего» с basis=sales", () => {
    const reco = S.accrualRecoProps(snap);
    assert.deepEqual([reco.worst.article, reco.worst.profit, reco.worst.margin, reco.worst.basis], ["L", -60, -60, "sales"]);
  });

  it("выручка без ведущего плюса, настоящий минус сохраняется", () => {
    const rev = m.rows.find((x) => x.label === "Реализация (выручка)");
    assert.equal(rev.kind, "neutral");
    assert.equal(nb(rev.value), "2 700,00 ₽");
    const ret = m.rows.find((x) => x.label === "Возвраты выручки");
    assert.match(nb(ret.value), /^−/);
  });
});
