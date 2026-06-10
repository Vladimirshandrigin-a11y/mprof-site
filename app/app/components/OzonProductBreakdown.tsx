"use client";

// ============================================================================
// OzonProductBreakdown — ЧИСТАЯ прибыль по товарам после загрузки отчёта Ozon.
//
// Логика:
//   1. Берём per-SKU строки из распарсенного отчёта (report.products).
//   2. Для каждого артикула ищем товар в каталоге пользователя (products.sku).
//   3. Общие расходы отчёта (estimate: комиссия, логистика, хранение, реклама,
//      налог, прочее) распределяем по товарам ПРОПОРЦИОНАЛЬНО выручке.
//   4. Найден + есть cost_price → считаем себестоимость и чистую прибыль.
//      Не найден / cost_price = 0 → блок «Товары без себестоимости».
//   5. Аналитика: самые прибыльные, товары в минус, товары без себестоимости.
//
// Формулы (на товар, агрегировано по артикулу):
//   доля в выручке   = выручка товара / выручка отчёта        (guard ÷0)
//   распред. расходы = (комиссия+логистика+хранение+реклама+налог+прочее) × доля
//   себестоимость    = cost_price × количество
//   чистая прибыль   = выручка − себестоимость − распред. расходы
//   чистая маржа, %  = выручка > 0 ? чистая прибыль / выручка × 100 : 0
//
// НЕ меняет общий расчёт отчёта — это отдельный производный слой поверх него.
// Стиль — тема M-PROF (глобальные CSS-переменные --gold/--txt/--green/…).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { loadProductsFromCloud, type Product } from "../lib/supabase-cloud";
import type {
  OzonProductRow,
  OzonEstimate,
} from "../lib/report-parsers/ozon-parser";

interface Props {
  products: OzonProductRow[];
  /** Тоталы отчёта (estimate) — источник общих расходов для распределения. */
  estimate: OzonEstimate | null;
  user: User | null;
}

/** Строка результата по одному артикулу (агрегирована по отчёту). */
interface BreakdownRow {
  article: string;
  name: string;
  revenue: number;
  quantity: number;
  /** Найден ли товар в каталоге. */
  matched: boolean;
  /** Себестоимость за единицу (из каталога). null — товар не найден. */
  unitCost: number | null;
  /** Себестоимость продаж = unitCost × quantity. null — нет себестоимости. */
  cogs: number | null;
  /** Чистая прибыль = revenue − cogs − распред. расходы. null — нет cost. */
  profit: number | null;
  /** Чистая маржа, %. null — нет себестоимости. */
  margin: number | null;
  /** Есть пригодная (>0) себестоимость — иначе чистую прибыль не считаем. */
  hasCost: boolean;
}

function formatRub(n: number): string {
  return (
    n.toLocaleString("ru-RU", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }) + " ₽"
  );
}

function formatSignedRub(n: number): string {
  const sign = n < 0 ? "−" : "";
  return sign + formatRub(Math.abs(n));
}

function pluralProducts(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "товар";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "товара";
  return "товаров";
}

