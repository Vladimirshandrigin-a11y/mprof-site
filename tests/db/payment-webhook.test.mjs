// Webhook ЮKassa целиком (POST route.ts) → supabase-js → RPC на НАСТОЯЩЕЙ PostgreSQL.
// Запуск: TEST_DATABASE_URL=… npm run test:db.
//
// Сеть подменена (tests/db/helpers/fetch-stub.mjs): ответ ЮKassa задаёт тест, запросы
// supabase-js к /rest/v1 выполняются SQL-ом на временной базе от имени service_role —
// каждый в своём соединении и своей транзакции. Настоящей ЮKassa и production нет.
//
// Проверяются два обработчика:
//   • ТЕКУЩИЙ — app/api/payment/webhook/route.ts этой ветки (скомпилирован run.mjs);
//   • СТАРЫЙ  — тот же файл из базовой production b1264168 (git show), без изменений:
//     его фактическая последовательность «прочитать → UPDATE подписки → UPSERT профиля».
// Пересечения задаются паузами конкретных HTTP-запросов обработчика.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { SERVICE_KEY, SUPABASE_URL, gate, installFetch } from "./helpers/fetch-stub.mjs";
import { MIGRATION, buildRequire, payTestEnv, read, root, runScript } from "./helpers/pay-db.mjs";

const BASE_SHA = "b1264168cf1f3abac0c672f600fd0884566b4674"; // production до PR #105
const HEAD_BEFORE_FENCE = "143434f7a2d552805c7a7e9b91b429b0e32b5752"; // первая версия PR #105
const MIGRATION_PATH = "supabase/migrations/20260927_unlimited_payment_extension.sql";

const gitShow = (sha, p) => {
  try {
    return execFileSync("git", ["show", `${sha}:${p}`], { cwd: root, encoding: "utf8" });
  } catch (e) {
    throw new Error(`git show ${sha}:${p} не удался — тест требует историю репозитория: ${e.message}`);
  }
};

// Переменные окружения только этого тестового процесса (ключи фиктивные).
process.env.YOOKASSA_SHOP_ID = "test-shop";
process.env.YOOKASSA_SECRET_KEY = "test-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const CURRENT = buildRequire("./api/payment/webhook/route.js");

