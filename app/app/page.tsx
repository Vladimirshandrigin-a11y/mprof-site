"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { User } from "@supabase/supabase-js"
import { StatsCards } from "./components/StatsCards"
import { AnalyticsBlock } from "./components/AnalyticsBlock"
import { ProductCatalog } from "./components/ProductCatalog"
import { OzonProductBreakdown } from "./components/OzonProductBreakdown"
import { MonthlyAnalytics } from "./components/MonthlyAnalytics"
import { ComingSoon } from "./components/ComingSoon"
import { TariffModal, type TariffTier } from "../components/TariffModal"
import { useEntitlements } from "./lib/entitlements"
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

/**
 * Нормализует строку периода отчёта в первое число месяца 'YYYY-MM-01'
 * (формат колонки report_history.report_month). Понимает ISO (2026-04 /
 * 2026/04 / 2026-04-30), компактный (20260430) и русские названия месяцев
 * («Апрель 2026», «За апрель 2026»). Если распознать не удалось — текущий месяц.
 */
function deriveReportMonth(period: string | null | undefined): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fallback = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  if (!period) return fallback;
  const p = period.toLowerCase();
  // 20260430 → 2026-04
  const compact = p.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) {
    const m = Number(compact[2]);
    if (m >= 1 && m <= 12) return `${compact[1]}-${pad(m)}-01`;
  }
  // 2026-04 / 2026/04 / 2026.04(-30)
  const iso = p.match(/(20\d{2})[-./](\d{1,2})/);
  if (iso) {
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return `${iso[1]}-${pad(m)}-01`;
  }
  // Русские месяцы (порядок важен: специфичные основы раньше короткой «ма»).
  const MONTHS = [
    "январ", "феврал", "март", "апрел", "ма", "июн", "июл",
    "август", "сентябр", "октябр", "ноябр", "декабр",
  ];
  const yearM = p.match(/20\d{2}/);
  if (yearM) {
    for (let i = 0; i < MONTHS.length; i++) {
      if (p.includes(MONTHS[i])) return `${yearM[0]}-${pad(i + 1)}-01`;
    }
  }
  return fallback;
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

// === RELEASE v1.0 ===
// «🔒 Скоро» остаётся ТОЛЬКО у незавершённых для v1 функций (AI, API-автозагрузка).
// Тарифы и Premium РАЗБЛОКИРОВАНЫ (payment=false): карточки 149 ₽ / 449 ₽ видны
// пользователю, чтобы проверить интерес; онлайн-оплата (ЮKassa) — в подготовке.
// Реальный код всех блоков ПОЛНОСТЬЮ сохранён — ничего не удалено.
const COMING_SOON = {
  apiAutoload: true, // Автозагрузка через API (Ozon / WB) — пока «Скоро»
  payment: false, // Тарифы + Premium РАЗБЛОКИРОВАНЫ — карточки видны
};

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

