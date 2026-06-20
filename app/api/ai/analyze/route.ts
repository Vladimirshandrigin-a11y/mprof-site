import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";

// LLM-вызов требует Node-рантайма (серверный ключ, произвольные заголовки).
export const runtime = "nodejs";
// Никогда не кешируем — каждый расчёт анализируется заново.
export const dynamic = "force-dynamic";

// ============================================================================
// /api/ai/analyze — реальная AI-аналитика расчёта через Timeweb AI Gateway
// (OpenAI-совместимый API; НЕ чат-бот, НЕ AI Agent — прямой вызов /chat/completions).
//
// БЕЗОПАСНОСТЬ:
//   • TIMEWEB_AI_GATEWAY_KEY — серверный секрет, без NEXT_PUBLIC.
//   • auth + план проверяются ДО любого вызова Gateway — токены не тратятся
//     на free/single пользователей.
//   • на вход принимаем ТОЛЬКО числовые агрегаты + короткие строки товаров;
//     никаких XLSX/PDF/сырых отчётов в LLM не уходит.
//   • любой сбой Gateway → rule-based fallback с source:"fallback";
//     сайт не падает.
// ============================================================================

// OpenAI-совместимый endpoint Timeweb AI Gateway. Берём из env Timeweb App
// Platform (process.env.TIMEWEB_AI_GATEWAY_URL); запасной адрес — на случай,
// если переменная ещё не проброшена, чтобы поведение не ломалось.
const GATEWAY_URL =
  process.env.TIMEWEB_AI_GATEWAY_URL?.trim() ||
  "https://api.timeweb.ai/v1/chat/completions";
const MODEL = process.env.TIMEWEB_AI_MODEL?.trim() || "openai/gpt-5-mini";
// gpt-5-* — reasoning-модели: бюджет токенов уходит и на рассуждение, и на вывод.
// При маленьком лимите модель «думает», упирается в потолок и возвращает пустой
// content → невалидный JSON → fallback. Поэтому даём запас; настраивается env.
const MAX_TOKENS = (() => {
  const n = Number(process.env.TIMEWEB_AI_MAX_TOKENS);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 4000;
})();

// ---------- входные типы ----------

type ProductRow = {
  name?: string;
  sku?: string;
  profit?: number;
  margin?: number;
};

type AnalyzeInput = {
  revenue?: number;
  profit?: number;
  margin?: number;
  commission?: number;
  logistics?: number;
  ads?: number;
  storage?: number;
  cost?: number;
  tax?: number;
  other_expenses?: number;
  // расширенные поля из NetProfitBreakdown
  loyaltyPayouts?: number;
  updServicesTotal?: number;
  updCommissionTotal?: number;
  packaging?: number;
  delivery?: number;
  salary?: number;
  netProfit?: number;
  productsWithoutCost?: number;
  marketplace?: string;
  mode?: string;
  products?: unknown[];
  // последние расчёты (агрегаты по каждому) + период отчёта, если доступны
  recentCalcs?: unknown[];
  period?: string;
};

// ---------- выходной тип (новый формат) ----------

type KeyInsight = {
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
};

type ProfitLeak = {
  area: string;
  amount: number | null;
  comment: string;
};

type ProductRisk = {
  name: string;
  sku?: string;
  reason: string;
  action: string;
};

type RecommendedAction = {
  priority: number;
  action: string;
  why: string;
  expectedEffect: string;
};

export type FallbackReason =
  | "missing_api_key"
  | "invalid_key_format"
  | "openai_error"
  | "invalid_json"
  | "timeout"
  | "unknown";

export type AiDebugInfo = {
  hasGatewayKey: boolean;
  hasGatewayModel: boolean;
  gatewayModel: string;
  runtime: "server";
  // Безопасная диагностика ФОРМАТА ключа — сам ключ НЕ раскрываем,
  // только boolean-проверки и длину.
  keyContainsEquals?: boolean;
  keyContainsWhitespace?: boolean;
  keyLength?: number;
  // Заполняется при ошибке Gateway (upstream.ok === false)
  gatewayStatus?: number | null;
  gatewayErrorType?: string | null;
  gatewayErrorCode?: string | null;
  gatewayErrorMessage?: string | null;
};

// ---------- новый структурированный формат «книжки» ----------
// Модель возвращает готовые страницы: заголовок, тип, строки-выводы, метрики
// (для шкал), действия и риски. Числа остаются детерминированными (считаем
// локально), AI отвечает за текстовый разбор — никаких выдуманных сумм.
export type ProfitStatus = "good" | "warning" | "bad";

export type AiPageType =
  | "summary"
  | "expense_structure"
  | "profit_leaks"
  | "sku"
  | "actions"
  | "risks"
  | "plan";

export type AiMetric = {
  label: string;
  value: string; // готовая строка для показа, напр. "98 180 ₽"
  share: number | null; // доля в % от выручки (ширина шкалы) или null
  tone: "good" | "warning" | "bad" | "neutral";
};

export type AiBookPageDoc = {
  title: string;
  type: AiPageType;
  lines: string[]; // 4–6 коротких смысловых строк
  metrics: AiMetric[]; // опц. (для «структуры расходов»)
  actions: string[]; // опц.: проблема → почему → что сделать
  risks: string[]; // опц.: строки рисков
};

export type AiAnalysisDoc = {
  summary: {
    mainConclusion: string;
    profitStatus: ProfitStatus;
    mainProblem: string;
    mainAction: string;
  };
  pages: AiBookPageDoc[];
};

// ---------- готовые данные 7 страниц AI Аналитики (контракт с фронтом) ----------
// Это структура, которую модель Timeweb GPT-5 mini возвращает строгим JSON, а
// фронт рендерит как «книжку». Числа берёт модель из переданных агрегатов —
// новых сумм не выдумывает (см. промпт). Лежит в ответе под ключом aiDoc,
// чтобы не конфликтовать с legacy-полем profitLeaks (другой формы).
export type AiRiskLevel = "low" | "medium" | "high";

export type AiDoc = {
  diagnosis: {
    mainConclusion: string;
    mainRisk: string;
    profitSafety: string;
  };
  moneyBreakdown: {
    label: string;
    amount: number;
    percent: number;
    comment: string;
  }[];
  profitLeaks: {
    title: string;
    amount: number;
    whyItMatters: string;
    action: string;
    expectedEffect: string;
  }[];
  skuAudit: {
    sku: string;
    name: string;
    problem: string;
    profit: number;
    margin: number;
    action: string;
  }[];
  risks: {
    level: AiRiskLevel;
    title: string;
    reason: string;
    action: string;
  }[];
  sevenDayPlan: {
    day: number;
    task: string;
    expectedResult: string;
  }[];
  finalActions: {
    title: string;
    action: string;
    expectedEffect: string;
  }[];
};

export type AiResult = {
  source: "timeweb_gateway" | "fallback";
  fallbackReason?: FallbackReason;
  /** Диагностика: только в source=fallback, НЕ раскрывает секреты. */
  debug?: AiDebugInfo;
  summary: string;
  healthScore: number;
  mainProblem: string;
  keyInsights: KeyInsight[];
  profitLeaks: ProfitLeak[];
  productRisks: ProductRisk[];
  recommendedActions: RecommendedAction[];
  missingData: string[];
  /** Прежний структурированный разбор книжки (legacy-формат summary+pages). */
  analysis?: AiAnalysisDoc;
  /** Готовые данные 7 страниц от модели (заполнены ТОЛЬКО при source=timeweb_gateway). */
  aiDoc?: AiDoc;
};

