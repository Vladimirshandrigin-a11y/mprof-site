// ============================================================================
// Ozon Performance API — ДИАГНОСТИЧЕСКИЙ read-only fetch расхода рекламы за месяц
// (PR #44). ТОЛЬКО сервер.
//
// ВАЖНО: это справочный расчёт. Полученная сумма НИКУДА не сохраняется, в формулу
// чистой прибыли НЕ входит и из прибыли НЕ вычитается. Никакой записи в БД/историю.
//
// Поток (всё под одним запросом пользователя, токен живёт только в памяти):
//   1) getPerformanceAccessToken(clientId, clientSecret) — bearer access_token;
//   2) GET  /api/client/campaign                        — список кампаний (все статусы);
//   3) POST /api/client/statistics/json                 — заказ статистики за месяц
//        батчами ≤10 кампаний (Ozon запрещает параллельные запросы) → { UUID };
//   4) GET  /api/client/statistics/{UUID}               — опрос готовности (state=OK);
//   5) GET  /api/client/statistics/report?UUID={UUID}   — сам отчёт (JSON, строки по дням);
//   6) суммируем moneySpent по всем строкам всех кампаний → adsSpend.
//
// moneySpent приходит СТРОКОЙ с запятой-разделителем и возможными пробелами/NBSP
// как разделителями тысяч («1 234,56») — нормализуем перед parseFloat.
//
// Хост: https://api-performance.ozon.ru (старый performance.ozon.ru отключён 15.01.2025).
//
// Асинхронность: заказ статистики у Ozon готовится не мгновенно. Опрашиваем с
// паузой и ОБЩИМ дедлайном; если к дедлайну отчёт не готов — возвращаем pending
// (UI просит повторить позже), НЕ висим бесконечно и НЕ падаем молча.
//
// Rate limit (HTTP 429): Ozon ограничивает частоту запросов (особенно заказ
// статистики). Тогда НЕ выдаём generic «недоступно», а возвращаем rate_limited с
// безопасной подсказкой «повторите позже» (учитываем Retry-After, иначе 60–120с),
// держим паузу между батчами и ОСТАНАВЛИВАЕМСЯ на первом 429 — не спамим Ozon.
//
// Диагностика statistics-этапа (PR #47): к rate_limited/unavailable на этом этапе
// добавляем БЕЗОПАСНЫЕ поля — сколько кампаний ушло в один запрос statistics/json,
// номер батча и сколько батчей всего, elapsedMs от старта проверки, форма тела
// (dateFrom/dateTo). Это помогает понять, реальный ли это лимит или мы шлём запрос
// не так. ВНИМАНИЕ: UUID заказа НЕ кэшируется между HTTP-запросами — КАЖДЫЙ клик
// создаёт новый заказ statistics/json (кэш в этом PR НЕ добавляем — только диагностика).
//
// access_token и client_secret НИКОГДА не логируются; полное тело ответа/запроса
// НЕ логируется (диагностика — только числа, коды и константная форма тела).
// ============================================================================

import { getPerformanceAccessToken } from "./performance";

const PERF_HOST = "https://api-performance.ozon.ru";
const CAMPAIGN_URL = `${PERF_HOST}/api/client/campaign`;
const STATISTICS_URL = `${PERF_HOST}/api/client/statistics/json`;
const STATUS_URL = (uuid: string) =>
  `${PERF_HOST}/api/client/statistics/${encodeURIComponent(uuid)}`;
const REPORT_URL = (uuid: string) =>
  `${PERF_HOST}/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`;

const FETCH_TIMEOUT_MS = 15000; // таймаут одного HTTP-запроса
const POLL_DELAY_MS = 2000; // пауза между опросами готовности
const GLOBAL_DEADLINE_MS = 45000; // общий бюджет всей операции (route maxDuration 60)
const CAMPAIGN_BATCH = 10; // Ozon: не больше 10 кампаний в одном заказе статистики
const BATCH_DELAY_MS = 1500; // пауза между заказами статистики (анти-rate-limit)
const DEFAULT_RETRY_AFTER_SEC = 90; // подсказка «повторить через», если Retry-After нет (60–120с)
const RATE_LIMIT_DETAIL =
  "Ozon ограничил частоту запросов. Попробуйте через 1–2 минуты.";
// Форма тела заказа статистики (диагностика: какой набор дат-полей мы шлём).
const STATISTICS_BODY_SHAPE = "dateFrom/dateTo";

export type AdsSpendStatus =
  | "ok"
  | "no_campaigns"
  | "pending"
  | "invalid_connection"
  | "rate_limited"
  | "unavailable";

/** Этап конвейера, на котором остановились (диагностика). БЕЗ секретов/токена. */
export type AdsSpendStage =
  | "token"
  | "campaigns"
  | "statistics"
  | "poll"
  | "report";

