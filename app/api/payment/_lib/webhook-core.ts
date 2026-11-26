// ============================================================================
// Обработка УЖЕ ВЕРИФИЦИРОВАННОГО платежа ЮKassa (вызывается из webhook после
// getYooKassaPayment). Вынесено из route.ts, чтобы проверять на настоящей
// PostgreSQL (tests/db) без Next.js и без сети.
//
// Что делает подтверждённый succeeded — РАЗНОЕ для двух тарифов:
//   • unlimited → ОДИН вызов SQL-функции public.grant_unlimited_payment()
//       (миграция supabase/migrations/20260927_unlimited_payment_extension.sql).
//       В одной транзакции БД под блокировками строк: отметка «платёж обработан»
//       (payment_activations, ключ payment_id), новый срок
//       premium_until = max(текущий срок, now() БД) + 30 дней и статус подписки.
//       Повтор того же платежа ничего не начисляет; разные платежи одного
//       пользователя складываются. Срок НЕ считается в JavaScript.
//   • single → grant_single_payment(): одна active single-подписка без срока
//       плюс private receipt в одной транзакции. Повтор выдаёт granted=false;
//       profiles/premium_until и правила лимита не меняются.
//   • status canceled → ещё не оплаченную (pending) подписку в cancelled;
//   • прочие статусы  → 200, игнорируем.
//
// Поиск подписки — по provider_payment_id (его проставляет /payment/create).
// Если не нашли — fallback по metadata.subscription_id из ВЕРИФИЦИРОВАННОГО
// платежа. Полный промах → 200 { ok:false }, НЕ 500.
// Проверили, но условия не сошлись (mismatch) → 200 { ok:false } без активации.
// Сбой БД → 500, чтобы ЮKassa повторила уведомление.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { PLAN_PRICING, type PaymentPlan, type YooKassaPayment } from "./yookassa";

const SUB_COLS = "id, user_id, plan, status, starts_at, expires_at, provider, provider_payment_id";

type SubRow = {
  id: string;
  user_id: string;
  plan: "single" | "unlimited";
  status: string;
  starts_at: string | null;
  expires_at: string | null;
  provider: string | null;
  provider_payment_id: string | null;
};

export type Outcome = { http: number; body: Record<string, unknown> };

/** Ответ public.grant_unlimited_payment(). */
type GrantResult = {
  ok?: boolean;
  granted?: boolean;
  reason?: string;
  activated_at?: string | null;
  premium_until?: string | null;
  status?: string;
};

