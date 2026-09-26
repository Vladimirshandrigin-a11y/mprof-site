// Однозначные подписи выручки, список «Самые прибыльные товары» и статус доступа в
// кабинете. Настоящие модули проекта на синтетических данных (вымышленные артикулы).
//
// Контрольный пример выручки (ручной расчёт, копейки):
//   «Выручка» V: 3 шт × 900 = +2 700,00; «Возврат выручки» V: 2 шт = −1 850,00;
//   логистика −100,00 → итог начислений 750,00; себестоимость (3 − 2) × 100 = 100,00;
//   прибыль 650,00; выручка после возвратов 850,00; маржа 650 / 850 = 76,47 %.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accrualRow, buildReport, SCENARIOS } from "./helpers/fixtures.mjs";
import { access as A, calc as C, parseBuf, pdfModel as P, product as PC, snapshot as S } from "./helpers/modules.mjs";

const nb = (s) => String(s).replace(/[\u00a0\u202f]/g, " ");

function snapFor(buf, catalog, tax = 0) {
  const parsed = parseBuf(buf);
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.errors));
  const res = C.computeAccrualProfit({ report: parsed.report, catalog, taxRatePercent: tax, manualExpenses: {} });
  assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.error));
  return S.buildAccrualSnapshot({
    calc: res.calc,
    period: parsed.report.period,
    warnings: parsed.warnings,
    source: { sheet: parsed.report.sheetName, rowCount: parsed.report.summary.rowCount },
    generatedAt: "2026-07-01T10:00:00.000Z",
  });
}

describe("выручка: продажи до возвратов, возвраты, выручка после возвратов (2 700 / −1 850 / 850)", () => {
  const d = "2026-06-12";
  const rows = [
    accrualRow(d, "Продажи", "Выручка", "V", 3, "2700.00", "V-1", "V-sku", "Товар V"),
    accrualRow(d, "Возвраты", "Возврат выручки", "V", 2, "-1850.00", "V-1", "V-sku", "Товар V"),
    accrualRow(d, "Услуги доставки", "Логистика", "V", 3, "-100.00", "V-1", "V-sku", "Товар V"),
  ];
  const s = S.asAccrualSnapshot(JSON.parse(JSON.stringify(S.serializeAccrualSnapshot(snapFor(buildReport(rows), [{ sku: "V", name: "V", cost_price: 100 }])))));

  it("снимок: база налога и маржи = 850,00; маржа расчёта = 650 / 850", () => {
    assert.deepEqual([s.salesRevenueKopecks, s.returnsRevenueKopecks, s.taxRevenueBaseKopecks, s.netProfitKopecks], [270000, -185000, 85000, 65000]);
    assert.equal(s.marginPercent, 76.47);
  });

  it("экран/PDF: три разные строки подряд, возвраты со своим знаком, справочная строка не входит в итог", () => {
    const br = S.accrualBreakdownRows(s);
    assert.deepEqual(
      br.slice(0, 3).map((r) => [r.label, r.kopecks, r.kind]),
      [["Продажи до возвратов", 270000, "neutral"], ["Возвраты выручки", -185000, "expense"], ["Выручка после возвратов", 85000, "neutral"]]
    );
    assert.match(br[2].note, /От неё считаются налог и маржа расчёта/);
    const net = br.find((r) => r.key === "net");
    const categories = br.slice(0, br.indexOf(net)).filter((r) => r.key !== "revenueAfterReturns");
    assert.equal(categories.reduce((a, r) => a + r.kopecks, 0), net.kopecks, "Σ категорий = итог начислений без справочной строки");
  });

  it("PDF: те же подписи и суммы; пояснение о базе маржи", () => {
    const m = P.buildAccrualPdfModel(s, new Date(2026, 6, 1));
    assert.deepEqual(
      m.rows.slice(0, 3).map((r) => [r.label, nb(r.value)]),
      [["Продажи до возвратов", "2 700,00 ₽"], ["Возвраты выручки", "−1 850,00 ₽"], ["Выручка после возвратов", "850,00 ₽"]]
    );
    assert.equal(nb(m.hero.stats[0].value), "76,5 %");
    assert.ok(m.explanations.some((t) => t.startsWith("Маржа расчёта = прибыль / выручка после возвратов")));
    assert.ok(!JSON.stringify(m).includes("Реализация (выручка)"));
  });

  it("детали истории: продажи 2 700, возвраты −1 850, выручка после возвратов 850 — справочно", () => {
    assert.deepEqual(
      S.accrualHistDetailRows(s).slice(0, 3).map((r) => [r.label, r.value, r.kind]),
      [
        ["Продажи до возвратов", 2700, "neutral"],
        ["Возвраты выручки", 1850, "expense"],
        ["Выручка после возвратов (справочно, база маржи)", 850, "neutral"],
      ]
    );
    assert.equal(S.ACCRUAL_REVENUE_LABELS.afterReturns, "Выручка после возвратов");
    assert.equal(S.ACCRUAL_MARGIN_BASE_NOTE, "от выручки после возвратов");
  });

  it("рейтинг продаж сохраняет свою базу — выручку продаж (без возвратных групп)", () => {
    const v = S.accrualSalesSplitView(s);
    assert.equal(v.availability, "ok");
    // Одна группа V-1 с частичным возвратом → неразделённая; продаж без возвратов нет.
    assert.equal(v.sales.products, 0);
  });
});

