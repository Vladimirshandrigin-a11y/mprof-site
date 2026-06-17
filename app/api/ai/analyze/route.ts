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

// OpenAI-совместимый endpoint Timeweb AI Gateway.
const GATEWAY_URL = "https://api.timeweb.ai/v1/chat/completions";
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

export type AiResult = {
  source: "openai" | "fallback";
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
  /** Новый структурированный разбор для книжки (заполнен при source=openai). */
  analysis?: AiAnalysisDoc;
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
    source: "openai",
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

// ---------- dev-only диагностика (в production не логируем) ----------

const AI_DEV = process.env.NODE_ENV !== "production";
function devLog(msg: string, extra?: unknown): void {
  if (!AI_DEV) return;
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.log("[ai/analyze][dev] " + msg, extra);
  // eslint-disable-next-line no-console
  else console.log("[ai/analyze][dev] " + msg);
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
 * Показываем свободный текст модели как AI-аналитику (source: "openai"):
 * числовую структуру берём из локального расчёта, а сам текст — в summary.
 * Технические поля (debug/fallbackReason) клиенту НЕ уходят.
 */
function buildFromText(d: SanitizedData, text: string): AiResult {
  const base = buildFallback(d);
  return {
    ...base,
    source: "openai",
    fallbackReason: undefined,
    debug: undefined,
    mainProblem: "",
    summary: text,
  };
}

// ---------- строим промпт ----------

function buildPrompt(d: SanitizedData): { system: string; user: string } {
  // Точная схема ответа: книга из 7 страниц + краткое резюме.
  const schema = {
    summary: {
      mainConclusion: "1–2 предложения: главный вывод по прибыли с цифрами",
      profitStatus: "good | warning | bad",
      mainProblem: "главная проблема чистой прибыли с конкретной цифрой",
      mainAction: "одно самое важное действие",
    },
    pages: [
      {
        title: "Главный вывод",
        type: "summary",
        lines: ["4–6 коротких строк с конкретными цифрами"],
        metrics: [],
        actions: [],
        risks: [],
      },
      {
        title: "Структура расходов",
        type: "expense_structure",
        lines: ["4–6 строк: на что уходит выручка"],
        metrics: [
          { label: "Комиссия", value: "98 180 ₽", share: 21.4, tone: "warning" },
        ],
        actions: [],
        risks: [],
      },
      {
        title: "Что съедает прибыль",
        type: "profit_leaks",
        lines: ["4–6 строк: проблема → почему опасно → что проверить"],
        metrics: [],
        actions: [],
        risks: [],
      },
      {
        title: "SKU / товары",
        type: "sku",
        lines: ["разбор товаров ИЛИ честный список недостающих данных"],
        metrics: [],
        actions: [],
        risks: [],
      },
      {
        title: "Конкретные действия",
        type: "actions",
        lines: ["вводная строка"],
        metrics: [],
        actions: ["проблема → почему важно → что сделать"],
        risks: [],
      },
      {
        title: "Риски",
        type: "risks",
        lines: ["вводная строка"],
        metrics: [],
        actions: [],
        risks: ["конкретный риск с цифрой"],
      },
      {
        title: "План на 7 дней",
        type: "plan",
        lines: ["вводная строка"],
        metrics: [],
        actions: ["День 1: …", "День 2: …"],
        risks: [],
      },
    ],
  };

  const system = [
    "Ты — опытный финансовый аналитик для продавца Ozon/WB.",
    "Готовишь ПЛАТНЫЙ разбор расчёта в виде книги из 7 страниц.",
    "Пиши по-русски, коротко и по делу, строками для книжки-слайдера.",
    "",
    "ЖЁСТКИЕ ПРАВИЛА:",
    "1) Каждый вывод привязан к конкретной цифре — сумма в ₽ и/или доля в % от выручки.",
    "2) Каждый совет отвечает на 3 вопроса: какая проблема найдена; почему это влияет на прибыль; что конкретно сделать продавцу.",
    "3) Запрещены очевидные советы без причины («проверьте себестоимость», «оптимизируйте расходы», «улучшите показатели» — без цифры и вывода).",
    "4) Не слишком коротко и не слишком длинно: на каждую страницу 4–6 смысловых строк.",
    "5) Если данных по SKU/товарам нет — честно укажи, каких данных не хватает, и дай чек-лист, что загрузить и проверить.",
    "6) Не выдумывай данные, которых нет. Не обещай точный/гарантированный рост прибыли, если данных недостаточно.",
    "7) Никакого markdown, таблиц и ссылок. Запрещены технические слова: fallback, debug, json, source, model, endpoint, API.",
    "",
    "Хорошие формулировки (пример стиля, а не готовый ответ):",
    "— «Комиссия 98 180 ₽ — это 21% выручки. Для этой категории норма ниже: проверьте, верно ли выбрана категория карточки».",
    "— «Логистика выше 8% выручки: проверьте габариты карточек, схему FBO/FBS и процент возвратов».",
    "— «Не повышайте цену всем: найдите SKU с маржой ниже 10% и проверьте, выдержат ли они рост цены без потери заказов».",
    "",
    "Страницы строго в этом порядке и с этими type: summary, expense_structure, profit_leaks, sku, actions, risks, plan.",
    "На странице expense_structure заполни metrics по основным статьям: label, value (сумма с ₽), share (доля % от выручки), tone (good|warning|bad|neutral).",
    "На странице sku бери ТОЛЬКО реальные товары из переданного списка (название/sku) — не выдумывай новых.",
    "",
    "Ответь ТОЛЬКО валидным JSON по схеме (без markdown и комментариев):",
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

  const user =
    "Данные расчёта (суммы в ₽, маржа в %):\n" +
    JSON.stringify(userData, null, 2) +
    "\n\nСделай разбор и верни строго JSON по схеме (summary + 7 страниц pages).";

  return { system, user };
}

// ============================================================================
// POST /api/ai/analyze
// ============================================================================

export async function POST(req: NextRequest) {
  // ── 1. Аутентификация: Bearer JWT → userId (fail-closed) ──────────────────
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;

  // ── 2. Авторизация: только active unlimited ───────────────────────────────
  // Клиенту НЕ верим: проверяем plan и premium_until в Supabase.
  const isUnlimited = await checkUnlimitedPlan(auth);
  if (!isUnlimited) {
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
  // eslint-disable-next-line no-console
  console.log("[ai/analyze] env check:", {
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
    // eslint-disable-next-line no-console
    console.warn("[ai/analyze] TIMEWEB_AI_GATEWAY_KEY не задан — fallback (missing_api_key)");
    return NextResponse.json({ ok: true, ...buildFallback(data, "missing_api_key", debugInfo) });
  }

  // ── 4b. Явно битый формат ключа — НЕ дёргаем Gateway впустую ─────────────
  if (keyContainsEquals) {
    // eslint-disable-next-line no-console
    console.warn("[ai/analyze] неверный формат ключа — fallback (invalid_key_format)", {
      keyContainsEquals,
      keyContainsWhitespace,
      keyLength,
    });
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
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] Gateway недоступен:", msg);
    return NextResponse.json({
      ok: true,
      ...buildFallback(data, isTimeout ? "timeout" : "openai_error", debugInfo),
    });
  } finally {
    clearTimeout(timeout);
  }

  // ── 6. Разбираем ответ Gateway ───────────────────────────────────────────
  const rawText = await upstream.text();

  // Всегда логируем статус ответа Gateway (без секретов) — чтобы причина ухода
  // в fallback была видна в server logs Timeweb при ЛЮБОМ исходе:
  //   401/403 → ключ · 404 → endpoint/model · 429/402 → баланс/лимиты Timeweb.
  // eslint-disable-next-line no-console
  console.log("[ai/analyze] ответ Gateway:", {
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
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] gateway error", upstream.status, {
      type: gwType, code: gwCode, message: gwMsg,
    });
    const errDebug: AiDebugInfo = {
      ...debugInfo,
      gatewayStatus: upstream.status,
      gatewayErrorType: gwType,
      gatewayErrorCode: gwCode,
      gatewayErrorMessage: gwMsg,
    };
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

  // 1) Строгий JSON (в т.ч. в markdown-обёртке) → структурированная аналитика.
  let parsed: unknown = null;
  if (content) {
    try {
      parsed = JSON.parse(stripCodeFences(content));
    } catch {
      parsed = null;
    }
  }
  // НОВЫЙ формат { summary, pages } → структурированная книжка.
  // Числа берём из детерминированного rule-based расчёта (модель не придумывает
  // суммы), а текстовый разбор книжки — из ответа AI.
  const analysis = normalizeAnalysisDoc(parsed);
  if (analysis) {
    devLog("parse success: analysis", {
      pages: analysis.pages.length,
      finishReason,
    });
    const base = buildFallback(data);
    return NextResponse.json({
      ok: true,
      ...base,
      source: "openai" as const,
      fallbackReason: undefined,
      debug: undefined,
      summary: analysis.summary.mainConclusion || base.summary,
      mainProblem: analysis.summary.mainProblem || base.mainProblem,
      analysis,
    });
  }

  // Старый строгий формат (на случай, если модель вернула прежнюю схему).
  const result = normalizeAiResult(parsed);
  if (result) {
    devLog("parse success: legacy schema");
    return NextResponse.json({ ok: true, ...result });
  }

  // 2) Не JSON, но осмысленный текст — это НЕ ошибка: показываем как AI-аналитику.
  const freeText = sanitizeFreeText(content);
  if (freeText) {
    // eslint-disable-next-line no-console
    console.warn("[ai/analyze] модель вернула текст вместо JSON — показываем как AI-аналитику");
    return NextResponse.json({ ok: true, ...buildFromText(data, freeText) });
  }

  // 3) Пусто/мусор — аккуратный fallback. Подробная диагностика — ТОЛЬКО в логах
  //    сервера (никаких секретов: ключ не логируем). finish_reason="length"
  //    означает, что лимит токенов мал — модель не успела отдать ответ.
  // eslint-disable-next-line no-console
  console.error("[ai/analyze] невалидный ответ модели", {
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
  return NextResponse.json({ ok: true, ...buildFallback(data, "invalid_json", debugInfo) });
}
