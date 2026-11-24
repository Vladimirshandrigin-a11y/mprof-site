import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { after, describe, before, it, mock } from "node:test";
import path from "node:path";
import { accrualRow } from "../accrual/helpers/fixtures.mjs";
import { xlsxSaveFixture } from "./helpers/xlsx-save-fixture.mjs";
import { buildRequire, payTestEnv, read, root } from "./helpers/pay-db.mjs";
import { installFetch, SERVICE_KEY, SUPABASE_URL, userJwt } from "./helpers/fetch-stub.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.OZON_KEYS_ENC_SECRET = "synthetic-day3-ozon-fixture-only";
process.env.OZON_FINANCE_ACCRUAL_ENABLED = "true";
const { NextRequest } = createRequire(path.join(root, "package.json"))("next/server");
const ops = buildRequire("./api/cloud/calculation-operations/route.js");
const calcs = buildRequire("./api/cloud/calculations/route.js");
const summaries = buildRequire("./api/cloud/financial-summary/route.js");
const ozon = buildRequire("./api/ozon/save-calculation/route.js");
const { encryptOzonApiKey } = buildRequire("./api/ozon/_lib/crypto.js");
const realizationLib = buildRequire("./api/ozon/_lib/realization.js");
const loadRealization = realizationLib.loadRealizationDiagnosticWithProducts;
const fixtureMock = mock.method(realizationLib, "loadRealizationDiagnosticWithProducts", async (...args) => {
  // The fixture is the entire known input for these downstream finance tests.
  const result = await loadRealization(...args);
  result.diagnostic.completeness = "verified";
  return result;
});
const network = installFetch();
const { freshDb } = payTestEnv();
const migrations = [
  "20260928_calculation_operations.sql",
  "20260929_calculation_operations_manual_api.sql",
  "20261113221918_quota_atomic_edits.sql",
  "20261115180805_operation_saved_edit_version.sql",
  "20261121100841_restrict_standalone_calculation_quota.sql",
  "20261121154206_verify_xlsx_financial_consistency.sql",
].map(name => read("supabase/migrations/" + name));

const day = "2026-06-10";
const row = (group, type, amount, id, quantity = 0, article = null) =>
  accrualRow(day, group, type, article, quantity, amount, id);
const rows = [
  row("Продажи", "Выручка", "1500", "S", 3, "ART-A"),
  row("Возвраты", "Возврат выручки", "-250", "R", 1, "ART-A"),
  row("Вознаграждение Ozon", "Вознаграждение за продажу", "-200", "S", 3, "ART-A"),
  row("Вознаграждение Ozon", "Возврат вознаграждения", "25", "R", 1, "ART-A"),
  row("Услуги доставки", "Логистика", "-90", "S"),
  row("Услуги партнёров", "Доставка до места выдачи", "-20", "S"),
  row("Услуги партнёров", "Эквайринг", "-15", "S"),
  row("Продвижение и реклама", "Оплата за клик", "-60", "AD1"),
  row("Продвижение и реклама", "Оплата за клик", "10", "AD2"),
  row("Компенсации и декомпенсации", "Начисление по спору", "40", "C1"),
  row("Компенсации и декомпенсации", "Начисление по спору", "-15", "C2"),
  row("Другие услуги и штрафы", "Отгрузка в нерекомендованный слот", "-12", "F1"),
  row("Прочие начисления", "Корректировка стоимости услуг", "-8", "F2"),
];
const register = (preamble) => ({ operationId: randomUUID(), requestHash: "2026-06:fixture",
  ...xlsxSaveFixture({ rows, cost: 150, packaging: "15", ads: "20", preamble }) });
