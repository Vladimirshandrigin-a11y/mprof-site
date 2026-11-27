import { attributionOf, safePath, safeReferrer, validClientId } from "../../../analytics/model";
import { analyticsRefused, metrikaConfig, readAnalyticsBody, sameOriginAnalytics, sendMetric } from "../../../analytics/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  const config = metrikaConfig();
  if (!config || !sameOriginAnalytics(request) || analyticsRefused(request)) return done();
  const body = await readAnalyticsBody(request);
  const path = safePath(body?.path);
  if (path && validClientId(body?.clientId)) {
    await sendMetric(config, { type: "view", clientId: body.clientId, path,
      source: attributionOf(body.source), referrer: safeReferrer(body.referrer) });
  }
  return done();
}
