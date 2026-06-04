import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../_lib/supabase-admin";

// ЮKassa шлёт webhook обычным POST с JSON — Node-рантайм, без кеша.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
// POST /api/payment/webhook — уведомления ЮKassa о статусе платежа.
//
// Этап 2. Что делает:
//   • payment.succeeded → подписку в active (starts_at / expires_at), профиль в
//     соответствующий план + premium_until;
//   • payment.canceled  → ещё не оплаченную (pending) подписку в cancelled;
//   • прочие события     → 200, игнорируем (чтобы ЮKassa не ретраила).
//
// Идемпотентность: повторный webhook не продлевает срок и не ломает активную
// подписку. Срок ставится ОДИН раз — при первой активации; профиль затем просто
// переустанавливается теми же значениями (повтор чинит и частичный сбой).
//
// Поиск подписки — по provider_payment_id (его проставляет /payment/create).
// Если не нашли — fallback по metadata.subscription_id (подстраховка, чтобы не
// потерять ОПЛАЧЕННУЮ подписку). Полный промах → 200 { ok:false }, НЕ 500.
//
// TODO(security): ЮKassa НЕ подписывает webhook (готового HMAC-секрета нет).
//   Перед продакшеном добавить верификацию источника: (1) allowlist IP ЮKassa
//   и/или (2) повторный запрос GET https://api.yookassa.ru/v3/payments/{id} к
//   API ЮKassa и сверку status, прежде чем активировать подписку. Сейчас тело
//   уведомления принимается на доверии (каркас).
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

async function handleSucceeded(
  admin: SupabaseClient,
  paymentId: string,
  metaSubId: string | undefined
): Promise<Outcome> {
  const { sub, dbError } = await findSubscription(admin, paymentId, metaSubId);
  if (dbError) return { http: 500, body: { ok: false, error: "db_error" } };
  if (!sub)
    return { http: 200, body: { ok: false, reason: "subscription_not_found" } };

  let expiresAt = sub.expires_at;

  // Первая активация: срок ставим один раз. Повторный webhook (status уже
  // active) срок НЕ пересчитывает — это и есть идемпотентность.
  if (sub.status !== "active") {
    const now = Date.now();
    const days = sub.plan === "unlimited" ? 30 : 1;
    const startsAt = new Date(now).toISOString();
    expiresAt = new Date(now + days * DAY_MS).toISOString();

    const { error: subErr } = await admin
      .from("subscriptions")
      .update({ status: "active", starts_at: startsAt, expires_at: expiresAt })
      .eq("id", sub.id);
    if (subErr) {
      // eslint-disable-next-line no-console
      console.error("[payment/webhook] subscription activate error", subErr);
      return { http: 500, body: { ok: false, error: "sub_update_failed" } };
    }
  }

  // Профиль — источник правды для entitlements (его читает useEntitlements).
  // UPSERT, а не UPDATE: если строки профиля ещё нет (триггер on_auth_user_created
  // не отработал или пользователь старше триггера), прежний UPDATE молча затрагивал
  // 0 строк — и премиум НЕ выдавался. upsert создаёт строку при отсутствии и
  // обновляет при наличии: идемпотентно, и чинит частичный сбой при повторе webhook.
  // Передаём только id/plan/premium_until — email и created_at у существующей
  // строки сохраняются (upsert трогает лишь переданные колонки).
  const { error: profErr } = await admin
    .from("profiles")
    .upsert(
      { id: sub.user_id, plan: sub.plan, premium_until: expiresAt },
      { onConflict: "id" }
    );
  if (profErr) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] profile upsert error", profErr);
    return { http: 500, body: { ok: false, error: "profile_update_failed" } };
  }

  return {
    http: 200,
    body: { ok: true, subscriptionId: sub.id, status: "active", expiresAt },
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

type Notification = {
  event?: string;
  object?: {
    id?: string;
    metadata?: Record<string, string>;
  };
};

export async function POST(req: NextRequest) {
  let body: Notification;
  try {
    body = (await req.json()) as Notification;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const event = body.event;
  const paymentId = body.object?.id;
  const metaSubId = body.object?.metadata?.subscription_id;
  if (typeof event !== "string" || !paymentId) {
    return NextResponse.json(
      { ok: false, error: "invalid_notification" },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "service_role_missing" },
      { status: 500 }
    );
  }

  let outcome: Outcome;
  if (event === "payment.succeeded") {
    outcome = await handleSucceeded(admin, paymentId, metaSubId);
  } else if (event === "payment.canceled") {
    outcome = await handleCanceled(admin, paymentId, metaSubId);
  } else {
    // waiting_for_capture, refund.succeeded и пр. — подтверждаем, не обрабатываем.
    outcome = { http: 200, body: { ok: true, ignored: true, event } };
  }

  return NextResponse.json(outcome.body, { status: outcome.http });
}
