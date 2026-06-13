import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// /api/cloud/report-history  — серверный прокси помесячной истории
// («Аналитика по месяцам»).
//   GET  — чтение;
//   POST — сохранение снимка за месяц (insert).
//
// Браузер РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS).
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена (не из тела) и пишем/фильтруем по нему — чужие данные не трогаем.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Поля, которые клиент НЕ вправе задавать сам (ставит сервер). */
function stripServerFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj };
  delete out.user_id;
  delete out.id;
  delete out.created_at;
  return out;
}

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

// POST — сохранить снимок за месяц. Тело = поля report_history (без user_id).
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  // user_id всегда из токена — клиентское значение игнорируем.
  const payload = { ...stripServerFields(body), user_id: userId };

  const { data, error } = await admin
    .from("report_history")
    .insert([payload])
    .select()
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/report-history] insert error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка сохранения" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json({ data }, { headers: NO_STORE });
}