/** Старый обработчик ДОСЛОВНО из базовой production; его зависимости с тех пор не менялись. */
const LEGACY = (() => {
  for (const dep of ["app/api/payment/_lib/supabase-admin.ts", "app/api/payment/_lib/yookassa.ts"]) {
    assert.equal(gitShow(BASE_SHA, dep), read(dep), `${dep} не менялся с ${BASE_SHA}`);
  }
  const ts = createRequire(path.join(root, "package.json"))("typescript");
  const js = ts.transpileModule(gitShow(BASE_SHA, "app/api/payment/webhook/route.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  const appRequire = createRequire(path.join(root, "package.json"));
  const deps = {
    "../_lib/supabase-admin": () => buildRequire("./api/payment/_lib/supabase-admin.js"),
    "../_lib/yookassa": () => buildRequire("./api/payment/_lib/yookassa.js"),
  };
  const mod = { exports: {} };
  new Function("exports", "require", "module", js)(mod.exports, (s) => (deps[s] ? deps[s]() : appRequire(s)), mod);
  return mod.exports;
})();

const net = installFetch();
const { state } = net;
const { freshDb } = payTestEnv();

/** Платежи «в ЮKassa»: id → ответ GET /v3/payments/{id} или сбой. */
const yookassa = new Map();
state.yookassa = (id) => {
  const p = yookassa.get(id);
  if (!p) return new Response(JSON.stringify({ type: "error", code: "not_found" }), { status: 404 });
  if (p.networkError) throw new TypeError("fetch failed");
  if (p.httpStatus) return new Response("{}", { status: p.httpStatus });
  return new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
};
function paid(sub, plan, over = {}) {
  const p = {
    id: sub.paymentId,
    status: "succeeded",
    paid: true,
    amount: { value: plan === "unlimited" ? "449.00" : "149.00", currency: "RUB" },
    metadata: { subscription_id: sub.id, plan },
    ...over,
  };
  yookassa.set(sub.paymentId, p);
  return p;
}

/** Уведомление ЮKassa в обработчик. Тело — только указатель на платёж (или подделка). */
async function webhook(handler, paymentId, body) {
  const req = new Request("http://localhost/api/payment/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? { type: "notification", event: "payment.succeeded", object: { id: paymentId } }),
  });
  const res = await handler.POST(req);
  return { status: res.status, body: await res.json() };
}

const writes = () => net.dbRequests().filter((r) => r.method !== "GET");
const isProfileWrite = (userId) => (r) => r.method === "POST" && r.path === "/rest/v1/profiles" && r.body?.id === userId;
const isSubPatch = (subId) => (r) => r.method === "PATCH" && r.path === "/rest/v1/subscriptions" && r.url.includes(`id=eq.${subId}`);

const realConsoleError = console.error;
before(() => {
  console.error = () => {}; // обработчики пишут в лог ожидаемые отказы
});
after(() => {
  console.error = realConsoleError;
  net.restore();
});
beforeEach(() => net.reset());

// ─────────────────────────────────────────────────────────────────────────────
describe("текущий webhook (route.ts) → RPC grant_unlimited_payment", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(() => {
    state.pool = db.pool(12);
  });

  it("подтверждённый безлимит: проверка у ЮKassa, затем ровно один вызов RPC с правильными аргументами и ключом", async () => {
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    paid(s, "unlimited");
    const out = await webhook(CURRENT, s.paymentId);

    const ykCalls = state.log.filter((r) => r.url.startsWith("https://api.yookassa.ru/"));
    assert.equal(ykCalls.length, 1);
    assert.equal(ykCalls[0].method, "GET");
    assert.equal(ykCalls[0].url, `https://api.yookassa.ru/v3/payments/${s.paymentId}`);
    assert.equal(ykCalls[0].headers.authorization, `Basic ${Buffer.from("test-shop:test-secret").toString("base64")}`);

    const rpc = net.rpcCalls();
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0].method, "POST");
    assert.equal(rpc[0].path, "/rest/v1/rpc/grant_unlimited_payment");
    assert.deepEqual(rpc[0].body, { p_subscription_id: s.id, p_payment_id: s.paymentId });
    assert.equal(rpc[0].headers.apikey, SERVICE_KEY);
    assert.equal(rpc[0].headers.authorization, `Bearer ${SERVICE_KEY}`);
    assert.deepEqual(writes().map((r) => r.path), ["/rest/v1/rpc/grant_unlimited_payment"], "срок пишет только RPC");

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.granted, true);
    assert.equal(out.body.plan, "unlimited");
    assert.equal(out.body.status, "active");
    assert.equal(out.body.subscriptionId, s.id);
    const until = (await db.profile(u)).premium_until;
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [until, start]));
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz", [out.body.expiresAt, until]), "ответ содержит новый срок");
  });

  it("«уже обработано»: повторное уведомление завершается 200 без продления", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    paid(s, "unlimited");
    const first = await webhook(CURRENT, s.paymentId);
    const snap = await db.snapshot();
    net.reset();
    const again = await webhook(CURRENT, s.paymentId);
    assert.equal(again.status, 200);
    assert.equal(again.body.ok, true);
    assert.equal(again.body.granted, false);
    assert.equal(again.body.expiresAt, first.body.expiresAt);
    assert.equal(net.rpcCalls().length, 1);
    assert.equal(await db.snapshot(), snap);
  });

  it("одновременная доставка одного уведомления в 4 обработчика: одна выдача, остальные «уже обработано»", async () => {
    const u = await db.user({ premium: "5 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    paid(s, "unlimited");
    const outs = await Promise.all([1, 2, 3, 4].map(() => webhook(CURRENT, s.paymentId)));
    assert.ok(outs.every((o) => o.status === 200 && o.body.ok === true));
    assert.equal(outs.filter((o) => o.body.granted === true).length, 1);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]));
  });

  it("повтор после успешной транзакции и потерянного ответа RPC не продлевает снова", async () => {
    const u = await db.user({ premium: "3 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const s = await db.sub(u);
    paid(s, "unlimited");
    state.dropAfterCommit = (r) => r.path.startsWith("/rest/v1/rpc/");
    const lost = await webhook(CURRENT, s.paymentId);
    assert.equal(lost.status, 500, "без ответа RPC обработчик не подтверждает выдачу");
    assert.equal(lost.body.ok, false);
    assert.equal(lost.body.error, "grant_failed");
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]), "транзакция зафиксирована");
    state.dropAfterCommit = null;
    const retry = await webhook(CURRENT, s.paymentId); // ЮKassa повторяет уведомление
    assert.equal(retry.status, 200);
    assert.equal(retry.body.granted, false);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await db.profile(u)).premium_until, start]), "не +60");
  });

  const rpcFailures = [
    ["RPC отвечает 500", () => new Response(JSON.stringify({ code: "XX000", message: "internal" }), { status: 500 })],
    ["сеть до RPC недоступна", () => { throw new TypeError("fetch failed"); }],
    ["RPC вернула пустой ответ", () => new Response("null", { status: 200, headers: { "content-type": "application/json" } })],
  ];
  for (const [title, respond] of rpcFailures) {
    it(`ошибка RPC не подтверждается как выдача: ${title} → 500 grant_failed, срок не меняется`, async () => {
      const u = await db.user({ premium: "8 days", plan: "unlimited" });
      const s = await db.sub(u);
      paid(s, "unlimited");
      const snap = await db.snapshot();
      state.override = (r) => (r.path.startsWith("/rest/v1/rpc/") ? respond() : undefined);
      const out = await webhook(CURRENT, s.paymentId);
      assert.equal(out.status, 500);
      assert.deepEqual(out.body, { ok: false, error: "grant_failed" });
      assert.equal(await db.snapshot(), snap);
      assert.equal((await db.activations(u)).length, 0);
    });
  }

  it("RPC отказала (платёж не той подписки) → 200 ok:false, срок не меняется", async () => {
    const u = await db.user();
    const s = await db.sub(u, "unlimited", { paymentId: "pay-already-bound-elsewhere" });
    paid({ id: s.id, paymentId: "pay-other" }, "unlimited"); // metadata указывает на эту подписку
    const snap = await db.snapshot();
    const out = await webhook(CURRENT, "pay-other");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: false, reason: "payment_mismatch" });
    assert.equal(await db.snapshot(), snap);
  });

  const verificationFailures = [
    ["ЮKassa: платёж не найден (404)", { httpStatus: 404 }, 502, { ok: false, error: "verification_failed" }],
    ["ЮKassa: 500", { httpStatus: 500 }, 502, { ok: false, error: "verification_failed" }],
    ["ЮKassa недоступна", { networkError: true }, 502, { ok: false, error: "verification_failed" }],
    ["ЮKassa: pending", { status: "pending", paid: false }, 200, { ok: true, ignored: true, status: "pending" }],
    ["ЮKassa: succeeded, но paid=false", { paid: false }, 200, { ok: true, ignored: true, status: "succeeded" }],
    ["ЮKassa: сумма 448", { amount: { value: "448.00", currency: "RUB" } }, 200, { ok: false, reason: "amount_mismatch" }],
    ["ЮKassa: валюта USD", { amount: { value: "449.00", currency: "USD" } }, 200, { ok: false, reason: "amount_mismatch" }],
    ["ЮKassa: тариф single", { metadata: "single" }, 200, { ok: false, reason: "plan_mismatch" }],
  ];
  for (const [title, over, status, body] of verificationFailures) {
    it(`отказ проверки платежа не вызывает выдачу: ${title}`, async () => {
      const u = await db.user({ premium: "2 days", plan: "unlimited" });
      const s = await db.sub(u);
      const p = paid(s, "unlimited", over.metadata ? {} : over);
      if (over.metadata) p.metadata = { subscription_id: s.id, plan: over.metadata };
      const snap = await db.snapshot();
      // Подделанное тело «всё оплачено» не влияет: решает ответ ЮKassa.
      const out = await webhook(CURRENT, s.paymentId, {
        event: "payment.succeeded",
        object: { id: s.paymentId, status: "succeeded", paid: true, amount: { value: "449.00", currency: "RUB" } },
      });
      assert.equal(out.status, status);
      assert.deepEqual(out.body, body);
      assert.equal(net.rpcCalls().length, 0);
      assert.deepEqual(writes(), []);
      assert.equal(await db.snapshot(), snap);
    });
  }

  it("некорректное уведомление → 400 без обращения к ЮKassa и БД", async () => {
    const out = await webhook(CURRENT, null, { event: "payment.succeeded", object: {} });
    assert.equal(out.status, 400);
    assert.deepEqual(state.log, []);
  });

  it("разовый кредит: прежнее поведение (как у старого обработчика), RPC не вызывается", async () => {
    const results = {};
    for (const [name, handler] of [["старый", LEGACY], ["текущий", CURRENT]]) {
      const u = await db.user({ premium: "6 days", plan: "unlimited" });
      const before = await db.profile(u);
      const s = await db.sub(u, "single");
      paid(s, "single");
      net.reset();
      const first = await webhook(handler, s.paymentId);
      const firstWrites = writes().map((r) => ({ method: r.method, path: r.path, keys: Object.keys(r.body ?? {}).sort() }));
      net.reset();
      const again = await webhook(handler, s.paymentId);
      const againWrites = writes().length;
      const credits = await db.main.query("select count(*)::int as n from public.subscriptions where user_id = $1 and plan = 'single' and status = 'active'", [u]);
      assert.deepEqual(await db.profile(u), before, `${name}: безлимит не тронут`);
      assert.equal((await db.subRow(s.id)).expires_at, null);
      results[name] = {
        first: { ...first, body: { ...first.body, subscriptionId: "…" } },
        again: { ...again, body: { ...again.body, subscriptionId: "…" } },
        firstWrites,
        againWrites,
        credits: credits.rows[0].n,
        activations: (await db.activations(u)).length,
      };
    }
    assert.deepEqual(results["текущий"], results["старый"]);
    assert.deepEqual(results["текущий"].firstWrites, [{ method: "PATCH", path: "/rest/v1/subscriptions", keys: ["expires_at", "starts_at", "status"] }]);
    assert.equal(results["текущий"].againWrites, 0);
    assert.equal(results["текущий"].credits, 1);
    assert.equal(results["текущий"].activations, 0);
  });

  it("миграция не применена: RPC нет (PGRST202) → 500 migration_missing, доступ не выдан; после миграции повтор выдаёт один раз", async () => {
    const bare = await freshDb({ migrated: false });
    state.pool = bare.pool(4);
    const u = await bare.user({ premium: "10 days", plan: "unlimited" });
    const start = (await bare.profile(u)).premium_until;
    const s = await bare.sub(u);
    paid(s, "unlimited");
    const snap = await bare.snapshot();
    const out = await webhook(CURRENT, s.paymentId);
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { ok: false, error: "migration_missing" });
    assert.equal(net.rpcCalls().length, 1);
    assert.deepEqual(writes().map((r) => r.path), ["/rest/v1/rpc/grant_unlimited_payment"]);
    assert.equal(await bare.snapshot(), snap);

    await runScript(bare.main, MIGRATION);
    const retry = await webhook(CURRENT, s.paymentId);
    assert.equal(retry.body.granted, true);
    assert.ok(await bare.holds("$1::timestamptz = $2::timestamptz + interval '30 days'", [(await bare.profile(u)).premium_until, start]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Пересечение СТАРОГО (production до PR #105) и НОВОГО обработчиков.
// Оплаченные дни считаются по правилу PR: каждый платёж, выданный новым кодом, — +30 дней.

async function scenarioDifferentPayments(db, t) {
  // Старый A прочитал подписку, посчитал абсолютный срок, отметил подписку и встал перед
  // записью профиля; новый B того же пользователя продлил срок; старый A продолжил.
  const u = await db.user({ premium: "10 days", plan: "unlimited" });
  const a = await db.sub(u);
  const b = await db.sub(u);
  paid(a, "unlimited");
  paid(b, "unlimited");
  const g = gate(isProfileWrite(u));
  state.gates.push(g);
  const oldA = webhook(LEGACY, a.paymentId);
  await g.reached;
  const newB = await webhook(CURRENT, b.paymentId);
  const afterB = await db.daysLeft(u);
  g.open();
  const oldRes = await oldA;
  const final = await db.daysLeft(u);
  t.diagnostic(`было 10 дн. → новый B: ${afterB} дн. (granted=${newB.body.granted}) → после записи старого A: ${final} дн., ответ старого ${oldRes.status}`);
  return { u, a, b, afterB, final, oldRes, newB };
}

async function scenarioSamePayment(db, t) {
  // Старый обработчик прочитал ещё не обработанный платёж A и посчитал срок; новый код
  // успел активировать A; старый продолжил запись.
  const u = await db.user({ premium: "10 days", plan: "unlimited" });
  const a = await db.sub(u);
  paid(a, "unlimited");
  const g = gate(isSubPatch(a.id));
  state.gates.push(g);
  const oldA = webhook(LEGACY, a.paymentId);
  await g.reached;
  const newA = await webhook(CURRENT, a.paymentId);
  const afterNew = await db.daysLeft(u);
  g.open();
  const oldRes = await oldA;
  const final = await db.daysLeft(u);
  t.diagnostic(`было 10 дн. → новый A: ${afterNew} дн. → после записи старого A: ${final} дн., ответ старого ${oldRes.status}`);
  return { u, a, afterNew, final, oldRes, newA };
}

describe(`пересечение обработчиков: до ограждения (миграция ${HEAD_BEFORE_FENCE.slice(0, 7)}) — воспроизведение`, () => {
  let db;
  before(async () => {
    db = await freshDb({ migration: gitShow(HEAD_BEFORE_FENCE, MIGRATION_PATH) });
  });
  beforeEach(() => {
    state.pool = db.pool(8);
  });

  it("разные платежи: запоздавшая запись старого A стирает продление нового B", async (t) => {
    const r = await scenarioDifferentPayments(db, t);
    assert.ok(Math.abs(r.afterB - 40) < 0.01, "B продлил 10 → 40");
    assert.ok(Math.abs(r.final - 30) < 0.01, "старый A перезаписал «сейчас + 30»: потеряны 10 оставшихся дней и 30 дней B");
  });

  it("один платёж: старый обработчик, прочитавший его до активации, затирает остаток", async (t) => {
    const r = await scenarioSamePayment(db, t);
    assert.ok(Math.abs(r.afterNew - 40) < 0.01);
    assert.ok(Math.abs(r.final - 30) < 0.01, "потеряны 10 оставшихся дней");
  });
});

describe("пересечение обработчиков: с ограждением (текущая миграция)", () => {
  let db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(() => {
    state.pool = db.pool(8);
  });

  it("разные платежи: старый A после миграции получает отказ, B продлевает, повтор A новым кодом — все 60 дней на месте", async (t) => {
    const u = await db.user({ premium: "10 days", plan: "unlimited" });
    const start = (await db.profile(u)).premium_until;
    const a = await db.sub(u);
    const b = await db.sub(u);
    paid(a, "unlimited");
    paid(b, "unlimited");
    const g = gate(isSubPatch(a.id)); // старый A прочитал и посчитал срок, стоит перед записью
    state.gates.push(g);
    const oldA = webhook(LEGACY, a.paymentId);
    await g.reached;
    const newB = await webhook(CURRENT, b.paymentId);
    g.open();
    const oldRes = await oldA;
    const afterOld = await db.daysLeft(u);
    const retryA = await webhook(CURRENT, a.paymentId); // ЮKassa повторяет A — уже новому коду
    const final = await db.daysLeft(u);
    t.diagnostic(`было 10 дн. → новый B: +30 → старый A: ${oldRes.status} ${JSON.stringify(oldRes.body)}, срок ${afterOld} дн. → повтор A новым кодом: ${final} дн.`);
    assert.equal(newB.body.granted, true);
    assert.deepEqual(oldRes, { status: 500, body: { ok: false, error: "sub_update_failed" } });
    assert.ok(Math.abs(afterOld - 40) < 0.01, "старый A ничего не записал");
    assert.equal(retryA.body.granted, true);
    assert.ok(await db.holds("$1::timestamptz = $2::timestamptz + interval '60 days'", [(await db.profile(u)).premium_until, start]), "10 + 30 + 30");
    assert.equal((await db.subRow(a.id)).status, "active");
  });

  it("один платёж: старый обработчик, прочитавший его до активации новым кодом, получает отказ; остаток цел", async (t) => {
    const r = await scenarioSamePayment(db, t);
    assert.ok(Math.abs(r.afterNew - 40) < 0.01);
    assert.deepEqual(r.oldRes, { status: 500, body: { ok: false, error: "sub_update_failed" } });
    assert.ok(Math.abs(r.final - 40) < 0.01, "срок не уменьшен");
    const retry = await webhook(CURRENT, r.a.paymentId);
    assert.equal(retry.body.granted, false);
    assert.ok(Math.abs((await db.daysLeft(r.u)) - 40) < 0.01);
  });

  it("повтор уже выданного платежа старым обработчиком (запоздавший или после отката кода) не уменьшает срок", async (t) => {
    const u = await db.user();
    const p1 = await db.sub(u);
    const p2 = await db.sub(u);
    paid(p1, "unlimited");
    paid(p2, "unlimited");
    await webhook(CURRENT, p1.paymentId);
    await webhook(CURRENT, p2.paymentId);
    const before = await db.daysLeft(u);
    const old = await webhook(LEGACY, p1.paymentId); // старый «чинит» профиль сроком p1
    const final = await db.daysLeft(u);
    t.diagnostic(`две выдачи: ${before} дн. → старый повтор p1: ${old.status} ${JSON.stringify(old.body)} → ${final} дн.`);
    assert.deepEqual(old, { status: 500, body: { ok: false, error: "profile_update_failed" } });
    assert.ok(Math.abs(final - before) < 0.001 && Math.abs(final - 60) < 0.01);
  });

  it("старый обработчик после миграции: новый безлимит не активирует (500, ЮKassa повторит), разовый работает как прежде", async () => {
    const u = await db.user();
    const s = await db.sub(u);
    const single = await db.sub(u, "single");
    paid(s, "unlimited");
    paid(single, "single");
    const snap = await db.snapshot();
    const out = await webhook(LEGACY, s.paymentId);
    assert.deepEqual(out, { status: 500, body: { ok: false, error: "sub_update_failed" } });
    assert.equal(await db.snapshot(), snap);
    const outSingle = await webhook(LEGACY, single.paymentId);
    assert.equal(outSingle.status, 200);
    assert.equal((await db.subRow(single.id)).status, "active");
  });

  it("старый A успел отметить подписку ДО миграции и стоит перед записью профиля: миграция не применяется, пока A не завершится", async (t) => {
    const bare = await freshDb({ migrated: false });
    state.pool = bare.pool(6);
    const u = await bare.user({ premium: "10 days", plan: "unlimited" });
    const a = await bare.sub(u);
    const b = await bare.sub(u);
    paid(a, "unlimited");
    paid(b, "unlimited");
    const g = gate(isProfileWrite(u));
    state.gates.push(g);
    const oldA = webhook(LEGACY, a.paymentId);
    await g.reached; // подписка A уже active, профиль ещё не записан
    const refused = await runScript(bare.main, MIGRATION).then(() => null, (e) => e.message);
    t.diagnostic(`миграция во время незавершённой активации: ${refused}`);
    assert.match(refused ?? "", /незавершённ/);
    assert.equal((await bare.main.query("select to_regprocedure('public.grant_unlimited_payment(uuid,text)') as f")).rows[0].f, null, "ничего не создано");
    g.open();
    assert.equal((await oldA).status, 200); // A завершился по-старому (до выпуска)
    const afterA = await bare.daysLeft(u);
    await runScript(bare.main, MIGRATION);
    const newB = await webhook(CURRENT, b.paymentId);
    const final = await bare.daysLeft(u);
    t.diagnostic(`старый A (до миграции): ${afterA} дн. → миграция → новый B: ${final} дн.`);
    assert.equal(newB.body.granted, true);
    assert.ok(Math.abs(final - afterA - 30) < 0.01, "после выпуска B добавил полные 30 дней к сроку A");
  });
});
