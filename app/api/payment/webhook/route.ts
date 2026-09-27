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
  object?: { id?: string };
};

export async function POST(req: NextRequest) {
  let body: Notification;
  try {
    body = (await req.json()) as Notification;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const paymentId = body.object?.id;
  if (typeof paymentId !== "string" || !paymentId) {
    return NextResponse.json(
      { ok: false, error: "invalid_notification" },
      { status: 400 }
    );
  }

  // Без ключей ЮKassa проверить платёж невозможно — ничего не активируем.
  if (!isYooKassaConfigured()) {
    return NextResponse.json(
      { ok: false, error: "yookassa_not_configured" },
      { status: 503 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service_role_missing" },
      { status: 500 }
    );
  }

  // АВТОРИТЕТНАЯ перепроверка: запрашиваем платёж напрямую у ЮKassa по id из тела.
  const verify = await getYooKassaPayment(paymentId);
  if (!verify.ok || !verify.payment) {
    // Не смогли проверить (сеть / 5xx / 404). 502 → ЮKassa повторит уведомление,
    // реальная оплата не потеряется. Активация НЕ происходит.
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] verification failed", {
      paymentId,
      error: verify.error,
    });
    return NextResponse.json(
      { ok: false, error: "verification_failed" },
      { status: 502 }
    );
  }

  const outcome = await handleVerifiedPayment(admin, verify.payment);
  return NextResponse.json(outcome.body, { status: outcome.http });
}
