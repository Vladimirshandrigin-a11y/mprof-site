"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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
}

interface Props {
  realHistory?: AnalyticsCalc[];
  hasAnyData?: boolean;
  hasPremium?: boolean;
  onOpenPremium?: () => void;
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
}

const DEMO_RECENT: DemoRecent[] = [
  { product: "Куртка зимняя унисекс", marketplace: "ozon", profit: 24580, margin: 22.4, date: "сегодня" },
  { product: "Кроссовки беговые",     marketplace: "wb",   profit: 18920, margin: 19.8, date: "вчера" },
  { product: "Платье летнее",         marketplace: "ozon", profit: 12450, margin: 17.2, date: "2 дня назад" },
  { product: "Рюкзак городской",      marketplace: "wb",   profit:  9870, margin: 21.0, date: "3 дня назад" },
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
type AiAnalysis = {
  aiScore: number;
  healthLabel: string;
  summary: string;
  risks: string[];
  recommendations: string[];
  quickActions: string[];
};

/** quickActions от AI — строки вида «Действие — эффект». Разбиваем на 2 части
 *  под существующий дизайн карточки (action + impact). Нет разделителя —
 *  всё уходит в action, impact пустой. Дизайн не меняется. */
function aiQuickFromStrings(items: string[]): QuickAction[] {
  return items.slice(0, 4).map((raw) => {
    const s = String(raw).trim();
    const parts = s.split(/\s*[—–:→]\s*/);
    const impact = parts.slice(1).join(" ").trim();
    if (parts.length >= 2 && parts[0].trim() && impact) {
      return { action: parts[0].trim(), impact };
    }
    return { action: s, impact: "" };
  });
}

/** risks/recommendations от AI → слоты инсайтов под существующий дизайн
 *  (цветной бордер + иконка): риск → warning, рекомендация → optimization. */
function aiSlotsFromAnalysis(a: AiAnalysis): Insight[] {
  const out: Insight[] = [];
  if (a.risks[0]) out.push({ kind: "warning", ico: ICONS.alert, text: a.risks[0] });
  if (a.recommendations[0])
    out.push({ kind: "optimization", ico: ICONS.zap, text: a.recommendations[0] });
  if (a.risks[1]) out.push({ kind: "warning", ico: ICONS.target, text: a.risks[1] });
  if (out.length === 0 && a.summary)
    out.push({ kind: "positive", ico: ICONS.trendUp, text: a.summary });
  return out.slice(0, 4);
}

/* Score ring — анимированное кольцо вокруг числа */
function ScoreRing({
  score,
  tier,
}: {
  score: number;
  tier: Tier["kind"];
}) {
  const r = 24;
  const circ = 2 * Math.PI * r;
  const safe = Math.max(0, Math.min(100, score));
  const offset = circ * (1 - safe / 100);
  const gradId = `aiRing-${tier}`;
  const colors: Record<Tier["kind"], [string, string]> = {
    weak: ["#FF8A98", "#E05566"],
    stable: ["#FFD37D", "#E0A050"],
    strong: ["#E8C97A", "#C9A84C"],
    excellent: ["#7DEAB2", "#2ECC8A"],
  };
  const [c1, c2] = colors[tier];

  return (
    <svg viewBox="0 0 60 60" className="ai-ring-svg" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
      </defs>
      <circle
        cx="30" cy="30" r={r}
        stroke="rgba(255,255,255,.07)"
        strokeWidth="3"
        fill="none"
      />
      <circle
        cx="30" cy="30" r={r}
        stroke={`url(#${gradId})`}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform="rotate(-90 30 30)"
        style={{
          transition: "stroke-dashoffset .95s cubic-bezier(.22,1,.36,1)",
          filter: `drop-shadow(0 0 4px ${c2}55)`,
        }}
      />
    </svg>
  );
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

// === RELEASE v1.0 ===
// AI Аналитика временно показывается в состоянии «🔒 Скоро».
// Вся реальная логика ниже (запрос /api/ai/analyze, rule-based fallback,
// отрисовка score/инсайтов/рекомендаций) ПОЛНОСТЬЮ сохранена — чтобы
// включить функцию, достаточно поставить флаг в false. Ничего не удалено.
const AI_COMING_SOON: boolean = true;

export function AnalyticsBlock({
  realHistory,
  hasAnyData = false,
  hasPremium = false,
  onOpenPremium,
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

  // Числовые агрегаты по истории — ЕДИНСТВЕННОЕ, что уходит в AI.
  // Никаких файлов/сырых отчётов: только суммы и проценты. Строка-подпись
  // служит и телом запроса, и стабильным ключом зависимости эффекта.
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
    });
  })();

  // Запрос только когда есть premium И реальные данные (нет данных → нет вызова).
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
        const res = await fetch("/api/ai/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: aiPayloadSig,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("status " + res.status);
        const json = (await res.json()) as Partial<AiAnalysis> & {
          ok?: boolean;
        };
        if (!active) return;
        if (
          json &&
          typeof json.aiScore === "number" &&
          (Array.isArray(json.risks) || typeof json.summary === "string")
        ) {
          setAiData({
            aiScore: json.aiScore,
            healthLabel:
              typeof json.healthLabel === "string" ? json.healthLabel : "",
            summary: typeof json.summary === "string" ? json.summary : "",
            risks: Array.isArray(json.risks)
              ? json.risks.filter((x): x is string => typeof x === "string")
              : [],
            recommendations: Array.isArray(json.recommendations)
              ? json.recommendations.filter(
                  (x): x is string => typeof x === "string"
                )
              : [],
            quickActions: Array.isArray(json.quickActions)
              ? json.quickActions.filter(
                  (x): x is string => typeof x === "string"
                )
              : [],
          });
          setAiFailed(false);
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

  /* charts series */
  const realSlice = history.slice(0, 14).reverse(); // oldest → newest
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
  const expensesAreDemo = computedExpenses.length === 0;
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
  const aiScore = useAi ? clamp(0, 100, Math.round(aiData!.aiScore)) : rbScore;
  const aiTier: Tier = useAi
    ? {
        kind: getTier(aiScore).kind,
        label: aiData!.healthLabel || getTier(aiScore).label,
      }
    : getTier(rbScore);
  const aiSummary = useAi ? aiData!.summary || rbSummary : rbSummary;
  const aiRecs =
    useAi && aiData!.recommendations.length
      ? aiData!.recommendations.slice(0, 4)
      : rbRecs;
  const aiQuick =
    useAi && aiData!.quickActions.length
      ? aiQuickFromStrings(aiData!.quickActions)
      : rbQuick;
  const aiSlots: Insight[] =
    useAi &&
    (aiData!.risks.length ||
      aiData!.recommendations.length ||
      aiData!.summary)
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
        }))
      : DEMO_RECENT;

  return (
    <>
      <style jsx>{`
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
        .an-area-ai{grid-area:ai}
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
        }
        .an-ai-card::before{content:"";position:absolute;inset:0;pointer-events:none;
          background:radial-gradient(420px 240px at 100% 0%, rgba(201,168,76,.14), transparent 60%)}
        .an-ai-card > *{position:relative}
        .ai-title-row{display:flex;align-items:center;gap:.6rem;
          font-family:'Playfair Display',Georgia,serif;font-size:1.05rem;font-weight:700;color:#E8EEF8}
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
        .ai-body{padding:.4rem 1.2rem 1rem;flex:1;display:flex;flex-direction:column;gap:.85rem}
        .ai-section{display:flex;flex-direction:column;gap:.4rem}
        .ai-section-label{
          font-family:'DM Mono',monospace;font-size:.6rem;font-weight:700;
          letter-spacing:.16em;text-transform:uppercase;
          color:#7A8FA8;margin:0 0 .15rem
        }

        /* ===== TOP: ring + tier/trend/confidence ===== */
        .ai-top{
          display:flex;align-items:center;gap:1.1rem;
          padding:.4rem 0 .8rem;
          border-bottom:1px solid rgba(255,255,255,.06)
        }
        .ai-score-block{position:relative;width:78px;height:78px;flex-shrink:0}
        .ai-ring-svg{width:100%;height:100%;display:block;
          animation:aiRingIn .55s cubic-bezier(.22,1,.36,1) both}
        @keyframes aiRingIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
        .ai-ring-text{
          position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.65rem;font-weight:700;letter-spacing:-.025em;
          background:linear-gradient(135deg,#E8C97A 0%,#C9A84C 100%);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent;
          filter:drop-shadow(0 0 6px rgba(232,201,122,.18))
        }
        .ai-top.score-weak .ai-ring-text{
          background:linear-gradient(135deg,#FF8A98,#E05566);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent;
          filter:drop-shadow(0 0 6px rgba(224,85,102,.25))
        }
        .ai-top.score-stable .ai-ring-text{
          background:linear-gradient(135deg,#FFD37D,#E0A050);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent;
          filter:drop-shadow(0 0 6px rgba(232,180,80,.2))
        }
        .ai-top.score-excellent .ai-ring-text{
          background:linear-gradient(135deg,#7DEAB2,#2ECC8A);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent;
          filter:drop-shadow(0 0 6px rgba(46,204,138,.25))
        }

        .ai-top-meta{flex:1;display:flex;flex-direction:column;gap:.45rem;min-width:0}
        .ai-top-row{
          display:flex;align-items:center;justify-content:space-between;gap:.55rem;flex-wrap:wrap
        }
        .ai-score-label{
          font-family:'DM Mono',monospace;font-size:.62rem;
          letter-spacing:.18em;text-transform:uppercase;color:#7A8FA8;font-weight:700
        }
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

        /* insights list */
        .ai-insights-list{
          list-style:none;padding:0;margin:0;
          display:flex;flex-direction:column;gap:.3rem;flex:1
        }
        .ai-insight{
          display:flex;align-items:flex-start;gap:.7rem;
          padding:.7rem .85rem;border-radius:10px;
          font-size:.88rem;line-height:1.45;font-weight:400;color:#E8EEF8;
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
          .ai-ring-svg,
          .ai-ring-text,
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
              ? "Демо-данные"
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
                  {isDemo ? "Пример данных" : `${revenueSeries.length} расчётов`}
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
                  {isDemo ? "Пример данных" : `${profitSeries.length} расчётов`}
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
              «Скоро» вместо полного AI-кокпита. Весь функционал AI (ScoreRing,
              health-бары, инсайты, рекомендации) сохранён в ветке else ниже —
              ничего не удалено, вернётся при AI_COMING_SOON=false. */}
          {AI_COMING_SOON ? (
            <div
              className="an-card an-ai-card an-area-ai an-ai-soon"
              role="region"
              aria-label="AI Аналитика — скоро"
            >
              <span className="ai-card-shine" aria-hidden="true" />
              <span className="ai-soon-badge">🔒 Скоро</span>
              <div className="ai-soon-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
                </svg>
              </div>
              <h3 className="ai-soon-title">AI Аналитика</h3>
              <p className="ai-soon-sub">
                Автоматический AI-разбор прибыли, рисков и рекомендаций.
              </p>
              <button
                type="button"
                className="ai-soon-btn"
                disabled
                aria-disabled="true"
              >
                Скоро
              </button>
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
                AI Аналитика
              </div>
              {hasPremium && (
                <div className="ai-sub">
                  {insightsAreDemo
                    ? "Пример аналитики"
                    : aiLoading
                    ? "AI анализирует расчёт…"
                    : useAi
                    ? "AI-анализ"
                    : "Rule-based"}
                </div>
              )}
            </div>
            <div className="ai-body" aria-hidden={!hasPremium}>
              {/* === TOP: score ring + tier + trend + confidence === */}
              <div className={"ai-top score-" + aiTier.kind}>
                <div className="ai-score-block">
                  <ScoreRing score={aiScore} tier={aiTier.kind} />
                  <div
                    className="ai-ring-text"
                    aria-label={`AI оценка ${aiScore} из 100`}
                  >
                    <AnimatedScore value={aiScore} />
                  </div>
                </div>
                <div className="ai-top-meta">
                  <div className="ai-top-row">
                    <span className="ai-score-label">AI score</span>
                    <span className={"ai-score-tier-pill " + aiTier.kind}>
                      {aiTier.label}
                    </span>
                  </div>
                  <div className="ai-top-row">
                    <span className={"ai-trend dir-" + aiTrend.dir}>
                      {aiTrend.dir === "up"
                        ? "↑"
                        : aiTrend.dir === "down"
                        ? "↓"
                        : "→"}
                      <span className="ai-trend-val">
                        {aiTrend.dir === "flat"
                          ? "стабильно"
                          : `${aiTrend.delta > 0 ? "+" : ""}${aiTrend.delta.toFixed(1)}%`}
                      </span>
                    </span>
                    <span className={"ai-conf conf-" + aiConfidence}>
                      <span className="ai-conf-dot" />
                      {CONFIDENCE_LABEL[aiConfidence]}
                      <span className="ai-conf-pct">· {aiConfidencePct}%</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* === INDICATORS row === */}
              <div className="ai-indicators">
                <span className="ai-ind">
                  <span className="ai-ind-l">Комм.</span>
                  <span className="ai-ind-v">
                    {(aiIndicators.commission * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="ai-ind">
                  <span className="ai-ind-l">Рек.</span>
                  <span className="ai-ind-v">
                    {(aiIndicators.ads * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="ai-ind">
                  <span className="ai-ind-l">Лог.</span>
                  <span className="ai-ind-v">
                    {(aiIndicators.logistics * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="ai-ind ai-ind-margin">
                  <span className="ai-ind-l">Маржа</span>
                  <span className="ai-ind-v">
                    {aiIndicators.margin.toFixed(1)}%
                  </span>
                </span>
              </div>

              {/* === HEALTH BARS === */}
              <div className="ai-section">
                <div className="ai-section-label">Финансовое здоровье</div>
                <div className="ai-health" key={"h:" + aiScore}>
                  {aiHealth.map((m, i) => (
                    <div className="ai-health-row" key={i}>
                      <span className="ai-health-label">{m.label}</span>
                      <span className={"ai-health-bar tier-" + m.tier}>
                        <span
                          className="ai-health-fill"
                          style={{ width: m.value + "%" }}
                        />
                      </span>
                      <span className={"ai-health-value tier-" + m.tier}>
                        {m.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* === INSIGHTS (3 slots) === */}
              <div className="ai-section">
                <div className="ai-section-label">Инсайты</div>
                <ul
                  className="ai-insights-list"
                  key={history.length + ":" + aiScore}
                >
                  {aiSlots.map((ins, i) => (
                    <li className={"ai-insight " + ins.kind} key={i}>
                      <span className="ai-insight-ico" aria-hidden="true">
                        {ins.ico}
                      </span>
                      <span className="ai-insight-text">{ins.text}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* === QUICK ACTIONS === */}
              <div className="ai-section">
                <div className="ai-section-label">Что улучшить прямо сейчас</div>
                <div className="ai-quick" key={"q:" + aiScore}>
                  {aiQuick.map((q, i) => (
                    <div className="ai-quick-card" key={i}>
                      <div className="ai-quick-action">{q.action}</div>
                      <div className="ai-quick-impact">{q.impact}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* === BOTTOM: recs + summary === */}
              <div className="ai-bottom">
                <div className="ai-recs">
                  {aiRecs.map((r, i) => (
                    <span className="ai-rec-chip" key={i}>
                      {r}
                    </span>
                  ))}
                </div>
                <p className="ai-summary">
                  <span className="ai-summary-tag">AI</span>
                  <span>{aiSummary}</span>
                </p>
              </div>
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
                <div className={"rc-profit " + (r.profit >= 0 ? "pos" : "neg")}>
                  {fmtSigned(r.profit)} ₽
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
