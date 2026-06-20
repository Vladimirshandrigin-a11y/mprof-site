import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";

// LLM-вызов требует Node-рантайма (серверный ключ, произвольные заголовки).
export const runtime = "nodejs";
// Никогда не кешируем — каждый расчёт анализируется заново.
export const dynamic = "force-dynamic";

// ============================================================================
// /api/ai/profit-advice — AI Аналитика v1 (чистая реализация).
//
// Только через Timeweb AI Gateway (OpenAI-совместимый /chat/completions),
// модель — GPT-5 mini (TIMEWEB_AI_MODEL). НЕТ api.openai.com, НЕТ OPENAI_API_KEY,
// НЕТ rule-based fallback: при любом сбое Gateway возвращаем честное состояние
// { source: "timeweb_gateway_error" }, фронт показывает «временно недоступно».
//
// БЕЗОПАСНОСТЬ:
//   • TIMEWEB_AI_GATEWAY_KEY — серверный секрет, без NEXT_PUBLIC, в логи не пишем.
//   • auth + активный тариф unlimited (449₽) проверяются ДО любого вызова Gateway.
//   • в модель уходят ТОЛЬКО числовые агрегаты и короткие строки товаров —
//     никаких e-mail, токенов, PII, сырых XLSX/PDF/отчётов.
// ============================================================================

// OpenAI-совместимый endpoint Timeweb AI Gateway (env Timeweb App Platform).
// Запасной адрес — на случай, если переменная ещё не проброшена.
const GATEWAY_URL =
  process.env.TIMEWEB_AI_GATEWAY_URL?.trim() ||
  "https://api.timeweb.ai/v1/chat/completions";
// GPT-5 mini через Timeweb (формат провайдера). Реальная модель задаётся env.
const MODEL = process.env.TIMEWEB_AI_MODEL?.trim() || "openai/gpt-5-mini";
// gpt-5-* — reasoning-модель: бюджет токенов уходит и на рассуждение, и на вывод.
// Маленький лимит → пустой content → ошибка. Даём запас; настраивается env.
const MAX_TOKENS = (() => {
  const n = Number(process.env.TIMEWEB_AI_MAX_TOKENS);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 4000;
})();
// Жёсткий потолок ожидания Gateway, чтобы запрос не висел вечно.
const GATEWAY_TIMEOUT_MS = 45_000;

// ---------- production-safe лог (без секретов) ----------
// Пишем только статусы/флаги/имя модели/длины/причины/userId. НИКОГДА —
// ключ/токен, тело отчёта, текст ответа модели, PII.
function aiLog(
  event: string,
  fields?: Record<string, string | number | boolean | null>
): void {
  // eslint-disable-next-line no-console
  if (fields) console.log("[ai/profit-advice]", event, fields);
  // eslint-disable-next-line no-console
  else console.log("[ai/profit-advice]", event);
}

// ---------- проверка активного тарифа 449₽ unlimited (server-side) ----------
// Идентична entitlements.isUnlimitedActive: plan==='unlimited' И premium_until>now.
// Клиенту не верим — читаем из profiles через service-role admin.
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
    return Date.parse(data.premium_until as string) > Date.now();
  } catch {
    return false;
  }
}

// ---------- входные данные ----------

type ProductRow = { name?: string; sku?: string; profit?: number; margin?: number };

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
  marketplace?: string;
  period?: string;
  productsWithoutCost?: number;
  products?: unknown[];
};

type SanitizedData = {
  revenue: number;
  profit: number;
  margin: number;
  commission: number;
  logistics: number;
  ads: number;
  storage: number;
  cost: number;
  tax: number;
  other: number;
  marketplace: string;
  period: string;
  productsWithoutCost: number;
  products: ProductRow[];
};

// ---------- выходной контракт (aiDoc v1) ----------

type ProfitLeak = {
  title: string;
  why: string;
  action: string;
  expectedEffect: string;
};
type SkuInsight = { name: string; issue: string; action: string };
type ActionItem = { action: string; expectedEffect: string };

