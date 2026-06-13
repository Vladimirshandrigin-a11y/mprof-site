import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";

// ============================================================================
// /api/cloud/calculations  — серверный прокси для истории расчётов.
//   GET   — чтение (история);
//   POST  — сохранение нового расчёта (insert);
//   PATCH — обновление существующего расчёта (update).
//
// Браузер из РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS),
// где прямой маршрут виснет/рвётся («Failed to fetch»). Сервер сам обращается
// к Supabase.
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена (не из тела) и фильтруем/пишем по нему — чужие данные не трогаем.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Поля, которые клиент НЕ вправе задавать сам (ставит/фильтрует сервер). */
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

// POST — сохранить новый расчёт. Тело = поля calculation (без user_id).
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
    .from("calculations")
    .insert([payload])
    .select()
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/calculations] insert error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка сохранения" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json({ data }, { headers: NO_STORE });
}

// PATCH — обновить существующий расчёт. Тело = { id, fields }.
export async function PATCH(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  let body: { id?: unknown; fields?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; fields?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json(
      { error: "Не указан id записи" },
      { status: 400, headers: NO_STORE }
    );
  }
  const fields =
    body.fields && typeof body.fields === "object"
      ? stripServerFields(body.fields as Record<string, unknown>)
      : {};

  const { data, error } = await admin
    .from("calculations")
    .update(fields)
    .eq("id", id)
    .eq("user_id", userId) // правим только свою строку
    .select()
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/cloud/calculations] update error", error);
    return NextResponse.json(
      { error: error.message || "Ошибка обновления" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json({ data }, { headers: NO_STORE });
}
