import { NextRequest, NextResponse } from "next/server";
import { getUserScopedClient } from "../_lib/auth";
import {
  computeManualColumns,
  manualRequestHash,
  parseManualInputs,
} from "../../../app/lib/calc-operation-keys";

// ============================================================================
// /api/cloud/calculation-operations — операции расчёта по XLSX «Отчёт по
// начислениям» и ручного расчёта: списание попытки и сохранение расчёта ОДНОЙ
// транзакцией БД.
//   POST — выполнить операцию: XLSX (RPC save_calculation_operation) или ручной
//          расчёт, mode "manual" (RPC save_manual_calculation_operation: итог и
//          отпечаток параметров считает сервер из введённых значений). Повтор с тем
//          же operationId (потерянный ответ, двойной клик, перезагрузка) ничего не
//          списывает и не пишет: возвращает сохранённую строку расчёта и признак
//          совпадения данных (contentMatch) или status "deleted", если расчёт удалён
//          из истории; тот же operationId с другими параметрами → 409;
//   GET  — статус операции (RPC calculation_operation_status): для восстановления
//          после перезагрузки страницы (done — с сохранённой строкой; deleted; none).
//
// Как /api/cloud/consume: USER-SCOPED клиент (anon-ключ + JWT пользователя) —
// функции берут пользователя из auth.uid(); user_id из тела не принимаем.
// Нет функции в БД (миграция не применена) → 503 migration_missing: раздельного
// списания «на всякий случай» нет — без миграции сохранение недоступно, попытка не
// списывается.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcError = { code?: string; message?: string } | null;

function bearer(req: NextRequest): string {
  const h = req.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 200;
}

/** Снимок из ai_insights — как есть (JSON-объект) или null. */
function snapshotOf(v: unknown): Record<string, unknown> | null {
  return isObject(v) ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function rpcFailure(error: RpcError, where: string) {
  // PostgREST: функции нет в схеме / PostgreSQL: undefined_function.
  if (error?.code === "PGRST202" || error?.code === "42883") {
    return json({ error: "Сохранение расчёта временно недоступно", code: "migration_missing" }, 503);
  }
  console.error(`[api/cloud/calculation-operations] ${where} rpc error`, error);
  return json({ error: "Ошибка сохранения расчёта", code: "rpc_failed" }, 502);
}

export async function POST(req: NextRequest) {
  const token = bearer(req);
  if (!token) return json({ error: "Требуется авторизация" }, 401);
  const client = getUserScopedClient(token);
  if (!client) {
    return json({ error: "Supabase не настроен", code: "supabase_env_missing" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Некорректный JSON в теле запроса", code: "bad_request" }, 400);
  }
  if (body.mode === "manual") return saveManual(client, body);
  const { operationId, requestHash, calculation, history } = body;
  if (
    typeof operationId !== "string" ||
    !UUID_RE.test(operationId) ||
    !isHash(requestHash) ||
    !isObject(calculation) ||
    !isObject(calculation.ai_insights) ||
    !isObject(history)
  ) {
    return json({ error: "Некорректный запрос", code: "bad_request" }, 400);
  }

  const { data, error } = await client.rpc("save_calculation_operation", {
    p_operation_id: operationId,
    p_mode: "upload",
    p_request_hash: requestHash,
    p_calculation: calculation,
    p_history: history,
  });
  if (error) return rpcFailure(error, "save");
  return operationResponse(data, "Операция не совпадает с этим файлом");
}

/**
 * Ручной расчёт: клиент присылает только введённые значения. Итог (расходы, прибыль,
 * маржа) и отпечаток параметров считает сервер — тот же ключ с другими значениями
 * даёт конфликт, результат не перезаписывается.
 */
async function saveManual(client: NonNullable<ReturnType<typeof getUserScopedClient>>, body: Record<string, unknown>) {
  const { operationId } = body;
  const inputs = parseManualInputs(body.inputs);
  if (typeof operationId !== "string" || !UUID_RE.test(operationId) || !inputs.ok) {
    return json({ error: "Некорректный запрос", code: "bad_request" }, 400);
  }
  const { data, error } = await client.rpc("save_manual_calculation_operation", {
    p_operation_id: operationId,
    p_request_hash: manualRequestHash(inputs.value),
    p_calculation: computeManualColumns(inputs.value),
  });
  if (error) return rpcFailure(error, "save manual");
  return operationResponse(data, "Операция относится к расчёту с другими значениями");
}

/** Ответ RPC операции → HTTP. Отказ в списании и конфликт ничего не записали. */
function operationResponse(data: unknown, conflictMessage: string) {
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.ok !== true) {
    const reason = typeof r.reason === "string" ? r.reason : "rpc_failed";
    if (reason === "not_authenticated") return json({ error: "Сессия недействительна", code: reason }, 401);
    if (reason === "operation_conflict") return json({ error: conflictMessage, code: reason }, 409);
    if (reason === "bad_request") return json({ error: "Некорректный запрос", code: reason }, 400);
    // limit_reached и прочие отказы в списании: ничего не записано.
    return json({ error: "Нет доступной попытки расчёта", code: reason }, 402);
  }

  return json({
    data: {
      status: r.status === "deleted" ? "deleted" : "done",
      replay: r.replay === true,
      mode: typeof r.mode === "string" ? r.mode : null,
      calculationId: typeof r.calculation_id === "string" ? r.calculation_id : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      snapshot: snapshotOf(r.snapshot),
      calculation: snapshotOf(r.calculation),
      contentMatch: r.content_match === true,
      charged: r.charged === true,
      used: typeof r.used === "number" ? r.used : null,
      unlimited: r.unlimited === true,
    },
  });
}

export async function GET(req: NextRequest) {
  const token = bearer(req);
  if (!token) return json({ error: "Требуется авторизация" }, 401);
  const client = getUserScopedClient(token);
  if (!client) {
    return json({ error: "Supabase не настроен", code: "supabase_env_missing" }, 503);
  }

  const operationId = req.nextUrl.searchParams.get("operationId") ?? "";
  const requestHash = req.nextUrl.searchParams.get("requestHash") ?? "";
  if (!UUID_RE.test(operationId) || !isHash(requestHash)) {
    return json({ error: "Некорректный запрос", code: "bad_request" }, 400);
  }

  const { data, error } = await client.rpc("calculation_operation_status", {
    p_operation_id: operationId,
    p_request_hash: requestHash,
  });
  if (error) return rpcFailure(error, "status");

  const r = (data ?? {}) as Record<string, unknown>;
  if (r.ok !== true) return json({ error: "Сессия недействительна", code: "not_authenticated" }, 401);
  const status = r.status === "done" || r.status === "deleted" || r.status === "conflict" ? r.status : "none";
  return json({
    data: {
      status,
      mode: typeof r.mode === "string" ? r.mode : null,
      calculationId: typeof r.calculation_id === "string" ? r.calculation_id : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      snapshot: snapshotOf(r.snapshot),
      calculation: snapshotOf(r.calculation),
    },
  });
}
