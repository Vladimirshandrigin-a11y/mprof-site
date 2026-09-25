// Снимок расчёта по «Отчёту по начислениям» (kind "ozon-accrual-xlsx-v1"):
// сборка из настоящего ядра, сериализация → чтение, строгая проверка, маржа
// (число / 0 / null), сохранение товарной аналитики, независимость от текущего
// каталога, совместимость со старыми снимками, повреждённые снимки.
// Ожидания — независимые литералы (helpers/expected.mjs).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAT, EXPECTED_BASIC as E } from "./helpers/expected.mjs";
import { GENERATED_AT, buildSnapshotFor, viaJson } from "./helpers/snapshot-fixtures.mjs";
import { calc as C, format as F, snapshot as S } from "./helpers/modules.mjs";

const read = (v) => S.readAccrualSnapshot(v);
const okSnap = (v) => {
  const r = read(v);
  assert.equal(r.status, "ok", r.status === "invalid" ? r.reason : "");
  return r.snapshot;
};
const nb = (s) => s.replace(/ | /g, " "); // NBSP из toLocaleString → пробел

describe("схема и сериализация → чтение", () => {
  const { snapshot: built } = buildSnapshotFor("basic");
  const stored = viaJson(S.serializeAccrualSnapshot(built)); // как из jsonb

  it("kind и версия", () => {
    assert.equal(built.kind, "ozon-accrual-xlsx-v1");
    assert.equal(built.version, 1);
    assert.equal(S.ACCRUAL_SNAPSHOT_KIND, "ozon-accrual-xlsx-v1");
  });
  it("после JSON-сериализации читается как ok и совпадает со снимком до записи (без потерь)", () => {
    assert.deepEqual(okSnap(stored), built);
  });
  it("снимок JSON-безопасен: нет undefined/NaN/Infinity, размер разумный", () => {
    const json = JSON.stringify(built);
    assert.doesNotMatch(json, /NaN|Infinity|undefined/);
    assert.ok(json.length < 12_000, `размер ${json.length}`);
  });
  it("источник: только тип, лист и число строк — исходный файл и операции не сохраняются", () => {
    assert.deepEqual(built.source, { type: "ozon-accrual-report-xlsx", sheet: "Начисления", rowCount: E.rowCount });
    // Строгий минимальный набор верхнего уровня: нет ни строк отчёта, ни «ID начисления».
    assert.deepEqual(Object.keys(built).sort(), [
      "buckets", "costCoverage", "generatedAt", "kind", "manualExpenses", "marginPercent", "netOzonOperationsKopecks",
      "netProfitKopecks", "period", "preliminary", "productTotals", "productionCostKopecks", "products", "quantities",
      "reconciliation", "returnsRevenueKopecks", "salesRevenueKopecks", "source", "tax", "taxRevenueBaseKopecks",
      "unknownTaxonomy", "version", "warnings",
    ]);
    assert.doesNotMatch(JSON.stringify(built), /ID-\d/);
    assert.equal(built.generatedAt, GENERATED_AT);
  });
  it("предупреждения парсера сохранены", () => {
    assert.ok(built.warnings.some((w) => w.code === "unknown_taxonomy"));
    assert.equal(built.unknownTaxonomy.length, 1);
  });
  it("нельзя собрать снимок из расчёта и периода разных месяцев", () => {
    const { calc: c, parsed } = buildSnapshotFor("basic");
    assert.throws(() =>
      S.buildAccrualSnapshot({
        calc: c,
        period: { ...parsed.report.period, month: "2026-05" },
        warnings: [],
        source: { sheet: "Начисления", rowCount: 1 },
      })
    );
  });
});

