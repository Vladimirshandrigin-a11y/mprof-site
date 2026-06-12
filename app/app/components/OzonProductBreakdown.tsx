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
import {
  addProductToCloud,
  loadProductsFromCloud,
  updateProductInCloud,
  type Product,
} from "../lib/supabase-cloud";
import type {
  OzonProductRow,
  OzonEstimate,
} from "../lib/report-parsers/ozon-parser";

/** Ключевой товар для PDF-отчёта родителя (подмножество BreakdownRow). */
export interface KeyProduct {
  article: string;
  name: string;
  profit: number;
  margin: number;
}
/**
 * Снимок ключевых товаров: best — самый прибыльный (null, если нет товаров с
 * себестоимостью), worst — самый убыточный (null, если убыточных нет).
 * Пробрасывается в родителя ТОЛЬКО для блока «Ключевые товары» в PDF.
 */
export interface KeyProductsSnapshot {
  best: KeyProduct | null;
  worst: KeyProduct | null;
}

/**
 * Снимок покрытия себестоимостью: total — всего товаров в отчёте, withCost —
 * сколько с заполненной себестоимостью, withoutCost — сколько без. Read-only
 * проброс уже посчитанных totals для блока «Проверка расчёта» родителя.
 */
export interface CostCoverageSnapshot {
  total: number;
  withCost: number;
  withoutCost: number;
}

