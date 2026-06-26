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
// /api/ozon/profit-draft — ПРЕДВАРИТЕЛЬНАЯ прибыль через API (PR #16 + PR #18).
//   POST { month: "YYYY-MM", manualExpenses? } → operations Ozon (finance) минус
//   себестоимость ТОЛЬКО сопоставленных товаров (postings ↔ каталог products),
//   а затем (PR #18) минус ОПЦИОНАЛЬНЫЕ ручные расходы → предварительная
//   чистая прибыль.
//
// Это всё ещё preview/draft, НЕ чистая прибыль «на бумаге» и НЕ финальный расчёт:
// НИЧЕГО не сохраняется (ни calculations, ни report_history), consume_calculation
// не вызывается, AI/PDF не запускаются. manualExpenses в БД НЕ сохраняются —
// они приходят в запросе, участвуют только в текущем preview-ответе и забываются.
//
// Формула (PR #16, не ломаем): returns УЖЕ внутри signed revenue
// (accruals_for_sale со знаком), поэтому повторно его НЕ прибавляем —
//   ozonOperationsTotal = revenue + commission + logistics + services + storage + other
//   profitBeforeManualExpenses = ozonOperationsTotal - matchedCostTotal
// PR #18 добавляет:
//   manualExpensesTotal = tax + packaging + warehouseDelivery + salary + other
//   netProfitPreview    = profitBeforeManualExpenses - manualExpensesTotal
//   marginPreview       = ozonOperationsTotal > 0 ? netProfitPreview/ozonOperationsTotal*100 : 0
//
// user_id берём ТОЛЬКО из токена (authenticateRequest). Ключ Ozon расшифровываем
// на сервере, НИКОГДА не логируем и не возвращаем; api_key_encrypted наружу не идёт.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---- ручные расходы (PR #18): optional, в БД НЕ сохраняются ----------------
type ManualExpenses = {
  tax: number;
  packaging: number;
  warehouseDelivery: number;
  salary: number;
  other: number;
};

const MANUAL_EXPENSE_FIELDS = [
  "tax",
  "packaging",
  "warehouseDelivery",
  "salary",
  "other",
] as const;

const MANUAL_EXPENSE_LABELS: Record<(typeof MANUAL_EXPENSE_FIELDS)[number], string> = {
  tax: "Налог",
  packaging: "Упаковка",
  warehouseDelivery: "Доставка до склада",
  salary: "Зарплата",
  other: "Прочие расходы",
};

/**
 * Разобрать ОПЦИОНАЛЬНЫЙ manualExpenses из тела запроса.
 *   • отсутствует/null/любое отсутствующее поле → 0;
 *   • каждое значение обязано быть finite number >= 0;
 *   • строка/булево/NaN/Infinity/отрицательное → ошибка (route вернёт 400).
 * Ничего не сохраняем в БД — это чистая валидация для текущего preview-ответа.
 */
function parseManualExpenses(
  raw: unknown
): { ok: true; value: ManualExpenses } | { ok: false; error: string } {
  const out: ManualExpenses = {
    tax: 0,
    packaging: 0,
    warehouseDelivery: 0,
    salary: 0,
    other: 0,
  };
  if (raw === undefined || raw === null) return { ok: true, value: out };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Поле manualExpenses должно быть объектом" };
  }
  const obj = raw as Record<string, unknown>;
  for (const f of MANUAL_EXPENSE_FIELDS) {
    const v = obj[f];
    if (v === undefined || v === null) continue; // отсутствует → 0
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        ok: false,
        error: `Расход «${MANUAL_EXPENSE_LABELS[f]}» должен быть числом не меньше 0`,
      };
    }
    out[f] = v;
  }
  return { ok: true, value: out };
}

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
  let body: { month?: unknown; manualExpenses?: unknown };
  try {
    body = (await req.json()) as { month?: unknown; manualExpenses?: unknown };
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

  // ---- ручные расходы (PR #18): optional; валидируем, в БД НЕ сохраняем ----
  const meParsed = parseManualExpenses(body.manualExpenses);
  if (!meParsed.ok) {
    return NextResponse.json(
      { error: meParsed.error },
      { status: 400, headers: NO_STORE }
    );
  }
  const manualExpenses = meParsed.value;

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

  // ---- 5b) ручные расходы → ПРЕДВАРИТЕЛЬНАЯ чистая прибыль (PR #18) ----
  // Существующую формулу выше не трогаем. manualExpenses в БД не сохраняются.
  const meTax = round2(manualExpenses.tax);
  const mePackaging = round2(manualExpenses.packaging);
  const meWarehouseDelivery = round2(manualExpenses.warehouseDelivery);
  const meSalary = round2(manualExpenses.salary);
  const meOther = round2(manualExpenses.other);
  const manualExpensesTotal = round2(
    meTax + mePackaging + meWarehouseDelivery + meSalary + meOther
  );
  const netProfitValue = round2(profitBeforeManualExpenses - manualExpensesTotal);
  const marginPreview =
    ozonOperationsTotal > 0
      ? round2((netProfitValue / ozonOperationsTotal) * 100)
      : 0;

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
    "Это предварительный API-расчёт. Он не сохраняется, не списывает попытку и требует проверки перед финальным сохранением."
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
      // PR #18 — ручные расходы (echo, в БД не сохранены) и предварительная
      // ЧИСТАЯ прибыль (preview, не финал). UI пишет «Предварительная чистая прибыль».
      manualExpenses: {
        tax: meTax,
        packaging: mePackaging,
        warehouseDelivery: meWarehouseDelivery,
        salary: meSalary,
        other: meOther,
        total: manualExpensesTotal,
      },
      netProfitPreview: {
        value: netProfitValue,
        margin: marginPreview,
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
