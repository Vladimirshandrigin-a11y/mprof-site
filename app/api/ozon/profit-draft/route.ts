import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import {
  aggregateDraft,
  fetchOzonTransactions,
  isMonthInFuture,
  monthToRange,
  type OzonFinanceErrorCode,
} from "../_lib/finance";
import {
  aggregateProfitCostDraft,
  fetchMonthPostings,
  type CatalogRow,
} from "../_lib/postings";

// ============================================================================
// /api/ozon/profit-draft — ПРЕДВАРИТЕЛЬНАЯ прибыль через API (PR #16).
//   POST { month: "YYYY-MM" } → operations Ozon (finance) минус себестоимость
//   ТОЛЬКО сопоставленных товаров (postings ↔ каталог products).
//
// Это НЕ чистая прибыль и НЕ финальный расчёт: НИЧЕГО не сохраняется
// (ни calculations, ни report_history), consume_calculation не вызывается,
// ручные расходы (налог/упаковка/доставка до склада/зарплата/прочее) НЕ вычитаются.
//
// Формула (см. обсуждение PR #16): returns УЖЕ внутри signed revenue
// (accruals_for_sale со знаком), поэтому повторно его НЕ прибавляем —
//   ozonOperationsTotal = revenue + commission + logistics + services + storage + other
//   profitBeforeManualExpenses = ozonOperationsTotal - matchedCostTotal
//
// user_id берём ТОЛЬКО из токена (authenticateRequest). Ключ Ozon расшифровываем
// на сервере, НИКОГДА не логируем и не возвращаем; api_key_encrypted наружу не идёт.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

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
    console.error("[api/ozon/profit-draft] connection select error", connErr);
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

  const clientId = conn.client_id as string;

  // ---- 1) финансы Ozon (operations) — обязательны для черновика прибыли ----
  const tx = await fetchOzonTransactions(clientId, apiKey, range);
  if (!tx.ok) return errorResponse(tx.code);
  const draft = aggregateDraft(tx.operations, tx.partial);

  // ---- 2) отправления FBO+FBS (мягко: сбой схемы → warning) ----
  const postings = await fetchMonthPostings(clientId, apiKey, range);
  if (postings.fatalCode) return errorResponse(postings.fatalCode);

  // ---- 3) каталог себестоимости пользователя (read-only) ----
  const { data: catalog, error: catErr } = await admin
    .from("products")
    .select("sku, name, cost_price")
    .eq("user_id", userId);

  if (catErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/profit-draft] products select error", catErr);
    return NextResponse.json(
      { error: "Ошибка чтения каталога себестоимости" },
      { status: 502, headers: NO_STORE }
    );
  }

  // ---- 4) себестоимость ТОЛЬКО по сопоставленным товарам (без fuzzy) ----
  const cost = aggregateProfitCostDraft(
    postings.items,
    postings.warnings,
    (catalog ?? []) as CatalogRow[]
  );

  // ---- 5) формула (returns НЕ прибавляем повторно — он уже в signed revenue) ----
  const t = draft.totals;
  const ozonOperationsTotal = round2(
    t.revenue + t.commission + t.logistics + t.services + t.storage + t.other
  );
  const matchedCostTotal = cost.matchedCostTotal;
  const profitBeforeManualExpenses = round2(ozonOperationsTotal - matchedCostTotal);

  // ---- 6) статус полноты себестоимости ----
  // no_cost: себестоимости нет совсем; partial_cost: есть несопоставленные;
  // complete_cost: всё сопоставлено и себестоимость > 0.
  let status: "complete_cost" | "partial_cost" | "no_cost";
  if (matchedCostTotal <= 0) {
    status = "no_cost";
  } else if (cost.coverage.unmatchedItems > 0 || cost.coverage.unmatchedQuantity > 0) {
    status = "partial_cost";
  } else {
    status = "complete_cost";
  }

  // ---- предупреждения / пояснения ----
  // warnings: finance + (postings fetch warnings уже внутри cost.warnings).
  const warnings = [...draft.warnings, ...cost.warnings];
  const notes = [...draft.notes, ...cost.notes];
  notes.push(
    "Возвраты (returns) показаны справочно: они уже учтены внутри «Начислений Ozon» (signed accruals_for_sale) и повторно в сумму не добавляются."
  );
  notes.push(
    "Это предварительный API-черновик, а НЕ чистая прибыль и НЕ финальный расчёт. Налог, упаковка, доставка до склада, зарплата и прочие ручные расходы здесь НЕ вычитаются."
  );

  return NextResponse.json(
    {
      period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
      source: "ozon_profit_draft_v1",
      status,
      apiTotals: {
        ozonAccruals: t.revenue,
        returns: t.returns,
        commission: t.commission,
        logistics: t.logistics,
        services: t.services,
        storage: t.storage,
        other: t.other,
        operationCount: t.operationCount,
      },
      productCoverage: cost.coverage,
      costDraft: {
        matchedCostTotal,
        itemsWithoutCost: cost.itemsWithoutCost,
        topCostItems: cost.topCostItems,
      },
      preliminary: {
        ozonOperationsTotal,
        matchedCostTotal,
        profitBeforeManualExpenses,
      },
      manualExpensesNotIncluded: [
        "tax",
        "packaging",
        "warehouse_delivery",
        "salary",
        "other_manual_expenses",
      ],
      warnings,
      notes,
    },
    { headers: NO_STORE }
  );
}
