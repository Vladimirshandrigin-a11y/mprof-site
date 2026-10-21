// Подписи старых расчётов по документам (реализация + УПД) в аналитике «Отчётов».
// У таких записей (ai_insights.kind = "net-profit-3file") колонка logistics — это
// агентское вознаграждение, а commission — расходы Ozon по УПД. В аналитике они
// показываются под своими названиями; суммы те же. Ручной, XLSX, Ozon API и прежняя
// загрузка одного отчёта — без изменений.
//
// Функции аналитики берутся из НАСТОЯЩЕГО app/app/components/AnalyticsBlock.tsx:
// файл транспилируется TypeScript проекта, внешние компоненты подменяются
// заглушками, библиотеки — скомпилированными модулями проекта.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { BUILD_DIR, REPO_ROOT, legacyUpd as L } from "./helpers/modules.mjs";

const repoRequire = createRequire(path.join(REPO_ROOT, "package.json"));
const ts = repoRequire("typescript");

const INTERNALS = [
  "computeExpenseBreakdown",
  "computeInsights",
  "computeIndicators",
  "computeScore",
  "buildRecommendations",
  "buildFinancials",
  "topFactors",
  "buildFirstActions",
  "buildLeaks",
  "buildExpenseReportItems",
  "buildLeakCards",
];

