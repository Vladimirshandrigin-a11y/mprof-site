import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../../../_lib/crypto";
import { verifyPerformanceToken } from "../../../_lib/performance";
import {
  PERF_SAFE_COLUMNS,
  toPerfConnectionView,
  type PerfConnectionRow,
} from "../../../_lib/performance";

// ============================================================================
// /api/ozon/performance/connection/verify — перепроверка сохранённых Performance
// кредов (PR #43 foundation).
//
// Тело не нужно: Client ID и зашифрованный client_secret берём из БД по user_id
// (из токена), расшифровываем ТОЛЬКО на сервере, получаем bearer access_token и
// обновляем статус. Токен В БД НЕ СОХРАНЯЕТСЯ и в ответ НЕ уходит. Секрет/токен
// НЕ логируются. Рекламные отчёты/кампании здесь НЕ запрашиваем.
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
    .from("ozon_performance_connections")
    .select("client_id, client_secret_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/performance/connection/verify] select error", readErr);
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

  let clientSecret: string;
  try {
    clientSecret = decryptOzonApiKey(existing.client_secret_encrypted as string);
  } catch {
    // Секрет нечитаем (сменили OZON_KEYS_ENC_SECRET/повреждение) — помечаем
    // invalid_key, чтобы UI попросил переподключить. Детали шифрования не раскрываем.
    await admin
      .from("ozon_performance_connections")
      .update({
        status: "invalid_key",
        last_checked_at: new Date().toISOString(),
        last_error: "Секрет нечитаем, переподключите Performance API",
      })
      .eq("user_id", userId);
    return NextResponse.json(
      {
        error: "Секрет нечитаем, переподключите Performance API",
        status: "invalid_key",
      },
      { status: 409, headers: NO_STORE }
    );
  }

  const verdict = await verifyPerformanceToken(
    existing.client_id as string,
    clientSecret
  );

  const { data, error } = await admin
    .from("ozon_performance_connections")
    .update({
      status: verdict.status,
      last_checked_at: new Date().toISOString(),
      last_error: verdict.detail ?? null,
    })
    .eq("user_id", userId)
    .select(PERF_SAFE_COLUMNS)
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/performance/connection/verify] update error", error);
    return NextResponse.json(
      { error: "Не удалось обновить статус" },
      { status: 502, headers: NO_STORE }
    );
  }

  return NextResponse.json(toPerfConnectionView(data as PerfConnectionRow), {
    headers: NO_STORE,
  });
}
