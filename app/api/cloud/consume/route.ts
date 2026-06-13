import { NextRequest, NextResponse } from "next/server";
import { getUserScopedClient } from "../_lib/auth";

// ============================================================================
// POST /api/cloud/consume  — серверный прокси RPC consume_calculation():
// атомарное server-authoritative списание одного расчёта. Браузер РФ без VPN
// ходит сюда (Timeweb), а не напрямую в Supabase (AWS) — прямой RPC висел без
// ответа, из-за чего «бесконечный анализ»: analyzeAllThree ждёт consume и не
// завершается.
//
// ВАЖНО: consume_calculation() в SQL опирается на auth.uid() и выдан роли
// authenticated. Поэтому здесь НЕ service-role, а USER-SCOPED клиент
// (anon-ключ + JWT пользователя), иначе auth.uid()=NULL → not_authenticated.
// user_id из тела НЕ принимаем — его определяет сам RPC из токена.
//
// Ответ RPC — это бизнес-JSON {ok, reason, used, allowance, unlimited}; даже
// «limit_reached» приходит как ok:false с HTTP 200 (это не ошибка сервера).
// HTTP-ошибку (502) отдаём только при реальном сбое RPC.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return NextResponse.json(
      { error: "Требуется авторизация" },
      { status: 401, headers: NO_STORE }
    );
  }

  const client = getUserScopedClient(token);
  if (!client) {
    return NextResponse.json(
      {
        error:
          "Supabase не настроен (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)",
        code: "supabase_env_missing",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  const { data, error } = await client.rpc("consume_calculation");

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/consume] rpc error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка списания расчёта" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json({ data: data ?? null }, { headers: NO_STORE });
}
