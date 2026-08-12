import { NextResponse } from "next/server";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateDraft,
  fetchOzonTransactions,
  type MonthRange,
  type OzonDraftAggregate,
  type OzonDraftTotals,
  type OzonFinanceErrorCode,
} from "./finance";
import {
  aggregateProfitCostDraft,
  fetchMonthPostings,
  type CatalogRow,
  type ProfitCostDraft,
} from "./postings";
import {
  loadRealizationDiagnostic,
  type RealizationDiagnostic,
} from "./realization";
import { isAccrualFinanceEnabled, loadAccrualDraft } from "./accrual";

// ============================================================================
// Общий модуль предварительной/финальной прибыли через Ozon API.
//
// Зачем он существует (PR #19): расчёт прибыли через Ozon API живёт в ОДНОМ месте
// (загрузка из Ozon API + каталог себестоимости + формула), чтобы бэкенд считал
// ОДНУ И ТУ ЖЕ цифру и НЕ доверял числам с фронтенда — он сам заново тянет данные
// и пересчитывает. PR #20.1: единственный потребитель — финальное сохранение
// /api/ozon/save-calculation (preview /api/ozon/profit-draft отключён: 410, чтобы
// полный расчёт нельзя было получить без сохранения и списания). Раньше тот же
// модуль обслуживал и preview — отсюда обобщённые имена ниже.
//
// Формула (returns УЖЕ внутри signed revenue = accruals_for_sale со знаком,
// поэтому повторно его НЕ прибавляем):
//   ozonOperationsTotal = revenue + commission + logistics + services + storage + other
//   productionCost      = себестоимость из ОТЧЁТА О РЕАЛИЗАЦИИ Ozon
//                         (/v2/finance/realization → candidateCogs.bySaleQty:
//                         Σ количество продаж × cost_price каталога по offer_id).
//   profitBeforeManualExpenses = ozonOperationsTotal − productionCost
//   realizationRevenueForTax = выручка ОТЧЁТА О РЕАЛИЗАЦИИ за вычетом возвратов
//                         (/v2/finance/realization → sums.taxRevenueBase =
//                         deliveryAmount − returnAmount), близка к строке
//                         «Итого реализовано за вычетом возвратов» док-расчёта.
//   taxAmount           = realizationRevenueForTax × tax% / 100  (налог задаётся
//                         ПРОЦЕНТОМ от выручки реализации, НЕ от Итого Ozon; в БД/
//                         историю/отчёты идёт сумма в ₽)
//   manualExpensesTotal = taxAmount + packaging + warehouseDelivery + salary + other
//   netProfit           = profitBeforeManualExpenses − manualExpensesTotal
//   margin              = ozonOperationsTotal > 0 ? netProfit/ozonOperationsTotal*100 : 0
//
// ИСТОЧНИК СЕБЕСТОИМОСТИ (боевой): отчёт о реализации Ozon (тот же источник, что и
// документальный расчёт), а НЕ отправления (postings delivered-only). Себестоимость
// по отправлениям остаётся только СПРАВОЧНОЙ (postingsReferenceCost) и НЕ участвует
// в прибыли. byNetQty (продажи−возвраты) остаётся ТОЛЬКО в диагностике. Если из
// отчёта реализации нельзя надёжно получить себестоимость (нет offer_id, есть
// несопоставленные/без себестоимости строки, отчёт пуст/не получен) —
// loadAndComputeApiProfit возвращает ошибку, боевой расчёт НЕ показывается.
// ============================================================================

export const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

const NO_STORE = { "Cache-Control": "no-store" } as const;

// ---- ручные расходы (PR #18): optional, в БД сохраняем ТОЛЬКО при финале -----
export type ManualExpenses = {
  /** Налог: ПРОЦЕНТ от выручки реализации (не ₽). Сумма в ₽ считается в computeApiProfit. */
  tax: number;
  packaging: number;
  warehouseDelivery: number;
  salary: number;
  other: number;
};

