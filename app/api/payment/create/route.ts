import { NextRequest, NextResponse } from "next/server";
import { PLAN_PRICING, isYooKassaConfigured, createYooKassaPayment,
  getYooKassaPayment, type PaymentPlan } from "../_lib/yookassa";
import { getSupabaseAdmin } from "../_lib/supabase-admin";
import { PAYMENT_INTENT_ID, paymentMatchesIntent, safeConfirmationUrl,
  type PaymentIntentClaim } from "../_lib/payment-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const response = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  let body: { plan?: unknown; intentId?: unknown };
  try { body = await req.json(); } catch { return response(400, { ok: false, code: "bad_request" }); }
  if (!body || (body.plan !== "single" && body.plan !== "unlimited"))
    return response(400, { ok: false, code: "invalid_plan" });
  if (typeof body.intentId !== "string" || !PAYMENT_INTENT_ID.test(body.intentId))
    return response(400, { ok: false, code: "invalid_intent" });
  const plan: PaymentPlan = body.plan;
  const intentId = body.intentId.toLowerCase();
  if (!isYooKassaConfigured()) return response(503, { ok: false, code: "yookassa_not_configured" });
  const admin = getSupabaseAdmin();
  if (!admin) return response(503, { ok: false, code: "service_role_missing" });
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return response(401, { ok: false, code: "unauthorized" });
  const { data: user, error: authError } = await admin.auth.getUser(token);
  if (authError || !user.user) return response(401, { ok: false, code: "unauthorized" });
  const userId = user.user.id;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const { data, error } = await admin.rpc("claim_payment_intent", {
    p_user_id: userId, p_intent_id: intentId, p_plan: plan, p_site_url: siteUrl,
    p_shop_id: process.env.YOOKASSA_SHOP_ID,
  });
  if (error) {
    console.error("[payment/create] claim failed", error.code);
    return response(503, { ok: false, code: "payment_intent_unavailable" });
  }
  const claim = data as PaymentIntentClaim | null;
  if (!claim?.ok || !claim.subscription_id) return response(409, { ok: false,
    code: claim?.reason ?? "intent_conflict" });
  const subscriptionId = claim.subscription_id;
  const common = { subscriptionId, intentId, plan, amount: PLAN_PRICING[plan].amount };
  if (claim.action === "wait") return response(202, { ok: false, code: "payment_in_progress", ...common });
  if (claim.action === "reconcile") return response(409, { ok: false, code: "reconciliation_required", ...common });

  const result = claim.action === "lookup" && claim.provider_payment_id
    ? await getYooKassaPayment(claim.provider_payment_id)
    : claim.action === "create" && claim.provider_key && claim.lease_token && claim.return_url
      ? await createYooKassaPayment({ plan, returnUrl: claim.return_url,
        idempotenceKey: claim.provider_key,
        metadata: { subscription_id: subscriptionId, plan, intent_id: intentId } })
      : null;
  if (!result?.ok || !result.payment) {
    // A lost response is an unknown outcome, never evidence of a failed payment.
    // Preserve the order and key; retries resume the same durable intent.
    if (claim.lease_token) await admin.rpc("release_payment_intent", {
      p_user_id: userId, p_intent_id: intentId, p_lease_token: claim.lease_token,
    });
    return response(502, { ok: false, code: "payment_verification_unavailable", ...common });
  }
  const payment = result.payment;
  if (!paymentMatchesIntent(payment, plan, subscriptionId, intentId))
    return response(502, { ok: false, code: "payment_binding_mismatch", ...common });
  const bound = await admin.rpc("complete_payment_intent", {
    p_user_id: userId, p_intent_id: intentId, p_lease_token: claim.lease_token ?? null,
    p_payment_id: payment.id, p_confirmation_url: payment.confirmationUrl ?? null,
    p_status: payment.status,
  });
  if (bound.error || bound.data?.ok !== true) return response(503, {
    ok: false, code: "payment_binding_unavailable", ...common,
  });
  // Redirects never grant rights. The independently verified webhook does that.
  if (payment.status === "canceled") return response(409, { ok: false,
    code: "payment_canceled", status: payment.status, ...common });
  if (payment.status === "succeeded") return response(200, { ok: true,
    code: "payment_succeeded", status: payment.status, ...common });
  if (!safeConfirmationUrl(payment.confirmationUrl)) return response(502, {
    ok: false, code: "payment_confirmation_unavailable", ...common,
  });
  return response(200, { ok: true, status: payment.status,
    confirmationUrl: payment.confirmationUrl, ...common });
}
