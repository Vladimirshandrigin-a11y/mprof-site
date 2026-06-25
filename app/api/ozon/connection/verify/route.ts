import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../../_lib/crypto";
import { verifyOzonKey } from "../../_lib/verify";
import { SAFE_COLUMNS, toConnectionView, type OzonConnectionRow } from "../../_lib/shape";

// ============================================================================
// /api/ozon/connection/verify — перепроверка уже сохранённого ключа (PR #1).
//
// Тело не нужно: Client-Id и зашифрованный ключ берём из БД по user_id (из токена),
// расшифровываем ТОЛЬКО на сервере, повторно пингуем Ozon и обновляем статус.
// Сырой/зашифрованный ключ в ответ НЕ уходит.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

  const { data: existing, error: readErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/connection/verify] select error", readErr);
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }
  if (!existing) {
    return NextResponse.json(
      { error: "Подключение не найдено" },
      { status: 404, headers: NO_STORE }
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptOzonApiKey(existing.api_key_encrypted as string);
  } catch {
    // Ключ нечитаем (сменили секрет/повреждение) — помечаем invalid_key, чтобы UI
    // попросил переподключить. Текст ошибки не раскрывает деталей шифрования.
    await admin
      .from("ozon_connections")
      .update({
        status: "invalid_key",
        last_checked_at: new Date().toISOString(),
        last_error: "Ключ нечитаем, переподключите кабинет",
      })
      .eq("user_id", userId);
    return NextResponse.json(
      { error: "Ключ нечитаем, переподключите кабинет", status: "invalid_key" },
      { status: 409, headers: NO_STORE }
    );
  }

  const verdict = await verifyOzonKey(existing.client_id as string, apiKey);

  const { data, error } = await admin
    .from("ozon_connections")
    .update({
      status: verdict.status,
      last_checked_at: new Date().toISOString(),
      last_error: verdict.detail ?? null,
    })
    .eq("user_id", userId)
    .select(SAFE_COLUMNS)
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/connection/verify] update error", error);
    return NextResponse.json(
      { error: "Не удалось обновить статус" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(toConnectionView(data as OzonConnectionRow), {
    headers: NO_STORE,
  });
}
