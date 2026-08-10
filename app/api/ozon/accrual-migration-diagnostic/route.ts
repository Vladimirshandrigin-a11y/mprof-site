// ============================================================================
// ВРЕМЕННАЯ read-only диагностика миграции Ozon Seller API (accrual + posting v3/v4).
//
// Цель: по кнопке сравнить старые и новые методы Ozon за выбранный месяц и вернуть
// ТОЛЬКО безопасную схему (имена ключей + типы), агрегаты и статусы — БЕЗ секретов,
// БЕЗ идентификаторов (Api-Key/Client-Id/posting_number/operation_id/SKU/offer_id/
// названий товаров), БЕЗ raw-ответов. Ничего не сохраняет, не списывает, не меняет
// прибыль. НЕ выполняет финансовую классификацию — только диагностика схемы.
//
// Порядок фаз — FINANCE-FIRST: сначала критичные finance-методы (types → by-day),
// затем справочные posting-методы (fbo/fbs → accrual/postings), в конце legacy —
// только если новые данные полны. Все новые запросы идут через один
// последовательный pacer (≥MIN_REQUEST_INTERVAL_MS между стартами), поэтому
// Ozon-rate-limit не срабатывает на «шторме» первых запросов.
//
// Безопасность: user_id ТОЛЬКО из токена (authenticateRequest); ключ Ozon берётся
// из ozon_connections текущего пользователя и расшифровывается ТОЛЬКО на сервере.
// Запросы последовательные (без параллельного шторма), с timeout, hard-limit
// пагинации и остановкой на 429. Никаких DB writes / consume / save-calculation.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { monthToRange, fetchOzonTransactions } from "../_lib/finance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const SELLER = "https://api-seller.ozon.ru";
const TIMEOUT_MS = 15000;
// Hard-лимиты, чтобы диагностика оставалась лёгкой и не устраивала шторм.
const FBO_MAX_PAGES = 3;
const FBS_MAX_PAGES = 3;
const POST_LIMIT = 100;
const MAX_POSTING_NUMBERS = 200; // 1 батч для accrual/postings (макс. 200 по схеме)
const BY_DAY_MAX_PAGES_PER_DAY = 5;
// Последовательный pacer: минимум MIN_REQUEST_INTERVAL_MS между СТАРТАМИ соседних
// реальных Ozon-запросов (первый — сразу). Ozon rate-limit на seller-эндпоинтах
// срабатывал на 3-м мгновенном запросе; ~1 запрос / 1.1 c держит нас ниже лимита.
const MIN_REQUEST_INTERVAL_MS = 1100;
// Мягкий общий дедлайн: после него НЕ стартуем новых Ozon-запросов (finance-first
// схема к этому моменту уже собрана) и помечаем truncated. Гарантирует ответ до
// таймаута прокси. Дедлайн-проверка — не fetch: budget не трогает, запросом не считается.
const DIAG_DEADLINE_MS = 40000;
// Доказуемый общий предел исходящих Ozon-запросов за один запуск:
//   новые методы (через ozonPost) ≤ NEW_API_MAX_REQUESTS,
//   старый fetchOzonTransactions ≤ LEGACY_MAX_REQUESTS (finance.ts: MAX_PAGES=20),
//   worst-case суммарно ≤ TOTAL_MAX_REQUESTS = 130 + 20 = 150.
const TOTAL_MAX_REQUESTS = 150;
const LEGACY_MAX_REQUESTS = 20; // fetchOzonTransactions: макс. 20 внутренних страниц
const NEW_API_MAX_REQUESTS = TOTAL_MAX_REQUESTS - LEGACY_MAX_REQUESTS; // 130

type OzonHeaders = { "Client-Id": string; "Api-Key": string; "Content-Type": string };

// Состояние на ОДИН вызов POST (не глобальное — чтобы параллельные запросы разных
// пользователей не влияли друг на друга). used — счётчик реальных fetch; lastStart —
// таймстамп старта предыдущего реального запроса (для pacer); deadline — абсолютная
// точка, после которой новые запросы не стартуют.
type Budget = { used: number; lastStart: number; deadline: number };