const fetchJson = async (route, uid, payload, query = "") => {
  const req = new NextRequest("http://localhost/tests" + query, {
    method: payload ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(uid ? { authorization: "Bearer " + userJwt(uid) } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const response = await route[req.method](req);
  return { status: response.status, body: await response.json() };
};
const summary = (uid, params = {}) => fetchJson(summaries, uid, { year: "2026", mode: "all", choices: [], page: 0, ...params });
const number = (amount) => ({ amount: String(amount) });
const fee = (id, typeId, amount) =>
  ({ accrual_id: id, accrued_category: "NON_ITEM", non_item_fee: { type_id: typeId }, total_amount: number(amount) });
const ledger = [
  { accrual_id: 1, accrued_category: "POSTING", total_amount: number(915), posting: { products: [{
    commission: { sale_amount: number(1000), commission: number(-175) }, delivery: { total_accrued: number(-110) },
  }] } },
  fee(2, 1, -60), fee(3, 1, 10), fee(4, 2, 40), fee(5, 2, -15), fee(6, 3, 15),
];

// Replace pacing sleeps while leaving real page/retry/budget decisions active.
async function withoutPacing(fn) {
  const realNow = Date.now;
  const realTimeout = globalThis.setTimeout;
  let now = realNow();
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms > 0 && ms <= 1200) {
      now += ms;
      return realTimeout(callback, 0, ...args);
    }
    return realTimeout(callback, ms, ...args);
  };
  try { return await fn(); }
  finally { Date.now = realNow; globalThis.setTimeout = realTimeout; }
}

function upstream(scenario = "normal") {
  return ({ url, body }) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === "/v1/finance/accrual/types") {
      const adName = scenario === "review-promotion" ? "Сбор первых отзывов" : "Оплата за клик";
      return Response.json({ types: [{ type_id: 1, name: adName },
        { type_id: 2, name: "Начисление по спору" }, { type_id: 3, name: "Эквайринг" }] });
    }
    if (endpoint === "/v1/finance/accrual/by-day") {
      if (body.date !== day) return Response.json({ accruals: [], last_id: "" });
      if (scenario === "normal" || scenario === "review-promotion") {
        return Response.json({ accruals: ledger, last_id: "" });
      }
      if (scenario === "omitted-initial") return Response.json({ accruals: ledger });
      if (!body.last_id) return Response.json({ accruals: ledger, last_id: "1" });
      if (scenario === "omitted-after-cursor") return Response.json({ accruals: [] });
      if (scenario === "terminal-empty") return Response.json({ accruals: [], last_id: "" });
      if (scenario === "http") return Response.json({}, { status: 500 });
      if (scenario === "timeout") throw new DOMException("test timeout", "AbortError");
      if (scenario === "empty-continues") {
        return body.last_id === "1" ? Response.json({ accruals: [], last_id: "2" })
          : Response.json({ accruals: [fee(8, 3, 10)], last_id: "" });
      }
      const next = scenario === "repeat" ? "1" : scenario === "cycle" && body.last_id === "2"
        ? "1" : String(Number(body.last_id) + 1);
      return Response.json({ accruals: [fee(9, 3, -100)], last_id: next });
    }
    if (endpoint === "/v2/finance/realization") return Response.json({ result: { header: {}, rows: [{
      item: { offer_id: "ART-A", name: "Fixture" },
      delivery_commission: { quantity: 3, amount: 1500 },
      return_commission: { quantity: 1, amount: 250 },
    }] } });
    if (endpoint === "/v2/posting/fbo/list") return Response.json({ result: [] });
    if (endpoint === "/v3/posting/fbs/list") return Response.json({ result: { postings: [], has_next: false } });
    return Response.json({}, { status: 404 });
  };
}

