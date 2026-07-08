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
// Reuse pending UUID (главный анти-429 фикс): Performance API асинхронный. Раньше
// КАЖДЫЙ клик заново делал POST /statistics/json и создавал НОВЫЙ заказ отчёта →
// Ozon отвечал 429. Теперь заказанный UUID кэшируется В ПАМЯТИ ПРОЦЕССА по ключу
// userId+month+campaignsHash (TTL ~12 мин): повторный клик за тот же месяц НЕ
// создаёт новый заказ, а продолжает poll/report по уже полученному UUID. После
// успешного скачивания/ошибки заказа запись из кэша убирается. Это НЕ БД — при
// рестарте/нескольких инстансах кэш теряется → безопасная деградация к заказу заново.
//
// access_token и client_secret НИКОГДА не логируются; UUID отчёта — не секрет, но
// в кэш секреты/токен не попадают и в лог не пишутся.
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
   * true, если этот вызов продолжил ОЖИДАНИЕ ранее заказанного отчёта по
   * закэшированному UUID (не создавал новый заказ statistics/json). Для UI-подсказки
   * на pending «продолжаем ожидание ранее заказанного отчёта». Не секрет.
   */
  reused?: boolean;
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
  /**
   * Значение заголовка Content-Type ответа (без параметров, напр. "application/json").
   * Безопасная диагностика формата отчёта — НЕ тело, НЕ секрет.
   */
  contentType?: string;
  /**
   * true, если тело непустое, но НЕ распарсилось как JSON (CSV/ZIP/HTML/текст).
   * Сам текст тела НЕ сохраняется и НЕ логируется — только этот флаг.
   */
  nonJson?: boolean;
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
    // Content-Type без параметров (application/json; charset=... → application/json).
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    // Читаем тело как ТЕКСТ и пытаемся распарсить JSON сами: так мы отличаем
    // «пустое тело» от «не-JSON» (CSV/ZIP/HTML) для безопасной диагностики. Сам
    // текст тела НЕ сохраняем и НЕ логируем — только флаг nonJson и content-type.
    let json: unknown = null;
    let nonJson = false;
    try {
      const text = await res.text();
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          nonJson = true;
        }
      }
    } catch {
      json = null;
    }
    // Retry-After читаем только при 429 (rate limit) — иначе он не нужен.
    const retryAfterSec = res.status === 429 ? parseRetryAfter(res) : undefined;
    return { ok: res.ok, status: res.status, json, retryAfterSec, contentType, nonJson };
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

// ---------------------------------------------------------------------------
// Разбор тела отчёта Performance API. Формат Ozon зависит от числа кампаний и
// может класть строки на РАЗНОЙ глубине, например:
//   { rows: [...] }                              (плоский)
//   { report: { rows: [...] } }                  (обёртка report)
//   { "<campId>": { rows: [...] } }              (по кампаниям)
//   { "<campId>": { report: { rows: [...] } } }  (report внутри кампании)
//   { result: { ... } }                          (обёртка result)
//   [ {...}, {...} ]                              (голый массив строк сверху)
// Поэтому вместо фиксированного обхода ищем массивы rows РЕКУРСИВНО, с пределом
// глубины и бюджетом узлов (защита от слишком большого обхода).
// ---------------------------------------------------------------------------

const REPORT_MAX_DEPTH = 8; // предел глубины рекурсии по телу отчёта
const REPORT_WALK_BUDGET = 100000; // предел числа посещённых узлов (защита от большого обхода)
const REPORT_DIAG_MAX_KEYS = 8; // сколько имён верхнеуровневых ключей показываем в диагностике
const REPORT_DIAG_MAX_KEY_LEN = 32; // предел длины одного имени ключа в диагностике

/**
 * Просуммировать moneySpent по строкам отчёта, терпимо к форме конверта.
 *
 * Рекурсивно (глубина ≤ REPORT_MAX_DEPTH, бюджет узлов REPORT_WALK_BUDGET) ищем
 * массивы под ключом `rows` на любом уровне. Если явных rows нет — как запасной
 * вариант берём row-подобный массив (все элементы — объекты с полем moneySpent):
 * это покрывает голый массив строк сверху и { result: [ ... ] }. НЕ падаем на
 * null / строках / числах / иных типах.
 *
 * recognized=true, если найден ХОТЯ БЫ один rows-массив (даже пустой) — тогда 0 ₽
 * валидны (у кампаний не было расхода). Если ни одного — recognized=false, и
 * вызывающий НЕ выдаёт ложный «0 ₽ ok», а честно сообщает «формат не распознан»
 * (+ безопасная диагностика структуры).
 */
