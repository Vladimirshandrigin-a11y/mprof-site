// Атомарное списание и сохранение ручного расчёта и Ozon API — настоящие обработчики
// (скомпилированы run.mjs):
//   • app/api/cloud/calculation-operations/route.ts (ручной, mode "manual");
//   • app/api/ozon/save-calculation/route.ts (Ozon API; Ozon — заглушка в fetch-stub);
//   • app/api/cloud/calculations/route.ts (граница: клиент не пишет mode 'api');
// → настоящий supabase-js → RPC на НАСТОЯЩЕЙ PostgreSQL. Запуск: TEST_DATABASE_URL=… npm run test:db.
//
// База: schema.sql до миграций + миграция продления безлимита (PR #105) + ДОСЛОВНО
// 20260928_calculation_operations.sql (#107) + 20260929_calculation_operations_manual_api.sql.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { SERVICE_KEY, SUPABASE_URL, gate, installFetch, userJwt } from "./helpers/fetch-stub.mjs";
import { SCHEMA, buildRequire, payTestEnv, read, root, runScript } from "./helpers/pay-db.mjs";

const OPS_MIGRATION = read("supabase/migrations/20260928_calculation_operations.sql");
const MA_MIGRATION = read("supabase/migrations/20260929_calculation_operations_manual_api.sql");
const MA_CHECKS = read("supabase/checks/calculation_operations_manual_api.sql");

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.OZON_KEYS_ENC_SECRET = "test-only-ozon-secret-0123456789abcdef";
delete process.env.OZON_FINANCE_ACCRUAL_ENABLED; // финансы Ozon — legacy-эндпоинт заглушки

const OPS_ROUTE = buildRequire("./api/cloud/calculation-operations/route.js");
const SAVE_API = buildRequire("./api/ozon/save-calculation/route.js");
const CALCS_ROUTE = buildRequire("./api/cloud/calculations/route.js");
const CRYPTO = buildRequire("./api/ozon/_lib/crypto.js");
const KEYS = buildRequire("./app/lib/calc-operation-keys.js");
const rootRequire = createRequire(path.join(root, "package.json"));
const { NextRequest } = rootRequire("next/server");
const { createClient } = rootRequire("@supabase/supabase-js");

const net = installFetch();
const { state } = net;
const { freshDb } = payTestEnv();

// ── ручной расчёт ────────────────────────────────────────────────────────────
const MANUAL = { marketplace: "ozon", revenue: 100000, commission: 15000, logistics: 8000, storage: 2000, ads: 5000, cost: 40000, tax: 6000, other: 1500 };

async function postManual(userId, { inputs = MANUAL, operationId = randomUUID() } = {}) {
  const req = new NextRequest("http://localhost/api/cloud/calculation-operations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(userId)}` },
    body: JSON.stringify({ mode: "manual", operationId, inputs }),
  });
  const res = await OPS_ROUTE.POST(req);
  return { status: res.status, body: await res.json(), operationId };
}

async function opStatus(userId, operationId, requestHash) {
  const q = new URLSearchParams({ operationId, requestHash });
  const req = new NextRequest(`http://localhost/api/cloud/calculation-operations?${q}`, {
    headers: { authorization: `Bearer ${userJwt(userId)}` },
  });
  const res = await OPS_ROUTE.GET(req);
  return { status: res.status, body: await res.json() };
}

// ── XLSX (для конкуренции режимов) ───────────────────────────────────────────
const xlsxBody = (requestHash = "2026-06:12:fileA") => ({
  operationId: randomUUID(),
  requestHash,
  calculation: {
    marketplace: "ozon", mode: "upload", revenue: 850, commission: 180, logistics: 67, ads: 60, storage: 0, tax: 59.5,
    cost: 100, other_expenses: 15.55, total_expenses: 200, profit: 650, margin: 76.47,
    ai_insights: { kind: "ozon-accrual-xlsx-v1", generatedAt: "2026-07-01T10:00:00.000Z", profitKopecks: 65000 },
  },
  history: { report_month: "2026-06-01", revenue: 850, expenses: 200, profit: 650, margin: 76.47 },
});
async function postXlsx(userId, body = xlsxBody()) {
  const req = new NextRequest("http://localhost/api/cloud/calculation-operations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(userId)}` },
    body: JSON.stringify(body),
  });
  const res = await OPS_ROUTE.POST(req);
  return { status: res.status, body: await res.json() };
}

// ── Ozon API (Ozon — заглушка) ───────────────────────────────────────────────
const rzRow = (offer, sku, name, saleQty, saleAmount, retQty = 0, retAmount = 0) => ({
  item: { offer_id: offer, sku, name },
  delivery_commission: { amount: saleAmount, quantity: saleQty },
  return_commission: { amount: retAmount, quantity: retQty },
  seller_price_per_instance: saleAmount / Math.max(1, saleQty),
});
const REALIZATION = [rzRow("ART-A", 111, "Товар А", 10, 1500, 2, 300), rzRow("ART-B", 222, "Товар Б", 5, 900), rzRow("ART-C", 333, "Товар В", 1, 100)];
const OPERATIONS = [{ operation_type: "OperationAgentDeliveredToCustomer", type: "orders", accruals_for_sale: 1000, sale_commission: -150, amount: 850, services: [] }];
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
function ozonOk(req) {
  const u = req.url;
  if (u.includes("/v3/finance/transaction/list")) return jsonRes({ result: { operations: OPERATIONS, page_count: 1, row_count: OPERATIONS.length } });
  if (u.includes("/v2/finance/realization")) return jsonRes({ result: { header: {}, rows: REALIZATION } });
  if (u.includes("/v2/posting/fbo/list")) return jsonRes({ result: [] });
  if (u.includes("/v3/posting/fbs/list")) return jsonRes({ result: { postings: [], has_next: false } });
  return jsonRes({}, 404);
}
const EXPENSES = { tax: 7, packaging: 100, warehouseDelivery: 0, salary: 0, other: 0 };