describe("детали, период и итоговые карточки из снимка", () => {
  const s = okSnap(viaJson(buildSnapshotFor("basic").snapshot));

  it("период: месяц, полнота, подписи", () => {
    assert.equal(s.period.month, "2026-06");
    assert.equal(s.period.periodComplete, true);
    assert.equal(S.accrualPeriodLabel(s), "Июнь 2026");
    assert.equal(S.accrualPeriodRange(s), "01.06.2026 — 30.06.2026");
    assert.equal(S.accrualSnapshotMonthKey(viaJson(s)), "2026-06");
  });
  it("итоговые значения: итог начислений, реализация после возвратов, себестоимость, налог, ручные, прибыль", () => {
    assert.equal(s.netOzonOperationsKopecks, E.net);
    assert.equal(s.taxRevenueBaseKopecks, E.base);
    assert.equal(s.productionCostKopecks, E.production);
    assert.deepEqual(s.tax, { ratePercent: 7, kopecks: E.tax });
    assert.equal(s.manualExpenses.totalKopecks, E.manual);
    assert.equal(s.netProfitKopecks, E.netProfit);
    assert.deepEqual(s.buckets, E.buckets);
  });
  it("полнота себестоимости: полная, не предварительный, подпись «Чистая прибыль»", () => {
    assert.equal(s.costCoverage.complete, true);
    assert.equal(s.preliminary, false);
    assert.equal(S.accrualProfitLabel(s), "Чистая прибыль");
  });
  it("ROI = прибыль / себестоимость (236,05 %), «Прибыль до себестоимости» = итог начислений", () => {
    assert.equal(S.accrualSnapshotRoi(s), 236.05);
  });
  it("разбивка для истории: категории включены в итог, вычитаются только себестоимость, налог и ручные", () => {
    const rows = S.accrualHistDetailRows(s);
    assert.deepEqual(
      rows.map((r) => [r.label, r.value, r.kind]),
      [
        ["Реализация (выручка)", 1500, "income"],
        ["Возвраты выручки", 300, "expense"],
        ["Программы партнёров", 5, "income"],
        ["Баллы за скидки", 25, "income"],
        ["Комиссия Ozon (вознаграждение)", 180, "expense"],
        ["Доставка и связанные услуги", 67, "expense"],
        ["Продвижение и реклама", 60, "expense"],
        ["Компенсации", 30.01, "income"],
        ["Прочие начисления и сборы", 15.55, "expense"],
        ["Итог начислений Ozon (включает все категории выше)", 937.46, "subtotal"],
        ["Себестоимость", 250, "expense"],
        ["Налог (7%)", 84, "expense"],
        ["Ручные расходы", 13.33, "expense"],
        ["Итоговая чистая прибыль", 590.13, "total"],
      ]
    );
  });
  it("в подписях нет УПД: реальные категории начислений", () => {
    const text = JSON.stringify([S.accrualHistDetailRows(s), S.accrualBreakdownRows(s), S.accrualExplanations(s), S.accrualNotices(s)]);
    assert.doesNotMatch(text, /УПД|агентск/i);
  });
  it("пояснения: категории уже в итоге, налог от реализации после возвратов, не пересчитывается по каталогу", () => {
    const text = S.accrualExplanations(s).join(" ");
    assert.match(text, /уже входят в этот итог/);
    assert.match(text, /реализации после возвратов/);
    assert.match(text, /не пересчитываются по текущему каталогу/);
    assert.match(text, /«—»/);
  });
  it("предупреждения: неизвестный тип начисления и т.п. без товарных данных", () => {
    const text = S.accrualNotices(s).map((n) => n.text).join(" ");
    assert.match(text, /неизвестных типов/);
    assert.doesNotMatch(text, /ART-|Товар/);
  });
});

