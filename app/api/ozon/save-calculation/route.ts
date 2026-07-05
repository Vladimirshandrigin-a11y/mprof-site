import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, getUserScopedClient } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { isMonthInFuture, monthToRange } from "../_lib/finance";
import {
  buildApiProfitResponseBody,
  errorResponse,
  loadAndComputeApiProfit,
  parseManualExpenses,
  round2,
} from "../_lib/profit";
import { type RealizationDiagnostic } from "../_lib/realization";

// ============================================================================
// POST /api/ozon/save-calculation — ФИНАЛЬНОЕ сохранение API-расчёта Ozon в
// историю + списание попытки (PR #19).
//
//   Вход: { month: "YYYY-MM", manualExpenses? }.
//
// Целевая формула API-расчёта:
//   Чистая прибыль = Итого Ozon − Себестоимость из отчёта реализации Ozon
//                    − Налог от выручки реализации − Внешние расходы вручную.
//   • Итого Ozon (ozonOperationsTotal) — из финопераций Ozon API;
//   • Себестоимость (productionCost) — из ОТЧЁТА О РЕАЛИЗАЦИИ Ozon
//     (/v2/finance/realization → candidateCogs.bySaleQty), сопоставленного с
//     каталогом по item.offer_id; postings delivered-only COGS БОЛЬШЕ НЕ боевая
//     (остаётся только справочной строкой postingsReferenceCost);
//   • Налог = round2(realizationRevenueForTax × tax% / 100) — ПРОЦЕНТ от выручки
//     отчёта реализации за вычетом возвратов (sums.taxRevenueBase), НЕ от Итого Ozon;
//   • Внешние расходы — вводит пользователь вручную.
//
// Поток (server-authoritative, бэкенд НЕ доверяет числам с фронтенда):
//   1. auth (user_id ТОЛЬКО из токена), ключ Ozon ТОЛЬКО из ozon_connections;
//   2. заново тянем данные Ozon API (финоперации + отчёт реализации) + каталог и
//      ПЕРЕСЧИТЫВАЕМ ту же формулу, что и preview (общий _lib/profit →
//      loadAndComputeApiProfit);
//   3. финальное сохранение разрешено ТОЛЬКО когда боевая себестоимость надёжно
//      получена ИЗ ОТЧЁТА РЕАЛИЗАЦИИ: realization подключился, есть строки и
//      item.offer_id, все строки сопоставлены с каталогом (unmatchedRows === 0) и
//      у всех есть cost_price (noCostRows === 0), bySaleQty > 0. Иначе:
//        • unmatched/no-cost → 400 incomplete_cost (пользователь заполняет каталог);
//        • not_connected/no_rows/no_offer_id/zero_cost → 422 realization_unavailable;
//      в обоих случаях БЕЗ сохранения и БЕЗ списания — некорректная прибыль НЕ
//      показывается;
//   4. списываем РОВНО один API-расчёт СТРОГИМ RPC consume_api_calculation
//      (PR #21): доступ ТОЛЬКО при активном безлимите 449₽ ИЛИ первом бесплатном
//      пробном расчёте; 149₽ single-кредит API НЕ открывает. Списание — ПЕРЕД
//      сохранением. Нет доступа → 402, без сохранения (RPC при лимите ничего не
//      инкрементит);
//   5. пишем строку в calculations (mode='api', снимок в ai_insights) и снимок
//      за месяц в report_history (для помесячных графиков).
//
// Списание идёт ПЕРЕД insert (как в рабочем ручном/файловом сохранении: оно тоже
// зовёт свой RPC до сохранения; ручной/файловый — consume_calculation, API —
// consume_api_calculation). Атомарной транзакции «списал+сохранил»
// в текущей архитектуре нет (RPC идёт user-scoped клиентом, insert — service-role
// клиентом), поэтому повторяем существующий порядок. Остаточный риск (списание
// прошло, а insert упал → расчёт «потрачен» без строки) такой же, как в текущем
// рабочем флоу, и описан в отчёте PR #19.
//
// Безопасность: raw-ключ Ozon не логируем и не возвращаем; api_key_encrypted,
// client_id и расшифрованный ключ наружу НЕ уходят.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ConsumeResult = {
  ok?: boolean;
  reason?: string;
  used?: number;
  allowance?: number;
  unlimited?: boolean;
};

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  // Bearer-токен для USER-SCOPED клиента (consume_api_calculation опирается на
  // auth.uid()). authenticateRequest уже подтвердил, что токен валиден.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return NextResponse.json(
      { error: "Требуется авторизация" },
      { status: 401, headers: NO_STORE }
    );
  }

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

  // ---- ручные расходы: optional; валидируем заново (не берём с фронтенда «как есть») ----
  const meParsed = parseManualExpenses(body.manualExpenses);
  if (!meParsed.ok) {
    return NextResponse.json(
      { error: meParsed.error },
      { status: 400, headers: NO_STORE }
    );
  }
  const manualExpenses = meParsed.value;

  // ---- подключение Ozon текущего пользователя (ключ ТОЛЬКО отсюда) ----
  const { data: conn, error: connErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] connection select error", connErr);
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

  // ---- 1) ЗАНОВО получаем данные Ozon + каталог и пересчитываем (общий модуль) ----
  // Боевая СЕБЕСТОИМОСТЬ берётся из ОТЧЁТА О РЕАЛИЗАЦИИ Ozon (тот же источник, что и
  // документальный расчёт), налог — от выручки реализации (за вычетом возвратов).
  // Полнота себестоимости И наличие выручки-базы налога проверяются ВНУТРИ
  // loadAndComputeApiProfit ДО расчёта: при проблеме возвращается
  // kind:"realization_cost" и прибыль НЕ считается.
  const loaded = await loadAndComputeApiProfit({
    admin,
    userId,
    clientId,
    apiKey,
    range,
    month,
    manualExpenses,
  });
  if (!loaded.ok) {
    if (loaded.kind === "ozon") return errorResponse(loaded.code);
    if (loaded.kind === "catalog") {
      return NextResponse.json(
        { error: "Ошибка чтения каталога себестоимости" },
        { status: 502, headers: NO_STORE }
      );
    }
    // ---- 2) себестоимость из отчёта реализации ненадёжна → НЕ сохраняем и НЕ
    //         списываем (боевой расчёт не показывается, чтобы не показать неверную
    //         прибыль). unmatched/no_cost → тот же блок «не хватает себестоимости»
    //         (пользователь заполняет каталог); остальные причины — понятная ошибка
    //         (отчёт не получен / пуст / без offer_id / нулевая себестоимость).
    const r = loaded.resolution;
    if (r.code === "unmatched" || r.code === "no_cost") {
      return NextResponse.json(
        {
          error:
            "Сохранение доступно только когда все товары из отчёта о реализации сопоставлены и у каждого заполнена себестоимость.",
          code: "incomplete_cost",
          status: "partial_cost",
          unmatchedItems: r.unmatchedRows,
          matchedNoCostCount: r.noCostRows,
        },
        { status: 400, headers: NO_STORE }
      );
    }
    if (r.code === "not_connected" && r.ozonErrorCode) {
      return errorResponse(r.ozonErrorCode);
    }
    const msgByCode: Record<string, string> = {
      not_connected:
        "Не удалось получить отчёт о реализации Ozon для расчёта себестоимости. Расчёт не сделан, попытка не списана.",
      no_rows:
        "Отчёт о реализации Ozon за выбранный месяц пуст — себестоимость определить нельзя. Расчёт не сделан, попытка не списана.",
      no_offer_id:
        "В отчёте о реализации Ozon нет артикулов (offer_id) — сопоставить с каталогом нельзя. Расчёт не сделан, попытка не списана.",
      zero_cost:
        "Себестоимость из отчёта о реализации Ozon равна 0 — проверьте себестоимость товаров в каталоге. Расчёт не сделан, попытка не списана.",
      no_tax_revenue:
        "Не удалось определить выручку из отчёта о реализации Ozon для расчёта налога. Расчёт не сделан, попытка не списана.",
    };
    return NextResponse.json(
      {
        error:
          msgByCode[r.code] ??
          "Не удалось определить себестоимость из отчёта о реализации Ozon. Расчёт не сделан, попытка не списана.",
        code: "realization_unavailable",
        reason: r.code,
      },
      { status: 422, headers: NO_STORE }
    );
  }

  const t = loaded.draft.totals;
  const c = loaded.computed;

  // ---- 3) списываем РОВНО один API-расчёт (server-authoritative, ПЕРЕД сохранением) ----
  // USER-SCOPED клиент: consume_api_calculation опирается на auth.uid(); service-role
  // обошёл бы auth и вернул not_authenticated. СТРОГИЙ API-RPC (PR #21): доступ
  // только при активном безлимите 449₽ ИЛИ первом бесплатном пробном расчёте;
  // 149₽ single-кредит API НЕ открывает. Цены не хардкодим — решает RPC.
  const userClient = getUserScopedClient(token);
  if (!userClient) {
    return NextResponse.json(
      {
        error:
          "Supabase не настроен (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)",
        code: "supabase_env_missing",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  const { data: consumeData, error: consumeErr } =
    await userClient.rpc("consume_api_calculation");
  if (consumeErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] consume rpc error", consumeErr);
    return NextResponse.json(
      { error: consumeErr.message || "Ошибка списания расчёта", code: "consume_failed" },
      { status: 502, headers: NO_STORE }
    );
  }
  const consume = (consumeData ?? {}) as ConsumeResult;
  if (consume.ok !== true) {
    // Нет доступа → НЕ сохраняем. При limit_reached RPC ничего не инкрементит,
    // так что попытка НЕ потрачена. Фронт откроет окно тарифа.
    const notAuth = consume.reason === "not_authenticated";
    return NextResponse.json(
      {
        error: notAuth
          ? "Сессия недействительна"
          : "API-расчёт доступен на тарифе «Безлимит» (449 ₽/мес) или как первый бесплатный пробный расчёт. Оформите тариф, чтобы продолжить.",
        code: notAuth ? "not_authenticated" : "limit_reached",
        consume: {
          ok: false,
          reason: consume.reason,
          used: consume.used,
          allowance: consume.allowance,
        },
      },
      { status: notAuth ? 401 : 402, headers: NO_STORE }
    );
  }

  // ---- 4) строка calculations: положительные величины расходов; reconcile с profit.
  // other_expenses — балансирующая статья (Ozon-услуги/прочее + ручные расходы
  // кроме налога), так что revenue − total_expenses === profit. Полный снимок —
  // в ai_insights (тот же приём, что у файлового net-profit расчёта).
  const revenue = round2(t.revenue);
  const commissionCol = round2(Math.max(0, -t.commission));
  const logisticsCol = round2(Math.max(0, -t.logistics));
  const storageCol = round2(Math.max(0, -t.storage));
  const adsCol = 0;
  const costCol = round2(c.matchedCostTotal);
  const taxCol = c.manualExpenses.tax;
  const otherExpensesCol = round2(
    revenue - commissionCol - logisticsCol - storageCol - adsCol - costCol - taxCol - c.netProfit
  );
  const totalExpensesCol = round2(
    commissionCol + logisticsCol + storageCol + adsCol + costCol + taxCol + otherExpensesCol
  );

  const snapshot = {
    kind: "ozon-api-v1",
    source: "ozon_api",
    period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
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
    productCoverage: loaded.cost.coverage,
    cost: {
      matchedCostTotal: c.matchedCostTotal,
      matchedNoCostCount: loaded.cost.matchedNoCostCount,
    },
    manualExpenses: c.manualExpenses,
    preliminary: {
      ozonOperationsTotal: c.ozonOperationsTotal,
      matchedCostTotal: c.matchedCostTotal,
      profitBeforeManualExpenses: c.profitBeforeManualExpenses,
      taxRevenueBase: c.taxRevenueBase,
    },
    netProfit: c.netProfit,
    margin: c.margin,
    savedAt: new Date().toISOString(),
  };

  const calcRow = {
    user_id: userId, // ТОЛЬКО из токена
    marketplace: "ozon",
    mode: "api",
    revenue,
    commission: commissionCol,
    logistics: logisticsCol,
    ads: adsCol,
    storage: storageCol,
    tax: taxCol,
    cost: costCol,
    other_expenses: otherExpensesCol,
    total_expenses: totalExpensesCol,
    profit: c.netProfit,
    margin: c.margin,
    ai_insights: snapshot,
  };

  const { data: savedCalc, error: calcErr } = await admin
    .from("calculations")
    .insert([calcRow])
    .select("id, created_at")
    .single();

  if (calcErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] calculations insert error", calcErr);
    // Расчёт уже списан (см. остаточный риск в шапке). Сообщаем об ошибке сейва.
    return NextResponse.json(
      { error: calcErr.message || "Не удалось сохранить расчёт", code: "save_failed" },
      { status: 502, headers: NO_STORE }
    );
  }

  // ---- 5) снимок за месяц для помесячных графиков (best-effort: не валит сейв) ----
  let reportHistorySaved = false;
  const { error: histErr } = await admin.from("report_history").insert([
    {
      user_id: userId,
      report_month: `${month}-01`, // первое число месяца отчёта (date)
      revenue,
      expenses: totalExpensesCol,
      profit: c.netProfit,
      margin: c.margin,
    },
  ]);
  if (histErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] report_history insert error", histErr);
  } else {
    reportHistorySaved = true;
  }

  // ---- 5.1) диагностика отчёта о реализации Ozon: ТА ЖЕ, что дала боевую
  //          себестоимость выше (loaded.realization) — повторно НЕ запрашиваем.
  //          Показываем ровно те количества/сопоставления, из которых посчитана
  //          боевая COGS (bySaleQty). byNetQty остаётся справочным (не в прибыли).
  const realizationDiagnostic: RealizationDiagnostic = loaded.realization;

  // ---- 6) полный расчёт для UI (PR #20): та же форма, что и preview-ответ, но
  // помечен как сохранённый. Фронт показывает эти цифры ТОЛЬКО после успешного
  // сохранения (единое действие «Рассчитать и сохранить»), поэтому полный расчёт
  // нельзя получить бесплатно. Общий билдер гарантирует идентичные поля с preview.
  const profit = buildApiProfitResponseBody({
    month,
    range,
    source: "ozon_api_saved_v1",
    draft: loaded.draft,
    cost: loaded.cost,
    computed: c,
    postingsReferenceCost: loaded.cost.matchedCostTotal,
    extraNotes: [
      "Себестоимость взята из отчёта о реализации Ozon (тот же источник, что и документальный расчёт); себестоимость по отправлениям показана справочно и в прибыль не входит.",
      "Налог рассчитан как процент от выручки из отчёта о реализации Ozon (за вычетом возвратов).",
      "Возвраты (returns) показаны справочно: они уже учтены внутри «Начислений Ozon» (signed accruals_for_sale) и повторно в сумму не добавляются.",
      "Расчёт сохранён в историю; одна попытка списана (для активного безлимита — без списания).",
    ],
  });

  return NextResponse.json(
    {
      ok: true,
      calculationId: savedCalc.id,
      createdAt: savedCalc.created_at,
      reportHistorySaved,
      consume: {
        ok: true,
        unlimited: consume.unlimited === true,
        used: typeof consume.used === "number" ? consume.used : undefined,
        allowance: typeof consume.allowance === "number" ? consume.allowance : undefined,
      },
      // Краткая сводка (обратная совместимость) + полный расчёт для отрисовки.
      result: {
        month,
        status: c.status,
        ozonOperationsTotal: c.ozonOperationsTotal,
        matchedCostTotal: c.matchedCostTotal,
        manualExpensesTotal: c.manualExpenses.total,
        netProfit: c.netProfit,
        margin: c.margin,
      },
      profit,
      // Справочная диагностика отчёта реализации (не влияет на сохранённые числа).
      realizationDiagnostic,
    },
    { headers: NO_STORE }
  );
}
