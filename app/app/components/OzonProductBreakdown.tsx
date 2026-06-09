"use client";

// ============================================================================
// OzonProductBreakdown — прибыль по товарам после загрузки отчёта Ozon.
//
// Логика (по ТЗ):
//   1. Берём per-SKU строки из распарсенного отчёта (report.products).
//   2. Для каждого артикула ищем товар в каталоге пользователя (products.sku).
//   3. Найден  → берём cost_price, считаем себестоимость продаж и прибыль.
//      Не найден → «Себестоимость не указана».
//   4. Таблица результатов: Артикул | Товар | Выручка | Себестоимость |
//      Прибыль | Маржа.
//   5. Аналитика: ТОП-10 по прибыли, ТОП-10 по выручке, товары без себестоимости.
//
// Формулы (на товар, агрегировано по артикулу):
//   себестоимость продаж = cost_price × количество
//   прибыль              = выручка − себестоимость продаж
//   маржа, %             = выручка > 0 ? прибыль / выручка × 100 : 0
//
// Стиль — тема M-PROF (глобальные CSS-переменные --gold/--txt/--green/…).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { loadProductsFromCloud, type Product } from "../lib/supabase-cloud";
import type { OzonProductRow } from "../lib/report-parsers/ozon-parser";

interface Props {
  products: OzonProductRow[];
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
  /** Себестоимость продаж = unitCost × quantity. null — не найден. */
  cogs: number | null;
  /** Прибыль = revenue − cogs. null — не найден. */
  profit: number | null;
  /** Маржа, %. null — не найден. */
  margin: number | null;
  /** Есть пригодная (>0) себестоимость — для ранжирования по прибыли. */
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

export function OzonProductBreakdown({ products, user }: Props) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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

