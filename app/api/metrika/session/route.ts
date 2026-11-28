import { clientIdForConsent } from "../../../analytics/model";
import { analyticsRefused, metrikaConfig, readAnalyticsBody, sameOriginAnalytics } from "../../../analytics/server";
import { getSupabaseAdmin } from "../../payment/_lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!metrikaConfig() || !sameOriginAnalytics(request)) return new Response(null, { status: 404 });
  const body = await readAnalyticsBody(request);
  const admin = getSupabaseAdmin();
  if (!body || !admin) return new Response(null, { status: 503 });
  const clientId = await clientIdForConsent(body.proof);
  if (!clientId) return new Response(null, { status: 400 });
  if (body.allowed === false || (body.allowed === true && analyticsRefused(request))) {
    const { error } = await admin.rpc("revoke_metrika_consent", { p_client_id: clientId });
    return new Response(null, { status: error ? 503 : 204 });
  }
  if (body.allowed !== true) return new Response(null, { status: 400 });
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return new Response(null, { status: 401 });
  const { data, error } = await admin.auth.getUser(token);
  const user = data.user;
  if (error || !user) return new Response(null, { status: 401 });
  const confirmed = user.email_confirmed_at;
  const accountAge = Date.now() - Date.parse(user.created_at);
  const registration = body.registration === true && accountAge >= 0 && accountAge < 7 * 86400_000;
  const waitingForConfirmation = registration && !confirmed;
  const result = await admin.rpc("register_metrika_consent", {
    p_user_id: user.id, p_client_id: clientId,
    p_signup_confirmed_at: registration ? confirmed ?? null : null,
  });
  if (result.error) return new Response(null, { status: 503 });
  return new Response(null, { status: waitingForConfirmation ? 202 : 204 });
}
