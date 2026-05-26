"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  totalRevenue: number;
  totalProfit: number;
  avgMargin: number;
  historyCount: number;
};

function AnimatedNumber({
  value,
  duration = 850,
  formatter,
}: {
  value: number;
  duration?: number;
  formatter: (v: number) => string;
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
      const cur = from + (to - from) * eased;
      setDisplay(cur);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        prev.current = to;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{formatter(display)}</>;
}

const fmtInt = (v: number) =>
  Math.round(v).toLocaleString("ru-RU", { maximumFractionDigits: 0 });

const fmtSignedInt = (v: number) =>
  (v >= 0 ? "+" : "−") +
  Math.abs(Math.round(v)).toLocaleString("ru-RU", { maximumFractionDigits: 0 });

const fmtPct = (v: number) => v.toFixed(1) + "%";

export function StatsCards({
  totalRevenue,
  totalProfit,
  avgMargin,
  historyCount,
}: Props) {
  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="stat-label">Общая выручка</div>
        <div className="stat-value">
          <AnimatedNumber value={totalRevenue} formatter={(v) => fmtInt(v) + " ₽"} />
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Общая прибыль</div>
        <div
          className={"stat-value " + (totalProfit >= 0 ? "pos" : "neg")}
        >
          <AnimatedNumber
            value={totalProfit}
            formatter={(v) => fmtSignedInt(v) + " ₽"}
          />
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Средняя маржа</div>
        <div className="stat-value">
          <AnimatedNumber value={avgMargin} formatter={fmtPct} />
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">Всего расчётов</div>
        <div className="stat-value">
          <AnimatedNumber
            value={historyCount}
            formatter={(v) => Math.round(v).toString()}
          />
        </div>
      </div>
    </div>
  );
}