export default function AppPage() {
  const [marketplace, setMarketplace] = useState<Marketplace>("ozon");
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const [result, setResult] = useState<CalcResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<CalcResult[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  // Счётчик-триггер перезагрузки «Аналитики по месяцам» после сохранения расчёта.
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [ozonClientId, setOzonClientId] = useState("");
  const [ozonApiKey, setOzonApiKey] = useState("");
  const [wbApiKey, setWbApiKey] = useState("");
  const [apiSaveStatus, setApiSaveStatus] = useState<"idle" | "ok" | "err" | "saving">("idle");
  const [apiSaveMessage, setApiSaveMessage] = useState("");
  const [showOzonKey, setShowOzonKey] = useState(false);
  const [showWbKey, setShowWbKey] = useState(false);
  const [calcMode, setCalcMode] = useState<"manual" | "api" | "upload">("manual");
  // Верхнеуровневые разделы дашборда: калькулятор или каталог товаров.
  // Каталог доступен только залогиненному (RLS user-scoped) — таб-бар прячем,
  // когда user отсутствует, и тогда всегда показываем калькулятор.
  const [mainTab, setMainTab] = useState<"calc" | "catalog">("calc");
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
    const netProfit = profitBeforeCost - totalExtraExpenses;
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
      netProfit,
      margin,
      roi,
    };
  }, [combinedResult, profitInputs]);

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
    // total_expenses включает Ozon-комиссии + все доп. расходы, поэтому
    // identity profit = revenue − total_expenses = netProfit сохраняется.
    const totalExpenses =
      combinedResult.updServicesTotal +
      combinedResult.updCommissionTotal +
      profitCalc.costPrice +
      profitCalc.tax +
      profitCalc.ads +
      otherGroup;

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
      const { error: histErr } = await saveReportHistoryToCloud(
        {
          report_month: deriveReportMonth(combinedResult.period),
          revenue: incomeRevenue,
          expenses: totalExpenses,
          profit: profitCalc.netProfit,
          margin: profitCalc.margin,
        },
        user.id
      );
      if (!histErr) setHistoryRefresh((k) => k + 1);
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

      // Строки таблицы основных показателей (порядок — как в форме на экране).
      const taxLabel =
        pc.taxPercent > 0
          ? `Налог (${pc.taxPercent.toLocaleString("ru-RU", {
              maximumFractionDigits: 2,
            })}%)`
          : "Налог";
      const rows: { label: string; value: string; bold?: boolean }[] = [
        { label: "Выручка Ozon", value: "+" + money(cr.revenue) },
        { label: "Выплаты от партнёров", value: "+" + money(cr.loyaltyPayouts) },
        { label: "Расходы Ozon по УПД", value: "−" + money(cr.updServicesTotal) },
        {
          label: "Агентское вознаграждение",
          value: "−" + money(cr.updCommissionTotal),
        },
        {
          label: "Прибыль до себестоимости",
          value: money(cr.profitBeforeCost),
          bold: true,
        },
        { label: "Себестоимость", value: "−" + money(pc.costPrice) },
        { label: taxLabel, value: "−" + money(pc.tax) },
        { label: "Реклама", value: "−" + money(pc.ads) },
        { label: "Упаковка", value: "−" + money(pc.packaging) },
        { label: "Доставка до склада", value: "−" + money(pc.deliveryToWarehouse) },
        { label: "Зарплата / подрядчики", value: "−" + money(pc.salary) },
        { label: "Прочие расходы", value: "−" + money(pc.other) },
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

      const SANS = "'Helvetica Neue', Arial, sans-serif";
      const ML = 64;
      const MR = W - 64;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#0e1525";
      ctx.fillRect(0, 0, W, 8);

      ctx.textBaseline = "alphabetic";
      let y = 90;
      ctx.fillStyle = "#0e1525";
      ctx.font = `700 25px ${SANS}`;
      ctx.fillText("M-Prof — отчёт о чистой прибыли", ML, y);

      y += 30;
      ctx.font = `400 13px ${SANS}`;
      ctx.fillStyle = "#5b6677";
      ctx.fillText(`Дата формирования: ${dateStr}`, ML, y);
      y += 20;
      ctx.fillText("Marketplace: Ozon", ML, y);

      y += 22;
      ctx.strokeStyle = "#e3e7ee";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(MR, y);
      ctx.stroke();

      y += 32;
      ctx.font = `700 15px ${SANS}`;
      ctx.fillStyle = "#0e1525";
      ctx.fillText("Основные показатели", ML, y);

      const rowH = 30;
      const drawRow = (
        label: string,
        value: string,
        opts?: { bold?: boolean; size?: number; color?: string }
      ) => {
        const size = opts?.size ?? 13;
        ctx.font = `${opts?.bold ? "700" : "400"} ${size}px ${SANS}`;
        ctx.fillStyle = "#384150";
        ctx.textAlign = "left";
        ctx.fillText(label, ML, y + 20);
        ctx.font = `${opts?.bold ? "700" : "600"} ${size}px ${SANS}`;
        ctx.fillStyle = opts?.color ?? "#0e1525";
        ctx.textAlign = "right";
        ctx.fillText(value, MR, y + 20);
        ctx.textAlign = "left";
        ctx.strokeStyle = "#f0f2f6";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ML, y + rowH);
        ctx.lineTo(MR, y + rowH);
        ctx.stroke();
        y += rowH;
      };

      y += 12;
      rows.forEach((r) => drawRow(r.label, r.value, { bold: r.bold }));

      // Разделитель перед итоговым результатом.
      y += 10;
      ctx.strokeStyle = "#cfd5df";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ML, y);
      ctx.lineTo(MR, y);
      ctx.stroke();
      y += 6;

      drawRow("Чистая прибыль", money(pc.netProfit), {
        bold: true,
        size: 18,
        color: netPositive ? "#1d8a4f" : "#c0392b",
      });
      drawRow("Маржинальность", pctv(pc.margin), {
        bold: true,
        color: pc.margin < 0 ? "#c0392b" : "#0e1525",
      });
      drawRow("ROI", pctv(pc.roi), {
        bold: true,
        color: pc.roi < 0 ? "#c0392b" : "#0e1525",
      });

      // Короткий вывод.
      y += 26;
      const conclusion = netPositive
        ? "Бизнес-модель прибыльная по загруженным данным."
        : "Расчёт показывает убыток. Проверьте себестоимость и расходы.";
      const boxH = 44;
      ctx.fillStyle = netPositive ? "#eaf7ef" : "#fdecea";
      ctx.fillRect(ML, y, MR - ML, boxH);
      ctx.font = `600 13px ${SANS}`;
      ctx.fillStyle = netPositive ? "#1d8a4f" : "#c0392b";
      ctx.textAlign = "left";
      ctx.fillText(conclusion, ML + 16, y + 27);

      // Подпись внизу страницы.
      ctx.font = `400 12px ${SANS}`;
      ctx.fillStyle = "#8a93a3";
      ctx.textAlign = "center";
      ctx.fillText("Отчёт сформирован сервисом M-Prof", W / 2, H - 46);
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
    // Восстанавливаем per-SKU строки + estimate из snapshot (если сохранены).
    // Это даёт OzonProductBreakdown заново сопоставить товары с АКТУАЛЬНЫМ
    // каталогом и пересчитать себестоимость (COGS) при открытии старого расчёта.
    const restoredProducts = b.products ?? [];
    setReportProducts(restoredProducts);
    setReportEstimate(b.estimate ?? null);
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
    const breakdown = asNetProfitBreakdown(item.aiInsights);
    if (breakdown) {
      // Upload-расчёт: вся логика восстановления уже в restoreUploadCalc.
      restoreUploadCalc(item);
    } else {
      // Ручной расчёт: восстанавливаем форму параметров и итоговый результат.
      const s = (n: number) => String(Math.round(n));
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
    // верху страницы. block:"start" + scroll-margin-top в .calc-tabs учитывают
    // sticky-шапку, поэтому скролл останавливается на калькуляторе, не на логотипе.
    calcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
      setSelectedTier("unlimited");
      setTariffModalOpen(true);
      return;
    }

    setUploadStatus("processing");
    setUploadStage(0);
    setUploadErrorMsg("");
    setUploadDebugInfo(null);
    setReportProducts([]);
    setReportEstimate(null);

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
      setSelectedTier("unlimited");
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
    setReportCogsTotal(null);
    setShowProfitForm(false);
    setProfitInputs({ ...EMPTY_PROFIT });
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
      setSelectedTier("unlimited");
      setTariffModalOpen(true);
      return;
    }

    setCombinedStatus("processing");
    setCombinedError("");
    setCombinedResult(null);
    setCombinedDebug(null);
    setReportProducts([]);
    setReportEstimate(null);
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
        'Не найдена строка «Итого реализовано (за вычетом возвратов)» в XLSX. revenue не заполнять. Проверьте, что файл — оригинальный «Отчёт о реализации товара» из Ozon, без обрезок. Откройте DEV debug для деталей.'
      );
      return;
    }

    // Все парсы прошли. Списываем расчёт server-authoritative ДО построения и
    // сохранения результата — кредит не сгорает на ошибке парсинга файлов.
    const consumed = await consumeCalculation();
    if (!consumed.ok) {
      // eslint-disable-next-line no-console
      console.warn("[upload-3] consume blocked → paywall", consumed.reason);
      setCombinedStatus("idle");
      setSelectedTier("unlimited");
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

  const showToast = (message: string, type: ToastType = "ok") => {
    setToast({ id: Date.now(), message, type });
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
  const [ozonLoadStatus, setOzonLoadStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [ozonLoadMessage, setOzonLoadMessage] = useState("");

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
  const [filterMp, setFilterMp] = useState<FilterMp>("all");
  const [filterResult, setFilterResult] = useState<FilterResult>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Поиск (по периоду отчёта / дате создания / типу расчёта) и быстрый фильтр
  // по прибыли. Чисто фронтовая фильтрация уже загруженной истории — на
  // статистику, AnalyticsBlock, формулы, Supabase и сохранение НЕ влияет.
  const [histSearch, setHistSearch] = useState("");
  const [histProfitFilter, setHistProfitFilter] =
    useState<HistProfitFilter>("all");

  const filterPeriodLabel =
    filterPeriod === "all" ? "всё время" : `${filterPeriod} дней`;
  const filterMpLabel =
    filterMp === "all"
      ? "все маркетплейсы"
      : filterMp === "ozon"
      ? "Ozon"
      : "Wildberries";
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
    return filteredHistory.filter((h) => {
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
  }, [filteredHistory, histSearch, histProfitFilter]);

  const totalRevenue = filteredHistory.reduce((sum, h) => sum + h.revenue, 0);
  const totalProfit = filteredHistory.reduce((sum, h) => sum + h.profit, 0);
  const avgMargin =
    filteredHistory.length > 0
      ? filteredHistory.reduce((sum, h) => sum + h.margin, 0) /
        filteredHistory.length
      : 0;

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
        loadApiKeys(uid);
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
        setWbApiKey("");
        setUploadedReports([]);
      }
    });

    return () => {
      mounted = false;
      clearTimeout(safety);
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = async () => {
    if (!email.trim()) {
      setAuthMessage("Введите email");
      return;
    }

    // Куда вернуть пользователя по ссылке из письма. На проде — NEXT_PUBLIC_SITE_URL
    // (Railway-домен), в dev (переменная не задана) — origin текущего окна.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
    const emailRedirectTo = `${siteUrl || window.location.origin}/app`;

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo,
      },
    });

    if (error) {
      setAuthMessage(error.message);
    } else {
      setAuthMessage("Письмо для входа отправлено на email");
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
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auth] signOut error", e);
    } finally {
      // Сброс in-memory state.
      setUser(null);
      setHistory([]);
      setResult(null);
      setUploadedReports([]);
      setOzonClientId("");
      setOzonApiKey("");
      setWbApiKey("");
      setApiSaveMessage("");
      setApiSaveStatus("idle");
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

  const loadApiKeys = async (userId: string) => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("ozon_client_id, ozon_api_key, wb_api_key")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("loadApiKeys error:", formatSupabaseError(error));
      return;
    }

    if (data) {
      setOzonClientId(data.ozon_client_id ?? "");
      setOzonApiKey(data.ozon_api_key ?? "");
      setWbApiKey(data.wb_api_key ?? "");
    }
  };

  const saveApiKeys = async () => {
    if (!user?.id) {
      setApiSaveStatus("err");
      setApiSaveMessage("Войдите в аккаунт, чтобы сохранить ключи");
      return;
    }

    setApiSaveStatus("saving");
    setApiSaveMessage("");

    const { error } = await supabase
      .from("api_keys")
      .upsert(
        [
          {
            user_id: user.id,
            ozon_client_id: ozonClientId.trim() || null,
            ozon_api_key: ozonApiKey.trim() || null,
            wb_api_key: wbApiKey.trim() || null,
          },
        ],
        { onConflict: "user_id" }
      );

    if (error) {
      const fmt = formatSupabaseError(error);
      console.error("saveApiKeys error:", fmt);
      setApiSaveStatus("err");
      setApiSaveMessage("Ошибка: " + fmt.message);
      return;
    }

    setApiSaveStatus("ok");
    setApiSaveMessage("Ключи сохранены");
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
      setIsLoadingHistory(false);
      return [];
    }

    const res = await loadCalculationsFromCloud(userId, 50);
    setIsLoadingHistory(false);

    if (res.error) {
      console.warn("loadHistory: cloud unavailable", res.error);
      // Graceful fallback: оставляем текущий локальный state нетронутым.
      return [];
    }

    const mapped = (res.data ?? []).map(cloudToLocal);
    setHistory(mapped);
    return mapped;
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

  const handleField = (key: string, value: string) => {
    if (value !== "" && !/^-?\d*[.,]?\d*$/.test(value)) return;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const calculate = async () => {
    if (isCalculating) return;
    // Защита: UI подменяет кнопку на paywall, но на всякий случай.
    if (!canCalculate) {
      setSelectedTier("unlimited");
      setTariffModalOpen(true);
      return;
    }
    setIsCalculating(true);

    try {
      // Ручной расчёт не парсит файлы (арифметика не падает) — списываем сразу,
      // server-authoritative, ДО выдачи результата. !ok → paywall, результата нет.
      const consumed = await consumeCalculation();
      if (!consumed.ok) {
        // eslint-disable-next-line no-console
        console.warn("[calc] consume blocked → paywall", consumed.reason);
        setSelectedTier("unlimited");
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

  const loadFromOzon = async () => {
    const clientId = ozonClientId.trim();
    const apiKey = ozonApiKey.trim();

    if (!clientId || !apiKey) {
      setOzonLoadStatus("err");
      setOzonLoadMessage("Заполните Ozon Client ID и Ozon API Key");
      return;
    }

    setOzonLoadStatus("loading");
    setOzonLoadMessage("");

    try {
      const res = await fetch("/api/ozon/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, apiKey, daysBack: 30 }),
      });

      const data = await res.json();

      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Не удалось получить данные");
      }

      // подставляем выручку и переключаем калькулятор на Ozon
      setMarketplace("ozon");
      setForm((prev) => ({
        ...prev,
        revenue: String(data.revenue ?? 0),
      }));

      const formattedRev = Number(data.revenue ?? 0).toLocaleString("ru-RU");
      setOzonLoadStatus("ok");
      setOzonLoadMessage(
        `Продажи успешно загружены: ${formattedRev} ₽ за ${data?.period?.days ?? 30} дней`
      );
    } catch (e) {
      console.error("loadFromOzon error:", e);
      setOzonLoadStatus("err");
      setOzonLoadMessage("Не удалось получить данные Ozon API");
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

.dash-top{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  padding:1rem 2rem;background:rgba(8,10,20,.75);backdrop-filter:blur(18px) saturate(1.3);
  border-bottom:1px solid var(--edge)}
.dash-brand{font-family:var(--display);font-size:1.15rem;font-weight:700;letter-spacing:.01em;color:var(--txt);text-decoration:none}
.dash-brand em{font-style:italic;color:var(--gold)}
.dash-brand-sub{font-family:var(--mono);font-size:.58rem;color:var(--txt3);letter-spacing:.14em;text-transform:uppercase;margin-left:10px;vertical-align:middle}
.dash-status{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.66rem;
  color:var(--gold2);letter-spacing:.06em;border:1px solid rgba(201,168,76,.3);
  padding:6px 16px;border-radius:100px;background:var(--gold-bg)}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--gold);
  animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.6)}}