function sumReport(json: unknown): {
  spend: number;
  rows: number;
  recognized: boolean;
  /** Сколько rows-массивов реально найдено (диагностика; 0 → не распознан). */
  rowsArrays: number;
} {
  const explicit: unknown[][] = []; // массивы под ключом "rows"
  const candidate: unknown[][] = []; // row-подобные массивы (элементы с moneySpent)
  let budget = REPORT_WALK_BUDGET;

  // Массив считаем «строками», если он непустой и КАЖДЫЙ элемент — объект (не
  // массив) с полем moneySpent. Это отсекает служебные массивы (напр. кампании).
  const isRowLikeArray = (arr: unknown[]): boolean =>
    arr.length > 0 &&
    arr.every(
      (e) =>
        !!e &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        "moneySpent" in (e as Record<string, unknown>)
    );

  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > REPORT_MAX_DEPTH) return;
    if (!node || typeof node !== "object") return;
    budget -= 1;
    if (Array.isArray(node)) {
      if (isRowLikeArray(node)) candidate.push(node);
      for (const el of node) walk(el, depth + 1);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const val = (node as Record<string, unknown>)[key];
      if (key === "rows" && Array.isArray(val)) {
        explicit.push(val); // строки — листья: внутрь не углубляемся
      } else {
        walk(val, depth + 1);
      }
    }
  };

  walk(json, 0);

  // Приоритет — явные rows; иначе запасной row-подобный массив (bare / result:[...]).
  const chosen = explicit.length > 0 ? explicit : candidate;

  let spend = 0;
  let rows = 0;
  for (const arr of chosen) {
    for (const r of arr) {
      if (r && typeof r === "object") {
        spend += parseMoney((r as { moneySpent?: unknown }).moneySpent);
        rows += 1;
      }
    }
  }
  return { spend, rows, recognized: chosen.length > 0, rowsArrays: chosen.length };
}

/**
 * Безопасное описание формы НЕраспознанного тела отчёта для диагностики. НЕ
 * содержит значений строк / сумм / секретов / токена / UUID — только тип тела,
 * content-type, ИМЕНА верхнеуровневых ключей (санитизированы, с лимитом) и число
 * найденных rows-массивов; плюс метка non_json_body, если тело было не JSON.
 */
function describeReportShape(res: HttpResult, rowsArrays: number): string {
  const json = res.json;
  const parts: string[] = [`ct=${res.contentType ?? "?"}`];
  const bodyType = Array.isArray(json)
    ? "array"
    : json === null
      ? "null"
      : typeof json;
  parts.push(`body=${bodyType}`);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const allKeys = Object.keys(json as Record<string, unknown>);
    const shown = allKeys.slice(0, REPORT_DIAG_MAX_KEYS).map((k) => {
      const safe = k.replace(/[^\w.-]/g, "_"); // только буквы/цифры/._- (без значений/спецсимволов)
      return safe.length > REPORT_DIAG_MAX_KEY_LEN
        ? `${safe.slice(0, REPORT_DIAG_MAX_KEY_LEN)}*`
        : safe;
    });
    const more =
      allKeys.length > shown.length ? `+${allKeys.length - shown.length}` : "";
    parts.push(`keys=[${shown.join(",")}${more}]`);
  }
  parts.push(`rowsArrays=${rowsArrays}`);
  if (res.nonJson) parts.push("non_json_body");
  return parts.join("; ");
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

// ---------------------------------------------------------------------------
// In-memory best-effort кэш pending-заказов статистики (reuse pending UUID).
// ТОЛЬКО память процесса (Map уровня модуля) — это НЕ БД: UUID/month/userId в базу
// НЕ пишутся. Serverless-оговорка: при рестарте/нескольких инстансах кэш теряется
// → безопасная деградация к заказу отчёта заново. Секреты/токен сюда НЕ попадают.
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 12 * 60 * 1000; // 12 мин — окно жизни pending-UUID (10–15 мин)

type PendingReport = {
  month: string;
  campaignsHash: string;
  /** batchIndex → UUID уже заказанного (возможно ещё не готового) отчёта. */
  uuids: Record<number, string>;
  createdAt: number;
  expiresAt: number;
};

/** userId+month+campaignsHash → pending-заказы. Живёт только в памяти процесса. */
const pendingReports = new Map<string, PendingReport>();

function pendingKey(userId: string, month: string, campaignsHash: string): string {
  return `${userId}|${month}|${campaignsHash}`;
}

