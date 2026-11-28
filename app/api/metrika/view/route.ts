import { attributionOf, clientIdForConsent, safePath, safeReferrer } from "../../../analytics/model";
import { analyticsRefused, metrikaConfig, readAnalyticsBody, sameOriginAnalytics, sendMetric } from "../../../analytics/server";
import { getSupabaseAdmin } from "../../payment/_lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  const config = metrikaConfig();
  if (!config || !sameOriginAnalytics(request) || analyticsRefused(request)) return done();
  const body = await readAnalyticsBody(request);
  const path = safePath(body?.path);
  if (!path || !body) return done();
  const clientId = await clientIdForConsent(body.proof);
  const admin = getSupabaseAdmin();
  if (!clientId || !admin) return done();
  const revoked = await admin.from("metrika_revoked_clients").select("client_id").eq("client_id", clientId).maybeSingle();
  if (revoked.error || revoked.data) return done();
  await sendMetric(config, { type: "view", clientId, path,
    source: attributionOf(body.source), referrer: safeReferrer(body.referrer) });
  return done();
}