.dash-user{display:inline-flex;align-items:center;gap:10px}
.dash-user-email{font-family:var(--mono);font-size:.63rem;color:var(--txt2);letter-spacing:.04em;
  max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-signout{font-family:var(--sans);font-size:.75rem;font-weight:500;background:transparent;
  border:1px solid var(--edge2);color:var(--txt2);padding:5px 13px;border-radius:8px;
  cursor:pointer;transition:all .18s;line-height:1}
.dash-signout:hover{border-color:rgba(224,85,102,.4);color:var(--red)}

.auth-card{margin-bottom:1.4rem;padding:1.4rem 1.5rem}
.auth-title{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);margin:0 0 .9rem}
.auth-row{display:flex;gap:10px;align-items:stretch}
.auth-input{flex:1;width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);
  border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:.92rem;padding:12px 14px;
  outline:none;transition:border .18s,box-shadow .18s,background .18s;
  -webkit-text-fill-color:var(--txt);caret-color:var(--gold);
  appearance:none;-webkit-appearance:none}
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
.auth-msg{margin:.8rem 0 0;font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em}
@media(max-width:480px){.auth-row{flex-direction:column}.auth-btn{padding:13px}}

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
/* === MAIN TABS (Калькулятор / Каталог товаров) === */
.main-tabs{display:flex;gap:6px;background:var(--glass);border:1px solid var(--edge);
  border-radius:14px;padding:6px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  margin:.2rem 0 1.1rem;box-shadow:0 10px 28px rgba(0,0,0,.20);max-width:520px}
