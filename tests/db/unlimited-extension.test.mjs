// Продление безлимита и однократная выдача доступа по платежу — на НАСТОЯЩЕЙ PostgreSQL
// с НЕЗАВИСИМЫМИ соединениями. Запуск: TEST_DATABASE_URL=… npm run test:db.
//
// Каждая группа тестов получает отдельную временную базу: supabase/schema.sql в состоянии
// ДО миграции (как в production сейчас) + роли и права по умолчанию как в Supabase
// (anon / authenticated / service_role). Затем ДОСЛОВНО миграция
// supabase/migrations/20260927_unlimited_payment_extension.sql и read-only проверки
// supabase/checks/unlimited_payment_extension.sql.
//
// Роли anon / authenticated / service_role создаются в тестовом кластере, если их нет
// (роли в PostgreSQL общие для кластера) — только для локальной тестовой БД.
//
// Что проверяется:
//   • SQL-функция public.grant_unlimited_payment() напрямую, от имени service_role;
//   • обработка проверенного платежа webhook (app/api/payment/_lib/webhook-core.ts) поверх
//     отдельных pg-соединений (supabase-js не участвует; ответ ЮKassa — готовый объект,
//     сети нет). Проверка платежа запросом к ЮKassa остаётся в route.ts и здесь не
//     вызывается;
//   • конкуренция: одновременные вызовы из разных соединений и принудительный порядок
//     «одна транзакция держит блокировку, другая ждёт».

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MIGRATION = read("supabase/migrations/20260927_unlimited_payment_extension.sql");
const CHECKS = read("supabase/checks/unlimited_payment_extension.sql");
const SCHEMA = read("supabase/schema.sql");
const req = createRequire(path.join(process.env.DB_TEST_BUILD_DIR, "loader.js"));
const WH = req("./api/payment/_lib/webhook-core.js");

pg.types.setTypeParser(1184, (v) => v); // timestamptz → строка как есть (точность до микросекунд)

const SECTION_MARK = "-- Продление безлимита (449 ₽) с сохранением оплаченного срока.";
// schema.sql в состоянии ДО миграции: всё до итоговой секции продления.
const SCHEMA_BEFORE = (() => {
  const i = SCHEMA.indexOf(SECTION_MARK);
  assert.ok(i > 0, "секция продления в schema.sql не найдена");
  return SCHEMA.slice(0, SCHEMA.lastIndexOf("-- ====", i));
})();

const CHECK_SECTIONS = (() => {
  const parts = CHECKS.split(/^(?=-- ─── РАЗДЕЛ )/m).slice(1); // строка-заголовок раздела остаётся комментарием
  assert.equal(parts.length, 3, "в файле проверок три раздела");
  return { before: parts[0], after: parts[1], deploy: parts[2] };
})();

// Роли и права по умолчанию как в Supabase + заглушка схемы auth.
const SUPABASE_LIKE = `
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

const PREFIX = `mprof_paytest_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
let server;
let adminUrl;
let dbCount = 0;
const databases = [];
const opened = [];

async function client(url, role) {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {}); // обрыв соединения проверяется тестом явно
  await c.connect();
  opened.push(c);
  if (role) await c.query(`set role ${role}`);
  return c;
}