type AiDoc = {
  verdict: string;
  summary: string;
  profitLeaks: ProfitLeak[];
  skuInsights: SkuInsight[];
  actionPlan: ActionItem[];
};

// ---------- утилиты ----------

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Снимаем markdown-обёртку ```json … ``` / ``` … ```, если она есть. */
function stripCodeFences(s: string): string {
  const m = s.trim().match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : s).trim();
}

/** Принимаем ТОЛЬКО нужные бизнес-метрики; ничего лишнего в модель не уходит. */
function sanitize(input: AnalyzeInput): SanitizedData {
  const products: ProductRow[] = Array.isArray(input.products)
    ? input.products
        .slice(0, 12)
        .map((p): ProductRow | null => {
          if (!p || typeof p !== "object") return null;
          const o = p as Record<string, unknown>;
          const row: ProductRow = {
            name: str(o.name, 80) || undefined,
            sku: str(o.sku, 40) || undefined,
            profit:
              typeof o.profit === "number" && Number.isFinite(o.profit)
                ? Math.round(o.profit)
                : undefined,
            margin:
              typeof o.margin === "number" && Number.isFinite(o.margin)
                ? Math.round(o.margin * 10) / 10
                : undefined,
          };
          return row.name || row.sku ? row : null;
        })
        .filter((p): p is ProductRow => p !== null)
    : [];

  return {
    revenue: Math.round(num(input.revenue)),
    profit: Math.round(num(input.profit)),
    margin: Math.round(num(input.margin) * 10) / 10,
    commission: Math.round(num(input.commission)),
    logistics: Math.round(num(input.logistics)),
    ads: Math.round(num(input.ads)),
    storage: Math.round(num(input.storage)),
    cost: Math.round(num(input.cost)),
    tax: Math.round(num(input.tax)),
    other: Math.round(num(input.other_expenses)),
    marketplace: str(input.marketplace, 16) || "—",
    period: str(input.period, 40),
    productsWithoutCost: Math.round(num(input.productsWithoutCost)),
    products,
  };
}

// ---------- промпт ----------

function buildPrompt(d: SanitizedData): { system: string; user: string } {
  const r = d.revenue;
  const pct = (v: number) => (r > 0 ? Math.round((v / r) * 1000) / 10 : 0);

  const system = [
    "Ты — финансовый аналитик для продавцов на маркетплейсах Ozon и Wildberries.",
    "Тебе дают агрегированные финансовые показатели магазина за период (в рублях) и, если есть, список товаров с прибылью и маржой.",
    "Проанализируй РЕАЛЬНЫЕ присланные цифры и дай практичный разбор прибыли.",
    "",
    "Правила анализа:",
    "- Опирайся ТОЛЬКО на присланные числа. Не выдумывай данные, которых нет.",
    "- Найди, что именно съедает прибыль: называй конкретные статьи расходов, их долю от выручки и почему это опасно.",
    "- Скажи, что проверить в первую очередь и что реально увеличит чистую прибыль.",
    "- Если есть данные по товарам — укажи, какие SKU/группы требуют внимания и что с ними делать.",
    "- Для каждой рекомендации указывай ожидаемый эффект (в рублях или %, если можно оценить по данным).",
    "- Избегай общих советов вроде «поднимите цены» без объяснения где именно, почему и какой риск.",
    "- Пиши по-русски, кратко и по делу, без воды и маркетингового тона.",
    "",
    "Верни СТРОГО валидный JSON по схеме (без markdown, без текста вне JSON):",
    "{",
    '  "verdict": "1–3 предложения: главный вывод о состоянии прибыли",',
    '  "summary": "1–2 предложения: короткое резюме с ключевыми цифрами",',
    '  "profitLeaks": [ { "title": "статья/проблема", "why": "почему съедает прибыль, с цифрами", "action": "что сделать", "expectedEffect": "ожидаемый эффект" } ],',
    '  "skuInsights": [ { "name": "товар или группа", "issue": "в чём проблема", "action": "что сделать" } ],',
    '  "actionPlan": [ { "action": "конкретный шаг", "expectedEffect": "ожидаемый эффект" } ]',
    "}",
    "",
    "Ограничения: profitLeaks — 2–5 пунктов; actionPlan — 3–7 пунктов (план на ближайшие 7 дней, по приоритету);",
    "skuInsights — только если есть данные по товарам, иначе пустой массив []. Все строки на русском.",
  ].join("\n");

  const metrics = {
    площадка: d.marketplace,
    период: d.period || "не указан",
    выручка: d.revenue,
    чистаяПрибыль: d.profit,
    маржаПроцент: d.margin,
    расходы: {
      себестоимость: { сумма: d.cost, процентОтВыручки: pct(d.cost) },
      комиссииМаркетплейса: { сумма: d.commission, процентОтВыручки: pct(d.commission) },
      логистика: { сумма: d.logistics, процентОтВыручки: pct(d.logistics) },
      реклама: { сумма: d.ads, процентОтВыручки: pct(d.ads) },
      хранение: { сумма: d.storage, процентОтВыручки: pct(d.storage) },
      налог: { сумма: d.tax, процентОтВыручки: pct(d.tax) },
      прочее: { сумма: d.other, процентОтВыручки: pct(d.other) },
    },
    товаровБезСебестоимости: d.productsWithoutCost,
    товары: d.products,
  };

  const user = [
    "Данные магазина за период (рубли). Проанализируй и верни JSON по схеме из инструкции:",
    JSON.stringify(metrics),
  ].join("\n");

  return { system, user };
}