// ---------- хелперы ----------

const isFinNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const num = (v: unknown): number => (isFinNum(v) ? v : 0);

const clamp = (min: number, max: number, v: number) =>
  Math.max(min, Math.min(max, v));

function fmtRub(n: number): string {
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}

/** Только ожидаемые числа + 2 enum-строки + топ-15 товаров (имя + числа). */
function sanitizeInput(p: AnalyzeInput) {
  const products: ProductRow[] = [];
  if (Array.isArray(p.products)) {
    for (const item of p.products.slice(0, 15)) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      products.push({
        name: typeof o.name === "string" ? o.name.trim().slice(0, 80) : undefined,
        sku: typeof o.sku === "string" ? o.sku.trim().slice(0, 40) : undefined,
        profit: isFinNum(o.profit) ? o.profit : undefined,
        margin: isFinNum(o.margin) ? o.margin : undefined,
      });
    }
  }
  // последние расчёты: только агрегаты по каждому (числа + тип площадки)
  const recentCalcs: {
    revenue: number;
    profit: number;
    margin: number;
    marketplace: string;
  }[] = [];
  if (Array.isArray(p.recentCalcs)) {
    for (const item of p.recentCalcs.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      recentCalcs.push({
        revenue: num(o.revenue),
        profit: num(o.profit),
        margin: num(o.margin),
        marketplace: o.marketplace === "wb" ? "wb" : "ozon",
      });
    }
  }
  return {
    revenue: num(p.revenue),
    profit: num(p.profit),
    margin: num(p.margin),
    commission: num(p.commission),
    logistics: num(p.logistics),
    ads: num(p.ads),
    storage: num(p.storage),
    cost: num(p.cost),
    tax: num(p.tax),
    other_expenses: num(p.other_expenses),
    loyaltyPayouts: num(p.loyaltyPayouts),
    updServicesTotal: num(p.updServicesTotal),
    updCommissionTotal: num(p.updCommissionTotal),
    packaging: num(p.packaging),
    delivery: num(p.delivery),
    salary: num(p.salary),
    netProfit: num(p.netProfit),
    productsWithoutCost: num(p.productsWithoutCost),
    marketplace: p.marketplace === "wb" ? "wb" : "ozon",
    mode:
      typeof p.mode === "string" && p.mode.trim()
        ? p.mode.trim().slice(0, 16)
        : "manual",
    period:
      typeof p.period === "string" ? p.period.trim().slice(0, 40) : "",
    products,
    recentCalcs,
  };
}

type SanitizedData = ReturnType<typeof sanitizeInput>;

// ---------- проверка плана (auth уже пройден) ----------

/** Проверяем: plan='unlimited' AND premium_until > now(). */
async function checkUnlimitedPlan(
  auth: Extract<Awaited<ReturnType<typeof authenticateRequest>>, { ok: true }>
): Promise<boolean> {
  try {
    const { data, error } = await auth.admin
      .from("profiles")
      .select("plan, premium_until")
      .eq("id", auth.userId)
      .single();
    if (error || !data) return false;
    if (data.plan !== "unlimited") return false;
    if (!data.premium_until) return false;
    return Date.parse(data.premium_until) > Date.now();
  } catch {
    return false;
  }
}

// ---------- rule-based fallback ----------

