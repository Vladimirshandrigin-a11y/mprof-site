import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";

// LLM-вызов требует Node-рантайма (серверный ключ, произвольные заголовки).
export const runtime = "nodejs";
// Никогда не кешируем — каждый расчёт анализируется заново.
export const dynamic = "force-dynamic";

// ============================================================================
// /api/ai/analyze — реальная AI-аналитика расчёта через OpenAI.
//
// БЕЗОПАСНОСТЬ:
//   • OPENAI_API_KEY — серверный секрет, без NEXT_PUBLIC.
//   • auth + план проверяются ДО любого вызова OpenAI — токены не тратятся
//     на free/single пользователей.
//   • на вход принимаем ТОЛЬКО числовые агрегаты + короткие строки товаров;
//     никаких XLSX/PDF/сырых отчётов в LLM не уходит.
//   • любой сбой OpenAI → rule-based fallback с source:"fallback";
//     сайт не падает.
// ============================================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

export type AiResult = {
  source: "openai" | "fallback";
  summary: string;
  healthScore: number;
  mainProblem: string;
  keyInsights: KeyInsight[];
  profitLeaks: ProfitLeak[];
  productRisks: ProductRisk[];
  recommendedActions: RecommendedAction[];
  missingData: string[];
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
    products,
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

function buildFallback(d: SanitizedData): AiResult {
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

  // keyInsights
  const keyInsights: KeyInsight[] = [];
  if (margin <= 0) {
    keyInsights.push({
      title: "Убыток",
      description: `Чистая прибыль отрицательная: ${fmtRub(d.profit)}. Расходы превышают выручку.`,
      severity: "high",
    });
  } else if (margin <= 8) {
    keyInsights.push({
      title: "Критически низкая маржа",
      description: `Маржа ${margin.toFixed(1)}% — минимальный запас прочности. Любое повышение расходов даст убыток.`,
      severity: "high",
    });
  } else if (margin > 20) {
    keyInsights.push({
      title: "Хорошая маржа",
      description: `Маржа ${margin.toFixed(1)}% выше среднего по маркетплейсам.`,
      severity: "low",
    });
  }
  if (adsPct > 15) {
    keyInsights.push({
      title: "Высокие расходы на рекламу",
      description: `Реклама занимает ${adsPct}% выручки. Норма для маркетплейсов — до 10–15%.`,
      severity: adsPct > 20 ? "high" : "medium",
    });
  }
  if (commPct > 22) {
    keyInsights.push({
      title: "Высокая комиссия маркетплейса",
      description: `Комиссия ${commPct}% от выручки. Проверьте правильность категории товара.`,
      severity: "medium",
    });
  }
  if (logPct > 18) {
    keyInsights.push({
      title: "Высокая логистика",
      description: `Логистика ${logPct}% — возможен высокий процент возвратов или крупногабаритный товар.`,
      severity: "medium",
    });
  }
  if (d.updServicesTotal > 0 && d.updServicesTotal > d.commission * 0.3) {
    keyInsights.push({
      title: "Значительные услуги по УПД",
      description: `Услуги Ozon по УПД составили ${fmtRub(d.updServicesTotal)} — проверьте состав.`,
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

  // recommendedActions
  const recommendedActions: RecommendedAction[] = [];
  let p = 1;
  if (adsPct > 15) {
    recommendedActions.push({
      priority: p++,
      action: "Оптимизировать рекламные кампании",
      why: `Реклама занимает ${adsPct}% выручки при норме 10–15%`,
      expectedEffect:
        "Снижение рекламных расходов без потери позиций при правильной оптимизации ставок",
    });
  }
  if (margin < 10 && margin > 0) {
    recommendedActions.push({
      priority: p++,
      action: "Пересмотреть цену или пересчитать себестоимость",
      why: `Маржа ${margin.toFixed(1)}% — критически низкий запас`,
      expectedEffect:
        "Повышение устойчивости к изменениям комиссий и логистики",
    });
  }
  if (commPct > 22) {
    recommendedActions.push({
      priority: p++,
      action: "Проверить категорию размещения товара",
      why: `Комиссия ${commPct}% выглядит высокой для данной категории`,
      expectedEffect:
        "Возможное снижение комиссии при переводе в более выгодную категорию",
    });
  }
  if (d.productsWithoutCost > 0) {
    recommendedActions.push({
      priority: p++,
      action: "Заполнить себестоимость для всех товаров",
      why: `${d.productsWithoutCost} товаров считаются без учёта себестоимости`,
      expectedEffect: "Точный расчёт чистой прибыли по каждой позиции",
    });
  }

  // missingData
  const missingData: string[] = [];
  if (!d.cost) missingData.push("Себестоимость товаров");
  if (!d.updServicesTotal && !d.updCommissionTotal)
    missingData.push("Данные УПД-отчёта (для детального анализа услуг Ozon)");
  if (!d.products || d.products.length === 0)
    missingData.push("Детализация по товарам (для выявления убыточных позиций)");

  return {
    source: "fallback",
    summary,
    healthScore,
    mainProblem,
    keyInsights: keyInsights.slice(0, 4),
    profitLeaks,
    productRisks,
    recommendedActions: recommendedActions.slice(0, 4),
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

// ---------- строим промпт ----------

function buildPrompt(d: SanitizedData): { system: string; user: string } {
  const system = [
    "Ты финансовый AI-помощник для продавца Ozon/WB.",
    "Твоя задача — найти, где продавец теряет чистую прибыль, и дать практичные действия.",
    "Пиши просто, конкретно, без воды.",
    "Опирайся ТОЛЬКО на переданные цифры.",
    "Если данных недостаточно — честно укажи, чего не хватает, в поле missingData.",
    "Не выдумывай цифры. Не обещай гарантированный рост прибыли.",
    "Не давай юридических или налоговых гарантий.",
    "Не советуй «просто повысить цену», если это не следует из данных.",
    "",
    "Ответь ТОЛЬКО валидным JSON по точной схеме (без markdown, без комментариев):",
    JSON.stringify({
      summary: "строка 1-2 предложения",
      healthScore: "число 0-100",
      mainProblem: "главная проблема чистой прибыли",
      keyInsights: [
        {
          title: "короткий заголовок",
          description: "конкретное объяснение с цифрами",
          severity: "low|medium|high",
        },
      ],
      profitLeaks: [
        { area: "статья расходов", amount: "число или null", comment: "что проверить" },
      ],
      productRisks: [
        { name: "товар", sku: "sku или null", reason: "почему риск", action: "что сделать" },
      ],
      recommendedActions: [
        {
          priority: 1,
          action: "конкретное действие",
          why: "почему важно",
          expectedEffect: "ожидаемый эффект без гарантий",
        },
      ],
      missingData: ["каких данных не хватает"],
    }),
  ].join("\n");

  const userData: Record<string, unknown> = {
    маркетплейс: d.marketplace,
    выручка: d.revenue,
    чистая_прибыль: d.profit || d.netProfit,
    маржа_процент: d.margin,
    комиссия: d.commission,
    логистика: d.logistics,
    реклама: d.ads,
    хранение: d.storage,
    себестоимость: d.cost,
    налог: d.tax,
    прочие_расходы: d.other_expenses,
  };
  if (d.loyaltyPayouts > 0) userData.выплаты_партнёрам = d.loyaltyPayouts;
  if (d.updServicesTotal > 0) userData.услуги_озон_упд = d.updServicesTotal;
  if (d.updCommissionTotal > 0) userData.агентское_вознаграждение_упд = d.updCommissionTotal;
  if (d.packaging > 0) userData.упаковка = d.packaging;
  if (d.delivery > 0) userData.доставка_до_склада = d.delivery;
  if (d.salary > 0) userData.зарплата = d.salary;
  if (d.productsWithoutCost > 0)
    userData.товаров_без_себестоимости = d.productsWithoutCost;
  if (d.products.length > 0) userData.товары_топ15 = d.products;

  const user =
    "Данные расчёта (суммы в ₽, маржа в %):\n" +
    JSON.stringify(userData, null, 2) +
    "\n\nОцени финансовое здоровье продавца и верни строго JSON по схеме.";

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

  // ── 4. Если OPENAI_API_KEY не задан — rule-based fallback (200, не 503) ──
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn("[ai/analyze] OPENAI_API_KEY не задан — возвращаем fallback");
    return NextResponse.json({ ok: true, ...buildFallback(data) });
  }

  // ── 5. Вызываем OpenAI ───────────────────────────────────────────────────
  const { system, user } = buildPrompt(data);

  let upstream: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.35,
        max_tokens: 1200,
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
    const msg = e instanceof Error ? e.message : "сеть недоступна";
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] OpenAI недоступен:", msg);
    return NextResponse.json({ ok: true, ...buildFallback(data) });
  } finally {
    clearTimeout(timeout);
  }

  // ── 6. Разбираем ответ OpenAI ────────────────────────────────────────────
  const rawText = await upstream.text();

  if (!upstream.ok) {
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] upstream error", upstream.status, rawText.slice(0, 300));
    return NextResponse.json({ ok: true, ...buildFallback(data) });
  }

  let parsed: unknown = null;
  try {
    const envelope = JSON.parse(rawText) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = envelope?.choices?.[0]?.message?.content ?? "";
    parsed = content ? JSON.parse(content) : null;
  } catch {
    parsed = null;
  }

  const result = normalizeAiResult(parsed);
  if (!result) {
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] LLM вернул некорректный формат");
    return NextResponse.json({ ok: true, ...buildFallback(data) });
  }

  return NextResponse.json({ ok: true, ...result });
}