// ---------- валидация ответа модели ----------

function coerceAiDoc(raw: unknown): AiDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const verdict = str(o.verdict, 600);
  const summary = str(o.summary, 600);

  const profitLeaks: ProfitLeak[] = Array.isArray(o.profitLeaks)
    ? o.profitLeaks
        .map((x): ProfitLeak | null => {
          if (!x || typeof x !== "object") return null;
          const e = x as Record<string, unknown>;
          const title = str(e.title, 160);
          if (!title) return null;
          return {
            title,
            why: str(e.why, 600),
            action: str(e.action, 600),
            expectedEffect: str(e.expectedEffect, 400),
          };
        })
        .filter((x): x is ProfitLeak => x !== null)
        .slice(0, 6)
    : [];

  const skuInsights: SkuInsight[] = Array.isArray(o.skuInsights)
    ? o.skuInsights
        .map((x): SkuInsight | null => {
          if (!x || typeof x !== "object") return null;
          const e = x as Record<string, unknown>;
          const name = str(e.name, 120);
          if (!name) return null;
          return {
            name,
            issue: str(e.issue, 400),
            action: str(e.action, 400),
          };
        })
        .filter((x): x is SkuInsight => x !== null)
        .slice(0, 12)
    : [];

  const actionPlan: ActionItem[] = Array.isArray(o.actionPlan)
    ? o.actionPlan
        .map((x): ActionItem | null => {
          if (!x || typeof x !== "object") return null;
          const e = x as Record<string, unknown>;
          const action = str(e.action, 400);
          if (!action) return null;
          return { action, expectedEffect: str(e.expectedEffect, 400) };
        })
        .filter((x): x is ActionItem => x !== null)
        .slice(0, 7)
    : [];

  // Осмысленный ответ = есть главный вывод И хотя бы одна утечка или шаг плана.
  if (!verdict) return null;
  if (profitLeaks.length === 0 && actionPlan.length === 0) return null;

  return { verdict, summary, profitLeaks, skuInsights, actionPlan };
}

const noStore = { "Cache-Control": "no-store" } as const;

function gatewayError(reason: string): NextResponse {
  aiLog("final source", { source: "timeweb_gateway_error", reason });
  return NextResponse.json(
    { source: "timeweb_gateway_error", message: "AI temporarily unavailable" },
    { status: 200, headers: noStore }
  );
}

// ---------- handler ----------