describe("маржа: число, ноль и null сохраняют смысл", () => {
  const { snapshot: base } = buildSnapshotFor("basic");

  it("числовая маржа: снимок 49,18 % приоритетнее технической колонки БД", () => {
    assert.equal(S.effectiveHistoryMargin(viaJson(base), 0), 49.18);
    assert.equal(S.effectiveHistoryMargin(viaJson(base), 12.3), 49.18);
  });
  it("настоящая нулевая маржа (прибыль 0) остаётся 0 — не подменяется и не превращается в «—»", () => {
    // ручные расходы подобраны так, что netProfit = 0 (3,33 + 590,13 = 593,46)
    const zero = buildSnapshotFor("basic", { manualExpenses: { packaging: 10, other: 593.46 } }).snapshot;
    assert.equal(zero.netProfitKopecks, 0);
    assert.equal(zero.marginPercent, 0);
    const back = okSnap(viaJson(zero));
    assert.equal(back.marginPercent, 0);
    assert.equal(S.effectiveHistoryMargin(viaJson(zero), 7.7), 0); // колонка БД с другим числом не перебивает
    assert.equal(F.fmtPercent(back.marginPercent), "0,0 %");
  });
  it("null-маржа: снимок побеждает колонку БД (0 — техническая замена) и показывается «—»", () => {
    const nullMargin = { ...viaJson(base), marginPercent: null };
    const back = okSnap(nullMargin);
    assert.equal(back.marginPercent, null);
    assert.equal(S.effectiveHistoryMargin(nullMargin, 0), null);
    assert.equal(F.fmtPercent(S.accrualSnapshotMargin(back)), "—");
    assert.equal(S.accrualSnapshotRoi(back) !== null, true);
  });
  it("отрицательная маржа форматируется со знаком минус", () => {
    assert.equal(F.fmtPercent(-3.456), "−3,5 %");
  });
  it("не наш снимок / нет снимка: используется колонка БД как есть (в т.ч. 0)", () => {
    assert.equal(S.effectiveHistoryMargin(null, 0), 0);
    assert.equal(S.effectiveHistoryMargin(undefined, 22.75), 22.75);
    assert.equal(S.effectiveHistoryMargin({ kind: "ozon-api-v1", margin: 22.75 }, 22.75), 22.75);
    assert.equal(S.effectiveHistoryMargin({ kind: "net-profit-3file" }, 5), 5);
  });
  it("повреждённый снимок нового вида: маржа неизвестна (null), а не 0 из колонки", () => {
    assert.equal(S.effectiveHistoryMargin({ kind: "ozon-accrual-xlsx-v1" }, 0), null);
    assert.equal(S.effectiveHistoryMargin({ kind: "ozon-accrual-xlsx-v1" }, 33), null);
  });
  it("предварительный результат не называется чистой прибылью", () => {
    const pre = okSnap(viaJson(buildSnapshotFor("basic", { catalog: [CAT[0]] }).snapshot));
    assert.equal(pre.preliminary, true);
    assert.equal(S.accrualProfitLabel(pre), "Предварительная прибыль");
    const rows = S.accrualBreakdownRows(pre);
    assert.equal(rows.at(-1).label, "Предварительная прибыль");
    assert.equal(rows.find((r) => r.key === "cost").label, "Себестоимость (неполная)");
    assert.match(S.accrualNotices(pre).map((n) => n.text).join(" "), /Предварительный результат: у 1 из 2 товаров нет себестоимости/);
  });
});

