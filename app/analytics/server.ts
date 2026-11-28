import { createHmac, timingSafeEqual } from "node:crypto";
import { ANALYTICS_ORIGIN, GOALS, attributePage, safeReferrer, validClientId, validGoal, type Attribution, type Goal } from "./model";

export function metrikaConfig() {
  const id = process.env.MPROF_METRIKA_COUNTER_ID;
  const token = process.env.MPROF_METRIKA_MEASUREMENT_TOKEN;
  if (process.env.MPROF_METRIKA_ENABLED !== "true" || process.env.NEXT_PUBLIC_SITE_URL !== ANALYTICS_ORIGIN ||
      !id || !/^[1-9][0-9]{0,11}$/.test(id) || !token) return null;
  return { id, token };
}

export function sameOriginAnalytics(request: Request) {
  return request.headers.get("origin") === ANALYTICS_ORIGIN
    && request.headers.get("host") === new URL(ANALYTICS_ORIGIN).host;
}

export function analyticsRefused(request: Request) {
  return request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1";
}

export async function readAnalyticsBody(request: Request): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    let raw = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 1500) {
        await reader.cancel();
        return null;
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function isAuthorizedDrain(value: string | null) {
  const key = process.env.MPROF_METRIKA_DRAIN_TOKEN;
  if (!key || key.length < 32 || !value) return false;
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

type View = { type: "view"; clientId: string; path: string; source: Attribution; referrer?: string | null };
type Conversion = { type: "goal"; clientId: string; goal: Goal; eventId: string; time: number; plan?: string | null };
type ConversionResult = "sent" | "uncertain" | "expired" | "rejected";

export function metricParameters(config: { id: string; token: string }, event: View | Conversion) {
  const params = new URLSearchParams({ tid: config.id, ms: config.token, cid: event.clientId });
  if (!validClientId(event.clientId)) throw new Error("invalid_analytics_client");
  if (event.type === "view") {
    params.set("t", "pageview");
    params.set("dl", attributePage(event.path, event.source));
    const referrer = safeReferrer(event.referrer);
    if (referrer) params.set("dr", referrer);
  } else {
    if (!validGoal(event.goal) || !/^[0-9a-f]{64}$/.test(event.eventId)) throw new Error("invalid_analytics_goal");
    params.set("t", "event");
    params.set("dl", `${ANALYTICS_ORIGIN}/app`);
    params.set("ea", event.goal);
    params.set("et", String(event.time));
    const plan = event.plan === "single" || event.plan === "unlimited" ? event.plan : undefined;
    params.set("params", JSON.stringify({ event_id: event.eventId, plan,
      reason: event.goal === "payment_failed" ? "canceled" : undefined }));
    const amount = GOALS[event.goal];
    if (amount) {
      params.set("ev", String(amount));
      params.set("cu", "RUB");
    }
  }
  return params;
}

export function metrikaEventId(key: string, id: string, goal: Goal) {
  return createHmac("sha256", key).update(`metrika:v1:${goal}:${id}`).digest("hex");
}

export async function sendMetric(config: { id: string; token: string }, event: View | Conversion): Promise<ConversionResult> {
  if (event.type === "goal" && Date.now() / 1000 - event.time >= 12 * 3600) return "expired";
  try {
    const response = await fetch("https://mc.yandex.ru/collect", {
      method: "POST", body: metricParameters(config, event), cache: "no-store",
      signal: AbortSignal.timeout(2500), redirect: "error",
    });
    if (response.ok && (await response.text()).trim() === "<!-- OK -->") return "sent";
    return response.status === 400 || response.status === 401 || response.status === 403 ? "rejected" : "uncertain";
  } catch { return "uncertain"; }
}
