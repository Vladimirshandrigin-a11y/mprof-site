import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../_lib/supabase-admin";
import { isYooKassaConfigured, getYooKassaPayment } from "../_lib/yookassa";
import { handleVerifiedPayment } from "../_lib/webhook-core";

// ЮKassa шлёт webhook обычным POST с JSON — Node-рантайм, без кеша.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// POST /api/payment/webhook — уведомления ЮKassa о статусе платежа.
//
// БЕЗОПАСНОСТЬ (главное): телу запроса НЕ доверяем. Кто угодно может отправить
// сюда поддельный `payment.succeeded`. Поэтому из тела берём ТОЛЬКО payment.id
// (указатель — какой платёж проверять) и перезапрашиваем платёж напрямую у API
// ЮKassa (GET /v3/payments/{id}, Basic-auth). Активируем подписку, только если
// АВТОРИТЕТНЫЙ ответ ЮKassa подтверждает все условия:
//   • status === "succeeded";
//   • paid === true (деньги реально захвачены);
//   • amount.value === цена тарифа на сервере (PLAN_PRICING) и currency === RUB;
//   • metadata.plan (ЕСЛИ присутствует) совпадает с sub.plan из БД — это лишь
//     мягкая доп. сверка; источник правды о тарифе — сама запись subscriptions,
//     найденная по provider_payment_id / metadata.subscription_id.
//
// Что делает подтверждённый платёж (single / unlimited / canceled) и защита от
// повторов — в ../_lib/webhook-core.ts. Безлимит продлевается ОДНОЙ транзакцией
// БД (public.grant_unlimited_payment): +30 дней к оплаченному сроку, один платёж —
// одна выдача.
//
// Коды ответов: не смогли проверить платёж (сеть/5xx/404 у ЮKassa) → 502, чтобы
// ЮKassa повторила уведомление и реальная оплата не потерялась. Проверили, но
// условия не сошлись (не succeeded / mismatch) → 200 { ok:false } без активации.
// Сбой записи в БД (в т.ч. не применена миграция) → 500: ЮKassa повторит
// уведомление, а повтор уже выданного платежа ничего не начислит.
// ============================================================================

// Из тела берём ТОЛЬКО object.id — указатель на платёж. Статус/сумму/план НЕ
// читаем из тела (его могли подделать); всё это берётся из API ЮKassa ниже.
type Notification = {
  type?: unknown;
  event?: unknown;
  object?: { id?: unknown };
};
const NO_STORE = { "Cache-Control": "no-store" } as const;
const PAYMENT_EVENTS = new Set(["payment.succeeded", "payment.canceled", "payment.waiting_for_capture"]);

export async function POST(req: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400, headers: NO_STORE });
  }

  const body = rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? rawBody as Notification : null;
  if (!body || body.type !== "notification" || typeof body.event !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_notification" }, { status: 400, headers: NO_STORE });
  }
  // A refund object is NOT a payment object. Do not GET /payments/{refund_id}
  // or silently remove existing paid rights without an approved refund policy.
  // Returning 503 keeps provider delivery retryable while the owner resolves it.
  if (body.event === "refund.succeeded") {
    return NextResponse.json({ ok: false, error: "refund_review_required" }, { status: 503, headers: NO_STORE });
  }
  if (!PAYMENT_EVENTS.has(body.event)) {
    return NextResponse.json({ ok: false, error: "unsupported_notification" }, { status: 400, headers: NO_STORE });
  }
  const paymentId = body.object?.id;
  if (typeof paymentId !== "string" || !paymentId.trim() || paymentId.length > 128) {
    return NextResponse.json(
      { ok: false, error: "invalid_notification" },
      { status: 400, headers: NO_STORE }
    );
  }

  // Без ключей ЮKassa проверить платёж невозможно — ничего не активируем.
  if (!isYooKassaConfigured()) {
    return NextResponse.json(
      { ok: false, error: "yookassa_not_configured" },
      { status: 503, headers: NO_STORE }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service_role_missing" },
      { status: 500, headers: NO_STORE }
    );
  }

  // АВТОРИТЕТНАЯ перепроверка: запрашиваем платёж напрямую у ЮKassa по id из тела.
  const verify = await getYooKassaPayment(paymentId);
  if (!verify.ok || !verify.payment || verify.payment.id !== paymentId) {
    // Не смогли проверить (сеть / 5xx / 404). 502 → ЮKassa повторит уведомление,
    // реальная оплата не потеряется. Активация НЕ происходит.
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] verification failed", {
      reason: verify.payment && verify.payment.id !== paymentId ? "payment_id_mismatch" : "provider_unavailable",
    });
    return NextResponse.json(
      { ok: false, error: "verification_failed" },
      { status: 502, headers: NO_STORE }
    );
  }

  const outcome = await handleVerifiedPayment(admin, verify.payment);
  return NextResponse.json(outcome.body, { status: outcome.http, headers: NO_STORE });
}
