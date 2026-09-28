import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { apiRequestHash } from "../../../app/lib/calc-operation-keys";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { isMonthInFuture, monthToRange } from "../_lib/finance";
import {
  accrualErrorResponse,
  buildApiProfitResponseBody,
  errorResponse,
  loadAndComputeApiProfit,
  parseManualExpenses,
  round2,
} from "../_lib/profit";
import { type RealizationDiagnostic } from "../_lib/realization";
import { syncMissingRealizationProducts } from "../_lib/realization-catalog-sync";

// ============================================================================
// POST /api/ozon/save-calculation — ФИНАЛЬНОЕ сохранение API-расчёта Ozon в
// историю + списание попытки (PR #19).
//
//   Вход: { month: "YYYY-MM", manualExpenses?, operationId? (UUID) }.
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
//      показывается. Перед ответом incomplete_cost товары строк реализации, которых
//      нет в каталоге, автоматически добавляются в каталог пользователя (единая
//      функция cloud/_lib/catalog-import, cost_price = 0 = «не указана») — так что
//      пользователю остаётся только заполнить стоимость и запустить расчёт снова;
//   4. ОДНА транзакция БД (RPC save_api_calculation_operation, только service_role):
//      окончательная проверка прав и списание по правилам API (активный безлимит
//      449₽ ИЛИ общая первая бесплатная попытка; 149₽ single-кредит API НЕ открывает),
//      строка calculations (mode='api', снимок в ai_insights), снимок за месяц в
//      report_history и отметка операции. Нет доступа → 402, ничего не записано;
//      сбой записи откатывает и списание.
//
// Операция расчёта (миграция 20260929): operationId от страницы привязан к
// пользователю (из токена), режиму api и параметрам (месяц + ручные расходы —
// отпечаток считает сервер). Завершённая операция возвращает сохранённый расчёт
// ДО новых обращений к Ozon (потерянный ответ, двойной клик, перезагрузка) — без
// списания и записи; удалённый из истории — status "deleted", заново не создаётся;
// тот же operationId с другими параметрами → 409. Запросы к Ozon — ВНЕ транзакции:
// их ошибка попытку не расходует. Нет функций в БД (миграция не применена) → 503
// ДО Ozon, раздельного списания нет. Старая страница без operationId получает новый
// ключ на сервере — атомарность сохраняется, повтор между запросами — нет.
//
// Безопасность: raw-ключ Ozon не логируем и не возвращаем; api_key_encrypted,
// client_id и расшифрованный ключ наружу НЕ уходят.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ответ RPC операции / статуса (миграция 20260929). */
type OperationResult = {
  ok?: boolean;
  reason?: string;
  status?: string;
  replay?: boolean;
  calculation_id?: string;
  created_at?: string;
  calculation?: Record<string, unknown> | null;
  used?: number;
  allowance?: number;
  unlimited?: boolean;
};

/** Ошибка RPC операции: нет функции (миграция не применена) → 503, иначе исход неизвестен. */
function operationRpcFailure(error: { code?: string; message?: string }, where: string): NextResponse {
  if (error.code === "PGRST202" || error.code === "42883") {
    return NextResponse.json(
      { error: "Сохранение расчёта временно недоступно. Попытка не списана.", code: "migration_missing" },
      { status: 503, headers: NO_STORE }
    );
  }
  console.error(`[api/ozon/save-calculation] operation ${where} rpc error`, error);
  return NextResponse.json(
    {
      error: "Сервер не подтвердил сохранение расчёта. Повторите: если расчёт уже сохранён, повтор вернёт его без повторного списания.",
      code: "operation_failed",
    },
    { status: 502, headers: NO_STORE }
  );
}

function operationConflict(): NextResponse {
  return NextResponse.json(
    { error: "Операция относится к расчёту с другими параметрами. Попытка не списана.", code: "operation_conflict" },
    { status: 409, headers: NO_STORE }
  );
}