/** FNV-1a 32-bit хэш ОТСОРТИРОВАННОГО списка id кампаний (детерминированный ключ). */
function hashCampaigns(ids: string[]): string {
  const joined = [...ids].sort().join(",");
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Убрать протухшие записи (ограничиваем рост Map). */
function prunePending(): void {
  const now = Date.now();
  for (const [k, v] of pendingReports) {
    if (now >= v.expiresAt) pendingReports.delete(k);
  }
}

/** Свежая запись кэша или undefined (протухшую удаляем). */
function getPending(key: string): PendingReport | undefined {
  const e = pendingReports.get(key);
  if (!e) return undefined;
  if (Date.now() >= e.expiresAt) {
    pendingReports.delete(key);
    return undefined;
  }
  return e;
}

/** Запомнить UUID заказанного отчёта для батча (создаёт/обновляет запись). */
function rememberUuid(
  key: string,
  month: string,
  campaignsHash: string,
  batchIndex: number,
  uuid: string
): void {
  const now = Date.now();
  const e = getPending(key);
  if (e) {
    e.uuids[batchIndex] = uuid;
  } else {
    pendingReports.set(key, {
      month,
      campaignsHash,
      uuids: { [batchIndex]: uuid },
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
    });
  }
}

/** Забыть UUID одного батча (Ozon вернул error/fail по заказу). Пустую запись удаляем. */
function forgetUuid(key: string, batchIndex: number): void {
  const e = pendingReports.get(key);
  if (!e) return;
  delete e.uuids[batchIndex];
  if (Object.keys(e.uuids).length === 0) pendingReports.delete(key);
}

/** Забыть весь заказ (успешно скачан целиком — переиспользовать больше нечего). */
function forgetPending(key: string): void {
  pendingReports.delete(key);
}

/**
 * Единый исход «Ozon ограничил частоту запросов» (HTTP 429) для любого этапа.
 * Безопасно: только этап, код 429 и число секунд подсказки — без тела/секретов.
 * Если Retry-After Ozon не прислал — даём консервативную подсказку (60–120с).
 */
function rateLimited(
  stage: AdsSpendStage,
  campaignsCount: number,
  retryAfterSec?: number
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
  };
}

/**
 * Получить справочный расход рекламы за месяц. Никогда не бросает — только
 * дискриминированный результат. Ничего не сохраняет в БД, ничего не логирует.
 *
 * userId нужен ТОЛЬКО как часть ключа in-memory кэша pending-UUID
 * (userId+month+campaignsHash) — чтобы повторный клик за тот же месяц продолжал
 * poll/report по ранее заказанному отчёту, а не создавал новый (анти-429). userId
 * в БД/лог не пишется.
 */
