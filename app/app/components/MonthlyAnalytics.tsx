"use client";

// ============================================================================
// MonthlyAnalytics — блок «Динамика прибыли» в кабинете (раньше «Аналитика по
// месяцам»).
//
// Источник данных: report_history (Supabase). Каждый сохранённый расчёт чистой
// прибыли пишет туда снимок: revenue / expenses (всего) / profit / margin +
// report_month. Здесь мы ТОЛЬКО отображаем уже сохранённые значения — ничего
// не пересчитываем (формулы, парсеры, schema не затрагиваются).
//
// Что показываем:
//   • Верхний понятный итог: вырос/упал/недостаточно данных + главный вывод.
//   • Карточки текущего месяца с изменением к прошлому (₽/%, стрелка, цвет).
//   • Графики динамики (выручка + чистая прибыль) — чистый CSS, без библиотек.
//   • Человеческие выводы простым языком (только по реальным данным).
//
// Защита от битых данных: report_month без валидного 'YYYY-MM' пропускается
// (без NaN/undefined в UI); такие записи считаются и логируются одним warning.
//
// Примечание по данным: в report_history себестоимость и комиссии/УПД отдельно
// НЕ хранятся (только суммарные expenses). Поэтому отдельных карточек
// «Себестоимость» / «Комиссии Ozon» здесь нет — данные не выдумываем.
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

type Dir = "up" | "down" | "flat";
interface Delta {
  abs: number;
  pct: number | null; // null, когда базовое значение 0 (процент не определён)
  dir: Dir;
}

