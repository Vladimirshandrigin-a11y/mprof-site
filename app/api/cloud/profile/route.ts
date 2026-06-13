import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// GET /api/cloud/profile  — серверный прокси чтения профиля пользователя
// (plan / premium_until / calculations_used). Браузер РФ без VPN ходит сюда
// (Timeweb), а не напрямую в Supabase (AWS), где прямой маршрут виснет.
//
// Это ключ к симптому «после reload подписка/доступ слетает»: useEntitlements
// читает профиль на маунте; прямой запрос висел → entitlements падали в free.
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена (admin.auth.getUser) и фильтруем .eq("id", userId) — чужой профиль
// не отдаём.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/profile] supabase error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка чтения профиля" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { data: data ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