describe("«Самые прибыльные товары»: сначала отбор прибыли > 0, затем сортировка и ограничение", () => {
  const row = (article, profit, hasCost = true) => ({ article, profit, hasCost });

  it("нулевая, отрицательная, неизвестная и без себестоимости — не попадают; порядок по убыванию", () => {
    const rows = [row("Z", 0), row("N", -5), row("U", null), row("A", 30), row("B", 10), row("C", 100, false), row("F", Number.NaN)];
    assert.deepEqual(PC.pickProfitableRows(rows).map((r) => r.article), ["A", "B"]);
  });

  it("меньше 10 прибыльных — список короче, без убыточных «добивок»", () => {
    const rows = [row("A", 5), ...Array.from({ length: 12 }, (_, i) => row(`L${i}`, -i - 1))];
    assert.deepEqual(PC.pickProfitableRows(rows).map((r) => r.article), ["A"]);
  });

  it("прибыльных нет — пусто", () => {
    assert.deepEqual(PC.pickProfitableRows([row("A", 0), row("B", -1), row("C", null)]), []);
  });

  it("отбор до ограничения: 12 прибыльных → первые 10 по убыванию; limit=2 не пропускает убыточные вперёд", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`P${String(i).padStart(2, "0")}`, i + 1));
    const top = PC.pickProfitableRows(rows);
    assert.equal(top.length, 10);
    assert.deepEqual([top[0].profit, top[9].profit], [12, 3]);
    assert.deepEqual(PC.pickProfitableRows([row("X", -1000), row("S", 5), row("T", 3), row("W", 1)], 2).map((r) => r.article), ["S", "T"]);
    assert.equal(PC.TOP_PROFITABLE_LIMIT, 10);
  });

  it("равная прибыль — детерминированно по артикулу", () => {
    assert.deepEqual(PC.pickProfitableRows([row("B", 7), row("A", 7)]).map((r) => r.article), ["A", "B"]);
  });

  it("снимок без прибыльных товаров: «лучшего» нет (PDF и рекомендации), блок ключевых товаров остаётся", () => {
    const expensive = ["ART-A", "ART-B", "ART-C"].map((sku) => ({ sku, name: sku, cost_price: 100000 }));
    const s = snapFor(SCENARIOS.basic(), expensive);
    assert.ok(s.products.every((p) => p.profitKopecks === null || p.profitKopecks <= 0));
    const kp = S.accrualKeyProducts(s);
    assert.equal(kp.best, null);
    assert.ok(kp.scoredCount > 0);
    const m = P.buildAccrualPdfModel(s, new Date(2026, 6, 1));
    assert.ok(m.keyProducts, "блок ключевых товаров не пропадает");
    assert.deepEqual([m.keyProducts.best, m.keyProducts.bestEmptyText], [null, "Прибыльных товаров нет"]);
    assert.equal(S.accrualRecoProps(s).best, null);
  });

  it("снимок с прибыльными: «лучший» = первый из того же списка", () => {
    const cheap = ["ART-A", "ART-B", "ART-C"].map((sku) => ({ sku, name: sku, cost_price: 1 }));
    const s = snapFor(SCENARIOS.basic(), cheap);
    const rows = S.accrualProductBreakdownRows(s);
    const top = PC.pickProfitableRows(rows);
    assert.ok(top.length > 0);
    assert.equal(S.accrualKeyProducts(s).best.article, top[0].article);
  });
});

