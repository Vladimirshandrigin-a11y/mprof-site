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
//   • single    → подписку в active БЕЗ срока (expires_at=null) и БЕЗ записи в
//       profiles. Один оплаченный разовый расчёт = сама active single-подписка;
//       useEntitlements/consume_calculation считают их как +1 к лимиту. Повтор
//       просто ещё раз ставит active (no-op) и НЕ начисляет лишних расчётов.
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

const SUB_COLS = "id, user_id, plan, status, starts_at, expires_at";

type SubRow = {
  id: string;
  user_id: string;
  plan: "single" | "unlimited";
  status: string;
  starts_at: string | null;
  expires_at: string | null;
};

export type Outcome = { http: number; body: Record<string, unknown> };

/** Ответ public.grant_unlimited_payment(). */
type GrantResult = {
  ok?: boolean;
  granted?: boolean;
  reason?: string;
  activated_at?: string | null;
  premium_until?: string | null;
};

// Сумма из ЮKassa сходится с серверной ценой тарифа (защита от подмены цены).
export function amountMatches(
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
    return handleCanceled(admin, payment.id, payment.metadata?.subscription_id);
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
    : activateSingle(admin, sub);
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
