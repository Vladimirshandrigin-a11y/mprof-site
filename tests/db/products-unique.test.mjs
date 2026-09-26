// Уникальность артикула каталога на НАСТОЯЩЕЙ PostgreSQL с НЕЗАВИСИМЫМИ соединениями.
// Запуск: TEST_DATABASE_URL=… npm run test:db (см. tests/db/run.mjs). Тест создаёт отдельную
// временную базу, применяет к ней products-часть supabase/schema.sql (состояние ДО PR #99),
// затем ДОСЛОВНО миграцию supabase/migrations/20260926_products_article_unique.sql и
// read-only проверку supabase/checks/products_article_conflicts.sql.
//
// Что доказывается на уровне БД (не моками):
//   • параллельный импорт одного артикула (разные написания, разные соединения) → ровно одна строка;
//   • стоимость существующего товара импорт не меняет;
//   • одновременное сохранение стоимости не теряется;
//   • каталоги пользователей изолированы;
//   • миграция при существующих конфликтах ничего не меняет; проверка конфликтов только читает.
// PostgREST в цепочке нет: SQL вставки повторяет то, что PostgREST строит для
// upsert(onConflict "user_id,sku_key", ignoreDuplicates) — INSERT … ON CONFLICT DO NOTHING
// RETURNING; сам HTTP-запрос supabase-js проверяется отдельно в tests/accrual.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MIGRATION = read("supabase/migrations/20260926_products_article_unique.sql");
const CHECK = read("supabase/checks/products_article_conflicts.sql");
const SCHEMA = read("supabase/schema.sql");
const req = createRequire(path.join(process.env.DB_TEST_BUILD_DIR, "loader.js"));
const CI = req("./api/cloud/_lib/catalog-import.js");

pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric → number (как PostgREST)
pg.types.setTypeParser(1184, (v) => v); // timestamptz → строка

// products-часть schema.sql в состоянии ДО миграции (таблица, колонки, триггер, RLS).
const PRODUCTS_BASE = (() => {
  const a = SCHEMA.indexOf("create table if not exists public.products (");
  const b = SCHEMA.indexOf("-- Уникальность артикула по КАНОНИЧЕСКОМУ ключу (PR #99)");
  assert.ok(a > 0 && b > a, "products-блок schema.sql не найден");
  return SCHEMA.slice(a, b);
})();

