// ============================================================================
// СЕРВЕРНЫЙ helper ЮKassa.
//
// БЕЗОПАСНОСТЬ:
//   • YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY читаются ТОЛЬКО на сервере —
//     без NEXT_PUBLIC. В клиентский бандл Next.js их не инлайнит.
//   • Этот модуль импортируется только из серверных route-хендлеров
//     (app/api/payment/*). Никогда не импортировать в клиентские компоненты.
//
// Реальный вызов ЮKassa (createYooKassaPayment) выполняется ТОЛЬКО когда
// isYooKassaConfigured() === true. Пока ключей нет — каркас просто сообщает
// «ЮKassa не настроена», без сетевых запросов.
// ============================================================================

import { randomUUID } from "crypto";

const YOOKASSA_API = "https://api.yookassa.ru/v3/payments";
const REQUEST_TIMEOUT_MS = 20000;

// Локальный тип (не тянем из "use client"-модуля, чтобы серверный код был
// самодостаточным). Совпадает с SubscriptionPlan в supabase-cloud.ts.
export type PaymentPlan = "single" | "unlimited";

// Цены тарифов — ЕДИНСТВЕННЫЙ источник правды на сервере. Сумму с клиента
// никогда не принимаем (иначе можно подделать цену).
export const PLAN_PRICING: Record<
  PaymentPlan,
  { amount: number; description: string }
> = {
  single: { amount: 149, description: "M-Prof — Разовый расчёт" },
  unlimited: { amount: 449, description: "M-Prof — Безлимит (30 дней)" },
};

export function isYooKassaConfigured(): boolean {
  return Boolean(
    process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY
  );
}

function getConfig(): { shopId: string; secretKey: string } | null {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) return null;
  return { shopId, secretKey };
}

export interface CreatePaymentInput {
  plan: PaymentPlan;
  /** Куда ЮKassa вернёт пользователя после оплаты. */
  returnUrl: string;
  /** Ключ идемпотентности — защищает от двойного списания при ретраях. */
  idempotenceKey?: string;
  /** Прокидывается в платёж и приходит обратно в webhook. */
  metadata?: Record<string, string>;
}

export interface CreatePaymentResult {
  ok: boolean;
  paymentId?: string;
  confirmationUrl?: string;
  status?: string;
  error?: string;
}

// Реальный POST в ЮKassa v3. Basic-auth (shopId:secretKey), заголовок
// Idempotence-Key обязателен. Возвращает confirmation_url для редиректа.
export async function createYooKassaPayment(
  input: CreatePaymentInput
): Promise<CreatePaymentResult> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, error: "ЮKassa не настроена" };

  const pricing = PLAN_PRICING[input.plan];
  const auth = Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(YOOKASSA_API, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Idempotence-Key": input.idempotenceKey || randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { value: pricing.amount.toFixed(2), currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: input.returnUrl },
        description: pricing.description,
        metadata: input.metadata ?? {},
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error("[yookassa] upstream error", res.status, raw.slice(0, 300));
      return { ok: false, error: `ЮKassa ответила статусом ${res.status}` };
    }

    const data = JSON.parse(raw) as {
      id?: string;
      status?: string;
      confirmation?: { confirmation_url?: string };
    };
    const confirmationUrl = data.confirmation?.confirmation_url;
    if (!data.id || !confirmationUrl) {
      return { ok: false, error: "ЮKassa вернула неполный ответ" };
    }
    return {
      ok: true,
      paymentId: data.id,
      confirmationUrl,
      status: data.status,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "сеть недоступна";
    return { ok: false, error: `ЮKassa недоступна: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// getYooKassaPayment — АВТОРИТЕТНОЕ состояние платежа.
//
// Webhook НЕ доверяет телу уведомления (его может подделать кто угодно). Он берёт
// из тела только payment.id и перепроверяет факт оплаты здесь — прямым GET к API
// ЮKassa под Basic-auth. Возвращает нормализованный объект (status / paid / amount
// / metadata), по которому webhook решает, активировать ли подписку.
// ============================================================================
export interface YooKassaPayment {
  id: string;
  /** "pending" | "waiting_for_capture" | "succeeded" | "canceled". */
  status: string;
  /** true только когда деньги реально захвачены. */
  paid: boolean;
  amount: { value: string; currency: string };
  metadata: Record<string, string>;
}

export interface FetchPaymentResult {
  ok: boolean;
  payment?: YooKassaPayment;
  error?: string;
}

export async function getYooKassaPayment(
  paymentId: string
): Promise<FetchPaymentResult> {
  const cfg = getConfig();
  if (!cfg) return { ok: false, error: "ЮKassa не настроена" };

  const auth = Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${YOOKASSA_API}/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error("[yookassa] get payment error", res.status, raw.slice(0, 300));
      return { ok: false, error: `ЮKassa ответила статусом ${res.status}` };
    }

    const data = JSON.parse(raw) as {
      id?: string;
      status?: string;
      paid?: boolean;
      amount?: { value?: string; currency?: string };
      metadata?: Record<string, string>;
    };
    if (!data.id || typeof data.status !== "string" || !data.amount) {
      return { ok: false, error: "ЮKassa вернула неполный ответ" };
    }
    return {
      ok: true,
      payment: {
        id: data.id,
        status: data.status,
        paid: data.paid === true,
        amount: {
          value: String(data.amount.value ?? ""),
          currency: String(data.amount.currency ?? ""),
        },
        metadata: data.metadata ?? {},
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "сеть недоступна";
    return { ok: false, error: `ЮKassa недоступна: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}
