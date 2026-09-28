// Себестоимость Ozon API = (продано − возвращено) × цена — согласованно с XLSX «Отчётом
// по начислениям». Один и тот же месяц продаж и возвратов прогоняется через НАСТОЯЩИЕ
// модули обоих путей: отчёт реализации (buildRealizationDiagnostic →
// resolveRealizationProductionCost → computeApiProfit) и строки начислений
// (computeAccrualProfit). Сохранение и восстановление — в tests/db.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calc as CALC, profitLib as PROFIT, realizationLib as RZ } from "./helpers/modules.mjs";

/**
 * Месяц: [{ offer, sku, sold, soldRub, returned, returnedRub }] (строк отчёта реализации
 * по товару может быть несколько — rows: [...]). Возвращает оба расчёта себестоимости.
 */
function bothPaths(month, catalog) {
  const rzRows = [];
  const accrualRows = [];
  let n = 0;
  for (const m of month) {
    for (const r of m.rows ?? [m]) {
      rzRows.push({
        item: { offer_id: m.offer, sku: m.sku, name: m.offer },
        delivery_commission: { amount: r.soldRub ?? 0, quantity: r.sold ?? 0 },
        return_commission: { amount: r.returnedRub ?? 0, quantity: r.returned ?? 0 },
      });
      const base = { date: "2026-08-15", group: "Продажи", knownTaxonomy: true, article: m.offer, sku: String(m.sku), name: m.offer };
      if (r.sold) accrualRows.push({ ...base, rowNumber: ++n, type: "Выручка", bucket: "salesRevenue", quantity: r.sold, amountKopecks: Math.round((r.soldRub ?? 0) * 100) });
      if (r.returned) accrualRows.push({ ...base, rowNumber: ++n, type: "Возврат выручки", bucket: "returnsRevenue", quantity: r.returned, amountKopecks: -Math.round((r.returnedRub ?? 0) * 100) });
    }
  }
  const diag = RZ.buildRealizationDiagnostic({ ok: true, rows: rzRows, rawRowCount: rzRows.length }, catalog, 8, 2026);
  const api = PROFIT.resolveRealizationProductionCost(diag);
  const xlsx = CALC.computeAccrualProfit({
    report: { rows: accrualRows, period: { month: "2026-08", periodComplete: true } },
    catalog,
    taxRatePercent: 7,
  });
  return { diag, api, xlsx };
}

const CATALOG = [
  { sku: "ART-A", name: "Товар А", cost_price: 100 },
  { sku: "ART-B", name: "Товар Б", cost_price: 50 },
  { sku: "ART-C", name: "Товар В", cost_price: 20 },
];
// Воспроизведённый пример аудита: A — 10 продано и 2 возвращено; B — 5 продано;
// C — только возврат 1 шт. (продажа была в прошлом месяце).
const AUDIT_MONTH = [
  { offer: "ART-A", sku: 111, sold: 10, soldRub: 1500, returned: 2, returnedRub: 300 },
  { offer: "ART-B", sku: 222, sold: 5, soldRub: 900 },
  { offer: "ART-C", sku: 333, returned: 1, returnedRub: 100 },
];

