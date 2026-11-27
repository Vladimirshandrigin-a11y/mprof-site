import { ANALYTICS_CHANGED, ANALYTICS_ORIGIN, ANALYTICS_PREFERENCE, ATTRIBUTION_FIELDS, CHOICE_ENABLED, attributionOf, validClientId, type Attribution } from "./model";

type Preference = { choice: "allow"; clientId: string; attribution: Attribution } | { choice: "deny" };
const SIGNUP_MARKER = "mprof:analytics-signup:v1";

export function analyticsAvailable() {
  return CHOICE_ENABLED && window.location.origin === ANALYTICS_ORIGIN;
}

export function trackingBlocked() {
  return navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

export function readAnalyticsPreference(): Preference | null {
  if (!analyticsAvailable()) return null;
  try { return parseAnalyticsPreference(window.localStorage.getItem(ANALYTICS_PREFERENCE)); }
  catch { return null; }
}

export function parseAnalyticsPreference(raw: string | null): Preference | null {
  try {
    const record = JSON.parse(raw || "null");
    if (record?.choice === "deny") return { choice: "deny" };
    if (record?.choice === "allow" && validClientId(record.clientId)) {
      return { choice: "allow", clientId: record.clientId, attribution: attributionOf(record.attribution) };
    }
  } catch { /* Storage may be unavailable. */ }
  return null;
}

export function chooseAnalytics(allowed: boolean, landing: Attribution) {
  const previous = readAnalyticsPreference();
  const randomId = () => {
    const parts = crypto.getRandomValues(new Uint32Array(2));
    return "1" + Array.from(parts, (value) => String(value % 1_000_000_000).padStart(9, "0")).join("");
  };
  let preference: Preference = { choice: "deny" };
  try {
    if (allowed && !trackingBlocked()) {
      preference = previous?.choice === "allow" ? previous
        : { choice: "allow", clientId: randomId(), attribution: landing };
    }
    window.localStorage.setItem(ANALYTICS_PREFERENCE, JSON.stringify(preference));
    if (preference.choice === "deny") window.localStorage.removeItem(SIGNUP_MARKER);
  } catch { preference = { choice: "deny" }; }
  if (preference.choice === "deny" && previous?.choice === "allow") {
    void fetch("/api/metrika/session", {
      method: "POST", cache: "no-store", credentials: "omit", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed: false, clientId: previous.clientId }),
    }).catch(() => {});
  }
  window.dispatchEvent(new Event(ANALYTICS_CHANGED));
  return preference;
}

export function captureLanding(search: string): Attribution {
  const input = new URLSearchParams(search);
  return attributionOf(Object.fromEntries(ATTRIBUTION_FIELDS.map((field) => [field, input.get(field)])));
}

export function rememberAnalyticsSignup(userId: string) {
  if (readAnalyticsPreference()?.choice !== "allow") return;
  try { window.localStorage.setItem(SIGNUP_MARKER, userId); } catch { /* Optional. */ }
}

export async function syncAnalyticsSession(token: string, userId: string) {
  const preference = readAnalyticsPreference();
  if (!preference) return;
  try {
    const registration = window.localStorage.getItem(SIGNUP_MARKER) === userId;
    const deny = preference.choice === "deny" || trackingBlocked();
    const result = await fetch("/api/metrika/session", {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(deny ? { allowed: false }
        : { allowed: true, clientId: preference.clientId, registration }),
    });
    if (registration && result.ok) window.localStorage.removeItem(SIGNUP_MARKER);
  } catch { /* Optional analytics cannot block authentication or checkout. */ }
}
