"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ProfitRecommendations,
  type ProfitRecommendationsProps,
} from "./ProfitRecommendations";
import { supabase } from "../lib/supabase-cloud";

interface AnalyticsCalc {
  id: string;
  marketplace: "ozon" | "wb";
  revenue: number;
  profit: number;
  margin: number;
  expenses: number;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  cost: number;
  tax: number;
  other: number;
  date: string;
  /** ai_insights расчёта (net-profit-3file breakdown) — нужно лишь чтобы выбрать
   *  подпись прибыли: «Чистая прибыль» vs «Прибыль до себестоимости». */
  aiInsights?: unknown;
}

interface Props {
  realHistory?: AnalyticsCalc[];
  /** Отдельный порядок ТОЛЬКО для линейных графиков (выручка/прибыль):
   *  хронологический, старый месяц слева → новый справа. Считается на странице
   *  (там есть разбор report_period). Если не передан — берём realHistory в
   *  обратном порядке (как раньше). На статистику/историю не влияет. */
  chartHistory?: AnalyticsCalc[];
  hasAnyData?: boolean;
  hasPremium?: boolean;
  onOpenPremium?: () => void;
  /** Данные для умных рекомендаций внутри карточки «AI Аналитика».
   *  Считаются на странице (combinedResult + profitCalc + покрытие/товары).
   *  Если не переданы — карточка показывает пустое состояние. */
  reco?: ProfitRecommendationsProps;
}

/* ---------- DEMO ---------- */

const DEMO_REVENUE_14D = [
  12200, 14800, 17500, 16100, 22300, 27500, 31800,
  29400, 35800, 41900, 38200, 46100, 51700, 48400,
];
const DEMO_PROFIT_14D = [
  2400, 3050, 3750, 3380, 4480, 5810, 6920,
  6210, 7480, 8990, 8180, 9750, 10820, 10310,
];

interface ExpenseSegment {
  label: string;
  value: number;
  color: string;
}

const DEMO_EXPENSES: ExpenseSegment[] = [
  { label: "Себестоимость", value: 145000, color: "#2ECC8A" },
  { label: "Комиссия",      value:  96500, color: "#C9A84C" },
  { label: "Реклама",       value:  69800, color: "#cb11ab" },
  { label: "Логистика",     value:  48200, color: "#5b7fff" },
  { label: "Хранение",      value:  33000, color: "#5BC7C9" },
  { label: "Налог",         value:  28000, color: "#E05566" },
  { label: "Прочее",        value:  22000, color: "#7C8DB5" },
];

interface DemoRecent {
  product: string;
  marketplace: "ozon" | "wb";
  profit: number;
  margin: number;
  date: string;
  /** Подпись над суммой: «Чистая прибыль» или «Прибыль до себестоимости». */
  profitLabel: string;
}

const DEMO_RECENT: DemoRecent[] = [
  { product: "Куртка зимняя унисекс", marketplace: "ozon", profit: 24580, margin: 22.4, date: "сегодня",     profitLabel: "Чистая прибыль" },
  { product: "Кроссовки беговые",     marketplace: "wb",   profit: 18920, margin: 19.8, date: "вчера",       profitLabel: "Чистая прибыль" },
  { product: "Платье летнее",         marketplace: "ozon", profit: 12450, margin: 17.2, date: "2 дня назад", profitLabel: "Чистая прибыль" },
  { product: "Рюкзак городской",      marketplace: "wb",   profit:  9870, margin: 21.0, date: "3 дня назад", profitLabel: "Чистая прибыль" },
];

/* ---------- ICONS ---------- */

const ICONS = {
  trendUp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  ),
  percent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  ),
  target: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
      <path d="M12 22.08V12" />
    </svg>
  ),
  zap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  ),
  pieChart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 21h8M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 5h2a2 2 0 0 1 0 4h-2M7 5H5a2 2 0 0 0 0 4h2" />
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h11v9H3z" />
      <path d="M14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17" cy="18" r="1.6" />
    </svg>
  ),
};

type InsightKind = "positive" | "warning" | "danger" | "optimization";

interface Insight {
  kind: InsightKind;
  ico: ReactNode;
  text: string;
}

const DEMO_INSIGHTS: Insight[] = [
  {
    kind: "positive",
    ico: ICONS.trendUp,
    text: "Маржинальность 24% — выше средней по категории.",
  },
  {
    kind: "warning",
    ico: ICONS.target,
    text: "Реклама съедает 18% расходов — перегретая реклама.",
  },
  {
    kind: "optimization",
    ico: ICONS.zap,
    text: "Снижение CPC на 12% повысит прибыль.",
  },
];

interface Tier {
  label: string;
  kind: "weak" | "stable" | "strong" | "excellent";
}

function getTier(score: number): Tier {
  if (score >= 81) return { label: "Отличный", kind: "excellent" };
  if (score >= 56) return { label: "Сильный", kind: "strong" };
  if (score >= 31) return { label: "Стабильный", kind: "stable" };
  return { label: "Слабый", kind: "weak" };
}

const DEMO_SCORE = 78;

/* ---------- HELPERS ---------- */

const fmt = (n: number) =>
  Math.round(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 });

const fmtSigned = (n: number) =>
  (n >= 0 ? "+" : "−") + fmt(Math.abs(n));

/**
 * Подпись к сумме прибыли в «Последних расчётах». Зеркалит логику детальной
 * «Истории расчётов» (page.tsx): «Прибыль до себестоимости» показываем ТОЛЬКО
 * для отчёта (net-profit-3file) без введённой себестоимости (costPrice ≤ 0).
 * Во всех остальных случаях (ручной расчёт, или отчёт с себестоимостью) число
 * уже финальное → «Чистая прибыль». Старые записи без ai_insights → безопасный
 * дефолт «Чистая прибыль». Формулы не трогаем — берём готовое значение profit.
 */
function profitLabelFor(aiInsights: unknown): string {
  if (aiInsights && typeof aiInsights === "object") {
    const o = aiInsights as Record<string, unknown>;
    if (o.kind === "net-profit-3file") {
      const cp =
        typeof o.costPrice === "number" && Number.isFinite(o.costPrice)
          ? o.costPrice
          : 0;
      if (cp <= 0) return "Прибыль до себестоимости";
    }
  }
  return "Чистая прибыль";
}

function computeExpenseBreakdown(history: AnalyticsCalc[]): ExpenseSegment[] {
  const totals = history.reduce(
    (acc, h) => {
      acc.cost       += h.cost;
      acc.commission += h.commission;
      acc.ads        += h.ads;
      acc.logistics  += h.logistics;
      acc.tax        += h.tax;
      acc.storage    += h.storage;
      acc.other      += h.other;
      return acc;
    },
    { cost: 0, commission: 0, ads: 0, logistics: 0, tax: 0, storage: 0, other: 0 }
  );

  return [
    { label: "Себестоимость", value: totals.cost,       color: "#2ECC8A" },
    { label: "Комиссия",      value: totals.commission, color: "#C9A84C" },
    { label: "Реклама",       value: totals.ads,        color: "#cb11ab" },
    { label: "Логистика",     value: totals.logistics,  color: "#5b7fff" },
    { label: "Налог",         value: totals.tax,        color: "#E05566" },
    { label: "Хранение",      value: totals.storage,    color: "#5BC7C9" },
    { label: "Прочее",        value: totals.other,      color: "#7C8DB5" },
  ].filter((e) => e.value > 0);
}

function computeInsights(history: AnalyticsCalc[]): Insight[] {
  if (history.length === 0) return DEMO_INSIGHTS;

  const sumRev = history.reduce((s, h) => s + h.revenue, 0);
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  const sumAds = history.reduce((s, h) => s + h.ads, 0);
  const sumLog = history.reduce((s, h) => s + h.logistics, 0);
  const sumCom = history.reduce((s, h) => s + h.commission, 0);
  const sumStore = history.reduce((s, h) => s + h.storage, 0);
  const sumProfit = history.reduce((s, h) => s + h.profit, 0);
  const avgMargin =
    history.reduce((s, h) => s + h.margin, 0) / history.length;
  const losing = history.find((h) => h.profit < 0);

  const comShare = sumRev > 0 ? sumCom / sumRev : 0;
  const adShare = sumExp > 0 ? sumAds / sumExp : 0;
  const logShare = sumRev > 0 ? sumLog / sumRev : 0;
  const storeShare = sumExp > 0 ? sumStore / sumExp : 0;

  const out: Insight[] = [];

  // === DANGER ===
  if (losing) {
    out.push({
      kind: "danger",
      ico: ICONS.alert,
      text: "Найден убыточный расчёт — проверьте структуру расходов.",
    });
  }
  if (avgMargin < 0) {
    out.push({
      kind: "danger",
      ico: ICONS.alert,
      text: `Средняя маржа ${avgMargin.toFixed(1)}% — товар работает в минус.`,
    });
  }

  // === WARNING ===
  if (comShare > 0.2) {
    out.push({
      kind: "warning",
      ico: ICONS.percent,
      text: `Комиссия маркетплейса ${(comShare * 100).toFixed(0)}% — слишком высокая для этой категории.`,
    });
  }
  if (adShare > 0.22) {
    out.push({
      kind: "warning",
      ico: ICONS.target,
      text: `Реклама занимает ${(adShare * 100).toFixed(0)}% расходов — попробуйте снизить CPC.`,
    });
  }
  if (logShare > 0.12) {
    out.push({
      kind: "warning",
      ico: ICONS.truck,
      text: `Логистика ${(logShare * 100).toFixed(0)}% выручки — выше нормы, оптимизируйте отгрузки.`,
    });
  }
  if (storeShare > 0.08) {
    out.push({
      kind: "warning",
      ico: ICONS.box,
      text: `Хранение выше среднего (${(storeShare * 100).toFixed(0)}% расходов) — уменьшите остатки.`,
    });
  }
  if (avgMargin > 0 && avgMargin < 5) {
    out.push({
      kind: "warning",
      ico: ICONS.percent,
      text: `Низкая маржинальность ${avgMargin.toFixed(1)}% — близко к точке безубыточности.`,
    });
  }
  if (adShare > 0.3 && avgMargin > 8) {
    out.push({
      kind: "warning",
      ico: ICONS.target,
      text: `Высокая зависимость прибыли от рекламы (${(adShare * 100).toFixed(0)}% расходов) — риск при росте ставок.`,
    });
  }

  // === POSITIVE ===
  if (avgMargin >= 25) {
    out.push({
      kind: "positive",
      ico: ICONS.trendUp,
      text: `Маржа ${avgMargin.toFixed(1)}% — товар прибыльный, можно масштабировать рекламу.`,
    });
  } else if (avgMargin >= 15) {
    out.push({
      kind: "positive",
      ico: ICONS.trendUp,
      text: `Маржа ${avgMargin.toFixed(1)}% — здоровый уровень, продолжайте курс.`,
    });
  }

  if (sumProfit > 100000) {
    out.push({
      kind: "positive",
      ico: ICONS.trophy,
      text: `Текущая прибыль ${fmt(sumProfit)} ₽ — позволяет наращивать обороты.`,
    });
  }

  // сравнение МП — только если есть данные с обеих площадок
  const ozonProfit = history
    .filter((h) => h.marketplace === "ozon")
    .reduce((s, h) => s + h.profit, 0);
  const wbProfit = history
    .filter((h) => h.marketplace === "wb")
    .reduce((s, h) => s + h.profit, 0);
  if (ozonProfit > 0 && wbProfit > 0) {
    const winner = wbProfit > ozonProfit ? "WB" : "Ozon";
    const a = Math.max(ozonProfit, wbProfit);
    const b = Math.min(ozonProfit, wbProfit);
    const diff = b > 0 ? ((a - b) / b) * 100 : 0;
    out.push({
      kind: "positive",
      ico: ICONS.trophy,
      text: `${winner} приносит на ${diff.toFixed(0)}% больше прибыли.`,
    });
  }

  // ===== OPTIMIZATION (actionable suggestion) =====
  if (avgMargin > 0 && avgMargin < 15) {
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: "Поднимите цену на 4–6% — маржинальность остаётся безопасной.",
    });
  } else if (adShare > 0.18) {
    const cut = Math.min(20, Math.max(8, Math.round((adShare - 0.10) * 100)));
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: `Снижение CPC на ${cut}% повысит чистую прибыль.`,
    });
  } else if (storeShare > 0.07) {
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: "Сократите остатки на складе — оборачиваемость вырастет.",
    });
  } else if (avgMargin >= 25) {
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: "Текущая маржа позволяет масштабировать рекламу.",
    });
  } else if (logShare > 0.10) {
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: "Объедините отгрузки — логистика снизится на 10–15%.",
    });
  } else {
    out.push({
      kind: "optimization",
      ico: ICONS.zap,
      text: "Точечная настройка CPC рекламы повысит ROI.",
    });
  }

  if (out.length === 0) {
    out.push({
      kind: "positive",
      ico: ICONS.trendUp,
      text: `Сохранено ${history.length} расчётов — данных достаточно для анализа.`,
    });
  }

  // Приоритет: сначала danger, потом warning, optimization, positive.
  const order: InsightKind[] = ["danger", "warning", "optimization", "positive"];
  return out
    .slice()
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, 4);
}

function computeScore(history: AnalyticsCalc[]): number {
  if (history.length === 0) return DEMO_SCORE;

  const sumRev = history.reduce((s, h) => s + h.revenue, 0);
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  const sumAds = history.reduce((s, h) => s + h.ads, 0);
  const sumLog = history.reduce((s, h) => s + h.logistics, 0);
  const sumCom = history.reduce((s, h) => s + h.commission, 0);
  const avgMargin =
    history.reduce((s, h) => s + h.margin, 0) / history.length;
  const hasLoss = history.some((h) => h.profit < 0);

  // base score from margin (0-50)
  let score = Math.max(0, Math.min(50, avgMargin * 1.4));

  // bonus for healthy margin
  if (avgMargin >= 25) score += 25;
  else if (avgMargin >= 15) score += 15;
  else if (avgMargin >= 5) score += 6;

  // penalties
  const adShare = sumExp > 0 ? sumAds / sumExp : 0;
  if (adShare > 0.30) score -= 14;
  else if (adShare > 0.22) score -= 8;
  else if (adShare > 0.15) score -= 3;

  const logShare = sumRev > 0 ? sumLog / sumRev : 0;
  if (logShare > 0.15) score -= 10;
  else if (logShare > 0.10) score -= 4;

  const comShare = sumRev > 0 ? sumCom / sumRev : 0;
  if (comShare > 0.22) score -= 8;
  else if (comShare > 0.18) score -= 3;

  if (hasLoss) score -= 18;
  if (avgMargin < 0) score -= 20;

  // bonus for stable positive baseline
  if (!hasLoss && avgMargin > 10) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

const clamp = (min: number, max: number, v: number) =>
  Math.max(min, Math.min(max, v));

/* ===== AI cockpit helpers ===== */

type Confidence = "low" | "medium" | "high";
function getConfidence(n: number): Confidence {
  if (n >= 10) return "high";
  if (n >= 3) return "medium";
  return "low";
}
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "Низкая",
  medium: "Средняя",
  high: "Высокая",
};
/** Численный показатель уверенности AI в анализе (для подписи рядом с лейблом). */
function getConfidencePct(n: number): number {
  if (n === 0) return 35; // demo baseline
  // плавно растём от 52% (n=1) до 92% (n>=10)
  return Math.round(Math.max(52, Math.min(92, 48 + n * 4.8)));
}

type TrendDir = "up" | "down" | "flat";
interface TrendInfo {
  dir: TrendDir;
  delta: number;
}
function getTrend(history: AnalyticsCalc[]): TrendInfo {
  if (history.length < 2) return { dir: "flat", delta: 0 };
  // history[0] — newest (см. loadHistory order desc)
  const latest = history[0];
  const rest = history.slice(1);
  const prevAvg = rest.reduce((s, h) => s + h.margin, 0) / rest.length;
  const delta = latest.margin - prevAvg;
  if (delta > 1) return { dir: "up", delta };
  if (delta < -1) return { dir: "down", delta };
  return { dir: "flat", delta: 0 };
}

interface FinancialIndicators {
  commission: number; // share of revenue, 0..1
  ads: number;        // share of expenses, 0..1
  logistics: number;  // share of revenue, 0..1
  margin: number;     // average margin %
}
function computeIndicators(history: AnalyticsCalc[]): FinancialIndicators {
  if (history.length === 0) {
    return { commission: 0.18, ads: 0.22, logistics: 0.14, margin: 24 };
  }
  const sumRev = history.reduce((s, h) => s + h.revenue, 0);
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  return {
    commission: sumRev > 0
      ? history.reduce((s, h) => s + h.commission, 0) / sumRev
      : 0,
    ads: sumExp > 0
      ? history.reduce((s, h) => s + h.ads, 0) / sumExp
      : 0,
    logistics: sumRev > 0
      ? history.reduce((s, h) => s + h.logistics, 0) / sumRev
      : 0,
    margin: history.reduce((s, h) => s + h.margin, 0) / history.length,
  };
}

/* ===== Числовая аналитика для «книжки» AI (слайды) =====
   Все агрегаты берём из готовых расчётов (history). САМУ математику расчёта
   прибыли НЕ меняем — только суммируем уже посчитанные поля и форматируем.
   Слайды строятся из этих чисел, поэтому выглядят как настоящая аналитика
   и в режиме AI, и в фолбэке (без техтекста). */