export type AdsSpendOutcome = {
  status: AdsSpendStatus;
  /** Итоговый расход рекламы за месяц (₽). 0, если не ok. */
  adsSpend: number;
  /** Сколько всего кампаний вернул Ozon (все статусы). */
  campaignsCount: number;
  /** Сколько строк отчёта суммировано (диагностика). */
  rowsCount: number;
  /** Безопасная строка для UI (без секретов/токена). */
  detail?: string;
  /** Этап, на котором цепочка остановилась (для unavailable). Диагностика. */
  stage?: AdsSpendStage;
  /**
   * HTTP-код ответа Ozon на падающем этапе, если он был HTTP-ответом. Диагностика:
   * это ТОЛЬКО числовой статус — НИ тела ответа, НИ client_secret, НИ access_token.
   */
  httpStatus?: number;
  /**
   * Для rate_limited (HTTP 429): через сколько секунд безопасно повторить —
   * из заголовка Retry-After Ozon, иначе консервативная подсказка. Только число.
   */
  retryAfterSec?: number;
  /**
   * Диагностика statistics-этапа (PR #47) — всё безопасно (числа/константа, без
   * секретов/токена/тела): сколько кампаний ушло в один запрос statistics/json,
   * номер батча (1-based) и сколько батчей всего, сколько мс прошло от старта
   * проверки до сбоя, и форма тела запроса ("dateFrom/dateTo").
   */
  campaignsInRequest?: number;
  batchIndex?: number;
  batchesTotal?: number;
  elapsedMs?: number;
  requestBodyShape?: string;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** «1 234,56» / «1234,56» / NBSP → number. Никогда не бросает, дефолт 0. */
function parseMoney(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  // убираем пробелы/NBSP/узкий NBSP (разделители тысяч), запятую → точку.
  const cleaned = v.replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

type HttpResult = {
  ok: boolean;
  status: number;
  json: unknown;
  /** Для 429: разобранный заголовок Retry-After в секундах, если он был. */
  retryAfterSec?: number;
};

/**
 * Retry-After ответа Ozon (целые секунды ИЛИ HTTP-дата) → секунды в [1, 600],
 * либо undefined, если заголовка нет / он не разбирается. Диагностика: это ТОЛЬКО
 * число секунд, никакого тела/секретов. Headers.get регистронезависим.
 */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) && sec > 0
      ? Math.min(Math.ceil(sec), 600)
      : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) {
    const deltaSec = Math.ceil((when - Date.now()) / 1000);
    if (deltaSec > 0) return Math.min(deltaSec, 600);
  }
  return undefined;
}

/** GET/POST с bearer-токеном, JSON, таймаутом. Никогда не бросает. */
async function perfFetch(
  url: string,
  token: string,
  init?: { method: "GET" | "POST"; body?: unknown }
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (method === "POST") headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(init?.body ?? {}) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    // Retry-After читаем только при 429 (rate limit) — иначе он не нужен.
    const retryAfterSec = res.status === 429 ? parseRetryAfter(res) : undefined;
    return { ok: res.ok, status: res.status, json, retryAfterSec };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Список id кампаний (все статусы). Ozon: { list: [{ id, ... }] }. */
function extractCampaignIds(json: unknown): string[] {
  const list = (json as { list?: unknown })?.list;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
    else if (typeof id === "number" && Number.isFinite(id)) ids.push(String(id));
  }
  return ids;
}

