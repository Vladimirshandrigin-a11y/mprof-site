import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../_lib/supabase-admin";
import {
  PLAN_PRICING,
  isYooKassaConfigured,
  getYooKassaPayment,
  type PaymentPlan,
  type YooKassaPayment,
} from "../_lib/yookassa";

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
//   • metadata.plan === plan нашей подписки в БД (платёж за тот тариф, что ждём).
//
// Что делает подтверждённый succeeded — РАЗНОЕ для двух тарифов:
//   • unlimited → подписку в active со сроком +30 дней (expires_at) И профиль:
//       plan='unlimited', premium_until=expires_at. Премиум по времени.
//   • single    → подписку в active БЕЗ срока (expires_at=null) и БЕЗ записи в
//       profiles. Один оплаченный разовый расчёт = сама active single-подписка;
//       useEntitlements/consume_calculation считают их как +1 к лимиту.
//   • status canceled → ещё не оплаченную (pending) подписку в cancelled;
//   • прочие статусы  → 200, игнорируем.
//
// Идемпотентность:
//   • unlimited — срок ставится ОДИН раз при первой активации; профиль затем
//     переустанавливается теми же значениями (повтор чинит частичный сбой).
//   • single    — кредит = факт active-подписки, поэтому повторный webhook просто
//     ещё раз ставит active (no-op) и НЕ начисляет лишних расчётов.
//
// Поиск подписки — по provider_payment_id (его проставляет /payment/create).
// Если не нашли — fallback по metadata.subscription_id из ВЕРИФИЦИРОВАННОГО
// платежа. Полный промах → 200 { ok:false }, НЕ 500.
//
// Коды ответов: не смогли проверить платёж (сеть/5xx/404 у ЮKassa) → 502, чтобы
// ЮKassa повторила уведомление и реальная оплата не потерялась. Проверили, но
// условия не сошлись (не succeeded / mismatch) → 200 { ok:false } без активации.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const SUB_COLS = "id, user_id, plan, status, starts_at, expires_at";

type SubRow = {
  id: string;
  user_id: string;
  plan: "single" | "unlimited";
  status: string;
  starts_at: string | null;
  expires_at: string | null;
};

type Outcome = { http: number; body: Record<string, unknown> };

// Сумма из ЮKassa сходится с серверной ценой тарифа (защита от подмены цены).
function amountMatches(
  plan: PaymentPlan,
  value: string,
  currency: string
): boolean {
  if (currency !== "RUB") return false;
  const paid = Number.parseFloat(value);
  if (!Number.isFinite(paid)) return false;
  return Math.abs(paid - PLAN_PRICING[plan].amount) < 0.005;
}

async function findSubscription(
  admin: SupabaseClient,
  paymentId: string,
  metaSubId: string | undefined
): Promise<{ sub: SubRow | null; dbError: boolean }> {
  let res = await admin
    .from("subscriptions")
    .select(SUB_COLS)
    .eq("provider_payment_id", paymentId)
    .maybeSingle();

  if (!res.error && !res.data && metaSubId) {
    res = await admin
      .from("subscriptions")
      .select(SUB_COLS)
      .eq("id", metaSubId)
      .maybeSingle();
  }

  if (res.error) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] subscription lookup error", res.error);
    return { sub: null, dbError: true };
  }
  return { sub: (res.data as SubRow | null) ?? null, dbError: false };
}

// Вызывается ТОЛЬКО после того, как getYooKassaPayment подтвердил succeeded+paid.
// Здесь — оставшиеся сверки (план/сумма/привязка) против верифицированного
// платежа, и лишь затем активация.
async function handleVerifiedSucceeded(
  admin: SupabaseClient,
  payment: YooKassaPayment
): Promise<Outcome> {
  const metaSubId = payment.metadata?.subscription_id;
  const metaPlan = payment.metadata?.plan;

  const { sub, dbError } = await findSubscription(admin, payment.id, metaSubId);
  if (dbError) return { http: 500, body: { ok: false, error: "db_error" } };
  if (!sub)
    return { http: 200, body: { ok: false, reason: "subscription_not_found" } };

  // metadata.plan платежа должен совпасть с планом нашей подписки.
  if (metaPlan !== sub.plan) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] plan mismatch", {
      paymentId: payment.id,
      metaPlan,
      subPlan: sub.plan,
    });
    return { http: 200, body: { ok: false, reason: "plan_mismatch" } };
  }

  // Если в платеже есть subscription_id — он должен указывать на эту же подписку.
  if (metaSubId && metaSubId !== sub.id) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] subscription_id mismatch", {
      paymentId: payment.id,
      metaSubId,
      subId: sub.id,
    });
    return { http: 200, body: { ok: false, reason: "subscription_mismatch" } };
  }

  // Сумма платежа должна равняться серверной цене тарифа.
  if (!amountMatches(sub.plan, payment.amount.value, payment.amount.currency)) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] amount mismatch", {
      paymentId: payment.id,
      paid: payment.amount,
      expected: PLAN_PRICING[sub.plan].amount,
    });
    return { http: 200, body: { ok: false, reason: "amount_mismatch" } };
  }

  return sub.plan === "unlimited"
    ? activateUnlimited(admin, sub)
    : activateSingle(admin, sub);
}

