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
import { monthToRange, fetchOzonTransactions, aggregateDraft } from "../_lib/finance";

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
// ---- 429-ретрай (Retry-After, ограниченное число попыток, ограниченное время) ----
// До MAX_429_RETRIES_PER_CALL повторов ОДНОГО и того же запроса при 429. Срок
// ожидания — ВСЕГДА полный и неизменённый: реальный Retry-After Ozon (если
// прислан) или RETRY_DEFAULT_WAIT_MS. RETRY_WAIT_CAP_MS — НЕ потолок, до которого
// урезается ожидание, а порог «сколько мы вообще готовы ждать один retry»: если
// нужный срок БОЛЬШЕ RETRY_WAIT_CAP_MS (или не помещается в оставшийся
// budget.deadline), retry НЕ происходит вовсе — мы никогда не ждём МЕНЬШЕ, чем
// требуется, и никогда не выходим за budget.deadline (мягкий общий дедлайн
// диагностики не растягивается ретраями). Каждая попытка (успешная или нет)
// считается как реальный запрос и учитывается в budget.used — общий потолок
// ≤130/≤150 остаётся доказанным без изменений.
const MAX_429_RETRIES_PER_CALL = 2;
const RETRY_DEFAULT_WAIT_MS = 2000;
const RETRY_WAIT_CAP_MS = 10000;

type OzonHeaders = { "Client-Id": string; "Api-Key": string; "Content-Type": string };

// Состояние на ОДИН вызов POST (не глобальное — чтобы параллельные запросы разных
// пользователей не влияли друг на друга). used — счётчик реальных fetch; lastStart —
// таймстамп старта предыдущего реального запроса (для pacer); deadline — абсолютная
// точка, после которой новые запросы не стартуют.
type Budget = { used: number; lastStart: number; deadline: number };

type FetchOut =
  | { ok: true; status: number; json: unknown; retries?: number }
  | {
      ok: false;
      status: number;
      code: "invalid_key" | "forbidden" | "rate_limited" | "timeout" | "bad_response" | "unavailable" | "deadline";
      retryAfter?: number | null;
      /** Сколько РЕАЛЬНЫХ повторов 429 было сделано для этого логического запроса
       *  (0 — если retries не применялись/не понадобились). */
      retries?: number;
    };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- одна попытка POST к Ozon (никогда не бросает) ----
// Проходит через единый pacer/budget/deadline: параллельных запросов нет.
async function ozonPostOnce(
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

// ---- POST к Ozon с ограниченным ретраем на 429 (Retry-After, НЕ урезается) ----
// Один И ТОТ ЖЕ логический запрос повторяется до MAX_429_RETRIES_PER_CALL раз ТОЛЬКО
// при code:"rate_limited". waitMs — ПОЛНЫЙ, НЕИЗМЕНЁННЫЙ срок: реальный Retry-After
// Ozon (если прислан) или наш дефолт — НИКОГДА не урезается до RETRY_WAIT_CAP_MS.
// Ждём ЛИБО ВЕСЬ этот срок и повторяем, ЛИБО не ждём и не повторяем СОВСЕМ — если
// waitMs превышает RETRY_WAIT_CAP_MS (наш предел «сколько мы вообще готовы ждать
// один retry») ИЛИ оставшееся время до budget.deadline, сдаёмся сразу, БЕЗ раннего
// повтора с урезанным ожиданием. Ozon попросил конкретный срок — либо выдерживаем
// его полностью, либо не претворяемся, что выдержали: retry раньше срока (даже
// частично) почти наверняка снова упрётся в 429, впустую тратя бюджет запросов, а
// причина отказа (retryAfter) остаётся в возвращаемом FetchOut — вызывающий код
// показывает её как честную причину незавершённости этапа, не как повтор «на
// авось». Любая ДРУГАЯ ошибка (invalid_key/forbidden/timeout/…) не ретраится —
// только 429 индицирует «подождать и попробовать ещё раз». Каждая попытка (успех
// или нет) — реальный fetch, budget.used растёт как раньше.
async function ozonPost(
  url: string,
  headers: OzonHeaders,
  body: unknown,
  budget: Budget
): Promise<FetchOut> {
  let last: FetchOut = { ok: false, status: 0, code: "unavailable" };
  for (let attempt = 0; attempt <= MAX_429_RETRIES_PER_CALL; attempt++) {
    const r = await ozonPostOnce(url, headers, body, budget);
    if (r.ok || r.code !== "rate_limited") {
      return attempt > 0 ? { ...r, retries: attempt } : r;
    }
    last = { ...r, retries: attempt };
    if (attempt === MAX_429_RETRIES_PER_CALL) break; // повторы исчерпаны
    const waitMs =
      typeof r.retryAfter === "number" ? Math.max(0, r.retryAfter * 1000) : RETRY_DEFAULT_WAIT_MS;
    // Ozon просит ждать больше, чем мы вообще готовы ждать один retry — НЕ
    // урезаем до RETRY_WAIT_CAP_MS, просто не повторяем этот запрос.
    if (waitMs > RETRY_WAIT_CAP_MS) break;
    const remainingMs = budget.deadline - Date.now();
    // Полный (неурезанный) срок не помещается в оставшийся бюджет времени —
    // сдаёмся без попытки, а НЕ ждём меньше запрошенного.
    if (waitMs > remainingMs - 500) break;
    if (waitMs > 0) await sleep(waitMs);
    // waitMs===0 (Retry-After:0) → повторяем СРАЗУ, без sleep.
  }
  return last;
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

// ---- строгий парсер денежной строки новых accrual-методов ----
// ДОКАЗАНО (live): total_amount.amount приходит как decimal STRING. Принимаем finite
// number ИЛИ строгую десятичную строку (опц. знак, цифры, опц. дробная часть). НЕ
// parseFloat-prefix, без exponent, без "1,25"/"1abc"/пустой/"NaN"/"Infinity"/объектов.
// Возвращает number | null. Исходную строку НЕ возвращаем и НЕ логируем. numOr0 для
// прочих данных не расширяем.
const MONEY_RE = /^[+-]?\d+(\.\d+)?$/;
function parseMoneyAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || !MONEY_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

// accrual_id — идентификатор КОНКРЕТНОЙ ЗАПИСИ начисления (по одному on by-day
// record), НЕ идентификатор её ТИПА услуги. НЕ путать с type_id (см. ниже) —
// type_id классифицирует ВИД услуги/комиссии и сверяется со справочником
// /v1/finance/accrual/types; accrual_id этому справочнику не принадлежит и
// против него не сверяется. Принимаем только конечное целое в разумном
// диапазоне; иначе null (в агрегате — безопасный count).
function safeAccrualId(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1_000_000_000) return null;
  return v;
}

// ---- Evidence-классификатор верхнеуровневого accrual_id (value-free) ----
// Возвращает имя ВЗАИМОИСКЛЮЧАЮЩЕГО bucket. Классификация ПОЛНАЯ: любое значение попадает
// ровно в один bucket, поэтому сумма всех bucket-счётчиков == числу by-day records. Само
// значение ID наружу НЕ выходит — только имя bucket. Диапазоны не пересекаются.
// Бакеты описывают ТОЛЬКО форму значения (знак/ноль/положительное) — БЕЗ деления
// по «известному диапазону типов»: accrual_id не type_id и справочнику типов не
// подчиняется (см. doc-comment safeAccrualId выше).
function accrualIdBucket(v: unknown): string {
  if (v === undefined || v === null) return "missingOrNull";
  if (typeof v === "string") return "string";
  if (typeof v !== "number") return "otherType";
  if (!Number.isFinite(v) || !Number.isInteger(v)) return "numberNonFiniteOrFractional";
  if (v < 0) return "integerNegative";
  if (v === 0) return "integerZero";
  return "integerPositive";
}
const ACCRUAL_ID_BUCKET_KEYS = [
  "missingOrNull",
  "string",
  "otherType",
  "numberNonFiniteOrFractional",
  "integerNegative",
  "integerZero",
  "integerPositive",
] as const;
function emptyAccrualIdBuckets(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of ACCRUAL_ID_BUCKET_KEYS) o[k] = 0;
  return o;
}