describe("товарная аналитика сохраняется в снимке", () => {
  const s = okSnap(viaJson(buildSnapshotFor("basic").snapshot));
  const p = (art) => s.products.find((x) => x.article === art);

  it("3 товара; значения по товарам совпадают с независимым расчётом", () => {
    assert.equal(s.products.length, 3);
    for (const [art, e] of Object.entries(E.products)) {
      const x = p(art);
      assert.deepEqual(
        [x.directKopecks, x.allocatedGeneralKopecks, x.allocatedTaxKopecks, x.allocatedManualKopecks, x.cogsKopecks, x.profitKopecks],
        [e.direct, e.G, e.T, e.M, e.cogs, e.profit]
      );
      assert.equal(x.marginPercent, e.margin);
    }
  });
  it("Σ прибыль товаров = прибыль расчёта; reconciliation сохранён", () => {
    assert.equal(s.productTotals.profitKopecks, E.netProfit);
    assert.deepEqual(s.reconciliation, { productProfitSumKopecks: E.netProfit, reconciles: true });
  });
  it("товар только с услугами не потерян и помечен", () => {
    assert.equal(p("ART-C").serviceOnly, true);
    assert.equal(s.productTotals.serviceOnlyCount, 1);
  });
  it("строки для существующей товарной таблицы: рубли, нетто-количество, «—» у неопределимой маржи", () => {
    const rows = S.accrualProductBreakdownRows(s);
    const a = rows.find((r) => r.article === "ART-A");
    assert.deepEqual([a.revenue, a.returnsAmount, a.quantity, a.cogs, a.profit, a.margin, a.unitCost], [700, 300, 2, 200, 267.49, 38.21, 100]);
    assert.equal(rows.find((r) => r.article === "ART-C").margin, null);
  });
  it("лучший и худший товар (худший — только с отрицательной прибылью)", () => {
    const kp = S.accrualKeyProducts(s);
    assert.equal(kp.best.article, "ART-B");
    assert.equal(kp.best.profitKopecks, 32964);
    assert.equal(kp.worst.article, "ART-C");
    assert.equal(kp.worst.profitKopecks, -700);
    assert.equal(kp.worst.marginPercent, null);
  });
  it("нет убыточных → worst = null", () => {
    const x = viaJson(s);
    x.products = x.products.filter((q) => q.article !== "ART-C");
    x.productTotals.productCount = 2;
    x.productTotals.serviceOnlyCount = 0;
    const kp = S.accrualKeyProducts(okSnap(x));
    assert.equal(kp.worst, null);
  });
  it("покрытие каталога на момент расчёта", () => {
    assert.deepEqual(S.accrualCostCoverageView(s), { total: 3, withCost: 2, withoutCost: 0, serviceOnly: 1 });
  });
  it("контекст для AI: топ товаров без файлов, маржа опускается при null", () => {
    const ai = S.accrualAiProducts(s);
    assert.deepEqual(
      ai.map((x) => [x.sku, x.profit]),
      [["ART-B", 330], ["ART-A", 267], ["ART-C", -7]]
    );
    assert.equal("margin" in ai[2], false);
    assert.equal(S.accrualProductsWithoutCost(s), 0);
  });
  it("категории расходов для рекомендаций: списания в рублях, база долей = реализация + баллы за скидки", () => {
    assert.deepEqual(S.accrualChargeCategories(s), { commission: 180, logistics: 67, advertising: 60, other: 15.55, shareBase: 1225 });
  });
});

describe("данные для рекомендаций из снимка", () => {
  const s = okSnap(viaJson(buildSnapshotFor("basic").snapshot));
  it("УПД не выдумывается: поля УПД = 0, вместо них категории начислений", () => {
    const r = S.accrualRecoProps(s);
    assert.equal(r.updServicesTotal, 0);
    assert.equal(r.updCommissionTotal, 0);
    assert.deepEqual(r.accrualCategories, { commission: 180, logistics: 67, advertising: 60, other: 15.55, shareBase: 1225 });
  });
  it("прибыль, налог, ручные, покрытие, лучший/худший — из снимка", () => {
    const r = S.accrualRecoProps(s);
    assert.deepEqual(
      [r.revenue, r.profitBeforeCost, r.netProfit, r.costPrice, r.tax, r.taxPercent, r.otherExpenses],
      [1200, 937.46, 590.13, 250, 84, 7, 13.33]
    );
    assert.deepEqual(r.coverage, { total: 2, withCost: 2, withoutCost: 0 });
    assert.equal(r.best.article, "ART-B");
    assert.equal(r.worst.margin, null);
    assert.equal(r.marginKnown, true);
    assert.equal(r.ready, true);
  });
  it("null-маржа → marginKnown=false (рекомендации не строят вывод по 0 %)", () => {
    const r = S.accrualRecoProps({ ...s, marginPercent: null });
    assert.equal(r.marginKnown, false);
  });
});