.main-tab{flex:1;font-family:var(--sans);font-size:.9rem;font-weight:600;padding:12px 18px;
  border-radius:10px;cursor:pointer;border:1px solid transparent;background:transparent;
  color:var(--txt2);transition:all .22s ease;display:inline-flex;align-items:center;
  justify-content:center;gap:9px;min-height:44px}
.main-tab:hover{color:var(--txt);background:rgba(255,255,255,.03)}
.main-tab.active{color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  box-shadow:0 8px 26px rgba(201,168,76,.3),inset 0 1px 0 rgba(255,255,255,.22)}
.main-tab-ico{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px}
.main-tab-ico svg{width:17px;height:17px;display:block}
@media(max-width:640px){.main-tabs{max-width:none}}

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
.api-pro-btn .spin{display:inline-block;width:14px;height:14px;border-radius:50%;
  border:2px solid rgba(0,0,0,.18);border-top-color:rgba(0,0,0,.55);
  animation:apiSpin .8s linear infinite;margin-right:2px}
@keyframes apiSpin{to{transform:rotate(360deg)}}

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
.mp-tab.act-wb{
  border-color:rgba(203,17,171,.55);color:#f0a4e6;
  background:linear-gradient(135deg, rgba(203,17,171,.18) 0%, rgba(203,17,171,.05) 100%);
  box-shadow:0 0 26px rgba(203,17,171,.18), inset 0 1px 0 rgba(255,255,255,.07)
}
.mp-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:var(--smoke);transition:all .22s ease}
.mp-dot-ozon{background:#3d7bff}
.mp-dot-wb{background:#cb11ab}
.mp-tab.act-ozon .mp-dot-ozon{box-shadow:0 0 12px #3d7bff, 0 0 24px rgba(61,123,255,.4);
  animation:mpDotPulse 2.4s ease-in-out infinite}
.mp-tab.act-wb .mp-dot-wb{box-shadow:0 0 12px #cb11ab, 0 0 24px rgba(203,17,171,.4);
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
  .mp-tab.act-wb .mp-dot-wb,
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
.mp-tab.act-wb{border-color:#cb11ab;color:#e878d6;background:rgba(203,17,171,.1)}

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
.res-row{display:flex;justify-content:space-between;align-items:center;padding:.6rem 0;
  border-bottom:1px solid var(--edge);font-size:.85rem}
.res-row:last-child{border-bottom:none}
.res-row .rl{color:var(--txt2)}
.res-row .rv{font-family:var(--mono);font-weight:500;color:var(--txt)}
.res-row .rv.neg{color:var(--red)}

.empty-res{padding:3rem 1.5rem;text-align:center;color:var(--txt3)}
.empty-icon{font-size:2rem;opacity:.4;margin-bottom:.7rem;display:block}
.empty-title{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt2);margin-bottom:.3rem}
.empty-sub{font-size:.8rem;font-weight:300}

.hist-card{margin-top:.65rem}
.hist-list{display:flex;flex-direction:column}
.hist-item{
  display:flex;
  align-items:center;
  gap:1rem;
  padding:.85rem 1.5rem;
  border-bottom:1px solid var(--edge);
  cursor:pointer;
  transition:.2s ease;
}

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
.hist-rev{font-size:.82rem;color:var(--txt);font-weight:600}
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
@media(max-width:560px){
  .hist-item{gap:.6rem;padding:.8rem 1rem}
  .hist-profit{font-size:.95rem;max-width:42%}
  .hist-profit-label{font-size:.54rem}
  .hist-period{font-size:.68rem}
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
  .dash-top{padding:.85rem 1.2rem}
  .dash-brand-sub{display:none}
  .dash-status{font-size:.6rem;padding:5px 12px}
  .dash-wrap{padding:1.8rem 1.2rem 4rem}
  .dash-grid{grid-template-columns:1fr}
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
      `}</style>

      <div className="dash-top">
        <a href="/" className="dash-brand">
          M&#8209;<em>Prof</em>
          <span className="dash-brand-sub">Dashboard</span>
        </a>

        {user ? (
          <div className="dash-user">
            <span className="dash-user-email">{user.email}</span>
            <button className="dash-signout" onClick={signOut}>
              Выйти
            </button>
          </div>
        ) : (
          <div className="dash-status">
            <span className="status-dot"></span>
            Первый расчёт бесплатно
          </div>
        )}
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

            <div className="auth-row">
              <input
                className="auth-input"
                type="email"
                placeholder="Ваш email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") signIn();
                }}
              />
              <button type="button" className="auth-btn" onClick={signIn}>
                Войти
              </button>
            </div>

            {authMessage && <p className="auth-msg">{authMessage}</p>}
          </div>
        )}

        {user && (
          <div className="main-tabs" role="tablist" aria-label="Разделы">
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
              Калькулятор
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

        <StatsCards
          totalRevenue={totalRevenue}
          totalProfit={totalProfit}
          avgMargin={avgMargin}
          historyCount={filteredHistory.length}
        />

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
                    "filter-bdg" + (filterMp !== "all" ? " active" : "")
                  }
                >
                  <span className="filter-bdg-dot" />
                  <span className="filter-bdg-l">Маркетплейсы:</span>
                  <span className="filter-bdg-v">{filterMpLabel}</span>
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
                Настройте аналитику по периоду, маркетплейсу и результату
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
            <div className="filter-label">Маркетплейс</div>
            <div className="filter-pills">
              {(
                [
                  ["all", "Все"],
                  ["ozon", "Ozon"],
                  ["wb", "Wildberries"],
                ] as [FilterMp, string][]
              ).map(([v, label]) => (
                <button
                  type="button"
                  key={v}
                  className={"filter-pill" + (filterMp === v ? " active" : "")}
                  onClick={() => setFilterMp(v)}
                  aria-pressed={filterMp === v}
                >
                  {label}
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
          hasAnyData={history.length > 0}
          hasPremium={hasPremium}
          onOpenPremium={openPremium}
        />

        <div className="calc-tabs" role="tablist" ref={calcSectionRef}>
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
            Ручной расчёт
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
            Авторасчёт через API
          </button>
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
            Загрузить отчёт
          </button>
        </div>

        {calcMode === "manual" && showOnboarding && (
          <div className="onboard-card" role="note">
            <div className="onboard-steps">
              <div className="onboard-step">
                <span className="onboard-num">1</span>
                <span className="onboard-text">Введите выручку</span>
              </div>
              <div className="onboard-arrow">→</div>
              <div className="onboard-step">
                <span className="onboard-num">2</span>
                <span className="onboard-text">Укажите комиссию</span>
              </div>
              <div className="onboard-arrow">→</div>
              <div className="onboard-step">
                <span className="onboard-num">3</span>
                <span className="onboard-text">Нажмите «Рассчитать»</span>
              </div>
            </div>
            <button
              type="button"
              className="onboard-close"
              onClick={dismissOnboarding}
              aria-label="Скрыть подсказку"
              title="Скрыть"
            >
              ×
            </button>
          </div>
        )}

        {calcMode === "manual" && (
        <div className="dash-grid">
          <div className={"card" + (isCalculating ? " calc-loading" : "")}>
            <div className="card-head">
              <div className="card-title">Параметры расчёта</div>
            </div>
            <div className="card-body">
              <div className="mp-row">
                <div
                  className={"mp-tab" + (marketplace === "ozon" ? " act-ozon" : "")}
                  onClick={() => !isCalculating && setMarketplace("ozon")}
                  role="button"
                  aria-pressed={marketplace === "ozon"}
                >
                  <span className="mp-dot mp-dot-ozon" aria-hidden="true" />
                  Ozon
                </div>
                <div
                  className={"mp-tab" + (marketplace === "wb" ? " act-wb" : "")}
                  onClick={() => !isCalculating && setMarketplace("wb")}
                  role="button"
                  aria-pressed={marketplace === "wb"}
                >
                  <span className="mp-dot mp-dot-wb" aria-hidden="true" />
                  Wildberries
                </div>
              </div>

              <div className="form-grid">
                {FIELDS.map((f) => (
                  <div className="fld" key={f.key}>
                    <label>
                      {f.label}
                      {f.key === "revenue" && <span className="rev-badge"> ●</span>}
                    </label>
                    <div className="in-wrap">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={form[f.key]}
                        onChange={(e) => handleField(f.key, e.target.value)}
                        disabled={isCalculating}
                      />
                      <span className="in-cur">₽</span>
                    </div>
                    {f.hint && <span className="fld-hint">{f.hint}</span>}
                  </div>
                ))}
              </div>

              {canCalculate || !entitlementsLoaded ? (
                <div className="btn-row">
                  <button
                    className="btn-gold"
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
                    className="btn-ghost"
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
                      Лимит расчётов исчерпан — выберите тариф в блоке ниже
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
                  <div className="res-row">
                    <span className="rl">Сумма расходов</span>
                    <span className="rv neg">− {fmt(result.expenses)} ₽</span>
                  </div>
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

        {calcMode === "api" && COMING_SOON.apiAutoload && (
          <ComingSoon
            title="Автозагрузка через API"
            description="Подключение Ozon и Wildberries по API: продажи, комиссии и расходы будут подтягиваться автоматически — без ручной выгрузки файлов."
          />
        )}

        {calcMode === "api" && !COMING_SOON.apiAutoload && (
        <div className="card api-pro-card">
          <div className="api-pro-head">
            <div className="api-pro-title">Подключение маркетплейсов</div>
            <p className="api-pro-sub">
              Подключите Ozon/WB API для автоматической загрузки продаж, комиссий и расходов.
            </p>
          </div>

          {user &&
            !ozonClientId.trim() &&
            !ozonApiKey.trim() &&
            !wbApiKey.trim() && (
              <div className="api-empty">
                <div className="api-empty-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 7V3M15 7V3" />
                    <rect x="6" y="7" width="12" height="6" rx="1.5" />
                    <path d="M12 13v4a3 3 0 0 0 3 3h2" />
                  </svg>
                </div>
                <div className="api-empty-title">
                  Подключите API Ozon или WB
                </div>
                <p className="api-empty-sub">
                  для автоматического анализа прибыли
                </p>
                <ul className="api-empty-list">
                  <li>Автоматическая аналитика</li>
                  <li>История продаж</li>
                  <li>Расчёт чистой прибыли</li>
                </ul>
              </div>
          )}

          <div className="api-pro-body">
            <div className="api-pro-grid">
              <div className="api-fld">
                <label>Ozon Client ID</label>
                <input
                  className="api-input"
                  type="text"
                  placeholder="Например, 123456"
                  value={ozonClientId}
                  onChange={(e) => setOzonClientId(e.target.value)}
                  disabled={!user}
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
                    disabled={!user}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="api-eye"
                    onClick={() => setShowOzonKey((v) => !v)}
                    disabled={!user}
                    aria-label={showOzonKey ? "Скрыть ключ" : "Показать ключ"}
                    title={showOzonKey ? "Скрыть" : "Показать"}
                  >
                    {showOzonKey ? eyeOffIcon : eyeIcon}
                  </button>
                </div>
              </div>

              <div className="api-fld api-fld-full">
                <label>Wildberries API Key</label>
                <div className="api-secret">
                  <input
                    className="api-input"
                    type={showWbKey ? "text" : "password"}
                    placeholder="Вставьте токен из личного кабинета WB"
                    value={wbApiKey}
                    onChange={(e) => setWbApiKey(e.target.value)}
                    disabled={!user}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="api-eye"
                    onClick={() => setShowWbKey((v) => !v)}
                    disabled={!user}
                    aria-label={showWbKey ? "Скрыть ключ" : "Показать ключ"}
                    title={showWbKey ? "Скрыть" : "Показать"}
                  >
                    {showWbKey ? eyeOffIcon : eyeIcon}
                  </button>
                </div>
              </div>
            </div>

            {apiSaveMessage && (
              <p
                className={
                  "api-pro-msg" +
                  (apiSaveStatus === "ok" ? " ok" : "") +
                  (apiSaveStatus === "err" ? " err" : "")
                }
                style={{ marginTop: "1rem" }}
              >
                {apiSaveMessage}
              </p>
            )}

            {user ? (
              <div className="api-pro-actions">
                <button
                  type="button"
                  className="api-pro-btn ghost"
                  onClick={saveApiKeys}
                  disabled={apiSaveStatus === "saving"}
                >
                  {apiSaveStatus === "saving" ? "Сохраняем…" : "Сохранить API"}
                </button>
                <button
                  type="button"
                  className="api-pro-btn"
                  onClick={loadFromOzon}
                  disabled={ozonLoadStatus === "loading"}
                >
                  {ozonLoadStatus === "loading" ? (
                    <>
                      <span className="spin" />
                      Загружаем продажи…
                    </>
                  ) : (
                    "Загрузить данные из Ozon"
                  )}
                </button>
              </div>
            ) : (
              <div className="api-pro-actions" style={{ gridTemplateColumns: "1fr" }}>
                <button type="button" className="api-pro-btn locked" disabled>
                  Войдите в аккаунт для подключения API
                </button>
              </div>
            )}

            {ozonLoadStatus === "ok" && (
              <div className="api-alert ok" role="status">
                <span className="api-alert-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                  </svg>
                </span>
                <span className="api-alert-text">
                  {ozonLoadMessage || "Продажи успешно загружены"}
                </span>
              </div>
            )}

            {ozonLoadStatus === "err" && (
              <div className="api-alert err" role="alert">
                <span className="api-alert-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5" />
                    <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
                  </svg>
                </span>
                <span className="api-alert-text">
                  {ozonLoadMessage || "Не удалось получить данные Ozon API"}
                </span>
              </div>
            )}

            <div className="api-pro-hint">
              <span className="api-pro-hint-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <circle cx="12" cy="16.4" r=".6" fill="currentColor" />
                </svg>
              </span>
              Ваши продажи, комиссии и расходы будут подтягиваться автоматически.
            </div>
          </div>
        </div>
        )}

        {calcMode === "upload" && (
          <div className="card upload-card" role="region" aria-label="Загрузка отчёта (3 файла)">
            <div className="upload-3-head">
              <div className="upload-3-title">
                Точный расчёт Ozon — 3 файла
              </div>
              <p className="upload-3-sub">
                Загрузите XLSX-отчёт о реализации и оба УПД (доп. услуги +
                агентское вознаграждение). Прибыль до себестоимости считается
                по формуле: <b>revenue + loyaltyPayouts − updServices − updCommission</b>.
              </p>
            </div>

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
                    Отчёт о реализации товара
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
                <div className="upload-3-result-breakdown">
                  <div className="upload-3-row">
                    <span>Revenue (Итого реализовано)</span>
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
                    : "Открыть форму (себестоимость, налог) →"}
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
                      </div>
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
          />
        )}

        {/* Аналитика по месяцам — карточки текущего месяца + графики
            прибыли/выручки. Данные из report_history (Supabase). */}
        <MonthlyAnalytics user={user} refreshKey={historyRefresh} />

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

        {/* Тарифный блок dashboard. Показ зависит от прав (entitlements):
            • unlimited активен → блок СТАТУСА тарифа (без карточек покупки),
              скрывается крестиком (localStorage mprof_unlimited_banner_hidden);
            • не unlimited И (есть single-кредит ИЛИ нет доступа) → карточки покупки;
            • иначе (free с остатком бесплатного расчёта) → ничего.
            entitlementsLoaded-гейт убирает мерцание до ответа Supabase. */}
        {entitlementsLoaded && hasPremium && !unlimitedBannerHidden && (
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

        {entitlementsLoaded &&
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
                    <li>Один расчёт за месячный отчёт</li>
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
                    <li>AI аналитика и рекомендации</li>
                    <li>Приоритетный доступ к новым функциям</li>
                    <li>Полная история без ограничений</li>
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

        {isLoadingHistory && (
          <div className="card hist-card">
            <div className="card-head">
              <div className="card-title">Последние расчёты</div>
            </div>
            <div className="card-body">
              Загрузка истории...
            </div>
          </div>
        )}

        {!isLoadingHistory && history.length === 0 && (
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
                onClick={clearHistory}
                style={{
                  boxShadow: "0 0 22px rgba(246,200,107,.22), inset 0 1px 0 rgba(255,255,255,.12)",
                  backdropFilter: "blur(10px)",
                  all: "unset",
                  height: "42px",
                  padding: "0 18px",
                  borderRadius: "14px",
                  border: "1px solid rgba(255,255,255,.10)",
                  background: "linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.035))",
                  color: "#f6c86b",
                  textShadow: "0 0 10px rgba(246,200,107,.25)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: "14px",
                  fontWeight: 700,
                  transition: "all .2s ease",
                }}
              >
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
            </div>

            {visibleHistory.length === 0 ? (
              <div className="hist-filter-empty">Расчёты не найдены</div>
            ) : (
            <div className="hist-list">
              {visibleHistory.map((h) => {
                const removing = removingIds.has(h.id);
                // Разбор upload-расчёта из ai_insights. null → ручной/старый расчёт.
                const breakdown = asNetProfitBreakdown(h.aiInsights);
                const isReport = !!breakdown;
                // Период отчёта Ozon. Нет периода → «Период не указан».
                const reportPeriod = breakdown?.reportPeriod ?? null;
                // Введена ли себестоимость → прибыль уже «чистая»; иначе «до себестоимости».
                const hasCost = (breakdown?.costPrice ?? 0) > 0;
                const mpName = h.marketplace === "ozon" ? "Ozon" : "WB";
                const histTitle = isReport
                  ? `Отчёт ${mpName}`
                  : `Ручной расчёт ${mpName}`;
                const profitLabel =
                  isReport && !hasCost
                    ? "Прибыль до себестоимости"
                    : "Чистая прибыль";
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
                    <div className={"hist-mp " + h.marketplace}>
                      {h.marketplace === "ozon" ? "Ozon" : "WB"}
                    </div>

                    <div className="hist-info">
                      <div className="hist-rev">{histTitle}</div>
                      <div className="hist-period">
                        {reportPeriod
                          ? `Период отчёта: ${reportPeriod}`
                          : "Период отчёта: не указан"}
                      </div>
                      <div className="hist-revenue">
                        Выручка: {fmt(h.revenue)} ₽
                      </div>
                      <div className="hist-date">Создан: {h.date}</div>
                    </div>

                    <div className={"hist-profit " + (h.profit >= 0 ? "pos" : "neg")}>
                      <span className="hist-profit-label">{profitLabel}</span>
                      <span className="hist-profit-num">
                        {h.profit >= 0 ? "+" : "−"}
                        {fmt(Math.abs(h.profit))} ₽
                      </span>
                      <span className="hm">Маржа: {h.margin.toFixed(1)}%</span>
                    </div>

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
      </div>

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