describe("Day 3 financial P1", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: migrations });
    network.state.pool = db.pool();
  });
  after(() => { fixtureMock.mock.restore(); network.restore(); });
  const sql = (...args) => db.main.query(...args);
  async function state(uid) {
    const [[profile], [calcs], [history], [ops]] = await Promise.all([
      sql("select calculations_used from public.profiles where id=$1", [uid]),
      ...["calculations", "report_history", "calculation_operations"].map(table =>
        sql(`select count(*)::int as count from public.${table} where user_id=$1`, [uid])),
    ]).then(results => results.map(result => result.rows));
    return [profile.calculations_used, calcs.count, history.count, ops.count];
  }
  async function ozonUser(options) {
    const uid = await db.user(options);
    await sql("insert into public.products(user_id,sku,name,cost_price) values($1,'ART-A','Fixture',150)", [uid]);
    await sql("insert into public.ozon_connections(user_id,client_id,api_key_encrypted,status) values($1,'fixture-shop',$2,'connected')",
      [uid, encryptOzonApiKey("fixture-ozon-key")]);
    return uid;
  }
  const saveApi = (uid, operationId = randomUUID()) => fetchJson(ozon, uid, {
    month: "2026-06", operationId,
    manualExpenses: { tax: 7, packaging: 15, warehouseDelivery: 0, salary: 0, other: 20 },
  });

  it("P1-1 rejects mismatched projections at HTTP and callable RPC, then persists 482.50 everywhere with one charge", async () => {
    const uid = await db.user();
    const good = register();
    const mismatch = { ...good, calculation: { ...good.calculation, profit: 500, total_expenses: 750 },
      history: { ...good.history, profit: 600, expenses: 650 } };
    const client = await db.client("authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
    const callRpc = async ({ operationId, requestHash, calculation, history }) => (await client.query(
      "select public.save_calculation_operation($1,'upload',$2,$3,$4) as result", [operationId, requestHash, calculation, history]
    )).rows[0].result;
    const changeSnapshot = (mutate) => {
      const bad = structuredClone(good);
      mutate(bad.calculation.ai_insights);
      return bad;
    };
    const invalid = [
      ["projections", mismatch],
      ["unsupported version", changeSnapshot(snapshot => { snapshot.version = 999; })],
      ["missing version", changeSnapshot(snapshot => { delete snapshot.version; })],
      ["unknown source", changeSnapshot(snapshot => { snapshot.source.type = "other"; })],
      ["absent actual date", changeSnapshot(snapshot => { delete snapshot.period.dateFrom; })],
      ["invalid calendar date", changeSnapshot(snapshot => { snapshot.period.dateFrom = "2026-06-00"; })],
      ["net profit", changeSnapshot(snapshot => { snapshot.netProfitKopecks++; })],
      ["inconsistent margin", changeSnapshot(snapshot => { snapshot.marginPercent = 38.601; })],
      ["inconsistent quantity", changeSnapshot(snapshot => { snapshot.quantities.net++; })],
      ["false cost coverage", changeSnapshot(snapshot => { snapshot.costCoverage.missingCost++; })],
      ["inconsistent product totals", changeSnapshot(snapshot => { snapshot.productTotals.profitKopecks++; })],
      ["inconsistent product cost", changeSnapshot(snapshot => { snapshot.products[0].cogsKopecks++; })],
    ];
    for (const [name, bad] of invalid) {
      assert.equal((await fetchJson(ops, uid, bad)).status, 400, name);
      assert.deepEqual(await callRpc(bad), { ok: false, reason: "bad_request" }, name);
      assert.deepEqual(await state(uid), [0, 0, 0, 0], name);
    }
    const [first, second] = await Promise.all([fetchJson(ops, uid, good), fetchJson(ops, uid, good)]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal([first, second].filter(r => r.body.data.replay).length, 1);
    assert.deepEqual(await state(uid), [1, 1, 1, 1]);
    const { rows: recorded } = await sql(`select c.profit::float8 as calc, h.profit::float8 as history,
      (c.ai_insights->>'netProfitKopecks')::float8 / 100 as snapshot
      from public.calculations c join public.calculation_operations o on o.calculation_id=c.id
      join public.report_history h on h.id=o.report_history_id where c.user_id=$1`, [uid]);
    assert.deepEqual(recorded, [{ calc: 482.5, history: 482.5, snapshot: 482.5 }]);
    const status = await fetchJson(ops, uid, undefined, "?" + new URLSearchParams({
      operationId: good.operationId, requestHash: good.requestHash,
    }));
    assert.equal(status.body.data.calculation.profit, 482.5);
  });

  it("P1-2 refuses repeated/cyclic cursors, page errors, page limits and timeouts without saving or charging", async () => {
    const uid = await ozonUser();
    for (const [scenario, expected] of [
      ["repeat", "pagination_loop"], ["cycle", "pagination_loop"], ["http", "malformed_response"],
      ["limit", "pagination_truncated"], ["timeout", "deadline_exceeded"],
      ["omitted-initial", "malformed_response"], ["omitted-after-cursor", "malformed_response"],
    ]) {
      network.state.ozon = upstream(scenario);
      const failure = await withoutPacing(() => saveApi(uid));
      assert.ok(failure.status >= 400, JSON.stringify(failure));
      assert.equal(failure.body.code, expected, scenario);
      assert.deepEqual(await state(uid), [0, 0, 0, 0]);
    }
    const terminalUser = await ozonUser();
    network.state.ozon = upstream("terminal-empty");
    const terminal = await withoutPacing(() => saveApi(terminalUser));
    assert.equal(terminal.status, 200, JSON.stringify(terminal));
    assert.equal(terminal.body.result.netProfit, 482.5);
    assert.deepEqual(await state(terminalUser), [1, 1, 1, 1]);

    network.state.ozon = upstream("empty-continues");
    const complete = await withoutPacing(() => saveApi(uid));
    assert.equal(complete.status, 200, JSON.stringify(complete));
    assert.equal(complete.body.result.netProfit, 492.5, "an advancing empty page still has a successor");
    assert.deepEqual(await state(uid), [1, 1, 1, 1]);
  });

  it("P1-3 separates stores and intervals, and chooses only the explicitly confirmed historical version", async () => {
    const uid = await db.user();
    const storeA = "a".repeat(64);
    const storeB = "b".repeat(64);
    const add = async ({ mode = "api", store, from = "2026-06-01", to = "2026-06-30", profit = 482.5,
      date = "2026-07-01T00:00:00Z" } = {}) => (await sql(
      "insert into public.calculations(user_id,marketplace,mode,created_at,revenue,profit,ai_insights) values($1,'ozon',$2,$3,1000,$4,$5) returning id",
      [uid, mode, date, profit, { kind: mode === "api" ? "ozon-api-v1" : "ozon-accrual-xlsx-v1",
        period: { dateFrom: from, dateTo: to }, reportStoreKey: store, preliminary: { taxRevenueBase: 1250 } }]
    )).rows[0].id;
    const xlsx = await add({ mode: "upload" });
    await add();
    let report = (await summary(uid)).body.data;
    assert.equal(report.summary, null);
    assert.equal(report.excludedCount, 2);
    const choices = [{ id: xlsx, shop: "label:Магазин A" }];
    report = (await summary(uid, { choices })).body.data;
    assert.equal(report.summary.profit, 482.5);
    assert.equal(report.excludedCount, 1);
    await add({ store: storeA, profit: 10 });
    await add({ store: storeA, profit: 20, date: "2026-07-02T00:00:00Z" });
    await add({ store: storeB, profit: 30 });
    await add({ store: storeA, from: "2026-05-01", to: "2026-05-31", profit: 40 });
    report = (await summary(uid)).body.data;
    assert.equal(report.summary.profit, 90, "latest of identical store/period only, separate stores and periods");
    const partial = await add({ store: storeA, from: "2026-06-01", to: "2026-06-10", profit: 7 });
    report = (await summary(uid)).body.data;
    assert.equal(report.summary.profit, 70, "overlap requires confirmation");
    report = (await summary(uid, { choices: [{ id: partial, shop: storeA }] })).body.data;
    assert.equal(report.summary.profit, 77);
    report = (await summary(uid, { choices: [{ id: xlsx, shop: storeA }] })).body.data;
    assert.equal(report.summary.profit, 552.5, "an explicitly associated XLSX replaces matching API data");
    assert.equal((await fetchJson(calcs, uid)).body.data.length, 7, "all original versions remain in history");
  });

  it("XLSX copies at 482.50 with conflicting headers require explicit acceptance of actual dates", async () => {
    const uid = await db.user({ plan: "unlimited", premium: "10 days" });
    const first = register([["Период: 01.06.2026-10.06.2026"]]);
    const second = register([["Период: 11.06.2026-30.06.2026"]]);
    assert.equal(first.calculation.profit, 482.5);
    assert.equal(second.calculation.profit, 482.5);
    assert.ok(second.calculation.ai_insights.warnings.some(w => w.code === "dates_outside_declared_period"));
    const a = await fetchJson(ops, uid, first);
    const b = await fetchJson(ops, uid, second);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const firstChoice = { id: a.body.data.calculationId, shop: "label:Same store" };
    const secondChoice = { id: b.body.data.calculationId, shop: firstChoice.shop };
    const defaultView = (await summary(uid)).body.data;
    assert.equal(defaultView.excludedCount, 2);
    assert.equal(defaultView.summary, null);
    const confirmedShopOnly = (await summary(uid, { choices: [firstChoice, secondChoice] })).body.data;
    assert.equal(confirmedShopOnly.summary.profit, 482.5);
    assert.equal(confirmedShopOnly.excludedPeriodConflicts, 1);
    const conflict = confirmedShopOnly.decisions.find(row => row.id === secondChoice.id);
    assert.deepEqual([conflict.included, conflict.periodConflict], [false, true]);
    assert.deepEqual(conflict.period, { from: "2026-06-10", to: "2026-06-10" });
    assert.deepEqual(conflict.declaredPeriod, { from: "2026-06-11", to: "2026-06-30" });
    const resolved = (await summary(uid, {
      choices: [firstChoice, { ...secondChoice, acceptActualDates: true }],
    })).body.data;
    assert.deepEqual([resolved.summary.profit, resolved.summary.count, resolved.excludedCount], [482.5, 1, 1]);
    assert.equal(resolved.decisions.find(row => row.id === secondChoice.id).included, true);
    const history = (await fetchJson(calcs, uid)).body.data;
    assert.deepEqual(history.map(row => row.profit), [482.5, 482.5]);
    assert.deepEqual(await state(uid), [0, 2, 2, 2]);
  });

  it("latest-version order uses PostgreSQL microseconds before the stable UUID tie-breaker", async () => {
    const uid = await db.user();
    const lowerId = "00000000-0000-0000-0000-000000000001";
    const higherId = "00000000-0000-0000-0000-000000000002";
    const snapshot = { kind: "ozon-api-v1", reportStoreKey: "c".repeat(64),
      period: { dateFrom: "2026-06-01", dateTo: "2026-06-30" }, preliminary: { taxRevenueBase: 1250 } };
    await sql(`insert into public.calculations(id,user_id,marketplace,mode,profit,created_at,ai_insights)
      values($1,$3,'ozon','api',500,'2026-07-02T00:00:00.123999Z',$4),
            ($2,$3,'ozon','api',482.5,'2026-07-02T03:00:00.123001+03:00',$4)`,
      [lowerId, higherId, uid, snapshot]);
    assert.equal((await summary(uid)).body.data.summary.profit, 500);
    await sql("update public.calculations set created_at='2026-07-02T00:00:00.123999Z' where id=$1", [higherId]);
    assert.equal((await summary(uid)).body.data.summary.profit, 482.5);
    assert.equal((await fetchJson(calcs, uid)).body.data.length, 2);
  });

  it("Moscow calendar groups manual records at month and year boundaries", async () => {
    const uid = await db.user();
    await sql(`insert into public.calculations(user_id,marketplace,mode,profit,created_at)
      values($1,'ozon','manual',150,'2025-12-31T20:59:59Z'),
            ($1,'ozon','manual',250,'2026-01-01T00:15:00+03:00'),
            ($1,'ozon','manual',400,'2026-01-31T21:00:00Z')`, [uid]);
    const y26 = (await summary(uid)).body.data;
    assert.deepEqual(y26.monthly.map(row => [row.key, row.profit]), [["2026-01", 250], ["2026-02", 400]]);
    assert.equal(y26.summary.profit, 650);
    const y25 = (await summary(uid, { year: "2025" })).body.data;
    assert.deepEqual(y25.monthly.map(row => [row.key, row.profit]), [["2025-12", 150]]);
  });

  it("P1-4 aggregates beyond 50 and the backend page size, respects year/month and account boundary", async () => {
    const uid = await db.user();
    const outsider = await db.user();
    await sql(`insert into public.calculations(user_id,marketplace,mode,profit,created_at)
      select $1,'ozon','manual',case when n=0 then 250 else 100 end,
        '2026-01-31T23:59:00+03:00'::timestamptz + n*interval '1 minute' from generate_series(0,50) n`, [uid]);
    await sql(`insert into public.calculations(user_id,marketplace,mode,profit,created_at)
      select $1,'ozon','manual',25,'2025-12-31T23:59:00+03:00'::timestamptz from generate_series(1,60)`, [uid]);
    await sql("insert into public.calculations(user_id,marketplace,mode,profit,created_at) values($1,'ozon','manual',9999,'2026-02-01Z')", [outsider]);
    assert.equal((await fetchJson(calcs, uid)).body.data.length, 50);
    const response = await summary(uid);
    assert.equal(response.status, 200, JSON.stringify(response));
    const report = response.body.data;
    assert.deepEqual(report.years, ["2026", "2025"]);
    assert.equal(report.summary.profit, 5250);
    assert.deepEqual(report.monthly.map(m => [m.key, m.profit]), [["2026-01", 250], ["2026-02", 5000]]);
    assert.equal((await summary(uid, { year: "2025" })).body.data.summary.profit, 1500);
    assert.equal((await summary(null)).status, 401);
    assert.equal((await summary(outsider)).body.data.summary.profit, 9999);

    network.state.override = request => request.path.endsWith("/calculations") &&
      new URL(request.url).searchParams.get("id")?.startsWith("gt.")
      ? Response.json({ message: "test: summary page unavailable" }, { status: 500 }) : undefined;
    try {
      const incomplete = await summary(uid);
      assert.equal(incomplete.status, 502);
      assert.equal(incomplete.body.data, undefined);
    } finally {
      network.state.override = null;
    }
  });

  it("first review promotion is shown as advertising in XLSX and API history without changing profit", async () => {
    const uid = await ozonUser({ plan: "unlimited", premium: "10 days" });
    const xlsxRows = rows.map(line => line[3] === "Оплата за клик"
      ? line.map((cell, index) => index === 3 ? "Сбор первых отзывов" : cell) : line);
    const fixture = xlsxSaveFixture({ rows: xlsxRows, cost: 150, packaging: "15", ads: "20" });
    const reference = register();
    for (const field of ["revenue", "commission", "logistics", "ads", "cost", "tax",
      "other_expenses", "total_expenses", "profit", "margin"]) {
      assert.equal(fixture.calculation[field], reference.calculation[field], field);
    }
    const savedXlsx = await fetchJson(ops, uid, { ...reference, ...fixture });
    assert.equal(savedXlsx.status, 200, JSON.stringify(savedXlsx));

    network.state.ozon = upstream("review-promotion");
    const savedApi = await withoutPacing(() => saveApi(uid));
    assert.equal(savedApi.status, 200, JSON.stringify(savedApi));
    const { rows: written } = await sql(
      "select mode, profit::float8, logistics::float8, ads::float8, ai_insights from public.calculations where user_id=$1 order by mode",
      [uid]
    );
    assert.deepEqual(written.map(r => [r.mode, r.profit, r.logistics, r.ads]),
      [["api", 482.5, 110, 50], ["upload", 482.5, 110, 70]]);
    assert.deepEqual(written[0].ai_insights.financeTaxonomy.breakdown.ads,
      { signedTotal: -50, charges: 60, credits: 10 });
    assert.equal((await fetchJson(calcs, uid)).body.data.length, 2);
  });

  it("P1-5 stores 1250 return-adjusted revenue and keeps 482.50 profit, 38.60 margin and historical cost on replay", async () => {
    const uid = await ozonUser({ plan: "unlimited", premium: "10 days" });
    const id = randomUUID();
    network.state.ozon = upstream();
    const first = await withoutPacing(() => saveApi(uid, id));
    assert.equal(first.status, 200, JSON.stringify(first));
    const calc = (await fetchJson(calcs, uid)).body.data[0];
    assert.deepEqual([calc.revenue, calc.profit, calc.margin, calc.cost], [1000, 482.5, 38.6, 300]);
    assert.equal(calc.ai_insights.preliminary.taxRevenueBase, 1250);
    assert.equal(calc.ai_insights.apiTotals.ozonAccruals, 1000);
    assert.equal(calc.ai_insights.preliminary.ozonOperationsTotal, 905);
    assert.match(calc.ai_insights.reportStoreKey, /^[0-9a-f]{64}$/);
    const history = (await sql("select revenue::float8,profit::float8,margin::float8 from public.report_history where user_id=$1", [uid])).rows[0];
    assert.deepEqual(history, { revenue: 1250, profit: 482.5, margin: 38.6 });
    await sql("update public.products set cost_price=200 where user_id=$1", [uid]);
    const before = network.ozonCalls().length;
    const replay = await saveApi(uid, id);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.calculation.cost, 300);
    assert.equal(network.ozonCalls().length, before);
    const historical = (await summary(uid)).body.data.summary;
    assert.deepEqual([historical.revenue, historical.profit, Number(historical.avgMargin.toFixed(2)),
      historical.expenses, historical.revenueBasisAdjustment, historical.manualExtraExpenses],
    [1250, 482.5, 38.6, 767.5, 250, 35]);
    const actual = (await sql("select revenue::float8 as revenue from public.calculations where id=$1", [calc.id])).rows[0];
    assert.equal(actual.revenue, 1000, "reading the summary does not rewrite historical calculations");
  });
});
