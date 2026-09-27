// Общая подготовка временных баз для тестов платежей (tests/db/*.test.mjs).
//
// Каждая база: роли и права по умолчанию как в Supabase (anon / authenticated / service_role),
// заглушка схемы auth, supabase/schema.sql в состоянии ДО миграции продления безлимита и —
// по умолчанию — ДОСЛОВНО миграция supabase/migrations/20260927_unlimited_payment_extension.sql.
// Роли создаются в тестовом кластере, если их нет (роли в PostgreSQL общие для кластера) —
// только для локальной тестовой БД. Базы удаляются в конце файла тестов.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "../../..");
export const read = (p) => readFileSync(path.join(root, p), "utf8");
export const MIGRATION = read("supabase/migrations/20260927_unlimited_payment_extension.sql");
export const CHECKS = read("supabase/checks/unlimited_payment_extension.sql");
export const SCHEMA = read("supabase/schema.sql");
/** require для скомпилированных run.mjs модулей приложения (TypeScript → CommonJS). */
export const buildRequire = createRequire(path.join(process.env.DB_TEST_BUILD_DIR, "loader.js"));

pg.types.setTypeParser(1184, (v) => v); // timestamptz → строка как есть (точность до микросекунд)

const SECTION_MARK = "-- Продление безлимита (449 ₽) с сохранением оплаченного срока.";
/** schema.sql в состоянии ДО миграции: всё до итоговой секции продления. */
export const SCHEMA_BEFORE = (() => {
  const i = SCHEMA.indexOf(SECTION_MARK);
  assert.ok(i > 0, "секция продления в schema.sql не найдена");
  return SCHEMA.slice(0, SCHEMA.lastIndexOf("-- ====", i));
})();

export const CHECK_SECTIONS = (() => {
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

/** Выполнить SQL-скрипт с begin/commit; при ошибке — откатить открытую транзакцию. */
export async function runScript(c, sql) {
  try {
    await c.query(sql);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}

export async function grant(c, subId, paymentId) {
  const r = await c.query("select public.grant_unlimited_payment($1, $2) as r", [subId, paymentId]);
  return r.rows[0].r;
}

export const pidOf = async (c) => (await c.query("select pg_backend_pid() as p")).rows[0].p;

/** Ждём, пока серверный процесс pid встанет в ожидание блокировки. */
export async function waitForLock(db, pid) {
  for (let i = 0; i < 100; i++) {
    const r = await db.main.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.fail(`процесс ${pid} так и не встал в ожидание блокировки`);
}

/**
 * Регистрирует хуки node:test (вызывать на верхнем уровне файла) и возвращает фабрику баз.
 * Соединения, открытые внутри теста, закрываются после него; соединения групп из before()
 * живут до конца файла.
 */
export function payTestEnv() {
  const prefix = `mprof_paytest_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  let server;
  let adminUrl;
  let dbCount = 0;
  const databases = [];
  const opened = [];
  const closers = [];
  let openedMark = 0;
  let closersMark = 0;

  before(async () => {
    adminUrl = process.env.TEST_DATABASE_URL;
    server = new pg.Client({ connectionString: adminUrl });
    await server.connect();
  });
  beforeEach(() => {
    openedMark = opened.length;
    closersMark = closers.length;
  });
  afterEach(async () => {
    await Promise.all(closers.splice(closersMark).map((f) => f().catch(() => {})));
    await Promise.all(opened.splice(openedMark).map((c) => c.end().catch(() => {})));
  });
  after(async () => {
    await Promise.all(closers.map((f) => f().catch(() => {})));
    await Promise.all(opened.map((c) => c.end().catch(() => {})));
    if (server) {
      for (const d of databases) await server.query(`drop database if exists ${d} with (force)`).catch(() => {});
      await server.end().catch(() => {});
    }
  });

  async function client(url, role) {
    const c = new pg.Client({ connectionString: url });
    c.on("error", () => {}); // обрыв соединения проверяется тестом явно
    await c.connect();
    opened.push(c);
    if (role) await c.query(`set role ${role}`);
    return c;
  }

  /** Пул соединений (закрывается вместе с остальными соединениями теста/группы). */
  function pool(url, max = 10) {
    const p = new pg.Pool({ connectionString: url, max });
    p.on("error", () => {});
    closers.push(() => p.end());
    return p;
  }

  /**
   * Новая временная база: схема ДО миграции + миграция (migrated=false — без неё;
   * migration — другой текст миграции; fullSchema — весь schema.sql).
   */
  async function freshDb({ migrated = true, fullSchema = false, migration = MIGRATION } = {}) {
    const name = `${prefix}_${++dbCount}`;
    await server.query(`create database ${name} encoding 'UTF8' template template0`);
    databases.push(name);
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    const url = u.toString();
    const main = await client(url);
    await main.query(SUPABASE_LIKE);
    await main.query(fullSchema ? SCHEMA : SCHEMA_BEFORE);
    if (migrated) await runScript(main, migration);
    return {
      url,
      main,
      pool: (max) => pool(url, max),
      /** Независимое соединение от имени service_role (как серверный webhook через PostgREST). */
      service: () => client(url, "service_role"),
      client: (role) => client(url, role),
      async serviceMany(n) {
        const cs = await Promise.all(Array.from({ length: n }, () => client(url, "service_role")));
        const pids = await Promise.all(cs.map((c) => pidOf(c)));
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
      /** Сколько дней доступа осталось по premium_until (по часам БД). */
      async daysLeft(userId) {
        const r = await main.query(
          "select round((extract(epoch from premium_until - now()) / 86400)::numeric, 3)::float8 as d from public.profiles where id = $1",
          [userId]
        );
        return r.rows[0].d;
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
  }

  return { freshDb, client };
}
