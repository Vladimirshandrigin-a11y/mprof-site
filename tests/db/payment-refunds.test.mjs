import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, it } from "node:test";
import { SERVICE_KEY, SUPABASE_URL, installFetch } from "./helpers/fetch-stub.mjs";
import { buildRequire, grant, payTestEnv, pidOf, read, waitForLock } from "./helpers/pay-db.mjs";

const { freshDb } = payTestEnv();
const net = installFetch();
const webhook = buildRequire("./api/payment/webhook/route.js");
const payments = new Map();
const refunds = new Map();
let db;

process.env.YOOKASSA_SHOP_ID = "test-shop";
process.env.YOOKASSA_SECRET_KEY = "test-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

function providerObject(objects, id) {
  return objects.has(id)
    ? Response.json(objects.get(id))
    : Response.json({ code: "not_found" }, { status: 404 });
}

before(async () => {
  db = await freshDb({ fullSchema: true, migrated: false });
  net.state.pool = db.pool(12);
  net.state.yookassa = (id) => providerObject(payments, id);
  net.state.yookassaRefund = (id) => providerObject(refunds, id);
});
beforeEach(() => {
  net.reset();
  payments.clear();
  refunds.clear();
});
after(() => net.restore());

async function notify(event, id) {
  const res = await webhook.POST(new Request("http://localhost/api/payment/webhook", {
    method: "POST",
    body: JSON.stringify({ type: "notification", event, object: { id, payment_id: "untrusted" } }),
  }));
  return { status: res.status, body: await res.json() };
}

async function order(userId, plan = "single", options) {
  const paymentId = `pay-${randomUUID()}`;
  const sub = await db.sub(userId, plan, { paymentId, ...options });
  const price = plan === "single" ? "149.00" : "449.00";
  payments.set(paymentId, {
    id: paymentId, status: "succeeded", paid: true,
    amount: { value: price, currency: "RUB" }, metadata: { subscription_id: sub.id, plan },
  });
  return { ...sub, paymentId, price };
}

function confirmedRefund(sub, amount = sub.price) {
  const id = `refund-${randomUUID()}`;
  refunds.set(id, { id, status: "succeeded", payment_id: sub.paymentId, amount: { value: amount, currency: "RUB" } });
  return id;
}

async function issue(sub) {
  return notify("payment.succeeded", sub.paymentId);
}

async function applyRefund(client, refundId, sub) {
  return (await client.query("select public.apply_payment_refund($1,$2,$3,$4,true) as result", [
    refundId, sub.id, sub.paymentId, Math.round(Number(sub.price) * 100),
  ])).rows[0].result;
}

async function checkRefund(refundId, outcome) {
  assert.deepEqual(await notify("refund.succeeded", refundId), { status: 200, body: { ok: true, outcome } });
}

async function consume(client, userId) {
  return (await client.query("select public.consume_calculation_for($1) as result", [userId])).rows[0].result;
}

it("возврат 149 ₽ отзывает только свой неиспользованный кредит, даже при параллельной доставке", async () => {
  const userId = await db.user();
  const refunded = await order(userId);
  const kept = await order(userId);
  await issue(refunded);
  await issue(kept);
  assert.equal((await consume(db.main, userId)).used, 1, "первая попытка бесплатная");
  const refundId = confirmedRefund(refunded);
  await Promise.all(Array.from({ length: 5 }, () => checkRefund(refundId, "revoked_single")));
  assert.equal((await db.subRow(refunded.id)).status, "cancelled");
  assert.equal((await db.subRow(kept.id)).status, "active");
  await checkRefund(confirmedRefund(refunded), "already_refunded");
  assert.equal((await db.main.query("select count(*)::int as n from public.payment_refunds where refund_id=$1", [refundId])).rows[0].n, 1);
  assert.equal((await issue(refunded)).body.granted, false);
  assert.equal((await consume(db.main, userId)).used, 2, "другой оплаченный кредит доступен");
  assert.equal((await consume(db.main, userId)).reason, "limit_reached");
});

