import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { isMonthInFuture, monthToRange } from "../_lib/finance";
import {
  errorResponse,
  loadAndComputeApiProfit,
  parseManualExpenses,
} from "../_lib/profit";

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
// PR #19: загрузка данных Ozon/каталога и формула вынесены в общий _lib/profit
// (loadAndComputeApiProfit), который ПОВТОРНО использует финальное сохранение —
// чтобы preview и сохранение считали идентичную цифру. Поведение этого роута не
// изменилось: тот же JSON, по-прежнему без сохранения и без списания.
//
// user_id берём ТОЛЬКО из токена (authenticateRequest). Ключ Ozon расшифровываем
// на сервере, НИКОГДА не логируем и не возвращаем; api_key_encrypted наружу не идёт.
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

  // ---- заново получаем данные Ozon + каталог и считаем (общий модуль) ----
  const loaded = await loadAndComputeApiProfit({
    admin,
    userId,
    clientId,
    apiKey,
    range,
    manualExpenses,
  });
  if (!loaded.ok) {
    if (loaded.kind === "ozon") return errorResponse(loaded.code);
    // catalog
    return NextResponse.json(
      { error: "Ошибка чтения каталога себестоимости" },
      { status: 502, headers: NO_STORE }
    );
  }

  const { draft, cost, computed } = loaded;
  const t = draft.totals;

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
      status: computed.status,
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
        matchedCostTotal: computed.matchedCostTotal,
        itemsWithoutCost: cost.itemsWithoutCost,
        topCostItems: cost.topCostItems,
      },
      preliminary: {
        ozonOperationsTotal: computed.ozonOperationsTotal,
        matchedCostTotal: computed.matchedCostTotal,
        profitBeforeManualExpenses: computed.profitBeforeManualExpenses,
      },
      // PR #18 — ручные расходы (echo, в БД не сохранены) и предварительная
      // ЧИСТАЯ прибыль (preview, не финал). UI пишет «Предварительная чистая прибыль».
      manualExpenses: {
        tax: computed.manualExpenses.tax,
        packaging: computed.manualExpenses.packaging,
        warehouseDelivery: computed.manualExpenses.warehouseDelivery,
        salary: computed.manualExpenses.salary,
        other: computed.manualExpenses.other,
        total: computed.manualExpenses.total,
      },
      netProfitPreview: {
        value: computed.netProfit,
        margin: computed.margin,
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