interface Props {
  products: OzonProductRow[];
  /** Тоталы отчёта (estimate) — источник общих расходов для распределения. */
  estimate: OzonEstimate | null;
  user: User | null;
  /**
   * Колбэк с суммарной себестоимостью (cost_price × qty по сматченным SKU).
   * Родитель использует его для автозаполнения поля «Себестоимость товара»
   * в блоке «Дополнительные расходы». 0 — если каталог пуст / ничего не сматчено.
   */
  onCogsTotal?: (cogsTotal: number) => void;
  /**
   * Колбэк с ключевыми товарами (самый прибыльный / самый убыточный) — read-only
   * проброс уже посчитанных bestProduct/worstProduct для PDF-отчёта родителя.
   * Ничего не пересчитывает и не меняет поведение блока.
   */
  onKeyProducts?: (data: KeyProductsSnapshot) => void;
  /**
   * Колбэк с покрытием себестоимостью (всего / с себестоимостью / без) —
   * read-only проброс уже посчитанных totals для блока «Проверка расчёта».
   * Ничего не пересчитывает и не меняет поведение блока.
   */
  onCostCoverage?: (data: CostCoverageSnapshot) => void;
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

/**
 * Парсинг себестоимости из инлайн-поля «за 1 шт.»: запятая→точка, схлоп пробелов.
 * Возвращает число СТРОГО > 0 (0/пусто/NaN/отрицательное → null), т.к. нулевая
 * себестоимость не выводит товар из «без себестоимости». Зеркало parseCost в
 * ProductCatalog, но с порогом > 0.
 */
function parseCostInput(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Нормализация артикула/sku для матчинга: trim + lower + схлопывание пробелов. */
function normArticle(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function OzonProductBreakdown({
  products,
  estimate,
  user,
  onCogsTotal,
  onKeyProducts,
  onCostCoverage,
}: Props) {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingAnalytics, setExportingAnalytics] = useState(false);

  // Раскрытие таблицы товаров в блоке «Чистая прибыль по товарам».
  // Только локальное UI-состояние (без Supabase): по умолчанию таблица
  // свёрнута, чтобы сводка и итоговые карточки были видны сразу; полную
  // таблицу пользователь раскрывает по кнопке.
  const [tableOpen, setTableOpen] = useState(false);

  // Раскрытие списков аналитики «Самые прибыльные товары» и «Товары в минус».
  // Тоже только локальное UI-состояние, по умолчанию свёрнуто — по аналогии с
  // таблицей выше. На расчёты (topProfitable / topLosses) не влияет.
  const [profitableOpen, setProfitableOpen] = useState(false);
  const [lossesOpen, setLossesOpen] = useState(false);

  // Инлайн-ввод себестоимости в блоке «Товары без себестоимости».
  // costDraft — значения полей ввода по нормализованному артикулу.
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  // Артикул строки, которая сейчас сохраняется (для спиннера/блокировки).
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Идёт массовое сохранение «Сохранить себестоимость».
  const [bulkSaving, setBulkSaving] = useState(false);
  // Ошибки сохранения по строкам (по нормализованному артикулу).
  const [rowError, setRowError] = useState<Record<string, string>>({});

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
    () =>
      rows
        .filter((r) => !r.hasCost)
        // Порядок отображения = как в Excel-выгрузке: сначала по названию,
        // затем по артикулу (русская локаль). Похожие/одинаковые названия идут
        // рядом, внутри группы — по article/sku. Стабильно (равные сохраняют
        // исходный порядок). .filter() даёт новый массив → .sort() не мутирует
        // rows. Строки НЕ объединяются; формулы/totals/общий расчёт не меняются.
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, "ru") ||
            a.article.localeCompare(b.article, "ru")
        ),
    [rows]
  );

  // ===== Инлайн-сохранение себестоимости =====
  // Сохраняем cost_price «за 1 штуку» прямо из таблицы «без себестоимости».
  // Логика «обновить или создать по sku» зеркалит массовый импорт каталога:
  //   • товар уже в каталоге (по нормализованному sku) → updateProductInCloud;
  //   • товара нет → addProductToCloud по article/name.
  // После успеха ЛОКАЛЬНО обновляем catalog → rows/totals/missing/onCogsTotal
  // пересчитываются реактивно (товар уходит из таблицы, агрегат COGS в
  // «Дополнительных расходах» обновляется) БЕЗ перезагрузки страницы и без
  // повторного парсинга отчёта. Supabase-схему, оплату и формулы не трогаем.
  async function persistCost(row: BreakdownRow): Promise<boolean> {
    if (!user) return false;
    const key = normArticle(row.article);
    const cost = parseCostInput(costDraft[key] ?? "");
    if (cost === null) {
      setRowError((p) => ({ ...p, [key]: "Введите число больше 0" }));
      return false;
    }
    // Чистим прежнюю ошибку строки.
    setRowError((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });

    const existing = catalog.find((p) => normArticle(p.sku) === key);
    if (existing) {
      const { data, error } = await updateProductInCloud(
        existing.id,
        { cost_price: cost },
        user.id
      );
      if (error) {
        setRowError((p) => ({ ...p, [key]: error.message }));
        return false;
      }
      setCatalog((prev) =>
        prev.map((p) =>
          p.id === existing.id ? data ?? { ...p, cost_price: cost } : p
        )
      );
    } else {
      const { data, error } = await addProductToCloud(
        { sku: row.article, name: row.name || row.article, cost_price: cost },
        user.id
      );
      if (error) {
        setRowError((p) => ({ ...p, [key]: error.message }));
        return false;
      }
      if (data) setCatalog((prev) => [data, ...prev]);
    }

    // Товар уходит из таблицы — чистим его драфт.
    setCostDraft((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    return true;
  }

  // Сохранение одной строки (кнопка «Сохранить» в строке).
  async function saveOne(row: BreakdownRow) {
    if (savingKey || bulkSaving) return;
    setSavingKey(normArticle(row.article));
    await persistCost(row);
    setSavingKey(null);
  }

  // Массовое сохранение всех заполненных строк (кнопка «Сохранить себестоимость»).
  async function saveAllFilled() {
    if (savingKey || bulkSaving) return;
    const targets = missing.filter(
      (r) => parseCostInput(costDraft[normArticle(r.article)] ?? "") !== null
    );
    if (targets.length === 0) return;
    setBulkSaving(true);
    // Последовательно — чтобы не словить гонок по каталогу/RLS.
    for (const row of targets) {
      // eslint-disable-next-line no-await-in-loop
      await persistCost(row);
    }
    setBulkSaving(false);
  }

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

  // Пробрасываем суммарную себестоимость каталога в родителя — для автозаполнения
  // поля «Себестоимость товара» в блоке «Дополнительные расходы».
  useEffect(() => {
    onCogsTotal?.(totals.cogs);
  }, [totals.cogs, onCogsTotal]);

  // Пробрасываем ключевые товары (best/worst) в родителя — ТОЛЬКО для PDF-отчёта.
  // Read-only: берём уже посчитанные bestProduct/worstProduct, ничего не
  // пересчитываем и не меняем поведение блока «Чистая прибыль по товарам».
  useEffect(() => {
    if (!onKeyProducts) return;
    const toKey = (r: BreakdownRow | null): KeyProduct | null =>
      r
        ? {
            article: r.article,
            name: r.name,
            profit: r.profit ?? 0,
            margin: r.margin ?? 0,
          }
        : null;
    onKeyProducts({ best: toKey(bestProduct), worst: toKey(worstProduct) });
  }, [bestProduct, worstProduct, onKeyProducts]);

  // Пробрасываем покрытие себестоимостью (всего/с/без) в родителя — ТОЛЬКО для
  // блока «Проверка расчёта». Read-only: используем уже посчитанные totals,
  // ничего не пересчитываем и не меняем поведение блока.
  useEffect(() => {
    onCostCoverage?.({
      total: totals.total,
      withCost: totals.withCost,
      withoutCost: totals.withoutCost,
    });
  }, [totals.total, totals.withCost, totals.withoutCost, onCostCoverage]);

  // Выгрузка «Товары без себестоимости» в Excel. Лист «Без себестоимости»:
  // sku | name | revenue | cost_price. Колонка cost_price идёт ПУСТОЙ — её
  // заполняет пользователь (себестоимость ЗА 1 ШТУКУ) и загружает файл обратно
  // в «Каталог товаров». Заголовок именно `cost_price`, чтобы импорт каталога
  // распознал его (регэксп /cost[\s_]*price/).
  //
  // Оформление (жирная шапка, ширина колонок, автофильтр, формат рублей,
  // подсветка колонки для ввода) делается через xlsx-js-style — это
  // API-совместимый форк SheetJS, поддерживающий стили ячеек. Базовый `xlsx`
  // (которым читает импорт каталога) стили НЕ пишет, поэтому здесь форк.
  async function handleExport() {
    if (missing.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx-js-style");

      // 1) СОРТИРОВКА: сначала по названию, потом по артикулу (русская локаль),
      //    чтобы одинаковые/похожие товары стояли рядом и группировались.
      const sorted = [...missing].sort(
        (a, b) =>
          a.name.localeCompare(b.name, "ru") ||
          a.article.localeCompare(b.article, "ru")
      );

      const data = sorted.map((r) => ({
        sku: r.article,
        name: r.name,
        revenue: r.revenue,
        cost_price: "", // пустая ячейка для ручного ввода себестоимости за 1 шт.
      }));

      const ws = XLSX.utils.json_to_sheet(data, {
        header: ["sku", "name", "revenue", "cost_price"],
      });

      const lastRow = data.length + 1; // +1 — строка заголовка
      const RUB = '#,##0.00\\ "₽"'; // числовой формат рублей

      // 2) Ширина колонок — чтобы названия не обрезались.
      ws["!cols"] = [{ wch: 20 }, { wch: 46 }, { wch: 16 }, { wch: 18 }];

      // 3) Автофильтр на шапку + данные.
      ws["!autofilter"] = { ref: `A1:D${lastRow}` };

      // 4) ЖИРНАЯ ШАПКА: тёмно-синий фон, белый жирный текст, по центру.
      const headerStyle = {
        font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "1F4E78" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
      for (const addr of ["A1", "B1", "C1", "D1"]) {
        const cell = ws[addr];
        if (cell) cell.s = headerStyle;
      }

      // 5) Данные: тонкая сетка; формат рублей на revenue и cost_price;
      //    cost_price подсвечиваем мягко-жёлтым — это колонка для ввода.
      const thin = { style: "thin", color: { rgb: "D9D9D9" } };
      const grid = { top: thin, bottom: thin, left: thin, right: thin };
      for (let r = 2; r <= lastRow; r++) {
        for (const col of ["A", "B", "C", "D"]) {
          const cell = ws[col + r];
          if (!cell) continue;
          if (col === "D") {
            // колонка ввода cost_price: формат рублей + жёлтая подсветка
            cell.z = RUB;
            cell.s = { border: grid, fill: { fgColor: { rgb: "FFF7DD" } } };
          } else {
            if (col === "C") cell.z = RUB; // revenue — формат рублей
            cell.s = { border: grid };
          }
        }
      }

      const wb = XLSX.utils.book_new();
      // ВАЖНО: лист с данными добавляем ПЕРВЫМ — импорт каталога читает
      // wb.SheetNames[0]. «Инструкция» идёт ВТОРЫМ листом, чтобы не сломать импорт.
      XLSX.utils.book_append_sheet(wb, ws, "Без себестоимости");

      // 6) Отдельный лист «Инструкция» — короткая памятка для продавца.
      const instr = XLSX.utils.aoa_to_sheet([
        ["Как заполнить себестоимость"],
        [""],
        ["Заполните колонку cost_price — это себестоимость ОДНОЙ единицы товара (за 1 штуку)."],
        ["Не указывайте себестоимость всей партии или всей выручки."],
        ["Колонка revenue (выручка) дана только для ориентира — менять её не нужно."],
        ["После заполнения сохраните файл и загрузите его обратно в раздел «Каталог товаров»."],
        [""],
        ["Пример: если 1 штука товара обходится вам в 250 ₽ — впишите в cost_price число 250."],
      ]);
      instr["!cols"] = [{ wch: 96 }];
      if (instr["A1"]) instr["A1"].s = { font: { bold: true, sz: 14 } };
      XLSX.utils.book_append_sheet(wb, instr, "Инструкция");

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

          {/* Кнопка раскрытия таблицы товаров */}
          <button
            type="button"
            className={"pb-toggle" + (tableOpen ? " open" : "")}
            aria-expanded={tableOpen}
            aria-controls="pb-products-table"
            onClick={() => setTableOpen((v) => !v)}
          >
            {tableOpen ? "Скрыть товары" : "Показать товары"}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {/* Таблица результатов — сворачиваемая */}
          <div className={"pb-collapse" + (tableOpen ? " open" : "")}>
            <div className="pb-collapse-inner">
              <div
                id="pb-products-table"
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
            </div>
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
                {topProfitable.length === 0 ? (
                  <div className="pba-hero-empty">Нет данных</div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={"pb-toggle" + (profitableOpen ? " open" : "")}
                      aria-expanded={profitableOpen}
                      aria-controls="pba-profitable-table"
                      onClick={() => setProfitableOpen((v) => !v)}
                    >
                      {profitableOpen
                        ? "Скрыть прибыльные товары"
                        : "Показать прибыльные товары"}
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    <div
                      className={"pb-collapse" + (profitableOpen ? " open" : "")}
                    >
                      <div className="pb-collapse-inner">
                        <div
                          id="pba-profitable-table"
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
                    </div>
                  </>
                )}
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
                  <>
                    <button
                      type="button"
                      className={"pb-toggle" + (lossesOpen ? " open" : "")}
                      aria-expanded={lossesOpen}
                      aria-controls="pba-losses-table"
                      onClick={() => setLossesOpen((v) => !v)}
                    >
                      {lossesOpen
                        ? "Скрыть товары в минус"
                        : "Показать товары в минус"}
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    <div className={"pb-collapse" + (lossesOpen ? " open" : "")}>
                      <div className="pb-collapse-inner">
                        <div
                          id="pba-losses-table"
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
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {!loading && !loadError && (
        <section className={"pbm" + (missing.length > 0 ? " pbm-alert" : "")}>
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
            <div className="pbm-cta" role="note">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <span>
                Заполните себестоимость этих товаров, чтобы <b>M-PROF</b> точно
                рассчитал чистую прибыль.
              </span>
            </div>
          )}

          {missing.length > 0 && (
            <p className="pbm-hint">
              Введите <b>себестоимость одной единицы товара</b> — за 1 шт., не за
              всю партию и не за оборот — и нажмите «Сохранить». Можно сохранить
              все строки сразу. Как альтернатива — скачайте файл, заполните{" "}
              <span className="pbm-hint-k">cost_price</span> и загрузите в «Каталог
              товаров».
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
            <>
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
                  <span role="columnheader" className="pbm-num">
                    Кол-во
                  </span>
                  <span role="columnheader" className="pbm-cost-h">
                    Себестоимость за 1 шт.
                  </span>
                </div>
                {missing.map((r, i) => {
                  const key = normArticle(r.article);
                  const saving = savingKey === key;
                  const valid =
                    parseCostInput(costDraft[key] ?? "") !== null;
                  const err = rowError[key];
                  return (
                    <div className="pbm-row" role="row" key={key + "#" + i}>
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
                      <span
                        className="pbm-cell pbm-num"
                        role="cell"
                        data-label="Кол-во"
                      >
                        {r.quantity}
                      </span>
                      <span
                        className="pbm-cell pbm-c-cost"
                        role="cell"
                        data-label="Себестоимость за 1 шт."
                      >
                        <span className="pbm-cost-ctl">
                          <input
                            type="text"
                            inputMode="decimal"
                            className="pbm-cost-input"
                            placeholder="за 1 шт."
                            value={costDraft[key] ?? ""}
                            disabled={saving || bulkSaving || !user}
                            aria-label={`Себестоимость за 1 шт. для ${r.article}`}
                            onChange={(e) =>
                              setCostDraft((p) => ({
                                ...p,
                                [key]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && valid) saveOne(r);
                            }}
                          />
                          <button
                            type="button"
                            className="pbm-cost-save"
                            onClick={() => saveOne(r)}
                            disabled={saving || bulkSaving || !valid || !user}
                          >
                            {saving ? "…" : "Сохранить"}
                          </button>
                        </span>
                        {err && <span className="pbm-cost-err">{err}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="pbm-bulk-bar">
                <span className="pbm-bulk-note">
                  Себестоимость — за 1 единицу товара.
                </span>
                <button
                  type="button"
                  className="pbm-bulk"
                  onClick={saveAllFilled}
                  disabled={
                    bulkSaving ||
                    savingKey !== null ||
                    !user ||
                    missing.every(
                      (m) =>
                        parseCostInput(
                          costDraft[normArticle(m.article)] ?? ""
                        ) === null
                    )
                  }
                >
                  {bulkSaving ? "Сохраняем…" : "Сохранить себестоимость"}
                </button>
              </div>
            </>
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

        .pb-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          min-height: 46px;
          margin-top: 1.1rem;
          padding: 0 18px;
          font-family: var(--sans);
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--txt2);
          cursor: pointer;
          border: 1px solid var(--edge2);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.03);
          transition: color 0.18s ease, border-color 0.18s ease,
            background 0.18s ease;
        }
        .pb-toggle:hover {
          color: var(--gold2);
          border-color: var(--gold);
          background: var(--gold-bg);
        }
        .pb-toggle svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          stroke-width: 2.2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          transition: transform 0.3s ease;
        }
        .pb-toggle.open svg {
          transform: rotate(180deg);
        }
        /* Плавное сворачивание: grid 0fr → 1fr, контент скрывается overflow.
           Расчёты не трогаются — строки всегда в DOM, меняется только высота. */
        .pb-collapse {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows 0.32s ease;
        }
        .pb-collapse.open {
          grid-template-rows: 1fr;
        }
        .pb-collapse-inner {
          overflow: hidden;
          min-height: 0;
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
        .pbm-alert {
          border-color: rgba(201, 168, 76, 0.45);
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24),
            0 0 0 1px rgba(201, 168, 76, 0.14),
            0 0 48px rgba(201, 168, 76, 0.1);
        }
        .pbm-cta {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          margin-top: 1.1rem;
          padding: 0.95rem 1.15rem;
          border: 1px solid rgba(201, 168, 76, 0.4);
          border-left: 3px solid var(--gold);
          border-radius: 12px;
          background: linear-gradient(
            135deg,
            rgba(201, 168, 76, 0.16) 0%,
            rgba(201, 168, 76, 0.05) 100%
          );
          color: var(--txt);
          font-size: 0.95rem;
          font-weight: 500;
          line-height: 1.45;
        }
        .pbm-cta svg {
          width: 22px;
          height: 22px;
          stroke: var(--gold);
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .pbm-cta b {
          color: var(--gold2);
          font-weight: 700;
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
          grid-template-columns: 140px 1fr 110px 64px 224px;
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
        .pbm-cost-h {
          text-align: left;
        }
        .pbm-c-cost {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .pbm-cost-ctl {
          display: flex;
          gap: 0.4rem;
          align-items: stretch;
        }
        .pbm-cost-input {
          width: 100%;
          min-width: 0;
          padding: 0.4rem 0.55rem;
          border-radius: 8px;
          border: 1px solid var(--edge);
          background: rgba(0, 0, 0, 0.18);
          color: var(--txt);
          font-family: var(--mono);
          font-size: 0.84rem;
          outline: none;
          transition: border-color 0.16s ease, box-shadow 0.16s ease;
        }
        .pbm-cost-input:focus {
          border-color: var(--gold2);
          box-shadow: 0 0 0 2px rgba(201, 168, 76, 0.18);
        }
        .pbm-cost-input:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .pbm-cost-save {
          flex: 0 0 auto;
          padding: 0.4rem 0.7rem;
          border-radius: 8px;
          border: 1px solid var(--gold2);
          background: rgba(201, 168, 76, 0.16);
          color: var(--gold2);
          font-weight: 700;
          font-size: 0.78rem;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.16s ease, opacity 0.16s ease;
        }
        .pbm-cost-save:hover:not(:disabled) {
          background: rgba(201, 168, 76, 0.28);
        }
        .pbm-cost-save:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .pbm-cost-err {
          font-size: 0.72rem;
          color: var(--red, #e5484d);
        }
        .pbm-bulk-bar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.9rem;
          flex-wrap: wrap;
          margin-top: 1rem;
        }
        .pbm-bulk-note {
          font-size: 0.78rem;
          color: var(--txt3);
        }
        .pbm-bulk {
          padding: 0.6rem 1.1rem;
          border-radius: 10px;
          border: 1px solid var(--gold2);
          background: rgba(201, 168, 76, 0.18);
          color: var(--gold2);
          font-weight: 700;
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 0.16s ease, opacity 0.16s ease;
        }
        .pbm-bulk:hover:not(:disabled) {
          background: rgba(201, 168, 76, 0.3);
        }
        .pbm-bulk:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .pbm-c-art::before,
        .pbm-c-name::before,
        .pbm-cell.pbm-num::before,
        .pbm-c-cost::before {
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
        /* Та же кнопка/анимация «Показать товары» внутри аналитики: убираем
           верхний отступ кнопки под подзаголовком и даём таблице воздух при
           раскрытии (отступ скрывается вместе с содержимым). */
        .pba-section .pb-toggle {
          margin-top: 0;
        }
        .pba-section .pb-collapse-inner {
          padding-top: 0.8rem;
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
          .pbm-c-cost {
            grid-column: 1 / -1;
          }
          .pbm-num {
            text-align: left;
            justify-self: start;
          }
          .pbm-c-art::before,
          .pbm-c-name::before,
          .pbm-cell.pbm-num::before,
          .pbm-c-cost::before {
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