function buildFallback(
  d: SanitizedData,
  reason: FallbackReason = "unknown",
  debug?: AiDebugInfo
): AiResult {
  const r = d.revenue;
  const pct = (v: number) =>
    r > 0 ? Math.round((v / r) * 1000) / 10 : 0; // 1 знак после точки

  const commPct = pct(d.commission);
  const logPct = pct(d.logistics);
  const adsPct = pct(d.ads);
  const taxPct = pct(d.tax);
  const costPct = pct(d.cost);
  const margin = d.margin;

  // healthScore
  let healthScore = 50;
  if (margin > 25) healthScore = 82;
  else if (margin > 15) healthScore = 66;
  else if (margin > 8) healthScore = 50;
  else if (margin > 0) healthScore = 30;
  else healthScore = 12;
  if (adsPct > 20) healthScore -= 10;
  if (commPct > 25) healthScore -= 8;
  if (logPct > 20) healthScore -= 5;
  healthScore = Math.round(clamp(5, 95, healthScore));

  // наибольшая статья расходов
  const expenseList = [
    { area: "Комиссии" as const, amount: d.commission, pct: commPct, warnAt: 20 },
    { area: "Логистика" as const, amount: d.logistics, pct: logPct, warnAt: 15 },
    { area: "Реклама" as const, amount: d.ads, pct: adsPct, warnAt: 15 },
    { area: "Налог" as const, amount: d.tax, pct: taxPct, warnAt: 8 },
    { area: "Себестоимость" as const, amount: d.cost, pct: costPct, warnAt: 45 },
  ].filter((e) => e.amount > 0);

  const highExpenses = expenseList.filter((e) => e.pct > e.warnAt);

  let mainProblem: string;
  if (margin <= 0) {
    mainProblem =
      "Расчёт показывает убыток — суммарные расходы превышают выручку";
  } else if (highExpenses.length > 0) {
    mainProblem = `Высокая доля ${highExpenses[0].area.toLowerCase()} (${highExpenses[0].pct}% от выручки) снижает чистую прибыль`;
  } else {
    mainProblem =
      "Финансовые показатели в норме, есть точки для оптимизации";
  }

  const summary =
    r > 0
      ? `Маржа ${margin.toFixed(1)}%, чистая прибыль ${fmtRub(d.profit)} при выручке ${fmtRub(r)}. ${mainProblem}.`
      : "Недостаточно данных для формирования вывода.";

  // keyInsights — минимум 3, всегда с конкретными цифрами
  const keyInsights: KeyInsight[] = [];

  // 1. Маржа (всегда)
  if (margin <= 0) {
    keyInsights.push({
      title: "Убыток по расчёту",
      description: `Чистая прибыль: ${fmtRub(d.profit)}. Суммарные расходы превышают выручку — продажи убыточны.`,
      severity: "high",
    });
  } else if (margin <= 8) {
    keyInsights.push({
      title: "Критически низкая маржа",
      description: `Маржа ${margin.toFixed(1)}% — минимальный запас прочности. Рост комиссии или логистики на 2–3% даст убыток.`,
      severity: "high",
    });
  } else if (margin <= 15) {
    keyInsights.push({
      title: "Маржа ниже среднего",
      description: `Маржа ${margin.toFixed(1)}% — ниже комфортного уровня (15–25%) для маркетплейсов. Чистая прибыль ${fmtRub(d.profit)}.`,
      severity: "medium",
    });
  } else {
    keyInsights.push({
      title: "Хорошая маржа",
      description: `Маржа ${margin.toFixed(1)}% — выше среднего по маркетплейсам. Чистая прибыль ${fmtRub(d.profit)} при выручке ${fmtRub(r)}.`,
      severity: "low",
    });
  }

  // 2. Реклама
  if (adsPct > 15) {
    keyInsights.push({
      title: "Высокие расходы на рекламу",
      description: `Реклама ${fmtRub(d.ads)} — это ${adsPct}% выручки. Норма для маркетплейсов — до 10–15%. Превышение на ${(adsPct - 12).toFixed(1)}%.`,
      severity: adsPct > 20 ? "high" : "medium",
    });
  } else if (d.ads > 0) {
    keyInsights.push({
      title: "Реклама в норме",
      description: `Расходы на рекламу ${fmtRub(d.ads)} (${adsPct}%) — в пределах нормы для маркетплейсов.`,
      severity: "low",
    });
  }

  // 3. Комиссия
  if (commPct > 22) {
    keyInsights.push({
      title: "Высокая комиссия маркетплейса",
      description: `Комиссия ${fmtRub(d.commission)} (${commPct}% выручки). Проверьте, правильно ли выбрана категория товара.`,
      severity: "medium",
    });
  } else if (d.commission > 0 && keyInsights.length < 3) {
    keyInsights.push({
      title: "Комиссия маркетплейса",
      description: `Комиссия составила ${fmtRub(d.commission)} — ${commPct}% от выручки. Это основная статья расходов.`,
      severity: commPct > 18 ? "medium" : "low",
    });
  }

  // 4. Логистика
  if (logPct > 18) {
    keyInsights.push({
      title: "Высокая логистика",
      description: `Логистика ${fmtRub(d.logistics)} (${logPct}%) — выше нормы. Возможен высокий % возвратов или крупногабаритный товар.`,
      severity: "medium",
    });
  } else if (d.logistics > 0 && keyInsights.length < 3) {
    keyInsights.push({
      title: "Логистика",
      description: `Расходы на логистику: ${fmtRub(d.logistics)} (${logPct}% выручки).`,
      severity: logPct > 12 ? "medium" : "low",
    });
  }

  // 5. УПД-услуги Ozon
  if (d.updServicesTotal > 0 && d.updServicesTotal > d.commission * 0.3) {
    keyInsights.push({
      title: "Значительные услуги по УПД",
      description: `Услуги Ozon по УПД: ${fmtRub(d.updServicesTotal)} — проверьте состав и корректность списаний.`,
      severity: "medium",
    });
  }

  // Гарантируем минимум 3 инсайта: добавляем универсальный, если мало
  if (keyInsights.length < 3 && r > 0) {
    keyInsights.push({
      title: "Структура расходов",
      description: `Из ${fmtRub(r)} выручки: комиссия ${fmtRub(d.commission)}, логистика ${fmtRub(d.logistics)}, реклама ${fmtRub(d.ads)}.`,
      severity: "low",
    });
  }
  if (keyInsights.length < 3 && d.productsWithoutCost > 0) {
    keyInsights.push({
      title: "Неполные данные о себестоимости",
      description: `${d.productsWithoutCost} товаров без себестоимости — реальная прибыль может быть ниже расчётной.`,
      severity: "medium",
    });
  }

  // profitLeaks
  const profitLeaks: ProfitLeak[] = expenseList.map((e) => ({
    area: e.area,
    amount: Math.round(e.amount),
    comment: `${e.pct}% от выручки${e.pct > e.warnAt ? " — выше нормы" : ""}`,
  }));
  if (d.updServicesTotal > 0) {
    profitLeaks.push({
      area: "УПД",
      amount: Math.round(d.updServicesTotal),
      comment: "Услуги Ozon по УПД-отчёту",
    });
  }

  // productRisks из переданных данных
  const productRisks: ProductRisk[] = (d.products ?? [])
    .filter((p) => isFinNum(p.profit) && (p.profit as number) < 0)
    .slice(0, 5)
    .map((p) => ({
      name: p.name ?? "Товар без названия",
      sku: p.sku,
      reason: `Убыток ${fmtRub(p.profit ?? 0)}`,
      action: "Проверьте ценообразование и себестоимость",
    }));

  if (d.productsWithoutCost > 0) {
    productRisks.push({
      name: `${d.productsWithoutCost} товаров без себестоимости`,
      reason: "Прибыль рассчитана без учёта себестоимости",
      action: "Добавьте себестоимость в справочник товаров",
    });
  }

  // recommendedActions — всегда 3-5 конкретных пунктов
  const recommendedActions: RecommendedAction[] = [];
  let p = 1;

  // Реклама
  if (adsPct > 15) {
    recommendedActions.push({
      priority: p++,
      action: "Снизить расходы на рекламу",
      why: `Реклама ${fmtRub(d.ads)} — это ${adsPct}% выручки при норме 10–15%`,
      expectedEffect: `Экономия до ${fmtRub(d.ads * 0.2)} в месяц при сокращении ставок на неэффективных кампаниях`,
    });
  } else if (d.ads > 0 && adsPct < 5) {
    recommendedActions.push({
      priority: p++,
      action: "Рассмотреть увеличение рекламного бюджета",
      why: `Реклама ${adsPct}% — возможно, низкая видимость товаров на площадке`,
      expectedEffect: "Рост выручки может перекрыть рекламные расходы при правильном таргетинге",
    });
  }

  // Маржа / цена
  if (margin <= 0) {
    recommendedActions.push({
      priority: p++,
      action: "Срочно пересмотреть ценообразование",
      why: `Расчёт убыточен: ${fmtRub(d.profit)}. Каждая продажа приносит убыток`,
      expectedEffect: "Выход в безубыток при повышении цены или снижении себестоимости",
    });
  } else if (margin < 10) {
    recommendedActions.push({
      priority: p++,
      action: "Пересмотреть цену или пересчитать себестоимость",
      why: `Маржа ${margin.toFixed(1)}% — критически низкий запас. Любой рост расходов даст убыток`,
      expectedEffect: `Повышение маржи до 15% добавит к прибыли ${fmtRub(d.profit)} примерно ${fmtRub(r * 0.05)}`,
    });
  }

  // Комиссия
  if (commPct > 22) {
    recommendedActions.push({
      priority: p++,
      action: "Проверить категорию размещения товара",
      why: `Комиссия ${fmtRub(d.commission)} (${commPct}%) — выглядит высокой для данной категории`,
      expectedEffect: "Снижение комиссии на 5% сэкономит " + fmtRub(r * 0.05) + " при той же выручке",
    });
  }

  // Себестоимость
  if (d.productsWithoutCost > 0) {
    recommendedActions.push({
      priority: p++,
      action: "Заполнить себестоимость для всех товаров",
      why: `${d.productsWithoutCost} товаров считаются без себестоимости — прибыль завышена`,
      expectedEffect: "Точный расчёт чистой прибыли по каждой позиции после заполнения справочника",
    });
  }

  // Логистика
  if (logPct > 18) {
    recommendedActions.push({
      priority: p++,
      action: "Проверить причины высокой логистики",
      why: `Логистика ${fmtRub(d.logistics)} (${logPct}%) — выше нормы. Возможны возвраты или нерациональная упаковка`,
      expectedEffect: "Сокращение логистики на 3-5% даст экономию " + fmtRub(d.logistics * 0.04),
    });
  }

  // Убыточные товары
  const lossProducts = (d.products ?? []).filter(
    (pr) => isFinNum(pr.profit) && (pr.profit as number) < 0
  );
  if (lossProducts.length > 0) {
    recommendedActions.push({
      priority: p++,
      action: `Разобраться с убыточными товарами (${lossProducts.length} шт.)`,
      why: `${lossProducts.length} товаров приносят убыток — они тянут общую прибыль вниз`,
      expectedEffect: "Снятие убыточных позиций или пересмотр цен улучшит общий результат",
    });
  }

  // Гарантируем минимум 3 рекомендации — добавляем универсальные
  if (recommendedActions.length < 3) {
    if (!d.cost) {
      recommendedActions.push({
        priority: p++,
        action: "Внести себестоимость товаров в систему",
        why: "Без себестоимости расчёт показывает валовую прибыль, а не чистую",
        expectedEffect: "Полная картина рентабельности каждой позиции",
      });
    }
    if (recommendedActions.length < 3) {
      recommendedActions.push({
        priority: p++,
        action: "Провести ABC-анализ товарного портфеля",
        why: "Выявить 20% товаров, которые дают 80% прибыли",
        expectedEffect: "Концентрация бюджета на прибыльных позициях повышает общую маржу",
      });
    }
    if (recommendedActions.length < 3 && r > 0) {
      recommendedActions.push({
        priority: p++,
        action: "Сравнить показатели с прошлым периодом",
        why: "Динамика маржи и выручки покажет тренд — рост или падение",
        expectedEffect: "Своевременное выявление ухудшения позволит принять меры раньше",
      });
    }
  }

  // missingData
  const missingData: string[] = [];
  if (!d.cost) missingData.push("Себестоимость товаров");
  if (!d.updServicesTotal && !d.updCommissionTotal)
    missingData.push("Данные УПД-отчёта (для детального анализа услуг Ozon)");
  if (!d.products || d.products.length === 0)
    missingData.push("Детализация по товарам (для выявления убыточных позиций)");

  return {
    source: "fallback" as const,
    fallbackReason: reason,
    debug,
    summary,
    healthScore,
    mainProblem,
    keyInsights: keyInsights.slice(0, 5),
    profitLeaks,
    productRisks,
    recommendedActions: recommendedActions.slice(0, 5),
    missingData,
  };
}

