import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import {
  isMonthInFuture,
  monthToRange,
  type OzonFinanceErrorCode,
} from "../_lib/finance";
import {
  aggregatePostingsMatch,
  fetchMonthPostings,
  type CatalogRow,
} from "../_lib/postings";

// ============================================================================
// /api/ozon/postings-match-diagnostic — read-only ДИАГНОСТИКА сопоставления (PR #15).
//   POST { month: "YYYY-MM" } → какие товары из Ozon postings (FBO+FBS) есть в
//   каталоге себестоимости (таблица products), а какие нет.
//
// Это НЕ расчёт прибыли и НЕ списание себестоимости: ничего не сохраняется
// (ни calculations, ни report_history), consume_calculation не вызывается.
// user_id берём ТОЛЬКО из токена (authenticateRequest). Ключ Ozon расшифровываем
// на сервере, НИКОГДА не логируем и не возвращаем; api_key_encrypted наружу не идёт.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Код ошибки Ozon → человеко-понятный текст + HTTP-статус. */
function errorResponse(code: OzonFinanceErrorCode): NextResponse {
  const map: Record<OzonFinanceErrorCode, { status: number; error: string }> = {
    not_connected: { status: 400, error: "Подключение Ozon не найдено" },
    invalid_key: { status: 400, error: "Ozon отклонил ключ" },
    forbidden: { status: 400, error: "Недостаточно прав у ключа" },
    rate_limited: {
      status: 429,
      error: "Слишком много запросов к Ozon. Подождите немного и попробуйте снова",
    },
    timeout: { status: 504, error: "Ozon не ответил вовремя. Попробуйте ещё раз" },
    bad_response: { status: 502, error: "Ozon вернул неожиданный ответ" },
    unavailable: { status: 502, error: "Ozon временно недоступен" },
  };
  const { status, error } = map[code];
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

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

  // ---- input ----
  let body: { month?: unknown };
  try {
    body = (await req.json()) as { month?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!month) {
    return NextResponse.json(
      { error: "Укажите месяц" },
      { status: 400, headers: NO_STORE }
    );
  }
  const range = monthToRange(month);
  if (!range) {
    return NextResponse.json(
      { error: "Месяц должен быть в формате ГГГГ-ММ" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (isMonthInFuture(month)) {
    return NextResponse.json(
      { error: "Нельзя выбрать будущий месяц" },
      { status: 400, headers: NO_STORE }
    );
  }

  // ---- подключение Ozon текущего пользователя ----
  const { data: conn, error: connErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/postings-match-diagnostic] connection select error", connErr);
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }
  if (!conn || !conn.client_id || !conn.api_key_encrypted) {
    return errorResponse("not_connected");
  }

  // ---- расшифровка ключа (ТОЛЬКО сервер; не логируем, не возвращаем) ----
  let apiKey: string;
  try {
    apiKey = decryptOzonApiKey(conn.api_key_encrypted as string);
  } catch {
    return NextResponse.json(
      { error: "Ключ Ozon нужно переподключить", code: "decrypt_failed" },
      { status: 400, headers: NO_STORE }
    );
  }

  // ---- получение отправлений FBO+FBS (мягко: сбой схемы → warning) ----
  const postings = await fetchMonthPostings(conn.client_id as string, apiKey, range);
  if (postings.fatalCode) return errorResponse(postings.fatalCode);

  // ---- каталог себестоимости пользователя (read-only) ----
  const { data: catalog, error: catErr } = await admin
    .from("products")
    .select("sku, name, cost_price")
    .eq("user_id", userId);

  if (catErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/postings-match-diagnostic] products select error", catErr);
    return NextResponse.json(
      { error: "Ошибка чтения каталога себестоимости" },
      { status: 502, headers: NO_STORE }
    );
  }

  // ---- агрегация + сопоставление (прибыль НЕ считаем, ничего не сохраняем) ----
  const result = aggregatePostingsMatch(
    postings.items,
    postings.postingCount,
    postings.partial,
    postings.warnings,
    (catalog ?? []) as CatalogRow[]
  );

  return NextResponse.json(
    {
      period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
      source: "ozon_postings_match_diagnostic_v1",
      totals: result.totals,
      matched: result.matched,
      unmatched: result.unmatched,
      warnings: result.warnings,
      notes: result.notes,
    },
    { headers: NO_STORE }
  );
}