/** Нормализация артикула/sku для матчинга: trim + lower + схлопывание пробелов. */
function normArticle(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function OzonProductBreakdown({ products, estimate, user }: Props) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingAnalytics, setExportingAnalytics] = useState(false);

  // Загружаем каталог при появлении товаров в отчёте / смене пользователя.
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setCatalog([]);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    loadProductsFromCloud(user.id).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setLoadError(error.message);
        setCatalog([]);
      } else {
        setCatalog(data ?? []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user, products]);

  // ===== Матчинг + расчёт чистой прибыли по SKU =====
  // Общие расходы отчёта (комиссия, логистика, хранение, реклама, налог,
  // прочее) берём из estimate и распределяем по товарам ПРОПОРЦИОНАЛЬНО
  // выручке. Себестоимость в этот пул НЕ входит — она считается отдельно по
  // каждому товару из каталога (cost_price × quantity).
  const rows = useMemo<BreakdownRow[]>(() => {
    // Индекс каталога по нормализованному sku.
    const bySku = new Map<string, Product>();
    for (const p of catalog) {
      const key = normArticle(p.sku);
      if (key && !bySku.has(key)) bySku.set(key, p);
    }

    // Тоталы отчёта для распределения расходов. estimate может быть null —
    // тогда расходы 0, и чистая прибыль вырождается в выручка − себестоимость.
    const totalRevenue = estimate?.revenue ?? 0;
    const totalExpenses =
      (estimate?.commission ?? 0) +
      (estimate?.logistics ?? 0) +
      (estimate?.storage ?? 0) +
      (estimate?.ads ?? 0) +
      (estimate?.tax ?? 0) +
      (estimate?.other ?? 0);

    // Агрегируем строки отчёта по артикулу (один товар может встречаться
    // несколькими строками — суммируем выручку и количество).
    const agg = new Map<
      string,
      { article: string; name: string; revenue: number; quantity: number }
    >();
    for (const pr of products) {
      const key = normArticle(pr.article);
      if (!key) continue;
      const ex = agg.get(key);
      if (ex) {
        ex.revenue += pr.revenue;
        ex.quantity += pr.quantity;
        if (!ex.name && pr.name) ex.name = pr.name;
      } else {
        agg.set(key, {
          article: pr.article.trim(),
          name: pr.name.trim(),
          revenue: pr.revenue,
          quantity: pr.quantity,
        });
      }
    }

    const out: BreakdownRow[] = [];
    for (const [key, a] of agg) {
      // Доля товара в общей выручке отчёта (guard против деления на ноль).
      const revenueShare = totalRevenue > 0 ? a.revenue / totalRevenue : 0;
      // Распределённые на товар общие расходы (без себестоимости).
      const allocated = totalExpenses * revenueShare;

      const match = bySku.get(key);
      const unitCost = match ? match.cost_price : null;
      const hasCost = unitCost !== null && unitCost > 0;

      if (match && hasCost) {
        const cogs = unitCost * a.quantity;
        // Чистая прибыль = выручка − себестоимость − распределённые расходы.
        const profit = a.revenue - cogs - allocated;
        const margin = a.revenue > 0 ? (profit / a.revenue) * 100 : 0;
        out.push({
          article: a.article,
          name: a.name || match.name || a.article,
          revenue: a.revenue,
          quantity: a.quantity,
          matched: true,
          unitCost,
          cogs,
          profit,
          margin,
          hasCost: true,
        });
      } else {
        // Нет пригодной себестоимости (товар не в каталоге ИЛИ cost_price = 0):
        // чистую прибыль не считаем — она была бы неточной. Товар уходит в
        // блок «Товары без себестоимости».
        out.push({
          article: a.article,
          name: (match ? a.name || match.name : a.name) || a.article,
          revenue: a.revenue,
          quantity: a.quantity,
          matched: !!match,
          unitCost,
          cogs: null,
          profit: null,
          margin: null,
          hasCost: false,
        });
      }
    }

    // По умолчанию — по выручке убыванию.
    out.sort((x, y) => y.revenue - x.revenue);
    return out;
  }, [products, catalog, estimate]);

  // ===== Аналитика товаров =====
  // Используем уже рассчитанные значения (revenue/profit/margin) — ничего не
  // пересчитываем. Берём только товары с себестоимостью, т.е. для которых
  // чистая прибыль реально посчитана (hasCost && profit !== null).
  const scored = useMemo(
    () => rows.filter((r) => r.hasCost && r.profit !== null),
    [rows]
  );
  // ТОП-10 прибыльных — по прибыли по убыванию.
  const topProfitable = useMemo(
    () => [...scored].sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0)).slice(0, 10),
    [scored]
  );
  // ТОП-10 убыточных — только отрицательная прибыль, по возрастанию.
  const topLosses = useMemo(
    () =>
      scored
        .filter((r) => (r.profit ?? 0) < 0)
        .sort((a, b) => (a.profit ?? 0) - (b.profit ?? 0))
        .slice(0, 10),
    [scored]
  );
  // Лучший товар месяца — максимум прибыли.
  const bestProduct = useMemo(
    () =>
      scored.length
        ? scored.reduce((best, r) => ((r.profit ?? 0) > (best.profit ?? 0) ? r : best))
        : null,
    [scored]
  );
  // Самый убыточный товар — минимум прибыли, но только если он отрицательный.
  const worstProduct = useMemo(() => {
    if (!scored.length) return null;
    const min = scored.reduce((w, r) => ((r.profit ?? 0) < (w.profit ?? 0) ? r : w));
    return (min.profit ?? 0) < 0 ? min : null;
  }, [scored]);

  // Блок «Товары без себестоимости»: товары без пригодной cost_price — нет в
  // каталоге ИЛИ cost_price = 0. Для них чистая прибыль не считается (была бы
  // неточной). Производная выборка из rows — общий расчёт не меняет.
  const missing = useMemo(
    () => rows.filter((r) => !r.hasCost),
    [rows]
  );

  // ===== Итоги =====
  const totals = useMemo(() => {
    let revenue = 0;
    let cogs = 0;
    let profit = 0;
    let withCost = 0;
    for (const r of rows) {
      revenue += r.revenue;
      if (r.hasCost) {
        cogs += r.cogs ?? 0;
        profit += r.profit ?? 0;
        withCost++;
      }
    }
    return {
      revenue,
      cogs,
      profit,
      withCost,
      total: rows.length,
      withoutCost: rows.length - withCost,
    };
  }, [rows]);

  // Выгрузка «Товары без себестоимости» в Excel: sku | name | revenue |
  // cost_price. Колонка cost_price идёт ПУСТОЙ — её заполняет пользователь и
  // загружает файл обратно в «Каталог товаров». Заголовок именно `cost_price`,
  // чтобы импорт каталога распознал его (регэксп /cost[\s_]*price/).
  async function handleExport() {
    if (missing.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = missing.map((r) => ({
        sku: r.article,
        name: r.name,
        revenue: r.revenue,
        cost_price: "", // пустая ячейка для ручного ввода себестоимости
      }));
      const ws = XLSX.utils.json_to_sheet(data, {
        header: ["sku", "name", "revenue", "cost_price"],
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Без себестоимости");
      XLSX.writeFile(wb, "tovary-bez-sebestoimosti.xlsx");
    } catch {
      // Выгрузка не критична: при сбое файл просто не скачается.
    } finally {
      setExporting(false);
    }
  }

  // Выгрузка аналитики: два листа — Top Profitable и Top Losses.
  // Колонки: sku | name | revenue | profit | margin (уже рассчитанные значения).
  async function handleAnalyticsExport() {
    if (exportingAnalytics) return;
    if (topProfitable.length === 0 && topLosses.length === 0) return;
    setExportingAnalytics(true);
    try {
      const XLSX = await import("xlsx");
      const header = ["sku", "name", "revenue", "net_profit", "net_margin"];
      const toRows = (list: BreakdownRow[]) =>
        list.map((r) => ({
          sku: r.article,
          name: r.name,
          revenue: r.revenue,
          net_profit: r.profit ?? 0,
          net_margin: r.margin !== null ? Number(r.margin.toFixed(2)) : 0,
        }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(toRows(topProfitable), { header }),
        "Top Profitable"
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(toRows(topLosses), { header }),
        "Top Losses"
      );
      XLSX.writeFile(wb, "analitika-tovarov.xlsx");
    } catch {
      // Выгрузка не критична: при сбое файл просто не скачается.
    } finally {
      setExportingAnalytics(false);
    }
  }

  if (rows.length === 0 && !loading) return null;

  return (
    <>
    <section className="pb">
      <div className="pb-head">
        <div>
          <h2 className="pb-title">Чистая прибыль по товарам</h2>
          <p className="pb-sub">
            {totals.total} {pluralProducts(totals.total)} в отчёте ·{" "}
            <b className="pb-sub-ok">{totals.withCost}</b> с себестоимостью
            {totals.withoutCost > 0 && (
              <>
                {" "}
                · <b className="pb-sub-warn">{totals.withoutCost}</b> без
                себестоимости
              </>
            )}
          </p>
        </div>
      </div>

      <div className="pb-note">
        Общие расходы распределяются по товарам пропорционально выручке. Это
        позволяет оценить чистую прибыль по каждому SKU.
      </div>

      {!user && (
        <div className="pb-note">
          Войдите и заполните «Каталог товаров» — система подставит себестоимость
          и посчитает прибыль по каждому артикулу.
        </div>
      )}

      {loading ? (
        <div className="pb-state">
          <span className="pb-spinner" aria-hidden="true" />
          <span>Сопоставляем товары с каталогом…</span>
        </div>
      ) : loadError ? (
        <div className="pb-state pb-state-err">
          Не удалось загрузить каталог: {loadError}
        </div>
      ) : (
        <>
          {/* Итоговые чипы */}
          <div className="pb-summary">
            <div className="pb-chip">
              <span className="pb-chip-l">Выручка</span>
              <span className="pb-chip-v">{formatRub(totals.revenue)}</span>
            </div>
            <div className="pb-chip">
              <span className="pb-chip-l">Себестоимость</span>
              <span className="pb-chip-v">{formatRub(totals.cogs)}</span>
            </div>
            <div className="pb-chip">
              <span className="pb-chip-l">Чистая прибыль</span>
              <span
                className={
                  "pb-chip-v " + (totals.profit >= 0 ? "pos" : "neg")
                }
              >
                {formatSignedRub(totals.profit)}
              </span>
            </div>
            <div className="pb-chip">
              <span className="pb-chip-l">С себестоимостью</span>
              <span className="pb-chip-v">
                {totals.withCost} / {totals.total}
              </span>
            </div>
          </div>

          {/* Таблица результатов */}
          <div
            className="pb-table"
            role="table"
            aria-label="Чистая прибыль по товарам"
          >
            <div className="pb-thead" role="row">
              <span role="columnheader">Артикул</span>
              <span role="columnheader">Товар</span>
              <span role="columnheader" className="pb-num">
                Выручка
              </span>
              <span role="columnheader" className="pb-num">
                Себестоимость
              </span>
              <span role="columnheader" className="pb-num">
                Чистая прибыль
              </span>
              <span role="columnheader" className="pb-num">
                Чистая маржа
              </span>
            </div>
            {rows.map((r, i) => (
              <div
                className={"pb-row" + (r.hasCost ? "" : " pb-row-nocost")}
                role="row"
                key={r.article + "#" + i}
              >
                <span className="pb-cell pb-c-art" role="cell" data-label="Артикул">
                  {r.article}
                </span>
                <span className="pb-cell pb-c-name" role="cell" data-label="Товар">
                  {r.name}
                  <i className="pb-qty">{r.quantity} шт</i>
                </span>
                <span className="pb-cell pb-num" role="cell" data-label="Выручка">
                  {formatRub(r.revenue)}
                </span>
                <span
                  className="pb-cell pb-num"
                  role="cell"
                  data-label="Себестоимость"
                >
                  {r.hasCost ? (
                    formatRub(r.cogs ?? 0)
                  ) : (
                    <span className="pb-nocost">Не указана</span>
                  )}
                </span>
                <span
                  className="pb-cell pb-num"
                  role="cell"
                  data-label="Чистая прибыль"
                >
                  {r.profit === null ? (
                    <span className="pb-dash">—</span>
                  ) : (
                    <span className={r.profit >= 0 ? "pos" : "neg"}>
                      {formatSignedRub(r.profit)}
                    </span>
                  )}
                </span>
                <span
                  className="pb-cell pb-num"
                  role="cell"
                  data-label="Чистая маржа"
                >
                  {r.margin === null ? (
                    <span className="pb-dash">—</span>
                  ) : (
                    <span className={r.margin >= 0 ? "pos" : "neg"}>
                      {r.margin.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>

      {!loading && !loadError && (
        <section className="pba">
          <div className="pba-head">
            <div>
              <h2 className="pba-title">Аналитика товаров</h2>
              <p className="pba-sub">
                Лучшие и убыточные товары по расчётной чистой прибыли.
              </p>
            </div>
            {scored.length > 0 && (
              <button
                type="button"
                className="pba-export"
                onClick={handleAnalyticsExport}
                disabled={exportingAnalytics}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
                {exportingAnalytics ? "Готовим…" : "Скачать аналитику"}
              </button>
            )}
          </div>

          {scored.length === 0 ? (
            <div className="pba-note">
              Аналитика прибыли появится, когда товары из отчёта получат
              себестоимость из «Каталога товаров».
            </div>
          ) : (
            <>
              {/* Герои: лучший и самый убыточный */}
              <div className="pba-heroes">
                <div className="pba-hero pba-hero-best">
                  <div className="pba-hero-h">
                    <span className="pba-hero-ic pba-ic-best" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M12 2v20M5 9l7-7 7 7" />
                      </svg>
                    </span>
                    Лучший товар месяца
                  </div>
                  {bestProduct ? (
                    <>
                      <div className="pba-hero-name">{bestProduct.name}</div>
                      <div className="pba-hero-art">{bestProduct.article}</div>
                      <div className="pba-stats">
                        <div className="pba-stat">
                          <span className="pba-stat-l">Выручка</span>
                          <span className="pba-stat-v">
                            {formatRub(bestProduct.revenue)}
                          </span>
                        </div>
                        <div className="pba-stat">
                          <span className="pba-stat-l">Чистая прибыль</span>
                          <span
                            className={
                              "pba-stat-v " +
                              ((bestProduct.profit ?? 0) >= 0 ? "pos" : "neg")
                            }
                          >
                            {formatSignedRub(bestProduct.profit ?? 0)}
                          </span>
                        </div>
                        <div className="pba-stat">
                          <span className="pba-stat-l">Чистая маржа</span>
                          <span
                            className={
                              "pba-stat-v " +
                              ((bestProduct.margin ?? 0) >= 0 ? "pos" : "neg")
                            }
                          >
                            {(bestProduct.margin ?? 0).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="pba-hero-empty">Нет данных</div>
                  )}
                </div>

                <div className="pba-hero pba-hero-worst">
                  <div className="pba-hero-h">
                    <span className="pba-hero-ic pba-ic-worst" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M12 22V2M5 15l7 7 7-7" />
                      </svg>
                    </span>
                    Самый убыточный товар
                  </div>
                  {worstProduct ? (
                    <>
                      <div className="pba-hero-name">{worstProduct.name}</div>
                      <div className="pba-hero-art">{worstProduct.article}</div>
                      <div className="pba-stats">
                        <div className="pba-stat">
                          <span className="pba-stat-l">Выручка</span>
                          <span className="pba-stat-v">
                            {formatRub(worstProduct.revenue)}
                          </span>
                        </div>
                        <div className="pba-stat">
                          <span className="pba-stat-l">Убыток</span>
                          <span className="pba-stat-v neg">
                            {formatSignedRub(worstProduct.profit ?? 0)}
                          </span>
                        </div>
                        <div className="pba-stat">
                          <span className="pba-stat-l">Чистая маржа</span>
                          <span className="pba-stat-v neg">
                            {(worstProduct.margin ?? 0).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="pba-hero-ok">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Убыточных товаров не найдено
                    </div>
                  )}
                </div>
              </div>

              {/* Самые прибыльные */}
              <div className="pba-section">
                <h3 className="pba-h3">Самые прибыльные товары</h3>
                <div
                  className="pba-table"
                  role="table"
                  aria-label="Самые прибыльные товары"
                >
                  <div className="pba-thead" role="row">
                    <span role="columnheader">Артикул</span>
                    <span role="columnheader">Название</span>
                    <span role="columnheader" className="pba-num">
                      Выручка
                    </span>
                    <span role="columnheader" className="pba-num">
                      Чистая прибыль
                    </span>
                    <span role="columnheader" className="pba-num">
                      Чистая маржа
                    </span>
                  </div>
                  {topProfitable.map((r, i) => (
                    <div className="pba-row" role="row" key={r.article + "#" + i}>
                      <span
                        className="pba-cell pba-c-art"
                        role="cell"
                        data-label="Артикул"
                      >
                        {r.article}
                      </span>
                      <span
                        className="pba-cell pba-c-name"
                        role="cell"
                        data-label="Название"
                      >
                        {r.name}
                      </span>
                      <span
                        className="pba-cell pba-num"
                        role="cell"
                        data-label="Выручка"
                      >
                        {formatRub(r.revenue)}
                      </span>
                      <span
                        className="pba-cell pba-num"
                        role="cell"
                        data-label="Чистая прибыль"
                      >
                        <span className={(r.profit ?? 0) >= 0 ? "pos" : "neg"}>
                          {formatSignedRub(r.profit ?? 0)}
                        </span>
                      </span>
                      <span
                        className="pba-cell pba-num"
                        role="cell"
                        data-label="Чистая маржа"
                      >
                        <span className={(r.margin ?? 0) >= 0 ? "pos" : "neg"}>
                          {(r.margin ?? 0).toFixed(1)}%
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Товары в минус */}
              <div className="pba-section">
                <h3 className="pba-h3">Товары в минус</h3>
                {topLosses.length === 0 ? (
                  <div className="pba-ok">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Убыточных товаров не найдено
                  </div>
                ) : (
                  <div
                    className="pba-table"
                    role="table"
                    aria-label="Товары в минус"
                  >
                    <div className="pba-thead" role="row">
                      <span role="columnheader">Артикул</span>
                      <span role="columnheader">Название</span>
                      <span role="columnheader" className="pba-num">
                        Выручка
                      </span>
                      <span role="columnheader" className="pba-num">
                        Прибыль
                      </span>
                      <span role="columnheader" className="pba-num">
                        Маржа
                      </span>
                    </div>
                    {topLosses.map((r, i) => (
                      <div
                        className="pba-row"
                        role="row"
                        key={r.article + "#" + i}
                      >
                        <span
                          className="pba-cell pba-c-art"
                          role="cell"
                          data-label="Артикул"
                        >
                          {r.article}
                        </span>
                        <span
                          className="pba-cell pba-c-name"
                          role="cell"
                          data-label="Название"
                        >
                          {r.name}
                        </span>
                        <span
                          className="pba-cell pba-num"
                          role="cell"
                          data-label="Выручка"
                        >
                          {formatRub(r.revenue)}
                        </span>
                        <span
                          className="pba-cell pba-num"
                          role="cell"
                          data-label="Чистая прибыль"
                        >
                          <span className="neg">
                            {formatSignedRub(r.profit ?? 0)}
                          </span>
                        </span>
                        <span
                          className="pba-cell pba-num"
                          role="cell"
                          data-label="Чистая маржа"
                        >
                          <span className="neg">
                            {(r.margin ?? 0).toFixed(1)}%
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {!loading && !loadError && (
        <section className="pbm">
          <div className="pbm-head">
            <div>
              <h2 className="pbm-title">
                Товары без себестоимости{" "}
                <span className="pbm-count">({missing.length})</span>
              </h2>
              {missing.length > 0 && (
                <p className="pbm-sub">
                  Эти артикулы есть в отчёте, но для них не указана
                  себестоимость в «Каталоге товаров». Чистая прибыль по ним не
                  рассчитывается.
                </p>
              )}
            </div>
            {missing.length > 0 && (
              <button
                type="button"
                className="pbm-export"
                onClick={handleExport}
                disabled={exporting}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
                {exporting ? "Готовим…" : "Скачать Excel"}
              </button>
            )}
          </div>

          {missing.length > 0 && (
            <p className="pbm-hint">
              Скачайте файл, заполните колонку{" "}
              <span className="pbm-hint-k">cost_price</span> и загрузите его
              обратно в «Каталог товаров».
            </p>
          )}

          {missing.length === 0 ? (
            <div className="pbm-ok">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Все товары имеют себестоимость
            </div>
          ) : (
            <div
              className="pbm-table"
              role="table"
              aria-label="Товары без себестоимости"
            >
              <div className="pbm-thead" role="row">
                <span role="columnheader">Артикул</span>
                <span role="columnheader">Название</span>
                <span role="columnheader" className="pbm-num">
                  Выручка
                </span>
              </div>
              {missing.map((r, i) => (
                <div className="pbm-row" role="row" key={r.article + "#" + i}>
                  <span
                    className="pbm-cell pbm-c-art"
                    role="cell"
                    data-label="Артикул"
                  >
                    {r.article}
                  </span>
                  <span
                    className="pbm-cell pbm-c-name"
                    role="cell"
                    data-label="Название"
                  >
                    {r.name}
                  </span>
                  <span
                    className="pbm-cell pbm-num"
                    role="cell"
                    data-label="Выручка"
                  >
                    {formatRub(r.revenue)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <style jsx>{`
        .pb {
          background: var(--glass);
          border: 1px solid var(--edge);
          border-radius: 16px;
          padding: 1.4rem 1.5rem 1.6rem;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
          margin-top: 1.1rem;
        }
        .pb-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .pb-title {
          font-family: var(--display);
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--txt);
          letter-spacing: -0.01em;
        }
        .pb-sub {
          font-size: 0.85rem;
          color: var(--txt2);
          margin-top: 0.25rem;
          font-weight: 300;
        }
        .pb-sub-ok {
          color: var(--green);
          font-weight: 600;
        }
        .pb-sub-warn {
          color: var(--gold2);
          font-weight: 600;
        }
        .pb-note {
          margin-top: 1rem;
          padding: 0.8rem 1rem;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: var(--gold-bg);
          color: var(--txt2);
          font-size: 0.85rem;
          line-height: 1.5;
        }

        .pb-summary {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.7rem;
          margin-top: 1.2rem;
        }
        .pb-chip {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 0.8rem 0.95rem;
          border: 1px solid var(--edge);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.02);
        }
        .pb-chip-l {
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pb-chip-v {
          font-family: var(--mono);
          font-size: 1rem;
          font-weight: 500;
          color: var(--txt);
        }
        .pb-chip-v.pos,
        .pos {
          color: var(--green);
        }
        .pb-chip-v.neg,
        .neg {
          color: var(--red);
        }

        .pb-table {
          margin-top: 1.2rem;
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--edge);
          border-radius: 12px;
          overflow: hidden;
        }
        .pb-thead,
        .pb-row {
          display: grid;
          grid-template-columns: 140px 1.5fr 1fr 1fr 1fr 80px;
          align-items: center;
          gap: 0.8rem;
          padding: 0.7rem 1rem;
        }
        .pb-thead {
          background: rgba(255, 255, 255, 0.03);
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pb-num {
          text-align: right;
          justify-self: end;
        }
        .pb-row {
          background: rgba(255, 255, 255, 0.012);
          transition: background 0.16s ease;
        }
        .pb-row:hover {
          background: rgba(255, 255, 255, 0.035);
        }
        .pb-row-nocost {
          background: rgba(201, 168, 76, 0.04);
        }
        .pb-cell {
          font-size: 0.9rem;
          color: var(--txt);
          min-width: 0;
          word-break: break-word;
        }
        .pb-c-art {
          font-family: var(--mono);
          font-size: 0.82rem;
          color: var(--txt2);
        }
        .pb-c-name {
          font-weight: 500;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .pb-qty {
          font-style: normal;
          font-size: 0.72rem;
          color: var(--txt3);
          font-family: var(--mono);
        }
        .pb-cell.pb-num {
          font-family: var(--mono);
          font-size: 0.86rem;
        }
        .pb-nocost {
          font-family: var(--sans);
          font-size: 0.76rem;
          color: var(--gold2);
          font-style: italic;
        }
        .pb-dash {
          color: var(--txt3);
        }

        .pb-c-art::before,
        .pb-c-name::before,
        .pb-cell.pb-num::before {
          content: attr(data-label);
          display: none;
          font-size: 0.68rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--txt3);
          margin-bottom: 2px;
        }

        .pb-state {
          display: flex;
          align-items: center;
          gap: 10px;
          justify-content: center;
          padding: 2rem 1rem;
          color: var(--txt2);
          font-size: 0.9rem;
        }
        .pb-state-err {
          color: var(--red);
        }
        .pb-spinner {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid var(--edge2);
          border-top-color: var(--gold);
          animation: pbSpin 0.7s linear infinite;
        }
        @keyframes pbSpin {
          to {
            transform: rotate(360deg);
          }
        }

        /* ===== Блок «Товары без себестоимости» ===== */
        .pbm {
          background: var(--glass);
          border: 1px solid var(--edge);
          border-radius: 16px;
          padding: 1.4rem 1.5rem 1.6rem;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
          margin-top: 1.1rem;
        }
        .pbm-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .pbm-title {
          font-family: var(--display);
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--txt);
          letter-spacing: -0.01em;
        }
        .pbm-count {
          font-family: var(--mono);
          font-size: 1.05rem;
          font-weight: 500;
          color: var(--gold2);
        }
        .pbm-sub {
          font-size: 0.85rem;
          color: var(--txt2);
          margin-top: 0.25rem;
          font-weight: 300;
        }
        .pbm-hint {
          margin-top: 1rem;
          padding: 0.7rem 0.9rem;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: var(--gold-bg);
          color: var(--txt2);
          font-size: 0.83rem;
          line-height: 1.5;
        }
        .pbm-hint-k {
          font-family: var(--mono);
          font-size: 0.8rem;
          color: var(--gold2);
          background: rgba(201, 168, 76, 0.12);
          padding: 1px 6px;
          border-radius: 5px;
        }
        .pbm-export {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 16px;
          font-family: var(--sans);
          font-size: 0.86rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.03);
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease;
          white-space: nowrap;
        }
        .pbm-export:hover:not(:disabled) {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pbm-export:disabled {
          opacity: 0.65;
          cursor: default;
        }
        .pbm-export svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pbm-ok {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 1.1rem;
          padding: 0.95rem 1.1rem;
          border: 1px solid rgba(46, 204, 138, 0.3);
          border-radius: 12px;
          background: rgba(46, 204, 138, 0.08);
          color: var(--green);
          font-size: 0.9rem;
          font-weight: 500;
        }
        .pbm-ok svg {
          width: 20px;
          height: 20px;
          stroke: currentColor;
          stroke-width: 2.2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex-shrink: 0;
        }
        .pbm-table {
          margin-top: 1.2rem;
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--edge);
          border-radius: 12px;
          overflow: hidden;
        }
        .pbm-thead,
        .pbm-row {
          display: grid;
          grid-template-columns: 160px 1fr 140px;
          align-items: center;
          gap: 0.8rem;
          padding: 0.7rem 1rem;
        }
        .pbm-thead {
          background: rgba(255, 255, 255, 0.03);
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pbm-num {
          text-align: right;
          justify-self: end;
        }
        .pbm-row {
          background: rgba(201, 168, 76, 0.04);
          transition: background 0.16s ease;
        }
        .pbm-row:hover {
          background: rgba(201, 168, 76, 0.08);
        }
        .pbm-cell {
          font-size: 0.9rem;
          color: var(--txt);
          min-width: 0;
          word-break: break-word;
        }
        .pbm-c-art {
          font-family: var(--mono);
          font-size: 0.82rem;
          color: var(--txt2);
        }
        .pbm-c-name {
          font-weight: 500;
        }
        .pbm-cell.pbm-num {
          font-family: var(--mono);
          font-size: 0.86rem;
          color: var(--txt);
        }
        .pbm-c-art::before,
        .pbm-c-name::before,
        .pbm-cell.pbm-num::before {
          content: attr(data-label);
          display: none;
          font-size: 0.68rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--txt3);
          margin-bottom: 2px;
        }

        /* ===== Блок «Аналитика товаров» ===== */
        .pba {
          background: var(--glass);
          border: 1px solid var(--edge);
          border-radius: 16px;
          padding: 1.4rem 1.5rem 1.6rem;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
          margin-top: 1.1rem;
        }
        .pba-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .pba-title {
          font-family: var(--display);
          font-size: 1.3rem;
          font-weight: 700;
          color: var(--txt);
          letter-spacing: -0.01em;
        }
        .pba-sub {
          font-size: 0.85rem;
          color: var(--txt2);
          margin-top: 0.25rem;
          font-weight: 300;
        }
        .pba-export {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 44px;
          padding: 0 16px;
          font-family: var(--sans);
          font-size: 0.86rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          border: 1px solid var(--edge2);
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.03);
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease;
          white-space: nowrap;
        }
        .pba-export:hover:not(:disabled) {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pba-export:disabled {
          opacity: 0.65;
          cursor: default;
        }
        .pba-export svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pba-note {
          margin-top: 1.1rem;
          padding: 0.95rem 1.1rem;
          border: 1px solid var(--edge2);
          border-radius: 12px;
          background: var(--gold-bg);
          color: var(--txt2);
          font-size: 0.85rem;
          line-height: 1.5;
        }

        .pba-heroes {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.9rem;
          margin-top: 1.3rem;
        }
        .pba-hero {
          border: 1px solid var(--edge);
          border-radius: 14px;
          padding: 1.1rem 1.15rem 1.2rem;
          background: rgba(255, 255, 255, 0.014);
          min-width: 0;
        }
        .pba-hero-best {
          border-color: rgba(46, 204, 138, 0.32);
          background: rgba(46, 204, 138, 0.05);
        }
        .pba-hero-worst {
          border-color: rgba(224, 85, 102, 0.3);
          background: rgba(224, 85, 102, 0.045);
        }
        .pba-hero-h {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--sans);
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--txt);
          margin-bottom: 0.85rem;
        }
        .pba-hero-ic {
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          border: 1px solid var(--edge2);
          flex-shrink: 0;
        }
        .pba-hero-ic svg {
          width: 15px;
          height: 15px;
          stroke: currentColor;
          stroke-width: 1.9;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pba-ic-best {
          color: var(--green);
          background: rgba(46, 204, 138, 0.1);
        }
        .pba-ic-worst {
          color: var(--red);
          background: rgba(224, 85, 102, 0.1);
        }
        .pba-hero-name {
          font-family: var(--sans);
          font-size: 0.98rem;
          font-weight: 600;
          color: var(--txt);
          line-height: 1.35;
          word-break: break-word;
        }
        .pba-hero-art {
          font-family: var(--mono);
          font-size: 0.76rem;
          color: var(--txt2);
          margin-top: 3px;
        }
        .pba-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.6rem;
          margin-top: 0.95rem;
        }
        .pba-stat {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 0.6rem 0.7rem;
          border: 1px solid var(--edge);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.02);
          min-width: 0;
        }
        .pba-stat-l {
          font-size: 0.66rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pba-stat-v {
          font-family: var(--mono);
          font-size: 0.86rem;
          font-weight: 500;
          color: var(--txt);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pba-hero-empty {
          font-size: 0.82rem;
          color: var(--txt3);
          padding: 0.5rem 0;
        }
        .pba-hero-ok {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 0.5rem 0;
          color: var(--green);
          font-size: 0.86rem;
          font-weight: 500;
        }
        .pba-hero-ok svg {
          width: 18px;
          height: 18px;
          stroke: currentColor;
          stroke-width: 2.2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex-shrink: 0;
        }

        .pba-section {
          margin-top: 1.4rem;
        }
        .pba-h3 {
          font-family: var(--sans);
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--txt);
          margin-bottom: 0.7rem;
        }
        .pba-ok {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0.95rem 1.1rem;
          border: 1px solid rgba(46, 204, 138, 0.3);
          border-radius: 12px;
          background: rgba(46, 204, 138, 0.08);
          color: var(--green);
          font-size: 0.9rem;
          font-weight: 500;
        }
        .pba-ok svg {
          width: 20px;
          height: 20px;
          stroke: currentColor;
          stroke-width: 2.2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex-shrink: 0;
        }
        .pba-table {
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--edge);
          border-radius: 12px;
          overflow: hidden;
        }
        .pba-thead,
        .pba-row {
          display: grid;
          grid-template-columns: 120px 1.4fr 1fr 1fr 80px;
          align-items: center;
          gap: 0.8rem;
          padding: 0.7rem 1rem;
        }
        .pba-thead {
          background: rgba(255, 255, 255, 0.03);
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--txt3);
        }
        .pba-num {
          text-align: right;
          justify-self: end;
        }
        .pba-row {
          background: rgba(255, 255, 255, 0.012);
          transition: background 0.16s ease;
        }
        .pba-row:hover {
          background: rgba(255, 255, 255, 0.035);
        }
        .pba-cell {
          font-size: 0.9rem;
          color: var(--txt);
          min-width: 0;
          word-break: break-word;
        }
        .pba-c-art {
          font-family: var(--mono);
          font-size: 0.82rem;
          color: var(--txt2);
        }
        .pba-c-name {
          font-weight: 500;
        }
        .pba-cell.pba-num {
          font-family: var(--mono);
          font-size: 0.86rem;
        }
        .pba-c-art::before,
        .pba-c-name::before,
        .pba-cell.pba-num::before {
          content: attr(data-label);
          display: none;
          font-size: 0.68rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--txt3);
          margin-bottom: 2px;
        }

        @media (max-width: 900px) {
          .pba-heroes {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 720px) {
          .pb {
            padding: 1.2rem 1.1rem 1.3rem;
          }
          .pb-summary {
            grid-template-columns: repeat(2, 1fr);
          }
          .pb-thead {
            display: none;
          }
          .pb-row {
            grid-template-columns: 1fr 1fr;
            gap: 0.55rem 0.8rem;
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--edge);
          }
          .pb-c-art {
            grid-column: 1 / -1;
          }
          .pb-c-name {
            grid-column: 1 / -1;
          }
          .pb-num {
            text-align: left;
            justify-self: start;
          }
          .pb-c-art::before,
          .pb-c-name::before,
          .pb-cell.pb-num::before {
            display: block;
          }

          .pbm {
            padding: 1.2rem 1.1rem 1.3rem;
          }
          .pbm-export {
            width: 100%;
            justify-content: center;
          }
          .pbm-thead {
            display: none;
          }
          .pbm-row {
            grid-template-columns: 1fr 1fr;
            gap: 0.55rem 0.8rem;
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--edge);
          }
          .pbm-c-art {
            grid-column: 1 / -1;
          }
          .pbm-c-name {
            grid-column: 1 / -1;
          }
          .pbm-num {
            text-align: left;
            justify-self: start;
          }
          .pbm-c-art::before,
          .pbm-c-name::before,
          .pbm-cell.pbm-num::before {
            display: block;
          }

          .pba {
            padding: 1.2rem 1.1rem 1.3rem;
          }
          .pba-export {
            width: 100%;
            justify-content: center;
          }
          .pba-heroes {
            grid-template-columns: 1fr;
          }
          .pba-thead {
            display: none;
          }
          .pba-row {
            grid-template-columns: 1fr 1fr;
            gap: 0.55rem 0.8rem;
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--edge);
          }
          .pba-c-art {
            grid-column: 1 / -1;
          }
          .pba-c-name {
            grid-column: 1 / -1;
          }
          .pba-num {
            text-align: left;
            justify-self: start;
          }
          .pba-c-art::before,
          .pba-c-name::before,
          .pba-cell.pba-num::before {
            display: block;
          }
        }
      `}</style>
    </>
  );
}