// Сумма из ЮKassa сходится с серверной ценой тарифа (защита от подмены цены).
export function amountMatches(
  plan: PaymentPlan,
  value: string,
  currency: string
): boolean {
  if (currency !== "RUB") return false;
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return false;
  const [whole, fractional = ""] = value.split(".");
  const kopecks = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(kopecks) && kopecks === PLAN_PRICING[plan].amount * 100;
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

// Точка входа для webhook: платёж уже перезапрошен у ЮKassa (телу уведомления
// не доверяем). Активация — только при status succeeded И paid.
export async function handleVerifiedPayment(
  admin: SupabaseClient,
  payment: YooKassaPayment
): Promise<Outcome> {
  if (payment.status === "succeeded" && payment.paid) {
    return handleVerifiedSucceeded(admin, payment);
  }
  if (payment.status === "canceled") {
    return handleCanceled(admin, payment);
  }
  // pending / waiting_for_capture / прочее — оплата не подтверждена, не активируем.
  return { http: 200, body: { ok: true, ignored: true, status: payment.status } };
}

// Оставшиеся сверки (план/сумма/привязка) против верифицированного платежа, и
// лишь затем активация.
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

  if (sub.provider !== "yookassa" ||
      (sub.provider_payment_id !== null && sub.provider_payment_id !== payment.id)) {
    return { http: 200, body: { ok: false, reason: "payment_mismatch" } };
  }
  if (sub.plan !== "single" && sub.plan !== "unlimited") {
    return { http: 200, body: { ok: false, reason: "plan_mismatch" } };
  }

  // Источник правды о тарифе — sub.plan из БД. metadata.plan платежа проверяем
  // ТОЛЬКО как мягкую сверку и ТОЛЬКО если он реально пришёл. Если metadata
  // пустая (старый платёж/деплой, где plan не ушёл) — не блокируем: ниже сумма
  // сверяется против sub.plan, и этого достаточно для активации.
  if (metaPlan && metaPlan !== sub.plan) {
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
    ? activateUnlimited(admin, sub, payment.id)
    : activateSingle(admin, sub, payment.id);
}

// PostgREST: функции нет в схеме (миграция не применена) / PostgreSQL: undefined_function.
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

// unlimited — +30 дней к оплаченному сроку. Всё решает БД одной транзакцией (см.
// шапку файла и миграцию). Ошибка вызова → 500: ЮKassa повторит уведомление, а
// повтор после уже зафиксированной выдачи ничего не начислит.
async function activateUnlimited(
  admin: SupabaseClient,
  sub: SubRow,
  paymentId: string
): Promise<Outcome> {
  const { data, error } = await admin.rpc("grant_unlimited_payment", {
    p_subscription_id: sub.id,
    p_payment_id: paymentId,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] unlimited grant error", error);
    return {
      http: 500,
      body: {
        ok: false,
        error: isMissingFunction(error) ? "migration_missing" : "grant_failed",
      },
    };
  }

  const r = data as GrantResult | null;
  if (!r || r.ok !== true) {
    // Отказ БД (платёж не подходит подписке и т.п.) → 200 без активации;
    // неожиданный ответ → 500, чтобы ЮKassa повторила уведомление.
    const malformed = !r || typeof r !== "object" || typeof r.ok !== "boolean";
    // eslint-disable-next-line no-console
    console.error("[payment/webhook] unlimited grant not applied", {
      paymentId,
      subId: sub.id,
      result: data,
    });
    return malformed
      ? { http: 500, body: { ok: false, error: "grant_failed" } }
      : { http: 200, body: { ok: false, reason: r.reason ?? "grant_refused" } };
  }

  return {
    http: 200,
    body: {
      ok: true,
      subscriptionId: sub.id,
      plan: "unlimited",
      status: "active",
      granted: r.granted === true,
      expiresAt: r.premium_until ?? null,
    },
  };
}

// The single credit and its receipt are committed together under a row lock.
// A retry after an uncertain response cannot reactivate an expired legacy credit
// or attach a second provider payment to the same local order.
async function activateSingle(
  admin: SupabaseClient,
  sub: SubRow,
  paymentId: string
): Promise<Outcome> {
  const { data, error } = await admin.rpc("grant_single_payment", {
    p_subscription_id: sub.id,
    p_payment_id: paymentId,
  });
  if (error) return {
    http: 500,
    body: { ok: false, error: isMissingFunction(error) ? "migration_missing" : "grant_failed" },
  };
  const r = data as GrantResult | null;
  if (!r || typeof r.ok !== "boolean") {
    return { http: 500, body: { ok: false, error: "grant_failed" } };
  }
  if (!r.ok) return { http: 200, body: { ok: false, reason: r.reason ?? "grant_refused" } };
  return {
    http: 200,
    body: { ok: true, subscriptionId: sub.id, plan: "single", status: r.status ?? (r.granted === true ? "active" : sub.status), granted: r.granted === true },
  };
}

async function handleCanceled(
  admin: SupabaseClient,
  payment: YooKassaPayment
): Promise<Outcome> {
  const { sub, dbError } = await findSubscription(admin, payment.id, payment.metadata?.subscription_id);
  if (dbError) return { http: 500, body: { ok: false, error: "db_error" } };
  if (!sub) return { http: 200, body: { ok: false, reason: "subscription_not_found" } };
  if (sub.provider !== "yookassa" ||
      (sub.provider_payment_id !== null && sub.provider_payment_id !== payment.id)) {
    return { http: 200, body: { ok: false, reason: "payment_mismatch" } };
  }
  if (payment.metadata?.subscription_id && payment.metadata.subscription_id !== sub.id) {
    return { http: 200, body: { ok: false, reason: "subscription_mismatch" } };
  }
  if (payment.metadata?.plan && payment.metadata.plan !== sub.plan) {
    return { http: 200, body: { ok: false, reason: "plan_mismatch" } };
  }
  if (!amountMatches(sub.plan, payment.amount.value, payment.amount.currency)) {
    return { http: 200, body: { ok: false, reason: "amount_mismatch" } };
  }
  // The RPC rechecks binding under the same row lock as grant_single_payment /
  // grant_unlimited_payment. A stale cancellation cannot overwrite active rights.
  const { data, error } = await admin.rpc("cancel_pending_payment", {
    p_subscription_id: sub.id,
    p_payment_id: payment.id,
  });
  if (error) return {
    http: 500,
    body: { ok: false, error: isMissingFunction(error) ? "migration_missing" : "cancel_failed" },
  };
  const r = data as { ok?: boolean; reason?: string; status?: string } | null;
  if (!r || typeof r.ok !== "boolean" || (r.ok && typeof r.status !== "string")) {
    return { http: 500, body: { ok: false, error: "cancel_failed" } };
  }
  return r.ok
    ? { http: 200, body: { ok: true, subscriptionId: sub.id, status: r.status } }
    : { http: 200, body: { ok: false, reason: r.reason ?? "cancel_refused" } };
}