  // ===== Матчинг + расчёт =====
  const rows = useMemo<BreakdownRow[]>(() => {
    // Индекс каталога по нормализованному sku.
    const bySku = new Map<string, Product>();
    for (const p of catalog) {
      const key = normArticle(p.sku);
      if (key && !bySku.has(key)) bySku.set(key, p);
    }

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
      const match = bySku.get(key);
      if (match) {
        const unitCost = match.cost_price;
        const cogs = unitCost * a.quantity;
        const profit = a.revenue - cogs;
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
          hasCost: unitCost > 0,
        });
      } else {
        out.push({
          article: a.article,
          name: a.name || a.article,
          revenue: a.revenue,
          quantity: a.quantity,
          matched: false,
          unitCost: null,
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
  }, [products, catalog]);

  // ===== Аналитика =====
  const topProfit = useMemo(
    () =>
      rows
        .filter((r) => r.hasCost && r.profit !== null)
        .sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0))
        .slice(0, 10),
    [rows]
  );
  const topRevenue = useMemo(
    () => [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    [rows]
  );
  const noCost = useMemo(() => rows.filter((r) => !r.hasCost), [rows]);

  // Блок «Товары без себестоимости» (по ТЗ): unitCost === null ИЛИ matched === false.
  // Не меняет существующий расчёт — это отдельная производная выборка из rows.
  const missing = useMemo(
    () => rows.filter((r) => r.unitCost === null || r.matched === false),
    [rows]
  );

  // ===== Итоги =====
  const totals = useMemo(() => {
    let revenue = 0;
    let cogs = 0;
    let profit = 0;
    let matchedCount = 0;
    for (const r of rows) {
      revenue += r.revenue;
      if (r.matched) {
        cogs += r.cogs ?? 0;
        profit += r.profit ?? 0;
        matchedCount++;
      }
    }
    return {
      revenue,
      cogs,
      profit,
      matchedCount,
      total: rows.length,
      unmatched: rows.length - matchedCount,
    };
  }, [rows]);

  // Выгрузка «Товары без себестоимости» в Excel: колонки sku | name | revenue.
  async function handleExport() {
    if (missing.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = missing.map((r) => ({
        sku: r.article,
        name: r.name,
        revenue: r.revenue,
      }));
      const ws = XLSX.utils.json_to_sheet(data, {
        header: ["sku", "name", "revenue"],
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

  if (rows.length === 0 && !loading) return null;

  return (
    <>
    <section className="pb">
      <div className="pb-head">
        <div>
          <h2 className="pb-title">Прибыль по товарам</h2>
          <p className="pb-sub">
            {totals.total} {pluralProducts(totals.total)} в отчёте ·{" "}
            <b className="pb-sub-ok">{totals.matchedCount}</b> найдено в каталоге
            {totals.unmatched > 0 && (
              <>
                {" "}
                · <b className="pb-sub-warn">{totals.unmatched}</b> без
                себестоимости
              </>
            )}
          </p>
        </div>
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
              <span className="pb-chip-l">Прибыль</span>
              <span
                className={
                  "pb-chip-v " + (totals.profit >= 0 ? "pos" : "neg")
                }
              >
                {formatSignedRub(totals.profit)}
              </span>
            </div>
            <div className="pb-chip">
              <span className="pb-chip-l">Найдено</span>
              <span className="pb-chip-v">
                {totals.matchedCount} / {totals.total}
              </span>
            </div>
          </div>

          {/* Таблица результатов */}
          <div
            className="pb-table"
            role="table"
            aria-label="Прибыль по товарам"
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
                Прибыль
              </span>
              <span role="columnheader" className="pb-num">
                Маржа
              </span>
            </div>
            {rows.map((r, i) => (
              <div
                className={"pb-row" + (r.matched ? "" : " pb-row-nocost")}
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
                  {r.matched ? (
                    formatRub(r.cogs ?? 0)
                  ) : (
                    <span className="pb-nocost">Не указана</span>
                  )}
                </span>
                <span className="pb-cell pb-num" role="cell" data-label="Прибыль">
                  {r.profit === null ? (
                    <span className="pb-dash">—</span>
                  ) : (
                    <span className={r.profit >= 0 ? "pos" : "neg"}>
                      {formatSignedRub(r.profit)}
                    </span>
                  )}
                </span>
                <span className="pb-cell pb-num" role="cell" data-label="Маржа">
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

          {/* Аналитика */}
          <div className="pb-analytics">
            <div className="pb-an">
              <div className="pb-an-h">
                <span className="pb-an-ic pb-ic-gold" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 2v20M5 9l7-7 7 7" />
                  </svg>
                </span>
                ТОП-10 по прибыли
              </div>
              {topProfit.length === 0 ? (
                <div className="pb-an-empty">
                  Нет товаров с указанной себестоимостью
                </div>
              ) : (
                <ol className="pb-an-list">
                  {topProfit.map((r, i) => (
                    <li className="pb-an-item" key={r.article + i}>
                      <span className="pb-an-rank">{i + 1}</span>
                      <span className="pb-an-name" title={r.name}>
                        <b>{r.article}</b>
                        <i>{r.name}</i>
                      </span>
                      <span className="pb-an-val pos">
                        {formatSignedRub(r.profit ?? 0)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="pb-an">
              <div className="pb-an-h">
                <span className="pb-an-ic pb-ic-blue" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M3 3v18h18" />
                    <path d="M7 14l4-4 3 3 5-6" />
                  </svg>
                </span>
                ТОП-10 по выручке
              </div>
              {topRevenue.length === 0 ? (
                <div className="pb-an-empty">Нет данных</div>
              ) : (
                <ol className="pb-an-list">
                  {topRevenue.map((r, i) => (
                    <li className="pb-an-item" key={r.article + i}>
                      <span className="pb-an-rank">{i + 1}</span>
                      <span className="pb-an-name" title={r.name}>
                        <b>{r.article}</b>
                        <i>{r.name}</i>
                      </span>
                      <span className="pb-an-val">{formatRub(r.revenue)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="pb-an">
              <div className="pb-an-h">
                <span className="pb-an-ic pb-ic-warn" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                  </svg>
                </span>
                Без себестоимости
                {noCost.length > 0 && (
                  <span className="pb-an-count">{noCost.length}</span>
                )}
              </div>
              {noCost.length === 0 ? (
                <div className="pb-an-empty">
                  У всех товаров указана себестоимость
                </div>
              ) : (
                <>
                  <ol className="pb-an-list">
                    {noCost.slice(0, 10).map((r, i) => (
                      <li className="pb-an-item" key={r.article + i}>
                        <span className="pb-an-rank pb-rank-warn">
                          {i + 1}
                        </span>
                        <span className="pb-an-name" title={r.name}>
                          <b>{r.article}</b>
                          <i>{r.name}</i>
                        </span>
                        <span className="pb-an-val muted">
                          {formatRub(r.revenue)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {noCost.length > 10 && (
                    <div className="pb-an-more">
                      …и ещё {noCost.length - 10}
                    </div>
                  )}
                  {user && (
                    <div className="pb-an-hint">
                      Добавьте их в «Каталог товаров» — прибыль посчитается
                      автоматически.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>

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
                  Эти артикулы есть в отчёте, но не найдены в «Каталоге товаров».
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

        .pb-analytics {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.9rem;
          margin-top: 1.3rem;
        }
        .pb-an {
          border: 1px solid var(--edge);
          border-radius: 13px;
          padding: 1rem 1.05rem 1.1rem;
          background: rgba(255, 255, 255, 0.014);
          min-width: 0;
        }
        .pb-an-h {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--sans);
          font-size: 0.82rem;
          font-weight: 700;
          color: var(--txt);
          margin-bottom: 0.85rem;
        }
        .pb-an-count {
          margin-left: auto;
          font-family: var(--mono);
          font-size: 0.72rem;
          font-weight: 500;
          color: var(--gold2);
          background: var(--gold-bg);
          border: 1px solid var(--edge2);
          border-radius: 8px;
          padding: 1px 7px;
        }
        .pb-an-ic {
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          border: 1px solid var(--edge2);
          flex-shrink: 0;
        }
        .pb-an-ic svg {
          width: 15px;
          height: 15px;
          stroke: currentColor;
          stroke-width: 1.9;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .pb-ic-gold {
          color: var(--gold2);
          background: var(--gold-bg);
        }
        .pb-ic-blue {
          color: #6ea8e8;
          background: rgba(110, 168, 232, 0.08);
        }
        .pb-ic-warn {
          color: var(--gold2);
          background: var(--gold-bg);
        }
        .pb-an-list {
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 1px;
          margin: 0;
          padding: 0;
        }
        .pb-an-item {
          display: grid;
          grid-template-columns: 20px 1fr auto;
          align-items: center;
          gap: 9px;
          padding: 0.42rem 0;
        }
        .pb-an-item + .pb-an-item {
          border-top: 1px solid rgba(255, 255, 255, 0.04);
        }
        .pb-an-rank {
          font-family: var(--mono);
          font-size: 0.74rem;
          font-weight: 600;
          color: var(--txt3);
          text-align: center;
        }
        .pb-rank-warn {
          color: var(--gold2);
        }
        .pb-an-name {
          display: flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
        }
        .pb-an-name b {
          font-family: var(--mono);
          font-size: 0.78rem;
          font-weight: 500;
          color: var(--txt);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pb-an-name i {
          font-style: normal;
          font-size: 0.72rem;
          color: var(--txt3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pb-an-val {
          font-family: var(--mono);
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--txt);
          white-space: nowrap;
        }
        .pb-an-val.muted {
          color: var(--txt2);
        }
        .pb-an-empty {
          font-size: 0.8rem;
          color: var(--txt3);
          padding: 0.6rem 0;
          line-height: 1.5;
        }
        .pb-an-more {
          font-size: 0.76rem;
          color: var(--txt3);
          margin-top: 0.5rem;
          font-family: var(--mono);
        }
        .pb-an-hint {
          font-size: 0.76rem;
          color: var(--txt2);
          margin-top: 0.7rem;
          padding-top: 0.7rem;
          border-top: 1px solid var(--edge);
          line-height: 1.45;
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

        @media (max-width: 900px) {
          .pb-analytics {
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
        }
      `}</style>
    </>
  );
}
