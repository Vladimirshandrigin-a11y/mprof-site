import { PAY_MSG, paymentCreateOutcome, type PaymentCreateOutcome } from "./payment-create-result";

export type CheckoutPlan = "single" | "unlimited";
type TerminalState = "canceled" | "succeeded";
type StoredIntent = { v: 1; id: string; plan: CheckoutPlan; state: "open" | TerminalState };
export type IntentStorage = Pick<Storage, "getItem" | "setItem">;
export type CheckoutSession = { userId: string; token: string };
export type CheckoutAction = { busy: true } | { outcome: PaymentCreateOutcome };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function key(userId: string, plan: CheckoutPlan) {
  return `mprof:checkout-intent:v1:${userId}:${plan}`;
}

function read(storage: IntentStorage, userId: string, plan: CheckoutPlan): StoredIntent | null {
  const raw = storage.getItem(key(userId, plan));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid_intent_storage");
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || r.plan !== plan || typeof r.id !== "string" || !UUID.test(r.id)
    || !["open", "canceled", "succeeded"].includes(String(r.state))) {
    throw new Error("invalid_intent_storage");
  }
  return r as StoredIntent;
}

function write(storage: IntentStorage, userId: string, intent: StoredIntent) {
  storage.setItem(key(userId, intent.plan), JSON.stringify(intent));
  // A denied/quota-limited storage implementation must not silently allow a
  // payment whose retry key disappears on reload. Never fall back to a new ID.
  if (storage.getItem(key(userId, intent.plan)) !== JSON.stringify(intent)) {
    throw new Error("intent_storage_not_persisted");
  }
}

/** One conscious purchase, persisted before the first HTTP request. No secrets
 * or provider URLs are stored. Terminal status is accepted only from the server;
 * a redirect/query parameter never ends or rotates an intent. */
export function createCheckoutController(deps: {
  storage: () => IntentStorage;
  /** Same-origin cross-tab exclusion, held only while touching intent storage. */
  withIntentLock: <T>(scope: string, operation: () => T | Promise<T>) => Promise<T>;
  createId: () => string;
  getSession: () => Promise<CheckoutSession | null>;
  request: (body: { plan: CheckoutPlan; intentId: string }, token: string) => Promise<{ status: number; body: unknown }>;
}) {
  let inFlight = false;
  return {
    async pay(plan: CheckoutPlan, newPurchase = false): Promise<CheckoutAction> {
      if (inFlight) return { busy: true };
      inFlight = true;
      try {
        let session: CheckoutSession | null;
        try { session = await deps.getSession(); } catch { return { outcome: { message: PAY_MSG.failed } }; }
        if (!session?.token || !UUID.test(session.userId)) return { outcome: { message: PAY_MSG.noSession } };
        const userId = session.userId;
        let storage: IntentStorage, intent: StoredIntent;
        try {
          storage = deps.storage();
          const stored = await deps.withIntentLock(key(userId, plan), () => {
            const existing = read(storage, userId, plan);
            if (newPurchase && (!existing || existing.state === "open")) return null;
            if (existing && !newPurchase) return existing;
            const id = deps.createId();
            if (!UUID.test(id)) throw new Error("invalid_generated_intent");
            const created: StoredIntent = { v: 1, id, plan, state: "open" };
            write(storage, userId, created);
            return created;
          });
          if (!stored) return { outcome: { message: PAY_MSG.unresolved } };
          intent = stored;
        } catch { return { outcome: { message: PAY_MSG.storageUnavailable } }; }

        let current: CheckoutSession | null;
        try { current = await deps.getSession(); } catch { current = null; }
        if (!current?.token || current.userId !== userId) {
          return { outcome: { message: PAY_MSG.sessionChanged } };
        }
        let response: { status: number; body: unknown };
        try { response = await deps.request({ plan, intentId: intent.id }, current.token); }
        catch { return { outcome: { message: PAY_MSG.network } }; }
        // Do not expose an old account's checkout URL after sign-out/account
        // switching while the request was in flight. Server authorization still
        // determines order ownership; this check protects the current UI session.
        try { current = await deps.getSession(); } catch { current = null; }
        if (current?.userId !== userId) return { outcome: { message: PAY_MSG.sessionChanged } };
        const outcome = paymentCreateOutcome(response.status, response.body);
        if ("terminal" in outcome && outcome.terminal) {
          const terminal = outcome.terminal;
          try {
            await deps.withIntentLock(key(userId, plan), () => {
              const stored = read(storage, userId, plan);
              // A delayed response for an old payment must never overwrite the
              // new explicit purchase created by another tab in the meantime.
              if (stored?.id === intent.id) write(storage, userId, { ...intent, state: terminal });
            });
          }
          catch { return { outcome: { message: PAY_MSG.storageUnavailable } }; }
        }
        return { outcome };
      } finally { inFlight = false; }
    },
  };
}
