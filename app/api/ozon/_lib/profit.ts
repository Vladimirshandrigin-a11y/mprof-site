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
// Формула (PR #16, не ломаем): returns УЖЕ внутри signed revenue
// (accruals_for_sale со знаком), поэтому повторно его НЕ прибавляем —
//   ozonOperationsTotal = revenue + commission + logistics + services + storage + other
//   profitBeforeManualExpenses = ozonOperationsTotal − matchedCostTotal
// PR #18 (ручные расходы):
//   manualExpensesTotal = tax + packaging + warehouseDelivery + salary + other
//   netProfit           = profitBeforeManualExpenses − manualExpensesTotal
//   margin              = ozonOperationsTotal > 0 ? netProfit/ozonOperationsTotal*100 : 0
// ============================================================================

export const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

const NO_STORE = { "Cache-Control": "no-store" } as const;

// ---- ручные расходы (PR #18): optional, в БД сохраняем ТОЛЬКО при финале -----
export type ManualExpenses = {
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
 * Свести агрегаты финансов + себестоимости + ручные расходы в итоговые числа.
 * ЧИСТАЯ функция — никаких сетей и БД. Используется И в preview, И в финальном
 * сохранении, чтобы цифры были идентичны. Формулу выше не меняем.
 */
export function computeApiProfit(
  totals: OzonDraftTotals,
  cost: ProfitCostDraft,
  manualExpenses: ManualExpenses
): ApiProfitComputed {
  const ozonOperationsTotal = round2(
    totals.revenue +
      totals.commission +
      totals.logistics +
      totals.services +
      totals.storage +
      totals.other
  );
  const matchedCostTotal = cost.matchedCostTotal;
  const profitBeforeManualExpenses = round2(ozonOperationsTotal - matchedCostTotal);

  const meTax = round2(manualExpenses.tax);
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

  // no_cost: себестоимости нет совсем; partial_cost: есть несопоставленные;
  // complete_cost: всё сопоставлено и себестоимость > 0.
  let status: CostStatus;
  if (matchedCostTotal <= 0) {
    status = "no_cost";
  } else if (
    cost.coverage.unmatchedItems > 0 ||
    cost.coverage.unmatchedQuantity > 0
  ) {
    status = "partial_cost";
  } else {
    status = "complete_cost";
  }

  return {
    ozonOperationsTotal,
    matchedCostTotal,
    profitBeforeManualExpenses,
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
  apiTotals: {
    ozonAccruals: number;
    returns: number;
    commission: number;
    logistics: number;
    services: number;
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
  extraNotes?: string[];
}): ApiProfitResponseBody {
  const { month, range, source, draft, cost, computed, extraNotes } = params;
  const t = draft.totals;
  return {
    period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
    source,
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
      matchedNoCostCount: cost.matchedNoCostCount,
      itemsWithoutCost: cost.itemsWithoutCost,
      topCostItems: cost.topCostItems,
    },
    preliminary: {
      ozonOperationsTotal: computed.ozonOperationsTotal,
      matchedCostTotal: computed.matchedCostTotal,
      profitBeforeManualExpenses: computed.profitBeforeManualExpenses,
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
  manualExpenses: ManualExpenses;
};

export type ApiProfitLoaded =
  | {
      ok: true;
      draft: OzonDraftAggregate;
      cost: ProfitCostDraft;
      computed: ApiProfitComputed;
    }
  | { ok: false; kind: "ozon"; code: OzonFinanceErrorCode }
  | { ok: false; kind: "catalog" };

/**
 * Заново получить данные Ozon API (финансы + отправления) и каталог
 * себестоимости пользователя, затем пересчитать прибыль. Бэкенд НЕ доверяет
 * числам с фронтенда — это единственный источник истины для обоих роутов.
 *
 * НИЧЕГО не сохраняет и НЕ списывает — это делает вызывающий роут.
 * apiKey приходит уже расшифрованным; здесь он НЕ логируется и НЕ возвращается.
 */
export async function loadAndComputeApiProfit(
  input: ApiProfitInputs
): Promise<ApiProfitLoaded> {
  const { admin, userId, clientId, apiKey, range, manualExpenses } = input;

  // 1) финансы Ozon (operations)
  const tx = await fetchOzonTransactions(clientId, apiKey, range);
  if (!tx.ok) return { ok: false, kind: "ozon", code: tx.code };
  const draft = aggregateDraft(tx.operations, tx.partial);

  // 2) отправления FBO+FBS (фатальная ошибка схемы → код Ozon)
  const postings = await fetchMonthPostings(clientId, apiKey, range);
  if (postings.fatalCode) return { ok: false, kind: "ozon", code: postings.fatalCode };

  // 3) каталог себестоимости пользователя (read-only, только свои строки)
  const { data: catalog, error: catErr } = await admin
    .from("products")
    .select("sku, name, cost_price")
    .eq("user_id", userId);
  if (catErr) {
    // eslint-disable-next-line no-console
    console.error("[ozon/profit] products select error", catErr);
    return { ok: false, kind: "catalog" };
  }

  // 4) себестоимость ТОЛЬКО по сопоставленным товарам (без fuzzy)
  const cost = aggregateProfitCostDraft(
    postings.items,
    postings.warnings,
    (catalog ?? []) as CatalogRow[]
  );

  // 5) формула
  const computed = computeApiProfit(draft.totals, cost, manualExpenses);

  return { ok: true, draft, cost, computed };
}
