import { effectiveHistoryMargin } from "./accrual/snapshot";
import { parseOzonFinanceTaxonomy } from "./ozon-finance-taxonomy-view";
import { extractReportMonthFromText } from "./report-month";
import type { CloudCalculation } from "./supabase-cloud";

export type SummaryMode = "all" | "manual" | "upload" | "api";
export type SummaryChoice = { id: string; shop: string; month?: string };
export type SummaryQuery = { year: string; mode: SummaryMode; choices: SummaryChoice[]; page: number };

type FinancialRow = Pick<CloudCalculation,
  "id" | "mode" | "marketplace" | "created_at" | "ai_insights" | "revenue" |
  "profit" | "margin" | "cost" | "total_expenses" | "commission" | "tax" |
  "storage" | "logistics" | "ads" | "other_expenses"
>;

type Period = { from: string; to: string };
type Report = { row: FinancialRow; month: string | null; period: Period | null; store: string | null };
type ConfirmedReport = Report & { period: Period; store: string; choiceOrder: number };
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHOP_KEY = /^[0-9a-f]{64}$/;
const PAGE_SIZE = 25;
const amount = (v: unknown) => Number(v) || 0;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function parseSummaryQuery(body: unknown): SummaryQuery | null {
  const { year, mode, choices, page } = object(body);
  if (typeof year !== "string" || (year !== "all" && !/^\d{4}$/.test(year)) ||
      (mode !== "all" && mode !== "manual" && mode !== "upload" && mode !== "api") ||
      typeof page !== "number" || !Number.isSafeInteger(page) || page < 0 ||
      !Array.isArray(choices) || choices.length > 2000) return null;
  const parsed: SummaryChoice[] = [];
  for (const entry of choices) {
    const { id, shop, month } = object(entry);
    if (typeof id !== "string" || !UUID.test(id) || typeof shop !== "string" ||
        !(SHOP_KEY.test(shop) || /^label:[^\p{Cc}]{1,80}$/u.test(shop)) ||
        (month !== undefined && (typeof month !== "string" || !MONTH.test(month)))) return null;
    parsed.push({ id, shop, month });
  }
  return { year, mode, choices: parsed, page };
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value)) return null;
  const day = value.slice(0, 10);
  const timestamp = Date.parse(day + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(day) ? day : null;
}

function reportFor(row: FinancialRow): Report {
  const snapshot = object(row.ai_insights);
  const p = object(snapshot.period);
  const api = row.mode === "api" && snapshot.kind === "ozon-api-v1";
  const xlsx = row.mode === "upload" && snapshot.kind === "ozon-accrual-xlsx-v1";
  const from = api || xlsx ? isoDay(p.declaredFrom ?? p.dateFrom) : null;
  const to = api || xlsx ? isoDay(p.declaredTo ?? p.dateTo) : null;
  const period = from && to && from <= to ? { from, to } : null;
  const store = api && typeof snapshot.reportStoreKey === "string" && SHOP_KEY.test(snapshot.reportStoreKey)
    ? snapshot.reportStoreKey : null;
  const created = Date.parse(row.created_at);
  const month = row.mode === "manual"
    ? Number.isFinite(created) ? new Date(created).toISOString().slice(0, 7) : null
    : period?.to.slice(0, 7) ??
      (typeof p.month === "string" && MONTH.test(p.month) ? p.month : null) ??
      extractReportMonthFromText(typeof snapshot.reportPeriod === "string" ? snapshot.reportPeriod : null)?.slice(0, 7) ??
      null;
  return { row, month, period, store };
}

function fullMonth(month: string): Period {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: month + "-01", to: month + "-" + String(last).padStart(2, "0") };
}

function compareLatest(a: FinancialRow, b: FinancialRow): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id);
}

function overlaps(a: Period, b: Period): boolean {
  return a.from <= b.to && b.from <= a.to;
}

export function ozonRealizationRevenue(aiInsights: unknown): number | null {
  const snapshot = object(aiInsights);
  const base = object(snapshot.preliminary).taxRevenueBase;
  // Old API flat rows use accrued sales; recover the original margin denominator.
  return snapshot.kind === "ozon-api-v1" &&
    typeof base === "number" && Number.isFinite(base) && base > 0 ? base : null;
}

