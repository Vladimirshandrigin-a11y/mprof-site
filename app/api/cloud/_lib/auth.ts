import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Общий хелпер аутентификации для cloud-proxy routes (/api/cloud/*).
//
// Зачем отдельная копия getSupabaseAdmin (а не импорт из payment/_lib): cloud
// остаётся самодостаточным модулем, платёжный код не редактируем.
//
// БЕЗОПАСНОСТЬ:
//   • SUPABASE_SERVICE_ROLE_KEY — СЕРВЕРНЫЙ секрет (без NEXT_PUBLIC).
//     Импортировать ТОЛЬКО в серверных route-хендлерах. Никогда в клиент.
//   • service-role ОБХОДИТ RLS, поэтому каждый route ОБЯЗАН вручную
//     фильтровать запрос по user_id (.eq("user_id", userId)).
//   • user_id берётся ТОЛЬКО из проверенного токена (admin.auth.getUser),
//     никогда из тела/параметров запроса — иначе можно прочитать чужие данные.
// ============================================================================

/** service-role клиент или null, если env не настроен (route отдаёт 503). */
export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AuthSuccess = {
  ok: true;
  admin: SupabaseClient;
  userId: string;
};

export type AuthFailure = {
  ok: false;
  response: NextResponse;
};

/**
 * Аутентификация cloud-proxy запроса. Никогда не бросает.
 *   1. service-role клиент (или 503, если env нет);
 *   2. Authorization: Bearer <jwt> (или 401);
 *   3. admin.auth.getUser(token) → user_id ИЗ ТОКЕНА (невалид → 401).
 * При успехе возвращает { ok:true, admin, userId }, иначе { ok:false, response }.
 */
export async function authenticateRequest(
  req: NextRequest
): Promise<AuthSuccess | AuthFailure> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Supabase service role не настроен (SUPABASE_SERVICE_ROLE_KEY)",
          code: "service_role_missing",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      ),
    };
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Требуется авторизация" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      ),
    };
  }

  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Недействительная сессия" },
          { status: 401, headers: { "Cache-Control": "no-store" } }
        ),
      };
    }
    return { ok: true, admin, userId: data.user.id };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Не удалось проверить сессию" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      ),
    };
  }
}