export async function fetchAdsSpendForMonth(
  clientId: string,
  clientSecret: string,
  month: string,
  userId: string
): Promise<AdsSpendOutcome> {
  const empty = { adsSpend: 0, campaignsCount: 0, rowsCount: 0 } as const;

  // 1) access_token
  const tok = await getPerformanceAccessToken(clientId, clientSecret);
  if (!tok.ok) {
    // Rate limit уже на выдаче токена — не generic-недоступность (Retry-After
    // токен-хелпер не отдаёт, поэтому подсказка консервативная по умолчанию).
    if (tok.httpStatus === 429) {
      return rateLimited("token", 0);
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
    return rateLimited("campaigns", 0, campRes.retryAfterSec);
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
  // Детерминированный порядок → стабильные батчи и campaignsHash между кликами,
  // чтобы закэшированный UUID батча всегда соответствовал тем же кампаниям.
  const ids = extractCampaignIds(campRes.json).sort();
  const campaignsCount = ids.length;
  if (campaignsCount === 0) {
    // Нет кампаний — это валидный результат: расход рекламы 0.
    return { status: "no_campaigns", adsSpend: 0, campaignsCount: 0, rowsCount: 0 };
  }

  const { dateFrom, dateTo } = monthRange(month);
  const deadline = Date.now() + GLOBAL_DEADLINE_MS;

  // Reuse pending UUID: ключ по userId+month+набору кампаний; если под ним уже есть
  // заказанный ранее отчёт — продолжим poll/report по нему, НЕ создавая новый заказ.
  const campaignsHash = hashCampaigns(ids);
  const cacheKey = pendingKey(userId, month, campaignsHash);
  prunePending();
  const cached = getPending(cacheKey);

  let totalSpend = 0;
  let totalRows = 0;
  let reusedAny = false; // хоть один батч продолжили по ранее заказанному UUID
  let didOrderThisCall = false; // делали ли POST /statistics/json в этом вызове (пауза)

  // pending-выход с флагом reused (UI покажет «продолжаем ожидание ранее заказанного»).
  const pendingOutcome = (): AdsSpendOutcome => ({
    status: "pending",
    ...empty,
    campaignsCount,
    reused: reusedAny || undefined,
  });

  // 3–6) последовательно по батчам (Ozon запрещает параллельные запросы). Между
  // ЗАКАЗАМИ держим паузу и НЕ продолжаем после первого 429 — не спамим Ozon.
  const batches = chunk(ids, CAMPAIGN_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    if (Date.now() >= deadline) return pendingOutcome();
    const batch = batches[bi];

    // Уже заказанный (в предыдущем клике) UUID этого батча — переиспользуем.
    let uuid: string | null = cached?.uuids[bi] ?? null;

    if (uuid) {
      // ПОВТОРНЫЙ клик за тот же месяц: НЕ создаём новый заказ statistics/json,
      // а сразу идём в poll/report по ранее полученному UUID (это и снижает 429).
      reusedAny = true;
    } else {
      // Новый заказ. Пауза перед КАЖДЫМ заказом, кроме первого в этом вызове.
      if (didOrderThisCall) {
        if (Date.now() + BATCH_DELAY_MS >= deadline) return pendingOutcome();
        await sleep(BATCH_DELAY_MS);
      }

      // 3) заказать статистику → UUID
      const orderRes = await perfFetch(STATISTICS_URL, token, {
        method: "POST",
        body: { campaigns: batch, dateFrom, dateTo, groupBy: "DATE" },
      });
      didOrderThisCall = true;
      // Rate limit на заказе статистики — самая частая точка 429. Останавливаемся
      // и возвращаем rate_limited (остальные батчи НЕ шлём — не усугубляем лимит).
      // Ранее закэшированные UUID (если были) остаются валидны для след. клика.
      if (orderRes.status === 429) {
        return rateLimited("statistics", campaignsCount, orderRes.retryAfterSec);
      }
      if (!orderRes.ok) {
        return {
          status: "unavailable",
          ...empty,
          campaignsCount,
          stage: "statistics",
          httpStatus: orderRes.status || undefined,
          detail: "Не удалось заказать статистику",
        };
      }
      uuid = extractUuid(orderRes.json);
      if (!uuid) {
        return {
          status: "unavailable",
          ...empty,
          campaignsCount,
          stage: "statistics",
          httpStatus: orderRes.status || undefined,
          detail: "Ozon не вернул идентификатор отчёта",
        };
      }
      // Запоминаем pending-UUID: повторный клик продолжит poll/report по нему,
      // не создавая новый заказ. Секреты/токен в кэш НЕ попадают.
      rememberUuid(cacheKey, month, campaignsHash, bi, uuid);
    }

    // 4) опрос готовности (bounded общим дедлайном)
    let state: PollState = "pending";
    while (Date.now() < deadline) {
      const statusRes = await perfFetch(STATUS_URL(uuid), token);
      // Rate limit во время опроса готовности — прекращаем опрос, не долбим Ozon.
      if (statusRes.status === 429) {
        return rateLimited("poll", campaignsCount, statusRes.retryAfterSec);
      }
      if (statusRes.ok) {
        state = readPollState(statusRes.json);
        if (state === "ready") break;
        if (state === "error") {
          // Ozon не смог сформировать отчёт — этот UUID бесполезен: убираем из
          // кэша, чтобы следующий клик заказал заново.
          forgetUuid(cacheKey, bi);
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
      // Отчёт ещё формируется — pending. UUID сохранён в кэше: следующий клик
      // продолжит ожидание того же заказа, НЕ создавая новый.
      return pendingOutcome();
    }

    // 5) скачать отчёт
    const reportRes = await perfFetch(REPORT_URL(uuid), token);
    if (reportRes.status === 429) {
      return rateLimited("report", campaignsCount, reportRes.retryAfterSec);
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

    // 6) суммируем (рекурсивный поиск rows-массивов, терпим к форме конверта)
    const { spend, rows, recognized, rowsArrays } = sumReport(reportRes.json);
    if (!recognized) {
      // HTTP 200, но ни одного rows-массива не нашли: не-JSON тело (CSV/ZIP) или
      // неизвестная схема. НЕ выдаём ложный «0 ₽ ok» — сообщаем честно и прилагаем
      // БЕЗОПАСНУЮ диагностику формы (тип/content-type/имена ключей/число rows),
      // без значений строк/секретов/токена/UUID.
      return {
        status: "unavailable",
        ...empty,
        campaignsCount,
        stage: "report",
        httpStatus: reportRes.status || undefined,
        detail: `Формат отчёта Performance API не распознан (${describeReportShape(
          reportRes,
          rowsArrays
        )})`,
      };
    }
    totalSpend += spend;
    totalRows += rows;
  }

  // Все батчи скачаны и просуммированы — заказ полностью использован, чистим кэш.
  forgetPending(cacheKey);

  return {
    status: "ok",
    adsSpend: Math.round(totalSpend * 100) / 100,
    campaignsCount,
    rowsCount: totalRows,
  };
}
