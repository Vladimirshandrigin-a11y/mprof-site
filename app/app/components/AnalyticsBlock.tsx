"use client";

import type { ReactNode } from "react";

interface AnalyticsCalc {
  id: number;
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

interface Insight {
  ico: ReactNode;
  text: string;
}

const DEMO_INSIGHTS: Insight[] = [
  { ico: ICONS.trendUp,  text: "Маржинальность выше средней по категории" },
  { ico: ICONS.pieChart, text: "Реклама занимает 18% расходов" },
  { ico: ICONS.trophy,   text: "WB приносит больше прибыли" },
];

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

  const sumRev    = history.reduce((s, h) => s + h.revenue,   0);
  const sumExp    = history.reduce((s, h) => s + h.expenses,  0);
  const sumAds    = history.reduce((s, h) => s + h.ads,       0);
  const sumLog    = history.reduce((s, h) => s + h.logistics, 0);
  const avgMargin =
    history.reduce((s, h) => s + h.margin, 0) / history.length;
  const losing = history.find((h) => h.profit < 0);

  const out: Insight[] = [];

  if (avgMargin > 40) {
    out.push({ ico: ICONS.trendUp, text: "Маржинальность выше среднего" });
  } else if (avgMargin > 0) {
    out.push({
      ico: ICONS.trendUp,
      text: `Средняя маржа ${avgMargin.toFixed(1)}%`,
    });
  }

  if (sumExp > 0 && sumAds / sumExp > 0.2) {
    const pct = ((sumAds / sumExp) * 100).toFixed(0);
    out.push({
      ico: ICONS.pieChart,
      text: `Реклама занимает больше ${pct}% расходов`,
    });
  }

  if (sumRev > 0 && sumLog / sumRev > 0.1) {
    const pct = ((sumLog / sumRev) * 100).toFixed(0);
    out.push({
      ico: ICONS.truck,
      text: `Логистика занимает ${pct}% выручки`,
    });
  }

  if (losing) {
    out.push({
      ico: ICONS.alert,
      text: "Расчёт убыточный — проверьте расходы",
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
    if (wbProfit > ozonProfit) {
      out.push({ ico: ICONS.trophy, text: "WB приносит больше прибыли" });
    } else if (ozonProfit > wbProfit) {
      out.push({ ico: ICONS.trophy, text: "Ozon приносит больше прибыли" });
    }
  }

  if (out.length === 0) {
    out.push({
      ico: ICONS.trendUp,
      text: `Сохранено расчётов: ${history.length}`,
    });
  }

  return out.slice(0, 3);
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

  /* insights */
  const insights = computeInsights(history);
  const insightsAreDemo = history.length === 0;

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

        .an-grid{display:grid;grid-template-columns:1fr 1fr;gap:.55rem;align-items:stretch}
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
        .donut-wrap{display:flex;align-items:center;gap:.8rem;padding:.05rem .95rem .75rem;
          flex:1}
        .donut-svg{flex-shrink:0;animation:donutIn 1s ease-out both}
        @keyframes donutIn{from{opacity:0;transform:scale(.86) rotate(-12deg)}
          to{opacity:1;transform:scale(1) rotate(0)}}
        .donut-legend{flex:1;display:flex;flex-direction:column;gap:.25rem;
          font-family:'DM Mono',monospace;font-size:.6rem;min-width:0}
        .donut-row{display:flex;align-items:center;gap:.4rem;color:#9FB1CB}
        .donut-dot{width:7px;height:7px;border-radius:2px;flex-shrink:0;
          box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
        .donut-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
        .donut-val{margin-left:auto;color:#E8EEF8;font-weight:500;flex-shrink:0;
          font-size:.6rem}

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
        .ai-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.3rem;
          flex:1}
        .ai-item{display:flex;align-items:flex-start;gap:.5rem;
          background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);
          padding:.42rem .65rem;border-radius:9px;font-size:.75rem;color:#E8EEF8;
          font-weight:300;line-height:1.38;transition:all .22s ease}
        .ai-item:hover{background:rgba(255,255,255,.05);
          border-color:rgba(201,168,76,.32);transform:translateX(2px)}
        .ai-ico{flex-shrink:0;color:#E8C97A;width:14px;height:14px;display:inline-flex;
          align-items:center;justify-content:center;margin-top:1px}
        .ai-ico svg{width:14px;height:14px}
        .ai-body{padding:.05rem .95rem .8rem;flex:1;display:flex;flex-direction:column}

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
          .an-badge .dot{animation:none !important;opacity:1 !important;
            transform:none !important;stroke-dashoffset:0 !important}
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
        <div className="an-grid">
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

          {/* Donut */}
          <div className="an-card">
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
              <DonutChart data={expenses} size={100} />
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

          {/* AI */}
          <div
            className={
              "an-card an-ai-card" + (hasPremium ? "" : " ai-locked")
            }
          >
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
                  {insightsAreDemo ? "Пример аналитики" : "Rule-based"}
                </div>
              )}
            </div>
            <div className="ai-body">
              <ul className="ai-list" aria-hidden={!hasPremium}>
                {insights.map((ins, i) => (
                  <li className="ai-item" key={i}>
                    <span className="ai-ico" aria-hidden="true">{ins.ico}</span>
                    <span>{ins.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            {!hasPremium && (
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
            )}
          </div>
        </div>

        {/* Recent */}
        <div className="an-card rc-wide">
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
        </>
        )}
      </section>
    </>
  );
}
