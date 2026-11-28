import { ANALYTICS_CHANGED, ANALYTICS_ORIGIN, ANALYTICS_PREFERENCE, ATTRIBUTION_FIELDS, CHOICE_ENABLED, attributionOf, type Attribution } from "./model";

type Preference = { choice: "allow"; proof: string } | { choice: "deny" };
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
    if (record?.choice === "allow" && typeof record.proof === "string" && /^[0-9a-f]{64}$/.test(record.proof)) {
      return { choice: "allow", proof: record.proof };
    }
  } catch { /* Storage may be unavailable. */ }
  return null;
}

export function chooseAnalytics(allowed: boolean) {
  const previous = readAnalyticsPreference();
  let preference: Preference = { choice: "deny" };
  try {
    if (allowed && !trackingBlocked()) {
      const proof = previous?.choice === "allow" ? previous.proof
        : Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      preference = { choice: "allow", proof };
    }
    window.localStorage.setItem(ANALYTICS_PREFERENCE, JSON.stringify(preference));
    if (preference.choice === "deny") window.localStorage.removeItem(SIGNUP_MARKER);
  } catch { preference = { choice: "deny" }; }
  if (preference.choice === "deny" && previous?.choice === "allow") withdrawAnalytics(previous.proof);
  window.dispatchEvent(new Event(ANALYTICS_CHANGED));
  return preference;
}

const WITHDRAWALS = "mprof:analytics-withdrawals:v2";

export function retryAnalyticsWithdrawals() {
  try {
    const pending = Object.keys(JSON.parse(window.localStorage.getItem(WITHDRAWALS) ?? "{}"));
    for (const proof of pending) withdrawAnalytics(proof);
  } catch { /* Browser storage is optional. */ }
}

function withdrawAnalytics(proof: string) {
  try {
    const pending = JSON.parse(window.localStorage.getItem(WITHDRAWALS) ?? "{}");
    pending[proof] = true;
    window.localStorage.setItem(WITHDRAWALS, JSON.stringify(pending));
  } catch { /* Still attempt to withdraw if storage is unavailable. */ }
  void fetch("/api/metrika/session", {
    method: "POST", cache: "no-store", credentials: "omit", keepalive: true,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowed: false, proof }),
  }).then((response) => {
    if (!response.ok) return;
    const pending = JSON.parse(window.localStorage.getItem(WITHDRAWALS) ?? "{}");
    delete pending[proof];
    if (Object.keys(pending).length) window.localStorage.setItem(WITHDRAWALS, JSON.stringify(pending));
    else window.localStorage.removeItem(WITHDRAWALS);
  }).catch(() => {});
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
  if (preference?.choice !== "allow") return;
  if (trackingBlocked()) {
    chooseAnalytics(false);
    return;
  }
  try {
    const registration = window.localStorage.getItem(SIGNUP_MARKER) === userId;
    const result = await fetch("/api/metrika/session", {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ allowed: true, proof: preference.proof, registration }),
    });
    if (registration && result.ok) window.localStorage.removeItem(SIGNUP_MARKER);
  } catch { /* Optional analytics cannot block authentication or checkout. */ }
}