/** Новая временная база: схема ДО миграции (+ миграция, если migrated). */
async function freshDb({ migrated = true, fullSchema = false } = {}) {
  const name = `${PREFIX}_${++dbCount}`;
  await server.query(`create database ${name} encoding 'UTF8' template template0`);
  databases.push(name);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const main = await client(url);
  await main.query(SUPABASE_LIKE);
  await main.query(fullSchema ? SCHEMA : SCHEMA_BEFORE);
  if (migrated) await main.query(MIGRATION);
  const db = {
    url,
    main,
    /** Независимое соединение от имени service_role (как серверный webhook через PostgREST). */
    service: () => client(url, "service_role"),
    async serviceMany(n) {
      const cs = await Promise.all(Array.from({ length: n }, () => client(url, "service_role")));
      const pids = await Promise.all(cs.map(async (c) => (await c.query("select pg_backend_pid() as p")).rows[0].p));
      assert.equal(new Set(pids).size, n, "соединения независимы (разные серверные процессы)");
      return cs;
    },
    async user({ premium = null, plan } = {}) {
      const id = randomUUID();
      await main.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id.slice(0, 8)}@example.test`]);
      // Профиль создаёт триггер handle_new_user() из schema.sql.
      if (premium !== null || plan) {
        await main.query(
          `update public.profiles set premium_until = ${premium === null ? "null" : `now() + interval '${premium}'`},
                  plan = coalesce($2, plan) where id = $1`,
          [id, plan ?? null]
        );
      }
      return id;
    },
    /** Pending-подписка, как её создаёт /api/payment/create. */
    async sub(userId, plan = "unlimited", { status = "pending", paymentId = `pay-${randomUUID()}`, createdAgo } = {}) {
      const r = await main.query(
        `insert into public.subscriptions (user_id, plan, status, provider, provider_payment_id, created_at)
         values ($1, $2, $3, 'yookassa', $4, ${createdAgo ? `now() - interval '${createdAgo}'` : "now()"})
         returning id`,
        [userId, plan, status, paymentId]
      );
      return { id: r.rows[0].id, paymentId };
    },
    async profile(userId) {
      return (await main.query("select plan, premium_until from public.profiles where id = $1", [userId])).rows[0];
    },
    async subRow(id) {
      return (await main.query("select status, starts_at, expires_at, provider_payment_id from public.subscriptions where id = $1", [id])).rows[0];
    },
    async activations(userId) {
      return (
        await main.query(
          "select payment_id, subscription_id, activated_at, premium_until_before, premium_until_after from public.payment_activations where ($1::uuid is null or user_id = $1) order by premium_until_after",
          [userId ?? null]
        )
      ).rows;
    },
    /** Истинно ли SQL-выражение (сравнения времени — в БД, с точностью до микросекунд). */
    async holds(sql, params) {
      return (await main.query(`select (${sql}) as ok`, params)).rows[0].ok === true;
    },
    async snapshot() {
      const s = await main.query("select * from public.subscriptions order by id");
      const p = await main.query("select * from public.profiles order by id");
      return JSON.stringify([s.rows, p.rows]);
    },
  };
  return db;
}

async function grant(c, subId, paymentId) {
  const r = await c.query("select public.grant_unlimited_payment($1, $2) as r", [subId, paymentId]);
  return r.rows[0].r;
}

/** Ждём, пока серверный процесс pid встанет в ожидание блокировки. */
async function waitForLock(db, pid) {
  for (let i = 0; i < 100; i++) {
    const r = await db.main.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail(`процесс ${pid} так и не встал в ожидание блокировки`);
}
const pidOf = async (c) => (await c.query("select pg_backend_pid() as p")).rows[0].p;

/** Подмножество supabase-js, которое использует webhook-core, поверх одного pg-соединения. */
function adminOver(c) {
  const ident = (s) => {
    assert.match(s, /^[a-z_]+$/, `идентификатор ${s}`);
    return s;
  };
  const err = (e) => ({ code: e.code, message: e.message });
  return {
    from(table) {
      assert.equal(table, "subscriptions");
      const q = { op: "select", cols: "*", filters: [], values: null };
      const run = async () => {
        const params = [];
        const where = q.filters.map(([col, v]) => {
          params.push(v);
          return `${ident(col)} = $${params.length}`;
        });
        if (q.op === "select") {
          const cols = q.cols.split(",").map((x) => ident(x.trim())).join(", ");
          const r = await c.query(`select ${cols} from public.subscriptions where ${where.join(" and ")}`, params);
          return r.rows;
        }
        const sets = Object.entries(q.values).map(([k, v]) => {
          params.push(v);
          return `${ident(k)} = $${params.length}`;
        });
        await c.query(`update public.subscriptions set ${sets.join(", ")} where ${where.join(" and ")}`, params);
        return null;
      };
      const b = {
        select(cols) {
          q.cols = cols;
          return b;
        },
        update(values) {
          q.op = "update";
          q.values = values;
          return b;
        },
        eq(col, v) {
          q.filters.push([col, v]);
          return b;
        },
        async maybeSingle() {
          try {
            const rows = await run();
            if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
            return { data: rows[0] ?? null, error: null };
          } catch (e) {
            return { data: null, error: err(e) };
          }
        },
        then(resolve, reject) {
          return run()
            .then((data) => ({ data, error: null }), (e) => ({ data: null, error: err(e) }))
            .then(resolve, reject);
        },
      };
      return b;
    },
    async rpc(name, args) {
      const keys = Object.keys(args);
      try {
        const r = await c.query(
          `select public.${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => args[k])
        );
        return { data: r.rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: err(e) };
      }
    },
  };
}

/** Ответ ЮKassa на GET /v3/payments/{id} (как его нормализует getYooKassaPayment). */
function yk(sub, plan, over = {}) {
  return {
    id: sub.paymentId,
    status: "succeeded",
    paid: true,
    amount: { value: plan === "unlimited" ? "449.00" : "149.00", currency: "RUB" },
    metadata: { subscription_id: sub.id, plan },
    ...over,
  };
}

let consoleErrors = [];
const realConsoleError = console.error;

before(async () => {
  adminUrl = process.env.TEST_DATABASE_URL;
  server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  console.error = (...a) => consoleErrors.push(a);
});

// Соединения, открытые внутри теста, закрываем после него (у сервера ограничено число
// подключений); соединения групп из before() живут до конца файла.
let openedMark = 0;
beforeEach(() => {
  openedMark = opened.length;
});
afterEach(async () => {
  const mine = opened.splice(openedMark);
  await Promise.all(mine.map((c) => c.end().catch(() => {})));
});

