import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, it } from "node:test";
import { buildRequire, payTestEnv, read } from "./helpers/pay-db.mjs";

const { freshDb } = payTestEnv();
const day5 = read("supabase/migrations/20261125155702_payment_intents.sql");
const day6 = read("supabase/migrations/20261127172250_day6_metrika_outbox.sql");
const operations = read("supabase/migrations/20260928_calculation_operations.sql");
const { metricParameters, metrikaEventId, readAnalyticsBody, sendMetric } = buildRequire("./analytics/server.js");
const { attributionOf, clientIdForConsent, safePath, safeReferrer } = buildRequire("./analytics/model.js");
const view = buildRequire("./api/metrika/view/route.js");
const session = buildRequire("./api/metrika/session/route.js");
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

it("records one failed-payment goal for an intent and ignores cancellations without an intent", async () => {
  const user = await db.user();
  await consent(user);
  const result = await claim(user, randomUUID());
  const intent = result.rows[0].claim_payment_intent;
  assert.equal(intent.ok, true);
  const paymentId = randomUUID();
  await service.query("select public.cancel_pending_payment($1,$2)", [intent.subscription_id, paymentId]);
  await service.query("select public.cancel_pending_payment($1,$2)", [intent.subscription_id, paymentId]);
  const legacy = await db.sub(user, "single");
  await service.query("select public.cancel_pending_payment($1,$2)", [legacy.id, legacy.paymentId]);
  assert.deepEqual(await goals(user), ["checkout_started", "payment_failed"]);
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

it("revocation stops previously claimed delivery, prevents stale enrollment, and isolates another browser", async () => {
  const user = await db.user();
  const other = await db.user();
  const otherClientId = await clientIdForConsent("b".repeat(64));
  await consent(user);
  await service.query("select public.register_metrika_consent($1,$2,$3)", [other, otherClientId, null]);
  await claim(user, randomUUID());
  await claim(other, randomUUID());
  const batch = await service.query("select * from public.claim_metrika_events()");
  const revoked = batch.rows.find((row) => row.client_id === clientId);
  const unaffected = batch.rows.find((row) => row.client_id === otherClientId);
  assert.ok(revoked && unaffected);
  await service.query("select public.revoke_metrika_consent($1)", [clientId]);
  await service.query("select public.revoke_metrika_consent($1)", [clientId]);
  await consent(user, new Date());
  assert.deepEqual(await goals(user), ["checkout_started"]);
  for (const [index, event] of [revoked, unaffected].entries()) {
    const write = await service.query(`update public.metrika_events set external_id=$2
      where id=$1 and state='sending' returning id`, [event.id, "a".repeat(64)]);
    assert.equal(write.rowCount, index);
  }
  assert.equal((await service.query("select * from public.claim_metrika_events()")).rowCount, 0);
  for (const role of ["anon", "authenticated"]) {
    const client = await db.client(role);
    await assert.rejects(client.query("select * from public.metrika_events"), { code: "42501" });
    await assert.rejects(client.query("select * from public.claim_metrika_events()"), { code: "42501" });
    await assert.rejects(client.query("select * from public.metrika_revoked_clients"), { code: "42501" });
    await assert.rejects(client.query("select public.revoke_metrika_consent($1)", [clientId]), { code: "42501" });
  }
});

it("serializes revocation with an in-progress enrollment for the same browser", async () => {
  const user = await db.user();
  const other = await db.service();
  await service.query("begin");
  try {
    await service.query("select public.revoke_metrika_consent($1)", [clientId]);
    const enrollment = other.query("select public.register_metrika_consent($1,$2,$3)", [user, clientId, new Date()]);
    await service.query("commit");
    await enrollment;
    assert.deepEqual(await goals(user), []);
  } finally {
    await service.query("rollback");
  }
});

it("routes send only approved, non-revoked views and require a private proof to withdraw", async (t) => {
  const settings = {
    MPROF_METRIKA_ENABLED: "true",
    MPROF_METRIKA_COUNTER_ID: "123",
    MPROF_METRIKA_MEASUREMENT_TOKEN: "synthetic-token",
    NEXT_PUBLIC_SITE_URL: "https://mprof-seller.ru",
    NEXT_PUBLIC_SUPABASE_URL: "http://fake-supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  };
  const previous = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const proof = "e".repeat(64);
  const id = await clientIdForConsent(proof);
  let revoked = false;
  let sent = 0;
  const mockFetch = t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/metrika_revoked_clients") {
      assert.equal(url.searchParams.get("client_id"), `eq.${id}`);
      return Response.json(revoked ? [{ client_id: id }] : []);
    }
    if (url.pathname === "/rest/v1/rpc/revoke_metrika_consent") {
      assert.deepEqual(JSON.parse(options.body), { p_client_id: id });
      revoked = true;
      return new Response(null, { status: 204 });
    }
    assert.equal(url.href, "https://mc.yandex.ru/collect");
    assert.equal(options.body.get("cid"), id);
    assert.equal(options.body.get("dl"), "https://mprof-seller.ru/app?yclid=123456789012345678");
    assert.equal(options.body.toString().includes(proof), false);
    sent++;
    return new Response("<!-- OK -->");
  });
  const request = (body, headers = {}) => new Request("https://mprof-seller.ru/api/metrika", {
    method: "POST",
    headers: { host: "mprof-seller.ru", origin: "https://mprof-seller.ru", ...headers },
    body: JSON.stringify(body),
  });
  const page = { path: "/app", proof, source: { yclid: "123456789012345678", uid: "synthetic" } };
  await view.POST(request({ path: "/app", clientId: id }));
  await view.POST(request(page, { "sec-gpc": "1" }));
  await view.POST(request(page, { origin: "https://other.test" }));
  assert.equal((await session.POST(request({ allowed: false, clientId: id }))).status, 400);
  assert.equal(mockFetch.mock.callCount(), 0);
  await view.POST(request(page));
  assert.equal(sent, 1);
  assert.equal((await session.POST(request({ allowed: false, proof }))).status, 204);
  await view.POST(request(page));
  assert.equal(sent, 1);
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
  const proof = "c".repeat(64);
  const derived = await clientIdForConsent(proof);
  assert.match(derived, /^[1-9][0-9]{18}$/);
  assert.equal(await clientIdForConsent(derived), null);
  assert.equal(await clientIdForConsent(proof), derived);
  assert.notEqual(await clientIdForConsent("d".repeat(64)), derived);
  const id = randomUUID();
  const eventId = metrikaEventId("unit-only", id, "purchase_149");
  const view = metricParameters(config, { type:"view", clientId, path:"/app?sub=private", source });
  assert.equal(view.get("dl"), "https://mprof-seller.ru/?yclid=123456789012345678");
  const goal = metricParameters(config, { type:"goal", clientId, goal:"purchase_149", plan:"single", time:10, eventId });
  assert.equal(goal.get("ev"), "149");
  assert.equal(goal.get("cu"), "RUB");
  for (const name of ["subscription_449", "subscription_renewed"]) {
    const paid = metricParameters(config, { type:"goal", clientId, goal:name, plan:"unlimited", time:10, eventId });
    assert.equal(paid.get("ev"), "449");
    assert.equal(paid.get("cu"), "RUB");
  }
  assert.match(goal.get("params"), /^[^@]+$/);
  assert.equal(goal.toString().includes(id), false);
  assert.equal(goal.toString().includes(proof), false);
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
