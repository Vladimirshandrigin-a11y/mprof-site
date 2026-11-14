import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// /api/cloud/report-history  — серверный прокси помесячной истории
// («Аналитика по месяцам»).
//   GET  — чтение;
//   POST — закрыт: история сохраняется только внутри операции расчёта.
//
// Браузер РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS).
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена (не из тела) и пишем/фильтруем по нему — чужие данные не трогаем.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { data, error } = await admin
    .from("report_history")
    .select("*")
    .eq("user_id", userId)
    .order("report_month", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/report-history] supabase error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка чтения данных" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { data: data ?? [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// History is written only together with its calculation, inside operation RPCs.
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(
    { error: "История сохраняется вместе с расчётом", code: "calculation_operation_required" },
    { status: 410, headers: NO_STORE }
  );
}
