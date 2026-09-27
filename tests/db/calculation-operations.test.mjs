// Атомарное списание попытки и сохранение расчёта по XLSX — настоящий обработчик
// app/api/cloud/calculation-operations/route.ts (скомпилирован run.mjs) → настоящий
// supabase-js (user-scoped клиент) → RPC на НАСТОЯЩЕЙ PostgreSQL.
// Запуск: TEST_DATABASE_URL=… npm run test:db.
//
// Сеть подменена (helpers/fetch-stub.mjs): запросы supabase-js к /rest/v1 выполняются
// SQL-ом на временной базе от имени authenticated с auth.uid() из JWT пользователя —
// каждый в своём соединении и своей транзакции, как у PostgREST. Supabase и production
// не участвуют.
//
// База: schema.sql до миграций + миграция продления безлимита (PR #105) + ДОСЛОВНО
// supabase/migrations/20260928_calculation_operations.sql.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { SUPABASE_URL, installFetch, userJwt } from "./helpers/fetch-stub.mjs";
import { SCHEMA, buildRequire, payTestEnv, read, root, runScript } from "./helpers/pay-db.mjs";

const OPS_MIGRATION = read("supabase/migrations/20260928_calculation_operations.sql");
const OPS_CHECKS = read("supabase/checks/calculation_operations.sql");

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-anon-key";

const ROUTE = buildRequire("./api/cloud/calculation-operations/route.js");
const { NextRequest } = createRequire(path.join(root, "package.json"))("next/server");

const net = installFetch();
const { state } = net;
const { freshDb } = payTestEnv();

/** Колонки строки calculations / report_history (как accrualSnapshotTo*Columns). */
const calcCols = (profit = 650) => ({
  marketplace: "ozon",
  mode: "upload",
  revenue: 850,
  commission: 180,
  logistics: 67,
  ads: 60,
  storage: 0,
  tax: 59.5,
  cost: 100,
  other_expenses: 15.55,
  total_expenses: 850 - profit,
  profit,
  margin: 76.47,
  ai_insights: { kind: "ozon-accrual-xlsx-v1", marker: `p${profit}` },
});
const histCols = (profit = 650) => ({ report_month: "2026-06-01", revenue: 850, expenses: 850 - profit, profit, margin: 76.47 });

function body(over = {}) {
  return {
    operationId: randomUUID(),
    requestHash: "2026-06:12:fileA",
    contentHash: "c1",
    calculation: calcCols(),
    history: histCols(),
    ...over,
  };
}

async function post(userId, payload) {
  const req = new NextRequest("http://localhost/api/cloud/calculation-operations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userJwt(userId)}` },
    body: JSON.stringify(payload),
  });
  const res = await ROUTE.POST(req);
  return { status: res.status, body: await res.json() };
}

async function status(userId, operationId, requestHash) {
  const q = new URLSearchParams({ operationId, requestHash });
  const req = new NextRequest(`http://localhost/api/cloud/calculation-operations?${q}`, {
    headers: { authorization: `Bearer ${userJwt(userId)}` },
  });
  const res = await ROUTE.GET(req);
  return { status: res.status, body: await res.json() };
}

/** Что записано у пользователя: счётчик, строки расчётов/сводки, отметки операций. */
async function facts(db, userId) {
  const q = async (sql) => (await db.main.query(sql, [userId])).rows;
  const [p] = await q("select calculations_used from public.profiles where id = $1");
  return {
    used: p?.calculations_used ?? null,
    calcs: (await q("select id, profit, ai_insights from public.calculations where user_id = $1 order by created_at")).length,
    history: (await q("select id from public.report_history where user_id = $1")).length,
    ops: (await q("select id, charged, calculation_id, report_history_id from public.calculation_operations where user_id = $1")).length,
  };
}

const realConsoleError = console.error;
before(() => {
  console.error = () => {}; // маршрут пишет в лог ожидаемые сбои
});
after(() => {
  console.error = realConsoleError;
  net.restore();
});
beforeEach(() => net.reset());

