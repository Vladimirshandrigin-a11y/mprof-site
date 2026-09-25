// Финансовое ядро, товарная аналитика и деньги (копейки, метод наибольших
// остатков). Вход — результат НАСТОЯЩЕГО парсера на синтетических XLSX;
// ожидания — независимые литералы из helpers/expected.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { CAT, EXPECTED_BASIC as E } from "./helpers/expected.mjs";
import { analytics as A, calc as C, money as M, parseBuf } from "./helpers/modules.mjs";

const report = (name) => {
  const r = parseBuf(scenario(name));
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.errors));
  return r.report;
};
const input = (rep, over = {}) => ({
  report: rep,
  catalog: CAT,
  taxRatePercent: 7,
  manualExpenses: { packaging: 10, other: 3.33 },
  ...over,
});
const run = (rep, over) => {
  const res = C.computeAccrualProfit(input(rep, over));
  assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.error));
  return res.calc;
};

describe("формула прибыли (базовый отчёт)", () => {
  const basic = report("basic");
  const c = run(basic);

  it("taxRevenueBase = продажи + возвраты = 1200,00 ₽", () => {
    assert.equal(c.salesRevenueKopecks, E.sales);
    assert.equal(c.returnsRevenueKopecks, E.returns);
    assert.equal(c.taxRevenueBaseKopecks, E.base);
  });
  it("себестоимость = нетто-количество × cost (250,00 ₽); строки услуг не размножают себестоимость", () => {
    assert.equal(c.productionCostKopecks, E.production);
  });
  it("tax = 7% от taxRevenueBase = 84,00 ₽", () => {
    assert.equal(c.taxKopecks, E.tax);
  });
  it("ручные расходы = 13,33 ₽", () => {
    assert.equal(c.manualExpenses.totalKopecks, E.manual);
  });
  it("netProfit = 590,13 ₽", () => {
    assert.equal(c.netProfitKopecks, E.netProfit);
  });
  it("margin = 49,18 %", () => {
    assert.equal(c.marginPercent, E.margin);
  });
  it("profitBeforeCost = netOzonOperations (корзины повторно не вычитаются)", () => {
    assert.equal(c.profitBeforeCostKopecks, E.net);
    assert.equal(c.netOzonOperationsKopecks, E.net);
  });
  it("Σ корзин в результате === netOzonOperations", () => {
    assert.equal(
      Object.values(c.buckets).reduce((a, b) => a + b, 0),
      c.netOzonOperationsKopecks
    );
  });
  it("покрытие полное: readyToSave, не предварительный", () => {
    assert.equal(c.costCoverage.complete, true);
    assert.equal(c.readyToSave, true);
    assert.equal(c.preliminary, false);
  });
  it("штуки: продано 4, возвращено 1, нетто 3", () => {
    assert.deepEqual(c.quantities, E.quantities);
  });
});

describe("товарная аналитика и reconciliation", () => {
  const c = run(report("basic"));
  const byArt = (art) => c.products.find((p) => p.article === art);

  it("Σ прибыль товаров === netProfit до копейки", () => {
    assert.equal(c.reconciliation.reconciles, true);
    assert.equal(c.reconciliation.productProfitSumKopecks, E.netProfit);
  });
  for (const [art, e] of Object.entries(E.products)) {
    it(`товар ${art}: direct/G/T/M/cogs/profit совпадают с независимым расчётом`, () => {
      const p = byArt(art);
      assert.deepEqual(
        [p.directKopecks, p.allocatedGeneralKopecks, p.allocatedTaxKopecks, p.allocatedManualKopecks, p.cogsKopecks, p.profitKopecks],
        [e.direct, e.G, e.T, e.M, e.cogs, e.profit]
      );
      assert.equal(p.marginPercent, e.margin);
    });
  }
  it("товар только с услугами не потерян: serviceOnly, без общих/налога/ручных, маржа null", () => {
    const p = byArt("ART-C");
    assert.equal(p.serviceOnly, true);
    assert.equal(p.costRequired, false);
    assert.equal(p.profitKopecks, -700);
    assert.equal(p.marginPercent, null);
  });
  it("Σ direct товаров + общие строки = netOzon (нет искусственной корзины/остатка)", () => {
    const direct = c.products.reduce((a, p) => a + p.directKopecks, 0);
    assert.equal(direct + c.productTotals.allocatedGeneralKopecks, E.net);
  });
  it("Σ налога и ручных по товарам = итоговые значения (распределены одними весами)", () => {
    assert.equal(c.productTotals.allocatedTaxKopecks, E.tax);
    assert.equal(c.productTotals.allocatedManualKopecks, E.manual);
    assert.equal(c.productTotals.allocatedGeneralKopecks, -3554);
  });
  it("порядок товаров детерминирован: реализация ↓, затем ключ", () => {
    assert.deepEqual(c.products.map((p) => p.article), ["ART-A", "ART-B", "ART-C"]);
  });
  it("адаптер ProductBreakdownRow: рубли, нетто-количество, партнёры → loyaltyPayout", () => {
    const rows = A.toProductBreakdownRows(c.products);
    const a = rows.find((r) => r.article === "ART-A");
    assert.deepEqual(
      [a.revenue, a.returnsAmount, a.quantity, a.cogs, a.profit, a.hasCost, a.matched, a.unitCost],
      [700, 300, 2, 200, 267.49, true, true, 100]
    );
    assert.equal(rows.find((r) => r.article === "ART-B").loyaltyPayout, 5);
  });
  it("адаптер: товар только с услугами → hasCost=true, cogs=0, флаги serviceOnly/costRequired", () => {
    const cRow = A.toProductBreakdownRows(c.products).find((r) => r.article === "ART-C");
    assert.deepEqual([cRow.hasCost, cRow.cogs, cRow.serviceOnly, cRow.costRequired], [true, 0, true, false]);
  });
});

