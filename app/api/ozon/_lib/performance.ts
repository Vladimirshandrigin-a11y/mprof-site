// ============================================================================
// Ozon Performance API — проверка Client ID + Client Secret. ТОЛЬКО сервер.
//
// FOUNDATION (PR #43): здесь НЕТ загрузки рекламных расходов/кампаний/статистики.
// Единственное, что делаем, — получаем bearer access_token по client_credentials,
// чтобы убедиться, что креды рабочие. Токен НИКОГДА не сохраняется в БД и НЕ
// логируется; client_secret тоже НИКОГДА не логируется.
//
// Хост и токен-эндпоинт (сверено с документацией Ozon, июль 2026):
//   • старый `performance.ozon.ru` ОТКЛЮЧЁН с 15.01.2025;
//   • актуальный хост — `api-performance.ozon.ru`;
//   • токен: POST https://api-performance.ozon.ru/api/client/token
//     тело JSON: { client_id, client_secret, grant_type: "client_credentials" }
//     ответ 200: { access_token, expires_in, token_type }.
//   (OAuth-обновление от 06.04.2026 ДОБАВИЛО единый токен-флоу, но классический
//    client_credentials /api/client/token остаётся валидным.)
//
// Ответы Ozon трактуем:
//   • 200 + непустой access_token → active (креды рабочие);
//   • 400 / 401                    → invalid_key (неверный Client ID/Secret);
//   • 403                          → forbidden (креды опознаны, нет прав/доступа);
//   • 429 / 5xx / timeout / сеть   → unavailable (временно, повторить позже);
//   • 200 без access_token / не-JSON → unavailable (неожиданный ответ).
// ============================================================================

import { maskClientId } from "./shape";

const PERF_TOKEN_URL = "https://api-performance.ozon.ru/api/client/token";
const TIMEOUT_MS = 12000;

export type PerfStatus =
  | "unknown"
  | "active"
  | "invalid_key"
  | "forbidden"
  | "unavailable";

export type PerfVerifyResult = {
  /** Никогда не 'unknown' из verify — только реальный итог проверки. */
  status: Exclude<PerfStatus, "unknown">;
  /** Безопасная для клиента строка (без секретов/токена). */
  detail?: string;
};

/** Форма ответа токен-эндпоинта — читаем ТОЛЬКО access_token, остальное игнор. */
type PerfTokenResponse = { access_token?: unknown };

/**
 * Проверка Performance-кредов: получаем access_token по client_credentials.
 * Никогда не бросает. client_secret и access_token НЕ логируются и НЕ возвращаются.
 */
export async function verifyPerformanceToken(
  clientId: string,
  clientSecret: string
): Promise<PerfVerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PERF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (res.ok) {
      let json: PerfTokenResponse | null = null;
      try {
        json = (await res.json()) as PerfTokenResponse;
      } catch {
        return { status: "unavailable", detail: "Ozon вернул неожиданный ответ" };
      }
      const token = typeof json?.access_token === "string" ? json.access_token : "";
      if (token.length > 0) return { status: "active" };
      return { status: "unavailable", detail: "Токен не получен — повторите позже" };
    }

    if (res.status === 400 || res.status === 401) {
      return { status: "invalid_key", detail: "Неверный Client ID или Client Secret" };
    }
    if (res.status === 403) {
      return { status: "forbidden", detail: "У ключа Performance нет нужных прав" };
    }
    return { status: "unavailable", detail: `Ozon ответил статусом ${res.status}` };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      status: "unavailable",
      detail: aborted ? "Ozon не ответил вовремя" : "Не удалось связаться с Ozon",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Получение bearer access_token для последующих Performance-запросов (PR #44).
//
// Та же client_credentials-логика, что и в verifyPerformanceToken, но ВОЗВРАЩАЕТ
// сам токен вызывающему коду (диагностический fetch рекламных расходов). Токен
// живёт ТОЛЬКО в памяти запроса: НЕ пишется в БД и НЕ логируется; client_secret
// тоже НЕ логируется. Никогда не бросает — только дискриминированный результат.
//
// Статусы ошибки маппятся на контракт роутов:
//   • invalid_key  → 400/401 (неверный Client ID/Secret) ИЛИ секрет нечитаем;
//   • unavailable  → 403/429/5xx/timeout/сеть/не-JSON/пустой токен (повторить).
// ---------------------------------------------------------------------------

export type PerfTokenOk = { ok: true; token: string };
export type PerfTokenErr = {
  ok: false;
  status: "invalid_key" | "unavailable";
  detail?: string;
};
export type PerfTokenResult = PerfTokenOk | PerfTokenErr;

/**
 * Получить bearer access_token по client_credentials. Токен возвращается
 * вызывающему, но НЕ сохраняется и НЕ логируется. Никогда не бросает.
 */
export async function getPerformanceAccessToken(
  clientId: string,
  clientSecret: string
): Promise<PerfTokenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PERF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (res.ok) {
      let json: PerfTokenResponse | null = null;
      try {
        json = (await res.json()) as PerfTokenResponse;
      } catch {
        return { ok: false, status: "unavailable", detail: "Ozon вернул неожиданный ответ" };
      }
      const token = typeof json?.access_token === "string" ? json.access_token : "";
      if (token.length > 0) return { ok: true, token };
      return { ok: false, status: "unavailable", detail: "Токен не получен — повторите позже" };
    }

    if (res.status === 400 || res.status === 401) {
      return { ok: false, status: "invalid_key", detail: "Неверный Client ID или Client Secret" };
    }
    // 403 (нет прав), 429 (лимит), 5xx — всё «временно/недоступно» для диагностики.
    return { ok: false, status: "unavailable", detail: `Ozon ответил статусом ${res.status}` };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: "unavailable",
      detail: aborted ? "Ozon не ответил вовремя" : "Не удалось связаться с Ozon",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Безопасная проекция строки ozon_performance_connections для браузера.
// НЕТ client_secret_encrypted и НЕТ полного client_id — только показуемое.
// ---------------------------------------------------------------------------

/** Колонки, которые route ВПРАВЕ селектить для клиента (без encrypted secret). */
export const PERF_SAFE_COLUMNS =
  "client_id, secret_last4, status, last_checked_at, last_error, updated_at";

export type PerfConnectionRow = {
  client_id: string;
  secret_last4: string | null;
  status: string;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string | null;
};

export type PerfConnectionView =
  | { connected: false; status: "not_connected" }
  | {
      connected: boolean;
      status: string;
      clientIdMasked: string;
      secretLast4: string | null;
      lastCheckedAt: string | null;
      lastError: string | null;
      updatedAt: string | null;
    };

/** Строка БД → безопасный для клиента объект (или «не подключено»). */
export function toPerfConnectionView(
  row: PerfConnectionRow | null
): PerfConnectionView {
  if (!row) return { connected: false, status: "not_connected" };
  return {
    connected: row.status === "active",
    status: row.status,
    clientIdMasked: maskClientId(row.client_id),
    secretLast4: row.secret_last4,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