describe("кабинет: статус доступа по правам из entitlements", () => {
  const NOW = Date.parse("2026-09-27T12:00:00Z");
  const base = { loaded: true, hasPremium: false, premiumUntil: null, calcCount: 0, freeLimit: 1, singleCredits: 0, now: NOW };
  const st = (o) => A.accessStatus({ ...base, ...o });

  it("права загружаются — ничего не утверждаем (нет «Нет доступных расчётов»)", () => {
    const x = st({ loaded: false, calcCount: 5 });
    assert.deepEqual([x.kind, x.planLabel, x.available], ["loading", "…", "…"]);
  });

  it("первая бесплатная попытка доступна", () => {
    const x = st({});
    assert.deepEqual([x.kind, x.planLabel, x.available, x.remaining], ["free", "Бесплатный расчёт", "1 бесплатный", 1]);
  });

  it("бесплатная + оплаченные разовые", () => {
    const x = st({ singleCredits: 2 });
    assert.deepEqual([x.kind, x.available, x.remaining], ["free_and_credits", "3 (1 бесплатный и 2 разовых)", 3]);
  });

  it("бесплатная использована, остались разовые кредиты", () => {
    const x = st({ calcCount: 1, singleCredits: 2 });
    assert.deepEqual([x.kind, x.planLabel, x.available], ["credits", "Разовые расчёты", "2"]);
    assert.match(x.detail, /^Доступно 2 разовых расчёта/);
  });

  it("разовые кредиты исчерпаны — «Нет доступных расчётов», а не «Разовые расчёты»", () => {
    const x = st({ calcCount: 2, singleCredits: 1 });
    assert.deepEqual([x.kind, x.planLabel, x.available, x.remaining], ["none", "Нет доступных расчётов", "0", 0]);
    assert.match(x.detail, /оплаченные разовые расчёты использованы/);
  });

  it("бесплатная использована, кредитов не было", () => {
    const x = st({ calcCount: 1 });
    assert.deepEqual([x.kind, x.planLabel], ["none", "Нет доступных расчётов"]);
    assert.match(x.detail, /^Бесплатный расчёт использован/);
  });

  it("активный безлимит — приоритетнее счётчика", () => {
    const x = st({ hasPremium: true, premiumUntil: "2026-10-20T00:00:00Z", calcCount: 40 });
    assert.deepEqual([x.kind, x.planLabel, x.available, x.remaining, x.expiredUntil], ["unlimited", "Безлимит", "Без ограничений", null, null]);
  });

  it("истёкший безлимит — статус по оставшимся расчётам + дата окончания", () => {
    const x = st({ hasPremium: false, premiumUntil: "2026-09-01T00:00:00Z", calcCount: 7 });
    assert.deepEqual([x.kind, x.planLabel, x.expiredUntil], ["none", "Нет доступных расчётов", "2026-09-01T00:00:00Z"]);
    const y = st({ hasPremium: false, premiumUntil: "2026-09-01T00:00:00Z", calcCount: 1, singleCredits: 1 });
    assert.deepEqual([y.kind, y.expiredUntil], ["credits", "2026-09-01T00:00:00Z"]);
  });
});
