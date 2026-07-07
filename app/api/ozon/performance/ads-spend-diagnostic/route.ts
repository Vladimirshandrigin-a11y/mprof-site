import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../../_lib/crypto";
import { fetchAdsSpendForMonth } from "../../_lib/performance-ads";

// ============================================================================
// POST /api/ozon/performance/ads-spend-diagnostic — СПРАВОЧНЫЙ расход рекламы
// Ozon Performance API за выбранный месяц (PR #44).
//
// Тело: { month: "YYYY-MM" }. Берём сохранённое Performance-подключение по user_id
// (из токена), расшифровываем client_secret ТОЛЬКО на сервере, получаем bearer
// access_token, тянем кампании+статистику+отчёт и суммируем расход.
//
// ЭТО ТОЛЬКО ДИАГНОСТИКА:
//   • ничего не пишем в БД (даже статус подключения не трогаем) — read-only;
//   • access_token НЕ сохраняется и НЕ логируется; client_secret НЕ логируется;
//   • сумма НЕ сохраняется в историю расчётов и НЕ вычитается из прибыли;
//   • формула чистой прибыли / налог / COGS / Seller API finance — не затронуты.
//
// Ответ (всегда с полем status; ok=true только для ok/no_campaigns):
//   { ok, month, adsSpend, campaignsCount, rowsCount, status, stage?, httpStatus?, detail?, retryAfterSec? }
//   status ∈ ok | no_campaigns | pending | not_connected | invalid_connection | rate_limited | unavailable
//   stage?/httpStatus?/detail? — ДИАГНОСТИКА (без секретов/токена): этап цепочки
//   (token|campaigns|statistics|poll|report), HTTP-код Ozon и короткое безопасное
//   описание. Присутствуют на unavailable/rate_limited, помогают понять, где падает.
//   retryAfterSec? — для rate_limited (HTTP 429 от Ozon): через сколько секунд повторить.
//
// HTTP-коды: доменные исходы (включая pending/unavailable) отдаём 200, чтобы UI
// единообразно ветвился по status. Не-2xx только для инфраструктурных сбоев:
//   400 — плохое тело/месяц; 401 — не авторизован; 503 — шифрование не настроено;
//   502 — ошибка чтения подключения из БД.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Отчёт Ozon готовится асинхронно — даём операции запас времени (сек).
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  // --- тело: month "YYYY-MM" ---
  let body: { month?: unknown };
  try {
    body = (await req.json()) as { month?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }
  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json(
      { error: "Укажите месяц в формате YYYY-MM" },
      { status: 400, headers: NO_STORE }
    );
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      {
        error: "Шифрование ключей не настроено на сервере",
        code: "encryption_misconfigured",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  // --- подключение пользователя (read-only) ---
  const { data: existing, error: readErr } = await admin
    .from("ozon_performance_connections")
    .select("client_id, client_secret_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) {
    // eslint-disable-next-line no-console
    console.error(
      "[api/ozon/performance/ads-spend-diagnostic] select error",
      readErr
    );
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }
  if (!existing) {
    return NextResponse.json(
      {
        ok: false,
        month,
        adsSpend: 0,
        campaignsCount: 0,
        rowsCount: 0,
        status: "not_connected",
      },
      { headers: NO_STORE }
    );
  }

  // --- расшифровка секрета ТОЛЬКО на сервере ---
  let clientSecret: string;
  try {
    clientSecret = decryptOzonApiKey(existing.client_secret_encrypted as string);
  } catch {
    // Секрет нечитаем (сменили OZON_KEYS_ENC_SECRET/повреждение). Ничего не пишем
    // в БД (диагностика read-only) — просто просим переподключить.
    return NextResponse.json(
      {
        ok: false,
        month,
        adsSpend: 0,
        campaignsCount: 0,
        rowsCount: 0,
        status: "invalid_connection",
      },
      { headers: NO_STORE }
    );
  }

  // --- сам справочный fetch расхода рекламы ---
  const result = await fetchAdsSpendForMonth(
    existing.client_id as string,
    clientSecret,
    month
  );

  const ok = result.status === "ok" || result.status === "no_campaigns";

  // Диагностика: на unavailable/rate_limited пишем в лог ТОЛЬКО безопасные поля —
  // этап цепочки, HTTP-код Ozon, короткий detail и (для 429) секунды повтора.
  // НИКОГДА не логируем client_secret, access_token или тело ответа Ozon (в этих
  // полях их нет — только этап/код/безопасный текст/число секунд).
  if (result.status === "unavailable" || result.status === "rate_limited") {
    // eslint-disable-next-line no-console
    console.error(
      `[api/ozon/performance/ads-spend-diagnostic] ${result.status}`,
      {
        stage: result.stage,
        httpStatus: result.httpStatus,
        detail: result.detail,
        retryAfterSec: result.retryAfterSec,
      }
    );
  }

  return NextResponse.json(
    {
      ok,
      month,
      adsSpend: result.adsSpend,
      campaignsCount: result.campaignsCount,
      rowsCount: result.rowsCount,
      status: result.status,
      stage: result.stage,
      httpStatus: result.httpStatus,
      detail: result.detail,
      retryAfterSec: result.retryAfterSec,
    },
    { headers: NO_STORE }
  );
}
