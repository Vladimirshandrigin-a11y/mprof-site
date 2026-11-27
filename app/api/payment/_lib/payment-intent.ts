import type { YooKassaPayment, PaymentPlan } from "./yookassa";
import { PLAN_PRICING } from "./yookassa";

export const PAYMENT_INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PaymentIntentClaim = {
  ok?: boolean; reason?: string; action?: "create" | "lookup" | "wait" | "reconcile";
  subscription_id?: string; provider_key?: string; provider_payment_id?: string | null;
  lease_token?: string | null; return_url?: string;
};
export function paymentMatchesIntent(payment: YooKassaPayment, plan: PaymentPlan,
  subscriptionId: string, intentId: string): boolean {
  return payment.amount.currency === "RUB"
    && payment.amount.value === PLAN_PRICING[plan].amount.toFixed(2)
    && payment.metadata.subscription_id === subscriptionId
    && payment.metadata.plan === plan && payment.metadata.intent_id === intentId;
}
export function safeConfirmationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
