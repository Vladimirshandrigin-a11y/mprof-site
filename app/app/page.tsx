"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { User } from "@supabase/supabase-js"
import { AnalyticsBlock } from "./components/AnalyticsBlock"
import { ProductCatalog } from "./components/ProductCatalog"
import {
  OzonProductBreakdown,
  type KeyProductsSnapshot,
  type CostCoverageSnapshot,
} from "./components/OzonProductBreakdown"
import { TariffModal, type TariffTier } from "../components/TariffModal"
import { useEntitlements } from "./lib/entitlements"
import {
  parseOzonFinanceTaxonomy,
  hasFinanceTaxonomyObject,
  type FlatContext as OzonTaxonomyFlatContext,
  type OzonTaxonomyView,
} from "./lib/ozon-finance-taxonomy-view"
import {
  supabase,
  saveCalculationToCloud,
  updateCalculationInCloud,
  loadCalculationsFromCloud,
  deleteCalculationFromCloud,
  clearCalculationsFromCloud,
  saveUploadedReportToCloud,
  loadUploadedReportsFromCloud,
  saveReportHistoryToCloud,
  type CloudCalculation,
  type CalcMode as CloudCalcMode,
} from "./lib/supabase-cloud"
import {
  parseOzonReport,
  type OzonDebugInfo,
  type OzonProductRow,
  type OzonEstimate,
} from "./lib/report-parsers/ozon-parser"
import {
  parseUpdPdf,
  type UpdDebugInfo,
} from "./lib/report-parsers/upd-pdf-parser"

// Supabase client импортируется из lib/supabase-cloud (единый instance,
// fallback на placeholder URL/key, browser-only warning при отсутствии env).

// ---------------------------------------------------------------------------
// Ozon Performance API — временно СКРЫТ из интерфейса (флаг = false).
//
// Почему скрыт: расходы «Продвижение и реклама» уже полностью учитываются через
// Ozon Seller API / finance operations и уже уменьшают чистую прибыль (сидят в
// бакетах other/services суммы операций). Performance API — это ОТДЕЛЬНЫЙ реестр
// Ozon (справочный) и в расчёт прибыли НЕ входит. Для первых пользователей блок
// путал: мог показывать 0 ₽, хотя рекламные списания уже есть в Seller finance.
//
// Скрыт ТОЛЬКО UI-блок в кабинете. Backend НЕ тронут: роуты /api/ozon/performance/*,
// библиотеки Performance, сохранённые подключения и таблицы остаются как есть —
// вернуть блок можно, поставив флаг обратно в true.
const SHOW_PERFORMANCE_API_BLOCK = false;

// Показ технической диагностики «Диагностика отчёта реализации Ozon» в кабинете.
// Скрыт (false) перед рекламным запуском: это read-only справочная диагностика для
// разработчика (сырой ответ отчёта о реализации, сверка идентификаторов, candidate
// COGS и т.п.). Обычному пользователю она не нужна и только путала. Скрыт ТОЛЬКО
// UI-блок — логика расчёта/сохранения/себестоимости не затронута; вернуть блок можно,
// поставив флаг обратно в true.
const SHOW_REALIZATION_DIAGNOSTIC = false;

/** Локальный id для расчётов, которые не попали в облако (offline/DEV). */
function makeLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "local-" + crypto.randomUUID();
  }
  return "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/** Mapping облачной строки в локальный CalcResult shape (используется в UI). */
function cloudToLocal(c: CloudCalculation): CalcResult {
  const created = new Date(c.created_at);
  return {
    id: c.id,
    marketplace: c.marketplace,
    revenue: Number(c.revenue) || 0,
    commission: Number(c.commission) || 0,
    logistics: Number(c.logistics) || 0,
    storage: Number(c.storage) || 0,
    ads: Number(c.ads) || 0,
    cost: Number(c.cost) || 0,
    tax: Number(c.tax) || 0,
    other: Number(c.other_expenses) || 0,
    expenses: Number(c.total_expenses) || 0,
    profit: Number(c.profit) || 0,
    margin: Number(c.margin) || 0,
    date: created.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    createdAt: c.created_at,
    synced: true,
    aiInsights: c.ai_insights ?? null,
    mode: c.mode,
  };
}

type Marketplace = "ozon" | "wb";

interface CalcResult {
  id: string;
  marketplace: Marketplace;
  revenue: number;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  cost: number;
  tax: number;
  other: number;
  expenses: number;
  profit: number;
  margin: number;
  date: string;
  createdAt: string;
  /** true — запись пришла из/попала в Supabase; false — локальная (DEV/offline). */
  synced: boolean;
  /** Разбор net-profit 3-file расчёта (из calculations.ai_insights) — чтобы
   *  клик по истории мог восстановить combinedResult + profitInputs. */
  aiInsights?: unknown;
  /** Тип расчёта из облака ("api" | "manual" | "upload"). Только для фильтра
   *  по типу во вкладке «Отчёты»; на формулы и сохранение НЕ влияет. */
  mode?: CloudCalcMode;
}

/** Структура, которую пишем в calculations.ai_insights для 3-file расчётов. */
type NetProfitBreakdown = {
  kind: "net-profit-3file";
  roi: number;
  taxPercent: number;
  costPrice: number;
  tax: number;
  ads: number;
  packaging: number;
  deliveryToWarehouse: number;
  salary: number;
  other: number;
  updServicesTotal: number;
  updCommissionTotal: number;
  revenueOzon: number;
  loyaltyPayouts: number;
  profitBeforeCost: number;
  /** Выбранный график выплат Ozon (jsonb — без миграции схемы). Старые записи
   *  без поля восстанавливаются как «стандартный» (0%). */
  payoutSchedule?: PayoutSchedule;
  /** Денормализованная корректировка прибыли от графика (для истории/PDF). */
  payoutScheduleAdjustment?: number;
  /** Период отчёта (строка из XLSX) — чтобы report_month восстанавливался. */
  reportPeriod?: string | null;
  /**
   * Per-SKU строки отчёта (артикул/название/выручка/кол-во). Нужны, чтобы при
   * восстановлении расчёта из «Последних расчётов» заново сопоставить товары с
   * АКТУАЛЬНЫМ каталогом и пересчитать себестоимость (COGS). Optional —
   * старые записи без этого поля восстанавливаются по агрегатам, как раньше.
   */
  products?: OzonProductRow[];
  /** Тоталы отчёта (estimate) — источник распределяемых расходов для пересчёта. */
  estimate?: OzonEstimate | null;
};

/** Безопасно достаёт NetProfitBreakdown из ai_insights (jsonb → unknown). */
function asNetProfitBreakdown(v: unknown): NetProfitBreakdown | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "net-profit-3file") return null;
  const n = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;
  return {
    kind: "net-profit-3file",
    roi: n(o.roi),
    taxPercent: n(o.taxPercent),
    costPrice: n(o.costPrice),
    tax: n(o.tax),
    ads: n(o.ads),
    packaging: n(o.packaging),
    deliveryToWarehouse: n(o.deliveryToWarehouse),
    salary: n(o.salary),
    other: n(o.other),
    updServicesTotal: n(o.updServicesTotal),
    updCommissionTotal: n(o.updCommissionTotal),
    revenueOzon: n(o.revenueOzon),
    loyaltyPayouts: n(o.loyaltyPayouts),
    profitBeforeCost: n(o.profitBeforeCost),
    payoutSchedule: asPayoutSchedule(o.payoutSchedule),
    payoutScheduleAdjustment: n(o.payoutScheduleAdjustment),
    reportPeriod: typeof o.reportPeriod === "string" ? o.reportPeriod : null,
    products: Array.isArray(o.products)
      ? o.products
          .map((r): OzonProductRow | null => {
            if (!r || typeof r !== "object") return null;
            const rr = r as Record<string, unknown>;
            return {
              article: typeof rr.article === "string" ? rr.article : "",
              name: typeof rr.name === "string" ? rr.name : "",
              revenue: n(rr.revenue),
              quantity: n(rr.quantity),
            };
          })
          .filter((x): x is OzonProductRow => x !== null)
      : [],
    estimate:
      o.estimate && typeof o.estimate === "object"
        ? ((): OzonEstimate => {
            const e = o.estimate as Record<string, unknown>;
            return {
              revenue: n(e.revenue),
              commission: n(e.commission),
              logistics: n(e.logistics),
              storage: n(e.storage),
              ads: n(e.ads),
              tax: n(e.tax),
              cost: n(e.cost),
              other: n(e.other),
            };
          })()
        : null,
  };
}

/** Тип строки мини-разбивки в «Последних расчётах». */
type HistDetailRow = {
  label: string;
  /** Значение (число) или null → данных нет, показываем «—». */
  value: number | null;
  /** Тип строки: доход (зелёный +), расход (красный −), подытог (нейтральный),
   *  итог (выделенный) или нейтральная строка (например, нулевой график). */
  kind: "income" | "expense" | "subtotal" | "total" | "neutral";
};

/**
 * Строит мини-разбивку расчёта для раскрытия строки в «Последних расчётах».
 * ТОЛЬКО отображение уже сохранённых данных — ничего не пересчитывает.
 *   • Отчёт Ozon (есть breakdown из ai_insights) → полная разбивка по ТЗ.
 *   • Ручной расчёт (breakdown=null) → разбивка из полей CalcResult (нулевые
 *     расходы скрываются). Старые записи без части полей не ломаются: парсер
 *     уже коалесцирует отсутствующие числа в 0.
 */
/**
 * Честная taxonomy-разбивка API-расчёта из ai_insights.financeTaxonomy (PR B).
 * Только для mode==="api" и только если снапшот валиден и сходится со stored
 * total_expenses. Иначе null → вызывающий использует старый flat-fallback.
 * Ничего не пересчитывает и не мутирует запись.
 */
function ozonTaxonomyView(h: CalcResult): OzonTaxonomyView | null {
  if (h.mode !== "api") return null;
  const flat: OzonTaxonomyFlatContext = {
    commission: Number(h.commission) || 0,
    logistics: Number(h.logistics) || 0,
    ads: Number(h.ads) || 0,
    storage: Number(h.storage) || 0,
    other: Number(h.other) || 0,
    cost: Number(h.cost) || 0,
    tax: Number(h.tax) || 0,
    totalExpenses: Number(h.expenses) || 0,
  };
  return parseOzonFinanceTaxonomy(h.aiInsights, flat);
}

/**
 * fail-closed guard: расчёт НЕЛЬЗЯ безопасно открыть в калькуляторе? Блокируем
 * (показ warning, форма не меняется) ТОЛЬКО реально небезопасные API-случаи:
 *   • есть объект financeTaxonomy, но провалидированная view не строится
 *     (битый/несводимый снапшот) — доверять такому нельзя;
 *   • снапшота нет, но flat other < 0 (старый API с нетто-компенсациями, который
 *     нельзя показать положительным ручным расходом).
 * Валидный API-taxonomy расчёт (view строится) открывается в режиме просмотра.
 * Manual/upload и старый API с неотрицательным other загружаются как раньше.
 */
function isApiCalcUnsafeToLoad(h: CalcResult): boolean {
  if (h.mode !== "api") return false;
  if (hasFinanceTaxonomyObject(h.aiInsights)) return ozonTaxonomyView(h) === null;
  return (Number(h.other) || 0) < 0;
}

/**
 * Годовые агрегаты для честной taxonomy-модели отчётов (PR B). Чистая функция:
 * для каждой записи берёт gross charges/income из валидной financeTaxonomy, иначе
 * flat. Без double count. Вынесена из useMemo, чтобы не раздувать render-компонент.
 */
function aggregateReportsTaxonomy(items: CalcResult[]): {
  logisticsCharges: number;
  adsCharges: number;
  otherCharges: number;
  manualExtraExpenses: number;
  ozonIncome: number;
} {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  let lc = 0;
  let ac = 0;
  let oc = 0;
  let me = 0;
  let inc = 0;
  for (const h of items) {
    const tv = ozonTaxonomyView(h);
    if (tv) {
      lc += tv.logisticsCharges;
      ac += tv.adsCharges;
      oc += tv.otherCharges;
      me += tv.manualExtraExpenses;
      inc += tv.ozonIncome;
    } else {
      // Старая запись без валидной taxonomy: flat один раз, без выдуманного дохода
      // и без выдуманных ручных доп-расходов.
      lc += Number(h.logistics) || 0;
      ac += Number(h.ads) || 0;
      oc += Number(h.other) || 0;
    }
  }
  return {
    logisticsCharges: round2(lc),
    adsCharges: round2(ac),
    otherCharges: round2(oc),
    manualExtraExpenses: round2(me),
    ozonIncome: round2(inc),
  };
}

function buildHistDetailRows(
  h: CalcResult,
  breakdown: NetProfitBreakdown | null
): HistDetailRow[] {
  if (breakdown) {
    const b = breakdown;
    const otherExpenses =
      b.ads + b.packaging + b.deliveryToWarehouse + b.salary + b.other;
    // График выплат: скидка (>0) — доход/зелёный, комиссия (<0) — расход/красный,
    // стандартный (0) — нейтральный. Уже сохранённое значение, не пересчитываем.
    const adj = b.payoutScheduleAdjustment ?? 0;
    const adjKind: HistDetailRow["kind"] =
      adj > 0 ? "income" : adj < 0 ? "expense" : "neutral";
    const taxLabel =
      b.taxPercent > 0
        ? `Налог (${b.taxPercent.toLocaleString("ru-RU", {
            maximumFractionDigits: 2,
          })}%)`
        : "Налог";
    return [
      { label: "Выручка Ozon", value: b.revenueOzon, kind: "income" },
      {
        label: "Выплаты от партнёров",
        value: b.loyaltyPayouts,
        kind: "income",
      },
      {
        label: "Расходы Ozon по УПД",
        value: b.updServicesTotal,
        kind: "expense",
      },
      {
        label: "Агентское вознаграждение",
        value: b.updCommissionTotal,
        kind: "expense",
      },
      {
        label: "Прибыль до себестоимости",
        value: b.profitBeforeCost,
        kind: "subtotal",
      },
      { label: "Себестоимость", value: b.costPrice, kind: "expense" },
      { label: taxLabel, value: b.tax, kind: "expense" },
      { label: "Прочие расходы", value: otherExpenses, kind: "expense" },
      { label: "График выплат Ozon", value: adj, kind: adjKind },
      { label: "Итоговая чистая прибыль", value: h.profit, kind: "total" },
    ];
  }
  // API-расчёт с валидной taxonomy (PR B): честная gross-разбивка расходов +
  // отдельная зелёная строка доходов-компенсаций. Не показываем сырой
  // отрицательный other; итог берём из stored profit (ничего не пересчитываем).
  const tv = ozonTaxonomyView(h);
  if (tv) {
    const trows: HistDetailRow[] = [
      { label: "Выручка", value: h.revenue, kind: "income" },
    ];
    const pushExp = (label: string, value: number) => {
      if (value > 0) trows.push({ label, value, kind: "expense" });
    };
    pushExp("Комиссия маркетплейса", h.commission);
    pushExp("Логистика", tv.logisticsCharges);
    pushExp("Реклама и продвижение", tv.adsCharges);
    pushExp("Хранение", tv.storage);
    pushExp("Прочие расходы Ozon", tv.otherCharges);
    // Дополнительные ручные расходы (packaging/warehouse/salary/manual other),
    // сидящие в flat other. Отдельная строка — не мешать с «Прочие расходы Ozon».
    pushExp("Дополнительные расходы", tv.manualExtraExpenses);
    pushExp("Себестоимость", h.cost);
    pushExp("Налог", h.tax);
    if (tv.ozonIncome > 0) {
      trows.push({
        label: "Корректировки и компенсации Ozon",
        value: tv.ozonIncome,
        kind: "income",
      });
    }
    trows.push({ label: "Чистая прибыль", value: h.profit, kind: "total" });
    return trows;
  }

  // Ручной расчёт: доход + ненулевые расходы + итог.
  const rows: HistDetailRow[] = [
    { label: "Выручка", value: h.revenue, kind: "income" },
  ];
  const manualExpenses: [string, number][] = [
    ["Комиссия", h.commission],
    ["Логистика", h.logistics],
    ["Хранение", h.storage],
    ["Реклама", h.ads],
    ["Налог", h.tax],
    ["Себестоимость", h.cost],
    ["Прочие расходы", h.other],
  ];
  for (const [label, value] of manualExpenses) {
    if (value > 0) rows.push({ label, value, kind: "expense" });
  }
  rows.push({ label: "Чистая прибыль", value: h.profit, kind: "total" });
  return rows;
}

/**
 * Извлекает месяц отчёта из ПРОИЗВОЛЬНОГО текста (строка периода из XLSX,
 * report_period или ИМЯ ФАЙЛА Ozon) и нормализует в первое число месяца
 * 'YYYY-MM-01' — формат колонки report_history.report_month (тип date в БД;
 * MonthlyAnalytics группирует записи по 'YYYY-MM' = report_month.slice(0, 7)).
 * Возвращает null, если месяц распознать НЕ удалось.
 *
 * Поддерживаемые форматы (всё → 'YYYY-MM-01'):
 *   диапазон   «01.04.2026 - 30.04.2026», «01.04.2026 — 30.04.2026»,
 *              «01.04.2026 по 30.04.2026»  → берём месяц КОНЕЧНОЙ даты;
 *   компактный «20260430», в т.ч. внутри имени файла
 *              «Отчет о реализации товара_20260430.xlsx»,
 *              «Отчет о реализации товара_20260430 2.xlsx»;
 *   ISO        «2026-04-30», «2026/04», «2026.04» (год впереди);
 *   ДД.ММ.ГГГГ «30.04.2026» (день впереди);
 *   русские    «Апрель 2026», «за апрель 2026».
 *
 * Почему месяц КОНЕЧНОЙ даты диапазона: отчёт Ozon за месяц имеет период вида
 * 01.04.2026–30.04.2026 — обе даты в одном месяце, результат однозначен. Если
 * период вдруг пересекает два месяца, конечная дата вернее отражает, к какому
 * расчётному месяцу относятся выручка и выплаты.
 */
function extractReportMonthFromText(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = text.toLowerCase();
  // Собрать 'YYYY-MM-01' с валидацией номера месяца (отсекает мусор вроде 99).
  const mk = (year: string, month: number): string | null =>
    month >= 1 && month <= 12 ? `${year}-${pad(month)}-01` : null;

  // 1) Диапазон ДД.ММ.ГГГГ … ДД.ММ.ГГГГ → месяц КОНЕЧНОЙ даты (группы 4,5,6).
  const range = p.match(
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\s*(?:-|—|–|по|до|to)\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/
  );
  if (range) {
    const res = mk(range[6], Number(range[5]));
    if (res) return res;
  }

  // 2) Компактный YYYYMMDD (в т.ч. в имени файла «_20260430.xlsx»).
  const compact = p.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) {
    const res = mk(compact[1], Number(compact[2]));
    if (res) return res;
  }

  // 3) ISO — год впереди: 2026-04-30 / 2026/04 / 2026.04.
  const iso = p.match(/(20\d{2})[-./](\d{1,2})/);
  if (iso) {
    const res = mk(iso[1], Number(iso[2]));
    if (res) return res;
  }

  // 4) Одиночная ДД.ММ.ГГГГ — день впереди: 30.04.2026.
  const dmy = p.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/);
  if (dmy) {
    const res = mk(dmy[3], Number(dmy[2]));
    if (res) return res;
  }

  // 5) Русские месяцы (порядок основ важен: специфичные раньше короткой «ма»).
  const MONTHS = [
    "январ", "феврал", "март", "апрел", "ма", "июн", "июл",
    "август", "сентябр", "октябр", "ноябр", "декабр",
  ];
  const yearM = p.match(/20\d{2}/);
  if (yearM) {
    for (let i = 0; i < MONTHS.length; i++) {
      if (p.includes(MONTHS[i])) return mk(yearM[0], i + 1);
    }
  }

  return null;
}

/**
 * Определяет месяц отчёта ('YYYY-MM-01') по ПРИОРИТЕТУ источников:
 *   1) период отчёта из XLSX / combinedResult (parsePeriod → combinedResult.period);
 *   2) имя XLSX-файла Ozon («Отчет о реализации товара_20260430.xlsx»).
 * Возвращает null, если ни один источник не дал месяц.
 *
 * ВАЖНО — почему больше НЕ подставляем текущий месяц: раньше при нераспознанном
 * периоде месяц МОЛЧА заменялся на текущий. Это ломало «Аналитику по месяцам»:
 * три отчёта (апрель/май/июнь), залитые в одну сессию, получали ОДИН и тот же
 * report_month (месяц загрузки) → MonthlyAnalytics видел один месяц → график
 * динамики не строился (для графика нужно ≥2 разных месяцев). Теперь при неудаче
 * возвращаем null, и вызывающий код НЕ пишет фейковый месяц как реальный.
 */
function resolveReportMonth(
  period: string | null | undefined,
  fileName?: string | null
): string | null {
  return (
    extractReportMonthFromText(period) ??
    extractReportMonthFromText(fileName) ??
    null
  );
}

// Русские названия месяцев (именительный) — для подписи фильтра по месяцам.
const RU_MONTHS_NOM = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
/** 'YYYY-MM' → 'Июнь 2026'. При неожиданном формате — исходная строка. */
function formatMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const mi = Number(m[2]) - 1;
  return `${RU_MONTHS_NOM[mi] ?? m[2]} ${m[1]}`;
}
/**
 * Месяц 'YYYY-MM' из API-снимка Ozon (ai_insights.kind === "ozon-api-v1").
 * Бэкенд /api/ozon/save-calculation пишет ВЫБРАННЫЙ месяц в period.month
 * (строка 'YYYY-MM'); если его нет — аккуратно достаём месяц из period.dateTo,
 * затем period.dateFrom (ISO-даты конца/начала диапазона — обе в одном месяце).
 * Возвращает null, если это не API-снимок или месяц не распознан. ОТДЕЛЬНЫЙ
 * парсер (НЕ asNetProfitBreakdown), чтобы не задеть upload-логику. Чисто
 * UI-деривация: формулы, сохранение и Supabase не затрагивает.
 */
function apiSnapshotMonthKey(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "ozon-api-v1") return null;
  if (!o.period || typeof o.period !== "object") return null;
  const p = o.period as Record<string, unknown>;
  // 1) period.month — каноничный источник ('YYYY-MM').
  if (typeof p.month === "string" && /^\d{4}-\d{2}$/.test(p.month)) {
    return p.month;
  }
  // 2) fallback: месяц из конечной/начальной даты диапазона (обе в одном месяце).
  const fromText = (s: unknown): string | null => {
    const ym = extractReportMonthFromText(typeof s === "string" ? s : null);
    return ym ? ym.slice(0, 7) : null;
  };
  return fromText(p.dateTo) ?? fromText(p.dateFrom) ?? null;
}

/**
 * Месяц расчёта 'YYYY-MM' из снимка ai_insights (для фильтра/группировки в
 * истории и «Отчётах»). Порядок источников:
 *   1) upload-снимок (net-profit-3file) — строка периода отчёта (reportPeriod);
 *   2) API-снимок (ozon-api-v1) — ВЫБРАННЫЙ месяц из period.month;
 *   3) иначе null (ручной/старый расчёт — месяц добирается из createdAt уже в calcMonthKey).
 * null — период не распознан. Чисто UI-деривация: на формулы, статистику,
 * Supabase и сохранение report_history не влияет.
 */
function histReportMonthKey(h: CalcResult): string | null {
  // 1) upload-снимок: месяц из строки периода отчёта (как раньше).
  const b = asNetProfitBreakdown(h.aiInsights);
  if (b) {
    const ym = resolveReportMonth(b.reportPeriod, null); // 'YYYY-MM-01' | null
    if (ym) return ym.slice(0, 7);
  }
  // 2) API-снимок: ВЫБРАННЫЙ месяц из period.month (НЕ месяц создания).
  const apiYm = apiSnapshotMonthKey(h.aiInsights);
  if (apiYm) return apiYm;
  return null;
}

/**
 * Месяц расчёта 'YYYY-MM' для вкладки «Отчёты»: приоритет — отчётный месяц
 * (из периода отчёта), иначе месяц создания записи. null — месяц не определить.
 * Чисто UI-деривация по уже загруженной истории: формулы, статистику, Supabase
 * и сохранение НЕ затрагивает.
 */
function calcMonthKey(h: CalcResult): string | null {
  const rep = histReportMonthKey(h);
  if (rep) return rep;
  if (h.createdAt) {
    const d = new Date(h.createdAt);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
  }
  return null;
}

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "revenue", label: "Выручка", hint: "Сумма продаж за период" },
  { key: "commission", label: "Комиссия маркетплейса" },
  { key: "logistics", label: "Логистика" },
  { key: "storage", label: "Хранение" },
  { key: "ads", label: "Реклама" },
  { key: "cost", label: "Себестоимость" },
  { key: "tax", label: "Налог" },
  { key: "other", label: "Прочие расходы" },
];

const UPLOAD_STAGES = [
  "Читаем отчёт…",
  "Анализируем продажи…",
  "Проверяем комиссии…",
  "Формируем финансовую модель…",
];

// ===== Финальный калькулятор чистой прибыли (после расчёта 3 файлов) =====
// Поля доп. расходов, которые продавец вносит вручную поверх данных из отчётов.
// Налог — единственное поле в процентах (база: выручка Ozon), остальные в ₽.
type ProfitInputs = {
  costPrice: string;
  taxPercent: string;
  ads: string;
  packaging: string;
  deliveryToWarehouse: string;
  salary: string;
  other: string;
};
const EMPTY_PROFIT: ProfitInputs = {
  costPrice: "",
  taxPercent: "",
  ads: "",
  packaging: "",
  deliveryToWarehouse: "",
  salary: "",
  other: "",
};
const PROFIT_EXPENSE_FIELDS: {
  key: keyof ProfitInputs;
  label: string;
  unit: "₽" | "%";
  hint?: string;
}[] = [
  { key: "costPrice", label: "Себестоимость товара", unit: "₽" },
  { key: "taxPercent", label: "Налог", unit: "%", hint: "Введите вашу ставку налога в процентах" },
  { key: "ads", label: "Реклама", unit: "₽" },
  { key: "packaging", label: "Упаковка", unit: "₽" },
  { key: "deliveryToWarehouse", label: "Доставка до склада", unit: "₽" },
  { key: "salary", label: "Зарплата / подрядчики", unit: "₽" },
  { key: "other", label: "Прочие расходы", unit: "₽" },
];

/* ===== График выплат Ozon (ручная настройка продавца) =====
   Ozon берёт комиссию за раннюю/ежедневную выплату или даёт скидку на
   вознаграждение за продажу при отсрочке. Это НЕ интеграция с Ozon — продавец
   выбирает свой график вручную, а M-PROF учитывает его в итоговой чистой
   прибыли (payoutScheduleAdjustment). Проценты — из тарифов Ozon; продавец
   сверяет актуальные значения с личным кабинетом. */
type PayoutScheduleType = "standard" | "early" | "deferred";
type PayoutBank = "ozon" | "other";
type PayoutEarlyVariant = "daily" | "week2" | "week1" | "nextweek";
type PayoutDeferredDays = 14 | 28 | 42 | 56 | 84 | 112 | 168;

type PayoutSchedule = {
  type: PayoutScheduleType;
  /** Под-вариант ранней выплаты (актуально при type === "early"). */
  earlyVariant: PayoutEarlyVariant;
  /** Банк получения (актуально при type === "early"). */
  bank: PayoutBank;
  /** Срок отсрочки в днях (актуально при type === "deferred"). */
  deferredDays: PayoutDeferredDays;
};

const DEFAULT_PAYOUT_SCHEDULE: PayoutSchedule = {
  type: "standard",
  earlyVariant: "daily",
  bank: "ozon",
  deferredDays: 14,
};

/** Ранняя/ежедневная выплата — КОМИССИЯ (% от суммы к перечислению, уменьшает
 *  прибыль). Ключи: ежедневная выплата + еженедельная с переносом. */
const PAYOUT_EARLY_PCT: Record<
  PayoutEarlyVariant,
  { ozon: number; other: number }
> = {
  daily: { ozon: 4.96, other: 5.99 }, // Ежедневная выплата
  week2: { ozon: 2.47, other: 2.69 }, // Через 2 недели
  week1: { ozon: 3.37, other: 3.89 }, // Через 1 неделю
  nextweek: { ozon: 4.16, other: 4.99 }, // На следующей неделе
};

/** Отсрочка выплаты — СКИДКА на вознаграждение за продажу (% от суммы к
 *  перечислению, увеличивает прибыль). */
const PAYOUT_DEFERRED_PCT: Record<PayoutDeferredDays, number> = {
  14: 0.45,
  28: 0.9,
  42: 1.35,
  56: 1.8,
  84: 2.7,
  112: 3.6,
  168: 5.4,
};

const PAYOUT_EARLY_VARIANTS: { key: PayoutEarlyVariant; label: string }[] = [
  { key: "daily", label: "Ежедневно" },
  { key: "week1", label: "Через 1 неделю" },
  { key: "week2", label: "Через 2 недели" },
  { key: "nextweek", label: "На следующей неделе" },
];

const PAYOUT_DEFERRED_OPTIONS: PayoutDeferredDays[] = [
  14, 28, 42, 56, 84, 112, 168,
];

/** Процент выбранного графика (0 для стандартного). */
function payoutPercentOf(s: PayoutSchedule): number {
  if (s.type === "early") return PAYOUT_EARLY_PCT[s.earlyVariant][s.bank];
  if (s.type === "deferred") return PAYOUT_DEFERRED_PCT[s.deferredDays];
  return 0;
}

/** Направление корректировки: комиссия уменьшает, скидка увеличивает прибыль. */
function payoutDirectionOf(s: PayoutSchedule): "fee" | "discount" | "none" {
  if (s.type === "early") return "fee";
  if (s.type === "deferred") return "discount";
  return "none";
}

/** Человекочитаемая подпись графика — для строки в разбивке и PDF. */
function payoutScheduleLabel(s: PayoutSchedule): string {
  if (s.type === "early") {
    const v =
      PAYOUT_EARLY_VARIANTS.find((x) => x.key === s.earlyVariant)?.label ?? "";
    const bank = s.bank === "ozon" ? "Ozon Банк" : "Другой банк";
    return `Ранняя выплата · ${v} · ${bank}`;
  }
  if (s.type === "deferred") return `Отсрочка ${s.deferredDays} дн.`;
  return "Стандартный";
}

/** Безопасно достаёт PayoutSchedule из jsonb (старые записи → стандартный). */
function asPayoutSchedule(v: unknown): PayoutSchedule {
  if (!v || typeof v !== "object") return { ...DEFAULT_PAYOUT_SCHEDULE };
  const o = v as Record<string, unknown>;
  const type: PayoutScheduleType =
    o.type === "early" || o.type === "deferred" ? o.type : "standard";
  const earlyVariant: PayoutEarlyVariant =
    o.earlyVariant === "week2" ||
    o.earlyVariant === "week1" ||
    o.earlyVariant === "nextweek"
      ? o.earlyVariant
      : "daily";
  const bank: PayoutBank = o.bank === "other" ? "other" : "ozon";
  const days = typeof o.deferredDays === "number" ? o.deferredDays : 14;
  const deferredDays: PayoutDeferredDays = (
    PAYOUT_DEFERRED_OPTIONS as number[]
  ).includes(days)
    ? (days as PayoutDeferredDays)
    : 14;
  return { type, earlyVariant, bank, deferredDays };
}

interface UploadedReport {
  id: string;
  filename: string;
  marketplace: "ozon" | "wb";
  profit: number;
  margin: number;
  rowsCount: number;
  period: string;
  date: string;
}

/**
 * Безопасный форматтер Supabase / PostgrestError.
 * PostgrestError — это plain object с полями на прототипе, поэтому
 * `console.error(error)` рендерит `{}`. Этот хелпер всегда возвращает
 * структурированный объект для логов + plain message для UI.
 */
function formatSupabaseError(err: unknown): {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
} {
  if (!err) return { message: "Неизвестная ошибка" };
  if (typeof err === "string") return { message: err };
  if (err instanceof Error) return { message: err.message || "Неизвестная ошибка" };
  const e = err as {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  };
  return {
    message: e.message || "Неизвестная ошибка",
    code: e.code,
    details: e.details,
    hint: e.hint,
  };
}

const AI_STAGES = [
  "Анализируем выручку…",
  "Проверяем комиссии…",
  "Считаем маржинальность…",
  "Ищем слабые места…",
  "Формируем рекомендации…",
];

const EMPTY: Record<string, string> = {
  revenue: "",
  commission: "",
  logistics: "",
  storage: "",
  ads: "",
  cost: "",
  tax: "",
  other: "",
};

const eyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const eyeOffIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.9 5.1A11.7 11.7 0 0 1 12 4.5C18.5 4.5 22.5 12 22.5 12a18 18 0 0 1-3.3 4.3M6.3 6.3A18 18 0 0 0 1.5 12s4 7.5 10.5 7.5a11.7 11.7 0 0 0 4.8-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
);

// Безопасное подключение кабинета Ozon по API (PR #1). Сырой/зашифрованный ключ
// в браузер НЕ приходит — фронт видит только статус, маску Client ID и ••••last4.
// Форму с ключом отправляем на наш сервер (Timeweb), он шифрует и хранит её.
type OzonConnStatus =
  | "not_connected"
  | "unknown"
  | "connected"
  | "invalid_key"
  | "forbidden"
  | "unavailable";

type OzonConnView = {
  connected: boolean;
  status: OzonConnStatus;
  clientIdMasked?: string;
  keyLast4?: string | null;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

// Ответ /api/ozon/connection*: безопасная проекция ИЛИ { error } при ошибке.
type OzonConnResponse = Partial<OzonConnView> & { error?: string };

// Ozon PERFORMANCE API (реклама/продвижение) — PR #43 (foundation). Отдельное
// подключение: Client ID + Client Secret. Секрет в браузер НЕ приходит — фронт
// видит только статус, маску Client ID и ••••last4. На этом этапе только проверка
// токена, в расчёт прибыли реклама ещё НЕ добавляется.
type PerfConnStatus =
  | "not_connected"
  | "unknown"
  | "active"
  | "invalid_key"
  | "forbidden"
  | "unavailable";

type PerfConnView = {
  connected: boolean;
  status: PerfConnStatus;
  clientIdMasked?: string;
  secretLast4?: string | null;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

// Ответ /api/ozon/performance/connection*: безопасная проекция ИЛИ { error }.
type PerfConnResponse = Partial<PerfConnView> & { error?: string };

// Ответ /api/ozon/performance/ads-spend-diagnostic — СПРАВОЧНЫЙ расход рекламы
// Performance API за месяц. Диагностика: в прибыль НЕ входит, никуда не сохраняется.
type AdsSpendStatus =
  | "ok"
  | "no_campaigns"
  | "pending"
  | "not_connected"
  | "invalid_connection"
  | "rate_limited"
  | "unavailable";
// Этап цепочки Performance API, на котором остановилась диагностика (без секретов).
type AdsSpendStage = "token" | "campaigns" | "statistics" | "poll" | "report";
// Человекочитаемые подписи этапов для мелкой диагностической строки под ошибкой.
const ADS_STAGE_LABELS: Record<AdsSpendStage, string> = {
  token: "получение токена",
  campaigns: "список кампаний",
  statistics: "заказ статистики",
  poll: "готовность отчёта",
  report: "загрузка отчёта",
};
type AdsSpendResult = {
  ok: boolean;
  month: string;
  adsSpend: number;
  campaignsCount: number;
  rowsCount: number;
  status: AdsSpendStatus;
  // Диагностика (без секретов/токена): этап, HTTP-код Ozon, безопасное описание.
  stage?: AdsSpendStage;
  httpStatus?: number;
  detail?: string;
  // Для rate_limited (HTTP 429): через сколько секунд безопасно повторить.
  retryAfterSec?: number;
  // true → сервер продолжил ранее заказанный отчёт (reuse pending UUID), новый
  // заказ statistics/json не создавался. Показываем мягкую подсказку на pending.
  reused?: boolean;
  error?: string;
};

// Ответ /api/ozon/postings-match-diagnostic — read-only диагностика сопоставления
// товаров Ozon (FBO+FBS) с каталогом себестоимости. Прибыль здесь НЕ считается.
type OzonPostingsMatchResponse = {
  period: { month: string; dateFrom: string; dateTo: string };
  source: string;
  totals: {
    postingCount: number;
    itemRows: number;
    uniqueOzonItems: number;
    matchedItems: number;
    unmatchedItems: number;
    matchedQuantity: number;
    unmatchedQuantity: number;
  };
  matched: Array<{
    offerId?: string;
    sku?: string;
    name?: string;
    quantity: number;
    price?: number;
    catalogProductName?: string;
    catalogCost?: number;
    matchBy: "offer_id" | "sku" | "article";
  }>;
  unmatched: Array<{
    offerId?: string;
    sku?: string;
    name?: string;
    quantity: number;
    price?: number;
    reason: string;
  }>;
  // Диагностика (read-only): разбивка сопоставленной себестоимости по статусам
  // отправлений Ozon. Боевой расчёт не меняет — только объясняет расхождение.
  costByStatus?: {
    totalMatchedCost: number;
    totalMatchedQuantity: number;
    deliveredMatchedCost: number;
    cancelledMatchedCost: number;
    nonDeliveredMatchedCost: number;
    rows: Array<{
      status: string;
      label: string;
      postingCount: number;
      itemsQuantity: number;
      matchedQuantity: number;
      unmatchedQuantity: number;
      matchedCost: number;
      shareOfMatchedCost: number;
    }>;
    notes: string[];
  };
  warnings: string[];
  notes: string[];
};

// Ответ /api/ozon/profit-draft — ПРЕДВАРИТЕЛЬНАЯ прибыль (PR #16): операции Ozon
// минус себестоимость ТОЛЬКО сопоставленных товаров. Это НЕ чистая прибыль и НЕ
// финальный расчёт — ручные расходы не вычитаются, ничего не сохраняется.
type OzonProfitDraftResponse = {
  period: { month: string; dateFrom: string; dateTo: string };
  source: string;
  status: "complete_cost" | "partial_cost" | "no_cost";
  // Источник боевой себестоимости: "realization" (отчёт о реализации Ozon).
  costSource?: "realization";
  // СПРАВОЧНАЯ себестоимость по отправлениям (postings delivered-only): показываем
  // как справку, в чистую прибыль НЕ входит. 0/undefined — отправления недоступны.
  postingsReferenceCost?: number;
  apiTotals: {
    ozonAccruals: number;
    returns: number;
    commission: number;
    logistics: number;
    services: number;
    storage: number;
    other: number;
    operationCount: number;
  };
  productCoverage: {
    uniqueOzonItems: number;
    matchedItems: number;
    unmatchedItems: number;
    matchedQuantity: number;
    unmatchedQuantity: number;
  };
  costDraft: {
    matchedCostTotal: number;
    matchedNoCostCount: number;
    itemsWithoutCost: Array<{
      offerId?: string;
      sku?: string;
      name?: string;
      quantity: number;
      reason: string;
    }>;
    topCostItems: Array<{
      offerId?: string;
      sku?: string;
      name?: string;
      quantity: number;
      costPerUnit: number;
      totalCost: number;
      matchBy: "offer_id" | "sku" | "article";
    }>;
  };
  preliminary: {
    ozonOperationsTotal: number;
    matchedCostTotal: number;
    profitBeforeManualExpenses: number;
    /** База налога API: выручка отчёта реализации за вычетом возвратов (в ₽). */
    taxRevenueBase?: number;
  };
  // PR #18 — ручные расходы (echo, в БД не сохранены) + предварительная чистая прибыль.
  manualExpenses: {
    tax: number;
    packaging: number;
    warehouseDelivery: number;
    salary: number;
    other: number;
    total: number;
  };
  netProfitPreview: {
    value: number;
    margin: number;
  };
  manualExpensesNotIncluded: string[];
  warnings: string[];
  notes: string[];
};

// Довесок к ответу /api/ozon/save-calculation — СПРАВОЧНАЯ диагностика отчёта о
// реализации Ozon (/v2/finance/realization). Read-only: candidate COGS НЕ входит в
// чистую прибыль/налог/боевую себестоимость и никуда не сохраняется — показываем,
// чтобы сверить источник себестоимости с документальным расчётом.
type RealizationDiagnostic = {
  connected: boolean;
  errorCode?: string;
  month: number;
  year: number;
  rowCount: number;
  sums: {
    saleQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    deliveryAmount: number;
    returnAmount: number;
    bonus: number;
    bankCoinvestment: number;
    stars: number;
    sellerPriceValue: number;
  };
  candidateCogs: {
    bySaleQty: number;
    byNetQty: number;
    matchedRows: number;
    unmatchedRows: number;
    matchedNoCostRows: number;
    matchedSaleQuantity: number;
    unmatchedSaleQuantity: number;
  };
  fieldsPresent: {
    offerId: boolean;
    productId: boolean;
    barcode: boolean;
    deliveryQuantity: boolean;
    returnQuantity: boolean;
    deliveryAmount: boolean;
    returnAmount: boolean;
    sellerPricePerInstance: boolean;
    bonus: boolean;
    bankCoinvestment: boolean;
    stars: boolean;
  };
  // Диагностика структуры ответа: реальные имена ключей rows[0] и где лежит
  // идентификатор товара (item.offer_id vs offer_id). Только имена/типы, без значений.
  debug: {
    rowKeys: string[];
    nestedKeys: Array<{ key: string; keys: string[] }>;
    identifierScan: Array<{ path: string; type: string; present: boolean }>;
    hasNestedItem: boolean;
    resolvedOfferIdPath: string | null;
  };
  sample: Array<{
    offerId: string;
    productName: string;
    saleQty: number;
    returnQty: number;
    matched: boolean;
    costPerUnit: number | null;
  }>;
  notes: string[];
  warnings: string[];
};

// Ответ /api/ozon/import-missing-products — добавление НЕсопоставленных товаров
// Ozon в каталог себестоимости (PR #17). Только INSERT новых товаров
// (sku = offer_id, cost_price = 0). Себестоимость НЕ выдумывается, расчёт НЕ
// запускается и НЕ сохраняется — пользователь заполняет cost вручную.
type OzonImportMissingResponse = {
  period: { month: string; dateFrom: string; dateTo: string };
  source: string;
  totals: {
    unmatchedFromOzon: number;
    eligibleToImport: number;
    created: number;
    skippedExisting: number;
    skippedNoOfferId: number;
  };
  created: Array<{ sku: string; name: string; costPrice: number | null }>;
  skipped: Array<{
    offerId?: string;
    sku?: string;
    name?: string;
    reason: string;
  }>;
  warnings: string[];
  notes: string[];
};

// Месяц по умолчанию для черновика — ПРОШЛЫЙ месяц (за него данные уже полные).
// Формат "YYYY-MM" для нативного <input type="month">. Считаем в UTC, без смещения.
function defaultDraftMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ISO-дата (например, profiles.premium_until) → "DD.MM.YYYY". Пустая строка,
// если строку не удалось распарсить — вызывающий код тогда дату не показывает.
function formatRuDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Технические тексты ошибок Supabase Auth (английские) → понятные сообщения на
// русском. Supabase отдаёт error.message строкой; сверяем по подстроке, чтобы не
// зависеть от точной формулировки/версии.
function authErrorRu(message: string): string {
  const m = (message || "").toLowerCase();
  if (m.includes("invalid login credentials") || m.includes("invalid credentials"))
    return "Неверный email или пароль.";
  if (m.includes("email not confirmed"))
    return "Email не подтверждён. Проверьте почту и перейдите по ссылке.";
  if (
    m.includes("already registered") ||
    m.includes("already been registered") ||
    m.includes("user already exists")
  )
    return "Пользователь с таким email уже существует. Попробуйте войти.";
  if (
    m.includes("password should be at least") ||
    m.includes("weak password") ||
    m.includes("password is too short")
  )
    return "Пароль слишком короткий — минимум 6 символов.";
  if (
    m.includes("unable to validate email") ||
    m.includes("invalid email") ||
    m.includes("invalid format")
  )
    return "Некорректный email.";
  if (m.includes("rate limit") || m.includes("too many requests"))
    return "Слишком много попыток. Подождите немного и попробуйте снова.";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("fetch"))
    return "Ошибка соединения. Проверьте интернет и попробуйте ещё раз.";
  return message || "Не удалось выполнить вход. Попробуйте ещё раз.";
}

// Ошибки именно ВХОДА (signInWithPassword) → понятные русские сообщения.
// Отдельно от authErrorRu (им пользуется регистрация), чтобы тексты входа были
// ровно те, что нужны, и правка не задевала signUp. Сверяем по подстроке —
// не зависим от точной формулировки/версии Supabase.
function loginErrorRu(message: string): string {
  const m = (message || "").toLowerCase();
  if (m.includes("invalid login credentials") || m.includes("invalid credentials"))
    return "Неверный email или пароль.";
  if (
    m.includes("logins are disabled") ||
    m.includes("login is disabled") ||
    m.includes("email provider is disabled") ||
    m.includes("provider is not enabled") ||
    m.includes("email_provider_disabled")
  )
    return "Вход по email временно недоступен. Попробуйте позже.";
  if (
    m.includes("failed to fetch") ||
    m.includes("load failed") ||
    m.includes("network") ||
    m.includes("fetch")
  )
    return "Не удалось подключиться к серверу. Проверьте интернет.";
  if (m.includes("email not confirmed"))
    return "Email не подтверждён. Проверьте почту и перейдите по ссылке.";
  if (m.includes("rate limit") || m.includes("too many requests"))
    return "Слишком много попыток. Подождите немного и попробуйте снова.";
  return "Не удалось войти. Попробуйте ещё раз.";
}

// Простая проверка формата email перед отправкой письма восстановления —
// чтобы не дёргать сеть на заведомо мусорном вводе. Не строгая RFC-валидация,
// нам достаточно «что-то@что-то.домен».
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function AppPage() {
  const [marketplace, setMarketplace] = useState<Marketplace>("ozon");
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const [result, setResult] = useState<CalcResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<CalcResult[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  // Счётчик-триггер перезагрузки «Аналитики по месяцам» после сохранения расчёта.
  // Сеттер используется в save-flow report_history (MonthlyAnalytics-блок убран
  // с экрана, поэтому само значение больше не читается; счётчик не трогаем).
  const [, setHistoryRefresh] = useState(0);
  // Ошибка загрузки истории из облака → показываем error-state с кнопкой «Повторить».
  const [historyError, setHistoryError] = useState(false);

  // ── PR #25: защита от случайного дубля расчёта за один месяц ──────────────
  // Мягкое предупреждение (НЕ overwrite/НЕ удаление старого): перед сохранением
  // НОВОГО расчёта за месяц, который уже есть в истории, показываем модалку с
  // выбором «Отмена» / «Создать новый расчёт всё равно». Проверка читает уже
  // загруженную историю; месяц определяется так же, как в отчётах (calcMonthKey).
  // Никаких новых запросов/таблиц/SQL — чисто клиентская защита.
  const [dupModal, setDupModal] = useState<{
    monthLabel: string;
    existing: CalcResult;
  } | null>(null);
  // resolve открытого confirm-промиса: true = «создать всё равно», false = «отмена».
  const dupResolveRef = useRef<((proceed: boolean) => void) | null>(null);

  // Ищет в истории расчёт за тот же месяц и маркетплейс (Ozon-дубль — среди
  // Ozon-расчётов). Месяц берётся через calcMonthKey: отчётный месяц из периода,
  // иначе месяц создания. mode-agnostic — два расчёта одного месяца (API + ручной +
  // файл) одинаково попадают в отчёты, поэтому дублем считаем любой по месяцу+МП.
  const findCalcForMonth = useCallback(
    (monthKey: string | null, mp: Marketplace): CalcResult | null => {
      if (!monthKey) return null;
      return (
        history.find(
          (h) => h.marketplace === mp && calcMonthKey(h) === monthKey
        ) ?? null
      );
    },
    [history]
  );

  // Promise-обёртка confirm-модалки. monthKey === null (месяц надёжно не определить)
  // или дубля нет → сразу resolve(true): НЕ блокируем сохранение. Есть дубль →
  // открываем модалку и ждём решения пользователя (resolve лежит в dupResolveRef).
  const confirmNoMonthDuplicate = useCallback(
    (monthKey: string | null, mp: Marketplace): Promise<boolean> => {
      const existing = findCalcForMonth(monthKey, mp);
      if (!monthKey || !existing) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        dupResolveRef.current = resolve;
        setDupModal({ monthLabel: formatMonthLabel(monthKey), existing });
      });
    },
    [findCalcForMonth]
  );

  // Закрывает модалку и резолвит ожидающий промис. proceed=false («Отмена») →
  // вызывающий код просто выходит, ничего не сохраняет и НЕ списывает попытку.
  const resolveDupModal = useCallback((proceed: boolean) => {
    const resolve = dupResolveRef.current;
    dupResolveRef.current = null;
    setDupModal(null);
    resolve?.(proceed);
  }, []);

  // Esc закрывает дубль-модалку как «Отмена» (доступность).
  useEffect(() => {
    if (!dupModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolveDupModal(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dupModal, resolveDupModal]);
  // ── /PR #25 ───────────────────────────────────────────────────────────────
  // История грузится дольше 10с → мягкая подсказка (не ошибка) про интернет/обновление.
  const [historySlow, setHistorySlow] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Чисто визуальный показ/скрытие пароля (глазок). На auth-логику не влияет.
  const [showPassword, setShowPassword] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  // Идёт вход по паролю (signInWithPassword) — блокируем кнопки/инпуты входа.
  const [signingIn, setSigningIn] = useState(false);
  // Идёт регистрация (signUp) — блокируем кнопки/инпуты входа.
  const [signingUp, setSigningUp] = useState(false);
  // Идёт выход (signOut) — блокируем кнопку «Выйти» и показываем «Выходим…».
  const [signingOut, setSigningOut] = useState(false);
  // Счётчик неудачных входов. Кнопку «Забыли пароль?» показываем только после
  // 3 ошибок подряд — чтобы не пугать обычного пользователя и не плодить спам.
  const [failedAttempts, setFailedAttempts] = useState(0);
  // Идёт отправка письма восстановления (resetPasswordForEmail).
  const [resetSending, setResetSending] = useState(false);
  // Анти-спам: после отправки письма блокируем повторную отправку на 60 секунд.
  // Храним оставшиеся секунды; 0 — отправка снова разрешена.
  const [resetCooldown, setResetCooldown] = useState(0);
  const [ozonClientId, setOzonClientId] = useState("");
  const [ozonApiKey, setOzonApiKey] = useState("");
  const [showOzonKey, setShowOzonKey] = useState(false);
  // Безопасное подключение Ozon: статус/маски берём из БД через /api/ozon/connection.
  // Сам ключ в браузере не держим — после успешного «Подключить» очищаем поле.
  const [ozonConn, setOzonConn] = useState<OzonConnView | null>(null);
  const [ozonConnLoading, setOzonConnLoading] = useState(false);
  const [ozonBusy, setOzonBusy] = useState<"idle" | "connecting" | "checking" | "deleting">("idle");
  const [ozonConnError, setOzonConnError] = useState("");

  // Ozon Performance API (реклама/продвижение) — PR #43 foundation. Отдельное
  // подключение и отдельная таблица; секрет в браузере не держим.
  const [perfClientId, setPerfClientId] = useState("");
  const [perfClientSecret, setPerfClientSecret] = useState("");
  const [showPerfSecret, setShowPerfSecret] = useState(false);
  const [perfConn, setPerfConn] = useState<PerfConnView | null>(null);
  const [perfConnLoading, setPerfConnLoading] = useState(false);
  const [perfBusy, setPerfBusy] = useState<"idle" | "connecting" | "checking" | "deleting">("idle");
  const [perfConnError, setPerfConnError] = useState("");

  // Справочный расход рекламы Performance API за месяц (PR #44) — read-only.
  // В прибыль НЕ входит, никуда не сохраняется, ничего не списывает.
  const [adsMonth, setAdsMonth] = useState<string>(() => defaultDraftMonth());
  const [adsBusy, setAdsBusy] = useState(false);
  const [adsResult, setAdsResult] = useState<AdsSpendResult | null>(null);
  const [adsError, setAdsError] = useState("");

  // Диагностика сопоставления товаров (PR #15) — read-only, ничего не сохраняет.
  const [matchMonth, setMatchMonth] = useState<string>(() => defaultDraftMonth());
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState("");
  const [matchResult, setMatchResult] = useState<OzonPostingsMatchResponse | null>(null);

  // Предварительная прибыль с себестоимостью (PR #16) — read-only API-черновик.
  const [profitMonth, setProfitMonth] = useState<string>(() => defaultDraftMonth());
  const [profitLoading, setProfitLoading] = useState(false);
  const [profitError, setProfitError] = useState("");
  const [profitResult, setProfitResult] = useState<OzonProfitDraftResponse | null>(null);
  // PR #18 — ручные расходы для API-preview. Строки (поля ввода), в БД НЕ
  // сохраняются и НЕ участвуют в файловом расчёте. Пустое поле трактуем как 0.
  const [apiExpenses, setApiExpenses] = useState<{
    tax: string;
    packaging: string;
    warehouseDelivery: string;
    salary: string;
    other: string;
  }>({ tax: "", packaging: "", warehouseDelivery: "", salary: "", other: "" });
  // PR #20 — единое действие «Рассчитать и сохранить»: сервер
  // (/api/ozon/save-calculation) проверяет доступ, пересчитывает, проверяет
  // себестоимость, списывает попытку и сохраняет; полный расчёт показываем ТОЛЬКО
  // после успеха. apiSaved=true означает «рассчитано и сохранено» (результат на
  // экране). Прогресс/ошибки переиспользуют profitLoading/profitError.
  const [apiSaved, setApiSaved] = useState(false);
  // PR #22 (UX) — структурированный показ «не хватает себестоимости». Сервер на
  // 400 incomplete_cost присылает status/unmatchedItems/matchedNoCostCount ДО
  // списания и без цифр расчёта. Держим их отдельно от profitError, чтобы показать
  // понятный блок с действиями (перейти в каталог / добавить несопоставленные),
  // а не сухой текст. null — блок скрыт.
  const [apiCostGap, setApiCostGap] = useState<{
    status?: string;
    unmatchedItems: number;
    matchedNoCostCount: number;
  } | null>(null);
  // СПРАВОЧНАЯ диагностика отчёта о реализации Ozon (read-only): приходит довеском
  // к успешному save-calculation. candidate COGS НЕ влияет на прибыль/налог/COGS и
  // никуда не сохраняется — показываем, чтобы сверить источник себестоимости с
  // документальным расчётом. null — блок скрыт.
  const [realizationDiag, setRealizationDiag] = useState<RealizationDiagnostic | null>(null);
  // PR #22 (UX) — свёрнутый второстепенный блок «Дополнительные действия и
  // диагностика» (проверка/удаление подключения, диагностика сопоставления,
  // добавление несопоставленных). По умолчанию закрыт, чтобы не мешать основному
  // сценарию: подключить → выбрать месяц → ввести расходы → рассчитать.
  const [apiDiagOpen, setApiDiagOpen] = useState(false);

  // Добавление несопоставленных товаров в каталог (PR #17) — только INSERT новых,
  // себестоимость НЕ выдумывается, расчёт НЕ запускается и НЕ сохраняется.
  const [importMonth, setImportMonth] = useState<string>(() => defaultDraftMonth());
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<OzonImportMissingResponse | null>(null);
  // Дефолт при первом открытии /app — вкладка «Авторасчёт Ozon API». Это только
  // активная вкладка/рендер: расчёт сам НЕ запускается (calculateAndSaveApi —
  // только по клику), consume/save/Ozon-запрос при mount не выполняются.
  const [calcMode, setCalcMode] = useState<"manual" | "api" | "upload">("api");
  // Открыт сохранённый Ozon API-расчёт ТОЛЬКО для просмотра (view-only): поля
  // заполнены и read-only, кнопка «Рассчитать» скрыта. null → обычный
  // редактируемый ручной калькулятор. Выход из просмотра — «Очистить форму».
  const [loadedApiView, setLoadedApiView] = useState<{ compensations: number } | null>(null);
  // Верхнеуровневые разделы дашборда: калькулятор или каталог товаров.
  // Каталог доступен только залогиненному (RLS user-scoped) — таб-бар прячем,
  // когда user отсутствует, и тогда всегда показываем калькулятор.
  const [mainTab, setMainTab] = useState<"calc" | "catalog" | "reports" | "cabinet">("calc");
  // Восстановление расчёта из «Отчётов» переключает на вкладку «Расчёт»; скролл
  // к калькулятору откладываем до её отрисовки (ref ещё не в DOM на «Отчётах»).
  const [pendingCalcScroll, setPendingCalcScroll] = useState(false);
  // Якорь для скролла «Последние расчёты» → калькулятор. Ведём scrollIntoView
  // сюда (табы режимов прямо над «Параметры расчёта»), а не на самый верх к
  // логотипу. scroll-margin-top в .calc-tabs компенсирует sticky-шапку .dash-top.
  const calcSectionRef = useRef<HTMLDivElement | null>(null);

  // ===== Upload report (UI-заготовка, без реального парсинга) =====
  // ===== Legacy single-file state (для обратной совместимости и demo) =====
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "ready" | "processing" | "success" | "error"
  >("idle");
  const [uploadStage, setUploadStage] = useState(0);
  const [uploadDetected, setUploadDetected] = useState<{
    marketplace: "ozon" | "wb";
    period: string;
    rowsCount: number;
  } | null>(null);
  const [uploadErrorMsg, setUploadErrorMsg] = useState("");
  const [uploadDebugInfo, setUploadDebugInfo] = useState<OzonDebugInfo | null>(
    null
  );
  const [uploadedReports, setUploadedReports] = useState<UploadedReport[]>([]);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // ===== 3-file architecture: XLSX (реализация) + 2× PDF (УПД) =====
  // Слот 1: Отчёт о реализации товара (XLSX) → revenue + loyaltyPayouts
  // Слот 2: УПД доп. услуги (PDF)          → updServicesTotal (расход)
  // Слот 3: УПД агентское вознаграждение   → updCommissionTotal (расход)
  // Формула: profitBeforeCost = revenue + loyaltyPayouts - updServices - updCommission
  const [slotXlsx, setSlotXlsx] = useState<File | null>(null);
  const [slotUpdServices, setSlotUpdServices] = useState<File | null>(null);
  const [slotUpdCommission, setSlotUpdCommission] = useState<File | null>(null);
  const [combinedStatus, setCombinedStatus] = useState<
    "idle" | "processing" | "success" | "error"
  >("idle");
  const [combinedError, setCombinedError] = useState("");
  const [combinedResult, setCombinedResult] = useState<{
    revenue: number;
    loyaltyPayouts: number;
    updServicesTotal: number;
    updCommissionTotal: number;
    profitBeforeCost: number;
    /** Период отчёта из XLSX — для report_month в истории по месяцам. */
    period: string | null;
    /** Имя XLSX-файла — fallback-источник месяца, если период не распарсился. */
    sourceFileName?: string | null;
  } | null>(null);
  const [combinedDebug, setCombinedDebug] = useState<{
    xlsx: OzonDebugInfo | null;
    updServices: UpdDebugInfo | null;
    updCommission: UpdDebugInfo | null;
  } | null>(null);
  /** Per-SKU строки из последнего распарсенного отчёта Ozon — для подстановки
   *  себестоимости из каталога и блока «Прибыль по товарам». Заполняется в
   *  обоих flow (одиночный upload и 3-file). Пусто → блок не показывается. */
  const [reportProducts, setReportProducts] = useState<OzonProductRow[]>([]);
  /** Тоталы (estimate) последнего отчёта — источник общих расходов для
   *  распределения по SKU в блоке «Чистая прибыль по товарам». Ставится вместе
   *  с reportProducts в обоих flow, сбрасывается там же. */
  const [reportEstimate, setReportEstimate] = useState<OzonEstimate | null>(
    null
  );
  /** Сумма себестоимости по сматченным товарам (каталог cost_price × кол-во),
   *  поднятая из блока «Чистая прибыль по товарам». Источник автозаполнения
   *  поля «Себестоимость товара» в форме доп. расходов. null — ещё не известна
   *  (нет per-SKU строк или каталог пуст) → поле остаётся ручным. */
  const [reportCogsTotal, setReportCogsTotal] = useState<number | null>(null);
  // Стабильная ссылка — чтобы effect в OzonProductBreakdown не зацикливался.
  const handleReportCogsTotal = useCallback((cogsTotal: number) => {
    setReportCogsTotal(cogsTotal);
  }, []);
  /** Ключевые товары (самый прибыльный / самый убыточный) последнего отчёта —
   *  для компактного блока «Ключевые товары» в PDF. Заполняется колбэком из
   *  OzonProductBreakdown (read-only). null — нет per-SKU данных → блок в PDF не
   *  рисуется и отчёт работает как раньше. */
  const [reportKeyProducts, setReportKeyProducts] =
    useState<KeyProductsSnapshot | null>(null);
  // Стабильная ссылка — как handleReportCogsTotal, чтобы effect не зацикливался.
  const handleReportKeyProducts = useCallback((data: KeyProductsSnapshot) => {
    setReportKeyProducts(data);
  }, []);
  /** Покрытие себестоимостью (всего / с себестоимостью / без) последнего отчёта —
   *  для блока «Проверка расчёта» перед «Сохранить результат». Заполняется
   *  колбэком из OzonProductBreakdown (read-only). null — нет per-SKU данных. */
  const [reportCostCoverage, setReportCostCoverage] =
    useState<CostCoverageSnapshot | null>(null);
  // Стабильная ссылка — как handleReportCogsTotal, чтобы effect не зацикливался.
  const handleReportCostCoverage = useCallback((data: CostCoverageSnapshot) => {
    setReportCostCoverage(data);
  }, []);
  const xlsxInputRef = useRef<HTMLInputElement | null>(null);
  const updServicesInputRef = useRef<HTMLInputElement | null>(null);
  const updCommissionInputRef = useRef<HTMLInputElement | null>(null);
  /** Какой слот сейчас под перетаскиванием — для подсветки. */
  const [dragOverSlot, setDragOverSlot] = useState<
    "xlsx" | "updServices" | "updCommission" | null
  >(null);

  // ===== Финальный калькулятор чистой прибыли =====
  const [showProfitForm, setShowProfitForm] = useState(false);
  const [profitInputs, setProfitInputs] = useState<ProfitInputs>({
    ...EMPTY_PROFIT,
  });
  // График выплат Ozon (ручной выбор) — учитывается в итоговой чистой прибыли
  // через payoutScheduleAdjustment. По умолчанию «стандартный» (0%).
  const [payoutSchedule, setPayoutSchedule] = useState<PayoutSchedule>({
    ...DEFAULT_PAYOUT_SCHEDULE,
  });
  // Пользователь вручную правил поле «Себестоимость товара» в доп. расходах?
  // Пока false — поле автоматически синхронизируется с суммарной COGS каталога
  // (включая инлайн-сохранения в «Товары без себестоимости»). После ручной
  // правки — true, и автосинк прекращается (ручное значение не затираем).
  const [costPriceTouched, setCostPriceTouched] = useState(false);
  const [profitSaving, setProfitSaving] = useState(false);
  const [profitSaved, setProfitSaved] = useState(false);
  // Хэндл авто-сохранённой записи 3-файлового анализа, чтобы «Сохранить
  // результат» ОБНОВЛЯЛ её (один анализ = одна строка), а не плодил вторую.
  // synced=false → облачной строки нет, правим только локальную в истории.
  const [lastUploadCalc, setLastUploadCalc] = useState<{
    id: string;
    synced: boolean;
  } | null>(null);
  const handleProfitInput = (key: keyof ProfitInputs, value: string) => {
    setProfitInputs((prev) => ({ ...prev, [key]: value }));
    // Ручная правка «Себестоимость товара» → отключаем автосинк с COGS каталога.
    if (key === "costPrice") setCostPriceTouched(true);
    // Любая правка расходов → разрешаем повторное сохранение нового результата.
    setProfitSaved(false);
  };
  // Изменение графика выплат Ozon → меняет итоговую прибыль, поэтому тоже
  // разрешаем повторное сохранение результата.
  const updatePayoutSchedule = (patch: Partial<PayoutSchedule>) => {
    setPayoutSchedule((prev) => ({ ...prev, ...patch }));
    setProfitSaved(false);
  };
  /** Итоговый расчёт чистой прибыли поверх данных из 3 отчётов. */
  const profitCalc = useMemo(() => {
    if (!combinedResult) return null;
    const num = (s: string) => {
      const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const { revenue, loyaltyPayouts, profitBeforeCost } = combinedResult;
    const costPrice = num(profitInputs.costPrice);
    const taxPercent = num(profitInputs.taxPercent);
    const ads = num(profitInputs.ads);
    const packaging = num(profitInputs.packaging);
    const deliveryToWarehouse = num(profitInputs.deliveryToWarehouse);
    const salary = num(profitInputs.salary);
    const other = num(profitInputs.other);

    // База налога — выручка Ozon (УСН «Доходы» по выбору пользователя).
    const tax = revenue * (taxPercent / 100);
    // В итоговом блоке costPrice и tax вынесены отдельными строками,
    // остальные ручные расходы сворачиваются в «Прочие расходы».
    const otherExpensesGroup =
      ads + packaging + deliveryToWarehouse + salary + other;
    const totalExtraExpenses = costPrice + tax + otherExpensesGroup;
    // Чистая прибыль ДО учёта графика выплат Ozon (прежняя формула — не меняем).
    const netProfitBeforePayout = profitBeforeCost - totalExtraExpenses;

    // ── График выплат Ozon ──
    // База — сумма к перечислению Ozon (profitBeforeCost = выручка + выплаты
    // партнёров − УПД услуги − агентское). Если она ≤ 0 (расходы Ozon съели
    // доход) — безопасный fallback на выручку.
    const payoutBase = profitBeforeCost > 0 ? profitBeforeCost : revenue;
    const payoutPercent = payoutPercentOf(payoutSchedule);
    const payoutDirection = payoutDirectionOf(payoutSchedule);
    // Комиссия (ранняя/ежедневная выплата) уменьшает прибыль, скидка (отсрочка)
    // — увеличивает. Стандартный график → 0 (прибыль не меняется).
    const payoutScheduleAdjustment =
      payoutDirection === "fee"
        ? -(payoutBase * payoutPercent) / 100
        : payoutDirection === "discount"
        ? (payoutBase * payoutPercent) / 100
        : 0;

    const netProfit = netProfitBeforePayout + payoutScheduleAdjustment;
    const incomeBase = revenue + loyaltyPayouts;
    const margin = incomeBase > 0 ? (netProfit / incomeBase) * 100 : 0;
    const roi = costPrice > 0 ? (netProfit / costPrice) * 100 : 0;

    return {
      costPrice,
      taxPercent,
      tax,
      ads,
      packaging,
      deliveryToWarehouse,
      salary,
      other,
      otherExpensesGroup,
      totalExtraExpenses,
      netProfitBeforePayout,
      payoutBase,
      payoutPercent,
      payoutDirection,
      payoutScheduleAdjustment,
      netProfit,
      margin,
      roi,
    };
  }, [combinedResult, profitInputs, payoutSchedule]);

  // Готов ли финальный расчёт чистой прибыли: считаем готовым, когда задана
  // себестоимость (> 0). Без неё показываем next-step вместо итоговой суммы.
  const netProfitReady = useMemo(() => {
    const n = parseFloat(
      profitInputs.costPrice.replace(/\s/g, "").replace(",", ".")
    );
    return Number.isFinite(n) && n > 0;
  }, [profitInputs.costPrice]);

  // Синхронизация «Себестоимость товара» с суммарной COGS каталога (cost_price ×
  // кол-во по сматченным SKU), которую считает блок «Чистая прибыль по товарам».
  // Пока пользователь не правил поле руками (costPriceTouched=false) — поле
  // всегда отражает актуальную сумму, в т.ч. после инлайн-сохранения себестоимости
  // в «Товары без себестоимости». После ручной правки автосинк прекращается, чтобы
  // не затирать введённое значение. 0/неизвестно (null) → не трогаем.
  useEffect(() => {
    if (reportCogsTotal !== null && reportCogsTotal > 0) {
      setProfitInputs((prev) =>
        costPriceTouched
          ? prev
          : { ...prev, costPrice: String(Math.round(reportCogsTotal)) }
      );
    }
  }, [reportCogsTotal, costPriceTouched]);

  /**
   * Сохранение ИТОГОВОЙ чистой прибыли (после себестоимости/налога/прочих
   * расходов) в историю + Supabase как отдельную запись calculation.
   * Гранулярные поля без своих колонок (ROI, упаковка, доставка, зарплата)
   * пишем в jsonb `ai_insights`, чтобы ничего не терялось при перезагрузке.
   * consumeCalculation НЕ зовём — квота уже списана авто-сейвом в analyzeAllThree.
   */
  const saveProfitResult = async () => {
    if (!combinedResult || !profitCalc) return;
    if (profitSaving) return;
    setProfitSaving(true);

    const now = new Date();
    const incomeRevenue =
      combinedResult.revenue + combinedResult.loyaltyPayouts;
    // ads выносим в свою колонку, остальные ручные — в other_expenses.
    const otherGroup =
      profitCalc.packaging +
      profitCalc.deliveryToWarehouse +
      profitCalc.salary +
      profitCalc.other;
    // total_expenses включает Ozon-комиссии + все доп. расходы. График выплат
    // вычитаем как корректировку расходов (комиссия за раннюю выплату → расходы
    // растут; скидка за отсрочку → падают), чтобы тождество
    // profit = revenue − total_expenses = netProfit сохранялось.
    const totalExpenses =
      combinedResult.updServicesTotal +
      combinedResult.updCommissionTotal +
      profitCalc.costPrice +
      profitCalc.tax +
      profitCalc.ads +
      otherGroup -
      profitCalc.payoutScheduleAdjustment;

    const breakdown: NetProfitBreakdown = {
      kind: "net-profit-3file",
      roi: profitCalc.roi,
      taxPercent: profitCalc.taxPercent,
      costPrice: profitCalc.costPrice,
      tax: profitCalc.tax,
      ads: profitCalc.ads,
      packaging: profitCalc.packaging,
      deliveryToWarehouse: profitCalc.deliveryToWarehouse,
      salary: profitCalc.salary,
      other: profitCalc.other,
      updServicesTotal: combinedResult.updServicesTotal,
      updCommissionTotal: combinedResult.updCommissionTotal,
      revenueOzon: combinedResult.revenue,
      loyaltyPayouts: combinedResult.loyaltyPayouts,
      profitBeforeCost: combinedResult.profitBeforeCost,
      payoutSchedule,
      payoutScheduleAdjustment: profitCalc.payoutScheduleAdjustment,
      reportPeriod: combinedResult.period,
      // Per-SKU строки + estimate — чтобы восстановление из истории пересчитало
      // себестоимость по актуальному каталогу (не по застывшему снапшоту).
      products: reportProducts,
      estimate: reportEstimate,
    };

    // Поля записи — идентичны для update и insert.
    const payload = {
      marketplace: "ozon" as const,
      mode: "upload" as CloudCalcMode,
      revenue: incomeRevenue,
      commission: combinedResult.updServicesTotal,
      logistics: combinedResult.updCommissionTotal,
      ads: profitCalc.ads,
      storage: 0,
      tax: profitCalc.tax,
      cost: profitCalc.costPrice,
      other_expenses: otherGroup,
      total_expenses: totalExpenses,
      profit: profitCalc.netProfit,
      margin: profitCalc.margin,
      ai_insights: breakdown,
    };

    const canPersist = !!user?.id;
    let cloudCalcId: string | null = null;
    let cloudCreatedAt: string | null = null;
    let synced = false;
    let calcErrMsg: string | null = null;

    if (canPersist) {
      // Есть облачная запись этого анализа → ОБНОВЛЯЕМ её (один анализ = одна
      // строка). Если её нет / update не нашёл строку — вставляем (fallback).
      if (lastUploadCalc?.synced) {
        const upRes = await updateCalculationInCloud(
          lastUploadCalc.id,
          payload,
          user!.id
        );
        if (upRes.data?.id) {
          cloudCalcId = upRes.data.id;
          cloudCreatedAt = upRes.data.created_at;
          synced = true;
        } else {
          calcErrMsg = upRes.error?.message ?? null;
        }
      }
      if (!synced) {
        const saveRes = await saveCalculationToCloud(payload, user!.id);
        if (saveRes.error) {
          calcErrMsg = saveRes.error.message;
        } else if (saveRes.data?.id) {
          cloudCalcId = saveRes.data.id;
          cloudCreatedAt = saveRes.data.created_at;
          synced = true;
          calcErrMsg = null;
        }
      }
    }

    // id строки в истории: облачный (после update/insert) → иначе id авто-записи
    // (правим её на месте) → иначе новый локальный.
    const targetId = lastUploadCalc?.id ?? null;
    const res: CalcResult = {
      id: cloudCalcId ?? targetId ?? makeLocalId(),
      marketplace: "ozon",
      revenue: incomeRevenue,
      commission: combinedResult.updServicesTotal,
      logistics: combinedResult.updCommissionTotal,
      storage: 0,
      ads: profitCalc.ads,
      cost: profitCalc.costPrice,
      tax: profitCalc.tax,
      other: otherGroup,
      expenses: totalExpenses,
      profit: profitCalc.netProfit,
      margin: profitCalc.margin,
      aiInsights: breakdown,
      date: now.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
      createdAt: cloudCreatedAt ?? now.toISOString(),
      synced,
    };

    // Обновляем СУЩЕСТВУЮЩУЮ строку на её месте (позицию и время анализа не
    // меняем). Если строки нет (edge: её удалили) — добавляем как новую.
    setHistory((prev) => {
      const idx = targetId ? prev.findIndex((h) => h.id === targetId) : -1;
      if (idx === -1) return [res, ...prev].slice(0, 50);
      const next = [...prev];
      next[idx] = { ...res, date: prev[idx].date, createdAt: prev[idx].createdAt };
      return next;
    });
    setLastUploadCalc({ id: res.id, synced });

    // История по месяцам: снимок (выручка/расходы/прибыль/маржа) с привязкой к
    // месяцу отчёта — для блока «Аналитика по месяцам». Best-effort: не блокирует
    // основной сейв и не влияет на расчёт. UI группирует по месяцу (последняя
    // запись за месяц), поэтому повторные сохранения того же отчёта корректны.
    if (canPersist && user?.id) {
      // Месяц отчёта по приоритету: период из XLSX → имя файла Ozon. Если ни
      // один источник не дал месяц — НЕ сохраняем снимок с фейковым текущим
      // месяцем (это сливало бы отчёты разных месяцев в одну точку и ломало
      // график динамики). Пропуск снимка не блокирует основной сейв расчёта.
      const reportMonth = resolveReportMonth(
        combinedResult.period,
        combinedResult.sourceFileName
      );
      if (reportMonth) {
        const { error: histErr } = await saveReportHistoryToCloud(
          {
            report_month: reportMonth,
            revenue: incomeRevenue,
            expenses: totalExpenses,
            profit: profitCalc.netProfit,
            margin: profitCalc.margin,
          },
          user.id
        );
        if (!histErr) setHistoryRefresh((k) => k + 1);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[report-history] месяц отчёта не распознан — снимок за месяц пропущен",
          {
            period: combinedResult.period,
            fileName: combinedResult.sourceFileName,
          }
        );
      }
    }

    setProfitSaving(false);
    setProfitSaved(true);

    if (synced) {
      showToast("Чистая прибыль сохранена", "ok");
    } else if (canPersist && calcErrMsg) {
      showToast("Облако: " + calcErrMsg, "warn");
    } else {
      showToast("Сохранено локально", "warn");
    }
  };

  /**
   * Скачать PDF-отчёт о чистой прибыли (3-file расчёт). Доступно только когда
   * combinedStatus === "success" и есть profitCalc (кнопка отрендерена внутри
   * формы чистой прибыли). Кириллица: jsPDF стандартными шрифтами кириллицу не
   * рендерит, поэтому отчёт рисуется на canvas (системный шрифт корректно
   * отображает русский), затем вставляется картинкой в A4-страницу jsPDF.
   * Без ручного подключения шрифтов и без сторонних зависимостей кроме jspdf.
   */
  const downloadProfitPdf = async () => {
    if (!combinedResult || !profitCalc) return;
    try {
      const { jsPDF } = await import("jspdf");

      const cr = combinedResult;
      const pc = profitCalc;
      const now = new Date();
      const dateStr = now.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const money = (n: number) =>
        n.toLocaleString("ru-RU", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }) + " ₽";
      const pctv = (n: number) =>
        n.toLocaleString("ru-RU", {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }) + " %";
      const netPositive = pc.netProfit >= 0;

      // Тип строки разбивки: kind управляет цветом и оформлением (доход +зелёный,
      // расход −красный, подытог белый, нейтраль серый, итог золотой).
      type RowKind = "income" | "expense" | "subtotal" | "neutral" | "total";
      type ProfitPdfRow = {
        label: string;
        value: string;
        kind: RowKind;
        sub?: string;
      };

      // Метка налога с процентом (если задан).
      const taxLabel =
        pc.taxPercent > 0
          ? `Налог (${pc.taxPercent.toLocaleString("ru-RU", {
              maximumFractionDigits: 2,
            })}%)`
          : "Налог";

      // График выплат Ozon. fee (ранняя/ежедневная выплата) — комиссия, уменьшает
      // прибыль (−); discount (отсрочка) — скидка, увеличивает (+); стандартный
      // график → 0. У старых расчётов adjustment отсутствует → profitCalc отдаёт 0,
      // поэтому строка показывает «0 ₽» и не ломает скачивание.
      const adj = pc.payoutScheduleAdjustment;
      const payoutKind: RowKind =
        adj > 0 ? "income" : adj < 0 ? "expense" : "neutral";
      const payoutValue =
        adj === 0 ? money(0) : (adj > 0 ? "+" : "−") + money(Math.abs(adj));

      // Полная разбивка расчёта — 10 строк по ТЗ. «Прочие расходы» — свёрнутая
      // группа (реклама + упаковка + доставка + зарплата + прочее).
      const rows: ProfitPdfRow[] = [
        { label: "Выручка Ozon", value: "+" + money(cr.revenue), kind: "income" },
        {
          label: "Выплаты от партнёров",
          value: "+" + money(cr.loyaltyPayouts),
          kind: "income",
        },
        {
          label: "Расходы Ozon по УПД",
          value: "−" + money(cr.updServicesTotal),
          kind: "expense",
        },
        {
          label: "Агентское вознаграждение",
          value: "−" + money(cr.updCommissionTotal),
          kind: "expense",
        },
        {
          label: "Прибыль до себестоимости",
          value: money(cr.profitBeforeCost),
          kind: "subtotal",
        },
        {
          label: "Себестоимость",
          value: "−" + money(pc.costPrice),
          kind: "expense",
        },
        { label: taxLabel, value: "−" + money(pc.tax), kind: "expense" },
        {
          label: "Прочие расходы",
          value: "−" + money(pc.otherExpensesGroup),
          kind: "expense",
        },
        {
          label: "График выплат Ozon",
          value: payoutValue,
          kind: payoutKind,
          sub: payoutScheduleLabel(payoutSchedule),
        },
        {
          label: "Итоговая чистая прибыль",
          value: (pc.netProfit >= 0 ? "+" : "−") + money(Math.abs(pc.netProfit)),
          kind: "total",
        },
      ];

      // ── Canvas (A4 @96dpi = 794×1123), scale ×2 для чёткости ──
      const scale = 2;
      const W = 794;
      const H = 1123;
      const canvas = document.createElement("canvas");
      canvas.width = W * scale;
      canvas.height = H * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context недоступен");
      ctx.scale(scale, scale);

      // ── Палитра M-Prof (тёмная премиальная, hex из CSS-переменных сайта) ──
      const C = {
        bgTop: "#080a14",
        bgBot: "#05070f",
        panel: "#0d1020",
        panelHi: "#11152b",
        gold: "#C9A84C",
        gold2: "#E8C97A",
        gold3: "#F5DFA0",
        txt: "#E8EEF8",
        txt2: "#8A9FBB",
        txt3: "#56678a",
        green: "#2ECC8A",
        red: "#E05566",
        edge: "rgba(255,255,255,0.08)",
        edge2: "rgba(255,255,255,0.14)",
      };
      const SANS = "'Helvetica Neue', Arial, sans-serif";
      const MONO = "'SF Mono', 'Roboto Mono', Menlo, monospace";
      const ML = 56;
      const MR = W - 56;
      const CW = MR - ML;

      // Путь скруглённого прямоугольника (без зависимости от ctx.roundRect —
      // совместимо со всеми движками canvas).
      const rr = (x: number, yy: number, w: number, h: number, r: number) => {
        const rad = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rad, yy);
        ctx.arcTo(x + w, yy, x + w, yy + h, rad);
        ctx.arcTo(x + w, yy + h, x, yy + h, rad);
        ctx.arcTo(x, yy + h, x, yy, rad);
        ctx.arcTo(x, yy, x + w, yy, rad);
        ctx.closePath();
      };

      // ── Фон: вертикальный градиент + золотое свечение + верхняя полоса ──
      const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
      bgGrad.addColorStop(0, C.bgTop);
      bgGrad.addColorStop(1, C.bgBot);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W / 2, -140, 40, W / 2, -140, 540);
      glow.addColorStop(0, "rgba(201,168,76,0.18)");
      glow.addColorStop(1, "rgba(201,168,76,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, 380);
      const topBar = ctx.createLinearGradient(0, 0, W, 0);
      topBar.addColorStop(0, C.gold);
      topBar.addColorStop(0.5, C.gold3);
      topBar.addColorStop(1, C.gold);
      ctx.fillStyle = topBar;
      ctx.fillRect(0, 0, W, 4);

      ctx.textBaseline = "alphabetic";

      // ── Шапка: бренд + тег + дата/маркетплейс ──
      ctx.textAlign = "left";
      ctx.font = `800 30px ${SANS}`;
      ctx.fillStyle = C.txt;
      ctx.fillText("M-", ML, 72);
      const brandW = ctx.measureText("M-").width;
      ctx.fillStyle = C.gold2;
      ctx.fillText("Prof", ML + brandW, 72);
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText("ОТЧЁТ О ЧИСТОЙ ПРИБЫЛИ", ML, 92);
      ctx.textAlign = "right";
      ctx.font = `700 13px ${SANS}`;
      ctx.fillStyle = C.gold2;
      ctx.fillText("Ozon", MR, 60);
      ctx.font = `400 11px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText(dateStr, MR, 80);

      // ── Главный итог (hero): крупная чистая прибыль + карточки маржа/ROI ──
      const heroY = 116;
      const heroH = 150;
      const heroGrad = ctx.createLinearGradient(ML, heroY, ML, heroY + heroH);
      heroGrad.addColorStop(0, C.panelHi);
      heroGrad.addColorStop(1, C.panel);
      rr(ML, heroY, CW, heroH, 16);
      ctx.fillStyle = heroGrad;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(201,168,76,0.30)";
      rr(ML, heroY, CW, heroH, 16);
      ctx.stroke();

      const heroPad = 28;
      ctx.textAlign = "left";
      ctx.font = `600 11px ${MONO}`;
      ctx.fillStyle = C.txt2;
      ctx.fillText("ИТОГОВАЯ ЧИСТАЯ ПРИБЫЛЬ", ML + heroPad, heroY + 38);
      ctx.font = `800 46px ${SANS}`;
      ctx.fillStyle = netPositive ? C.green : C.red;
      ctx.fillText(
        (pc.netProfit >= 0 ? "+" : "−") + money(Math.abs(pc.netProfit)),
        ML + heroPad,
        heroY + 94
      );
      ctx.font = `500 12px ${SANS}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(
        netPositive
          ? "Бизнес-модель прибыльна по загруженным данным"
          : "Расчёт показывает убыток — проверьте себестоимость и расходы",
        ML + heroPad,
        heroY + 122
      );

      const cardW = 156;
      const cardH = 54;
      const cardX = MR - heroPad - cardW;
      const drawStat = (
        cy: number,
        label: string,
        value: string,
        neg: boolean
      ) => {
        rr(cardX, cy, cardW, cardH, 12);
        ctx.fillStyle = "rgba(255,255,255,0.035)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = C.edge;
        rr(cardX, cy, cardW, cardH, 12);
        ctx.stroke();
        ctx.textAlign = "left";
        ctx.font = `600 9.5px ${MONO}`;
        ctx.fillStyle = C.txt2;
        ctx.fillText(label, cardX + 16, cy + 21);
        ctx.font = `700 21px ${SANS}`;
        ctx.fillStyle = neg ? C.red : C.gold2;
        ctx.fillText(value, cardX + 16, cy + 44);
      };
      drawStat(heroY + 19, "МАРЖИНАЛЬНОСТЬ", pctv(pc.margin), pc.margin < 0);
      drawStat(heroY + 19 + cardH + 9, "ROI", pctv(pc.roi), pc.roi < 0);

      // ── Заголовок раздела разбивки ──
      let y = heroY + heroH + 40;
      ctx.textAlign = "left";
      ctx.font = `700 12px ${MONO}`;
      ctx.fillStyle = C.gold2;
      ctx.fillText("РАЗБИВКА РАСЧЁТА", ML, y);
      const headW = ctx.measureText("РАЗБИВКА РАСЧЁТА").width;
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ML + headW + 16, y - 4);
      ctx.lineTo(MR, y - 4);
      ctx.stroke();

      // ── Таблица разбивки (панель + строки) ──
      y += 18;
      const rowH = 42;
      const tableTop = y;
      const tableH = rows.length * rowH + 14;
      rr(ML, tableTop, CW, tableH, 14);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1;
      rr(ML, tableTop, CW, tableH, 14);
      ctx.stroke();

      const padX = 24;
      const colorFor = (kind: RowKind) =>
        kind === "income"
          ? C.green
          : kind === "expense"
          ? C.red
          : kind === "total"
          ? C.gold2
          : kind === "subtotal"
          ? C.txt
          : C.txt2;
      let ry = tableTop + 7;
      rows.forEach((r) => {
        const isTotal = r.kind === "total";
        const isSub = r.kind === "subtotal";
        // Итог — золотая «пилюля» (визуально выделяем отдельно).
        if (isTotal) {
          rr(ML + 8, ry + 3, CW - 16, rowH - 6, 10);
          ctx.fillStyle = "rgba(201,168,76,0.10)";
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(201,168,76,0.38)";
          rr(ML + 8, ry + 3, CW - 16, rowH - 6, 10);
          ctx.stroke();
        }
        // Подытог — пунктирный разделитель сверху.
        if (isSub) {
          ctx.strokeStyle = C.edge2;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(ML + padX, ry + 1);
          ctx.lineTo(MR - padX, ry + 1);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const baseY = ry + rowH / 2 + 5;
        ctx.textAlign = "left";
        if (r.sub) {
          // Строка с под-меткой (график выплат) — лейбл выше, описание ниже.
          ctx.font = `${isTotal ? "700" : "500"} 13px ${SANS}`;
          ctx.fillStyle = isTotal ? C.txt : C.txt2;
          ctx.fillText(r.label, ML + padX, ry + rowH / 2 - 1);
          ctx.font = `400 9px ${MONO}`;
          ctx.fillStyle = C.txt3;
          ctx.fillText(r.sub, ML + padX, ry + rowH / 2 + 13);
        } else {
          ctx.font = `${isTotal ? "700" : isSub ? "600" : "500"} ${
            isTotal ? 15 : 13
          }px ${SANS}`;
          ctx.fillStyle = isTotal || isSub ? C.txt : C.txt2;
          ctx.fillText(r.label, ML + padX, baseY);
        }
        ctx.textAlign = "right";
        ctx.font = `${isTotal ? "800" : "700"} ${isTotal ? 17 : 13}px ${SANS}`;
        ctx.fillStyle = colorFor(r.kind);
        ctx.fillText(r.value, MR - padX, baseY);
        ry += rowH;
      });
      ctx.textAlign = "left";

      // ── Ключевые товары (компактно): самый прибыльный / самый убыточный ──
      // Данные — read-only снимок из OzonProductBreakdown (reportKeyProducts).
      // Рисуем блок ТОЛЬКО при наличии данных по товарам; иначе PDF как раньше.
      let yAfter = tableTop + tableH;
      // Обрезка длинного текста под ширину карточки (по текущему шрифту ctx).
      const ellipsize = (text: string, maxW: number) => {
        if (ctx.measureText(text).width <= maxW) return text;
        let t = text;
        while (t.length > 1 && ctx.measureText(t + "…").width > maxW)
          t = t.slice(0, -1);
        return t + "…";
      };
      const drawProductCard = (
        x: number,
        cy: number,
        w: number,
        h: number,
        kind: "best" | "worst",
        p: { article: string; name: string; profit: number; margin: number } | null
      ) => {
        rr(x, cy, w, h, 12);
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = C.edge;
        rr(x, cy, w, h, 12);
        ctx.stroke();
        const accent = kind === "best" ? C.green : C.red;
        ctx.textAlign = "left";
        ctx.font = `700 9.5px ${MONO}`;
        ctx.fillStyle = kind === "best" ? C.green : p ? C.red : C.txt2;
        ctx.fillText(
          kind === "best" ? "САМЫЙ ПРИБЫЛЬНЫЙ" : "САМЫЙ УБЫТОЧНЫЙ",
          x + 16,
          cy + 22
        );
        // Убыточных товаров нет — аккуратная зелёная строка вместо карточки.
        if (kind === "worst" && !p) {
          const pillY = cy + h / 2 - 1;
          rr(x + 16, pillY, w - 32, 30, 8);
          ctx.fillStyle = "rgba(46,204,138,0.10)";
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(46,204,138,0.30)";
          rr(x + 16, pillY, w - 32, 30, 8);
          ctx.stroke();
          ctx.textAlign = "center";
          ctx.font = `600 11px ${SANS}`;
          ctx.fillStyle = C.green;
          ctx.fillText("Убыточных товаров не найдено", x + w / 2, pillY + 20);
          ctx.textAlign = "left";
          return;
        }
        if (!p) return;
        // Название (обрезаем) + артикул/SKU.
        ctx.font = `700 13px ${SANS}`;
        ctx.fillStyle = C.txt;
        ctx.fillText(ellipsize(p.name || p.article, w - 32), x + 16, cy + 46);
        ctx.font = `400 9px ${MONO}`;
        ctx.fillStyle = C.txt3;
        ctx.fillText(ellipsize("SKU: " + p.article, w - 32), x + 16, cy + 63);
        ctx.strokeStyle = C.edge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 16, cy + 77);
        ctx.lineTo(x + w - 16, cy + 77);
        ctx.stroke();
        // Чистая прибыль (слева) + маржа (справа).
        ctx.font = `600 8px ${MONO}`;
        ctx.fillStyle = C.txt3;
        ctx.fillText("ЧИСТАЯ ПРИБЫЛЬ", x + 16, cy + 92);
        ctx.font = `800 15px ${SANS}`;
        ctx.fillStyle = accent;
        ctx.fillText(
          (p.profit >= 0 ? "+" : "−") + money(Math.abs(p.profit)),
          x + 16,
          cy + 106
        );
        ctx.textAlign = "right";
        ctx.font = `600 8px ${MONO}`;
        ctx.fillStyle = C.txt3;
        ctx.fillText("МАРЖА", x + w - 16, cy + 92);
        ctx.font = `700 14px ${SANS}`;
        ctx.fillStyle = p.margin < 0 ? C.red : C.txt;
        ctx.fillText(pctv(p.margin), x + w - 16, cy + 106);
        ctx.textAlign = "left";
      };
      const keyProducts = reportKeyProducts;
      if (keyProducts?.best) {
        yAfter += 30;
        ctx.textAlign = "left";
        ctx.font = `700 12px ${MONO}`;
        ctx.fillStyle = C.gold2;
        ctx.fillText("КЛЮЧЕВЫЕ ТОВАРЫ", ML, yAfter);
        const kHeadW = ctx.measureText("КЛЮЧЕВЫЕ ТОВАРЫ").width;
        ctx.strokeStyle = C.edge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ML + kHeadW + 16, yAfter - 4);
        ctx.lineTo(MR, yAfter - 4);
        ctx.stroke();
        yAfter += 16;
        const kGap = 16;
        const kcW = (CW - kGap) / 2;
        const kcH = 112;
        drawProductCard(ML, yAfter, kcW, kcH, "best", keyProducts.best);
        drawProductCard(
          ML + kcW + kGap,
          yAfter,
          kcW,
          kcH,
          "worst",
          keyProducts.worst
        );
        yAfter += kcH;
      }

      // ── Примечание о методике расчёта ──
      y = yAfter + 26;
      const noteH = 98;
      rr(ML, y, CW, noteH, 14);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 1;
      rr(ML, y, CW, noteH, 14);
      ctx.stroke();
      ctx.font = `700 10px ${MONO}`;
      ctx.fillStyle = C.gold2;
      ctx.fillText("КАК СЧИТАЕМ", ML + 22, y + 26);
      ctx.font = `400 11px ${SANS}`;
      ctx.fillStyle = C.txt2;
      const notes = [
        "Прибыль до себестоимости = Выручка Ozon + Выплаты партнёров − Расходы по УПД − Агентское.",
        "Чистая прибыль = Прибыль до себестоимости − Себестоимость − Налог − Прочие ± График выплат Ozon.",
        "Налог считается от выручки Ozon. График выплат: комиссия за раннюю выплату (−), скидка за отсрочку (+).",
      ];
      notes.forEach((line, i) => ctx.fillText(line, ML + 22, y + 48 + i * 17));

      // ── Подвал ──
      ctx.textAlign = "center";
      ctx.font = `500 10.5px ${MONO}`;
      ctx.fillStyle = C.txt3;
      ctx.fillText(
        "Сформировано сервисом M-Prof · аналитика прибыли для маркетплейсов",
        W / 2,
        H - 46
      );
      ctx.textAlign = "left";

      // ── Canvas → картинка → A4 PDF ──
      const imgData = canvas.toDataURL("image/png");
      const doc = new jsPDF({ orientation: "portrait", unit: "px", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      doc.addImage(imgData, "PNG", 0, 0, pw, ph);
      doc.save(`mprof-profit-report-${now.toISOString().slice(0, 10)}.pdf`);
      showToast("PDF-отчёт сформирован", "ok");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[pdf] downloadProfitPdf", e);
      showToast("Не удалось сформировать PDF", "err");
    }
  };

  /**
   * Клик по строке истории, относящейся к 3-file расчёту: восстанавливаем
   * редактируемое состояние (combinedResult + форма чистой прибыли) из
   * ai_insights, чтобы пользователь мог поменять себестоимость/налог/расходы и
   * нажать «Сохранить результат» — обновится ТА ЖЕ строка (lastUploadCalc),
   * а не создастся новая. Записи без net-profit разбора (ручной/API расчёт)
   * не восстанавливаются — guard возвращает null и handler выходит.
   */
  const restoreUploadCalc = (item: CalcResult) => {
    const b = asNetProfitBreakdown(item.aiInsights);
    if (!b) return;
    const s = (n: number) => (n ? String(n) : "");
    setCalcMode("upload");
    setCombinedError("");
    setCombinedStatus("success");
    setCombinedResult({
      revenue: b.revenueOzon,
      loyaltyPayouts: b.loyaltyPayouts,
      updServicesTotal: b.updServicesTotal,
      updCommissionTotal: b.updCommissionTotal,
      profitBeforeCost: b.profitBeforeCost,
      period: b.reportPeriod ?? null,
    });
    // Восстанавливаем выбранный график выплат (старые записи → стандартный 0%).
    setPayoutSchedule(b.payoutSchedule ?? { ...DEFAULT_PAYOUT_SCHEDULE });
    // Восстанавливаем per-SKU строки + estimate из snapshot (если сохранены).
    // Это даёт OzonProductBreakdown заново сопоставить товары с АКТУАЛЬНЫМ
    // каталогом и пересчитать себестоимость (COGS) при открытии старого расчёта.
    const restoredProducts = b.products ?? [];
    setReportProducts(restoredProducts);
    setReportEstimate(b.estimate ?? null);
    // Сбрасываем ключевые товары — OzonProductBreakdown пересчитает и пробросит
    // свежие best/worst (или оставит null, если совпадений нет).
    setReportKeyProducts(null);
    setReportCostCoverage(null);
    setProfitInputs({
      // b.costPrice — fallback: если per-SKU строк нет или в каталоге нет
      // совпадений (COGS=0), остаётся сохранённое значение. При наличии строк
      // и совпадений его перезапишет автосинк с COGS (см. ниже).
      costPrice: s(b.costPrice),
      taxPercent: s(b.taxPercent),
      ads: s(b.ads),
      packaging: s(b.packaging),
      deliveryToWarehouse: s(b.deliveryToWarehouse),
      salary: s(b.salary),
      other: s(b.other),
    });
    // Есть per-SKU строки → разблокируем автосинк с COGS: OzonProductBreakdown
    // загрузит актуальный каталог, посчитает totals.cogs и через onCogsTotal
    // обновит «Себестоимость товара» свежим значением → чистая прибыль и блок
    // «Товары без себестоимости» пересчитаются. Нет строк (старый снапшот) →
    // оставляем сохранённое значение, автосинк его не трогает.
    setCostPriceTouched(restoredProducts.length === 0);
    setShowProfitForm(true);
    setLastUploadCalc({ id: item.id, synced: item.synced });
    setSelectedId(item.id);
    setProfitSaved(false);
    setProfitSaving(false);
  };

  /**
   * Клик по строке «Последние расчёты» → загрузить этот расчёт в калькулятор.
   * Универсальный загрузчик поверх restoreUploadCalc:
   *   • 3-file (upload) расчёт → восстанавливаем combinedResult + форму чистой
   *     прибыли через restoreUploadCalc, режим «upload»;
   *   • ручной (manual) расчёт → заполняем форму параметров сохранёнными числами
   *     и показываем результат, режим «manual».
   * В обоих случаях плавно скроллим наверх (там калькулятор), чтобы пользователь
   * увидел подставленный расчёт.
   */
  const loadCalcIntoCalculator = (item: CalcResult) => {
    // fail-closed: реально небезопасные API-расчёты (битый/несводимый taxonomy-
    // снапшот, либо старый API без снапшота с отрицательным other) открыть в
    // калькуляторе нельзя — только warning, форма не меняется.
    if (isApiCalcUnsafeToLoad(item)) {
      showToast(
        "Этот расчёт получен через Ozon API, но его финансовый снапшот повреждён или не сводится, поэтому его нельзя открыть в калькуляторе. Данные видны в истории.",
        "warn"
      );
      return;
    }
    // Клик мог прийти со вкладки «Отчёты» — возвращаем пользователя к
    // калькулятору, где восстанавливается выбранный расчёт.
    setMainTab("calc");

    // Валидный Ozon API-расчёт с financeTaxonomy → открываем в ручном калькуляторе
    // ТОЛЬКО для просмотра (view-only). Поля заполняем через taxonomy-view: логистика
    // и реклама отдельными строками, other = прочие Ozon + ручные доп-расходы,
    // компенсации — отдельной зелёной доходной строкой (loadedApiView). Итог берём из
    // сохранённого result. Ничего не пересчитываем и в БД не пишем (только setState).
    const apiView = item.mode === "api" ? ozonTaxonomyView(item) : null;
    if (apiView) {
      const s = (n: number) => String(Math.round(n));
      setCalcMode("manual");
      setMarketplace(item.marketplace);
      setForm({
        revenue: s(item.revenue),
        commission: s(item.commission),
        logistics: s(apiView.logisticsCharges),
        storage: s(apiView.storage),
        ads: s(apiView.adsCharges),
        cost: s(item.cost),
        tax: s(item.tax),
        other: s(apiView.otherCharges + apiView.manualExtraExpenses),
      });
      setLoadedApiView({ compensations: apiView.ozonIncome });
      setResult(item);
      setShowProfitForm(false);
      setSelectedId(item.id);
      setPendingCalcScroll(true);
      return;
    }

    const breakdown = asNetProfitBreakdown(item.aiInsights);
    if (breakdown) {
      // Upload-расчёт: вся логика восстановления уже в restoreUploadCalc.
      setLoadedApiView(null);
      restoreUploadCalc(item);
    } else {
      // Ручной расчёт (или старый API с неотрицательным other): восстанавливаем
      // форму и итог, режим — обычный редактируемый (view-only снимаем).
      const s = (n: number) => String(Math.round(n));
      setLoadedApiView(null);
      setCalcMode("manual");
      setMarketplace(item.marketplace);
      setForm({
        revenue: s(item.revenue),
        commission: s(item.commission),
        logistics: s(item.logistics),
        storage: s(item.storage),
        ads: s(item.ads),
        cost: s(item.cost),
        tax: s(item.tax),
        other: s(item.other),
      });
      setResult(item);
      setShowProfitForm(false);
      setSelectedId(item.id);
    }
    // Плавно подводим к блоку расчёта (табы + «Параметры расчёта»), а не к самому
    // верху страницы. На вкладке «Отчёты» калькулятор ещё не в DOM, поэтому
    // скролл выполняем после переключения вкладки — через флаг + эффект ниже.
    setPendingCalcScroll(true);
  };

  // Отложенный скролл к калькулятору после восстановления расчёта из «Отчётов».
  // Срабатывает, когда вкладка «Расчёт» уже отрисована (ref доступен). block:
  // "start" + scroll-margin-top в .calc-tabs учитывают sticky-шапку.
  useEffect(() => {
    if (!pendingCalcScroll || mainTab !== "calc") return;
    const raf = requestAnimationFrame(() => {
      calcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingCalcScroll(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingCalcScroll, mainTab]);

  const acceptUploadFile = (file: File | null) => {
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      showToast("Поддерживаются только XLSX и CSV", "err");
      return;
    }
    setUploadFile(file);
    setUploadStatus("ready");
  };

  const removeUploadFile = () => {
    setUploadFile(null);
    setUploadStatus("idle");
    setUploadStage(0);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  };

  const analyzeUpload = async () => {
    if (!uploadFile || uploadStatus === "processing") {
      // eslint-disable-next-line no-console
      console.warn("[upload] analyzeUpload guard exit", {
        hasFile: !!uploadFile,
        uploadStatus,
      });
      return;
    }
    if (!canCalculate) {
      // eslint-disable-next-line no-console
      console.warn(
        "[upload] analyzeUpload blocked by paywall (canCalculate=false)"
      );
      setSelectedTier(null);
      setTariffModalOpen(true);
      return;
    }

    setUploadStatus("processing");
    setUploadStage(0);
    setUploadErrorMsg("");
    setUploadDebugInfo(null);
    setReportProducts([]);
    setReportEstimate(null);
    setReportKeyProducts(null);
    setReportCostCoverage(null);

    // Запускаем парсинг параллельно со стадиями анимации — пока крутятся
    // фейковые «стадии AI», файл уже реально читается. К концу анимации
    // у нас обычно уже есть результат.
    const parsePromise = parseOzonReport(uploadFile);

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setUploadStage(UPLOAD_STAGES.length - 1);
      await new Promise((r) => setTimeout(r, 600));
    } else {
      for (let i = 1; i < UPLOAD_STAGES.length; i++) {
        await new Promise((r) => setTimeout(r, 750));
        setUploadStage(i);
      }
      await new Promise((r) => setTimeout(r, 700));
    }

    const parseResult = await parsePromise;
    // Сохраняем debugInfo всегда — в DEV MODE он отрисуется на ошибочном
    // экране для диагностики реальных файлов Ozon.
    setUploadDebugInfo(parseResult.debugInfo);

    // eslint-disable-next-line no-console
    console.log("[upload] parseResult shape:", {
      ok: parseResult.ok,
      error: parseResult.error,
      hasReport: !!parseResult.report,
      reportEstimate: parseResult.report?.estimate ?? null,
      reportRowsCount: parseResult.report?.rowsCount ?? null,
      debugRowsParsed: parseResult.debugInfo.rowsParsed,
      debugFailedAt: parseResult.debugInfo.failedAt,
      debugWarnings: parseResult.debugInfo.aggregationWarnings.length,
    });

    if (!parseResult.ok || !parseResult.report) {
      // eslint-disable-next-line no-console
      console.warn("[upload] → setUploadStatus('error') (parser returned !ok)", {
        ok: parseResult.ok,
        error: parseResult.error,
        hasReport: !!parseResult.report,
        failedAt: parseResult.debugInfo.failedAt,
        rowsParsed: parseResult.debugInfo.rowsParsed,
      });
      setUploadStatus("error");
      setUploadErrorMsg(
        parseResult.error ||
          "Не удалось распознать отчёт Ozon. Проверьте, что это XLSX-файл из личного кабинета Ozon."
      );
      return;
    }

    // Парс прошёл. Списываем расчёт server-authoritative ДО сохранения/выдачи —
    // кредит не сгорает на ошибке парсинга (consume только после успешного парса).
    const consumed = await consumeCalculation();
    if (!consumed.ok) {
      // eslint-disable-next-line no-console
      console.warn("[upload] consume blocked → paywall", consumed.reason);
      setUploadStatus("ready");
      setSelectedTier(null);
      setTariffModalOpen(true);
      return;
    }

    // eslint-disable-next-line no-console
    console.log("[upload] SUCCESS FLOW START", {
      mp: parseResult.report.marketplace,
      estimate: parseResult.report.estimate,
      rowsCount: parseResult.report.rowsCount,
      period: parseResult.report.period,
    });

    const report = parseResult.report;
    const mp: Marketplace = report.marketplace;
    const est = report.estimate;

    // Per-SKU слой для блока «Чистая прибыль по товарам» (best-effort: пусто,
    // если колонки артикула в отчёте не распознаны — тогда блок не показывается).
    setReportProducts(report.products);
    // estimate — источник общих расходов для распределения по SKU.
    setReportEstimate(est);

    // Финансовая модель из реального отчёта (cost обычно 0 — Ozon не отдаёт
    // себестоимость, юзер может дозаполнить в ручном расчёте).
    const revenue = est.revenue;
    const commission = est.commission;
    const logistics = est.logistics;
    const storage = est.storage;
    const ads = est.ads;
    const cost = est.cost;
    const tax = est.tax;
    const other = est.other;
    const expensesSum =
      commission + logistics + storage + ads + cost + tax + other;
    const profit = revenue - expensesSum;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const now = new Date();

    // Подставляем значения в форму — юзер сможет переключиться на ручной
    // режим и увидеть распарсенные числа.
    setMarketplace(mp);
    setForm({
      revenue: String(Math.round(revenue)),
      commission: String(Math.round(commission)),
      logistics: String(Math.round(logistics)),
      storage: String(Math.round(storage)),
      ads: String(Math.round(ads)),
      cost: String(Math.round(cost)),
      tax: String(Math.round(tax)),
      other: String(Math.round(other)),
    });

    // eslint-disable-next-line no-console
    console.log("[debug] analyzeUpload user.id =", user?.id ?? "(anonymous)");

    const canPersist = !!user?.id;

    let cloudCalcId: string | null = null;
    let cloudCreatedAt: string | null = null;
    let uploadSynced = false;
    let calcErrMsg: string | null = null;

    if (canPersist) {
      const saveRes = await saveCalculationToCloud(
        {
          marketplace: mp,
          mode: "upload" as CloudCalcMode,
          revenue,
          commission,
          logistics,
          ads,
          storage,
          tax,
          cost,
          other_expenses: other,
          total_expenses: expensesSum,
          profit,
          margin,
        },
        user!.id
      );

      if (saveRes.error) {
        calcErrMsg = saveRes.error.message;
      } else if (saveRes.data?.id) {
        cloudCalcId = saveRes.data.id;
        cloudCreatedAt = saveRes.data.created_at;
        uploadSynced = true;
      }
    }

    {
      const res: CalcResult = {
        id: cloudCalcId ?? makeLocalId(),
        marketplace: mp,
        revenue,
        commission,
        logistics,
        storage,
        ads,
        cost,
        tax,
        other,
        expenses: expensesSum,
        profit,
        margin,
        date: now.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        createdAt: cloudCreatedAt ?? now.toISOString(),
        synced: uploadSynced,
      };

      setResult(res);
      setHistory((prev) => [res, ...prev].slice(0, 50));
      setJustCalculated(true);
      window.setTimeout(() => setJustCalculated(false), 2200);
      dismissOnboarding();

      // Период — из парсера, иначе fallback на месяц текущей даты загрузки
      const monthName = now.toLocaleString("ru-RU", { month: "long" });
      const period =
        report.period ?? `За ${monthName} ${now.getFullYear()}`;
      const rowsCount = report.rowsCount;

      // eslint-disable-next-line no-console
      console.log("[upload] → setUploadStatus('success')", {
        mp,
        period,
        rowsCount,
        profit,
        margin,
        synced: uploadSynced,
      });
      setUploadDetected({ marketplace: mp, period, rowsCount });
      setUploadStatus("success");

      // Сохраняем uploaded_report в облако (если есть user и cloud calc id);
      // ID отчёта — либо из облака, либо локальный.
      let reportId: string = makeLocalId();
      if (canPersist) {
        const repRes = await saveUploadedReportToCloud(
          {
            file_name: uploadFile.name,
            file_size: formatFileSize(uploadFile.size),
            marketplace: mp,
            period,
            rows_count: rowsCount,
            calculation_id: cloudCalcId, // может быть null если cloud calc упал
          },
          user!.id
        );
        if (repRes.data?.id) {
          reportId = repRes.data.id;
        } else if (repRes.error) {
          console.warn(
            "analyzeUpload: uploaded_report save failed",
            repRes.error
          );
        }
      }

      setUploadedReports((prev) =>
        [
          {
            id: reportId,
            filename: uploadFile.name,
            marketplace: mp,
            profit,
            margin,
            rowsCount,
            period,
            date: res.date,
          },
          ...prev,
        ].slice(0, 6)
      );

      if (uploadSynced) {
        showToast("Отчёт сохранён", "ok");
      } else if (canPersist && calcErrMsg) {
        showToast("Облако: " + calcErrMsg, "warn");
      } else {
        // Soft fallback (anon / DEV)
        showToast("Отчёт сохранён локально", "warn");
      }
    }
  };

  const resetUploadFlow = () => {
    setUploadFile(null);
    setUploadStatus("idle");
    setUploadStage(0);
    setUploadDetected(null);
    setUploadErrorMsg("");
    setUploadDebugInfo(null);
  };

  const openUploadResults = () => {
    resetUploadFlow();
    setCalcMode("manual");
  };

  // ===== 3-file flow helpers =====
  /** Положить файл в КОНКРЕТНЫЙ слот (через input[type=file] click). */
  const acceptSlot = (
    slot: "xlsx" | "updServices" | "updCommission",
    file: File | null
  ) => {
    if (!file) return;
    const isXlsx = /\.(xlsx|csv)$/i.test(file.name);
    const isPdf = /\.pdf$/i.test(file.name);
    if (slot === "xlsx" && !isXlsx) {
      showToast("Слот 1: только XLSX или CSV", "err");
      return;
    }
    if (slot !== "xlsx" && !isPdf) {
      showToast("Слот УПД: только PDF", "err");
      return;
    }
    if (slot === "xlsx") setSlotXlsx(file);
    if (slot === "updServices") setSlotUpdServices(file);
    if (slot === "updCommission") setSlotUpdCommission(file);
  };

  /**
   * Маршрутизация файлов из drag&drop — мы можем не знать на какой
   * именно слот перетащил пользователь (он мог промахнуться). По типу:
   *  - XLSX/CSV → slot 1 (realization)
   *  - PDF → первый пустой PDF-слот (services → commission)
   * `preferredSlot` подсказывает желаемый слот (если drop попал на конкретный).
   */
  const acceptDroppedFile = (
    file: File | null,
    preferredSlot: "xlsx" | "updServices" | "updCommission" | null
  ) => {
    if (!file) return;
    const isXlsx = /\.(xlsx|csv)$/i.test(file.name);
    const isPdf = /\.pdf$/i.test(file.name);

    if (isXlsx) {
      // XLSX всегда идёт в slot 1, независимо от того, куда дропнули
      if (preferredSlot && preferredSlot !== "xlsx") {
        showToast(`XLSX отправлен в слот 1 (реализация)`, "warn");
      }
      setSlotXlsx(file);
      return;
    }
    if (isPdf) {
      // Если drop попал точно на PDF-слот — кладём туда (даже перезаписав)
      if (preferredSlot === "updServices") {
        setSlotUpdServices(file);
        return;
      }
      if (preferredSlot === "updCommission") {
        setSlotUpdCommission(file);
        return;
      }
      // Иначе — в первый пустой PDF-слот
      if (!slotUpdServices) {
        setSlotUpdServices(file);
      } else if (!slotUpdCommission) {
        setSlotUpdCommission(file);
      } else {
        // Оба заняты — заменяем второй (более вероятный «refresh»)
        setSlotUpdCommission(file);
        showToast("Заменили УПД агентское вознаграждение", "warn");
      }
      return;
    }
    showToast("Только XLSX/CSV (слот 1) или PDF (слоты 2/3)", "err");
  };

  const resetCombinedFlow = () => {
    setSlotXlsx(null);
    setSlotUpdServices(null);
    setSlotUpdCommission(null);
    setCombinedStatus("idle");
    setCombinedError("");
    setCombinedResult(null);
    setCombinedDebug(null);
    setReportProducts([]);
    setReportEstimate(null);
    setReportKeyProducts(null);
    setReportCostCoverage(null);
    setReportCogsTotal(null);
    setShowProfitForm(false);
    setProfitInputs({ ...EMPTY_PROFIT });
    setPayoutSchedule({ ...DEFAULT_PAYOUT_SCHEDULE });
    setCostPriceTouched(false);
    setProfitSaving(false);
    setProfitSaved(false);
    setLastUploadCalc(null);
  };

  const analyzeAllThree = async () => {
    if (!slotXlsx || !slotUpdServices || !slotUpdCommission) {
      showToast("Загрузите все 3 файла", "warn");
      return;
    }
    if (combinedStatus === "processing") return;
    if (!canCalculate) {
      // eslint-disable-next-line no-console
      console.warn("[upload-3] blocked by paywall");
      setSelectedTier(null);
      setTariffModalOpen(true);
      return;
    }

    setCombinedStatus("processing");
    setCombinedError("");
    setCombinedResult(null);
    setCombinedDebug(null);
    setReportProducts([]);
    setReportEstimate(null);
    setReportKeyProducts(null);
    setReportCostCoverage(null);
    setReportCogsTotal(null);

    // eslint-disable-next-line no-console
    console.log("[upload-3] starting parallel parse of 3 files", {
      xlsx: slotXlsx.name,
      updServices: slotUpdServices.name,
      updCommission: slotUpdCommission.name,
    });

    // Параллельный парсинг всех трёх
    const [xlsxRes, updSrvRes, updComRes] = await Promise.all([
      parseOzonReport(slotXlsx),
      parseUpdPdf(slotUpdServices),
      parseUpdPdf(slotUpdCommission),
    ]);

    setCombinedDebug({
      xlsx: xlsxRes.debugInfo,
      updServices: updSrvRes.debugInfo,
      updCommission: updComRes.debugInfo,
    });

    // eslint-disable-next-line no-console
    console.log("[upload-3] parse results:", {
      xlsxOk: xlsxRes.ok,
      xlsxRevenueFromTotals:
        xlsxRes.report?.totals.revenueFromTotalsRow ?? null,
      xlsxLoyaltyFromTotals:
        xlsxRes.report?.totals.loyaltyPayoutsFromTotalsRow ?? null,
      updServicesOk: updSrvRes.ok,
      updServicesTotal: updSrvRes.report?.totalAmount ?? null,
      updCommissionOk: updComRes.ok,
      updCommissionTotal: updComRes.report?.totalAmount ?? null,
    });

    if (!xlsxRes.ok || !xlsxRes.report) {
      setCombinedStatus("error");
      setCombinedError(
        `XLSX: ${xlsxRes.error ?? "не удалось обработать"}`
      );
      return;
    }
    if (!updSrvRes.ok || !updSrvRes.report) {
      setCombinedStatus("error");
      setCombinedError(
        `УПД доп. услуги: ${updSrvRes.error ?? "не удалось обработать"}`
      );
      return;
    }
    if (!updComRes.ok || !updComRes.report) {
      setCombinedStatus("error");
      setCombinedError(
        `УПД агентское: ${updComRes.error ?? "не удалось обработать"}`
      );
      return;
    }

    // STRICT POLICY: revenue из XLSX берётся ТОЛЬКО через text-match строки
    // «Итого реализовано (за вычетом возвратов)». Если text-match не нашёл —
    // парсер возвращает null (никакого numeric fallback'а нет). В этом случае
    // мы НЕ заполняем форму и НЕ показываем результат — это ошибка анализа.
    const revenueFromTotals = xlsxRes.report.totals.revenueFromTotalsRow;
    const loyaltyPayouts =
      xlsxRes.report.totals.loyaltyPayoutsFromTotalsRow ?? 0;
    const updServicesTotal = updSrvRes.report.totalAmount;
    const updCommissionTotal = updComRes.report.totalAmount;

    if (revenueFromTotals === null || revenueFromTotals <= 0) {
      // eslint-disable-next-line no-console
      console.warn(
        "[upload-3] revenue text-match failed — strict policy, no fallback",
        {
          matchedRevenueTotalDetails:
            xlsxRes.debugInfo.matchedRevenueTotalDetails,
        }
      );
      setCombinedStatus("error");
      setCombinedError(
        'Проверьте, что загружен оригинальный файл «Отчёт о реализации товара» из Ozon Seller. Если ошибка повторяется, обновите страницу и загрузите файл заново.'
      );
      return;
    }

    // PR #25: дубль-гард ДО списания. Месяц — из периода отчёта (приоритет) или
    // имени XLSX-файла; если месяц надёжно не определить (null) → НЕ блокируем,
    // сохранение важнее. «Отмена» → откатываем статус в idle и выходим ДО
    // consumeCalculation (попытка НЕ списывается).
    const uploadMonth = resolveReportMonth(
      xlsxRes.report.period,
      slotXlsx?.name ?? null
    );
    if (
      !(await confirmNoMonthDuplicate(
        uploadMonth ? uploadMonth.slice(0, 7) : null,
        "ozon"
      ))
    ) {
      setCombinedStatus("idle");
      return;
    }

    // Все парсы прошли. Списываем расчёт server-authoritative ДО построения и
    // сохранения результата — кредит не сгорает на ошибке парсинга файлов.
    const consumed = await consumeCalculation();
    if (!consumed.ok) {
      // eslint-disable-next-line no-console
      console.warn("[upload-3] consume blocked → paywall", consumed.reason);
      setCombinedStatus("idle");
      setSelectedTier(null);
      setTariffModalOpen(true);
      return;
    }

    const revenue = revenueFromTotals;

    const profitBeforeCost =
      revenue + loyaltyPayouts - updServicesTotal - updCommissionTotal;

    // eslint-disable-next-line no-console
    console.log("[upload-3] FORMULA:", {
      revenue,
      loyaltyPayouts,
      updServicesTotal,
      updCommissionTotal,
      profitBeforeCost,
    });

    setCombinedResult({
      revenue,
      loyaltyPayouts,
      updServicesTotal,
      updCommissionTotal,
      profitBeforeCost,
      period: xlsxRes.report.period,
      // Имя файла Ozon — fallback для определения месяца, если период из
      // содержимого XLSX не распознан (приоритет 2 в resolveReportMonth).
      sourceFileName: slotXlsx?.name ?? null,
    });

    // Per-SKU слой из XLSX-отчёта — для блока «Чистая прибыль по товарам».
    setReportProducts(xlsxRes.report.products);
    setReportEstimate(xlsxRes.report.estimate);

    // Автозаполнение блока «Дополнительные расходы».
    // ads — единственное поле, которое безопасно брать из отчёта: estimate.ads
    // информационное и НЕ входит в profitBeforeCost, поэтому двойного учёта нет.
    // Остальные поля остаются ручными: estimate.other = возвраты + лояльность,
    // которые уже учтены в profitBeforeCost; estimate.cost всегда 0. costPrice
    // заполняется отдельным эффектом из суммарной себестоимости каталога
    // (onCogsTotal → reportCogsTotal). tax остаётся ручным процентом (0% по умолч.).
    const adsFromReport = xlsxRes.report.estimate.ads;
    setProfitInputs({
      ...EMPTY_PROFIT,
      ads: adsFromReport > 0 ? String(Math.round(adsFromReport)) : "",
    });
    // Новый отчёт → график выплат снова стандартный (0%).
    setPayoutSchedule({ ...DEFAULT_PAYOUT_SCHEDULE });
    // Новый отчёт → поле «Себестоимость товара» снова под автосинком с COGS.
    setCostPriceTouched(false);

    // Автозаполнение формы в manual mode (для last-mile проверки/правок).
    // Объединяем доход (revenue + loyaltyPayouts) и расходы (Ozon-комиссии).
    setForm({
      ...EMPTY,
      revenue: String((revenue + loyaltyPayouts).toFixed(2)),
      commission: String(updServicesTotal.toFixed(2)),
      logistics: String(updCommissionTotal.toFixed(2)),
    });

    // Сохраняем результат 3-file flow в историю + Supabase как calculation (mode='upload').
    // Все доп. расходы = 0, поэтому identity profit = revenue − total_expenses (= profitBeforeCost).
    {
      const now = new Date();
      const incomeRevenue = revenue + loyaltyPayouts;
      const upExpenses = updServicesTotal + updCommissionTotal;
      const upMargin =
        incomeRevenue > 0 ? (profitBeforeCost / incomeRevenue) * 100 : 0;

      // Разбор для ai_insights — чтобы клик по истории мог восстановить
      // combinedResult и (после ввода себестоимости) форму чистой прибыли.
      // На этом этапе все доп. расходы = 0 (черновик до ввода себестоимости).
      const breakdown: NetProfitBreakdown = {
        kind: "net-profit-3file",
        roi: 0,
        taxPercent: 0,
        costPrice: 0,
        tax: 0,
        ads: 0,
        packaging: 0,
        deliveryToWarehouse: 0,
        salary: 0,
        other: 0,
        updServicesTotal,
        updCommissionTotal,
        revenueOzon: revenue,
        loyaltyPayouts,
        profitBeforeCost,
        reportPeriod: xlsxRes.report.period,
        // Сохраняем per-SKU строки + estimate в snapshot, чтобы клик по истории
        // мог пересчитать себестоимость по актуальному каталогу товаров.
        products: xlsxRes.report.products,
        estimate: xlsxRes.report.estimate,
      };

      const canPersist = !!user?.id;
      let cloudCalcId: string | null = null;
      let cloudCreatedAt: string | null = null;
      let synced = false;
      let calcErrMsg: string | null = null;

      if (canPersist) {
        const saveRes = await saveCalculationToCloud(
          {
            marketplace: "ozon",
            mode: "upload" as CloudCalcMode,
            revenue: incomeRevenue,
            commission: updServicesTotal,
            logistics: updCommissionTotal,
            ads: 0,
            storage: 0,
            tax: 0,
            cost: 0,
            other_expenses: 0,
            total_expenses: upExpenses,
            profit: profitBeforeCost,
            margin: upMargin,
            ai_insights: breakdown,
          },
          user!.id
        );
        if (saveRes.error) {
          calcErrMsg = saveRes.error.message;
        } else if (saveRes.data?.id) {
          cloudCalcId = saveRes.data.id;
          cloudCreatedAt = saveRes.data.created_at;
          synced = true;
        }
      }

      const res: CalcResult = {
        id: cloudCalcId ?? makeLocalId(),
        marketplace: "ozon",
        revenue: incomeRevenue,
        commission: updServicesTotal,
        logistics: updCommissionTotal,
        storage: 0,
        ads: 0,
        cost: 0,
        tax: 0,
        other: 0,
        expenses: upExpenses,
        profit: profitBeforeCost,
        margin: upMargin,
        aiInsights: breakdown,
        date: now.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        createdAt: cloudCreatedAt ?? now.toISOString(),
        synced,
      };

      setHistory((prev) => [res, ...prev].slice(0, 50));
      // Запоминаем эту строку — «Сохранить результат» обновит ИМЕННО её.
      setLastUploadCalc({ id: res.id, synced });

      if (synced) {
        showToast("Расчёт сохранён", "ok");
      } else if (canPersist && calcErrMsg) {
        showToast("Облако: " + calcErrMsg, "warn");
      } else {
        showToast("Расчёт сохранён локально", "warn");
      }
    }

    setCombinedStatus("success");
  };
  const [tariffModalOpen, setTariffModalOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<TariffTier | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [analysisStage, setAnalysisStage] = useState(0);

  // циклируем стадии AI-анализа каждые ~700мс пока идёт расчёт
  useEffect(() => {
    if (!isCalculating) {
      setAnalysisStage(0);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setAnalysisStage(AI_STAGES.length - 1);
      return;
    }

    setAnalysisStage(0);
    let i = 0;
    const interval = window.setInterval(() => {
      i++;
      if (i < AI_STAGES.length) {
        setAnalysisStage(i);
      } else {
        window.clearInterval(interval);
      }
    }, 700);

    return () => window.clearInterval(interval);
  }, [isCalculating]);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  type ToastType = "ok" | "warn" | "err";
  const [toast, setToast] = useState<
    { id: number; message: string; type: ToastType } | null
  >(null);

  // Монотонный счётчик id тоста через ref (вместо Date.now(): уникально в сессии,
  // не может коллизнуть при двух тостах в одну мс, и не тянет impure Date.now в
  // анализ React-компилятора). Поведение UX не меняется — id только React-key.
  const toastIdRef = useRef(0);
  const showToast = (message: string, type: ToastType = "ok") => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message, type });
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  const [justCalculated, setJustCalculated] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem("mprof_onboarded")) {
        setShowOnboarding(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    try {
      localStorage.setItem("mprof_onboarded", "1");
    } catch {
      /* ignore */
    }
  };
  /* ===== Analytics filters ===== */
  type FilterPeriod = "7" | "14" | "30" | "all";
  type FilterMp = "all" | "ozon" | "wb";
  type FilterResult = "all" | "profit" | "loss";
  // Быстрый фильтр по прибыли ВНУТРИ блока «Последние расчёты»:
  // net — чистая прибыль (ручной/с себестоимостью, ≥0);
  // before — прибыль до себестоимости (отчёт без себестоимости, ≥0);
  // loss — убыток (profit < 0).
  type HistProfitFilter = "all" | "net" | "before" | "loss";
  const [filterPeriod, setFilterPeriod] = useState<FilterPeriod>("all");
  // Ozon-only: маркетплейс-фильтр убран из UI, значение зафиксировано на "all"
  // (фильтрация по площадке не нужна; тип/значения сохранены для совместимости).
  const [filterMp] = useState<FilterMp>("all");
  const [filterResult, setFilterResult] = useState<FilterResult>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Поиск (по периоду отчёта / дате создания / типу расчёта) и быстрый фильтр
  // по прибыли. Чисто фронтовая фильтрация уже загруженной истории — на
  // статистику, AnalyticsBlock, формулы, Supabase и сохранение НЕ влияет.
  const [histSearch, setHistSearch] = useState("");
  const [histProfitFilter, setHistProfitFilter] =
    useState<HistProfitFilter>("all");
  // Фильтр по месяцу отчёта в «Последние расчёты»: 'all' | 'YYYY-MM'. Только UI.
  const [filterMonth, setFilterMonth] = useState<string>("all");
  // Компактный дропдаун выбора месяца (в панели фильтров истории). Только UI.
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const monthMenuRef = useRef<HTMLDivElement | null>(null);
  // Раскрытые строки «Последних расчётов» (мини-разбивка). Множественное
  // раскрытие — каждая строка независима. Только UI, данные не пересчитываются.
  const [expandedHist, setExpandedHist] = useState<Set<string>>(
    () => new Set()
  );
  const toggleHistDetails = (id: string) => {
    setExpandedHist((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Закрытие дропдауна месяца по клику вне и по Escape. Только UI.
  useEffect(() => {
    if (!monthMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (monthMenuRef.current && !monthMenuRef.current.contains(e.target as Node)) {
        setMonthMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMonthMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [monthMenuOpen]);

  const filterPeriodLabel =
    filterPeriod === "all" ? "всё время" : `${filterPeriod} дней`;
  const filterResultLabel =
    filterResult === "all"
      ? "все результаты"
      : filterResult === "profit"
      ? "прибыльные"
      : "убыточные";

  const filtersActive =
    filterPeriod !== "all" || filterMp !== "all" || filterResult !== "all";

  const filteredHistory = useMemo(() => {
    let arr = history;

    if (filterPeriod !== "all") {
      const days = parseInt(filterPeriod, 10);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      arr = arr.filter((h) => {
        const t = h.createdAt ? new Date(h.createdAt).getTime() : 0;
        return t >= cutoff;
      });
    }

    if (filterMp !== "all") {
      arr = arr.filter((h) => h.marketplace === filterMp);
    }

    if (filterResult !== "all") {
      arr = arr.filter((h) =>
        filterResult === "profit" ? h.profit >= 0 : h.profit < 0
      );
    }

    return arr;
  }, [history, filterPeriod, filterMp, filterResult]);

  // Список «Последние расчёты» = filteredHistory + локальные поиск и быстрый
  // фильтр по прибыли. Отдельная деривация, чтобы НЕ влиять на статистику и
  // AnalyticsBlock (они продолжают читать filteredHistory). Категория прибыли
  // зеркалит подпись в строке: убыток → loss; отчёт без себестоимости → before;
  // иначе (ручной/с себестоимостью) → net.
  const visibleHistory = useMemo(() => {
    const q = histSearch.trim().toLowerCase();
    const arr = filteredHistory.filter((h) => {
      if (filterMonth !== "all" && histReportMonthKey(h) !== filterMonth) {
        return false;
      }
      if (histProfitFilter !== "all") {
        let cat: HistProfitFilter;
        if (h.profit < 0) {
          cat = "loss";
        } else {
          const b = asNetProfitBreakdown(h.aiInsights);
          cat = b && (b.costPrice ?? 0) <= 0 ? "before" : "net";
        }
        if (cat !== histProfitFilter) return false;
      }
      if (q !== "") {
        const b = asNetProfitBreakdown(h.aiInsights);
        const mpName = h.marketplace === "ozon" ? "Ozon" : "WB";
        const title = b ? `Отчёт ${mpName}` : `Ручной расчёт ${mpName}`;
        const hay = `${title} ${b?.reportPeriod ?? ""} ${h.date}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Порядок: по месяцу отчёта от нового к старому ('YYYY-MM' убыв.); записи
    // без понятного месяца — ниже всех; внутри месяца новее создан → выше.
    // Чисто UI-сортировка (.filter уже вернул новый массив), на статистику,
    // формулы и Supabase не влияет.
    return arr.sort((a, b) => {
      const ma = histReportMonthKey(a); // 'YYYY-MM' | null
      const mb = histReportMonthKey(b);
      if (ma !== mb) {
        if (ma === null) return 1;
        if (mb === null) return -1;
        return ma < mb ? 1 : -1;
      }
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [filteredHistory, histSearch, histProfitFilter, filterMonth]);

  // Месяцы для фильтра «Последние расчёты» — из периодов загруженных отчётов.
  // Сортировка: новые месяцы первыми. Чисто UI; не агрегирует и не пересчитывает.
  const monthOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const h of history) {
      const k = histReportMonthKey(h);
      if (k) keys.add(k);
    }
    return Array.from(keys)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .map((k) => ({ key: k, label: formatMonthLabel(k) }));
  }, [history]);

  // Отдельный порядок ТОЛЬКО для графиков блока «Аналитика прибыли»:
  // хронологический — старый месяц слева → новый справа (Май → Июнь → Июль).
  // Список «Последние расчёты» (visibleHistory, новые сверху) и статистика
  // (filteredHistory) НЕ затрагиваются. Записи без понятного месяца считаем
  // «самыми ранними» (слева). Внутри месяца — старее создан левее.
  const chartHistory = useMemo(() => {
    return filteredHistory.slice().sort((a, b) => {
      const ma = histReportMonthKey(a); // 'YYYY-MM' | null
      const mb = histReportMonthKey(b);
      if (ma !== mb) {
        if (ma === null) return -1;
        if (mb === null) return 1;
        return ma < mb ? -1 : 1;
      }
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
  }, [filteredHistory]);

  const totalRevenue = filteredHistory.reduce((sum, h) => sum + h.revenue, 0);
  const totalProfit = filteredHistory.reduce((sum, h) => sum + h.profit, 0);
  const avgMargin =
    filteredHistory.length > 0
      ? filteredHistory.reduce((sum, h) => sum + h.margin, 0) /
        filteredHistory.length
      : 0;

  /* ===== Вкладка «Отчёты»: годовая сводка =====
     Всё считается ТОЛЬКО на фронте по уже загруженной истории (history). Новых
     запросов, таблиц и изменений сохранения нет. Денежные поля, которых в
     расчётах фактически нет (нулевые суммы), в сводке НЕ показываем — данные не
     выдумываем. Фильтры: год (по calcMonthKey) + тип расчёта (mode). */
  type ReportsType = "all" | "api" | "manual" | "upload";
  const [reportsYear, setReportsYear] = useState<string>("all");
  const [reportsType, setReportsType] = useState<ReportsType>("all");

  // Годы, за которые реально есть расчёты (новые сверху). Только UI-деривация.
  const reportsYears = useMemo(() => {
    const set = new Set<string>();
    for (const h of history) {
      const k = calcMonthKey(h);
      if (k) set.add(k.slice(0, 4));
    }
    return Array.from(set).sort((a, b) => Number(b) - Number(a));
  }, [history]);

  // Если выбранный год пропал из данных (например, после очистки истории) —
  // молча сбрасываем фильтр на «всё время», чтобы вкладка не оказалась пустой.
  useEffect(() => {
    if (reportsYear !== "all" && !reportsYears.includes(reportsYear)) {
      setReportsYear("all");
    }
  }, [reportsYear, reportsYears]);

  // История под фильтрами «Отчётов» (год + тип). Базируется на полном history,
  // НЕ на filteredHistory, чтобы фильтры вкладки были независимы от фильтров
  // детальной аналитики (период/маркетплейс/результат).
  const reportsFiltered = useMemo(() => {
    return history.filter((h) => {
      if (reportsType !== "all" && (h.mode ?? "manual") !== reportsType) {
        return false;
      }
      if (reportsYear !== "all") {
        const k = calcMonthKey(h);
        if (!k || k.slice(0, 4) !== reportsYear) return false;
      }
      return true;
    });
  }, [history, reportsYear, reportsType]);

  // Помесячная разбивка прибыли/выручки (для графика и лучшего/худшего месяца).
  // Записи без распознанного месяца в разбивку не попадают (но остаются в общих
  // суммах сводки). Хронологический порядок: старый месяц слева → новый справа.
  const reportsMonthly = useMemo(() => {
    const map = new Map<
      string,
      { key: string; profit: number; revenue: number; count: number }
    >();
    for (const h of reportsFiltered) {
      const k = calcMonthKey(h);
      if (!k) continue;
      const cur =
        map.get(k) ?? { key: k, profit: 0, revenue: 0, count: 0 };
      cur.profit += Number(h.profit) || 0;
      cur.revenue += Number(h.revenue) || 0;
      cur.count += 1;
      map.set(k, cur);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    );
  }, [reportsFiltered]);

  // Годовая сводка. null — под фильтром нет расчётов. Денежные агрегаты
  // отдаём как есть; решение «показывать ли карточку» (sum>0) принимает UI.
  const yearlySummary = useMemo(() => {
    const items = reportsFiltered;
    const count = items.length;
    if (count === 0) return null;
    const sum = (sel: (h: CalcResult) => number) =>
      items.reduce((s, h) => s + (Number(sel(h)) || 0), 0);
    const revenue = sum((h) => h.revenue);
    const profit = sum((h) => h.profit);
    const cost = sum((h) => h.cost);
    const expenses = sum((h) => h.expenses);
    const commission = sum((h) => h.commission);
    const logistics = sum((h) => h.logistics);
    const storage = sum((h) => h.storage);
    const ads = sum((h) => h.ads);
    const tax = sum((h) => h.tax);
    const other = sum((h) => h.other);
    // Комиссии и логистика Ozon = комиссия + логистика + хранение.
    const ozonFees = commission + logistics + storage;

    // PR B: taxonomy-aware gross-разбивка для честного отчёта (чистая функция
    // модульного уровня). Для записей с валидной financeTaxonomy — gross charges
    // и отдельный доход-компенсации; для старых — flat без выдуманного дохода.
    // Без double count: расходы берут charges, доход вычитается один раз, итог =
    // stored total_expenses.
    const taxAgg = aggregateReportsTaxonomy(items);
    const logisticsCharges = taxAgg.logisticsCharges;
    const adsCharges = taxAgg.adsCharges;
    const otherCharges = taxAgg.otherCharges;
    const manualExtraExpenses = taxAgg.manualExtraExpenses;
    const ozonIncome = taxAgg.ozonIncome;
    // «Комиссии и логистика Ozon» для честной модели — на gross-логистике.
    const ozonFeesCharges =
      Math.round((commission + logisticsCharges + storage) * 100) / 100;
    // Средняя маржинальность: по выручке, если она есть; иначе среднее по margin.
    const avgMargin =
      revenue > 0
        ? (profit / revenue) * 100
        : items.reduce((s, h) => s + (Number(h.margin) || 0), 0) / count;
    let best: { key: string; profit: number } | null = null;
    let worst: { key: string; profit: number } | null = null;
    for (const m of reportsMonthly) {
      if (!best || m.profit > best.profit) best = { key: m.key, profit: m.profit };
      if (!worst || m.profit < worst.profit) worst = { key: m.key, profit: m.profit };
    }
    // Лучший/худший месяц имеет смысл только при ≥2 месяцах с данными.
    if (reportsMonthly.length < 2) {
      best = null;
      worst = null;
    }
    return {
      count,
      revenue,
      profit,
      cost,
      expenses,
      commission,
      logistics,
      storage,
      ads,
      tax,
      other,
      ozonFees,
      // PR B: honest taxonomy-aware поля (аддитивно; старые поля не тронуты).
      logisticsCharges,
      adsCharges,
      otherCharges,
      manualExtraExpenses,
      ozonIncome,
      ozonFeesCharges,
      avgMargin,
      best,
      worst,
    };
  }, [reportsFiltered, reportsMonthly]);

  const [authLoading, setAuthLoading] = useState(true);

  // 1) Восстанавливаем сессию из localStorage через Supabase getSession()
  //    + слушаем все последующие изменения auth (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED)
  useEffect(() => {
    let mounted = true;
    let loadingCleared = false;

    // "Проверяем сессию…" ОБЯЗАНО сняться при любом исходе. Раньше
    // setAuthLoading(false) вызывался ТОЛЬКО внутри getSession().then(...), без
    // catch/finally/timeout — поэтому reject или зависание getSession (известная
    // проблема navigator-lock / refresh в supabase-js) держали экран в вечном
    // "Проверяем сессию…". Теперь снимаем loading гарантированно (3 страховки:
    // finally, событие INITIAL_SESSION и таймаут).
    const clearAuthLoading = () => {
      if (mounted && !loadingCleared) {
        loadingCleared = true;
        setAuthLoading(false);
      }
    };

    // Подгрузка данных пользователя НЕ должна блокировать снятие loading.
    const loadUserData = (uid: string) => {
      loadHistory(uid).then((calcs) => {
        fetchOzonConnection();
        fetchPerfConnection();
        loadUploadedReportsCloud(uid, calcs);
      });
    };

    // Последний рубеж: если getSession не ответит — не держим экран бесконечно.
    const safety = setTimeout(() => {
      if (mounted && !loadingCleared) {
        // eslint-disable-next-line no-console
        console.warn("[auth] getSession не ответил за 8с — снимаем loading");
        clearAuthLoading();
      }
    }, 8000);

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        const u = data.session?.user ?? null;
        // eslint-disable-next-line no-console
        console.log("[debug] getSession user.id =", u?.id ?? "(no session)");
        setUser(u);
        if (u?.id) loadUserData(u.id);
        else loadHistory(null);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[auth] getSession error", e);
        if (mounted) {
          setUser(null);
          loadHistory(null);
        }
      })
      .finally(() => {
        clearTimeout(safety);
        clearAuthLoading();
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      const u = session?.user ?? null;
      setUser(u);
      // Резерв: INITIAL_SESSION snimaet loading, даже если getSession завис.
      clearAuthLoading();

      // ВАЖНО: не await-им supabase-вызовы прямо в колбэке onAuthStateChange —
      // это дедлок внутреннего lock auth-token (после него getSession() висит).
      // Откладываем загрузку данных в макро-таск, чтобы колбэк отдал lock.
      if (event === "SIGNED_IN" && u?.id) {
        setTimeout(() => {
          if (mounted) loadUserData(u.id);
        }, 0);
      }
      if (event === "SIGNED_OUT") {
        setHistory([]);
        setResult(null);
        setOzonClientId("");
        setOzonApiKey("");
        setOzonConn(null);
        setOzonConnError("");
        setUploadedReports([]);
      }
    });

    return () => {
      mounted = false;
      clearTimeout(safety);
      sub.subscription.unsubscribe();
    };
  }, []);

  // ОСНОВНОЙ вход для MVP — email + пароль. Не зависит от SMTP/лимитов писем
  // (в отличие от magic-link). Supabase signInWithPassword при успехе сам выставит
  // сессию → onAuthStateChange(SIGNED_IN) подхватит user и покажет дашборд (форма
  // скрыта по `!user`), мы уже на /app — ручной редирект не нужен.
  const signIn = async () => {
    if (signingIn || signingUp) return; // защита от двойного клика
    const emailTrim = email.trim();
    if (!emailTrim) {
      setAuthMessage("Введите email");
      return;
    }
    if (password.length < 6) {
      setAuthMessage("Пароль слишком короткий — минимум 6 символов.");
      return;
    }

    setSigningIn(true);
    setAuthMessage("");

    // ВАЖНО про вечное «Входим…». supabase-js сериализует auth-операции через
    // navigator LockManager. Если лок держит зависшая операция (например,
    // getSession при загрузке /app), то signInWithPassword ждёт лок и его промис
    // не резолвится НИКОГДА: await не возвращается → finally не срабатывает →
    // кнопка застревает в «Входим…». Лечим гонкой с 15-сек таймаутом — await
    // гарантированно завершается, и finally всегда снимает loading.
    const TIMED_OUT = Symbol("auth-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), 15000);
      });
      const outcome = await Promise.race([
        supabase.auth.signInWithPassword({ email: emailTrim, password }),
        timeout,
      ]);

      if (outcome === TIMED_OUT) {
        // Не «неверный пароль» — счётчик неудач не трогаем. Если запрос всё же
        // завершится успехом позже, onAuthStateChange(SIGNED_IN) откроет /app.
        setAuthMessage(
          "Вход занимает слишком много времени. Проверьте интернет и попробуйте ещё раз."
        );
        return;
      }

      const { error } = outcome;
      if (error) {
        // Неудачный вход → счётчик +1. На 3-й ошибке появится «Забыли пароль?».
        setFailedAttempts((n) => n + 1);
        setAuthMessage(loginErrorRu(error.message));
      } else {
        // Успех: сбрасываем счётчик. onAuthStateChange(SIGNED_IN) покажет /app
        // (форма скрыта по `!user`) — мы уже на /app, ручной редирект не нужен.
        setFailedAttempts(0);
      }
    } catch (e) {
      // e не содержит пароль (его нет в ошибках signInWithPassword) — лог
      // безопасен; email отдельно не логируем.
      // eslint-disable-next-line no-console
      console.error("[auth] signInWithPassword error", e);
      // Сетевая ошибка — это не «неверный пароль», счётчик не трогаем.
      const msg = e instanceof Error ? e.message : String(e);
      setAuthMessage(loginErrorRu(msg));
    } finally {
      if (timer) clearTimeout(timer);
      setSigningIn(false);
    }
  };

  // Регистрация email + пароль. Если в Supabase ОТКЛЮЧЕНО подтверждение email
  // (рекомендуется для MVP) — signUp сразу вернёт session → onAuthStateChange
  // войдёт в дашборд. Если подтверждение ВКЛЮЧЕНО — session отсутствует, поэтому
  // просим подтвердить почту (это снова зависит от SMTP).
  const signUp = async () => {
    if (signingIn || signingUp) return;
    const emailTrim = email.trim();
    if (!emailTrim) {
      setAuthMessage("Введите email");
      return;
    }
    if (password.length < 6) {
      setAuthMessage("Пароль слишком короткий — минимум 6 символов.");
      return;
    }

    setSigningUp(true);
    setAuthMessage("");
    try {
      const { data, error } = await supabase.auth.signUp({
        email: emailTrim,
        password,
      });
      if (error) {
        setAuthMessage(authErrorRu(error.message));
      } else if (!data.session) {
        // Подтверждение email включено: письмо ушло, сессии пока нет.
        setAuthMessage(
          "Аккаунт создан. Подтвердите email по ссылке в письме, затем войдите."
        );
      }
      // Если session есть — onAuthStateChange(SIGNED_IN) сам покажет дашборд /app.
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] signUp error", e);
      setAuthMessage("Ошибка соединения. Проверьте интернет и попробуйте ещё раз.");
    } finally {
      setSigningUp(false);
    }
  };

  // Восстановление пароля. БЕЗОПАСНОСТЬ: здесь пароль НЕ меняется. Мы лишь
  // запускаем официальный flow Supabase — на почту уходит ссылка, и только
  // перейдя по ней (получив recovery-сессию), пользователь сможет задать новый
  // пароль на /auth/update-password. Сменить пароль «просто по введённому email»
  // нельзя — без доступа к почте recovery-сессии не будет.
  const requestPasswordReset = async () => {
    if (resetSending || resetCooldown > 0) return; // анти-дабл-клик + кулдаун
    const emailTrim = email.trim();
    if (!emailTrim) {
      setAuthMessage("Введите email, чтобы восстановить пароль.");
      return;
    }
    if (!isValidEmail(emailTrim)) {
      setAuthMessage("Некорректный email.");
      return;
    }

    // Ссылка должна вести на ТОТ ЖЕ хост, где открыто приложение; origin окна —
    // основной источник, NEXT_PUBLIC_SITE_URL — только fallback для SSR.
    const fallbackUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
    const baseUrl =
      typeof window !== "undefined" ? window.location.origin : fallbackUrl;
    const redirectTo = `${baseUrl}/auth/update-password`;

    setResetSending(true);
    setAuthMessage("");

    // То же лекарство от вечного «Отправляем…», что и у входа: resetPasswordForEmail
    // идёт через navigator-lock + сеть (Supabase → SMTP). Если лок держит зависшая
    // auth-операция или SMTP тупит — промис не резолвится, await не возвращается,
    // finally не снимает loading → кнопка застревает. Гонка с 15-сек таймаутом
    // гарантирует, что await завершится и finally всегда разблокирует кнопку.
    const TIMED_OUT = Symbol("reset-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), 15000);
      });
      // Существование аккаунта НЕ раскрываем: что бы ни вернул Supabase
      // (успех или ошибку уровня API), наружу показываем одно нейтральное
      // сообщение. Реальную ошибку пишем только в консоль для отладки.
      const outcome = await Promise.race([
        supabase.auth.resetPasswordForEmail(emailTrim, { redirectTo }),
        timeout,
      ]);

      if (outcome === TIMED_OUT) {
        // Нейтральный текст про таймаут — существование email не раскрываем.
        // Кулдаун НЕ ставим: пользователь должен иметь возможность повторить.
        setAuthMessage(
          "Отправка занимает слишком много времени. Попробуйте ещё раз."
        );
        return;
      }

      const { error } = outcome;
      if (error) {
        // eslint-disable-next-line no-console
        console.error("[auth] resetPasswordForEmail error", error.message);
      }
      setAuthMessage(
        "Если аккаунт с таким email существует, мы отправили ссылку для восстановления пароля."
      );
      // Анти-спам: 60 секунд блокируем повторную отправку.
      setResetCooldown(60);
    } catch (e) {
      // Сетевой сбой (до Supabase не достучались) — здесь существование аккаунта
      // не раскрывается, поэтому можно прямо сказать, что не отправилось.
      // eslint-disable-next-line no-console
      console.error("[auth] resetPasswordForEmail exception", e);
      setAuthMessage(
        "Не удалось отправить письмо восстановления. Попробуйте позже."
      );
    } finally {
      if (timer) clearTimeout(timer);
      setResetSending(false);
    }
  };

  // Тик кулдауна восстановления: раз в секунду уменьшаем счётчик до нуля.
  useEffect(() => {
    if (resetCooldown <= 0) return;
    const t = setTimeout(
      () => setResetCooldown((s) => Math.max(0, s - 1)),
      1000
    );
    return () => clearTimeout(t);
  }, [resetCooldown]);

  // FALLBACK (оставлен намеренно, НЕ удалять): прежний вход по magic-link без
  // пароля. Сейчас в UI не используется — основной способ email+пароль. Чтобы
  // быстро вернуть вход по ссылке, повесь этот обработчик на кнопку.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const signInWithMagicLink = async () => {
    if (signingIn) return;
    if (!email.trim()) {
      setAuthMessage("Введите email");
      return;
    }
    // origin ТЕКУЩЕГО окна — билд работает на любом хосте; NEXT_PUBLIC_SITE_URL —
    // только fallback для SSR/пререндера.
    const fallbackUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
    const baseUrl =
      typeof window !== "undefined" ? window.location.origin : fallbackUrl;
    const emailRedirectTo = `${baseUrl}/app`;

    setSigningIn(true);
    setAuthMessage("");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo },
      });
      if (error) {
        setAuthMessage(error.message);
      } else {
        setAuthMessage(
          `Ссылку для входа отправили на ${email.trim()}. Проверьте почту.`
        );
      }
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = async () => {
    // Выход обязан срабатывать при ЛЮБОМ исходе. Раньше был голый
    // `await supabase.auth.signOut()` без try/catch: дефолтный global-scope делает
    // сетевой revoke токена, который может зависнуть/упасть (navigator-lock /
    // refresh в supabase-js — та же проблема, что у getSession). Тогда промис не
    // резолвится → строки после await не выполняются → пользователь остаётся
    // «залогинен». Лечим: scope:'local' (без сети, сразу чистит локальную сессию
    // из localStorage) + try/finally, чтобы выход завершился всегда.
    if (signingOut) return; // анти-дабл-клик: один выход за раз, не плодим запросы
    setSigningOut(true);

    // Жёсткая зачистка локальной сессии Supabase. Делаем сами на случай, если
    // signOut зависнет на navigator-lock и сработает таймаут: после перезагрузки
    // getSession не должен «воскресить» пользователя из localStorage. Ключ
    // Supabase — sb-<ref>-auth-token; чистим все совпадения, не привязываясь к ref.
    const purgeLocalSession = () => {
      try {
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith("sb-") && key.includes("-auth-token")) {
            window.localStorage.removeItem(key);
          }
        }
      } catch {
        /* localStorage недоступен — игнор */
      }
    };

    // scope:'local' не ходит в сеть, но всё равно проходит через navigator-lock и
    // может ждать зависшую getSession/refresh. Раньше без таймаута await мог
    // не вернуться → finally (с редиректом) не выполнялся → выход «требовал
    // 3–5 кликов». Гонка с 10-сек таймаутом гарантирует завершение await.
    const TIMED_OUT = Symbol("signout-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), 10000);
      });
      await Promise.race([
        supabase.auth.signOut({ scope: "local" }),
        timeout,
      ]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] signOut error", e);
    } finally {
      if (timer) clearTimeout(timer);
      // Принудительная очистка локального auth-state при ЛЮБОМ исходе (в т.ч. таймаут).
      purgeLocalSession();
      // Сброс in-memory state.
      setUser(null);
      setHistory([]);
      setResult(null);
      setUploadedReports([]);
      setOzonClientId("");
      setOzonApiKey("");
      setOzonConn(null);
      setOzonConnError("");
      // Премиум-баннер — device-pref, привязанный к показу premium: сбрасываем,
      // чтобы состояние одного аккаунта не «утекло» следующему. mprof_calc_count
      // (анти-абуз анонимного лимита) и mprof_onboarded НЕ трогаем.
      try {
        window.localStorage.removeItem("mprof_unlimited_banner_hidden");
      } catch {
        /* localStorage недоступен — игнор */
      }
      // useEntitlements не слушает onAuthStateChange и грузится только на mount —
      // hasPremium/singleCredits/profile НЕ сбросятся без перезагрузки документа
      // (router.refresh() не пересоздаёт client-компоненты). Поэтому жёсткий
      // переход на "/" — гарантированный полный сброс user/session/profile/прав.
      window.location.href = "/";
    }
  };

  // Bearer-токен текущей сессии Supabase — для наших /api/ozon/*. user_id сервер
  // берёт ИЗ токена, не из тела. Без сессии возвращаем пустые заголовки.
  const ozonAuthHeaders = async (): Promise<Record<string, string>> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // Строка БД → локальный безопасный вид (без ключа). Один маппинг на все ответы.
  const applyOzonView = (data: OzonConnResponse) => {
    setOzonConn({
      connected: !!data.connected,
      status: (data.status as OzonConnStatus) ?? "not_connected",
      clientIdMasked: data.clientIdMasked,
      keyLast4: data.keyLast4 ?? null,
      lastCheckedAt: data.lastCheckedAt ?? null,
      lastError: data.lastError ?? null,
      updatedAt: data.updatedAt ?? null,
    });
  };

  // GET статус подключения (без ключа). Гостя/сбой сети тихо трактуем как «не
  // подключено» — это не ошибка пользователя.
  const fetchOzonConnection = async () => {
    setOzonConnLoading(true);
    setOzonConnError("");
    try {
      const headers = await ozonAuthHeaders();
      if (!headers.Authorization) {
        setOzonConn(null);
        return;
      }
      const res = await fetch("/api/ozon/connection", {
        method: "GET",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as OzonConnResponse;
      if (!res.ok) {
        setOzonConn(null);
        return;
      }
      applyOzonView(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("fetchOzonConnection error:", e);
      setOzonConn(null);
    } finally {
      setOzonConnLoading(false);
    }
  };

  // POST подключить: {clientId, apiKey} → сервер проверяет ключ у Ozon, шифрует и
  // сохраняет. Сырой ключ после успеха стираем из state и прячем глазок.
  const connectOzon = async () => {
    if (!user?.id) {
      setOzonConnError("Войдите в аккаунт, чтобы подключить Ozon");
      return;
    }
    const clientId = ozonClientId.trim();
    const apiKey = ozonApiKey.trim();
    if (clientId.length < 3 || apiKey.length < 20) {
      setOzonConnError("Укажите корректные Client ID и API-ключ Ozon");
      return;
    }

    setOzonBusy("connecting");
    setOzonConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/connection", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, apiKey }),
        cache: "no-store",
      });
      const data = (await res.json()) as OzonConnResponse;
      if (!res.ok) {
        setOzonConnError(data.error || "Не удалось подключить кабинет Ozon");
        return;
      }
      applyOzonView(data);
      // Сырой ключ в браузере больше не нужен — стираем.
      setOzonApiKey("");
      setShowOzonKey(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("connectOzon error:", e);
      setOzonConnError("Не удалось связаться с сервером");
    } finally {
      setOzonBusy("idle");
    }
  };

  // POST перепроверка уже сохранённого ключа — сервер сам берёт его из БД.
  const verifyOzon = async () => {
    if (!user?.id) return;
    setOzonBusy("checking");
    setOzonConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/connection/verify", {
        method: "POST",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as OzonConnResponse;
      if (!res.ok) {
        setOzonConnError(data.error || "Не удалось проверить подключение");
        // verify-route при нечитаемом ключе отдаёт status — отразим в UI.
        if (data.status) {
          setOzonConn((prev) =>
            prev
              ? { ...prev, status: data.status as OzonConnStatus, connected: false }
              : prev
          );
        }
        return;
      }
      applyOzonView(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("verifyOzon error:", e);
      setOzonConnError("Не удалось связаться с сервером");
    } finally {
      setOzonBusy("idle");
    }
  };

  // DELETE отключить кабинет (по подтверждению). Чистим и локальные поля ввода.
  const deleteOzon = async () => {
    if (!user?.id) return;
    if (!confirm("Отключить кабинет Ozon? Сохранённый ключ будет удалён.")) return;
    setOzonBusy("deleting");
    setOzonConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/connection", {
        method: "DELETE",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as OzonConnResponse;
      if (!res.ok) {
        setOzonConnError(data.error || "Не удалось отключить кабинет");
        return;
      }
      setOzonConn(null);
      setOzonClientId("");
      setOzonApiKey("");
      setShowOzonKey(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("deleteOzon error:", e);
      setOzonConnError("Не удалось связаться с сервером");
    } finally {
      setOzonBusy("idle");
    }
  };

  // ---- Ozon Performance API (реклама/продвижение) — PR #43 foundation ----
  // Отдельное подключение (Client ID + Client Secret). Секрет в браузер НЕ
  // возвращается; фронт видит только статус/маску/last4. Реклама в расчёт прибыли
  // на этом этапе НЕ добавляется — только сохранение кредов и проверка токена.
  const applyPerfView = (data: PerfConnResponse) => {
    setPerfConn({
      connected: !!data.connected,
      status: (data.status as PerfConnStatus) ?? "not_connected",
      clientIdMasked: data.clientIdMasked,
      secretLast4: data.secretLast4 ?? null,
      lastCheckedAt: data.lastCheckedAt ?? null,
      lastError: data.lastError ?? null,
      updatedAt: data.updatedAt ?? null,
    });
  };

  // GET статус Performance-подключения (без секрета). Гостя/сбой — «не подключено».
  const fetchPerfConnection = async () => {
    setPerfConnLoading(true);
    setPerfConnError("");
    try {
      const headers = await ozonAuthHeaders();
      if (!headers.Authorization) {
        setPerfConn(null);
        return;
      }
      const res = await fetch("/api/ozon/performance/connection", {
        method: "GET",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as PerfConnResponse;
      if (!res.ok) {
        setPerfConn(null);
        return;
      }
      applyPerfView(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("fetchPerfConnection error:", e);
      setPerfConn(null);
    } finally {
      setPerfConnLoading(false);
    }
  };

  // POST подключить: {clientId, clientSecret} → сервер проверяет токен, шифрует и
  // сохраняет секрет. Сырой секрет после успеха стираем из state и прячем глазок.
  const connectPerformance = async () => {
    if (!user?.id) {
      setPerfConnError("Войдите в аккаунт, чтобы подключить Performance API");
      return;
    }
    const clientId = perfClientId.trim();
    const clientSecret = perfClientSecret.trim();
    if (clientId.length < 3 || clientSecret.length < 20) {
      setPerfConnError("Укажите корректные Client ID и Client Secret Performance API");
      return;
    }

    setPerfBusy("connecting");
    setPerfConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/performance/connection", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
        cache: "no-store",
      });
      const data = (await res.json()) as PerfConnResponse;
      if (!res.ok) {
        setPerfConnError(data.error || "Не удалось подключить Performance API");
        return;
      }
      applyPerfView(data);
      // Сырой секрет в браузере больше не нужен — стираем.
      setPerfClientSecret("");
      setShowPerfSecret(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("connectPerformance error:", e);
      setPerfConnError("Не удалось связаться с сервером");
    } finally {
      setPerfBusy("idle");
    }
  };

  // POST перепроверка сохранённого секрета — сервер сам берёт его из БД, получает
  // токен и НЕ сохраняет его.
  const verifyPerformance = async () => {
    if (!user?.id) return;
    setPerfBusy("checking");
    setPerfConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/performance/connection/verify", {
        method: "POST",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as PerfConnResponse;
      if (!res.ok) {
        setPerfConnError(data.error || "Не удалось проверить подключение");
        if (data.status) {
          setPerfConn((prev) =>
            prev
              ? { ...prev, status: data.status as PerfConnStatus, connected: false }
              : prev
          );
        }
        return;
      }
      applyPerfView(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("verifyPerformance error:", e);
      setPerfConnError("Не удалось связаться с сервером");
    } finally {
      setPerfBusy("idle");
    }
  };

  // DELETE отключить Performance (по подтверждению). Чистим локальные поля.
  const deletePerformance = async () => {
    if (!user?.id) return;
    if (!confirm("Отключить Ozon Performance API? Сохранённый секрет будет удалён.")) return;
    setPerfBusy("deleting");
    setPerfConnError("");
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/performance/connection", {
        method: "DELETE",
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as PerfConnResponse;
      if (!res.ok) {
        setPerfConnError(data.error || "Не удалось отключить Performance API");
        return;
      }
      setPerfConn(null);
      setPerfClientId("");
      setPerfClientSecret("");
      setShowPerfSecret(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("deletePerformance error:", e);
      setPerfConnError("Не удалось связаться с сервером");
    } finally {
      setPerfBusy("idle");
    }
  };

  // POST /api/ozon/performance/ads-spend-diagnostic — СПРАВОЧНЫЙ расход рекламы
  // Performance API за месяц. Read-only: сумма НЕ входит в прибыль, никуда не
  // сохраняется, ничего не списывает. Отчёт Ozon готовится асинхронно — при
  // status "pending" просим повторить позже (см. UI).
  const checkAdsSpend = async () => {
    if (!user?.id) {
      setAdsError("Войдите в аккаунт, чтобы проверить расход рекламы");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(adsMonth)) {
      setAdsError("Укажите месяц в формате ГГГГ-ММ");
      return;
    }
    setAdsBusy(true);
    setAdsError("");
    setAdsResult(null);
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/performance/ads-spend-diagnostic", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ month: adsMonth }),
        cache: "no-store",
      });
      const data = (await res.json()) as AdsSpendResult;
      if (!res.ok) {
        setAdsError(data.error || "Не удалось получить расход рекламы");
        return;
      }
      setAdsResult(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("checkAdsSpend error:", e);
      setAdsError("Не удалось связаться с сервером");
    } finally {
      setAdsBusy(false);
    }
  };

  // POST /api/ozon/postings-match-diagnostic — read-only диагностика: какие товары
  // из Ozon postings (FBO+FBS) есть в каталоге себестоимости. НИЧЕГО не сохраняет,
  // не списывает расчёт и НЕ считает прибыль — только сопоставление по артикулу.
  const loadPostingsMatch = async () => {
    if (!user?.id) {
      setMatchError("Войдите в аккаунт, чтобы проверить сопоставление");
      return;
    }
    if (!ozonConn?.connected) {
      setMatchError("Сначала подключите Ozon API");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(matchMonth)) {
      setMatchError("Выберите месяц");
      return;
    }
    setMatchLoading(true);
    setMatchError("");
    setMatchResult(null);
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/postings-match-diagnostic", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ month: matchMonth }),
        cache: "no-store",
      });
      const data = (await res.json()) as OzonPostingsMatchResponse & { error?: string };
      if (!res.ok) {
        setMatchError(data.error || "Не удалось проверить сопоставление");
        return;
      }
      setMatchResult(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("loadPostingsMatch error:", e);
      setMatchError("Не удалось связаться с сервером");
    } finally {
      setMatchLoading(false);
    }
  };

  // PR #22 (UX) — быстрый переход в каталог товаров (заполнить себестоимость),
  // когда расчёт упёрся в неполную себестоимость. Просто переключаем верхний
  // раздел дашборда и скроллим вверх; никакой бизнес-логики/расчётов тут нет.
  const goToCatalog = () => {
    setMainTab("catalog");
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // POST /api/ozon/save-calculation — ЕДИНОЕ действие «Рассчитать и сохранить»
  // (PR #20). Закрывает дыру монетизации: раньше был бесплатный preview, который
  // отдавал полный расчёт без списания. Теперь полный API-расчёт показываем ТОЛЬКО
  // после успешного сохранения. Сервер сам ПРОВЕРЯЕТ доступ, заново тянет Ozon/
  // каталог, пересчитывает, проверяет полноту себестоимости, СПИСЫВАЕТ ровно один
  // расчёт (free/149₽; для безлимита — без списания) и пишет в историю — это
  // единственная точка списания, двойного списания нет. Числам с фронта не верим:
  // шлём только месяц и ручные расходы. Защита от двойного клика — profitLoading.
  const calculateAndSaveApi = async () => {
    if (profitLoading) return; // защита от двойного клика
    if (!user?.id) {
      setProfitError("Войдите в аккаунт, чтобы рассчитать прибыль");
      return;
    }
    if (!ozonConn?.connected) {
      setProfitError("Сначала подключите Ozon API");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(profitMonth)) {
      setProfitError("Выберите месяц");
      return;
    }
    // PR #25: дубль-гард ДО любого запроса/списания. profitMonth уже 'YYYY-MM'.
    // «Отмена» → выходим сразу: /api/ozon/save-calculation НЕ вызывается, поэтому
    // попытка НЕ списывается (для API это критично — списание на сервере в save).
    if (!(await confirmNoMonthDuplicate(profitMonth, "ozon"))) return;
    setProfitLoading(true);
    setProfitError("");
    setProfitResult(null);
    setApiSaved(false);
    setApiCostGap(null);
    setRealizationDiag(null);
    try {
      // Пустое/≤0 поле → 0. Сервер всё равно валидирует заново (>= 0).
      const meNum = (s: string): number => {
        const n = parseFloat(s);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/save-calculation", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          month: profitMonth,
          manualExpenses: {
            tax: meNum(apiExpenses.tax),
            packaging: meNum(apiExpenses.packaging),
            warehouseDelivery: meNum(apiExpenses.warehouseDelivery),
            salary: meNum(apiExpenses.salary),
            other: meNum(apiExpenses.other),
          },
        }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        status?: string;
        unmatchedItems?: number;
        matchedNoCostCount?: number;
        profit?: OzonProfitDraftResponse;
        realizationDiagnostic?: RealizationDiagnostic | null;
      };

      // Нет доступа (free/149₽ исчерпан) → окно тарифа, как в обычном расчёте.
      // Ничего не списано/сохранено; цифры НЕ пришли.
      if (
        res.status === 402 ||
        data.code === "limit_reached" ||
        data.code === "calculation_required"
      ) {
        setSelectedTier(null);
        setTariffModalOpen(true);
        return;
      }
      // Себестоимость не полная → 400 ДО списания (сервер не присылает цифр).
      // Вместо сухого текста показываем структурированный блок «Не хватает
      // себестоимости у товаров» с понятными действиями (перейти в каталог /
      // добавить несопоставленные товары). Ошибку-текст не ставим — блок сам всё
      // объясняет.
      if (res.status === 400 && data.code === "incomplete_cost") {
        setApiCostGap({
          status: data.status,
          unmatchedItems:
            typeof data.unmatchedItems === "number" ? data.unmatchedItems : 0,
          matchedNoCostCount:
            typeof data.matchedNoCostCount === "number"
              ? data.matchedNoCostCount
              : 0,
        });
        return;
      }
      if (!res.ok || data.ok !== true || !data.profit) {
        const msg = data.error || "Не удалось рассчитать и сохранить расчёт";
        setProfitError(msg);
        showToast(msg, "err");
        return;
      }

      // Успех: показываем ПОЛНЫЙ расчёт (он уже сохранён, попытка списана) и
      // обновляем историю/счётчик помесячных снимков.
      setProfitResult(data.profit);
      setRealizationDiag(data.realizationDiagnostic ?? null);
      setApiSaved(true);
      showToast("API-расчёт рассчитан и сохранён в историю", "ok");
      await loadHistory(user.id);
      setHistoryRefresh((k) => k + 1);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("calculateAndSaveApi error:", e);
      setProfitError("Не удалось связаться с сервером");
    } finally {
      setProfitLoading(false);
    }
  };

  // POST /api/ozon/import-missing-products — добавить в каталог несопоставленные
  // товары Ozon (sku = offer_id, cost_price = 0). ТОЛЬКО INSERT новых товаров:
  // существующие не трогаем, себестоимость НЕ выдумываем, прибыль НЕ считаем,
  // расчёт НЕ запускаем/НЕ сохраняем/НЕ списываем. После — заполнить cost вручную.
  const importMissingProducts = async (monthArg?: string) => {
    // monthArg позволяет вызвать импорт из блока «не хватает себестоимости»
    // основного сценария (там используется profitMonth). По умолчанию — importMonth
    // из второстепенного блока диагностики. Бэкенд и его поведение не меняются.
    const month = monthArg ?? importMonth;
    if (!user?.id) {
      setImportError("Войдите в аккаунт, чтобы добавить товары");
      return;
    }
    if (!ozonConn?.connected) {
      setImportError("Сначала подключите Ozon API");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setImportError("Выберите месяц");
      return;
    }
    setImportLoading(true);
    setImportError("");
    setImportResult(null);
    try {
      const headers = await ozonAuthHeaders();
      const res = await fetch("/api/ozon/import-missing-products", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
        cache: "no-store",
      });
      const data = (await res.json()) as OzonImportMissingResponse & { error?: string };
      if (!res.ok) {
        setImportError(data.error || "Не удалось добавить товары в каталог");
        return;
      }
      setImportResult(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("importMissingProducts error:", e);
      setImportError("Не удалось связаться с сервером");
    } finally {
      setImportLoading(false);
    }
  };

  const clearHistory = async () => {
    const ok = confirm("Удалить всю историю?");
    if (!ok) return;

    // optimistic: чистим UI сразу
    setHistory([]);
    setSelectedId(null);
    setResult(null);

    if (!user?.id) {
      showToast("История очищена локально", "warn");
      return;
    }

    const res = await clearCalculationsFromCloud(user.id);
    if (res.error) {
      console.warn("clearHistory: cloud delete failed", res.error);
      // НЕ откатываем локальную чистку — пользователь явно нажал «Удалить всю историю».
      showToast("История очищена локально", "warn");
      return;
    }
    setUploadedReports([]); // cascade: uploaded_reports.calculation_id → null уже в DB
    showToast("История очищена", "ok");
  };

  const deleteHistoryItem = async (id: string) => {
    if (removingIds.has(id)) return;

    const item = history.find((h) => h.id === id);
    if (!item) {
      showToast("Расчёт не найден", "err");
      return;
    }

    // 1) запускаем fade-out
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    // 2) Делаем delete через cloud helper ТОЛЬКО если запись синхронизирована
    //    и пользователь залогинен. Локальные записи (synced: false)
    //    удаляются только из state — без сетевых запросов и ложных ошибок.
    const shouldPersistDelete = !!item.synced && !!user?.id;
    let delErr: ReturnType<typeof formatSupabaseError> | null = null;

    if (shouldPersistDelete) {
      const [delRes] = await Promise.all([
        deleteCalculationFromCloud(id, user!.id),
        new Promise<void>((r) => setTimeout(r, 300)),
      ]);
      if (delRes.error) delErr = delRes.error;
    } else {
      // local-only delete — просто ждём анимацию
      await new Promise((r) => setTimeout(r, 300));
    }

    // 3) Локальное удаление выполняется ВСЕГДА (DEV / offline fallback).
    setHistory((prev) => prev.filter((h) => h.id !== id));
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (selectedId === id) setSelectedId(null);
    setResult((prev) => (prev && prev.id === id ? null : prev));
    // Если удалили авто-запись анализа — сбрасываем хэндл, чтобы следующее
    // «Сохранить результат» вставило новую строку, а не апдейтило удалённую.
    if (lastUploadCalc?.id === id) setLastUploadCalc(null);

    if (delErr) {
      // Не error — fallback нормально сработал.
      console.warn("deleteHistoryItem: cloud delete failed", delErr);
      showToast("Удалено локально", "warn");
    } else if (shouldPersistDelete) {
      showToast("Удалено", "ok");
    } else {
      // запись изначально не была в облаке (DEV / offline / неавторизованный юзер)
      showToast("Удалено локально", "warn");
    }
  };

  /** Загрузка истории через cloud helper. Возвращает мапнутый массив для
   *  опционального join'а с uploaded_reports. UI обновляется внутри. */
  const loadHistory = async (
    userId: string | null
  ): Promise<CalcResult[]> => {
    if (!userId) {
      // Не залогинен → история работает только локально, ничего не подгружаем.
      setHistory([]);
      setHistoryError(false);
      setIsLoadingHistory(false);
      return [];
    }

    // Новая попытка загрузки → сбрасываем прошлую ошибку.
    setHistoryError(false);
    const res = await loadCalculationsFromCloud(userId, 50);
    setIsLoadingHistory(false);

    if (res.error) {
      console.warn("loadHistory: cloud unavailable", res.error);
      // Облако недоступно. Если показывать ещё нечего — поднимаем error-state
      // с кнопкой «Повторить»; уже загруженный список не затираем (graceful).
      setHistoryError(true);
      return [];
    }

    const mapped = (res.data ?? []).map(cloudToLocal);
    setHistory(mapped);
    return mapped;
  };

  // История грузится дольше 10с → показываем мягкую подсказку (не ошибка).
  // Таймер живёт только пока isLoadingHistory === true; на завершении — сброс.
  useEffect(() => {
    if (!isLoadingHistory) {
      setHistorySlow(false);
      return;
    }
    const t = setTimeout(() => setHistorySlow(true), 10000);
    return () => clearTimeout(t);
  }, [isLoadingHistory]);

  // Повторная загрузка истории по кнопке «Повторить» (error-state). Трогает
  // ТОЛЬКО историю: расчёты, сохранение и фильтры не затрагиваются.
  const retryLoadHistory = () => {
    const uid = user?.id ?? null;
    if (!uid) return; // облачная история только для залогиненного
    setHistoryError(false);
    setIsLoadingHistory(true);
    void loadHistory(uid);
  };

  /** Загрузка uploaded_reports после логина. Join'ит profit/margin
   *  из переданных calculations (если есть связь по calculation_id). */
  const loadUploadedReportsCloud = async (
    userId: string,
    linkedCalcs: CalcResult[]
  ) => {
    const res = await loadUploadedReportsFromCloud(userId, 20);
    if (res.error || !res.data) return;

    const calcMap = new Map(linkedCalcs.map((c) => [c.id, c]));
    const enriched: UploadedReport[] = res.data.map((r) => {
      const linked = r.calculation_id ? calcMap.get(r.calculation_id) : null;
      return {
        id: r.id,
        filename: r.file_name || "—",
        marketplace: r.marketplace ?? "ozon",
        profit: linked?.profit ?? 0,
        margin: linked?.margin ?? 0,
        rowsCount: r.rows_count ?? 0,
        period: r.period || "",
        date: new Date(r.created_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
      };
    });
    setUploadedReports(enriched);
  };

  const num = (v: string) => {
    const n = parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  const fmt = (n: number) =>
    n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });

  // Формат значения строки мини-разбивки «Последних расчётов» (только показ).
  const histDetailValue = (r: HistDetailRow): string => {
    if (r.value === null) return "—";
    const money = `${fmt(Math.abs(r.value))} ₽`;
    switch (r.kind) {
      case "income":
        return r.value === 0 ? "0 ₽" : `+${money}`;
      case "expense":
        return r.value === 0 ? "0 ₽" : `−${money}`;
      case "subtotal":
        return `${fmt(r.value)} ₽`;
      case "neutral":
        return r.value === 0 ? "0 ₽" : `${fmt(r.value)} ₽`;
      case "total":
        return `${r.value >= 0 ? "+" : "−"}${money}`;
    }
  };

  const handleField = (key: string, value: string) => {
    // В режиме просмотра сохранённого API-расчёта (view-only) поля не редактируются.
    if (loadedApiView) return;
    if (value !== "" && !/^-?\d*[.,]?\d*$/.test(value)) return;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const calculate = async () => {
    if (isCalculating) return;
    // Защита: UI подменяет кнопку на paywall, но на всякий случай.
    if (!canCalculate) {
      setSelectedTier(null);
      setTariffModalOpen(true);
      return;
    }
    // PR #25: дубль-гард. Ручной расчёт всегда относится к ТЕКУЩЕМУ месяцу
    // (периода отчёта нет → calcMonthKey берёт месяц создания записи). «Отмена» →
    // выходим ДО setIsCalculating/consumeCalculation: попытка НЕ списывается.
    {
      const dnow = new Date();
      const curMonthKey = `${dnow.getFullYear()}-${String(
        dnow.getMonth() + 1
      ).padStart(2, "0")}`;
      if (!(await confirmNoMonthDuplicate(curMonthKey, marketplace))) return;
    }
    setIsCalculating(true);

    try {
      // Ручной расчёт не парсит файлы (арифметика не падает) — списываем сразу,
      // server-authoritative, ДО выдачи результата. !ok → paywall, результата нет.
      const consumed = await consumeCalculation();
      if (!consumed.ok) {
        // eslint-disable-next-line no-console
        console.warn("[calc] consume blocked → paywall", consumed.reason);
        setSelectedTier(null);
        setTariffModalOpen(true);
        return;
      }

      const revenue = num(form.revenue);
      const expenses =
        num(form.commission) +
        num(form.logistics) +
        num(form.storage) +
        num(form.ads) +
        num(form.cost) +
        num(form.tax) +
        num(form.other);
      const profit = revenue - expenses;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      const now = new Date();
      const localResult: CalcResult = {
        id: makeLocalId(),
        marketplace,
        revenue,
        commission: num(form.commission),
        logistics: num(form.logistics),
        storage: num(form.storage),
        ads: num(form.ads),
        cost: num(form.cost),
        tax: num(form.tax),
        other: num(form.other),
        expenses,
        profit,
        margin,
        date: now.toLocaleString("ru-RU", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        createdAt: now.toISOString(),
        synced: false,
      };

      // 5 стадий × 700мс — минимальная задержка для AI processing overlay.
      const minDelay = new Promise<void>((r) => setTimeout(r, 3600));

      // Параллельно: cloud save (через helper, который сам обрабатывает ошибки)
      // и таймер для UX. Если юзер не залогинен — save пропускаем сразу.
      // eslint-disable-next-line no-console
      console.log("[debug] calculate user.id =", user?.id ?? "(anonymous)");

      const savePromise: Promise<{
        synced: boolean;
        cloudId: string | null;
        cloudCreatedAt: string | null;
        errMsg: string | null;
      }> = user?.id
        ? saveCalculationToCloud(
            {
              marketplace,
              mode: "manual" as CloudCalcMode,
              revenue,
              commission: num(form.commission),
              logistics: num(form.logistics),
              ads: num(form.ads),
              storage: num(form.storage),
              tax: num(form.tax),
              cost: num(form.cost),
              other_expenses: num(form.other),
              total_expenses: expenses,
              profit,
              margin,
            },
            user.id
          ).then((res) => {
            // Strict synced: ТОЛЬКО если нет ошибки И вернулся id из БД.
            const ok = !res.error && !!res.data?.id;
            return {
              synced: ok,
              cloudId: res.data?.id ?? null,
              cloudCreatedAt: res.data?.created_at ?? null,
              errMsg: res.error?.message ?? null,
            };
          })
        : Promise.resolve({
            synced: false,
            cloudId: null,
            cloudCreatedAt: null,
            errMsg: null,
          });

      const [saveResult] = await Promise.all([savePromise, minDelay]);

      const finalResult: CalcResult = {
        ...localResult,
        id: saveResult.cloudId ?? localResult.id,
        createdAt: saveResult.cloudCreatedAt ?? localResult.createdAt,
        synced: saveResult.synced,
      };

      setResult(finalResult);
      setHistory((prev) => [finalResult, ...prev].slice(0, 50));
      const synced = saveResult.synced;

      if (synced) {
        showToast("Расчёт сохранён", "ok");
      } else if (user?.id && saveResult.errMsg) {
        // Был логин — но cloud упал. Показываем причину одной строкой.
        showToast("Облако: " + saveResult.errMsg, "warn");
      } else {
        // Не залогинен / DEV — обычный soft-fallback.
        showToast("Расчёт сохранён локально", "warn");
      }

      // success state — короткий glow + бейдж-shine
      setJustCalculated(true);
      window.setTimeout(() => setJustCalculated(false), 2200);

      // онбординг свернётся после первого успешного расчёта
      dismissOnboarding();
    } finally {
      setIsCalculating(false);
    }
  };

  const handleTariff = (tier: "single" | "unlimited") => {
    setSelectedTier(tier);
    setTariffModalOpen(true);
  };

  // Единый источник про премиум-доступ и лимит бесплатных расчётов.
  // Контракт стабильный — когда подключим billing, поменяется только hook.
  const {
    hasPremium,
    singleCredits,
    premiumUntil,
    canCalculate,
    calcCount,
    freeCalculationsLimit,
    loaded: entitlementsLoaded,
    consumeCalculation,
  } = useEntitlements();

  // Баннер статуса «Безлимит» можно скрыть крестиком; выбор запоминаем в
  // localStorage. Скрытие касается ТОЛЬКО unlimited-баннера и не влияет на показ
  // тарифов/paywall для остальных пользователей (см. секцию ниже).
  const [unlimitedBannerHidden, setUnlimitedBannerHidden] = useState(false);
  useEffect(() => {
    try {
      setUnlimitedBannerHidden(
        window.localStorage.getItem("mprof_unlimited_banner_hidden") === "1"
      );
    } catch {
      /* localStorage недоступен — оставляем баннер видимым */
    }
  }, []);
  const hideUnlimitedBanner = () => {
    setUnlimitedBannerHidden(true);
    try {
      window.localStorage.setItem("mprof_unlimited_banner_hidden", "1");
    } catch {
      /* ignore */
    }
  };

  // AI PRO «Открыть Premium» — открываем тот же payment flow с тарифом «Безлимит»
  const openPremium = () => {
    setSelectedTier("unlimited");
    setTariffModalOpen(true);
  };

  const clearForm = () => {
    setForm({ ...EMPTY });
    setResult(null);
    setLoadedApiView(null);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  return (
    <>
      <style jsx global>{`
@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap");
:root{
  --void:#05070f;--deep:#080a14;--panel:#0d1020;
  --glass:rgba(255,255,255,.032);--glass2:rgba(255,255,255,.055);
  --edge:rgba(255,255,255,.07);--edge2:rgba(255,255,255,.12);
  --gold:#C9A84C;--gold2:#E8C97A;--gold3:#F5DFA0;--gold-d:#8B6E28;
  --gold-bg:rgba(201,168,76,.07);--gold-bg2:rgba(201,168,76,.13);
  --platinum:#B0C0D8;--silver:#7A8FA8;--smoke:#3A4A60;
  --txt:#E8EEF8;--txt2:#8A9FBB;--txt3:#425068;
  --green:#2ECC8A;--red:#E05566;
  --display:'Playfair Display',Georgia,serif;
  --sans:'Outfit',sans-serif;--mono:'DM Mono',monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--void);color:var(--txt);font-family:var(--sans);line-height:1.6;
  background-image:radial-gradient(900px 500px at 85% -5%,rgba(201,168,76,.10),transparent 60%),
  radial-gradient(700px 500px at -10% 110%,rgba(201,168,76,.05),transparent 60%);
  background-attachment:fixed;min-height:100vh}

.dash-top{position:sticky;top:0;z-index:80;
  background:rgba(8,10,20,.97);backdrop-filter:blur(16px) saturate(1.2);
  -webkit-backdrop-filter:blur(16px) saturate(1.2);
  border-bottom:1px solid var(--edge)}
.dash-top-inner{width:100%;max-width:none;margin:0;box-sizing:border-box;
  display:grid;grid-template-columns:minmax(160px,1fr) auto minmax(160px,1fr);align-items:center;
  gap:1rem;padding:.8rem 2rem}
.dash-brand{grid-column:1;justify-self:start;font-family:var(--display);font-size:1.15rem;font-weight:700;letter-spacing:.01em;color:var(--txt);text-decoration:none}
.dash-brand em{font-style:italic;color:var(--gold)}
.dash-status{grid-column:3;justify-self:end;display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.66rem;
  color:var(--gold2);letter-spacing:.06em;border:1px solid rgba(201,168,76,.3);
  padding:6px 16px;border-radius:100px;background:var(--gold-bg)}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--gold);
  animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.6)}}

.dash-user{grid-column:3;justify-self:end;display:flex;align-items:center;justify-content:flex-end;gap:10px}
.dash-user-email{font-family:var(--mono);font-size:.63rem;color:var(--txt2);letter-spacing:.04em;
  max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-signout{font-family:var(--sans);font-size:.75rem;font-weight:500;background:transparent;
  border:1px solid var(--edge2);color:var(--txt2);padding:5px 13px;border-radius:8px;
  cursor:pointer;transition:all .18s;line-height:1}
.dash-signout:hover{border-color:rgba(224,85,102,.4);color:var(--red)}
.dash-signout:disabled{opacity:.6;cursor:default}
.dash-signout:disabled:hover{border-color:var(--edge2);color:var(--txt2)}

.auth-card{margin-bottom:1.4rem;padding:1.4rem 1.5rem}
.auth-title{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);margin:0 0 .9rem}
.auth-row{display:flex;gap:10px;align-items:stretch}
.auth-input{flex:1;width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);
  border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:.92rem;padding:12px 14px;
  outline:none;transition:border .18s,box-shadow .18s,background .18s;
  -webkit-text-fill-color:var(--txt);caret-color:var(--gold);
  appearance:none;-webkit-appearance:none}
.auth-pass-wrap{position:relative;display:flex;flex:1;width:100%}
.auth-pass-wrap .auth-input{width:100%;padding-right:44px}
.auth-eye{position:absolute;top:50%;right:6px;transform:translateY(-50%);
  width:32px;height:32px;border-radius:7px;border:1px solid transparent;background:transparent;
  color:var(--txt3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  padding:0;transition:all .18s}
.auth-eye:hover{color:var(--gold2);border-color:var(--edge2);background:rgba(255,255,255,.04)}
.auth-eye:focus-visible{outline:none;color:var(--gold2);border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.18)}
.auth-eye svg{width:16px;height:16px;display:block}
.auth-input::placeholder{color:var(--txt3);opacity:1}
.auth-input::-webkit-input-placeholder{color:var(--txt3)}
.auth-input:hover{border-color:var(--smoke)}
.auth-input:focus,
.auth-input:focus-visible,
.auth-input:active{
  background:rgba(255,255,255,.04);
  border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(201,168,76,.18);
  color:var(--txt);
  -webkit-text-fill-color:var(--txt);
  outline:none
}
.auth-input:-webkit-autofill,
.auth-input:-webkit-autofill:hover,
.auth-input:-webkit-autofill:focus,
.auth-input:-webkit-autofill:active{
  -webkit-text-fill-color:var(--txt) !important;
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset !important;
  box-shadow:0 0 0 1000px #0d1020 inset !important;
  caret-color:var(--gold) !important;
  border:1px solid var(--edge2);
  transition:background-color 9999s ease-out 0s,color 9999s ease-out 0s
}
.auth-input:-webkit-autofill:focus{
  border-color:var(--gold);
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset,0 0 0 3px rgba(201,168,76,.18) !important;
  box-shadow:0 0 0 1000px #0d1020 inset,0 0 0 3px rgba(201,168,76,.18) !important
}
.auth-btn{font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:0 22px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28);white-space:nowrap}
.auth-btn:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.auth-btn:disabled{opacity:.6;cursor:default;box-shadow:0 8px 28px rgba(201,168,76,.18)}
.auth-btn:disabled:hover{transform:none;box-shadow:0 8px 28px rgba(201,168,76,.18)}
.auth-msg{margin:.8rem 0 0;font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em}
.auth-fields{display:flex;flex-direction:column;gap:10px}
.auth-actions{display:flex;gap:10px;margin-top:10px}
.auth-actions .auth-btn{flex:1;padding:12px 18px;text-align:center}
.auth-btn-2{background:transparent;color:var(--gold2);border:1px solid var(--edge2);box-shadow:none}
.auth-btn-2:hover{transform:translateY(-1px);border-color:var(--gold);box-shadow:0 8px 24px rgba(201,168,76,.16)}
.auth-btn-2:disabled,.auth-btn-2:disabled:hover{opacity:.6;cursor:default;transform:none;box-shadow:none;border-color:var(--edge2)}
.auth-hint{margin:.7rem 0 0;font-family:var(--mono);font-size:.66rem;color:var(--txt3);letter-spacing:.02em;line-height:1.5}
.auth-reset{margin:.95rem 0 0;padding-top:.95rem;border-top:1px solid var(--edge)}
.auth-reset-q{margin:0 0 .55rem;font-family:var(--mono);font-size:.7rem;color:var(--txt2);letter-spacing:.02em}
.auth-reset-btn{font-family:var(--sans);font-size:.82rem;font-weight:600;color:var(--gold2);background:transparent;
  border:1px solid var(--edge2);border-radius:9px;padding:10px 16px;cursor:pointer;letter-spacing:.02em;transition:all .18s}
.auth-reset-btn:hover{border-color:var(--gold);color:var(--gold);box-shadow:0 6px 20px rgba(201,168,76,.14)}
.auth-reset-btn:disabled{opacity:.55;cursor:default}
.auth-reset-btn:disabled:hover{border-color:var(--edge2);color:var(--gold2);box-shadow:none;transform:none}
@media(max-width:480px){.auth-row{flex-direction:column}.auth-btn{padding:13px}.auth-actions{flex-direction:column}.auth-reset-btn{width:100%}.auth-eye{width:40px;height:40px}.auth-pass-wrap .auth-input{padding-right:52px}}

.api-card{margin-top:1.25rem}
.api-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.api-fld{display:flex;flex-direction:column;gap:6px}
.api-fld.api-fld-full{grid-column:1 / -1}
.api-fld label{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3)}
.api-fld .api-hint{font-size:.62rem;color:var(--txt3);font-weight:300}
.api-input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);border-radius:8px;
  color:var(--txt);font-family:var(--mono);font-size:.88rem;padding:11px 12px;outline:none;
  transition:border .18s,box-shadow .18s,background .18s;
  -webkit-text-fill-color:var(--txt);caret-color:var(--gold);
  appearance:none;-webkit-appearance:none}
.api-input::placeholder{color:var(--txt3);opacity:1}
.api-input::-webkit-input-placeholder{color:var(--txt3)}
.api-input:hover{border-color:var(--smoke)}
.api-input:focus,
.api-input:focus-visible{
  background:rgba(255,255,255,.04);
  border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(201,168,76,.18);
  color:var(--txt);
  -webkit-text-fill-color:var(--txt);
  outline:none
}
.api-input:-webkit-autofill,
.api-input:-webkit-autofill:hover,
.api-input:-webkit-autofill:focus{
  -webkit-text-fill-color:var(--txt) !important;
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset !important;
  caret-color:var(--gold) !important;
  transition:background-color 9999s ease-out 0s
}
.api-secret{position:relative}
.api-secret .api-input{padding-right:44px;font-family:var(--mono);letter-spacing:.04em}
.api-eye{position:absolute;top:50%;right:6px;transform:translateY(-50%);
  width:32px;height:32px;border-radius:7px;border:1px solid transparent;background:transparent;
  color:var(--txt3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  padding:0;transition:all .18s}
.api-eye:hover{color:var(--gold2);border-color:var(--edge2);background:rgba(255,255,255,.04)}
.api-eye:focus-visible{outline:none;color:var(--gold2);border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.18)}
.api-eye svg{width:16px;height:16px;display:block}
.api-foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  margin-top:1.4rem;flex-wrap:wrap}
.api-msg{font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em;margin:0;flex:1;min-width:0}
.api-msg.ok{color:var(--green)}
.api-msg.err{color:var(--red)}
.api-save{font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:12px 24px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.api-save:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.api-save:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none}
.api-locked{padding:2.2rem 1.5rem;text-align:center;color:var(--txt3)}
.api-locked-icon{font-size:1.6rem;opacity:.4;margin-bottom:.6rem;display:block}
.api-locked-title{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt2);margin-bottom:.3rem}
.api-locked-sub{font-size:.8rem;font-weight:300}
@media(max-width:480px){
  .api-grid{grid-template-columns:1fr}
  .api-foot{flex-direction:column;align-items:stretch}
  .api-save{width:100%;padding:13px}
}

.calc-tabs{display:flex;gap:5px;background:var(--glass);border:1px solid var(--edge);
  border-radius:12px;padding:5px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  margin-bottom:.55rem;box-shadow:0 10px 28px rgba(0,0,0,.20);scroll-margin-top:84px}
.calc-tab{flex:1;font-family:var(--sans);font-size:.88rem;font-weight:600;padding:12px 16px;
  border-radius:10px;cursor:pointer;letter-spacing:.01em;border:1px solid transparent;
  background:transparent;color:var(--txt2);transition:all .22s ease;text-align:center;
  display:inline-flex;align-items:center;justify-content:center;gap:9px}
.calc-tab:hover{color:var(--txt);background:rgba(255,255,255,.03)}
.calc-tab.active{
  color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  box-shadow:0 8px 26px rgba(201,168,76,.3),inset 0 1px 0 rgba(255,255,255,.22)
}
.calc-tab-ico{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;opacity:.9}
.calc-tab-ico svg{width:16px;height:16px;display:block}
@media(max-width:640px){
  .calc-tabs{flex-direction:column;gap:6px}
  .calc-tab{padding:11px}
}
/* === HEADER NAV — вкладки в шапке (Расчёт / Каталог / Отчёты / Личный кабинет) === */
.dash-nav{display:flex;gap:5px;background:var(--glass);border:1px solid var(--edge);
  border-radius:13px;padding:5px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  box-shadow:0 8px 22px rgba(0,0,0,.20);grid-column:2;justify-self:center}
.main-tab{flex:0 0 auto;font-family:var(--sans);font-size:.83rem;font-weight:600;padding:9px 15px;
  border-radius:9px;cursor:pointer;border:1px solid transparent;background:transparent;
  color:var(--txt2);transition:all .22s ease;display:inline-flex;align-items:center;
  justify-content:center;gap:8px;min-height:38px;white-space:nowrap}
.main-tab:hover{color:var(--txt);background:rgba(255,255,255,.03)}
.main-tab.active{color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  box-shadow:0 8px 26px rgba(201,168,76,.3),inset 0 1px 0 rgba(255,255,255,.22)}
.main-tab-ico{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
.main-tab-ico svg{width:16px;height:16px;display:block}
@media(max-width:900px){
  .dash-nav{order:3;flex-basis:100%;width:100%}
  .main-tab{flex:1 1 auto}
}
@media(max-width:560px){
  .dash-nav{gap:4px;padding:4px}
  .main-tab{flex:1 1 calc(50% - 3px);font-size:.8rem;padding:9px 8px;gap:6px}
}

.api-pro-card{margin-bottom:.25rem;position:relative;overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 50px rgba(201,168,76,.06)}
.api-pro-card::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(520px 280px at 100% 0%, rgba(201,168,76,.10), transparent 60%);
  z-index:0}
.api-pro-card > *{position:relative;z-index:1}
.api-pro-head{padding:1.5rem 1.7rem 1.1rem;border-bottom:1px solid var(--edge)}
.api-pro-title{font-family:var(--display);font-size:1.15rem;font-weight:700;color:var(--txt);
  margin-bottom:.35rem;letter-spacing:-.005em}
.api-pro-sub{font-size:.85rem;color:var(--txt2);font-weight:300;line-height:1.5;margin:0}
.api-pro-body{padding:1.5rem 1.7rem 1.7rem}
.api-pro-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.api-pro-grid .api-fld.api-fld-full{grid-column:1 / -1}
.api-pro-foot{display:flex;align-items:center;gap:1rem;margin-top:1.6rem;flex-wrap:wrap}
.api-pro-btn{flex:1;min-width:240px;font-family:var(--sans);font-size:.95rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:14px 22px;border:none;border-radius:11px;cursor:pointer;letter-spacing:.01em;
  transition:all .22s ease;box-shadow:0 10px 30px rgba(201,168,76,.28);
  display:inline-flex;align-items:center;justify-content:center;gap:8px}
.api-pro-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 18px 44px rgba(201,168,76,.42)}
.api-pro-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;
  background:linear-gradient(135deg,rgba(58,74,96,.5) 0%,rgba(122,143,168,.4) 100%);
  color:var(--txt2);box-shadow:none}
.api-pro-btn.locked{cursor:not-allowed;opacity:.85;color:var(--txt);
  background:rgba(255,255,255,.04);border:1px dashed var(--edge2);box-shadow:none}
.api-pro-btn.locked:hover{transform:none;box-shadow:none}
.api-pro-msg{font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em;
  margin:0;flex:1;min-width:0}
.api-pro-msg.ok{color:var(--green)}
.api-pro-msg.err{color:var(--red)}
.api-pro-hint{margin-top:1.2rem;padding:.9rem 1.1rem;background:var(--gold-bg);
  border:1px solid rgba(201,168,76,.18);border-radius:11px;font-size:.78rem;
  color:var(--txt2);font-weight:300;line-height:1.55;display:flex;gap:.7rem;align-items:flex-start}
.api-pro-hint-ico{color:var(--gold2);flex-shrink:0;margin-top:1px;display:inline-flex}
.api-pro-hint-ico svg{width:16px;height:16px;display:block}
.api-pro-actions{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin-top:1.6rem}
.api-pro-actions .api-pro-btn{flex:none;min-width:0;width:100%}
.api-pro-btn.ghost{background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--edge2);box-shadow:none;backdrop-filter:blur(10px)}
.api-pro-btn.ghost:hover:not(:disabled){border-color:var(--gold);color:var(--gold2);
  background:var(--gold-bg);box-shadow:0 8px 24px rgba(201,168,76,.18)}
.api-pro-btn.danger{background:rgba(224,85,102,.08);color:#FF8A98;
  border:1px solid rgba(224,85,102,.32);box-shadow:none}
.api-pro-btn.danger:hover:not(:disabled){background:rgba(224,85,102,.14);
  border-color:rgba(224,85,102,.5);box-shadow:0 8px 24px rgba(224,85,102,.16)}
.api-pro-btn .spin{display:inline-block;width:14px;height:14px;border-radius:50%;
  border:2px solid rgba(0,0,0,.18);border-top-color:rgba(0,0,0,.55);
  animation:apiSpin .8s linear infinite;margin-right:2px}
@keyframes apiSpin{to{transform:rotate(360deg)}}

/* PR #44: справочный расход рекламы за месяц (read-only, в прибыль НЕ входит) */
.ads-diag{margin-top:1.4rem;padding:1.1rem 1.15rem;border-radius:14px;
  background:rgba(255,255,255,.03);border:1px solid var(--edge2)}
.ads-diag-head{font-family:var(--sans);font-weight:700;font-size:.95rem;color:var(--txt);letter-spacing:.01em}
.ads-diag-hint{margin:.4rem 0 0;font-size:.8rem;line-height:1.5;color:var(--txt3)}
.ads-diag-row{display:flex;gap:.7rem;flex-wrap:wrap;align-items:center;margin-top:.9rem}
.ads-diag-month{max-width:190px}
.ads-diag-row .api-pro-btn{flex:0 1 auto;min-width:260px}
.ads-diag-result{margin-top:1rem;padding-top:.9rem;border-top:1px solid var(--edge2)}
.ads-diag-line{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;
  padding:.32rem 0;font-size:.86rem;color:var(--txt2)}
.ads-diag-line b{font-family:var(--sans);color:var(--txt);font-weight:600}
.ads-diag-total b{color:var(--gold2);font-size:1.04rem}
.ads-diag-note{margin:.7rem 0 0;font-family:var(--mono);font-size:.7rem;letter-spacing:.02em;color:var(--txt3)}
.ads-diag-info{margin:.9rem 0 0;font-size:.82rem;line-height:1.5;color:var(--txt2)}
.ads-diag-diag{margin:.5rem 0 0;font-family:var(--mono);font-size:.72rem;line-height:1.5;letter-spacing:.02em;color:var(--txt3)}
@media (max-width:560px){
  .ads-diag-month{max-width:none;width:100%}
  .ads-diag-row .api-pro-btn{min-width:0;width:100%}
}

.api-alert{margin-top:1.1rem;padding:.95rem 1.1rem;border-radius:12px;font-size:.85rem;
  line-height:1.5;display:flex;gap:.7rem;align-items:flex-start;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  animation:apiAlertIn .25s ease}
@keyframes apiAlertIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.api-alert.ok{background:rgba(46,204,138,.08);border:1px solid rgba(46,204,138,.32);
  color:#7DEAB2;box-shadow:0 0 30px rgba(46,204,138,.07)}
.api-alert.err{background:rgba(224,85,102,.08);border:1px solid rgba(224,85,102,.32);
  color:#FF8A98;box-shadow:0 0 30px rgba(224,85,102,.07)}
.api-alert-ico{flex-shrink:0;margin-top:1px;display:inline-flex}
.api-alert-ico svg{width:18px;height:18px;display:block}
.api-alert-text{flex:1;min-width:0}

/* PR #22 (UX) — упрощённый сценарий «Авторасчёт чистой прибыли Ozon»:
   подключить → выбрать месяц → ввести расходы → рассчитать. */
.api-step{margin-top:1.5rem}
.api-step:first-of-type{margin-top:0}
.api-step-head{display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem}
.api-step-num{flex-shrink:0;width:26px;height:26px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);
  font-size:.82rem;font-weight:600;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  box-shadow:0 6px 18px rgba(201,168,76,.3)}
.api-step-title{font-family:var(--display);font-size:1.02rem;font-weight:600;color:var(--txt)}
.api-step-hint{font-size:.82rem;color:var(--txt3);line-height:1.5;margin:.1rem 0 .7rem 0}
.api-conn-ok{display:flex;align-items:center;gap:.7rem;padding:.85rem 1.05rem;
  border-radius:12px;background:rgba(46,204,138,.08);border:1px solid rgba(46,204,138,.32);
  color:#7DEAB2;font-size:.88rem}
.api-conn-ok svg{width:18px;height:18px;flex-shrink:0}
.api-conn-ok b{color:#9FEFC6;font-weight:600}
.api-conn-ok-meta{color:var(--txt3);font-size:.8rem}
.api-main-cta{width:100%;min-width:0;margin-top:.2rem;padding:16px 22px;font-size:1.04rem}
/* Минимальный дизайн блока «Авторасчёт через Ozon API» (без шагов 1–4) */
.api-connect-cta{display:flex;flex-direction:column;align-items:flex-start;gap:1rem;margin-top:.2rem}
.api-connect-cta-text{font-size:.92rem;color:var(--txt2);line-height:1.6;margin:0;max-width:520px}
.api-connect-cta .api-pro-btn{flex:none;min-width:0;width:auto}
.api-conn-ok-bar{margin-top:.2rem;flex-wrap:wrap}
.api-conn-manage{margin-left:auto;background:none;border:none;padding:0;cursor:pointer;
  font-family:var(--sans);font-size:.82rem;font-weight:600;color:#7DEAB2;
  text-decoration:underline;text-underline-offset:2px;transition:color .15s}
.api-conn-manage:hover{color:#9FEFC6}
.api-field-block{margin-top:1.3rem}
.api-field-label{display:block;font-family:var(--display);font-size:.98rem;font-weight:600;
  color:var(--txt);margin-bottom:.55rem}
.api-field-hint{font-size:.8rem;color:var(--txt3);line-height:1.5;margin:0 0 .65rem 0}
.api-costgap{margin-top:1.3rem;padding:1.1rem 1.2rem;border-radius:14px;
  background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.4)}
.api-costgap-title{font-family:var(--display);font-size:1.02rem;font-weight:700;color:#F7C66B;
  margin-bottom:.45rem;display:flex;align-items:center;gap:.5rem}
.api-costgap-sub{font-size:.86rem;color:var(--txt2);line-height:1.55;margin:0 0 .7rem}
.api-costgap-stats{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.9rem}
.api-costgap-chip{font-size:.8rem;padding:.35rem .7rem;border-radius:999px;
  background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.32);color:#F7C66B;font-weight:600}
.api-costgap-actions{display:flex;flex-wrap:wrap;gap:.6rem}
.api-costgap-actions .api-pro-btn{flex:0 1 auto;min-width:210px}
.api-result{margin-top:1.4rem;border:1px solid var(--edge2);border-radius:16px;overflow:hidden;
  background:rgba(255,255,255,.02)}
.api-result-hero{padding:1.5rem 1.5rem 1.3rem;text-align:center;position:relative;
  background:radial-gradient(420px 200px at 50% 0%, rgba(201,168,76,.1), transparent 65%)}
.api-result-lbl{font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;
  color:var(--txt3)}
.api-result-net{font-family:var(--display);font-size:2.15rem;font-weight:700;margin:.3rem 0 .15rem;
  letter-spacing:-.01em}
.api-result-net.pos{color:#7DEAB2}
.api-result-net.neg{color:#FF8A98}
.api-result-margin{font-size:.86rem;color:var(--txt2)}
.api-result-saved{margin-top:.6rem;font-size:.78rem;color:#7DEAB2;font-weight:500;
  display:inline-flex;align-items:center;gap:.35rem}
.api-result-saved svg{width:15px;height:15px}
.api-result-rows{padding:1.1rem 1.5rem 1.35rem;display:flex;flex-direction:column;gap:.5rem}
.api-result-row{display:flex;justify-content:space-between;gap:1rem;font-size:.88rem;
  padding-bottom:.5rem;border-bottom:1px solid rgba(127,127,127,.12)}
.api-result-row:last-child{border-bottom:none;padding-bottom:0}
.api-result-row .rl{color:var(--txt2)}
.api-result-row .rv{font-weight:600;color:var(--txt);white-space:nowrap}
.api-result-row .rv.neg{color:#FF8A98}
.api-result-row.is-total{margin-top:.15rem;padding-top:.6rem;border-top:1px solid var(--edge2);
  border-bottom:none;font-size:.95rem}
.api-result-row.is-total .rl{color:var(--txt)}
.api-result-row.is-sub{padding-left:.9rem;padding-bottom:.3rem;border-bottom:none;font-size:.78rem;opacity:.82}
.api-result-row.is-sub .rl{color:var(--txt3)}
.api-result-row.is-sub .rv{font-weight:500;color:var(--txt2)}
/* Диагностика отчёта реализации Ozon (read-only, справочная) */
.rz-diag{margin-top:1.3rem;border:1px solid rgba(201,168,76,.32);border-radius:16px;
  padding:1.1rem 1.25rem 1.2rem;background:rgba(201,168,76,.05)}
.rz-head{margin-bottom:.85rem}
.rz-title{font-family:var(--display);font-weight:700;font-size:1rem;color:var(--txt)}
.rz-sub{margin:.3rem 0 0;font-size:.8rem;color:var(--txt3);line-height:1.5;max-width:64ch}
.rz-warn{padding:.7rem .85rem;border-radius:12px;font-size:.85rem;line-height:1.45;
  background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.35);color:var(--txt2)}
.rz-cand{border:1px solid var(--edge2);border-radius:14px;padding:.85rem .95rem;
  background:var(--glass);margin-bottom:.9rem}
.rz-cand-row{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}
.rz-cand-row.sub{margin-top:.4rem}
.rz-cand-lbl{color:var(--txt2);font-size:.85rem}
.rz-cand-row.sub .rz-cand-lbl{color:var(--txt3);font-size:.8rem}
.rz-cand-val{font-weight:800;font-size:1.15rem;color:var(--gold);white-space:nowrap}
.rz-cand-row.sub .rz-cand-val{font-weight:600;font-size:.95rem;color:var(--txt)}
.rz-cand-hint{margin:.55rem 0 0;font-size:.76rem;color:var(--txt3);line-height:1.45}
.rz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.55rem;margin-bottom:.85rem}
.rz-cell{border:1px solid rgba(127,127,127,.22);border-radius:12px;padding:.55rem .7rem}
.rz-cell-lbl{font-size:.74rem;color:var(--txt3)}
.rz-cell-val{font-size:.98rem;font-weight:700;color:var(--txt);margin-top:.15rem;white-space:nowrap}
.rz-fields{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.rz-fields-cap{font-size:.78rem;color:var(--txt3);margin-right:.15rem}
.rz-chip{font-size:.74rem;padding:.22rem .5rem;border-radius:999px;border:1px solid rgba(127,127,127,.25);white-space:nowrap}
.rz-chip.ok{color:#7BE0A0;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}
.rz-chip.no{color:var(--txt3);opacity:.75}
.rz-notes{margin:.85rem 0 0;padding-left:1.1rem;display:flex;flex-direction:column;gap:.3rem}
.rz-notes li{font-size:.78rem;color:var(--txt3);line-height:1.45}
/* Диагностика структуры ответа (свёрнуто) */
.rz-debug{margin-top:.9rem;border:1px dashed rgba(127,127,127,.32);border-radius:12px;
  background:rgba(127,127,127,.05)}
.rz-debug-sum{cursor:pointer;list-style:none;padding:.6rem .8rem;font-size:.8rem;
  color:var(--txt2);font-weight:600;user-select:none}
.rz-debug-sum::-webkit-details-marker{display:none}
.rz-debug-sum::before{content:"▸ ";color:var(--txt3)}
.rz-debug[open] .rz-debug-sum::before{content:"▾ "}
.rz-debug-body{padding:.2rem .8rem .8rem;display:flex;flex-direction:column;gap:.5rem}
.rz-debug-line{font-size:.76rem;color:var(--txt3);line-height:1.5}
.rz-debug-k{color:var(--txt2);margin-right:.35rem}
.rz-debug-none{color:#F59E0B}
.rz-debug-hint{color:var(--txt3)}
.rz-keys{display:inline-flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem}
.rz-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;
  padding:.1rem .35rem;border-radius:6px;background:rgba(127,127,127,.14);
  border:1px solid rgba(127,127,127,.2);color:var(--txt2);white-space:nowrap}
.rz-code.ok{color:#7BE0A0;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}
.rz-code.no{color:var(--txt3);opacity:.7}
.api-extra-heading{margin-top:1.7rem;font-family:var(--display);font-size:.95rem;font-weight:600;
  color:var(--txt2);letter-spacing:.01em}
.api-extra-note{margin:.3rem 0 .9rem;font-size:.8rem;color:var(--txt3);line-height:1.5;max-width:62ch}
.api-extra{opacity:.94}
.api-extra-sum{position:relative;cursor:pointer;list-style:none;display:block;outline:none}
.api-extra-sum::-webkit-details-marker{display:none}
.api-extra-sum::after{content:"▸";position:absolute;right:1.7rem;top:1.55rem;color:var(--txt3);
  transition:transform .2s ease;font-size:.85rem}
details[open] > .api-extra-sum::after{transform:rotate(90deg)}
.api-extra-sum:hover .api-pro-title{color:var(--gold2)}
@media(max-width:640px){
  .api-costgap-actions .api-pro-btn{min-width:0;width:100%}
  .api-result-net{font-size:1.8rem}
  .api-extra-sum::after{right:1.3rem}
}

.api-input:disabled,
.api-input:disabled:hover{opacity:.5;cursor:not-allowed;background:rgba(255,255,255,.02);
  border-color:var(--edge);box-shadow:none}
.api-eye:disabled{opacity:.35;cursor:not-allowed}
.api-eye:disabled:hover{color:var(--txt3);border-color:transparent;background:transparent}
@media(max-width:640px){
  .api-pro-head{padding:1.3rem 1.3rem 1rem}
  .api-pro-body{padding:1.3rem}
  .api-pro-grid{grid-template-columns:1fr;gap:.85rem}
  .api-pro-foot{flex-direction:column;align-items:stretch;gap:.8rem}
  .api-pro-btn{width:100%;min-width:0;padding:13px}
  .api-pro-actions{grid-template-columns:1fr;gap:.7rem}
}

.tariff-card{margin-top:.55rem;scroll-margin-top:1.2rem}
.tariff-card .card-head{padding:.75rem 1.1rem !important}
.tariff-card .card-title{font-size:.78rem !important;font-weight:600 !important;
  color:var(--txt2) !important;letter-spacing:.02em !important}

.tariff-grid-2{
  grid-template-columns:repeat(2,minmax(0,1fr)) !important;
  gap:.85rem !important;padding:1rem !important;
  align-items:stretch
}
.tariff-grid-2 .tariff-item{
  /* одинаковая высота карточек в строке (align-items:stretch на гриде) */
  height:auto;display:flex;flex-direction:column
}
.tariff-grid-2 .tariff-item{padding:.95rem 1rem .9rem !important;gap:.4rem !important}
.tariff-grid-2 .tariff-name{font-size:.88rem !important}
.tariff-grid-2 .tariff-price{font-size:1.55rem !important}
.tariff-grid-2 .tariff-period{font-size:.52rem !important}
.tariff-grid-2 .tariff-list{margin:.25rem 0 !important;gap:.32rem !important}
.tariff-grid-2 .tariff-list li{font-size:.72rem !important}
.tariff-grid-2 .tariff-btn{padding:8px 12px !important;font-size:.76rem !important}
@media(max-width:600px){
  .tariff-grid-2{grid-template-columns:1fr !important;padding:.95rem !important}
  .tariff-grid-2 .tariff-item{padding:1.05rem 1.1rem !important}
}

/* ====== PREMIUM "Безлимит" tariff ====== */
.tariff-item.featured{
  position:relative
}
.tariff-item.featured::before{
  content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;
  background:linear-gradient(135deg,
    rgba(201,168,76,.55) 0%,
    rgba(201,168,76,.18) 25%,
    rgba(232,201,122,.62) 50%,
    rgba(201,168,76,.18) 75%,
    rgba(201,168,76,.55) 100%);
  background-size:220% 100%;
  -webkit-mask:linear-gradient(#000,#000) content-box, linear-gradient(#000,#000);
  -webkit-mask-composite:xor;mask-composite:exclude;
  animation:tariffBorderFlow 5s linear infinite;
  pointer-events:none;z-index:0
}
@keyframes tariffBorderFlow{
  from{background-position:0% 0}
  to{background-position:220% 0}
}
.tariff-item.featured .tariff-shine{
  position:absolute;inset:0;border-radius:inherit;
  overflow:hidden;pointer-events:none;z-index:0
}
.tariff-item.featured .tariff-shine::before{
  content:"";position:absolute;top:-50%;left:0;
  width:30%;height:200%;
  background:linear-gradient(115deg,
    transparent 0%,
    rgba(255,255,255,.06) 40%,
    rgba(232,201,122,.22) 50%,
    rgba(255,255,255,.06) 60%,
    transparent 100%);
  transform:translateX(-220%) rotate(20deg);
  animation:tariffShimmerSweep 6s ease-in-out infinite;
  filter:blur(2px)
}
@keyframes tariffShimmerSweep{
  0%, 15%{transform:translateX(-220%) rotate(20deg);opacity:0}
  20%{opacity:1}
  60%{transform:translateX(440%) rotate(20deg);opacity:1}
  70%, 100%{transform:translateX(440%) rotate(20deg);opacity:0}
}
/* контент карточки — выше шайна, бейдж — поверх всего */
.tariff-item.featured > .tariff-name,
.tariff-item.featured > .tariff-price,
.tariff-item.featured > .tariff-period,
.tariff-item.featured > .tariff-list,
.tariff-item.featured > .tariff-btn{position:relative;z-index:2}
.tariff-item.featured > .tariff-badge{z-index:3}

.tariff-item.featured:hover{
  transform:translateY(-4px);
  border-color:rgba(201,168,76,.65);
  box-shadow:0 30px 78px rgba(0,0,0,.42), 0 0 90px rgba(201,168,76,.24)
}

.tariff-item.tariff-flash{
  animation:tariffFlash 1.7s cubic-bezier(.22,1,.36,1)
}
@keyframes tariffFlash{
  0%{box-shadow:0 18px 50px rgba(0,0,0,.3),0 0 50px rgba(201,168,76,.10);
    border-color:rgba(201,168,76,.45)}
  25%{box-shadow:0 30px 80px rgba(0,0,0,.4),0 0 110px rgba(201,168,76,.55);
    border-color:rgba(201,168,76,.95);transform:translateY(-3px)}
  55%{box-shadow:0 26px 70px rgba(0,0,0,.38),0 0 90px rgba(201,168,76,.4);
    border-color:rgba(201,168,76,.75);transform:translateY(-2px)}
  100%{box-shadow:0 18px 50px rgba(0,0,0,.3),0 0 50px rgba(201,168,76,.10);
    border-color:rgba(201,168,76,.45);transform:translateY(0)}
}
@media (prefers-reduced-motion: reduce){
  .tariff-item.tariff-flash,
  .tariff-item.featured::before,
  .tariff-item.featured .tariff-shine::before{animation:none !important}
}
.tariff-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;padding:1.5rem}
.tariff-item{position:relative;background:rgba(255,255,255,.025);border:1px solid var(--edge);
  border-radius:13px;padding:1.4rem 1.3rem;display:flex;flex-direction:column;gap:.7rem;
  transition:all .22s ease;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.tariff-item:hover{transform:translateY(-2px);border-color:var(--smoke);background:rgba(255,255,255,.04)}
.tariff-item.featured{
  border-color:rgba(201,168,76,.4);
  background:linear-gradient(150deg,rgba(201,168,76,.07) 0%,rgba(255,255,255,.025) 60%);
  box-shadow:0 14px 38px rgba(0,0,0,.3),0 0 38px rgba(201,168,76,.08)
}
.tariff-item.featured:hover{border-color:rgba(201,168,76,.6);box-shadow:0 18px 46px rgba(0,0,0,.32),0 0 50px rgba(201,168,76,.14)}
.tariff-badge{position:absolute;top:-10px;right:14px;font-family:var(--mono);font-size:.55rem;
  font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  padding:4px 12px;border-radius:100px;box-shadow:0 4px 14px rgba(201,168,76,.35)}
.tariff-name{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);letter-spacing:-.005em}
.tariff-price{font-family:var(--display);font-size:2.1rem;font-weight:700;letter-spacing:-.03em;
  color:var(--txt);line-height:1;display:flex;align-items:baseline;gap:.25rem}
.tariff-price em{font-style:normal;color:var(--gold)}
.tariff-price .tariff-month{font-family:var(--mono);font-size:.7rem;font-weight:400;color:var(--txt3);letter-spacing:.04em}
.tariff-period{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);margin-top:-.2rem}
.tariff-list{list-style:none;padding:0;margin:.5rem 0;display:flex;flex-direction:column;gap:.5rem;flex:1}
.tariff-list li{font-size:.81rem;color:var(--txt2);display:flex;gap:.55rem;line-height:1.45;font-weight:300}
.tariff-list li::before{content:"";flex-shrink:0;margin-top:.45rem;width:5px;height:5px;border-radius:50%;background:var(--gold);box-shadow:0 0 6px rgba(201,168,76,.6)}
.tariff-btn{font-family:var(--sans);font-size:.85rem;font-weight:600;background:transparent;
  border:1px solid var(--edge2);color:var(--txt);padding:11px 14px;border-radius:9px;cursor:pointer;
  transition:all .18s;margin-top:auto;letter-spacing:.01em}
.tariff-btn:hover{border-color:var(--gold);color:var(--gold2);background:var(--gold-bg)}
.tariff-btn.primary{background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border:none;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.tariff-btn.primary:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38);color:var(--void)}
.tariff-btn:disabled{opacity:.45;cursor:not-allowed;border-style:dashed}
.tariff-btn:disabled:hover{border-color:var(--edge2);color:var(--txt);background:transparent}
.tariff-msg{font-family:var(--mono);font-size:.72rem;color:var(--gold2);letter-spacing:.03em;
  text-align:center;margin:0;padding:0 1.5rem 1.4rem}
@media(max-width:900px){
  .tariff-grid{grid-template-columns:1fr;gap:.85rem;padding:1.2rem}
  .tariff-item{padding:1.2rem 1.2rem}
}

/* ====== Tariff STATUS (активный безлимит) ====== */
.tariff-status{position:relative;padding:1.25rem 1.4rem 1.35rem}
.tariff-status-x{
  position:absolute;top:.7rem;right:.7rem;width:30px;height:30px;
  display:flex;align-items:center;justify-content:center;
  font-size:1.3rem;line-height:1;color:var(--txt3);
  background:transparent;border:1px solid transparent;border-radius:8px;
  cursor:pointer;transition:all .18s
}
.tariff-status-x:hover{color:var(--txt);border-color:var(--edge2);background:rgba(255,255,255,.04)}
.tariff-status-head{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding-right:2.4rem}
.tariff-status-badge{
  font-family:var(--mono);font-size:.55rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.14em;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  padding:4px 12px;border-radius:100px;box-shadow:0 4px 14px rgba(201,168,76,.35)
}
.tariff-status-title{font-family:var(--display);font-size:1.1rem;font-weight:700;
  color:var(--txt);letter-spacing:-.01em}
.tariff-status-text{font-size:.85rem;color:var(--txt2);line-height:1.5;font-weight:300;
  margin:.75rem 0 .25rem}
.tariff-status-list{margin:.5rem 0 !important}
.tariff-status-until{font-family:var(--mono);font-size:.72rem;color:var(--gold2);
  letter-spacing:.03em;margin:.7rem 0 0}
.tariff-status-until strong{color:var(--txt);font-weight:600}

/* ====== CALC LOADING ====== */
.calc-loading{position:relative}
.calc-loading::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;
  background:linear-gradient(110deg, transparent 25%, rgba(201,168,76,.07) 50%, transparent 75%);
  background-size:200% 100%;animation:calcShimmer 1.6s linear infinite;z-index:3}
@keyframes calcShimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.calc-loading input,
.calc-loading .mp-tab{opacity:.55;pointer-events:none;cursor:not-allowed}
/* ====== AUTH LOADING (восстановление сессии) ====== */
.auth-loading{
  display:inline-flex;align-items:center;gap:.7rem;
  padding:.7rem 1rem;border-radius:11px;
  background:var(--glass);border:1px solid var(--edge);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  font-family:var(--mono);font-size:.68rem;font-weight:500;
  letter-spacing:.06em;color:var(--txt2);
  margin-bottom:1.1rem;
  box-shadow:0 8px 24px rgba(0,0,0,.2);
  animation:authLoadIn .35s cubic-bezier(.22,1,.36,1) both
}
@keyframes authLoadIn{
  from{opacity:0;transform:translateY(-4px)}
  to{opacity:1;transform:translateY(0)}
}
.auth-loading-ring{
  width:12px;height:12px;border-radius:50%;flex-shrink:0;
  border:1.5px solid rgba(201,168,76,.2);
  border-top-color:var(--gold2);
  animation:authLoadSpin .8s linear infinite
}
@keyframes authLoadSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){
  .auth-loading,
  .auth-loading-ring{animation:none !important}
  .auth-loading-ring{border:1.5px solid var(--gold2);border-right-color:transparent}
}

/* ====== UPLOAD REPORT CARD ====== */
.upload-card{padding:1.4rem;margin-bottom:.25rem;min-width:0;overflow:hidden}

/* ===== 3-file upload (новая архитектура) ===== */
.upload-3-head{margin-bottom:1.2rem}
.upload-3-title{
  font-family:var(--display);font-style:italic;font-size:1.45rem;
  color:var(--txt);margin:0 0 .35rem;letter-spacing:.005em
}
.upload-3-sub{
  font-size:.85rem;color:var(--txt2);line-height:1.5;margin:0;max-width:680px
}
.upload-3-sub b{color:var(--gold2);font-weight:500}
/* ===== Upload guide — какие файлы нужны ===== */
.upload-guide{
  margin-bottom:1.2rem;padding:.85rem 1rem;
  background:var(--gold-bg);
  border:1px solid var(--edge2);
  border-left:2px solid var(--gold);
  border-radius:12px;
  min-width:0;overflow:hidden
}
.upload-guide-head{
  display:flex;align-items:center;gap:.5rem;margin-bottom:.65rem
}
.upload-guide-ico{flex:0 0 auto;display:flex;color:var(--gold2)}
.upload-guide-title{
  font-family:var(--display);font-style:italic;font-size:1rem;
  color:var(--txt);letter-spacing:.005em;overflow-wrap:anywhere
}
.upload-guide-list{
  list-style:none;margin:0;padding:0;
  display:flex;flex-direction:column;gap:.4rem
}
.upload-guide-item{display:flex;align-items:flex-start;gap:.55rem;min-width:0}
.upload-guide-num{
  flex:0 0 1.3rem;height:1.3rem;margin-top:.05rem;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:.72rem;font-weight:600;
  color:var(--gold3);
  background:var(--gold-bg2);
  border:1px solid var(--gold-d);
  border-radius:6px
}
.upload-guide-text{
  flex:1 1 auto;min-width:0;
  font-size:.82rem;color:var(--txt2);line-height:1.45;
  overflow-wrap:anywhere
}
.upload-guide-text b{color:var(--txt);font-weight:500}
.upload-guide-foot{
  margin-top:.7rem;padding-top:.6rem;
  border-top:1px solid var(--edge);
  font-size:.78rem;color:var(--gold2);line-height:1.45;
  overflow-wrap:anywhere
}
.upload-3-slots{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:12px;margin-bottom:1.2rem;
  width:100%;min-width:0
}
/* Laptop / tablet → 2 columns (третий уезжает вниз, без переполнения) */
@media (max-width:1100px){
  .upload-3-slots{grid-template-columns:repeat(2,minmax(0,1fr))}
}
/* Mobile → 1 column */
@media (max-width:680px){
  .upload-3-slots{grid-template-columns:1fr}
}
.upload-slot{
  position:relative;display:flex;gap:12px;align-items:flex-start;
  background:rgba(255,255,255,.028);
  border:1px solid var(--edge);
  border-radius:14px;padding:14px;
  min-width:0;            /* критично — иначе grid не позволит ужаться */
  transition:border-color .25s,background .25s,transform .2s
}
.upload-slot.is-drag{
  border-color:var(--gold);
  background:rgba(201,168,76,.08);
  box-shadow:0 0 0 1px rgba(201,168,76,.25),0 8px 22px rgba(201,168,76,.08)
}
.upload-slot:hover{border-color:rgba(201,168,76,.22);background:rgba(255,255,255,.04)}
.upload-slot.is-ready{
  border-color:rgba(46,204,138,.32);background:rgba(46,204,138,.05);
  box-shadow:0 0 0 1px rgba(46,204,138,.10),0 8px 22px rgba(46,204,138,.06)
}
.upload-slot-num{
  flex:0 0 28px;width:28px;height:28px;display:grid;place-items:center;
  border-radius:50%;font-family:var(--mono);font-size:.72rem;
  background:rgba(201,168,76,.13);color:var(--gold2);
  border:1px solid rgba(201,168,76,.28)
}
.upload-slot.is-ready .upload-slot-num{
  background:rgba(46,204,138,.16);color:#7be8b2;border-color:rgba(46,204,138,.34)
}
.upload-slot-body{flex:1;min-width:0}
.upload-slot-label{
  font-size:.88rem;color:var(--txt);font-weight:500;margin-bottom:2px;line-height:1.3
}
.upload-slot-desc{
  font-size:.72rem;color:var(--txt2);line-height:1.35;margin-bottom:8px;
  overflow-wrap:anywhere
}
.upload-slot-meta{
  font-family:var(--mono);font-size:.6rem;color:var(--txt3);
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px
}
.upload-slot-pick{
  width:100%;padding:8px 12px;border-radius:9px;font-size:.78rem;
  background:rgba(201,168,76,.10);color:var(--gold2);
  border:1px solid rgba(201,168,76,.28);cursor:pointer;
  transition:all .2s
}
.upload-slot-pick:hover{background:rgba(201,168,76,.16);border-color:var(--gold)}
.upload-slot-file{
  display:flex;align-items:center;gap:8px;
  background:rgba(46,204,138,.08);
  border:1px solid rgba(46,204,138,.20);
  border-radius:9px;padding:7px 10px;
  font-size:.74rem
}
.upload-slot-file-name{
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--txt)
}
.upload-slot-remove{
  width:20px;height:20px;display:grid;place-items:center;
  background:transparent;color:var(--txt2);border:1px solid var(--edge);
  border-radius:50%;cursor:pointer;font-size:.95rem;line-height:1;
  transition:all .15s
}
.upload-slot-remove:hover{color:var(--red);border-color:rgba(224,85,102,.35)}

.upload-3-actions{
  display:flex;gap:12px;flex-wrap:wrap;align-items:center
}
.upload-3-btn{
  padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:500;
  cursor:pointer;transition:all .2s;border:1px solid transparent
}
.upload-3-btn.primary{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:#0d1020;border-color:var(--gold);
  box-shadow:0 6px 16px rgba(201,168,76,.22)
}
.upload-3-btn.primary:hover:not(:disabled){
  transform:translateY(-1px);box-shadow:0 10px 24px rgba(201,168,76,.32)
}
.upload-3-btn.primary:disabled{
  opacity:.4;cursor:not-allowed;background:rgba(201,168,76,.18);color:var(--txt2);
  box-shadow:none
}
.upload-3-btn.ghost{
  background:transparent;color:var(--txt2);border-color:var(--edge)
}
.upload-3-btn.ghost:hover:not(:disabled){
  color:var(--txt);border-color:rgba(255,255,255,.18)
}

.upload-3-result{
  margin-top:1.3rem;padding:1.3rem 1.4rem;border-radius:14px;
  background:linear-gradient(135deg,rgba(46,204,138,.06) 0%,rgba(46,204,138,.02) 100%);
  border:1px solid rgba(46,204,138,.22);position:relative
}
.upload-3-result-title{
  font-family:var(--mono);font-size:.62rem;color:#7be8b2;
  text-transform:uppercase;letter-spacing:.1em;margin-bottom:.5rem
}
.upload-3-result-big{
  font-family:var(--display);font-style:italic;font-size:2.4rem;
  color:var(--txt);margin-bottom:1rem;letter-spacing:-.01em;line-height:1.1
}
.upload-3-result-cap{
  margin-top:-.6rem;margin-bottom:1rem;
  font-size:.78rem;color:var(--txt2);line-height:1.4;
  min-width:0;overflow-wrap:anywhere
}
/* Главный итог «Чистая прибыль» вверху результата (Задача 5). */
.np-hero{
  margin-bottom:1.2rem;padding:1.1rem 1.2rem;border-radius:13px;
  border:1px solid var(--edge);position:relative
}
.np-hero.pos{
  background:linear-gradient(135deg,rgba(46,204,138,.12),rgba(46,204,138,.03));
  border-color:rgba(46,204,138,.30)
}
.np-hero.neg{
  background:linear-gradient(135deg,rgba(232,154,153,.12),rgba(232,154,153,.03));
  border-color:rgba(232,154,153,.30)
}
.np-hero.pending{
  background:linear-gradient(135deg,rgba(201,168,76,.10),rgba(201,168,76,.02));
  border-color:rgba(201,168,76,.28)
}
.np-hero-lbl{
  font-family:var(--mono);font-size:.62rem;text-transform:uppercase;
  letter-spacing:.1em;color:var(--txt2);margin-bottom:.45rem
}
.np-hero-val{
  font-family:var(--display);font-style:italic;font-size:2.6rem;line-height:1.05;
  letter-spacing:-.01em;color:var(--txt);font-variant-numeric:tabular-nums
}
.np-hero.neg .np-hero-val{color:#e89a99}
.np-hero.pos .np-hero-val{color:#7be8b2}
.np-hero-sub{
  margin-top:.5rem;font-size:.76rem;color:var(--txt2);line-height:1.4
}
.np-hero-next{
  font-size:.86rem;color:var(--txt);line-height:1.45;margin-bottom:.9rem;
  max-width:46ch
}
.np-hero-btn{margin-top:.2rem}
/* Спокойная info-подсказка в блоке «Чистая прибыль»: точность итога зависит
   от полноты загруженных данных. Мягкий золотой акцент, не перетягивает
   внимание с суммы. */
.np-hero-note{
  display:flex;gap:.5rem;align-items:flex-start;
  margin-top:.9rem;padding:.58rem .72rem;
  border:1px solid rgba(201,168,76,.22);
  background:rgba(201,168,76,.07);
  border-radius:9px
}
.np-hero-note-ico{flex:0 0 auto;color:var(--gold);margin-top:.06rem}
.np-hero-note-ico svg{width:14px;height:14px;display:block}
.np-hero-note-txt{
  font-size:.72rem;line-height:1.45;color:var(--txt2);overflow-wrap:anywhere
}
.upload-3-result-breakdown{
  display:grid;grid-template-columns:1fr;gap:6px;padding:.7rem 0 .3rem;
  border-top:1px solid rgba(255,255,255,.06)
}
.upload-3-row{
  display:flex;justify-content:space-between;align-items:baseline;
  font-size:.82rem;color:var(--txt2);padding:3px 0
}
.upload-3-row .num{
  font-family:var(--mono);font-size:.82rem;color:#7be8b2;font-variant-numeric:tabular-nums
}
.upload-3-row.negative .num{color:#e89a99}
.upload-3-row.subtotal{
  border-top:1px dashed rgba(255,255,255,.1);margin-top:4px;padding-top:7px;
  color:var(--txt);font-weight:500
}
.upload-3-row.subtotal .num{color:var(--txt)}
.upload-3-row.payout-zero .num{color:var(--txt3)}
/* ===== График выплат Ozon ===== */
.payout-sched{
  margin-top:1.25rem;padding:1.1rem 1.15rem;border-radius:14px;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08)
}
.payout-sched-head{margin-bottom:.85rem}
.payout-sched-title{
  font-family:var(--display);font-size:1.02rem;font-weight:600;
  letter-spacing:-.01em;color:var(--txt)
}
.payout-sched-sub{
  font-size:.82rem;color:var(--txt2);font-weight:300;line-height:1.45;
  margin-top:.3rem;max-width:52ch
}
.payout-row-label{
  font-family:var(--mono);font-size:.62rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.12em;color:var(--txt3);margin:.85rem 0 .45rem
}
.payout-chips{display:flex;flex-wrap:wrap;gap:.5rem}
.payout-chip{
  font-family:var(--sans);font-size:.8rem;font-weight:500;color:var(--txt2);
  padding:.5rem .85rem;border-radius:10px;cursor:pointer;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
  transition:all .16s ease;white-space:nowrap
}
.payout-chip:hover{
  color:var(--txt);border-color:rgba(201,168,76,.4);background:rgba(201,168,76,.08)
}
.payout-chip.active{
  color:#1a1408;font-weight:600;border-color:transparent;
  background:linear-gradient(135deg,var(--gold),var(--gold2));
  box-shadow:0 4px 14px rgba(201,168,76,.28)
}
.payout-hint{
  font-size:.76rem;color:var(--txt3);font-weight:300;line-height:1.45;margin-top:.9rem
}
.payout-impact{
  display:flex;align-items:center;justify-content:space-between;gap:.75rem;
  margin-top:.9rem;padding-top:.85rem;border-top:1px dashed rgba(255,255,255,.1)
}
.payout-impact-label{font-size:.84rem;color:var(--txt2);font-weight:500}
.payout-impact-val{
  font-family:var(--mono);font-size:.95rem;font-weight:600;color:var(--txt3);
  font-variant-numeric:tabular-nums
}
.payout-impact-val.pos{color:#7be8b2}
.payout-impact-val.neg{color:#e89a99}
@media(max-width:560px){
  .payout-impact{flex-direction:column;align-items:flex-start;gap:.35rem}
}
.upload-3-note{
  margin-top:1rem;padding:.85rem 1rem;border-radius:10px;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
  border-left:3px solid rgba(201,168,76,.55)
}
.upload-3-note-title{
  font-size:.82rem;font-weight:700;color:var(--txt);margin-bottom:.35rem
}
.upload-3-note-text{
  font-size:.78rem;line-height:1.5;color:var(--txt2);margin:0;font-weight:300
}

/* ===== Финальный калькулятор чистой прибыли ===== */
.profit-calc{
  margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(255,255,255,.08)
}
.profit-calc-head{
  font-family:var(--mono);font-size:.6rem;color:var(--txt3);
  text-transform:uppercase;letter-spacing:.1em;margin-bottom:.8rem
}
.profit-grid{margin-bottom:.4rem}
/* ГЛАВНЫЙ ИТОГ расчёта — намеренно выделен сильнее обычных карточек/полей формы,
   чтобы взгляд падал сюда первым. Прибыль → зелёно-золотой акцент, убыток →
   красно-розовый. Только UI: формулы netProfit/margin/roi не затронуты. */
.profit-summary{
  margin-top:1.6rem;padding:2.1rem 1.9rem;border-radius:18px;
  border:2px solid var(--edge);background:rgba(255,255,255,.025);
  transition:border-color .25s ease, box-shadow .25s ease, background .25s ease
}
.profit-summary.pos{
  background:
    radial-gradient(120% 140% at 0% 0%, rgba(46,204,138,.16) 0%, rgba(46,204,138,0) 55%),
    linear-gradient(135deg, rgba(123,232,178,.10) 0%, rgba(201,168,76,.085) 100%);
  border-color:rgba(123,232,178,.55);
  box-shadow:0 24px 60px rgba(0,0,0,.34), 0 0 70px rgba(46,204,138,.20),
    inset 0 1px 0 rgba(255,255,255,.06)
}
.profit-summary.neg{
  background:
    radial-gradient(120% 140% at 0% 0%, rgba(224,85,102,.18) 0%, rgba(224,85,102,0) 55%),
    linear-gradient(135deg, rgba(232,154,153,.12) 0%, rgba(224,85,102,.07) 100%);
  border-color:rgba(232,120,128,.62);
  box-shadow:0 24px 60px rgba(0,0,0,.34), 0 0 70px rgba(224,85,102,.22),
    inset 0 1px 0 rgba(255,255,255,.05)
}
.profit-summary-head{
  display:flex;flex-direction:column;gap:.4rem;margin-bottom:1rem
}
.profit-summary-kicker{
  align-self:flex-start;display:inline-flex;align-items:center;gap:6px;
  font-family:var(--mono);font-size:.58rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.14em;
  padding:3px 10px;border-radius:999px;border:1px solid transparent
}
.profit-summary.pos .profit-summary-kicker{
  color:#bfe9cf;background:rgba(46,204,138,.14);border-color:rgba(46,204,138,.3)
}
.profit-summary.neg .profit-summary-kicker{
  color:#f0b8bb;background:rgba(224,85,102,.16);border-color:rgba(224,85,102,.34)
}
.profit-summary-title{
  font-family:var(--display);font-size:1.3rem;font-weight:600;
  letter-spacing:-.01em;line-height:1.1;color:var(--txt);margin-bottom:0
}
.profit-summary-caption{
  font-size:.84rem;color:var(--txt2);font-weight:300;line-height:1.4;max-width:42ch
}
.profit-summary-big{
  font-family:var(--display);font-style:italic;font-size:3.6rem;
  color:#7be8b2;letter-spacing:-.02em;line-height:1;margin-top:.2rem
}
.profit-summary.pos .profit-summary-big{
  text-shadow:0 0 40px rgba(46,204,138,.38), 0 0 10px rgba(46,204,138,.18)
}
.profit-summary.neg .profit-summary-big{
  text-shadow:0 0 40px rgba(224,85,102,.36), 0 0 10px rgba(224,85,102,.18)
}
.profit-summary-big.neg{color:#e89a99}
.profit-stats{
  display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:1.4rem
}
.profit-stat{
  display:flex;flex-direction:column;gap:3px;padding:.6rem .85rem;
  background:rgba(255,255,255,.02);border:1px solid var(--edge);border-radius:10px
}
.profit-stat-label{
  font-family:var(--mono);font-size:.56rem;color:var(--txt3);
  text-transform:uppercase;letter-spacing:.08em
}
.profit-stat-val{
  font-family:var(--mono);font-size:1.05rem;color:var(--txt2);
  font-variant-numeric:tabular-nums
}
.profit-stat-val.neg{color:#e89a99}
@media (max-width: 600px){
  .profit-summary{padding:1.5rem 1.25rem}
  .profit-summary-title{font-size:1.15rem}
  .profit-summary-big{font-size:2.4rem}
  .profit-summary-caption{font-size:.8rem}
}
.profit-breakdown{
  display:grid;grid-template-columns:1fr;gap:6px;margin-top:1.1rem;
  padding-top:.9rem;border-top:1px solid rgba(255,255,255,.06)
}

/* ===== Проверка расчёта (перед «Сохранить результат») ===== */
.calc-check{
  margin-top:1.25rem;padding:1.05rem 1.15rem;border-radius:14px;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08)
}
.calc-check-title{
  font-family:var(--mono);font-size:.6rem;color:var(--txt3);
  text-transform:uppercase;letter-spacing:.13em;margin-bottom:.8rem
}
.calc-check-list{display:grid;grid-template-columns:1fr;gap:2px}
.calc-check-row{
  display:flex;align-items:flex-start;gap:.6rem;padding:5px 0;
  font-size:.83rem;color:var(--txt2);line-height:1.3
}
.calc-check-ico{
  flex:0 0 1.1rem;text-align:center;font-family:var(--mono);
  font-size:.76rem;line-height:1.45;color:var(--txt3)
}
.calc-check-row.ok .calc-check-ico{color:var(--green)}
.calc-check-row.warn .calc-check-ico{color:#E8B04B}
.calc-check-body{flex:1 1 auto;min-width:0}
.calc-check-line{
  display:flex;align-items:baseline;gap:.6rem;justify-content:space-between
}
.calc-check-label{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.calc-check-row.warn .calc-check-label{color:var(--gold2)}
.calc-check-val{
  font-family:var(--mono);font-size:.79rem;color:var(--txt);
  font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;flex:0 0 auto
}
.calc-check-row.warn .calc-check-val{color:#E8B04B}
.calc-check-hint{
  font-size:.72rem;color:var(--txt3);line-height:1.36;margin-top:1px;
  overflow-wrap:anywhere
}
.calc-check-row.warn .calc-check-hint{color:#bfa468}
.calc-check-status{
  display:flex;align-items:flex-start;gap:.6rem;margin-top:.85rem;
  padding:.7rem .9rem;border-radius:11px
}
.calc-check-status-ico{flex:0 0 auto;font-size:.88rem;line-height:1.35}
.calc-check-status b{display:block;font-size:.85rem;font-weight:600;letter-spacing:-.01em}
.calc-check-status em{
  display:block;font-style:normal;font-size:.75rem;font-weight:300;
  margin-top:2px;opacity:.9;line-height:1.4
}
.calc-check-status.ok{
  background:rgba(46,204,138,.08);border:1px solid rgba(46,204,138,.24);color:#7be8b2
}
.calc-check-status.warn{
  background:rgba(232,176,75,.08);border:1px solid rgba(232,176,75,.28);color:#f0cd84
}
/* ===== Save hint — что будет после сохранения ===== */
.save-hint{
  display:flex;align-items:flex-start;gap:.55rem;
  margin-top:14px;padding:.7rem .85rem;
  background:rgba(255,255,255,.022);
  border:1px solid var(--edge);
  border-radius:10px;
  min-width:0
}
.save-hint-ico{flex:0 0 auto;display:flex;color:var(--txt3);margin-top:.05rem}
.save-hint-text{
  flex:1 1 auto;min-width:0;
  font-size:.76rem;color:var(--txt2);line-height:1.45;
  overflow-wrap:anywhere
}

.upload-3-error{
  margin-top:1.2rem;padding:1.1rem 1.3rem;border-radius:12px;
  background:rgba(224,85,102,.07);border:1px solid rgba(224,85,102,.24)
}
.upload-3-error-title{
  font-size:1rem;color:#f0a4a4;font-weight:500;margin-bottom:.3rem
}
.upload-3-error-sub{
  font-size:.82rem;color:var(--txt2);margin:0;line-height:1.5
}

.upload-3-debug{
  margin-top:1.2rem;padding:.7rem 1rem;border-radius:10px;
  background:rgba(255,255,255,.025);border:1px solid var(--edge);
  font-size:.7rem;color:var(--txt2)
}
.upload-3-debug summary{
  cursor:pointer;font-family:var(--mono);text-transform:uppercase;
  letter-spacing:.08em;color:var(--gold2);font-size:.6rem
}

/* === IDLE: premium drag&drop === */
.upload-drop{
  position:relative;overflow:hidden;
  border:1.5px dashed rgba(201,168,76,.32);
  border-radius:16px;
  padding:2.6rem 1.6rem 2.1rem;text-align:center;
  display:flex;flex-direction:column;align-items:center;gap:.65rem;
  background:linear-gradient(160deg,
    rgba(201,168,76,.05) 0%,
    rgba(255,255,255,.015) 70%);
  transition:border-color .28s ease, background .28s ease,
    transform .28s ease, box-shadow .28s ease
}
.upload-drop > *{position:relative;z-index:2}
/* мягкий зерновой golden glow по центру */
.upload-drop-glow{
  position:absolute;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(420px 220px at 50% 30%,
    rgba(232,201,122,.12), transparent 70%)
}
/* медленный диагональный световой sweep */
.upload-drop-sweep{
  position:absolute;inset:0;pointer-events:none;z-index:1;
  background:linear-gradient(120deg,
    transparent 25%,
    rgba(232,201,122,.07) 45%,
    rgba(201,168,76,.10) 50%,
    rgba(232,201,122,.07) 55%,
    transparent 75%);
  background-size:280% 100%;
  animation:uploadSweep 7s linear infinite
}
@keyframes uploadSweep{
  from{background-position:0% 0}
  to{background-position:280% 0}
}
.upload-drop.is-active{
  border-color:rgba(232,201,122,.7);
  border-style:solid;
  background:linear-gradient(160deg,
    rgba(201,168,76,.12) 0%,
    rgba(255,255,255,.025) 70%);
  transform:scale(1.005);
  box-shadow:0 0 0 4px rgba(201,168,76,.10),
    0 0 60px rgba(201,168,76,.18),
    inset 0 0 30px rgba(201,168,76,.06)
}
.upload-drop-icon{
  width:60px;height:60px;border-radius:17px;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(201,168,76,.28),rgba(201,168,76,.06));
  border:1px solid rgba(201,168,76,.4);color:var(--gold2);
  box-shadow:0 10px 26px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08);
  margin-bottom:.4rem;
  animation:uploadIcoPulse 3s ease-in-out infinite
}
@keyframes uploadIcoPulse{
  0%,100%{box-shadow:0 10px 26px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 0 rgba(201,168,76,.16)}
  50%{box-shadow:0 12px 30px rgba(201,168,76,.30),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 14px rgba(201,168,76,.04)}
}
.upload-drop-icon svg{width:26px;height:26px;display:block}
.upload-drop-title{
  font-family:var(--display);font-size:1.25rem;font-weight:700;
  color:var(--txt);margin:0;letter-spacing:-.012em;line-height:1.2
}
.upload-drop-title em{font-style:italic;color:var(--gold2)}
.upload-drop-sub{
  font-size:.86rem;color:var(--txt2);font-weight:300;line-height:1.55;
  margin:0 0 .25rem;max-width:400px
}
.upload-pick-btn .arr{display:inline-block;transition:transform .22s ease;margin-left:6px}
.upload-pick-btn:hover .arr{transform:translateX(3px)}
.upload-input-hidden{
  position:absolute;width:0;height:0;opacity:0;pointer-events:none
}
.upload-pick-btn{
  font-family:var(--sans);font-size:.85rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border:none;padding:9px 22px;border-radius:10px;
  cursor:pointer;margin-top:.3rem;
  box-shadow:0 8px 22px rgba(201,168,76,.30);
  transition:transform .22s ease, box-shadow .22s ease;
  -webkit-appearance:none;appearance:none
}
.upload-pick-btn:hover{
  transform:translateY(-1px) scale(1.02);
  box-shadow:0 14px 30px rgba(201,168,76,.42)
}
.upload-formats{
  display:inline-flex;gap:.45rem;margin-top:.35rem
}
.upload-formats span{
  font-family:var(--mono);font-size:.55rem;font-weight:600;
  letter-spacing:.14em;text-transform:uppercase;
  color:var(--txt3);
  padding:3px 8px;border-radius:5px;
  border:1px solid var(--edge2);
  background:rgba(255,255,255,.025)
}

/* === READY: file selected === */
.upload-ready{display:flex;flex-direction:column;gap:1rem}
.upload-file-info{
  display:flex;align-items:center;gap:.85rem;
  background:rgba(255,255,255,.025);
  border:1px solid rgba(201,168,76,.22);
  border-radius:12px;padding:.8rem .9rem;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  animation:uploadInfoIn .35s cubic-bezier(.22,1,.36,1) both
}
@keyframes uploadInfoIn{
  from{opacity:0;transform:translateY(4px)}
  to{opacity:1;transform:translateY(0)}
}
.upload-file-icon{
  width:40px;height:40px;border-radius:10px;flex-shrink:0;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(201,168,76,.24),rgba(201,168,76,.06));
  border:1px solid rgba(201,168,76,.32);color:var(--gold2);
  box-shadow:0 6px 16px rgba(201,168,76,.14),
    inset 0 1px 0 rgba(255,255,255,.06)
}
.upload-file-icon svg{width:18px;height:18px;display:block}
.upload-file-meta{flex:1;min-width:0}
.upload-file-name{
  font-family:var(--sans);font-size:.86rem;color:var(--txt);font-weight:500;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px
}
.upload-file-size{
  font-family:var(--mono);font-size:.58rem;color:var(--txt3);
  letter-spacing:.06em
}
.upload-file-remove{
  all:unset;cursor:pointer;flex-shrink:0;
  width:30px;height:30px;border-radius:9px;
  display:inline-flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,.10);
  background:rgba(255,255,255,.04);color:var(--txt2);
  font-size:1.05rem;line-height:1;
  transition:all .2s ease
}
.upload-file-remove:hover{
  border-color:rgba(224,85,102,.42);
  color:#FF8A98;
  background:rgba(224,85,102,.08)
}
.upload-analyze-btn{
  font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border:none;padding:12px 22px;border-radius:11px;
  cursor:pointer;width:100%;
  box-shadow:0 10px 28px rgba(201,168,76,.32);
  transition:transform .22s ease, box-shadow .22s ease;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  -webkit-appearance:none;appearance:none
}
.upload-analyze-btn:hover{
  transform:translateY(-1px) scale(1.01);
  box-shadow:0 16px 36px rgba(201,168,76,.44)
}
.upload-analyze-btn .arr{display:inline-block;transition:transform .22s ease}
.upload-analyze-btn:hover .arr{transform:translateX(3px)}

/* === PROCESSING (использует .ai-proc-* ниже) === */
.upload-processing{
  padding:1rem 0 .5rem;
  display:flex;flex-direction:column;align-items:center;gap:.85rem;
  text-align:center
}
.upload-processing .ai-proc-stages{width:100%;max-width:340px}
.upload-processing .ai-proc-progress{width:100%;max-width:340px}

/* === SUCCESS state === */
.upload-success{
  display:flex;flex-direction:column;align-items:center;gap:.8rem;
  padding:1.4rem .5rem .3rem;text-align:center;
  animation:uploadSuccessIn .45s cubic-bezier(.22,1,.36,1) both
}
@keyframes uploadSuccessIn{
  from{opacity:0;transform:translateY(8px)}
  to{opacity:1;transform:translateY(0)}
}
.upload-success-icon{
  width:62px;height:62px;border-radius:18px;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(46,204,138,.28),rgba(46,204,138,.06));
  border:1px solid rgba(46,204,138,.42);color:#7DEAB2;
  box-shadow:0 12px 30px rgba(46,204,138,.26),
    inset 0 1px 0 rgba(255,255,255,.08);
  animation:uploadSuccessIcoIn .55s cubic-bezier(.34,1.56,.64,1) both,
    uploadSuccessIcoPulse 3s ease-in-out infinite .55s
}
@keyframes uploadSuccessIcoIn{
  from{opacity:0;transform:scale(.5) rotate(-14deg)}
  to{opacity:1;transform:scale(1) rotate(0)}
}
@keyframes uploadSuccessIcoPulse{
  0%,100%{box-shadow:0 12px 30px rgba(46,204,138,.26),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 0 rgba(46,204,138,.18)}
  50%{box-shadow:0 14px 34px rgba(46,204,138,.32),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 14px rgba(46,204,138,.04)}
}
.upload-success-icon svg{width:28px;height:28px;display:block}
.upload-success-title{
  font-family:var(--display);font-size:1.1rem;font-weight:700;
  color:var(--txt);letter-spacing:-.005em;margin:0
}
.upload-success-sub{
  font-family:var(--mono);font-size:.7rem;letter-spacing:.04em;
  color:var(--txt2);max-width:340px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  margin:0 .5rem
}
.upload-success-meta{
  display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;justify-content:center;
  margin:.2rem 0 .35rem
}
.upload-mp-badge{
  display:inline-flex;align-items:center;gap:6px;
  font-family:var(--mono);font-size:.6rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.1em;
  padding:5px 11px;border-radius:100px;border:1px solid;line-height:1
}
.upload-mp-badge.sm{font-size:.54rem;padding:3px 8px;gap:5px}
.upload-mp-badge.ozon{
  color:#9ec6ff;border-color:rgba(61,123,255,.45);background:rgba(61,123,255,.1)
}
.upload-mp-badge.wb{
  color:#f0a4e6;border-color:rgba(203,17,171,.45);background:rgba(203,17,171,.1)
}
.upload-mp-dot{
  width:6px;height:6px;border-radius:50%;flex-shrink:0;
  background:currentColor;box-shadow:0 0 6px currentColor;opacity:.85
}
.upload-meta-pill{
  font-family:var(--mono);font-size:.6rem;font-weight:500;
  letter-spacing:.06em;color:var(--txt2);
  padding:5px 10px;border-radius:100px;
  border:1px solid var(--edge2);background:rgba(255,255,255,.025)
}
.upload-success-actions{
  display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;
  margin-top:.5rem;width:100%;max-width:380px
}
.upload-success-btn{
  font-family:var(--sans);font-size:.85rem;font-weight:600;
  padding:11px 18px;border-radius:10px;cursor:pointer;
  transition:transform .22s ease, box-shadow .22s ease,
    background .22s ease, color .22s ease, border-color .22s ease;
  border:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  -webkit-appearance:none;appearance:none;flex:1;min-width:140px
}
.upload-success-btn.primary{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);
  box-shadow:0 10px 26px rgba(201,168,76,.32)
}
.upload-success-btn.primary:hover{
  transform:translateY(-1px) scale(1.01);
  box-shadow:0 16px 34px rgba(201,168,76,.44)
}
.upload-success-btn.ghost{
  background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--edge2)
}
.upload-success-btn.ghost:hover{
  border-color:rgba(201,168,76,.4);color:var(--gold2);
  background:var(--gold-bg);transform:translateY(-1px)
}
.upload-success-btn .arr{display:inline-block;transition:transform .22s ease}
.upload-success-btn:hover .arr{transform:translateX(3px)}

/* === ERROR state === */
.upload-error{
  display:flex;flex-direction:column;align-items:center;gap:.7rem;
  padding:1.4rem .5rem .3rem;text-align:center;
  animation:uploadSuccessIn .4s cubic-bezier(.22,1,.36,1) both
}
.upload-error-icon{
  width:56px;height:56px;border-radius:16px;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(224,85,102,.26),rgba(224,85,102,.06));
  border:1px solid rgba(224,85,102,.4);color:#FF8A98;
  box-shadow:0 12px 28px rgba(224,85,102,.22),
    inset 0 1px 0 rgba(255,255,255,.06)
}
.upload-error-icon svg{width:24px;height:24px}
.upload-error-title{
  font-family:var(--display);font-size:1.05rem;font-weight:700;
  color:var(--txt);margin:0
}
.upload-error-sub{
  font-size:.85rem;color:var(--txt2);font-weight:300;line-height:1.5;
  margin:0 0 .3rem;max-width:340px
}

/* === RECENT UPLOADS mini section === */
.upload-recent{margin-top:.75rem}
.upload-recent-head{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:.5rem;padding:0 .15rem
}
.upload-recent-title{
  font-family:var(--mono);font-size:.58rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.14em;color:var(--txt3)
}
.upload-recent-count{
  font-family:var(--mono);font-size:.55rem;color:var(--gold2);
  background:var(--gold-bg);border:1px solid rgba(201,168,76,.22);
  padding:2px 8px;border-radius:100px;letter-spacing:.06em
}
.upload-recent-grid{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
  gap:.55rem
}
.upload-recent-card{
  background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.07);
  border-radius:11px;padding:.65rem .8rem;
  display:flex;flex-direction:column;gap:.4rem;
  transition:transform .22s ease, border-color .22s ease,
    background .22s ease, box-shadow .22s ease
}
.upload-recent-card:hover{
  transform:translateY(-2px);
  border-color:rgba(201,168,76,.3);
  background:rgba(255,255,255,.045);
  box-shadow:0 10px 22px rgba(0,0,0,.24),
    0 0 22px rgba(201,168,76,.08)
}
.upload-recent-row{
  display:flex;align-items:center;justify-content:space-between;gap:.5rem
}
.upload-recent-status{
  font-family:var(--mono);font-size:.5rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.12em;color:#7DEAB2;
  padding:2px 7px;border-radius:5px;
  background:rgba(46,204,138,.08);border:1px solid rgba(46,204,138,.22)
}
.upload-recent-name{
  font-family:var(--sans);font-size:.78rem;color:var(--txt);font-weight:500;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}
.upload-recent-foot{
  display:flex;align-items:center;justify-content:space-between;gap:.5rem
}
.upload-recent-profit{
  font-family:var(--display);font-size:.95rem;font-weight:700;
  letter-spacing:-.022em;line-height:1
}
.upload-recent-profit.pos{color:#2ECC8A}
.upload-recent-profit.neg{color:#E05566}
.upload-recent-date{
  font-family:var(--mono);font-size:.55rem;color:var(--txt3);letter-spacing:.06em
}

@media (prefers-reduced-motion: reduce){
  .upload-drop,
  .upload-drop-sweep,
  .upload-drop-icon,
  .upload-pick-btn,
  .upload-analyze-btn,
  .upload-file-info,
  .upload-success,
  .upload-success-icon,
  .upload-error,
  .upload-recent-card{transition:none !important;animation:none !important}
  .upload-drop.is-active{transform:none}
}

/* ====== UPGRADE HINT (compact, subtle SaaS-style) ====== */
.upgrade-hint{
  display:flex;align-items:center;justify-content:space-between;gap:1rem;
  flex-wrap:wrap;
  margin-top:1.2rem;padding:.65rem .8rem .65rem 1rem;
  background:linear-gradient(160deg,rgba(201,168,76,.07),rgba(13,16,32,.65));
  border:1px solid rgba(201,168,76,.22);
  border-radius:12px;
  backdrop-filter:blur(12px) saturate(1.2);
  -webkit-backdrop-filter:blur(12px) saturate(1.2);
  box-shadow:0 6px 18px rgba(0,0,0,.22);
  animation:upgradeHintIn .4s cubic-bezier(.22,1,.36,1) both
}
@keyframes upgradeHintIn{
  from{opacity:0;transform:translateY(4px)}
  to{opacity:1;transform:translateY(0)}
}
.upgrade-hint-left{display:flex;align-items:center;gap:.6rem;min-width:0}
.upgrade-hint-dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:var(--gold);
  box-shadow:0 0 10px rgba(201,168,76,.55);
  animation:upgradeHintDot 2.4s ease-in-out infinite
}
@keyframes upgradeHintDot{0%,100%{opacity:1}50%{opacity:.5}}
.upgrade-hint-text{
  font-family:var(--mono);font-size:.62rem;font-weight:600;
  letter-spacing:.14em;text-transform:uppercase;color:var(--txt2);
  white-space:nowrap
}
.upgrade-hint-actions{display:flex;gap:.4rem;flex-wrap:wrap}
.upgrade-hint-btn{
  font-family:var(--sans);font-size:.74rem;font-weight:500;
  padding:7px 12px;border-radius:8px;cursor:pointer;
  background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--edge2);
  transition:transform .22s ease, border-color .22s ease,
    background .22s ease, color .22s ease, box-shadow .22s ease;
  display:inline-flex;align-items:center;gap:6px;line-height:1.2;
  -webkit-appearance:none;appearance:none
}
.upgrade-hint-btn em{
  font-style:normal;color:var(--gold2);font-weight:600;letter-spacing:.01em
}
.upgrade-hint-btn:hover{
  border-color:rgba(201,168,76,.4);
  background:var(--gold-bg);
  transform:translateY(-1px);
  box-shadow:0 4px 12px rgba(201,168,76,.14)
}
.upgrade-hint-btn.primary{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border-color:transparent;
  box-shadow:0 6px 16px rgba(201,168,76,.30)
}
.upgrade-hint-btn.primary em{color:var(--void);font-weight:700}
.upgrade-hint-btn.primary:hover{
  transform:translateY(-1px) scale(1.01);
  box-shadow:0 10px 22px rgba(201,168,76,.42)
}
@media(max-width:560px){
  .upgrade-hint{flex-direction:column;align-items:stretch;gap:.6rem;padding:.7rem .8rem}
  .upgrade-hint-left{justify-content:center}
  .upgrade-hint-actions{display:grid;grid-template-columns:1fr 1fr;gap:.4rem}
  .upgrade-hint-btn{justify-content:center}
}
@media (prefers-reduced-motion: reduce){
  .upgrade-hint,
  .upgrade-hint-dot{animation:none !important}
}

/* ====== PAYWALL CARD (free limit reached) ====== */
.paywall-card{
  position:relative;
  background:linear-gradient(160deg,
    rgba(201,168,76,.12) 0%,
    rgba(13,16,32,.96) 70%);
  border:1px solid rgba(201,168,76,.32);
  border-radius:14px;
  padding:1.6rem 1.5rem 1.4rem;
  margin-top:1.4rem;
  overflow:hidden;text-align:center;
  box-shadow:0 18px 50px rgba(0,0,0,.32),
    0 0 50px rgba(201,168,76,.12);
  animation:paywallIn .5s cubic-bezier(.22,1,.36,1) both
}
@keyframes paywallIn{
  from{opacity:0;transform:translateY(8px) scale(.985)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
.paywall-card::before{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(420px 220px at 50% -10%,
    rgba(232,201,122,.18), transparent 65%)
}
.paywall-card > *{position:relative}

/* animated gold border light — subtle shimmer flow */
.paywall-shine{
  position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(120deg,
    rgba(201,168,76,.55) 0%,
    rgba(232,201,122,.15) 25%,
    rgba(201,168,76,.55) 50%,
    rgba(232,201,122,.15) 75%,
    rgba(201,168,76,.55) 100%);
  background-size:280% 100%;
  -webkit-mask:linear-gradient(#000,#000) content-box, linear-gradient(#000,#000);
  -webkit-mask-composite:xor;mask-composite:exclude;
  animation:paywallShineFlow 4s linear infinite;
  pointer-events:none;z-index:0
}
@keyframes paywallShineFlow{
  from{background-position:0% 0}
  to{background-position:280% 0}
}

.paywall-badge{
  display:inline-flex;align-items:center;gap:5px;
  font-family:var(--mono);font-size:.56rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.16em;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  padding:4px 10px;border-radius:100px;
  box-shadow:0 4px 12px rgba(201,168,76,.42);margin-bottom:.85rem
}
.paywall-badge svg{width:9px;height:9px;display:block}

.paywall-icon{
  width:48px;height:48px;border-radius:14px;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(201,168,76,.28),rgba(201,168,76,.08));
  border:1px solid rgba(201,168,76,.36);color:var(--gold2);
  margin:0 auto .9rem;
  box-shadow:0 8px 24px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08);
  animation:paywallIconPulse 3s ease-in-out infinite
}
@keyframes paywallIconPulse{
  0%,100%{box-shadow:0 8px 24px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 0 rgba(201,168,76,.18)}
  50%{box-shadow:0 10px 28px rgba(201,168,76,.30),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 12px rgba(201,168,76,.04)}
}
.paywall-icon svg{width:22px;height:22px;display:block}

.paywall-title{
  font-family:var(--display);font-size:1.15rem;font-weight:700;
  color:var(--txt);letter-spacing:-.005em;margin:0 0 .4rem;line-height:1.25
}
.paywall-sub{
  font-size:.86rem;color:var(--txt2);font-weight:300;line-height:1.5;
  margin:0 auto 1.3rem;max-width:320px
}

.paywall-actions{
  display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center
}
.paywall-btn{
  font-family:var(--sans);font-size:.84rem;font-weight:600;
  padding:11px 18px;border-radius:10px;cursor:pointer;
  transition:transform .22s ease, box-shadow .22s ease,
    background .22s ease, color .22s ease, border-color .22s ease;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  border:none;letter-spacing:.01em;line-height:1.2;
  -webkit-appearance:none;appearance:none
}
.paywall-btn-ghost{
  background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--edge2)
}
.paywall-btn-ghost:hover{
  border-color:var(--gold);color:var(--gold2);
  background:var(--gold-bg);transform:translateY(-1px)
}
.paywall-btn-gold{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);box-shadow:0 8px 22px rgba(201,168,76,.32)
}
.paywall-btn-gold:hover{
  transform:translateY(-2px) scale(1.02);
  box-shadow:0 16px 36px rgba(201,168,76,.46),
    0 0 24px rgba(201,168,76,.22)
}
.paywall-btn-gold .arr{display:inline-block;transition:transform .22s ease}
.paywall-btn-gold:hover .arr{transform:translateX(3px)}

@media(max-width:520px){
  .paywall-actions{flex-direction:column}
  .paywall-btn{width:100%}
}
@media (prefers-reduced-motion: reduce){
  .paywall-card,
  .paywall-shine,
  .paywall-icon{animation:none !important}
}

/* ====== PREMIUM AI PROCESSING OVERLAY ====== */
.ai-proc-overlay{
  position:absolute;inset:0;z-index:10;
  display:flex;align-items:center;justify-content:center;
  padding:1.5rem;
  background:rgba(8,10,20,.65);
  backdrop-filter:blur(10px) saturate(1.2);
  -webkit-backdrop-filter:blur(10px) saturate(1.2);
  border-radius:inherit;
  animation:aiOverlayIn .35s cubic-bezier(.22,1,.36,1) both
}
@keyframes aiOverlayIn{from{opacity:0}to{opacity:1}}

.ai-proc-card{
  position:relative;
  max-width:380px;width:100%;
  background:linear-gradient(160deg,
    rgba(201,168,76,.10) 0%,
    rgba(13,16,32,.96) 70%);
  border:1px solid rgba(201,168,76,.25);
  border-radius:16px;
  padding:1.5rem 1.4rem 1.3rem;
  backdrop-filter:blur(18px) saturate(1.3);
  -webkit-backdrop-filter:blur(18px) saturate(1.3);
  box-shadow:0 24px 60px rgba(0,0,0,.55),
    0 0 60px rgba(201,168,76,.14);
  overflow:hidden;
  animation:aiCardIn .45s cubic-bezier(.22,1,.36,1) both
}
@keyframes aiCardIn{
  from{opacity:0;transform:translateY(10px) scale(.97)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
.ai-proc-card > *{position:relative;z-index:1}

/* animated border light — золотой gradient «бегает» по периметру */
.ai-proc-border{
  position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(120deg,
    rgba(201,168,76,.7) 0%,
    rgba(232,201,122,.18) 20%,
    rgba(201,168,76,.7) 40%,
    rgba(232,201,122,.12) 70%,
    rgba(201,168,76,.7) 100%);
  background-size:300% 100%;
  -webkit-mask:linear-gradient(#000,#000) content-box, linear-gradient(#000,#000);
  -webkit-mask-composite:xor;mask-composite:exclude;
  animation:aiBorderFlow 3.2s linear infinite;
  pointer-events:none;z-index:0
}
@keyframes aiBorderFlow{
  from{background-position:0% 50%}
  to{background-position:300% 50%}
}

/* AI icon — золотая капсула с sparkle, пульсирует */
.ai-proc-ico{
  width:48px;height:48px;border-radius:14px;
  display:flex;align-items:center;justify-content:center;
  margin:0 auto .85rem;
  background:linear-gradient(135deg,rgba(201,168,76,.26),rgba(201,168,76,.06));
  border:1px solid rgba(201,168,76,.32);
  color:#E8C97A;
  box-shadow:0 8px 24px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08);
  animation:aiIcoPulse 2.4s ease-in-out infinite
}
@keyframes aiIcoPulse{
  0%,100%{box-shadow:0 8px 24px rgba(201,168,76,.22),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 0 rgba(201,168,76,.16)}
  50%{box-shadow:0 10px 30px rgba(201,168,76,.32),
    inset 0 1px 0 rgba(255,255,255,.08),
    0 0 0 12px rgba(201,168,76,.04)}
}
.ai-proc-ico svg{
  width:24px;height:24px;display:block;
  animation:aiIcoBreathe 3.6s ease-in-out infinite
}
@keyframes aiIcoBreathe{
  0%,100%{transform:rotate(0deg) scale(1)}
  50%{transform:rotate(28deg) scale(1.08)}
}

/* title */
.ai-proc-title{
  font-family:var(--display);font-size:1.05rem;font-weight:700;
  text-align:center;color:var(--txt);margin:0 0 1.1rem;
  letter-spacing:-.005em;line-height:1.2
}
.ai-proc-title em{font-style:italic;color:var(--gold)}

/* stages list */
.ai-proc-stages{
  list-style:none;padding:0;margin:0 0 1.1rem;
  display:flex;flex-direction:column;gap:.5rem
}
.ai-proc-stage{
  display:flex;align-items:center;gap:.7rem;
  font-family:var(--mono);font-size:.72rem;letter-spacing:.02em;
  color:rgba(232,238,248,.38);
  transition:color .35s ease, opacity .35s ease
}
.ai-proc-mark{
  width:14px;height:14px;border-radius:50%;flex-shrink:0;
  border:1.5px solid rgba(255,255,255,.14);
  background:transparent;position:relative;
  transition:all .35s cubic-bezier(.22,1,.36,1)
}
.ai-proc-stage.is-active{color:#E8C97A}
.ai-proc-stage.is-active .ai-proc-mark{
  border-color:rgba(201,168,76,.65);
  background:rgba(201,168,76,.18);
  box-shadow:0 0 0 4px rgba(201,168,76,.10),
    inset 0 0 8px rgba(201,168,76,.35);
  animation:aiMarkPulse 1.1s ease-in-out infinite
}
@keyframes aiMarkPulse{
  0%,100%{box-shadow:0 0 0 4px rgba(201,168,76,.10),
    inset 0 0 8px rgba(201,168,76,.35)}
  50%{box-shadow:0 0 0 7px rgba(201,168,76,.06),
    inset 0 0 12px rgba(201,168,76,.55)}
}
.ai-proc-stage.is-done{color:rgba(232,238,248,.72)}
.ai-proc-stage.is-done .ai-proc-mark{
  border-color:rgba(201,168,76,.6);
  background:#C9A84C;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)
}
.ai-proc-stage.is-done .ai-proc-mark::after{
  content:"";position:absolute;
  top:50%;left:50%;
  width:6px;height:3px;
  border-left:1.6px solid #05070f;
  border-bottom:1.6px solid #05070f;
  transform:translate(-50%,-70%) rotate(-45deg)
}

/* progress line + shimmer */
.ai-proc-progress{
  width:100%;height:3px;border-radius:2px;
  background:rgba(255,255,255,.06);
  overflow:hidden;position:relative
}
.ai-proc-progress-bar{
  position:absolute;top:0;left:0;height:100%;width:0;
  border-radius:inherit;
  background:linear-gradient(90deg,#C9A84C 0%,#E8C97A 100%);
  box-shadow:0 0 10px rgba(201,168,76,.42);
  animation:aiProgressFill 3.6s linear forwards
}
@keyframes aiProgressFill{from{width:0}to{width:100%}}
.ai-proc-progress::after{
  content:"";position:absolute;top:0;left:-30%;width:30%;height:100%;
  background:linear-gradient(90deg,
    transparent 0%,
    rgba(255,255,255,.5) 50%,
    transparent 100%);
  animation:aiProgressShimmer 1.5s ease-in-out infinite;
  pointer-events:none
}
@keyframes aiProgressShimmer{
  0%{left:-30%;opacity:0}
  20%{opacity:1}
  100%{left:100%;opacity:0}
}

@media(max-width:640px){
  .ai-proc-overlay{padding:1rem}
  .ai-proc-card{padding:1.3rem 1.1rem 1.1rem;border-radius:14px}
  .ai-proc-title{font-size:.95rem}
  .ai-proc-stage{font-size:.68rem}
}
.spin-dark{display:inline-block;width:14px;height:14px;border-radius:50%;
  border:2px solid rgba(0,0,0,.2);border-top-color:rgba(0,0,0,.6);
  animation:calcRing .75s linear infinite}
.btn-gold:disabled,.btn-ghost:disabled{opacity:.6;cursor:not-allowed}
.btn-gold:disabled:hover,.btn-ghost:disabled:hover{transform:none;box-shadow:none}

/* ====== EMPTY RESULT BARS ====== */
.empty-bars{display:flex;flex-direction:column;gap:9px;margin:1.6rem auto 0;
  padding:0 .5rem;max-width:240px}
.empty-bar{height:9px;border-radius:5px;
  background:linear-gradient(90deg,
    rgba(201,168,76,.18) 0%,
    rgba(201,168,76,.06) 50%,
    rgba(201,168,76,.18) 100%);
  background-size:200% 100%;
  animation:emptyPulse 2.8s ease-in-out infinite;
  filter:blur(.4px);opacity:.5;align-self:flex-start}
.empty-bar.bar-1{width:78%}
.empty-bar.bar-2{width:55%;animation-delay:.3s}
.empty-bar.bar-3{width:65%;animation-delay:.6s}
@keyframes emptyPulse{
  0%,100%{opacity:.35;background-position:0% 0}
  50%{opacity:.65;background-position:100% 0}
}

/* ====== API EMPTY STATE ====== */
.api-empty{padding:2.2rem 1.7rem 1.9rem;border-bottom:1px solid var(--edge);
  text-align:center;position:relative;overflow:hidden}
.api-empty::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(440px 240px at 50% 0%, rgba(201,168,76,.10), transparent 60%)}
.api-empty > *{position:relative}
.api-empty-ico{width:64px;height:64px;border-radius:18px;display:inline-flex;
  align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(201,168,76,.24) 0%,rgba(201,168,76,.06) 100%);
  border:1px solid rgba(201,168,76,.32);color:var(--gold2);margin-bottom:1.1rem;
  box-shadow:0 10px 30px rgba(201,168,76,.18);
  animation:apiEmptyPulse 3.4s ease-in-out infinite}
@keyframes apiEmptyPulse{
  0%,100%{box-shadow:0 10px 30px rgba(201,168,76,.18),0 0 0 0 rgba(201,168,76,.18)}
  50%{box-shadow:0 12px 32px rgba(201,168,76,.22),0 0 0 14px rgba(201,168,76,.04)}
}
.api-empty-ico svg{width:28px;height:28px;display:block}
.api-empty-title{font-family:var(--display);font-size:1.18rem;font-weight:700;color:var(--txt);
  margin:0 0 .4rem;letter-spacing:-.005em}
.api-empty-sub{font-size:.88rem;color:var(--txt2);font-weight:300;line-height:1.55;
  max-width:440px;margin:0 auto 1.3rem}
.api-empty-list{list-style:none;padding:0;margin:0;display:inline-flex;flex-wrap:wrap;
  gap:.5rem;justify-content:center}
.api-empty-list li{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;
  letter-spacing:.11em;color:var(--gold2);background:var(--gold-bg);
  border:1px solid rgba(201,168,76,.22);padding:7px 13px;border-radius:100px;
  display:inline-flex;align-items:center;gap:7px;font-weight:600}
.api-empty-list li::before{content:"";width:5px;height:5px;border-radius:50%;
  background:var(--gold);box-shadow:0 0 8px rgba(201,168,76,.6)}
@media(max-width:640px){
  .api-empty{padding:1.8rem 1.3rem 1.5rem}
  .api-empty-title{font-size:1.05rem}
  .api-empty-sub{font-size:.85rem;margin-bottom:1rem}
  .api-empty-list{gap:.4rem}
  .api-empty-list li{font-size:.58rem;padding:6px 10px}
}

/* ====== ONBOARDING CARD ====== */
.onboard-card{
  display:flex;align-items:center;justify-content:space-between;gap:1rem;
  background:linear-gradient(135deg, rgba(201,168,76,.10) 0%, rgba(255,255,255,.025) 60%);
  border:1px solid rgba(201,168,76,.28);
  border-radius:14px;
  padding:.95rem 1.2rem;margin-bottom:1.1rem;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  box-shadow:0 12px 32px rgba(0,0,0,.22), 0 0 32px rgba(201,168,76,.07);
  animation:onboardIn .4s cubic-bezier(.22,1,.36,1) both;
  position:relative;overflow:hidden
}
.onboard-card::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(420px 180px at 50% 0%, rgba(201,168,76,.10), transparent 60%)}
.onboard-card > *{position:relative}
@keyframes onboardIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.onboard-steps{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;flex:1}
.onboard-step{display:inline-flex;align-items:center;gap:.55rem;
  font-family:var(--mono);font-size:.7rem;color:var(--txt2);letter-spacing:.04em}
.onboard-num{width:22px;height:22px;border-radius:7px;display:inline-flex;
  align-items:center;justify-content:center;
  background:linear-gradient(135deg, var(--gold) 0%, var(--gold2) 100%);
  color:var(--void);font-family:var(--display);font-weight:700;font-size:.78rem;
  box-shadow:0 4px 12px rgba(201,168,76,.32)}
.onboard-text{color:var(--txt)}
.onboard-arrow{font-family:var(--mono);color:var(--gold);opacity:.55;font-size:.85rem}
.onboard-close{all:unset;width:28px;height:28px;border-radius:8px;cursor:pointer;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);
  color:var(--txt3);font-size:1.15rem;line-height:1;
  display:inline-flex;align-items:center;justify-content:center;
  transition:all .18s ease}
.onboard-close:hover{border-color:var(--gold);color:var(--gold2);background:var(--gold-bg)}
@media(max-width:640px){
  .onboard-card{flex-direction:column;align-items:stretch;gap:.7rem}
  .onboard-arrow{display:none}
  .onboard-steps{flex-direction:column;gap:.5rem;align-items:flex-start}
  .onboard-close{align-self:flex-end;margin-top:-2.4rem}
}

/* ====== PREMIUM INPUTS (focus glow + placeholder fade) ====== */
.in-wrap input{transition:border .22s ease, background .22s ease, box-shadow .22s ease}
.in-wrap input::placeholder{transition:opacity .22s ease, transform .22s ease}
.in-wrap input:focus{
  border-color:var(--gold);
  background:rgba(255,255,255,.055);
  box-shadow:0 0 0 3px rgba(201,168,76,.16), 0 0 24px rgba(201,168,76,.10)
}
.in-wrap input:focus::placeholder{opacity:0;transform:translateX(4px)}
.in-wrap:has(input:focus) .in-cur{color:var(--gold2);transition:color .22s ease}

/* ====== PREMIUM MARKETPLACE TABS ====== */
.mp-tab{display:inline-flex;align-items:center;justify-content:center;gap:9px;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:all .22s ease;position:relative;overflow:hidden}
.mp-tab:hover{transform:translateY(-2px);border-color:var(--smoke);color:var(--txt);
  background:rgba(255,255,255,.04);
  box-shadow:0 8px 22px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.04)}
.mp-tab.act-ozon{
  border-color:rgba(61,123,255,.55);color:#9ec6ff;
  background:linear-gradient(135deg, rgba(61,123,255,.18) 0%, rgba(61,123,255,.05) 100%);
  box-shadow:0 0 26px rgba(61,123,255,.18), inset 0 1px 0 rgba(255,255,255,.07)
}
/* Ozon-only: статичный индикатор маркетплейса (не кнопка) */
.mp-tab.mp-static{cursor:default;pointer-events:none}
.mp-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:var(--smoke);transition:all .22s ease}
.mp-dot-ozon{background:#3d7bff}
.mp-tab.act-ozon .mp-dot-ozon{box-shadow:0 0 12px #3d7bff, 0 0 24px rgba(61,123,255,.4);
  animation:mpDotPulse 2.4s ease-in-out infinite}
@keyframes mpDotPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.3)}}

/* ====== STATS CARDS hover + gradient glow ====== */
.stat-card{position:relative;transition:transform .25s ease, box-shadow .25s ease, border-color .25s ease}
.stat-card::before{
  content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(135deg, transparent 0%, rgba(201,168,76,.5) 50%, transparent 100%);
  -webkit-mask:linear-gradient(#000,#000) content-box, linear-gradient(#000,#000);
  -webkit-mask-composite:xor;mask-composite:exclude;
  opacity:0;transition:opacity .25s ease;pointer-events:none
}
.stat-card:hover{transform:translateY(-3px);
  border-color:rgba(201,168,76,.3);
  box-shadow:0 18px 44px rgba(0,0,0,.32), 0 0 36px rgba(201,168,76,.10)}
.stat-card:hover::before{opacity:1}

/* ====== RESULT CARD premium ====== */
.res-hero{position:relative;isolation:isolate;overflow:hidden}
.res-hero-chart{position:absolute;left:0;right:0;bottom:0;width:100%;height:62%;
  pointer-events:none;opacity:.55;z-index:0}
.res-hero-glow{position:absolute;left:50%;top:62%;width:280px;height:160px;
  transform:translate(-50%,-50%);pointer-events:none;z-index:0;
  background:radial-gradient(closest-side, rgba(201,168,76,.20), transparent 70%);
  filter:blur(6px);opacity:.7}
.res-hero > *:not(.res-hero-chart):not(.res-hero-glow){position:relative;z-index:1}

.res-hero-val{transition:transform .35s cubic-bezier(.34,1.56,.64,1), text-shadow .35s ease}
.result-card.result-pos .res-hero-val.pos{
  text-shadow:0 0 32px rgba(46,204,138,.32), 0 0 8px rgba(46,204,138,.15)
}
.result-card.result-neg .res-hero-val.neg{
  text-shadow:0 0 32px rgba(224,85,102,.32), 0 0 8px rgba(224,85,102,.15)
}

.res-margin{position:relative;overflow:hidden}
.res-margin::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(110deg,
    transparent 40%, rgba(255,255,255,.18) 50%, transparent 60%);
  background-size:220% 100%;background-position:200% 0;
  animation:marginShine 4s ease-in-out infinite}
@keyframes marginShine{
  0%, 8%{background-position:200% 0;opacity:0}
  12%{opacity:1}
  60%{background-position:-200% 0;opacity:1}
  72%, 100%{background-position:-200% 0;opacity:0}
}

.res-row{position:relative;border-bottom:none}
.res-row::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;
  background:linear-gradient(to right,
    transparent 0%, rgba(255,255,255,.08) 50%, transparent 100%)}
.res-row:last-child::after{display:none}

/* ====== SUCCESS PULSE on result-card after calculate ====== */
.result-card.success-pulse{
  animation:resultSuccessGlow 2.1s ease-out
}
@keyframes resultSuccessGlow{
  0%{box-shadow:0 24px 60px rgba(0,0,0,.35), 0 0 50px rgba(201,168,76,.06)}
  18%{box-shadow:0 28px 70px rgba(0,0,0,.4), 0 0 90px rgba(46,204,138,.45)}
  100%{box-shadow:0 24px 60px rgba(0,0,0,.35), 0 0 50px rgba(201,168,76,.06)}
}
.result-card.success-pulse .res-hero-val{
  animation:profitPop .85s cubic-bezier(.34,1.56,.64,1)
}
@keyframes profitPop{
  0%{transform:scale(.94)}
  55%{transform:scale(1.06)}
  100%{transform:scale(1)}
}
.result-card.success-pulse .res-margin{
  animation:marginPop .8s cubic-bezier(.34,1.56,.64,1) .1s both
}
@keyframes marginPop{
  0%{transform:scale(.85);opacity:0}
  60%{transform:scale(1.05);opacity:1}
  100%{transform:scale(1);opacity:1}
}
/* sparkle */
.result-card.success-pulse .res-hero::before{
  content:"✦";position:absolute;top:14px;right:18px;z-index:2;
  font-size:1rem;color:var(--gold2);
  text-shadow:0 0 12px rgba(232,201,122,.6);
  animation:sparkleSpin 1.2s ease-out both;pointer-events:none
}
@keyframes sparkleSpin{
  0%{opacity:0;transform:scale(.3) rotate(0deg)}
  30%{opacity:1;transform:scale(1.2) rotate(180deg)}
  100%{opacity:0;transform:scale(1) rotate(360deg)}
}

/* ====== FILTER BAR (collapsible) ====== */
/* === ВКЛАДКА «ОТЧЁТЫ»: годовая сводка === */
.reports-hero{
  background:var(--glass);border:1px solid var(--edge);border-radius:14px;
  padding:1.15rem 1.15rem 1.25rem;margin-bottom:.75rem;
  backdrop-filter:blur(14px) saturate(1.2);
  -webkit-backdrop-filter:blur(14px) saturate(1.2);
  box-shadow:0 14px 38px rgba(0,0,0,.24)
}
.reports-filters{display:flex;flex-wrap:wrap;gap:1.1rem 2.2rem;margin-bottom:1.15rem}
.reports-filter-group{display:flex;flex-direction:column;gap:.5rem;min-width:0}
.reports-filter-label{font-family:var(--mono);font-size:.62rem;letter-spacing:.08em;
  text-transform:uppercase;color:var(--txt3)}
.reports-pills{display:flex;flex-wrap:wrap;gap:.4rem}
.reports-pill{
  all:unset;cursor:pointer;font-family:var(--sans);font-size:.8rem;font-weight:600;
  color:var(--txt2);padding:7px 14px;border-radius:100px;
  background:rgba(255,255,255,.035);border:1px solid var(--edge);
  transition:color .2s ease, background .2s ease, border-color .2s ease, box-shadow .2s ease;
  white-space:nowrap
}
.reports-pill:hover{color:var(--txt);border-color:rgba(201,168,76,.3);
  background:rgba(255,255,255,.06)}
.reports-pill:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(201,168,76,.4)}
.reports-pill.active{
  color:var(--void);background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  border-color:transparent;box-shadow:0 4px 14px rgba(201,168,76,.3)
}
.reports-empty{
  font-family:var(--sans);font-size:.9rem;color:var(--txt3);line-height:1.6;
  text-align:center;padding:2rem 1rem;border:1px dashed var(--edge);border-radius:12px;
  background:rgba(255,255,255,.02)
}
.reports-summary-grid{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.7rem
}
.reports-card{
  background:rgba(255,255,255,.025);border:1px solid var(--edge);border-radius:12px;
  padding:.85rem .95rem;display:flex;flex-direction:column;gap:.35rem;min-width:0;
  transition:border-color .2s ease, transform .2s ease
}
.reports-card:hover{border-color:rgba(201,168,76,.22);transform:translateY(-1px)}
.reports-card-label{font-family:var(--mono);font-size:.6rem;letter-spacing:.05em;
  text-transform:uppercase;color:var(--txt3);line-height:1.3}
.reports-card-value{font-family:var(--display);font-size:1.35rem;font-weight:600;
  color:var(--txt);letter-spacing:-.01em;line-height:1.1;word-break:break-word}
.reports-card.hero{
  grid-column:span 2;
  background:linear-gradient(135deg,rgba(201,168,76,.1) 0%,rgba(201,168,76,.02) 100%);
  border-color:rgba(201,168,76,.28)
}
.reports-card.hero .reports-card-value{font-size:1.7rem}
.reports-card.hero.pos .reports-card-value{color:var(--green)}
.reports-card.hero.neg .reports-card-value{color:var(--red)}
.reports-bestworst{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:.7rem}
.reports-bw-item{
  flex:1 1 200px;display:flex;flex-direction:column;gap:.22rem;
  padding:.75rem .9rem;border-radius:12px;border:1px solid var(--edge);
  background:rgba(255,255,255,.02)
}
.reports-bw-item.pos{border-color:rgba(46,204,138,.25)}
.reports-bw-item.neg{border-color:rgba(224,85,102,.22)}
.reports-bw-cap{font-family:var(--mono);font-size:.58rem;letter-spacing:.06em;
  text-transform:uppercase;color:var(--txt3)}
.reports-bw-month{font-family:var(--sans);font-size:.92rem;font-weight:600;color:var(--txt)}
.reports-bw-val{font-family:var(--display);font-size:1.05rem;font-weight:600}
.reports-bw-item.pos .reports-bw-val{color:var(--green)}
.reports-bw-item.neg .reports-bw-val{color:var(--red)}
.reports-chart{margin-top:1rem;border-top:1px solid var(--edge);padding-top:1rem}
.reports-chart-head{display:flex;align-items:baseline;justify-content:space-between;
  margin-bottom:.85rem}
.reports-chart-title{font-family:var(--sans);font-size:.82rem;font-weight:600;color:var(--txt)}
.reports-chart-sub{font-family:var(--mono);font-size:.62rem;letter-spacing:.05em;color:var(--txt3)}
.reports-bars{display:flex;align-items:flex-end;gap:.5rem;height:140px;
  overflow-x:auto;padding-bottom:.2rem}
.reports-bar-col{flex:1 1 0;min-width:26px;display:flex;flex-direction:column;
  align-items:center;gap:.45rem;height:100%}
.reports-bar-track{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
.reports-bar{width:62%;max-width:30px;min-height:3px;border-radius:6px 6px 3px 3px;
  transition:height .35s cubic-bezier(.16,1,.3,1)}
.reports-bar.pos{background:linear-gradient(180deg,var(--gold2) 0%,var(--gold) 100%);
  box-shadow:0 0 14px rgba(201,168,76,.25)}
.reports-bar.neg{background:linear-gradient(180deg,rgba(224,85,102,.85) 0%,rgba(224,85,102,.5) 100%)}
.reports-bar-label{font-family:var(--mono);font-size:.58rem;color:var(--txt3);
  white-space:nowrap;letter-spacing:.02em}
.reports-section-cap{
  font-family:var(--mono);font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;
  color:var(--txt3);margin:1.3rem 0 .6rem;padding-bottom:.45rem;
  border-bottom:1px solid var(--edge)
}
@media(max-width:640px){
  .reports-summary-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
  .reports-card-value{font-size:1.2rem}
  .reports-card.hero .reports-card-value{font-size:1.45rem}
  .reports-filters{gap:1rem 1.4rem}
  .reports-bars{height:120px}
}
/* === ВКЛАДКА «ОТЧЁТЫ»: финансовая таблица (fin-*) === */
.reports-summary{
  display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);
  /* stretch: обе карточки в одной grid-строке (desktop/tablet) выравниваются по
     высоте самой высокой — верх/низ совпадают, без фиксированной высоты и обрезки.
     На mobile (1 колонка, ниже) каждая карточка в своей строке → высота по контенту. */
  gap:.75rem;align-items:stretch
}
.fin-card,.fin-stats{
  background:rgba(255,255,255,.025);border:1px solid var(--edge);border-radius:12px;
  padding:1rem 1.1rem;min-width:0
}
/* «Финансовая сводка» чуть выше — визуальный баланс по высоте с блоком «Статистика».
   Только вертикальные отступы, scoped на .fin-card (блок «Статистика» .fin-stats не затронут);
   без height/min-height, без изменения ширины/сетки/JSX. */
.fin-card{padding-top:1.5rem;padding-bottom:1.5rem}
.fin-card .fin-row > th,
.fin-card .fin-val{padding-top:.54rem;padding-bottom:.54rem}
.fin-card-title{
  font-family:var(--mono);font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;
  color:var(--txt3);margin-bottom:.75rem
}
.fin-table{width:100%;border-collapse:collapse;font-family:var(--sans)}
.fin-table thead th{
  font-family:var(--mono);font-size:.55rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--txt3);font-weight:600;text-align:left;padding:0 0 .55rem;
  border-bottom:1px solid var(--edge)
}
.fin-table thead th:last-child{text-align:right}
.fin-row > th{
  font-family:var(--sans);font-size:.86rem;font-weight:500;color:var(--txt2);
  text-align:left;padding:.5rem 0;vertical-align:baseline
}
.fin-val{
  font-family:var(--display);font-size:.98rem;font-weight:600;color:var(--txt);
  text-align:right;padding:.5rem 0;white-space:nowrap;
  font-variant-numeric:tabular-nums;vertical-align:baseline
}
.fin-val.pos,.fin-val .pos{color:var(--green)}
.fin-val.neg,.fin-val .neg{color:var(--red)}
.fin-stat-sub{font-family:var(--sans);font-size:.8rem;font-weight:500;color:var(--txt3)}
.fin-stats .fin-val{white-space:normal}
.fin-stats .fin-val .pos,.fin-stats .fin-val .neg{white-space:nowrap}
/* Расширенный блок «Статистика»: разделители групп + текст/составные значения */
.fin-stats .fin-row--group > th,
.fin-stats .fin-row--group > .fin-val{border-top:1px solid var(--edge);padding-top:.62rem}
.fin-stats .fin-val--text{
  font-family:var(--sans);font-size:.82rem;font-weight:500;color:var(--txt2)
}
.fin-stats .fin-val--stacked{
  display:flex;flex-direction:column;align-items:flex-end;gap:.1rem;line-height:1.25
}
/* Подытог «Все расходы» */
.fin-row--subtotal > th{color:var(--txt);font-weight:600}
.fin-row--subtotal > th,.fin-row--subtotal > .fin-val{
  border-top:1px solid var(--edge);padding-top:.62rem
}
/* Чистая прибыль — главный визуальный акцент */
.fin-row--net > th{color:var(--txt);font-weight:700}
.fin-row--net > th,.fin-row--net > .fin-val{
  border-top:1px solid rgba(201,168,76,.32);padding-top:.72rem;
  background:rgba(201,168,76,.05)
}
.fin-row--net > .fin-val{font-size:1.5rem;letter-spacing:-.01em}
.fin-row--margin > th{color:var(--txt2)}
.fin-row--margin > .fin-val{font-size:1rem}
@media(max-width:760px){
  .reports-summary{grid-template-columns:1fr}
  .fin-row--net > .fin-val{font-size:1.3rem}
}
.filter-bar{
  background:var(--glass);border:1px solid var(--edge);border-radius:12px;
  margin-bottom:.55rem;overflow:hidden;
  backdrop-filter:blur(14px) saturate(1.2);
  -webkit-backdrop-filter:blur(14px) saturate(1.2);
  box-shadow:0 12px 32px rgba(0,0,0,.22);
  transition:border-color .25s ease, box-shadow .25s ease, background .25s ease
}
.filter-bar.filter-open{
  border-color:rgba(201,168,76,.28);
  background:rgba(255,255,255,.045);
  box-shadow:0 16px 42px rgba(0,0,0,.3), 0 0 36px rgba(201,168,76,.08)
}
.filter-toggle{
  all:unset;cursor:pointer;display:flex;align-items:center;
  gap:.8rem;width:100%;box-sizing:border-box;
  padding:.85rem 1.1rem;font-family:var(--sans);
  transition:background .2s ease
}
.filter-toggle:hover{background:rgba(255,255,255,.025)}
.filter-toggle:focus-visible{outline:none;box-shadow:inset 0 0 0 2px rgba(201,168,76,.35)}
.filter-toggle-ico{
  display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;border-radius:9px;flex-shrink:0;
  background:linear-gradient(135deg,rgba(201,168,76,.2) 0%,rgba(201,168,76,.05) 100%);
  border:1px solid rgba(201,168,76,.28);color:var(--gold2);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);
  transition:transform .25s ease, box-shadow .25s ease
}
.filter-toggle-ico svg{width:15px;height:15px;display:block}
.filter-bar.filter-open .filter-toggle-ico{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 0 18px rgba(201,168,76,.22);
  transform:rotate(-4deg)
}
.filter-toggle-label{font-family:var(--sans);font-size:.88rem;font-weight:600;color:var(--txt);
  flex-shrink:0;letter-spacing:.005em}
.filter-toggle-dot{
  width:6px;height:6px;border-radius:50%;background:var(--gold);
  box-shadow:0 0 8px var(--gold);flex-shrink:0;
  animation:filterToggleDot 2s ease-in-out infinite
}
@keyframes filterToggleDot{0%,100%{opacity:1}50%{opacity:.5}}
.filter-toggle-hint{
  font-family:var(--mono);font-size:.66rem;letter-spacing:.04em;
  color:var(--txt3);flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}

.filter-toggle-badges{
  display:inline-flex;align-items:center;gap:.45rem;flex:1;
  min-width:0;flex-wrap:wrap
}
.filter-bdg{
  display:inline-flex;align-items:center;gap:.42rem;
  font-family:var(--mono);font-size:.6rem;font-weight:500;
  letter-spacing:.04em;
  padding:5px 11px;border-radius:100px;
  background:rgba(255,255,255,.035);
  border:1px solid var(--edge);
  color:var(--txt2);
  transition:border-color .22s ease, background .22s ease,
    color .22s ease, box-shadow .22s ease;
  white-space:nowrap;flex-shrink:0
}
.filter-bdg-dot{
  width:5px;height:5px;border-radius:50%;
  background:var(--smoke);flex-shrink:0;
  transition:background .22s ease, box-shadow .22s ease
}
.filter-bdg-l{color:var(--txt3);font-weight:500;letter-spacing:.04em}
.filter-bdg-v{color:var(--txt);font-weight:600;letter-spacing:.02em}

.filter-bdg.active{
  background:var(--gold-bg);
  border-color:rgba(201,168,76,.32);
  color:var(--gold2);
  box-shadow:0 4px 14px rgba(201,168,76,.10)
}
.filter-bdg.active .filter-bdg-dot{
  background:var(--gold);
  box-shadow:0 0 8px rgba(201,168,76,.6)
}
.filter-bdg.active .filter-bdg-l{color:var(--gold2);opacity:.78}
.filter-bdg.active .filter-bdg-v{color:var(--gold3)}
.filter-toggle-chev{
  display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:8px;flex-shrink:0;
  border:1px solid var(--edge2);background:rgba(255,255,255,.03);
  color:var(--txt2);
  transition:transform .35s cubic-bezier(.22,1,.36,1),
    color .2s ease, border-color .2s ease, background .2s ease
}
.filter-toggle-chev svg{width:12px;height:12px;display:block}
.filter-bar.filter-open .filter-toggle-chev{
  transform:rotate(180deg);color:var(--gold2);
  border-color:rgba(201,168,76,.32);background:var(--gold-bg);
  box-shadow:0 0 14px rgba(201,168,76,.18)
}

.filter-panel-wrap{
  display:grid;grid-template-rows:0fr;
  transition:grid-template-rows .35s cubic-bezier(.22,1,.36,1)
}
.filter-bar.filter-open .filter-panel-wrap{grid-template-rows:1fr}
.filter-panel-inner{overflow:hidden;min-height:0}
.filter-panel{
  display:flex;align-items:center;gap:1.3rem;flex-wrap:wrap;
  padding:.5rem 1.1rem 1.05rem;
  border-top:1px solid rgba(255,255,255,.05)
}

.filter-group{display:flex;align-items:center;gap:.65rem;min-width:0}
.filter-label{font-family:var(--mono);font-size:.58rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.14em;color:var(--txt3);flex-shrink:0}
.filter-pills{display:inline-flex;gap:.32rem;flex-wrap:wrap}
.filter-pill{
  font-family:var(--sans);font-size:.78rem;font-weight:500;
  padding:7px 13px;border-radius:9px;cursor:pointer;
  background:transparent;border:1px solid var(--edge2);
  color:var(--txt2);transition:all .2s ease;
  -webkit-appearance:none;appearance:none
}
.filter-pill:hover{
  border-color:var(--smoke);color:var(--txt);
  background:rgba(255,255,255,.03);transform:translateY(-1px)
}
.filter-pill.active{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border-color:transparent;
  box-shadow:0 8px 22px rgba(201,168,76,.32),
    inset 0 1px 0 rgba(255,255,255,.22);
  font-weight:600
}
.filter-pill.active:hover{
  transform:translateY(-2px);
  box-shadow:0 12px 28px rgba(201,168,76,.42),
    inset 0 1px 0 rgba(255,255,255,.22)
}
.filter-divider{
  width:1px;height:24px;background:var(--edge);flex-shrink:0
}
@media(max-width:980px){
  .filter-divider{display:none}
  .filter-group{flex:1 1 auto;min-width:240px;flex-wrap:wrap}
}
@media(max-width:760px){
  .filter-toggle-badges{display:none}
  .filter-toggle-hint{font-size:.62rem}
}
@media(max-width:560px){
  .filter-toggle{padding:.8rem .95rem;gap:.6rem}
  .filter-toggle-hint{font-size:.6rem}
  .filter-toggle-label{font-size:.82rem}
  .filter-panel{flex-direction:column;align-items:stretch;gap:.9rem;padding:.5rem .95rem 1rem}
  .filter-group{flex-direction:column;align-items:flex-start;gap:.4rem}
  .filter-pills{width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:.35rem}
  .filter-pill{text-align:center;padding:8px 10px}
}
@media (prefers-reduced-motion: reduce){
  .filter-panel-wrap,
  .filter-toggle-chev,
  .filter-toggle-ico,
  .filter-toggle-dot{transition:none !important;animation:none !important}
}

.hist-tools{
  display:flex;align-items:center;gap:.7rem 1rem;flex-wrap:wrap;
  padding:.85rem 1.25rem;border-top:1px solid var(--edge)
}
.hist-search{position:relative;flex:1 1 240px;min-width:200px}
.hist-search-ic{
  position:absolute;left:12px;top:50%;transform:translateY(-50%);
  width:16px;height:16px;stroke:var(--txt3);stroke-width:2;fill:none;
  stroke-linecap:round;pointer-events:none
}
.hist-search-input{
  width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);
  border-radius:10px;padding:10px 36px;font-family:var(--sans);font-size:.86rem;
  color:var(--txt);transition:border-color .2s ease,box-shadow .2s ease;
  outline:none;-webkit-appearance:none;appearance:none
}
.hist-search-input::placeholder{color:var(--txt3)}
.hist-search-input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.hist-search-input:focus{
  border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.14)
}
.hist-search-clear{
  position:absolute;right:8px;top:50%;transform:translateY(-50%);
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;padding:0;font-size:1.2rem;line-height:1;
  color:var(--txt3);background:transparent;border:0;border-radius:6px;
  cursor:pointer;transition:color .18s ease,background .18s ease
}
.hist-search-clear:hover{color:var(--txt);background:rgba(255,255,255,.06)}
@media(max-width:760px){
  .hist-tools{flex-direction:column;align-items:stretch}
  .hist-search{flex-basis:auto;width:100%}
  .hist-search-input{font-size:16px}
  .hist-month,.hist-month-trigger{width:100%}
  .hist-month-menu{left:0;right:0}
}

/* ====== HISTORY MONTH DROPDOWN ====== */
.hist-month{position:relative;flex-shrink:0}
.hist-month-trigger{
  display:inline-flex;align-items:center;justify-content:space-between;gap:.5rem;
  min-width:132px;font-family:var(--sans);font-size:.78rem;font-weight:500;
  padding:7px 13px;border-radius:9px;cursor:pointer;
  background:transparent;border:1px solid var(--edge2);
  color:var(--txt2);transition:all .2s ease;
  -webkit-appearance:none;appearance:none
}
.hist-month-trigger:hover{
  border-color:var(--smoke);color:var(--txt);
  background:rgba(255,255,255,.03)
}
.hist-month-trigger.active{
  border-color:var(--gold);color:var(--gold2);
  background:rgba(201,168,76,.10);font-weight:600;
  box-shadow:inset 0 0 0 1px rgba(201,168,76,.18)
}
.hist-month-chev{
  width:13px;height:13px;flex-shrink:0;
  stroke:currentColor;stroke-width:2;fill:none;
  stroke-linecap:round;stroke-linejoin:round;
  transition:transform .2s ease
}
.hist-month-trigger[aria-expanded="true"] .hist-month-chev{transform:rotate(180deg)}
.hist-month-menu{
  position:absolute;top:calc(100% + 6px);right:0;z-index:40;
  min-width:180px;max-height:300px;overflow-y:auto;
  display:flex;flex-direction:column;gap:2px;
  padding:6px;border-radius:12px;
  background:var(--panel);border:1px solid var(--edge);
  box-shadow:0 18px 44px rgba(0,0,0,.55)
}
.hist-month-opt{
  text-align:left;white-space:nowrap;
  font-family:var(--sans);font-size:.8rem;font-weight:500;
  padding:8px 12px;border-radius:8px;cursor:pointer;
  background:transparent;border:1px solid transparent;
  color:var(--txt2);transition:background .15s ease,color .15s ease
}
.hist-month-opt:hover{background:rgba(255,255,255,.05);color:var(--txt)}
.hist-month-opt.active{
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);font-weight:600
}

/* ====== HISTORY CLEAR BUTTON (спокойный danger-outline) ====== */
.hist-clear{
  margin-left:auto;flex-shrink:0;
  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  font-family:var(--sans);font-size:.78rem;font-weight:500;
  padding:7px 13px;border-radius:9px;cursor:pointer;
  background:transparent;border:1px solid var(--edge2);
  color:var(--txt3);transition:all .2s ease;
  -webkit-appearance:none;appearance:none
}
.hist-clear:hover{
  border-color:rgba(224,85,102,.45);color:var(--red);
  background:rgba(224,85,102,.08)
}
.hist-clear-ic{
  width:14px;height:14px;flex-shrink:0;
  stroke:currentColor;stroke-width:2;fill:none;
  stroke-linecap:round;stroke-linejoin:round
}

.hist-filter-empty{
  padding:2.4rem 1.5rem;text-align:center;
  font-family:var(--mono);font-size:.78rem;letter-spacing:.04em;
  color:var(--txt3);
  background:rgba(255,255,255,.015);
  border-top:1px solid var(--edge)
}

/* ====== HISTORY ITEM REMOVE ANIMATION ====== */
.hist-item{transition:opacity .28s ease, transform .28s ease, filter .28s ease}
.hist-item.hist-removing{
  opacity:0;
  transform:translateX(28px) scale(.97);
  filter:blur(1.5px);
  pointer-events:none
}
.hist-del:disabled{cursor:wait;opacity:.7}
.hist-del:disabled:hover{background:rgba(255,255,255,.04) !important;
  border-color:rgba(255,255,255,.14) !important;color:#cbd5e1 !important;transform:none !important}
.hist-del-spin{display:inline-block;width:11px;height:11px;border-radius:50%;
  border:1.6px solid rgba(224,85,102,.25);border-top-color:#FF8A98;
  animation:histDelSpin .7s linear infinite}
@keyframes histDelSpin{to{transform:rotate(360deg)}}

/* ====== TOAST ====== */
.mp-toast{
  position:fixed;bottom:24px;right:24px;z-index:300;
  background:rgba(8,10,20,.85);
  backdrop-filter:blur(16px) saturate(1.3);
  -webkit-backdrop-filter:blur(16px) saturate(1.3);
  border:1px solid var(--edge2);border-radius:12px;
  padding:.85rem 1.1rem;font-family:var(--sans);font-size:.85rem;font-weight:500;
  color:var(--txt);box-shadow:0 22px 60px rgba(0,0,0,.5);
  display:inline-flex;align-items:center;gap:.7rem;max-width:360px;
  animation:toastIn .3s cubic-bezier(.22,1,.36,1) both
}
@keyframes toastIn{
  from{opacity:0;transform:translate(20px,4px) scale(.96)}
  to{opacity:1;transform:translate(0,0) scale(1)}
}
.mp-toast-ok{
  border-color:rgba(46,204,138,.42);
  color:#9bf0c4;
  box-shadow:0 22px 60px rgba(0,0,0,.5), 0 0 36px rgba(46,204,138,.15)
}
.mp-toast-warn{
  border-color:rgba(201,168,76,.42);
  color:#F5DFA0;
  box-shadow:0 22px 60px rgba(0,0,0,.5), 0 0 36px rgba(201,168,76,.18)
}
.mp-toast-err{
  border-color:rgba(224,85,102,.42);
  color:#ff9aa6;
  box-shadow:0 22px 60px rgba(0,0,0,.5), 0 0 36px rgba(224,85,102,.15)
}
.mp-toast-ico{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}
.mp-toast-ico svg{width:18px;height:18px;display:block}
.mp-toast-text{flex:1;min-width:0;line-height:1.35}
@media(max-width:640px){
  .mp-toast{right:16px;left:16px;bottom:16px;max-width:none}
}

@media (prefers-reduced-motion: reduce){
  .ai-proc-progress-bar{width:100% !important}
  .ai-proc-overlay,
  .ai-proc-card,
  .ai-proc-border,
  .ai-proc-ico,
  .ai-proc-ico svg,
  .ai-proc-mark,
  .ai-proc-progress-bar,
  .ai-proc-progress::after,
  .calc-loading::after,
  .empty-bar,
  .api-empty-ico,
  .calc-loading-spin,
  .res-margin::after,
  .result-card.success-pulse,
  .result-card.success-pulse .res-hero-val,
  .result-card.success-pulse .res-margin,
  .result-card.success-pulse .res-hero::before,
  .mp-tab.act-ozon .mp-dot-ozon,
  .onboard-card,
  .mp-toast,
  .hist-del-spin{animation:none !important}
  .hist-item.hist-removing{transition:none}
}

.dash-wrap{max-width:1100px;margin:0 auto;padding:1.2rem 2rem 3.2rem}
.dash-h1{font-family:var(--display);font-size:clamp(1.45rem,2.3vw,1.85rem);font-weight:700;letter-spacing:-.02em;margin:0 0 .25rem}
.dash-h1 em{font-style:italic;color:var(--gold)}
.dash-lead{color:var(--txt2);font-size:.84rem;font-weight:300;margin-bottom:.85rem}

.dash-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:.7rem;align-items:start;margin-top:.3rem}
.dash-right-col{display:flex;flex-direction:column;gap:.7rem;min-width:0}
/* Ручной калькулятор: правая колонка динамически растягивается до высоты «Параметров» (desktop) */
.mcalc-layout-grid{align-items:stretch}
.mcalc-layout-grid .result-card{flex:1 1 auto}

/* ====== QUICK SUMMARY (правая колонка под Результатом) ====== */
.quick-summary{
  background:rgba(255,255,255,.032);
  border:1px solid rgba(201,168,76,.25);
  border-radius:13px;
  padding:.85rem 1.05rem .7rem;
  backdrop-filter:blur(10px) saturate(1.2);
  -webkit-backdrop-filter:blur(10px) saturate(1.2);
  box-shadow:0 12px 28px rgba(0,0,0,.22), 0 0 26px rgba(201,168,76,.06)
}
.quick-summary-head{
  display:flex;align-items:center;justify-content:space-between;gap:.5rem;
  margin-bottom:.6rem
}
.quick-summary-title{
  font-family:var(--mono);font-size:.58rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.14em;color:var(--txt3)
}
.quick-summary-status{
  font-family:var(--mono);font-size:.53rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.10em;
  padding:3px 9px;border-radius:100px;border:1px solid;line-height:1
}
.quick-summary-status.ok{
  color:#7DEAB2;border-color:rgba(46,204,138,.32);background:rgba(46,204,138,.08)
}
.quick-summary-status.bad{
  color:#FF8A98;border-color:rgba(224,85,102,.32);background:rgba(224,85,102,.08)
}
.quick-summary-body{display:flex;flex-direction:column}
.quick-summary-row{
  display:flex;align-items:baseline;justify-content:space-between;gap:.7rem;
  padding:.4rem 0;border-bottom:1px solid rgba(255,255,255,.04)
}
.quick-summary-row:last-child{border-bottom:none}
.quick-summary-label{
  font-family:var(--sans);font-size:.78rem;color:var(--txt2);font-weight:300
}
.quick-summary-value{
  font-family:var(--display);font-size:1.02rem;font-weight:700;
  color:var(--txt);letter-spacing:-.022em;line-height:1
}
.quick-summary-value.pos{color:#2ECC8A}
.quick-summary-value.neg{color:#E05566}
.quick-summary-value.muted{color:var(--txt3);font-weight:400}
.quick-summary-foot{
  margin-top:.55rem;font-family:var(--mono);font-size:.54rem;
  letter-spacing:.08em;color:var(--txt3);text-transform:uppercase
}

.card{background:var(--glass);border:1px solid var(--edge);border-radius:14px;
  backdrop-filter:blur(10px);box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;
  padding:1.1rem 1.5rem;border-bottom:1px solid var(--edge)}
.card-title{font-family:var(--display);font-size:.95rem;font-weight:700;color:var(--txt)}
.card-body{padding:1.5rem}

.mp-row{display:flex;gap:8px;margin-bottom:1.5rem}
.mp-tab{flex:1;font-family:var(--sans);font-size:.85rem;font-weight:600;padding:11px;border-radius:9px;
  cursor:pointer;letter-spacing:.02em;border:1px solid var(--edge2);background:transparent;
  color:var(--txt2);transition:all .18s;text-align:center}
.mp-tab:hover{border-color:var(--smoke);color:var(--txt)}
.mp-tab.act-ozon{border-color:#3d7bff;color:#7fb0ff;background:rgba(61,123,255,.1)}

.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.fld{display:flex;flex-direction:column;gap:5px}
.fld label{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3)}
.fld .rev-badge{color:var(--gold)}
.in-wrap{position:relative;display:flex;align-items:center}
.in-wrap input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);border-radius:8px;
  color:var(--txt);font-family:var(--mono);font-size:.92rem;padding:11px 32px 11px 12px;outline:none;transition:border .18s}
.in-wrap input:focus{border-color:var(--gold)}
.in-wrap input::placeholder{color:var(--txt3)}
.in-cur{position:absolute;right:12px;font-family:var(--mono);font-size:.8rem;color:var(--txt3);pointer-events:none}
.fld-hint{font-size:.62rem;color:var(--txt3);font-weight:300}

.btn-row{display:flex;gap:10px;margin-top:1.5rem}
.btn-gold{flex:1;font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:13px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.btn-gold:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.btn-ghost{font-family:var(--sans);font-size:.85rem;font-weight:500;background:transparent;
  border:1px solid var(--edge2);color:var(--txt2);padding:13px 20px;border-radius:9px;cursor:pointer;transition:all .18s}
.btn-ghost:hover{border-color:var(--gold);color:var(--gold2)}

/* ====== MANUAL CALC — premium redesign (UI-only) ====== */
/* верхняя информационная карточка (переиспользует премиальный .onboard-card) */
.mcalc-info{flex-direction:column;align-items:stretch;justify-content:flex-start;gap:.85rem}
.mcalc-head{margin:0}
.mcalc-title{font-family:var(--display);font-size:1.55rem;font-weight:700;
  letter-spacing:-.01em;color:var(--txt);margin:0 0 .45rem}
.mcalc-sub{font-family:var(--sans);font-size:.9rem;font-weight:300;line-height:1.55;
  color:var(--txt2);margin:0;max-width:54ch}
/* заголовок левой карточки «Параметры расчёта» */
.mcalc-params-head{font-family:var(--display);font-size:1.15rem;font-weight:700;
  letter-spacing:-.01em;color:var(--txt);margin:0 0 1.3rem}

/* компактный переключатель маркетплейса (пилюли) */
.mcalc-mp{margin-bottom:1.5rem;gap:8px;flex-wrap:wrap}
.mcalc-mp .mp-tab{flex:0 1 auto;padding:8px 18px;font-size:.8rem;border-radius:100px}

/* логические группы Доход / Расходы */
.mcalc-group{margin-bottom:1.4rem}
.mcalc-group:last-of-type{margin-bottom:0}
.mcalc-group-label{display:flex;align-items:center;gap:.55rem;
  font-family:var(--mono);font-size:.62rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.16em;color:var(--txt2);margin:0 0 .8rem;
  padding-bottom:.6rem;border-bottom:1px solid var(--edge)}
.mcalc-group-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.mcalc-group-dot.income{background:var(--green);box-shadow:0 0 10px rgba(46,204,138,.5)}
.mcalc-group-dot.expense{background:var(--gold);box-shadow:0 0 10px rgba(201,168,76,.5)}

/* ровная сетка полей одинаковой ширины */
.mcalc-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.mcalc-grid.income{grid-template-columns:1fr}
.mcalc-grid .fld label{font-size:.64rem;letter-spacing:.09em;color:var(--txt2)}
.mcalc-grid .in-wrap input{padding:13px 34px 13px 14px;font-size:.95rem;border-radius:10px}

/* действия: большая кнопка-акцент + «Очистить форму» в одну строку (desktop) */
.mcalc-actions{flex-direction:row;align-items:stretch;gap:.7rem;margin-top:1.7rem}
.mcalc-actions .mcalc-calc{flex:2 1 0;min-width:0;padding:16px;font-size:1rem;border-radius:12px;
  box-shadow:0 12px 34px rgba(201,168,76,.34)}
.mcalc-actions .mcalc-calc:hover{box-shadow:0 18px 46px rgba(201,168,76,.44)}
.mcalc-actions .mcalc-clear{flex:1 1 0;min-width:0;padding:12px 16px;border-radius:11px;white-space:nowrap}

@media(max-width:560px){
  .mcalc-title{font-size:1.3rem}
  .mcalc-grid{grid-template-columns:1fr}
  .mcalc-actions{flex-direction:column}
  .mcalc-actions .mcalc-calc,
  .mcalc-actions .mcalc-clear{flex:0 0 auto;width:100%}
}

/* view-only: компактный full-width пункт «Дополнительный доход» (компенсации Ozon) */
.api-additional-income{grid-column:1 / -1;display:flex;flex-direction:column;gap:6px;margin-top:.2rem}
.api-additional-income-label{display:flex;flex-direction:column;gap:1px;min-width:0}
.api-additional-income-label span{font-family:var(--mono);font-size:.6rem;font-weight:600;
  text-transform:uppercase;letter-spacing:.1em;color:var(--txt2);white-space:normal;overflow-wrap:anywhere}
.api-additional-income-label small{font-family:var(--sans);font-size:.66rem;font-weight:300;
  color:var(--txt3);line-height:1.35;white-space:normal;overflow-wrap:anywhere}
.api-additional-income-box{display:flex;align-items:center;justify-content:center;width:100%;
  background:rgba(255,255,255,.04);border:1px solid var(--edge2);border-radius:10px;
  padding:12px 14px;min-width:0}
.api-additional-income-value{font-family:var(--display);font-size:1.2rem;font-weight:700;
  letter-spacing:-.01em;color:var(--green);white-space:nowrap;text-align:center}
.api-additional-income-hint{font-size:.62rem;font-weight:300;color:var(--txt3);overflow-wrap:anywhere}

/* view-only: компактная двухстрочная подсказка режима просмотра */
.api-view-actions{align-items:center}
.api-view-actions .mcalc-clear{flex:0 0 auto}
.api-view-notice{flex:1 1 auto;min-width:0;display:flex;align-items:flex-start;gap:.6rem;
  padding:.7rem .9rem;border-radius:12px;
  background:linear-gradient(160deg,rgba(201,168,76,.07),rgba(13,16,32,.6));
  border:1px solid rgba(201,168,76,.2)}
.api-view-notice-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:.35rem;
  background:var(--gold);box-shadow:0 0 10px rgba(201,168,76,.5)}
.api-view-notice-body{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.api-view-notice-title{font-family:var(--sans);font-size:.82rem;font-weight:600;color:var(--txt)}
.api-view-notice-text{font-family:var(--sans);font-size:.76rem;font-weight:300;line-height:1.45;
  color:var(--txt2);white-space:normal;overflow-wrap:anywhere}
@media(max-width:560px){
  .api-view-actions{align-items:stretch}
}

.result-card{background:linear-gradient(135deg,var(--panel) 0%,rgba(201,168,76,.05) 100%);
  border:1px solid rgba(201,168,76,.3);border-radius:14px;overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 50px rgba(201,168,76,.06)}
.result-card .card-head{border-bottom-color:rgba(201,168,76,.18)}
.res-hero{padding:1.5rem;text-align:center;border-bottom:1px solid var(--edge)}
.res-hero-lbl{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);margin-bottom:.5rem}
.res-hero-val{font-family:var(--display);font-size:2.6rem;font-weight:700;letter-spacing:-.03em;line-height:1}
.res-hero-val.pos{color:var(--green)}
.res-hero-val.neg{color:var(--red)}
.res-margin{display:inline-block;margin-top:.7rem;font-family:var(--mono);font-size:.75rem;
  padding:4px 14px;border-radius:100px;border:1px solid}
.res-margin.pos{color:var(--green);border-color:rgba(46,204,138,.3);background:rgba(46,204,138,.08)}
.res-margin.neg{color:var(--red);border-color:rgba(224,85,102,.3);background:rgba(224,85,102,.08)}
.res-rows{padding:1.2rem 1.5rem}
.res-row{display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:.6rem 0;
  border-bottom:1px solid var(--edge);font-size:.85rem}
.res-row:last-child{border-bottom:none}
.res-row .rl{color:var(--txt2);min-width:0}
.res-row .rv{font-family:var(--mono);font-weight:500;color:var(--txt);flex-shrink:0;white-space:nowrap}
.res-row .rv.neg{color:var(--red)}
.res-row .rv.income{color:var(--green)}

.empty-res{padding:3rem 1.5rem;text-align:center;color:var(--txt3)}
.empty-icon{font-size:2rem;opacity:.4;margin-bottom:.7rem;display:block}
.empty-title{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt2);margin-bottom:.3rem}
.empty-sub{font-size:.8rem;font-weight:300}

.hist-card{margin-top:.65rem}
.hist-list{display:flex;flex-direction:column}
.hist-item{
  display:flex;
  flex-direction:column;
  align-items:stretch;
  padding:.85rem 1.5rem;
  border-bottom:1px solid var(--edge);
  cursor:pointer;
  transition:.2s ease;
}
.hist-row{display:flex;align-items:center;gap:1rem;width:100%}

.hist-item:hover{
  background:rgba(255,255,255,.03);
}
  .hist-item.active{
  background:rgba(255,255,255,.04);
  border-left:2px solid var(--accent);
}
.hist-item:last-child{border-bottom:none}
.hist-mp{font-family:var(--mono);font-size:.58rem;padding:3px 9px;border-radius:3px;border:1px solid;flex-shrink:0;letter-spacing:.06em}
.hist-mp.ozon{border-color:rgba(61,123,255,.35);color:#7fb0ff;background:rgba(61,123,255,.08)}
.hist-mp.wb{border-color:rgba(203,17,171,.35);color:#e878d6;background:rgba(203,17,171,.08)}
.hist-info{flex:1;min-width:0}
.hist-rev{font-size:.82rem;color:var(--txt);font-weight:600;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.hist-type-badge{display:inline-flex;align-items:center;padding:.14rem .5rem;border-radius:999px;font-family:var(--sans);font-size:.6rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--glass);border:1px solid var(--edge2);color:var(--txt2);white-space:nowrap;line-height:1.3;max-width:100%}
.hist-type-badge.hist-type-api{background:rgba(201,168,76,.12);border-color:rgba(201,168,76,.42);color:var(--gold2)}
.hist-type-badge.hist-type-upload{background:var(--glass2);border-color:var(--edge2);color:var(--txt)}
.hist-type-badge.hist-type-manual{background:rgba(255,255,255,.035);border-color:var(--edge);color:var(--txt2)}
.hist-period{font-family:var(--mono);font-size:.72rem;color:var(--gold2);font-weight:600;margin-top:3px;letter-spacing:.01em}
.hist-revenue{font-size:.7rem;color:var(--txt2);font-weight:400;margin-top:3px}
.hist-date{font-family:var(--mono);font-size:.62rem;color:var(--txt3);margin-top:1px}
.hist-profit{font-family:var(--display);font-size:1.05rem;font-weight:700;letter-spacing:-.02em;flex-shrink:0;text-align:right;max-width:46%}
.hist-profit.pos{color:var(--green)}
.hist-profit.neg{color:var(--red)}
.hist-profit-label{display:block;font-family:var(--mono);font-size:.56rem;font-weight:400;color:var(--txt2);letter-spacing:.03em;margin-bottom:2px;white-space:normal;line-height:1.25}
.hist-profit-num{display:block;white-space:nowrap}
.hist-profit .hm{display:block;font-family:var(--mono);font-size:.6rem;font-weight:400;color:var(--txt3);letter-spacing:.04em;margin-top:1px}
.hist-del{flex-shrink:0;width:28px;height:28px;border-radius:8px;border:1px solid var(--edge2);
  background:transparent;color:var(--txt3);font-size:1.05rem;line-height:1;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;transition:all .18s;padding:0}
.hist-del:hover{border-color:rgba(224,85,102,.4);color:var(--red);background:rgba(224,85,102,.08)}
/* Кнопка раскрытия мини-разбивки + сама разбивка */
.hist-toggle{flex-shrink:0;width:28px;height:28px;border-radius:8px;border:1px solid var(--edge2);
  background:transparent;color:var(--txt3);cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;transition:all .18s;padding:0}
.hist-toggle:hover,.hist-toggle.open{border-color:rgba(201,168,76,.45);color:var(--gold2);background:rgba(201,168,76,.08)}
.hist-toggle svg{transition:transform .2s ease}
.hist-toggle.open svg{transform:rotate(180deg)}
.hist-details{cursor:default;margin-top:.7rem;padding:.7rem .85rem;border-radius:10px;
  background:rgba(255,255,255,.022);border:1px solid rgba(255,255,255,.07);
  display:flex;flex-direction:column;gap:1px}
.hd-row{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;
  font-size:.78rem;padding:3px 0;color:var(--txt2)}
.hd-label{min-width:0;font-weight:400}
.hd-val{font-family:var(--mono);font-size:.78rem;font-weight:600;color:var(--txt2);
  font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0}
.hd-income .hd-val{color:#7be8b2}
.hd-expense .hd-val{color:#e89a99}
.hd-neutral .hd-val{color:var(--txt3)}
.hd-subtotal{border-top:1px dashed rgba(255,255,255,.1);margin-top:3px;padding-top:6px}
.hd-subtotal .hd-label{color:var(--txt);font-weight:600}
.hd-subtotal .hd-val{color:var(--txt)}
.hd-total{border-top:1px solid rgba(201,168,76,.3);margin-top:5px;padding-top:8px}
.hd-total .hd-label{color:var(--txt);font-weight:700;font-size:.82rem}
.hd-total .hd-val{color:var(--gold2);font-weight:700;font-size:.9rem}
@media(max-width:560px){
  .hist-item{padding:.8rem 1rem}
  .hist-row{gap:.6rem}
  .hist-profit{font-size:.95rem;max-width:42%}
  .hist-profit-label{font-size:.54rem}
  .hist-period{font-size:.68rem}
  .hist-details{padding:.6rem .7rem}
  .hd-row{font-size:.75rem}
  .hd-val{font-size:.75rem}
}
.stats-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:.55rem;
  margin-bottom:.65rem;
}

.stat-card{
  background:var(--glass);
  border:1px solid var(--edge);
  border-radius:12px;
  padding:.75rem .9rem .8rem;
  backdrop-filter:blur(10px);
  box-shadow:0 8px 22px rgba(0,0,0,.20);
}

.stat-label{
  font-family:var(--mono);
  font-size:.58rem;
  text-transform:uppercase;
  letter-spacing:.10em;
  color:var(--txt3);
  margin-bottom:.4rem;
}

.stat-value{
  font-family:var(--display);
  font-size:1.2rem;
  font-weight:700;
  letter-spacing:-.025em;
  color:var(--txt);
  line-height:1;
}

.stat-value.pos{
  color:var(--green);
}

.stat-value.neg{
  color:var(--red);
}
@media(max-width:900px){
  .dash-top-inner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:.7rem 1.2rem;gap:.55rem .8rem}
  .dash-status{font-size:.6rem;padding:5px 12px}
  .dash-wrap{padding:1.5rem 1.2rem 4rem}
  .dash-grid{grid-template-columns:1fr}
  .mcalc-layout-grid{align-items:start}
  .mcalc-layout-grid .result-card{flex:none}
  .dash-user-email{display:none}
}
@media(max-width:480px){
  .form-grid{grid-template-columns:1fr}
  .btn-row{flex-direction:column}
  .res-hero-val{font-size:2.1rem}
}
/* MOBILE A11Y (≤640px): 16px-инпуты против iOS-зума + зоны нажатия ≥44×44px. */
@media(max-width:640px){
  .auth-input,.api-input,.in-wrap input{font-size:16px}
  .dash-signout{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 16px}
  .api-eye{width:44px;height:44px}
  .api-secret .api-input{padding-right:56px}
  .tariff-status-x{width:44px;height:44px}
  .upload-slot-remove{width:44px;height:44px}
  .onboard-close{width:44px;height:44px}
}

/* ── PR #25: модалка-предупреждение о дубле расчёта за месяц ─────────────── */
.dg-overlay{
  position:fixed;inset:0;z-index:1100;
  background:rgba(4,6,14,.78);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  display:flex;align-items:center;justify-content:center;
  padding:1.5rem;animation:dgFade .24s ease both;
  font-family:'Outfit',sans-serif;color:#E8EEF8
}
@keyframes dgFade{from{opacity:0}to{opacity:1}}
.dg-card{
  position:relative;max-width:480px;width:100%;
  background:linear-gradient(160deg,
    rgba(201,168,76,.10) 0%, rgba(13,16,32,.96) 70%);
  border:1px solid rgba(201,168,76,.32);
  border-radius:20px;padding:2.2rem 2rem 1.8rem;
  backdrop-filter:blur(22px) saturate(1.3);
  -webkit-backdrop-filter:blur(22px) saturate(1.3);
  box-shadow:0 32px 90px rgba(0,0,0,.6),0 0 90px rgba(201,168,76,.14);
  animation:dgSlide .32s cubic-bezier(.22,1,.36,1) both
}
@keyframes dgSlide{
  from{opacity:0;transform:translateY(12px) scale(.97)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
.dg-ico{
  width:44px;height:44px;border-radius:13px;
  display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,
    rgba(201,168,76,.26),rgba(201,168,76,.06));
  border:1px solid rgba(201,168,76,.32);
  color:#E8C97A;margin-bottom:1rem
}
.dg-ico svg{width:22px;height:22px;display:block}
.dg-title{
  font-family:'Playfair Display',Georgia,serif;
  font-size:1.4rem;font-weight:700;color:#E8EEF8;
  letter-spacing:-.01em;line-height:1.22;margin:0 0 .65rem
}
.dg-text{
  font-size:.94rem;color:#B9C6DA;font-weight:300;
  line-height:1.55;margin:0 0 1.15rem
}
.dg-text b{color:#E8EEF8;font-weight:600}
.dg-found{
  border:1px solid rgba(255,255,255,.10);border-radius:13px;
  background:rgba(255,255,255,.03);padding:.85rem 1rem;
  display:flex;flex-direction:column;gap:.5rem;margin-bottom:1.4rem
}
.dg-row{
  display:flex;align-items:baseline;justify-content:space-between;gap:1rem
}
.dg-k{
  font-size:.78rem;color:#8A9FBB;font-weight:400;letter-spacing:.02em
}
.dg-v{
  font-size:.9rem;color:#E8EEF8;font-weight:500;text-align:right
}
.dg-v.prof{
  font-family:'Playfair Display',Georgia,serif;
  font-weight:700;font-size:1.02rem
}
.dg-actions{display:flex;gap:.7rem;flex-wrap:wrap}
.dg-btn{
  flex:1;min-width:150px;font-family:'Outfit',sans-serif;
  font-size:.9rem;font-weight:600;padding:12px 20px;border-radius:11px;
  cursor:pointer;border:none;-webkit-appearance:none;appearance:none;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  transition:transform .2s ease,box-shadow .2s ease,background .2s ease,
    color .2s ease,border-color .2s ease
}
.dg-btn-ghost{
  background:rgba(255,255,255,.04);color:#E8EEF8;
  border:1px solid rgba(255,255,255,.14)
}
.dg-btn-ghost:hover{
  border-color:#C9A84C;color:#E8C97A;
  background:rgba(201,168,76,.08);transform:translateY(-1px)
}
.dg-btn-gold{
  background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
  color:#05070f;box-shadow:0 10px 28px rgba(201,168,76,.30)
}
.dg-btn-gold:hover{
  transform:translateY(-2px) scale(1.02);
  box-shadow:0 18px 44px rgba(201,168,76,.48),
    0 0 28px rgba(201,168,76,.2)
}
@media(max-width:640px){
  .dg-card{padding:1.7rem 1.3rem 1.4rem;border-radius:16px}
  .dg-title{font-size:1.2rem}
  .dg-actions{flex-direction:column}
  .dg-btn{width:100%;min-width:0}
}
@media (prefers-reduced-motion: reduce){
  .dg-overlay,.dg-card{
    animation:none !important;transform:none !important;opacity:1 !important
  }
}

/* PR #26 — вкладка «Личный кабинет» (.cab-*) */
.cab-wrap{margin-top:1.4rem}
.cab-head{margin-bottom:1.4rem}
.cab-h{font-family:var(--display);font-size:1.5rem;font-weight:600;letter-spacing:-.01em;color:var(--txt);margin:0}
.cab-sub{margin:.4rem 0 0;font-size:.92rem;color:var(--txt2);line-height:1.5}
.cab-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.1rem}
.cab-card{background:var(--glass);border:1px solid var(--edge);border-radius:18px;padding:1.5rem 1.5rem 1.4rem;display:flex;flex-direction:column}
.cab-card-wide{grid-column:1 / -1}
.cab-card-head{display:flex;align-items:center;gap:.7rem;margin-bottom:1.1rem}
.cab-card-ico{flex-shrink:0;width:38px;height:38px;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;background:var(--gold-bg);border:1px solid rgba(201,168,76,.28);color:var(--gold2)}
.cab-card-ico svg{width:20px;height:20px;display:block}
.cab-card-title{font-family:var(--display);font-size:1.06rem;font-weight:600;color:var(--txt)}
.cab-rows{display:flex;flex-direction:column}
.cab-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.62rem 0;border-bottom:1px solid var(--edge)}
.cab-row:last-child{border-bottom:none}
.cab-k{font-size:.85rem;color:var(--txt3);flex-shrink:0}
.cab-v{font-size:.9rem;color:var(--txt);font-weight:500;text-align:right;word-break:break-word;min-width:0}
.cab-muted{font-size:.86rem;color:var(--txt2);line-height:1.55;margin:0}
.cab-badge{display:inline-flex;align-items:center;padding:.18rem .6rem;border-radius:999px;font-size:.72rem;font-weight:600;letter-spacing:.02em;background:rgba(255,255,255,.06);border:1px solid var(--edge2);color:var(--txt2)}
.cab-badge.ok{background:rgba(46,204,138,.1);border-color:rgba(46,204,138,.34);color:var(--green)}
.cab-tariff-status{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap}
.cab-tariff-name{font-family:var(--display);font-size:1.05rem;font-weight:600;color:var(--gold2)}
.cab-tariff-actions{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-top:1.2rem}
.cab-quick{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem}
.cab-quick .api-pro-btn{width:100%}
@media(max-width:760px){
  .cab-grid{grid-template-columns:1fr}
  .cab-tariff-actions{grid-template-columns:1fr}
  .cab-quick{grid-template-columns:1fr}
  .cab-h{font-size:1.3rem}
}

/* PR #26 — пустой статус Ozon в шаге 1 «Расчёта» (форма подключения переехала в кабинет) */
.api-conn-empty{display:flex;flex-direction:column;gap:.7rem}
.api-conn-empty-row{display:flex;align-items:center;gap:.55rem;font-weight:600;color:var(--txt)}
.api-conn-empty-dot{width:9px;height:9px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.16);flex-shrink:0}

/* ===== Пояснения о режимах расчёта (info-блоки + FAQ + предупреждение) =====
   Только UI/текст: помогают понять, почему «Загрузка отчёта» и «Авторасчёт
   через API» могут давать разные значения. Формулы/расчёты не затрагивают. */
.mode-note{margin-top:1rem;padding:.95rem 1.1rem;border:1px solid var(--edge2);
  border-left:3px solid var(--gold);border-radius:12px;background:var(--glass);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.mode-note-title{font-family:var(--display);font-size:.95rem;font-weight:600;
  color:var(--gold2);margin:0 0 .35rem;letter-spacing:.01em}
.mode-note-text{font-family:var(--sans);font-size:.84rem;line-height:1.55;
  color:var(--txt2);margin:0}
.mode-note-sub{display:block;margin-top:.5rem;font-size:.76rem;line-height:1.5;
  color:var(--txt3)}
.faq-disc{margin:1.4rem 0 .4rem;border:1px solid var(--edge2);border-radius:12px;
  background:var(--glass);overflow:hidden}
.faq-disc>summary{list-style:none;cursor:pointer;padding:.95rem 1.1rem;
  font-family:var(--sans);font-size:.88rem;font-weight:600;color:var(--txt);
  display:flex;align-items:center;gap:.6rem}
.faq-disc>summary::-webkit-details-marker{display:none}
.faq-disc>summary::before{content:"";width:7px;height:7px;
  border-right:2px solid var(--gold);border-bottom:2px solid var(--gold);
  transform:rotate(-45deg);transition:transform .2s ease;flex:0 0 auto}
.faq-disc[open]>summary::before{transform:rotate(45deg)}
.faq-disc-body{padding:0 1.1rem 1.05rem;font-family:var(--sans);font-size:.83rem;
  line-height:1.6;color:var(--txt2)}
.reports-warn{margin:.2rem 0 1.15rem;padding:.8rem 1rem;
  border:1px solid rgba(201,168,76,.28);border-radius:11px;
  background:rgba(201,168,76,.07);font-family:var(--sans);font-size:.8rem;
  line-height:1.5;color:var(--txt2);display:flex;gap:.6rem;align-items:flex-start}
.reports-warn-ico{flex:0 0 auto;color:var(--gold);margin-top:.05rem}
      `}</style>

      <div className="dash-top">
        <div className="dash-top-inner">
        <a href="/" className="dash-brand">
          M&#8209;<em>Prof</em>
        </a>

        {user && (
          <div className="dash-nav" role="tablist" aria-label="Разделы">
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "calc"}
              className={"main-tab" + (mainTab === "calc" ? " active" : "")}
              onClick={() => setMainTab("calc")}
            >
              <span className="main-tab-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2.5" />
                  <path d="M8 7h8M8 11h8M8 15h5" />
                </svg>
              </span>
              Расчёт
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "catalog"}
              className={"main-tab" + (mainTab === "catalog" ? " active" : "")}
              onClick={() => setMainTab("catalog")}
            >
              <span className="main-tab-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7l9-4 9 4-9 4-9-4z" />
                  <path d="M3 7v10l9 4 9-4V7" />
                  <path d="M12 11v10" />
                </svg>
              </span>
              Каталог товаров
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "reports"}
              className={"main-tab" + (mainTab === "reports" ? " active" : "")}
              onClick={() => setMainTab("reports")}
            >
              <span className="main-tab-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4v16h16" />
                  <path d="M9 16v-4" />
                  <path d="M13.5 16V9" />
                  <path d="M18 16v-7" />
                </svg>
              </span>
              Отчёты
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "cabinet"}
              className={"main-tab" + (mainTab === "cabinet" ? " active" : "")}
              onClick={() => setMainTab("cabinet")}
            >
              <span className="main-tab-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="3.4" />
                  <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
                </svg>
              </span>
              Личный кабинет
            </button>
          </div>
        )}

        {user ? (
          <div className="dash-user">
            <span className="dash-user-email">{user.email}</span>
            <button
              type="button"
              className="dash-signout"
              onClick={signOut}
              disabled={signingOut}
              aria-busy={signingOut}
            >
              {signingOut ? "Выходим…" : "Выйти"}
            </button>
          </div>
        ) : (
          <div className="dash-status">
            <span className="status-dot"></span>
            Первый расчёт бесплатно
          </div>
        )}
        </div>
      </div>

      <div className="dash-wrap">
        {authLoading && (
          <div className="auth-loading" role="status" aria-live="polite">
            <span className="auth-loading-ring" aria-hidden="true" />
            <span>Проверяем сессию…</span>
          </div>
        )}
        {!authLoading && !user && (
          <div className="card auth-card">
            <h3 className="auth-title">Вход в аккаунт</h3>

            <div className="auth-fields">
              <input
                className="auth-input"
                type="email"
                placeholder="Ваш email"
                autoComplete="email"
                value={email}
                disabled={signingIn || signingUp}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // Сменили email — возможно, другой аккаунт: сбрасываем счётчик
                  // неудачных попыток (кнопка восстановления снова прячется).
                  if (failedAttempts !== 0) setFailedAttempts(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") signIn();
                }}
              />
              <div className="auth-pass-wrap">
                <input
                  className="auth-input"
                  type={showPassword ? "text" : "password"}
                  placeholder="Пароль"
                  autoComplete="current-password"
                  value={password}
                  disabled={signingIn || signingUp}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") signIn();
                  }}
                />
                <button
                  type="button"
                  className="auth-eye"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  aria-pressed={showPassword}
                  title={showPassword ? "Скрыть" : "Показать"}
                >
                  {showPassword ? eyeOffIcon : eyeIcon}
                </button>
              </div>
            </div>

            <div className="auth-actions">
              <button
                type="button"
                className="auth-btn"
                onClick={signIn}
                disabled={signingIn || signingUp}
                aria-busy={signingIn}
              >
                {signingIn ? "Входим…" : "Войти"}
              </button>
              <button
                type="button"
                className="auth-btn auth-btn-2"
                onClick={signUp}
                disabled={signingIn || signingUp}
                aria-busy={signingUp}
              >
                {signingUp ? "Создаём…" : "Создать аккаунт"}
              </button>
            </div>

            <p className="auth-hint">
              Пароль — минимум 6 символов. Нет аккаунта? Нажмите «Создать
              аккаунт».
            </p>
            <p className="auth-hint">
              Email нужен только для входа, восстановления доступа и привязки
              оплаты. Рассылок не будет.
            </p>

            {/* Кнопка восстановления появляется только после 3 неудачных входов —
               чтобы не отвлекать обычного пользователя и не плодить спам. */}
            {failedAttempts >= 3 && (
              <div className="auth-reset">
                <p className="auth-reset-q">Не получается войти?</p>
                <button
                  type="button"
                  className="auth-reset-btn"
                  onClick={requestPasswordReset}
                  disabled={resetSending || resetCooldown > 0}
                  aria-busy={resetSending}
                >
                  {resetSending
                    ? "Отправляем…"
                    : resetCooldown > 0
                    ? `Отправить повторно через ${resetCooldown} с`
                    : "Забыли пароль? Восстановить пароль"}
                </button>
              </div>
            )}

            {authMessage && <p className="auth-msg">{authMessage}</p>}
          </div>
        )}

        {(mainTab === "calc" || !user) && (
          <>
        <h1 className="dash-h1">
          Новый <em>расчёт</em>
        </h1>
        <p className="dash-lead">
          Введите данные по товару или периоду — посчитаем чистую прибыль и маржинальность.
        </p>
          </>
        )}

        {user && mainTab === "reports" && (
          <>
        <h1 className="dash-h1">
          Ваши <em>отчёты</em>
        </h1>
        <p className="dash-lead">
          История расчётов и годовая сводка по прибыли, выручке и расходам.
          Считаем по сохранённым расчётам — без выдуманных данных.
        </p>

        <div className="reports-warn" role="note">
          <svg
            className="reports-warn-ico"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16.5v.5" />
          </svg>
          <span>
            Если за один месяц есть несколько расчётов разными способами,
            итоговая аналитика может суммировать их. Для финальной сверки
            используйте один основной расчёт за месяц. API и документы могут
            отличаться из-за разных источников данных — для автоматического
            расчёта ориентируйтесь на API.
          </span>
        </div>

        {/* ===== Годовая сводка (новый блок вкладки «Отчёты») ===== */}
        <div className="reports-hero">
          <div className="reports-filters" role="region" aria-label="Фильтры отчётов">
            <div className="reports-filter-group">
              <div className="reports-filter-label">Год</div>
              <div className="reports-pills">
                <button
                  type="button"
                  className={"reports-pill" + (reportsYear === "all" ? " active" : "")}
                  onClick={() => setReportsYear("all")}
                  aria-pressed={reportsYear === "all"}
                >
                  Всё время
                </button>
                {reportsYears.map((y) => (
                  <button
                    type="button"
                    key={y}
                    className={"reports-pill" + (reportsYear === y ? " active" : "")}
                    onClick={() => setReportsYear(y)}
                    aria-pressed={reportsYear === y}
                  >
                    {y}
                  </button>
                ))}
              </div>
            </div>
            <div className="reports-filter-group">
              <div className="reports-filter-label">Тип расчёта</div>
              <div className="reports-pills">
                {(
                  [
                    ["all", "Все"],
                    ["api", "API"],
                    ["upload", "Документы"],
                    ["manual", "Ручной"],
                  ] as [ReportsType, string][]
                ).map(([v, label]) => (
                  <button
                    type="button"
                    key={v}
                    className={"reports-pill" + (reportsType === v ? " active" : "")}
                    onClick={() => setReportsType(v)}
                    aria-pressed={reportsType === v}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="reports-empty">
              Здесь появится годовая сводка после первого сохранённого расчёта.
            </div>
          ) : !yearlySummary ? (
            <div className="reports-empty">
              За выбранный период и тип расчёта данных нет. Измените фильтры выше.
            </div>
          ) : (
            <>
              <div className="reports-summary">
                <div className="fin-card">
                  <div className="fin-card-title">
                    Финансовая сводка
                    {reportsYear !== "all" ? ` · ${reportsYear}` : ""}
                  </div>
                  <table className="fin-table" aria-label="Финансовая сводка">
                    <thead>
                      <tr>
                        <th scope="col">Показатель</th>
                        <th scope="col">Значение</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="fin-row">
                        <th scope="row">Выручка</th>
                        <td className="fin-val">
                          {fmt(Math.round(yearlySummary.revenue))} ₽
                        </td>
                      </tr>

                      {yearlySummary.cost > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Себестоимость</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.cost))} ₽
                          </td>
                        </tr>
                      )}

                      {yearlySummary.ozonFeesCharges > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Комиссии и логистика Ozon</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.ozonFeesCharges))} ₽
                          </td>
                        </tr>
                      )}

                      {yearlySummary.adsCharges > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Реклама и продвижение</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.adsCharges))} ₽
                          </td>
                        </tr>
                      )}

                      {yearlySummary.otherCharges > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Прочие расходы</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.otherCharges))} ₽
                          </td>
                        </tr>
                      )}

                      {/* PR B: дополнительные ручные расходы API-расчётов
                          (packaging/warehouse/salary/manual other), отдельно. */}
                      {yearlySummary.manualExtraExpenses > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Дополнительные расходы</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.manualExtraExpenses))} ₽
                          </td>
                        </tr>
                      )}

                      {/* PR B: отдельная зелёная строка доходов-компенсаций Ozon.
                          Вычитается из расходов; итог = stored total_expenses. */}
                      {yearlySummary.ozonIncome > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Корректировки и компенсации Ozon</th>
                          <td className="fin-val pos">
                            +{fmt(Math.round(yearlySummary.ozonIncome))} ₽
                          </td>
                        </tr>
                      )}

                      {yearlySummary.tax > 0 && (
                        <tr className="fin-row">
                          <th scope="row">Налог</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.tax))} ₽
                          </td>
                        </tr>
                      )}

                      {yearlySummary.expenses > 0 && (
                        <tr className="fin-row fin-row--subtotal">
                          <th scope="row">Все расходы</th>
                          <td className="fin-val">
                            {fmt(Math.round(yearlySummary.expenses))} ₽
                          </td>
                        </tr>
                      )}

                      <tr className="fin-row fin-row--net">
                        <th scope="row">Чистая прибыль</th>
                        <td
                          className={
                            "fin-val " +
                            (yearlySummary.profit >= 0 ? "pos" : "neg")
                          }
                        >
                          {yearlySummary.profit >= 0 ? "+" : "−"}
                          {fmt(Math.abs(Math.round(yearlySummary.profit)))} ₽
                        </td>
                      </tr>

                      <tr className="fin-row fin-row--margin">
                        <th scope="row">Маржинальность</th>
                        <td
                          className={
                            "fin-val " +
                            (yearlySummary.avgMargin >= 0 ? "pos" : "neg")
                          }
                        >
                          {yearlySummary.avgMargin.toFixed(1)}%
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="fin-stats">
                  <div className="fin-card-title">Статистика</div>
                  {(() => {
                    // Все вычисления ниже — display-only и локальные: они НЕ
                    // меняют yearlySummary / reportsMonthly / reportsFiltered /
                    // историю / БД. Делитель средних — число МЕСЯЦЕВ с расчётами
                    // (reportsMonthly.length), а не число отдельных расчётов.
                    const months = reportsMonthly.length;
                    const perMonth = (v: number) => (months > 0 ? v / months : 0);
                    const avgProfit = perMonth(yearlySummary.profit);
                    const avgRevenue = perMonth(yearlySummary.revenue);
                    const avgExpenses = perMonth(yearlySummary.expenses);
                    const profitableMonths = reportsMonthly.filter(
                      (m) => m.profit > 0
                    ).length;
                    const losingMonths = reportsMonthly.filter(
                      (m) => m.profit < 0
                    ).length;
                    const share = (n: number) =>
                      months > 0 ? Math.round((n / months) * 100) : 0;
                    const money = (v: number, signed: boolean) =>
                      (signed ? (v >= 0 ? "+" : "−") : "") +
                      fmt(Math.abs(Math.round(v))) +
                      " ₽";
                    // Диапазон периода из уже отсортированного reportsMonthly
                    // (по возрастанию ключа 'YYYY-MM'). Без новой агрегации.
                    const periodLabel =
                      months === 0
                        ? "—"
                        : months === 1
                        ? formatMonthLabel(reportsMonthly[0].key)
                        : (() => {
                            const a = reportsMonthly[0].key;
                            const b = reportsMonthly[months - 1].key;
                            const am = /^(\d{4})-(\d{2})$/.exec(a);
                            const aName = am
                              ? RU_MONTHS_NOM[Number(am[2]) - 1] ?? a
                              : a;
                            return a.slice(0, 4) === b.slice(0, 4)
                              ? `${aName} — ${formatMonthLabel(b)}`
                              : `${formatMonthLabel(a)} — ${formatMonthLabel(b)}`;
                          })();
                    return (
                      <table className="fin-table" aria-label="Статистика">
                        <tbody>
                          <tr className="fin-row">
                            <th scope="row">Количество расчётов</th>
                            <td className="fin-val">{yearlySummary.count}</td>
                          </tr>
                          {months > 0 && (
                            <tr className="fin-row">
                              <th scope="row">Период</th>
                              <td className="fin-val fin-val--text">
                                {periodLabel}
                              </td>
                            </tr>
                          )}

                          {months > 0 && (
                            <>
                              <tr className="fin-row fin-row--group">
                                <th scope="row">Средняя прибыль</th>
                                <td
                                  className={
                                    "fin-val " +
                                    (avgProfit >= 0 ? "pos" : "neg")
                                  }
                                >
                                  {money(avgProfit, true)}
                                </td>
                              </tr>
                              <tr className="fin-row">
                                <th scope="row">Средняя выручка</th>
                                <td className="fin-val">
                                  {money(avgRevenue, false)}
                                </td>
                              </tr>
                              <tr className="fin-row">
                                <th scope="row">Средние расходы</th>
                                <td className="fin-val">
                                  {money(avgExpenses, false)}
                                </td>
                              </tr>

                              <tr className="fin-row fin-row--group">
                                <th scope="row">Прибыльных месяцев</th>
                                <td className="fin-val">
                                  <span
                                    className={
                                      profitableMonths > 0 ? "pos" : undefined
                                    }
                                  >
                                    {profitableMonths} из {months} ·{" "}
                                    {share(profitableMonths)}%
                                  </span>
                                </td>
                              </tr>
                              <tr className="fin-row">
                                <th scope="row">Убыточных месяцев</th>
                                <td className="fin-val">
                                  <span
                                    className={
                                      losingMonths > 0 ? "neg" : undefined
                                    }
                                  >
                                    {losingMonths} из {months} ·{" "}
                                    {share(losingMonths)}%
                                  </span>
                                </td>
                              </tr>
                            </>
                          )}

                          {yearlySummary.best && (
                            <tr className="fin-row fin-row--group">
                              <th scope="row">Лучший месяц</th>
                              <td className="fin-val fin-val--stacked">
                                <span className="fin-stat-sub">
                                  {formatMonthLabel(yearlySummary.best.key)}
                                </span>
                                <span className="pos">
                                  +{fmt(Math.round(yearlySummary.best.profit))} ₽
                                </span>
                              </td>
                            </tr>
                          )}
                          {yearlySummary.worst && (
                            <tr className="fin-row">
                              <th scope="row">Худший месяц</th>
                              <td className="fin-val fin-val--stacked">
                                <span className="fin-stat-sub">
                                  {formatMonthLabel(yearlySummary.worst.key)}
                                </span>
                                <span
                                  className={
                                    yearlySummary.worst.profit >= 0
                                      ? "pos"
                                      : "neg"
                                  }
                                >
                                  {yearlySummary.worst.profit >= 0 ? "+" : "−"}
                                  {fmt(
                                    Math.abs(Math.round(yearlySummary.worst.profit))
                                  )}{" "}
                                  ₽
                                </span>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              </div>

              {reportsMonthly.length > 0 && (
                <div className="reports-chart">
                  <div className="reports-chart-head">
                    <span className="reports-chart-title">Прибыль по месяцам</span>
                    <span className="reports-chart-sub">
                      {reportsMonthly.length}&nbsp;мес.
                    </span>
                  </div>
                  <div
                    className="reports-bars"
                    role="img"
                    aria-label="График прибыли по месяцам"
                  >
                    {(() => {
                      const bars = reportsMonthly.slice(-12);
                      const maxAbs = Math.max(
                        1,
                        ...bars.map((m) => Math.abs(m.profit))
                      );
                      return bars.map((m) => {
                        const pos = m.profit >= 0;
                        const hPct = Math.max(
                          3,
                          Math.round((Math.abs(m.profit) / maxAbs) * 100)
                        );
                        return (
                          <div
                            className="reports-bar-col"
                            key={m.key}
                            title={`${formatMonthLabel(m.key)}: ${
                              pos ? "+" : "−"
                            }${fmt(Math.abs(Math.round(m.profit)))} ₽`}
                          >
                            <div className="reports-bar-track">
                              <div
                                className={"reports-bar " + (pos ? "pos" : "neg")}
                                style={{ height: hPct + "%" }}
                              />
                            </div>
                            <div className="reports-bar-label">
                              {formatMonthLabel(m.key).replace(/ \d{4}$/, "")}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {history.length > 0 && (
          <div className="reports-section-cap">Детальная аналитика и история</div>
        )}

        <div
          className={
            "filter-bar" +
            (filtersOpen ? " filter-open" : "") +
            (filtersActive ? " filter-has-active" : "")
          }
          role="region"
          aria-label="Фильтры аналитики"
        >
          <button
            type="button"
            className="filter-toggle"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="filter-panel"
          >
            <span className="filter-toggle-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
                <circle cx="9" cy="6" r="2.2" fill="#0d1020" />
                <circle cx="15" cy="12" r="2.2" fill="#0d1020" />
                <circle cx="7" cy="18" r="2.2" fill="#0d1020" />
              </svg>
            </span>
            <span className="filter-toggle-label">Фильтры</span>
            {filtersActive && <span className="filter-toggle-dot" aria-hidden="true" />}

            {filtersActive ? (
              <span className="filter-toggle-badges">
                <span
                  className={
                    "filter-bdg" + (filterPeriod !== "all" ? " active" : "")
                  }
                >
                  <span className="filter-bdg-dot" />
                  <span className="filter-bdg-l">Период:</span>
                  <span className="filter-bdg-v">{filterPeriodLabel}</span>
                </span>
                <span
                  className={
                    "filter-bdg" + (filterResult !== "all" ? " active" : "")
                  }
                >
                  <span className="filter-bdg-dot" />
                  <span className="filter-bdg-l">Результаты:</span>
                  <span className="filter-bdg-v">{filterResultLabel}</span>
                </span>
              </span>
            ) : (
              <span className="filter-toggle-hint">
                Настройте аналитику по периоду и результату
              </span>
            )}

            <span className="filter-toggle-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </button>

          <div className="filter-panel-wrap">
            <div className="filter-panel-inner">
              <div className="filter-panel" id="filter-panel" role="toolbar">
          <div className="filter-group">
            <div className="filter-label">Период</div>
            <div className="filter-pills">
              {(["7", "14", "30", "all"] as FilterPeriod[]).map((v) => (
                <button
                  type="button"
                  key={v}
                  className={"filter-pill" + (filterPeriod === v ? " active" : "")}
                  onClick={() => setFilterPeriod(v)}
                  aria-pressed={filterPeriod === v}
                >
                  {v === "all" ? "Всё время" : v + " дней"}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-divider" aria-hidden="true" />

          <div className="filter-group">
            <div className="filter-label">Результат</div>
            <div className="filter-pills">
              {(
                [
                  ["all", "Все"],
                  ["profit", "Прибыльные"],
                  ["loss", "Убыточные"],
                ] as [FilterResult, string][]
              ).map(([v, label]) => (
                <button
                  type="button"
                  key={v}
                  className={"filter-pill" + (filterResult === v ? " active" : "")}
                  onClick={() => setFilterResult(v)}
                  aria-pressed={filterResult === v}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
              </div>
            </div>
          </div>
        </div>

        <AnalyticsBlock
          realHistory={filteredHistory}
          chartHistory={chartHistory}
          hasAnyData={history.length > 0}
          hasPremium={hasPremium}
          onOpenPremium={openPremium}
          reco={{
            hasReport: combinedStatus === "success" && !!combinedResult,
            ready: netProfitReady,
            revenue: combinedResult?.revenue ?? 0,
            profitBeforeCost: combinedResult?.profitBeforeCost ?? 0,
            updServicesTotal: combinedResult?.updServicesTotal ?? 0,
            updCommissionTotal: combinedResult?.updCommissionTotal ?? 0,
            netProfit: profitCalc?.netProfit ?? 0,
            margin: profitCalc?.margin ?? 0,
            roi: profitCalc?.roi ?? 0,
            costPrice: profitCalc?.costPrice ?? 0,
            tax: profitCalc?.tax ?? 0,
            taxPercent: profitCalc?.taxPercent ?? 0,
            ads: profitCalc?.ads ?? 0,
            otherExpenses: profitCalc?.otherExpensesGroup ?? 0,
            coverage: reportCostCoverage,
            best: reportKeyProducts?.best ?? null,
            worst: reportKeyProducts?.worst ?? null,
          }}
        />
          </>
        )}

        {(mainTab === "calc" || !user) && (
          <>
        <div className="calc-tabs" role="tablist" ref={calcSectionRef}>
          <button
            type="button"
            role="tab"
            aria-selected={calcMode === "upload"}
            className={"calc-tab" + (calcMode === "upload" ? " active" : "")}
            onClick={() => setCalcMode("upload")}
          >
            <span className="calc-tab-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8 12 3 7 8" />
                <path d="M12 3v13" />
              </svg>
            </span>
            Расчёт по документам Ozon
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={calcMode === "api"}
            className={"calc-tab" + (calcMode === "api" ? " active" : "")}
            onClick={() => setCalcMode("api")}
          >
            <span className="calc-tab-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
              </svg>
            </span>
            Авторасчёт Ozon API
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={calcMode === "manual"}
            className={"calc-tab" + (calcMode === "manual" ? " active" : "")}
            onClick={() => setCalcMode("manual")}
          >
            <span className="calc-tab-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="16" height="18" rx="2.5" />
                <path d="M8 7h8M8 11h8M8 15h5" />
              </svg>
            </span>
            Ручной калькулятор
          </button>
        </div>

        {calcMode === "manual" && (
          <div className="onboard-card mcalc-info">
            <div className="mcalc-head">
              <h2 className="mcalc-title">Ручной калькулятор</h2>
              <p className="mcalc-sub">
                Быстрый расчёт: вы сами вводите все показатели — без
                подключения Ozon API и без загрузки документов.
              </p>
            </div>
            <div className="onboard-steps">
              <div className="onboard-step">
                <span className="onboard-num">1</span>
                <span className="onboard-text">Введите выручку</span>
              </div>
              <span className="onboard-arrow" aria-hidden="true">→</span>
              <div className="onboard-step">
                <span className="onboard-num">2</span>
                <span className="onboard-text">Укажите комиссию</span>
              </div>
              <span className="onboard-arrow" aria-hidden="true">→</span>
              <div className="onboard-step">
                <span className="onboard-num">3</span>
                <span className="onboard-text">Нажмите «Рассчитать»</span>
              </div>
            </div>
          </div>
        )}

        {calcMode === "manual" && (
        <div className="dash-grid mcalc-layout-grid">
          <div className={"card" + (isCalculating ? " calc-loading" : "")}>
            <div className="card-body">
              <div className="mcalc-params-head">Параметры расчёта</div>

              <div className="mp-row mcalc-mp" aria-label="Маркетплейс">
                <div className="mp-tab act-ozon mp-static" aria-current="true">
                  <span className="mp-dot mp-dot-ozon" aria-hidden="true" />
                  Ozon
                </div>
              </div>

              <div className="mcalc-grid">
                {FIELDS.map((f) => (
                  <div className="fld" key={f.key}>
                    <label>{f.label}</label>
                    <div className="in-wrap">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={form[f.key]}
                        onChange={(e) => handleField(f.key, e.target.value)}
                        disabled={isCalculating}
                        readOnly={loadedApiView !== null}
                        aria-readonly={loadedApiView !== null || undefined}
                      />
                      <span className="in-cur">₽</span>
                    </div>
                    {f.hint && <span className="fld-hint">{f.hint}</span>}
                  </div>
                ))}
                {loadedApiView && loadedApiView.compensations > 0 && (
                  <div
                    className="api-additional-income"
                    aria-label="Дополнительный доход — корректировки и компенсации Ozon"
                  >
                    <div className="api-additional-income-label">
                      <span>Дополнительный доход</span>
                      <small>(корректировки и компенсации Ozon)</small>
                    </div>
                    <div className="api-additional-income-box">
                      <output
                        className="api-additional-income-value"
                        aria-label={
                          "Дополнительный доход: " +
                          fmt(Math.round(loadedApiView.compensations)) +
                          " рублей, уже учтён в чистой прибыли"
                        }
                      >
                        +{fmt(Math.round(loadedApiView.compensations))} ₽
                      </output>
                    </div>
                    <div className="api-additional-income-hint">
                      Уже учтён в чистой прибыли.
                    </div>
                  </div>
                )}
              </div>

              {loadedApiView ? (
                <div className="btn-row mcalc-actions api-view-actions">
                  <div className="api-view-notice" role="region" aria-label="Сохранённый расчёт Ozon API">
                    <span className="api-view-notice-dot" aria-hidden="true" />
                    <div className="api-view-notice-body">
                      <span className="api-view-notice-title">Сохранённый расчёт Ozon API</span>
                      <span className="api-view-notice-text">
                        Открыт для просмотра. Чтобы вернуться к обычному калькулятору, очистите форму.
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn-ghost mcalc-clear"
                    onClick={clearForm}
                    disabled={isCalculating}
                  >
                    Очистить форму
                  </button>
                </div>
              ) : canCalculate || !entitlementsLoaded ? (
                <div className="btn-row mcalc-actions">
                  <button
                    className="btn-gold mcalc-calc"
                    onClick={calculate}
                    disabled={isCalculating}
                  >
                    {isCalculating ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                        <span className="spin-dark" />
                        Считаем…
                      </span>
                    ) : (
                      "Рассчитать чистую прибыль"
                    )}
                  </button>
                  <button
                    className="btn-ghost mcalc-clear"
                    onClick={clearForm}
                    disabled={isCalculating}
                  >
                    Очистить форму
                  </button>
                </div>
              ) : (
                <div className="upgrade-hint" role="region" aria-label="Лимит расчётов исчерпан">
                  {/* Возле кнопки расчёта НЕ дублируем продажу тарифов: только
                      нейтральная подсказка. Карточки 149/449 — в одном месте, в
                      нижнем тарифном блоке dashboard (#dash-tariffs). */}
                  <div className="upgrade-hint-left">
                    <span className="upgrade-hint-dot" aria-hidden="true" />
                    <span className="upgrade-hint-text">
                      Лимит расчётов исчерпан —{" "}
                      {user
                        ? "оформите тариф во вкладке «Личный кабинет»"
                        : "выберите тариф в блоке ниже"}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {isCalculating && (
              <div
                className="ai-proc-overlay"
                role="status"
                aria-live="polite"
                aria-label="Идёт AI-анализ расчёта"
              >
                <div className="ai-proc-card">
                  <span className="ai-proc-border" aria-hidden="true" />

                  <div className="ai-proc-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
                      <circle cx="19.5" cy="4.5" r="1.1" opacity=".55" />
                      <circle cx="4.5" cy="18.5" r=".9" opacity=".4" />
                    </svg>
                  </div>

                  <div className="ai-proc-title">
                    AI <em>анализ</em> финансов
                  </div>

                  <ul className="ai-proc-stages">
                    {AI_STAGES.map((s, i) => (
                      <li
                        key={i}
                        className={
                          "ai-proc-stage" +
                          (i === analysisStage ? " is-active" : "") +
                          (i < analysisStage ? " is-done" : "")
                        }
                      >
                        <span className="ai-proc-mark" aria-hidden="true" />
                        <span className="ai-proc-stage-text">{s}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="ai-proc-progress" aria-hidden="true">
                    <div className="ai-proc-progress-bar" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="dash-right-col">
          <div
            className={
              "result-card" +
              (justCalculated ? " success-pulse" : "") +
              (result && result.profit >= 0 ? " result-pos" : "") +
              (result && result.profit < 0 ? " result-neg" : "")
            }
          >
            <div className="card-head">
              <div className="card-title">Результат</div>
            </div>
            {result ? (
              <>
                <div className="res-hero">
                  <svg
                    className="res-hero-chart"
                    viewBox="0 0 200 60"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <defs>
                      <linearGradient id="resChartFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(201,168,76,.22)" />
                        <stop offset="100%" stopColor="rgba(201,168,76,0)" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M0,46 L20,42 L40,44 L60,32 L80,30 L100,24 L120,26 L140,16 L160,18 L180,10 L200,12 L200,60 L0,60 Z"
                      fill="url(#resChartFill)"
                    />
                    <path
                      d="M0,46 L20,42 L40,44 L60,32 L80,30 L100,24 L120,26 L140,16 L160,18 L180,10 L200,12"
                      stroke="rgba(201,168,76,.55)"
                      strokeWidth="1.4"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <div className="res-hero-glow" aria-hidden="true" />
                  <div className="res-hero-lbl">Чистая прибыль</div>
                  <div className={"res-hero-val " + (result.profit >= 0 ? "pos" : "neg")}>
                    {result.profit >= 0 ? "+" : "−"}
                    {fmt(Math.abs(result.profit))} ₽
                  </div>
                  <div className={"res-margin " + (result.margin >= 0 ? "pos" : "neg")}>
                    Маржинальность {result.margin.toFixed(1)}%
                  </div>
                </div>
                <div className="res-rows">
                  <div className="res-row">
                    <span className="rl">Выручка</span>
                    <span className="rv">{fmt(result.revenue)} ₽</span>
                  </div>
                  {loadedApiView && loadedApiView.compensations > 0 ? (
                    <>
                      <div className="res-row">
                        <span className="rl">Расходы до компенсаций</span>
                        <span className="rv neg">
                          − {fmt(result.expenses + loadedApiView.compensations)} ₽
                        </span>
                      </div>
                      <div className="res-row">
                        <span className="rl">Корректировки Ozon</span>
                        <span className="rv income">
                          + {fmt(Math.round(loadedApiView.compensations))} ₽
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="res-row">
                      <span className="rl">Сумма расходов</span>
                      <span className="rv neg">− {fmt(result.expenses)} ₽</span>
                    </div>
                  )}
                  <div className="res-row">
                    <span className="rl">Чистая прибыль</span>
                    <span className="rv">
                      {result.profit >= 0 ? "+" : "−"}
                      {fmt(Math.abs(result.profit))} ₽
                    </span>
                  </div>
                  <div className="res-row">
                    <span className="rl">Маржинальность</span>
                    <span className="rv">{result.margin.toFixed(1)}%</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-res">
                <span className="empty-icon">◇</span>
                <div className="empty-title">Результат появится здесь</div>
                <div className="empty-sub">
                  Заполните поля слева и нажмите «Рассчитать»
                </div>
                <div className="empty-bars" aria-hidden="true">
                  <span className="empty-bar bar-1" />
                  <span className="empty-bar bar-2" />
                  <span className="empty-bar bar-3" />
                </div>
              </div>
            )}
          </div>

          {(() => {
            const quick = result ?? history[0] ?? null;
            const hasData = quick !== null;
            const isProfit = hasData && quick.profit >= 0;
            return (
              <div className="quick-summary" role="region" aria-label="Быстрый итог">
                <div className="quick-summary-head">
                  <span className="quick-summary-title">Быстрый итог</span>
                  {hasData && (
                    <span
                      className={
                        "quick-summary-status " + (isProfit ? "ok" : "bad")
                      }
                    >
                      {isProfit ? "прибыльный" : "убыточный"}
                    </span>
                  )}
                </div>

                <div className="quick-summary-body">
                  <div className="quick-summary-row">
                    <span className="quick-summary-label">Чистая прибыль</span>
                    <span
                      className={
                        "quick-summary-value " +
                        (hasData ? (isProfit ? "pos" : "neg") : "muted")
                      }
                    >
                      {hasData
                        ? (isProfit ? "+" : "−") +
                          fmt(Math.abs(quick.profit)) +
                          " ₽"
                        : "—"}
                    </span>
                  </div>
                  <div className="quick-summary-row">
                    <span className="quick-summary-label">Маржинальность</span>
                    <span
                      className={
                        "quick-summary-value " + (hasData ? "" : "muted")
                      }
                    >
                      {hasData ? quick.margin.toFixed(1) + "%" : "—"}
                    </span>
                  </div>
                </div>

                <div className="quick-summary-foot">
                  Обновляется после каждого расчёта
                </div>
              </div>
            );
          })()}
          </div>
        </div>
        )}

        {calcMode === "api" && (
        <div className="card api-pro-card">
          <div className="api-pro-head">
            <div className="api-pro-title">Авторасчёт через Ozon API</div>
          </div>

          <div className="api-pro-body">
            {/* Подключение Ozon — только статус. Само подключение/ключи в «Личном
                кабинете» (setMainTab("cabinet")). */}
            {!user || (!ozonConnLoading && !ozonConn?.connected) ? (
              /* Состояние 1 — Ozon API не подключён (гость или без подключения) */
              <div className="api-connect-cta">
                <p className="api-connect-cta-text">
                  Подключите Ozon API в личном кабинете, чтобы рассчитывать
                  чистую прибыль автоматически.
                </p>
                <button
                  type="button"
                  className="api-pro-btn"
                  onClick={() => setMainTab("cabinet")}
                >
                  Перейти в личный кабинет
                </button>
              </div>
            ) : ozonConnLoading ? (
              <p className="api-pro-msg" style={{ marginTop: ".2rem" }}>
                Проверяем подключение…
              </p>
            ) : (
              /* Состояние 2 (шапка) — Ozon подключён */
              <div className="api-conn-ok api-conn-ok-bar" role="status">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                </svg>
                <b>Ozon подключён</b>
                <button
                  type="button"
                  className="api-conn-manage"
                  onClick={() => setMainTab("cabinet")}
                >
                  Управление подключением
                </button>
              </div>
            )}

            {/* Форма расчёта — доступна только после подключения Ozon */}
            {ozonConn?.connected && (
              <>
                {/* Месяц расчёта */}
                <div className="api-field-block">
                  <label className="api-field-label" htmlFor="ozon-profit-month">
                    Месяц расчёта
                  </label>
                  <div className="api-fld" style={{ maxWidth: "320px" }}>
                    <input
                      id="ozon-profit-month"
                      className="api-input"
                      type="month"
                      value={profitMonth}
                      max={new Date().toISOString().slice(0, 7)}
                      onChange={(e) => {
                        // Новый месяц → сбрасываем прошлый результат/ошибки, чтобы
                        // кнопка снова считала и не было показа чужих цифр.
                        setProfitMonth(e.target.value);
                        setApiSaved(false);
                        setProfitResult(null);
                        setProfitError("");
                        setApiCostGap(null);
                        setRealizationDiag(null);
                      }}
                      disabled={profitLoading}
                    />
                  </div>
                </div>

                {/* Ваши расходы */}
                <div className="api-field-block">
                  <label className="api-field-label">Ваши расходы</label>
                  <p className="api-field-hint">
                    Налог — в процентах от выручки Ozon (например, 6), остальное
                    в рублях. Пустое поле считается как 0.
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: ".6rem",
                    }}
                  >
                    {([
                      { key: "tax", label: "Налог, %", placeholder: "напр. 6", hint: "% от выручки Ozon" },
                      { key: "packaging", label: "Упаковка, ₽", placeholder: "0", hint: "" },
                      { key: "warehouseDelivery", label: "Доставка до склада, ₽", placeholder: "0", hint: "" },
                      { key: "salary", label: "Зарплата, ₽", placeholder: "0", hint: "" },
                      { key: "other", label: "Прочие расходы, ₽", placeholder: "0", hint: "" },
                    ] as const).map((f) => (
                      <div className="api-fld" key={f.key}>
                        <label htmlFor={`ozon-me-${f.key}`}>{f.label}</label>
                        <input
                          id={`ozon-me-${f.key}`}
                          className="api-input"
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          placeholder={f.placeholder}
                          value={apiExpenses[f.key]}
                          onChange={(e) => {
                            setApiExpenses((prev) => ({ ...prev, [f.key]: e.target.value }));
                            // Изменили расходы → разрешаем пересчёт и убираем прошлый результат.
                            setApiSaved(false);
                            setProfitResult(null);
                            setProfitError("");
                            setApiCostGap(null);
                            setRealizationDiag(null);
                          }}
                          disabled={profitLoading}
                        />
                        {f.hint ? <span className="api-hint">{f.hint}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Главная кнопка — расчёт и сохранение */}
                <div className="api-field-block">
                  <button
                    type="button"
                    className="api-pro-btn api-main-cta"
                    onClick={calculateAndSaveApi}
                    disabled={profitLoading || apiSaved}
                  >
                    {profitLoading ? (
                      <>
                        <span className="spin" />
                        Получаем данные из Ozon…
                      </>
                    ) : apiSaved ? (
                      "Рассчитано и сохранено ✓"
                    ) : (
                      "Рассчитать чистую прибыль"
                    )}
                  </button>
                </div>

                {/* Общая ошибка (не «нет тарифа» и не «нет себестоимости») */}
                {profitError && (
                  <p className="api-pro-msg err" style={{ marginTop: "1rem" }}>
                    {profitError}
                  </p>
                )}

                {/* Не хватает себестоимости — структурированный блок с действиями.
                    Расчёт не сделан, попытка не списана. */}
                {apiCostGap && (
                  <div className="api-costgap" role="alert">
                    <div className="api-costgap-title">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18, flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 8v5" />
                        <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
                      </svg>
                      Не хватает себестоимости у товаров
                    </div>
                    <p className="api-costgap-sub">
                      Чтобы рассчитать чистую прибыль, заполните себестоимость всех
                      товаров в каталоге. Сейчас расчёт не сделан и попытка не
                      списана.
                    </p>
                    <div className="api-costgap-stats">
                      {apiCostGap.unmatchedItems > 0 && (
                        <span className="api-costgap-chip">
                          Не сопоставлено с каталогом: {fmt(apiCostGap.unmatchedItems)}
                        </span>
                      )}
                      {apiCostGap.matchedNoCostCount > 0 && (
                        <span className="api-costgap-chip">
                          Без себестоимости (0 ₽): {fmt(apiCostGap.matchedNoCostCount)}
                        </span>
                      )}
                      {apiCostGap.status === "no_cost" &&
                        apiCostGap.unmatchedItems === 0 &&
                        apiCostGap.matchedNoCostCount === 0 && (
                          <span className="api-costgap-chip">
                            Себестоимость не найдена
                          </span>
                        )}
                    </div>
                    <div className="api-costgap-actions">
                      <button type="button" className="api-pro-btn" onClick={goToCatalog}>
                        Перейти в каталог товаров
                      </button>
                      {apiCostGap.unmatchedItems > 0 && (
                        <button
                          type="button"
                          className="api-pro-btn ghost"
                          onClick={() => importMissingProducts(profitMonth)}
                          disabled={importLoading}
                        >
                          {importLoading ? (
                            <>
                              <span className="spin" />
                              Добавляем…
                            </>
                          ) : (
                            "Добавить несопоставленные товары в каталог"
                          )}
                        </button>
                      )}
                    </div>
                    {importError && (
                      <p className="api-pro-msg err" style={{ marginTop: ".8rem" }}>
                        {importError}
                      </p>
                    )}
                    {importResult && (
                      <p className="api-pro-msg ok" style={{ marginTop: ".8rem" }}>
                        Добавлено в каталог: {fmt(importResult.totals.created)}. Теперь
                        заполните им себестоимость в каталоге товаров и повторите
                        расчёт.
                      </p>
                    )}
                  </div>
                )}

                {/* Успех — чистый результат. Показываем только после сохранения. */}
                {profitResult && apiSaved && (
                  <div className="api-result" role="region" aria-label="Результат расчёта">
                    <div className="api-result-hero">
                      <div className="api-result-lbl">
                        Чистая прибыль · {profitResult.period.month}
                      </div>
                      <div
                        className={
                          "api-result-net " +
                          (profitResult.netProfitPreview.value >= 0 ? "pos" : "neg")
                        }
                      >
                        {profitResult.netProfitPreview.value >= 0 ? "+" : "−"}
                        {fmt(Math.abs(profitResult.netProfitPreview.value))} ₽
                      </div>
                      <div className="api-result-margin">
                        Маржинальность{" "}
                        {profitResult.netProfitPreview.margin.toLocaleString("ru-RU", {
                          maximumFractionDigits: 1,
                        })}
                        %
                      </div>
                      <div className="api-result-saved">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="9" />
                          <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                        </svg>
                        Расчёт сохранён в историю
                      </div>
                    </div>
                    <div className="api-result-rows">
                      <div className="api-result-row">
                        <span className="rl">Операции Ozon</span>
                        <span className="rv">
                          {fmt(profitResult.preliminary.ozonOperationsTotal)} ₽
                        </span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Себестоимость товаров</span>
                        <span className="rv neg">
                          − {fmt(profitResult.costDraft.matchedCostTotal)} ₽
                        </span>
                      </div>
                      <p
                        className="api-step-hint"
                        style={{ margin: "-.15rem 0 .1rem" }}
                      >
                        Себестоимость получена из отчёта реализации Ozon
                      </p>
                      {typeof profitResult.postingsReferenceCost === "number" &&
                        profitResult.postingsReferenceCost > 0 && (
                          <div className="api-result-row is-sub">
                            <span className="rl">
                              Справочно: по отправлениям было
                            </span>
                            <span className="rv">
                              {fmt(profitResult.postingsReferenceCost)} ₽
                            </span>
                          </div>
                        )}
                      <div className="api-result-row">
                        <span className="rl">Ручные расходы</span>
                        <span className="rv neg">
                          − {fmt(profitResult.manualExpenses.total)} ₽
                        </span>
                      </div>
                      {profitResult.manualExpenses.tax > 0 && (
                        <div className="api-result-row is-sub">
                          <span className="rl">
                            в т.ч. налог
                            {apiExpenses.tax
                              ? ` (${apiExpenses.tax}% от выручки из реализации Ozon ${fmt(
                                  profitResult.preliminary.taxRevenueBase ?? 0
                                )} ₽)`
                              : ""}
                          </span>
                          <span className="rv">
                            {fmt(profitResult.manualExpenses.tax)} ₽
                          </span>
                        </div>
                      )}
                      <div className="api-result-row is-total">
                        <span className="rl">Чистая прибыль</span>
                        <span
                          className={
                            "rv " + (profitResult.netProfitPreview.value < 0 ? "neg" : "")
                          }
                        >
                          {profitResult.netProfitPreview.value >= 0 ? "+" : "−"}
                          {fmt(Math.abs(profitResult.netProfitPreview.value))} ₽
                        </span>
                      </div>
                    </div>
                    <div className="api-result-rows" style={{ paddingTop: 0 }}>
                      <p className="api-step-hint" style={{ margin: "0 0 .4rem" }}>
                        В составе «Операций Ozon» (справочно, уже учтены выше):
                      </p>
                      <div className="api-result-row">
                        <span className="rl">Начисления Ozon</span>
                        <span className="rv">{fmt(profitResult.apiTotals.ozonAccruals)} ₽</span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Комиссия Ozon</span>
                        <span className="rv">{fmt(profitResult.apiTotals.commission)} ₽</span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Логистика</span>
                        <span className="rv">{fmt(profitResult.apiTotals.logistics)} ₽</span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Доп. услуги</span>
                        <span className="rv">{fmt(profitResult.apiTotals.services)} ₽</span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Хранение</span>
                        <span className="rv">{fmt(profitResult.apiTotals.storage)} ₽</span>
                      </div>
                      <div className="api-result-row">
                        <span className="rl">Прочее</span>
                        <span className="rv">{fmt(profitResult.apiTotals.other)} ₽</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* СПРАВОЧНАЯ диагностика отчёта о реализации Ozon (read-only).
                    Приходит довеском к сохранённому расчёту. НЕ влияет на прибыль/
                    налог/себестоимость выше — candidate COGS показываем, чтобы сверить
                    источник себестоимости с документальным расчётом.
                    Скрыт перед рекламным запуском флагом SHOW_REALIZATION_DIAGNOSTIC
                    (см. верх файла): это техническая диагностика, обычному пользователю
                    не нужна. Логика расчёта/сохранения НЕ тронута — вернуть = флаг в true. */}
                {SHOW_REALIZATION_DIAGNOSTIC && realizationDiag && apiSaved && profitResult && (
                  <div
                    className="rz-diag"
                    role="region"
                    aria-label="Диагностика отчёта реализации Ozon"
                  >
                    <div className="rz-head">
                      <div className="rz-title">Диагностика отчёта реализации Ozon</div>
                      <p className="rz-sub">
                        Справочно (read-only). Не влияет на чистую прибыль, налог и
                        себестоимость выше — показывает, что даёт отчёт о реализации
                        Ozon за {profitResult.period.month}.
                      </p>
                    </div>

                    {!realizationDiag.connected ? (
                      <div className="rz-warn" role="alert">
                        Отчёт о реализации получить не удалось
                        {realizationDiag.errorCode ? ` (${realizationDiag.errorCode})` : ""}.
                        Диагностика недоступна — сохранённый расчёт выше не затронут.
                      </div>
                    ) : (
                      <>
                        <div className="rz-cand">
                          <div className="rz-cand-row">
                            <span className="rz-cand-lbl">
                              Кандидатная себестоимость (по количеству продаж)
                            </span>
                            <span className="rz-cand-val">
                              {fmt(realizationDiag.candidateCogs.bySaleQty)} ₽
                            </span>
                          </div>
                          <div className="rz-cand-row sub">
                            <span className="rz-cand-lbl">
                              С вычетом возвратов (продажи − возвраты)
                            </span>
                            <span className="rz-cand-val">
                              {fmt(realizationDiag.candidateCogs.byNetQty)} ₽
                            </span>
                          </div>
                          <p className="rz-cand-hint">
                            Сравните с себестоимостью в «Расчёте по документам Ozon» за
                            тот же месяц. Величина справочная — в прибыль не входит.
                          </p>
                        </div>

                        <div className="rz-grid">
                          {[
                            { label: "Строк в отчёте", value: fmt(realizationDiag.rowCount) },
                            { label: "Продано, ед.", value: fmt(realizationDiag.sums.saleQuantity) },
                            { label: "Возвраты, ед.", value: fmt(realizationDiag.sums.returnQuantity) },
                            { label: "Выручка (delivery)", value: `${fmt(realizationDiag.sums.deliveryAmount)} ₽` },
                            { label: "Возвраты (amount)", value: `${fmt(realizationDiag.sums.returnAmount)} ₽` },
                            { label: "Баллы за скидки", value: `${fmt(realizationDiag.sums.bonus)} ₽` },
                            { label: "Со-инвест. банка", value: `${fmt(realizationDiag.sums.bankCoinvestment)} ₽` },
                            { label: "Программы (stars)", value: `${fmt(realizationDiag.sums.stars)} ₽` },
                            { label: "Сопоставлено строк", value: fmt(realizationDiag.candidateCogs.matchedRows) },
                            { label: "Не сопоставлено", value: fmt(realizationDiag.candidateCogs.unmatchedRows) },
                            { label: "Без себестоимости", value: fmt(realizationDiag.candidateCogs.matchedNoCostRows) },
                          ].map((c) => (
                            <div className="rz-cell" key={c.label}>
                              <div className="rz-cell-lbl">{c.label}</div>
                              <div className="rz-cell-val">{c.value}</div>
                            </div>
                          ))}
                        </div>

                        <div className="rz-fields">
                          <span className="rz-fields-cap">Поля отчёта:</span>
                          {([
                            ["Артикул (offer_id)", realizationDiag.fieldsPresent.offerId],
                            ["Кол-во продаж", realizationDiag.fieldsPresent.deliveryQuantity],
                            ["Кол-во возвратов", realizationDiag.fieldsPresent.returnQuantity],
                            ["Выручка", realizationDiag.fieldsPresent.deliveryAmount],
                            ["Цена продавца", realizationDiag.fieldsPresent.sellerPricePerInstance],
                            ["Баллы", realizationDiag.fieldsPresent.bonus],
                            ["Со-инвест.", realizationDiag.fieldsPresent.bankCoinvestment],
                            ["Stars", realizationDiag.fieldsPresent.stars],
                          ] as const).map(([lbl, ok]) => (
                            <span key={lbl} className={"rz-chip " + (ok ? "ok" : "no")}>
                              {ok ? "✓" : "—"} {lbl}
                            </span>
                          ))}
                        </div>

                        {/* Диагностика СТРУКТУРЫ ответа: реальные имена ключей
                            rows[0] и где лежит идентификатор товара. Свёрнуто,
                            чтобы не перегружать основной результат. Значения полей
                            не показываются — только имена ключей/типы. */}
                        <details className="rz-debug">
                          <summary className="rz-debug-sum">
                            Структура ответа реализации (имена полей rows[0])
                          </summary>
                          <div className="rz-debug-body">
                            <div className="rz-debug-line">
                              <span className="rz-debug-k">Идентификатор товара:</span>{" "}
                              {realizationDiag.debug.resolvedOfferIdPath ? (
                                <code className="rz-code ok">
                                  {realizationDiag.debug.resolvedOfferIdPath}
                                </code>
                              ) : (
                                <span className="rz-debug-none">не найден в строке</span>
                              )}
                              {realizationDiag.debug.hasNestedItem && (
                                <span className="rz-debug-hint">
                                  {" "}
                                  — товарные поля вложены в объект <code className="rz-code">item</code>
                                </span>
                              )}
                            </div>

                            {realizationDiag.debug.rowKeys.length > 0 && (
                              <div className="rz-debug-line">
                                <span className="rz-debug-k">Поля строки rows[0]:</span>
                                <span className="rz-keys">
                                  {realizationDiag.debug.rowKeys.map((k) => (
                                    <code key={k} className="rz-code">
                                      {k}
                                    </code>
                                  ))}
                                </span>
                              </div>
                            )}

                            {realizationDiag.debug.nestedKeys.map((nk) => (
                              <div className="rz-debug-line" key={nk.key}>
                                <span className="rz-debug-k">{nk.key} {"{}"}:</span>
                                <span className="rz-keys">
                                  {nk.keys.map((k) => (
                                    <code key={k} className="rz-code">
                                      {k}
                                    </code>
                                  ))}
                                </span>
                              </div>
                            ))}

                            {realizationDiag.debug.identifierScan.length > 0 && (
                              <div className="rz-debug-line">
                                <span className="rz-debug-k">Идентификаторы (скан):</span>
                                <span className="rz-keys">
                                  {realizationDiag.debug.identifierScan.map((s) => (
                                    <code
                                      key={s.path}
                                      className={"rz-code " + (s.present ? "ok" : "no")}
                                    >
                                      {s.present ? "✓" : "—"} {s.path}:{s.type}
                                    </code>
                                  ))}
                                </span>
                              </div>
                            )}
                          </div>
                        </details>

                        {realizationDiag.warnings.length > 0 && (
                          <ul className="rz-notes">
                            {realizationDiag.warnings.map((w) => (
                              <li key={w}>{w}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        )}

        {calcMode === "api" && (
        <>
        <div className="api-extra-heading">Дополнительные действия и диагностика</div>
        <p className="api-extra-note">
          Эти инструменты не нужны для обычного расчёта. Откройте их, только если
          часть товаров не сопоставлена с каталогом. Подключение и проверка Ozon
          API — во вкладке «Личный кабинет». Прибыль здесь не считается и попытка
          не списывается.
        </p>
        <details className="card api-pro-card api-extra">
          <summary className="api-pro-head api-extra-sum">
            <div className="api-pro-title">Диагностика сопоставления товаров</div>
            <p className="api-pro-sub">
              Проверяем, какие товары из Ozon API удалось найти в каталоге
              себестоимости. Это ещё не расчёт прибыли — данные не сохраняются и не
              списывают попытку.
            </p>
          </summary>

          <div className="api-pro-body">
            {!ozonConn?.connected ? (
              <p className="api-pro-msg" style={{ marginTop: ".4rem" }}>
                Сначала подключите Ozon API
              </p>
            ) : (
              <>
                <div
                  className="api-pro-grid"
                  style={{ gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "end" }}
                >
                  <div className="api-fld">
                    <label htmlFor="ozon-match-month">Месяц</label>
                    <input
                      id="ozon-match-month"
                      className="api-input"
                      type="month"
                      value={matchMonth}
                      max={new Date().toISOString().slice(0, 7)}
                      onChange={(e) => setMatchMonth(e.target.value)}
                      disabled={matchLoading}
                    />
                  </div>
                  <div className="api-fld">
                    <button
                      type="button"
                      className="api-pro-btn"
                      onClick={loadPostingsMatch}
                      disabled={matchLoading}
                    >
                      {matchLoading ? (
                        <>
                          <span className="spin" />
                          Проверяем…
                        </>
                      ) : (
                        "Проверить сопоставление товаров"
                      )}
                    </button>
                  </div>
                </div>

                {matchError && (
                  <p className="api-pro-msg err" style={{ marginTop: "1rem" }}>
                    {matchError}
                  </p>
                )}

                {matchResult && (
                  <div style={{ marginTop: "1rem" }}>
                    {matchResult.warnings.map((w) => (
                      <div
                        key={w}
                        className="api-alert"
                        role="alert"
                        style={{
                          background: "rgba(245,158,11,.10)",
                          border: "1px solid rgba(245,158,11,.35)",
                          marginBottom: ".5rem",
                        }}
                      >
                        <span className="api-alert-text">{w}</span>
                      </div>
                    ))}

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: ".6rem",
                        marginTop: ".25rem",
                      }}
                    >
                      {[
                        { label: "Всего отправлений", value: fmt(matchResult.totals.postingCount) },
                        { label: "Строк товаров", value: fmt(matchResult.totals.itemRows) },
                        { label: "Уникальных товаров", value: fmt(matchResult.totals.uniqueOzonItems) },
                        { label: "Сопоставлено", value: fmt(matchResult.totals.matchedItems) },
                        { label: "Не сопоставлено", value: fmt(matchResult.totals.unmatchedItems) },
                        { label: "Сопоставлено единиц", value: fmt(matchResult.totals.matchedQuantity) },
                        { label: "Не сопоставлено единиц", value: fmt(matchResult.totals.unmatchedQuantity) },
                      ].map((c) => (
                        <div
                          key={c.label}
                          style={{
                            border: "1px solid rgba(127,127,127,.25)",
                            borderRadius: "12px",
                            padding: ".6rem .8rem",
                          }}
                        >
                          <div style={{ fontSize: ".78rem", opacity: 0.7 }}>{c.label}</div>
                          <div
                            style={{
                              fontSize: "1.05rem",
                              fontWeight: 700,
                              marginTop: ".15rem",
                            }}
                          >
                            {c.value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {(() => {
                      const cbs = matchResult.costByStatus;
                      if (!cbs || cbs.rows.length === 0) return null;
                      const pct = (x: number) =>
                        `${(x * 100).toLocaleString("ru-RU", {
                          maximumFractionDigits: 1,
                        })}%`;
                      const highlights = [
                        {
                          label: "Себестоимость всего",
                          value: cbs.totalMatchedCost,
                          accent: false,
                        },
                        {
                          label: "Доставлено",
                          value: cbs.deliveredMatchedCost,
                          accent: false,
                        },
                        {
                          label: "Не доставлено",
                          value: cbs.nonDeliveredMatchedCost,
                          accent: true,
                        },
                        {
                          label: "Отменено",
                          value: cbs.cancelledMatchedCost,
                          accent: true,
                        },
                      ];
                      return (
                        <div
                          style={{
                            marginTop: "1rem",
                            border: "1px solid rgba(201,168,76,.3)",
                            borderRadius: "14px",
                            padding: ".85rem .9rem",
                            background: "rgba(201,168,76,.05)",
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: ".15rem" }}>
                            Себестоимость по статусам отправлений
                          </div>
                          <p
                            className="api-pro-sub"
                            style={{ marginTop: 0, marginBottom: ".7rem" }}
                          >
                            Диагностика (все статусы): показывает, из каких статусов
                            складывается себестоимость отправлений. В расчёт
                            себестоимости включаются только доставленные отправления —
                            отменённые и недоставленные не списываются.
                          </p>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "repeat(auto-fit, minmax(140px, 1fr))",
                              gap: ".6rem",
                              marginBottom: ".85rem",
                            }}
                          >
                            {highlights.map((h) => (
                              <div
                                key={h.label}
                                style={{
                                  border: h.accent
                                    ? "1px solid rgba(245,158,11,.4)"
                                    : "1px solid rgba(127,127,127,.25)",
                                  borderRadius: "12px",
                                  padding: ".6rem .8rem",
                                  background: h.accent
                                    ? "rgba(245,158,11,.07)"
                                    : "transparent",
                                }}
                              >
                                <div style={{ fontSize: ".78rem", opacity: 0.7 }}>
                                  {h.label}
                                </div>
                                <div
                                  style={{
                                    fontSize: "1.05rem",
                                    fontWeight: 700,
                                    marginTop: ".15rem",
                                  }}
                                >
                                  {fmt(h.value)} ₽
                                </div>
                              </div>
                            ))}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: ".4rem",
                            }}
                          >
                            {cbs.rows.map((r) => (
                              <div
                                key={r.status || "(empty)"}
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  justifyContent: "space-between",
                                  gap: ".5rem",
                                  borderBottom:
                                    "1px solid rgba(127,127,127,.12)",
                                  paddingBottom: ".35rem",
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <div
                                    style={{ fontWeight: 600, fontSize: ".9rem" }}
                                  >
                                    {r.label}
                                  </div>
                                  <div
                                    style={{ fontSize: ".76rem", opacity: 0.65 }}
                                  >
                                    {fmt(r.postingCount)} отпр. ·{" "}
                                    {fmt(r.matchedQuantity)} ед. с себест.
                                    {r.unmatchedQuantity > 0
                                      ? ` · ${fmt(r.unmatchedQuantity)} ед. без`
                                      : ""}
                                  </div>
                                </div>
                                <div
                                  style={{
                                    textAlign: "right",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  <div
                                    style={{ fontWeight: 700, fontSize: ".95rem" }}
                                  >
                                    {fmt(r.matchedCost)} ₽
                                  </div>
                                  <div
                                    style={{ fontSize: ".76rem", opacity: 0.65 }}
                                  >
                                    {pct(r.shareOfMatchedCost)}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>

                          {cbs.notes.length > 0 && (
                            <ul
                              style={{
                                marginTop: ".7rem",
                                marginBottom: 0,
                                paddingLeft: "1.1rem",
                                opacity: 0.75,
                                fontSize: ".8rem",
                              }}
                            >
                              {cbs.notes.map((n) => (
                                <li key={n} style={{ marginBottom: ".2rem" }}>
                                  {n}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })()}

                    {matchResult.totals.itemRows > 0 &&
                      matchResult.totals.unmatchedItems === 0 && (
                        <div
                          className="api-alert ok"
                          role="status"
                          style={{ marginTop: "1rem" }}
                        >
                          <span className="api-alert-text">
                            Все найденные товары сопоставлены с каталогом
                            себестоимости.
                          </span>
                        </div>
                      )}

                    {matchResult.unmatched.length > 0 && (
                      <div
                        style={{
                          marginTop: "1rem",
                          border: "1px solid rgba(127,127,127,.2)",
                          borderRadius: "12px",
                          padding: ".75rem .9rem",
                        }}
                      >
                        <div style={{ fontWeight: 700, marginBottom: ".4rem" }}>
                          Несопоставленные товары
                        </div>
                        <p
                          className="api-pro-sub"
                          style={{ marginTop: 0, marginBottom: ".5rem" }}
                        >
                          Добавьте себестоимость/артикул в каталог, чтобы следующий
                          API-расчёт смог учесть эти товары.
                        </p>
                        <div style={{ display: "flex", flexDirection: "column", gap: ".4rem" }}>
                          {matchResult.unmatched.map((u, i) => (
                            <div
                              key={(u.offerId || u.sku || u.name || "x") + i}
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                justifyContent: "space-between",
                                gap: ".5rem",
                                borderBottom: "1px solid rgba(127,127,127,.12)",
                                paddingBottom: ".35rem",
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: ".9rem" }}>
                                  {u.name || u.offerId || u.sku || "—"}
                                </div>
                                <div style={{ fontSize: ".76rem", opacity: 0.7 }}>
                                  {u.offerId ? `Артикул: ${u.offerId}` : ""}
                                  {u.offerId && u.sku ? " · " : ""}
                                  {u.sku ? `SKU: ${u.sku}` : ""}
                                </div>
                                <div style={{ fontSize: ".76rem", opacity: 0.6 }}>
                                  {u.reason}
                                </div>
                              </div>
                              <div
                                style={{
                                  fontSize: ".82rem",
                                  whiteSpace: "nowrap",
                                  opacity: 0.85,
                                }}
                              >
                                {fmt(u.quantity)} шт.
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {matchResult.notes.length > 0 && (
                      <ul
                        style={{
                          marginTop: ".75rem",
                          paddingLeft: "1.1rem",
                          opacity: 0.75,
                          fontSize: ".82rem",
                        }}
                      >
                        {matchResult.notes.map((n) => (
                          <li key={n} style={{ marginBottom: ".2rem" }}>
                            {n}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="api-pro-hint">
              <span className="api-pro-hint-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <circle cx="12" cy="16.4" r=".6" fill="currentColor" />
                </svg>
              </span>
              Диагностика только сопоставляет товары с каталогом. Прибыль не
              считается, ничего не сохраняется и не списывает расчёт.
            </div>
          </div>
        </details>
        </>
        )}

        {calcMode === "api" && (
        <details className="card api-pro-card api-extra">
          <summary className="api-pro-head api-extra-sum">
            <div className="api-pro-title">Добавить несопоставленные товары в каталог</div>
            <p className="api-pro-sub">
              Сайт добавит товары из Ozon API, которых нет в каталоге.
              Себестоимость не будет придумываться — после добавления заполните её
              вручную в каталоге товаров.
            </p>
          </summary>

          <div className="api-pro-body">
            {!ozonConn?.connected ? (
              <p className="api-pro-msg" style={{ marginTop: ".4rem" }}>
                Сначала подключите Ozon API
              </p>
            ) : (
              <>
                <div
                  className="api-pro-grid"
                  style={{ gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "end" }}
                >
                  <div className="api-fld">
                    <label htmlFor="ozon-import-month">Месяц</label>
                    <input
                      id="ozon-import-month"
                      className="api-input"
                      type="month"
                      value={importMonth}
                      max={new Date().toISOString().slice(0, 7)}
                      onChange={(e) => setImportMonth(e.target.value)}
                      disabled={importLoading}
                    />
                  </div>
                  <div className="api-fld">
                    <button
                      type="button"
                      className="api-pro-btn"
                      onClick={() => importMissingProducts()}
                      disabled={importLoading}
                    >
                      {importLoading ? (
                        <>
                          <span className="spin" />
                          Добавляем…
                        </>
                      ) : (
                        "Добавить несопоставленные в каталог"
                      )}
                    </button>
                  </div>
                </div>

                {importError && (
                  <p className="api-pro-msg err" style={{ marginTop: "1rem" }}>
                    {importError}
                  </p>
                )}

                {importResult && (
                  <div style={{ marginTop: "1rem" }}>
                    {importResult.warnings.map((w) => (
                      <div
                        key={w}
                        className="api-alert"
                        role="alert"
                        style={{
                          background: "rgba(245,158,11,.10)",
                          border: "1px solid rgba(245,158,11,.35)",
                          marginBottom: ".5rem",
                        }}
                      >
                        <span className="api-alert-text">{w}</span>
                      </div>
                    ))}

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: ".6rem",
                        marginTop: ".25rem",
                      }}
                    >
                      {[
                        { label: "Не сопоставлено (Ozon)", value: fmt(importResult.totals.unmatchedFromOzon) },
                        { label: "Добавлено в каталог", value: fmt(importResult.totals.created) },
                        { label: "Уже в каталоге", value: fmt(importResult.totals.skippedExisting) },
                        { label: "Без артикула (не добавлены)", value: fmt(importResult.totals.skippedNoOfferId) },
                      ].map((c) => (
                        <div
                          key={c.label}
                          style={{
                            border: "1px solid rgba(127,127,127,.25)",
                            borderRadius: "12px",
                            padding: ".6rem .8rem",
                          }}
                        >
                          <div style={{ fontSize: ".78rem", opacity: 0.7 }}>{c.label}</div>
                          <div
                            style={{
                              fontSize: "1.05rem",
                              fontWeight: 700,
                              marginTop: ".15rem",
                            }}
                          >
                            {c.value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {importResult.totals.unmatchedFromOzon === 0 && (
                      <div
                        className="api-alert ok"
                        role="status"
                        style={{ marginTop: "1rem" }}
                      >
                        <span className="api-alert-text">
                          Все товары уже есть в каталоге. Добавление не требуется.
                        </span>
                      </div>
                    )}

                    {importResult.totals.created > 0 && (
                      <div
                        className="api-alert ok"
                        role="status"
                        style={{ marginTop: "1rem" }}
                      >
                        <span className="api-alert-text">
                          Товары добавлены в каталог. Теперь заполните себестоимость
                          и повторите проверку сопоставления.
                        </span>
                      </div>
                    )}

                    {importResult.created.length > 0 && (
                      <div
                        style={{
                          marginTop: "1rem",
                          border: "1px solid rgba(127,127,127,.2)",
                          borderRadius: "12px",
                          padding: ".75rem .9rem",
                        }}
                      >
                        <div style={{ fontWeight: 700, marginBottom: ".4rem" }}>
                          Добавленные товары
                        </div>
                        <p
                          className="api-pro-sub"
                          style={{ marginTop: 0, marginBottom: ".5rem" }}
                        >
                          Себестоимость у этих товаров пока 0 — заполните её вручную
                          в каталоге товаров, иначе следующий расчёт будет неполным.
                        </p>
                        <div style={{ display: "flex", flexDirection: "column", gap: ".4rem" }}>
                          {importResult.created.map((c, i) => (
                            <div
                              key={(c.sku || c.name || "x") + i}
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                justifyContent: "space-between",
                                gap: ".5rem",
                                borderBottom: "1px solid rgba(127,127,127,.12)",
                                paddingBottom: ".35rem",
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: ".9rem" }}>
                                  {c.name || c.sku || "—"}
                                </div>
                                <div style={{ fontSize: ".76rem", opacity: 0.7 }}>
                                  {c.sku ? `Артикул: ${c.sku}` : ""}
                                </div>
                              </div>
                              <div
                                style={{
                                  fontSize: ".82rem",
                                  whiteSpace: "nowrap",
                                  opacity: 0.85,
                                }}
                              >
                                себестоимость 0 ₽
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {importResult.notes.length > 0 && (
                      <ul
                        style={{
                          marginTop: ".75rem",
                          paddingLeft: "1.1rem",
                          opacity: 0.75,
                          fontSize: ".82rem",
                        }}
                      >
                        {importResult.notes.map((n) => (
                          <li key={n} style={{ marginBottom: ".2rem" }}>
                            {n}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="api-pro-hint">
              <span className="api-pro-hint-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <circle cx="12" cy="16.4" r=".6" fill="currentColor" />
                </svg>
              </span>
              Добавляются только новые товары (артикул = offer_id, себестоимость 0).
              Существующие товары не изменяются, прибыль не считается, расчёт не
              сохраняется и не списывается.
            </div>
          </div>
        </details>
        )}

        {calcMode === "upload" && (
          <div className="card upload-card" role="region" aria-label="Загрузка отчёта (3 файла)">
            <div className="upload-3-head">
              <div className="upload-3-title">
                Расчёт по документам Ozon — 3 файла
              </div>
              <p className="upload-3-sub">
                Загрузите XLSX-отчёт о реализации и оба УПД (доп. услуги +
                агентское вознаграждение). Сайт считает прибыль на основе
                выручки Ozon, выплат от партнёров, расходов по УПД и агентского
                вознаграждения.
              </p>
            </div>

            <div className="mode-note" role="note">
              <div className="mode-note-title">Расчёт по документам Ozon</div>
              <p className="mode-note-text">
                Расчёт по загруженным документам.
                <span className="mode-note-sub">
                  Может отличаться от API и личного кабинета Ozon, если в месяце
                  есть баллы за скидки, компенсации, программы партнёров или
                  прочие начисления.
                </span>
              </p>
            </div>

            {/* Золотой блок «Какие файлы нужны для точного расчёта» убран:
                подписи к каждому файлу теперь внутри ячеек загрузки
                (см. upload-slot-desc в каждом слоте ниже). */}

            <div className="upload-3-slots">
              {/* Slot 1: XLSX */}
              <div
                className={
                  "upload-slot " +
                  (slotXlsx ? "is-ready " : "") +
                  (dragOverSlot === "xlsx" ? "is-drag" : "")
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot("xlsx");
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOverSlot(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot(null);
                  acceptDroppedFile(
                    e.dataTransfer.files?.[0] ?? null,
                    "xlsx"
                  );
                }}
              >
                <div className="upload-slot-num" aria-hidden="true">1</div>
                <div className="upload-slot-body">
                  <div className="upload-slot-label">
                    Отчёт о реализации Ozon
                  </div>
                  <div className="upload-slot-desc">
                    Основной Excel-файл с выручкой и товарами
                  </div>
                  <div className="upload-slot-meta">XLSX или CSV</div>
                  {slotXlsx ? (
                    <div className="upload-slot-file" title={slotXlsx.name}>
                      <span className="upload-slot-file-name">{slotXlsx.name}</span>
                      <button
                        type="button"
                        className="upload-slot-remove"
                        onClick={() => setSlotXlsx(null)}
                        aria-label="Удалить файл"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="upload-slot-pick"
                      onClick={() => xlsxInputRef.current?.click()}
                    >
                      Выбрать файл
                    </button>
                  )}
                  <input
                    ref={xlsxInputRef}
                    type="file"
                    accept=".xlsx,.csv"
                    style={{ display: "none" }}
                    onChange={(e) =>
                      acceptSlot("xlsx", e.target.files?.[0] ?? null)
                    }
                  />
                </div>
              </div>

              {/* Slot 2: UPD services */}
              <div
                className={
                  "upload-slot " +
                  (slotUpdServices ? "is-ready " : "") +
                  (dragOverSlot === "updServices" ? "is-drag" : "")
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot("updServices");
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOverSlot(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot(null);
                  acceptDroppedFile(
                    e.dataTransfer.files?.[0] ?? null,
                    "updServices"
                  );
                }}
              >
                <div className="upload-slot-num" aria-hidden="true">2</div>
                <div className="upload-slot-body">
                  <div className="upload-slot-label">УПД доп. услуги</div>
                  <div className="upload-slot-desc">
                    PDF с расходами Ozon по услугам
                  </div>
                  <div className="upload-slot-meta">PDF</div>
                  {slotUpdServices ? (
                    <div className="upload-slot-file" title={slotUpdServices.name}>
                      <span className="upload-slot-file-name">
                        {slotUpdServices.name}
                      </span>
                      <button
                        type="button"
                        className="upload-slot-remove"
                        onClick={() => setSlotUpdServices(null)}
                        aria-label="Удалить файл"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="upload-slot-pick"
                      onClick={() => updServicesInputRef.current?.click()}
                    >
                      Выбрать файл
                    </button>
                  )}
                  <input
                    ref={updServicesInputRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: "none" }}
                    onChange={(e) =>
                      acceptSlot("updServices", e.target.files?.[0] ?? null)
                    }
                  />
                </div>
              </div>

              {/* Slot 3: UPD commission */}
              <div
                className={
                  "upload-slot " +
                  (slotUpdCommission ? "is-ready " : "") +
                  (dragOverSlot === "updCommission" ? "is-drag" : "")
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot("updCommission");
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOverSlot(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverSlot(null);
                  acceptDroppedFile(
                    e.dataTransfer.files?.[0] ?? null,
                    "updCommission"
                  );
                }}
              >
                <div className="upload-slot-num" aria-hidden="true">3</div>
                <div className="upload-slot-body">
                  <div className="upload-slot-label">
                    УПД агентское вознаграждение
                  </div>
                  <div className="upload-slot-desc">
                    PDF с комиссией/вознаграждением Ozon
                  </div>
                  <div className="upload-slot-meta">PDF</div>
                  {slotUpdCommission ? (
                    <div className="upload-slot-file" title={slotUpdCommission.name}>
                      <span className="upload-slot-file-name">
                        {slotUpdCommission.name}
                      </span>
                      <button
                        type="button"
                        className="upload-slot-remove"
                        onClick={() => setSlotUpdCommission(null)}
                        aria-label="Удалить файл"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="upload-slot-pick"
                      onClick={() => updCommissionInputRef.current?.click()}
                    >
                      Выбрать файл
                    </button>
                  )}
                  <input
                    ref={updCommissionInputRef}
                    type="file"
                    accept=".pdf"
                    style={{ display: "none" }}
                    onChange={(e) =>
                      acceptSlot("updCommission", e.target.files?.[0] ?? null)
                    }
                  />
                </div>
              </div>
            </div>

            <div className="upload-3-actions">
              <button
                type="button"
                className="upload-3-btn primary"
                onClick={analyzeAllThree}
                disabled={
                  combinedStatus === "processing" ||
                  !slotXlsx ||
                  !slotUpdServices ||
                  !slotUpdCommission
                }
              >
                {combinedStatus === "processing"
                  ? "Анализируем 3 файла…"
                  : "Проанализировать все 3 файла"}
              </button>
              {(slotXlsx || slotUpdServices || slotUpdCommission ||
                combinedStatus !== "idle") && (
                <button
                  type="button"
                  className="upload-3-btn ghost"
                  onClick={resetCombinedFlow}
                  disabled={combinedStatus === "processing"}
                >
                  Сбросить
                </button>
              )}
            </div>

            {combinedStatus === "success" && combinedResult && (
              <div className="upload-3-result" role="status">
                {/* Главный итог «Чистая прибыль» — сразу в зоне внимания (Задача 5).
                    Пока нет себестоимости/налога — показываем понятный next step. */}
                <div
                  className={
                    "np-hero" +
                    (netProfitReady && profitCalc
                      ? profitCalc.netProfit < 0
                        ? " neg"
                        : " pos"
                      : " pending")
                  }
                >
                  {netProfitReady && profitCalc ? (
                    <>
                      <div className="np-hero-lbl">
                        {profitCalc.netProfit < 0
                          ? "Чистый убыток"
                          : "Чистая прибыль"}
                      </div>
                      <div className="np-hero-val">
                        {profitCalc.netProfit.toLocaleString("ru-RU", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        ₽
                      </div>
                      <div className="np-hero-sub">
                        После себестоимости, налога и графика выплат · маржа{" "}
                        {profitCalc.margin.toLocaleString("ru-RU", {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}
                        %
                      </div>
                      <div className="np-hero-note" role="note">
                        <span className="np-hero-note-ico" aria-hidden="true">
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 8v5" />
                            <circle cx="12" cy="16.4" r=".6" fill="currentColor" />
                          </svg>
                        </span>
                        <span className="np-hero-note-txt">
                          Перед выводом итоговой прибыли проверьте, что загружены
                          все документы (отчёт Ozon, УПД по услугам и агентскому)
                          и заполнены себестоимость, налог и прочие расходы. Если
                          часть данных отсутствует, итог может быть неполным.
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="np-hero-lbl">Чистая прибыль</div>
                      <div className="np-hero-next">
                        Добавьте себестоимость и налог, чтобы увидеть финальную
                        чистую прибыль.
                      </div>
                      <button
                        type="button"
                        className="upload-3-btn primary np-hero-btn"
                        onClick={() => setShowProfitForm(true)}
                      >
                        Добавить себестоимость и налог →
                      </button>
                    </>
                  )}
                </div>
                <div className="upload-3-result-title">
                  ✓ Прибыль до себестоимости
                </div>
                <div className="upload-3-result-big">
                  {combinedResult.profitBeforeCost.toLocaleString("ru-RU", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  ₽
                </div>
                <div className="upload-3-result-cap">
                  Это ещё не чистая прибыль — ниже добавьте себестоимость и
                  налог.
                </div>
                <div className="upload-3-result-breakdown">
                  <div className="upload-3-row">
                    <span>Выручка (Итого реализовано)</span>
                    <span className="num">
                      +
                      {combinedResult.revenue.toLocaleString("ru-RU", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      ₽
                    </span>
                  </div>
                  <div className="upload-3-row">
                    <span>Выплаты от партнёров</span>
                    <span className="num">
                      +
                      {combinedResult.loyaltyPayouts.toLocaleString("ru-RU", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      ₽
                    </span>
                  </div>
                  <div className="upload-3-row negative">
                    <span>УПД доп. услуги</span>
                    <span className="num">
                      −
                      {combinedResult.updServicesTotal.toLocaleString("ru-RU", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      ₽
                    </span>
                  </div>
                  <div className="upload-3-row negative">
                    <span>УПД агентское вознаграждение</span>
                    <span className="num">
                      −
                      {combinedResult.updCommissionTotal.toLocaleString("ru-RU", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{" "}
                      ₽
                    </span>
                  </div>
                </div>
                <div className="upload-3-note" role="note">
                  <div className="upload-3-note-title">
                    Почему сумма может отличаться от выплаты Ozon?
                  </div>
                  <p className="upload-3-note-text">
                    M-PROF считает прибыль по отчёту реализации и УПД. Раздел
                    «Выплаты» в личном кабинете Ozon показывает сумму будущего
                    перечисления на расчётный счёт. Эти суммы могут отличаться
                    из-за отсрочки выплат, резервов, факторинга, компенсаций,
                    возвратов и переносов между периодами.
                  </p>
                </div>

                <button
                  type="button"
                  className="upload-3-btn primary"
                  onClick={() => setShowProfitForm((v) => !v)}
                  style={{ marginTop: 14 }}
                >
                  {showProfitForm
                    ? "Свернуть форму ↑"
                    : "Добавить себестоимость и налог →"}
                </button>

                {showProfitForm && profitCalc && (
                  <div className="profit-calc">
                    <div className="profit-calc-head">
                      Дополнительные расходы
                    </div>
                    <div className="form-grid profit-grid">
                      {PROFIT_EXPENSE_FIELDS.map((f) => (
                        <div className="fld" key={f.key}>
                          <label>{f.label}</label>
                          <div className="in-wrap">
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0"
                              value={profitInputs[f.key]}
                              onChange={(e) =>
                                handleProfitInput(f.key, e.target.value)
                              }
                            />
                            <span className="in-cur">{f.unit}</span>
                          </div>
                          {f.hint && (
                            <span className="fld-hint">{f.hint}</span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* График выплат Ozon — ручной выбор, влияет на чистую прибыль */}
                    <div className="payout-sched">
                      <div className="payout-sched-head">
                        <div className="payout-sched-title">
                          График выплат Ozon
                        </div>
                        <div className="payout-sched-sub">
                          Выберите график выплат, чтобы M-PROF учёл комиссию за
                          ранние выплаты или скидку за отсрочку.
                        </div>
                      </div>

                      {/* Шаг 1 — тип графика */}
                      <div className="payout-chips" role="group">
                        {(
                          [
                            { k: "standard", l: "Стандартный" },
                            { k: "early", l: "Ранняя выплата" },
                            { k: "deferred", l: "Отсрочка выплат" },
                          ] as { k: PayoutScheduleType; l: string }[]
                        ).map((t) => (
                          <button
                            key={t.k}
                            type="button"
                            className={
                              "payout-chip" +
                              (payoutSchedule.type === t.k ? " active" : "")
                            }
                            onClick={() => updatePayoutSchedule({ type: t.k })}
                          >
                            {t.l}
                          </button>
                        ))}
                      </div>

                      {/* Шаг 2a — ранняя выплата: периодичность + банк */}
                      {payoutSchedule.type === "early" && (
                        <>
                          <div className="payout-row-label">Периодичность</div>
                          <div className="payout-chips" role="group">
                            {PAYOUT_EARLY_VARIANTS.map((v) => (
                              <button
                                key={v.key}
                                type="button"
                                className={
                                  "payout-chip" +
                                  (payoutSchedule.earlyVariant === v.key
                                    ? " active"
                                    : "")
                                }
                                onClick={() =>
                                  updatePayoutSchedule({ earlyVariant: v.key })
                                }
                              >
                                {v.label}
                              </button>
                            ))}
                          </div>
                          <div className="payout-row-label">Банк получения</div>
                          <div className="payout-chips" role="group">
                            {(
                              [
                                { k: "ozon", l: "Ozon Банк" },
                                { k: "other", l: "Другой банк" },
                              ] as { k: PayoutBank; l: string }[]
                            ).map((b) => (
                              <button
                                key={b.k}
                                type="button"
                                className={
                                  "payout-chip" +
                                  (payoutSchedule.bank === b.k ? " active" : "")
                                }
                                onClick={() =>
                                  updatePayoutSchedule({ bank: b.k })
                                }
                              >
                                {b.l}
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Шаг 2b — отсрочка: срок */}
                      {payoutSchedule.type === "deferred" && (
                        <>
                          <div className="payout-row-label">Срок отсрочки</div>
                          <div className="payout-chips" role="group">
                            {PAYOUT_DEFERRED_OPTIONS.map((d) => (
                              <button
                                key={d}
                                type="button"
                                className={
                                  "payout-chip" +
                                  (payoutSchedule.deferredDays === d
                                    ? " active"
                                    : "")
                                }
                                onClick={() =>
                                  updatePayoutSchedule({ deferredDays: d })
                                }
                              >
                                {d} дн.
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      <div className="payout-hint">
                        Процент считается от суммы выручки/выплат Ozon. Проверьте
                        актуальный процент в кабинете Ozon.
                      </div>

                      <div className="payout-impact">
                        <span className="payout-impact-label">
                          Влияние на прибыль
                        </span>
                        <span
                          className={
                            "payout-impact-val" +
                            (profitCalc.payoutScheduleAdjustment > 0
                              ? " pos"
                              : profitCalc.payoutScheduleAdjustment < 0
                              ? " neg"
                              : "")
                          }
                        >
                          {profitCalc.payoutScheduleAdjustment > 0 ? "+" : ""}
                          {profitCalc.payoutScheduleAdjustment === 0
                            ? "0"
                            : profitCalc.payoutScheduleAdjustment.toLocaleString(
                                "ru-RU",
                                {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                }
                              )}{" "}
                          ₽
                          {payoutSchedule.type !== "standard" &&
                          profitCalc.payoutPercent > 0
                            ? ` · ${profitCalc.payoutPercent.toLocaleString(
                                "ru-RU",
                                { maximumFractionDigits: 2 }
                              )}%`
                            : ""}
                        </span>
                      </div>
                    </div>

                    <div
                      className={
                        "profit-summary" +
                        (profitCalc.netProfit < 0 ? " neg" : " pos")
                      }
                    >
                      <div className="profit-summary-head">
                        <span className="profit-summary-kicker">
                          {profitCalc.netProfit < 0 ? "Убыток" : "Прибыль"}
                        </span>
                        <div className="profit-summary-title">
                          Чистая прибыль
                        </div>
                        <div className="profit-summary-caption">
                          Главный итог расчёта после всех расходов
                        </div>
                      </div>
                      <div
                        className={
                          "profit-summary-big" +
                          (profitCalc.netProfit < 0 ? " neg" : "")
                        }
                      >
                        {profitCalc.netProfit.toLocaleString("ru-RU", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        ₽
                      </div>

                      <div className="profit-stats">
                        <div className="profit-stat">
                          <span className="profit-stat-label">
                            Маржинальность
                          </span>
                          <span
                            className={
                              "profit-stat-val" +
                              (profitCalc.margin < 0 ? " neg" : "")
                            }
                          >
                            {profitCalc.margin.toLocaleString("ru-RU", {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            })}
                            %
                          </span>
                        </div>
                        <div className="profit-stat">
                          <span className="profit-stat-label">ROI</span>
                          <span
                            className={
                              "profit-stat-val" +
                              (profitCalc.roi < 0 ? " neg" : "")
                            }
                          >
                            {profitCalc.roi.toLocaleString("ru-RU", {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            })}
                            %
                          </span>
                        </div>
                      </div>

                      <div className="profit-breakdown">
                        <div className="upload-3-row">
                          <span>Выручка Ozon</span>
                          <span className="num">
                            +
                            {combinedResult.revenue.toLocaleString("ru-RU", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row">
                          <span>Выплаты от партнёров</span>
                          <span className="num">
                            +
                            {combinedResult.loyaltyPayouts.toLocaleString(
                              "ru-RU",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row negative">
                          <span>Расходы Ozon по УПД</span>
                          <span className="num">
                            −
                            {combinedResult.updServicesTotal.toLocaleString(
                              "ru-RU",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row negative">
                          <span>Агентское вознаграждение</span>
                          <span className="num">
                            −
                            {combinedResult.updCommissionTotal.toLocaleString(
                              "ru-RU",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row subtotal">
                          <span>Прибыль до себестоимости</span>
                          <span className="num">
                            {combinedResult.profitBeforeCost.toLocaleString(
                              "ru-RU",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row negative">
                          <span>Себестоимость</span>
                          <span className="num">
                            −
                            {profitCalc.costPrice.toLocaleString("ru-RU", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row negative">
                          <span>
                            Налог
                            {profitCalc.taxPercent > 0
                              ? ` (${profitCalc.taxPercent.toLocaleString(
                                  "ru-RU",
                                  { maximumFractionDigits: 2 }
                                )}%)`
                              : ""}
                          </span>
                          <span className="num">
                            −
                            {profitCalc.tax.toLocaleString("ru-RU", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}{" "}
                            ₽
                          </span>
                        </div>
                        <div className="upload-3-row negative">
                          <span>Прочие расходы</span>
                          <span className="num">
                            −
                            {profitCalc.otherExpensesGroup.toLocaleString(
                              "ru-RU",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )}{" "}
                            ₽
                          </span>
                        </div>
                        <div
                          className={
                            "upload-3-row" +
                            (profitCalc.payoutScheduleAdjustment < 0
                              ? " negative"
                              : profitCalc.payoutScheduleAdjustment === 0
                              ? " payout-zero"
                              : "")
                          }
                        >
                          <span>График выплат Ozon</span>
                          <span className="num">
                            {profitCalc.payoutScheduleAdjustment > 0 ? "+" : ""}
                            {profitCalc.payoutScheduleAdjustment === 0
                              ? "0"
                              : profitCalc.payoutScheduleAdjustment.toLocaleString(
                                  "ru-RU",
                                  {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  }
                                )}{" "}
                            ₽
                          </span>
                        </div>
                      </div>
                    </div>

                    {(() => {
                      const updOk =
                        (combinedResult?.updServicesTotal ?? 0) > 0;
                      const agencyOk =
                        (combinedResult?.updCommissionTotal ?? 0) > 0;
                      const cov = reportCostCoverage;
                      const total = cov?.total ?? 0;
                      const withCost = cov?.withCost ?? 0;
                      const withoutCost = cov?.withoutCost ?? 0;
                      const hasProducts = total > 0;
                      const costWarn = hasProducts && withoutCost > 0;
                      const taxPct = profitCalc?.taxPercent ?? 0;
                      const taxWarn = taxPct <= 0;
                      const adj = profitCalc?.payoutScheduleAdjustment ?? 0;
                      const payoutType = payoutSchedule.type;
                      const reportOk = !!combinedResult;
                      const pluralTov = (n: number) => {
                        const a = Math.abs(n) % 100;
                        const b = a % 10;
                        if (a > 10 && a < 20) return "товаров";
                        if (b === 1) return "товар";
                        if (b > 1 && b < 5) return "товара";
                        return "товаров";
                      };
                      const fmtRub = (n: number) =>
                        n.toLocaleString("ru-RU", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        }) + " ₽";
                      const signedRub = (n: number) =>
                        (n > 0 ? "+" : n < 0 ? "−" : "") + fmtRub(Math.abs(n));

                      type Row = {
                        state: "ok" | "warn" | "muted";
                        label: string;
                        value?: string;
                        hint?: string;
                      };
                      const checks: Row[] = [
                        reportOk
                          ? { state: "ok", label: "Отчёт Ozon загружен" }
                          : {
                              state: "warn",
                              label: "Загрузите отчёт Ozon",
                              hint: "без него расчёт невозможен",
                            },
                        updOk
                          ? { state: "ok", label: "Расходы по УПД учтены" }
                          : {
                              state: "warn",
                              label: "Расходы по УПД не загружены",
                              hint: "прибыль может быть завышена",
                            },
                        agencyOk
                          ? {
                              state: "ok",
                              label: "Агентское вознаграждение учтено",
                            }
                          : {
                              state: "warn",
                              label: "Агентское вознаграждение не загружено",
                              hint: "прибыль может быть завышена",
                            },
                        !hasProducts
                          ? {
                              state: "muted",
                              label: "Себестоимость по товарам",
                              value: "нет данных",
                            }
                          : withoutCost === 0
                          ? {
                              state: "ok",
                              label: "Себестоимость заполнена",
                              value: `${withCost} / ${total} ${pluralTov(
                                total
                              )}`,
                            }
                          : {
                              state: "warn",
                              label: `У ${withoutCost} ${pluralTov(
                                withoutCost
                              )} нет себестоимости`,
                              value: `${withCost} / ${total} ${pluralTov(
                                total
                              )}`,
                              hint: "чистая прибыль может быть неточной",
                            },
                        payoutType === "early"
                          ? {
                              state: "warn",
                              label: `График выплат Ozon: ${payoutScheduleLabel(
                                payoutSchedule
                              )}`,
                              value: signedRub(adj),
                              hint: "ранняя выплата уменьшает прибыль · проверьте график перед сохранением",
                            }
                          : payoutType === "deferred"
                          ? {
                              state: "ok",
                              label: `График выплат Ozon: ${payoutScheduleLabel(
                                payoutSchedule
                              )}`,
                              value: signedRub(adj),
                              hint: "отсрочка увеличивает прибыль · проверьте график перед сохранением",
                            }
                          : {
                              state: "ok",
                              label: "График выплат Ozon: Стандартный",
                              value: "0 ₽",
                              hint: "корректировка 0 ₽ · обязательно проверьте график выплат перед сохранением",
                            },
                        taxWarn
                          ? {
                              state: "warn",
                              label: "Налог не указан",
                              hint: "итоговая прибыль может быть завышена",
                            }
                          : {
                              state: "ok",
                              label: "Налог указан",
                              value: `${taxPct.toLocaleString("ru-RU", {
                                maximumFractionDigits: 2,
                              })}%`,
                            },
                      ];

                      const critical = !reportOk || !updOk || !agencyOk;
                      const inaccurate = costWarn || taxWarn;
                      const missingCore: string[] = [];
                      if (!reportOk) missingCore.push("отчёт Ozon");
                      if (!updOk) missingCore.push("расходы по УПД");
                      if (!agencyOk)
                        missingCore.push("агентское вознаграждение");
                      const softIssues: string[] = [];
                      if (costWarn)
                        softIssues.push(
                          `${withoutCost} ${pluralTov(
                            withoutCost
                          )} без себестоимости`
                        );
                      if (taxWarn) softIssues.push("не указан налог");
                      const icoFor = (s: Row["state"]) =>
                        s === "ok" ? "✓" : s === "warn" ? "⚠" : "•";

                      return (
                        <div className="calc-check">
                          <div className="calc-check-title">
                            Проверка расчёта
                          </div>
                          <div className="calc-check-list">
                            {checks.map((c, i) => (
                              <div
                                key={i}
                                className={"calc-check-row " + c.state}
                              >
                                <span className="calc-check-ico">
                                  {icoFor(c.state)}
                                </span>
                                <div className="calc-check-body">
                                  <div className="calc-check-line">
                                    <span className="calc-check-label">
                                      {c.label}
                                    </span>
                                    {c.value && (
                                      <span className="calc-check-val">
                                        {c.value}
                                      </span>
                                    )}
                                  </div>
                                  {c.hint && (
                                    <div className="calc-check-hint">
                                      {c.hint}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                          {critical ? (
                            <div className="calc-check-status warn">
                              <span className="calc-check-status-ico">⚠</span>
                              <span>
                                <b>Недостаточно данных для точного расчёта</b>
                                <em>
                                  Не загружено: {missingCore.join(", ")}.
                                  Сохранить можно, но прибыль будет неточной.
                                </em>
                              </span>
                            </div>
                          ) : inaccurate ? (
                            <div className="calc-check-status warn">
                              <span className="calc-check-status-ico">⚠</span>
                              <span>
                                <b>
                                  Расчёт можно сохранить, но он может быть
                                  неточным
                                </b>
                                <em>Проверьте: {softIssues.join(", ")}.</em>
                              </span>
                            </div>
                          ) : (
                            <div className="calc-check-status ok">
                              <span className="calc-check-status-ico">✓</span>
                              <span>
                                <b>Расчёт готов к сохранению</b>
                                <em>Все ключевые данные на месте.</em>
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div className="save-hint">
                      <span className="save-hint-ico" aria-hidden="true">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <polyline points="12 7 12 12 15.5 14" />
                        </svg>
                      </span>
                      <span className="save-hint-text">
                        После сохранения расчёт появится в истории: период
                        отчёта, чистая прибыль, маржинальность, график выплат
                        Ozon и статус точности.
                      </span>
                    </div>

                    <button
                      type="button"
                      className="upload-3-btn primary"
                      onClick={saveProfitResult}
                      disabled={profitSaving}
                      style={{ marginTop: 14, width: "100%" }}
                    >
                      {profitSaving
                        ? "Сохранение…"
                        : profitSaved
                        ? "Сохранено ✓"
                        : "Сохранить результат"}
                    </button>

                    <div className="save-hint">
                      <span className="save-hint-ico" aria-hidden="true">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <polyline points="12 7 12 12 15.5 14" />
                        </svg>
                      </span>
                      <span className="save-hint-text">
                        PDF-отчёт содержит итоговую чистую прибыль,
                        маржинальность, ROI, разбивку расчёта, график выплат
                        Ozon и ключевые товары.
                      </span>
                    </div>

                    <button
                      type="button"
                      className="upload-3-btn ghost"
                      onClick={downloadProfitPdf}
                      style={{ marginTop: 10, width: "100%" }}
                    >
                      Скачать PDF-отчёт
                    </button>
                  </div>
                )}
              </div>
            )}

            {combinedStatus === "error" && (
              <div className="upload-3-error" role="alert">
                <div className="upload-3-error-title">Ошибка анализа</div>
                <p className="upload-3-error-sub">
                  {combinedError ||
                    "Не удалось разобрать один из файлов. Проверьте формат."}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Чистая прибыль по товарам — себестоимость из каталога по sku +
            распределение общих расходов отчёта пропорционально выручке.
            Показывается, когда в распарсенном отчёте есть per-SKU строки. */}
        {reportProducts.length > 0 && (
          <OzonProductBreakdown
            products={reportProducts}
            estimate={reportEstimate}
            user={user}
            onCogsTotal={handleReportCogsTotal}
            onKeyProducts={handleReportKeyProducts}
            onCostCoverage={handleReportCostCoverage}
          />
        )}

        {/* Отдельный блок месячной сводки («Динамика прибыли») убран с экрана:
            у продавца бывает несколько магазинов/отчётов и несколько загрузок
            за месяц — отдельная сводка может вводить в заблуждение. Месяцы
            смотрим через фильтр в «Последние расчёты» (привязка к отчётам).
            Данные в report_history (Supabase) сохраняются как прежде. */}

        {calcMode === "upload" &&
          uploadedReports.length > 0 &&
          (uploadStatus === "idle" || uploadStatus === "success") && (
            <div className="upload-recent">
              <div className="upload-recent-head">
                <span className="upload-recent-title">Недавние загрузки</span>
                <span className="upload-recent-count">
                  {uploadedReports.length}
                </span>
              </div>
              <div className="upload-recent-grid">
                {uploadedReports.map((r) => (
                  <div className="upload-recent-card" key={r.id}>
                    <div className="upload-recent-row">
                      <span
                        className={"upload-mp-badge sm " + r.marketplace}
                        title={r.marketplace === "ozon" ? "Ozon" : "Wildberries"}
                      >
                        <span className="upload-mp-dot" />
                        {r.marketplace === "ozon" ? "Ozon" : "WB"}
                      </span>
                      <span className="upload-recent-status">обработан</span>
                    </div>
                    <div className="upload-recent-name" title={r.filename}>
                      {r.filename}
                    </div>
                    <div className="upload-recent-foot">
                      <span
                        className={
                          "upload-recent-profit " + (r.profit >= 0 ? "pos" : "neg")
                        }
                      >
                        {r.profit >= 0 ? "+" : "−"}
                        {fmt(Math.abs(r.profit))} ₽
                      </span>
                      <span className="upload-recent-date">{r.date}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        {/* Тарифный блок лендинга для НЕвошедших гостей (logged-out). Для вошедших
            пользователей тарифы/покупка живут во вкладке «Личный кабинет», поэтому
            здесь блок гейтится по !user. Показ зависит от прав (entitlements):
            • не unlimited И (есть single-кредит ИЛИ нет доступа) → карточки покупки;
            • иначе (free с остатком бесплатного расчёта) → ничего.
            entitlementsLoaded-гейт убирает мерцание до ответа Supabase. */}
        {!user && entitlementsLoaded && hasPremium && !unlimitedBannerHidden && (
          <div className="card tariff-card tariff-status" id="dash-tariff-status">
            <button
              type="button"
              className="tariff-status-x"
              onClick={hideUnlimitedBanner}
              aria-label="Скрыть блок тарифа"
              title="Скрыть"
            >
              ×
            </button>
            <div className="tariff-status-head">
              <span className="tariff-status-badge">Активно</span>
              <div className="tariff-status-title">Ваш тариф: Безлимит</div>
            </div>
            <p className="tariff-status-text">
              Вы можете выполнять неограниченное количество расчётов до окончания
              подписки.
            </p>
            <ul className="tariff-list tariff-status-list">
              <li>Неограниченное количество расчётов</li>
              <li>Полная история без ограничений</li>
              <li>Приоритетный доступ к новым функциям</li>
            </ul>
            {formatRuDate(premiumUntil) && (
              <p className="tariff-status-until">
                Активен до: <strong>{formatRuDate(premiumUntil)}</strong>
              </p>
            )}
          </div>
        )}

        {!user &&
          entitlementsLoaded &&
          !hasPremium &&
          (singleCredits > 0 || !canCalculate) && (
            <div className="card tariff-card" id="dash-tariffs">
              <div className="card-head">
                <div className="card-title">
                  {singleCredits > 0 ? "Расширить доступ" : "Тарифы"}
                </div>
              </div>

              <div className="tariff-grid tariff-grid-2">
                <div className="tariff-item">
                  <div className="tariff-name">Разовый расчёт</div>
                  <div className="tariff-price">
                    <em>149</em> ₽
                  </div>
                  <div className="tariff-period">Один платёж</div>
                  <ul className="tariff-list">
                    <li>Один расчёт по отчёту или вручную</li>
                    <li>Без Ozon API-расчёта (только файл или ручной ввод)</li>
                    <li>Сохранение результата в историю</li>
                    <li>Без подписки и автосписаний</li>
                  </ul>
                  <button
                    type="button"
                    className="tariff-btn"
                    onClick={() => handleTariff("single")}
                  >
                    {singleCredits > 0
                      ? "Купить ещё разовый расчёт 149₽"
                      : "Разовый расчёт 149₽"}
                  </button>
                </div>

                <div className="tariff-item featured">
                  <span className="tariff-shine" aria-hidden="true" />
                  <span className="tariff-badge">Выгодно</span>
                  <div className="tariff-name">Безлимит</div>
                  <div className="tariff-price">
                    <em>449</em> ₽<span className="tariff-month">/мес</span>
                  </div>
                  <div className="tariff-period">Подписка на 30 дней</div>
                  <ul className="tariff-list">
                    <li>Неограниченное число расчётов в месяц</li>
                    <li>Расчёты по Ozon API (автозагрузка данных)</li>
                    <li>AI-аналитика и рекомендации (в ближайших обновлениях)</li>
                    <li>Полная история и графики без ограничений</li>
                  </ul>
                  <button
                    type="button"
                    className="tariff-btn primary"
                    onClick={() => handleTariff("unlimited")}
                  >
                    {singleCredits > 0
                      ? "Оформить безлимит 449₽"
                      : "Безлимит 449₽"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* FAQ: почему API и загрузка отчётов могут давать разные значения */}
          <details className="faq-disc">
            <summary>
              Почему расчёт через API и загрузку отчётов может отличаться?
            </summary>
            <div className="faq-disc-body">
              Это два разных способа расчёта. Загрузка отчётов использует
              документы Ozon и удобна для сверки с бухгалтерией. API использует
              финансовые операции Ozon и удобен для быстрой автоматической
              проверки месяца. Чтобы расчёты были максимально близкими,
              используйте один и тот же месяц, полностью заполните себестоимость
              по всем товарам и указывайте одинаковые ручные расходы. Небольшие
              расхождения из-за разных источников данных, периода операций,
              возвратов, бонусов и округлений являются нормальными.
            </div>
          </details>
          </>
        )}

        {user && mainTab === "reports" && (
          <>

        {isLoadingHistory && (
          <div className="card hist-card">
            <div className="card-head">
              <div className="card-title">Последние расчёты</div>
            </div>
            <div className="card-body" role="status" aria-live="polite">
              <div
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                <span className="auth-loading-ring" aria-hidden="true" />
                <span>Загружаем историю расчётов…</span>
              </div>
              {historySlow && (
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: "13px",
                    color: "var(--txt3)",
                    lineHeight: 1.5,
                  }}
                >
                  История загружается дольше обычного. Проверьте интернет или
                  попробуйте обновить страницу.
                </p>
              )}
            </div>
          </div>
        )}

        {!isLoadingHistory && historyError && history.length === 0 && (
          <div className="card hist-card">
            <div className="card-head">
              <div className="card-title">Последние расчёты</div>
            </div>
            <div className="hist-filter-empty" role="alert">
              <p style={{ margin: "0 0 12px" }}>
                Не удалось загрузить историю расчётов. Проверьте интернет и
                попробуйте ещё раз.
              </p>
              <button
                type="button"
                className="auth-reset-btn"
                onClick={retryLoadHistory}
              >
                Повторить
              </button>
            </div>
          </div>
        )}

        {!isLoadingHistory && !historyError && history.length === 0 && (
          <div className="card hist-card">
            <div className="card-head">
              <div className="card-title">Последние расчёты</div>
            </div>
            <div className="hist-filter-empty">
              Здесь появятся ваши расчёты после первого сохранения
            </div>
          </div>
        )}

        {!isLoadingHistory && history.length > 0 && (
          <div className="card hist-card">
            <div className="card-head">
              <div className="card-title">Последние расчёты</div>
              <button
                type="button"
                className="hist-clear"
                onClick={clearHistory}
              >
                <svg
                  className="hist-clear-ic"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                </svg>
                Очистить историю
              </button>
            </div>

            <div className="hist-tools">
              <div className="hist-search">
                <svg
                  className="hist-search-ic"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  type="search"
                  className="hist-search-input"
                  value={histSearch}
                  onChange={(e) => setHistSearch(e.target.value)}
                  placeholder="Поиск по периоду, дате или типу расчёта"
                  aria-label="Поиск по истории расчётов"
                />
                {histSearch && (
                  <button
                    type="button"
                    className="hist-search-clear"
                    aria-label="Очистить поиск"
                    onClick={() => setHistSearch("")}
                  >
                    ×
                  </button>
                )}
              </div>
              <div
                className="filter-pills"
                role="group"
                aria-label="Быстрый фильтр по прибыли"
              >
                {(
                  [
                    ["all", "Все"],
                    ["net", "С чистой прибылью"],
                    ["before", "Прибыль до себестоимости"],
                    ["loss", "Убыток"],
                  ] as [HistProfitFilter, string][]
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={
                      "filter-pill" + (histProfitFilter === v ? " active" : "")
                    }
                    aria-pressed={histProfitFilter === v}
                    onClick={() => setHistProfitFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {monthOptions.length >= 2 && (
                <div className="hist-month" ref={monthMenuRef}>
                  <button
                    type="button"
                    className={
                      "hist-month-trigger" +
                      (filterMonth !== "all" ? " active" : "")
                    }
                    aria-haspopup="listbox"
                    aria-expanded={monthMenuOpen}
                    aria-label="Фильтр по месяцу отчёта"
                    onClick={() => setMonthMenuOpen((o) => !o)}
                  >
                    <span>
                      {filterMonth === "all"
                        ? "Все месяцы"
                        : formatMonthLabel(filterMonth)}
                    </span>
                    <svg
                      className="hist-month-chev"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {monthMenuOpen && (
                    <div
                      className="hist-month-menu"
                      role="listbox"
                      aria-label="Месяц отчёта"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={filterMonth === "all"}
                        className={
                          "hist-month-opt" +
                          (filterMonth === "all" ? " active" : "")
                        }
                        onClick={() => {
                          setFilterMonth("all");
                          setMonthMenuOpen(false);
                        }}
                      >
                        Все месяцы
                      </button>
                      {monthOptions.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          role="option"
                          aria-selected={filterMonth === m.key}
                          className={
                            "hist-month-opt" +
                            (filterMonth === m.key ? " active" : "")
                          }
                          onClick={() => {
                            setFilterMonth(m.key);
                            setMonthMenuOpen(false);
                          }}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {visibleHistory.length === 0 ? (
              <div className="hist-filter-empty">Расчёты не найдены</div>
            ) : (
            <div className="hist-list">
              {visibleHistory.map((h) => {
                const removing = removingIds.has(h.id);
                // Разбор upload-расчёта из ai_insights. null → API/ручной/старый расчёт.
                const breakdown = asNetProfitBreakdown(h.aiInsights);
                const isReport = !!breakdown;
                // Введена ли себестоимость → прибыль уже «чистая»; иначе «до себестоимости».
                const hasCost = (breakdown?.costPrice ?? 0) > 0;
                // Тип расчёта определяем по сохранённому mode (api/upload/manual), а НЕ
                // по наличию breakdown: иначе API-расчёт (breakdown=null) подписывался
                // как «Ручной расчёт». На формулы/сохранение не влияет — только подпись.
                const calcMode: CloudCalcMode = h.mode ?? "manual";
                // Короткий бейдж типа расчёта; маркетплейс показывает соседний .hist-mp.
                const typeLabel =
                  calcMode === "api"
                    ? "API"
                    : calcMode === "upload"
                    ? "Документы"
                    : "Ручной";
                // Месяц расчёта через исправленный calcMonthKey: upload→период отчёта,
                // API→period.month, иначе→месяц создания. null → «не указан».
                const monthKey = calcMonthKey(h);
                const monthLabel = monthKey ? formatMonthLabel(monthKey) : null;
                // Дата создания записи в формате ДД.ММ.ГГГГ (с безопасным фолбэком).
                const createdDate = (() => {
                  if (!h.createdAt) return h.date;
                  const d = new Date(h.createdAt);
                  return Number.isNaN(d.getTime())
                    ? h.date
                    : d.toLocaleDateString("ru-RU");
                })();
                const profitLabel =
                  isReport && !hasCost
                    ? "Прибыль до себестоимости"
                    : "Чистая прибыль";
                const expanded = expandedHist.has(h.id);
                const detailRows = buildHistDetailRows(h, breakdown);
                return (
                  <div
                    className={
                      "hist-item" +
                      (removing ? " hist-removing" : "") +
                      (selectedId === h.id ? " active" : "")
                    }
                    key={h.id}
                    onClick={() => loadCalcIntoCalculator(h)}
                  >
                    <div className="hist-row">
                      <div className={"hist-mp " + h.marketplace}>
                        {h.marketplace === "ozon" ? "Ozon" : "WB"}
                      </div>

                      <div className="hist-info">
                        <div className="hist-rev">
                          <span
                            className={"hist-type-badge hist-type-" + calcMode}
                          >
                            {typeLabel}
                          </span>
                        </div>
                        <div className="hist-period">
                          {monthLabel
                            ? `Месяц расчёта: ${monthLabel}`
                            : "Месяц расчёта: не указан"}
                        </div>
                        <div className="hist-revenue">
                          Выручка: {fmt(h.revenue)} ₽
                        </div>
                        <div className="hist-date">Создан: {createdDate}</div>
                      </div>

                      <div
                        className={
                          "hist-profit " + (h.profit >= 0 ? "pos" : "neg")
                        }
                      >
                        <span className="hist-profit-label">{profitLabel}</span>
                        <span className="hist-profit-num">
                          {h.profit >= 0 ? "+" : "−"}
                          {fmt(Math.abs(h.profit))} ₽
                        </span>
                        <span className="hm">
                          Маржа: {h.margin.toFixed(1)}%
                        </span>
                      </div>

                      <button
                        type="button"
                        className={"hist-toggle" + (expanded ? " open" : "")}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHistDetails(h.id);
                        }}
                        aria-expanded={expanded}
                        aria-label={
                          expanded ? "Скрыть подробности" : "Показать подробности"
                        }
                        title="Подробнее"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M4 6l4 4 4-4"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className="hist-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteHistoryItem(h.id);
                        }}
                        disabled={removing}
                        aria-label="Удалить расчёт"
                        title="Удалить"
                      >
                        {removing ? <span className="hist-del-spin" /> : "×"}
                      </button>
                    </div>

                    {expanded && (
                      <div
                        className="hist-details"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {detailRows.map((r, i) => (
                          <div key={i} className={"hd-row hd-" + r.kind}>
                            <span className="hd-label">{r.label}</span>
                            <span className="hd-val">{histDetailValue(r)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </div>
        )}
          </>
        )}

        {user && mainTab === "catalog" && (
          <ProductCatalog user={user} showToast={showToast} />
        )}

        {/* PR #26: вкладка «Личный кабинет». Гейтится по user (для гостя её нет —
            показывается карточка входа выше), поэтому внутри user уже не null.
            Покупка тарифов и подключение Ozon API живут здесь; вкладка «Расчёт»
            только потребляет статус. Бэкенд/handlers переиспользуются как есть. */}
        {user &&
          mainTab === "cabinet" &&
          (() => {
            const remaining = Math.max(
              0,
              freeCalculationsLimit + singleCredits - calcCount,
            );
            const planLabel = !entitlementsLoaded
              ? "…"
              : hasPremium
              ? "Безлимит"
              : singleCredits > 0
              ? "Разовые расчёты"
              : "Бесплатный";
            return (
              <div className="cab-wrap">
                <div className="cab-head">
                  <h2 className="cab-h">Личный кабинет</h2>
                  <p className="cab-sub">
                    Профиль, тариф и подключение Ozon API — в одном месте.
                  </p>
                </div>

                <div className="cab-grid">
                  {/* Профиль и информация по аккаунту */}
                  <div className="cab-card">
                    <div className="cab-card-head">
                      <span className="cab-card-ico" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="8" r="3.4" />
                          <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
                        </svg>
                      </span>
                      <div className="cab-card-title">Профиль</div>
                    </div>
                    <div className="cab-rows">
                      <div className="cab-row">
                        <span className="cab-k">Email</span>
                        <span className="cab-v">{user.email}</span>
                      </div>
                      <div className="cab-row">
                        <span className="cab-k">Текущий тариф</span>
                        <span className="cab-v">{planLabel}</span>
                      </div>
                      <div className="cab-row">
                        <span className="cab-k">Доступно расчётов</span>
                        <span className="cab-v">
                          {!entitlementsLoaded
                            ? "…"
                            : hasPremium
                            ? "Без ограничений"
                            : String(remaining)}
                        </span>
                      </div>
                      {hasPremium && formatRuDate(premiumUntil) && (
                        <div className="cab-row">
                          <span className="cab-k">Подписка до</span>
                          <span className="cab-v">
                            {formatRuDate(premiumUntil)}
                          </span>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="api-pro-btn ghost"
                      onClick={signOut}
                      disabled={signingOut}
                      aria-busy={signingOut}
                      style={{ width: "100%", marginTop: "1.1rem" }}
                    >
                      {signingOut ? "Выходим…" : "Выйти из аккаунта"}
                    </button>
                  </div>

                  {/* Тариф: статус + покупка */}
                  <div className="cab-card">
                    <div className="cab-card-head">
                      <span className="cab-card-ico" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7-7V4h9.6l7.4 7.4a2 2 0 0 1 0 2z" />
                          <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
                        </svg>
                      </span>
                      <div className="cab-card-title">Тариф</div>
                    </div>

                    {!entitlementsLoaded ? (
                      <p className="cab-muted">Загружаем данные тарифа…</p>
                    ) : hasPremium ? (
                      <>
                        <div className="cab-tariff-status">
                          <span className="cab-badge ok">Активно</span>
                          <span className="cab-tariff-name">
                            Тариф: Безлимит
                          </span>
                        </div>
                        <p className="cab-muted" style={{ marginTop: ".7rem" }}>
                          Неограниченное количество расчётов
                          {formatRuDate(premiumUntil)
                            ? ` до ${formatRuDate(premiumUntil)}`
                            : ""}
                          .
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="cab-tariff-status">
                          <span className="cab-badge">
                            {singleCredits > 0 ? "Разовые" : "Бесплатный"}
                          </span>
                          <span className="cab-tariff-name">
                            {singleCredits > 0
                              ? "Разовые расчёты"
                              : "Бесплатный доступ"}
                          </span>
                        </div>
                        <p className="cab-muted" style={{ marginTop: ".7rem" }}>
                          {remaining > 0
                            ? `Доступно расчётов: ${remaining}`
                            : "Лимит расчётов исчерпан — оформите тариф ниже."}
                        </p>
                        <div className="cab-tariff-actions">
                          <button
                            type="button"
                            className="api-pro-btn ghost"
                            onClick={() => handleTariff("single")}
                          >
                            Разовый — 149&nbsp;₽
                          </button>
                          <button
                            type="button"
                            className="api-pro-btn"
                            onClick={() => handleTariff("unlimited")}
                          >
                            Безлимит — 449&nbsp;₽
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Подключение Ozon API — на всю ширину */}
                  <div className="cab-card cab-card-wide">
                    <div className="cab-card-head">
                      <span className="cab-card-ico" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="5" width="16" height="14" rx="2" />
                          <path d="M4 9.5h16" />
                          <circle cx="7" cy="7.2" r=".6" fill="currentColor" stroke="none" />
                        </svg>
                      </span>
                      <div className="cab-card-title">Подключение Ozon API</div>
                    </div>
                    <p className="cab-muted" style={{ marginBottom: "1rem" }}>
                      Ключ хранится в зашифрованном виде и в браузер не
                      возвращается — видны только статус и маска. После подключения
                      авторасчёт по API доступен во вкладке «Расчёт».
                    </p>

                    {ozonConnLoading ? (
                      <p className="api-pro-msg" style={{ marginTop: ".2rem" }}>
                        Проверяем подключение…
                      </p>
                    ) : ozonConn?.connected ? (
                      <>
                        <div className="api-conn-ok" role="status">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                          </svg>
                          <span>
                            <b>Ozon подключён</b>
                            <span className="api-conn-ok-meta">
                              {ozonConn.clientIdMasked ? ` · Client ID ${ozonConn.clientIdMasked}` : ""}
                              {ozonConn.keyLast4 ? ` · ключ ••••${ozonConn.keyLast4}` : ""}
                            </span>
                          </span>
                        </div>
                        <div className="api-pro-actions">
                          <button
                            type="button"
                            className="api-pro-btn ghost"
                            onClick={verifyOzon}
                            disabled={ozonBusy !== "idle"}
                          >
                            {ozonBusy === "checking" ? (
                              <>
                                <span className="spin" />
                                Проверяем…
                              </>
                            ) : (
                              "Проверить подключение"
                            )}
                          </button>
                          <button
                            type="button"
                            className="api-pro-btn danger"
                            onClick={deleteOzon}
                            disabled={ozonBusy !== "idle"}
                          >
                            {ozonBusy === "deleting" ? "Отключаем…" : "Отключить"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {ozonConn && ozonConn.status !== "not_connected" && (
                          <div className="api-alert err" role="alert">
                            <span className="api-alert-ico">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 8v5" />
                                <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
                              </svg>
                            </span>
                            <span className="api-alert-text">
                              {ozonConn.status === "invalid_key"
                                ? "Неверный ключ — переподключите кабинет"
                                : ozonConn.status === "forbidden"
                                ? "Недостаточно прав у ключа — проверьте доступы в Ozon"
                                : ozonConn.status === "unavailable"
                                ? "Ozon временно недоступен — попробуйте позже"
                                : "Кабинет не подключён"}
                            </span>
                          </div>
                        )}

                        <div className="api-pro-grid">
                          <div className="api-fld">
                            <label>Ozon Client ID</label>
                            <input
                              className="api-input"
                              type="text"
                              placeholder="Например, 123456"
                              value={ozonClientId}
                              onChange={(e) => setOzonClientId(e.target.value)}
                              disabled={ozonBusy !== "idle"}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>

                          <div className="api-fld">
                            <label>Ozon API Key</label>
                            <div className="api-secret">
                              <input
                                className="api-input"
                                type={showOzonKey ? "text" : "password"}
                                placeholder="Вставьте секретный ключ"
                                value={ozonApiKey}
                                onChange={(e) => setOzonApiKey(e.target.value)}
                                disabled={ozonBusy !== "idle"}
                                autoComplete="off"
                                spellCheck={false}
                              />
                              <button
                                type="button"
                                className="api-eye"
                                onClick={() => setShowOzonKey((v) => !v)}
                                disabled={ozonBusy !== "idle"}
                                aria-label={showOzonKey ? "Скрыть ключ" : "Показать ключ"}
                                title={showOzonKey ? "Скрыть" : "Показать"}
                              >
                                {showOzonKey ? eyeOffIcon : eyeIcon}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="api-pro-actions" style={{ gridTemplateColumns: "1fr", marginTop: "1rem" }}>
                          <button
                            type="button"
                            className="api-pro-btn"
                            onClick={connectOzon}
                            disabled={ozonBusy !== "idle"}
                          >
                            {ozonBusy === "connecting" ? (
                              <>
                                <span className="spin" />
                                Подключаем…
                              </>
                            ) : (
                              "Подключить Ozon"
                            )}
                          </button>
                        </div>
                      </>
                    )}

                    {ozonConnError && (
                      <p className="api-pro-msg err" style={{ marginTop: ".8rem" }}>
                        {ozonConnError}
                      </p>
                    )}
                  </div>

                  {/* Ozon Performance API — реклама и продвижение — на всю ширину.
                      Скрыт флагом SHOW_PERFORMANCE_API_BLOCK (см. верх файла):
                      реклама уже учтена через Seller finance, отдельный справочный
                      блок только путал. Backend/подключение/таблицы НЕ тронуты. */}
                  {SHOW_PERFORMANCE_API_BLOCK && (
                  <div className="cab-card cab-card-wide">
                    <div className="cab-card-head">
                      <span className="cab-card-ico" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1Z" />
                          <path d="M16 9a4 4 0 0 1 0 6" />
                        </svg>
                      </span>
                      <div className="cab-card-title">Ozon Performance API — реклама и продвижение</div>
                    </div>
                    <p className="cab-muted" style={{ marginBottom: "1rem" }}>
                      Нужно для автоматического учёта расходов на рекламу Ozon. На
                      этом этапе подключение только проверяется, в расчёт прибыли
                      реклама ещё не добавляется. Client Secret хранится в
                      зашифрованном виде и в браузер не возвращается — видны только
                      статус и маска.
                    </p>

                    {perfConnLoading ? (
                      <p className="api-pro-msg" style={{ marginTop: ".2rem" }}>
                        Проверяем подключение…
                      </p>
                    ) : perfConn?.connected ? (
                      <>
                        <div className="api-conn-ok" role="status">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                          </svg>
                          <span>
                            <b>Performance API подключён</b>
                            <span className="api-conn-ok-meta">
                              {perfConn.clientIdMasked ? ` · Client ID ${perfConn.clientIdMasked}` : ""}
                              {perfConn.secretLast4 ? ` · секрет ••••${perfConn.secretLast4}` : ""}
                            </span>
                          </span>
                        </div>
                        <div className="api-pro-actions">
                          <button
                            type="button"
                            className="api-pro-btn ghost"
                            onClick={verifyPerformance}
                            disabled={perfBusy !== "idle"}
                          >
                            {perfBusy === "checking" ? (
                              <>
                                <span className="spin" />
                                Проверяем…
                              </>
                            ) : (
                              "Проверить подключение"
                            )}
                          </button>
                          <button
                            type="button"
                            className="api-pro-btn danger"
                            onClick={deletePerformance}
                            disabled={perfBusy !== "idle"}
                          >
                            {perfBusy === "deleting" ? "Отключаем…" : "Отключить"}
                          </button>
                        </div>

                        {/* PR #44: справочный расход рекламы за месяц — read-only.
                            Сумма НЕ входит в прибыль и никуда не сохраняется. */}
                        <div className="ads-diag">
                          <div className="ads-diag-head">
                            Расход рекламы за месяц (справочно)
                          </div>
                          <p className="ads-diag-hint">
                            Покажем расход на рекламу Ozon Performance API за выбранный
                            месяц. Справочно — в этом обновлении реклама ещё не
                            вычитается из чистой прибыли.
                          </p>
                          <div className="ads-diag-row">
                            <input
                              className="api-input ads-diag-month"
                              type="month"
                              value={adsMonth}
                              onChange={(e) => setAdsMonth(e.target.value)}
                              disabled={adsBusy}
                              aria-label="Месяц для проверки расхода рекламы"
                            />
                            <button
                              type="button"
                              className="api-pro-btn ghost"
                              onClick={checkAdsSpend}
                              disabled={adsBusy}
                            >
                              {adsBusy ? (
                                <>
                                  <span className="spin" />
                                  Считаем…
                                </>
                              ) : (
                                "Проверить расход рекламы за месяц"
                              )}
                            </button>
                          </div>

                          {adsResult &&
                            (adsResult.status === "ok" ? (
                              <div className="ads-diag-result">
                                <div className="ads-diag-line">
                                  <span>Месяц</span>
                                  <b>{adsResult.month}</b>
                                </div>
                                <div className="ads-diag-line ads-diag-total">
                                  <span>Расход рекламы (Performance API)</span>
                                  <b>
                                    {adsResult.adsSpend.toLocaleString("ru-RU", {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}{" "}
                                    ₽
                                  </b>
                                </div>
                                <div className="ads-diag-line">
                                  <span>Кампаний</span>
                                  <b>{adsResult.campaignsCount}</b>
                                </div>
                                <div className="ads-diag-line">
                                  <span>Строк отчёта</span>
                                  <b>{adsResult.rowsCount}</b>
                                </div>
                                <p className="ads-diag-note">
                                  Справочно. В этом PR реклама ещё не вычитается из
                                  прибыли.
                                </p>
                                {adsResult.rowsCount === 0 && adsResult.detail && (
                                  <p className="ads-diag-diag">
                                    Диагностика (0 строк): {adsResult.detail}
                                  </p>
                                )}
                              </div>
                            ) : adsResult.status === "no_campaigns" ? (
                              <div className="ads-diag-result">
                                <div className="ads-diag-line ads-diag-total">
                                  <span>Расход рекламы (Performance API)</span>
                                  <b>0,00 ₽</b>
                                </div>
                                <p className="ads-diag-info">
                                  Кампаний не найдено — расход рекламы за месяц 0 ₽.
                                </p>
                                <p className="ads-diag-note">
                                  Справочно. В этом PR реклама ещё не вычитается из
                                  прибыли.
                                </p>
                              </div>
                            ) : adsResult.status === "pending" ? (
                              <>
                                <p className="ads-diag-info">
                                  Отчёт рекламы ещё формируется, попробуйте позже.
                                </p>
                                {adsResult.reused && (
                                  <p className="ads-diag-diag">
                                    Продолжаем ожидание ранее заказанного отчёта.
                                  </p>
                                )}
                              </>
                            ) : adsResult.status === "not_connected" ? (
                              <p className="ads-diag-info">
                                Performance API не подключён.
                              </p>
                            ) : adsResult.status === "invalid_connection" ? (
                              <p className="ads-diag-info">
                                Не удалось получить токен — переподключите Performance
                                API.
                              </p>
                            ) : adsResult.status === "rate_limited" ? (
                              <>
                                <p className="ads-diag-info">
                                  Ozon ограничил частоту запросов. Попробуйте позже.
                                </p>
                                {adsResult.stage && (
                                  <p className="ads-diag-diag">
                                    Диагностика: этап «
                                    {ADS_STAGE_LABELS[adsResult.stage]}»
                                    {adsResult.httpStatus
                                      ? `, код ${adsResult.httpStatus}`
                                      : ""}
                                    {typeof adsResult.retryAfterSec === "number"
                                      ? ` — повтор через ~${adsResult.retryAfterSec} сек`
                                      : ""}
                                  </p>
                                )}
                              </>
                            ) : (
                              <>
                                <p className="ads-diag-info">
                                  Performance API временно недоступен — попробуйте
                                  позже.
                                </p>
                                {adsResult.stage && (
                                  <p className="ads-diag-diag">
                                    Диагностика: этап «
                                    {ADS_STAGE_LABELS[adsResult.stage]}»
                                    {adsResult.httpStatus
                                      ? `, код ${adsResult.httpStatus}`
                                      : ""}
                                    {adsResult.detail
                                      ? ` — ${adsResult.detail}`
                                      : ""}
                                  </p>
                                )}
                              </>
                            ))}

                          {adsError && (
                            <p
                              className="api-pro-msg err"
                              style={{ marginTop: ".6rem" }}
                            >
                              {adsError}
                            </p>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        {perfConn && perfConn.status !== "not_connected" && (
                          <div className="api-alert err" role="alert">
                            <span className="api-alert-ico">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 8v5" />
                                <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
                              </svg>
                            </span>
                            <span className="api-alert-text">
                              {perfConn.status === "invalid_key"
                                ? "Неверный Client ID или Client Secret — переподключите"
                                : perfConn.status === "forbidden"
                                ? "Недостаточно прав у кредов — проверьте доступ Performance API"
                                : perfConn.status === "unavailable"
                                ? "Performance API временно недоступен — попробуйте позже"
                                : "Performance API не подключён"}
                            </span>
                          </div>
                        )}

                        <div className="api-pro-grid">
                          <div className="api-fld">
                            <label>Performance Client ID</label>
                            <input
                              className="api-input"
                              type="text"
                              placeholder="Например, 12345678-1234-…"
                              value={perfClientId}
                              onChange={(e) => setPerfClientId(e.target.value)}
                              disabled={perfBusy !== "idle"}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>

                          <div className="api-fld">
                            <label>Performance Client Secret</label>
                            <div className="api-secret">
                              <input
                                className="api-input"
                                type={showPerfSecret ? "text" : "password"}
                                placeholder="Вставьте Client Secret"
                                value={perfClientSecret}
                                onChange={(e) => setPerfClientSecret(e.target.value)}
                                disabled={perfBusy !== "idle"}
                                autoComplete="off"
                                spellCheck={false}
                              />
                              <button
                                type="button"
                                className="api-eye"
                                onClick={() => setShowPerfSecret((v) => !v)}
                                disabled={perfBusy !== "idle"}
                                aria-label={showPerfSecret ? "Скрыть секрет" : "Показать секрет"}
                                title={showPerfSecret ? "Скрыть" : "Показать"}
                              >
                                {showPerfSecret ? eyeOffIcon : eyeIcon}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="api-pro-actions" style={{ gridTemplateColumns: "1fr", marginTop: "1rem" }}>
                          <button
                            type="button"
                            className="api-pro-btn"
                            onClick={connectPerformance}
                            disabled={perfBusy !== "idle"}
                          >
                            {perfBusy === "connecting" ? (
                              <>
                                <span className="spin" />
                                Подключаем…
                              </>
                            ) : (
                              "Подключить Performance API"
                            )}
                          </button>
                        </div>
                      </>
                    )}

                    {perfConnError && (
                      <p className="api-pro-msg err" style={{ marginTop: ".8rem" }}>
                        {perfConnError}
                      </p>
                    )}
                  </div>
                  )}

                  {/* Быстрые действия — на всю ширину */}
                  <div className="cab-card cab-card-wide">
                    <div className="cab-card-head">
                      <span className="cab-card-ico" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13 3 4 14h7l-1 7 9-11h-7z" />
                        </svg>
                      </span>
                      <div className="cab-card-title">Быстрые действия</div>
                    </div>
                    <div className="cab-quick">
                      <button
                        type="button"
                        className="api-pro-btn ghost"
                        onClick={() => setMainTab("calc")}
                      >
                        Перейти к расчёту
                      </button>
                      <button
                        type="button"
                        className="api-pro-btn ghost"
                        onClick={() => setMainTab("catalog")}
                      >
                        Каталог товаров
                      </button>
                      <button
                        type="button"
                        className="api-pro-btn ghost"
                        onClick={() => setMainTab("reports")}
                      >
                        Отчёты
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
      </div>

      {/* PR #25: модалка-предупреждение о дубле расчёта за месяц. Открывается
          ТОЛЬКО когда найден существующий расчёт за тот же месяц+МП. «Отмена» и
          клик по фону/Esc → resolveDupModal(false); «Создать новый» → (true). */}
      {dupModal && (
        <>
          <div
            className="dg-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dg-title"
            onClick={() => resolveDupModal(false)}
          >
            <div className="dg-card" onClick={(e) => e.stopPropagation()}>
              <span className="dg-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <path d="M12 9v4" />
                  <circle cx="12" cy="17" r=".7" fill="currentColor" />
                </svg>
              </span>
              <h3 id="dg-title" className="dg-title">
                За этот месяц уже есть расчёт
              </h3>
              <p className="dg-text">
                В истории уже есть расчёт за <b>{dupModal.monthLabel}</b>. Если
                создать новый, в отчётах появятся два расчёта за один месяц.
              </p>
              <div className="dg-found">
                <div className="dg-row">
                  <span className="dg-k">Месяц</span>
                  <span className="dg-v">{dupModal.monthLabel}</span>
                </div>
                <div className="dg-row">
                  <span className="dg-k">Чистая прибыль</span>
                  <span className="dg-v prof">
                    {Math.round(dupModal.existing.profit).toLocaleString("ru-RU")} ₽
                  </span>
                </div>
                <div className="dg-row">
                  <span className="dg-k">Создан</span>
                  <span className="dg-v">{dupModal.existing.date}</span>
                </div>
                {dupModal.existing.mode && (
                  <div className="dg-row">
                    <span className="dg-k">Тип расчёта</span>
                    <span className="dg-v">
                      {dupModal.existing.mode === "api"
                        ? "Ozon API"
                        : dupModal.existing.mode === "upload"
                        ? "Загрузка отчёта"
                        : "Ручной расчёт"}
                    </span>
                  </div>
                )}
              </div>
              <div className="dg-actions">
                <button
                  type="button"
                  className="dg-btn dg-btn-ghost"
                  onClick={() => resolveDupModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="dg-btn dg-btn-gold"
                  onClick={() => resolveDupModal(true)}
                >
                  Создать новый расчёт
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <TariffModal
        open={tariffModalOpen}
        tier={selectedTier}
        onClose={() => setTariffModalOpen(false)}
      />

      {toast && (
        <div
          key={toast.id}
          className={"mp-toast mp-toast-" + toast.type}
          role={toast.type === "err" ? "alert" : "status"}
        >
          <span className="mp-toast-ico" aria-hidden="true">
            {toast.type === "ok" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="m8.5 12.5 2.5 2.5 4.5-5" />
              </svg>
            ) : toast.type === "warn" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5" />
                <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4" />
                <circle cx="12" cy="17" r=".7" fill="currentColor" />
              </svg>
            )}
          </span>
          <span className="mp-toast-text">{toast.message}</span>
        </div>
      )}
    </>
  );
}