// unlimited — безлимит на 30 дней. profiles.premium_until = источник правды для
// useEntitlements/consume_calculation. Срок ставим ОДИН раз (повтор не
// пересчитывает); upsert профиля идемпотентен и чинит частичный сбой при повторе
// webhook (создаёт строку, если её ещё нет, иначе обновляет — email/created_at
// сохраняются).
async function activateUnlimited(
  admin: SupabaseClient,
  sub: SubRow
): Promise<Outcome> {
  let expiresAt = sub.expires_at;

  if (sub.status !== "active") {
    const now = Date.now();
    const startsAt = new Date(now).toISOString();
    expiresAt = new Date(now + 30 * DAY_MS).toISOString();

    const { error: subErr } = await admin
      .from("subscriptions")
      .update({ status: "active", starts_at: startsAt, expires_at: expiresAt })
      .eq("id", sub.id);
    if (subErr) {
      // eslint-disable-next-line no-console
      console.error("[payment/webhook] unlimited activate error", subErr);
      return { http: 500, body: { ok: false, error: "sub_update_failed" } };
    }
  }

  const { error: profErr } = await admin
    .from("profiles")
    .upsert(
      { id: sub.user_id, plan: "unlimited", premium_until: expiresAt },
      { onConflict: "id" }
    );
  if (profErr) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] profile upsert error", profErr);
    return { http: 500, body: { ok: false, error: "profile_update_failed" } };
  }

  return {
    http: 200,
    body: {
      ok: true,
      subscriptionId: sub.id,
      plan: "unlimited",
      status: "active",
      expiresAt,
    },
  };
}

// single — один оплаченный разовый расчёт. Кредит = сама active single-подписка
// (её считает consume_calculation через count active single). profiles и
// premium_until НЕ трогаем; срок не ставим (expires_at=null) — кредит действует
// до использования. Идемпотентно: повтор просто ещё раз ставит active (no-op).
async function activateSingle(
  admin: SupabaseClient,
  sub: SubRow
): Promise<Outcome> {
  if (sub.status !== "active") {
    const startsAt = new Date().toISOString();
    const { error: subErr } = await admin
      .from("subscriptions")
      .update({ status: "active", starts_at: startsAt, expires_at: null })
      .eq("id", sub.id);
    if (subErr) {
      // eslint-disable-next-line no-console
      console.error("[payment/webhook] single activate error", subErr);
      return { http: 500, body: { ok: false, error: "sub_update_failed" } };
    }
  }

  return {
    http: 200,
    body: { ok: true, subscriptionId: sub.id, plan: "single", status: "active" },
  };
}

async function handleCanceled(
  admin: SupabaseClient,
  paymentId: string,
  metaSubId: string | undefined
): Promise<Outcome> {
  const { sub, dbError } = await findSubscription(admin, paymentId, metaSubId);
  if (dbError) return { http: 500, body: { ok: false, error: "db_error" } };
  if (!sub)
    return { http: 200, body: { ok: false, reason: "subscription_not_found" } };

  // Отменяем только ещё не оплаченную (pending). Активную подписку не трогаем —
  // защита от даунгрейда уже оплаченного доступа (идемпотентность/безопасность).
  if (sub.status === "pending") {
    const { error: subErr } = await admin
      .from("subscriptions")
      .update({ status: "cancelled" })
      .eq("id", sub.id);
    if (subErr) {
      // eslint-disable-next-line no-console
      console.error("[payment/webhook] subscription cancel error", subErr);
      return { http: 500, body: { ok: false, error: "sub_update_failed" } };
    }
    return {
      http: 200,
      body: { ok: true, subscriptionId: sub.id, status: "cancelled" },
    };
  }

  return {
    http: 200,
    body: { ok: true, subscriptionId: sub.id, status: sub.status },
  };
}

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
  const payment = verify.payment;

  let outcome: Outcome;
  if (payment.status === "succeeded" && payment.paid) {
    outcome = await handleVerifiedSucceeded(admin, payment);
  } else if (payment.status === "canceled") {
    outcome = await handleCanceled(
      admin,
      payment.id,
      payment.metadata?.subscription_id
    );
  } else {
    // pending / waiting_for_capture / прочее — оплата не подтверждена, не активируем.
    outcome = {
      http: 200,
      body: { ok: true, ignored: true, status: payment.status },
    };
  }

  return NextResponse.json(outcome.body, { status: outcome.http });
}