// ---------- нормализация ответа OpenAI ----------

function toStr(v: unknown, maxLen = 300): string {
  return typeof v === "string" ? v.trim().slice(0, maxLen) : "";
}

function toNum(v: unknown): number {
  return isFinNum(v) ? v : 0;
}

function normalizeKeyInsights(raw: unknown): KeyInsight[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 4)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const sev = o.severity;
      return {
        title: toStr(o.title, 80),
        description: toStr(o.description, 300),
        severity: (sev === "high" || sev === "medium" || sev === "low"
          ? sev
          : "medium") as KeyInsight["severity"],
      };
    })
    .filter((x): x is KeyInsight => !!x && x.title.length > 0);
}

function normalizeProfitLeaks(raw: unknown): ProfitLeak[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      return {
        area: toStr(o.area, 40) || "Прочее",
        amount: isFinNum(o.amount) ? Math.round(o.amount) : null,
        comment: toStr(o.comment, 200),
      };
    })
    .filter((x): x is ProfitLeak => x !== null);
}

function normalizeProductRisks(raw: unknown): ProductRisk[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductRisk[] = [];
  for (const item of raw.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = toStr(o.name, 80) || "Товар";
    if (!name) continue;
    out.push({
      name,
      sku: toStr(o.sku, 40) || undefined,
      reason: toStr(o.reason, 200),
      action: toStr(o.action, 200),
    });
  }
  return out;
}

function normalizeRecommendedActions(raw: unknown): RecommendedAction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 4)
    .map((item, idx) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      return {
        priority: isFinNum(o.priority) ? Math.round(o.priority) : idx + 1,
        action: toStr(o.action, 200),
        why: toStr(o.why, 200),
        expectedEffect: toStr(o.expectedEffect, 200),
      };
    })
    .filter((x): x is RecommendedAction => x !== null && x.action.length > 0);
}

function normalizeAiResult(raw: unknown): AiResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const summary = toStr(o.summary, 600);
  const healthScore = clamp(0, 100, Math.round(toNum(o.healthScore)));
  const mainProblem = toStr(o.mainProblem, 300);
  const keyInsights = normalizeKeyInsights(o.keyInsights);
  const profitLeaks = normalizeProfitLeaks(o.profitLeaks);
  const productRisks = normalizeProductRisks(o.productRisks);
  const recommendedActions = normalizeRecommendedActions(o.recommendedActions);
  const missingData = Array.isArray(o.missingData)
    ? (o.missingData as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 200))
        .slice(0, 5)
    : [];

  // считаем ответ невалидным только если нет ни summary, ни одного инсайта
  if (!summary && keyInsights.length === 0 && recommendedActions.length === 0) {
    return null;
  }

  return {
    source: "timeweb_gateway",
    summary,
    healthScore,
    mainProblem,
    keyInsights,
    profitLeaks,
    productRisks,
    recommendedActions,
    missingData,
  };
}

// ---------- нормализация нового формата { summary, pages } ----------

const PAGE_TYPES: AiPageType[] = [
  "summary",
  "expense_structure",
  "profit_leaks",
  "sku",
  "actions",
  "risks",
  "plan",
];

/** Терпимо приводим к массиву коротких строк: принимаем массив ИЛИ строку
 *  (с переносами/точками) — модель иногда отдаёт text вместо lines. */
function toStrArr(raw: unknown, maxItems: number, maxLen: number): string[] {
  let parts: string[];
  if (typeof raw === "string") {
    parts = raw.split(/\r?\n|(?<=[.!?])\s+(?=[А-ЯA-ZЁ0-9])/);
  } else if (Array.isArray(raw)) {
    parts = raw.map((x) => (typeof x === "string" ? x : ""));
  } else {
    return [];
  }
  return parts
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .slice(0, maxItems)
    .map((s) => s.slice(0, maxLen));
}

function normalizeMetrics(raw: unknown): AiMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: AiMetric[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const label = toStr(o.label, 48);
    if (!label) continue;
    const shareRaw = isFinNum(o.share)
      ? (o.share as number)
      : isFinNum(o.pct)
      ? (o.pct as number)
      : null;
    const tone = o.tone;
    out.push({
      label,
      value: toStr(o.value, 40),
      share: shareRaw === null ? null : Math.round(shareRaw * 10) / 10,
      tone:
        tone === "good" || tone === "warning" || tone === "bad"
          ? tone
          : "neutral",
    });
  }
  return out;
}

/** Строгий, но терпимый парсер { summary, pages }. Пустые страницы выкидываем,
 *  чтобы во фронте не было пустых слайдов. null → уходим в fallback. */
function normalizeAnalysisDoc(raw: unknown): AiAnalysisDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const s = (
    o.summary && typeof o.summary === "object" ? o.summary : {}
  ) as Record<string, unknown>;
  const ps = s.profitStatus;
  const summary = {
    mainConclusion: toStr(s.mainConclusion, 300),
    profitStatus: (ps === "good" || ps === "warning" || ps === "bad"
      ? ps
      : "warning") as ProfitStatus,
    mainProblem: toStr(s.mainProblem, 300),
    mainAction: toStr(s.mainAction, 300),
  };

  const rawPages = Array.isArray(o.pages) ? o.pages : [];
  const pages: AiBookPageDoc[] = [];
  rawPages.slice(0, 9).forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const p = item as Record<string, unknown>;
    const typ = PAGE_TYPES.includes(p.type as AiPageType)
      ? (p.type as AiPageType)
      : PAGE_TYPES[Math.min(idx, PAGE_TYPES.length - 1)];
    const lines = toStrArr(p.lines ?? p.text, 8, 220);
    const metrics = normalizeMetrics(p.metrics);
    const actions = toStrArr(p.actions, 6, 240);
    const risks = toStrArr(p.risks, 6, 240);
    // Пустую страницу не добавляем (не показываем пустых слайдов).
    if (lines.length + metrics.length + actions.length + risks.length === 0) {
      return;
    }
    pages.push({
      title: toStr(p.title, 60) || typ,
      type: typ,
      lines,
      metrics,
      actions,
      risks,
    });
  });

  // Считаем валидным, если есть главный вывод и достаточно наполненных страниц.
  if (pages.length === 0) return null;
  if (!summary.mainConclusion && pages.length < 3) return null;
  return { summary, pages };
}