describe("no_tax_revenue", () => {
  for (const name of ["tax_zero", "tax_negative"]) {
    it(`${name}: taxRevenueBase ≤ 0 → ошибка, а не прибыль с нулевым налогом`, () => {
      const res = C.computeAccrualProfit(input(report(name)));
      assert.equal(res.ok, false);
      assert.equal(res.error.code, "no_tax_revenue");
      assert.ok(res.error.taxRevenueBaseKopecks <= 0);
    });
  }
});

describe("неполная себестоимость", () => {
  const basic = report("basic");

  it("товара B нет в каталоге → preliminary, readyToSave=false, честное покрытие", () => {
    const c = run(basic, { catalog: [CAT[0]] });
    assert.equal(c.preliminary, true);
    assert.equal(c.readyToSave, false);
    assert.deepEqual(
      [c.costCoverage.requiredProducts, c.costCoverage.withCost, c.costCoverage.missingCost, c.costCoverage.complete],
      [2, 1, 1, false]
    );
  });
  it("прибыль товара без себестоимости = null (не 0), cogs = null, matched=false", () => {
    const b = run(basic, { catalog: [CAT[0]] }).products.find((p) => p.article === "ART-B");
    assert.deepEqual(
      [b.profitKopecks, b.cogsKopecks, b.marginPercent, b.hasCost, b.matched],
      [null, null, null, false, false]
    );
  });
  it("productionCost — только по известным (A = 200,00 ₽)", () => {
    assert.equal(run(basic, { catalog: [CAT[0]] }).productionCostKopecks, 20000);
  });
  it("reconciles = null при неполном покрытии; profitComplete=false", () => {
    const c = run(basic, { catalog: [CAT[0]] });
    assert.equal(c.reconciliation.reconciles, null);
    assert.equal(c.productTotals.profitComplete, false);
  });
  it("cost_price = 0 не считается себестоимостью", () => {
    const c = run(basic, { catalog: [CAT[0], { sku: "ART-B", name: "b", cost_price: 0 }] });
    assert.equal(c.preliminary, true);
    assert.equal(c.products.find((p) => p.article === "ART-B").hasCost, false);
  });
  it("пустой каталог → 0 товаров с себестоимостью, не готово к сохранению", () => {
    const c = run(basic, { catalog: [] });
    assert.deepEqual([c.costCoverage.withCost, c.productionCostKopecks, c.readyToSave], [0, 0, false]);
  });
  it("матч по нормализованному артикулу; первая запись каталога побеждает", () => {
    const c = run(basic, {
      catalog: [{ sku: " art-a ", name: "x", cost_price: 100 }, { sku: "ART-A", name: "dup", cost_price: 999 }, CAT[1]],
    });
    assert.equal(c.productionCostKopecks, E.production);
    assert.equal(c.readyToSave, true);
  });
  it("каталог не изменяется расчётом", () => {
    const frozen = JSON.stringify(CAT);
    run(basic);
    assert.equal(JSON.stringify(CAT), frozen);
  });
});