interface AiFinancials {
  isDemo: boolean;
  count: number;
  lossCount: number;
  noCostCount: number;
  revenue: number;
  profit: number;
  cost: number;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  tax: number;
  other: number;
  expenses: number;
  marginPct: number;
  hasCost: boolean;
  // revenue − expenses − profit. Для корректных расчётов ≈ 0 (модель хранит
  // тождество profit = revenue − total_expenses), поэтому показываем «расхождение»
  // только при реально большом отклонении — не выдумываем его на ровном месте.
  discrepancy: number;
}
function buildFinancials(history: AnalyticsCalc[]): AiFinancials {
  if (history.length === 0) {
    // demo-числа для пустого состояния (до первого расчёта / за замком).
    // Внутренне согласованы: profit = revenue − сумма всех статей расходов.
    const revenue = 755260;
    const cost = 475060, commission = 98180, logistics = 52870,
      ads = 41540, storage = 13600, tax = 22650, other = 12400;
    const expenses = cost + commission + logistics + ads + storage + tax + other;
    const profit = revenue - expenses;
    return {
      isDemo: true, count: 0, lossCount: 0, noCostCount: 0,
      revenue, profit, cost, commission, logistics, storage, ads, tax, other,
      expenses, marginPct: (profit / revenue) * 100, hasCost: true,
      discrepancy: 0,
    };
  }
  const sum = (f: (h: AnalyticsCalc) => number) =>
    history.reduce((s, h) => s + f(h), 0);
  const revenue = sum((h) => h.revenue);
  const profit = sum((h) => h.profit);
  const expenses = sum((h) => h.expenses);
  const cost = sum((h) => h.cost);
  return {
    isDemo: false,
    count: history.length,
    lossCount: history.filter((h) => h.profit < 0).length,
    noCostCount: history.filter((h) => h.cost <= 0 && h.revenue > 0).length,
    revenue, profit, expenses, cost,
    commission: sum((h) => h.commission),
    logistics: sum((h) => h.logistics),
    storage: sum((h) => h.storage),
    ads: sum((h) => h.ads),
    tax: sum((h) => h.tax),
    other: sum((h) => h.other),
    // маржа по агрегату (profit/revenue) — точнее простого среднего по расчётам
    marginPct: revenue > 0
      ? (profit / revenue) * 100
      : history.reduce((s, h) => s + h.margin, 0) / history.length,
    hasCost: cost > 0,
    discrepancy: revenue - expenses - profit,
  };
}
// доля от выручки числом (%) и строкой («62.9%»)
function pctRev(value: number, revenue: number): number {
  return revenue > 0 ? (value / revenue) * 100 : 0;
}
function shareStr(value: number, revenue: number): string {
  return pctRev(value, revenue).toFixed(1) + "%";
}
function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// гарантируем минимум 3 содержательных строки — добиваем нейтральными, но
// конкретными пунктами (без пустых фраз), чтобы слайд не схлопывался в одну мысль
function pad3(items: string[], fillers: string[]): string[] {
  const out = items.filter(Boolean);
  for (const f of fillers) {
    if (out.length >= 3) break;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}
interface FactorRow { name: string; amount: number; share: number }
function topFactors(f: AiFinancials): FactorRow[] {
  const rev = f.revenue > 0 ? f.revenue : 1;
  return [
    { name: "себестоимость", amount: f.cost },
    { name: "комиссия маркетплейса", amount: f.commission },
    { name: "логистика и УПД", amount: f.logistics },
    { name: "реклама", amount: f.ads },
    { name: "налог", amount: f.tax },
    { name: "хранение", amount: f.storage },
    { name: "прочие расходы", amount: f.other },
  ]
    .filter((x) => x.amount > 0)
    .map((x) => ({ name: x.name, amount: x.amount, share: x.amount / rev }))
    .sort((a, b) => b.share - a.share);
}
/* ===== Приоритизация проблем (scoring) =====
   Тяжесть проблем определяем по долям расходов и марже — выводы на слайдах
   строятся из этих флагов, а не из общих фраз. Пороговые значения — отраслевые
   ориентиры для Ozon/WB. Сами формулы расчёта прибыли не трогаем. */
type AiSeverity = "critical" | "high" | "medium" | "low";
interface AiScore {
  costPct: number;
  commissionPct: number;
  logisticsPct: number;
  taxPct: number;
  adsPct: number;
  storagePct: number;
  otherPct: number;
  expensesPct: number;
  isLoss: boolean;
  marginCritical: boolean; // < 5%
  marginWeak: boolean; // 5–10%
  costHigh: boolean; // > 60%
  costElevated: boolean; // > 50%
  commissionHigh: boolean; // > 18%
  commissionElevated: boolean; // > 12%
  logisticsHigh: boolean; // > 10%
  logisticsElevated: boolean; // > 7%
  taxHigh: boolean; // > 8%
  noCost: boolean;
  severity: AiSeverity;
}
const SEV_RANK: Record<AiSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
function scoreProblems(f: AiFinancials): AiScore {
  const costPct = pctRev(f.cost, f.revenue);
  const commissionPct = pctRev(f.commission, f.revenue);
  const logisticsPct = pctRev(f.logistics, f.revenue);
  const taxPct = pctRev(f.tax, f.revenue);
  const adsPct = pctRev(f.ads, f.revenue);
  const storagePct = pctRev(f.storage, f.revenue);
  const otherPct = pctRev(f.other, f.revenue);
  const expensesPct = pctRev(f.expenses, f.revenue);
  const isLoss = f.profit < 0;
  const marginCritical = !isLoss && f.marginPct < 5;
  const marginWeak = !isLoss && f.marginPct >= 5 && f.marginPct < 10;
  const noCost = !f.hasCost || f.noCostCount > 0;
  let severity: AiSeverity = "low";
  const bump = (s: AiSeverity) => {
    if (SEV_RANK[s] > SEV_RANK[severity]) severity = s;
  };
  if (isLoss) bump("critical");
  if (marginCritical) bump("critical");
  if (marginWeak) bump("high");
  if (costPct > 60) bump("high");
  else if (costPct > 50) bump("medium");
  if (logisticsPct > 10) bump("high");
  else if (logisticsPct > 7) bump("medium");
  if (commissionPct > 18) bump("high");
  else if (commissionPct > 12) bump("medium");
  if (noCost) bump("medium");
  return {
    costPct, commissionPct, logisticsPct, taxPct, adsPct, storagePct, otherPct,
    expensesPct, isLoss, marginCritical, marginWeak,
    costHigh: costPct > 60, costElevated: costPct > 50,
    commissionHigh: commissionPct > 18, commissionElevated: commissionPct > 12,
    logisticsHigh: logisticsPct > 10, logisticsElevated: logisticsPct > 7,
    taxHigh: taxPct > 8, noCost, severity,
  };
}
// «из каждых 100 ₽ продаж ~63 ₽ уходит в закупку» — наглядная расшифровка доли
function per100(pct: number): string {
  return `из каждых 100 ₽ продаж около ${Math.round(pct)} ₽`;
}
// Слайд 1 — «Главный вывод»: главная проблема, крупнейшая статья, влияние на
// прибыль и (если есть) подозрение на расхождение в данных. 3–4 строки.
function buildVerdictLines(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  const top = topFactors(f);
  const out: string[] = [];

  // 1) статус прибыли + честная оценка маржи
  const profitWord = f.hasCost ? "Чистая прибыль" : "Прибыль до себестоимости";
  let marginVerdict: string;
  if (s.isLoss)
    marginVerdict = "расчёт убыточный — расходы уже превышают выручку";
  else if (s.marginCritical)
    marginVerdict = `маржа всего ${f.marginPct.toFixed(1)}% — это опасная зона, любой рост расходов уводит в минус`;
  else if (s.marginWeak)
    marginVerdict = `маржа ${f.marginPct.toFixed(1)}% — слабая, бизнес работает близко к зоне риска`;
  else
    marginVerdict = `маржа ${f.marginPct.toFixed(1)}% — рабочая, но запас ещё есть куда улучшать`;
  out.push(`При выручке ${fmt(f.revenue)} ₽ ${profitWord.toLowerCase()} ${fmt(f.profit)} ₽; ${marginVerdict}.`);

  // 2) главный давящий фактор + наглядная расшифровка «из 100 ₽»
  if (top.length) {
    const t = top[0];
    out.push(
      `Главный давящий фактор — ${t.name}: ${shareStr(t.amount, f.revenue)} выручки (${fmt(t.amount)} ₽). Это значит, ${per100(t.share * 100)} сразу уходит на эту статью.`
    );
  }

  // 3) вторичное давление (2–3 факторы)
  if (top.length > 1) {
    const second = top[1];
    const third = top.length > 2 ? top[2] : null;
    const tail = third ? ` и ${third.name} (${shareStr(third.amount, f.revenue)})` : "";
    out.push(
      `Дополнительно давят ${second.name} (${shareStr(second.amount, f.revenue)} выручки)${tail} — вместе с закупкой они почти не оставляют места для чистой прибыли.`
    );
  }

  // 4) вердикт по тяжести (из scoring)
  if (s.isLoss)
    out.push("Сейчас бизнес теряет деньги на обороте — нужен срочный разбор цены, закупки и убыточных позиций.");
  else if (s.severity === "critical" || s.severity === "high")
    out.push("Прибыль держится на тонком слое: при первом подорожании закупки или комиссии она легко уйдёт в ноль.");
  else
    out.push("Запас прочности есть, но основной резерв роста прибыли спрятан в 1–2 крупнейших статьях расходов.");

  // 5) качество данных — если есть пробел, честно говорим проверить отчёт
  if (s.noCost)
    out.push(
      `Внимание: часть позиций без себестоимости${f.noCostCount > 0 ? ` (${f.noCostCount})` : ""} — реальная чистая прибыль может быть ниже, эти данные нужно проверить в отчёте.`
    );
  else if (Math.abs(f.discrepancy) > Math.max(f.revenue * 0.01, 1500))
    out.push(
      `Внимание: выручка, расходы и прибыль расходятся примерно на ${fmt(Math.abs(f.discrepancy))} ₽ — сверьте отчёт до решений.`
    );

  return pad3(out, [
    "Сравните показатели с прошлым расчётом, чтобы увидеть, куда движется маржа.",
    "Зафиксируйте текущие цифры как точку отсчёта перед изменением цен.",
  ]).slice(0, 6);
}
// Слайд 2 — «Куда уходит прибыль»: статьи расходов с долей выручки И суммой в ₽.
function buildEaters(f: AiFinancials): string[] {
  const top = topFactors(f).slice(0, 5);
  if (!top.length) {
    return pad3([], [
      "Расходы в расчёте не детализированы — данных недостаточно, проверьте в отчёте себестоимость, комиссию и логистику.",
      "Без разбивки затрат точную утечку прибыли показать нельзя.",
      "Загрузите полный отчёт Ozon/WB, чтобы увидеть структуру расходов.",
    ]);
  }
  // короткое объяснение к каждой статье: почему она важна и что проверить
  const hint = (name: string): string => {
    if (name.includes("себестоимость"))
      return "Главный фактор давления на маржу: пока закупка так высока, прибыли расти некуда.";
    if (name.includes("комиссия"))
      return "Проверьте ставку категории и участие в акциях — там часто скрыт лишний процент.";
    if (name.includes("логистика"))
      return "Возможны проблемы с габаритами, схемой FBO/FBS или частыми возвратами.";
    if (name.includes("реклама"))
      return "Сверьте ДРР по кампаниям: часть бюджета может уходить в неокупаемые показы.";
    if (name.includes("налог"))
      return "Проверьте налоговую модель — иногда выгоднее другой режим или учёт расходов.";
    if (name.includes("хранение"))
      return "Растёт на залежавшихся остатках — проверьте оборачиваемость медленных SKU.";
    return "Разнородная статья — стоит разложить её на составляющие в отчёте.";
  };
  const out = top.map(
    (x, i) =>
      `${i + 1}. ${capFirst(x.name)} — ${shareStr(x.amount, f.revenue)} выручки (${fmt(x.amount)} ₽). ${hint(x.name)}`
  );
  if (f.expenses > 0) {
    const leftPct = (100 - pctRev(f.expenses, f.revenue)).toFixed(1);
    out.push(
      `Итого расходы — ${shareStr(f.expenses, f.revenue)} выручки (${fmt(f.expenses)} ₽); на чистую прибыль остаётся ${leftPct}%.`
    );
  }
  return out.slice(0, 6);
}
// Слайд 3 (fallback) — «Проблема по товарам / SKU»: честно про нехватку детализации
// по SKU и что именно загрузить/заполнить. Реальные товары (если есть) подставляет
// view-model из productRisks AI. Пустых общих советов не пишем.
function buildSkuProblems(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  const out: string[] = [];
  out.push("В этом расчёте нет разбивки по товарам — загрузите отчёт Ozon/WB с детализацией по SKU, чтобы видеть прибыль и маржу по каждой позиции.");
  if (f.lossCount > 0)
    out.push(`В истории есть убыточные расчёты (${f.lossCount}) — по ним в первую очередь нужна разбивка по SKU, чтобы найти конкретные товары в минусе.`);
  if (s.noCost)
    out.push(`Заполните себестоимость по товарам без неё${f.noCostCount > 0 ? ` (${f.noCostCount})` : ""}: без закупочной цены прибыль по SKU считается неверно и завышается.`);
  out.push("Когда данные появятся — ищите товары с маржой ниже 10%, с себестоимостью выше 55% и с высоким процентом возвратов: именно они тянут прибыль вниз.");
  if (s.commissionElevated || s.logisticsElevated)
    out.push(`Средняя комиссия ${s.commissionPct.toFixed(1)}% и логистика ${s.logisticsPct.toFixed(1)}% — найдите SKU, где они выше среднего, и поймите причину (категория, габариты, схема доставки).`);
  return pad3(out, [
    "Минимум для анализа по SKU: цена продажи, себестоимость, комиссия, логистика и возвраты по каждому товару.",
    "Сверьте артикулы и размеры/габариты — пересорт и неверный объёмный вес часто искажают прибыль по позиции.",
  ]).slice(0, 5);
}
// Слайд 4 — «Что сделать в первую очередь»: 4–5 конкретных действий.
function buildFirstActions(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  const out: string[] = [];

  // 1) себестоимость — почти всегда главный рычаг
  if (s.noCost)
    out.push("Внесите себестоимость по топ-SKU: без закупочной цены чистая прибыль считается неверно, а решения принимаются вслепую.");
  else
    out.push(`Пересчитайте себестоимость по 10 SKU с максимальной выручкой: при доле закупки ${s.costPct.toFixed(1)}% именно они определяют общую маржу.`);

  // 2) комиссия — если завышена
  if (s.commissionElevated)
    out.push(`Проверьте комиссию по категориям: средняя ${s.commissionPct.toFixed(1)}% — сверьте ставку и участие в акциях, часть из них может быть невыгодной.`);

  // 3) логистика — если завышена
  if (s.logisticsElevated)
    out.push(`Разберите логистику (${s.logisticsPct.toFixed(1)}% выручки): проверьте габариты карточек, схему FBO/FBS и упаковку — на объёме это даёт быструю экономию.`);

  // 4) сверка УПД — гарантированное действие
  out.push(`Сверьте отчёт Ozon с актом УПД (услуги ${shareStr(f.logistics, f.revenue)} выручки): расхождения по услугам и агентскому вознаграждению часто незаметно съедают прибыль.`);

  // 5) возвраты — частая скрытая утечка
  out.push("Сверьте возвраты и компенсации по товарам: один SKU с высоким невыкупом способен съесть прибыль нескольких прибыльных.");

  // 6) убыточные позиции / цена — точечно, а не «всем подряд»
  if (f.lossCount > 0)
    out.push(`Разберите убыточные позиции (${f.lossCount}): по каждой решите — поднять цену, сменить закупку/упаковку или вывести из ассортимента.`);
  else
    out.push("Цену поднимайте не всем подряд: сначала найдите SKU с маржой ниже 10% и проверьте, выдержат ли они рост цены без потери заказов.");

  return pad3(out, [
    "Проверьте, не участвуют ли товары в невыгодных акциях, где скидка съедает всю наценку.",
    "Сократите расходы на упаковку и хранение по медленным остаткам — они копятся незаметно.",
  ]).slice(0, 5);
}
// Слайд 5 — «Риски»: подозрительные места отчёта человеческим языком.
function buildRisks(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  const out: string[] = [];
  if (s.noCost)
    out.push("Товар может быть прибыльным только на бумаге: по части позиций не заполнена себестоимость, поэтому реальная прибыль ниже расчётной.");
  if (s.isLoss)
    out.push(`Расчёт убыточный — расходы превышают выручку на ${fmt(Math.abs(f.profit))} ₽. Без вмешательства убыток будет накапливаться с каждым оборотом.`);
  else if (s.marginCritical || s.marginWeak)
    out.push(`При марже ${f.marginPct.toFixed(1)}% любое изменение комиссии, логистики или закупки опасно — небольшой рост расходов уводит товар в минус.`);
  if (s.costHigh || s.costElevated)
    out.push(`Высокая себестоимость (${s.costPct.toFixed(1)}%) делает прибыль уязвимой к закупке: подорожание у поставщика на 5–10% почти полностью съест маржу.`);
  if (s.commissionElevated)
    out.push(`Комиссия ${s.commissionPct.toFixed(1)}% выше нормы — невыгодные акции и категории могут тихо забирать наценку.`);
  if (s.logisticsElevated)
    out.push(`Логистика ${s.logisticsPct.toFixed(1)}% выручки — частые возвраты и крупные габариты способны превращать прибыльные SKU в убыточные.`);
  if (f.lossCount > 0)
    out.push(`Уже есть убыточные расчёты (${f.lossCount}) — они тянут общий результат вниз и маскируют прибыльные позиции.`);
  if (f.tax <= 0)
    out.push("Налог в расчёте не учтён — чистая прибыль на руки окажется ниже показанной.");
  if (Math.abs(f.discrepancy) > Math.max(f.revenue * 0.01, 1500))
    out.push(`Выручка, расходы и прибыль не сходятся (~${fmt(Math.abs(f.discrepancy))} ₽) — данные стоит сверить, прежде чем принимать решения.`);
  return pad3(out, [
    "Следите, чтобы реклама и логистика не росли быстрее выручки — иначе маржа поедается незаметно.",
    "Перепроверяйте себестоимость при каждой смене поставщика или закупочной цены.",
    "Контролируйте акции: глубокая скидка по топ-SKU может увести его в убыток на пике продаж.",
  ]).slice(0, 5);
}
// Слайд 6 — «План на 7 дней»: пошаговый разбор по дням.
function buildWeekPlan(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  return [
    `День 1: сверить себестоимость по топ-SKU${s.noCost ? " и заполнить её там, где она пустая" : ` (доля закупки ${s.costPct.toFixed(1)}%)`}.`,
    f.lossCount > 0
      ? `День 2: разобрать убыточные товары (${f.lossCount}) — найти причину минуса по каждому.`
      : "День 2: найти товары с маржой ниже 10% и понять, что держит их у нуля.",
    `День 3: проверить комиссии и акции по категориям${s.commissionElevated ? ` (сейчас ${s.commissionPct.toFixed(1)}%)` : ""}.`,
    `День 4: проверить логистику, упаковку и габариты${s.logisticsElevated ? ` (сейчас ${s.logisticsPct.toFixed(1)}%)` : ""}.`,
    "День 5: пересчитать цены точечно — только там, где маржа выдержит повышение.",
    "День 6: отключить или исправить слабые позиции — закупка, упаковка или вывод.",
    "День 7: повторить расчёт в M-PROF и сравнить маржу с сегодняшней.",
  ];
}
// Один пункт страницы «книжки». Кроме строки-вывода и мини-бара есть
// структурные блоки: KPI-сетка, карточка-проблема, риск-бейдж, чек-лист,
// сильный вывод и заметка-плашка. Каждый рендерится как один <li>, поэтому
// измеритель высот автопагинации продолжает работать без изменений.
type AiItemTone = "exp" | "good" | "bad";
// Тон структурных блоков (KPI/карточки/выводы): нейтральный → плохой.
type AiTone = "good" | "warn" | "bad" | "neutral";
type AiItem =
  | { kind: "text"; text: string }
  | {
      kind: "bar";
      label: string;
      pct: number;
      amount: number;
      tone: AiItemTone;
      // если задано — показываем эту строку вместо «{amount} ₽ · {pct}%»
      // (метрики из ответа AI приходят уже отформатированными).
      valueText?: string;
      // нет суммы по статье → бар рендерится приглушённым с «нет данных»
      missing?: boolean;
      // короткий комментарий AI к статье (под шкалой), если есть
      comment?: string;
    }
  // сильный вывод (стр. «Главный вывод» / «Итог»)
  | { kind: "verdict"; text: string; tone: AiTone }
  // KPI-сетка: чистая прибыль, маржа, доли расходов
  | { kind: "kpis"; cells: { label: string; value: string; tone: AiTone }[] }
  // карточка-проблема: проблема → почему опасно → что проверить
  | { kind: "card"; problem: string; why: string; action: string; tone: AiTone }
  // риск с бейджем уровня
  | { kind: "risk"; text: string; level: "high" | "medium" | "low" }
  // пункт чек-листа плана на 7 дней
  | { kind: "check"; day: string; text: string }
  // заметка-плашка: «AI недоступен», «главная проблема», «ожидаемый эффект»
  | { kind: "note"; text: string; tone: "muted" | "accent" };
// Логическая секция = одна тема. На сколько физических страниц «книжки» она ляжет,
// решает автопагинация по реальной высоте — текст не обрезаем и «…» не ставим.
interface AiBookPage {
  title: string;
  items: AiItem[];
  empty: string;
}
// Страница 2 — «Структура расходов»: доли статей компактными прогресс-барами
// (без библиотек, чистый CSS). Последний бар — что осталось как прибыль/убыток.
function buildExpenseBars(f: AiFinancials): AiItem[] {
  if (f.revenue <= 0) return [];
  const rows = topFactors(f); // ненулевые статьи, по убыванию доли
  const MAX = 5;
  const bars: AiItem[] = rows.slice(0, MAX).map((r) => ({
    kind: "bar" as const,
    label: capFirst(r.name),
    pct: r.share * 100,
    amount: r.amount,
    tone: "exp" as const,
  }));
  const restAmt = rows.slice(MAX).reduce((s, r) => s + r.amount, 0);
  if (restAmt > 0)
    bars.push({
      kind: "bar",
      label: "Прочие расходы",
      pct: pctRev(restAmt, f.revenue),
      amount: restAmt,
      tone: "exp",
    });
  bars.push({
    kind: "bar",
    label: f.profit >= 0 ? "Чистая прибыль" : "Убыток",
    pct: f.marginPct,
    amount: f.profit,
    tone: f.profit >= 0 ? "good" : "bad",
  });
  return bars;
}
// Страница 3 — «Что съедает прибыль»: 2–4 главных давящих фактора в формате
// проблема → почему опасно → что проверить. Только то, что видно из расчёта.
function buildLeaks(f: AiFinancials): string[] {
  const s = scoreProblems(f);
  const out: string[] = [];
  if (s.costHigh || s.costElevated)
    out.push(
      `Себестоимость ${s.costPct.toFixed(1)}% выручки (${fmt(f.cost)} ₽). Почему опасно: при такой доле закупки маржа почти не растёт, а подорожание у поставщика сразу уводит в минус. Что проверить: закупочные цены и unit-экономику топ-SKU.`
    );
  if (s.commissionElevated)
    out.push(
      `Комиссия маркетплейса ${s.commissionPct.toFixed(1)}% (${fmt(f.commission)} ₽). Почему опасно: завышенная ставка и невыгодные акции тихо забирают наценку. Что проверить: ставку по категориям и участие в акциях.`
    );
  if (s.logisticsElevated)
    out.push(
      `Логистика и УПД ${s.logisticsPct.toFixed(1)}% (${fmt(f.logistics)} ₽). Почему опасно: крупные габариты и возвраты превращают прибыльные позиции в убыточные. Что проверить: габариты карточек, схему FBO/FBS и процент возвратов.`
    );
  if (s.adsPct > 8)
    out.push(
      `Реклама ${s.adsPct.toFixed(1)}% (${fmt(f.ads)} ₽). Почему опасно: при высокой ДРР часть бюджета уходит в неокупаемые показы. Что проверить: ДРР и ставки по кампаниям, отключите убыточные.`
    );
  if (s.taxHigh)
    out.push(
      `Налог ${s.taxPct.toFixed(1)}% (${fmt(f.tax)} ₽). Почему опасно: неоптимальный режим съедает прибыль на ровном месте. Что проверить: налоговую модель и учёт расходов.`
    );
  if (!out.length) {
    const top = topFactors(f);
    if (top[0])
      out.push(
        `Крупнейшая статья — ${top[0].name}: ${shareStr(top[0].amount, f.revenue)} выручки (${fmt(top[0].amount)} ₽). Грубых перекосов нет, но именно здесь спрятан главный резерв: даже −5% по ней заметно поднимут прибыль.`
      );
  }
  return pad3(out, [
    "Сравните доли расходов с прошлым периодом: резкий рост любой статьи — первый признак утечки прибыли.",
    "Держите под контролем себестоимость, комиссию и логистику — вместе они решают итоговую маржу.",
  ]).slice(0, 4);
}
function buildRecommendations(
  ind: FinancialIndicators,
  history: AnalyticsCalc[]
): string[] {
  if (history.length === 0) {
    return ["↓ снизить CPC", "↓ хранение", "↑ средний чек"];
  }
  const recs: string[] = [];
  if (ind.ads > 0.22) recs.push("↓ снизить CPC");
  if (ind.logistics > 0.12) recs.push("↓ логистика");
  if (ind.margin < 12) recs.push("↑ поднять цену");
  if (ind.margin >= 25) recs.push("↑ масштабировать");
  if (ind.commission > 0.20) recs.push("↑ средний чек");
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  const sumStore = history.reduce((s, h) => s + h.storage, 0);
  if (sumExp > 0 && sumStore / sumExp > 0.07) recs.push("↓ хранение");
  if (history.some((h) => h.profit < 0)) recs.push("⚠ убрать убыточные");
  if (recs.length === 0) recs.push("✓ держать курс");
  return recs.slice(0, 4);
}

function buildSummary(
  history: AnalyticsCalc[],
  score: number,
  ind: FinancialIndicators
): string {
  if (history.length === 0) {
    return "Премиум-аналитика покажет реальные данные после первого расчёта.";
  }
  const hasLoss = history.some((h) => h.profit < 0);
  if (hasLoss) return "Есть убыточные расчёты — пересмотрите структуру расходов.";
  if (score >= 81) return "Отличные показатели — товар прибыльный и устойчивый.";
  if (ind.margin >= 20 && ind.ads > 0.25)
    return "Маржа сильная, но реклама съедает значимую часть прибыли.";
  if (ind.margin < 8) return "Маржа низкая — пересмотрите цену или расходы.";
  if (score >= 56)
    return "Бизнес стабилен — есть потенциал для оптимизации расходов.";
  if (score >= 31)
    return "Показатели в норме, но есть несколько слабых мест.";
  return "Внимание — много слабых мест в финансовой модели.";
}

/* ===== Business health metrics (0-100 each) ===== */
interface HealthMetric {
  label: string;
  value: number;
  tier: Tier["kind"];
}
function tierFromValue(v: number): Tier["kind"] {
  if (v >= 81) return "excellent";
  if (v >= 56) return "strong";
  if (v >= 31) return "stable";
  return "weak";
}
function buildHealth(
  history: AnalyticsCalc[],
  ind: FinancialIndicators
): HealthMetric[] {
  if (history.length === 0) {
    const demo = [
      { label: "Прибыльность", value: 72 },
      { label: "Стабильность", value: 80 },
      { label: "Эфф. рекламы", value: 58 },
      { label: "Эфф. хранения", value: 84 },
      { label: "Масштаб", value: 65 },
    ];
    return demo.map((d) => ({ ...d, tier: tierFromValue(d.value) }));
  }
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  const sumStore = history.reduce((s, h) => s + h.storage, 0);
  const sumProf = history.reduce((s, h) => s + h.profit, 0);
  const storeShare = sumExp > 0 ? sumStore / sumExp : 0;

  const profitability = clamp(0, 100, ind.margin * 3);
  const positiveCount = history.filter((h) => h.profit >= 0).length;
  const stability = (positiveCount / history.length) * 100;
  const adEff = clamp(0, 100, 100 - Math.max(0, ind.ads - 0.10) * 400);
  const storeEff = clamp(0, 100, 100 - Math.max(0, storeShare - 0.05) * 800);
  const scale = clamp(0, 100, ind.margin * 2 + Math.min(50, sumProf / 5000));

  const arr = [
    { label: "Прибыльность", value: profitability },
    { label: "Стабильность", value: stability },
    { label: "Эфф. рекламы", value: adEff },
    { label: "Эфф. хранения", value: storeEff },
    { label: "Масштаб", value: scale },
  ];
  return arr.map((m) => ({
    label: m.label,
    value: Math.round(m.value),
    tier: tierFromValue(m.value),
  }));
}

/* ===== Quick actions (concrete numbers + ₽ impact) ===== */
interface QuickAction {
  action: string;
  impact: string;
}
function buildQuickActions(
  history: AnalyticsCalc[],
  ind: FinancialIndicators
): QuickAction[] {
  if (history.length === 0) {
    return [
      { action: "↓ CPC на 12%", impact: "+15 200 ₽/мес" },
      { action: "↑ цена на 5%", impact: "+24 000 ₽/мес" },
      { action: "↓ хранение",  impact: "+4 100 ₽/мес" },
      { action: "↑ масштаб ×1.5", impact: "+18 000 ₽/мес" },
    ];
  }
  const sumAds = history.reduce((s, h) => s + h.ads, 0);
  const sumRev = history.reduce((s, h) => s + h.revenue, 0);
  const sumExp = history.reduce((s, h) => s + h.expenses, 0);
  const sumStore = history.reduce((s, h) => s + h.storage, 0);
  const sumProf = history.reduce((s, h) => s + h.profit, 0);

  const out: QuickAction[] = [];

  if (ind.ads > 0.18 && sumAds > 0) {
    const save = Math.round(sumAds * 0.15);
    out.push({ action: "↓ CPC на 15%", impact: `+${fmt(save)} ₽` });
  }
  if (ind.margin > 0 && ind.margin < 15 && sumRev > 0) {
    const gain = Math.round(sumRev * 0.05);
    out.push({ action: "↑ цена на 5%", impact: `+${fmt(gain)} ₽` });
  }
  if (sumExp > 0 && sumStore / sumExp > 0.07) {
    const save = Math.round(sumStore * 0.3);
    out.push({ action: "↓ хранение", impact: `+${fmt(save)} ₽` });
  }
  if (ind.margin >= 20 && sumProf > 50000) {
    const gain = Math.round(sumProf * 0.15);
    out.push({ action: "↑ масштаб ×1.5", impact: `+${fmt(gain)} ₽` });
  }
  if (ind.commission > 0.20) {
    out.push({ action: "↑ средний чек", impact: "сниж. комиссии" });
  }
  if (history.some((h) => h.profit < 0)) {
    out.push({ action: "⚠ убрать убыточные", impact: "сэкономить капитал" });
  }
  if (out.length === 0) {
    out.push({ action: "✓ держать курс", impact: "показатели в норме" });
  }
  return out.slice(0, 4);
}

/* ===== Реальная AI-аналитика (ответ серверного /api/ai/analyze) ===== */

type KeyInsight = {
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
};

type ProfitLeak = {
  area: string;
  amount: number | null;
  comment: string;
};

type ProductRisk = {
  name: string;
  sku?: string;
  reason: string;
  action: string;
};

type RecommendedAction = {
  priority: number;
  action: string;
  why: string;
  expectedEffect: string;
};

type AiDebug = {
  hasGatewayKey?: boolean;
  hasGatewayModel?: boolean;
  gatewayModel?: string;
  runtime?: string;
  keyContainsEquals?: boolean;
  keyContainsWhitespace?: boolean;
  keyLength?: number;
  gatewayStatus?: number | null;
  gatewayErrorType?: string | null;
  gatewayErrorCode?: string | null;
  gatewayErrorMessage?: string | null;
};

// Новый структурированный разбор «книжки» (ответ /api/ai/analyze, source=openai).
type AiMetricDoc = {
  label: string;
  value: string;
  share: number | null;
  tone: "good" | "warning" | "bad" | "neutral";
};
type AiPageDoc = {
  title: string;
  type: string;
  lines: string[];
  metrics: AiMetricDoc[];
  actions: string[];
  risks: string[];
};
type AiAnalysisDoc = {
  summary: {
    mainConclusion: string;
    profitStatus: "good" | "warning" | "bad";
    mainProblem: string;
    mainAction: string;
  };
  pages: AiPageDoc[];
};

// Готовые данные 7 страниц от модели (ответ /api/ai/analyze, source=openai,
// поле aiDoc). Это и есть «настоящая» AI-аналитика, которую рендерит книжка.
type AiDocRiskLevel = "low" | "medium" | "high";
type AiDoc = {
  diagnosis: { mainConclusion: string; mainRisk: string; profitSafety: string };
  moneyBreakdown: {
    label: string;
    amount: number;
    percent: number;
    comment: string;
  }[];
  profitLeaks: {
    title: string;
    amount: number;
    whyItMatters: string;
    action: string;
    expectedEffect: string;
  }[];
  skuAudit: {
    sku: string;
    name: string;
    problem: string;
    profit: number;
    margin: number;
    action: string;
  }[];
  risks: {
    level: AiDocRiskLevel;
    title: string;
    reason: string;
    action: string;
  }[];
  sevenDayPlan: { day: number; task: string; expectedResult: string }[];
  finalActions: { title: string; action: string; expectedEffect: string }[];
};

type AiAnalysis = {
  source: "openai" | "fallback";
  fallbackReason?: string;
  debug?: AiDebug;
  summary: string;
  healthScore: number;
  mainProblem: string;
  keyInsights: KeyInsight[];
  profitLeaks: ProfitLeak[];
  productRisks: ProductRisk[];
  recommendedActions: RecommendedAction[];
  missingData: string[];
  analysis?: AiAnalysisDoc;
  /** Готовые данные 7 страниц от модели (заполнены при source=openai). */
  aiDoc?: AiDoc;
};

/** keyInsights от AI → слоты инсайтов (severity → kind). */
function aiSlotsFromAnalysis(a: AiAnalysis): Insight[] {
  return a.keyInsights.slice(0, 4).map((ins) => {
    const kind: Insight["kind"] =
      ins.severity === "high"
        ? "danger"
        : ins.severity === "medium"
        ? "warning"
        : "positive";
    const ico =
      ins.severity === "high"
        ? ICONS.alert
        : ins.severity === "medium"
        ? ICONS.target
        : ICONS.trendUp;
    return { kind, ico, text: ins.title + (ins.description ? ": " + ins.description : "") };
  });
}

/** recommendedActions → QuickAction chips для блока «Что улучшить». */
function aiQuickFromActions(items: RecommendedAction[]): QuickAction[] {
  return items.slice(0, 4).map((a) => ({
    action: a.action,
    impact: a.expectedEffect,
  }));
}

/* AnimatedScore — RAF-counter, уважает prefers-reduced-motion */
function AnimatedScore({
  value,
  duration = 950,
}: {
  value: number;
  duration?: number;
}) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(to);
      prev.current = to;
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{display}</>;
}