it("частичный возврат и использованный кредит попадают в долговечную ручную очередь", async () => {
  const userId = await db.user();
  const sub = await order(userId);
  await issue(sub);
  const partialId = confirmedRefund(sub, "19.00");
  await checkRefund(partialId, "review_partial");
  await checkRefund(partialId, "review_partial");
  assert.equal((await consume(db.main, userId)).used, 1);
  assert.equal((await consume(db.main, userId)).used, 2);
  // A different order represents the full-refund scenario: YooKassa cannot
  // refund the full original amount after a successful partial refund.
  const another = await order(userId);
  await issue(another);
  await checkRefund(confirmedRefund(another), "review_single_usage");
  assert.equal((await db.subRow(sub.id)).status, "active");
  assert.equal((await db.subRow(another.id)).status, "active");
});

it("расход против возврата сериализуется по профилю: расход успел первым", async () => {
  const userId = await db.user();
  const sub = await order(userId);
  await issue(sub);
  await consume(db.main, userId);
  const consuming = await db.client();
  const refunding = await db.service();
  const refundPid = await pidOf(refunding);
  await consuming.query("begin");
  assert.equal((await consume(consuming, userId)).used, 2);
  const result = applyRefund(refunding, confirmedRefund(sub), sub);
  await waitForLock(db, refundPid);
  await consuming.query("commit");
  assert.equal((await result).outcome, "review_single_usage");
  assert.equal((await db.subRow(sub.id)).status, "active");
});

it("расход против возврата сериализуется по профилю: возврат успел первым", async () => {
  const userId = await db.user();
  const sub = await order(userId);
  await issue(sub);
  await consume(db.main, userId);
  const refunding = await db.service();
  const consuming = await db.client();
  const consumePid = await pidOf(consuming);
  await refunding.query("begin");
  assert.equal((await applyRefund(refunding, confirmedRefund(sub), sub)).outcome, "revoked_single");
  const blocked = consume(consuming, userId);
  await waitForLock(db, consumePid);
  await refunding.query("commit");
  assert.equal((await blocked).reason, "limit_reached");
});

it("возврат пришёл раньше оплаты: блокирует позднюю выдачу 149 ₽ и 449 ₽", async () => {
  for (const plan of ["single", "unlimited"]) {
    const userId = await db.user();
    const sub = await order(userId, plan, { paymentId: null });
    const refunding = await db.service();
    const granting = await db.service();
    const grantPid = await pidOf(granting);
    await refunding.query("begin");
    assert.equal((await applyRefund(refunding, confirmedRefund(sub), sub)).outcome, "blocked_pending");
    const later = plan === "single"
      ? granting.query("select public.grant_single_payment($1,$2) as result", [sub.id, sub.paymentId])
      : granting.query("select public.grant_unlimited_payment($1,$2) as result", [sub.id, sub.paymentId]);
    await waitForLock(db, grantPid);
    await refunding.query("commit");
    assert.equal((await later).rows[0].result.granted ?? false, false);
    assert.equal((await db.subRow(sub.id)).status, "cancelled");
    assert.equal((await db.profile(userId)).premium_until, null);
    if (plan === "single") {
      const legacy = await granting.query("update public.subscriptions set status='active' where id=$1", [sub.id]);
      assert.equal(legacy.rowCount, 0, "повтор через предыдущий обработчик сохранит отзыв");
    }
  }
});

it("возврат 449 ₽ удаляет только последний период и сохраняет срок другого платежа", async () => {
  const userId = await db.user();
  const kept = await order(userId, "unlimited");
  const refunded = await order(userId, "unlimited");
  await issue(kept);
  const originalTerm = (await db.profile(userId)).premium_until;
  await issue(refunded);
  const afterBoth = (await db.profile(userId)).premium_until;
  assert.notEqual(afterBoth, originalTerm);
  const refundId = confirmedRefund(refunded);
  await checkRefund(refundId, "revoked_unlimited");
  assert.equal((await db.profile(userId)).premium_until, originalTerm);
  assert.equal((await db.subRow(kept.id)).status, "active");
  assert.equal((await db.subRow(refunded.id)).status, "cancelled");
  await checkRefund(refundId, "revoked_unlimited");
  assert.equal((await issue(refunded)).body.granted, false);
  assert.equal((await db.profile(userId)).premium_until, originalTerm);
});