export async function POST(req: NextRequest) {
  aiLog("ai route called");

  // 1) Аутентификация (нет сессии → 401).
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    aiLog("final source", { source: "none", reason: "unauthorized_401" });
    return auth.response;
  }
  aiLog("user id", { userId: auth.userId });

  // 2) Активный тариф 449₽ unlimited (нет → 403). Gateway не дёргаем.
  const isUnlimited = await checkUnlimitedPlan(auth);
  aiLog("user premium", { premium: isUnlimited });
  if (!isUnlimited) {
    aiLog("final source", { source: "none", reason: "no_active_plan_403" });
    return NextResponse.json(
      { error: "AI-аналитика доступна на тарифе Безлимит", code: "no_active_plan" },
      { status: 403, headers: noStore }
    );
  }

  // 3) Тело запроса (битое → 400).
  let input: AnalyzeInput;
  try {
    input = (await req.json()) as AnalyzeInput;
  } catch {
    aiLog("final source", { source: "none", reason: "bad_request_body_400" });
    return NextResponse.json(
      { error: "Некорректное тело запроса", code: "bad_request" },
      { status: 400, headers: noStore }
    );
  }
  const data = sanitize(input);

  // 4) Ключ Gateway. Отсутствует/битый формат → честная ошибка (без fallback).
  const rawKey = process.env.TIMEWEB_AI_GATEWAY_KEY ?? "";
  const key = rawKey.trim();
  aiLog("gateway config", {
    gatewayUrlEnvSet: !!process.env.TIMEWEB_AI_GATEWAY_URL,
    modelEnvSet: !!process.env.TIMEWEB_AI_MODEL,
    model: MODEL,
    hasKey: !!key,
    maxTokens: MAX_TOKENS,
  });
  if (!key) return gatewayError("missing_api_key");
  if (/[=\s]/.test(key)) return gatewayError("invalid_key_format");

  // 5) Вызов Timeweb AI Gateway.
  const { system, user } = buildPrompt(data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // gpt-5-* — reasoning: temperature дефолтная (не задаём),
        // лимит вывода — через max_completion_tokens (max_tokens модель отвергает).
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e instanceof Error && e.name === "AbortError";
    aiLog("gateway unreachable", { timeout: isTimeout });
    return gatewayError(isTimeout ? "gateway_timeout" : "gateway_unreachable");
  }
  clearTimeout(timer);

  const rawText = await upstream.text();
  aiLog("gateway response", {
    status: upstream.status,
    ok: upstream.ok,
    model: MODEL,
    bodyLength: rawText.length,
  });

  if (!upstream.ok) {
    let errType: string | null = null;
    let errCode: string | null = null;
    try {
      const errBody = JSON.parse(rawText) as {
        error?: { type?: string; code?: string };
      };
      errType = errBody?.error?.type ?? null;
      errCode = errBody?.error?.code ?? null;
    } catch {
      /* тело не-JSON — оставляем null */
    }
    aiLog("gateway error", {
      status: upstream.status,
      type: errType,
      code: errCode,
    });
    return gatewayError(`gateway_http_${upstream.status}`);
  }

  // 6) Разбор ответа.
  let content = "";
  let finishReason: string | null = null;
  try {
    const envelope = JSON.parse(rawText) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    content = envelope?.choices?.[0]?.message?.content ?? "";
    finishReason = envelope?.choices?.[0]?.finish_reason ?? null;
  } catch {
    return gatewayError("envelope_parse_failed");
  }
  aiLog("gateway content", {
    contentLength: content.length,
    finishReason,
  });
  if (!content.trim()) return gatewayError("empty_content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(content));
  } catch {
    return gatewayError("invalid_json");
  }

  const aiDoc = coerceAiDoc(parsed);
  if (!aiDoc) return gatewayError("invalid_content");

  aiLog("final source", { source: "timeweb_gateway", reason: "aiDoc" });
  return NextResponse.json(
    { source: "timeweb_gateway", model: MODEL, aiDoc },
    { status: 200, headers: noStore }
  );
}
