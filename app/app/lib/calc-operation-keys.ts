// ============================================================================
// Операции расчёта для ручного режима и Ozon API: параметры → отпечаток запроса
// (request_hash) и итог ручного расчёта. Чистые функции без зависимостей — общие
// для сервера (маршруты считают отпечаток и итог сами, не доверяя клиенту) и
// клиента (тот же отпечаток индексирует ключ незавершённой операции у страницы).
//
// Отпечаток = режим + параметры расчёта. Ключ операции (UUID) хранится у страницы
// по паре «пользователь + отпечаток»: тот же расчёт с теми же параметрами после
// потерянного ответа или перезагрузки повторяет ТУ ЖЕ операцию, другие параметры —
// другая операция. Сервер сверяет отпечаток с сохранённым: тот же ключ с другими
// параметрами → конфликт, без записи.
// ============================================================================

import { hash53 } from "./hash53";

export const MANUAL_REQUEST_PREFIX = "manual:v1:";
export const API_REQUEST_PREFIX = "api:v1:";

/** Поля ручного расчёта (₽) в порядке формы. */
export const MANUAL_INPUT_FIELDS = [
  "revenue",
  "commission",
  "logistics",
  "storage",
  "ads",
  "cost",
  "tax",
  "other",
] as const;

export type ManualInputField = (typeof MANUAL_INPUT_FIELDS)[number];

export type ManualCalcInputs = { marketplace: "ozon" | "wb" } & Record<ManualInputField, number>;

/** Итог ручного расчёта — те же колонки, что пишутся в calculations. */
export interface ManualCalcColumns {
  marketplace: "ozon" | "wb";
  revenue: number;
  commission: number;
  logistics: number;
  ads: number;
  storage: number;
  tax: number;
  cost: number;
  other_expenses: number;
  total_expenses: number;
  profit: number;
  margin: number;
}

/** Ручные расходы API-расчёта (как parseManualExpenses на сервере). */
export interface ApiManualExpenses {
  tax: number;
  packaging: number;
  warehouseDelivery: number;
  salary: number;
  other: number;
}

const MAX_ABS = 1e13;

function fingerprint(body: string): string {
  return `${body.length}:${hash53(body).toString(36)}:${hash53(body, 7).toString(36)}`;
}

/** Разбор входа ручного расчёта (сервер): числа конечные, маркетплейс известен. */
export function parseManualInputs(raw: unknown): { ok: true; value: ManualCalcInputs } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (o.marketplace !== "ozon" && o.marketplace !== "wb") return { ok: false };
  const out = { marketplace: o.marketplace } as ManualCalcInputs;
  for (const f of MANUAL_INPUT_FIELDS) {
    const v = o[f];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_ABS) return { ok: false };
    out[f] = v;
  }
  return { ok: true, value: out };
}

/**
 * Итог ручного расчёта — ровно та же арифметика и порядок сложения, что в форме
 * (page.tsx), чтобы сервер и экран получали одинаковые числа.
 */
export function computeManualColumns(i: ManualCalcInputs): ManualCalcColumns {
  const expenses = i.commission + i.logistics + i.storage + i.ads + i.cost + i.tax + i.other;
  const profit = i.revenue - expenses;
  const margin = i.revenue > 0 ? (profit / i.revenue) * 100 : 0;
  return {
    marketplace: i.marketplace,
    revenue: i.revenue,
    commission: i.commission,
    logistics: i.logistics,
    ads: i.ads,
    storage: i.storage,
    tax: i.tax,
    cost: i.cost,
    other_expenses: i.other,
    total_expenses: expenses,
    profit,
    margin,
  };
}

/** Отпечаток ручного расчёта: маркетплейс и все поля формы. */
export function manualRequestHash(i: ManualCalcInputs): string {
  return MANUAL_REQUEST_PREFIX + fingerprint(JSON.stringify([i.marketplace, ...MANUAL_INPUT_FIELDS.map((f) => i[f])]));
}

/** Отпечаток API-расчёта: месяц и ручные расходы. */
export function apiRequestHash(month: string, e: ApiManualExpenses): string {
  return (
    API_REQUEST_PREFIX +
    month +
    ":" +
    fingerprint(JSON.stringify([month, e.tax, e.packaging, e.warehouseDelivery, e.salary, e.other]))
  );
}

/** Режим операции по отпечатку (ключи XLSX — отпечатки файла без префикса режима). */
export function operationModeOf(requestHash: string): "manual" | "api" | "upload" {
  if (requestHash.startsWith(MANUAL_REQUEST_PREFIX)) return "manual";
  if (requestHash.startsWith(API_REQUEST_PREFIX)) return "api";
  return "upload";
}