describe("исторический результат не пересчитывается по текущему каталогу", () => {
  it("смена себестоимости в каталоге не меняет сохранённый результат", () => {
    const { snapshot: built, parsed } = buildSnapshotFor("basic");
    const stored = viaJson(S.serializeAccrualSnapshot(built));

    // «Сегодня» цены в каталоге другие: пересчёт по ним дал бы иной результат…
    const newCatalog = [{ sku: "ART-A", name: "cat A", cost_price: 999 }, { sku: "ART-B", name: "cat B", cost_price: 1 }];
    const recomputed = C.computeAccrualProfit({
      report: parsed.report,
      catalog: newCatalog,
      taxRatePercent: 7,
      manualExpenses: { packaging: 10, other: 3.33 },
    });
    assert.notEqual(recomputed.calc.netProfitKopecks, E.netProfit);

    // …но чтение сохранённого снимка (и построенных из него строк) от каталога не зависит.
    const back = okSnap(stored);
    assert.equal(back.netProfitKopecks, E.netProfit);
    assert.equal(back.productionCostKopecks, E.production);
    const a = S.accrualProductBreakdownRows(back).find((r) => r.article === "ART-A");
    assert.deepEqual([a.unitCost, a.cogs, a.profit], [100, 200, 267.49]);
    assert.equal(S.accrualBreakdownRows(back).find((r) => r.key === "cost").kopecks, E.production);
  });
});

describe("старые и чужие снимки не задеваются", () => {
  const old3 = { kind: "net-profit-3file", roi: 1, taxPercent: 6, costPrice: 100, tax: 5, updServicesTotal: 1, updCommissionTotal: 2, revenueOzon: 300, loyaltyPayouts: 3, profitBeforeCost: 200, reportPeriod: "01.04.2026 - 30.04.2026" };
  const oldApi = { kind: "ozon-api-v1", period: { month: "2026-05" }, margin: 22.75 };

  for (const [name, v] of [
    ["net-profit-3file", old3],
    ["ozon-api-v1", oldApi],
    ["null", null],
    ["undefined", undefined],
    ["число", 42],
    ["строка", "ozon-accrual-xlsx-v1"],
    ["массив", []],
    ["пустой объект", {}],
    ["объект без kind", { period: { month: "2026-06" } }],
    ["kind не строка", { kind: 5 }],
  ]) {
    it(`${name} → absent: читается только прежними ветками`, () => {
      assert.deepEqual(read(v), { status: "absent" });
      assert.equal(S.accrualSnapshotMonthKey(v), null);
      assert.equal(S.isAccrualSnapshotKind(v), false);
      assert.equal(S.asAccrualSnapshot(v), null);
    });
  }
  it("старые записи: маржа — колонка БД без изменений", () => {
    assert.equal(S.effectiveHistoryMargin(old3, 31.5), 31.5);
    assert.equal(S.effectiveHistoryMargin(oldApi, 22.75), 22.75);
    assert.equal(S.effectiveHistoryMargin(null, 0), 0);
  });
});

