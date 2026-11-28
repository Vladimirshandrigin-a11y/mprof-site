export const ANALYTICS_ORIGIN = "https://mprof-seller.ru";
export const ANALYTICS_PREFERENCE = "mprof:analytics:v2";
export const ANALYTICS_CHANGED = "mprof:analytics-changed";
export const ATTRIBUTION_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "yclid"] as const;
export type Attribution = Partial<Record<(typeof ATTRIBUTION_FIELDS)[number], string>>;
export const CHOICE_ENABLED = process.env.NEXT_PUBLIC_MPROF_METRIKA_ENABLED === "true";
const PATHS = new Set(["/", "/app", "/offer", "/privacy", "/contacts"]);
const REFERRERS = new Set(["yandex.ru", "ya.ru", "www.yandex.ru", "google.com", "www.google.com",
  "www.google.ru", "vk.com", "t.me", "www.bing.com", "duckduckgo.com"]);
const CAMPAIGN_VALUES = new Set((process.env.NEXT_PUBLIC_MPROF_METRIKA_CAMPAIGN_VALUES ?? "")
  .split(",").filter((value) => /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value)));

export function safePath(value: unknown): string | null {
  return typeof value === "string" && PATHS.has(value) ? value : null;
}

export function safeReferrer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && REFERRERS.has(url.hostname) ? url.origin : null;
  } catch { return null; }
}

export function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

// The browser keeps the secret. Only the derived numeric identifier goes to Yandex.
export async function clientIdForConsent(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const number = new DataView(digest).getBigUint64(0) % BigInt("1000000000000000000");
  return `1${number.toString().padStart(18, "0")}`;
}

export function attributionOf(value: unknown, approved: ReadonlySet<string> = CAMPAIGN_VALUES): Attribution {
  const result: Attribution = {};
  if (!value || typeof value !== "object") return result;
  const source = value as Record<string, unknown>;
  for (const field of ATTRIBUTION_FIELDS) {
    const item = source[field];
    if (typeof item !== "string") continue;
    if (field === "yclid" ? /^[1-9][0-9]{14,19}$/.test(item) : approved.has(item)) result[field] = item;
  }
  return result;
}

export function attributePage(path: string, attribution: Attribution): string {
  const url = new URL(safePath(path) ?? "/", ANALYTICS_ORIGIN);
  for (const [field, value] of Object.entries(attributionOf(attribution))) url.searchParams.set(field, value);
  return url.href;
}

export const GOALS = {
  registration_confirmed: 0,
  first_free_calculation: 0,
  checkout_started: 0,
  payment_confirmed: 0,
  purchase_149: 149,
  subscription_449: 449,
  subscription_renewed: 449,
  payment_failed: 0,
} as const;

export type Goal = keyof typeof GOALS;

export function validGoal(goal: unknown): goal is Goal {
  return typeof goal === "string" && Object.prototype.hasOwnProperty.call(GOALS, goal);
}