type FetchOut =
  | { ok: true; status: number; json: unknown }
  | {
      ok: false;
      status: number;
      code: "invalid_key" | "forbidden" | "rate_limited" | "timeout" | "bad_response" | "unavailable" | "deadline";
      retryAfter?: number | null;
    };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- один безопасный POST к Ozon (никогда не бросает) ----
// Проходит через единый pacer/budget/deadline: параллельных запросов нет.
async function ozonPost(
  url: string,
  headers: OzonHeaders,
  body: unknown,
  budget: Budget
): Promise<FetchOut> {
  if (budget.used >= NEW_API_MAX_REQUESTS) {
    return { ok: false, status: 0, code: "unavailable" };
  }
  // Мягкий дедлайн: не стартуем новых запросов (не fetch → budget не трогаем).
  if (Date.now() >= budget.deadline) {
    return { ok: false, status: 0, code: "deadline" };
  }
  // Pacer: выдерживаем MIN_REQUEST_INTERVAL_MS от старта предыдущего РЕАЛЬНОГО запроса.
  // Первый запрос (lastStart===0) — сразу. Ожидание НЕ считается запросом и НЕ трогает budget.
  if (budget.lastStart !== 0) {
    const waitMs = MIN_REQUEST_INTERVAL_MS - (Date.now() - budget.lastStart);
    if (waitMs > 0) await sleep(waitMs);
  }
  // Повторная проверка дедлайна ПОСЛЕ сна и ДО fetch: sleep мог перенести старт за
  // deadline. Без этого запрос стартовал бы после мягкого дедлайна (не fetch → budget не трогаем).
  if (Date.now() >= budget.deadline) {
    return { ok: false, status: 0, code: "deadline" };
  }
  budget.lastStart = Date.now();
  budget.used += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, status: 401, code: "invalid_key" };
      if (res.status === 403) return { ok: false, status: 403, code: "forbidden" };
      if (res.status === 429) {
        // Retry-After берём ТОЛЬКО если заголовок реально присутствует и это
        // неотрицательное число секунд. Никаких других заголовков/тела наружу.
        const ra = res.headers.get("retry-after");
        let retryAfter: number | null = null;
        if (ra !== null) {
          const n = Number.parseInt(ra.trim(), 10);
          if (Number.isFinite(n) && n >= 0) retryAfter = n;
        }
        return { ok: false, status: 429, code: "rate_limited", retryAfter };
      }
      return { ok: false, status: res.status, code: "unavailable" };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, status: res.status, code: "bad_response" };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, status: 0, code: aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

// ---- утилиты формы (ТОЛЬКО имена ключей + типы, никаких значений) ----
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const first = v.length > 0 ? v[0] : undefined;
    return `array<${first === undefined ? "unknown" : typeName(first)}>`;
  }
  return typeof v; // string | number | boolean | object | undefined
}

/** Карта {ключ: тип} на 1 уровень (значения НЕ раскрываются). Для вложенных
 *  объектов/массивов рекурсивно — но с ограничением глубины. */
function keySchema(value: unknown, depth: number): unknown {
  if (depth <= 0) return typeName(value);
  if (Array.isArray(value)) {
    return value.length > 0 ? [keySchema(value[0], depth - 1)] : "array<empty>";
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v && typeof v === "object" ? keySchema(v, depth - 1) : typeName(v);
    }
    return out;
  }
  return typeName(value);
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---- безопасная ФОРМА ответа (ТОЛЬКО имена ключей + типы, БЕЗ значений) ----
// Тот же value-free принцип, что и keySchema, но с hard-limit на число узлов
// (защита от раздувания ответа). Захватывается ДО текущего парсинга, чтобы при
// HTTP 200 + records=0 стало видно, где реально лежит массив. Скаляр → только тип
// ("string"/"number"/"boolean"/…); null → "null"; пустой массив → "array";
// непустой массив → форма ПЕРВОГО элемента (ключи+типы). Значения НЕ раскрываются.
const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_NODES = 200;
function responseShape(value: unknown): unknown {
  const budget = { nodes: 0 };
  const walk = (v: unknown, depth: number): unknown => {
    budget.nodes += 1;
    if (budget.nodes > SHAPE_MAX_NODES) return "…nodes_truncated";
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (v.length === 0 || depth <= 1) return "array";
      return [walk(v[0], depth - 1)]; // форма первого элемента, без значений
    }
    if (typeof v === "object") {
      if (depth <= 1) return "object";
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (budget.nodes >= SHAPE_MAX_NODES) {
          out["__truncated__"] = "nodes_limit";
          break;
        }
        out[k] = walk(val, depth - 1);
      }
      return out;
    }
    return typeof v; // только имя типа скаляра, НЕ значение
  };
  return walk(value, SHAPE_MAX_DEPTH);
}