it("одновременные продление и возврат хвоста сохраняют новый период", async () => {
  const userId = await db.user();
  const refunded = await order(userId, "unlimited");
  const kept = await order(userId, "unlimited");
  await issue(refunded);
  const refunding = await db.service();
  const granting = await db.service();
  const grantPid = await pidOf(granting);
  await refunding.query("begin");
  assert.equal((await applyRefund(refunding, confirmedRefund(refunded), refunded)).outcome, "revoked_unlimited");
  const later = grant(granting, kept.id, kept.paymentId);
  await waitForLock(db, grantPid);
  await refunding.query("commit");
  assert.equal((await later).granted, true);
  assert.equal(await db.daysLeft(userId), 30);
  assert.equal((await db.subRow(kept.id)).status, "active");
});

it("старое продление под более новым и legacy-период без чека остаются на ручной сверке", async () => {
  const userId = await db.user({ plan: "unlimited", premium: "10 days" });
  const legacy = await order(userId, "unlimited", { status: "active" });
  await checkRefund(confirmedRefund(legacy), "review_unlimited_attribution");
  const first = await order(userId, "unlimited");
  const second = await order(userId, "unlimited");
  await issue(first);
  await issue(second);
  const beforeRefund = await db.profile(userId);
  await checkRefund(confirmedRefund(first), "review_unlimited_attribution");
  assert.deepEqual(await db.profile(userId), beforeRefund);
  assert.equal((await db.subRow(first.id)).status, "active");
  assert.equal((await db.subRow(second.id)).status, "active");
});

it("поддельные данные, чужая привязка и неверная сумма не отзывают права", async () => {
  const userId = await db.user();
  const sub = await order(userId);
  await issue(sub);
  const id = confirmedRefund(sub, "149.01");
  assert.equal((await notify("refund.succeeded", id)).status, 502);
  const mismatchId = confirmedRefund(sub);
  payments.get(sub.paymentId).metadata.subscription_id = randomUUID();
  assert.equal((await notify("refund.succeeded", mismatchId)).body.reason, "refund_payment_mismatch");
  assert.equal((await db.subRow(sub.id)).status, "active");
  assert.ok(net.state.log.every((request) => !request.path.includes("/v3/refunds") || request.method === "GET"));
  assert.equal(net.rpcCalls().filter((request) => request.path.endsWith("/apply_payment_refund")).length, 0);
});

it("SQL возврата и журнал доступны только сервисной роли с минимальными правами", async () => {
  const sub = await order(await db.user());
  for (const role of ["anon", "authenticated"]) {
    const client = await db.client(role);
    await assert.rejects(applyRefund(client, "blocked", sub), { code: "42501" });
    await assert.rejects(client.query("select * from public.payment_refunds"), { code: "42501" });
  }
  const service = await db.service();
  await assert.rejects(service.query("delete from public.payment_refunds"), { code: "42501" });
  assert.match(read("supabase/migrations/20261125155702_payment_intents.sql"), /alter table public\.payment_refunds enable row level security/);
});

it("новые журналы сохраняют каскадное удаление тестового аккаунта", async () => {
  const userId = await db.user();
  const sub = await order(userId);
  await db.main.query(`insert into public.payment_intents(user_id,id,subscription_id,plan,provider_shop_id,return_url)
    values($1,$2,$3,'single','test-shop','https://localhost/app')`, [userId, randomUUID(), sub.id]);
  await issue(sub);
  await checkRefund(confirmedRefund(sub), "revoked_single");
  await db.main.query("delete from auth.users where id=$1", [userId]);
  for (const table of ["payment_intents", "single_payment_activations", "payment_refunds"]) {
    assert.equal((await db.main.query(`select 1 from public.${table} where subscription_id=$1`, [sub.id])).rowCount, 0);
  }
});