/** Строгий, но терпимый парсер нового контракта 7 страниц (aiDoc).
 *  Пустые секции выкидываем; слишком скудный ответ → null (уходим в fallback,
 *  чтобы НЕ показывать rule-based под видом AI). */
function normalizeAiDoc(raw: unknown): AiDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const dg = (
    o.diagnosis && typeof o.diagnosis === "object" ? o.diagnosis : {}
  ) as Record<string, unknown>;
  const diagnosis = {
    mainConclusion: toStr(dg.mainConclusion, 400),
    mainRisk: toStr(dg.mainRisk, 400),
    profitSafety: toStr(dg.profitSafety, 400),
  };

  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x === "object")
          .map((x) => x as Record<string, unknown>)
      : [];

  const moneyBreakdown = arr(o.moneyBreakdown)
    .slice(0, 10)
    .map((m) => ({
      label: toStr(m.label, 60),
      amount: toNum(m.amount),
      percent: toNum(m.percent),
      comment: toStr(m.comment, 240),
    }))
    .filter((m) => m.label);

  const profitLeaks = arr(o.profitLeaks)
    .slice(0, 8)
    .map((l) => ({
      title: toStr(l.title, 120),
      amount: toNum(l.amount),
      whyItMatters: toStr(l.whyItMatters, 280),
      action: toStr(l.action, 280),
      expectedEffect: toStr(l.expectedEffect, 200),
    }))
    .filter((l) => l.title || l.action);

  const skuAudit = arr(o.skuAudit)
    .slice(0, 12)
    .map((s) => ({
      sku: toStr(s.sku, 40),
      name: toStr(s.name, 80),
      problem: toStr(s.problem, 240),
      profit: toNum(s.profit),
      margin: toNum(s.margin),
      action: toStr(s.action, 240),
    }))
    .filter((s) => s.name || s.sku);

  const risks = arr(o.risks)
    .slice(0, 8)
    .map((r) => {
      const lvl = r.level;
      return {
        level: (lvl === "low" || lvl === "medium" || lvl === "high"
          ? lvl
          : "medium") as AiRiskLevel,
        title: toStr(r.title, 120),
        reason: toStr(r.reason, 240),
        action: toStr(r.action, 240),
      };
    })
    .filter((r) => r.title || r.reason);

  const sevenDayPlan = arr(o.sevenDayPlan)
    .slice(0, 7)
    .map((p, i) => ({
      day: isFinNum(p.day)
        ? clamp(1, 7, Math.round(p.day as number))
        : i + 1,
      task: toStr(p.task, 200),
      expectedResult: toStr(p.expectedResult, 200),
    }))
    .filter((p) => p.task);

  const finalActions = arr(o.finalActions)
    .slice(0, 3)
    .map((a) => ({
      title: toStr(a.title, 120),
      action: toStr(a.action, 240),
      expectedEffect: toStr(a.expectedEffect, 200),
    }))
    .filter((a) => a.title || a.action);

  const filled =
    moneyBreakdown.length +
    profitLeaks.length +
    skuAudit.length +
    risks.length +
    sevenDayPlan.length +
    finalActions.length;
  // Нужен главный вывод и хотя бы несколько наполненных секций.
  if (!diagnosis.mainConclusion || filled < 3) return null;

  return {
    diagnosis,
    moneyBreakdown,
    profitLeaks,
    skuAudit,
    risks,
    sevenDayPlan,
    finalActions,
  };
}

// ---------- dev-only диагностика (в production не логируем) ----------

const AI_DEV = process.env.NODE_ENV !== "production";
function devLog(msg: string, extra?: unknown): void {
  if (!AI_DEV) return;
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.log("[ai/analyze][dev] " + msg, extra);
  // eslint-disable-next-line no-console
  else console.log("[ai/analyze][dev] " + msg);
}
function devWarn(msg: string, extra?: unknown): void {
  if (!AI_DEV) return;
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.warn("[ai/analyze][dev] " + msg, extra);
  // eslint-disable-next-line no-console
  else console.warn("[ai/analyze][dev] " + msg);
}
function devError(msg: string, extra?: unknown): void {
  if (!AI_DEV) return;
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.error("[ai/analyze][dev] " + msg, extra);
  // eslint-disable-next-line no-console
  else console.error("[ai/analyze][dev] " + msg);
}

// ---------- production-safe диагностика (видна в server logs Timeweb) ----------
/**
 * Безопасный лог, который ОСТАЁТСЯ в production (в отличие от devLog) — чтобы по
 * логам Timeweb было видно, почему запрос ушёл в fallback. Пишем ТОЛЬКО безопасные
 * скаляры: статусы, флаги true/false, имя модели, длины, причины, userId (UUID).
 * НИКОГДА не пишем: ключ/токен, тело отчёта, текст ответа модели, прочие PII.
 */
function aiLog(
  event: string,
  fields?: Record<string, string | number | boolean | null>
): void {
  // eslint-disable-next-line no-console
  if (fields) console.log("[ai/analyze]", event, fields);
  // eslint-disable-next-line no-console
  else console.log("[ai/analyze]", event);
}

// ---------- свободный текст как запасной формат ----------

/** Снимаем markdown-обёртку ```json … ``` / ``` … ```, если она есть. */
function stripCodeFences(s: string): string {
  const m = s.trim().match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : s).trim();
}

/**
 * Если модель ответила не JSON-ом, а осмысленным текстом — возвращаем
 * почищенный текст; для мусора/слишком короткого ответа возвращаем "".
 */
