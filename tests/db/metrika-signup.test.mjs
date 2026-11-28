import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { buildRequire, payTestEnv, read } from "./helpers/pay-db.mjs";

process.env.NEXT_PUBLIC_MPROF_METRIKA_ENABLED = "true";
const { supabaseSignupFetch } = buildRequire("./app/lib/supabase-signup.js");
const { ANALYTICS_PREFERENCE } = buildRequire("./analytics/model.js");
const { rememberAnalyticsSignup, syncAnalyticsSession } = buildRequire("./analytics/browser.js");
const route = buildRequire("./api/metrika/session/route.js");
const { freshDb } = payTestEnv();
const site = "https://mprof-seller.ru";
const authOrigin = "https://mprof-isolated.test";

it("recovers the actual GoTrue signup user in SDK 2.106.1 without creating a session", async () => {
  const id = randomUUID();
  const payload = { id, email: "person@example.test", identities: [{ user_id: id }] };
  const sdk = createClient(authOrigin, "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: supabaseSignupFetch(authOrigin, async () => Response.json(payload)) },
  });
  const result = await sdk.auth.signUp({ email: payload.email, password: "synthetic-password" });
  assert.equal(result.error, null);
  assert.equal(result.data.user.id, id);
  assert.equal(result.data.session, null);

  payload.identities = [];
  const duplicate = await sdk.auth.signUp({ email: payload.email, password: "synthetic-password" });
  assert.deepEqual(duplicate.data.user.identities, []);
});

it("keeps modern responses, failures and unrelated requests unchanged", async () => {
  const legacy = { id: randomUUID(), identities: [] };
  const modern = { user: legacy, session: null };
  for (const [body, path, status] of [
    [modern, "/auth/v1/signup", 200],
    [legacy, "/auth/v1/signup", 429],
    [legacy, "/auth/v1/verify", 200],
    [legacy, "https://elsewhere.test/auth/v1/signup", 200],
    [{ id: legacy.id }, "/auth/v1/signup", 200],
  ]) {
    const response = Response.json(body, { status });
    const fetcher = supabaseSignupFetch(authOrigin, async () => response);
    assert.equal(await fetcher(new URL(path, authOrigin), { method: "POST" }), response);
  }
});

it("queues only one confirmed goal after consent, retaining the marker until confirmation", async (t) => {
  const db = await freshDb({ extraMigrations: [
    read("supabase/migrations/20260928_calculation_operations.sql"),
    read("supabase/migrations/20261125155702_payment_intents.sql"),
    read("supabase/migrations/20261127172250_day6_metrika_outbox.sql"),
  ] });
  const rpc = await db.service();
  const userId = await db.user();
  const proof = "a".repeat(64);
  const browserStorage = new Map();
  const priorWindow = globalThis.window;
  globalThis.window = {
    location: new URL(site),
    localStorage: {
      getItem: (k) => browserStorage.get(k) ?? null,
      setItem: (k, v) => browserStorage.set(k, v),
      removeItem: (k) => browserStorage.delete(k),
    },
  };
  t.after(() => {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  });
  const env = {
    MPROF_METRIKA_ENABLED: "true",
    MPROF_METRIKA_COUNTER_ID: "123",
    MPROF_METRIKA_MEASUREMENT_TOKEN: "synthetic",
    NEXT_PUBLIC_SITE_URL: site,
    NEXT_PUBLIC_SUPABASE_URL: authOrigin,
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let confirmed = null;
  const created = new Date().toISOString();
  let syncs = 0;
  let expectedRegistration = true;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input, site);
    if (url.href === site + "/api/metrika/session") {
      syncs++;
      assert.deepEqual(JSON.parse(options.body), { allowed: true, proof, registration: expectedRegistration });
      return route.POST(new Request(url, {
        ...options, headers: { ...options.headers, origin: site, host: new URL(site).host },
      }));
    }
    if (url.href === authOrigin + "/auth/v1/user") {
      return Response.json({ id: userId, email: "person@example.test", created_at: created, email_confirmed_at: confirmed });
    }
    assert.equal(url.href, authOrigin + "/rest/v1/rpc/register_metrika_consent");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ["p_client_id", "p_signup_confirmed_at", "p_user_id"]);
    await rpc.query("select public.register_metrika_consent($1,$2,$3)", [
      body.p_user_id, body.p_client_id, body.p_signup_confirmed_at,
    ]);
    return new Response(null, { status: 204 });
  });
  const count = async () => (await db.main.query(
    "select count(*)::integer as count from public.metrika_events where user_id=$1 and name='registration_confirmed'", [userId],
  )).rows[0].count;

  rememberAnalyticsSignup(userId);
  await syncAnalyticsSession("synthetic-session", userId);
  assert.equal(syncs, 0);
  assert.equal(browserStorage.size, 0);

  browserStorage.set(ANALYTICS_PREFERENCE, JSON.stringify({ choice: "allow", proof }));
  rememberAnalyticsSignup(userId);
  await syncAnalyticsSession("synthetic-session", userId);
  assert.equal(syncs, 1);
  assert.equal(await count(), 0);
  assert.ok([...browserStorage.values()].includes(userId));

  confirmed = created;
  await syncAnalyticsSession("synthetic-session", userId);
  assert.equal(syncs, 2);
  assert.equal(await count(), 1);
  assert.ok(![...browserStorage.values()].includes(userId));
  expectedRegistration = false;
  await syncAnalyticsSession("synthetic-session", userId);
  assert.equal(syncs, 3);
  assert.equal(await count(), 1);
});
