// Свойства на СЛУЧАЙНЫХ отчётах (фиксированный seed → воспроизводимо).
//
// Отчёт строится в памяти (строки AccrualRow), прогоняется через настоящее
// ядро computeAccrualProfit; ожидания считает независимый «оракул» в этом файле
// (простая арифметика на копейках и BigInt-раздача с точным сравнением дробей),
// а не проверяемая функция.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buckets as K, calc as C, money as M } from "./helpers/modules.mjs";

/** Фиксированный seed генератора (LCG). Меняйте осознанно: набор отчётов изменится. */
const SEED = 12345;
const REPORTS = 400;

function makeRng(seed) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const int = (a, b) => a + Math.floor(next() * (b - a + 1));
  return { next, int };
}

// Пары (группа, тип): известные и неизвестная — чтобы были и корзины, и other+unknown.
const SERVICE_PAIRS = [
  ["Вознаграждение Ozon", "Вознаграждение за продажу"],
  ["Услуги доставки", "Логистика"],
  ["Услуги партнёров", "Эквайринг"],
  ["Продажи", "Баллы за скидки"],
  ["Продажи", "Программы партнёров"],
  ["Другие услуги и штрафы", "Отгрузка в нерекомендованный слот"],
  ["Странная группа", "Новый тип"],
  ["Компенсации и декомпенсации", "Начисление по спору"],
  ["Продвижение и реклама", "Оплата за клик"],
];

/** Независимая раздача наибольших остатков: точные дроби через BigInt, порядок по ключу. */
function oracleAllocate(total, weightByKey) {
  const keys = Object.keys(weightByKey).sort();
  const W = keys.reduce((a, k) => a + BigInt(weightByKey[k]), 0n);
  const T = BigInt(total);
  const base = {};
  const rem = {};
  let sum = 0n;
  for (const k of keys) {
    const num = T * BigInt(weightByKey[k]);
    const r = ((num % W) + W) % W; // остаток в [0, W)
    base[k] = (num - r) / W; // точный floor
    rem[k] = r;
    sum += base[k];
  }
  let left = Number(T - sum);
  const order = [...keys].sort((a, b) => (rem[a] === rem[b] ? (a < b ? -1 : 1) : rem[a] > rem[b] ? -1 : 1));
  for (const k of order) {
    if (left <= 0) break;
    base[k] += 1n;
    left--;
  }
  const out = {};
  for (const k of keys) out[k] = Number(base[k]);
  return out;
}

function generateReport(rng) {
  const rows = [];
  const catalog = [];
  const netQty = {};
  const productCount = rng.int(1, 12);
  for (let i = 0; i < productCount; i++) {
    const art = `P${i}`;
    const sold = rng.int(0, 4);
    const returned = sold > 0 ? rng.int(0, Math.min(2, sold)) : rng.int(0, 1);
    if (rng.next() < 0.85) {
      catalog.push({ sku: art, name: "n", cost_price: rng.int(1, 5000) / (rng.next() < 0.5 ? 1 : 100) });
    }
    let q = 0;
    for (let k = 0; k < sold; k++) {
      const qty = rng.int(1, 3);
      q += qty;
      rows.push({ g: "Продажи", t: "Выручка", art, qty, amt: rng.int(100, 900000) });
    }
    let rq = 0;
    for (let k = 0; k < returned; k++) {
      const qty = rng.int(1, 2);
      rq += qty;
      rows.push({ g: "Возвраты", t: "Возврат выручки", art, qty, amt: -rng.int(100, 30000) });
    }
    netQty[art] = q - rq;
    // Строки услуг: «Количество» произвольное/повторяющееся — в себестоимость входить НЕ должно.
    const services = rng.int(0, 6);
    for (let k = 0; k < services; k++) {
      const [g, t] = SERVICE_PAIRS[rng.int(0, SERVICE_PAIRS.length - 1)];
      rows.push({ g, t, art, qty: rng.int(1, 9), amt: rng.int(-50000, 20000) });
    }
  }
  const generalRows = rng.int(0, 5);
  for (let k = 0; k < generalRows; k++) {
    const [g, t] = SERVICE_PAIRS[rng.int(0, SERVICE_PAIRS.length - 1)];
    rows.push({ g, t, art: "", qty: 0, amt: rng.int(-90000, 90000) });
  }
  const accrualRows = rows.map((x, i) => {
    const cls = K.classifyAccrual(x.g, x.t);
    return {
      rowNumber: i + 3,
      date: "2026-06-05",
      group: x.g,
      type: x.t,
      bucket: cls.bucket,
      knownTaxonomy: cls.known,
      article: x.art,
      sku: "",
      name: "",
      quantity: x.qty,
      amountKopecks: x.amt,
    };
  });
  return { accrualRows, catalog, netQty };
}

