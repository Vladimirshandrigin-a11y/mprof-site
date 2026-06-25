import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { encryptOzonApiKey, isEncryptionConfigured, last4 } from "../_lib/crypto";
import { verifyOzonKey } from "../_lib/verify";
import { SAFE_COLUMNS, toConnectionView, type OzonConnectionRow } from "../_lib/shape";

// ============================================================================
// /api/ozon/connection — безопасное подключение кабинета Ozon (PR #1).
//   GET    — статус подключения (без ключа);
//   POST   — подключить: {clientId, apiKey} → проверка → шифрование → сохранение;
//   DELETE — отключить кабинет.
//
// Браузер из РФ без VPN ходит сюда (Timeweb), а не напрямую в Supabase (AWS).
// api_key_encrypted и сырой ключ НИКОГДА не уходят в ответ. user_id берём ТОЛЬКО
// из токена (authenticateRequest), не из тела. Это PR #1 — РАСЧЁТА через API тут НЕТ.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const MIN_CLIENT_ID_LEN = 3;
const MIN_API_KEY_LEN = 20;

// GET — статус. НИКОГДА не возвращает ключ (ни сырой, ни зашифрованный).
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { data, error } = await admin
    .from("ozon_connections")
    .select(SAFE_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/connection] select error", error);
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(toConnectionView(data as OzonConnectionRow | null), {
    headers: NO_STORE,
  });
}

// POST — подключить: {clientId, apiKey}. Проверяем ключ → шифруем → сохраняем.
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

  let body: { clientId?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as { clientId?: unknown; apiKey?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (clientId.length < MIN_CLIENT_ID_LEN || apiKey.length < MIN_API_KEY_LEN) {
    return NextResponse.json(
      { error: "Укажите корректные Client ID и API-ключ Ozon" },
      { status: 400, headers: NO_STORE }
    );
  }

  // Проверяем ключ ДО сохранения.
  const verdict = await verifyOzonKey(clientId, apiKey);

  // Заведомо неверные креды НЕ храним — просим ввести заново (нет смысла хранить
  // нерабочий ключ). forbidden/unavailable сохраняем: ключ опознан / временный
  // сбой — пользователь сможет «Проверить» позже.
  if (verdict.status === "invalid_key") {
    return NextResponse.json(
      {
        error: verdict.detail ?? "Неверный Client ID или API-ключ",
        status: "invalid_key",
      },
      { status: 400, headers: NO_STORE }
    );
  }

  const row = {
    user_id: userId,
    client_id: clientId,
    api_key_encrypted: encryptOzonApiKey(apiKey),
    key_last4: last4(apiKey),
    status: verdict.status,
    last_checked_at: new Date().toISOString(),
    last_error: verdict.detail ?? null,
  };

  const { data, error } = await admin
    .from("ozon_connections")
    .upsert(row, { onConflict: "user_id" })
    .select(SAFE_COLUMNS)
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/connection] upsert error", error);
    return NextResponse.json(
      { error: "Не удалось сохранить подключение" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(toConnectionView(data as OzonConnectionRow), {
    headers: NO_STORE,
  });
}

// DELETE — отключить. user_id строго из токена, не из тела.
export async function DELETE(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  const { error } = await admin
    .from("ozon_connections")
    .delete()
    .eq("user_id", userId);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/connection] delete error", error);
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