export const MANUAL_EXPENSE_FIELDS = [
  "tax",
  "packaging",
  "warehouseDelivery",
  "salary",
  "other",
] as const;

export const MANUAL_EXPENSE_LABELS: Record<
  (typeof MANUAL_EXPENSE_FIELDS)[number],
  string
> = {
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
 * Чистая валидация — в БД здесь ничего не пишется.
 */
export function parseManualExpenses(
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
export function errorResponse(code: OzonFinanceErrorCode): NextResponse {
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

// ---------------------------------------------------------------------------
// Чистый расчёт прибыли по уже полученным агрегатам.
// ---------------------------------------------------------------------------

/** Полнота себестоимости: всё сопоставлено и >0 / есть несопоставленные / нет. */
export type CostStatus = "complete_cost" | "partial_cost" | "no_cost";

export type ApiProfitComputed = {
  ozonOperationsTotal: number;
  matchedCostTotal: number;
  profitBeforeManualExpenses: number;
  /** База налога: выручка отчёта реализации за вычетом возвратов (в ₽). */
  taxRevenueBase: number;
  manualExpenses: {
    tax: number;
    packaging: number;
    warehouseDelivery: number;
    salary: number;
    other: number;
    total: number;
  };
  netProfit: number;
  margin: number;
  status: CostStatus;
};

/**
 * Свести агрегаты финансов + БОЕВУЮ себестоимость (из отчёта реализации Ozon) +
 * ручные расходы в итоговые числа. ЧИСТАЯ функция — никаких сетей и БД.
 *
 * productionCost — боевая себестоимость из отчёта о реализации Ozon
 * (candidateCogs.bySaleQty), уже провалидированная вызывающим (полное покрытие).
 * Полнота проверяется ДО вызова (resolveRealizationProductionCost →
 * loadAndComputeApiProfit): сюда productionCost приходит только когда всё
 * сопоставлено и себестоимость > 0, поэтому status здесь = complete_cost.
 *
 * realizationRevenueForTax — БАЗА НАЛОГА: выручка отчёта реализации за вычетом
 * возвратов (sums.taxRevenueBase = deliveryAmount − returnAmount), тоже уже
 * провалидированная (> 0) вызывающим. Налог считается ПРОЦЕНТОМ от неё, а НЕ от
 * Итого Ozon.
 */
export function computeApiProfit(
  totals: OzonDraftTotals,
  productionCost: number,
  realizationRevenueForTax: number,
  manualExpenses: ManualExpenses
): ApiProfitComputed {
  // Ads и adjustments раньше были частью other (residual). Классификатор PR A
  // ВЫДЕЛИЛ их в отдельные signed-бакеты, поэтому теперь суммируем их явно —
  // сумма идентична прежней (ads+adjustments+other == прежний other), значит
  // ozonOperationsTotal и netProfit не меняются ни на копейку. logisticsLegacy/
  // logisticsServices — breakdown ВНУТРИ logistics, второй раз НЕ прибавляем.
  const ozonOperationsTotal = round2(
    totals.revenue +
      totals.commission +
      totals.logistics +
      totals.services +
      totals.storage +
      totals.ads +
      totals.adjustments +
      totals.other
  );
  // Боевая себестоимость = из отчёта о реализации Ozon (bySaleQty), НЕ из
  // отправлений. Отрицательную/нечисловую себестоимость не пропускаем.
  const matchedCostTotal =
    Number.isFinite(productionCost) && productionCost > 0
      ? round2(productionCost)
      : 0;
  const profitBeforeManualExpenses = round2(ozonOperationsTotal - matchedCostTotal);

  // База налога = выручка отчёта реализации за вычетом возвратов (НЕ Итого Ozon).
  // Приходит уже провалидированной (> 0); защитно отбрасываем нечисло/≤0 в 0.
  const taxRevenueBase =
    Number.isFinite(realizationRevenueForTax) && realizationRevenueForTax > 0
      ? round2(realizationRevenueForTax)
      : 0;
  // Налог задаётся ПРОЦЕНТОМ от выручки реализации, а не суммой в ₽.
  // В результат/историю/отчёты идёт уже рассчитанная сумма в ₽.
  // Пример: выручка реализации 409404, ставка 7 → 28658.28 ₽.
  const meTax = round2(taxRevenueBase * (manualExpenses.tax / 100));
  const mePackaging = round2(manualExpenses.packaging);
  const meWarehouseDelivery = round2(manualExpenses.warehouseDelivery);
  const meSalary = round2(manualExpenses.salary);
  const meOther = round2(manualExpenses.other);
  const manualExpensesTotal = round2(
    meTax + mePackaging + meWarehouseDelivery + meSalary + meOther
  );

  const netProfit = round2(profitBeforeManualExpenses - manualExpensesTotal);
  const margin =
    ozonOperationsTotal > 0 ? round2((netProfit / ozonOperationsTotal) * 100) : 0;

  // Себестоимость из реализации приходит уже полной (валидатор отсёк неполноту),
  // поэтому complete_cost при cost>0. Защитный no_cost — если по какой-то причине
  // себестоимость всё же 0 (боевой расчёт в этом случае не должен сохраняться).
  const status: CostStatus = matchedCostTotal > 0 ? "complete_cost" : "no_cost";

  return {
    ozonOperationsTotal,
    matchedCostTotal,
    profitBeforeManualExpenses,
    taxRevenueBase,
    manualExpenses: {
      tax: meTax,
      packaging: mePackaging,
      warehouseDelivery: meWarehouseDelivery,
      salary: meSalary,
      other: meOther,
      total: manualExpensesTotal,
    },
    netProfit,
    margin,
    status,
  };
}

// ---------------------------------------------------------------------------
// Боевая себестоимость из отчёта о реализации Ozon: валидация + резолюция.
//
// Себестоимость для API-прибыли берётся из /v2/finance/realization
// (candidateCogs.bySaleQty). Прежде чем использовать её как боевую, проверяем
// НАДЁЖНОСТЬ. Любая из проблем → боевой расчёт останавливается понятной ошибкой
// (мы НЕ показываем неверную прибыль и НЕ используем postings как тихий фолбэк):
//   • not_connected — отчёт реализации не получен (сеть/ключ);
//   • no_rows       — отчёт пуст (нет строк) → себестоимость не определить;
//   • no_offer_id   — в строках нет offer_id → сопоставить с каталогом нельзя;
//   • unmatched     — есть строки, не сопоставленные с каталогом;
//   • no_cost       — есть сопоставленные строки без cost_price (0 ₽);
//   • zero_cost     — bySaleQty ≤ 0 (нечего использовать как себестоимость);
//   • no_tax_revenue — sums.taxRevenueBase ≤ 0 (выручку реализации для БАЗЫ НАЛОГА
//                      получить нельзя: нет delivery/return amount) → налог считать
//                      не от чего, боевой расчёт останавливается.
// unmatched/no_cost решаются пользователем в каталоге (заполнить себестоимость).
// ---------------------------------------------------------------------------

export type RealizationCostErrorCode =
  | "not_connected"
  | "no_rows"
  | "no_offer_id"
  | "unmatched"
  | "no_cost"
  | "zero_cost"
  | "no_tax_revenue";

export type RealizationCostResolution =
  | {
      ok: true;
      productionCost: number;
      /** База налога API: выручка реализации за вычетом возвратов (> 0). */
      realizationRevenueForTax: number;
    }
  | {
      ok: false;
      code: RealizationCostErrorCode;
      /** Кол-во несопоставленных строк реализации (для сообщения/каталога). */
      unmatchedRows: number;
      /** Кол-во сопоставленных строк без себестоимости (cost=0). */
      noCostRows: number;
      /** Код ошибки Ozon, если отчёт реализации не получен (not_connected). */
      ozonErrorCode?: OzonFinanceErrorCode;
    };

/**
 * Провалидировать диагностику отчёта реализации и вернуть боевую себестоимость
 * (bySaleQty) + БАЗУ НАЛОГА (taxRevenueBase = выручка за вычетом возвратов) ЛИБО
 * причину, по которой их нельзя использовать. ЧИСТАЯ функция.
 * byNetQty здесь НЕ используется (остаётся только в диагностике).
 */
export function resolveRealizationProductionCost(
  rz: RealizationDiagnostic
): RealizationCostResolution {
  const unmatchedRows = rz.candidateCogs.unmatchedRows;
  const noCostRows = rz.candidateCogs.matchedNoCostRows;
  if (!rz.connected) {
    return {
      ok: false,
      code: "not_connected",
      unmatchedRows: 0,
      noCostRows: 0,
      ozonErrorCode: rz.errorCode,
    };
  }
  if (rz.rowCount === 0) {
    return { ok: false, code: "no_rows", unmatchedRows: 0, noCostRows: 0 };
  }
  if (!rz.fieldsPresent.offerId) {
    return { ok: false, code: "no_offer_id", unmatchedRows, noCostRows };
  }
  if (unmatchedRows > 0) {
    return { ok: false, code: "unmatched", unmatchedRows, noCostRows };
  }
  if (noCostRows > 0) {
    return { ok: false, code: "no_cost", unmatchedRows, noCostRows };
  }
  const productionCost = round2(rz.candidateCogs.bySaleQty);
  if (!(productionCost > 0)) {
    return { ok: false, code: "zero_cost", unmatchedRows: 0, noCostRows: 0 };
  }
  // База налога: выручка реализации за вычетом возвратов. Если её нельзя получить
  // (нет delivery/return amount → ≤ 0) — налог считать не от чего, останавливаемся.
  const realizationRevenueForTax = round2(rz.sums.taxRevenueBase);
  if (!(realizationRevenueForTax > 0)) {
    return { ok: false, code: "no_tax_revenue", unmatchedRows: 0, noCostRows: 0 };
  }
  return { ok: true, productionCost, realizationRevenueForTax };
}

// ---------------------------------------------------------------------------
// Сборка тела ответа полного API-расчёта (PR #20).
//
// Успешный /api/ozon/save-calculation отдаёт полный API-расчёт
// (apiTotals/costDraft/preliminary/netProfitPreview/...) — фронт рендерит цифры
// ТОЛЬКО после сохранения. PR #20.1: preview-роут отключён (410), поэтому теперь
// это единственный потребитель билдера. Вынесено в чистую функцию, чтобы форма
// ответа была в одном месте. source/notes задаёт вызывающий.
// ---------------------------------------------------------------------------

export type ApiProfitResponseBody = {
  period: { month: string; dateFrom: string; dateTo: string };
  source: string;
  status: CostStatus;
  /** Источник боевой себестоимости: "realization" (отчёт о реализации Ozon). */
  costSource: "realization";
  /** СПРАВОЧНАЯ себестоимость по отправлениям (postings delivered-only): показываем
   *  как справку, в чистую прибыль НЕ входит. 0 — если отправления недоступны. */
  postingsReferenceCost: number;
  apiTotals: {
    ozonAccruals: number;
    returns: number;
    commission: number;
    logistics: number;
    logisticsLegacy: number;
    logisticsServices: number;
    services: number;
    ads: number;
    adjustments: number;
    storage: number;
    other: number;
    operationCount: number;
  };
  productCoverage: ProfitCostDraft["coverage"];
  costDraft: {
    matchedCostTotal: number;
    matchedNoCostCount: number;
    itemsWithoutCost: ProfitCostDraft["itemsWithoutCost"];
    topCostItems: ProfitCostDraft["topCostItems"];
  };
  preliminary: {
    ozonOperationsTotal: number;
    matchedCostTotal: number;
    profitBeforeManualExpenses: number;
    /** База налога: выручка отчёта реализации за вычетом возвратов (в ₽). */
    taxRevenueBase: number;
  };
  manualExpenses: ApiProfitComputed["manualExpenses"];
  netProfitPreview: { value: number; margin: number };
  manualExpensesNotIncluded: string[];
  warnings: string[];
  notes: string[];
};

/**
 * Собрать полный JSON API-расчёта из уже посчитанных агрегатов. ЧИСТАЯ функция:
 * ничего не тянет и не сохраняет. extraNotes — контекстные пояснения вызывающего
 * (preview: «не сохраняется»; save: «сохранён и списан»).
 */
export function buildApiProfitResponseBody(params: {
  month: string;
  range: MonthRange;
  source: string;
  draft: OzonDraftAggregate;
  cost: ProfitCostDraft;
  computed: ApiProfitComputed;
  /** СПРАВОЧНАЯ себестоимость по отправлениям (postings). НЕ в прибыли. */
  postingsReferenceCost: number;
  extraNotes?: string[];
}): ApiProfitResponseBody {
  const { month, range, source, draft, cost, computed, postingsReferenceCost, extraNotes } =
    params;
  const t = draft.totals;
  return {
    period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
    source,
    status: computed.status,
    costSource: "realization",
    postingsReferenceCost: round2(postingsReferenceCost),
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
    productCoverage: cost.coverage,
    costDraft: {
      matchedCostTotal: computed.matchedCostTotal,
      matchedNoCostCount: cost.matchedNoCostCount,
      itemsWithoutCost: cost.itemsWithoutCost,
      topCostItems: cost.topCostItems,
    },
    preliminary: {
      ozonOperationsTotal: computed.ozonOperationsTotal,
      matchedCostTotal: computed.matchedCostTotal,
      profitBeforeManualExpenses: computed.profitBeforeManualExpenses,
      taxRevenueBase: computed.taxRevenueBase,
    },
    manualExpenses: computed.manualExpenses,
    netProfitPreview: { value: computed.netProfit, margin: computed.margin },
    manualExpensesNotIncluded: [
      "tax",
      "packaging",
      "warehouse_delivery",
      "salary",
      "other_manual_expenses",
    ],
    warnings: [...draft.warnings, ...cost.warnings],
    notes: [...draft.notes, ...cost.notes, ...(extraNotes ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Загрузка из авторитетных источников + расчёт (общая для preview и save).
// ---------------------------------------------------------------------------

export type ApiProfitInputs = {
  admin: SupabaseClient;
  userId: string;
  clientId: string;
  apiKey: string;
  range: MonthRange;
  /** Месяц отчёта "YYYY-MM" — для отчёта о реализации (боевая себестоимость). */
  month: string;
  manualExpenses: ManualExpenses;
};

export type ApiProfitLoaded =
  | {
      ok: true;
      draft: OzonDraftAggregate;
      /** СПРАВОЧНАЯ себестоимость по отправлениям (postings). НЕ в прибыли. */
      cost: ProfitCostDraft;
      /** Диагностика отчёта о реализации Ozon (источник боевой себестоимости). */
      realization: RealizationDiagnostic;
      /** Боевая себестоимость (bySaleQty) — уже провалидированная. */
      productionCost: number;
      /** База налога: выручка реализации за вычетом возвратов — уже > 0. */
      realizationRevenueForTax: number;
      computed: ApiProfitComputed;
    }
  | { ok: false; kind: "ozon"; code: OzonFinanceErrorCode }
  | { ok: false; kind: "catalog" }
  | {
      ok: false;
      kind: "realization_cost";
      resolution: Extract<RealizationCostResolution, { ok: false }>;
    };

/**
 * Заново получить данные Ozon API + каталог себестоимости и пересчитать боевую
 * прибыль. Бэкенд НЕ доверяет числам с фронтенда — единственный источник истины.
 *
 * Боевая СЕБЕСТОИМОСТЬ берётся из ОТЧЁТА О РЕАЛИЗАЦИИ Ozon (/v2/finance/realization,
 * candidateCogs.bySaleQty) — тот же источник, что и документальный расчёт. Отчёт
 * реализации получаем и валидируем ДО расчёта: если себестоимость нельзя надёжно
 * получить (нет offer_id / несопоставленные / без себестоимости / пусто / не
 * получен) — возвращаем kind:"realization_cost" и НЕ считаем прибыль (боевой расчёт
 * не показывается). Себестоимость по отправлениям (postings) остаётся ТОЛЬКО
 * справочной (postingsReferenceCost) и НЕ используется как тихий фолбэк.
 *
 * НИЧЕГО не сохраняет и НЕ списывает — это делает вызывающий роут.
 * apiKey приходит уже расшифрованным; здесь он НЕ логируется и НЕ возвращается.
 */
export async function loadAndComputeApiProfit(
  input: ApiProfitInputs
): Promise<ApiProfitLoaded> {
  const { admin, userId, clientId, apiKey, range, month, manualExpenses } = input;

  // 1) финансы Ozon → OzonDraftAggregate. При включённом флаге сначала пробуем новый
  //    accrual-источник (/v1/finance/accrual/by-day); ЛЮБАЯ его неудача (429/deadline/
  //    truncation/невалидное обязательное поле/reconciliation) → null и полный откат к
  //    существующему legacy-агрегатору byte-for-byte. Флаг выключен → legacy как и раньше.
  let draft: OzonDraftAggregate | null = null;
  if (isAccrualFinanceEnabled()) {
    draft = await loadAccrualDraft({ clientId, apiKey, month });
  }
  if (draft === null) {
    const tx = await fetchOzonTransactions(clientId, apiKey, range);
    if (!tx.ok) return { ok: false, kind: "ozon", code: tx.code };
    draft = aggregateDraft(tx.operations, tx.partial);
  }

  // 2) каталог себестоимости пользователя (read-only, только свои строки) — нужен
  //    и для сопоставления отчёта реализации, и для справочной себестоимости.
  const { data: catalog, error: catErr } = await admin
    .from("products")
    .select("sku, name, cost_price")
    .eq("user_id", userId);
  if (catErr) {
    // eslint-disable-next-line no-console
    console.error("[ozon/profit] products select error", catErr);
    return { ok: false, kind: "catalog" };
  }
  const catalogRows = (catalog ?? []) as CatalogRow[];

  // 3) БОЕВАЯ себестоимость из отчёта о реализации Ozon + валидация надёжности.
  //    productionCost = candidateCogs.bySaleQty (Σ кол-во продаж × cost каталога).
  const realization = await loadRealizationDiagnostic({
    clientId,
    apiKey,
    month,
    catalog: catalogRows,
  });
  const resolution = resolveRealizationProductionCost(realization);
  if (!resolution.ok) {
    return { ok: false, kind: "realization_cost", resolution };
  }
  const productionCost = resolution.productionCost;
  const realizationRevenueForTax = resolution.realizationRevenueForTax;

  // 4) СПРАВОЧНАЯ себестоимость по отправлениям (postings) — best-effort. НЕ
  //    участвует в прибыли и НЕ гейтит расчёт: фатальная ошибка отправлений НЕ
  //    валит боевой расчёт (показываем справку 0). Прежняя delivered-only логика
  //    больше НЕ боевая себестоимость.
  const postings = await fetchMonthPostings(clientId, apiKey, range);
  const cost = aggregateProfitCostDraft(
    postings.fatalCode ? [] : postings.items,
    postings.warnings,
    catalogRows
  );

  // 5) формула: себестоимость из реализации + налог от выручки реализации.
  const computed = computeApiProfit(
    draft.totals,
    productionCost,
    realizationRevenueForTax,
    manualExpenses
  );

  return {
    ok: true,
    draft,
    cost,
    realization,
    productionCost,
    realizationRevenueForTax,
    computed,
  };
}
