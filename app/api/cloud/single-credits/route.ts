import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// GET /api/cloud/single-credits  — серверный прокси: сколько ОПЛАЧЕННЫХ разовых
// расчётов (тариф single, статус active) есть у пользователя. Каждая такая
// строка = +1 расчёт сверх бесплатного лимита. Браузер РФ без VPN ходит сюда
// (Timeweb), а не напрямую в Supabase (AWS).
//
// Часть пути «доступ слетает после reload»: useEntitlements считает кредиты на
// маунте; прямой запрос к Supabase висел → доступ падал в free.
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена и фильтруем .eq("user_id", userId) — чужие кредиты не считаем.
// Ответ: { count }. Сбой на клиенте трактуется как 0 (fail-closed).
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { count, error } = await admin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("plan", "single")
    .eq("status", "active");

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/single-credits] supabase error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка чтения кредитов" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { count: count ?? 0 },
    { headers: { "Cache-Control": "no-store" } }
  );
}