// Дни выбранного месяца в формате YYYY-MM-DD (для accrual/by-day).
function daysOfMonth(month: string): string[] {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= last; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

// ---- owner-only allowlist из server-only env (fail-closed) ----
// Формат OZON_ACCRUAL_DIAGNOSTIC_USER_IDS: Supabase user UUID через запятую.
// Нет env / пусто / userId не в списке → доступа нет. UUID/env НЕ логируются.
//
// Нормализация значения: веб-панель (Timeweb) часто сохраняет env в кавычках или
// со скрытыми символами (BOM), а UUID регистронезависим. Поэтому обе стороны
// приводим к канону: убираем пробелы/переводы строк, BOM, окружающие кавычки и
// регистр. Fail-closed СОХРАНЯЕТСЯ: пустое после нормализации → не совпадёт;
// разные UUID не коллидируют (lower-case не делает разные значения равными).
function normId(s: string): string {
  return s
    .trim()
    .replace(/^["']+|["']+$/g, "") // окружающие кавычки
    .replace(/\uFEFF/g, "") // BOM (в UUID не встречается)
    .trim()
    .toLowerCase();
}

function isDiagnosticOwner(userId: string): boolean {
  const raw = process.env.OZON_ACCRUAL_DIAGNOSTIC_USER_IDS;
  if (!raw) return false;
  const target = normId(userId);
  if (!target) return false; // без валидного userId — доступа нет
  const allow = raw.split(",").map(normId).filter((s) => s.length > 0);
  return allow.includes(target);
}

// Единый fail-closed ответ «не найдено» — не раскрывает существование route.
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

// ---- GET: лёгкий owner-check для UI. Только auth + allowlist. ----
// НЕ читает ozon_connections, НЕ расшифровывает ключ, НЕ ходит в Ozon.
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  if (!isDiagnosticOwner(auth.userId)) return notFound();
  return NextResponse.json({ allowed: true }, { status: 200, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  // Owner-only: fail-closed ДО чтения ozon_connections/decrypt/любых Ozon-запросов.
  // Клиентскому GET-чеку НЕ доверяем — POST перепроверяет allowlist сам.
  if (!isDiagnosticOwner(userId)) return notFound();

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "Шифрование ключей не настроено", code: "encryption_misconfigured" },
      { status: 503, headers: NO_STORE }
    );
  }

  // ---- body: month + skipTypes (единственный вход; никаких ключей/user_id из body) ----
  let month = "2026-06";
  let skipTypes = false; // отсутствует → обратная совместимость (types вызывается)
  try {
    const body = (await req.json()) as { month?: unknown; skipTypes?: unknown };
    if (typeof body?.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) {
      month = body.month;
    }
    // skipTypes строго boolean: присутствует и не boolean → 400 (безопасный код).
    if (body?.skipTypes !== undefined && typeof body.skipTypes !== "boolean") {
      return NextResponse.json(
        { error: "skipTypes должен быть boolean", code: "bad_skip_types" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (typeof body?.skipTypes === "boolean") skipTypes = body.skipTypes;
  } catch {
    /* пустое/битое тело → дефолты: month=2026-06, skipTypes=false */
  }
  const range = monthToRange(month);
  if (!range) {
    return NextResponse.json(
      { error: "Некорректный месяц", code: "bad_month" },
      { status: 400, headers: NO_STORE }
    );
  }

  // ---- подключение Ozon текущего пользователя (ключ ТОЛЬКО отсюда) ----
  const { data: conn, error: connErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (connErr) {
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }
  if (!conn || !conn.client_id || !conn.api_key_encrypted) {
    return NextResponse.json(
      { error: "Подключение Ozon не найдено", code: "not_connected" },
      { status: 400, headers: NO_STORE }
    );
  }
  let apiKey: string;
  try {
    apiKey = decryptOzonApiKey(conn.api_key_encrypted as string);
  } catch {
    return NextResponse.json(
      { error: "Ключ Ozon нужно переподключить", code: "decrypt_failed" },
      { status: 400, headers: NO_STORE }
    );
  }
  const clientId = conn.client_id as string;
  const headers: OzonHeaders = {
    "Client-Id": clientId,
    "Api-Key": apiKey,
    "Content-Type": "application/json",
  };

  const budget: Budget = { used: 0, lastStart: 0, deadline: Date.now() + DIAG_DEADLINE_MS };
  let rateLimited = false;
  let retryAfterSeconds: number | null = null;
  const methods: Record<string, unknown> = {};
  const postingNumbers: string[] = [];

  // safe-код ошибки метода (без raw)
  const errCode = (r: FetchOut): string => (r.ok ? "ok" : r.code);
  // Централизованная фиксация 429: ставим rateLimited и (один раз) retryAfterSeconds.
  // После этого все следующие фазы и legacy НЕ выполняются.
  const noteRateLimit = (r: FetchOut) => {
    if (!r.ok && r.code === "rate_limited") {
      rateLimited = true;
      if (retryAfterSeconds === null && typeof r.retryAfter === "number") {
        retryAfterSeconds = r.retryAfter;
      }
    }
  };
  // Явный маркер фазы, пропущенной из-за уже случившегося 429.
  const skippedMethod = (endpoint: string) => ({
    endpoint,
    status: 0,
    skipped: true,
    error: "rate_limited" as const,
  });

  // ============== 1) accrual/types — ПЕРВЫЙ Ozon-запрос (finance-first), ==============
  // ============== ЕСЛИ владелец не пропустил (справочник 119 типов уже собран). =======
  if (skipTypes) {
    // Явный owner-пропуск: types НЕ вызывается, budget не растёт, rateLimited/truncated
    // НЕ выставляются. Первым РЕАЛЬНЫМ Ozon-запросом станет by-day. Пропуск (reason
    // already_collected) намеренный → не считается незавершённостью плана.
    methods.accrual_types = {
      endpoint: "/v1/finance/accrual/types",
      status: 0,
      skipped: true,
      reason: "already_collected",
    };
  } else if (!rateLimited) {
    const r = await ozonPost(`${SELLER}/v1/finance/accrual/types`, headers, undefined, budget);
    noteRateLimit(r);
    let count = 0;
    let dictionary: Array<{ accrual_id: unknown; name: unknown; description: unknown }> = [];
    let schema: unknown = null;
    if (r.ok) {
      // типы могут лежать в result[] / types[] / accrual_types[] — берём мягко.
      const root = asObj(r.json);
      const arr =
        asArr(root.result).length > 0 ? asArr(root.result)
        : asArr(root.types).length > 0 ? asArr(root.types)
        : asArr(root.accrual_types);
      if (arr.length > 0) schema = keySchema(arr[0], 3);
      count = arr.length;
      // Справочник типов — глобальная классификация (не персональные данные) → показываем.
      dictionary = arr.slice(0, 300).map((t) => {
        const o = asObj(t);
        return {
          accrual_id: o.accrual_id ?? o.type_id ?? o.id ?? null,
          name: o.name ?? o.title ?? null,
          description: o.description ?? o.desc ?? null,
        };
      });
    }
    methods.accrual_types = { endpoint: "/v1/finance/accrual/types", status: r.status, count, dictionary, schema, error: errCode(r) };
  } else {
    methods.accrual_types = skippedMethod("/v1/finance/accrual/types");
  }

  // ================= 2) accrual/by-day (finance-фаза, по дням месяца) =================
  if (!rateLimited) {
    const days = daysOfMonth(month);
    let daysQueried = 0;
    let pages = 0;
    let records = 0;
    let sumTotalAmount = 0;
    let containerFeesSum = 0;
    let containerFeesSeen = false;
    let truncated = false;
    let status = 0;
    let schema: unknown = null;
    let lastErr = "ok";
    let bydayShape: unknown = null; // безопасная форма первого 200-ответа by-day
    const categories = new Set<string>();
    for (const day of days) {
      if (rateLimited || Date.now() >= budget.deadline) break;
      let lastId = "";
      for (let p = 0; p < BY_DAY_MAX_PAGES_PER_DAY; p++) {
        const r = await ozonPost(`${SELLER}/v1/finance/accrual/by-day`, headers, { date: day, last_id: lastId }, budget);
        status = r.status;
        lastErr = errCode(r);
        if (!r.ok) {
          noteRateLimit(r);
          break;
        }
        // Безопасная форма первого 200-ответа — ДО парсинга (ключи+типы, без значений).
        if (bydayShape === null) bydayShape = responseShape(r.json);
        const root = asObj(r.json);
        const result = asObj(root.result);
        // записи могут лежать в result.details[]/result.rows[]/result[]/root.details[] — мягко.
        const items =
          asArr(result.details).length > 0 ? asArr(result.details)
          : asArr(result.rows).length > 0 ? asArr(result.rows)
          : asArr(root.details).length > 0 ? asArr(root.details)
          : asArr(root.result);
        if (schema === null && items.length > 0) schema = keySchema(items[0], 3);
        records += items.length;
        for (const it of items) {
          const o = asObj(it);
          // Σ total_amount.amount (по задаче). Мягко: total_amount может быть числом/объектом.
          const ta = o.total_amount;
          if (typeof ta === "number") sumTotalAmount += numOr0(ta);
          else sumTotalAmount += numOr0(asObj(ta).amount);
          // container_fees — если есть
          if (o.container_fees !== undefined) {
            containerFeesSeen = true;
            const cf = o.container_fees;
            if (typeof cf === "number") containerFeesSum += numOr0(cf);
            else containerFeesSum += numOr0(asObj(cf).amount);
          }
          const cat = o.accrued_category ?? asObj(o.accruals).accrued_category;
          if (typeof cat === "string") categories.add(cat);
        }
        pages += 1;
        // пагинация by-day: last_id из ответа, пусто → конец дня.
        const nextId =
          typeof root.last_id === "string" ? root.last_id
          : typeof result.last_id === "string" ? result.last_id
          : "";
        lastId = nextId;
        if (lastId === "" || items.length === 0) break;
        if (p === BY_DAY_MAX_PAGES_PER_DAY - 1 && lastId !== "") truncated = true;
      }
      daysQueried += 1;
    }
    methods.accrual_by_day = {
      endpoint: "/v1/finance/accrual/by-day",
      status,
      days: daysQueried,
      pages,
      records,
      sumTotalAmount: Math.round(sumTotalAmount * 100) / 100,
      containerFeesSum: containerFeesSeen ? Math.round(containerFeesSum * 100) / 100 : null,
      accruedCategories: Array.from(categories).sort(),
      schema,
      responseShape: bydayShape,
      truncated,
      error: lastErr,
    };
  } else {
    methods.accrual_by_day = skippedMethod("/v1/finance/accrual/by-day");
  }

  // ===================== 3) FBO /v3/posting/fbo/list (справочный) =====================
  if (!rateLimited) {
    let cursor = "";
    let pages = 0;
    let records = 0;
    let truncated = false;
    let status = 0;
    let schema: unknown = null;
    let lastErr = "ok";
    let fboShape: unknown = null; // безопасная форма первого 200-ответа FBO
    for (let p = 0; p < FBO_MAX_PAGES; p++) {
      const r = await ozonPost(
        `${SELLER}/v3/posting/fbo/list`,
        headers,
        { cursor, filter: { since: range.dateFrom, to: range.dateTo, statuses: ["delivered"] }, limit: POST_LIMIT, sort_dir: "ASC" },
        budget
      );
      status = r.status;
      lastErr = errCode(r);
      if (!r.ok) {
        noteRateLimit(r);
        break;
      }
      if (fboShape === null) fboShape = responseShape(r.json); // ДО парсинга, без значений
      const result = asObj(asObj(r.json).result);
      // v3 fbo: ответ может быть result.postings[] ИЛИ result[] — берём мягко.
      const items = result.postings !== undefined ? asArr(result.postings) : asArr(asObj(r.json).result);
      if (p === 0 && items.length > 0) schema = keySchema(items[0], 3);
      records += items.length;
      for (const it of items) {
        const pn = asObj(it).posting_number;
        if (typeof pn === "string" && postingNumbers.length < MAX_POSTING_NUMBERS) postingNumbers.push(pn);
      }
      pages += 1;
      const hasNext = result.has_next === true;
      cursor = typeof result.cursor === "string" ? result.cursor : "";
      if (!hasNext || cursor === "" || items.length === 0) break;
      if (p === FBO_MAX_PAGES - 1 && hasNext) truncated = true;
    }
    methods.fbo_v3 = { endpoint: "/v3/posting/fbo/list", status, pages, records, schema, responseShape: fboShape, truncated, error: lastErr };
  } else {
    methods.fbo_v3 = skippedMethod("/v3/posting/fbo/list");
  }

  // ===================== 4) FBS /v4/posting/fbs/list (справочный) =====================
  if (!rateLimited) {
    let cursor = "";
    let pages = 0;
    let records = 0;
    let truncated = false;
    let status = 0;
    let schema: unknown = null;
    let lastErr = "ok";
    let fbsShape: unknown = null; // безопасная форма первого 200-ответа FBS
    for (let p = 0; p < FBS_MAX_PAGES; p++) {
      const r = await ozonPost(
        `${SELLER}/v4/posting/fbs/list`,
        headers,
        { cursor, filter: { since: range.dateFrom, to: range.dateTo, statuses: ["delivered"] }, limit: POST_LIMIT, sort_dir: "ASC" },
        budget
      );
      status = r.status;
      lastErr = errCode(r);
      if (!r.ok) {
        noteRateLimit(r);
        break;
      }
      if (fbsShape === null) fbsShape = responseShape(r.json); // ДО парсинга, без значений
      const result = asObj(asObj(r.json).result);
      const items = asArr(result.postings);
      if (p === 0 && items.length > 0) schema = keySchema(items[0], 3);
      records += items.length;
      for (const it of items) {
        const pn = asObj(it).posting_number;
        if (typeof pn === "string" && postingNumbers.length < MAX_POSTING_NUMBERS) postingNumbers.push(pn);
      }
      pages += 1;
      const hasNext = result.has_next === true;
      cursor = typeof result.cursor === "string" ? result.cursor : "";
      if (!hasNext || cursor === "" || items.length === 0) break;
      if (p === FBS_MAX_PAGES - 1 && hasNext) truncated = true;
    }
    methods.fbs_v4 = { endpoint: "/v4/posting/fbs/list", status, pages, records, schema, responseShape: fbsShape, truncated, error: lastErr };
  } else {
    methods.fbs_v4 = skippedMethod("/v4/posting/fbs/list");
  }

  // ========= 5) accrual/postings — только после posting_numbers из FBO/FBS ===========
  if (rateLimited) {
    methods.accrual_postings = skippedMethod("/v1/finance/accrual/postings");
  } else if (postingNumbers.length > 0) {
    const batch = postingNumbers.slice(0, MAX_POSTING_NUMBERS);
    const r = await ozonPost(`${SELLER}/v1/finance/accrual/postings`, headers, { posting_numbers: batch }, budget);
    noteRateLimit(r);
    let records = 0;
    let schema: unknown = null;
    let postShape: unknown = null; // безопасная форма 200-ответа postings (метод реально вызван)
    const categories = new Set<string>();
    if (r.ok) {
      postShape = responseShape(r.json); // ДО парсинга, без значений
      const root = asObj(r.json);
      const items =
        asArr(root.result).length > 0 ? asArr(root.result)
        : asArr(root.postings).length > 0 ? asArr(root.postings)
        : asArr(asObj(root.result).postings);
      if (items.length > 0) schema = keySchema(items[0], 3);
      records = items.length;
      for (const it of items) {
        const cat = asObj(it).accrued_category;
        if (typeof cat === "string") categories.add(cat);
      }
    }
    methods.accrual_postings = {
      endpoint: "/v1/finance/accrual/postings",
      status: r.status,
      batches: 1,
      postingsQueried: batch.length,
      records,
      accruedCategories: Array.from(categories).sort(),
      schema,
      responseShape: postShape,
      error: errCode(r),
    };
  } else {
    methods.accrual_postings = {
      endpoint: "/v1/finance/accrual/postings",
      status: 0,
      batches: 0,
      postingsQueried: 0,
      records: 0,
      schema: null,
      error: "no_posting_numbers",
      note: "FBO/FBS не вернули отправлений за месяц — нечего запрашивать.",
    };
  }

  // ---- полны ли новые методы (нужно для gate legacy и честного truncated) ----
  const newApiLimitReached = budget.used >= NEW_API_MAX_REQUESTS;
  const NEW_METHOD_KEYS = ["accrual_types", "accrual_by_day", "fbo_v3", "fbs_v4", "accrual_postings"] as const;
  const newMethodsClean = NEW_METHOD_KEYS.every((k) => {
    const m = asObj(methods[k]);
    // Намеренный owner-пропуск справочника типов (already_collected) — НЕ незавершённость.
    if (m.skipped === true && m.reason !== "already_collected") return false;
    if (m.truncated === true) return false;
    const e = m.error;
    // "ok" и "no_posting_numbers" (нет отправлений) — не ошибки; остальное — незавершённость.
    return !(typeof e === "string" && e !== "ok" && e !== "no_posting_numbers");
  });
  const newApiComplete = !rateLimited && !newApiLimitReached && newMethodsClean;

  // ======= 6) СТАРЫЙ finance-агрегатор — ПОСЛЕДНИМ, только если new завершены =========
  // Переиспользуем существующий модуль без изменений: Σ amount по операциям.
  let legacy: Record<string, unknown> = {
    endpoint: "/v3/finance/transaction/list",
    status: null,
    skipped: true,
    reason: rateLimited ? "rate_limited" : "new_api_incomplete",
  };
  let oldTotal: number | null = null;
  let legacyRan = false;
  // legacy — только если новые данные полны (без 429/лимита/ошибки/обрезки). Его
  // страницы (≤LEGACY_MAX_REQUESTS) зарезервированы ВНЕ budget новых методов →
  // суммарный потолок доказуемо ≤150.
  if (newApiComplete) {
    legacyRan = true;
    const tx = await fetchOzonTransactions(clientId, apiKey, range);
    if (tx.ok) {
      let sum = 0;
      for (const op of tx.operations) sum += numOr0(op.amount);
      oldTotal = Math.round(sum * 100) / 100;
      legacy = {
        endpoint: "/v3/finance/transaction/list",
        status: 200,
        operations: tx.operations.length,
        pages: tx.pageCount,
        partial: tx.partial,
        sumAmount: oldTotal,
      };
    } else {
      legacy = { endpoint: "/v3/finance/transaction/list", status: null, error: tx.code };
    }
  }

  // ---- честная полнота: остановились ли раньше полного плана ----
  const anyMethodTruncated = Object.values(methods).some((m) => asObj(m).truncated === true);
  const anyMethodSkipped = Object.values(methods).some((m) => {
    const o = asObj(m);
    // already_collected — намеренный owner-пропуск types, НЕ признак обрезки плана.
    return o.skipped === true && o.reason !== "already_collected";
  });
  const anyMethodErrored = Object.values(methods).some((m) => {
    const e = asObj(m).error;
    // "rate_limited" помечает skipped-фазу (учтено выше), "no_posting_numbers" — не ошибка.
    return typeof e === "string" && e !== "ok" && e !== "no_posting_numbers" && e !== "rate_limited";
  });
  // truncated=true, если план не отработал полностью: 429 / budget / pagination cap /
  // deadline|timeout|прочая ошибка метода / пропущенные фазы.
  const truncated =
    rateLimited || newApiLimitReached || anyMethodTruncated || anyMethodSkipped || anyMethodErrored;

  // ---- сравнение old vs new (диагностика; НЕ утверждение об эквивалентности) ----
  const byDay = asObj(methods.accrual_by_day);
  const newTotal = typeof byDay.sumTotalAmount === "number" ? byDay.sumTotalAmount : null;
  const legacyObj = asObj(legacy);
  // delta считаем ТОЛЬКО когда и new, и legacy завершены полностью: без 429, без
  // общего лимита, без per-method error/truncated и без legacy.partial. Дополнительно
  // требуем !truncated — delta невозможна при любой частичности.
  const newComplete =
    !rateLimited && !newApiLimitReached && byDay.error === "ok" && byDay.truncated === false && newTotal !== null;
  const legacyComplete =
    legacyRan && legacyObj.status === 200 && legacyObj.partial === false && oldTotal !== null;
  const comparisonOk = newComplete && legacyComplete && !truncated;
  const comparison = {
    oldTotal,
    newTotal,
    delta:
      comparisonOk && newTotal !== null && oldTotal !== null
        ? Math.round((newTotal - oldTotal) * 100) / 100
        : null,
    ...(comparisonOk ? {} : { reason: "comparison_unavailable" as const }),
    note: comparisonOk
      ? "Сравнение сумм — только диагностика. НЕ означает эквивалентность классификации."
      : "Дельта не вычислена: new/legacy неполны (error/partial/truncated/лимит/429).",
  };

  // ---- наличие нужных полей (по извлечённым схемам, без значений) ----
  const schemaHasKey = (schema: unknown, keys: string[]): boolean => {
    const o = asObj(schema);
    return keys.some((k) => Object.prototype.hasOwnProperty.call(o, k));
  };
  const byDaySchema = asObj(methods.accrual_by_day).schema;
  const postingsSchema = asObj(methods.accrual_postings).schema;
  const fieldPresence = {
    amount_or_net: schemaHasKey(byDaySchema, ["total_amount", "amount", "net"]) || schemaHasKey(postingsSchema, ["amount", "total_amount"]),
    accrual_id: schemaHasKey(byDaySchema, ["accrual_id", "type_id"]) || schemaHasKey(postingsSchema, ["accrual_id", "type_id"]),
    accrued_category: schemaHasKey(byDaySchema, ["accrued_category"]) || schemaHasKey(postingsSchema, ["accrued_category"]),
    services: schemaHasKey(byDaySchema, ["services"]) || schemaHasKey(postingsSchema, ["services"]),
    commission: schemaHasKey(postingsSchema, ["sale_commission", "commission"]),
    logistics: schemaHasKey(postingsSchema, ["delivery_charge", "return_delivery_charge", "logistics"]),
    returns: schemaHasKey(postingsSchema, ["returns", "return"]) || schemaHasKey(byDaySchema, ["returns"]),
    posting_link: schemaHasKey(postingsSchema, ["posting_number", "posting"]),
    pagination_dedup_id: schemaHasKey(byDaySchema, ["last_id", "operation_id", "id"]) || schemaHasKey(postingsSchema, ["operation_id", "id"]),
    container_fees: schemaHasKey(byDaySchema, ["container_fees"]) || schemaHasKey(postingsSchema, ["container_fees"]),
  };
  // fieldPresence авторитетен ТОЛЬКО когда обе finance-схемы (by-day и postings)
  // реально получены без 429/лимита/обрезки. Иначе false в fieldPresence — НЕ
  // доказательство отсутствия полей (просто finance-метод не завершился).
  const byDayFin = asObj(methods.accrual_by_day);
  const postFin = asObj(methods.accrual_postings);
  const byDayFinOk = byDayFin.error === "ok" && byDayFin.truncated !== true && byDayFin.schema != null;
  const postFinOk = postFin.error === "ok" && postFin.schema != null;
  const fieldPresenceComplete = !rateLimited && !newApiLimitReached && byDayFinOk && postFinOk;

  return NextResponse.json(
    {
      ok: true,
      month,
      range: { since: range.dateFrom, to: range.dateTo },
      rateLimited,
      retryAfterSeconds,
      truncated,
      fieldPresenceComplete,
      newApiRequestsUsed: budget.used,
      ...(legacyRan ? { legacyRequestsMax: LEGACY_MAX_REQUESTS } : {}),
      totalRequestsUpperBound: budget.used + (legacyRan ? LEGACY_MAX_REQUESTS : 0),
      totalRequestLimit: TOTAL_MAX_REQUESTS,
      methods,
      legacy,
      comparison,
      fieldPresence,
      safety:
        "Диагностика ничего не сохраняет, не списывает расчёт и не изменяет прибыль. Идентификаторы (posting_number/operation_id/SKU/offer_id/названия) не возвращаются — только имена ключей, типы и агрегаты.",
    },
    { status: 200, headers: NO_STORE }
  );
}