describe("повреждённый/неполный снимок не превращается в корректный нулевой расчёт", () => {
  const good = viaJson(buildSnapshotFor("basic").snapshot);
  const mutate = (fn) => {
    const x = viaJson(good);
    fn(x);
    return x;
  };
  const cases = {
    "только kind": { kind: "ozon-accrual-xlsx-v1" },
    "kind + версия, остального нет": { kind: "ozon-accrual-xlsx-v1", version: 1 },
    "версия 2": mutate((x) => (x.version = 2)),
    "версия строкой": mutate((x) => (x.version = "1")),
    "будущий kind v2": mutate((x) => (x.kind = "ozon-accrual-xlsx-v2")),
    "нет корзин": mutate((x) => delete x.buckets),
    "одной корзины нет": mutate((x) => delete x.buckets.commission),
    "корзина не целое (рубли вместо копеек)": mutate((x) => (x.buckets.commission = -1800.5)),
    "корзина строкой": mutate((x) => (x.buckets.logistics = "-6700")),
    "сумма корзин ≠ итог": mutate((x) => (x.buckets.other += 1)),
    "итог NaN → null": mutate((x) => (x.netOzonOperationsKopecks = null)),
    "прибыль не сходится": mutate((x) => (x.netProfitKopecks += 1)),
    "налог не число": mutate((x) => (x.tax.kopecks = "8400")),
    "ставка налога 150": mutate((x) => (x.tax.ratePercent = 150)),
    "ручные расходы не сходятся": mutate((x) => (x.manualExpenses.totalKopecks += 1)),
    "база налога ≤ 0": mutate((x) => (x.taxRevenueBaseKopecks = 0)),
    "предварительный при полном покрытии": mutate((x) => (x.preliminary = true)),
    "покрытие не сходится": mutate((x) => (x.costCoverage.withCost += 5)),
    "маржа не сходится": mutate((x) => (x.marginPercent = 99.99)),
    "маржа строкой": mutate((x) => (x.marginPercent = "49.18")),
    "нет периода": mutate((x) => delete x.period),
    "месяц 2026-13": mutate((x) => (x.period.month = "2026-13")),
    "нет products": mutate((x) => delete x.products),
    "products не массив": mutate((x) => (x.products = {})),
    "товар без артикула": mutate((x) => (x.products[0].article = "")),
    "товар с нецелой прибылью": mutate((x) => (x.products[0].profitKopecks = 267.49)),
    "число товаров не сходится": mutate((x) => x.products.pop()),
    "нет reconciliation": mutate((x) => delete x.reconciliation),
    "warnings не массив": mutate((x) => (x.warnings = "нет")),
    "источник другого типа": mutate((x) => (x.source.type = "manual")),
  };
  for (const [name, v] of Object.entries(cases)) {
    it(`${name} → invalid (нет нулей вместо данных)`, () => {
      const r = read(v);
      assert.equal(r.status, "invalid");
      assert.ok(r.reason.length > 0);
      assert.equal(S.asAccrualSnapshot(v), null);
      assert.equal(S.accrualSnapshotMonthKey(v), null);
      assert.equal(S.isAccrualSnapshotKind(v), true);
      assert.equal(S.effectiveHistoryMargin(v, 0), null);
    });
  }
  it("исходный корректный снимок при этом проходит (контроль)", () => {
    assert.equal(read(good).status, "ok");
  });
});

describe("форматирование", () => {
  it("рубли и знаки", () => {
    assert.equal(nb(F.fmtRub(37674167)), "376 741,67 ₽");
    assert.equal(nb(F.fmtRub(-37904)), "−379,04 ₽");
    assert.equal(nb(F.fmtSignedRub(9313840)), "+93 138,40 ₽");
    assert.equal(F.fmtSignedRub(0), "0,00 ₽");
  });
  it("процент: null/NaN → «—», 0 → «0,0 %»", () => {
    assert.equal(F.fmtPercent(null), "—");
    assert.equal(F.fmtPercent(NaN), "—");
    assert.equal(F.fmtPercent(0), "0,0 %");
    assert.equal(nb(F.fmtPercent(22.75)), "22,8 %");
  });
  it("месяц и склонение", () => {
    assert.equal(F.fmtMonthLabel("2026-06"), "Июнь 2026");
    assert.equal(F.pluralRu(1, "товар", "товара", "товаров"), "товар");
    assert.equal(F.pluralRu(3, "товар", "товара", "товаров"), "товара");
    assert.equal(F.pluralRu(11, "товар", "товара", "товаров"), "товаров");
  });
});
