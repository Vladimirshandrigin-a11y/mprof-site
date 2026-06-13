"use client";

// ============================================================================
// MonthlyAnalytics — раздел «Аналитика по месяцам» в кабинете.
//
// Источник данных: report_history (Supabase). Каждый сохранённый расчёт чистой
// прибыли пишет туда снимок (revenue/expenses/profit/margin + report_month).
// Здесь мы:
//   1. Загружаем историю пользователя.
//   2. Группируем по месяцу (последняя запись за месяц).
//   3. Показываем карточки текущего (последнего) месяца: выручка/прибыль/маржа.
//   4. Рисуем графики прибыли и выручки по месяцам (чистый CSS, без библиотек).
//   5. Если месяцев < 2 — показываем подсказку, что нужны расчёты за 2 РАЗНЫХ
//      месяца (а не просто «2 отчёта»: 8 расчётов одного месяца = 1 точка).
//
// Ничего не пересчитывает: только отображает уже сохранённые значения.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  loadReportHistoryFromCloud,
  type CloudReportHistory,
} from "../lib/supabase-cloud";

interface Props {
  user: User | null;
  /** Меняется после сохранения расчёта → триггерит перезагрузку истории. */
  refreshKey: number;
}

/** Точка ряда — один месяц. */
interface MonthPoint {
  month: string; // 'YYYY-MM'
  label: string; // 'апр 26'
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
}

const RU_SHORT = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];
const RU_FULL = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function formatRub(n: number): string {
  return (
    n.toLocaleString("ru-RU", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }) + " ₽"
  );
}
function formatSignedRub(n: number): string {
  return (n < 0 ? "−" : "") + formatRub(Math.abs(n));
}

/** Компактный формат для подписей на барах: 19 295 → «19,3к», 1 250 000 → «1,25М». */
function formatCompact(n: number): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return sign + (abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(".", ",") + "М";
  }
  if (abs >= 1_000) {
    return sign + (abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(".", ",") + "к";
  }
  return sign + String(Math.round(abs));
}

/** 'YYYY-MM' → 'апр 26' */
function monthShort(ym: string): string {
  const [y, m] = ym.split("-");
  const mi = Number(m) - 1;
  return `${RU_SHORT[mi] ?? m} ${(y ?? "").slice(2)}`;
}
/** 'YYYY-MM' → 'Апрель 2026' */
function monthFull(ym: string): string {
  const [y, m] = ym.split("-");
  const mi = Number(m) - 1;
  return `${RU_FULL[mi] ?? m} ${y}`;
}