async function postApi(userId, { month = "2026-06", manualExpenses = EXPENSES, operationId = randomUUID() } = {}) {
  const req = new NextRequest("http://localhost/api/ozon/save-calculation", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(userId)}` },
    body: JSON.stringify({ month, manualExpenses, operationId }),
  });
  const res = await SAVE_API.POST(req);
  return { status: res.status, body: await res.json(), operationId };
}

/** Пользователь с подключением Ozon (ключ зашифрован настоящей функцией) и полным каталогом. */
async function apiUser(db, { unlimited = false, used = 0, credits = 0 } = {}) {
  const u = await db.user(unlimited ? { plan: "unlimited", premium: "10 days" } : {});
  if (used) await db.main.query("update public.profiles set calculations_used = $2 where id = $1", [u, used]);
  for (let i = 0; i < credits; i++) {
    await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [u]);
  }
  await db.main.query(
    "insert into public.ozon_connections (user_id, client_id, api_key_encrypted, status) values ($1, 'c1', $2, 'connected')",
    [u, CRYPTO.encryptOzonApiKey("plain-api-key")]
  );
  for (const [sku, cost] of [["ART-A", 100], ["ART-B", 50], ["ART-C", 20]]) {
    await db.main.query("insert into public.products (user_id, sku, name, cost_price) values ($1, $2, $3, $4)", [u, sku, `имя ${sku}`, cost]);
  }
  return u;
}

// ── общие проверки состояния ─────────────────────────────────────────────────
async function facts(db, userId) {
  const q = async (sql) => (await db.main.query(sql, [userId])).rows;
  const [p] = await q("select calculations_used from public.profiles where id = $1");
  return {
    used: p?.calculations_used ?? null,
    calcs: (await q("select id from public.calculations where user_id = $1")).length,
    history: (await q("select id from public.report_history where user_id = $1")).length,
    ops: (await q("select id from public.calculation_operations where user_id = $1")).length,
  };
}
async function dbState(db) {
  const t = async (sql) => (await db.main.query(sql)).rows;
  return JSON.stringify([
    await t("select * from public.profiles order by id"),
    await t("select * from public.subscriptions order by id"),
    await t("select * from public.calculations order by id"),
    await t("select * from public.report_history order by id"),
    await t("select * from public.calculation_operations order by id"),
  ]);
}
async function opRow(db, id) {
  return (await db.main.query("select user_id, mode, request_hash, calculation_id, report_history_id, charged from public.calculation_operations where id = $1", [id])).rows[0] ?? null;
}
/** Штатное удаление из истории: тот же запрос supabase-js, что deleteCalculationFromCloud. */
async function deleteFromHistory(userId, calculationId) {
  const sb = createClient(SUPABASE_URL, "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${userJwt(userId)}` } },
  });
  const { error } = await sb.from("calculations").delete().eq("id", calculationId).eq("user_id", userId);
  return error;
}
/** Вызов SQL от имени authenticated с auth.uid() = uid (или анонимно при uid = null). */
async function asUser(db, uid, sql, params = []) {
  const c = await db.client();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
  try {
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}

const realConsoleError = console.error;
const realConsoleWarn = console.warn;
const realConsoleLog = console.log;
before(() => {
  console.error = () => {}; // маршруты пишут в лог ожидаемые сбои
  console.warn = () => {};
  console.log = () => {};
});
after(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
  console.log = realConsoleLog;
  net.restore();
});
beforeEach(() => net.reset());

