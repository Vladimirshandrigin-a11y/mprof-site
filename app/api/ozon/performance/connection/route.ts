import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../../cloud/_lib/auth";
import {
  encryptOzonApiKey,
  isEncryptionConfigured,
  last4,
} from "../../_lib/crypto";
import { verifyPerformanceToken } from "../../_lib/performance";
import {
  PERF_SAFE_COLUMNS,
  toPerfConnectionView,
  type PerfConnectionRow,
} from "../../_lib/performance";

// ============================================================================
// /api/ozon/performance/connection — безопасное подключение Ozon PERFORMANCE API
// (реклама/продвижение). FOUNDATION (PR #43): только хранение кредов + проверка
// токена. Рекламные отчёты/кампании/статистику здесь НЕ тянем и в расчёт прибыли
// НИЧЕГО не добавляем.
//   GET    — статус подключения (без секрета);
//   POST   — подключить: {clientId, clientSecret} → проверка токена → шифрование → сохранение;
//   DELETE — отключить.
//
// Отдельная таблица ozon_performance_connections (НЕ ozon_connections), чтобы не
// рисковать текущим Seller-подключением. Шифрование — та же AES-256-GCM логика
// (OZON_KEYS_ENC_SECRET). client_secret и access_token НИКОГДА не уходят в ответ и
// не логируются. user_id берём ТОЛЬКО из токена (authenticateRequest).
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const MIN_CLIENT_ID_LEN = 3;
const MIN_CLIENT_SECRET_LEN = 20;

// GET — статус. НИКОГДА не возвращает секрет (ни сырой, ни зашифрованный).
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { data, error } = await admin
    .from("ozon_performance_connections")
    .select(PERF_SAFE_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/performance/connection] select error", error);
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    toPerfConnectionView(data as PerfConnectionRow | null),
    { headers: NO_STORE }
  );
}

// POST — подключить: {clientId, clientSecret}. Проверяем токен → шифруем → сохраняем.
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      {
        error: "Шифрование ключей не настроено на сервере",
        code: "encryption_misconfigured",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  let body: { clientId?: unknown; clientSecret?: unknown };
  try {
    body = (await req.json()) as { clientId?: unknown; clientSecret?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret =
    typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";

  if (
    clientId.length < MIN_CLIENT_ID_LEN ||
    clientSecret.length < MIN_CLIENT_SECRET_LEN
  ) {
    return NextResponse.json(
      { error: "Укажите корректные Client ID и Client Secret Performance API" },
      { status: 400, headers: NO_STORE }
    );
  }

  // Проверяем креды ДО сохранения (получаем access_token, но НЕ храним его).
  const verdict = await verifyPerformanceToken(clientId, clientSecret);

  // Заведомо неверные креды НЕ храним. forbidden/unavailable сохраняем: креды
  // опознаны / временный сбой — пользователь сможет «Проверить» позже.
  if (verdict.status === "invalid_key") {
    return NextResponse.json(
      {
        error: verdict.detail ?? "Неверный Client ID или Client Secret",
        status: "invalid_key",
      },
      { status: 400, headers: NO_STORE }
    );
  }

  const row = {
    user_id: userId,
    client_id: clientId,
    client_secret_encrypted: encryptOzonApiKey(clientSecret),
    secret_last4: last4(clientSecret),
    status: verdict.status,
    last_checked_at: new Date().toISOString(),
    last_error: verdict.detail ?? null,
  };

  const { data, error } = await admin
    .from("ozon_performance_connections")
    .upsert(row, { onConflict: "user_id" })
    .select(PERF_SAFE_COLUMNS)
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/performance/connection] upsert error", error);
    return NextResponse.json(
      { error: "Не удалось сохранить подключение" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(toPerfConnectionView(data as PerfConnectionRow), {
    headers: NO_STORE,
  });
}

// DELETE — отключить. user_id строго из токена, не из тела.
export async function DELETE(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { error } = await admin
    .from("ozon_performance_connections")
    .delete()
    .eq("user_id", userId);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/performance/connection] delete error", error);
    return NextResponse.json(
      { error: "Не удалось удалить подключение" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { connected: false, status: "not_connected" },
    { headers: NO_STORE }
  );
}