const U1 = randomUUID();
const U2 = randomUUID();
const DB = `mprof_dbtest_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
let adminUrl;
let testUrl;
let server; // соединение с базой из TEST_DATABASE_URL — только CREATE/DROP DATABASE
let main; // рабочее соединение с временной базой
const opened = [];

async function connect() {
  const c = new pg.Client({ connectionString: testUrl });
  await c.connect();
  opened.push(c);
  return c;
}
async function connectMany(n) {
  const cs = await Promise.all(Array.from({ length: n }, () => connect()));
  const pids = await Promise.all(cs.map(async (c) => (await c.query("select pg_backend_pid() as p")).rows[0].p));
  assert.equal(new Set(pids).size, n, "соединения независимы (разные серверные процессы)");
  return cs;
}
async function closeAll(cs) {
  await Promise.all(cs.map((c) => c.end().catch(() => {})));
}

async function resetBase() {
  await main.query(`
    drop table if exists public.products cascade;
    drop function if exists public.canonical_article(text) cascade;
    drop function if exists public.touch_products_updated_at() cascade;
    drop schema if exists auth cascade;
    create schema auth;
    create table auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  `);
  await main.query(PRODUCTS_BASE);
  await main.query("insert into auth.users (id) values ($1), ($2)", [U1, U2]);
}
async function migrate(c = main) {
  try {
    await c.query(MIGRATION);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}
async function addRow(user, sku, cost = 0, name = `имя ${sku}`) {
  const r = await main.query(
    "insert into public.products (user_id, sku, name, cost_price) values ($1, $2, $3, $4) returning id",
    [user, sku, name, cost]
  );
  return r.rows[0].id;
}
async function rows(user) {
  const r = await main.query(
    "select id, user_id, sku, name, cost_price from public.products where ($1::uuid is null or user_id = $1) order by created_at, id",
    [user ?? null]
  );
  return r.rows;
}
async function snapshot() {
  const r = await main.query("select id, user_id, sku, name, cost_price, updated_at from public.products order by id");
  return JSON.stringify(r.rows);
}
async function schemaState() {
  const r = await main.query(`
    select
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='sku_key') as has_column,
      exists (select 1 from pg_indexes where schemaname='public' and indexname='products_user_sku_key_uq') as has_index,
      exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='canonical_article') as has_function`);
  return r.rows[0];
}

/**
 * Вставка «как PostgREST upsert ignoreDuplicates»: INSERT … ON CONFLICT (user_id, sku_key) DO NOTHING
 * RETURNING, строки в порядке канонического ключа — как делает приложение (без этого одновременные
 * вставки пересекающихся наборов в разном порядке могут взаимно заблокироваться).
 */
async function importInsert(c, user, itemsIn) {
  const items = [...itemsIn].sort((x, y) => (CI.normArticle(x) < CI.normArticle(y) ? -1 : CI.normArticle(x) > CI.normArticle(y) ? 1 : 0));
  const r = await c.query(
    `insert into public.products (user_id, sku, name, cost_price)
     select x.user_id, x.sku, x.name, x.cost_price
       from jsonb_to_recordset($1::jsonb) as x(user_id uuid, sku text, name text, cost_price numeric)
     on conflict (user_id, sku_key) do nothing
     returning id, sku, cost_price`,
    [JSON.stringify(items.map((sku) => ({ user_id: user, sku, name: `из отчёта ${sku}`, cost_price: 0 })))]
  );
  return r.rows;
}

/**
 * Подмножество клиента supabase-js, которое использует importMissingCatalogProducts, поверх
 * отдельного pg-соединения (один вызов = одно соединение = «отдельный инстанс сервера»).
 * Журнал SQL позволяет убедиться, что функция не выполняет UPDATE/DELETE.
 */
function adminOver(c, log) {
  const cols = (s) => s.split(",").map((x) => x.trim()).join(", ");
  return {
    from(table) {
      assert.equal(table, "products");
      const q = { op: "select", cols: "*", filters: [], order: null, range: null };
      const exec = async () => {
        try {
          if (q.op === "select") {
            let sql = `select ${cols(q.cols)} from public.products where ${q.filters.map(([k], i) => `${k} = $${i + 1}`).join(" and ")}`;
            if (q.order) sql += ` order by ${q.order[0]} ${q.order[1] ? "asc" : "desc"}`;
            if (q.range) sql += ` offset ${q.range[0]} limit ${q.range[1] - q.range[0] + 1}`;
            log.push(sql);
            const r = await c.query(sql, q.filters.map(([, v]) => v));
            return { data: r.rows, error: null };
          }
          assert.equal(q.ignore, true, "адаптер поддерживает только ignoreDuplicates");
          const target = q.onConflict.split(",").map((x) => x.trim()).join(", ");
          const sql = `insert into public.products (user_id, sku, name, cost_price)
            select x.user_id, x.sku, x.name, x.cost_price
              from jsonb_to_recordset($1::jsonb) as x(user_id uuid, sku text, name text, cost_price numeric)
            on conflict (${target}) do nothing
            returning ${cols(q.cols)}`;
          log.push(sql);
          const r = await c.query(sql, [JSON.stringify(q.rows)]);
          return { data: r.rows, error: null };
        } catch (e) {
          return { data: null, error: { code: e.code, message: e.message } };
        }
      };
      const b = {
        select(s) {
          q.cols = s;
          return b;
        },
        eq(k, v) {
          q.filters.push([k, v]);
          return b;
        },
        order(k, o = {}) {
          q.order = [k, o.ascending !== false];
          return b;
        },
        range(a, z) {
          q.range = [a, z];
          return b;
        },
        upsert(rowsIn, o = {}) {
          q.op = "upsert";
          q.rows = rowsIn;
          q.onConflict = o.onConflict;
          q.ignore = o.ignoreDuplicates === true;
          return b;
        },
        then(res, rej) {
          return exec().then(res, rej);
        },
      };
      return b;
    },
  };
}

async function waitUntilLocked(pid) {
  for (let i = 0; i < 100; i++) {
    const r = await main.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

before(async () => {
  adminUrl = process.env.TEST_DATABASE_URL;
  server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  await server.query(`create database ${DB} encoding 'UTF8' template template0 lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8'`);
  const u = new URL(adminUrl);
  u.pathname = `/${DB}`;
  testUrl = u.toString();
  main = await connect();
});
after(async () => {
  await closeAll(opened);
  if (server) {
    await server.query(`drop database if exists ${DB} with (force)`).catch(() => {});
    await server.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
describe("миграция и read-only проверка конфликтов", () => {
  beforeEach(resetBase);

  it("чистые данные: проверка пуста, миграция создаёт функцию, колонку и индекс; повторный прогон безопасен", async () => {
    await addRow(U1, "ART-A", 10);
    await addRow(U1, "ART-B", 0);
    await addRow(U2, "ART-A", 20); // тот же артикул у другого пользователя — не конфликт
    const res = (await main.query(CHECK)).filter((r) => r.command === "SELECT");
    assert.equal(res[0].rows[0].case_mapping_ok, true);
    assert.equal(Number(res[1].rows[0].conflict_groups), 0);
    assert.equal(res[2].rows.length, 0);
    await migrate();
    assert.deepEqual(await schemaState(), { has_column: true, has_index: true, has_function: true });
    await migrate(); // идемпотентно
    const keys = (await main.query("select sku, sku_key from public.products order by sku, user_id")).rows;
    assert.deepEqual(keys.map((k) => k.sku_key), ["art-a", "art-a", "art-b"]);
  });

  it("конфликты (разные написания одного артикула): миграция останавливается и НИЧЕГО не меняет; строки и стоимости те же", async () => {
    await addRow(U1, "ART-A", 100, "первая");
    await addRow(U1, " art-a", 0, "вторая");
    await addRow(U1, "Art\u00a0B", 5);
    await addRow(U1, "art b", 7);
    await addRow(U2, "ART-A", 1);
    const before = await snapshot();
    await assert.rejects(() => migrate(), /найдено 2 групп \(4 строк\)/);
    assert.deepEqual(await schemaState(), { has_column: false, has_index: false, has_function: false });
    assert.equal(await snapshot(), before, "данные не изменены");
  });

  it("read-only проверка показывает группы, написания и расхождение стоимостей; сама ничего не меняет и не может писать", async () => {
    await addRow(U1, "ART-A", 100, "первая");
    await addRow(U1, " art-a", 0, "вторая");
    await addRow(U2, "ART-A", 1);
    const before = await snapshot();
    const res = (await main.query(CHECK)).filter((r) => r.command === "SELECT");
    assert.equal(Number(res[1].rows[0].conflict_groups), 1);
    assert.equal(Number(res[1].rows[0].conflict_rows), 2);
    const g = res[2].rows[0];
    assert.equal(g.canonical_key, "art-a");
    assert.deepEqual(g.raw_skus, ["ART-A", " art-a"]);
    assert.deepEqual(g.costs.map(Number), [100, 0]);
    assert.equal(g.costs_differ, true);
    assert.equal(await snapshot(), before);
    assert.deepEqual(await schemaState(), { has_column: false, has_index: false, has_function: false });
    // файл проверки целиком в транзакции READ ONLY и заканчивается откатом
    const body = CHECK.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim() !== "").join("\n").trim();
    assert.ok(body.startsWith("begin read only;"), "начинается с begin read only");
    assert.ok(body.endsWith("rollback;"), "заканчивается rollback");
    // и в такой транзакции PostgreSQL запись действительно отклоняет
    await main.query("begin read only");
    await assert.rejects(
      () => main.query("insert into public.products (user_id, sku, name) values ($1, 'x', 'x')", [U1]),
      /read-only transaction/
    );
    await main.query("rollback");
  });

  it("итоговый блок в supabase/schema.sql даёт ту же схему, что и миграция (функция, колонка, индекс)", async () => {
    const a = SCHEMA.indexOf("-- Уникальность артикула по КАНОНИЧЕСКОМУ ключу (PR #99)");
    const b = SCHEMA.indexOf("-- report_history", a);
    assert.ok(a > 0 && b > a);
    await main.query(SCHEMA.slice(a, b));
    assert.deepEqual(await schemaState(), { has_column: true, has_index: true, has_function: true });
    const def = (await main.query("select indexdef from pg_indexes where indexname = 'products_user_sku_key_uq'")).rows[0].indexdef;
    assert.match(def, /UNIQUE INDEX products_user_sku_key_uq ON public\.products USING btree \(user_id, sku_key\)/);
    await migrate(); // миграция поверх — без ошибок (идемпотентна)
  });

  it("ключ БД совпадает с нормализацией расчёта на реалистичных артикулах; расхождение — только на экзотических символах", async () => {
    await migrate();
    const realistic = ["ART-1", "art-1", " Art-1 ", "ART\u00a01", "a\tb\nc", "Товар-10", "ТОВАР  10", "SKU_123/XL", "12345", "Футболка «Лето» M", "ÉCLAIR-1", "Straße-5", "x\u3000y\ufeff", "\u2003ёж\u2009Ёж"];
    for (const s of realistic) {
      const k = (await main.query("select public.canonical_article($1) as k", [s])).rows[0].k;
      assert.equal(k, CI.normArticle(s) || null, JSON.stringify(s));
    }
    for (const s of ["", "   ", "\u00a0"]) {
      assert.equal((await main.query("select public.canonical_article($1) as k", [s])).rows[0].k, null);
    }
    const exotic = ["İ", "ΟΔΟΣ", "ǅ"];
    for (const s of exotic) {
      const k = (await main.query("select public.canonical_article($1) as k", [s])).rows[0].k;
      assert.notEqual(k, CI.normArticle(s), `ожидаемое (задокументированное) расхождение: ${s}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("гарантия БД после миграции: независимые соединения", () => {
  beforeEach(async () => {
    await resetBase();
    await migrate();
  });

  it("соединение B ждёт незафиксированную вставку A того же артикула и после её фиксации ничего не вставляет", async () => {
    const [a, b] = await connectMany(2);
    const pidB = (await b.query("select pg_backend_pid() as p")).rows[0].p;
    await a.query("begin");
    assert.equal((await importInsert(a, U1, ["ART-1"])).length, 1);
    const pending = importInsert(b, U1, [" art-1 "]); // другое написание, отдельное соединение
    assert.equal(await waitUntilLocked(pidB), true, "B заблокирован уникальным индексом до фиксации A");
    await a.query("commit");
    assert.deepEqual(await pending, [], "B: DO NOTHING");
    assert.deepEqual((await rows(U1)).map((r) => r.sku), ["ART-1"]);
    await closeAll([a, b]);
  });

  it("16 соединений одновременно импортируют 40 артикулов в разных написаниях: ровно одна строка на артикул, Σ вставок = 40", async () => {
    const cs = await connectMany(16);
    const arts = Array.from({ length: 40 }, (_, i) => `ART-${String(i).padStart(3, "0")}`);
    const spell = (s, k) => [s, s.toLowerCase(), ` ${s} `, s.replace(/^ART/, "Art"), `${s}\u00a0`][k % 5];
    const rotate = (a, n) => a.slice(n % a.length).concat(a.slice(0, n % a.length));
    const results = await Promise.all(
      cs.map((c, k) => importInsert(c, U1, rotate(arts, k * 3).map((s) => spell(s, k))))
    );
    assert.equal(results.reduce((n, r) => n + r.length, 0), 40);
    const all = await rows(U1);
    assert.equal(all.length, 40);
    assert.equal(new Set(all.map((r) => CI.normArticle(r.sku))).size, 40);
    await closeAll(cs);
  });

  it("общая функция приложения, 8 вызовов параллельно — каждый на своём соединении («разные инстансы»): одна строка на артикул, без UPDATE/DELETE", async () => {
    const cs = await connectMany(8);
    const logs = cs.map(() => []);
    const items = ["P-1", "P-2", "P-3", "P-4", "P-5"];
    const rotate = (a, n) => a.slice(n % a.length).concat(a.slice(0, n % a.length));
    const variants = [(s) => s, (s) => s.toLowerCase(), (s) => `  ${s}`, (s) => `${s.toLowerCase()}\t`];
    const results = await Promise.all(
      cs.map((c, k) =>
        CI.importMissingCatalogProducts(
          adminOver(c, logs[k]),
          U1,
          rotate(items, k).map((s) => ({ offerId: variants[k % variants.length](s), name: `Товар ${s}` })),
          { serialize: false }
        )
      )
    );
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)));
    assert.equal(results.reduce((n, r) => n + r.created.length, 0), 5, "каждая строка засчитана ровно одному вызову");
    assert.ok(results.every((r) => r.created.length + r.alreadyInCatalog === 5 && r.ambiguous.length === 0));
    assert.equal((await rows(U1)).length, 5);
    const sql = logs.flat().join("\n").toLowerCase();
    assert.doesNotMatch(sql, /\b(update|delete)\b/);
    await closeAll(cs);
  });

  it("стоимость существующего товара импорт не меняет (параллельные импорты разных написаний)", async () => {
    const id = await addRow(U1, "ART-A", 150, "Мой товар");
    const cs = await connectMany(6);
    await Promise.all(cs.map((c, k) => importInsert(c, U1, [["art-a", " ART-A", "Art-a"][k % 3], `NEW-${k}`])));
    const a = (await rows(U1)).find((r) => r.id === id);
    assert.deepEqual([a.sku, a.name, a.cost_price], ["ART-A", "Мой товар", 150]);
    assert.equal((await rows(U1)).filter((r) => CI.normArticle(r.sku) === "art-a").length, 1);
    await closeAll(cs);
  });

  it("сохранение стоимости во время импорта не теряется: незафиксированный UPDATE стоимости + параллельный импорт того же артикула", async () => {
    const id = await addRow(U1, "ART-C", 0);
    const [a, b] = await connectMany(2);
    await a.query("begin");
    await a.query("update public.products set cost_price = 77 where id = $1 and user_id = $2", [id, U1]);
    const imported = importInsert(b, U1, ["art-c", "ART-D"]);
    const res = await Promise.race([
      imported.then((r) => ({ done: true, r })),
      new Promise((r) => setTimeout(() => r({ done: false }), 300)),
    ]);
    await a.query("commit");
    const r = res.done ? res.r : await imported;
    assert.deepEqual(r.map((x) => x.sku), ["ART-D"], "импорт вставил только отсутствующий товар");
    assert.equal((await rows(U1)).find((x) => x.id === id).cost_price, 77);
    await closeAll([a, b]);
  });

  it("одновременные сохранения стоимости (10 соединений) и импорты тех же артикулов (10 соединений): все стоимости на месте, строк не прибавилось", async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await addRow(U1, `COST-${i}`, 0));
    const savers = await connectMany(10);
    const importers = await connectMany(10);
    await Promise.all([
      ...savers.map((c, i) => c.query("update public.products set cost_price = $1 where id = $2 and user_id = $3", [100 + i, ids[i], U1])),
      ...importers.map((c, i) => importInsert(c, U1, [`cost-${i}`, ` COST-${(i + 1) % 10}`])),
    ]);
    const after = await rows(U1);
    assert.equal(after.length, 10);
    for (let i = 0; i < 10; i++) assert.equal(after.find((r) => r.id === ids[i]).cost_price, 100 + i);
    await closeAll([...savers, ...importers]);
  });

  it("изоляция: одинаковые артикулы у разных пользователей допустимы; параллельные импорты — по одной строке каждому; чужая стоимость цела", async () => {
    await addRow(U2, "SHARED", 500, "чужой");
    const cs = await connectMany(8);
    await Promise.all(cs.map((c, k) => importInsert(c, k % 2 ? U1 : U2, ["SHARED", "shared ", "ONLY"])));
    const u1 = await rows(U1);
    const u2 = await rows(U2);
    assert.deepEqual(u1.map((r) => CI.normArticle(r.sku)).sort(), ["only", "shared"]);
    assert.deepEqual(u2.map((r) => CI.normArticle(r.sku)).sort(), ["only", "shared"]);
    assert.equal(u2.find((r) => r.sku === "SHARED").cost_price, 500);
    await closeAll(cs);
  });

  it("другие пути записи тоже под гарантией: ручная вставка дубля и смена артикула на занятый → 23505; ключ приложение не пишет (428C9)", async () => {
    await addRow(U1, "ART-A", 10);
    const other = await addRow(U1, "ART-B", 20);
    await assert.rejects(() => addRow(U1, " art-a", 99), (e) => e.code === "23505");
    await assert.rejects(
      () => main.query("update public.products set sku = 'Art-A' where id = $1", [other]),
      (e) => e.code === "23505"
    );
    await main.query("update public.products set cost_price = 25, name = 'новое' where id = $1", [other]);
    await assert.rejects(
      () => main.query("insert into public.products (user_id, sku, name, sku_key) values ($1, 'X', 'x', 'x')", [U1]),
      (e) => e.code === "428C9"
    );
    await addRow(U1, null, 1, "без артикула 1");
    await addRow(U1, "   ", 1, "без артикула 2"); // пустой ключ = NULL — не конфликтует
    assert.equal((await rows(U1)).length, 4);
  });
});

describe("без миграции автодобавление не выполняется", () => {
  beforeEach(resetBase);

  it("общая функция на настоящей БД без колонки sku_key: migration_missing, ни одной вставки", async () => {
    const [c] = await connectMany(1);
    const res = await CI.importMissingCatalogProducts(adminOver(c, []), U1, [{ offerId: "M-1" }], { serialize: false });
    assert.deepEqual([res.ok, res.code], [false, "migration_missing"]);
    assert.equal((await rows(U1)).length, 0);
    await closeAll([c]);
  });
});