// ─────────────────────────────────────────────────────────────────────────────
describe("операция расчёта через настоящий маршрут: списание и записи — одна транзакция", () => {
  let db;
  before(async () => {
    db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
  });
  beforeEach(() => {
    state.pool = db.pool(12);
  });

  it("успех: одна строка calculations, одна report_history, отметка операции, списание 1 — всё у этого пользователя", async () => {
    const u = await db.user();
    const b = body();
    const out = await post(u, b);
    assert.equal(out.status, 200);
    assert.deepEqual(
      { replay: out.body.data.replay, charged: out.body.data.charged, contentHash: out.body.data.contentHash, used: out.body.data.used },
      { replay: false, charged: true, contentHash: "c1", used: 1 }
    );
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
    const row = (await db.main.query("select user_id, mode, profit, ai_insights from public.calculations where id = $1", [out.body.data.calculationId])).rows[0];
    assert.equal(row.user_id, u);
    assert.equal(row.mode, "upload");
    assert.equal(Number(row.profit), 650);
    assert.deepEqual(row.ai_insights, b.calculation.ai_insights);
    const rpc = net.rpcCalls();
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0].path, "/rest/v1/rpc/save_calculation_operation");
    assert.equal(rpc[0].headers.authorization, `Bearer ${userJwt(u)}`, "пользователь из JWT, а не из тела");
  });

  it("сбой записи результата (report_history): откат — ни списания, ни частичных строк; повтор того же ключа проходит один раз", async () => {
    const u = await db.user();
    await db.main.query(`
      create or replace function public.test_fail_history() returns trigger language plpgsql as $$
      begin raise exception 'test: report_history недоступна'; end $$;
      create trigger test_fail_history before insert on public.report_history
        for each row execute function public.test_fail_history();`);
    const b = body();
    try {
      const failed = await post(u, b);
      assert.equal(failed.status, 502);
      assert.equal(failed.body.code, "rpc_failed");
      assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
    } finally {
      await db.main.query("drop trigger test_fail_history on public.report_history; drop function public.test_fail_history();");
    }
    const ok = await post(u, b);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.replay, false);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("успешный COMMIT с потерянным ответом: повтор возвращает тот же расчёт без нового списания и строк", async () => {
    const u = await db.user();
    const b = body();
    state.dropAfterCommit = (r) => r.path.startsWith("/rest/v1/rpc/");
    const lost = await post(u, b);
    assert.equal(lost.status, 502, "маршрут не подтверждает успех без ответа БД");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 }, "в БД всё зафиксировано");
    state.dropAfterCommit = null;
    const retry = await post(u, b);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.replay, true);
    assert.equal(retry.body.data.contentHash, "c1");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
    const st = await status(u, b.operationId, b.requestHash);
    assert.deepEqual([st.body.data.status, st.body.data.calculationId], ["done", retry.body.data.calculationId]);
  });

  it("двойной клик / две вкладки: 6 одновременных запросов одной операции → одно списание, одна строка; остальные — повтор", async () => {
    const u = await db.user();
    const b = body();
    const outs = await Promise.all(Array.from({ length: 6 }, () => post(u, b)));
    assert.ok(outs.every((o) => o.status === 200));
    assert.equal(outs.filter((o) => o.body.data.replay === false).length, 1);
    assert.equal(new Set(outs.map((o) => o.body.data.calculationId)).size, 1);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("две разные операции одновременно при одной оставшейся попытке: одна сохранена, вторая 402 — без записей", async () => {
    const u = await db.user();
    const [x, y] = await Promise.all([
      post(u, body({ requestHash: "2026-06:12:fileA" })),
      post(u, body({ requestHash: "2026-05:9:fileB" })),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 402]);
    const refused = [x, y].find((o) => o.status === 402);
    assert.equal(refused.body.code, "limit_reached");
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("повтор ключа с другим файлом → 409; с тем же файлом, но другими данными → возвращается сохранённое, данные не подменяются", async () => {
    const u = await db.user({ plan: "unlimited", premium: "10 days" });
    const b = body();
    const first = await post(u, b);
    assert.equal(first.status, 200);
    const other = await post(u, { ...b, requestHash: "2026-05:9:fileB" });
    assert.deepEqual([other.status, other.body.code], [409, "operation_conflict"]);
    const tampered = await post(u, { ...b, contentHash: "c2", calculation: calcCols(9999), history: histCols(9999) });
    assert.equal(tampered.status, 200);
    assert.deepEqual([tampered.body.data.replay, tampered.body.data.contentHash], [true, "c1"]);
    const rows = (await db.main.query("select profit from public.calculations where user_id = $1", [u])).rows;
    assert.deepEqual(rows.map((r) => Number(r.profit)), [650], "строка не подменена");
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 1, history: 1, ops: 1 });
  });

  it("изоляция пользователей: чужой ключ → 409 без данных; статус чужой операции — none; свои счётчики не тронуты", async () => {
    const a = await db.user();
    const bUser = await db.user();
    const b = body();
    const mine = await post(a, b);
    assert.equal(mine.status, 200);
    const stolen = await post(bUser, b);
    assert.deepEqual([stolen.status, stolen.body.data], [409, undefined]);
    const peek = await status(bUser, b.operationId, b.requestHash);
    assert.deepEqual([peek.status, peek.body.data.status, peek.body.data.calculationId], [200, "none", null]);
    assert.deepEqual(await facts(db, bUser), { used: 0, calcs: 0, history: 0, ops: 0 });
    const own = await status(a, b.operationId, b.requestHash);
    assert.deepEqual([own.body.data.status, own.body.data.calculationId], ["done", mine.body.data.calculationId]);
    const wrongFile = await status(a, b.operationId, "другой файл");
    assert.equal(wrongFile.body.data.status, "conflict");
  });

  it("действующие правила: безлимит — без расхода; разовый кредит — расходуется; попыток нет — 402 и ничего не записано", async () => {
    const unl = await db.user({ plan: "unlimited", premium: "5 days" });
    await db.main.query("update public.profiles set calculations_used = 4 where id = $1", [unl]);
    const r1 = await post(unl, body());
    assert.deepEqual([r1.status, r1.body.data.charged, r1.body.data.unlimited], [200, false, true]);
    assert.deepEqual(await facts(db, unl), { used: 4, calcs: 1, history: 1, ops: 1 });

    const cred = await db.user();
    await db.main.query("update public.profiles set calculations_used = 1 where id = $1", [cred]);
    await db.main.query("insert into public.subscriptions (user_id, plan, status) values ($1, 'single', 'active')", [cred]);
    const r2 = await post(cred, body());
    assert.deepEqual([r2.status, r2.body.data.charged, r2.body.data.used], [200, true, 2]);
    const r3 = await post(cred, body({ requestHash: "2026-05:9:fileB" }));
    assert.deepEqual([r3.status, r3.body.code], [402, "limit_reached"]);
    assert.deepEqual(await facts(db, cred), { used: 2, calcs: 1, history: 1, ops: 1 });
  });

  it("некорректный запрос → 400 без обращения к БД", async () => {
    const u = await db.user();
    for (const bad of [body({ operationId: "не-uuid" }), body({ history: null }), body({ requestHash: "" }), body({ calculation: [1] })]) {
      const r = await post(u, bad);
      assert.equal(r.status, 400);
    }
    assert.equal(net.rpcCalls().length, 0);
    assert.deepEqual(await facts(db, u), { used: 0, calcs: 0, history: 0, ops: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("доступ, миграция и совместимость", () => {
  it("браузерные роли не читают и не меняют журнал операций; anon не вызывает функции", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    state.pool = db.pool(4);
    const u = await db.user();
    const ok = await post(u, body());
    assert.equal(ok.status, 200);
    const c = await db.client("authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [u]);
    const denied = (e) => e.code === "42501";
    await assert.rejects(c.query("select * from public.calculation_operations"), denied);
    await assert.rejects(c.query("insert into public.calculation_operations (id, user_id, mode, request_hash, content_hash, charged) values ($1, $2, 'upload', 'x', 'y', true)", [randomUUID(), u]), denied);
    await assert.rejects(c.query("update public.calculation_operations set charged = false"), denied);
    await assert.rejects(c.query("delete from public.calculation_operations"), denied);
    const anon = await db.client("anon");
    await assert.rejects(anon.query("select public.save_calculation_operation($1, 'upload', 'x', 'y', '{}'::jsonb, '{}'::jsonb)", [randomUUID()]), denied);
    await assert.rejects(anon.query("select public.calculation_operation_status($1, 'x')", [randomUUID()]), denied);
    assert.deepEqual(await facts(db, u), { used: 1, calcs: 1, history: 1, ops: 1 });
  });

  it("код раньше миграции: 503 migration_missing, ничего не списано; раздельного списания нет", async () => {
    const db = await freshDb(); // только PR #105
    state.pool = db.pool(4);
    const u = await db.user();
    const out = await post(u, body());
    assert.deepEqual([out.status, out.body.code], [503, "migration_missing"]);
    assert.deepEqual(net.dbRequests().map((r) => r.path), ["/rest/v1/rpc/save_calculation_operation"]);
    const used = (await db.main.query("select calculations_used from public.profiles where id = $1", [u])).rows[0].calculations_used;
    const calcs = (await db.main.query("select count(*)::int as n from public.calculations where user_id = $1", [u])).rows[0].n;
    const hist = (await db.main.query("select count(*)::int as n from public.report_history where user_id = $1", [u])).rows[0].n;
    assert.deepEqual([used, calcs, hist], [0, 0, 0]);
  });

  it("старый путь после миграции работает как раньше: consume_calculation списывает, запись calculations — отдельно", async () => {
    const db = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    const u = await db.user();
    const c = await db.client();
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [u]);
    const r = (await c.query("select public.consume_calculation() as r")).rows[0].r;
    await c.query("commit");
    assert.deepEqual([r.ok, r.used, r.allowance], [true, 1, 1]);
  });

  it("миграция не меняет существующие строки и повторяется без ошибок; read-only проверки дают ожидаемое", async () => {
    const db = await freshDb();
    const u = await db.user({ plan: "unlimited", premium: "3 days" });
    await db.main.query("insert into public.calculations (user_id, marketplace, mode) values ($1, 'ozon', 'upload')", [u]);
    const snap = await db.snapshot();
    const sections = OPS_CHECKS.split(/^(?=-- ─── РАЗДЕЛ )/m).slice(1);
    assert.equal(sections.length, 3);
    const rowsOf = async (sql) => {
      const res = await db.main.query(sql);
      return (Array.isArray(res) ? res : [res]).filter((x) => x.command === "SELECT").map((x) => x.rows);
    };
    const [[before]] = await rowsOf(sections[0]);
    assert.deepEqual([before.tables_ok, before.consume_ok, before.roles_ok, before.already_table, before.already_functions], [true, true, true, false, false]);
    await runScript(db.main, OPS_MIGRATION);
    await runScript(db.main, OPS_MIGRATION);
    assert.equal(await db.snapshot(), snap);
    const [[afterRow]] = await rowsOf(sections[1]);
    for (const [k, v] of Object.entries(afterRow)) if (k.endsWith("_ok")) assert.equal(v, true, k);
    state.pool = db.pool(4);
    await post(u, body());
    const [[cons]] = await rowsOf(sections[2]);
    assert.equal(cons.operations, "1");
    for (const [k, v] of Object.entries(cons)) if (k.endsWith("_mismatch")) assert.equal(v, "0", k);
  });

  it("итоговая секция schema.sql совпадает с миграцией (таблица, функции, права)", async () => {
    const describeDb = async (c) => {
      const f = await c.query(`select p.proname, pg_get_functiondef(p.oid) as d, p.proacl::text as acl
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('save_calculation_operation', 'calculation_operation_status') order by 1`);
      const t = await c.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='calculation_operations' order by ordinal_position");
      const a = await c.query("select relacl::text as acl, relrowsecurity from pg_class where oid = 'public.calculation_operations'::regclass");
      const k = await c.query("select conname, pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'public.calculation_operations'::regclass order by 1");
      return JSON.stringify([f.rows, t.rows, a.rows, k.rows]);
    };
    const migrated = await freshDb({ extraMigrations: [OPS_MIGRATION] });
    const full = await freshDb({ migrated: false, fullSchema: true });
    assert.ok(SCHEMA.includes("save_calculation_operation"));
    assert.equal(await describeDb(full.main), await describeDb(migrated.main));
  });
});