/* ---------- CHARTS ---------- */

function LineChart({
  data,
  color,
  height = 160,
}: {
  data: number[];
  color: string;
  height?: number;
}) {
  const w = 320;
  const safe = data.length >= 2 ? data : [0, data[0] ?? 0];
  const min = Math.min(...safe, 0);
  const max = Math.max(...safe, 1);
  const range = max - min || 1;
  const stepX = w / (safe.length - 1);
  const pts = safe.map(
    (v, i) =>
      [
        i * stepX,
        height - ((v - min) / range) * (height - 18) - 9,
      ] as [number, number]
  );
  const linePath = pts
    .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
    .join(" ");
  const baselineY = height - ((0 - min) / range) * (height - 18) - 9;
  const areaPath = `${linePath} L${w},${baselineY} L0,${baselineY} Z`;
  const gradId = `grad-${color.replace(/[#]/g, "")}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="line-svg"
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.40" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} className="line-area" />
      <path
        d={linePath}
        stroke={color}
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="line-stroke"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function DonutChart({
  data,
  size = 150,
}: {
  data: ExpenseSegment[];
  size?: number;
}) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="donut-svg"
    >
      <circle
        cx="50" cy="50" r={r}
        fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="12"
      />
      {data.map((d, i) => {
        const len = (d.value / total) * circ;
        const dash = `${len} ${circ - len}`;
        const off = -acc;
        acc += len;
        return (
          <circle
            key={i}
            cx="50" cy="50" r={r}
            fill="none"
            stroke={d.color}
            strokeWidth="12"
            strokeDasharray={dash}
            strokeDashoffset={off}
            transform="rotate(-90 50 50)"
            style={{ filter: `drop-shadow(0 0 1px ${d.color}40)` }}
          />
        );
      })}
      <text
        x="50" y="48" textAnchor="middle"
        fontFamily="'Playfair Display', Georgia, serif"
        fontSize="11" fontWeight="700"
        fill="rgba(232,238,248,.9)"
      >
        {fmt(total / 1000)}к ₽
      </text>
      <text
        x="50" y="60" textAnchor="middle"
        fontFamily="'DM Mono', monospace"
        fontSize="5.5" fontWeight="500"
        fill="rgba(138,159,187,.7)"
        letterSpacing=".12em"
      >
        ВСЕГО
      </text>
    </svg>
  );
}

/* ---------- MAIN ---------- */

// === RELEASE ===
// Карточка «AI Аналитика» показывает rule-based умные рекомендации по чистой
// прибыли (компонент ProfitRecommendations, данные с расчёта на странице).
// Прежний премиальный AI-кокпит (запрос /api/ai/analyze, score/инсайты)
// ПОЛНОСТЬЮ сохранён в ветке else ниже и вернётся при AI_COMING_SOON=false —
// ничего не удалено.
const AI_COMING_SOON: boolean = false;

// Безопасный фолбэк, когда данные для рекомендаций ещё не переданы со страницы
// (нет расчёта) — карточка покажет аккуратное пустое состояние.
const EMPTY_RECO: ProfitRecommendationsProps = {
  hasReport: false,
  ready: false,
  revenue: 0,
  profitBeforeCost: 0,
  updServicesTotal: 0,
  updCommissionTotal: 0,
  netProfit: 0,
  margin: 0,
  roi: 0,
  costPrice: 0,
  tax: 0,
  taxPercent: 0,
  ads: 0,
  otherExpenses: 0,
  coverage: null,
  best: null,
  worst: null,
};

/* ============================================================================
   DATA-DRIVEN КНИЖКА: 7 страниц аналитики строятся из ЧИСЕЛ расчёта.
   AI-текст подмешивается только как дополнительный комментарий (стр. 1 и 7).
   Даже без AI и при скудных данных каждая страница остаётся заполненной.
   Математику прибыли не трогаем — только агрегируем уже посчитанные поля.
   ============================================================================ */

// Один товар из NetProfitBreakdown (только то, что уже посчитано на странице).
type SkuRow = {
  name: string;
  sku?: string;
  profit?: number;
  margin?: number;
  revenue?: number;
};
// Контекст по товарам/услугам из самого свежего расчёта net-profit-3file.
type SkuContext = {
  products: SkuRow[];
  withoutCost: number;
  updServicesTotal: number;
  updCommissionTotal: number;
  packaging: number;
  delivery: number;
  salary: number;
};

function tidyStr(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
// Имена товаров для карточки: первые k, остальное — «и ещё N».
function listNames(rows: SkuRow[], k: number): string {
  const names = rows.slice(0, k).map((r) => {
    const nm = r.name.length > 30 ? r.name.slice(0, 29) + "…" : r.name;
    return r.sku ? `${nm} (${r.sku})` : nm;
  });
  const extra = rows.length - names.length;
  return names.join(", ") + (extra > 0 ? ` и ещё ${extra}` : "");
}

// Извлекаем товары/услуги из aiInsights — зеркало логики aiPayloadSig, но для
// локальных страниц (в LLM ничего не уходит). Берём первый расчёт с разбивкой.
function extractSkuContext(history: AnalyticsCalc[]): SkuContext {
  const ctx: SkuContext = {
    products: [],
    withoutCost: 0,
    updServicesTotal: 0,
    updCommissionTotal: 0,
    packaging: 0,
    delivery: 0,
    salary: 0,
  };
  for (const h of history) {
    const ins = h.aiInsights as Record<string, unknown> | null | undefined;
    if (!ins || ins.kind !== "net-profit-3file") continue;
    const n = (k: string): number => {
      const v = ins[k];
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
    };
    ctx.updServicesTotal = n("updServicesTotal");
    ctx.updCommissionTotal = n("updCommissionTotal");
    ctx.packaging = n("packaging");
    ctx.delivery = n("deliveryToWarehouse");
    ctx.salary = n("salary");
    const raw = ins.products;
    if (Array.isArray(raw)) {
      const rows: SkuRow[] = [];
      for (const p of raw) {
        if (!p || typeof p !== "object") continue;
        const o = p as Record<string, unknown>;
        const num = (k: string): number | undefined => {
          const v = o[k];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const name =
          typeof o.name === "string" && o.name.trim()
            ? o.name.trim()
            : typeof o.article === "string" && o.article.trim()
            ? o.article.trim()
            : "";
        if (!name) continue;
        rows.push({
          name: name.slice(0, 60),
          sku:
            typeof o.vendorCode === "string" && o.vendorCode.trim()
              ? o.vendorCode.trim().slice(0, 40)
              : undefined,
          profit: num("profit"),
          margin: num("margin"),
          revenue: num("revenue"),
        });
      }
      ctx.products = rows;
      ctx.withoutCost = raw.filter((p) => {
        if (!p || typeof p !== "object") return false;
        const o = p as Record<string, unknown>;
        return !o.costPrice && !o.cost && o.profit !== undefined;
      }).length;
    }
    break;
  }
  return ctx;
}

function marginTone(s: AiScore): AiTone {
  if (s.isLoss || s.marginCritical) return "bad";
  if (s.marginWeak) return "warn";
  return "good";
}

// Главный вывод (2–3 строки) — сильное утверждение из чисел расчёта.
function mainVerdict(f: AiFinancials, s: AiScore): string {
  const profitWord = f.hasCost ? "чистая прибыль" : "прибыль до себестоимости";
  let head: string;
  if (s.isLoss)
    head = `Расчёт убыточный: расходы превышают выручку на ${fmt(Math.abs(f.profit))} ₽.`;
  else if (s.marginCritical)
    head = `Маржа всего ${f.marginPct.toFixed(1)}% — это опасная зона, любой рост расходов уводит в минус.`;
  else if (s.marginWeak)
    head = `Маржа ${f.marginPct.toFixed(1)}% — рабочая, но слабая: запас прочности небольшой.`;
  else
    head = `Маржа ${f.marginPct.toFixed(1)}% — здоровая, бизнес зарабатывает с запасом.`;
  return `При выручке ${fmt(f.revenue)} ₽ ${profitWord} составляет ${fmt(f.profit)} ₽. ${head}`;
}

// Короткая формулировка главной проблемы месяца (footer стр. 1).
function mainProblemText(f: AiFinancials, s: AiScore): string {
  if (s.isLoss) return "расчёт уходит в минус — расходы выше выручки";
  if (s.noCost)
    return "не у всех позиций заполнена себестоимость — прибыль завышена";
  if (s.costHigh) return `высокая себестоимость (${s.costPct.toFixed(1)}% выручки)`;
  if (s.commissionHigh)
    return `высокая комиссия маркетплейса (${s.commissionPct.toFixed(1)}%)`;
  if (s.logisticsHigh)
    return `высокая логистика и УПД (${s.logisticsPct.toFixed(1)}%)`;
  if (s.marginCritical || s.marginWeak)
    return `тонкая маржа ${f.marginPct.toFixed(1)}% — мало запаса прочности`;
  if (s.costElevated)
    return `повышенная себестоимость (${s.costPct.toFixed(1)}%)`;
  const top = topFactors(f)[0];
  return top
    ? `основной вес расходов — ${top.name} (${shareStr(top.amount, f.revenue)})`
    : "резких перекосов нет — следите за крупнейшими статьями";
}

// KPI-сетка стр. 1: 5 ключевых цифр с тоном.
function buildKpiCells(f: AiFinancials, s: AiScore, ctx: SkuContext): AiItem {
  return {
    kind: "kpis",
    cells: [
      {
        label: "Чистая прибыль",
        value: `${fmt(f.profit)} ₽`,
        tone: f.profit >= 0 ? "good" : "bad",
      },
      { label: "Маржа", value: `${f.marginPct.toFixed(1)}%`, tone: marginTone(s) },
      {
        label: "Себестоимость",
        value: f.hasCost ? `${s.costPct.toFixed(1)}%` : "нет данных",
        tone: !f.hasCost
          ? "neutral"
          : s.costHigh
          ? "bad"
          : s.costElevated
          ? "warn"
          : "good",
      },
      {
        label: "Комиссия",
        value: `${s.commissionPct.toFixed(1)}%`,
        tone: s.commissionHigh ? "bad" : s.commissionElevated ? "warn" : "good",
      },
      {
        label: "Логистика",
        value: `${s.logisticsPct.toFixed(1)}%`,
        tone: s.logisticsHigh ? "bad" : s.logisticsElevated ? "warn" : "good",
      },
      {
        // УПД/доп. услуги детализируются только в расчёте net-profit-3file;
        // если их нет — «нет данных» (как у себестоимости), а не пустой 0%.
        label: "УПД / доп. услуги",
        value:
          ctx.updServicesTotal > 0
            ? shareStr(ctx.updServicesTotal, f.revenue)
            : "нет данных",
        tone: "neutral",
      },
    ],
  };
}

// Стр. 2 — структура расходов: 5 фиксированных баров + бар прибыли + вывод.
function buildExpenseReportItems(f: AiFinancials): AiItem[] {
  const rev = f.revenue > 0 ? f.revenue : 0;
  const rest = f.ads + f.storage + f.other;
  const defs: { label: string; amount: number }[] = [
    { label: "Себестоимость", amount: f.cost },
    { label: "Комиссия маркетплейса", amount: f.commission },
    { label: "Логистика и УПД", amount: f.logistics },
    { label: "Налог", amount: f.tax },
    { label: "Остальное (реклама, хранение, прочее)", amount: rest },
  ];
  const items: AiItem[] = defs.map((d) => {
    const missing = !(d.amount > 0);
    return {
      kind: "bar" as const,
      label: d.label,
      amount: d.amount,
      pct: pctRev(d.amount, rev),
      tone: "exp" as const,
      missing,
      valueText: missing ? "нет данных" : undefined,
    };
  });
  items.push({
    kind: "bar",
    label: f.profit >= 0 ? "Чистая прибыль" : "Убыток",
    amount: f.profit,
    pct: f.marginPct,
    tone: f.profit >= 0 ? "good" : "bad",
  });
  const top = topFactors(f)[0];
  if (top) {
    const left = (100 - pctRev(f.expenses, f.revenue)).toFixed(1);
    items.push({
      kind: "text",
      text: `Сильнее всего давит ${top.name}: ${shareStr(
        top.amount,
        f.revenue
      )} выручки (${fmt(top.amount)} ₽). На чистую прибыль остаётся ${left}% выручки.`,
    });
  }
  return items;
}

// Стр. 3 — что съедает прибыль: 3–5 карточек проблема → почему → что проверить.
function buildLeakCards(f: AiFinancials): AiItem[] {
  const s = scoreProblems(f);
  const cards: AiItem[] = [];
  const push = (problem: string, why: string, action: string, tone: AiTone) =>
    cards.push({ kind: "card", problem, why, action, tone });

  if (s.costHigh || s.costElevated)
    push(
      `Себестоимость ${s.costPct.toFixed(1)}% выручки (${fmt(f.cost)} ₽)`,
      "При такой доле закупки маржа почти не растёт, а подорожание у поставщика сразу уводит в минус.",
      "Проверьте закупочные цены и unit-экономику топ-SKU, упаковку и позиции с самой низкой маржой.",
      s.costHigh ? "bad" : "warn"
    );
  if (s.commissionElevated)
    push(
      `Комиссия маркетплейса ${s.commissionPct.toFixed(1)}% (${fmt(f.commission)} ₽)`,
      "Завышенная ставка и невыгодные акции тихо забирают наценку.",
      "Сверьте ставку по категориям и участие в акциях.",
      s.commissionHigh ? "bad" : "warn"
    );
  if (s.logisticsElevated)
    push(
      `Логистика и УПД ${s.logisticsPct.toFixed(1)}% (${fmt(f.logistics)} ₽)`,
      "Крупные габариты и возвраты превращают прибыльные позиции в убыточные.",
      "Проверьте габариты карточек, схему FBO/FBS и процент возвратов.",
      s.logisticsHigh ? "bad" : "warn"
    );
  if (s.adsPct > 8)
    push(
      `Реклама ${s.adsPct.toFixed(1)}% (${fmt(f.ads)} ₽)`,
      "При высокой ДРР часть бюджета уходит в неокупаемые показы.",
      "Сверьте ДРР и ставки по кампаниям, отключите убыточные.",
      "warn"
    );
  if (s.taxHigh)
    push(
      `Налог ${s.taxPct.toFixed(1)}% (${fmt(f.tax)} ₽)`,
      "Неоптимальный режим съедает прибыль на ровном месте.",
      "Проверьте налоговую модель и учёт расходов.",
      "warn"
    );
  if (s.noCost)
    push(
      `Не заполнена себестоимость${f.noCostCount > 0 ? ` (${f.noCostCount})` : ""}`,
      "Без закупочной цены прибыль по этим позициям завышается.",
      "Внесите себестоимость по товарам без неё и пересчитайте.",
      "warn"
    );

  // гарантируем минимум 3 карточки — добиваем конкретными резервами, не водой
  if (cards.length < 3) {
    const top = topFactors(f)[0];
    const fillers: { problem: string; why: string; action: string; tone: AiTone }[] = [];
    if (top)
      fillers.push({
        problem: `Крупнейшая статья — ${top.name} (${shareStr(top.amount, f.revenue)})`,
        why: "Даже без перекоса именно здесь спрятан главный резерв прибыли.",
        action: "Снижение этой статьи на 3–5 п.п. заметно поднимет маржу.",
        tone: "neutral",
      });
    fillers.push({
      problem: "Нет сверки с прошлым периодом",
      why: "Резкий рост любой статьи — первый признак утечки прибыли.",
      action: "Сравните доли расходов с предыдущим расчётом в M-PROF.",
      tone: "neutral",
    });
    fillers.push({
      problem: "Контроль трёх ключевых статей",
      why: "Себестоимость, комиссия и логистика вместе решают итоговую маржу.",
      action: "Держите их под регулярным контролем, чтобы маржа не просела.",
      tone: "neutral",
    });
    for (const fl of fillers) {
      if (cards.length >= 3) break;
      push(fl.problem, fl.why, fl.action, fl.tone);
    }
  }
  return cards.slice(0, 5);
}

// Стр. 4 — товары/SKU: реальные позиции из отчёта; иначе AI-риски; иначе честный
// блок «не хватает данных» + что загрузить. Страница всегда заполнена.
function buildSkuItems(
  f: AiFinancials,
  ctx: SkuContext,
  aiRisks: ProductRisk[]
): AiItem[] {
  const items: AiItem[] = [];
  const products = ctx.products;

  if (products.length) {
    items.push({
      kind: "note",
      text: `По отчёту разобрано ${products.length} ${plural(
        products.length,
        "позиция",
        "позиции",
        "позиций"
      )}. Ниже — товары, которые тянут прибыль вниз.`,
      tone: "muted",
    });
    const losses = products
      .filter((p) => typeof p.profit === "number" && p.profit < 0)
      .sort((a, b) => (a.profit ?? 0) - (b.profit ?? 0));
    const lowMargin = products
      .filter((p) => typeof p.margin === "number" && p.margin >= 0 && p.margin < 10)
      .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0));
    const lowProfitHighRev = products.filter(
      (p) =>
        typeof p.revenue === "number" &&
        typeof p.profit === "number" &&
        p.revenue > 0 &&
        p.profit >= 0 &&
        p.profit / p.revenue < 0.05
    );

    if (ctx.withoutCost > 0)
      items.push({
        kind: "card",
        problem: `${ctx.withoutCost} ${plural(
          ctx.withoutCost,
          "товар",
          "товара",
          "товаров"
        )} без себестоимости`,
        why: "Без закупочной цены их прибыль завышена, реальная маржа ниже.",
        action: "Внесите себестоимость по этим SKU и пересчитайте.",
        tone: "warn",
      });
    if (losses.length)
      items.push({
        kind: "card",
        problem: `Убыточные SKU (${losses.length}): ${listNames(losses, 2)}`,
        why: "Каждая такая позиция уходит в минус и маскирует прибыльные.",
        action: "Поднимите цену, смените закупку/упаковку или выведите из ассортимента.",
        tone: "bad",
      });
    if (lowMargin.length)
      items.push({
        kind: "card",
        problem: `Низкомаржинальные (<10%): ${listNames(lowMargin, 2)}`,
        why: "Любой рост комиссии или закупки уводит их в убыток.",
        action: "Проверьте, выдержат ли они повышение цены без потери заказов.",
        tone: "warn",
      });
    if (lowProfitHighRev.length)
      items.push({
        kind: "card",
        problem: `Высокая выручка, низкая прибыль: ${listNames(lowProfitHighRev, 2)}`,
        why: "Гонят оборот, но почти не приносят денег — съедают рекламу и логистику.",
        action: "Пересчитайте их unit-экономику: цена, закупка, ДРР.",
        tone: "warn",
      });
    if (items.length < 3)
      items.push({
        kind: "card",
        problem: "Что проверять регулярно",
        why: "Прибыль вниз тянут конкретные позиции, а не «средние» цифры.",
        action: "Товары с маржой <10%, себестоимостью >55% и высоким % возвратов.",
        tone: "neutral",
      });
    return items.slice(0, 6);
  }

  // AI дал товары для проверки (тоже реальные позиции из отчёта)
  if (aiRisks.length) {
    items.push({
      kind: "note",
      text: "Товары для проверки по вашему отчёту:",
      tone: "muted",
    });
    aiRisks.slice(0, 5).forEach((r) => {
      const name = tidyStr(r.name);
      if (!name) return;
      items.push({
        kind: "card",
        problem: name,
        why: tidyStr(r.reason) || "Позиция требует проверки.",
        action: tidyStr(r.action) || "Пересчитайте цену и закупку.",
        tone: "warn",
      });
    });
    if (items.length > 1) return items;
  }

  // честный блок: данных по SKU нет — что загрузить + что искать
  items.length = 0;
  items.push({
    kind: "note",
    text: "Для точного SKU-анализа не хватает данных. Загрузите отчёт с детализацией по товарам.",
    tone: "muted",
  });
  items.push({ kind: "check", day: "", text: "Себестоимость по каждому SKU" });
  items.push({ kind: "check", day: "", text: "Возвраты и невыкуп по позициям" });
  items.push({ kind: "check", day: "", text: "Комиссия маркетплейса по позициям" });
  items.push({ kind: "check", day: "", text: "Логистика и габариты по позициям" });
  items.push({
    kind: "card",
    problem: "Что искать, когда данные появятся",
    why: "Прибыль вниз тянут конкретные позиции, а не «средние» цифры.",
    action: "Товары с маржой <10%, себестоимостью >55% и высоким % возвратов.",
    tone: "neutral",
  });
  return items;
}

// Стр. 5 — риски и ошибки учёта: 4–6 рисков с бейджами уровня (high>medium>low).
function buildRiskItems(f: AiFinancials, ctx: SkuContext): AiItem[] {
  const s = scoreProblems(f);
  const rows: { text: string; level: "high" | "medium" | "low" }[] = [];
  const push = (text: string, level: "high" | "medium" | "low") =>
    rows.push({ text, level });

  if (s.noCost)
    push(
      `Неучтённая себестоимость${
        f.noCostCount > 0 ? ` (${f.noCostCount} поз.)` : ""
      }: прибыль завышена, на руки будет меньше.`,
      "high"
    );
  if (s.isLoss)
    push(
      `Расчёт убыточный: убыток ${fmt(Math.abs(f.profit))} ₽ будет копиться с каждым оборотом.`,
      "high"
    );
  else if (s.marginCritical)
    push(`Тонкая маржа ${f.marginPct.toFixed(1)}%: любой рост расходов уводит в минус.`, "high");
  else if (s.marginWeak)
    push(`Слабая маржа ${f.marginPct.toFixed(1)}%: запас прочности небольшой.`, "medium");
  if (s.costHigh)
    push(
      `Высокая себестоимость ${s.costPct.toFixed(1)}%: подорожание закупки на 5–10% съест маржу.`,
      "high"
    );
  else if (s.costElevated)
    push(
      `Повышенная себестоимость ${s.costPct.toFixed(1)}%: следите за закупочными ценами.`,
      "medium"
    );
  if (ctx.updServicesTotal > 0 || ctx.updCommissionTotal > 0)
    push(
      `Сверка с УПД: услуги ${fmt(ctx.updServicesTotal)} ₽ и вознаграждение ${fmt(
        ctx.updCommissionTotal
      )} ₽ — расхождения с отчётом съедают прибыль незаметно.`,
      "medium"
    );
  else
    push(
      "Расхождение отчёта и акта УПД: услуги и агентское вознаграждение часто учтены не полностью.",
      "medium"
    );
  if (s.logisticsElevated)
    push(
      `Возвраты и логистика ${s.logisticsPct.toFixed(1)}%: высокий невыкуп превращает прибыльные SKU в убыточные.`,
      s.logisticsHigh ? "high" : "medium"
    );
  if (s.adsPct > 8)
    push(
      `Реклама ${s.adsPct.toFixed(1)}%: при высокой ДРР бюджет уходит в неокупаемые показы.`,
      "medium"
    );
  if (ctx.packaging > 0 || ctx.delivery > 0)
    push(
      `Упаковка и доставка на склад: ${fmt(
        ctx.packaging + ctx.delivery
      )} ₽ — мелкие статьи, которые копятся незаметно.`,
      "low"
    );
  if (f.tax <= 0)
    push("Налог не учтён в расчёте: чистая прибыль на руки будет ниже показанной.", "medium");
  if (Math.abs(f.discrepancy) > Math.max(f.revenue * 0.01, 1500))
    push(
      `Выручка, расходы и прибыль не сходятся (~${fmt(Math.abs(f.discrepancy))} ₽): сверьте отчёт до решений.`,
      "medium"
    );

  const fillers: { text: string; level: "low" | "medium" }[] = [
    { text: "Реклама и логистика растут быстрее выручки: проверяйте динамику каждый период.", level: "low" },
    { text: "Себестоимость при смене поставщика: пересчитывайте маржу после каждого изменения закупки.", level: "low" },
    { text: "Невыгодные акции: глубокая скидка по топ-SKU может увести его в убыток на пике продаж.", level: "low" },
  ];
  for (const fl of fillers) {
    if (rows.length >= 4) break;
    if (!rows.some((r) => r.text === fl.text)) push(fl.text, fl.level);
  }

  const rank: Record<"high" | "medium" | "low", number> = { high: 0, medium: 1, low: 2 };
  rows.sort((a, b) => rank[a.level] - rank[b.level]);
  return rows
    .slice(0, 6)
    .map((r) => ({ kind: "risk" as const, text: r.text, level: r.level }));
}

// Стр. 6 — план на 7 дней: чек-лист, первые дни закрывают главную проблему.
function buildWeekChecklist(f: AiFinancials, ctx: SkuContext): AiItem[] {
  const s = scoreProblems(f);
  const hasLossSku = ctx.products.some(
    (p) => typeof p.profit === "number" && p.profit < 0
  );
  const costTask = s.noCost
    ? "Заполнить себестоимость по топ-SKU, где она пустая"
    : `Сверить себестоимость топ-SKU (доля закупки ${s.costPct.toFixed(1)}%)`;
  const lossTask =
    f.lossCount > 0
      ? `Разобрать убыточные расчёты (${f.lossCount}) — найти причину минуса`
      : hasLossSku
      ? "Разобрать убыточные SKU — найти причину минуса по каждому"
      : "Найти SKU с маржой ниже 10% и понять, что держит их у нуля";
  const commissionTask = `Проверить комиссию и акции по категориям${
    s.commissionElevated ? ` (сейчас ${s.commissionPct.toFixed(1)}%)` : ""
  }`;
  const logisticsTask = `Проверить логистику, упаковку и габариты${
    s.logisticsElevated ? ` (сейчас ${s.logisticsPct.toFixed(1)}%)` : ""
  }`;
  const updTask = "Сверить отчёт маркетплейса с актом УПД по услугам и вознаграждению";
  const priceTask = "Пересчитать цены точечно — там, где маржа выдержит повышение";
  const repeatTask = "Повторить расчёт в M-PROF и сравнить маржу с сегодняшней";

  let ordered: string[];
  if (s.isLoss || f.lossCount > 0 || hasLossSku)
    ordered = [lossTask, costTask, commissionTask, logisticsTask, updTask, priceTask, repeatTask];
  else if (s.costHigh || s.costElevated || s.noCost)
    ordered = [costTask, lossTask, commissionTask, logisticsTask, updTask, priceTask, repeatTask];
  else if (s.logisticsElevated)
    ordered = [logisticsTask, costTask, commissionTask, updTask, lossTask, priceTask, repeatTask];
  else if (s.commissionElevated)
    ordered = [commissionTask, costTask, logisticsTask, updTask, lossTask, priceTask, repeatTask];
  else
    ordered = [costTask, lossTask, commissionTask, logisticsTask, updTask, priceTask, repeatTask];

  return ordered
    .slice(0, 7)
    .map((t, i) => ({ kind: "check" as const, day: `День ${i + 1}`, text: t }));
}

// Стр. 7 — финальная рекомендация: что делать первым, максимальный эффект,
// что проверить перед следующим отчётом + блок «ожидаемый эффект» (без обещаний).
function buildFinalItems(f: AiFinancials, ctx: SkuContext): AiItem[] {
  const s = scoreProblems(f);
  const top = topFactors(f)[0];
  const topName = top ? top.name : "себестоимость";
  const hasLossSku = ctx.products.some(
    (p) => typeof p.profit === "number" && p.profit < 0
  );

  // Кандидаты действий в порядке приоритета: заголовок / как сделать / эффект.
  // Берём первые три активных (по флагам score); добиваем универсальными.
  type Act = { on: boolean; problem: string; why: string; effect: string };
  const candidates: Act[] = [
    {
      on: s.noCost,
      problem: "Заполнить себестоимость по SKU",
      why: "Проставьте закупочную цену там, где её нет, и пересчитайте отчёт.",
      effect: "прибыль и маржа станут реальными, а не завышенными.",
    },
    {
      on: s.isLoss || f.lossCount > 0 || hasLossSku,
      problem: "Закрыть убыточные позиции",
      why: "Поднимите цену, снизьте закупку и логистику или выведите их из ассортимента.",
      effect: "уберёте прямой минус — общая прибыль вырастет.",
    },
    {
      on: s.costHigh || s.costElevated,
      problem: "Снизить себестоимость топ-SKU",
      why: "Пересмотрите поставщика, упаковку, объём партии и аналоги по крупным позициям.",
      effect: "−3–5 п.п. закупки заметно поднимут маржу.",
    },
    {
      on: s.commissionElevated,
      problem: "Пересмотреть комиссию и акции",
      why: "Сверьте ставку по категориям и участие в промо-акциях.",
      effect: "меньше будете отдавать площадке с каждой продажи.",
    },
    {
      on: s.logisticsElevated,
      problem: "Оптимизировать логистику",
      why: "Проверьте габариты карточек, схему FBO/FBS и процент возвратов.",
      effect: "логистика перестанет утягивать прибыльные позиции в минус.",
    },
    {
      on: s.adsPct > 8,
      problem: "Перебрать рекламные кампании",
      why: "Сверьте ДРР и ставки по кампаниям, отключите неокупаемые.",
      effect: "рекламный бюджет уйдёт в окупаемые показы.",
    },
  ];
  const fillers: Act[] = [
    {
      on: true,
      problem: "Сверить отчёт с актом УПД",
      why: "Проверьте услуги и агентское вознаграждение на расхождения с отчётом.",
      effect: "найдёте скрытые удержания, которые занижают прибыль.",
    },
    {
      on: true,
      problem: "Точечно поднять цену",
      why: "Поднимите цену там, где маржа позволяет, без риска для оборота.",
      effect: "прибыль вырастет без потери заказов.",
    },
    {
      on: true,
      problem: "Повторить расчёт в M-PROF",
      why: "Загрузите следующий отчёт и сравните маржу с текущей.",
      effect: "увидите эффект изменений сразу в цифрах.",
    },
  ];
  // ровно три карточки-действия
  const chosen = [...candidates.filter((a) => a.on), ...fillers].slice(0, 3);

  const items: AiItem[] = [];
  // вводный вердикт — задаёт тон страницы (не карточка)
  const lead = s.isLoss
    ? "Сейчас расчёт в минусе. Ниже — три действия в порядке приоритета, чтобы вернуть прибыль."
    : s.marginCritical || s.marginWeak
    ? `Маржа ${f.marginPct.toFixed(
        1
      )}% — рабочая, но тонкая. Ниже — три действия с наибольшим эффектом на прибыль.`
    : `Прибыль в норме. Дальше всё упирается в ${topName} — ниже три действия, чтобы закрепить результат.`;
  items.push({
    kind: "verdict",
    text: lead,
    tone: s.isLoss || s.marginCritical ? "bad" : s.marginWeak ? "warn" : "good",
  });
  for (const a of chosen) {
    items.push({
      kind: "card",
      problem: a.problem,
      why: a.why,
      action: `Ожидаемый эффект: ${a.effect}`,
      tone: "neutral",
    });
  }
  // финальный сжатый вывод (не карточка)
  items.push({
    kind: "note",
    text: "Сделайте хотя бы первое действие и пересчитайте отчёт через неделю — эффект будет виден в марже.",
    tone: "accent",
  });
  return items;
}

// Оркестратор: всегда 7 страниц из чисел расчёта. AI-текст — только комментарий
// (стр. 1: плашка «недоступно», стр. 7: «Комментарий AI»). Структуру не задаёт.
function buildBookPages(
  f: AiFinancials,
  ctx: SkuContext,
  ai: { comment?: string; note?: string; productRisks: ProductRisk[] }
): AiBookPage[] {
  const s = scoreProblems(f);

  const p1: AiItem[] = [];
  if (ai.note) p1.push({ kind: "note", text: ai.note, tone: "muted" });
  p1.push({
    kind: "verdict",
    text: mainVerdict(f, s),
    tone: s.isLoss || s.marginCritical ? "bad" : s.marginWeak ? "warn" : "good",
  });
  p1.push(buildKpiCells(f, s, ctx));
  p1.push({
    kind: "note",
    text: `Главная проблема месяца: ${mainProblemText(f, s)}.`,
    tone: "accent",
  });

  const p7 = buildFinalItems(f, ctx);
  if (ai.comment)
    p7.push({ kind: "note", text: `Комментарий AI: ${ai.comment}`, tone: "muted" });

  return [
    { title: "Главный вывод", items: p1, empty: "Недостаточно данных для вывода." },
    {
      title: "Структура расходов",
      items: buildExpenseReportItems(f),
      empty: "Расходы не детализированы.",
    },
    {
      title: "Что съедает прибыль",
      items: buildLeakCards(f),
      empty: "Серьёзных перекосов не видно.",
    },
    {
      title: "Товары и SKU",
      items: buildSkuItems(f, ctx, ai.productRisks),
      empty: "Недостаточно данных по товарам.",
    },
    {
      title: "Риски и учёт",
      items: buildRiskItems(f, ctx),
      empty: "Критичных рисков не обнаружено.",
    },
    {
      title: "План на 7 дней",
      items: buildWeekChecklist(f, ctx),
      empty: "План появится после расчёта.",
    },
    { title: "Итог и эффект", items: p7, empty: "Итог появится после расчёта." },
  ];
}

// Защитное приведение ответа сервера (aiDoc) к типу: гарантируем массивы и
// строки, чтобы рендер книжки не падал на неожиданном теле. Сервер уже
// валидирует, это второй контур безопасности на клиенте.
function aiStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function aiNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function coerceAiDoc(raw: unknown): AiDoc | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const dg = (
    o.diagnosis && typeof o.diagnosis === "object" ? o.diagnosis : {}
  ) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x === "object")
          .map((x) => x as Record<string, unknown>)
      : [];
  return {
    diagnosis: {
      mainConclusion: aiStr(dg.mainConclusion),
      mainRisk: aiStr(dg.mainRisk),
      profitSafety: aiStr(dg.profitSafety),
    },
    moneyBreakdown: arr(o.moneyBreakdown).map((m) => ({
      label: aiStr(m.label),
      amount: aiNum(m.amount),
      percent: aiNum(m.percent),
      comment: aiStr(m.comment),
    })),
    profitLeaks: arr(o.profitLeaks).map((l) => ({
      title: aiStr(l.title),
      amount: aiNum(l.amount),
      whyItMatters: aiStr(l.whyItMatters),
      action: aiStr(l.action),
      expectedEffect: aiStr(l.expectedEffect),
    })),
    skuAudit: arr(o.skuAudit).map((s) => ({
      sku: aiStr(s.sku),
      name: aiStr(s.name),
      problem: aiStr(s.problem),
      profit: aiNum(s.profit),
      margin: aiNum(s.margin),
      action: aiStr(s.action),
    })),
    risks: arr(o.risks).map((r) => ({
      level: (r.level === "low" || r.level === "medium" || r.level === "high"
        ? r.level
        : "medium") as AiDocRiskLevel,
      title: aiStr(r.title),
      reason: aiStr(r.reason),
      action: aiStr(r.action),
    })),
    sevenDayPlan: arr(o.sevenDayPlan).map((p, i) => ({
      day: aiNum(p.day) || i + 1,
      task: aiStr(p.task),
      expectedResult: aiStr(p.expectedResult),
    })),
    finalActions: arr(o.finalActions).map((a) => ({
      title: aiStr(a.title),
      action: aiStr(a.action),
      expectedEffect: aiStr(a.expectedEffect),
    })),
  };
}

/** Есть ли в ответе модели хоть какое-то содержимое для книжки. */
function aiDocHasContent(doc: AiDoc): boolean {
  const filled =
    doc.moneyBreakdown.length +
    doc.profitLeaks.length +
    doc.skuAudit.length +
    doc.risks.length +
    doc.sevenDayPlan.length +
    doc.finalActions.length;
  return !!doc.diagnosis.mainConclusion && filled > 0;
}

// Конвертируем ГОТОВЫЙ ответ модели (aiDoc) в те же AiBookPage[], что и
// rule-based книжка, — рендер и стили остаются прежними. Числа и тексты берём
// из ответа AI. Пустую секцию подменяем детерминированной rule-based страницей
// (числа реальны), чтобы не было пустых слайдов — но техполей не добавляем.
function buildBookPagesFromAiDoc(
  doc: AiDoc,
  fallback: AiBookPage[]
): AiBookPage[] {
  const fbItems = (i: number): AiItem[] => (fallback[i] ? fallback[i].items : []);
  const fbVerdictTone = (i: number): AiTone => {
    const v = fbItems(i).find((it) => it.kind === "verdict");
    return v && v.kind === "verdict" ? v.tone : "neutral";
  };

  // 1) Главный вывод: вывод + (реальные KPI из расчёта) + риск + запас прочности
  const p1: AiItem[] = [];
  if (doc.diagnosis.mainConclusion)
    p1.push({
      kind: "verdict",
      text: doc.diagnosis.mainConclusion,
      tone: fbVerdictTone(0),
    });
  const kpis = fbItems(0).find((it) => it.kind === "kpis");
  if (kpis) p1.push(kpis);
  if (doc.diagnosis.mainRisk)
    p1.push({
      kind: "note",
      text: `Главный риск: ${doc.diagnosis.mainRisk}`,
      tone: "accent",
    });
  if (doc.diagnosis.profitSafety)
    p1.push({
      kind: "note",
      text: `Запас прочности: ${doc.diagnosis.profitSafety}`,
      tone: "muted",
    });

  // 2) Структура расходов: шкалы статей + короткий комментарий AI
  const p2: AiItem[] = doc.moneyBreakdown.map((m) => ({
    kind: "bar" as const,
    label: m.label,
    pct: m.percent,
    amount: m.amount,
    tone: "exp" as AiItemTone,
    valueText: `${fmt(m.amount)} ₽ · ${m.percent.toFixed(1)}%`,
    comment: m.comment || undefined,
  }));

  // 3) Что съедает прибыль: карточки проблема → почему → что сделать
  const p3: AiItem[] = doc.profitLeaks.map((l) => ({
    kind: "card" as const,
    problem: l.amount ? `${l.title} — ${fmt(l.amount)} ₽` : l.title,
    why: l.whyItMatters,
    action: l.expectedEffect
      ? `${l.action} Ожидаемый эффект: ${l.expectedEffect}`
      : l.action,
    tone: "bad" as AiTone,
  }));

  // 4) Товары и SKU: карточки по реальным товарам из ответа
  const p4: AiItem[] = doc.skuAudit.map((s) => {
    const head = [s.name, s.sku].filter(Boolean).join(" · ");
    return {
      kind: "card" as const,
      problem: s.problem ? `${head} — ${s.problem}` : head,
      why: `Прибыль ${fmt(s.profit)} ₽ · маржа ${s.margin.toFixed(1)}%`,
      action: s.action,
      tone: (s.profit < 0 ? "bad" : "warn") as AiTone,
    };
  });

  // 5) Риски и учёт: бейдж уровня + причина → действие
  const p5: AiItem[] = doc.risks.map((r) => {
    const tail = [r.reason, r.action].filter(Boolean).join(" → ");
    return {
      kind: "risk" as const,
      level: r.level,
      text: tail ? `${r.title}: ${tail}` : r.title,
    };
  });

  // 6) План на 7 дней: чек-лист по дням
  const p6: AiItem[] = doc.sevenDayPlan.map((p) => ({
    kind: "check" as const,
    day: `День ${p.day}`,
    text: p.expectedResult ? `${p.task} → ${p.expectedResult}` : p.task,
  }));

  // 7) Итог и эффект: ровно 3 приоритетных действия
  const p7: AiItem[] = doc.finalActions.slice(0, 3).map((a) => ({
    kind: "card" as const,
    problem: a.title,
    why: a.action,
    action: a.expectedEffect
      ? `Ожидаемый эффект: ${a.expectedEffect}`
      : "Ожидаемый эффект: рост чистой прибыли",
    tone: "good" as AiTone,
  }));

  const sections: { title: string; items: AiItem[]; empty: string; fb: number }[] =
    [
      { title: "Главный вывод", items: p1, empty: "Недостаточно данных для вывода.", fb: 0 },
      { title: "Структура расходов", items: p2, empty: "Расходы не детализированы.", fb: 1 },
      { title: "Что съедает прибыль", items: p3, empty: "Серьёзных перекосов не видно.", fb: 2 },
      { title: "Товары и SKU", items: p4, empty: "Недостаточно данных по товарам.", fb: 3 },
      { title: "Риски и учёт", items: p5, empty: "Критичных рисков не обнаружено.", fb: 4 },
      { title: "План на 7 дней", items: p6, empty: "План появится после расчёта.", fb: 5 },
      { title: "Итог и эффект", items: p7, empty: "Итог появится после расчёта.", fb: 6 },
    ];

  return sections.map((s) => ({
    title: s.title,
    items: s.items.length > 0 ? s.items : fbItems(s.fb),
    empty: s.empty,
  }));
}

export function AnalyticsBlock({
  realHistory,
  chartHistory,
  hasAnyData = false,
  hasPremium = false,
  onOpenPremium,
  reco,
}: Props) {
  const history = realHistory ?? [];
  // три состояния:
  //   demo            — у пользователя нет ни одного сохранённого расчёта
  //   filter-empty    — расчёты есть, но фильтры всё отсеяли
  //   real            — есть данные для отрисовки
  const isFilteredEmpty = history.length === 0 && hasAnyData;
  const isDemo = history.length === 0 && !hasAnyData;

  // ===== Реальная AI-аналитика через серверный /api/ai/analyze =====
  //   aiData   — успешный ответ AI (показываем вместо rule-based);
  //   aiLoading — идёт запрос («AI анализирует расчёт…»);
  //   aiFailed  — ошибка/недоступно → тихий fallback на rule-based.
  const [aiData, setAiData] = useState<AiAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiFailed, setAiFailed] = useState(false);
  // Текущая страница «книжки» AI Аналитики (0…aiBookPages.length-1)
  const [aiPage, setAiPage] = useState(0);

  // Числовые агрегаты по истории + расширенные поля из NetProfitBreakdown.
  // ЕДИНСТВЕННОЕ, что уходит в AI: только числа и короткие строки товаров.
  // Никаких XLSX/PDF/сырых отчётов в LLM не уходит.
  // Строка-подпись служит и телом запроса, и стабильным ключом эффекта.
  const aiPayloadSig = (() => {
    if (history.length === 0) return "";
    const sum = (sel: (h: AnalyticsCalc) => number) =>
      history.reduce((a, h) => a + (Number(sel(h)) || 0), 0);
    const revenue = sum((h) => h.revenue);
    const profit = sum((h) => h.profit);
    const margin =
      revenue > 0
        ? (profit / revenue) * 100
        : history.reduce((a, h) => a + h.margin, 0) / history.length;

    // Расширенные поля — берём из aiInsights самого свежего расчёта,
    // у которого есть NetProfitBreakdown (kind: "net-profit-3file").
    let extra: Record<string, number | unknown[]> = {};
    for (const h of history) {
      const ins = h.aiInsights as Record<string, unknown> | null | undefined;
      if (!ins || ins.kind !== "net-profit-3file") continue;
      const n = (k: string) => {
        const v = ins[k];
        return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
      };
      extra = {
        loyaltyPayouts: n("loyaltyPayouts"),
        updServicesTotal: n("updServicesTotal"),
        updCommissionTotal: n("updCommissionTotal"),
        packaging: n("packaging"),
        delivery: n("deliveryToWarehouse"),
        salary: n("salary"),
        netProfit: n("profitBeforeCost"),
      };
      // Топ-15 товаров: только имя, sku, profit, margin — никаких файлов.
      const rawProducts = ins.products;
      if (Array.isArray(rawProducts)) {
        extra.products = rawProducts
          .slice(0, 15)
          .map((p: unknown) => {
            if (!p || typeof p !== "object") return null;
            const o = p as Record<string, unknown>;
            const pProfit =
              typeof o.profit === "number" && Number.isFinite(o.profit)
                ? Math.round(o.profit)
                : undefined;
            const pMargin =
              typeof o.margin === "number" && Number.isFinite(o.margin)
                ? Math.round(o.margin * 10) / 10
                : undefined;
            return {
              name:
                typeof o.name === "string"
                  ? o.name.trim().slice(0, 80)
                  : typeof o.article === "string"
                  ? o.article.trim().slice(0, 80)
                  : undefined,
              sku:
                typeof o.vendorCode === "string"
                  ? o.vendorCode.trim().slice(0, 40)
                  : undefined,
              profit: pProfit,
              margin: pMargin,
            };
          })
          .filter(Boolean);
        // productsWithoutCost — товары, у которых нет себестоимости
        const withoutCost = (rawProducts as Record<string, unknown>[]).filter(
          (p) => !p.costPrice && !p.cost && p.profit !== undefined
        ).length;
        if (withoutCost > 0) extra.productsWithoutCost = withoutCost;
      }
      break; // берём только первый подходящий
    }

    // Последние расчёты — только агрегаты по каждому (числа + площадка).
    const recentCalcs = history.slice(0, 6).map((h) => ({
      revenue: Math.round(h.revenue),
      profit: Math.round(h.profit),
      margin: Number((Number(h.margin) || 0).toFixed(1)),
      marketplace: h.marketplace,
    }));

    // Месяц/дата отчёта — только если это реально дата (есть цифры), чтобы не
    // слать в модель ярлыки вроде «сегодня».
    const latestDate = history[0]?.date || "";
    const period = /\d/.test(latestDate) ? latestDate.slice(0, 40) : "";

    return JSON.stringify({
      revenue: Math.round(revenue),
      profit: Math.round(profit),
      margin: Number(margin.toFixed(2)),
      commission: Math.round(sum((h) => h.commission)),
      logistics: Math.round(sum((h) => h.logistics)),
      ads: Math.round(sum((h) => h.ads)),
      storage: Math.round(sum((h) => h.storage)),
      cost: Math.round(sum((h) => h.cost)),
      tax: Math.round(sum((h) => h.tax)),
      other_expenses: Math.round(sum((h) => h.other)),
      marketplace: history[0].marketplace,
      mode: "history",
      ...(period ? { period } : {}),
      recentCalcs,
      ...extra,
    });
  })();

  // Запрос только когда есть premium И реальные данные (нет данных → нет вызова).
  // Bearer token берём из сессии Supabase — сервер верифицирует его сам.
  // Любой сбой → aiFailed=true: остаёмся на rule-based, сайт не падает.
  useEffect(() => {
    if (AI_COMING_SOON || !hasPremium || !aiPayloadSig) {
      setAiData(null);
      setAiFailed(false);
      setAiLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setAiLoading(true);
    setAiFailed(false);
    (async () => {
      try {
        // Берём токен непосредственно перед запросом — он может обновиться.
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) {
          if (active) setAiFailed(true);
          return;
        }
        if (process.env.NODE_ENV !== "production") {
          let keys: string[] = [];
          try {
            keys = Object.keys(JSON.parse(aiPayloadSig || "{}"));
          } catch {}
          // eslint-disable-next-line no-console
          console.log("[AI] endpoint called → /api/ai/analyze", {
            payloadKeys: keys,
          });
        }
        const res = await fetch("/api/ai/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: aiPayloadSig,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("status " + res.status);
        const json = (await res.json()) as Partial<AiAnalysis> & {
          ok?: boolean;
        };
        if (!active) return;
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[AI] response received", {
            source: json.source,
            hasAnalysis: !!json.analysis,
            pages: Array.isArray(json.analysis?.pages)
              ? json.analysis!.pages.length
              : 0,
          });
        }
        // Новый формат: source + healthScore + keyInsights + ...
        if (
          json &&
          (json.source === "openai" || json.source === "fallback") &&
          typeof json.healthScore === "number"
        ) {
          setAiData({
            source: json.source,
            summary: typeof json.summary === "string" ? json.summary : "",
            healthScore: json.healthScore,
            mainProblem:
              typeof json.mainProblem === "string" ? json.mainProblem : "",
            keyInsights: Array.isArray(json.keyInsights)
              ? (json.keyInsights as KeyInsight[])
              : [],
            profitLeaks: Array.isArray(json.profitLeaks)
              ? (json.profitLeaks as ProfitLeak[])
              : [],
            productRisks: Array.isArray(json.productRisks)
              ? (json.productRisks as ProductRisk[])
              : [],
            recommendedActions: Array.isArray(json.recommendedActions)
              ? (json.recommendedActions as RecommendedAction[])
              : [],
            missingData: Array.isArray(json.missingData)
              ? (json.missingData as string[])
              : [],
            fallbackReason: typeof json.fallbackReason === "string" ? json.fallbackReason : undefined,
            debug: json.debug && typeof json.debug === "object" ? (json.debug as AiDebug) : undefined,
            analysis:
              json.analysis &&
              typeof json.analysis === "object" &&
              Array.isArray((json.analysis as AiAnalysisDoc).pages)
                ? (json.analysis as AiAnalysisDoc)
                : undefined,
            aiDoc: coerceAiDoc((json as { aiDoc?: unknown }).aiDoc),
          });
          setAiFailed(false);
          if (process.env.NODE_ENV !== "production") {
            const smart = json.source === "openai" && !!json.analysis;
            // eslint-disable-next-line no-console
            console.log(
              "[AI] parse:",
              smart ? "structured success" : "no structured analysis",
              "| fallback used:",
              json.source === "fallback"
            );
          }
        } else {
          setAiFailed(true);
        }
      } catch {
        if (active) setAiFailed(true);
      } finally {
        if (active) setAiLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [hasPremium, aiPayloadSig]);

  /* charts series — строго хронологический порядок: старый месяц слева →
     новый справа. chartHistory уже отсортирован по report_period на странице
     (возрастание), берём последние 14 (самые свежие) в том же порядке.
     Фолбэк (prop не передан) — прежнее поведение: 14 новых по дате создания,
     развёрнутые в oldest → newest. */
  const realSlice = chartHistory
    ? chartHistory.slice(-14)
    : history.slice(0, 14).reverse();
  const revenueSeries = isDemo
    ? DEMO_REVENUE_14D
    : realSlice.map((h) => h.revenue);
  const profitSeries = isDemo
    ? DEMO_PROFIT_14D
    : realSlice.map((h) => h.profit);

  const sumRev = revenueSeries.reduce((s, v) => s + v, 0);
  const sumProf = profitSeries.reduce((s, v) => s + v, 0);
  const maxRev = revenueSeries.length ? Math.max(...revenueSeries) : 0;
  const avgRev = revenueSeries.length
    ? sumRev / revenueSeries.length
    : 0;
  const maxProf = profitSeries.length ? Math.max(...profitSeries) : 0;
  const avgProf = profitSeries.length
    ? sumProf / profitSeries.length
    : 0;

  /* expense breakdown */
  const computedExpenses = computeExpenseBreakdown(history);
  // Демо-разбивку показываем ТОЛЬКО в полном demo-режиме (0 расчётов). Если у
  // пользователя есть расчёты, но в них нет разбивки расходов, — рисуем реальную
  // (возможно пустую) структуру, а НЕ подмешиваем пример поверх реальных данных.
  const expensesAreDemo = isDemo;
  const expenses = expensesAreDemo ? DEMO_EXPENSES : computedExpenses;
  const totalExp = expenses.reduce((s, e) => s + e.value, 0);

  /* AI cockpit data — rule-based база (fallback), поверх неё AI-override */
  const insights = computeInsights(history);
  const insightsAreDemo = history.length === 0;
  const aiConfidence = getConfidence(history.length);
  const aiConfidencePct = getConfidencePct(history.length);
  const aiTrend = getTrend(history);
  const aiIndicators = computeIndicators(history);
  const aiHealth = buildHealth(history, aiIndicators);

  // --- rule-based значения: используются, когда AI недоступен/ошибка ---
  const rbScore = computeScore(history);
  const rbRecs = buildRecommendations(aiIndicators, history);
  const rbSummary = buildSummary(history, rbScore, aiIndicators);
  const rbQuick = buildQuickActions(history, aiIndicators);
  const slotPositive = insights.find((i) => i.kind === "positive");
  const slotWarning = insights.find(
    (i) => i.kind === "warning" || i.kind === "danger"
  );
  const slotOptim = insights.find((i) => i.kind === "optimization");
  const rbSlots: Insight[] = [slotPositive, slotWarning, slotOptim].filter(
    Boolean
  ) as Insight[];

  // --- AI-override: при успешном ответе /api/ai/analyze показываем его,
  //     иначе остаёмся на rule-based. Разметка/дизайн ниже не меняются. ---
  const useAi = !!aiData && !aiFailed;
  const aiScore = useAi
    ? clamp(0, 100, Math.round(aiData!.healthScore))
    : rbScore;
  const aiTier: Tier = getTier(aiScore);
  const aiSummary = useAi
    ? aiData!.mainProblem || aiData!.summary || rbSummary
    : rbSummary;
  const aiRecs = useAi && aiData!.recommendedActions.length
    ? aiData!.recommendedActions.slice(0, 4).map((a) => a.action)
    : rbRecs;
  const aiQuick = useAi && aiData!.recommendedActions.length
    ? aiQuickFromActions(aiData!.recommendedActions)
    : rbQuick;
  const aiSlots: Insight[] =
    useAi && aiData!.keyInsights.length
      ? aiSlotsFromAnalysis(aiData!)
      : rbSlots;

  /* recent */
  const recent: DemoRecent[] =
    history.length > 0
      ? history.slice(0, 4).map((h) => ({
          product: `Расчёт #${String(h.id).slice(-4)}`,
          marketplace: h.marketplace,
          profit: h.profit,
          margin: h.margin,
          date: h.date,
          profitLabel: profitLabelFor(h.aiInsights),
        }))
      : DEMO_RECENT;

  // ============================================================
  // MVP-вид AI-блока: 4 короткие секции (источник — AI или rule-based).
  // Без карусели, без сырого ответа модели, без техполей.
  // ============================================================

  // Числа расчёта для rule-based книжки («Базовая аналитика», когда настоящий
  // AI-разбор недоступен). Саму математику расчёта не трогаем — только агрегаты.
  const aiFin = buildFinancials(history);
  const aiSkuCtx = extractSkuContext(history);

  // Настоящая AI-аналитика = успешный ответ модели (source=openai) с готовыми
  // данными 7 страниц (aiDoc). Тогда книжку рендерим ИЗ ответа AI, а не строим
  // сами. productRisks от AI нужны только rule-based ветке.
  const aiProductRisks: ProductRisk[] = useAi ? aiData!.productRisks ?? [] : [];
  const realAi =
    useAi &&
    aiData!.source === "openai" &&
    !!aiData!.aiDoc &&
    aiDocHasContent(aiData!.aiDoc!);

  // Есть доступ (premium), но настоящий AI-разбор не пришёл (ошибка/недоступно/
  // фолбэк) → честно: «AI-аудит временно недоступен», ниже — базовая аналитика.
  // Никаких технических ошибок AI в интерфейсе.
  const aiUnavailable = hasPremium && !aiLoading && !realAi;
  const aiUnavailableNote = aiUnavailable
    ? "AI-аудит временно недоступен, попробуйте позже. Ниже — базовая аналитика по вашим цифрам."
    : undefined;

  // rule-based 7 страниц (детерминированные числа) — запасной вариант и основа
  // для подмешивания при пустой секции настоящего AI-ответа.
  const ruleBookPages: AiBookPage[] = buildBookPages(aiFin, aiSkuCtx, {
    comment: undefined,
    note: aiUnavailableNote,
    productRisks: aiProductRisks,
  });

  // Рендер одного пункта: строка-вывод либо мини-бар структуры расходов.
  const renderAiItem = (item: AiItem, i: number): ReactNode => {
    if (item.kind === "bar") {
      const w = Math.max(0, Math.min(100, item.pct));
      return (
        <li
          key={i}
          className={
            "ai-bar-li ai-bar-" + item.tone + (item.missing ? " ai-bar-missing" : "")
          }
        >
          <div className="ai-bar-head">
            <span className="ai-bar-name">{item.label}</span>
            <span className="ai-bar-val">
              {item.valueText
                ? item.valueText
                : `${fmt(item.amount)} ₽ · ${item.pct.toFixed(1)}%`}
            </span>
          </div>
          <div className="ai-bar-track">
            <span className="ai-bar-fill" style={{ width: w + "%" }} />
          </div>
          {item.comment ? (
            <div className="ai-bar-comment">{item.comment}</div>
          ) : null}
        </li>
      );
    }
    if (item.kind === "verdict") {
      return (
        <li key={i} className={"ai-li-plain ai-verdict ai-verdict-" + item.tone}>
          {item.text}
        </li>
      );
    }
    if (item.kind === "kpis") {
      return (
        <li key={i} className="ai-li-plain">
          <div className="ai-kpi-grid">
            {item.cells.map((c, j) => (
              <div key={j} className={"ai-kpi ai-kpi-" + c.tone}>
                <span className="ai-kpi-val">{c.value}</span>
                <span className="ai-kpi-label">{c.label}</span>
              </div>
            ))}
          </div>
        </li>
      );
    }
    if (item.kind === "card") {
      return (
        <li key={i} className={"ai-li-plain ai-pcard ai-pcard-" + item.tone}>
          <div className="ai-pcard-problem">{item.problem}</div>
          <div className="ai-pcard-why">{item.why}</div>
          <div className="ai-pcard-action">
            <span className="ai-pcard-arrow" aria-hidden="true">
              →
            </span>
            {item.action}
          </div>
        </li>
      );
    }
    if (item.kind === "risk") {
      const lvl =
        item.level === "high"
          ? "высокий"
          : item.level === "medium"
          ? "средний"
          : "низкий";
      return (
        <li key={i} className="ai-li-plain ai-risk">
          <span className={"ai-risk-badge ai-risk-" + item.level}>{lvl}</span>
          <span className="ai-risk-text">{item.text}</span>
        </li>
      );
    }
    if (item.kind === "check") {
      return (
        <li key={i} className="ai-li-plain ai-check">
          <span className="ai-check-box" aria-hidden="true" />
          {item.day ? <span className="ai-check-day">{item.day}</span> : null}
          <span className="ai-check-text">{item.text}</span>
        </li>
      );
    }
    if (item.kind === "note") {
      return (
        <li key={i} className={"ai-li-plain ai-note ai-note-" + item.tone}>
          {item.text}
        </li>
      );
    }
    return <li key={i}>{item.text}</li>;
  };
  const renderAiPageBody = (page: AiBookPage): ReactNode =>
    page.items.length > 0 ? (
      <ul className="ai-sec-list">{page.items.map(renderAiItem)}</ul>
    ) : (
      <p className="ai-sec-text ai-sec-muted">{page.empty}</p>
    );

  // Фиксированные 7 страниц. Если пришёл настоящий AI-разбор (aiDoc) — рендерим
  // его (тексты и числа от модели); иначе — rule-based «Базовая аналитика».
  // Карточки, KPI и чек-листы не разбиваются между страницами; редкое
  // переполнение аккуратно скроллится внутри .ai-book-content (без обрезки фраз).
  const aiBookPages: AiBookPage[] = realAi
    ? buildBookPagesFromAiDoc(aiData!.aiDoc!, ruleBookPages)
    : ruleBookPages;
  const aiTotal = aiBookPages.length;
  const aiCur = Math.min(Math.max(aiPage, 0), aiTotal - 1);
  const aiGoPrev = () => setAiPage((p) => Math.max(0, p - 1));
  const aiGoNext = () => setAiPage((p) => Math.min(aiTotal - 1, p + 1));

  return (
    <>
      {/* global: книжка AI рендерится функциями-хелперами renderAiItem и
          renderAiPageBody, а styled-jsx навешивает scope-класс только на
          элементы из самого return. Без global контент книжки (KPI, карточки,
          бары, риски, чек-листы) остаётся без стилей. Все селекторы — с
          префиксами an- и ai-, без голых тегов и пересечений, поэтому
          глобализация безопасна. */}
      <style jsx global>{`
        .an-section{margin-bottom:.85rem}
        .an-head{display:flex;align-items:center;justify-content:space-between;
          margin-bottom:.6rem;flex-wrap:wrap;gap:.5rem}
        .an-title{font-family:'Playfair Display',Georgia,serif;font-size:1.22rem;
          font-weight:700;color:#E8EEF8;letter-spacing:-.012em;margin:0}
        .an-title em{font-style:italic;color:#C9A84C}
        .an-badge{display:inline-flex;align-items:center;gap:7px;
          font-family:'DM Mono',monospace;font-size:.6rem;letter-spacing:.14em;
          text-transform:uppercase;color:#E8C97A;
          background:rgba(201,168,76,.07);border:1px solid rgba(201,168,76,.32);
          padding:5px 13px;border-radius:100px}
        .an-badge .dot{width:5px;height:5px;border-radius:50%;background:#C9A84C;
          box-shadow:0 0 8px #C9A84C;animation:anDotPulse 2.2s ease-in-out infinite}
        @keyframes anDotPulse{0%,100%{opacity:1}50%{opacity:.45}}

        .an-head-right{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
        .an-pro-pill{
          display:inline-flex;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.58rem;font-weight:600;
          text-transform:uppercase;letter-spacing:.12em;
          color:rgba(232,238,248,.6);
          background:rgba(255,255,255,.035);
          border:1px solid rgba(255,255,255,.10);
          padding:5px 11px;border-radius:100px;cursor:pointer;
          transition:transform .22s ease, color .22s ease,
            border-color .22s ease, background .22s ease,
            box-shadow .22s ease;
          -webkit-appearance:none;appearance:none
        }
        .an-pro-pill:hover{
          color:#E8C97A;
          border-color:rgba(201,168,76,.4);
          background:rgba(201,168,76,.08);
          transform:translateY(-1px);
          box-shadow:0 4px 14px rgba(201,168,76,.18)
        }
        .an-pro-pill:active{transform:translateY(0)}
        .an-pro-pill svg{width:11px;height:11px;display:block}

        .an-grid{display:grid;gap:.55rem;align-items:stretch}
        .an-grid + .an-grid{margin-top:.55rem}
        .an-grid-row-1{grid-template-columns:1fr 1fr}

        /* AI занимает всю правую колонку (2 строки), donut top-left, recent bottom-left */
        .an-grid-bottom{
          grid-template-columns:1fr 1.7fr;
          grid-template-rows:auto 1fr;
          grid-template-areas:
            "donut ai"
            "recent ai"
        }
        .an-area-donut{grid-area:donut}
        .an-area-ai{grid-area:ai;align-self:stretch;min-height:390px;display:flex;flex-direction:column}
        .an-area-recent{grid-area:recent;margin-top:0 !important}

        @media(max-width:900px){
          .an-grid-row-1{grid-template-columns:1fr !important}
          .an-grid-bottom{
            grid-template-columns:1fr !important;
            grid-template-rows:auto !important;
            grid-template-areas:
              "ai"
              "donut"
              "recent" !important
          }
        }
        .an-card{
          background:rgba(255,255,255,.032);
          border:1px solid rgba(255,255,255,.07);
          border-radius:14px;
          backdrop-filter:blur(12px);
          -webkit-backdrop-filter:blur(12px);
          box-shadow:0 14px 36px rgba(0,0,0,.25);
          transition:transform .25s ease, box-shadow .25s ease,
                     border-color .25s ease, background .25s ease;
          overflow:hidden;position:relative;
          display:flex;flex-direction:column;
          animation:anCardIn .55s cubic-bezier(.22,1,.36,1) both
        }
        .an-card:hover{
          transform:translateY(-3px);
          border-color:rgba(201,168,76,.32);
          background:rgba(255,255,255,.045);
          box-shadow:0 22px 56px rgba(0,0,0,.34), 0 0 42px rgba(201,168,76,.10)
        }
        .an-card:nth-child(1){animation-delay:50ms}
        .an-card:nth-child(2){animation-delay:130ms}
        .an-card:nth-child(3){animation-delay:210ms}
        .an-card:nth-child(4){animation-delay:290ms}
        @keyframes anCardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}

        .an-card-head{display:flex;justify-content:space-between;align-items:flex-start;
          padding:.7rem 1.05rem .45rem;gap:.7rem}
        .an-card-title{font-family:'DM Mono',monospace;font-size:.58rem;
          text-transform:uppercase;letter-spacing:.14em;color:#425068;margin:0 0 3px}
        .an-card-val{font-family:'Playfair Display',Georgia,serif;font-size:1.05rem;
          font-weight:700;color:#E8EEF8;letter-spacing:-.022em;line-height:1}
        .an-card-val.pos{color:#2ECC8A}
        .an-card-val.neg{color:#E05566}
        .an-card-sub{font-family:'DM Mono',monospace;font-size:.58rem;color:#425068;
          letter-spacing:.06em;margin-top:4px}
        .an-card-sub.demo{color:#E8C97A;opacity:.85}

        .an-chart-body{padding:.05rem .95rem 0;flex:1;display:flex;flex-direction:column;
          justify-content:flex-end}

        /* === LINE CHART === */
        .line-svg .line-stroke{
          stroke-dasharray:1500;stroke-dashoffset:1500;
          animation:lineDraw 1.6s cubic-bezier(.22,1,.36,1) .15s forwards
        }
        @keyframes lineDraw{to{stroke-dashoffset:0}}
        .line-svg .line-area{opacity:0;animation:areaFade .9s ease-out .55s forwards}
        @keyframes areaFade{to{opacity:1}}

        .an-chart-foot{display:flex;gap:1.1rem;padding:.45rem 1.05rem .7rem;
          border-top:1px solid rgba(255,255,255,.05);margin-top:.3rem}
        .an-stat-l{font-family:'DM Mono',monospace;font-size:.5rem;color:#425068;
          letter-spacing:.14em;text-transform:uppercase;margin-bottom:1px}
        .an-stat-v{font-family:'Playfair Display',Georgia,serif;font-size:.75rem;font-weight:700;
          color:#E8EEF8;letter-spacing:-.01em}
        .an-stat-v.pos{color:#2ECC8A}
        .an-stat-v.neg{color:#E05566}

        /* === DONUT === */
        .donut-wrap{display:flex;align-items:center;gap:.85rem;padding:.05rem .95rem .7rem;
          flex:1}
        .donut-svg{flex-shrink:0;animation:donutIn 1s ease-out both}
        @keyframes donutIn{from{opacity:0;transform:scale(.86) rotate(-12deg)}
          to{opacity:1;transform:scale(1) rotate(0)}}
        .donut-legend{flex:1;display:flex;flex-direction:column;gap:.34rem;
          font-family:'DM Mono',monospace;font-size:.7rem;min-width:0}
        .donut-row{display:flex;align-items:center;gap:.5rem;color:#9FB1CB}
        .donut-dot{width:9px;height:9px;border-radius:2px;flex-shrink:0;
          box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
        .donut-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
        .donut-val{margin-left:auto;color:#E8EEF8;font-weight:600;flex-shrink:0;
          font-size:.7rem;letter-spacing:-.005em}

        /* === AI === */
        .an-ai-card{
          background:linear-gradient(150deg, rgba(201,168,76,.10) 0%, rgba(255,255,255,.025) 60%);
          border-color:rgba(201,168,76,.28);
          min-height:390px;
        }
        .an-ai-card > *{position:relative}
        .ai-title-row{display:flex;align-items:center;gap:.6rem;
          font-family:'Playfair Display',Georgia,serif;font-size:.95rem;font-weight:700;color:#E8EEF8}
        .ai-spark{display:inline-flex;width:26px;height:26px;border-radius:9px;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
          color:#05070f;align-items:center;justify-content:center;
          box-shadow:0 6px 18px rgba(201,168,76,.42);
          animation:aiSparkPulse 2.6s ease-in-out infinite}
        .ai-spark svg{width:14px;height:14px}
        @keyframes aiSparkPulse{0%,100%{filter:brightness(1);box-shadow:0 6px 18px rgba(201,168,76,.42)}
          50%{filter:brightness(1.2);box-shadow:0 6px 22px rgba(201,168,76,.6)}}
        .ai-sub{font-family:'DM Mono',monospace;font-size:.58rem;
          letter-spacing:.14em;text-transform:uppercase;color:#E8C97A;opacity:.7}
        /* ===== AI Аналитика — встроенные умные рекомендации ===== */
        .an-ai-reco{justify-content:flex-start}
        .ai-reco-body{padding:.2rem 1.05rem 1rem;flex:1;min-width:0}
        /* ===== AI cockpit (premium main feature) ===== */
        .an-ai-card{
          /* layered glassmorphism + усиленный gold-glow по углу */
          box-shadow:0 18px 50px rgba(0,0,0,.32),
            0 0 60px rgba(201,168,76,.12)
        }
        /* медленный animated gold-border вокруг AI card */
        .ai-card-shine{
          position:absolute;inset:0;border-radius:inherit;padding:1px;
          background:linear-gradient(120deg,
            rgba(201,168,76,.45) 0%,
            rgba(232,201,122,.10) 25%,
            rgba(201,168,76,.45) 50%,
            rgba(232,201,122,.10) 75%,
            rgba(201,168,76,.45) 100%);
          background-size:280% 100%;
          -webkit-mask:linear-gradient(#000,#000) content-box, linear-gradient(#000,#000);
          -webkit-mask-composite:xor;mask-composite:exclude;
          animation:aiCardShine 8s linear infinite;
          pointer-events:none
        }
        @keyframes aiCardShine{
          from{background-position:0% 0}
          to{background-position:280% 0}
        }
        .ai-section{display:flex;flex-direction:column;gap:.4rem}
        .ai-section-label{
          font-family:'DM Mono',monospace;font-size:.6rem;font-weight:700;
          letter-spacing:.16em;text-transform:uppercase;
          color:#7A8FA8;margin:0 0 .15rem
        }

        /* ===== AI overview: компактные показатели с подписями ===== */
        .ai-compact-top{
          display:flex;align-items:flex-end;gap:1.1rem;flex-wrap:wrap;
          padding:.2rem 0 .65rem;
          border-bottom:1px solid rgba(255,255,255,.06);
          margin-bottom:.55rem
        }
        .ai-compact-metric{
          display:flex;flex-direction:column;gap:.32rem;min-width:0
        }
        .ai-compact-metric-end{margin-left:auto;align-items:flex-end;text-align:right}
        .ai-compact-label{
          font-family:'DM Mono',monospace;font-size:.56rem;font-weight:700;
          letter-spacing:.16em;text-transform:uppercase;color:#7A8FA8
        }
        .ai-compact-score-row{
          display:flex;align-items:center;gap:.5rem;flex-wrap:wrap
        }
        .ai-compact-score{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.35rem;font-weight:700;letter-spacing:-.025em;
          line-height:1
        }
        .ai-compact-score.tier-weak{color:#FF8A98}
        .ai-compact-score.tier-stable{color:#FFD37D}
        .ai-compact-score.tier-strong{color:#E8C97A}
        .ai-compact-score.tier-excellent{color:#7DEAB2}
        .ai-trend{
          display:inline-flex;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.72rem;font-weight:700;
          letter-spacing:.04em;color:#8A9FBB
        }
        .ai-trend.dir-up{color:#7DEAB2}
        .ai-trend.dir-down{color:#FF8A98}
        .ai-trend.dir-flat{color:#8A9FBB}
        .ai-trend-val{font-weight:500}
        .ai-conf{
          display:inline-flex;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.64rem;font-weight:600;
          letter-spacing:.08em;color:#9FB1CB
        }
        .ai-conf-pct{
          font-weight:700;letter-spacing:.02em;color:#E8EEF8;
          font-size:.7rem
        }
        .ai-conf.conf-low .ai-conf-pct{color:#FF8A98}
        .ai-conf.conf-medium .ai-conf-pct{color:#FFD37D}
        .ai-conf.conf-high .ai-conf-pct{color:#7DEAB2}
        .ai-conf-dot{
          width:6px;height:6px;border-radius:50%;flex-shrink:0
        }
        .ai-conf.conf-low .ai-conf-dot{background:#E05566;box-shadow:0 0 5px rgba(224,85,102,.5)}
        .ai-conf.conf-medium .ai-conf-dot{background:#E0A050;box-shadow:0 0 5px rgba(232,180,80,.5)}
        .ai-conf.conf-high .ai-conf-dot{background:#7DEAB2;box-shadow:0 0 5px rgba(46,204,138,.5)}

        .ai-score-tier-pill{
          font-family:'DM Mono',monospace;font-size:.66rem;font-weight:700;
          letter-spacing:.14em;text-transform:uppercase;
          padding:6px 12px;border-radius:100px;
          border:1px solid;line-height:1
        }
        .ai-score-tier-pill.weak{
          color:#FF8A98;border-color:rgba(224,85,102,.42);
          background:rgba(224,85,102,.10)
        }
        .ai-score-tier-pill.stable{
          color:#FFD37D;border-color:rgba(232,180,80,.42);
          background:rgba(232,180,80,.10)
        }
        .ai-score-tier-pill.strong{
          color:#E8C97A;border-color:rgba(201,168,76,.42);
          background:rgba(201,168,76,.10)
        }
        .ai-score-tier-pill.excellent{
          color:#7DEAB2;border-color:rgba(46,204,138,.42);
          background:rgba(46,204,138,.10)
        }

        /* ===== AI overview: статус-строка «AI Score: 55 — Стабильный» ===== */
        .ai-status-line{
          display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;
          padding:.1rem 0 .6rem;
          border-bottom:1px solid rgba(255,255,255,.06);
          margin-bottom:.6rem
        }
        .ai-status-key{
          font-family:'DM Mono',monospace;font-size:.62rem;font-weight:700;
          letter-spacing:.14em;text-transform:uppercase;color:#7A8FA8;
          align-self:center
        }
        .ai-status-score{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.4rem;font-weight:700;letter-spacing:-.025em;line-height:1
        }
        .ai-status-score.tier-weak{color:#FF8A98}
        .ai-status-score.tier-stable{color:#FFD37D}
        .ai-status-score.tier-strong{color:#E8C97A}
        .ai-status-score.tier-excellent{color:#7DEAB2}
        .ai-status-dash{color:#5A6B82;font-size:.95rem;align-self:center}
        .ai-status-tier{
          font-family:'DM Mono',monospace;font-size:.74rem;font-weight:700;
          letter-spacing:.04em;align-self:center
        }
        .ai-status-tier.tier-weak{color:#FF8A98}
        .ai-status-tier.tier-stable{color:#FFD37D}
        .ai-status-tier.tier-strong{color:#E8C97A}
        .ai-status-tier.tier-excellent{color:#7DEAB2}
        .ai-status-line .ai-trend{margin-left:auto;align-self:center}
        .ai-pg-block{display:flex;flex-direction:column;gap:.05rem;min-width:0}

        /* insights list */
        .ai-insights-list{
          list-style:none;padding:0;margin:0;
          display:flex;flex-direction:column;gap:.3rem;flex:1
        }
        .ai-insight{
          display:flex;align-items:flex-start;gap:.7rem;
          padding:.7rem .85rem;border-radius:10px;
          font-size:.78rem;line-height:1.5;font-weight:400;color:#E8EEF8;
          overflow-wrap:break-word;
          background:rgba(255,255,255,.025);
          border:1px solid rgba(255,255,255,.07);
          transition:all .22s ease;
          animation:aiInsightIn .4s cubic-bezier(.22,1,.36,1) both
        }
        @keyframes aiInsightIn{
          from{opacity:0;transform:translateY(3px)}
          to{opacity:1;transform:translateY(0)}
        }
        .ai-insights-list .ai-insight:nth-child(1){animation-delay:60ms}
        .ai-insights-list .ai-insight:nth-child(2){animation-delay:120ms}
        .ai-insights-list .ai-insight:nth-child(3){animation-delay:180ms}
        .ai-insights-list .ai-insight:nth-child(4){animation-delay:240ms}

        .ai-insight:hover{transform:translateX(2px)}
        .ai-insight-ico{
          flex-shrink:0;width:18px;height:18px;
          display:inline-flex;align-items:center;justify-content:center;
          margin-top:1px
        }
        .ai-insight-ico svg{width:18px;height:18px}
        .ai-insight-text{flex:1;min-width:0}

        .ai-insight.positive{
          border-color:rgba(46,204,138,.22);
          background:rgba(46,204,138,.05)
        }
        .ai-insight.positive .ai-insight-ico{color:#7DEAB2}
        .ai-insight.positive:hover{
          background:rgba(46,204,138,.09);
          border-color:rgba(46,204,138,.35)
        }

        .ai-insight.warning{
          border-color:rgba(232,180,80,.25);
          background:rgba(232,180,80,.05)
        }
        .ai-insight.warning .ai-insight-ico{color:#FFD37D}
        .ai-insight.warning:hover{
          background:rgba(232,180,80,.09);
          border-color:rgba(232,180,80,.4)
        }

        .ai-insight.danger{
          border-color:rgba(224,85,102,.26);
          background:rgba(224,85,102,.05)
        }
        .ai-insight.danger .ai-insight-ico{color:#FF8A98}
        .ai-insight.danger:hover{
          background:rgba(224,85,102,.09);
          border-color:rgba(224,85,102,.4)
        }

        .ai-insight.optimization{
          border-color:rgba(201,168,76,.30);
          background:linear-gradient(135deg,rgba(201,168,76,.08),rgba(201,168,76,.03))
        }
        .ai-insight.optimization .ai-insight-ico{color:#E8C97A}
        .ai-insight.optimization:hover{
          background:linear-gradient(135deg,rgba(201,168,76,.14),rgba(201,168,76,.05));
          border-color:rgba(201,168,76,.5)
        }

        /* ===== INDICATORS ===== */
        .ai-indicators{
          display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;
          padding:.05rem 0
        }
        .ai-ind{
          display:inline-flex;align-items:baseline;gap:7px;
          font-family:'DM Mono',monospace;
          padding:7px 12px;border-radius:9px;
          background:rgba(255,255,255,.035);
          border:1px solid rgba(255,255,255,.08);
          font-size:.64rem;letter-spacing:.08em;
          line-height:1
        }
        .ai-ind-l{color:#7A8FA8;text-transform:uppercase;font-weight:700}
        .ai-ind-v{color:#E8EEF8;font-size:.92rem;font-weight:700;letter-spacing:-.012em}
        .ai-ind.ai-ind-margin{
          background:rgba(201,168,76,.07);
          border-color:rgba(201,168,76,.25)
        }
        .ai-ind.ai-ind-margin .ai-ind-l{color:#E8C97A}
        .ai-ind.ai-ind-margin .ai-ind-v{color:#F5DFA0}

        /* ===== HEALTH BARS ===== */
        .ai-health{display:flex;flex-direction:column;gap:.4rem}
        .ai-health-row{
          display:flex;align-items:center;gap:.7rem;
          animation:aiInsightIn .35s cubic-bezier(.22,1,.36,1) both
        }
        .ai-health-row:nth-child(1){animation-delay:50ms}
        .ai-health-row:nth-child(2){animation-delay:110ms}
        .ai-health-row:nth-child(3){animation-delay:170ms}
        .ai-health-row:nth-child(4){animation-delay:230ms}
        .ai-health-row:nth-child(5){animation-delay:290ms}
        .ai-health-label{
          font-family:'DM Mono',monospace;font-size:.68rem;font-weight:600;
          letter-spacing:.06em;color:#9FB1CB;
          width:122px;flex-shrink:0
        }
        .ai-health-bar{
          flex:1;height:7px;border-radius:4px;
          background:rgba(255,255,255,.05);
          overflow:hidden;position:relative;
          box-shadow:inset 0 1px 0 rgba(0,0,0,.2)
        }
        .ai-health-fill{
          display:block;height:100%;border-radius:4px;
          transition:width .85s cubic-bezier(.22,1,.36,1)
        }
        .ai-health-bar.tier-weak .ai-health-fill{
          background:linear-gradient(90deg,#FF8A98 0%,#E05566 100%);
          box-shadow:0 0 8px rgba(224,85,102,.4)
        }
        .ai-health-bar.tier-stable .ai-health-fill{
          background:linear-gradient(90deg,#FFD37D 0%,#E0A050 100%);
          box-shadow:0 0 8px rgba(232,180,80,.35)
        }
        .ai-health-bar.tier-strong .ai-health-fill{
          background:linear-gradient(90deg,#E8C97A 0%,#C9A84C 100%);
          box-shadow:0 0 8px rgba(201,168,76,.4)
        }
        .ai-health-bar.tier-excellent .ai-health-fill{
          background:linear-gradient(90deg,#7DEAB2 0%,#2ECC8A 100%);
          box-shadow:0 0 8px rgba(46,204,138,.4)
        }
        .ai-health-value{
          font-family:'DM Mono',monospace;font-size:.74rem;font-weight:700;
          letter-spacing:-.01em;width:34px;text-align:right;flex-shrink:0
        }
        .ai-health-value.tier-weak{color:#FF8A98}
        .ai-health-value.tier-stable{color:#FFD37D}
        .ai-health-value.tier-strong{color:#E8C97A}
        .ai-health-value.tier-excellent{color:#7DEAB2}

        /* ===== QUICK ACTIONS ===== */
        .ai-quick{
          display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem
        }
        .ai-quick-card{
          padding:.6rem .8rem;border-radius:11px;
          background:linear-gradient(135deg,rgba(201,168,76,.12) 0%,rgba(201,168,76,.04) 100%);
          border:1px solid rgba(201,168,76,.28);
          display:flex;flex-direction:column;gap:4px;
          transition:transform .22s ease, border-color .22s ease, box-shadow .22s ease;
          animation:aiInsightIn .4s cubic-bezier(.22,1,.36,1) both
        }
        .ai-quick .ai-quick-card:nth-child(1){animation-delay:80ms}
        .ai-quick .ai-quick-card:nth-child(2){animation-delay:140ms}
        .ai-quick .ai-quick-card:nth-child(3){animation-delay:200ms}
        .ai-quick .ai-quick-card:nth-child(4){animation-delay:260ms}
        .ai-quick-card:hover{
          transform:translateY(-1px);
          border-color:rgba(201,168,76,.48);
          box-shadow:0 8px 22px rgba(0,0,0,.22), 0 0 24px rgba(201,168,76,.18)
        }
        .ai-quick-action{
          font-family:'Outfit',sans-serif;font-size:.84rem;font-weight:600;
          color:#E8EEF8;letter-spacing:.005em;line-height:1.25
        }
        .ai-quick-impact{
          font-family:'DM Mono',monospace;font-size:.66rem;font-weight:600;
          color:#E8C97A;letter-spacing:.04em
        }

        /* ===== BOTTOM: recs + summary ===== */
        .ai-bottom{
          display:flex;flex-direction:column;gap:.55rem;
          padding-top:.55rem;
          border-top:1px solid rgba(255,255,255,.06)
        }
        .ai-recs{display:flex;flex-wrap:wrap;gap:.38rem}
        .ai-rec-chip{
          display:inline-flex;align-items:center;
          font-family:'DM Mono',monospace;font-size:.66rem;font-weight:700;
          letter-spacing:.06em;color:#E8C97A;
          padding:6px 11px;border-radius:100px;line-height:1;
          background:rgba(201,168,76,.10);
          border:1px solid rgba(201,168,76,.3);
          animation:aiInsightIn .35s cubic-bezier(.22,1,.36,1) both
        }
        .ai-recs .ai-rec-chip:nth-child(1){animation-delay:60ms}
        .ai-recs .ai-rec-chip:nth-child(2){animation-delay:110ms}
        .ai-recs .ai-rec-chip:nth-child(3){animation-delay:160ms}
        .ai-recs .ai-rec-chip:nth-child(4){animation-delay:210ms}
        .ai-summary{
          display:flex;gap:.6rem;align-items:flex-start;
          margin:0;font-size:.82rem;line-height:1.5;color:#9FB1CB;font-weight:400
        }
        .ai-summary-tag{
          font-family:'DM Mono',monospace;font-size:.6rem;font-weight:700;
          letter-spacing:.16em;color:#05070f;
          background:linear-gradient(135deg,#C9A84C,#E8C97A);
          padding:4px 9px;border-radius:6px;line-height:1;flex-shrink:0;margin-top:2px;
          box-shadow:0 4px 10px rgba(201,168,76,.25)
        }

        /* === FILTER EMPTY === */
        .filter-empty{
          background:rgba(255,255,255,.025);
          border:1px solid rgba(255,255,255,.07);
          border-radius:14px;
          padding:3.4rem 2rem;text-align:center;
          backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          box-shadow:0 14px 36px rgba(0,0,0,.25);
          display:flex;flex-direction:column;align-items:center;gap:.7rem;
          animation:anCardIn .55s cubic-bezier(.22,1,.36,1) both;
          position:relative;overflow:hidden
        }
        .filter-empty::before{content:"";position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(440px 240px at 50% 0%, rgba(201,168,76,.10), transparent 60%)}
        .filter-empty > *{position:relative}
        .filter-empty-ico{
          width:64px;height:64px;border-radius:18px;display:inline-flex;
          align-items:center;justify-content:center;
          background:linear-gradient(135deg,rgba(201,168,76,.22) 0%,rgba(201,168,76,.06) 100%);
          border:1px solid rgba(201,168,76,.32);color:#E8C97A;margin-bottom:.4rem;
          box-shadow:0 10px 30px rgba(201,168,76,.16);
          animation:filterEmptyIco 3.4s ease-in-out infinite
        }
        @keyframes filterEmptyIco{
          0%,100%{box-shadow:0 10px 30px rgba(201,168,76,.16),0 0 0 0 rgba(201,168,76,.18)}
          50%{box-shadow:0 12px 32px rgba(201,168,76,.22),0 0 0 12px rgba(201,168,76,.04)}
        }
        .filter-empty-ico svg{width:28px;height:28px;display:block}
        .filter-empty-title{font-family:'Playfair Display',Georgia,serif;
          font-size:1.18rem;font-weight:700;color:#E8EEF8;letter-spacing:-.005em;margin:0}
        .filter-empty-sub{font-size:.88rem;color:#8A9FBB;font-weight:300;
          line-height:1.55;max-width:400px;margin:0}

        /* === AI «книжка»: одна страница за раз, компактно === */
        /* ai-body — контейнер книжки внутри карточки */
        .ai-body{padding:.45rem .9rem .75rem;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}

        .ai-book{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
        /* страница-плашка: тянется по доступной высоте, контент скроллится внутри */
        .ai-book-page{
          flex:1;min-height:0;min-width:0;
          display:flex;flex-direction:column;
          background:rgba(255,255,255,.025);
          border:1px solid rgba(255,255,255,.07);
          border-radius:14px;padding:.85rem .95rem;
          animation:aiBookFade .28s ease both
        }
        @keyframes aiBookFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

        /* шапка страницы: заголовок + счётчик «1 / 5» */
        .ai-book-head{
          display:flex;align-items:center;justify-content:space-between;gap:.5rem;
          margin-bottom:.5rem;flex-shrink:0
        }
        .ai-book-counter{
          font-family:'DM Mono',monospace;font-size:.6rem;letter-spacing:.1em;
          color:#8A9FBB;flex-shrink:0
        }

        /* контент страницы: ограничен по высоте, аккуратный внутренний скролл */
        .ai-book-content{
          flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;
          display:flex;flex-direction:column;
          padding-right:.25rem;
          -webkit-overflow-scrolling:touch;
          scrollbar-width:thin;scrollbar-color:rgba(201,168,76,.28) transparent
        }
        .ai-book-content::-webkit-scrollbar{width:3px}
        .ai-book-content::-webkit-scrollbar-track{background:transparent}
        .ai-book-content::-webkit-scrollbar-thumb{background:rgba(201,168,76,.28);border-radius:3px}

        /* плашка «AI недоступен» — только на стр. «Главный вывод» */
        .ai-book-note{
          margin:0 0 .55rem;font-size:.72rem;line-height:1.45;color:#C9A84C;
          padding:.4rem .55rem;border-radius:8px;
          background:rgba(201,168,76,.07);border:1px solid rgba(201,168,76,.18)
        }

        /* навигация: стрелки + точки */
        .ai-book-nav{
          display:flex;align-items:center;justify-content:center;gap:.7rem;
          margin-top:.6rem;flex-shrink:0
        }
        .ai-book-arrow{
          width:30px;height:30px;border-radius:50%;flex-shrink:0;padding:0;
          display:inline-flex;align-items:center;justify-content:center;
          background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.30);
          color:#E8C97A;cursor:pointer;
          transition:background .15s,border-color .15s,opacity .15s
        }
        .ai-book-arrow:hover:not(:disabled){background:rgba(201,168,76,.18);border-color:rgba(201,168,76,.5)}
        .ai-book-arrow:disabled{opacity:.28;cursor:default}
        .ai-book-arrow svg{width:15px;height:15px}
        .ai-book-dots{display:flex;align-items:center;gap:.4rem}
        .ai-book-dot{
          width:7px;height:7px;border-radius:50%;padding:0;cursor:pointer;
          background:rgba(255,255,255,.18);border:none;
          transition:background .15s,transform .15s
        }
        .ai-book-dot:hover{background:rgba(201,168,76,.5)}
        .ai-book-dot.is-active{
          background:#C9A84C;transform:scale(1.25);
          box-shadow:0 0 8px rgba(201,168,76,.55)
        }

        /* типографика внутри страницы */
        .ai-sec-title{
          margin:0;font-family:'DM Mono',monospace;font-size:.62rem;font-weight:700;
          letter-spacing:.14em;text-transform:uppercase;color:#E8C97A
        }
        .ai-sec-text{
          margin:0;font-size:.84rem;line-height:1.6;color:#D7E0EE;font-weight:400;
          white-space:pre-line;overflow-wrap:break-word;word-break:break-word
        }
        .ai-sec-muted{color:#8A9FBB}
        .ai-sec-list{
          list-style:none;margin:0;padding:0;flex:1 1 auto;
          display:flex;flex-direction:column;gap:.5rem;
          justify-content:space-between
        }
        .ai-sec-list li{
          position:relative;padding-left:.95rem;
          font-size:.8rem;line-height:1.46;color:#D7E0EE;
          overflow-wrap:break-word;word-break:break-word
        }
        .ai-sec-list li::before{
          content:"";position:absolute;left:.1rem;top:.56em;
          width:5px;height:5px;border-radius:50%;
          background:#C9A84C;box-shadow:0 0 6px rgba(201,168,76,.5)
        }
        /* мини-бары структуры расходов (стр. 2) — чистый CSS, без библиотек */
        .ai-sec-list li.ai-bar-li{padding-left:0}
        .ai-sec-list li.ai-bar-li::before{display:none}
        .ai-bar-head{
          display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;
          margin-bottom:.3rem;font-size:.78rem;line-height:1.3;color:#D7E0EE
        }
        .ai-bar-name{overflow-wrap:break-word;word-break:break-word}
        .ai-bar-val{
          font-family:'DM Mono',monospace;font-size:.72rem;color:#9FB1CB;
          flex-shrink:0;white-space:nowrap
        }
        .ai-bar-track{
          height:7px;border-radius:6px;overflow:hidden;
          background:rgba(255,255,255,.06)
        }
        .ai-bar-fill{
          display:block;height:100%;border-radius:6px;
          background:linear-gradient(90deg,#C9A84C,#E8C97A)
        }
        .ai-bar-good .ai-bar-fill{background:linear-gradient(90deg,#3FB984,#6FE0AE)}
        .ai-bar-good .ai-bar-val{color:#7FE3B4}
        .ai-bar-bad .ai-bar-fill{background:linear-gradient(90deg,#E0604C,#F0897A)}
        .ai-bar-bad .ai-bar-val{color:#F0897A}
        /* бар без данных по статье — приглушённый, с «нет данных» */
        .ai-bar-missing .ai-bar-name{color:#8A9FBB}
        .ai-bar-missing .ai-bar-val{color:#6B7E99;font-style:italic}
        .ai-bar-missing .ai-bar-track{background:rgba(255,255,255,.04)}
        /* короткий комментарий AI под шкалой статьи */
        .ai-bar-comment{margin-top:.32rem;font-size:.72rem;line-height:1.4;color:#9FB1CB}

        /* === Структурные блоки книжки: KPI, карточки, риски, чек-лист === */
        /* строковый пункт-контейнер без маркера */
        .ai-sec-list li.ai-li-plain{padding-left:0}
        .ai-sec-list li.ai-li-plain::before{display:none}

        /* сильный вывод (стр. «Главный вывод» / «Итог») */
        .ai-verdict{
          font-size:.84rem;line-height:1.5;color:#E8EEF8;font-weight:500;
          padding:.55rem .65rem;border-radius:10px;
          background:rgba(201,168,76,.06);border:1px solid rgba(201,168,76,.16);
          border-left:3px solid #C9A84C
        }
        .ai-verdict-bad{background:rgba(224,96,76,.08);border-color:rgba(224,96,76,.22);border-left-color:#E0604C}
        .ai-verdict-warn{background:rgba(224,170,76,.07);border-color:rgba(224,170,76,.2);border-left-color:#E8C97A}
        .ai-verdict-good{background:rgba(63,185,132,.07);border-color:rgba(63,185,132,.2);border-left-color:#3FB984}

        /* KPI-сетка — авто-перенос: на широком 5 в ряд, на узком переносится */
        .ai-kpi-grid{
          display:grid;gap:.4rem;
          grid-template-columns:repeat(3,1fr)
        }
        .ai-kpi{
          display:flex;flex-direction:column;gap:.1rem;min-width:0;
          padding:.45rem .5rem;border-radius:9px;
          background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)
        }
        .ai-kpi-val{
          font-family:'DM Mono',monospace;font-size:.8rem;font-weight:700;
          color:#E8EEF8;line-height:1.1;letter-spacing:-.01em;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis
        }
        .ai-kpi-label{
          font-size:.58rem;letter-spacing:.03em;color:#8A9FBB;text-transform:uppercase;
          line-height:1.2;overflow-wrap:break-word
        }
        .ai-kpi-good{border-color:rgba(63,185,132,.22)}
        .ai-kpi-good .ai-kpi-val{color:#7FE3B4}
        .ai-kpi-warn{border-color:rgba(224,170,76,.22)}
        .ai-kpi-warn .ai-kpi-val{color:#E8C97A}
        .ai-kpi-bad{border-color:rgba(224,96,76,.22)}
        .ai-kpi-bad .ai-kpi-val{color:#F0897A}

        /* карточка-проблема: проблема → почему → действие */
        .ai-pcard{
          padding:.5rem .6rem;border-radius:10px;
          background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);
          border-left:3px solid #6B7E99
        }
        .ai-pcard-warn{border-left-color:#E8C97A}
        .ai-pcard-bad{border-left-color:#E0604C}
        .ai-pcard-good{border-left-color:#3FB984}
        .ai-pcard-neutral{border-left-color:#6B7E99}
        .ai-pcard-problem{font-size:.8rem;font-weight:600;color:#E8EEF8;line-height:1.35;margin-bottom:.2rem}
        .ai-pcard-why{font-size:.74rem;line-height:1.42;color:#9FB1CB;margin-bottom:.25rem}
        .ai-pcard-action{font-size:.76rem;line-height:1.4;color:#D7E0EE;display:flex;gap:.32rem}
        .ai-pcard-arrow{color:#C9A84C;flex-shrink:0}

        /* риск с бейджем уровня — компактная карточка */
        .ai-risk{display:flex;align-items:flex-start;gap:.5rem;
          font-size:.78rem;line-height:1.42;color:#D7E0EE;
          padding:.46rem .58rem;border-radius:9px;
          background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07)}
        .ai-risk-badge{
          flex-shrink:0;font-family:'DM Mono',monospace;font-size:.55rem;font-weight:700;
          letter-spacing:.05em;text-transform:uppercase;
          padding:.16rem .34rem;border-radius:5px;margin-top:.05rem
        }
        .ai-risk-high{background:rgba(224,96,76,.16);color:#F0897A;border:1px solid rgba(224,96,76,.32)}
        .ai-risk-medium{background:rgba(224,170,76,.14);color:#E8C97A;border:1px solid rgba(224,170,76,.3)}
        .ai-risk-low{background:rgba(120,140,170,.14);color:#9FB1CB;border:1px solid rgba(120,140,170,.28)}
        .ai-risk-text{flex:1;min-width:0;overflow-wrap:break-word;word-break:break-word}

        /* чек-лист «План на 7 дней» — компактная карточка */
        .ai-check{display:flex;align-items:flex-start;gap:.5rem;
          font-size:.78rem;line-height:1.4;color:#D7E0EE;
          padding:.46rem .58rem;border-radius:9px;
          background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07)}
        .ai-check-box{
          flex-shrink:0;width:13px;height:13px;border-radius:4px;margin-top:.12rem;
          border:1.5px solid rgba(201,168,76,.55);background:rgba(201,168,76,.08)
        }
        .ai-check-day{
          flex-shrink:0;font-family:'DM Mono',monospace;font-size:.66rem;font-weight:700;
          color:#E8C97A;min-width:3.1rem
        }
        .ai-check-text{flex:1;min-width:0;overflow-wrap:break-word;word-break:break-word}

        /* заметка-плашка: «AI недоступен» / «главная проблема» / «эффект» */
        .ai-note{font-size:.74rem;line-height:1.45;padding:.42rem .55rem;border-radius:8px}
        .ai-note-muted{color:#9FB1CB;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)}
        .ai-note-accent{color:#E8C97A;background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.2)}

        @media (prefers-reduced-motion:reduce){
          .ai-book-page{animation:none}
        }

        /* loader на время ожидания ответа AI */
        .ai-loading{
          display:flex;align-items:center;justify-content:center;gap:.6rem;
          min-height:160px;font-size:.82rem;color:#9FB1CB
        }
        .ai-spinner{
          width:16px;height:16px;border-radius:50%;
          border:2px solid rgba(201,168,76,.25);border-top-color:#C9A84C;
          animation:aiSpin .8s linear infinite;flex-shrink:0
        }
        @keyframes aiSpin{to{transform:rotate(360deg)}}
        .ai-ins-title{color:#E8EEF8;font-weight:600}
        .ai-ins-desc{color:#8A9FBB;font-weight:400}

        /* missing data list */
        .ai-missing-list{
          list-style:none;margin:.35rem 0 0;padding:0;
          display:flex;flex-direction:column;gap:.3rem
        }
        .ai-missing-item{
          font-size:.76rem;color:#7C8DB5;padding:.25rem .5rem .25rem .8rem;
          border-left:2px solid rgba(201,168,76,.3);line-height:1.4;
          overflow-wrap:break-word
        }

        /* === PROFIT LEAKS === */
        .ai-leaks{display:flex;flex-direction:column;gap:.28rem;padding:.1rem 0 .1rem}
        .ai-leak-row{display:flex;align-items:center;gap:.45rem;font-size:.76rem;
          padding:.22rem .5rem;border-radius:7px;background:rgba(255,255,255,.025);
          border:1px solid rgba(255,255,255,.06)}
        .ai-leak-area{font-family:'DM Mono',monospace;font-size:.62rem;font-weight:600;
          letter-spacing:.06em;color:#C9A84C;min-width:90px;flex-shrink:0}
        .ai-leak-comment{flex:1;min-width:0;color:#8A9FBB;font-size:.73rem;overflow-wrap:break-word}
        .ai-leak-amount{font-family:'DM Mono',monospace;font-size:.68rem;
          color:#E05566;font-weight:600;white-space:nowrap;flex-shrink:0}

        /* === PRODUCT RISKS === */
        .ai-risks-list{list-style:none;margin:0;padding:.1rem 0 .1rem;
          display:flex;flex-direction:column;gap:.3rem}
        .ai-risk-item{display:grid;grid-template-columns:1fr auto;
          grid-template-areas:"name sku" "reason action";
          gap:.12rem .5rem;padding:.3rem .5rem;border-radius:7px;
          background:rgba(224,85,102,.06);border:1px solid rgba(224,85,102,.18)}
        .ai-risk-name{grid-area:name;font-size:.76rem;color:#E8EEF8;font-weight:500;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .ai-risk-sku{grid-area:sku;font-family:'DM Mono',monospace;font-size:.58rem;
          color:#7C8DB5;letter-spacing:.05em;white-space:nowrap}
        .ai-risk-reason{grid-area:reason;font-size:.71rem;color:#E05566;
          min-width:0;overflow-wrap:break-word}
        .ai-risk-action{grid-area:action;font-size:.68rem;color:#8A9FBB;
          text-align:right;font-style:italic;min-width:0;overflow-wrap:break-word}

        /* === FALLBACK NOTE (дружелюбное сообщение, без техданных) === */
        .ai-fallback-note{
          margin:0 0 .1rem;
          padding:.5rem .7rem;
          border-radius:8px;
          background:rgba(201,168,76,.08);
          border:1px solid rgba(201,168,76,.22);
          color:#D8C089;font-size:.74rem;line-height:1.45
        }

        /* === AI PRO LOCK ===  */
        .an-ai-card.ai-locked .ai-list{
          filter:blur(6px) saturate(.55);opacity:.55;
          pointer-events:none;user-select:none;
          transition:filter .3s ease, opacity .3s ease
        }
        .ai-lock-overlay{
          position:absolute;inset:0;z-index:5;
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          gap:.65rem;padding:1.5rem;text-align:center;
          background:linear-gradient(180deg,
            rgba(13,16,32,.55) 0%,
            rgba(13,16,32,.85) 100%);
          backdrop-filter:blur(10px) saturate(1.2);
          -webkit-backdrop-filter:blur(10px) saturate(1.2);
          animation:lockIn .4s cubic-bezier(.22,1,.36,1) both
        }
        @keyframes lockIn{from{opacity:0}to{opacity:1}}
        .ai-lock-pro{
          display:inline-flex;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.58rem;font-weight:700;
          text-transform:uppercase;letter-spacing:.16em;color:#05070f;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
          padding:5px 11px;border-radius:100px;
          box-shadow:0 6px 16px rgba(201,168,76,.42);margin-bottom:.2rem
        }
        .ai-lock-icon{
          width:60px;height:60px;border-radius:17px;
          display:inline-flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg,rgba(201,168,76,.28) 0%,rgba(201,168,76,.08) 100%);
          border:1px solid rgba(201,168,76,.4);color:#E8C97A;
          box-shadow:0 14px 38px rgba(201,168,76,.22),
            inset 0 1px 0 rgba(255,255,255,.08);
          animation:lockGlow 3s ease-in-out infinite
        }
        @keyframes lockGlow{
          0%,100%{box-shadow:0 14px 38px rgba(201,168,76,.22),
            0 0 0 0 rgba(201,168,76,.2),inset 0 1px 0 rgba(255,255,255,.08)}
          50%{box-shadow:0 14px 38px rgba(201,168,76,.32),
            0 0 0 14px rgba(201,168,76,.04),inset 0 1px 0 rgba(255,255,255,.08)}
        }
        .ai-lock-icon svg{width:26px;height:26px;display:block}
        .ai-lock-title{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.18rem;font-weight:700;color:#E8EEF8;
          letter-spacing:-.005em;margin:.2rem 0 0
        }
        .ai-lock-sub{
          font-size:.85rem;color:#8A9FBB;font-weight:300;line-height:1.5;
          max-width:280px;margin:0
        }
        .ai-lock-btn{
          margin-top:.4rem;font-family:'Outfit',sans-serif;
          font-size:.85rem;font-weight:600;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
          color:#05070f;border:none;
          padding:11px 22px;border-radius:11px;cursor:pointer;
          box-shadow:0 10px 28px rgba(201,168,76,.32);
          transition:transform .22s ease, box-shadow .22s ease;
          display:inline-flex;align-items:center;gap:8px
        }
        .ai-lock-btn:hover{
          transform:translateY(-2px) scale(1.02);
          box-shadow:0 18px 42px rgba(201,168,76,.5), 0 0 28px rgba(201,168,76,.22)
        }
        .ai-lock-btn:active{transform:translateY(0) scale(.98)}
        .ai-lock-btn .arr{display:inline-block;transition:transform .22s ease}
        .ai-lock-btn:hover .arr{transform:translateX(3px)}
        .ai-lock-btn.is-soon{
          background:linear-gradient(135deg,rgba(201,168,76,.22),rgba(201,168,76,.10));
          color:#E8C97A;border:1px solid rgba(201,168,76,.4);
          box-shadow:none;cursor:default;letter-spacing:.04em
        }
        .ai-lock-btn.is-soon:hover{transform:none;box-shadow:none}

        /* === RELEASE v1.0 — компактная карточка «AI Аналитика — Скоро» ===
           Не рендерит тяжёлый ai-body, поэтому не растягивает страницу.
           Контент по центру; карточка занимает свою колонку без лишней высоты. */
        .an-ai-soon{
          align-items:center;justify-content:center;text-align:center;
          gap:.55rem;padding:1.7rem 1.4rem
        }
        .an-ai-soon .ai-card-shine{opacity:.5}
        .ai-soon-badge{
          display:inline-flex;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.58rem;font-weight:700;
          text-transform:uppercase;letter-spacing:.16em;color:#05070f;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
          padding:5px 11px;border-radius:100px;
          box-shadow:0 6px 16px rgba(201,168,76,.42)
        }
        .ai-soon-icon{
          width:48px;height:48px;border-radius:14px;
          display:inline-flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg,rgba(201,168,76,.28) 0%,rgba(201,168,76,.08) 100%);
          border:1px solid rgba(201,168,76,.4);color:#E8C97A;
          box-shadow:0 12px 30px rgba(201,168,76,.2),inset 0 1px 0 rgba(255,255,255,.08);
          animation:lockGlow 3s ease-in-out infinite
        }
        .ai-soon-icon svg{width:22px;height:22px;display:block}
        .ai-soon-title{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.1rem;font-weight:700;color:#E8EEF8;
          letter-spacing:-.005em;margin:.1rem 0 0
        }
        .ai-soon-sub{
          font-size:.82rem;color:#8A9FBB;font-weight:300;line-height:1.5;
          max-width:300px;margin:0
        }
        .ai-soon-btn{
          margin-top:.35rem;font-family:'Outfit',sans-serif;
          font-size:.82rem;font-weight:600;letter-spacing:.04em;
          background:linear-gradient(135deg,rgba(201,168,76,.22),rgba(201,168,76,.10));
          color:#E8C97A;border:1px solid rgba(201,168,76,.4);
          padding:9px 24px;border-radius:11px;cursor:default
        }
        @media (prefers-reduced-motion: reduce){
          .ai-soon-icon{animation:none}
        }

        /* === RECENT === */
        .rc-wide{margin-top:.55rem}
        .rc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.55rem;
          padding:.05rem .95rem .85rem}
        .rc-card{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);
          border-radius:10px;padding:.65rem .8rem;display:flex;flex-direction:column;gap:.35rem;
          transition:all .22s ease;position:relative;overflow:hidden}
        .rc-card::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:0;
          background:radial-gradient(220px 120px at 100% 0%, rgba(201,168,76,.12), transparent 60%);
          transition:opacity .25s ease}
        .rc-card:hover{transform:translateY(-3px);border-color:rgba(201,168,76,.32);
          background:rgba(255,255,255,.045);
          box-shadow:0 14px 32px rgba(0,0,0,.28),0 0 28px rgba(201,168,76,.10)}
        .rc-card:hover::before{opacity:1}
        .rc-card > *{position:relative}
        .rc-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
        .rc-product{font-size:.82rem;color:#E8EEF8;font-weight:500;overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
        .rc-mp{font-family:'DM Mono',monospace;font-size:.56rem;padding:3px 9px;
          border-radius:5px;border:1px solid;flex-shrink:0;letter-spacing:.08em;
          font-weight:600;text-transform:uppercase}
        .rc-mp.ozon{border-color:rgba(61,123,255,.45);color:#9ec6ff;background:rgba(61,123,255,.1)}
        .rc-mp.wb{border-color:rgba(203,17,171,.45);color:#f0a4e6;background:rgba(203,17,171,.1)}
        .rc-profit-wrap{display:flex;flex-direction:column;gap:.2rem}
        .rc-profit-label{font-family:'DM Mono',monospace;font-size:.54rem;letter-spacing:.07em;
          text-transform:uppercase;color:#7C8DB5;line-height:1}
        .rc-profit{font-family:'Playfair Display',Georgia,serif;font-size:1.1rem;font-weight:700;
          letter-spacing:-.022em;line-height:1}
        .rc-profit.pos{color:#2ECC8A}
        .rc-profit.neg{color:#E05566}
        .rc-meta{display:flex;justify-content:space-between;align-items:center;
          font-family:'DM Mono',monospace;font-size:.6rem;color:#425068;letter-spacing:.06em}
        .rc-meta .mar{color:#8A9FBB}

        @media(max-width:900px){
          .an-grid{grid-template-columns:1fr}
        }
        @media(max-width:640px){
          .an-title{font-size:1.2rem}
          .donut-wrap{flex-direction:column;align-items:center;text-align:left;padding:0 1.2rem 1.3rem}
          .donut-legend{width:100%;max-width:300px}
          .an-card-head{padding:1rem 1.1rem .7rem}
          .an-chart-body{padding:.2rem .8rem 0}
          .an-chart-foot{padding:.7rem 1.1rem 1rem;gap:1rem}
          .rc-grid{padding:.2rem 1.1rem 1.1rem;gap:.7rem}
          .ai-kpi-grid{grid-template-columns:repeat(2,1fr)}
        }

        @media (prefers-reduced-motion: reduce){
          .an-card,
          .donut-svg,
          .line-svg .line-stroke,
          .line-svg .line-area,
          .ai-spark,
          .ai-lock-icon,
          .ai-lock-overlay,
          .ai-insight,
          .ai-rec-chip,
          .ai-health-row,
          .ai-health-fill,
          .ai-quick-card,
          .ai-card-shine,
          .an-badge .dot{animation:none !important;opacity:1 !important;
            transform:none !important;stroke-dashoffset:0 !important;
            transition:none !important}
        }
      `}</style>

      <section className="an-section">
        <div className="an-head">
          <h2 className="an-title">
            Аналитика <em>прибыли</em>
          </h2>
          <div className="an-badge">
            <span className="dot" />
            {isFilteredEmpty
              ? "Фильтр активен"
              : isDemo
              ? "Нет данных"
              : "Ваши данные"}
          </div>
        </div>

        {isFilteredEmpty ? (
          <div className="filter-empty" role="status">
            <div className="filter-empty-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4h18l-7 8v6l-4 2v-8z" />
                <line x1="16" y1="6" x2="22" y2="12" />
                <line x1="22" y1="6" x2="16" y2="12" />
              </svg>
            </div>
            <h3 className="filter-empty-title">
              Нет расчётов по выбранным фильтрам
            </h3>
            <p className="filter-empty-sub">
              Попробуйте изменить период, маркетплейс или тип результата, чтобы увидеть аналитику.
            </p>
          </div>
        ) : isDemo ? (
          <div className="filter-empty" role="status">
            <div className="filter-empty-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <rect x="7" y="11" width="3" height="6" rx="1" />
                <rect x="12" y="7" width="3" height="10" rx="1" />
                <rect x="17" y="13" width="3" height="4" rx="1" />
              </svg>
            </div>
            <h3 className="filter-empty-title">
              Аналитика появится после первого расчёта
            </h3>
            <p className="filter-empty-sub">
              Здесь будут ваши графики выручки и прибыли, структура расходов и
              последние расчёты — на основе реальных данных. Сделайте первый
              расчёт в калькуляторе выше.
            </p>
          </div>
        ) : (
        <>
        <div className="an-grid an-grid-row-1">
          {/* Revenue */}
          <div className="an-card">
            <div className="an-card-head">
              <div>
                <div className="an-card-title">
                  {isDemo ? "Выручка за 14 дней" : "Выручка по расчётам"}
                </div>
                <div className={"an-card-sub" + (isDemo ? " demo" : "")}>
                  {isDemo
                    ? "Пример данных"
                    : `${revenueSeries.length} ${
                        revenueSeries.length === 1
                          ? "расчёт"
                          : revenueSeries.length < 5
                          ? "расчёта"
                          : "расчётов"
                      }`}
                </div>
              </div>
              <div className="an-card-val">{fmt(sumRev)} ₽</div>
            </div>
            <div className="an-chart-body">
              <LineChart data={revenueSeries} color="#C9A84C" height={78} />
            </div>
            <div className="an-chart-foot">
              <div>
                <div className="an-stat-l">Максимум</div>
                <div className="an-stat-v">{fmt(maxRev)} ₽</div>
              </div>
              <div>
                <div className="an-stat-l">Среднее</div>
                <div className="an-stat-v">{fmt(avgRev)} ₽</div>
              </div>
            </div>
          </div>

          {/* Profit */}
          <div className="an-card">
            <div className="an-card-head">
              <div>
                <div className="an-card-title">
                  {isDemo ? "Чистая прибыль за 14 дней" : "Прибыль по расчётам"}
                </div>
                <div className={"an-card-sub" + (isDemo ? " demo" : "")}>
                  {isDemo
                    ? "Пример данных"
                    : `${profitSeries.length} ${
                        profitSeries.length === 1
                          ? "расчёт"
                          : profitSeries.length < 5
                          ? "расчёта"
                          : "расчётов"
                      }`}
                </div>
              </div>
              <div className={"an-card-val " + (sumProf >= 0 ? "pos" : "neg")}>
                {fmtSigned(sumProf)} ₽
              </div>
            </div>
            <div className="an-chart-body">
              <LineChart data={profitSeries} color="#2ECC8A" height={105} />
            </div>
            <div className="an-chart-foot">
              <div>
                <div className="an-stat-l">Максимум</div>
                <div className={"an-stat-v " + (maxProf >= 0 ? "pos" : "neg")}>
                  {fmtSigned(maxProf)} ₽
                </div>
              </div>
              <div>
                <div className="an-stat-l">Среднее</div>
                <div className={"an-stat-v " + (avgProf >= 0 ? "pos" : "neg")}>
                  {fmtSigned(avgProf)} ₽
                </div>
              </div>
            </div>
          </div>

        </div>

        <div className="an-grid an-grid-bottom">
          {/* Donut — top-left */}
          <div className="an-card an-area-donut">
            <div className="an-card-head">
              <div>
                <div className="an-card-title">Структура расходов</div>
                <div className={"an-card-sub" + (expensesAreDemo ? " demo" : "")}>
                  {expensesAreDemo
                    ? "Пример данных"
                    : `${fmt(totalExp)} ₽ всего`}
                </div>
              </div>
            </div>
            <div className="donut-wrap">
              <DonutChart data={expenses} size={92} />
              <div className="donut-legend">
                {expenses.map((e, i) => (
                  <div className="donut-row" key={i}>
                    <span
                      className="donut-dot"
                      style={{ background: e.color, color: e.color }}
                    />
                    <span className="donut-label">{e.label}</span>
                    <span className="donut-val">{fmt(e.value)} ₽</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* AI — full right column (spans both rows) */}
          {/* RELEASE v1.0: при AI_COMING_SOON показываем компактную карточку
              «Скоро» вместо полного AI-кокпита. Весь функционал AI (компактный
              обзор, health-бары, инсайты, рекомендации) сохранён в ветке else
              ниже — вернётся при AI_COMING_SOON=false. */}
          {AI_COMING_SOON ? (
            <div
              className="an-card an-ai-card an-area-ai an-ai-reco"
              role="region"
              aria-label="AI Аналитика"
            >
              <span className="ai-card-shine" aria-hidden="true" />
              <div className="an-card-head">
                <div className="ai-title-row">
                  <span className="ai-spark" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
                    </svg>
                  </span>
                  AI Аналитика
                </div>
                <div className="ai-sub">умные рекомендации</div>
              </div>
              <div className="ai-reco-body">
                <ProfitRecommendations {...(reco ?? EMPTY_RECO)} />
              </div>
            </div>
          ) : (
          <div
            className={"an-card an-ai-card an-area-ai" + (hasPremium ? "" : " ai-locked")}
          >
            <span className="ai-card-shine" aria-hidden="true" />

            <div className="an-card-head">
              <div className="ai-title-row">
                <span className="ai-spark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
                  </svg>
                </span>
                {hasPremium && !aiLoading && !realAi
                  ? "Базовая аналитика"
                  : "AI Аналитика"}
              </div>
              {hasPremium && (
                <div className="ai-sub">
                  {realAi
                    ? "Персональные рекомендации по вашему отчёту"
                    : aiLoading
                    ? "AI анализирует ваш отчёт…"
                    : "Базовая аналитика по вашим цифрам"}
                </div>
              )}
            </div>
            {/* ═══ AI-«КНИЖКА» — одна страница за раз: стрелки + точки + счётчик ═══ */}
            <div className="ai-body" aria-hidden={!hasPremium}>
              {aiLoading ? (
                <div className="ai-loading" role="status" aria-live="polite">
                  <span className="ai-spinner" aria-hidden="true" />
                  <span>AI анализирует прибыль…</span>
                </div>
              ) : (
                <div className="ai-book">
                  <div className="ai-book-page" key={aiCur}>
                    <div className="ai-book-head">
                      <h4 className="ai-sec-title">{aiBookPages[aiCur].title}</h4>
                      <span className="ai-book-counter">
                        {aiCur + 1} / {aiTotal}
                      </span>
                    </div>
                    <div className="ai-book-content">
                      {renderAiPageBody(aiBookPages[aiCur])}
                    </div>
                  </div>

                  <div className="ai-book-nav">
                    <button
                      type="button"
                      className="ai-book-arrow"
                      onClick={aiGoPrev}
                      disabled={aiCur === 0}
                      aria-label="Предыдущая страница"
                    >
                      <svg
                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>

                    <div
                      className="ai-book-dots"
                      role="tablist"
                      aria-label="Страницы AI Аналитики"
                    >
                      {aiBookPages.map((p, i) => (
                        <button
                          key={i}
                          type="button"
                          role="tab"
                          aria-selected={i === aiCur}
                          aria-label={p.title}
                          className={"ai-book-dot" + (i === aiCur ? " is-active" : "")}
                          onClick={() => setAiPage(i)}
                        />
                      ))}
                    </div>

                    <button
                      type="button"
                      className="ai-book-arrow"
                      onClick={aiGoNext}
                      disabled={aiCur === aiTotal - 1}
                      aria-label="Следующая страница"
                    >
                      <svg
                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* RELEASE v1.0: AI_COMING_SOON-оверлей убран — это теперь отдельная
                компактная карточка выше. Здесь остаётся только Premium-замок
                (показывается, когда hasPremium=false). Ничего не удалено. */}
            {!hasPremium ? (
              <div className="ai-lock-overlay" role="region" aria-label="AI Аналитика — Premium">
                <div className="ai-lock-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                </div>
                <h3 className="ai-lock-title">AI Аналитика</h3>
                <p className="ai-lock-sub">
                  Доступно в тарифе Безлимит
                </p>
                <button
                  type="button"
                  className="ai-lock-btn"
                  onClick={onOpenPremium}
                >
                  Открыть Premium
                  <span className="arr" aria-hidden="true">→</span>
                </button>
              </div>
            ) : null}
          </div>
          )}

          {/* Recent — bottom-left under donut */}
          <div className="an-card rc-wide an-area-recent">
          <div className="an-card-head">
            <div>
              <div className="an-card-title">Последние расчёты</div>
              <div className={"an-card-sub" + (isDemo ? " demo" : "")}>
                {isDemo
                  ? "Пример данных"
                  : `${recent.length} ${
                      recent.length === 1
                        ? "запись"
                        : recent.length < 5
                        ? "записи"
                        : "записей"
                    }`}
              </div>
            </div>
          </div>
          <div className="rc-grid">
            {recent.map((r, i) => (
              <div className="rc-card" key={i}>
                <div className="rc-top">
                  <span className="rc-product">{r.product}</span>
                  <span className={"rc-mp " + r.marketplace}>
                    {r.marketplace === "ozon" ? "Ozon" : "WB"}
                  </span>
                </div>
                <div className="rc-profit-wrap">
                  <span className="rc-profit-label">{r.profitLabel}</span>
                  <div className={"rc-profit " + (r.profit >= 0 ? "pos" : "neg")}>
                    {fmtSigned(r.profit)} ₽
                  </div>
                </div>
                <div className="rc-meta">
                  <span className="mar">маржа {r.margin.toFixed(1)}%</span>
                  <span>{r.date}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
        </>
        )}
      </section>
    </>
  );
}
