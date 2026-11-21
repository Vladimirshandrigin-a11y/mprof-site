import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { after, describe, before, it } from "node:test";
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
const register = () => ({ operationId: randomUUID(), requestHash: "2026-06:fixture",
  ...xlsxSaveFixture({ rows, cost: 150, packaging: "15", ads: "20" }) });
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
      return Response.json({ types: [{ type_id: 1, name: "Оплата за клик" },
        { type_id: 2, name: "Начисление по спору" }, { type_id: 3, name: "Эквайринг" }] });
    }
    if (endpoint === "/v1/finance/accrual/by-day") {
      if (body.date !== day) return Response.json({ accruals: [], last_id: "" });
      if (scenario === "normal") return Response.json({ accruals: ledger, last_id: "" });
      if (!body.last_id) return Response.json({ accruals: ledger, last_id: "1" });
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
  after(() => network.restore());
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
    assert.equal((await fetchJson(ops, uid, mismatch)).status, 400);
    const client = await db.client("authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
    const callRpc = async ({ operationId, requestHash, calculation, history }) => (await client.query(
      "select public.save_calculation_operation($1,'upload',$2,$3,$4) as result", [operationId, requestHash, calculation, history]
    )).rows[0].result;
    assert.deepEqual(await callRpc(mismatch), { ok: false, reason: "bad_request" });
    assert.deepEqual(await state(uid), [0, 0, 0, 0]);
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
    ]) {
      network.state.ozon = upstream(scenario);
      const failure = await withoutPacing(() => saveApi(uid));
      assert.ok(failure.status >= 400, JSON.stringify(failure));
      assert.equal(failure.body.code, expected, scenario);
      assert.deepEqual(await state(uid), [0, 0, 0, 0]);
    }
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

  it("P1-4 aggregates beyond 50 and the backend page size, respects year/month and account boundary", async () => {
    const uid = await db.user();
    const outsider = await db.user();
    await sql(`insert into public.calculations(user_id,marketplace,mode,profit,created_at)
      select $1,'ozon','manual',case when n=0 then 250 else 100 end,
        '2026-01-31T23:59:00Z'::timestamptz + n*interval '1 minute' from generate_series(0,50) n`, [uid]);
    await sql(`insert into public.calculations(user_id,marketplace,mode,profit,created_at)
      select $1,'ozon','manual',25,'2025-12-31T23:59:00Z'::timestamptz from generate_series(1,60)`, [uid]);
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