const RU_SHORT = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];
const RU_FULL = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
// Предложный падеж — «в июне чистая прибыль…»
const RU_PREP = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];
// Творительный падеж — «по сравнению с маем»
const RU_INSTR = [
  "январём", "февралём", "мартом", "апрелем", "маем", "июнем",
  "июлем", "августом", "сентябрём", "октябрём", "ноябрём", "декабрём",
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
/** Дельта в рублях со знаком: +1 234 ₽ / −1 234 ₽. */
function formatDeltaRub(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + formatRub(Math.abs(n));
}
/** Процент со знаком, без дробей: +18% / −5%. */
function formatPct(p: number): string {
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return sign + Math.abs(p).toFixed(0) + "%";
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

/** Безопасный разбор 'YYYY-MM[-DD]' → {y, m(1..12)}; иначе null. */
function parseYM(ym: string): { y: number; m: number } | null {
  const mt = /^(\d{4})-(\d{2})/.exec(ym ?? "");
  if (!mt) return null;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { y, m };
}
/** 'YYYY-MM' → 'апр 26' (или '—' при битых данных). */
function monthShort(ym: string): string {
  const p = parseYM(ym);
  if (!p) return "—";
  return `${RU_SHORT[p.m - 1]} ${String(p.y).slice(2)}`;
}
/** 'YYYY-MM' → 'Апрель 2026' (или '—' при битых данных). */
function monthFull(ym: string): string {
  const p = parseYM(ym);
  if (!p) return "—";
  return `${RU_FULL[p.m - 1]} ${p.y}`;
}
/** Предложный падеж: 'в июне' (+ год, если нужно различить годы). */
function monthPrep(ym: string, withYear: boolean): string {
  const p = parseYM(ym);
  if (!p) return "этом месяце";
  return RU_PREP[p.m - 1] + (withYear ? ` ${p.y}` : "");
}
/** Творительный падеж: 'маем' (+ год при необходимости). */
function monthInstr(ym: string, withYear: boolean): string {
  const p = parseYM(ym);
  if (!p) return "прошлым месяцем";
  return RU_INSTR[p.m - 1] + (withYear ? ` ${p.y}` : "");
}

/** Дельта по денежному/процентному показателю. */
function moneyDelta(curr: number, prev: number): Delta {
  const abs = curr - prev;
  const pct = prev !== 0 ? (abs / Math.abs(prev)) * 100 : null;
  let dir: Dir;
  if (pct !== null) dir = Math.abs(pct) < 1 ? "flat" : pct > 0 ? "up" : "down";
  else dir = Math.abs(abs) < 0.005 ? "flat" : abs > 0 ? "up" : "down";
  return { abs, pct, dir };
}
/** Дельта маржи в процентных пунктах (нейтрально, если |Δ| < 0,3 п.п.). */
function ppDelta(curr: number, prev: number): Delta {
  const abs = curr - prev;
  const dir: Dir = Math.abs(abs) < 0.3 ? "flat" : abs > 0 ? "up" : "down";
  return { abs, pct: null, dir };
}

/** Главный вывод по месяцу (только из реальных полей history). */
function buildVerdict(curr: MonthPoint, prev: MonthPoint): string {
  const sameYear = curr.month.slice(0, 4) === prev.month.slice(0, 4);
  const withYear = !sameYear;
  const inMonth = monthPrep(curr.month, withYear);
  const vsMonth = monthInstr(prev.month, withYear);
  const d = moneyDelta(curr.profit, prev.profit);
  const pctTxt = d.pct !== null ? ` (${formatPct(d.pct)})` : "";

  let head: string;
  if (d.dir === "up") {
    head = `В ${inMonth} чистая прибыль выросла на ${formatRub(Math.abs(d.abs))}${pctTxt} по сравнению с ${vsMonth}.`;
  } else if (d.dir === "down") {
    head = `В ${inMonth} чистая прибыль снизилась на ${formatRub(Math.abs(d.abs))}${pctTxt} по сравнению с ${vsMonth}.`;
  } else {
    head = `В ${inMonth} чистая прибыль почти не изменилась по сравнению с ${vsMonth}.`;
  }

  // «Основной фактор» — строго по доступным сигналам (выручка/расходы/маржа).
  const rev = moneyDelta(curr.revenue, prev.revenue);
  const exp = moneyDelta(curr.expenses, prev.expenses);
  const mar = ppDelta(curr.margin, prev.margin);
  let driver = "";
  if (rev.dir === "up" && mar.dir === "up") driver = "рост выручки и улучшение маржинальности";
  else if (rev.dir === "up" && mar.dir === "down") driver = "рост выручки, но снижение маржи";
  else if (rev.dir === "up" && mar.dir === "flat") driver = "рост выручки при стабильной марже";
  else if (rev.dir === "down" && exp.dir === "down") driver = "снижение расходов на фоне меньшей выручки";
  else if (rev.dir === "down" && mar.dir === "up") driver = "более высокая маржинальность";
  else if (rev.dir === "flat" && exp.dir === "down") driver = "снижение расходов";
  else if (rev.dir === "flat" && exp.dir === "up") driver = "рост расходов";
  else if (rev.dir === "down") driver = "снижение выручки";

  return driver ? `${head} Основной фактор — ${driver}.` : head;
}

/** 2–4 коротких человеческих вывода. Только по реальным данным; пусто не бывает. */
function buildInsights(
  curr: MonthPoint,
  prev: MonthPoint
): { tone: "good" | "warn" | "info"; text: string }[] {
  const out: { tone: "good" | "warn" | "info"; text: string }[] = [];
  const rev = moneyDelta(curr.revenue, prev.revenue);
  const prof = moneyDelta(curr.profit, prev.profit);
  const exp = moneyDelta(curr.expenses, prev.expenses);
  const marD = curr.margin - prev.margin;
  const revPct = rev.pct;
  const profPct = prof.pct;
  const expPct = exp.pct;
  const expShare = curr.revenue > 0 ? (curr.expenses / curr.revenue) * 100 : null;

  if (curr.profit < 0) {
    out.push({
      tone: "warn",
      text: "В этом месяце чистая прибыль отрицательная — расходы превышают выручку. Сократите издержки или поднимите цены.",
    });
  }
  if (revPct !== null && revPct > 1 && marD < -0.3) {
    out.push({
      tone: "warn",
      text: "Выручка выросла, но маржинальность снизилась — проверьте себестоимость и комиссии Ozon.",
    });
  }
  if (
    prev.profit > 0 &&
    prev.revenue > 0 &&
    profPct !== null &&
    revPct !== null &&
    revPct > 0 &&
    profPct > revPct + 2
  ) {
    out.push({
      tone: "good",
      text: "Прибыль растёт быстрее выручки — структура расходов стала лучше.",
    });
  }
  if (revPct !== null && revPct < -1 && profPct !== null && profPct > 1) {
    out.push({
      tone: "good",
      text: "Выручка снизилась, но прибыль выросла — вы лучше контролируете расходы.",
    });
  }
  if (expShare !== null && expShare > 75) {
    out.push({
      tone: "warn",
      text: `Расходы съедают ${expShare.toFixed(0)}% выручки — проверьте закупочные цены, логистику и комиссии.`,
    });
  }
  if (expPct !== null && revPct !== null && expPct > revPct + 3 && marD < -0.3) {
    out.push({
      tone: "warn",
      text: "Расходы выросли быстрее выручки — стоит проверить расходы Ozon/УПД за месяц.",
    });
  }
  if (marD > 0.5) {
    out.push({
      tone: "good",
      text: `Маржинальность выросла на ${marD.toFixed(1).replace(".", ",")} п.п. — бизнес стал эффективнее.`,
    });
  }

  const capped = out.slice(0, 4);
  if (capped.length === 0) {
    capped.push({
      tone: "info",
      text: "Показатели держатся примерно на уровне прошлого месяца.",
    });
  }
  return capped;
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
  // запись за месяц «выигрывает». Берём последние 12 месяцев. Записи без
  // валидного 'YYYY-MM' пропускаем (защита от битого report_month).
  const series = useMemo<MonthPoint[]>(() => {
    const byMonth = new Map<string, CloudReportHistory>();
    let skipped = 0;
    for (const r of rows) {
      const key = (r.report_month ?? "").slice(0, 7);
      if (!parseYM(key)) {
        skipped += 1;
        continue;
      }
      byMonth.set(key, r);
    }
    if (skipped > 0) {
      console.warn(
        `[Динамика прибыли] пропущено записей без распознанного месяца: ${skipped}`
      );
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
  const previous = series.length >= 2 ? series[series.length - 2] : null;
  const multi = !!current && !!previous;

  // Чип изменения к прошлому месяцу (стрелка + значение + %, цвет по «хорошо»).
  const renderDelta = (
    d: Delta,
    text: string,
    goodWhen: Dir = "up"
  ) => {
    const tone = d.dir === "flat" ? "flat" : d.dir === goodWhen ? "good" : "bad";
    const arrow = d.dir === "up" ? "↑" : d.dir === "down" ? "↓" : "≈";
    return (
      <span className={"ma-delta " + tone}>
        <i aria-hidden="true">{arrow}</i>
        {d.dir === "flat" ? "без изменений" : text}
      </span>
    );
  };

  // Столбчатый график (чистый CSS) с поддержкой отрицательных значений и
  // подсветкой текущего (последнего) месяца.
  const renderChart = (
    points: { label: string; value: number }[],
    variant: "profit" | "revenue"
  ) => {
    const posMax = Math.max(0, ...points.map((p) => p.value));
    const negMax = Math.max(0, ...points.map((p) => -p.value));
    const total = posMax + negMax || 1;
    const posPct = (posMax / total) * 100;
    const negPct = (negMax / total) * 100;
    const lastIdx = points.length - 1;
    return (
      <div className="ma-chart">
        <div className="ma-plot">
          {points.map((p, i) => {
            const pos = p.value >= 0;
            const isCurrent = i === lastIdx;
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
              <div
                className={"ma-col" + (isCurrent ? " is-current" : "")}
                key={p.label + i}
                title={`${p.label}: ${formatSignedRub(p.value)}`}
              >
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
            <span
              className={"ma-axis-l" + (i === lastIdx ? " is-current" : "")}
              key={p.label + i}
            >
              {p.label}
            </span>
          ))}
        </div>
      </div>
    );
  };

  if (!user) return null;

  const verdictTone = multi
    ? moneyDelta(current!.profit, previous!.profit).dir
    : "flat";

  return (
    <>
      <section className="ma">
        <div className="ma-head">
          <div>
            <h2 className="ma-title">Динамика прибыли</h2>
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
            Загрузите отчёт и посчитайте чистую прибыль — здесь появится динамика
            прибыли, выручки и расходов по месяцам.
          </div>
        ) : (
          <>
            {/* ── Верхний понятный итог ── */}
            <div
              className={
                "ma-hero " +
                (verdictTone === "up"
                  ? "good"
                  : verdictTone === "down"
                  ? "bad"
                  : "neutral")
              }
            >
              <span className="ma-hero-ic" aria-hidden="true">
                {multi
                  ? verdictTone === "up"
                    ? "↑"
                    : verdictTone === "down"
                    ? "↓"
                    : "≈"
                  : "•"}
              </span>
              <div className="ma-hero-body">
                {multi ? (
                  <p className="ma-hero-text">{buildVerdict(current!, previous!)}</p>
                ) : (
                  <p className="ma-hero-text">
                    Пока недостаточно данных для динамики — нужен ещё один месяц.
                  </p>
                )}
                <div className="ma-hero-pills">
                  <span className="ma-pill">
                    Текущий: <b>{monthFull(current!.month)}</b>
                  </span>
                  {multi && (
                    <span className="ma-pill ma-pill-prev">
                      Прошлый: <b>{monthFull(previous!.month)}</b>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Карточки текущего месяца ── */}
            <div className="ma-cards">
              <div className="ma-card">
                <span className="ma-card-l">Чистая прибыль</span>
                <span className={"ma-card-v " + (current!.profit >= 0 ? "pos" : "neg")}>
                  {formatSignedRub(current!.profit)}
                </span>
                {multi &&
                  renderDelta(
                    moneyDelta(current!.profit, previous!.profit),
                    `${formatDeltaRub(current!.profit - previous!.profit)}${
                      moneyDelta(current!.profit, previous!.profit).pct !== null
                        ? " · " +
                          formatPct(moneyDelta(current!.profit, previous!.profit).pct as number)
                        : ""
                    }`,
                    "up"
                  )}
              </div>

              <div className="ma-card">
                <span className="ma-card-l">Выручка</span>
                <span className="ma-card-v">{formatRub(current!.revenue)}</span>
                {multi &&
                  renderDelta(
                    moneyDelta(current!.revenue, previous!.revenue),
                    `${formatDeltaRub(current!.revenue - previous!.revenue)}${
                      moneyDelta(current!.revenue, previous!.revenue).pct !== null
                        ? " · " +
                          formatPct(moneyDelta(current!.revenue, previous!.revenue).pct as number)
                        : ""
                    }`,
                    "up"
                  )}
              </div>

              <div className="ma-card">
                <span className="ma-card-l">Маржинальность</span>
                <span className={"ma-card-v " + (current!.margin >= 0 ? "pos" : "neg")}>
                  {current!.margin.toFixed(1).replace(".", ",")}%
                </span>
                {multi &&
                  renderDelta(
                    ppDelta(current!.margin, previous!.margin),
                    `${current!.margin - previous!.margin > 0 ? "+" : "−"}${Math.abs(
                      current!.margin - previous!.margin
                    )
                      .toFixed(1)
                      .replace(".", ",")} п.п.`,
                    "up"
                  )}
              </div>

              <div className="ma-card">
                <span className="ma-card-l">Расходы (всего)</span>
                <span className="ma-card-v">{formatRub(current!.expenses)}</span>
                {multi &&
                  renderDelta(
                    moneyDelta(current!.expenses, previous!.expenses),
                    `${formatDeltaRub(current!.expenses - previous!.expenses)}${
                      moneyDelta(current!.expenses, previous!.expenses).pct !== null
                        ? " · " +
                          formatPct(moneyDelta(current!.expenses, previous!.expenses).pct as number)
                        : ""
                    }`,
                    "down"
                  )}
              </div>
            </div>

            {!multi ? (
              <div className="ma-note">
                {rows.length >= 2
                  ? "У вас несколько расчётов за один месяц. Чтобы M-PROF показал динамику прибыли, выручки и расходов, загрузите ещё один отчёт за другой месяц."
                  : "Пока загружен только один месяц. Загрузите ещё один отчёт, чтобы M-PROF показал динамику прибыли, выручки и расходов."}
              </div>
            ) : (
              <>
                {/* ── Графики динамики ── */}
                <div className="ma-charts">
                  <div className="ma-chart-card">
                    <h3 className="ma-h3">Чистая прибыль по месяцам</h3>
                    {renderChart(
                      series.map((s) => ({ label: s.label, value: s.profit })),
                      "profit"
                    )}
                  </div>
                  <div className="ma-chart-card">
                    <h3 className="ma-h3">Выручка по месяцам</h3>
                    {renderChart(
                      series.map((s) => ({ label: s.label, value: s.revenue })),
                      "revenue"
                    )}
                  </div>
                </div>

                {/* ── Человеческие выводы ── */}
                <div className="ma-insights">
                  <h3 className="ma-h3">Выводы</h3>
                  <ul className="ma-ins-list">
                    {buildInsights(current!, previous!).map((ins, i) => (
                      <li className={"ma-ins " + ins.tone} key={i}>
                        <span className="ma-ins-dot" aria-hidden="true" />
                        <span>{ins.text}</span>
                      </li>
                    ))}
                  </ul>
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

        /* ── Верхний итог (hero) ── */
        .ma-hero {
          display: flex;
          gap: 0.85rem;
          align-items: flex-start;
          margin-top: 1.2rem;
          padding: 1rem 1.15rem;
          border: 1px solid var(--edge2);
          border-radius: 14px;
          border-left-width: 3px;
          background: rgba(255, 255, 255, 0.022);
        }
        .ma-hero.good {
          border-left-color: var(--green);
          background: linear-gradient(
            90deg,
            rgba(46, 204, 138, 0.08),
            rgba(255, 255, 255, 0.014)
          );
        }
        .ma-hero.bad {
          border-left-color: var(--red);
          background: linear-gradient(
            90deg,
            rgba(224, 85, 102, 0.08),
            rgba(255, 255, 255, 0.014)
          );
        }
        .ma-hero.neutral {
          border-left-color: var(--gold);
          background: var(--gold-bg);
        }
        .ma-hero-ic {
          flex: 0 0 auto;
          width: 30px;
          height: 30px;
          border-radius: 9px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 1rem;
          font-weight: 700;
          font-family: var(--mono);
          color: var(--txt);
          background: rgba(255, 255, 255, 0.05);
        }
        .ma-hero.good .ma-hero-ic {
          color: var(--green);
          background: rgba(46, 204, 138, 0.14);
        }
        .ma-hero.bad .ma-hero-ic {
          color: var(--red);
          background: rgba(224, 85, 102, 0.14);
        }
        .ma-hero.neutral .ma-hero-ic {
          color: var(--gold2);
          background: rgba(201, 168, 76, 0.14);
        }
        .ma-hero-body {
          min-width: 0;
        }
        .ma-hero-text {
          font-size: 0.95rem;
          line-height: 1.5;
          color: var(--txt);
          font-weight: 400;
        }
        .ma-hero-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 0.45rem;
          margin-top: 0.7rem;
        }
        .ma-pill {
          font-family: var(--mono);
          font-size: 0.68rem;
          letter-spacing: 0.02em;
          color: var(--txt2);
          padding: 0.22rem 0.55rem;
          border: 1px solid var(--edge2);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.02);
        }
        .ma-pill b {
          color: var(--gold2);
          font-weight: 600;
        }
        .ma-pill-prev b {
          color: var(--txt);
        }

        /* ── Карточки текущего месяца ── */
        .ma-cards {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.7rem;
          margin-top: 1rem;
        }
        .ma-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 0.95rem 1.05rem;
          border: 1px solid var(--edge);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.02);
          min-width: 0;
        }
        .ma-card-l {
          font-size: 0.68rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .ma-card-v {
          font-family: var(--mono);
          font-size: 1.12rem;
          font-weight: 500;
          color: var(--txt);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ma-delta {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: var(--mono);
          font-size: 0.68rem;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ma-delta i {
          font-style: normal;
          font-size: 0.78rem;
          line-height: 1;
        }
        .ma-delta.good {
          color: var(--green);
        }
        .ma-delta.bad {
          color: var(--red);
        }
        .ma-delta.flat {
          color: var(--txt3);
        }

        /* ── Графики ── */
        .ma-charts {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.9rem;
          margin-top: 1.5rem;
        }
        .ma-chart-card {
          min-width: 0;
        }
        .ma-h3 {
          font-family: var(--sans);
          font-size: 0.92rem;
          font-weight: 700;
          color: var(--txt);
          margin-bottom: 0.8rem;
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
          height: 160px;
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
          max-width: 46px;
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
        /* подсветка текущего (последнего) месяца */
        .ma-col.is-current .ma-bar {
          box-shadow: 0 0 0 1.5px var(--gold2), 0 0 14px rgba(201, 168, 76, 0.35);
          filter: brightness(1.08);
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
        .ma-axis-l.is-current {
          color: var(--gold2);
          font-weight: 600;
        }

        /* ── Выводы ── */
        .ma-insights {
          margin-top: 1.5rem;
        }
        .ma-ins-list {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .ma-ins {
          display: flex;
          gap: 0.6rem;
          align-items: flex-start;
          padding: 0.75rem 0.95rem;
          border: 1px solid var(--edge2);
          border-left-width: 3px;
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.018);
          font-size: 0.875rem;
          line-height: 1.45;
          color: var(--txt);
        }
        .ma-ins-dot {
          flex: 0 0 auto;
          width: 7px;
          height: 7px;
          margin-top: 0.42rem;
          border-radius: 50%;
        }
        .ma-ins.good {
          border-left-color: var(--green);
        }
        .ma-ins.good .ma-ins-dot {
          background: var(--green);
        }
        .ma-ins.warn {
          border-left-color: var(--red);
        }
        .ma-ins.warn .ma-ins-dot {
          background: var(--red);
        }
        .ma-ins.info {
          border-left-color: var(--gold);
        }
        .ma-ins.info .ma-ins-dot {
          background: var(--gold2);
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

        @media (max-width: 900px) {
          .ma-cards {
            grid-template-columns: repeat(2, 1fr);
          }
          .ma-charts {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 560px) {
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
