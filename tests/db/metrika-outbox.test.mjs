import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, it } from "node:test";
import { buildRequire, payTestEnv, read } from "./helpers/pay-db.mjs";

const { freshDb } = payTestEnv();
const day5 = read("supabase/migrations/20261125155702_payment_intents.sql");
const day6 = read("supabase/migrations/20261127172250_day6_metrika_outbox.sql");
const operations = read("supabase/migrations/20260928_calculation_operations.sql");
const { metricParameters, metrikaEventId, readAnalyticsBody, sendMetric } = buildRequire("./analytics/server.js");
const { attributionOf, safePath, safeReferrer } = buildRequire("./analytics/model.js");
const clientId = "1123456789012345678";
let db;
let service;

beforeEach(async () => {
  db = await freshDb({ extraMigrations: [operations, day5, day6] });
  service = await db.service();
});

const consent = (user, signup = null) => service.query(
  "select public.register_metrika_consent($1,$2,$3)", [user, clientId, signup]
);
const goals = async (user) => (await db.main.query(
  "select name from public.metrika_events where user_id=$1 order by name", [user]
)).rows.map(({ name }) => name);
const grant = (fn, sub) => service.query(`select public.${fn}($1,$2)`, [sub.id, sub.paymentId]);
const claim = (user, intent) => service.query(
  "select public.claim_payment_intent($1,$2,'single','https://mprof-seller.ru','test-shop')", [user, intent]
);

it("captures one checkout intent and one server-confirmed 149 goal despite provider retries", async () => {
  const user = await db.user();
  await consent(user);
  const intent = randomUUID();
  await claim(user, intent);
  await claim(user, intent);
  assert.deepEqual(await goals(user), ["checkout_started"]);
  const sub = await db.sub(user, "single");
  await grant("grant_single_payment", sub);
  await grant("grant_single_payment", sub);
  assert.deepEqual(await goals(user), ["checkout_started", "payment_confirmed", "purchase_149"]);
});

it("uses separate 449 renewal and first purchase goals and discards uncommitted receipts", async () => {
  const user = await db.user();
  await consent(user);
  const a = await db.sub(user);
  const b = await db.sub(user);
  await grant("grant_unlimited_payment", a);
  await service.query("begin");
  await grant("grant_unlimited_payment", b);
  await service.query("rollback");
  assert.deepEqual(await goals(user), ["payment_confirmed", "subscription_449"]);
  await grant("grant_unlimited_payment", b);
  assert.deepEqual(await goals(user), ["payment_confirmed", "payment_confirmed", "subscription_449", "subscription_renewed"]);
});

it("requires consent, counts registration and first free receipt once, and prevents concurrent double claim", async () => {
  const user = await db.user();
  const sub = await db.sub(user, "single");
  await grant("grant_single_payment", sub);
  assert.deepEqual(await goals(user), []);
  await consent(user, new Date());
  await consent(user, new Date());
  await db.main.query("update public.profiles set calculations_used=1 where id=$1", [user]);
  for (const id of [randomUUID(), randomUUID()]) {
    await db.main.query(`insert into public.calculation_operations(id,user_id,mode,request_hash,payload_hash,charged)
      values ($1,$2,'upload','synthetic',repeat('a',64),true)`, [id, user]);
  }
  const other = await db.service();
  const result = await Promise.all([service, other].map(connection => connection.query("select * from public.claim_metrika_events()")));
  const seen = result.flatMap(batch => batch.rows);
  assert.deepEqual(seen.map(({name}) => name).sort(), ["first_free_calculation","registration_confirmed"]);
  assert.equal(new Set(seen.map(({id}) => id)).size, 2);
  assert.equal((await service.query("select * from public.claim_metrika_events()")).rowCount, 0);
});

it("revocation stops queued delivery and client roles cannot read analytics records", async () => {
  const user = await db.user();
  await consent(user);
  await claim(user, randomUUID());
  await service.query("delete from public.metrika_consent where user_id=$1", [user]);
  assert.equal((await service.query("select * from public.claim_metrika_events()")).rowCount, 0);
  for (const role of ["anon", "authenticated"]) {
    const client = await db.client(role);
    await assert.rejects(client.query("select * from public.metrika_events"), { code: "42501" });
    await assert.rejects(client.query("select * from public.claim_metrika_events()"), { code: "42501" });
  }
});

it("projects only curated acquisition, goal, public price, and opaque event data", async () => {
  const source = { utm_source: "direct", utm_campaign: "merchant@example.test", utm_term: "purchase",
    yclid:"123456789012345678", payment_id: "secret", email: "person@example.test" };
  assert.deepEqual(attributionOf(source, new Set(["direct","purchase"])), {
    utm_source: "direct", utm_term: "purchase", yclid:"123456789012345678",
  });
  assert.deepEqual(attributionOf({ yclid: "79991234567" }), {});
  assert.equal(safePath("/app?sub=private"), null);
  assert.equal(safePath("/auth/update-password"), null);
  assert.equal(safeReferrer("https://yandex.ru/search?private@example.test"), "https://yandex.ru");
  assert.equal(safeReferrer("https://yandex.ru.example.test/"), null);
  const config = { id: "123", token: "private-test-token" };
  const id = randomUUID();
  const eventId = metrikaEventId("unit-only", id, "purchase_149");
  const view = metricParameters(config, { type:"view", clientId, path:"/app?sub=private", source });
  assert.equal(view.get("dl"), "https://mprof-seller.ru/?yclid=123456789012345678");
  const goal = metricParameters(config, { type:"goal", clientId, goal:"purchase_149", plan:"single", time:10, eventId });
  assert.equal(goal.get("ev"), "149");
  assert.equal(goal.get("cu"), "RUB");
  assert.match(goal.get("params"), /^[^@]+$/);
  assert.equal(goal.toString().includes(id), false);
  assert.equal(metricParameters(config, { type:"goal", clientId, goal:"payment_confirmed", time:11, eventId }).has("ev"), false);
  assert.equal(await readAnalyticsBody(new Request("https://example.test", {
    method:"POST", body: JSON.stringify({ value: "x".repeat(2000) }),
  })), null);
});

it("checks provider acceptance, leaves an ambiguous send uncertain, and sends no expired goal", async () => {
  const nativeFetch = globalThis.fetch;
  const event = { type: "goal", clientId, goal: "subscription_449", eventId: "f".repeat(64),
    time: Math.floor(Date.now() / 1000) };
  const config = { id: "123", token: "private-test-token" };
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://mc.yandex.ru/collect");
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("ea"), "subscription_449");
      calls++;
      if (calls === 1) throw new TypeError("test: provider accepted but response was lost");
      return new Response("<!-- OK -->");
    };
    assert.equal(await sendMetric(config, event), "uncertain");
    assert.equal(calls, 1);
    assert.equal(await sendMetric(config, { ...event, time: event.time - 13 * 3600 }), "expired");
    assert.equal(calls, 1);
    assert.equal(await sendMetric(config, event), "sent");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
