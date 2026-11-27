import { validClientId, validGoal } from "../../../analytics/model";
import { isAuthorizedDrain, metrikaConfig, metrikaEventId, sendMetric } from "../../../analytics/server";
import { getSupabaseAdmin } from "../../payment/_lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 30;

type QueuedEvent = { id: string; name: string; plan: string | null; client_id: string; occurred_at: string };

export async function POST(request: Request) {
  const config = metrikaConfig();
  const eventKey = process.env.MPROF_METRIKA_EVENT_KEY;
  if (!config || !eventKey || eventKey.length < 32 || !isAuthorizedDrain(request.headers.get("authorization"))) {
    return new Response(null, { status: 404 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return new Response(null, { status: 503 });
  const pending = await admin.rpc("claim_metrika_events");
  if (pending.error || !Array.isArray(pending.data)) return new Response(null, { status: 503 });
  const summary: Record<string, number> = {};
  for (const event of pending.data as QueuedEvent[]) {
    if (!validGoal(event.name) || !validClientId(event.client_id)) continue;
    const eventId = metrikaEventId(eventKey, event.id, event.name);
    const written = await admin.from("metrika_events").update({ external_id: eventId })
      .eq("id", event.id).eq("state", "sending").select("id").maybeSingle();
    if (written.error || !written.data) continue;
    const result = await sendMetric(config, {
      type: "goal", goal: event.name, plan: event.plan, clientId: event.client_id, eventId,
      time: Math.floor(Date.parse(event.occurred_at) / 1000),
    });
    const finished = await admin.from("metrika_events").update({ state: result })
      .eq("id", event.id).eq("state", "sending");
    const outcome = finished.error ? "uncertain" : result;
    summary[outcome] = (summary[outcome] ?? 0) + 1;
  }
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}
