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

// accrual_id — глобальный идентификатор ТИПА начисления (не posting/order). Принимаем
// только конечное целое в разумном диапазоне; иначе null (в агрегате — безопасный count).
function safeAccrualId(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1_000_000_000) return null;
  return v;
}

// ---- Evidence-классификатор верхнеуровневого accrual_id (value-free) ----
// Возвращает имя ВЗАИМОИСКЛЮЧАЮЩЕГО bucket. Классификация ПОЛНАЯ: любое значение попадает
// ровно в один bucket, поэтому сумма всех bucket-счётчиков == числу by-day records. Само
// значение ID наружу НЕ выходит — только имя bucket. Диапазоны не пересекаются.
function accrualIdBucket(v: unknown): string {
  if (v === undefined || v === null) return "missingOrNull";
  if (typeof v === "string") return "string";
  if (typeof v !== "number") return "otherType";
  if (!Number.isFinite(v) || !Number.isInteger(v)) return "numberNonFiniteOrFractional";
  if (v < 0) return "integerNegative";
  if (v === 0) return "integerZero";
  if (v <= 119) return "integerKnownRange1To119"; // 1..119
  if (v <= 1_000_000_000) return "integer120To1e9"; // 120..1e9 (граница 1e9 включительно)
  return "integerAbove1e9"; // > 1e9
}
const ACCRUAL_ID_BUCKET_KEYS = [
  "missingOrNull",
  "string",
  "otherType",
  "numberNonFiniteOrFractional",
  "integerNegative",
  "integerZero",
  "integerKnownRange1To119",
  "integer120To1e9",
  "integerAbove1e9",
] as const;
function emptyAccrualIdBuckets(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of ACCRUAL_ID_BUCKET_KEYS) o[k] = 0;
  return o;
}

// ---- Evidence-классификатор taxonomy type_id (value-free) ----
// type_id РАЗРЕШЕНО раскрывать ТОЛЬКО как целое 1..119 (глобальный справочник типов).
// Всё прочее — только счётчик bucket, без значения. Классификация полная (сумма bucket-
// счётчиков == числу учтённых records источника).
function typeIdBucket(v: unknown): string {
  if (v === undefined || v === null) return "missingOrNull";
  if (typeof v === "string") return "string";
  if (typeof v !== "number") return "otherType";
  if (!Number.isFinite(v) || !Number.isInteger(v)) return "numberNonFiniteOrFractional";
  if (v >= 1 && v <= 119) return "integerInRange1To119";
  return "integerOutOfRange";
}
const TYPE_ID_BUCKET_KEYS = [
  "missingOrNull",
  "string",
  "otherType",
  "numberNonFiniteOrFractional",
  "integerInRange1To119",
  "integerOutOfRange",
] as const;
function emptyTypeIdBuckets(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of TYPE_ID_BUCKET_KEYS) o[k] = 0;
  return o;
}
// known type_id → целое 1..119, иначе null (значение не раскрываем).
function knownTypeId(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) return null;
  return v >= 1 && v <= 119 ? v : null;
}

// ---- Аккумулятор taxonomy-evidence по ОДНОМУ источнику (NON_ITEM by-day ИЛИ posting nested) ----
// records — знаменатель (сколько записей источника учтено); buckets — исчерпывающая
// классификация type_id; byType — агрегаты ТОЛЬКО по известным 1..119. Денежные суммы
// здесь — ТОЛЬКО classification evidence; в net-итог/comparison они НЕ входят.
type TaxonomyEvidence = {
  records: number;
  buckets: Record<string, number>;
  byType: Map<number, { records: number; parsed: number; unparsed: number; sum: number }>;
};
function newTaxonomyEvidence(): TaxonomyEvidence {
  return { records: 0, buckets: emptyTypeIdBuckets(), byType: new Map() };
}
function addTaxonomyEvidence(ev: TaxonomyEvidence, typeIdRaw: unknown, amountRaw: unknown): void {
  ev.records += 1;
  ev.buckets[typeIdBucket(typeIdRaw)] += 1;
  const id = knownTypeId(typeIdRaw);
  if (id === null) return; // out-of-range / unknown → только bucket, без значения и без суммы
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
  const postingNumbersSeen = new Set<string>(); // дедуп posting_number FBO+FBS (наружу не отдаём)

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
            addTaxonomyEvidence(nonItemEvidence, nif.type_id, asObj(nif.accrued).amount);
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
                addTaxonomyEvidence(itemEvidence, fo.type_id, asObj(fo.accrued).amount);
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
      };
    }
    methods.accrual_by_day = {
      endpoint: "/v1/finance/accrual/by-day",
      status,
      days: daysQueried,
      pages,
      records,
      sumTotalAmount: byDayAmountComplete ? round2(sumTotalAmount) : null,
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
      // 2: ITEM taxonomy по item_fees.fees[].type_id (type_id наружу только 1–119).
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
            addTaxonomyEvidence(postingEvidence, o.type_id, asObj(o.accrued).amount);
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
        records: postingTaxonomy.records,
        typeIdEvidence: postingTaxonomy.typeIdEvidence,
        byTypeId: postingTaxonomy.byTypeId,
      },
      // 4: grand-total nested accrued.amount (все типы) + полнота; в net не входит.
      nestedAccruedTotal: {
        records,
        parsed: postAccParsed,
        unparsed: postAccUnparsed,
        total: postAccUnparsed === 0 ? round2(postAccSum) : null,
        complete: postAccUnparsed === 0,
      },
      accruedCategories: Array.from(categories).sort(),
      schemasByAccruedCategory: Array.from(postCatSchemas.entries())
        .map(([accrued_category, v]) => ({ accrued_category, records: v.records, schema: v.schema }))
        .sort((x, y) => (x.accrued_category < y.accrued_category ? -1 : x.accrued_category > y.accrued_category ? 1 : 0)),
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
  // newComplete требует, чтобы ВСЕ by-day amounts были распознаны (byDayAmountComplete).
  const byDayAmt = asObj(byDay.amountParsing);
  const newComplete =
    !rateLimited && !newApiLimitReached && byDay.error === "ok" && byDay.truncated === false && byDayAmt.complete === true && newTotal !== null;
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
    productCandidates[name] = {
      ...c,
      // дельта к legacyRevenue — ТОЛЬКО для полного кандидата при известном legacyRevenue.
      deltaToLegacyRevenue:
        complete && total !== null && legacyRevenue !== null ? round2(total - legacyRevenue) : null,
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
      grossRevenueEvidence,
      fieldPresence,
      safety:
        "Диагностика ничего не сохраняет, не списывает расчёт и не изменяет прибыль. Идентификаторы (posting_number/operation_id/SKU/offer_id/названия) не возвращаются — только имена ключей, типы и агрегаты.",
    },
    { status: 200, headers: NO_STORE }
  );
}