describe("себестоимость API = продано − возвращено, как в XLSX «Отчёте по начислениям»", () => {
  it("пример аудита: API = XLSX = 1030 ₽ (прежнее правило «только продано» давало 1250 ₽)", () => {
    const { diag, api, xlsx } = bothPaths(AUDIT_MONTH, CATALOG);
    assert.equal(api.ok, true);
    assert.equal(xlsx.calc.productionCostKopecks, 103000);
    assert.equal(api.productionCost, 1030, "себестоимость API по нетто-количеству");
    assert.equal(api.productionCost * 100, xlsx.calc.productionCostKopecks);
    assert.equal(diag.candidateCogs.bySaleQty, 1250, "прежнее правило — справочно");
    assert.equal(api.realizationRevenueForTax, xlsx.calc.taxRevenueBaseKopecks / 100, "база налога не изменилась");
  });

  it("продажи без возвратов — прежний итог: Σ продано × цена, как раньше и как в XLSX", () => {
    const month = [
      { offer: "ART-A", sku: 111, sold: 10, soldRub: 1500 },
      { offer: "ART-B", sku: 222, sold: 5, soldRub: 900 },
    ];
    const { diag, api, xlsx } = bothPaths(month, CATALOG);
    assert.equal(api.productionCost, 1250);
    assert.equal(api.productionCost, diag.candidateCogs.bySaleQty, "без возвратов новое правило = прежнему");
    assert.equal(api.productionCost * 100, xlsx.calc.productionCostKopecks);
  });

  it("частичный возврат: вычитается ровно один раз (8 × 100 ₽), в том числе если продажа и возврат в разных строках отчёта", () => {
    const oneRow = bothPaths([{ offer: "ART-A", sku: 111, sold: 10, soldRub: 1500, returned: 2, returnedRub: 300 }], CATALOG);
    const split = bothPaths(
      [{ offer: "ART-A", sku: 111, rows: [{ sold: 10, soldRub: 1500 }, { returned: 2, returnedRub: 300 }] }],
      CATALOG
    );
    for (const { api, xlsx } of [oneRow, split]) {
      assert.equal(api.productionCost, 800);
      assert.equal(api.productionCost * 100, xlsx.calc.productionCostKopecks);
    }
  });

  it("возврат с отрицательным количеством в ответе Ozon вычитается так же (знак не удваивает и не отменяет возврат)", () => {
    const month = [{ offer: "ART-A", sku: 111, sold: 10, soldRub: 1500, returned: -2, returnedRub: 300 }];
    const { api } = bothPaths(month, CATALOG);
    assert.equal(api.productionCost, 800);
  });

  it("продажи равны возвратам: вклад товара 0, остальные товары считаются как обычно", () => {
    const month = [
      { offer: "ART-A", sku: 111, sold: 3, soldRub: 450, returned: 3, returnedRub: 450 },
      { offer: "ART-B", sku: 222, sold: 5, soldRub: 900 },
    ];
    const { api, xlsx } = bothPaths(month, CATALOG);
    assert.equal(api.productionCost, 250);
    assert.equal(api.productionCost * 100, xlsx.calc.productionCostKopecks);
    const a = xlsx.calc.products.find((p) => p.article === "ART-A");
    assert.deepEqual([a.netQuantity, a.cogsKopecks], [0, 0]);
  });

  it("возврат без продаж даёт отрицательный вклад; отрицательный итог не обрезается до нуля — ни в резолвере, ни в прибыли", () => {
    // Дешёвые продажи и возврат дорогого товара прошлого месяца: нетто-себестоимость < 0.
    const catalog = [...CATALOG, { sku: "ART-X", name: "Дорогой", cost_price: 500 }];
    const month = [
      { offer: "ART-C", sku: 333, sold: 10, soldRub: 3000 },
      { offer: "ART-X", sku: 999, returned: 1, returnedRub: 900 },
    ];
    const { api, xlsx } = bothPaths(month, catalog);
    assert.equal(api.ok, true, "продажи есть, база налога > 0 — расчёт разрешён");
    assert.equal(api.productionCost, 10 * 20 - 500);
    assert.equal(api.productionCost * 100, xlsx.calc.productionCostKopecks);
    const totals = { revenue: 2100, commission: -300, logistics: 0, services: 0, storage: 0, ads: 0, adjustments: 0, other: 0 };
    const c = PROFIT.computeApiProfit(totals, api.productionCost, api.realizationRevenueForTax, { tax: 7, packaging: 0, warehouseDelivery: 0, salary: 0, other: 0 });
    assert.equal(c.matchedCostTotal, -300, "отрицательная себестоимость сохраняется как есть");
    assert.equal(c.profitBeforeManualExpenses, 1800 + 300);
    assert.equal(c.status, "complete_cost");
  });

  it("цены с копейками и дробные цены: округление по товару, как в XLSX (Math.round(нетто × цена × 100)), без накопления ошибок сложения", () => {
    const catalog = [
      { sku: "K-1", name: "k1", cost_price: 10.555 },
      { sku: "K-2", name: "k2", cost_price: 0.1 },
      { sku: "K-3", name: "k3", cost_price: 0.2 },
      { sku: "K-4", name: "k4", cost_price: 99.99 },
      { sku: "K-5", name: "k5", cost_price: 33.335 },
    ];
    const month = [
      // один товар в двух строках отчёта: по строкам было бы 10.56 + 10.56, по товару — 21.11
      { offer: "K-1", sku: 1, rows: [{ sold: 1, soldRub: 50 }, { sold: 1, soldRub: 50 }] },
      { offer: "K-2", sku: 2, sold: 1, soldRub: 10 },
      { offer: "K-3", sku: 3, sold: 1, soldRub: 10 },
      { offer: "K-4", sku: 4, sold: 7, soldRub: 1400, returned: 2, returnedRub: 400 },
      // возврат без продажи с дробной ценой: отрицательное полукопеечное значение
      { offer: "K-5", sku: 5, returned: 1, returnedRub: 60 },
    ];
    const { api, xlsx } = bothPaths(month, catalog);
    assert.equal(api.ok, true);
    assert.equal(Math.round(api.productionCost * 100), xlsx.calc.productionCostKopecks);
    const byArticle = Object.fromEntries(xlsx.calc.products.map((p) => [p.article, p.cogsKopecks]));
    assert.deepEqual(byArticle, { "K-1": 2111, "K-2": 10, "K-3": 20, "K-4": 49995, "K-5": -3333 });
    assert.equal(api.productionCost, (2111 + 10 + 20 + 49995 - 3333) / 100);
  });

  it("неполная себестоимость по-прежнему не разрешает расчёт: товар возврата не в каталоге, цена 0, нет продаж, нет количеств", () => {
    const notInCatalog = bothPaths([...AUDIT_MONTH, { offer: "ART-Z", sku: 777, returned: 1, returnedRub: 50 }], CATALOG);
    assert.deepEqual([notInCatalog.api.ok, notInCatalog.api.code], [false, "unmatched"]);
    assert.equal(notInCatalog.xlsx.calc.readyToSave, false, "XLSX тоже не сохраняет");

    const zeroPrice = bothPaths(AUDIT_MONTH, CATALOG.map((c) => (c.sku === "ART-C" ? { ...c, cost_price: 0 } : c)));
    assert.deepEqual([zeroPrice.api.ok, zeroPrice.api.code], [false, "no_cost"]);
    assert.equal(zeroPrice.xlsx.calc.readyToSave, false);

    const noQty = RZ.buildRealizationDiagnostic(
      { ok: true, rows: [{ item: { offer_id: "ART-A", sku: 111 }, delivery_commission: { amount: 1500 }, return_commission: { amount: 0 } }], rawRowCount: 1 },
      CATALOG, 8, 2026
    );
    assert.deepEqual([PROFIT.resolveRealizationProductionCost(noQty).ok, PROFIT.resolveRealizationProductionCost(noQty).code], [false, "zero_cost"]);
  });

  it("месяц только с возвратами оценённого товара: себестоимость −цена × возвращено, проверка себестоимости его не блокирует; останавливает база налога ≤ 0 — в API и в XLSX одинаково", () => {
    const { diag, api, xlsx } = bothPaths([{ offer: "ART-R", sku: 555, returned: 1, returnedRub: 2000 }], [{ sku: "ART-R", name: "r", cost_price: 1600 }]);
    assert.deepEqual([diag.candidateCogs.byNetQty, diag.candidateCogs.bySaleQty, diag.candidateCogs.pricedQuantity], [-1600, 0, 1]);
    assert.deepEqual([api.ok, api.code], [false, "no_tax_revenue"], "не zero_cost: себестоимость известна");
    assert.deepEqual([xlsx.ok, xlsx.error.code], [false, "no_tax_revenue"]);
  });

  it("ответ расчёта и снимок помечают правило: costQuantityBasis — только у новых расчётов", () => {
    assert.equal(PROFIT.API_COST_QUANTITY_BASIS, "sold_minus_returned");
  });
});