function loadAnalyticsInternals() {
  const file = path.join(REPO_ROOT, "app/app/components/AnalyticsBlock.tsx");
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const code = `${out}\nmodule.exports.__internals = { ${INTERNALS.join(", ")} };`;
  const libs = {
    "../lib/accrual/snapshot": "app/lib/accrual/snapshot.js",
    "../lib/accrual/money": "app/lib/accrual/money.js",
    "../lib/legacy-upd-display": "app/lib/legacy-upd-display.js",
  };
  const buildRequire = createRequire(path.join(BUILD_DIR, "loader.js"));
  const req = (id) => {
    if (id === "./ProfitRecommendations" || id === "./AiAnalyticsV1") return {};
    if (libs[id]) return buildRequire(`./${libs[id]}`);
    return repoRequire(id);
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, require, module) {${code}\n})`, { filename: file })(mod.exports, req, mod);
  return mod.exports.__internals;
}

const A = loadAnalyticsInternals();

// Запись истории в форме AnalyticsCalc.
let seq = 0;
const rec = (o) => ({
  id: `r${++seq}`,
  marketplace: "ozon",
  revenue: 100000,
  profit: 20000,
  margin: 20,
  expenses: 80000,
  commission: 0,
  logistics: 0,
  storage: 0,
  ads: 0,
  cost: 40000,
  tax: 6000,
  other: 0,
  date: "01 окт.",
  aiInsights: null,
  ...o,
});
const UPD = (o = {}) => ({ kind: "net-profit-3file", docFormat: "single-upd", commissionKnown: true, ...o });

// Ручной, XLSX, Ozon API, прежняя загрузка одного отчёта — колонки настоящие.
const NON_LEGACY = [
  ["ручной расчёт", null],
  ["XLSX «Отчёт по начислениям»", { kind: "ozon-accrual-xlsx-v1" }],
  ["Ozon API", { kind: "ozon-api-v1", financeTaxonomy: {} }],
  ["прежняя загрузка одного отчёта", undefined],
];

const view = (history) => history.map(L.withUpdCategories);
const segments = (history) => Object.fromEntries(A.computeExpenseBreakdown(view(history)).map((s) => [s.label, s.value]));
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe("legacy-upd: какие записи считаются старыми расчётами по УПД", () => {
  it("только ai_insights.kind = net-profit-3file", () => {
    assert.equal(L.isLegacyUpdRecord(UPD()), true);
    assert.equal(L.isLegacyUpdRecord(UPD({ docFormat: "dual-upd" })), true);
    for (const [, ai] of NON_LEGACY) assert.equal(L.isLegacyUpdRecord(ai), false);
    assert.equal(L.isLegacyUpdRecord("net-profit-3file"), false);
  });

  it("подписи совпадают с детализацией записи в истории (page.tsx)", () => {
    const page = readFileSync(path.join(REPO_ROOT, "app/app/page.tsx"), "utf8");
    assert.equal(L.UPD_SERVICES_LABEL, "Расходы Ozon по УПД");
    assert.ok(page.includes(`label: "${L.UPD_SERVICES_LABEL}"`));
    assert.ok(page.includes('label: "Агентское вознаграждение"'));
    assert.equal(L.UPD_AGENT_FEE_LABEL, "Агентское вознаграждение (УПД)");
  });
});

describe("legacy-upd: суммы не меняются", () => {
  it("у остальных режимов запись для аналитики та же, УПД-суммы — 0", () => {
    for (const [name, ai] of NON_LEGACY) {
      const h = rec({ commission: 12000, logistics: 7000, aiInsights: ai });
      const v = L.withUpdCategories(h);
      assert.deepEqual({ ...v, updServices: undefined, updAgentFee: undefined }, { ...h, updServices: undefined, updAgentFee: undefined }, name);
      assert.equal(v.updServices, 0);
      assert.equal(v.updAgentFee, 0);
    }
  });

  it("старая УПД-запись: суммы переходят в свои категории без изменений, остальные поля те же", () => {
    const h = rec({ commission: 15000, logistics: 9000, aiInsights: UPD() });
    const copy = structuredClone(h);
    const v = L.withUpdCategories(h);
    assert.deepEqual([v.commission, v.logistics, v.updServices, v.updAgentFee], [0, 0, 15000, 9000]);
    for (const k of ["revenue", "profit", "margin", "expenses", "storage", "ads", "cost", "tax", "other", "aiInsights"]) {
      assert.deepEqual(v[k], h[k], k);
    }
    assert.equal(v.commission + v.logistics + v.updServices + v.updAgentFee, h.commission + h.logistics);
    assert.deepEqual(h, copy, "исходная запись не меняется");
  });

  it("агентское вознаграждение не выделено (commissionKnown=false): всё — «Расходы Ozon по УПД»", () => {
    const v = L.withUpdCategories(rec({ commission: 24000, logistics: 0, aiInsights: UPD({ commissionKnown: false }) }));
    assert.deepEqual([v.updServices, v.updAgentFee], [24000, 0]);
  });
});

describe("legacy-upd: структура расходов в «Отчётах» по режимам", () => {
  for (const [name, ai] of NON_LEGACY) {
    it(`${name}: «Комиссия» и «Логистика» как раньше, без строк УПД`, () => {
      const s = segments([rec({ commission: 12000, logistics: 7000, aiInsights: ai })]);
      assert.equal(s["Комиссия"], 12000);
      assert.equal(s["Логистика"], 7000);
      assert.equal(s[L.UPD_SERVICES_LABEL], undefined);
      assert.equal(s[L.UPD_AGENT_FEE_LABEL], undefined);
    });
  }

  it("старый расчёт по УПД: «Расходы Ozon по УПД» и «Агентское вознаграждение (УПД)», без «Логистики» и «Комиссии»", () => {
    const s = segments([rec({ commission: 15000, logistics: 9000, aiInsights: UPD() })]);
    assert.equal(s[L.UPD_SERVICES_LABEL], 15000);
    assert.equal(s[L.UPD_AGENT_FEE_LABEL], 9000);
    assert.equal(s["Логистика"], undefined);
    assert.equal(s["Комиссия"], undefined);
  });

  it("смешанная история: логистика — только настоящая, общая сумма расходов та же", () => {
    const history = [
      rec({ commission: 12000, logistics: 7000 }),
      rec({ commission: 11000, logistics: 6500, aiInsights: { kind: "ozon-api-v1" } }),
      rec({ commission: 15000, logistics: 9000, aiInsights: UPD() }),
    ];
    const s = segments(history);
    assert.equal(s["Логистика"], 13500);
    assert.equal(s["Комиссия"], 23000);
    assert.equal(s[L.UPD_SERVICES_LABEL], 15000);
    assert.equal(s[L.UPD_AGENT_FEE_LABEL], 9000);
    const raw = Object.fromEntries(A.computeExpenseBreakdown(history).map((x) => [x.label, x.value]));
    assert.equal(total(s), total(raw), "сумма всех категорий не изменилась");
  });
});

describe("legacy-upd: советы по логистике и комиссии", () => {
  // Агентское вознаграждение 20 % выручки — раньше считалось «логистикой».
  const legacy = [rec({ commission: 25000, logistics: 20000, aiInsights: UPD() })];
  const manual = [rec({ commission: 25000, logistics: 20000 })];
  const texts = (arr) => arr.map((i) => i.text ?? i).join("\n");

  it("старый расчёт по УПД: нет советов про логистику и про «высокую комиссию»", () => {
    const ins = texts(A.computeInsights(view(legacy)));
    assert.ok(!/Логистика|логистика снизится|Объедините отгрузки/.test(ins), ins);
    assert.ok(!/Комиссия маркетплейса/.test(ins), ins);
    const recs = A.buildRecommendations(A.computeIndicators(view(legacy)), view(legacy));
    assert.ok(!recs.includes("↓ логистика") && !recs.includes("↑ средний чек"), recs.join(", "));
  });

  it("ручной расчёт с той же логистикой: совет про логистику по-прежнему есть", () => {
    assert.match(texts(A.computeInsights(view(manual))), /Логистика 20% выручки/);
    assert.ok(A.buildRecommendations(A.computeIndicators(view(manual)), view(manual)).includes("↓ логистика"));
  });

  it("книжка аналитики: бары и карточки — под своими названиями", () => {
    const f = A.buildFinancials(view(legacy));
    assert.equal(f.logistics, 0);
    assert.equal(f.commission, 0);
    assert.equal(f.updServices, 25000);
    assert.equal(f.updAgentFee, 20000);
    const bars = A.buildExpenseReportItems(f).filter((i) => i.kind === "bar").map((i) => i.label);
    assert.ok(bars.includes(L.UPD_SERVICES_LABEL) && bars.includes(L.UPD_AGENT_FEE_LABEL), bars.join(", "));
    const cards = A.buildLeakCards(f).map((c) => c.problem ?? c.text).join("\n");
    assert.ok(!/Логистика/.test(cards), cards);
    assert.ok(!/Логистика/.test(A.buildLeaks(f).join("\n")));
    const first = A.buildFirstActions(f).join("\n");
    assert.match(first, /актом УПД \(расходы по УПД 45\.0% выручки\)/);
    assert.deepEqual(
      A.topFactors(f).map((x) => x.name).filter((n) => /УПД/.test(n)),
      ["расходы Ozon по УПД", "агентское вознаграждение по УПД"]
    );
  });

  it("книжка для ручного расчёта: «Логистика» без приписки «и УПД», без доли УПД в советах", () => {
    const f = A.buildFinancials(view(manual));
    assert.equal(f.logistics, 20000);
    assert.equal(f.updServices + f.updAgentFee, 0);
    const bars = A.buildExpenseReportItems(f).filter((i) => i.kind === "bar").map((i) => i.label);
    assert.ok(bars.includes("Логистика") && !bars.some((b) => /УПД/.test(b)), bars.join(", "));
    assert.ok(!/УПД/.test(A.buildFirstActions(f).join("\n")));
  });

  it("суммы книжки: выручка, прибыль, расходы и сумма статей — как по исходным записям", () => {
    for (const history of [legacy, manual]) {
      const a = A.buildFinancials(view(history));
      const b = A.buildFinancials(history);
      for (const k of ["revenue", "profit", "expenses", "cost", "tax", "ads", "storage", "other", "marginPct", "discrepancy"]) {
        assert.equal(a[k], b[k], k);
      }
      assert.equal(a.commission + a.logistics + a.updServices + a.updAgentFee, b.commission + b.logistics);
    }
  });
});

describe("legacy-upd: что осталось прежним (по исходному коду)", () => {
  const src = readFileSync(path.join(REPO_ROOT, "app/app/components/AnalyticsBlock.tsx"), "utf8");

  it("индекс здоровья и данные для AI-разбора — по исходным записям", () => {
    assert.ok(src.includes("const rbScore = computeScore(history);"));
    assert.ok(src.includes("commission: Math.round(sum((h) => h.commission)),"));
    assert.ok(src.includes("logistics: Math.round(sum((h) => h.logistics)),"));
  });

  it("подписи «логистика и УПД» больше нет", () => {
    assert.ok(!/[Лл]огистика и УПД/.test(src));
  });
});
