import { validClientId } from "../../../analytics/model";
import { analyticsRefused, metrikaConfig, readAnalyticsBody, sameOriginAnalytics } from "../../../analytics/server";
import { getSupabaseAdmin } from "../../payment/_lib/supabase-admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!metrikaConfig() || !sameOriginAnalytics(request)) return new Response(null, { status: 404 });
  const body = await readAnalyticsBody(request);
  const admin = getSupabaseAdmin();
  if (!body || !admin) return new Response(null, { status: 503 });
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token && body.allowed === false && validClientId(body.clientId)) {
    const { error } = await admin.from("metrika_consent").delete().eq("client_id", body.clientId);
    return new Response(null, { status: error ? 503 : 204 });
  }
  if (!token) return new Response(null, { status: 401 });
  const { data, error } = await admin.auth.getUser(token);
  const user = data.user;
  if (error || !user) return new Response(null, { status: 401 });
  const allowed = body.allowed === true && !analyticsRefused(request);
  if (!allowed) {
    const result = await admin.from("metrika_consent").delete().eq("user_id", user.id);
    return new Response(null, { status: result.error ? 503 : 204 });
  }
  if (!validClientId(body.clientId)) return new Response(null, { status: 400 });
  const confirmed = user.email_confirmed_at;
  const accountAge = Date.now() - Date.parse(user.created_at);
  const register = body.registration === true && !!confirmed && accountAge >= 0 && accountAge < 7 * 86400_000;
  const result = await admin.rpc("register_metrika_consent", {
    p_user_id: user.id, p_client_id: body.clientId,
    p_signup_confirmed_at: register ? confirmed : null,
  });
  return new Response(null, { status: result.error ? 503 : 204 });
}