describe(`свойства на ${REPORTS} случайных отчётах (seed ${SEED})`, () => {
  const rng = makeRng(SEED);
  const failures = [];
  let calcOk = 0;
  let fullCoverage = 0;
  let partialCoverage = 0;

  for (let it0 = 0; it0 < REPORTS; it0++) {
    const { accrualRows, catalog, netQty } = generateReport(rng);
    const rate = rng.int(0, 3000) / 100;
    const manual = { packaging: rng.int(0, 200000) / 100, salary: rng.int(0, 500000) / 100 };
    const res = C.computeAccrualProfit({
      report: { rows: accrualRows, period: { month: "2026-06", periodComplete: true } },
      catalog,
      taxRatePercent: rate,
      manualExpenses: manual,
    });
    const errs = [];

    // --- независимые ожидания ---
    const isRev = (x) => x.bucket === "salesRevenue" || x.bucket === "returnsRevenue";
    const base = accrualRows.filter(isRev).reduce((a, x) => a + x.amountKopecks, 0);
    const net = accrualRows.reduce((a, x) => a + x.amountKopecks, 0);

    if (base <= 0) {
      if (res.ok || res.error.code !== "no_tax_revenue") errs.push("ожидалась ошибка no_tax_revenue");
    } else if (!res.ok) {
      errs.push(`неожиданная ошибка ${res.error.code}`);
    } else {
      calcOk++;
      const c = res.calc;
      if (c.netOzonOperationsKopecks !== net) errs.push("netOzonOperations");
      if (Object.values(c.buckets).reduce((a, b) => a + b, 0) !== net) errs.push("Σ корзин");

      // себестоимость: только нетто-количество строк выручки/возврата × cost (оракул)
      let cost = 0;
      let allKnown = true;
      for (const [art, nq] of Object.entries(netQty)) {
        if (nq === 0) continue;
        const entry = catalog.find((x) => x.sku === art);
        if (entry) cost += Math.round(nq * entry.cost_price * 100);
        else allKnown = false;
      }
      if (c.productionCostKopecks !== cost) errs.push(`себестоимость ${c.productionCostKopecks} ≠ ${cost}`);

      const tax = Math.floor((2 * base * Math.round(rate * 100) + 10000) / 20000); // round-half-up
      if (c.taxKopecks !== tax) errs.push("налог");
      const manualKop = Math.round(manual.packaging * 100) + Math.round(manual.salary * 100);
      if (c.manualExpenses.totalKopecks !== manualKop) errs.push("ручные расходы");
      if (c.netProfitKopecks !== net - cost - tax - manualKop) errs.push("netProfit");

      // распределение: независимый оракул по весам «положительная реализация»
      const revBase = {};
      for (const x of accrualRows) if (x.article && isRev(x)) revBase[x.article] = (revBase[x.article] ?? 0) + x.amountKopecks;
      const articles = [...new Set(accrualRows.filter((x) => x.article).map((x) => x.article))];
      const weights = Object.fromEntries(articles.map((a) => [a, Math.max(revBase[a] ?? 0, 0)]));
      const generalSum = accrualRows.filter((x) => !x.article).reduce((a, x) => a + x.amountKopecks, 0);
      if (Object.values(weights).some((w) => w > 0)) {
        const expG = oracleAllocate(generalSum, weights);
        const expT = oracleAllocate(tax, weights);
        const expM = oracleAllocate(manualKop, weights);
        for (const p of c.products) {
          if (p.allocatedGeneralKopecks !== expG[p.article]) errs.push(`G ${p.article}`);
          if (p.allocatedTaxKopecks !== expT[p.article]) errs.push(`T ${p.article}`);
          if (p.allocatedManualKopecks !== expM[p.article]) errs.push(`M ${p.article}`);
          if (weights[p.article] === 0 && (p.allocatedGeneralKopecks || p.allocatedTaxKopecks || p.allocatedManualKopecks)) {
            errs.push(`аллокация товару с базой ≤ 0 ${p.article}`);
          }
          if (p.marginPercent !== null && p.revenueBaseKopecks <= 0) errs.push(`маржа при базе ≤ 0 ${p.article}`);
        }
      }
      const direct = c.products.reduce((a, p) => a + p.directKopecks, 0);
      if (direct + generalSum !== net) errs.push("Σ direct + общие ≠ net");

      if (allKnown) {
        fullCoverage++;
        if (c.reconciliation.reconciles !== true) errs.push("Σ profit товаров ≠ netProfit при полном покрытии");
        if (c.preliminary || !c.readyToSave) errs.push("флаги готовности при полном покрытии");
      } else {
        partialCoverage++;
        if (c.reconciliation.reconciles !== null || !c.preliminary || c.readyToSave) errs.push("флаги при неполном покрытии");
      }
    }
    if (errs.length) failures.push(`отчёт #${it0}: ${errs.join(", ")}`);
  }

  it(`все ${REPORTS} отчётов проходят независимые проверки`, () => {
    assert.deepEqual(failures, []);
  });
  it("выборка нетривиальна: есть и полное, и неполное покрытие", () => {
    assert.ok(calcOk > 300, `calcOk=${calcOk}`);
    assert.ok(fullCoverage > 0, "нет отчётов с полным покрытием");
    assert.ok(partialCoverage > 0, "нет отчётов с неполным покрытием");
  });
});