// ---- Evidence-классификатор taxonomy type_id (value-free) ----
// type_id РАЗРЕШЕНО раскрывать ТОЛЬКО когда оно найдено в РЕАЛЬНО ПОЛУЧЕННОМ в
// ЭТОМ запуске справочнике /v1/finance/accrual/types (known — Set известных
// type_id ИЗ ЭТОГО справочника, не жёсткая граница 1..119: справочник растёт —
// сейчас, например, 124 позиции, а не 119). known===null — справочник в этом
// запуске не получен (skipTypes или сбой types) → доказать «известность» нечем,
// ни одно значение НЕ раскрывается (dictionaryUnavailable), только форма.
// known известен, но значения нет в нём → notInDictionary (может быть новый,
// ещё не задокументированный тип — тоже не раскрываем, только bucket).
// Классификация полная: сумма bucket-счётчиков == числу учтённых records источника.
function typeIdBucket(v: unknown, known: ReadonlySet<number> | null): string {
  if (v === undefined || v === null) return "missingOrNull";
  if (typeof v === "string") return "string";
  if (typeof v !== "number") return "otherType";
  if (!Number.isFinite(v) || !Number.isInteger(v)) return "numberNonFiniteOrFractional";
  if (known === null) return "dictionaryUnavailable";
  return known.has(v) ? "knownFromDictionary" : "notInDictionary";
}
const TYPE_ID_BUCKET_KEYS = [
  "missingOrNull",
  "string",
  "otherType",
  "numberNonFiniteOrFractional",
  "dictionaryUnavailable",
  "knownFromDictionary",
  "notInDictionary",
] as const;
function emptyTypeIdBuckets(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of TYPE_ID_BUCKET_KEYS) o[k] = 0;
  return o;
}
// known type_id → само значение ТОЛЬКО если оно есть в реально полученном
// справочнике этого запуска; иначе null (значение не раскрываем).
function knownTypeId(v: unknown, known: ReadonlySet<number> | null): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) return null;
  if (known === null) return null;
  return known.has(v) ? v : null;
}

// ---- Аккумулятор taxonomy-evidence по ОДНОМУ источнику (NON_ITEM by-day ИЛИ posting nested) ----
// records — знаменатель (сколько записей источника учтено); buckets — исчерпывающая
// классификация type_id; byType — агрегаты ТОЛЬКО по type_id из реально полученного
// в этом запуске справочника. Денежные суммы здесь — ТОЛЬКО classification evidence;
// в net-итог/comparison они НЕ входят.
type TaxonomyEvidence = {
  records: number;
  buckets: Record<string, number>;
  byType: Map<number, { records: number; parsed: number; unparsed: number; sum: number }>;
};
function newTaxonomyEvidence(): TaxonomyEvidence {
  return { records: 0, buckets: emptyTypeIdBuckets(), byType: new Map() };
}
function addTaxonomyEvidence(
  ev: TaxonomyEvidence,
  typeIdRaw: unknown,
  amountRaw: unknown,
  knownTypeIds: ReadonlySet<number> | null
): void {
  ev.records += 1;
  ev.buckets[typeIdBucket(typeIdRaw, knownTypeIds)] += 1;
  const id = knownTypeId(typeIdRaw, knownTypeIds);
  if (id === null) return; // не из справочника / справочник недоступен → только bucket
  let g = ev.byType.get(id);
  if (!g) {
    g = { records: 0, parsed: 0, unparsed: 0, sum: 0 };
    ev.byType.set(id, g);
  }
  g.records += 1;
  const amt = parseMoneyAmount(amountRaw); // строгий парсер (тот же, что для net)
  if (amt === null) g.unparsed += 1;
  else {
    g.parsed += 1;
    g.sum += amt;
  }
}
function finalizeTaxonomyEvidence(ev: TaxonomyEvidence): {
  records: number;
  typeIdEvidence: Record<string, number>;
  byTypeId: Array<{ type_id: number; records: number; parsedAmounts: number; unparsedAmounts: number; totalAmount: number | null }>;
} {
  const byTypeId = Array.from(ev.byType.entries())
    .map(([type_id, g]) => ({
      type_id,
      records: g.records,
      parsedAmounts: g.parsed,
      unparsedAmounts: g.unparsed,
      // totalAmount группы — ТОЛЬКО при полном парсинге (все amounts распознаны), иначе null.
      totalAmount: g.unparsed === 0 ? round2(g.sum) : null,
    }))
    .sort((a, b) => a.type_id - b.type_id);
  return { records: ev.records, typeIdEvidence: ev.buckets, byTypeId };
}

// ---- Safe path-навигация + product-кандидаты gross revenue (value-free) ----
// Идёт по цепочке ключей строго через объекты; любой отсутствующий/не-объектный
// уровень → undefined. Сырое значение наружу НЕ отдаётся — только парсится строгим
// parseMoneyAmount в агрегированную сумму.
function getByPath(root: unknown, keys: readonly string[]): unknown {
  let cur: unknown = root;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
// Доказанные (live deep-shape) product-level пути-кандидаты источника gross revenue.
// Внутри posting.products[] проверяем ТОЛЬКО эти денежные листья; сравнение с
// legacyRevenue — на стороне grossRevenueEvidence. Никаких SKU/offer_id/дат/сырых строк.
const GROSS_CANDIDATE_PATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["commission.sale_amount", ["commission", "sale_amount", "amount"]],
  ["commission.seller_price", ["commission", "seller_price", "amount"]],
  ["commission.sale_price", ["commission", "sale_price", "amount"]],
  ["commission.sale_commission", ["commission", "sale_commission", "amount"]],
  ["commission.commission", ["commission", "commission", "amount"]],
  ["commission.coinvestment", ["commission", "coinvestment", "amount"]],
  ["commission.bonus", ["commission", "bonus", "amount"]],
  ["delivery.total_accrued", ["delivery", "total_accrued", "amount"]],
];
type GrossCandAcc = { present: number; parsed: number; unparsed: number; sum: number };

// accrued_category → безопасная нормализация. Известные из live-ответа: ITEM/NON_ITEM/
// POSTING; всё прочее → "OTHER". Категория хранится как ЗНАЧЕНИЕ поля массива (НЕ ключ).
const KNOWN_ACCRUED_CATEGORIES = new Set(["ITEM", "NON_ITEM", "POSTING"]);
function normAccruedCategory(v: unknown): string {
  return typeof v === "string" && KNOWN_ACCRUED_CATEGORIES.has(v) ? v : "OTHER";
}

// Hard-cap диагностических агрегатов (защита от раздувания ответа).
const ACCRUAL_AGG_CAP = 200; // макс. групп accrual_id×category
const CAT_SCHEMA_CAP = 10; // макс. schema-семплов по accrued_category

// ---- безопасная ФОРМА ответа (ТОЛЬКО имена ключей + типы, БЕЗ значений) ----
// Тот же value-free принцип, что и keySchema, но с hard-limit на число узлов
// (защита от раздувания ответа). Захватывается ДО текущего парсинга, чтобы при
// HTTP 200 + records=0 стало видно, где реально лежит массив. Скаляр → только тип
// ("string"/"number"/"boolean"/…); null → "null"; пустой массив → "array";
// непустой массив → форма ПЕРВОГО элемента (ключи+типы). Значения НЕ раскрываются.
const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_NODES = 200;