export function MonthlyAnalytics({ user, refreshKey }: Props) {
  const [rows, setRows] = useState<CloudReportHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setRows([]);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    loadReportHistoryFromCloud(user.id).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
        setRows([]);
      } else {
        setRows(data ?? []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, refreshKey]);

  // Группировка по месяцу: rows отсортированы по created_at asc → последняя
  // запись за месяц «выигрывает» (актуальные значения за повторно загруженный
  // отчёт). Берём последние 12 месяцев для читаемости графиков.
  const series = useMemo<MonthPoint[]>(() => {
    const byMonth = new Map<string, CloudReportHistory>();
    for (const r of rows) {
      const key = (r.report_month ?? "").slice(0, 7);
      if (!key) continue;
      byMonth.set(key, r);
    }
    return Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(-12)
      .map(([key, r]) => ({
        month: key,
        label: monthShort(key),
        revenue: Number(r.revenue) || 0,
        expenses: Number(r.expenses) || 0,
        profit: Number(r.profit) || 0,
        margin: Number(r.margin) || 0,
      }));
  }, [rows]);

  const current = series.length ? series[series.length - 1] : null;

  // Рендер столбчатого графика (чистый CSS). Поддерживает отрицательные значения
  // (прибыль): положительная зона сверху, отрицательная снизу от нулевой линии.
  // Объявлена внутри компонента → styled-jsx корректно скоупит классы.
  const renderChart = (
    points: { label: string; value: number }[],
    variant: "profit" | "revenue"
  ) => {
    const posMax = Math.max(0, ...points.map((p) => p.value));
    const negMax = Math.max(0, ...points.map((p) => -p.value));
    const total = posMax + negMax || 1;
    const posPct = (posMax / total) * 100;
    const negPct = (negMax / total) * 100;
    return (
      <div className="ma-chart">
        <div className="ma-plot">
          {points.map((p, i) => {
            const pos = p.value >= 0;
            const h = pos
              ? posMax > 0
                ? (p.value / posMax) * 100
                : 0
              : negMax > 0
              ? (-p.value / negMax) * 100
              : 0;
            const barClass =
              variant === "revenue" ? "ma-bar-rev" : pos ? "ma-bar-pos" : "ma-bar-neg";
            return (
              <div className="ma-col" key={p.label + i} title={`${p.label}: ${formatSignedRub(p.value)}`}>
                <div className="ma-zone ma-zone-pos" style={{ flexBasis: `${posPct}%` }}>
                  {pos && p.value !== 0 && (
                    <div className={"ma-bar " + barClass} style={{ height: `${Math.max(h, 2)}%` }}>
                      <span className="ma-val">{formatCompact(p.value)}</span>
                    </div>
                  )}
                </div>
                <div className="ma-zone ma-zone-neg" style={{ flexBasis: `${negPct}%` }}>
                  {!pos && (
                    <div className="ma-bar ma-bar-neg" style={{ height: `${Math.max(h, 2)}%` }}>
                      <span className="ma-val ma-val-neg">{formatCompact(p.value)}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ma-axis">
          {points.map((p, i) => (
            <span className="ma-axis-l" key={p.label + i}>
              {p.label}
            </span>
          ))}
        </div>
      </div>
    );
  };

  if (!user) return null;

  return (
    <>
      <section className="ma">
        <div className="ma-head">
          <div>
            <h2 className="ma-title">Аналитика по месяцам</h2>
            {current && (
              <p className="ma-sub">
                Текущий месяц — <b>{monthFull(current.month)}</b>
              </p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="ma-state">
            <span className="ma-spinner" aria-hidden="true" />
            <span>Загружаем историю расчётов…</span>
          </div>
        ) : loadError ? (
          <div className="ma-state ma-state-err">
            Не удалось загрузить историю: {loadError}
          </div>
        ) : series.length === 0 ? (
          <div className="ma-note">
            Для отображения динамики нужны расчёты минимум за 2 разных месяца.
          </div>
        ) : (
          <>
            {/* Карточки текущего месяца */}
            <div className="ma-cards">
              <div className="ma-card">
                <span className="ma-card-l">Выручка</span>
                <span className="ma-card-v">{formatRub(current!.revenue)}</span>
              </div>
              <div className="ma-card">
                <span className="ma-card-l">Прибыль</span>
                <span className={"ma-card-v " + (current!.profit >= 0 ? "pos" : "neg")}>
                  {formatSignedRub(current!.profit)}
                </span>
              </div>
              <div className="ma-card">
                <span className="ma-card-l">Маржа</span>
                <span className={"ma-card-v " + (current!.margin >= 0 ? "pos" : "neg")}>
                  {current!.margin.toFixed(1)}%
                </span>
              </div>
            </div>

            {series.length < 2 ? (
              <div className="ma-note">
                {rows.length >= 2
                  ? "У вас есть несколько расчётов за один месяц. Для графика динамики нужен ещё один расчёт за другой месяц."
                  : "Для отображения динамики нужны расчёты минимум за 2 разных месяца."}
              </div>
            ) : (
              <>
                <div className="ma-section">
                  <h3 className="ma-h3">Прибыль по месяцам</h3>
                  {renderChart(
                    series.map((s) => ({ label: s.label, value: s.profit })),
                    "profit"
                  )}
                </div>
                <div className="ma-section">
                  <h3 className="ma-h3">Выручка по месяцам</h3>
                  {renderChart(
                    series.map((s) => ({ label: s.label, value: s.revenue })),
                    "revenue"
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <style jsx>{`
        .ma {
          background: var(--glass);
          border: 1px solid var(--edge);
          border-radius: 16px;
          padding: 1.4rem 1.5rem 1.6rem;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
          margin-top: 1.1rem;
        }
        .ma-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .ma-title {
          font-family: var(--display);
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--txt);
          letter-spacing: -0.01em;
        }
        .ma-sub {
          font-size: 0.85rem;
          color: var(--txt2);
          margin-top: 0.25rem;
          font-weight: 300;
        }
        .ma-sub b {
          color: var(--gold2);
          font-weight: 600;
        }
        .ma-note {
          margin-top: 1.1rem;
          padding: 0.95rem 1.1rem;
          border: 1px solid var(--edge2);
          border-radius: 12px;
          background: var(--gold-bg);
          color: var(--txt2);
          font-size: 0.88rem;
          line-height: 1.5;
        }

        .pos {
          color: var(--green);
        }
        .neg {
          color: var(--red);
        }

        /* ── Карточки текущего месяца ── */
        .ma-cards {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.7rem;
          margin-top: 1.2rem;
        }
        .ma-card {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 1rem 1.1rem;
          border: 1px solid var(--edge);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.02);
          min-width: 0;
        }
        .ma-card-l {
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .ma-card-v {
          font-family: var(--mono);
          font-size: 1.15rem;
          font-weight: 500;
          color: var(--txt);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ── Секции с графиками ── */
        .ma-section {
          margin-top: 1.5rem;
        }
        .ma-h3 {
          font-family: var(--sans);
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--txt);
          margin-bottom: 0.9rem;
        }
        .ma-chart {
          border: 1px solid var(--edge);
          border-radius: 13px;
          padding: 1.4rem 1.1rem 0.9rem;
          background: rgba(255, 255, 255, 0.014);
        }
        .ma-plot {
          display: flex;
          align-items: stretch;
          gap: 0.5rem;
          height: 170px;
          overflow: visible;
        }
        .ma-col {
          flex: 1 1 0;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .ma-zone {
          display: flex;
          justify-content: center;
          min-width: 0;
        }
        .ma-zone-pos {
          align-items: flex-end;
          border-bottom: 1px dashed var(--edge2);
        }
        .ma-zone-neg {
          align-items: flex-start;
        }
        .ma-bar {
          position: relative;
          width: 62%;
          max-width: 48px;
          min-height: 3px;
          border-radius: 6px 6px 0 0;
          transition: filter 0.16s ease;
        }
        .ma-bar-neg {
          border-radius: 0 0 6px 6px;
        }
        .ma-bar-pos {
          background: linear-gradient(180deg, var(--green), rgba(46, 204, 138, 0.55));
        }
        .ma-bar-rev {
          background: linear-gradient(180deg, var(--gold2), rgba(201, 168, 76, 0.5));
        }
        .ma-bar-neg {
          background: linear-gradient(0deg, var(--red), rgba(224, 85, 102, 0.55));
        }
        .ma-col:hover .ma-bar {
          filter: brightness(1.15);
        }
        .ma-val {
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%);
          margin-bottom: 3px;
          font-family: var(--mono);
          font-size: 0.58rem;
          font-weight: 500;
          color: var(--txt2);
          white-space: nowrap;
          pointer-events: none;
        }
        .ma-val-neg {
          bottom: auto;
          top: 100%;
          margin-bottom: 0;
          margin-top: 3px;
          color: var(--red);
        }
        .ma-axis {
          display: flex;
          gap: 0.5rem;
          margin-top: 0.85rem;
        }
        .ma-axis-l {
          flex: 1 1 0;
          text-align: center;
          font-family: var(--mono);
          font-size: 0.66rem;
          color: var(--txt3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ── Состояния загрузки/ошибки ── */
        .ma-state {
          display: flex;
          align-items: center;
          gap: 10px;
          justify-content: center;
          padding: 2rem 1rem;
          color: var(--txt2);
          font-size: 0.9rem;
        }
        .ma-state-err {
          color: var(--red);
        }
        .ma-spinner {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid var(--edge2);
          border-top-color: var(--gold);
          animation: maSpin 0.7s linear infinite;
        }
        @keyframes maSpin {
          to {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 720px) {
          .ma {
            padding: 1.2rem 1.1rem 1.3rem;
          }
          .ma-cards {
            grid-template-columns: 1fr;
          }
          .ma-card-v {
            font-size: 1.05rem;
          }
          .ma-plot {
            height: 150px;
            gap: 0.3rem;
          }
          .ma-bar {
            width: 72%;
          }
          .ma-axis {
            gap: 0.3rem;
          }
          .ma-axis-l {
            font-size: 0.58rem;
          }
          .ma-val {
            font-size: 0.52rem;
          }
        }
      `}</style>
    </>
  );
}