// ─────────────────────────────────────────────────────────────────────────────
describe("ручной расчёт: списание и запись — одна транзакция через настоящий маршрут", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
  });
  beforeEach(() => {
    state.pool = db.pool(12);
  });

  it("успех: итог считает сервер из введённых значений; одна строка calculations (mode manual, без снимка), без сводки, отметка операции, списание 1", async () => {
    const u = await db.user();
    const out = await postManual(u);
    assert.equal(out.status, 200);
    const d = out.body.data;
    assert.deepEqual([d.status, d.replay, d.mode, d.charged, d.used], ["done", false, "manual", true, 1]);
    const expected = KEYS.computeManualColumns(MANUAL);
    assert.equal(d.calculation.profit, expected.profit);
    assert.equal(d.calculation.total_expenses, expected.total_expenses);
    assert.equal(Number(d.calculation.margin).toFixed(6), expected.margin.toFixed(6));
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
    const row = (await db.main.query("select mode, ai_insights, profit from public.calculations where id = $1", [d.calculationId])).rows[0];
    assert.deepEqual([row.mode, row.ai_insights, Number(row.profit)], ["manual", null, expected.profit]);
    const op = await opRow(db, out.operationId);
    assert.deepEqual([op.mode, op.request_hash, op.report_history_id, op.charged], ["manual", KEYS.manualRequestHash(MANUAL), null, true]);
    assert.deepEqual(net.rpcCalls().map((r) => r.path), ["/rest/v1/rpc/save_manual_calculation_operation"]);
  });

  it("сбой записи результата: откат — ни списания, ни строк; повтор с тем же ключом проходит один раз", async () => {
    const u = await db.user();
    await db.main.query(`
      create or replace function public.test_fail_manual() returns trigger language plpgsql as $$
      begin if new.mode = 'manual' then raise exception 'test: calculations недоступна'; end if; return new; end $$;
      create trigger test_fail_manual before insert on public.calculations
        for each row execute function public.test_fail_manual();`);
    const operationId = randomUUID();
    try {
      const failed = await postManual(u, { operationId });
      assert.deepEqual([failed.status, failed.body.code], [502, "rpc_failed"]);
      assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    } finally {
      await db.main.query("drop trigger test_fail_manual on public.calculations; drop function public.test_fail_manual();");
    }
    const ok = await postManual(u, { operationId });
    assert.deepEqual([ok.status, ok.body.data.replay], [200, false]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("COMMIT с потерянным ответом: повтор тем же ключом возвращает сохранённую строку — без списания и дубля", async () => {
    const u = await db.user();
    const operationId = randomUUID();
    state.dropAfterCommit = (r) => r.path === "/rest/v1/rpc/save_manual_calculation_operation";
    const lost = await postManual(u, { operationId });
    assert.equal(lost.status, 502, "маршрут не подтверждает успех без ответа БД");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 }, "в БД всё зафиксировано");
    state.dropAfterCommit = null;
    const retry = await postManual(u, { operationId });
    assert.equal(retry.status, 200);
    assert.deepEqual([retry.body.data.replay, retry.body.data.contentMatch, retry.body.data.charged], [true, true, true]);
    const saved = (await db.main.query("select id, profit from public.calculations where user_id = $1", [u])).rows[0];
    assert.deepEqual([retry.body.data.calculation.id, retry.body.data.calculation.profit], [saved.id, Number(saved.profit)]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("двойной клик / две вкладки: 6 одновременных запросов одного ключа → одно списание, одна строка, остальные — повтор", async () => {
    const u = await db.user();
    const operationId = randomUUID();
    const outs = await Promise.all(Array.from({ length: 6 }, () => postManual(u, { operationId })));
    assert.ok(outs.every((o) => o.status === 200));
    assert.equal(outs.filter((o) => o.body.data.replay === false).length, 1);
    assert.equal(new Set(outs.map((o) => o.body.data.calculationId)).size, 1);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("тот же ключ с изменёнными значениями → 409, сохранённый расчёт не перезаписан, ничего не создано и не списано", async () => {
    const u = await db.user();
    await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [u]);
    const first = await postManual(u);
    assert.equal(first.status, 200);
    const snap = await dbState(db);
    for (const changed of [{ ...MANUAL, tax: 7000 }, { ...MANUAL, ads: 1 }, { ...MANUAL, cost: 1 }, { ...MANUAL, marketplace: "wb" }]) {
      const r = await postManual(u, { inputs: changed, operationId: first.operationId });
      assert.deepEqual([r.status, r.body.code, r.body.data], [409, "operation_conflict", undefined]);
    }
    assert.equal(await dbState(db), snap);
  });

  it("изоляция пользователей: чужой ключ → 409 без данных; статус чужой операции — none; свои счётчики не тронуты", async () => {
    const a = await db.user();
    const b = await db.user();
    const mine = await postManual(a);
    const stolen = await postManual(b, { operationId: mine.operationId });
    assert.deepEqual([stolen.status, stolen.body.data], [409, undefined]);
    const peek = await opStatus(b, mine.operationId, KEYS.manualRequestHash(MANUAL));
    assert.deepEqual([peek.body.data.status, peek.body.data.calculation], ["none", null]);
    assert.deepEqual(await facts(db, b), { used: 0, calcs: 0, history: 0, ops: 0 });
  });

  it("восстановление: статус отдаёт сохранённую строку целиком (режим, итог) — без пересчёта", async () => {
    const u = await db.user();
    const out = await postManual(u);
    const st = await opStatus(u, out.operationId, KEYS.manualRequestHash(MANUAL));
    assert.equal(st.status, 200);
    assert.deepEqual([st.body.data.status, st.body.data.mode], ["done", "manual"]);
    assert.deepEqual(st.body.data.calculation, out.body.data.calculation);
    const wrong = await opStatus(u, out.operationId, KEYS.manualRequestHash({ ...MANUAL, tax: 1 }));
    assert.equal(wrong.body.data.status, "conflict");
  });

  it("удаление штатным запросом → повтор прежней операции: «deleted», без списания и без повторного создания; журнал остаётся", async () => {
    const u = await db.user();
    await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [u]);
    const out = await postManual(u);
    assert.equal(await deleteFromHistory(u, out.body.data.calculationId), null);
    const op = await opRow(db, out.operationId);
    assert.deepEqual([op.calculation_id, op.charged], [null, true]);
    const snap = await dbState(db);
    const replay = await postManual(u, { operationId: out.operationId });
    assert.deepEqual([replay.status, replay.body.data.status, replay.body.data.replay], [200, "deleted", true]);
    assert.equal(await dbState(db), snap, "ничего не записано и не списано");
    const st = await opStatus(u, out.operationId, KEYS.manualRequestHash(MANUAL));
    assert.equal(st.body.data.status, "deleted");
    const fresh = await postManual(u);
    assert.deepEqual([fresh.status, fresh.body.data.replay, fresh.body.data.used], [200, false, 2], "новый расчёт — новая операция по правилам");
  });

  it("точность: копейки и дробные суммы сохраняются и отдаются статусом точно; итог — ровно computeManualColumns; восстановленная форма даёт ту же операцию", async () => {
    const u = await db.user();
    const KOP = { marketplace: "ozon", revenue: 123456.78, commission: 18518.52, logistics: 7654.31, storage: 0.07, ads: 3210.99, cost: 45678.9, tax: 7407.41, other: 12.345 };
    const out = await postManual(u, { inputs: KOP });
    assert.equal(out.status, 200);
    const st = await opStatus(u, out.operationId, KEYS.manualRequestHash(KOP));
    const c = st.body.data.calculation;
    assert.deepEqual(
      [c.revenue, c.commission, c.logistics, c.storage, c.ads, c.cost, c.tax, c.other_expenses],
      [KOP.revenue, KOP.commission, KOP.logistics, KOP.storage, KOP.ads, KOP.cost, KOP.tax, KOP.other]
    );
    const exp = KEYS.computeManualColumns(KOP);
    assert.deepEqual([c.total_expenses, c.profit, c.margin], [exp.total_expenses, exp.profit, exp.margin]);
    const [txt] = (await db.main.query("select revenue::text as r, storage::text as s, other_expenses::text as o from public.calculations where id = $1", [c.id])).rows;
    assert.deepEqual([txt.r, txt.s, txt.o], ["123456.78", "0.07", "12.345"], "numeric хранит ввод без округления");
    const form = KEYS.manualFormFromSaved({ revenue: c.revenue, commission: c.commission, logistics: c.logistics, storage: c.storage, ads: c.ads, cost: c.cost, tax: c.tax, other: c.other_expenses });
    const back = { marketplace: c.marketplace };
    for (const f of KEYS.MANUAL_INPUT_FIELDS) back[f] = KEYS.parseManualAmount(form[f]);
    assert.deepEqual(back, KOP);
    const replay = await postManual(u, { inputs: back, operationId: out.operationId });
    assert.deepEqual([replay.status, replay.body.data.replay, replay.body.data.contentMatch], [200, true, true], "та же операция — без списания");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("поздний COMMIT: пока исходный запрос в полёте, статус «нет» (не доказательство отказа); после COMMIT статус done, повтор тем же ключом — сохранённая строка без списания", async () => {
    const u = await db.user();
    const operationId = randomUUID();
    const rh = KEYS.manualRequestHash(MANUAL);
    let seen = 0;
    const g = gate((r) => r.path === "/rest/v1/rpc/save_manual_calculation_operation" && seen++ === 0);
    state.gates.push(g);
    const original = postManual(u, { operationId });
    await g.reached; // запрос дошёл до сервера, SQL ещё не выполнен
    for (let i = 0; i < 3; i++) assert.equal((await opStatus(u, operationId, rh)).body.data.status, "none");
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    g.open(); // поздний COMMIT — уже после «окна перепроверки»
    assert.deepEqual([(await original).status], [200]);
    assert.equal((await opStatus(u, operationId, rh)).body.data.status, "done");
    const retry = await postManual(u, { operationId });
    assert.deepEqual([retry.status, retry.body.data.replay], [200, true]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("повтор тем же ключом, пока исходный запрос ещё в полёте: выполняется один раз — исходный потом получает сохранённое; попытка последняя, списание одно", async () => {
    const u = await db.user(); // одна (бесплатная) попытка
    const operationId = randomUUID();
    let seen = 0;
    const g = gate((r) => r.path === "/rest/v1/rpc/save_manual_calculation_operation" && seen++ === 0);
    state.gates.push(g);
    const original = postManual(u, { operationId });
    await g.reached;
    const resend = await postManual(u, { operationId }); // «проверить и завершить сохранение»
    assert.deepEqual([resend.status, resend.body.data.replay], [200, false]);
    g.open();
    const late = await original;
    assert.deepEqual([late.status, late.body.data.replay, late.body.data.calculationId], [200, true, resend.body.data.calculationId]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 0, ops: 1 });
  });

  it("некорректный ввод → 400 без обращения к БД", async () => {
    const u = await db.user();
    for (const inputs of [null, {}, { ...MANUAL, revenue: "100" }, { ...MANUAL, marketplace: "ya" }, { ...MANUAL, tax: Number.NaN }]) {
      const r = await postManual(u, { inputs });
      assert.equal(r.status, 400);
    }
    const bad = await OPS_ROUTE.POST(new NextRequest("http://localhost/api/cloud/calculation-operations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(u)}` },
      body: JSON.stringify({ mode: "manual", operationId: "не-uuid", inputs: MANUAL }),
    }));
    assert.equal(bad.status, 400);
    assert.equal(net.rpcCalls().length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Ozon API: Ozon вне транзакции, права + списание + запись — одна транзакция", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
  });
  beforeEach(() => {
    state.pool = db.pool(12);
    state.ozon = ozonOk;
  });

  it("успех (общая бесплатная попытка): строка api со снимком, сводка, отметка операции — одно списание; пользователь из токена", async () => {
    const u = await apiUser(db);
    const out = await postApi(u);
    assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300));
    assert.deepEqual([out.body.ok, out.body.replay, out.body.consume.unlimited, out.body.consume.used], [true, false, false, 1]);
    assert.ok(out.body.profit, "полный расчёт для экрана");
    assert.ok(net.ozonCalls().length > 0);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
    const row = (await db.main.query("select user_id, mode, ai_insights->>'kind' as kind from public.calculations where id = $1", [out.body.calculationId])).rows[0];
    assert.deepEqual([row.user_id, row.mode, row.kind], [u, "api", "ozon-api-v1"]);
    const op = await opRow(db, out.operationId);
    assert.deepEqual([op.mode, op.request_hash, op.charged], ["api", KEYS.apiRequestHash("2026-06", EXPENSES), true]);
    assert.ok(op.report_history_id);
    assert.deepEqual(net.rpcCalls().map((r) => [r.path, r.headers.authorization === `Bearer ${SERVICE_KEY}`]), [
      ["/rest/v1/rpc/api_calculation_operation_status", true],
      ["/rest/v1/rpc/save_api_calculation_operation", true],
    ]);
  });

  it("безлимит: без расхода попытки (charged=false)", async () => {
    const u = await apiUser(db, { unlimited: true, used: 3 });
    const out = await postApi(u);
    assert.deepEqual([out.status, out.body.consume.unlimited], [200, true]);
    assert.equal((await opRow(db, out.operationId)).charged, false);
    assert.deepEqual(await facts(db, u), { used: 3, calcs: 1, history: 1, ops: 1 });
  });

  it("только разовые кредиты: API недоступен (402), ничего не записано и не списано; ручной расчёт тем же кредитом — доступен", async () => {
    const u = await apiUser(db, { used: 1, credits: 2 });
    const out = await postApi(u);
    assert.deepEqual([out.status, out.body.code], [402, "limit_reached"]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 0, history: 0, ops: 0 });
    const manual = await postManual(u);
    assert.deepEqual([manual.status, manual.body.data.used], [200, 2]);
  });

  it("ошибка Ozon: попытка не расходуется, операция не вызывается", async () => {
    const u = await apiUser(db);
    state.ozon = () => jsonRes({ message: "down" }, 503);
    const out = await postApi(u);
    assert.ok(out.status >= 400 && out.status !== 402, `статус ${out.status}`);
    assert.notEqual(out.body.code, "operation_failed");
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    assert.ok(!net.rpcCalls().some((r) => r.path === "/rest/v1/rpc/save_api_calculation_operation"));
  });

  it("сбой записи внутри операции: откат — ни списания, ни строк, ни сводки", async () => {
    const u = await apiUser(db);
    await db.main.query(`
      create or replace function public.test_fail_api() returns trigger language plpgsql as $$
      begin raise exception 'test: report_history недоступна'; end $$;
      create trigger test_fail_api before insert on public.report_history
        for each row execute function public.test_fail_api();`);
    try {
      const out = await postApi(u);
      assert.deepEqual([out.status, out.body.code], [502, "operation_failed"]);
      assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    } finally {
      await db.main.query("drop trigger test_fail_api on public.report_history; drop function public.test_fail_api();");
    }
  });

  it("COMMIT с потерянным ответом → повтор: сохранённый расчёт ДО обращений к Ozon, без списания и дубля", async () => {
    const u = await apiUser(db);
    const operationId = randomUUID();
    state.dropAfterCommit = (r) => r.path === "/rest/v1/rpc/save_api_calculation_operation";
    const lost = await postApi(u, { operationId });
    assert.deepEqual([lost.status, lost.body.code], [502, "operation_failed"]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 }, "в БД всё зафиксировано");
    net.reset();
    state.pool = db.pool(4);
    state.ozon = ozonOk;
    const retry = await postApi(u, { operationId });
    assert.equal(retry.status, 200);
    assert.deepEqual([retry.body.replay, retry.body.status], [true, "done"]);
    assert.equal(retry.body.calculation.mode, "api");
    assert.equal(retry.body.calculation.ai_insights.kind, "ozon-api-v1");
    assert.equal(net.ozonCalls().length, 0, "Ozon не вызывался");
    assert.deepEqual(net.rpcCalls().map((r) => r.path), ["/rest/v1/rpc/api_calculation_operation_status"]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("параллельные повторы одного ключа: одно списание и одна строка; остальные получают сохранённый расчёт", async () => {
    const u = await apiUser(db);
    const operationId = randomUUID();
    const outs = await Promise.all(Array.from({ length: 3 }, () => postApi(u, { operationId })));
    assert.ok(outs.every((o) => o.status === 200), JSON.stringify(outs.map((o) => o.status)));
    assert.equal(outs.filter((o) => o.body.replay === false).length, 1);
    assert.equal(new Set(outs.map((o) => o.body.calculationId ?? o.body.calculation?.id)).size, 1);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("тот же ключ с другими месяцем или расходами → 409 до Ozon, ничего не записано", async () => {
    const u = await apiUser(db, { unlimited: true });
    const first = await postApi(u);
    assert.equal(first.status, 200);
    const snap = await dbState(db);
    net.reset();
    state.pool = db.pool(4);
    state.ozon = ozonOk;
    for (const params of [{ month: "2026-05" }, { manualExpenses: { ...EXPENSES, tax: 6 } }]) {
      const r = await postApi(u, { ...params, operationId: first.operationId });
      assert.deepEqual([r.status, r.body.code], [409, "operation_conflict"]);
    }
    assert.equal(net.ozonCalls().length, 0);
    assert.equal(await dbState(db), snap);
  });

  it("удаление штатным запросом → повтор: «deleted» без Ozon, списания и повторного создания; журнал остаётся", async () => {
    const u = await apiUser(db);
    const out = await postApi(u);
    assert.equal(await deleteFromHistory(u, out.body.calculationId), null);
    const snap = await dbState(db);
    net.reset();
    state.pool = db.pool(4);
    state.ozon = ozonOk;
    const replay = await postApi(u, { operationId: out.operationId });
    assert.deepEqual([replay.status, replay.body.replay, replay.body.status], [200, true, "deleted"]);
    assert.equal(net.ozonCalls().length, 0);
    assert.equal(await dbState(db), snap);
    assert.equal((await opRow(db, out.operationId)).calculation_id, null);
  });

  it("поздний COMMIT API: пока запись в полёте — статус «нет»; после COMMIT повтор тем же ключом — сохранённый расчёт без Ozon и без списания, хотя права уже исчерпаны", async () => {
    const u = await apiUser(db); // единственная бесплатная попытка
    const operationId = randomUUID();
    const rh = KEYS.apiRequestHash("2026-06", EXPENSES);
    let seen = 0;
    const g = gate((r) => r.path === "/rest/v1/rpc/save_api_calculation_operation" && seen++ === 0);
    state.gates.push(g);
    const original = postApi(u, { operationId });
    await g.reached; // Ozon уже опрошен, запись ждёт
    for (let i = 0; i < 3; i++) assert.equal((await opStatus(u, operationId, rh)).body.data.status, "none");
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    g.open();
    assert.equal((await original).status, 200);
    const ozonBefore = net.ozonCalls().length;
    const fresh = await postApi(u); // новая операция — прав уже нет
    assert.deepEqual([fresh.status, fresh.body.code], [402, "limit_reached"]);
    const ozonMid = net.ozonCalls().length;
    const retry = await postApi(u, { operationId });
    assert.deepEqual([retry.status, retry.body.replay, retry.body.status], [200, true, "done"]);
    assert.equal(net.ozonCalls().length, ozonMid, "повтор завершённой операции не обращается к Ozon");
    assert.ok(ozonMid > ozonBefore, "новая операция к Ozon обращалась (до отказа)");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("восстановление через статус пользователя: API-операция отдаёт сохранённую строку", async () => {
    const u = await apiUser(db);
    const out = await postApi(u);
    const st = await opStatus(u, out.operationId, KEYS.apiRequestHash("2026-06", EXPENSES));
    assert.deepEqual([st.body.data.status, st.body.data.mode, st.body.data.calculation.id], ["done", "api", out.body.calculationId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("граница доверия: клиент не пишет API-расчёт и не подменяет режим", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
  });
  beforeEach(() => {
    state.pool = db.pool(6);
  });

  it("права: внутренние функции (явный user_id) не вызывает никто — PUBLIC, anon, authenticated, service_role; серверные API-функции — только service_role; отказ ничего не меняет", async () => {
    const victim = await db.user();
    const attacker = await db.user();
    const victimOp = await postManual(victim);
    assert.equal(victimOp.status, 200);
    const denied = (e) => e.code === "42501";
    const calc = JSON.stringify({ marketplace: "ozon", revenue: 1, commission: 0, logistics: 0, ads: 0, storage: 0, tax: 0, cost: 0, other_expenses: 0, total_expenses: 0, profit: 1, margin: 100, ai_insights: { kind: "ozon-api-v1" } });
    const hist = JSON.stringify({ report_month: "2026-06-01", revenue: 1, expenses: 0, profit: 1, margin: 100 });
    // Функции с явным пользователем — через них можно было бы списать или прочитать чужое.
    const INTERNAL = [
      ["public.consume_calculation_for($1)", [victim]],
      ["public.consume_api_calculation_for($1)", [victim]],
      ["public.calculation_operation_saved($1)", [victimOp.body.data.calculationId]],
      ["public.calculation_operation_execute($1, $2, 'api', 'x', $3::jsonb, $4::jsonb)", [victim, randomUUID(), calc, hist]],
      ["public.calculation_operation_lookup($1, $2, $3, null)", [victim, victimOp.operationId, KEYS.manualRequestHash(MANUAL)]],
    ];
    const SERVER = [
      ["public.save_api_calculation_operation($1, $2, 'x', $3::jsonb, $4::jsonb)", [victim, randomUUID(), calc, hist]],
      ["public.api_calculation_operation_status($1, $2, 'x')", [victim, victimOp.operationId]],
    ];
    const before = await dbState(db);

    // PUBLIC: роль без собственных прав получает только выданное PUBLIC.
    await db.main.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'mprof_public_probe') then create role mprof_public_probe nologin; end if; end $$");
    const probe = await db.client("mprof_public_probe");
    for (const [sql, args] of [...INTERNAL, ...SERVER, ["public.save_manual_calculation_operation($1, 'x', '{}'::jsonb)", [randomUUID()]]]) {
      await assert.rejects(probe.query(`select ${sql}`, args), denied, `PUBLIC: ${sql}`);
    }
    const publicAcl = (await db.main.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'
         and p.proname in ('consume_calculation_for', 'consume_api_calculation_for', 'calculation_operation_saved',
                           'calculation_operation_execute', 'calculation_operation_lookup', 'save_manual_calculation_operation',
                           'save_api_calculation_operation', 'api_calculation_operation_status')`)).rows;
    assert.deepEqual(publicAcl, [], "EXECUTE для PUBLIC не выдан ни одной новой функции");

    // anon и authenticated (атакующий пытается действовать за жертву).
    const anon = await db.client("anon");
    for (const [sql, args] of [...INTERNAL, ...SERVER]) {
      await assert.rejects(anon.query(`select ${sql}`, args), denied, `anon: ${sql}`);
      await assert.rejects(asUser(db, attacker, `select ${sql}`, args), denied, `authenticated: ${sql}`);
    }
    // service_role: внутренние — нет (сервер не списывает мимо операции), серверные — да.
    const svc = await db.client("service_role");
    for (const [sql, args] of INTERNAL) await assert.rejects(svc.query(`select ${sql}`, args), denied, `service_role: ${sql}`);
    const [{ r: svcStatus }] = (await svc.query("select public.api_calculation_operation_status($1, $2, 'x') as r", [victim, randomUUID()])).rows;
    assert.equal(svcStatus.status, "none");
    assert.equal(await dbState(db), before, "ни один отказ ничего не изменил");

    // Пользовательские функции — без параметра пользователя: только auth.uid().
    const params = (await db.main.query(`
      select p.proname, coalesce(p.proargnames, '{}') as names from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('consume_calculation', 'consume_api_calculation', 'save_calculation_operation',
             'save_manual_calculation_operation', 'calculation_operation_status') order by 1`)).rows;
    assert.equal(params.length, 5);
    for (const r of params) assert.ok(!r.names.includes("p_user_id"), r.proname);
    const [{ r: own }] = await asUser(db, attacker, "select public.consume_calculation() as r");
    assert.deepEqual([own.ok, own.used], [true, 1], "списано у вызывающего");
    const [{ r: peek }] = await asUser(db, attacker, "select public.calculation_operation_status($1, $2) as r", [victimOp.operationId, KEYS.manualRequestHash(MANUAL)]);
    assert.equal(peek.status, "none", "чужая операция не видна");
    const [{ r: hijack }] = await asUser(db, attacker, "select public.save_manual_calculation_operation($1, $2, $3::jsonb) as r", [victimOp.operationId, KEYS.manualRequestHash(MANUAL), JSON.stringify(KEYS.computeManualColumns(MANUAL))]);
    assert.equal(hijack.reason, "operation_conflict");
    const [{ r: anonWrapper }] = (await anon.query("select public.consume_calculation() as r")).rows;
    assert.equal(anonWrapper.reason, "not_authenticated");
    assert.deepEqual(await facts(db, victim), { used: 1, calcs: 1, history: 0, ops: 1 }, "данные жертвы не изменились");
    assert.deepEqual((await facts(db, attacker)).used, 1);
  });

  it("ручная операция не создаёт строку api: режим фиксирован, снимок не принимается", async () => {
    const u = await db.user();
    const rows = await asUser(
      db,
      u,
      "select public.save_manual_calculation_operation($1, 'manual:x', $2::jsonb) as r",
      [randomUUID(), JSON.stringify({ marketplace: "ozon", mode: "api", revenue: 1, commission: 0, logistics: 0, ads: 0, storage: 0, tax: 0, cost: 0, other_expenses: 0, total_expenses: 0, profit: 1, margin: 100, ai_insights: { kind: "ozon-api-v1" } })]
    );
    assert.equal(rows[0].r.reason, "bad_request");
    const ok = await asUser(db, u, "select public.save_manual_calculation_operation($1, 'manual:x', $2::jsonb) as r",
      [randomUUID(), JSON.stringify({ marketplace: "ozon", mode: "api", revenue: 1, commission: 0, logistics: 0, ads: 0, storage: 0, tax: 0, cost: 0, other_expenses: 0, total_expenses: 0, profit: 1, margin: 100 })]);
    assert.equal(ok[0].r.ok, true);
    const modes = (await db.main.query("select mode from public.calculations where user_id = $1", [u])).rows.map((r) => r.mode);
    assert.deepEqual(modes, ["manual"], "mode из тела игнорируется");
    const xlsxAsApi = await asUser(db, u, "select public.save_calculation_operation($1, 'api', 'x', '{}'::jsonb, '{}'::jsonb) as r", [randomUUID()]);
    assert.equal(xlsxAsApi[0].r.reason, "bad_request");
  });

  it("подмена режима ключом: ручная операция с отпечатком API → маршрут API отвечает 409 до Ozon", async () => {
    const u = await apiUser(db);
    const operationId = randomUUID();
    const apiHash = KEYS.apiRequestHash("2026-06", EXPENSES);
    await asUser(db, u, "select public.save_manual_calculation_operation($1, $2, $3::jsonb)", [
      operationId,
      apiHash,
      JSON.stringify(KEYS.computeManualColumns(MANUAL)),
    ]);
    state.ozon = ozonOk;
    const r = await postApi(u, { operationId });
    assert.deepEqual([r.status, r.body.code], [409, "operation_conflict"]);
    assert.equal(net.ozonCalls().length, 0);
    const modes = (await db.main.query("select mode from public.calculations where user_id = $1", [u])).rows.map((x) => x.mode);
    assert.deepEqual(modes, ["manual"]);
  });

  it("RLS и маршрут: пользователь не может вставить или изменить строку mode='api'; сервер (service_role) — может; удаление своих — как раньше", async () => {
    const u = await db.user();
    const denied = (e) => e.code === "42501";
    await assert.rejects(asUser(db, u, "insert into public.calculations (user_id, marketplace, mode) values ($1, 'ozon', 'api')", [u]), denied);
    const [own] = await asUser(db, u, "insert into public.calculations (user_id, marketplace, mode) values ($1, 'ozon', 'manual') returning id", [u]);
    await assert.rejects(asUser(db, u, "update public.calculations set mode = 'api' where id = $1", [own.id]), denied);
    const svc = await db.client("service_role");
    const apiRow = (await svc.query("insert into public.calculations (user_id, marketplace, mode, profit) values ($1, 'ozon', 'api', 5) returning id", [u])).rows[0];
    const upd = await asUser(db, u, "update public.calculations set profit = 999 where id = $1 returning id", [apiRow.id]);
    assert.deepEqual(upd, [], "строку api пользователь не меняет");
    const post = await CALCS_ROUTE.POST(new NextRequest("http://localhost/api/cloud/calculations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(u)}` },
      body: JSON.stringify({ marketplace: "ozon", mode: "api", profit: 1 }),
    }));
    assert.deepEqual([post.status, (await post.json()).code], [400, "api_mode_forbidden"]);
    const patchApi = await CALCS_ROUTE.PATCH(new NextRequest("http://localhost/api/cloud/calculations", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(u)}` },
      body: JSON.stringify({ id: apiRow.id, fields: { profit: 1 } }),
    }));
    assert.equal(patchApi.status, 502, "строка api через маршрут не редактируется");
    const toApi = await CALCS_ROUTE.PATCH(new NextRequest("http://localhost/api/cloud/calculations", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(u)}` },
      body: JSON.stringify({ id: own.id, fields: { mode: "api" } }),
    }));
    assert.equal(toApi.status, 400);
    const rows = (await db.main.query("select id, mode, profit from public.calculations where user_id = $1 order by mode", [u])).rows;
    assert.deepEqual(rows.map((r) => [r.mode, Number(r.profit)]), [["api", 5], ["manual", 0]]);
    assert.equal(await deleteFromHistory(u, apiRow.id), null, "удалить свой API-расчёт можно");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("общая бесплатная попытка между режимами", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
  });
  beforeEach(() => {
    state.pool = db.pool(12);
    state.ozon = ozonOk;
  });

  for (let round = 1; round <= 3; round++) {
    it(`последняя бесплатная попытка: ручной + API + XLSX одновременно → ровно один расчёт (прогон ${round})`, async () => {
      const u = await apiUser(db);
      const outs = await Promise.all([postManual(u), postApi(u), postXlsx(u)]);
      const statuses = outs.map((o) => o.status);
      assert.equal(statuses.filter((s) => s === 200).length, 1, JSON.stringify(statuses));
      assert.equal(statuses.filter((s) => s === 402).length, 2, JSON.stringify(statuses));
      const f = await facts(db, u);
      assert.deepEqual([f.used, f.calcs, f.ops], [1, 1, 1]);
    });
  }

  it("один разовый кредит после бесплатной: ручной и XLSX делят кредит, API недоступен", async () => {
    const u = await apiUser(db, { used: 1, credits: 1 });
    const outs = await Promise.all([postManual(u), postXlsx(u), postApi(u)]);
    const [m, x, a] = outs.map((o) => o.status);
    assert.equal(a, 402, "кредит не открывает API");
    assert.deepEqual([m, x].sort(), [200, 402]);
    assert.deepEqual(await facts(db, u).then((f) => [f.used, f.calcs, f.ops]), [2, 1, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("совместимость и миграция", () => {
  it("правила списания не изменились: consume_calculation() и consume_api_calculation() дают те же ответы и счётчики, что до миграции", async () => {
    const cases = [
      { name: "бесплатная доступна" },
      { name: "бесплатная израсходована", used: 1 },
      { name: "два кредита", used: 1, credits: 2 },
      { name: "кредиты израсходованы", used: 3, credits: 2 },
      { name: "безлимит", unlimited: "10 days", used: 5 },
      { name: "безлимит истёк", expired: true, used: 1, credits: 1 },
      { name: "нет профиля", noProfile: true },
      { name: "аноним", anonymous: true },
    ];
    const run = async (db) => {
      const out = [];
      for (const c of cases) {
        for (const fn of ["consume_calculation()", "consume_api_calculation()"]) {
          const u = await db.user(c.unlimited ? { plan: "unlimited", premium: c.unlimited } : {});
          if (c.expired) await db.main.query("update public.profiles set plan = 'unlimited', premium_until = now() - interval '1 day' where id = $1", [u]);
          if (c.used) await db.main.query("update public.profiles set calculations_used = $2 where id = $1", [u, c.used]);
          for (let i = 0; i < (c.credits ?? 0); i++) await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [u]);
          if (c.noProfile) await db.main.query("delete from public.profiles where id = $1", [u]);
          const [{ r }] = await asUser(db, c.anonymous ? null : u, `select public.${fn} as r`);
          const [p] = (await db.main.query("select calculations_used from public.profiles where id = $1", [u])).rows;
          out.push([c.name, fn, r, p?.calculations_used ?? null]);
        }
      }
      return out;
    };
    const before = await run(await freshDb({ extraMigrations: [OPS_MIGRATION] }));
    const after = await run(await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] }));
    assert.deepEqual(after, before);
  });

  it("XLSX-операция, созданная до миграции, после неё повторяется с тем же отпечатком данных (content_match) и статусом", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    state.pool = db.pool(4);
    const u = await db.user();
    const body = xlsxBody();
    const first = await postXlsx(u, body);
    assert.equal(first.status, 200);
    await runScript(db.main, MA_MIGRATION);
    const replay = await postXlsx(u, { ...body, calculation: { ...body.calculation, ai_insights: { ...body.calculation.ai_insights, generatedAt: "2026-07-02T00:00:00.000Z" } } });
    assert.deepEqual([replay.status, replay.body.data.replay, replay.body.data.contentMatch], [200, true, true]);
    assert.deepEqual(replay.body.data.snapshot, body.calculation.ai_insights);
    const st = await opStatus(u, body.operationId, body.requestHash);
    assert.deepEqual([st.body.data.status, st.body.data.mode], ["done", "upload"]);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("новый код без этой миграции: ручной и API — 503 migration_missing, API — до Ozon; ничего не списано; XLSX работает", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    state.pool = db.pool(4);
    state.ozon = ozonOk;
    const u = await apiUser(db);
    const m = await postManual(u);
    assert.deepEqual([m.status, m.body.code], [503, "migration_missing"]);
    const a = await postApi(u);
    assert.deepEqual([a.status, a.body.code], [503, "migration_missing"]);
    assert.equal(net.ozonCalls().length, 0, "без миграции к Ozon не обращаемся");
    assert.ok(!net.rpcCalls().some((r) => /consume/.test(r.path)), "раздельного списания нет");
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    const x = await postXlsx(u);
    assert.equal(x.status, 200);
  });

  it("старый код после миграции: consume_calculation() + вставка ручной строки маршрутом, consume_api_calculation() + вставка API service role", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
    const u = await db.user();
    await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [u]);
    const [{ r: api }] = await asUser(db, u, "select public.consume_api_calculation() as r");
    assert.deepEqual([api.ok, api.used], [true, 1]);
    const svc = await db.client("service_role");
    await svc.query("insert into public.calculations (user_id, marketplace, mode) values ($1, 'ozon', 'api')", [u]);
    const [{ r: man }] = await asUser(db, u, "select public.consume_calculation() as r");
    assert.deepEqual([man.ok, man.used], [true, 2]);
    await svc.query("insert into public.calculations (user_id, marketplace, mode) values ($1, 'ozon', 'manual')", [u]);
    assert.equal((await db.main.query("select count(*)::int as n from public.calculations where user_id = $1", [u])).rows[0].n, 2);
  });

  it("миграция идемпотентна и не меняет существующие строки; read-only проверки дают ожидаемое", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    state.pool = db.pool(6);
    state.ozon = ozonOk;
    const u = await apiUser(db, { unlimited: true });
    await postXlsx(u);
    const sections = MA_CHECKS.split(/^(?=-- ─── РАЗДЕЛ )/m).slice(1);
    assert.equal(sections.length, 3);
    const rowsOf = async (sql) => {
      const res = await db.main.query(sql);
      return (Array.isArray(res) ? res : [res]).filter((x) => x.command === "SELECT").map((x) => x.rows);
    };
    const [[beforeRow], beforeModes] = await rowsOf(sections[0]);
    for (const [k, v] of Object.entries(beforeRow)) if (k.endsWith("_ok")) assert.equal(v, true, k);
    assert.equal(beforeRow.already_applied, false);
    assert.deepEqual(beforeModes, [{ mode: "upload", operations: "1" }]);
    const snap = await dbState(db);
    await runScript(db.main, MA_MIGRATION);
    await runScript(db.main, MA_MIGRATION);
    assert.equal(await dbState(db), snap, "существующие строки не изменились");
    const [[afterRow], afterModes] = await rowsOf(sections[1]);
    for (const [k, v] of Object.entries(afterRow)) if (k.endsWith("_ok")) assert.equal(v, true, k);
    assert.deepEqual(afterModes, [{ mode: "upload", operations: "1" }]);
    await postManual(u);
    await postApi(u);
    const [[cons]] = await rowsOf(sections[2]);
    assert.deepEqual([cons.operations_upload, cons.operations_manual, cons.operations_api], ["1", "1", "1"]);
    for (const [k, v] of Object.entries(cons)) if (k.endsWith("_mismatch")) assert.equal(v, "0", k);
  });

  it("итоговая секция schema.sql совпадает с миграцией (функции, права, ограничение журнала, политики RLS)", async () => {
    const FNS = [
      "consume_calculation", "consume_api_calculation", "consume_calculation_for", "consume_api_calculation_for",
      "calculation_operation_saved", "calculation_operation_execute", "calculation_operation_lookup",
      "save_calculation_operation", "save_manual_calculation_operation", "calculation_operation_status",
      "save_api_calculation_operation", "api_calculation_operation_status",
    ];
    const describeDb = async (c) => {
      const f = await c.query(
        `select p.proname, pg_get_functiondef(p.oid) as d, p.proacl::text as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1) order by 1, 2`,
        [FNS]
      );
      const k = await c.query("select conname, pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'public.calculation_operations'::regclass order by 1");
      const pol = await c.query("select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'calculations' order by 1");
      return JSON.stringify([f.rows, k.rows, pol.rows]);
    };
    const migrated = await freshDb({ extraMigrations: [OPS_MIGRATION, MA_MIGRATION] });
    const full = await freshDb({ migrated: false, fullSchema: true });
    assert.ok(SCHEMA.includes("save_manual_calculation_operation"));
    assert.equal(await describeDb(full.main), await describeDb(migrated.main));
  });
});
