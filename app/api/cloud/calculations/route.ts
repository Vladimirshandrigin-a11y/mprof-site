import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// GET /api/cloud/calculations  — серверный прокси чтения истории расчётов.
//
// Браузер из РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS),
// где прямой маршрут виснет без ответа. Сервер сам обращается к Supabase.
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём из токена,
// фильтруем .eq("user_id", userId) — чужие данные не отдаём.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  const { data, error } = await admin
    .from("calculations")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/calculations] supabase error", error);
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