/** UUID из ответа заказа статистики: { UUID } (fallback uuid). */
function extractUuid(json: unknown): string | null {
  const o = json as { UUID?: unknown; uuid?: unknown } | null;
  const raw = o?.UUID ?? o?.uuid;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

type PollState = "ready" | "pending" | "error";

/** Готовность заказа: state=OK → ready; ERROR/FAILED → error; иначе pending. */
function readPollState(json: unknown): PollState {
  const raw =
    (json as { state?: unknown; status?: unknown })?.state ??
    (json as { status?: unknown })?.status;
  const s = typeof raw === "string" ? raw.toUpperCase() : "";
  if (s === "OK") return "ready";
  if (s.includes("ERROR") || s.includes("FAIL")) return "error";
  return "pending";
}

/**
 * Просуммировать moneySpent по строкам отчёта. Терпим к форме конверта:
 *   { report: { rows: [...] } }              (плоский)
 *   { report: { "<campId>": { rows: [...] } } } (по кампаниям)
 *   { rows: [...] } / { "<campId>": { rows: [...] } } (без обёртки report)
 *
 * recognized=true, если нашли ХОТЯ БЫ один ожидаемый rows-массив (даже пустой) —
 * тогда сумма 0 ₽ валидна (у кампаний просто не было расхода). Если rows-массива
 * нет вовсе (не-JSON тело, CSV/ZIP, иная схема) — recognized=false, и вызывающий
 * НЕ выдаёт ложный «0 ₽ ok», а честно сообщает, что формат отчёта не распознан.
 */
function sumReport(json: unknown): {
  spend: number;
  rows: number;
  recognized: boolean;
} {
  let spend = 0;
  let rows = 0;
  let recognized = false;
  if (!json || typeof json !== "object") return { spend, rows, recognized };

  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const arr = (node as { rows?: unknown }).rows;
    if (Array.isArray(arr)) {
      recognized = true; // ожидаемый конверт отчёта найден (даже если строк 0)
      for (const r of arr) {
        if (r && typeof r === "object") {
          spend += parseMoney((r as { moneySpent?: unknown }).moneySpent);
          rows += 1;
        }
      }
    }
  };

  const root = (json as { report?: unknown }).report ?? json;
  if (!root || typeof root !== "object") return { spend, rows, recognized };

  if (Array.isArray((root as { rows?: unknown }).rows)) {
    collect(root);
  } else {
    for (const key of Object.keys(root as Record<string, unknown>)) {
      collect((root as Record<string, unknown>)[key]);
    }
  }
  return { spend, rows, recognized };
}