function sanitizeFreeText(s: string): string {
  const t = stripCodeFences(s).replace(/\s+/g, " ").trim().slice(0, 1200);
  const letters = (t.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  return letters >= 20 ? t : "";
}

/**
 * Показываем свободный текст модели как AI-аналитику (source: "timeweb_gateway"):
 * числовую структуру берём из локального расчёта, а сам текст — в summary.
 * Технические поля (debug/fallbackReason) клиенту НЕ уходят.
 */
function buildFromText(d: SanitizedData, text: string): AiResult {
  const base = buildFallback(d);
  return {
    ...base,
    source: "timeweb_gateway",
    fallbackReason: undefined,
    debug: undefined,
    mainProblem: "",
    summary: text,
  };
}

// ---------- сборка aiDoc из «нестрогих» успешных ответов Gateway ----------

/** moneyBreakdown из РЕАЛЬНЫХ чисел расчёта (ничего не выдумываем). */
function moneyBreakdownFromData(d: SanitizedData): AiDoc["moneyBreakdown"] {
  const r = d.revenue;
  const pct = (v: number) => (r > 0 ? Math.round((v / r) * 1000) / 10 : 0);
  return [
    { label: "Себестоимость", amount: d.cost, percent: pct(d.cost), comment: "" },
    { label: "Комиссии", amount: d.commission, percent: pct(d.commission), comment: "" },
    { label: "Логистика", amount: d.logistics, percent: pct(d.logistics), comment: "" },
    { label: "Реклама", amount: d.ads, percent: pct(d.ads), comment: "" },
    { label: "Налог", amount: d.tax, percent: pct(d.tax), comment: "" },
  ].filter((m) => m.amount > 0);
}

/**
 * Превращаем ЛЮБОЙ осмысленный успешный ответ Gateway, который не лёг строго в
 * схему aiDoc (старая схема {summary,pages} / legacy / свободный текст), в валидный
 * aiDoc — чтобы фронт показал это как настоящий AI-разбор, а не маскировал под
 * «Базовую аналитику» (фронт рендерит реальный AI только при наличии aiDoc).
 * Тексты — от модели; числа moneyBreakdown — из реального расчёта. Если контента
 * собрать не удалось (нет главного вывода или все суммы нулевые) → null.
 */
function looseAiDoc(
  d: SanitizedData,
  c: {
    mainConclusion: string;
    mainRisk?: string;
    profitSafety?: string;
    profitLeaks?: AiDoc["profitLeaks"];
    risks?: AiDoc["risks"];
    finalActions?: AiDoc["finalActions"];
    sevenDayPlan?: AiDoc["sevenDayPlan"];
    skuAudit?: AiDoc["skuAudit"];
  }
): AiDoc | null {
  const mainConclusion = c.mainConclusion.trim().slice(0, 400);
  if (!mainConclusion) return null;
  const doc: AiDoc = {
    diagnosis: {
      mainConclusion,
      mainRisk: (c.mainRisk ?? "").trim().slice(0, 400),
      profitSafety: (c.profitSafety ?? "").trim().slice(0, 400),
    },
    moneyBreakdown: moneyBreakdownFromData(d),
    profitLeaks: (c.profitLeaks ?? []).slice(0, 8),
    skuAudit: (c.skuAudit ?? []).slice(0, 12),
    risks: (c.risks ?? []).slice(0, 8),
    sevenDayPlan: (c.sevenDayPlan ?? []).slice(0, 7),
    finalActions: (c.finalActions ?? []).slice(0, 3),
  };
  const filled =
    doc.moneyBreakdown.length +
    doc.profitLeaks.length +
    doc.skuAudit.length +
    doc.risks.length +
    doc.sevenDayPlan.length +
    doc.finalActions.length;
  return filled > 0 ? doc : null;
}

// ---------- строим промпт ----------

function buildPrompt(d: SanitizedData): { system: string; user: string } {
  // Точная схема ответа = контракт aiDoc (готовые данные 7 страниц).
  const schema = {
    diagnosis: {
      mainConclusion:
        "1–2 предложения: главный вывод по прибыли с конкретными цифрами",
      mainRisk: "главный риск для прибыли, с конкретной цифрой",
      profitSafety:
        "запас прочности прибыли: насколько устойчива, с цифрой или долей",
    },
    moneyBreakdown: [
      {
        label: "Комиссия",
        amount: 0,
        percent: 0,
        comment: "что не так с этой статьёй и что проверить",
      },
    ],
    profitLeaks: [
      {
        title: "где теряется прибыль",
        amount: 0,
        whyItMatters: "почему это бьёт по прибыли",
        action: "что конкретно сделать",
        expectedEffect: "ожидаемый эффект",
      },
    ],
    skuAudit: [
      {
        sku: "артикул из переданных данных",
        name: "название из переданных данных",
        problem: "проблема товара",
        profit: 0,
        margin: 0,
        action: "что сделать с этим товаром",
      },
    ],
    risks: [
      {
        level: "low|medium|high",
        title: "название риска",
        reason: "почему это риск, с цифрой",
        action: "что сделать",
      },
    ],
    sevenDayPlan: [
      { day: 1, task: "конкретная задача на день", expectedResult: "ожидаемый результат" },
    ],
    finalActions: [
      {
        title: "приоритетное действие",
        action: "что именно сделать",
        expectedEffect: "ожидаемый эффект",
      },
    ],
  };

  // Базовый промпт — дословно по ТЗ; ниже добавлены требования к формату JSON.
  const system = [
    "Ты финансовый аналитик для продавцов Ozon/WB.",
    "Анализируй только переданные данные. Не выдумывай цифры.",
    "Не давай общие советы типа «увеличьте продажи» или «поднимите цену».",
    "Давай конкретные действия: какие расходы проверить, какие товары требуют внимания, где теряется маржа, что сделать в первую очередь.",
    "Пиши по-русски. Ответ строго JSON.",
    "",
    "Требования к ответу:",
    "— Каждый вывод и риск привязывай к конкретной цифре (сумма в ₽ и/или доля % от выручки) из переданных данных.",
    "— moneyBreakdown: основные статьи расходов с суммой, долей % от выручки и коротким комментарием.",
    "— skuAudit: бери ТОЛЬКО товары из переданного списка (их название/sku), не выдумывай новых. Если товаров нет — верни пустой массив skuAudit.",
    "— sevenDayPlan: ровно 7 пунктов (день 1..7). finalActions: ровно 3 приоритетных действия.",
    "— Никакого markdown, никаких пояснений вне JSON. Верни ровно один JSON-объект по схеме ниже.",
    "",
    "Схема ответа (строго такой JSON, без markdown):",
    JSON.stringify(schema),
  ].join("\n");

  const userData: Record<string, unknown> = {
    маркетплейс: d.marketplace,
    выручка: d.revenue,
    чистая_прибыль: d.netProfit || d.profit,
    маржа_процент: d.margin,
    комиссия: d.commission,
    логистика: d.logistics,
    реклама: d.ads,
    хранение: d.storage,
    себестоимость: d.cost,
    налог: d.tax,
    прочие_расходы: d.other_expenses,
  };
  if (d.period) userData.период_отчёта = d.period;
  if (d.loyaltyPayouts > 0) userData.выплаты_партнёрам = d.loyaltyPayouts;
  if (d.updServicesTotal > 0) userData.услуги_озон_упд = d.updServicesTotal;
  if (d.updCommissionTotal > 0)
    userData.агентское_вознаграждение_упд = d.updCommissionTotal;
  if (d.packaging > 0) userData.упаковка = d.packaging;
  if (d.delivery > 0) userData.доставка_до_склада = d.delivery;
  if (d.salary > 0) userData.зарплата = d.salary;
  if (d.productsWithoutCost > 0)
    userData.товаров_без_себестоимости = d.productsWithoutCost;
  if (d.products.length > 0) userData.товары_топ15 = d.products;
  if (d.recentCalcs.length > 0) userData.последние_расчёты = d.recentCalcs;

  // Явно выделяем сигналы по товарам из уже переданного списка (не новые данные):
  // убыточные (profit<0) и низкомаржинальные (0≤margin<10).
  const lossMaking = d.products.filter(
    (p) => typeof p.profit === "number" && p.profit < 0
  );
  const lowMargin = d.products.filter(
    (p) => typeof p.margin === "number" && p.margin >= 0 && p.margin < 10
  );
  if (lossMaking.length > 0) userData.убыточные_товары = lossMaking;
  if (lowMargin.length > 0) userData.низкомаржинальные_товары = lowMargin;

  const user =
    "Данные расчёта (суммы в ₽, маржа в %):\n" +
    JSON.stringify(userData, null, 2) +
    "\n\nСделай разбор и верни строго JSON по схеме " +
    "(diagnosis, moneyBreakdown, profitLeaks, skuAudit, risks, sevenDayPlan, finalActions).";

  return { system, user };
}

// ============================================================================
// POST /api/ai/analyze
// ============================================================================

export async function POST(req: NextRequest) {
  // Безопасная диагностика без секретов: сам факт вызова роута (виден в server
  // logs Timeweb, в т.ч. в production). Ключи/токены/тело с PII здесь НЕ пишем.
  aiLog("ai route called");

  // ── 1. Аутентификация: Bearer JWT → userId (fail-closed) ──────────────────
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    aiLog("final source", { source: "none", reason: "unauthorized" });
    return auth.response;
  }
  // Безопасная диагностика: userId (UUID, не PII отчёта) — чтобы соотнести запрос.
  aiLog("user id", { userId: auth.userId });

  // ── 2. Авторизация: только active unlimited ───────────────────────────────
  // Клиенту НЕ верим: проверяем plan и premium_until в Supabase.
  const isUnlimited = await checkUnlimitedPlan(auth);
  // Безопасная диагностика без секретов: результат проверки тарифа (true/false).
  aiLog("user premium", { premium: isUnlimited });
  if (!isUnlimited) {
    // Нет активного тарифа 449₽ → 403 и Gateway НЕ вызывается.
    aiLog("final source", { source: "none", reason: "no_active_plan_403" });
    return NextResponse.json(
      {
        ok: false,
        error: "AI Аналитика доступна только в тарифе Безлимит (449₽/мес)",
      },
      { status: 403 }
    );
  }

  // ── 3. Читаем и санируем тело запроса ────────────────────────────────────
  let rawBody: AnalyzeInput;
  try {
    rawBody = (await req.json()) as AnalyzeInput;
  } catch {
    aiLog("final source", { source: "none", reason: "bad_request_body_400" });
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }
  const data = sanitizeInput(rawBody);

  // ── 4. Читаем ключ строго из env и ОБЯЗАТЕЛЬНО trim ──────────────────────
  // Частая причина 401: в env попал лишний мусор
  // (целиком "TIMEWEB_AI_GATEWAY_KEY=...", кавычки, пробелы, перенос строки).
  const rawApiKey = process.env.TIMEWEB_AI_GATEWAY_KEY;
  const apiKey = rawApiKey?.trim();

  // Безопасная диагностика ФОРМАТА (никаких символов ключа наружу).
  // sk-проверки НЕТ: ключи Timeweb Gateway не обязаны начинаться с "sk-".
  const keyContainsEquals = !!apiKey && apiKey.includes("=");
  const keyContainsWhitespace = !!apiKey && /\s/.test(apiKey);
  const keyLength = apiKey ? apiKey.length : 0;

  const debugInfo: AiDebugInfo = {
    hasGatewayKey: !!apiKey,
    hasGatewayModel: !!process.env.TIMEWEB_AI_MODEL,
    gatewayModel: MODEL,
    runtime: "server",
    keyContainsEquals,
    keyContainsWhitespace,
    keyLength,
  };
  devLog("env check", {
    endpoint: GATEWAY_URL,
    hasKey: debugInfo.hasGatewayKey,
    model: debugInfo.gatewayModel,
    hasModelEnv: debugInfo.hasGatewayModel,
    maxTokens: MAX_TOKENS,
    keyContainsEquals,
    keyContainsWhitespace,
    keyLength,
  });

  if (!apiKey) {
    devWarn("TIMEWEB_AI_GATEWAY_KEY не задан — fallback (missing_api_key)");
    aiLog("final source", { source: "fallback", reason: "missing_api_key" });
    return NextResponse.json({ ok: true, ...buildFallback(data, "missing_api_key", debugInfo) });
  }

  // ── 4b. Явно битый формат ключа — НЕ дёргаем Gateway впустую ─────────────
  if (keyContainsEquals) {
    devWarn("неверный формат ключа — fallback (invalid_key_format)", {
      keyContainsEquals,
      keyContainsWhitespace,
      keyLength,
    });
    aiLog("final source", { source: "fallback", reason: "invalid_key_format" });
    return NextResponse.json({
      ok: true,
      ...buildFallback(data, "invalid_key_format", {
        ...debugInfo,
        gatewayErrorMessage:
          "TIMEWEB_AI_GATEWAY_KEY в env должен содержать только сам ключ, без TIMEWEB_AI_GATEWAY_KEY=, кавычек и пробелов.",
      }),
    });
  }

  // ── 5. Вызываем Timeweb AI Gateway (OpenAI-совместимый /chat/completions) ──
  const { system, user } = buildPrompt(data);
  devLog("endpoint called → Gateway", {
    products: data.products.length,
    recentCalcs: data.recentCalcs.length,
    hasPeriod: !!data.period,
  });
  // Безопасная диагностика конфигурации Gateway (без значения ключа/URL):
  // видно, заданы ли env, какая модель и есть ли ключ — частые причины fallback.
  aiLog("gateway config", {
    gatewayUrlEnvSet: !!process.env.TIMEWEB_AI_GATEWAY_URL,
    modelEnvSet: !!process.env.TIMEWEB_AI_MODEL,
    model: MODEL,
    hasKey: !!apiKey,
    maxTokens: MAX_TOKENS,
  });

  let upstream: Response;
  const controller = new AbortController();
  // reasoning-моделям нужно время на «рассуждение» — даём запас по таймауту.
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    upstream = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // gpt-5-* — reasoning-модели: temperature только дефолтная (не задаём),
        // лимит вывода — через max_completion_tokens (max_tokens они отвергают).
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError";
    const msg = e instanceof Error ? e.message : "сеть недоступна";
    devError("Gateway недоступен", msg);
    aiLog("gateway unreachable", { timeout: isTimeout });
    aiLog("final source", {
      source: "fallback",
      reason: isTimeout ? "timeout" : "network_error",
    });
    return NextResponse.json({
      ok: true,
      ...buildFallback(data, isTimeout ? "timeout" : "openai_error", debugInfo),
    });
  } finally {
    clearTimeout(timeout);
  }

  // ── 6. Разбираем ответ Gateway ───────────────────────────────────────────
  const rawText = await upstream.text();

  // Безопасная диагностика без секретов (видна и в production): факт ответа
  // Gateway, его HTTP-статус и ok. ВАЖНО: это НЕ финальный source — реальным
  // источником "timeweb_gateway" считаем только распознанный контент ниже
  // (см. aiLog "final source"). Ключ/тело/текст ответа не пишем.
  aiLog("gateway response", {
    status: upstream.status,
    ok: upstream.ok,
    model: MODEL,
    bodyLength: rawText.length,
  });

  // Всегда логируем статус ответа Gateway (без секретов) — чтобы причина ухода
  // в fallback была видна в server logs Timeweb при ЛЮБОМ исходе:
  //   401/403 → ключ · 404 → endpoint/model · 429/402 → баланс/лимиты Timeweb.
  devLog("ответ Gateway", {
    endpoint: GATEWAY_URL,
    model: MODEL,
    status: upstream.status,
    ok: upstream.ok,
    bodyLength: rawText.length,
  });

  if (!upstream.ok) {
    // Безопасно парсим тело ошибки Gateway — извлекаем status/type/code/message,
    // ключ НЕ логируем и НЕ возвращаем.
    let gwType: string | null = null;
    let gwCode: string | null = null;
    let gwMsg: string | null = null;
    try {
      const errBody = JSON.parse(rawText) as {
        error?: { type?: string; code?: string; message?: string };
      };
      gwType = errBody?.error?.type?.slice(0, 80) ?? null;
      gwCode = errBody?.error?.code?.slice(0, 80) ?? null;
      gwMsg = errBody?.error?.message?.slice(0, 280) ?? null;
    } catch { /* не валидный JSON — оставляем null */ }
    devError("gateway error " + upstream.status, {
      type: gwType, code: gwCode, message: gwMsg,
    });
    // Production-safe: сообщение об ошибке Gateway (без ключей/токенов) — чтобы по
    // логам Timeweb понять причину: 401/403 ключ · 404 endpoint/model · 402/429 баланс.
    aiLog("gateway error", {
      status: upstream.status,
      type: gwType,
      code: gwCode,
      message: gwMsg,
    });
    const errDebug: AiDebugInfo = {
      ...debugInfo,
      gatewayStatus: upstream.status,
      gatewayErrorType: gwType,
      gatewayErrorCode: gwCode,
      gatewayErrorMessage: gwMsg,
    };
    aiLog("final source", {
      source: "fallback",
      reason: "gateway_http_" + upstream.status,
    });
    return NextResponse.json({ ok: true, ...buildFallback(data, "openai_error", errDebug) });
  }

  // Достаём текст ответа и служебные поля из OpenAI-совместимого конверта.
  let content = "";
  let finishReason: string | null = null;
  let usage: unknown = null;
  try {
    const envelope = JSON.parse(rawText) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: unknown;
    };
    content = (envelope?.choices?.[0]?.message?.content ?? "").trim();
    finishReason = envelope?.choices?.[0]?.finish_reason ?? null;
    usage = envelope?.usage ?? null;
  } catch {
    content = "";
  }
  devLog("response received", {
    status: upstream.status,
    contentLength: content.length,
    finishReason,
  });
  // Production-safe: длина контента и finish_reason. finishReason="length" +
  // contentLength=0 ⇒ reasoning-модель исчерпала лимит токенов (поднять
  // TIMEWEB_AI_MAX_TOKENS). Сам текст ответа НЕ пишем.
  aiLog("gateway content", {
    contentLength: content.length,
    finishReason: finishReason ?? "null",
  });

  // 1) Строгий JSON (в т.ч. в markdown-обёртке) → структурированная аналитика.
  let parsed: unknown = null;
  if (content) {
    try {
      parsed = JSON.parse(stripCodeFences(content));
    } catch {
      parsed = null;
    }
  }
  // ПРИОРИТЕТНЫЙ контракт (aiDoc): готовые данные 7 страниц от модели. Разбор и
  // тексты — от AI; рендерит их фронт как «книжку». healthScore/legacy-поля
  // остаются от детерминированного расчёта (для совместимости старого кокпита).
  const aiDoc = normalizeAiDoc(parsed);
  if (aiDoc) {
    devLog("parse success: aiDoc", {
      money: aiDoc.moneyBreakdown.length,
      leaks: aiDoc.profitLeaks.length,
      sku: aiDoc.skuAudit.length,
      risks: aiDoc.risks.length,
      plan: aiDoc.sevenDayPlan.length,
      actions: aiDoc.finalActions.length,
      finishReason,
    });
    const base = buildFallback(data);
    aiLog("final source", { source: "timeweb_gateway", reason: "aiDoc" });
    return NextResponse.json({
      ok: true,
      ...base,
      source: "timeweb_gateway" as const,
      fallbackReason: undefined,
      debug: undefined,
      summary: aiDoc.diagnosis.mainConclusion || base.summary,
      mainProblem: aiDoc.diagnosis.mainRisk || base.mainProblem,
      aiDoc,
    });
  }

  // Прежний формат { summary, pages } → структурированная книжка (на случай,
  // если модель вернула старую схему). Числа — детерминированные.
  const analysis = normalizeAnalysisDoc(parsed);
  if (analysis) {
    devLog("parse success: analysis", {
      pages: analysis.pages.length,
      finishReason,
    });
    const base = buildFallback(data);
    // Собираем aiDoc из старой схемы — иначе фронт (рендерит реальный AI только
    // по aiDoc) замаскирует рабочий ответ Gateway под «Базовую аналитику».
    const aLeaks: AiDoc["profitLeaks"] = [];
    const aRisks: AiDoc["risks"] = [];
    analysis.pages.forEach((pg) => {
      pg.actions.forEach((a) => {
        if (a) aLeaks.push({ title: a.slice(0, 120), amount: 0, whyItMatters: "", action: a.slice(0, 280), expectedEffect: "" });
      });
      pg.risks.forEach((rk) => {
        if (rk) aRisks.push({ level: "medium", title: rk.slice(0, 120), reason: "", action: "" });
      });
    });
    const aActions: AiDoc["finalActions"] = analysis.summary.mainAction
      ? [{ title: "Что сделать в первую очередь", action: analysis.summary.mainAction.slice(0, 240), expectedEffect: "" }]
      : [];
    const aiDocFromAnalysis = looseAiDoc(data, {
      mainConclusion: analysis.summary.mainConclusion || analysis.pages[0]?.lines[0] || "",
      mainRisk: analysis.summary.mainProblem,
      profitLeaks: aLeaks,
      risks: aRisks,
      finalActions: aActions,
    });
    aiLog("final source", {
      source: "timeweb_gateway",
      reason: aiDocFromAnalysis ? "analysis->aiDoc" : "analysis_no_content",
    });
    return NextResponse.json({
      ok: true,
      ...base,
      source: "timeweb_gateway" as const,
      fallbackReason: undefined,
      debug: undefined,
      summary: analysis.summary.mainConclusion || base.summary,
      mainProblem: analysis.summary.mainProblem || base.mainProblem,
      analysis,
      ...(aiDocFromAnalysis ? { aiDoc: aiDocFromAnalysis } : {}),
    });
  }

  // Старый строгий формат (на случай, если модель вернула прежнюю схему).
  const result = normalizeAiResult(parsed);
  if (result) {
    devLog("parse success: legacy schema");
    // Привязываем aiDoc, чтобы фронт показал это как настоящий AI, а не fallback.
    const aiDocFromLegacy = looseAiDoc(data, {
      mainConclusion: result.summary || result.mainProblem,
      mainRisk: result.mainProblem,
    });
    aiLog("final source", {
      source: "timeweb_gateway",
      reason: aiDocFromLegacy ? "legacy->aiDoc" : "legacy_no_content",
    });
    return NextResponse.json({
      ok: true,
      ...result,
      ...(aiDocFromLegacy ? { aiDoc: aiDocFromLegacy } : {}),
    });
  }

  // 2) Не JSON, но осмысленный текст — это НЕ ошибка: показываем как AI-аналитику.
  const freeText = sanitizeFreeText(content);
  if (freeText) {
    devWarn("модель вернула текст вместо JSON — показываем как AI-аналитику");
    const fromText = buildFromText(data, freeText);
    // Привязываем aiDoc (текст модели + реальные числа), чтобы фронт показал это
    // как настоящий AI-разбор, а не «Базовую аналитику».
    const aiDocFromFree = looseAiDoc(data, { mainConclusion: freeText });
    aiLog("final source", {
      source: "timeweb_gateway",
      reason: aiDocFromFree ? "freeText->aiDoc" : "freeText_no_content",
    });
    return NextResponse.json({
      ok: true,
      ...fromText,
      ...(aiDocFromFree ? { aiDoc: aiDocFromFree } : {}),
    });
  }

  // 3) Пусто/мусор — аккуратный fallback. Подробная диагностика — ТОЛЬКО в логах
  //    сервера (никаких секретов: ключ не логируем). finish_reason="length"
  //    означает, что лимит токенов мал — модель не успела отдать ответ.
  devError("невалидный ответ модели", {
    model: MODEL,
    maxTokens: MAX_TOKENS,
    finishReason,
    contentLength: content.length,
    usage,
    rawSnippet: rawText.slice(0, 500),
    hint:
      finishReason === "length"
        ? "Увеличьте TIMEWEB_AI_MAX_TOKENS — лимит токенов исчерпан на reasoning."
        : "Модель вернула пустой/нечитаемый content.",
  });
  devLog("fallback used: invalid_json");
  aiLog("final source", {
    source: "fallback",
    reason: "invalid_json",
    finishReason: finishReason ?? "null",
  });
  return NextResponse.json({ ok: true, ...buildFallback(data, "invalid_json", debugInfo) });
}