after(async () => {
  console.error = realConsoleError;
  await Promise.all(opened.map((c) => c.end().catch(() => {})));
  if (server) {
    for (const d of databases) await server.query(`drop database if exists ${d} with (force)`).catch(() => {});
    await server.end().catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe("правило срока: max(текущее окончание, момент активации) + 30 дней", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  it("первая покупка (premium_until NULL): 30 дней от активации по времени БД", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const svc = await db.service();
    const r = await grant(svc, s.id, s.paymentId);
    assert.equal(r.ok, true);
    assert.equal(r.granted, true);
    assert.equal(r.premium_until_before, null);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [r.premium_until, r.activated_at]));
    assert.ok(await db.holds("abs(extract(epoch from now() - $1::timestamptz)) < 10", [r.activated_at]), "активация — текущее время БД");
    const p = await db.profile(u);
    assert.equal(p.plan, "unlimited");
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [p.premium_until, r.premium_until]));
    const sr = await db.subRow(s.id);
    assert.equal(sr.status, "active");
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz and $3::timestamptz = $4::timestamptz", [sr.starts_at, r.activated_at, sr.expires_at, r.premium_until]));
    assert.equal((await db.activations(u)).length, 1);
  });

  it("продление активного срока: осталось 10 дней → стало 40", async () => {
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const before = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const r = await grant(await db.service(), s.id, s.paymentId);
    assert.equal(r.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [r.premium_until_before, before]));
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, before]));
    assert.ok(await db.holds("$1::timestamptz - now() between interval '39 days 23 hours' and interval '40 days'", [(await db.profile(u)).premium_until]));
  });

  it("покупка после окончания: 30 новых дней от активации, старый срок не суммируется", async () => {
    const u = await db.user({ premium: "-3 days", plan: "unlimited" });
    const s = await db.sub(u);
    const r = await grant(await db.service(), s.id, s.paymentId);
    assert.equal(r.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, r.activated_at]));
  });

  it("NULL premium_until у бесплатного профиля: 30 дней от активации, тариф → unlimited", async () => {
    const u = await db.user();
    assert.deepEqual(await db.profile(u), { plan: "free", premium_until: null });
    const s = await db.sub(u);
    const r = await grant(await db.service(), s.id, s.paymentId);
    const p = await db.profile(u);
    assert.equal(p.plan, "unlimited");
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [p.premium_until, r.activated_at]));
  });

  it("профиля нет (аномалия): создаётся и получает 30 дней", async () => {
    const u = await db.user();
    await db.main.query("delete from public.profiles where id = $1", [u]);
    const s = await db.sub(u);
    const r = await grant(await db.service(), s.id, s.paymentId);
    assert.equal(r.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, r.activated_at]));
  });

  it("задержанная первая обработка: срок от момента активации, повтор дату не сдвигает", async () => {
    // Оплата 20 дней назад, прошлый безлимит истёк 5 дней назад, webhook дошёл только сейчас.
    const u = await db.user({ premium: "-5 days", plan: "unlimited" });
    const s = await db.sub(u, "unlimited", { createdAgo: "20 days" });
    const svc = await db.service();
    const r = await grant(svc, s.id, s.paymentId);
    assert.ok(await db.holds("abs(extract(epoch from now() - $1::timestamptz)) < 10", [r.activated_at]));
    assert.ok(await db.holds("$1::timestamptz - now() > interval '29 days 23 hours'", [(await db.profile(u)).premium_until]), "полные 30 дней от активации");
    const first = await db.activations(u);
    const firstSub = await db.subRow(s.id);
    await new Promise((res) => setTimeout(res, 20));
    const again = await grant(svc, s.id, s.paymentId);
    assert.equal(again.granted, false);
    assert.equal(again.reason, "already_processed");
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [again.activated_at, r.activated_at]));
    assert.deepEqual(await db.activations(u), first);
    assert.deepEqual(await db.subRow(s.id), firstSub);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [(await db.profile(u)).premium_until, r.premium_until]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("однократность и конкуренция (независимые соединения)", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  it("повтор одного платежа последовательно — дни не добавляются", async () => {
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const s = await db.sub(u);
    const svc = await db.service();
    const r1 = await grant(svc, s.id, s.paymentId);
    const snap = await db.snapshot();
    const r2 = await grant(svc, s.id, s.paymentId);
    const r3 = await grant(await db.service(), s.id, s.paymentId);
    assert.equal(r1.granted, true);
    assert.equal(r2.granted, false);
    assert.equal(r3.granted, false);
    assert.equal(await db.snapshot(), snap);
    assert.equal((await db.activations(u)).length, 1);
  });

  it("повтор одного платежа одновременно из 8 соединений — ровно одна выдача", async () => {
    const u = await db.user({ premium: "5 days", plan: "unlimited" });
    const before = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const cs = await db.serviceMany(8);
    const rs = await Promise.all(cs.map((c) => grant(c, s.id, s.paymentId)));
    assert.equal(rs.filter((r) => r.granted === true).length, 1);
    assert.ok(rs.every((r) => r.ok === true));
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, before]));
    assert.equal((await db.activations(u)).length, 1);
  });

  it("повтор одного платежа, пока первая транзакция не завершена: второй ждёт и ничего не начисляет", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const [a, b] = await db.serviceMany(2);
    const pidB = await pidOf(b); // до блокирующего запроса: занятое соединение ставит запросы в очередь
    await a.query("begin");
    const ra = await grant(a, s.id, s.paymentId);
    const pb = grant(b, s.id, s.paymentId);
    await waitForLock(db, pidB);
    await a.query("commit");
    const rb = await pb;
    assert.equal(ra.granted, true);
    assert.equal(rb.granted, false);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, ra.activated_at]));
  });

  for (const base of [
    { title: "активный срок", premium: "7 days" },
    { title: "без срока", premium: null },
  ]) {
    it(`две разные оплаты одного пользователя одновременно (${base.title}) → +60 дней, ни один день не потерян`, async () => {
      for (let round = 0; round < 5; round++) {
        const u = await db.user({ premium: base.premium, plan: base.premium ? "unlimited" : undefined });
        const start = (await db.profile(u)).premium_until;
        const s1 = await db.sub(u);
        const s2 = await db.sub(u);
        const [a, b] = await db.serviceMany(2);
        const [r1, r2] = await Promise.all([grant(a, s1.id, s1.paymentId), grant(b, s2.id, s2.paymentId)]);
        assert.equal(r1.granted && r2.granted, true);
        const acts = await db.activations(u);
        assert.equal(acts.length, 2);
        const [first, second] = acts; // по возрастанию premium_until_after
        assert.ok(await db.holds("$1::timestamptz is not distinct from $2::timestamptz", [first.premium_until_before, start]));
        assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [second.premium_until_before, first.premium_until_after]), "второй платёж видит срок первого");
        assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [second.premium_until_after, first.premium_until_after]));
        const expectedBase = start ?? first.activated_at;
        assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '60 days'", [(await db.profile(u)).premium_until, expectedBase]));
      }
    });
  }

  it("две оплаты в разном порядке (принудительная очерёдность) дают одинаковый итог +60 дней", async () => {
    const results = [];
    for (const order of ["p1-first", "p2-first"]) {
      const u = await db.user({ premium: "3 days", plan: "unlimited" });
      const start = (await db.profile(u)).premium_until;
      const s1 = await db.sub(u);
      const s2 = await db.sub(u);
      const [x, y] = order === "p1-first" ? [s1, s2] : [s2, s1];
      const [a, b] = await db.serviceMany(2);
      const pidB = await pidOf(b);
      await a.query("begin");
      await grant(a, x.id, x.paymentId);
      const pb = grant(b, y.id, y.paymentId);
      await waitForLock(db, pidB); // второй ждёт блокировку профиля
      await a.query("commit");
      await pb;
      assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '60 days'", [(await db.profile(u)).premium_until, start]));
      results.push((await db.activations(u)).length);
    }
    assert.deepEqual(results, [2, 2]);
  });

  it("платежи разных пользователей не ждут друг друга и не смешиваются", async () => {
    const u1 = await db.user({ premium: "10 days", plan: "unlimited" });
    const u2 = await db.user();
    const b1 = (await db.profile(u1)).premium_until;
    const s1 = await db.sub(u1);
    const s2 = await db.sub(u2);
    const [a, b] = await db.serviceMany(2);
    await a.query("begin");
    await grant(a, s1.id, s1.paymentId);
    const r2 = await grant(b, s2.id, s2.paymentId); // завершается, пока транзакция a открыта
    await a.query("commit");
    assert.equal(r2.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u1)).premium_until, b1]));
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u2)).premium_until, r2.activated_at]));
    assert.equal((await db.activations(u1)).length, 1);
    assert.equal((await db.activations(u2)).length, 1);
  });

  it("платёж, чужой для подписки (payment_id не совпадает), доступ не выдаёт", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const snap = await db.snapshot();
    const r = await grant(await db.service(), s.id, "pay-other");
    assert.deepEqual(r, { ok: false, reason: "payment_mismatch" });
    assert.equal(await db.snapshot(), snap);
  });

  it("подписка без сохранённого payment_id (сбой /payment/create) привязывается один раз", async () => {
    const u = await db.user();
    const s = await db.sub(u, "unlimited", { paymentId: null });
    const svc = await db.service();
    const r = await grant(svc, s.id, "pay-late-bound");
    assert.equal(r.granted, true);
    assert.equal((await db.subRow(s.id)).provider_payment_id, "pay-late-bound");
    assert.equal((await grant(svc, s.id, "pay-late-bound")).granted, false);
    assert.equal((await grant(svc, s.id, "pay-another")).reason, "payment_mismatch");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("сбои и повторы", () => {
  let db;
  before(async () => {
    db = await freshDb();
    // Тестовые «поломки» — только в этой временной базе.
    await db.main.query(`
      create function public.test_fail_if() returns trigger language plpgsql as $$
      begin
        if current_setting('mprof_test.' || tg_argv[0], true) = 'on' then
          raise exception 'test failure: %', tg_argv[0];
        end if;
        return new;
      end $$;
      create trigger test_fail_sub before update on public.subscriptions
        for each row execute function public.test_fail_if('fail_sub');
      create trigger test_fail_profile before update on public.profiles
        for each row execute function public.test_fail_if('fail_profile');
    `);
  });

  for (const point of ["fail_profile", "fail_sub"]) {
    it(`ошибка транзакции (${point === "fail_sub" ? "после отметки и срока, на статусе подписки" : "на обновлении срока"}) откатывает всё; повтор начисляет ровно один раз`, async () => {
      const u = await db.user({ premium: "10 days", plan: "unlimited" });
      const start = (await db.profile(u)).premium_until;
      const s = await db.sub(u);
      const svc = await db.service();
      const snap = await db.snapshot();
      await svc.query(`set mprof_test.${point} = 'on'`);
      await assert.rejects(grant(svc, s.id, s.paymentId), /test failure/);
      assert.equal(await db.snapshot(), snap, "ни срока, ни статуса");
      assert.equal((await db.activations(u)).length, 0, "ни отметки");
      await svc.query(`reset mprof_test.${point}`);
      const r = await grant(svc, s.id, s.paymentId);
      assert.equal(r.granted, true);
      assert.equal((await grant(svc, s.id, s.paymentId)).granted, false);
      assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]));
    });
  }

  it("соединение оборвалось до COMMIT: ничего не записано, повтор выдаёт один раз", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const a = await db.service();
    const pidA = await pidOf(a);
    await a.query("begin");
    await grant(a, s.id, s.paymentId);
    await db.main.query("select pg_terminate_backend($1)", [pidA]);
    await a.query("select 1").catch(() => {});
    assert.equal((await db.activations(u)).length, 0);
    assert.equal((await db.profile(u)).premium_until, null);
    const r = await grant(await db.service(), s.id, s.paymentId);
    assert.equal(r.granted, true);
    assert.equal((await db.activations(u)).length, 1);
  });

  it("потерянный ответ после успешного COMMIT: повтор webhook ничего не начисляет", async () => {
    const u = await db.user({ premium: "2 days", plan: "unlimited" });
    const s = await db.sub(u);
    const first = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited")); // ответ «потерян»
    assert.equal(first.body.granted, true);
    const snap = await db.snapshot();
    const retry = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited"));
    assert.equal(retry.http, 200);
    assert.equal(retry.body.ok, true);
    assert.equal(retry.body.granted, false);
    assert.equal(retry.body.expiresAt, first.body.expiresAt);
    assert.equal(await db.snapshot(), snap);
  });

  it("платёж, обработанный старым кодом (подписка уже active/expired), повторно дни не выдаёт", async () => {
    for (const status of ["active", "expired"]) {
      const u = await db.user({ premium: "12 days", plan: "unlimited" });
      const s = await db.sub(u, "unlimited", { status });
      await db.main.query("update public.subscriptions set starts_at = now() - interval '18 days', expires_at = now() + interval '12 days' where id = $1", [s.id]);
      const snap = await db.snapshot();
      const r = await grant(await db.service(), s.id, s.paymentId);
      assert.equal(r.ok, true);
      assert.equal(r.granted, false);
      assert.equal(r.reason, "already_processed_legacy");
      const w = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited"));
      assert.equal(w.body.granted, false);
      assert.equal(await db.snapshot(), snap);
      assert.equal((await db.activations(u)).length, 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("webhook: сверки платежа и разовый кредит", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  it("безлимит через webhook: 200, +30 дней, одновременная повторная доставка — одна выдача", async () => {
    const u = await db.user({ premium: "4 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const outs = await Promise.all(
      (await db.serviceMany(4)).map((c) => WH.handleVerifiedPayment(adminOver(c), yk(s, "unlimited")))
    );
    assert.ok(outs.every((o) => o.http === 200 && o.body.ok === true));
    assert.equal(outs.filter((o) => o.body.granted === true).length, 1);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]));
  });

  it("две разные оплаты через webhook одновременно → +60 дней", async () => {
    const u = await db.user({ premium: "1 day", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s1 = await db.sub(u);
    const s2 = await db.sub(u);
    const [a, b] = await db.serviceMany(2);
    await Promise.all([
      WH.handleVerifiedPayment(adminOver(a), yk(s1, "unlimited")),
      WH.handleVerifiedPayment(adminOver(b), yk(s2, "unlimited")),
    ]);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '60 days'", [(await db.profile(u)).premium_until, start]));
  });

  const refusals = [
    ["не оплачен (pending)", { status: "pending", paid: false }, 200, { ignored: true }],
    ["waiting_for_capture", { status: "waiting_for_capture", paid: false }, 200, { ignored: true }],
    ["succeeded, но paid=false", { paid: false }, 200, { ignored: true }],
    ["сумма не совпадает", { amount: { value: "448.00", currency: "RUB" } }, 200, { reason: "amount_mismatch" }],
    ["сумма разового тарифа", { amount: { value: "149.00", currency: "RUB" } }, 200, { reason: "amount_mismatch" }],
    ["валюта не совпадает", { amount: { value: "449.00", currency: "USD" } }, 200, { reason: "amount_mismatch" }],
    ["тариф в metadata не совпадает", { metadata: { plan: "single" } }, 200, { reason: "plan_mismatch" }],
  ];
  for (const [title, over, http, expect] of refusals) {
    it(`неподтверждённый/несовпадающий платёж не выдаёт доступ: ${title}`, async () => {
      const u = await db.user({ premium: "3 days", plan: "unlimited" });
      const s = await db.sub(u);
      const payment = yk(s, "unlimited", over);
      if (over.metadata) payment.metadata = { subscription_id: s.id, ...over.metadata };
      const snap = await db.snapshot();
      const out = await WH.handleVerifiedPayment(adminOver(await db.service()), payment);
      assert.equal(out.http, http);
      for (const [k, v] of Object.entries(expect)) assert.equal(out.body[k], v);
      assert.equal(await db.snapshot(), snap);
      assert.equal((await db.activations(u)).length, 0);
    });
  }

  it("metadata.subscription_id указывает на другую подписку — отказ", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const other = await db.sub(u);
    const snap = await db.snapshot();
    const out = await WH.handleVerifiedPayment(adminOver(await db.service()), { ...yk(s, "unlimited"), metadata: { subscription_id: other.id, plan: "unlimited" } });
    assert.equal(out.body.reason, "subscription_mismatch");
    assert.equal(await db.snapshot(), snap);
  });

  it("canceled: pending → cancelled, доступ не выдаётся (поведение не менялось)", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const out = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited", { status: "canceled", paid: false }));
    assert.equal(out.body.status, "cancelled");
    assert.equal((await db.subRow(s.id)).status, "cancelled");
    assert.deepEqual(await db.profile(u), { plan: "free", premium_until: null });
  });

  it("разовый кредит 149 ₽: не продлевает безлимит и не начисляется повторно", async () => {
    const u = await db.user({ premium: "6 days", plan: "unlimited" });
    const before = await db.profile(u);
    const s = await db.sub(u, "single");
    const outs = await Promise.all(
      (await db.serviceMany(3)).map((c) => WH.handleVerifiedPayment(adminOver(c), yk(s, "single")))
    );
    const again = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "single"));
    for (const o of [...outs, again]) assert.deepEqual(o, { http: 200, body: { ok: true, subscriptionId: s.id, plan: "single", status: "active" } });
    assert.deepEqual(await db.profile(u), before, "безлимит не тронут");
    assert.equal((await db.subRow(s.id)).expires_at, null);
    assert.equal((await db.activations(u)).length, 0);
    const credits = await db.main.query("select count(*)::int as n from public.subscriptions where user_id = $1 and plan = 'single' and status = 'active'", [u]);
    assert.equal(credits.rows[0].n, 1);
    // Функция безлимита отказывает разовой подписке.
    assert.deepEqual(await grant(await db.service(), s.id, s.paymentId), { ok: false, reason: "plan_mismatch" });
  });

  it("разовый кредит без безлимита: consume_calculation даёт ровно 1 бесплатный + 1 оплаченный", async () => {
    const u = await db.user();
    const s = await db.sub(u, "single");
    await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "single"));
    await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "single")); // повторная доставка
    const c = await client(db.url);
    const consume = async () => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [u]);
      const r = (await c.query("select public.consume_calculation() as r")).rows[0].r;
      await c.query("commit");
      return r;
    };
    assert.equal((await consume()).ok, true);
    assert.equal((await consume()).ok, true);
    const third = await consume();
    assert.equal(third.ok, false);
    assert.equal(third.allowance, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("доступ: выдать права может только серверный путь (service_role)", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} не может вызвать функцию и не видит журнал`, async () => {
      const u = await db.user();
      const s = await db.sub(u);
      const c = await client(db.url, role);
      if (role === "authenticated") await c.query("select set_config('request.jwt.claim.sub', $1, false)", [u]);
      await assert.rejects(grant(c, s.id, s.paymentId), (e) => e.code === "42501");
      await assert.rejects(c.query("select count(*) from public.payment_activations"), (e) => e.code === "42501");
      await assert.rejects(
        c.query("insert into public.payment_activations (payment_id, subscription_id, user_id, activated_at, premium_until_after) values ('x', $1, $2, now(), now())", [s.id, u]),
        (e) => e.code === "42501"
      );
      assert.deepEqual(await db.profile(u), { plan: "free", premium_until: null });
    });
  }

  it("даже при ошибочно выданном EXECUTE браузерной роли продлить себе срок нельзя (SECURITY INVOKER)", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const c = await client(db.url);
    await c.query("begin");
    await c.query("grant execute on function public.grant_unlimited_payment(uuid, text) to authenticated");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [u]);
    let result = null;
    try {
      await c.query("savepoint s1");
      result = (await c.query("select public.grant_unlimited_payment($1, $2) as r", [s.id, s.paymentId])).rows[0].r;
    } catch (e) {
      result = { error: e.code };
      await c.query("rollback to savepoint s1");
    }
    await c.query("rollback");
    assert.notEqual(result?.granted, true, `браузерная роль не получила доступ: ${JSON.stringify(result)}`);
    assert.deepEqual(await db.profile(u), { plan: "free", premium_until: null });
    assert.equal((await db.activations(u)).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("миграция, read-only проверки и порядок выпуска", () => {
  const sectionRows = async (c, sql) => {
    const res = await c.query(sql);
    return (Array.isArray(res) ? res : [res]).filter((r) => r.command === "SELECT").map((r) => r.rows);
  };

  it("миграция не меняет существующие строки, повторный запуск безопасен; проверки только читают", async () => {
    const db = await freshDb({ migrated: false });
    const u = await db.user({ premium: "9 days", plan: "unlimited" });
    const legacy = await db.sub(u, "unlimited", { status: "active" });
    await db.sub(u, "single", { status: "active" });
    await db.sub(u, "unlimited");
    const [beforeRow, beforeStats, beforeCounts] = await sectionRows(db.main, CHECK_SECTIONS.before);
    assert.equal(beforeRow[0].tables_ok, true);
    assert.equal(beforeRow[0].roles_ok, true);
    assert.equal(beforeRow[0].already_table, false);
    assert.equal(beforeRow[0].already_function, false);
    assert.equal(beforeCounts[0].duplicate_payment_ids, "0");
    const snap = await db.snapshot();
    assert.equal(await db.snapshot(), snap, "раздел «ДО» ничего не изменил");

    await db.main.query(MIGRATION);
    assert.equal(await db.snapshot(), snap, "миграция не тронула подписки и профили");
    await db.main.query(MIGRATION); // повторно
    assert.equal(await db.snapshot(), snap);

    const [afterRow, afterStats] = await sectionRows(db.main, CHECK_SECTIONS.after);
    for (const [k, v] of Object.entries(afterRow[0])) if (k.endsWith("_ok")) assert.equal(v, true, k);
    assert.equal(afterRow[0].activations, "0");
    assert.deepEqual(afterStats, beforeStats, "сводка по тарифам и статусам не изменилась");

    // Выдачи новым кодом → раздел «ПОСЛЕ ДЕПЛОЯ» без расхождений.
    const s = await db.sub(u);
    await grant(await db.service(), s.id, s.paymentId);
    assert.equal((await grant(await db.service(), legacy.id, legacy.paymentId)).granted, false);
    const [deployRow] = await sectionRows(db.main, CHECK_SECTIONS.deploy);
    assert.equal(deployRow[0].activations, "1");
    for (const [k, v] of Object.entries(deployRow[0])) if (k.endsWith("_mismatch")) assert.equal(v, "0", k);
  });

  it("итоговая секция schema.sql совпадает с миграцией (функция, таблица, права)", async () => {
    const describeDb = async (c) => {
      const f = await c.query("select pg_get_functiondef(to_regprocedure('public.grant_unlimited_payment(uuid,text)')) as d, (select proacl::text from pg_proc where oid = to_regprocedure('public.grant_unlimited_payment(uuid,text)')) as acl");
      const t = await c.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='payment_activations' order by ordinal_position");
      const a = await c.query("select relacl::text as acl, relrowsecurity from pg_class where oid = 'public.payment_activations'::regclass");
      const i = await c.query("select indexdef from pg_indexes where schemaname='public' and tablename='payment_activations' order by indexname");
      return JSON.stringify([f.rows, t.rows, a.rows, i.rows]);
    };
    const migrated = await freshDb();
    const full = await freshDb({ migrated: false, fullSchema: true });
    assert.equal(await describeDb(full.main), await describeDb(migrated.main));
  });

  it("код раньше миграции: безлимит не выдаётся (500 migration_missing, ЮKassa повторит), разовый работает; после миграции повтор выдаёт один раз", async () => {
    const db = await freshDb({ migrated: false });
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const single = await db.sub(u, "single");
    const snap = await db.snapshot();
    const out = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited"));
    assert.deepEqual(out, { http: 500, body: { ok: false, error: "migration_missing" } });
    assert.equal(await db.snapshot(), snap);
    const outSingle = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(single, "single"));
    assert.equal(outSingle.http, 200);
    assert.equal((await db.subRow(single.id)).status, "active");

    await db.main.query(MIGRATION);
    const retry = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited"));
    assert.equal(retry.body.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]));
  });

  // Старый webhook (до этого PR) — те же запросы, что он делал через PostgREST:
  // прочитать подписку; если не active — UPDATE подписки (срок = время Node + 30 дней);
  // затем UPSERT профиля premium_until = срок подписки. Каждый запрос — своя транзакция.
  const DAY = 24 * 60 * 60 * 1000;
  async function oldRead(c, subId) {
    return (await c.query("select id, user_id, status, expires_at from public.subscriptions where id = $1", [subId])).rows[0];
  }
  async function oldWrite(c, sub) {
    let expires = sub.expires_at;
    if (sub.status !== "active") {
      const now = Date.now();
      expires = new Date(now + 30 * DAY).toISOString();
      await c.query("update public.subscriptions set status = 'active', starts_at = $2, expires_at = $3 where id = $1", [sub.id, new Date(now).toISOString(), expires]);
    }
    await c.query(
      "insert into public.profiles (id, plan, premium_until) values ($1, 'unlimited', $2) on conflict (id) do update set plan = excluded.plan, premium_until = excluded.premium_until",
      [sub.user_id, expires]
    );
  }

  it("миграция раньше кода: старый webhook работает как прежде, новый код не выдаёт повторно его платёж", async () => {
    const db = await freshDb();
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const s = await db.sub(u);
    const old = await db.service();
    await oldWrite(old, await oldRead(old, s.id));
    // Старое поведение: «сейчас + 30», остаток 10 дней потерян (дефект, который исправляет PR).
    assert.ok(await db.holds("$1::timestamptz - now() between interval '29 days 23 hours' and interval '30 days'", [(await db.profile(u)).premium_until]));
    const snap = await db.snapshot();
    const out = await WH.handleVerifiedPayment(adminOver(await db.service()), yk(s, "unlimited"));
    assert.equal(out.body.granted, false);
    assert.equal(await db.snapshot(), snap, "двойного начисления нет");
  });

  it("старый и новый код одновременно обрабатывают один платёж: двойного начисления нет (возможна старая потеря остатка)", async () => {
    const db = await freshDb();
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const [oldC, newC] = await db.serviceMany(2);
    const seen = await oldRead(oldC, s.id); // старый код прочитал pending
    const r = await grant(newC, s.id, s.paymentId); // новый код выдал +30 и зафиксировал
    assert.equal(r.granted, true);
    await oldWrite(oldC, seen); // старый код перезаписал по-старому
    const until = (await db.profile(u)).premium_until;
    assert.ok(await db.holds("$1::timestamptz < $2::timestamptz + interval '30 days' + interval '1 minute'", [until, start]), "не больше одной выдачи");
    assert.ok(await db.holds("$1::timestamptz - now() > interval '29 days 23 hours'", [until]), "доступ не потерян");
  });

  it("новый код держит блокировку, старый ждёт её и затем пишет по-старому: без взаимоблокировок и без двойного начисления", async () => {
    const db = await freshDb();
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    const [newC, oldC] = await db.serviceMany(2);
    const pidOld = await pidOf(oldC);
    const seen = await oldRead(oldC, s.id);
    await newC.query("begin");
    await grant(newC, s.id, s.paymentId);
    const pOld = oldWrite(oldC, seen);
    await waitForLock(db, pidOld);
    await newC.query("commit");
    await pOld;
    assert.ok(await db.holds("$1::timestamptz < $2::timestamptz + interval '30 days' + interval '1 minute'", [(await db.profile(u)).premium_until, start]));
  });

  it("откат кода после выпуска: повтор уже выданного платежа старым кодом ставит срок этого платежа (может уменьшить)", async () => {
    // Характеризация риска отката: не откатывать код, пока идут повторы уведомлений.
    const db = await freshDb();
    const u = await db.user();
    const s1 = await db.sub(u);
    const s2 = await db.sub(u);
    const svc = await db.service();
    const r1 = await grant(svc, s1.id, s1.paymentId);
    const r2 = await grant(svc, s2.id, s2.paymentId);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [r2.premium_until, r1.premium_until]));
    await oldWrite(svc, await oldRead(svc, s1.id));
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [(await db.profile(u)).premium_until, r1.premium_until]), "старый код вернул срок первого платежа");
  });
});
