import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, getUserScopedClient } from "../_lib/auth";
import { buildFinancialSummary, parseSummaryQuery } from "../../../app/lib/financial-summary";
import type { CloudCalculation } from "../../../app/lib/supabase-cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };
const PAGE_SIZE = 100;

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const summaryQuery = parseSummaryQuery(await req.json().catch(() => null));
  if (!summaryQuery) {
    return NextResponse.json({ error: "Некорректные параметры сводки" }, { status: 400, headers: HEADERS });
  }

  const { userId } = auth;
  const token = req.headers.get("authorization")?.slice(7).trim() ?? "";
  const client = getUserScopedClient(token);
  if (!client) {
    return NextResponse.json({ error: "Финансовая сводка временно недоступна" },
      { status: 503, headers: HEADERS });
  }
  const rows: CloudCalculation[] = [];
  let cursor: string | undefined;
  // Page by a unique ID. A short response can be a PostgREST row-limit,
  // so only an empty page ends the scan. Never return a partial total.
  for (;;) {
    let page = client.from("calculations").select(
      "id,mode,marketplace,created_at,ai_insights,revenue,profit,margin,cost,total_expenses,commission,tax,storage,logistics,ads,other_expenses"
    ).eq("user_id", userId).order("id").limit(PAGE_SIZE);
    if (cursor) page = page.gt("id", cursor);
    const { data, error } = await page.abortSignal(req.signal);
    if (error || !data) {
      return NextResponse.json({ error: "Не удалось загрузить полную финансовую сводку" },
        { status: 502, headers: HEADERS });
    }
    if (data.length === 0) break;
    const last = data[data.length - 1].id;
    if (cursor === last) {
      return NextResponse.json({ error: "Не удалось загрузить полную финансовую сводку" },
        { status: 502, headers: HEADERS });
    }
    rows.push(...data as CloudCalculation[]);
    cursor = last;
  }

  return NextResponse.json({ data: buildFinancialSummary(rows, summaryQuery) }, { headers: HEADERS });
}