describe("allocateLargestRemainder: случайные раздачи (seed 777)", () => {
  const rng = makeRng(777);
  const bad = [];
  for (let i = 0; i < 2000; i++) {
    const n = rng.int(1, 8);
    const weights = Array.from({ length: n }, () => (rng.next() < 0.2 ? 0 : rng.int(0, 500000)));
    const total = rng.int(-500000, 500000);
    const keys = weights.map((_, j) => `k${j}`);
    const out = M.allocateLargestRemainder(total, weights, keys);
    const W = weights.reduce((a, b) => a + b, 0);
    if (W === 0) {
      if (out !== null) bad.push(`#${i}: ожидался null`);
      continue;
    }
    const oracle = oracleAllocate(total, Object.fromEntries(keys.map((k, j) => [k, weights[j]])));
    keys.forEach((k, j) => {
      if (out[j] !== oracle[k]) bad.push(`#${i}: ${k} ${out[j]} ≠ ${oracle[k]}`);
      if (weights[j] === 0 && out[j] !== 0) bad.push(`#${i}: нулевой вес получил ${out[j]}`);
      const exact = (total * weights[j]) / W;
      if (Math.abs(out[j] - exact) >= 1 + 1e-9) bad.push(`#${i}: отклонение ≥ 1 копейки`);
    });
    if (out.reduce((a, b) => a + b, 0) !== total) bad.push(`#${i}: Σ ≠ total`);
  }
  it("Σ = total, отклонение от точной доли < 1 копейки, нулевые веса пусты, совпадает с оракулом", () => {
    assert.deepEqual(bad, []);
  });
});
