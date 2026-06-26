import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import {
  isMonthInFuture,
  monthToRange,
  type OzonFinanceErrorCode,
} from "../_lib/finance";
import {
  fetchMonthPostings,
  planMissingProductsImport,
  type CatalogRow,
} from "../_lib/postings";

// ============================================================================
// /api/ozon/import-missing-products — добавление НЕсопоставленных товаров из
// Ozon API в каталог себестоимости (PR #17).
//   POST { month: "YYYY-MM" } → товары из Ozon postings (FBO+FBS), которых НЕТ
//   в каталоге products, добавляются как новые строки: sku = offer_id,
//   name = название из Ozon, cost_price = 0 (схема products: NOT NULL default 0).
//
// Это НЕ расчёт прибыли и НЕ финальный расчёт: НИЧЕГО не считается,
// consume_calculation НЕ вызывается, в calculations/report_history НЕ пишем,
// AI/PDF НЕ запускаются. Себестоимость НЕ выдумывается — её пользователь
// заполняет вручную в каталоге уже после добавления.
//
// Безопасность каталога:
//   • только INSERT новых товаров (никаких update/upsert/delete);
//   • существующие товары НЕ перезаписываются (ни cost_price, ни name);
//   • дубли не создаём: товар, который уже сопоставляется с каталогом
//     (offer_id↔products.sku или точное Ozon-sku↔products.sku, без fuzzy),
//     пропускаем и возвращаем в skipped;
//   • товары без offer_id НЕ добавляем (их нельзя надёжно связать).
//
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
    console.error("[api/ozon/import-missing-products] connection select error", connErr);
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

  // ---- 1) отправления FBO+FBS (мягко: сбой схемы → warning) ----
  const postings = await fetchMonthPostings(conn.client_id as string, apiKey, range);
  if (postings.fatalCode) return errorResponse(postings.fatalCode);

  // ---- 2) каталог себестоимости пользователя (read-only) ----
  const { data: catalog, error: catErr } = await admin
    .from("products")
    .select("sku, name, cost_price")
    .eq("user_id", userId);

  if (catErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/import-missing-products] products select error", catErr);
    return NextResponse.json(
      { error: "Ошибка чтения каталога себестоимости" },
      { status: 502, headers: NO_STORE }
    );
  }

  // ---- 3) план импорта (чистая функция, без записи в БД, без fuzzy) ----
  const plan = planMissingProductsImport(
    postings.items,
    postings.warnings,
    (catalog ?? []) as CatalogRow[]
  );

  const warnings = [...plan.warnings];
  const notes = [...plan.notes];

  // ---- 4) INSERT только новых товаров (sku = offer_id, cost_price = 0) ----
  // Никаких update/upsert/delete: существующие строки не трогаем.
  const created: Array<{ sku: string; name: string; costPrice: number | null }> = [];

  if (plan.eligible.length > 0) {
    const rows = plan.eligible.map((e) => ({
      user_id: userId,
      sku: e.offerId,
      name: e.name,
      cost_price: 0,
    }));

    const { data: inserted, error: insErr } = await admin
      .from("products")
      .insert(rows)
      .select("sku, name, cost_price");

    if (insErr) {
      // eslint-disable-next-line no-console
      console.error("[api/ozon/import-missing-products] products insert error", insErr);
      return NextResponse.json(
        { error: "Не удалось добавить товары в каталог" },
        { status: 502, headers: NO_STORE }
      );
    }

    const insertedRows = (inserted ?? []) as Array<{
      sku: string | null;
      name: string | null;
      cost_price: number | null;
    }>;
    for (const r of insertedRows) {
      created.push({
        sku: typeof r.sku === "string" ? r.sku : "",
        name: typeof r.name === "string" ? r.name : "",
        costPrice: typeof r.cost_price === "number" ? r.cost_price : null,
      });
    }
  }

  // ---- 5) skipped = уже в каталоге + без offer_id ----
  const skipped = [...plan.skippedExisting, ...plan.skippedNoOfferId];

  if (created.length > 0) {
    notes.push(
      "Товары добавлены в каталог с нулевой себестоимостью. Заполните cost_price вручную и повторите проверку сопоставления."
    );
  }

  return NextResponse.json(
    {
      period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
      source: "ozon_import_missing_products_v1",
      totals: {
        unmatchedFromOzon: plan.unmatchedFromOzon,
        eligibleToImport: plan.eligible.length,
        created: created.length,
        skippedExisting: plan.skippedExisting.length,
        skippedNoOfferId: plan.skippedNoOfferId.length,
      },
      created,
      skipped,
      warnings,
      notes,
    },
    { headers: NO_STORE }
  );
}