function summarize(included: Report[]) {
  const monthly = new Map<string, { key: string; profit: number; revenue: number; count: number }>();
  const totals = { count: 0, revenue: 0, profit: 0, cost: 0, expenses: 0, tax: 0,
    ozonFeesCharges: 0, adsCharges: 0, otherCharges: 0, manualExtraExpenses: 0, ozonIncome: 0,
    revenueBasisAdjustment: 0, missingRealizationBase: 0 };
  let knownMargin = 0;
  let knownCount = 0;
  for (const { row, month } of included) {
    const realized = row.mode === "api" ? ozonRealizationRevenue(row.ai_insights) : null;
    if (row.mode === "api" && realized === null) totals.missingRealizationBase++;
    const revenue = realized ?? amount(row.revenue);
    const profit = amount(row.profit);
    const flat = { commission: amount(row.commission), logistics: amount(row.logistics),
      ads: amount(row.ads), storage: amount(row.storage), other: amount(row.other_expenses),
      cost: amount(row.cost), tax: amount(row.tax), totalExpenses: amount(row.total_expenses) };
    const taxonomy = row.mode === "api" ? parseOzonFinanceTaxonomy(row.ai_insights, flat) : null;
    totals.count++;
    totals.revenue += revenue;
    totals.profit += profit;
    totals.cost += flat.cost;
    totals.tax += flat.tax;
    // Reconcile the report basis without assigning the difference to real fees or manual expenses.
    const basisAdjustment = revenue - amount(row.revenue);
    totals.expenses += flat.totalExpenses + basisAdjustment;
    totals.revenueBasisAdjustment += basisAdjustment;
    totals.ozonFeesCharges += flat.commission + (taxonomy?.logisticsCharges ?? flat.logistics) + flat.storage;
    totals.adsCharges += taxonomy?.adsCharges ?? flat.ads;
    totals.otherCharges += taxonomy?.otherCharges ?? flat.other;
    totals.manualExtraExpenses += taxonomy?.manualExtraExpenses ?? 0;
    totals.ozonIncome += taxonomy?.ozonIncome ?? 0;
    const margin = effectiveHistoryMargin(row.ai_insights, amount(row.margin));
    if (margin !== null) { knownMargin += margin; knownCount++; }
    if (month) {
      const entry = monthly.get(month) ?? { key: month, revenue: 0, profit: 0, count: 0 };
      entry.profit += profit;
      entry.revenue += revenue;
      entry.count++;
      monthly.set(month, entry);
    }
  }
  const months = Array.from(monthly.values()).sort((a, b) => a.key.localeCompare(b.key));
  let best = null;
  let worst = null;
  if (months.length > 1) {
    best = months.reduce((a, b) => a.profit >= b.profit ? a : b);
    worst = months.reduce((a, b) => a.profit <= b.profit ? a : b);
  }
  return {
    monthly: months,
    summary: totals.count ? {
      ...totals, best, worst,
      avgMargin: totals.revenue > 0 ? totals.profit / totals.revenue * 100 :
        knownCount > 0 ? knownMargin / knownCount : 0,
    } : null,
  };
}

export function buildFinancialSummary(rows: FinancialRow[], query: SummaryQuery) {
  const reports = rows.map(reportFor);
  const years = new Set<string>();
  const shops = new Map<string, string>();
  for (const { row, store } of reports) {
    if (!store) continue;
    const label = object(row.ai_insights).reportStoreLabel;
    shops.set(store, typeof label === "string" && label.startsWith("••••") && label.length <= 7
      ? label : shops.get(store) ?? store.slice(0, 8));
  }
  const choiceById = new Map(query.choices.map((choice, order) => [choice.id, { ...choice, order }]));
  const included: Report[] = [];
  const decisions = new Map<string, Report>();
  const byStore = new Map<string, ConfirmedReport[]>();
  const includedIds = new Set<string>();

  for (const r of reports) {
    const choice = choiceById.get(r.row.id);
    const period = r.period ?? (choice?.month ? fullMonth(choice.month) : null);
    const month = r.row.mode === "manual" ? r.month : period?.to.slice(0, 7) ?? r.month;
    if (month) years.add(month.slice(0, 4));
    if ((query.mode !== "all" && r.row.mode !== query.mode) ||
        (query.year !== "all" && month && !month.startsWith(query.year))) continue;
    if (r.row.mode === "manual") {
      if (query.year === "all" || month) included.push(r);
      continue;
    }
    const assertedShop = choice && (shops.has(choice.shop) || choice.shop.startsWith("label:")) ? choice.shop : null;
    const store = r.store ?? assertedShop;
    const candidate = { ...r, period, month, store };
    if (!r.store || !r.period) decisions.set(r.row.id, candidate);
    if (!store || !period) continue;
    const key = JSON.stringify([r.row.marketplace, store]);
    const group = byStore.get(key) ?? [];
    group.push({ ...candidate, period, store, choiceOrder: choice?.order ?? -1 });
    byStore.set(key, group);
  }

  for (const group of byStore.values()) {
    // Identical confirmed scopes are versions. An explicit choice takes priority;
    // otherwise the newest successfully saved record represents that exact scope.
    group.sort((a, b) => b.choiceOrder - a.choiceOrder || compareLatest(a.row, b.row));
    const exact = new Map<string, ConfirmedReport>();
    for (const r of group) {
      const key = r.period.from + "/" + r.period.to;
      if (!exact.has(key)) exact.set(key, r);
      if (r.choiceOrder !== -1) decisions.set(r.row.id, r);
    }
    const unique = [...exact.values()];
    for (const r of unique) {
      const intersects = unique.filter(other => other !== r && overlaps(r.period, other.period));
      if (intersects.length) {
        decisions.set(r.row.id, r);
        // Overlapping but different periods require an explicit selection.
        if (r.choiceOrder < 0 || intersects.some(other =>
          other.choiceOrder > r.choiceOrder && includedIds.has(other.row.id))) continue;
      }
      included.push(r);
      includedIds.add(r.row.id);
    }
  }

  const allDecisions = [...decisions.values()].sort((a, b) =>
    (b.month ?? "").localeCompare(a.month ?? "") || compareLatest(a.row, b.row));
  const start = query.page * PAGE_SIZE;
  return {
    ...summarize(included),
    years: [...years].sort().reverse(),
    decisionCount: allDecisions.length,
    excludedCount: allDecisions.filter(r => !includedIds.has(r.row.id)).length,
    decisionPageSize: PAGE_SIZE,
    shops: [...shops].sort(([a], [b]) => a.localeCompare(b)).map(([key, label]) => ({ key, label })),
    decisions: allDecisions.slice(start, start + PAGE_SIZE).map(r => {
      const original = reportFor(r.row);
      return {
        id: r.row.id, mode: r.row.mode, marketplace: r.row.marketplace,
        createdAt: r.row.created_at, period: r.period, month: r.month, profit: amount(r.row.profit),
        knownStore: original.store, hasPeriod: original.period !== null,
        included: includedIds.has(r.row.id),
      };
    }),
  };
}

export type FinancialSummary = ReturnType<typeof buildFinancialSummary>;