/** «YYYY-MM» → { dateFrom: YYYY-MM-01, dateTo: YYYY-MM-<последний день> } (UTC). */
function monthRange(month: string): { dateFrom: string; dateTo: string } {
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr);
  const mm = Number(mStr); // 1-based
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return {
    dateFrom: `${month}-01`,
    dateTo: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** id → батчи по CAMPAIGN_BATCH. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Безопасные диагностические поля statistics-этапа (числа/константа). */
type StatsDiag = {
  campaignsInRequest?: number;
  batchIndex?: number;
  batchesTotal?: number;
  elapsedMs?: number;
  requestBodyShape?: string;
};

/**
 * Единый исход «Ozon ограничил частоту запросов» (HTTP 429) для любого этапа.
 * Безопасно: только этап, код 429, число секунд подсказки и (опц.) диагностика
 * батча — без тела/секретов. Если Retry-After нет — консервативная подсказка.
 */
function rateLimited(
  stage: AdsSpendStage,
  campaignsCount: number,
  retryAfterSec?: number,
  diag?: StatsDiag
): AdsSpendOutcome {
  return {
    status: "rate_limited",
    adsSpend: 0,
    campaignsCount,
    rowsCount: 0,
    stage,
    httpStatus: 429,
    retryAfterSec: retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC,
    detail: RATE_LIMIT_DETAIL,
    ...diag,
  };
}

/**
 * Получить справочный расход рекламы за месяц. Никогда не бросает — только
 * дискриминированный результат. Ничего не сохраняет, ничего не логирует.
 */
export async function fetchAdsSpendForMonth(
  clientId: string,
  clientSecret: string,
  month: string
): Promise<AdsSpendOutcome> {
  const startedAt = Date.now(); // для elapsedMs в диагностике statistics-этапа
  const empty = { adsSpend: 0, campaignsCount: 0, rowsCount: 0 } as const;

  // 1) access_token
  const tok = await getPerformanceAccessToken(clientId, clientSecret);
  if (!tok.ok) {
    // Rate limit уже на выдаче токена — не generic-недоступность (Retry-After
    // токен-хелпер не отдаёт, поэтому подсказка консервативная по умолчанию).
    if (tok.httpStatus === 429) {
      return rateLimited("token", 0, undefined, {
        elapsedMs: Date.now() - startedAt,
      });
    }
    // invalid_key → проблема с самим подключением; unavailable → временный сбой.
    return {
      status: tok.status === "invalid_key" ? "invalid_connection" : "unavailable",
      ...empty,
      stage: "token",
      httpStatus: tok.httpStatus,
      detail: tok.detail,
    };
  }
  const token = tok.token;

  // 2) список кампаний
  const campRes = await perfFetch(CAMPAIGN_URL, token);
  if (campRes.status === 429) {
    return rateLimited("campaigns", 0, campRes.retryAfterSec, {
      elapsedMs: Date.now() - startedAt,
    });
  }
  if (!campRes.ok) {
    return {
      status: "unavailable",
      ...empty,
      stage: "campaigns",
      httpStatus: campRes.status || undefined,
      detail: "Не удалось получить список кампаний",
    };
  }
  const ids = extractCampaignIds(campRes.json);
  const campaignsCount = ids.length;
  if (campaignsCount === 0) {
    // Нет кампаний — это валидный результат: расход рекламы 0.
    return { status: "no_campaigns", adsSpend: 0, campaignsCount: 0, rowsCount: 0 };
  }

  const { dateFrom, dateTo } = monthRange(month);
  const deadline = Date.now() + GLOBAL_DEADLINE_MS;

  let totalSpend = 0;
  let totalRows = 0;

  // 3–6) последовательно по батчам (Ozon запрещает параллельные запросы). Между
  // батчами держим паузу и НЕ продолжаем после первого 429 — не спамим Ozon.
  const batches = chunk(ids, CAMPAIGN_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    if (Date.now() >= deadline) {
      return { status: "pending", ...empty, campaignsCount };
    }
    // Пауза перед КАЖДЫМ следующим заказом статистики (не перед первым), чтобы
    // снизить риск rate-limit. Если пауза не влезает в дедлайн — честный pending.
    if (bi > 0) {
      if (Date.now() + BATCH_DELAY_MS >= deadline) {
        return { status: "pending", ...empty, campaignsCount };
      }
      await sleep(BATCH_DELAY_MS);
    }
    const batch = batches[bi];
    // Безопасная диагностика этого заказа статистики (только числа/константа).
    const statsDiag: StatsDiag = {
      campaignsInRequest: batch.length,
      batchIndex: bi + 1,
      batchesTotal: batches.length,
      requestBodyShape: STATISTICS_BODY_SHAPE,
    };

    // 3) заказать статистику → UUID
    const orderRes = await perfFetch(STATISTICS_URL, token, {
      method: "POST",
      body: { campaigns: batch, dateFrom, dateTo, groupBy: "DATE" },
    });
    // Rate limit на заказе статистики — самая частая точка 429. Останавливаемся
    // и возвращаем rate_limited (остальные батчи НЕ шлём — не усугубляем лимит).
    if (orderRes.status === 429) {
      return rateLimited("statistics", campaignsCount, orderRes.retryAfterSec, {
        ...statsDiag,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (!orderRes.ok) {
      return {
        status: "unavailable",
        ...empty,
        campaignsCount,
        stage: "statistics",
        httpStatus: orderRes.status || undefined,
        detail: "Не удалось заказать статистику",
        ...statsDiag,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const uuid = extractUuid(orderRes.json);
    if (!uuid) {
      return {
        status: "unavailable",
        ...empty,
        campaignsCount,
        stage: "statistics",
        httpStatus: orderRes.status || undefined,
        detail: "Ozon не вернул идентификатор отчёта",
        ...statsDiag,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // 4) опрос готовности (bounded общим дедлайном)
    let state: PollState = "pending";
    while (Date.now() < deadline) {
      const statusRes = await perfFetch(STATUS_URL(uuid), token);
      // Rate limit во время опроса готовности — прекращаем опрос, не долбим Ozon.
      if (statusRes.status === 429) {
        return rateLimited("poll", campaignsCount, statusRes.retryAfterSec, {
          ...statsDiag,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (statusRes.ok) {
        state = readPollState(statusRes.json);
        if (state === "ready") break;
        if (state === "error") {
          return {
            status: "unavailable",
            ...empty,
            campaignsCount,
            stage: "poll",
            httpStatus: statusRes.status || undefined,
            detail: "Ozon не смог сформировать отчёт",
          };
        }
      }
      if (Date.now() + POLL_DELAY_MS >= deadline) break;
      await sleep(POLL_DELAY_MS);
    }
    if (state !== "ready") {
      // Отчёт ещё формируется — честно сообщаем pending, не выдаём частичную сумму.
      return { status: "pending", ...empty, campaignsCount };
    }

    // 5) скачать отчёт
    const reportRes = await perfFetch(REPORT_URL(uuid), token);
    if (reportRes.status === 429) {
      return rateLimited("report", campaignsCount, reportRes.retryAfterSec, {
        ...statsDiag,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (!reportRes.ok) {
      return {
        status: "unavailable",
        ...empty,
        campaignsCount,
        stage: "report",
        httpStatus: reportRes.status || undefined,
        detail: "Не удалось скачать отчёт",
      };
    }

    // 6) суммируем
    const { spend, rows, recognized } = sumReport(reportRes.json);
    if (!recognized) {
      // HTTP 200, но тело не в ожидаемом JSON-формате (rows/moneySpent): не-JSON,
      // CSV/ZIP или иная схема. НЕ выдаём ложный «0 ₽ ok» — сообщаем честно.
      return {
        status: "unavailable",
        ...empty,
        campaignsCount,
        stage: "report",
        httpStatus: reportRes.status || undefined,
        detail: "Формат отчёта Performance API не распознан",
      };
    }
    totalSpend += spend;
    totalRows += rows;
  }

  return {
    status: "ok",
    adsSpend: Math.round(totalSpend * 100) / 100,
    campaignsCount,
    rowsCount: totalRows,
  };
}