describe("строки продажи без артикула, слияние артикулов, возврат без продажи", () => {
  it("продажа без артикула входит в базу, но себестоимость не посчитать → preliminary", () => {
    const c = run(report("sale_without_article"));
    assert.equal(c.taxRevenueBaseKopecks, E.base + 20000);
    assert.equal(c.costCoverage.unattributedNetQuantity, 2);
    assert.equal(c.preliminary, true);
    assert.equal(c.readyToSave, false);
  });
  it("общие строки + продажа без артикула раздаются точно: −35,54 + 200,00 = 164,46 ₽", () => {
    const c = run(report("sale_without_article"));
    assert.equal(c.productTotals.allocatedGeneralKopecks, 16446);
    assert.equal(c.reconciliation.reconciles, null);
  });
  it("артикулы сливаются по нормализованному ключу: A продано 4, возвращено 1, нетто 3; B — только услуги", () => {
    const c = run(report("article_normalization"));
    const a = c.products.find((p) => p.article.toLowerCase().trim() === "art-a");
    assert.equal(a.netQuantity, 3);
    assert.equal(c.products.find((p) => p.article === "ART-B").serviceOnly, true);
  });
  it("товар только с возвратом: нетто −1, себестоимость возвращается кредитом −100,00 ₽, маржа null", () => {
    const c = run(report("return_only_product"));
    const a = c.products.find((p) => p.article === "ART-A");
    assert.deepEqual([a.netQuantity, a.cogsKopecks, a.marginPercent], [-1, -10000, null]);
    assert.equal(c.reconciliation.reconciles, true);
  });
});

describe("валидация входа расчёта", () => {
  const basic = report("basic");
  const err = (over) => C.computeAccrualProfit(input(basic, over)).error?.code;

  it("ставка 101 → invalid_tax_rate", () => assert.equal(err({ taxRatePercent: 101 }), "invalid_tax_rate"));
  it("ставка NaN → invalid_tax_rate", () => assert.equal(err({ taxRatePercent: NaN }), "invalid_tax_rate"));
  it("ставка 7,125 (3 знака) → invalid_tax_rate", () => assert.equal(err({ taxRatePercent: 7.125 }), "invalid_tax_rate"));
  it("отрицательный ручной расход → invalid_manual_expenses", () =>
    assert.equal(err({ manualExpenses: { salary: -1 } }), "invalid_manual_expenses"));
  it("пустой отчёт → empty_report", () => {
    const res = C.computeAccrualProfit({
      report: { rows: [], period: { month: "2026-06", periodComplete: true } },
      catalog: CAT,
      taxRatePercent: 7,
    });
    assert.equal(res.error.code, "empty_report");
  });
  it("ставка 0 и без ручных расходов: tax=0, manual=0, netProfit = net − cost", () => {
    const c = run(basic, { taxRatePercent: 0, manualExpenses: undefined });
    assert.deepEqual([c.taxKopecks, c.manualExpenses.totalKopecks], [0, 0]);
    assert.equal(c.netProfitKopecks, E.net - E.production);
    assert.equal(c.reconciliation.reconciles, true);
  });
});

describe("деньги: копейки и метод наибольших остатков", () => {
  const LR = M.allocateLargestRemainder;
  it("100 на три равных → 34/33/33 (лишняя копейка — первому по ключу)", () => {
    assert.deepEqual(LR(100, [1, 1, 1], ["a", "b", "c"]), [34, 33, 33]);
  });
  it("−100 на три равных: Σ = −100 (отрицательные суммы)", () => {
    assert.equal(LR(-100, [1, 1, 1], ["a", "b", "c"]).reduce((a, b) => a + b), -100);
  });
  it("нулевой вес ничего не получает", () => {
    assert.equal(LR(7, [5, 0, 5], ["a", "b", "c"])[1], 0);
  });
  it("Σ весов = 0 → null", () => {
    assert.equal(LR(10, [0, 0], ["a", "b"]), null);
  });
  it("детерминизм при равных остатках: порядок по ключу", () => {
    assert.deepEqual(LR(1, [1, 1], ["b", "a"]), [0, 1]);
  });
  it("parseMoneyText: «−1 234,56» → −123456; «1.5» → 150; мусор/пусто → null", () => {
    assert.equal(M.parseMoneyText("−1 234,56").kopecks, -123456);
    assert.equal(M.parseMoneyText("1.5").kopecks, 150);
    assert.equal(M.parseMoneyText("abc"), null);
    assert.equal(M.parseMoneyText(""), null);
  });
  it("rublesToKopecks: 3247.9 → 324790; 409782.84 → 40978284; NaN → null", () => {
    assert.equal(M.rublesToKopecks(3247.9).kopecks, 324790);
    assert.equal(M.rublesToKopecks(409782.84).kopecks, 40978284);
    assert.equal(M.rublesToKopecks(NaN), null);
  });
  it("percentOfKopecks: 409 403,80 ₽ × 7% = 28 658,27 ₽", () => {
    assert.equal(M.percentOfKopecks(40940380, 700), 2865827);
  });
});