// Маскирование ключей: Ozon может вернуть объект-карту, где идентификатор
// (posting_number/UUID/operation_id/числовой/hex ID) лежит в ИМЕНИ КЛЮЧА — тогда он
// утёк бы как динамическое имя, хотя значения и так скрыты. Поэтому показываем ТОЛЬКО
// «статические» имена полей: lowercase ASCII, первый символ [a-z_], далее [a-z0-9_],
// длина ≤64, не длинная hex-последовательность, не prototype-sensitive. Всё остальное
// (UUID/числовые/hex/произвольные ключи) → единый плейсхолдер SHAPE_DYNAMIC_KEY.
const SHAPE_DYNAMIC_KEY = "<dynamic_key>";
const SHAPE_FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function safeShapeKey(key: string): string {
  const looksStatic =
    /^[a-z_][a-z0-9_]{0,63}$/.test(key) &&
    !/^[0-9a-f]{8,}$/i.test(key) &&
    !SHAPE_FORBIDDEN_KEYS.has(key);
  return looksStatic ? key : SHAPE_DYNAMIC_KEY;
}

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
        const safeK = safeShapeKey(k);
        // Динамические (ID-подобные) ключи схлопываем в ОДНОГО представителя —
        // идентификаторы не перечисляются и узлы не раздуваются.
        if (safeK === SHAPE_DYNAMIC_KEY && Object.prototype.hasOwnProperty.call(out, SHAPE_DYNAMIC_KEY)) {
          continue;
        }
        out[safeK] = walk(val, depth - 1);
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

  // ---- body: month + skipTypes + legacyOnly (единственный вход; никаких ключей/user_id из body) ----
  let month = "2026-06";
  let skipTypes = false; // отсутствует → обратная совместимость (types вызывается)
  // legacyOnly=true — независимая read-only сверка БЕЗ повторной загрузки новых
  // методов: новые методы (types/by-day/FBO/FBS/accrual_postings) не вызываются
  // вовсе, legacy получает ВЕСЬ 40-секундный бюджет для себя одного (см. doc-
  // comment у блока 6 ниже — зачем это нужно и почему это МИНИМАЛЬНЫЙ способ,
  // а не архитектурное изменение).
  let legacyOnly = false;
  try {
    const body = (await req.json()) as { month?: unknown; skipTypes?: unknown; legacyOnly?: unknown };
    if (typeof body?.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) {
      month = body.month;
    }
    // skipTypes/legacyOnly строго boolean: присутствует и не boolean → 400 (безопасный код).
    if (body?.skipTypes !== undefined && typeof body.skipTypes !== "boolean") {
      return NextResponse.json(
        { error: "skipTypes должен быть boolean", code: "bad_skip_types" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (body?.legacyOnly !== undefined && typeof body.legacyOnly !== "boolean") {
      return NextResponse.json(
        { error: "legacyOnly должен быть boolean", code: "bad_legacy_only" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (typeof body?.skipTypes === "boolean") skipTypes = body.skipTypes;
    if (typeof body?.legacyOnly === "boolean") legacyOnly = body.legacyOnly;
  } catch {
    /* пустое/битое тело → дефолты: month=2026-06, skipTypes=false, legacyOnly=false */
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
  const postingNumbersSeen = new Set<string>(); // дедуп posting_number FBO+FBS (наружу не отдаём)

  // safe-код ошибки метода (без raw)
  const errCode = (r: FetchOut): string => (r.ok ? "ok" : r.code);
  // Фиксация 429: ставим rateLimited и (один раз) retryAfterSeconds — ТОЛЬКО для
  // (а) честного truncated/fieldPresenceComplete/comparisonOk и (б) гейта legacy
  // ниже. Каждая фаза САМА уже отретраила 429 внутри ozonPost (Retry-After,
  // ограниченное число попыток) прежде чем вернуть rate_limited сюда — поэтому
  // ОДНА фаза, упавшая по 429 после исчерпания ретраев, БОЛЬШЕ НЕ блокирует
  // следующие независимые фазы (по-прежнему успевшие/успешные данные не
  // перезапрашиваются и не отбрасываются).
  const noteRateLimit = (r: FetchOut) => {
    if (!r.ok && r.code === "rate_limited") {
      rateLimited = true;
      if (retryAfterSeconds === null && typeof r.retryAfter === "number") {
        retryAfterSeconds = r.retryAfter;
      }
    }
  };

  // ============== 1) accrual/types — ПЕРВЫЙ Ozon-запрос (finance-first), ==============
  // ============== ЕСЛИ владелец не пропустил (справочник типов уже собран). ===========
  // knownTypeIds — Set type_id ИЗ РЕАЛЬНО ПОЛУЧЕННОГО в этом запуске справочника;
  // null — справочник в этом запуске недоступен (skipTypes или сбой) → ниже ни
  // один type_id НЕ раскрывается как «известный» (см. typeIdBucket/knownTypeId).
  let knownTypeIds: Set<number> | null = null;
  const durationsMs: Record<string, number | null> = {
    types: null,
    byDay: null,
    fbo: null,
    fbs: null,
    accrualPostings: null,
    legacy: null,
  };
  if (legacyOnly) {
    // Независимая read-only сверка: новые методы НЕ вызываются вовсе — legacy
    // (блок 6) получает ВЕСЬ 40-секундный бюджет для себя одного. См. doc-
    // comment у блока 6 — почему это МИНИМАЛЬНЫЙ способ, не архитектурное решение.
    methods.accrual_types = {
      endpoint: "/v1/finance/accrual/types",
      status: 0,
      skipped: true,
      reason: "legacy_only_mode",
    };
  } else if (skipTypes) {
    // Явный owner-пропуск: types НЕ вызывается, budget не растёт, truncated
    // НЕ выставляется. Пропуск (reason already_collected) намеренный → не
    // считается незавершённостью плана. knownTypeIds остаётся null — в этом
    // запуске справочника нет, byTypeId-значения type_id не раскрываются.
    methods.accrual_types = {
      endpoint: "/v1/finance/accrual/types",
      status: 0,
      skipped: true,
      reason: "already_collected",
    };
  } else {
    const t0Types = Date.now();
    const r = await ozonPost(`${SELLER}/v1/finance/accrual/types`, headers, undefined, budget);
    noteRateLimit(r);
    let count = 0;
    let dictionary: Array<{ type_id: unknown; name: unknown; description: unknown }> = [];
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
      // Справочник типов — глобальная классификация (не персональные данные) →
      // показываем. Поле называем type_id (НЕ accrual_id — это разные сущности,
      // см. doc-comment safeAccrualId): это словарь ВИДОВ услуги/комиссии.
      dictionary = arr.slice(0, 300).map((t) => {
        const o = asObj(t);
        return {
          type_id: o.type_id ?? o.accrual_id ?? o.id ?? null,
          name: o.name ?? o.title ?? null,
          description: o.description ?? o.desc ?? null,
        };
      });
      // knownTypeIds строится из ЭТОГО же дерева (arr), а не из slice(0,300)-
      // урезанного dictionary — справочник не настолько большой, чтобы урезание
      // требовалось, но classification не должна зависеть от лимита показа.
      const ids = new Set<number>();
      for (const t of arr) {
        const o = asObj(t);
        const idRaw = o.type_id ?? o.accrual_id ?? o.id;
        if (typeof idRaw === "number" && Number.isInteger(idRaw) && Number.isFinite(idRaw)) {
          ids.add(idRaw);
        }
      }
      if (ids.size > 0) knownTypeIds = ids;
    }
    methods.accrual_types = { endpoint: "/v1/finance/accrual/types", status: r.status, count, dictionary, schema, error: errCode(r) };
    durationsMs.types = Date.now() - t0Types;
  }

  // ================= 2) accrual/by-day (finance-фаза, по дням месяца) =================
  // Гейта по rateLimited ПРЕДЫДУЩЕЙ фазы больше нет: by-day — независимый метод,
  // пробуем его в любом случае (собственный pacer/budget/deadline внутри ozonPost
  // остаются единственным ограничителем). Если 429 случится ЗДЕСЬ — это НЕ
  // блокирует последующие фазы (FBO/FBS/accrual_postings), только помечает
  // truncated и останавливает ДАЛЬНЕЙШИЕ дни этого месяца (уже полученные дни
  // сохраняются, не отбрасываются и не перезапрашиваются).
  if (legacyOnly) {
    methods.accrual_by_day = { endpoint: "/v1/finance/accrual/by-day", status: 0, skipped: true, reason: "legacy_only_mode" };
  } else {
    const t0ByDay = Date.now();
    const days = daysOfMonth(month);
    let daysQueried = 0;
    let pages = 0;
    let records = 0;
    let sumTotalAmount = 0;
    let containerFeesSum = 0;
    let containerFeesSeen = false;
    let truncated = false;
    let dayFetchFailed = false; // 429/timeout/ошибка ПОСЛЕ retry — не просто "лимит страниц"
    let status = 0;
    let schema: unknown = null;
    let lastErr = "ok";
    let bydayShape: unknown = null; // безопасная форма первого 200-ответа by-day
    let parsedAmounts = 0;
    let unparsedAmounts = 0;
    let aggTruncated = false;
    // агрегаты по (accrual_id, accrued_category) — evidence для taxonomy; без идентификаторов заказов.
    const aggMap = new Map<string, { accrual_id: number | null; accrued_category: string; records: number; parsed: number; unparsed: number; sum: number }>();
    // type-only schema-семпл по каждой accrued_category.
    const catSchemas = new Map<string, { records: number; schema: unknown }>();
    const categories = new Set<string>();
    // ---- evidence-аккумуляторы (value-free; в net-итог НЕ входят) ----
    const accrualIdBuckets = emptyAccrualIdBuckets(); // A: bucket-классы верхнеуровневого accrual_id
    const nonItemEvidence = newTaxonomyEvidence(); // B: taxonomy по non_item_fee.type_id
    let deepShapeItemFee: unknown = null; // D: форма item_fees.fees[0]
    let deepShapePostingProduct: unknown = null; // D: форма posting.products[0]
    let deepShapeContainerFee: unknown = null; // D: форма первого non-null container_fees
    const itemEvidence = newTaxonomyEvidence(); // 2: taxonomy по item_fees.fees[].type_id
    let grossProductRecords = 0; // 3: число просмотренных posting.products[]
    const grossCandAccs = new Map<string, GrossCandAcc>(); // 3: аккумуляторы кандидатов gross
    for (const [name] of GROSS_CANDIDATE_PATHS) grossCandAccs.set(name, { present: 0, parsed: 0, unparsed: 0, sum: 0 });
    for (const day of days) {
      // dayFetchFailed — своя (не чужой фазы) персистентная неудача уже была в
      // этом месяце → дальнейшие дни пробовать бессмысленно (see comment ниже).
      if (dayFetchFailed || Date.now() >= budget.deadline) break;
      let lastId = "";
      for (let p = 0; p < BY_DAY_MAX_PAGES_PER_DAY; p++) {
        const r = await ozonPost(`${SELLER}/v1/finance/accrual/by-day`, headers, { date: day, last_id: lastId }, budget);
        status = r.status;
        lastErr = errCode(r);
        if (!r.ok) {
          noteRateLimit(r);
          // Персистентная (после retry) неудача этого дня — весь месяц отдать
          // как «завершённый» уже нельзя: помечаем truncated честно, а не
          // молчаливым частичным итогом. Уже накопленные дни НЕ отбрасываются.
          dayFetchFailed = true;
          truncated = true;
          break;
        }
        // Безопасная форма первого 200-ответа — ДО парсинга (ключи+типы, без значений).
        if (bydayShape === null) bydayShape = responseShape(r.json);
        const root = asObj(r.json);
        const result = asObj(root.result);
        // ДОКАЗАНО (live shape авг-2026): by-day → root.accruals[]. Приоритет root.accruals,
        // затем прежние fallback-пути (обратная совместимость). Новых ключей не угадываем.
        const items =
          asArr(root.accruals).length > 0 ? asArr(root.accruals)
          : asArr(result.details).length > 0 ? asArr(result.details)
          : asArr(result.rows).length > 0 ? asArr(result.rows)
          : asArr(root.details).length > 0 ? asArr(root.details)
          : asArr(root.result);
        if (schema === null && items.length > 0) schema = keySchema(items[0], 3);
        records += items.length;
        for (const it of items) {
          const o = asObj(it);
          // ДОКАЗАНО: сумма записи = total_amount.amount (decimal STRING) — строгий парсер.
          const amt = parseMoneyAmount(asObj(o.total_amount).amount);
          if (amt === null) unparsedAmounts += 1;
          else {
            parsedAmounts += 1;
            sumTotalAmount += amt;
          }
          // container_fees — прежний справочный агрегат (путь не менялся).
          if (o.container_fees !== undefined) {
            containerFeesSeen = true;
            const cf = o.container_fees;
            if (typeof cf === "number") containerFeesSum += numOr0(cf);
            else containerFeesSum += numOr0(asObj(cf).amount);
          }
          const rawCat = o.accrued_category ?? asObj(o.accruals).accrued_category;
          if (typeof rawCat === "string") categories.add(rawCat);
          const cat = normAccruedCategory(rawCat);
          const aid = safeAccrualId(o.accrual_id);
          // агрегат по (accrual_id, category); accrual_id "null" при невалидном → безопасный count.
          const key = `${aid === null ? "null" : aid}|${cat}`;
          let agg = aggMap.get(key);
          if (!agg) {
            if (aggMap.size >= ACCRUAL_AGG_CAP) {
              aggTruncated = true;
            } else {
              agg = { accrual_id: aid, accrued_category: cat, records: 0, parsed: 0, unparsed: 0, sum: 0 };
              aggMap.set(key, agg);
            }
          }
          if (agg) {
            agg.records += 1;
            if (amt === null) agg.unparsed += 1;
            else {
              agg.parsed += 1;
              agg.sum += amt;
            }
          }
          // schema-семпл по категории (первый item категории, type-only, ≤ CAT_SCHEMA_CAP).
          if (!catSchemas.has(cat) && catSchemas.size < CAT_SCHEMA_CAP) {
            catSchemas.set(cat, { records: 0, schema: keySchema(o, 3) });
          }
          const cs = catSchemas.get(cat);
          if (cs) cs.records += 1;
          // ---- Evidence A: bucket верхнеуровневого accrual_id (ровно 1 на запись; значение не раскрываем) ----
          accrualIdBuckets[accrualIdBucket(o.accrual_id)] += 1;
          // ---- Evidence B: NON_ITEM taxonomy по доказанному пути non_item_fee.type_id + .accrued.amount ----
          if (cat === "NON_ITEM") {
            const nif = asObj(o.non_item_fee);
            addTaxonomyEvidence(nonItemEvidence, nif.type_id, asObj(nif.accrued).amount, knownTypeIds);
          }
          // ---- Evidence D: глубокие type-only формы (responseShape, без scalar-значений) ----
          if (deepShapeItemFee === null) {
            const fees = asArr(asObj(o.item_fees).fees);
            if (fees.length > 0) deepShapeItemFee = responseShape(fees[0]);
          }
          if (deepShapePostingProduct === null) {
            const products = asArr(asObj(o.posting).products);
            if (products.length > 0) deepShapePostingProduct = responseShape(products[0]);
          }
          if (deepShapeContainerFee === null && o.container_fees !== undefined && o.container_fees !== null) {
            deepShapeContainerFee = responseShape(o.container_fees);
          }
          // ---- Evidence 2: ITEM taxonomy по доказанному пути item_fees.fees[].fees[].type_id + .accrued.amount ----
          // Внешний item_fees.fees[] — SKU-группы; фактическая fee-запись лежит во
          // ВНУТРЕННЕМ .fees[]. type_id/accrued читаем ТОЛЬКО из внутренней записи;
          // sku внешней группы НЕ читаем/не сохраняем/не возвращаем. Счётчики
          // itemTaxonomy считают внутренние fee-записи, а не внешние SKU-группы.
          {
            const skuGroups = asArr(asObj(o.item_fees).fees);
            for (const g of skuGroups) {
              const innerFees = asArr(asObj(g).fees);
              for (const f of innerFees) {
                const fo = asObj(f);
                addTaxonomyEvidence(itemEvidence, fo.type_id, asObj(fo.accrued).amount, knownTypeIds);
              }
            }
          }
          // ---- Evidence 3: кандидаты gross revenue по доказанным posting.products[] путям ----
          {
            const products = asArr(asObj(o.posting).products);
            for (const prod of products) {
              const po = asObj(prod);
              grossProductRecords += 1;
              for (const [name, keys] of GROSS_CANDIDATE_PATHS) {
                const acc = grossCandAccs.get(name);
                if (!acc) continue;
                const leaf = getByPath(po, keys);
                if (leaf === undefined) continue; // missing = records − present
                acc.present += 1;
                const a = parseMoneyAmount(leaf);
                if (a === null) acc.unparsed += 1;
                else {
                  acc.parsed += 1;
                  acc.sum += a;
                }
              }
            }
          }
        }
        pages += 1;
        // пагинация by-day: last_id приоритетно из root.last_id (доказано), пусто → конец дня.
        const prevLastId = lastId;
        const nextId =
          typeof root.last_id === "string" ? root.last_id
          : typeof result.last_id === "string" ? result.last_id
          : "";
        lastId = nextId;
        // stop: пусто / не изменился (защита от зацикливания) / нет записей.
        if (nextId === "" || nextId === prevLastId || items.length === 0) break;
        if (p === BY_DAY_MAX_PAGES_PER_DAY - 1 && nextId !== "") truncated = true;
      }
      daysQueried += 1;
    }
    // Честно: если обработали МЕНЬШЕ дней, чем в месяце (дедлайн/бюджет оборвали
    // цикл до dayFetchFailed) — тоже truncated. sumTotalAmount ниже при
    // truncated=true всё равно может быть "complete по распознаванию", но это
    // НЕ то же самое, что "полный месяц" — comparison/gate ниже проверяют truncated отдельно.
    if (daysQueried < days.length) truncated = true;
    // Полнота парсинга денежных значений: сумму отдаём ТОЛЬКО если ВСЕ amounts распознаны.
    const byDayAmountComplete = unparsedAmounts === 0;
    const accrualAggregates = Array.from(aggMap.values())
      .map((a) => ({
        accrual_id: a.accrual_id,
        accrued_category: a.accrued_category,
        records: a.records,
        parsedAmounts: a.parsed,
        unparsedAmounts: a.unparsed,
        // totalAmount группы — только если ВСЕ её amounts распознаны, иначе null.
        totalAmount: a.unparsed === 0 ? round2(a.sum) : null,
      }))
      .sort((x, y) => {
        const ax = x.accrual_id === null ? Number.MAX_SAFE_INTEGER : x.accrual_id;
        const ay = y.accrual_id === null ? Number.MAX_SAFE_INTEGER : y.accrual_id;
        if (ax !== ay) return ax - ay;
        return x.accrued_category < y.accrued_category ? -1 : x.accrued_category > y.accrued_category ? 1 : 0;
      });
    const schemasByAccruedCategory = Array.from(catSchemas.entries())
      .map(([accrued_category, v]) => ({ accrued_category, records: v.records, schema: v.schema }))
      .sort((x, y) => (x.accrued_category < y.accrued_category ? -1 : x.accrued_category > y.accrued_category ? 1 : 0));
    // evidence-финализация (все суммы — только classification, вне net-итога)
    const nonItemTaxonomy = finalizeTaxonomyEvidence(nonItemEvidence);
    const itemTaxonomy = finalizeTaxonomyEvidence(itemEvidence);
    const grossCandidates: Record<string, unknown> = {};
    for (const [name] of GROSS_CANDIDATE_PATHS) {
      const acc = grossCandAccs.get(name) ?? { present: 0, parsed: 0, unparsed: 0, sum: 0 };
      // complete = у ВСЕХ product-записей путь присутствует и распознан.
      const complete = grossProductRecords > 0 && acc.present === grossProductRecords && acc.unparsed === 0;
      grossCandidates[name] = {
        records: grossProductRecords,
        present: acc.present,
        missing: grossProductRecords - acc.present,
        parsed: acc.parsed,
        unparsed: acc.unparsed,
        complete,
        // total — число ТОЛЬКО при complete; иначе null (любой missing/unparsed).
        total: complete ? round2(acc.sum) : null,
        // parsedPresentTotal — Σ распознанных present-значений (уже накопленный acc.sum);
        // число при parsed>0, иначе null. Позволяет сверить present-подмножество с
        // legacyRevenue даже при incomplete; НЕ меняет complete/total-семантику.
        parsedPresentTotal: acc.parsed > 0 ? round2(acc.sum) : null,
      };
    }
    methods.accrual_by_day = {
      endpoint: "/v1/finance/accrual/by-day",
      status,
      days: daysQueried,
      pages,
      records,
      // sumTotalAmount — ТОЛЬКО когда И все суммы распознаны (byDayAmountComplete),
      // И месяц реально пройден целиком (!truncated) — иначе это была бы сумма
      // ЧАСТИ месяца, выданная за итог всего месяца (провал → не подтверждённый
      // «полный» результат).
      sumTotalAmount: byDayAmountComplete && !truncated ? round2(sumTotalAmount) : null,
      // complete — ТОЛЬКО про распознавание уже полученных сумм; за полноту
      // ФЕТЧА месяца отвечает соседнее поле truncated (см. sumTotalAmount выше).
      amountParsing: { totalRecords: records, parsed: parsedAmounts, unparsed: unparsedAmounts, complete: byDayAmountComplete },
      accrualAggregates,
      accrualAggregatesTruncated: aggTruncated,
      schemasByAccruedCategory,
      // A: исчерпывающие bucket-классы верхнеуровневого accrual_id (Σ == records; значения ID не раскрыты).
      accrualIdEvidence: accrualIdBuckets,
      // B: NON_ITEM taxonomy по non_item_fee.type_id (+ .accrued.amount как classification-сумма).
      nonItemTaxonomy: {
        records: nonItemTaxonomy.records,
        typeIdEvidence: nonItemTaxonomy.typeIdEvidence,
        byTypeId: nonItemTaxonomy.byTypeId,
      },
      // D: глубокие type-only формы (без scalar-значений; отсутствуют → null).
      deepShapes: {
        item_fees_fee: deepShapeItemFee,
        posting_product: deepShapePostingProduct,
        container_fees: deepShapeContainerFee,
      },
      // 2: ITEM taxonomy по item_fees.fees[].type_id (type_id наружу только из
      // реально полученного в ЭТОМ запуске справочника /v1/finance/accrual/types).
      itemTaxonomy: {
        records: itemTaxonomy.records,
        typeIdEvidence: itemTaxonomy.typeIdEvidence,
        byTypeId: itemTaxonomy.byTypeId,
      },
      // 3: кандидаты gross revenue из posting.products[] (только агрегаты; без сырых значений).
      grossCandidates,
      containerFeesSum: containerFeesSeen ? round2(containerFeesSum) : null,
      accruedCategories: Array.from(categories).sort(),
      schema,
      responseShape: bydayShape,
      truncated,
      error: lastErr,
    };
    durationsMs.byDay = Date.now() - t0ByDay;
  }

  // ===================== 3) FBO /v3/posting/fbo/list (справочный) =====================
  // Независимая фаза — пробуем даже если предыдущая (by-day) уже отметила
  // rateLimited после исчерпания собственных ретраев.
  if (legacyOnly) {
    methods.fbo_v3 = { endpoint: "/v3/posting/fbo/list", status: 0, skipped: true, reason: "legacy_only_mode" };
  } else {
    const t0Fbo = Date.now();
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
      const root = asObj(r.json);
      const result = asObj(root.result);
      // ДОКАЗАНО (live): FBO v3 → root.postings[] + top-level root.has_next/root.cursor.
      // Приоритет root, затем прежние fallback (result.postings / result[]).
      const items =
        asArr(root.postings).length > 0 ? asArr(root.postings)
        : result.postings !== undefined ? asArr(result.postings)
        : asArr(root.result);
      if (p === 0 && items.length > 0) schema = keySchema(items[0], 3);
      records += items.length;
      for (const it of items) {
        const pn = asObj(it).posting_number;
        // posting_number ТОЛЬКО внутренне (для /accrual/postings), с дедупом, наружу не отдаём.
        if (typeof pn === "string" && !postingNumbersSeen.has(pn) && postingNumbers.length < MAX_POSTING_NUMBERS) {
          postingNumbersSeen.add(pn);
          postingNumbers.push(pn);
        }
      }
      pages += 1;
      const prevCursor = cursor;
      const hasNext = typeof root.has_next === "boolean" ? root.has_next : result.has_next === true;
      const nextCursor =
        typeof root.cursor === "string" ? root.cursor
        : typeof result.cursor === "string" ? result.cursor
        : "";
      cursor = nextCursor;
      // stop: !has_next / пустой cursor / cursor не изменился (анти-loop) / нет записей.
      if (!hasNext || nextCursor === "" || nextCursor === prevCursor || items.length === 0) break;
      if (p === FBO_MAX_PAGES - 1 && hasNext) truncated = true;
    }
    methods.fbo_v3 = { endpoint: "/v3/posting/fbo/list", status, pages, records, schema, responseShape: fboShape, truncated, error: lastErr };
    durationsMs.fbo = Date.now() - t0Fbo;
  }

  // ===================== 4) FBS /v4/posting/fbs/list (справочный) =====================
  // Независимая фаза — пробуем даже если ранее уже была отметка rateLimited.
  if (legacyOnly) {
    methods.fbs_v4 = { endpoint: "/v4/posting/fbs/list", status: 0, skipped: true, reason: "legacy_only_mode" };
  } else {
    const t0Fbs = Date.now();
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
      const root = asObj(r.json);
      const result = asObj(root.result);
      // ДОКАЗАНО (live): FBS v4 → root.postings[] + top-level root.has_next/root.cursor.
      const items = asArr(root.postings).length > 0 ? asArr(root.postings) : asArr(result.postings);
      if (p === 0 && items.length > 0) schema = keySchema(items[0], 3);
      records += items.length;
      for (const it of items) {
        const pn = asObj(it).posting_number;
        // posting_number ТОЛЬКО внутренне, дедуп общий с FBO, наружу не отдаём.
        if (typeof pn === "string" && !postingNumbersSeen.has(pn) && postingNumbers.length < MAX_POSTING_NUMBERS) {
          postingNumbersSeen.add(pn);
          postingNumbers.push(pn);
        }
      }
      pages += 1;
      const prevCursor = cursor;
      const hasNext = typeof root.has_next === "boolean" ? root.has_next : result.has_next === true;
      const nextCursor =
        typeof root.cursor === "string" ? root.cursor
        : typeof result.cursor === "string" ? result.cursor
        : "";
      cursor = nextCursor;
      // stop: !has_next / пустой cursor / cursor не изменился (анти-loop) / нет записей.
      if (!hasNext || nextCursor === "" || nextCursor === prevCursor || items.length === 0) break;
      if (p === FBS_MAX_PAGES - 1 && hasNext) truncated = true;
    }
    methods.fbs_v4 = { endpoint: "/v4/posting/fbs/list", status, pages, records, schema, responseShape: fbsShape, truncated, error: lastErr };
    durationsMs.fbs = Date.now() - t0Fbs;
  }

  // ========= 5) accrual/postings — только после posting_numbers из FBO/FBS ===========
  // Независимая фаза — пробуем даже если ранее уже была отметка rateLimited
  // (собственный ozonPost() уже отретраил 429 внутри себя с учётом Retry-After).
  const t0AccrualPostings = Date.now();
  if (postingNumbers.length > 0) {
    const batch = postingNumbers.slice(0, MAX_POSTING_NUMBERS);
    const r = await ozonPost(`${SELLER}/v1/finance/accrual/postings`, headers, { posting_numbers: batch }, budget);
    noteRateLimit(r);
    let records = 0;
    let schema: unknown = null;
    let postShape: unknown = null; // безопасная форма 200-ответа postings (метод реально вызван)
    let postingGroups = 0;
    let groupsWithAccruals = 0;
    let postingLinkedRecords = 0;
    const categories = new Set<string>();
    const postCatSchemas = new Map<string, { records: number; schema: unknown }>();
    // C: taxonomy-evidence по доказанному пути posting_accruals[].accruals[].type_id (value-free суммы).
    const postingEvidence = newTaxonomyEvidence();
    // 4: grand-total nested accrued.amount (ВСЕ nested records, без фильтра типа) для gross-эвиденса.
    let postAccSum = 0;
    let postAccParsed = 0;
    let postAccUnparsed = 0;
    if (r.ok) {
      postShape = responseShape(r.json); // ДО парсинга, без значений
      const root = asObj(r.json);
      // ДОКАЗАНО (live responseShape): root.posting_accruals[]; внутри группы group.accruals[].
      const groups = asArr(root.posting_accruals);
      if (groups.length > 0) {
        postingGroups = groups.length;
        for (const g of groups) {
          const grp = asObj(g);
          const nested = asArr(grp.accruals);
          if (nested.length > 0) groupsWithAccruals += 1;
          // связь доказывается ВНЕШНЕЙ структурой: непустой string posting_number группы.
          // Само значение posting_number наружу НЕ выходит — только boolean-учёт.
          const linked = typeof grp.posting_number === "string" && grp.posting_number.length > 0;
          for (const it of nested) {
            const o = asObj(it);
            if (schema === null) schema = keySchema(o, 3); // первый реальный nested accrual (type-only)
            records += 1;
            // C: taxonomy-evidence по nested type_id + .accrued.amount (доказанный путь; в net не входит).
            addTaxonomyEvidence(postingEvidence, o.type_id, asObj(o.accrued).amount, knownTypeIds);
            // 4: grand-total accrued (все типы) — только evidence, в net/comparison не входит.
            {
              const pa = parseMoneyAmount(asObj(o.accrued).amount);
              if (pa === null) postAccUnparsed += 1;
              else {
                postAccParsed += 1;
                postAccSum += pa;
              }
            }
            if (linked) postingLinkedRecords += 1;
            const rawCat = o.accrued_category;
            if (typeof rawCat === "string") categories.add(rawCat);
            const cat = normAccruedCategory(rawCat);
            if (!postCatSchemas.has(cat) && postCatSchemas.size < CAT_SCHEMA_CAP) {
              postCatSchemas.set(cat, { records: 0, schema: keySchema(o, 3) });
            }
            const cs = postCatSchemas.get(cat);
            if (cs) cs.records += 1;
          }
        }
      } else {
        // Доказанного root wrapper нет → прежние fallback-пути без регрессии и без угадывания.
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
    }
    const postingTaxonomy = finalizeTaxonomyEvidence(postingEvidence);
    // r.ok===false (429/timeout/…, после исчерпания ретраев) → НИЧЕГО ниже не
    // было реально получено. records/postAcc*/postingTaxonomy все остались на
    // своих инициализирующих значениях (0/пусто) — но это НЕ «подтверждённый
    // ноль», а «неизвестно», поэтому available:false + total/complete не
    // изображают завершённость. Без этой развилки total получался бы round2(0)=0
    // и complete=true даже при полном провале запроса — ложный «подтверждённый ноль».
    methods.accrual_postings = {
      endpoint: "/v1/finance/accrual/postings",
      status: r.status,
      batches: 1,
      postingsQueried: batch.length,
      postingGroups,
      groupsWithAccruals,
      records,
      postingLinkedRecords,
      // C: taxonomy по posting_accruals[].accruals[].type_id (Σ buckets == учтённые nested records).
      postingTaxonomy: {
        available: r.ok,
        records: postingTaxonomy.records,
        typeIdEvidence: postingTaxonomy.typeIdEvidence,
        byTypeId: postingTaxonomy.byTypeId,
      },
      // 4: grand-total nested accrued.amount (все типы) + полнота; в net не входит.
      nestedAccruedTotal: r.ok
        ? {
            available: true,
            records,
            parsed: postAccParsed,
            unparsed: postAccUnparsed,
            total: postAccUnparsed === 0 ? round2(postAccSum) : null,
            complete: postAccUnparsed === 0,
          }
        : { available: false, records: 0, parsed: 0, unparsed: 0, total: null, complete: false },
      accruedCategories: Array.from(categories).sort(),
      schemasByAccruedCategory: Array.from(postCatSchemas.entries())
        .map(([accrued_category, v]) => ({ accrued_category, records: v.records, schema: v.schema }))
        .sort((x, y) => (x.accrued_category < y.accrued_category ? -1 : x.accrued_category > y.accrued_category ? 1 : 0)),
      schema,
      responseShape: postShape,
      error: errCode(r),
    };
    durationsMs.accrualPostings = Date.now() - t0AccrualPostings;
  } else {
    methods.accrual_postings = legacyOnly
      ? { endpoint: "/v1/finance/accrual/postings", status: 0, skipped: true, reason: "legacy_only_mode" }
      : {
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
  // Переиспользуем существующий модуль, формула/пагинация/агрегация НЕ МЕНЯЮТСЯ —
  // добавлен ТОЛЬКО опциональный 4-й параметр deadlineMs (finance.ts, backward-
  // compatible: save-calculation/import-missing-products/postings-match-diagnostic
  // его не передают — их поведение byte-for-byte прежнее).
  //
  // ИТОГОВЫЙ КОНТРАКТ ДЕДЛАЙНА (без противоречия «общий, но legacy не входит»):
  // DIAG_DEADLINE_MS=40000 — ОДИН budget.deadline на ВЕСЬ запрос диагностики,
  // включая legacy. «Legacy не входит в budget новых методов» касалось ТОЛЬКО
  // ЛИМИТА ЗАПРОСОВ (LEGACY_MAX_REQUESTS=20 зарезервированы ОТДЕЛЬНО от
  // NEW_API_MAX_REQUESTS=130, потолок ≤150 — см. константы вверху файла), а НЕ
  // временного дедлайна: budget.deadline (время) — один и тот же для всех фаз,
  // просто legacy передаёт его В finance.ts явно (deadlineMs), а не через
  // разделяемый Budget-объект (тот привязан к pacer/budget.used новых методов,
  // которых у legacy нет — там свой TIMEOUT_MS/страница и MAX_PAGES=20).
  // Итог: 1 дедлайн по ВРЕМЕНИ на всю диагностику; 2 РАЗНЫХ лимита по ЧИСЛУ
  // запросов (новые методы vs legacy), зарезервированных не пересекаясь.
  //
  // К моменту, когда доходит очередь до legacy, строгий pacer новых методов
  // (особенно by-day — 1 запрос на КАЖДЫЙ день месяца) уже мог израсходовать
  // почти весь бюджет — см. budgetRemainingMsAtLegacyStart ниже (РЕАЛЬНО
  // измеренный остаток, не оценка). Если новые методы НЕ помещаются в общий
  // бюджет перед legacy, минимальный read-only способ сверки БЕЗ повторной
  // загрузки уже успешных этапов — legacyOnly:true (см. парсинг body выше):
  // пропускает все 5 новых методов, legacy получает ВЕСЬ 40-секундный бюджет
  // для себя одного, отдельным запросом. Слепое увеличение DIAG_DEADLINE_MS
  // здесь НЕ делается: это НЕ решает проблему (просто отодвигает тот же
  // конфликт дальше) и НЕ обосновано данными о реальном внешнем таймауте
  // (см. PR #87 — Timeweb не подтверждён логами).
  let legacy: Record<string, unknown> = {
    endpoint: "/v3/finance/transaction/list",
    status: null,
    skipped: true,
    reason: rateLimited ? "rate_limited" : "new_api_incomplete",
  };
  let oldTotal: number | null = null;
  let legacyRan = false;
  let budgetRemainingMsAtLegacyStart: number | null = null;
  // legacy — если новые данные полны (без 429/лимита/ошибки/обрезки) ИЛИ явно
  // запрошен независимый режим legacyOnly. Страницы (≤LEGACY_MAX_REQUESTS)
  // зарезервированы ВНЕ budget новых методов → суммарный потолок ≤150 (как раньше).
  if (newApiComplete || legacyOnly) {
    legacyRan = true;
    budgetRemainingMsAtLegacyStart = budget.deadline - Date.now();
    const t0Legacy = Date.now();
    // ЕДИНЫЙ дедлайн диагностики передан явно: budget.deadline уже прошёл →
    // fetchPage(page=1) вернёт code:"deadline" НЕМЕДЛЕННО, без единого fetch()
    // (требование 1 — «если бюджет исчерпан до вызова, не отправляй запрос»).
    // Если наступит ВО ВРЕМЯ уже идущей страницы — тот же AbortController,
    // что и обычный TIMEOUT_MS, реально прерывает fetch (требование 2 —
    // подтверждённая отмена, не Promise.race без реальной остановки).
    const tx = await fetchOzonTransactions(clientId, apiKey, range, budget.deadline);
    durationsMs.legacy = Date.now() - t0Legacy;
    if (tx.ok) {
      let sum = 0;
      for (const op of tx.operations) sum += numOr0(op.amount);
      oldTotal = Math.round(sum * 100) / 100;
      // 1: breakdown ТЕМ ЖЕ aggregateDraft, что и основной расчёт (формулы не дублируем).
      // Только итоговые числовые бакеты OzonDraftTotals + net-reconciliation; сырые
      // operations НЕ отдаём. Инвариант finance.ts: revenue+commission+logistics+
      // services+storage+ads+adjustments+other === Σ amount (== sumAmount).
      const t = aggregateDraft(tx.operations, tx.partial).totals;
      const netReconciliation = round2(
        t.revenue + t.commission + t.logistics + t.services + t.storage + t.ads + t.adjustments + t.other
      );
      legacy = {
        endpoint: "/v3/finance/transaction/list",
        status: 200,
        operations: tx.operations.length,
        pages: tx.pageCount,
        partial: tx.partial,
        sumAmount: oldTotal,
        durationMs: durationsMs.legacy,
        budgetRemainingMsAtLegacyStart,
        breakdown: {
          revenue: t.revenue,
          commission: t.commission,
          logistics: t.logistics,
          logisticsLegacy: t.logisticsLegacy,
          logisticsServices: t.logisticsServices,
          services: t.services,
          storage: t.storage,
          ads: t.ads,
          adjustments: t.adjustments,
          other: t.other,
          operationCount: t.operationCount,
          netReconciliation,
          reconciles: round2(netReconciliation - oldTotal) === 0,
        },
      };
    } else {
      // Различаем причину, а не сваливаем всё в одно "unavailable":
      //   • budget_exhausted — сработал ЕДИНЫЙ дедлайн диагностики (deadlineMs,
      //     переданный явно в fetchOzonTransactions выше) — ЛИБО он уже прошёл
      //     ДО старта legacy (запрос не отправлялся вовсе — требование 1), ЛИБО
      //     наступил ВО ВРЕМЯ уже идущей страницы (реально прерванной тем же
      //     AbortController, что и обычный таймаут — требование 2). Это ТЕПЕРЬ
      //     доказанная, а не предполагаемая причина: finance.ts возвращает
      //     "deadline" ТОЛЬКО когда сам его различил (см. doc-comment fetchPage).
      //   • request_timeout — finance.ts СВОЙ AbortController (20с/страница)
      //     сработал ПЕРВЫМ (deadlineMs ещё не наступил) — НЕ бюджет диагностики;
      //   • ozon_http_error — реальный HTTP-ответ получен (сеть дошла), status —
      //     ФАКТИЧЕСКИЙ код (401/403/429/5xx/…), а не подтверждённый null;
      //   • rate_limited — Ozon вернул 429 (finance.ts НЕ ретраит legacy сам —
      //     отдельно от ozonPost-ретрая новых методов, это тоже чужой модуль);
      //   • network_error — fetch бросил исключение, которое НЕ AbortError (DNS/
      //     соединение оборвано/TLS/и т.п.) — ответа не было вообще.
      const errorKind: string =
        tx.code === "deadline" ? "budget_exhausted"
        : tx.code === "timeout" ? "request_timeout"
        : tx.code === "rate_limited" ? "rate_limited"
        : typeof tx.status === "number" ? "ozon_http_error"
        : "network_error";
      legacy = {
        endpoint: "/v3/finance/transaction/list",
        status: typeof tx.status === "number" ? tx.status : null,
        error: tx.code,
        errorKind,
        durationMs: durationsMs.legacy,
        budgetRemainingMsAtLegacyStart,
      };
    }
  }

  // ---- честная полнота: остановились ли раньше полного плана ----
  const anyMethodTruncated = Object.values(methods).some((m) => asObj(m).truncated === true);
  const anyMethodSkipped = Object.values(methods).some((m) => {
    const o = asObj(m);
    // already_collected (owner: справочник уже собран) и legacy_only_mode
    // (owner: независимая сверка БЕЗ новых методов) — намеренные пропуски,
    // НЕ признак обрезки плана.
    return o.skipped === true && o.reason !== "already_collected" && o.reason !== "legacy_only_mode";
  });
  const anyMethodErrored = Object.values(methods).some((m) => {
    const e = asObj(m).error;
    // "rate_limited" помечает skipped-фазу (учтено выше), "no_posting_numbers" — не ошибка.
    return typeof e === "string" && e !== "ok" && e !== "no_posting_numbers" && e !== "rate_limited";
  });
  const legacyObj = asObj(legacy);
  const legacyComplete =
    legacyRan && legacyObj.status === 200 && legacyObj.partial === false && oldTotal !== null;
  // legacy запускался, но НЕ завершился — сравнение не состоялось, даже если
  // сбор новых данных прошёл идеально (rateLimited=false, все методы truncated=false).
  // Раньше это НЕ попадало в truncated (legacy не входит в `methods`) — общий
  // статус мог честно показывать truncated:false при незавершённом сравнении.
  const legacyFailed = legacyRan && !legacyComplete;
  // truncated=true, если план не отработал полностью: 429 / budget / pagination cap /
  // deadline|timeout|прочая ошибка метода / пропущенные фазы / провал legacy.
  const truncated =
    rateLimited || newApiLimitReached || anyMethodTruncated || anyMethodSkipped || anyMethodErrored || legacyFailed;

  // ---- сравнение old vs new (диагностика; НЕ утверждение об эквивалентности) ----
  const byDay = asObj(methods.accrual_by_day);
  const newTotal = typeof byDay.sumTotalAmount === "number" ? byDay.sumTotalAmount : null;
  // delta считаем ТОЛЬКО когда и new, и legacy завершены полностью: без 429, без
  // общего лимита, без per-method error/truncated и без legacy.partial. Дополнительно
  // требуем !truncated — delta невозможна при любой частичности.
  // newComplete требует, чтобы ВСЕ by-day amounts были распознаны (byDayAmountComplete).
  const byDayAmt = asObj(byDay.amountParsing);
  const newComplete =
    !rateLimited && !newApiLimitReached && byDay.error === "ok" && byDay.truncated === false && byDayAmt.complete === true && newTotal !== null;
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
  // posting_link доказывается ВНЕШНЕЙ структурой posting_accruals[].posting_number →
  // .accruals[], а НЕ поиском posting_number внутри nested accrual item.
  const postLinked = asObj(methods.accrual_postings).postingLinkedRecords;
  const postingLink = typeof postLinked === "number" && postLinked > 0;
  const fieldPresence = {
    amount_or_net: schemaHasKey(byDaySchema, ["total_amount", "amount", "net"]) || schemaHasKey(postingsSchema, ["amount", "total_amount"]),
    accrual_id: schemaHasKey(byDaySchema, ["accrual_id", "type_id"]) || schemaHasKey(postingsSchema, ["accrual_id", "type_id"]),
    accrued_category: schemaHasKey(byDaySchema, ["accrued_category"]) || schemaHasKey(postingsSchema, ["accrued_category"]),
    services: schemaHasKey(byDaySchema, ["services"]) || schemaHasKey(postingsSchema, ["services"]),
    commission: schemaHasKey(postingsSchema, ["sale_commission", "commission"]),
    logistics: schemaHasKey(postingsSchema, ["delivery_charge", "return_delivery_charge", "logistics"]),
    returns: schemaHasKey(postingsSchema, ["returns", "return"]) || schemaHasKey(byDaySchema, ["returns"]),
    posting_link: postingLink,
    pagination_dedup_id: schemaHasKey(byDaySchema, ["last_id", "operation_id", "id"]) || schemaHasKey(postingsSchema, ["operation_id", "id"]),
    container_fees: schemaHasKey(byDaySchema, ["container_fees"]) || schemaHasKey(postingsSchema, ["container_fees"]),
  };
  // fieldPresence авторитетен ТОЛЬКО когда обе finance-схемы (by-day и postings)
  // реально получены без 429/лимита/обрезки. Иначе false в fieldPresence — НЕ
  // доказательство отсутствия полей (просто finance-метод не завершился).
  const byDayFin = asObj(methods.accrual_by_day);
  const postFin = asObj(methods.accrual_postings);
  const byDayAmtOk = asObj(byDayFin.amountParsing).complete === true;
  const byDayFinOk = byDayFin.error === "ok" && byDayFin.truncated !== true && byDayFin.schema != null && byDayAmtOk;
  const postFinOk = postFin.error === "ok" && postFin.schema != null;
  const fieldPresenceComplete = !rateLimited && !newApiLimitReached && byDayFinOk && postFinOk;

  // ---- gross revenue evidence: сводит legacyRevenue, by-day net truth, nested accrued и
  //      product-кандидаты. ТОЛЬКО числа и дельты; какой кандидат = gross, НЕ утверждаем.
  //      Ничего не хардкодим. В net/comparison/profit НЕ участвует. ----
  const byDayForGross = asObj(methods.accrual_by_day);
  const postForGross = asObj(methods.accrual_postings);
  const legacyBreakdown = asObj(asObj(legacy).breakdown);
  const legacyRevenue = typeof legacyBreakdown.revenue === "number" ? legacyBreakdown.revenue : null;
  // postingNetTotal := by-day sumTotalAmount — ЕДИНСТВЕННЫЙ доказанный new net truth
  // (nested amounts уже внутри него; здесь для net повторно НЕ вычитаются).
  const postingNetTotal = typeof byDayForGross.sumTotalAmount === "number" ? byDayForGross.sumTotalAmount : null;
  const nestedAccObj = asObj(postForGross.nestedAccruedTotal);
  const nestedPostingAccruedTotal = {
    total: typeof nestedAccObj.total === "number" ? nestedAccObj.total : null,
    records: typeof nestedAccObj.records === "number" ? nestedAccObj.records : 0,
    parsed: typeof nestedAccObj.parsed === "number" ? nestedAccObj.parsed : 0,
    unparsed: typeof nestedAccObj.unparsed === "number" ? nestedAccObj.unparsed : 0,
    complete: nestedAccObj.complete === true,
  };
  const postingNetMinusNestedAccrued =
    postingNetTotal !== null && nestedPostingAccruedTotal.total !== null && nestedPostingAccruedTotal.complete
      ? round2(postingNetTotal - nestedPostingAccruedTotal.total)
      : null;
  const productCandidates: Record<string, unknown> = {};
  for (const [name, cand] of Object.entries(asObj(byDayForGross.grossCandidates))) {
    const c = asObj(cand);
    const complete = c.complete === true;
    const total = typeof c.total === "number" ? c.total : null;
    const parsedPresentTotal = typeof c.parsedPresentTotal === "number" ? c.parsedPresentTotal : null;
    productCandidates[name] = {
      ...c,
      // дельта к legacyRevenue — ТОЛЬКО для полного кандидата при известном legacyRevenue.
      deltaToLegacyRevenue:
        complete && total !== null && legacyRevenue !== null ? round2(total - legacyRevenue) : null,
      // дельта present-подмножества к legacyRevenue — при известном parsedPresentTotal и
      // legacyRevenue (incomplete допустим). Только число; кандидат выручкой НЕ объявляется.
      parsedPresentDeltaToLegacyRevenue:
        parsedPresentTotal !== null && legacyRevenue !== null ? round2(parsedPresentTotal - legacyRevenue) : null,
    };
  }
  const grossRevenueEvidence = {
    legacyRevenue,
    postingNetTotal,
    nestedPostingAccruedTotal,
    postingNetMinusNestedAccrued,
    productCandidates,
    note: "Только числа и дельты. Какой кандидат = gross revenue, диагностика НЕ утверждает; nested amounts уже в by-day total и повторно не вычитаются из net.",
  };

  return NextResponse.json(
    {
      ok: true,
      month,
      legacyOnly,
      range: { since: range.dateFrom, to: range.dateTo },
      rateLimited,
      retryAfterSeconds,
      truncated,
      fieldPresenceComplete,
      newApiRequestsUsed: budget.used,
      ...(legacyRan ? { legacyRequestsMax: LEGACY_MAX_REQUESTS } : {}),
      totalRequestsUpperBound: budget.used + (legacyRan ? LEGACY_MAX_REQUESTS : 0),
      totalRequestLimit: TOTAL_MAX_REQUESTS,
      // Безопасные длительности этапов (мс) + единый мягкий дедлайн диагностики.
      // Ни ключей, ни идентификаторов продавца — только числа. null — этап не
      // запускался (skipTypes/legacyOnly/недостижим по плану).
      diagDeadlineMs: DIAG_DEADLINE_MS,
      durationsMs,
      methods,
      legacy,
      comparison,
      grossRevenueEvidence,
      fieldPresence,
      safety:
        "Диагностика ничего не сохраняет, не списывает расчёт и не изменяет прибыль. Идентификаторы (posting_number/operation_id/SKU/offer_id/названия) не возвращаются — только имена ключей, типы и агрегаты.",
    },
    { status: 200, headers: NO_STORE }
  );
}