/** Завершённая операция: сохранённый расчёт (без Ozon, списания и записи) или «удалён». */
function savedOperationResponse(r: OperationResult): NextResponse {
  if (r.status === "deleted") {
    return NextResponse.json({ ok: true, replay: true, status: "deleted" }, { headers: NO_STORE });
  }
  return NextResponse.json(
    {
      ok: true,
      replay: true,
      status: "done",
      calculationId: r.calculation_id ?? null,
      createdAt: r.created_at ?? null,
      calculation: r.calculation ?? null,
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  // userId — ТОЛЬКО из проверенного токена; операция (service_role) получает его
  // параметром и списывает по правилам API.
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
  let body: { month?: unknown; manualExpenses?: unknown; operationId?: unknown };
  try {
    body = (await req.json()) as { month?: unknown; manualExpenses?: unknown; operationId?: unknown };
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

  // ---- операция: ключ страницы (или новый) + отпечаток параметров (считает сервер) ----
  if (body.operationId !== undefined && (typeof body.operationId !== "string" || !UUID_RE.test(body.operationId))) {
    return NextResponse.json(
      { error: "Некорректный ключ операции", code: "bad_request" },
      { status: 400, headers: NO_STORE }
    );
  }
  const operationId = typeof body.operationId === "string" ? body.operationId : randomUUID();
  const requestHash = apiRequestHash(month, manualExpenses);

  // ---- 0) завершённая операция → сохранённый расчёт ДО обращений к Ozon ----
  const { data: stData, error: stErr } = await admin.rpc("api_calculation_operation_status", {
    p_user_id: userId,
    p_operation_id: operationId,
    p_request_hash: requestHash,
  });
  if (stErr) return operationRpcFailure(stErr, "status");
  const st = (stData ?? {}) as OperationResult;
  if (st.status === "conflict") return operationConflict();
  if (st.status === "done" || st.status === "deleted") return savedOperationResponse(st);

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
    // accrual-источник (флаг включён) без отката на отключённый legacy — честная
    // причина незавершённости ДО consume/save (см. doc-comment в profit.ts/accrual.ts).
    if (loaded.kind === "accrual") return accrualErrorResponse(loaded.code);
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
      // Автодобавление отсутствующих товаров — ДО consume и сохранения; здесь же
      // расчёт останавливается (consume/calculations/report_history не трогаем).
      // Ошибка импорта не скрывается: catalogImport.ok=false доходит до UI.
      const sync = await syncMissingRealizationProducts({
        admin,
        userId,
        resolution: r,
        unmatched: loaded.unmatched,
      });
      return NextResponse.json(
        {
          error:
            "Сохранение доступно только когда все товары из отчёта о реализации сопоставлены и у каждого заполнена себестоимость.",
          code: "incomplete_cost",
          status: "partial_cost",
          unmatchedItems: sync.unmatchedItems,
          matchedNoCostCount: sync.matchedNoCostCount,
          catalogImport: sync.catalogImport,
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

  // ---- 3) строка calculations: положительные величины расходов; reconcile с profit.
  // other_expenses — балансирующая статья (Ozon-услуги/прочее + ручные расходы
  // кроме налога), так что revenue − total_expenses === profit. Полный снимок —
  // в ai_insights (тот же приём, что у файлового net-profit расчёта).
  const revenue = round2(t.revenue);
  const commissionCol = round2(Math.max(0, -t.commission));
  // logisticsCol теперь использует COMBINED signed logistics (legacy delivery-поля
  // + точные logistics-services из классификатора PR A) — оба в t.logistics.
  const logisticsCol = round2(Math.max(0, -t.logistics));
  const storageCol = round2(Math.max(0, -t.storage));
  // ads больше НЕ хардкод-ноль: берём из signed ads-бакета классификатора
  // (реклама/продвижение — списание, т.е. t.ads ≤ 0 → -t.ads ≥ 0).
  const adsCol = round2(Math.max(0, -t.ads));
  const costCol = round2(c.matchedCostTotal);
  const taxCol = c.manualExpenses.tax;
  const otherExpensesCol = round2(
    revenue - commissionCol - logisticsCol - storageCol - adsCol - costCol - taxCol - c.netProfit
  );
  const totalExpensesCol = round2(
    commissionCol + logisticsCol + storageCol + adsCol + costCol + taxCol + otherExpensesCol
  );

  // Точная signed-разбивка классификатора PR A. Только безопасные агрегаты
  // (никаких raw operations / order / SKU / offer_id / product_id / ключей).
  const tx = loaded.draft.taxonomy;
  const financeTaxonomy = {
    classifierVersion: tx.classifierVersion,
    // Честный endpoint ФАКТИЧЕСКИ использованного источника: legacy → та же строка
    // byte-for-byte; accrual → /v1/finance/accrual/by-day. classifierVersion и
    // snapshot.kind НЕ меняем — их гейтят page.tsx (месяц по kind==="ozon-api-v1") и
    // ozon-finance-taxonomy-view (classifierVersion===поддерживаемый); их смена сломала
    // бы загрузку истории/UI. Различие источника несёт sourceEndpoint (+ маркер ниже).
    sourceEndpoint: loaded.financeSource.sourceEndpoint,
    // Additive-маркер источника ТОЛЬКО для accrual → legacy metadata остаётся byte-for-byte.
    ...(loaded.financeSource.source === "accrual_by_day"
      ? { financeSource: "accrual_by_day" as const }
      : {}),
    operationCount: t.operationCount,
    // signed итоги по корзинам
    logistics: t.logistics,
    logisticsLegacy: t.logisticsLegacy,
    logisticsServices: t.logisticsServices,
    ads: t.ads,
    adjustments: t.adjustments,
    remainingServices: t.services,
    storage: t.storage,
    remainingOther: t.other,
    // gross-разбивка (signedTotal === credits − charges), накоплена из отдельных строк
    breakdown: {
      logistics: tx.logistics,
      ads: tx.ads,
      adjustments: tx.adjustments,
      remainingServices: tx.remainingServices,
      remainingOther: tx.remainingOther,
    },
    // Additive: суммы операций accrual-источника, НЕ отнесённые к «Реклама»/
    // «Компенсации» (нет справочника типов в этом запуске ИЛИ type_id не в
    // известном наборе) — реальные суммы, а не подгонка остатком (см. doc-
    // comment buildAccrualDraft, accrual.ts). У legacy это поле отсутствует
    // (не появляется в snapshot вовсе) — старые записи истории не трогает.
    ...(loaded.draft.unclassified && loaded.draft.unclassified.length > 0
      ? { unclassified: loaded.draft.unclassified }
      : {}),
  };

  const snapshot = {
    kind: "ozon-api-v1",
    source: "ozon_api",
    period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
    apiTotals: {
      ozonAccruals: t.revenue,
      returns: t.returns,
      commission: t.commission,
      logistics: t.logistics,
      logisticsLegacy: t.logisticsLegacy,
      logisticsServices: t.logisticsServices,
      services: t.services,
      ads: t.ads,
      adjustments: t.adjustments,
      storage: t.storage,
      other: t.other,
      operationCount: t.operationCount,
    },
    financeTaxonomy,
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

  // Пользователь — ТОЛЬКО из токена (параметр p_user_id операции), не из тела.
  const calcRow = {
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

  // ---- 4) ОДНА транзакция: права + списание + calculations + report_history + журнал ----
  const { data: opData, error: opErr } = await admin.rpc("save_api_calculation_operation", {
    p_user_id: userId,
    p_operation_id: operationId,
    p_request_hash: requestHash,
    p_calculation: calcRow,
    p_history: {
      report_month: `${month}-01`, // первое число месяца отчёта (date)
      revenue,
      expenses: totalExpensesCol,
      profit: c.netProfit,
      margin: c.margin,
    },
  });
  if (opErr) return operationRpcFailure(opErr, "save");
  const op = (opData ?? {}) as OperationResult;
  if (op.ok !== true) {
    if (op.reason === "operation_conflict") return operationConflict();
    if (op.reason === "bad_request") {
      console.error("[api/ozon/save-calculation] operation bad_request");
      return NextResponse.json(
        { error: "Не удалось сохранить расчёт", code: "save_failed" },
        { status: 500, headers: NO_STORE }
      );
    }
    // Нет доступа → ничего не записано и не списано. Фронт откроет окно тарифа.
    const notAuth = op.reason === "not_authenticated";
    return NextResponse.json(
      {
        error: notAuth
          ? "Сессия недействительна"
          : "API-расчёт доступен на тарифе «Безлимит» (449 ₽/мес) или как первый бесплатный пробный расчёт. Оформите тариф, чтобы продолжить.",
        code: notAuth ? "not_authenticated" : "limit_reached",
        consume: { ok: false, reason: op.reason, used: op.used, allowance: op.allowance },
      },
      { status: notAuth ? 401 : 402, headers: NO_STORE }
    );
  }
  // Параллельный запрос той же операции успел раньше — его сохранённый расчёт.
  if (op.replay === true || op.status === "deleted") return savedOperationResponse(op);

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
      replay: false,
      operationId,
      calculationId: op.calculation_id,
      createdAt: op.created_at,
      reportHistorySaved: true,
      consume: {
        ok: true,
        unlimited: op.unlimited === true,
        used: typeof op.used === "number" ? op.used : undefined,
        allowance: typeof op.allowance === "number" ? op.allowance : undefined,
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
