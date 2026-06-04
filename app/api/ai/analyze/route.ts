import { NextRequest, NextResponse } from "next/server";

// LLM-вызов требует Node-рантайма (серверный ключ, произвольные заголовки).
export const runtime = "nodejs";
// Никогда не кешируем — каждый расчёт анализируется заново.
export const dynamic = "force-dynamic";

// ============================================================================
// /api/ai/analyze — реальная AI-аналитика расчёта через OpenAI.
//
// ВАЖНО (безопасность):
//   • ключ OPENAI_API_KEY читается ТОЛЬКО на сервере (без NEXT_PUBLIC);
//   • на вход принимаем ТОЛЬКО числовые агрегаты — никаких файлов/сырых
//     отчётов в LLM не уходит;
//   • любой сбой → JSON с ok:false и статусом, фронт делает fallback на
//     rule-based аналитику и не падает.
// ============================================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
  mode?: string;
};

type AiAnalysis = {
  aiScore: number;
  healthLabel: string;
  summary: string;
  risks: string[];
  recommendations: string[];
  quickActions: string[];
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Берём из тела ТОЛЬКО ожидаемые числовые поля (+ 2 коротких enum-строки). */
function sanitizeInput(p: AnalyzeInput) {
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
    marketplace: p.marketplace === "wb" ? "wb" : "ozon",
    mode:
      typeof p.mode === "string" && p.mode.trim()
        ? p.mode.trim().slice(0, 16)
        : "manual",
  };
}

const toStrArray = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 240))
        .slice(0, max)
    : [];

/** Приводим ответ LLM к строгой схеме AiAnalysis (или null, если мусор). */
function normalizeAnalysis(raw: unknown): AiAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const aiScore = Math.max(0, Math.min(100, Math.round(num(o.aiScore))));
  const summary =
    typeof o.summary === "string" ? o.summary.trim().slice(0, 600) : "";
  const healthLabel =
    typeof o.healthLabel === "string" ? o.healthLabel.trim().slice(0, 40) : "";
  const risks = toStrArray(o.risks, 3);
  const recommendations = toStrArray(o.recommendations, 4);
  const quickActions = toStrArray(o.quickActions, 4);
  // Если LLM не дал ни текста, ни списков — считаем ответ невалидным.
  if (!summary && risks.length === 0 && recommendations.length === 0) {
    return null;
  }
  return {
    aiScore,
    healthLabel: healthLabel || "—",
    summary,
    risks,
    recommendations,
    quickActions,
  };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Ключа нет → фронт уйдёт в rule-based fallback.
    return NextResponse.json(
      { ok: false, error: "OPENAI_API_KEY не задан на сервере" },
      { status: 503 }
    );
  }

  let body: AnalyzeInput;
  try {
    body = (await req.json()) as AnalyzeInput;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const data = sanitizeInput(body);

  const system =
    "Ты — финансовый аналитик маркетплейсов Ozon и Wildberries. " +
    "Анализируешь юнит-экономику продавца по агрегированным числам за период. " +
    "Отвечай ТОЛЬКО валидным JSON по схеме, без markdown и комментариев. " +
    "Пиши кратко, по-деловому, на русском языке. Схема ответа: " +
    '{"aiScore": число 0-100, "healthLabel": строка (одно-два слова: ' +
    "Слабый/Стабильный/Сильный/Отличный), " +
    '"summary": строка (1-2 предложения), ' +
    '"risks": массив строк (до 3, конкретные риски), ' +
    '"recommendations": массив строк (до 4, конкретные действия), ' +
    '"quickActions": массив строк (до 4, формат "Действие — эффект")}.';

  const user =
    "Данные расчёта (суммы в ₽, margin в процентах):\n" +
    JSON.stringify(data) +
    "\n\nОцени финансовое здоровье продавца. aiScore выше при высокой марже " +
    "и низкой доле рекламы/комиссии/логистики; ниже — при убытке или " +
    "перегретых расходах. Верни строго JSON по схеме.";

  let upstream: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 700,
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
    return NextResponse.json(
      { ok: false, error: `LLM недоступен: ${msg}` },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    // eslint-disable-next-line no-console
    console.error("[ai/analyze] upstream error", upstream.status, rawText.slice(0, 300));
    return NextResponse.json(
      { ok: false, error: `LLM ответил статусом ${upstream.status}` },
      { status: 502 }
    );
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

  const analysis = normalizeAnalysis(parsed);
  if (!analysis) {
    return NextResponse.json(
      { ok: false, error: "LLM вернул некорректный формат" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, ...analysis });
}
