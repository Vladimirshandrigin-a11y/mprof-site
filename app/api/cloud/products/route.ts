import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// GET /api/cloud/products  — серверный прокси чтения каталога товаров
// (себестоимость). Браузер РФ без VPN ходит сюда (Timeweb), а не напрямую в
// Supabase (AWS).
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём из токена,
// фильтруем .eq("user_id", userId) — чужие данные не отдаём.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { data, error } = await admin
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/products] supabase error", error);
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
