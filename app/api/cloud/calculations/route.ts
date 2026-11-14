import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../_lib/auth";
import { parseCalculationEdit } from "../_lib/calculation-edit";

// ============================================================================
// /api/cloud/calculations  — серверный прокси для истории расчётов.
//   GET   — чтение (история);
//   POST  — закрыт: новый расчёт только через атомарную операцию;
//   PATCH — согласованная правка расчёта и истории через RPC.
//
// Браузер из РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS),
// где прямой маршрут виснет/рвётся («Failed to fetch»). Сервер сам обращается
// к Supabase.
//
// Авторизация: Authorization: Bearer <access_token>. user_id берём ТОЛЬКО из
// токена (не из тела) и фильтруем/пишем по нему — чужие данные не трогаем.
//
// Расчёты Ozon API (mode 'api') пишет ТОЛЬКО сервер (/api/ozon/save-calculation):
// здесь такую строку нельзя ни создать, ни изменить — иначе клиент мог бы выдать
// свои числа за проверенный сервером API-расчёт. Та же граница — в RLS (миграция
// 20260929).
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

// New calculations must use an atomic, metered operation.
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(
    { error: "Для нового расчёта используйте операцию расчёта", code: "calculation_operation_required" },
    { status: 410, headers: NO_STORE }
  );
}

export async function PATCH(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const edit = parseCalculationEdit(body);
  if (!edit) return NextResponse.json(
    { error: "Некорректный запрос", code: "bad_request" }, { status: 400, headers: NO_STORE }
  );
  const { data, error } = await auth.admin.rpc("edit_calculation_operation", {
    p_user_id: auth.userId,
    p_calculation_id: edit.id,
    p_calculation: edit.calculation,
    p_history: edit.history,
  });
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883";
    console.error("[api/cloud/calculations] edit RPC failed", error.code);
    return NextResponse.json(
      { error: "Сохранение изменений временно недоступно", code: missing ? "migration_missing" : "rpc_failed" },
      { status: missing ? 503 : 502, headers: NO_STORE }
    );
  }
  if (data?.ok !== true) {
    const reason = typeof data?.reason === "string" ? data.reason : "rpc_failed";
    const status = reason === "not_found" ? 404 : reason === "legacy_read_only" || reason === "api_mode_forbidden" ? 403
      : reason === "source_conflict" || reason === "history_missing" ? 409 : reason === "bad_request" ? 400 : 502;
    return NextResponse.json({
      code: reason,
      error: reason === "legacy_read_only"
        ? "Редактирование этого исторического расчёта временно недоступно. Исходные данные сохранены"
        : reason === "source_conflict" ? "Исходные данные изменились — выполните новый расчёт"
        : "Не удалось сохранить изменения расчёта",
    }, { status, headers: NO_STORE });
  }
  return NextResponse.json({ data: data.calculation }, { headers: NO_STORE });
}
