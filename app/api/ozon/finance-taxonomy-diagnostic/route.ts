import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { monthToRange, type OzonOperation } from "../_lib/finance";

// ============================================================================
// /api/ozon/finance-taxonomy-diagnostic — ВРЕМЕННАЯ read-only диагностика.
//
// Зачем: в сохранённых API-расчётах «Логистика» и «Реклама» = 0, потому что
// finance.ts берёт логистику ТОЛЬКО из delivery_charge/return_delivery_charge,
// а save-calculation пишет adsCol жёстким нулём. Фактические расходы на рекламу
// и service-based логистику приезжают внутри services[]/residual и теряют там
// отдельные имена. Этот endpoint показывает СЫРУЮ ТАКСОНОМИЮ июня 2026:
// какие реально бывают operation_type и services[].name и сколько в них денег.
//
// Это НЕ расчёт прибыли и НЕ классификация. Ничего не сохраняется
// (ни calculations, ни report_history), consume_api_calculation НЕ вызывается,
// формулы/бакеты/история не меняются.
//
// ДОСТУП — ТОЛЬКО активный безлимит 449₽. Endpoint отдаёт ту же финансовую
// разбивку Ozon, что и платный API-расчёт (currentBuckets в сумме = это
// ozonOperationsTotal из profit.ts). Без этого гейта любой бесплатный
// пользователь получал бы платный результат в обход consume_api_calculation() —
// то есть обход монетизации. Гейт намеренно read-only: он НИЧЕГО не списывает,
// поэтому пробный бесплатный расчёт им не тратится. Пробный расчёт и тариф
// 149₽ доступа СЮДА НЕ дают (149₽ не открывает API и в самой RPC).
//
// БЕЗОПАСНОСТЬ:
//   • user_id берём ТОЛЬКО из проверенного токена (authenticateRequest);
//     из query/body идентификатор пользователя НЕ принимается вообще.
//   • service-role ОБХОДИТ RLS → фильтры .eq("id"/"user_id", userId) обязательны.
//   • Ключ расшифровывается только в памяти процесса; ни ключ, ни client_id,
//     ни сырой ответ Ozon, ни upstream-заголовки НЕ логируются и НЕ возвращаются.
//   • Наружу не уходят posting_number/order_id/SKU/offer_id/product_id/ФИО —
//     только агрегаты по типам операций и именам услуг.
//   • Страницы агрегируются на лету: массив всех операций в памяти НЕ копится.
//
// ВРЕМЕННЫЙ: после снятия диагностики удаляется отдельным cleanup-PR.
// ============================================================================

export const runtime = "nodejs"; // нужен node:crypto в decryptOzonApiKey
export const dynamic = "force-dynamic";

/** Приватный, без CDN/ISR/браузерного кеша — ответ привязан к пользователю. */
const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const OZON_TX_URL = "https://api-seller.ozon.ru/v3/finance/transaction/list";
/** Период зафиксирован в коде: июнь 2026. Месяц извне НЕ принимается. */
const DIAG_MONTH = "2026-06";
const PAGE_SIZE = 1000; // как в production finance.ts
const MAX_PAGES = 100; // жёсткий потолок: никакого бесконечного цикла
const TIMEOUT_MS = 20000; // таймаут на КАЖДУЮ страницу, как в production
/** Потолок уникальных категорий: защита памяти/размера ответа. */
const MAX_TAXONOMY_ENTRIES = 1000;
/** Минимальная пауза между запусками для одного пользователя. */
const COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Best-effort защита от параллельных/частых вызовов.
//
// ЧЕСТНО: это in-memory защита В ПРЕДЕЛАХ ОДНОГО ЭКЗЕМПЛЯРА. Timeweb/serverless
// может держать несколько инстансов, и тогда лимит обходится запросом в другой
// инстанс. Полноценный лимит требовал бы DB/Redis, а писать в БД здесь запрещено
// (диагностика строго read-only). Этого достаточно, потому что endpoint
// дополнительно закрыт активным тарифом 449₽ и одним фиксированным месяцем.
//
// Храним ТОЛЬКО userId и метку времени. Ни токена, ни ключа, ни connection,
// ни финансового ответа здесь нет — ответ не кешируется.
// ---------------------------------------------------------------------------
const inFlight = new Set<string>();
const lastStartedAt = new Map<string, number>();

/** Убрать протухшие метки cooldown, чтобы Map не рос бесконечно. */
function pruneCooldowns(now: number): void {
  for (const [uid, ts] of lastStartedAt) {
    if (now - ts > COOLDOWN_MS) lastStartedAt.delete(uid);
  }
}

// ---------------------------------------------------------------------------
// Деньги: копейки целыми числами.
// Копим ТОЛЬКО в integer-копейках, чтобы не накапливать ошибку float
// (0.1+0.2 !== 0.3). В рубли переводим один раз, на выходе.
// ---------------------------------------------------------------------------

/** Рубли (float из Ozon) → целые копейки. Нечисло/NaN/Infinity → 0. */
const toKop = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) : 0;

/** Целые копейки → рубли с 2 знаками (number, а не строка). */
const toRub = (kop: number): number => Math.round(kop) / 100;

// ---------------------------------------------------------------------------
// Правила текущего finance.ts.
//
// isReturnOp/isStorageMarker в finance.ts НЕ экспортированы, а менять
// production-файл в этом PR запрещено. Поэтому они здесь ЗЕРКАЛЬНО
// продублированы 1:1 — currentBuckets обязан воспроизводить то, что реально
// считает production СЕЙЧАС, включая текущий storage-маркер.
// НЕ «улучшать» их в этом PR: цель — снять фактическую картину, а не чинить.
// Источник: app/api/ozon/_lib/finance.ts (isReturnOp, isStorageMarker).
// ---------------------------------------------------------------------------

/** Зеркало finance.ts::isReturnOp — операция является возвратом? */
function isReturnOp(op: OzonOperation): boolean {
  const t = (op.type ?? "").toLowerCase();
  if (t.includes("return")) return true;
  return (op.operation_type ?? "").toLowerCase().includes("return");
}

/** Зеркало finance.ts::isStorageMarker — услуга является складским хранением? */
function isStorageMarker(serviceName: string, operationType: string): boolean {
  const s = `${serviceName} ${operationType}`.toLowerCase();
  return s.includes("storage") || s.includes("хранен") || s.includes("складск");
}

// ---------------------------------------------------------------------------
// Диагностические маркеры кандидатов.
//
// ЭТО НЕ КЛАССИФИКАЦИЯ. Подстрочный матч по имени — заведомо ненадёжен
// (в будущем правильный путь — устойчивый accrual_id из словаря Ozon).
// Здесь он нужен ровно для одного: показать человеку, куда смотреть.
// ---------------------------------------------------------------------------

const ADS_MARKERS = [
  "реклам",
  "продвиж",
  "трафарет",
  "advert",
  "promotion",
  "marketing",
  "traffic",
  "promo",
  "вывод в топ",
  "оплата за клик",
] as const;

const LOGISTICS_MARKERS = [
  "логист",
  "достав",
  "магистрал",
  "последн",
  "обработ",
  "сортиров",
  "возврат",
  "невыкуп",
  "delivery",
  "logistic",
  "last mile",
  "fulfillment",
  "cross-dock",
  "drop-off",
] as const;

const STORAGE_MARKERS = ["хранен", "размещен", "складск", "storage"] as const;

/** Первый сработавший маркер (для показа «почему совпало»), иначе null. */
function firstMarker(haystack: string, markers: readonly string[]): string | null {
  const h = haystack.toLowerCase();
  for (const m of markers) if (h.includes(m)) return m;
  return null;
}

// ---------------------------------------------------------------------------
// Аккумуляторы (всё в копейках)
// ---------------------------------------------------------------------------

type TypeAcc = {
  operationType: string;
  operationTypeName: string | null;
  count: number;
  amount: number;
  accrualsForSale: number;
  saleCommission: number;
  deliveryCharge: number;
  returnDeliveryCharge: number;
  servicesTotal: number;
  residualTotal: number;
};

type ServiceAcc = {
  name: string;
  count: number;
  total: number;
  operationTypes: Set<string>;
};

type CandidateAcc = {
  exactName: string;
  matchedMarker: string;
  count: number;
  total: number;
};

type Buckets = {
  revenue: number;
  returns: number;
  commission: number;
  logistics: number;
  services: number;
  storage: number;
  other: number;
  amountTotal: number;
};

type CandidateGroup = {
  /** Ключ — exactName. Отдельные Map для operation и service: составной ключ
   *  (а значит и небезопасный разделитель) не нужен в принципе. */
  operation: Map<string, CandidateAcc>;
  service: Map<string, CandidateAcc>;
};

const newGroup = (): CandidateGroup => ({
  operation: new Map(),
  service: new Map(),
});

// ---------------------------------------------------------------------------
// Ответы
// ---------------------------------------------------------------------------

/** Форматированный UTF-8 JSON, удобный для копирования из браузера. */
function json(body: unknown, status: number): NextResponse {
  return new NextResponse(JSON.stringify(body, null, 2), {
    status,
    headers: NO_STORE,
  });
}

/** Общая безопасная форма ошибки. Никаких секретов и сырого body Ozon. */
function fail(
  status: number,
  stage: string,
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {}
): NextResponse {
  return json(
    {
      ok: false,
      diagnosticOnly: true,
      stage,
      errorCode,
      message,
      calculationConsumed: false,
      savedToDatabase: false,
      rawOperationsReturned: false,
      ...extra,
    },
    status
  );
}

// ---------------------------------------------------------------------------
// GET — единственный метод. Тела/параметров нет by design.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // ---- 1) текущий пользователь: ТОЛЬКО из проверенного токена ----
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response; // 401/503, без утечек
  const { admin, userId } = auth;

  // ---- 2) ГЕЙТ ДОСТУПА: только активный безлимит 449₽ ----
  // Read-only: SELECT двух полей, никаких INSERT/UPDATE/RPC. Предикат зеркалит
  // ветку «безлимит» обеих RPC (schema.sql: consume_calculation и
  // consume_api_calculation): plan='unlimited' AND premium_until IS NOT NULL
  // AND premium_until > now(). Всё остальное (нет профиля / free / single(149₽) /
  // неиспользованный пробный / истёкший безлимит / кривая дата) → 403.
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("plan, premium_until")
    .eq("id", userId)
    .maybeSingle();

  if (profErr) {
    // Логируем только факт — без строки профиля и без ошибки Supabase наружу.
    console.error("[ozon/finance-taxonomy-diagnostic] profile select failed");
    return fail(502, "access", "profile_read_failed", "Ошибка чтения профиля");
  }

  const premiumUntilMs = profile?.premium_until
    ? Date.parse(String(profile.premium_until))
    : NaN;
  const hasActiveUnlimited =
    profile?.plan === "unlimited" &&
    Number.isFinite(premiumUntilMs) &&
    premiumUntilMs > Date.now();

  if (!hasActiveUnlimited) {
    // Ни plan, ни premium_until, ни userId наружу не отдаём.
    return fail(
      403,
      "access",
      "unlimited_required",
      "Диагностика доступна только при активном тарифе 449 ₽."
    );
  }

  // ---- 3) best-effort лимит: параллельные вызовы и cooldown ----
  const now = Date.now();
  pruneCooldowns(now);

  if (inFlight.has(userId)) {
    return fail(
      429,
      "rate_limit",
      "diagnostic_in_progress",
      "Диагностика уже выполняется. Дождитесь завершения."
    );
  }
  const prev = lastStartedAt.get(userId);
  if (prev !== undefined && now - prev < COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((COOLDOWN_MS - (now - prev)) / 1000);
    return fail(
      429,
      "rate_limit",
      "diagnostic_cooldown",
      `Диагностику можно запускать не чаще раза в минуту. Повторите через ${retryAfterSec} с.`,
      { retryAfterSeconds: retryAfterSec }
    );
  }

  inFlight.add(userId);
  lastStartedAt.set(userId, now);

  try {
    if (!isEncryptionConfigured()) {
      return fail(
        503,
        "encryption",
        "encryption_misconfigured",
        "Шифрование ключей не настроено на сервере"
      );
    }

    // ---- 4) период: жёстко июнь 2026, тем же кодом, что и production ----
    const range = monthToRange(DIAG_MONTH);
    if (!range) {
      return fail(500, "period", "bad_period", "Не удалось построить период диагностики");
    }
    const period = {
      month: DIAG_MONTH,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    };

    // ---- 5) подключение Ozon СТРОГО текущего пользователя ----
    // service-role обходит RLS → .eq("user_id", userId) обязателен.
    const { data: conn, error: connErr } = await admin
      .from("ozon_connections")
      .select("client_id, api_key_encrypted, status")
      .eq("user_id", userId)
      .maybeSingle();

    if (connErr) {
      console.error("[ozon/finance-taxonomy-diagnostic] connection select failed");
      return fail(502, "connection", "connection_read_failed", "Ошибка чтения подключения");
    }
    if (!conn || !conn.client_id || !conn.api_key_encrypted) {
      return fail(400, "connection", "not_connected", "Подключение Ozon не найдено");
    }
    if (conn.status !== "connected") {
      return fail(
        400,
        "connection",
        "not_connected",
        "Подключение Ozon не в статусе «подключено». Проверьте его в Личном кабинете."
      );
    }

    // ---- 6) расшифровка ключа: ТОЛЬКО в памяти процесса ----
    let apiKey: string;
    try {
      apiKey = decryptOzonApiKey(conn.api_key_encrypted as string);
    } catch {
      return fail(400, "connection", "decrypt_failed", "Ключ Ozon нужно переподключить");
    }
    const clientId = conn.client_id as string;

    // ---- 7) аккумуляторы ----
    const b: Buckets = {
      revenue: 0,
      returns: 0,
      commission: 0,
      logistics: 0,
      services: 0,
      storage: 0,
      other: 0,
      amountTotal: 0,
    };
    const types = new Map<string, TypeAcc>();
    const serviceNames = new Map<string, ServiceAcc>();
    const cand: Record<"ads" | "logistics" | "storage", CandidateGroup> = {
      ads: newGroup(),
      logistics: newGroup(),
      storage: newGroup(),
    };

    /** Один exactName внутри одной группы+source агрегируется ровно один раз. */
    const addCandidate = (
      group: "ads" | "logistics" | "storage",
      source: "operation" | "service",
      exactName: string,
      matchedMarker: string,
      totalKop: number
    ) => {
      const m = cand[group][source];
      const cur = m.get(exactName);
      if (cur) {
        cur.count += 1;
        cur.total += totalKop;
      } else {
        m.set(exactName, { exactName, matchedMarker, count: 1, total: totalKop });
      }
    };

    let operationCount = 0;
    let pagesRead = 0;
    let pageCount = 1;
    let limitExceeded = false;

    // ---- 8) страницы Ozon: тот же контракт, что и production finance.ts ----
    // Каждая страница агрегируется СРАЗУ; массив всех операций не копится.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(OZON_TX_URL, {
          method: "POST",
          headers: {
            "Client-Id": clientId,
            "Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filter: {
              date: { from: range.dateFrom, to: range.dateTo },
              transaction_type: "all",
            },
            page,
            page_size: PAGE_SIZE,
          }),
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        return fail(
          502,
          "ozon_fetch",
          aborted ? "timeout" : "unavailable",
          aborted ? "Ozon не ответил вовремя" : "Ozon временно недоступен",
          { httpStatus: null, sourceEndpoint: OZON_TX_URL, period }
        );
      } finally {
        clearTimeout(timer);
      }

      // Никаких retry: при 429 честно отдаём статус и останавливаемся.
      if (!res.ok) {
        const code =
          res.status === 401
            ? "invalid_key"
            : res.status === 403
              ? "forbidden"
              : res.status === 429
                ? "rate_limited"
                : res.status === 404 || res.status === 410
                  ? "deprecated_or_gone"
                  : "unavailable";
        return fail(
          502,
          "ozon_fetch",
          code,
          "Ozon вернул ошибку на запрос финансовых операций",
          { httpStatus: res.status, sourceEndpoint: OZON_TX_URL, period }
        );
      }

      let data: { result?: { operations?: OzonOperation[]; page_count?: number } };
      try {
        data = await res.json();
      } catch {
        return fail(502, "ozon_parse", "bad_response", "Ozon вернул неожиданный ответ", {
          httpStatus: res.status,
          sourceEndpoint: OZON_TX_URL,
          period,
        });
      }

      const result = data.result ?? {};
      const ops = Array.isArray(result.operations) ? result.operations : [];
      pageCount = typeof result.page_count === "number" ? result.page_count : page;
      pagesRead = page;

      // ---- агрегация ЭТОЙ страницы ----
      for (const op of ops) {
        operationCount += 1;
        const opType = op.operation_type ?? "";
        const opTypeName =
          typeof op.operation_type_name === "string" && op.operation_type_name
            ? op.operation_type_name
            : null;

        const amount = toKop(op.amount);
        const accr = toKop(op.accruals_for_sale);
        const comm = toKop(op.sale_commission);
        const deliv = toKop(op.delivery_charge);
        const retDeliv = toKop(op.return_delivery_charge);

        // ---- бакеты как в текущем finance.ts ----
        b.revenue += accr;
        b.commission += comm;
        b.logistics += deliv + retDeliv;
        b.amountTotal += amount;
        if (isReturnOp(op)) b.returns += accr;

        let serviceSum = 0;
        if (Array.isArray(op.services)) {
          for (const s of op.services) {
            const price = toKop(s?.price);
            if (price === 0) continue; // как в finance.ts: нулевые услуги пропускаем
            serviceSum += price;
            const name = typeof s?.name === "string" ? s.name : "";

            if (isStorageMarker(name, opType)) b.storage += price;
            else b.services += price;

            const sv = serviceNames.get(name);
            if (sv) {
              sv.count += 1;
              sv.total += price;
              if (opType) sv.operationTypes.add(opType);
            } else {
              if (serviceNames.size >= MAX_TAXONOMY_ENTRIES) {
                limitExceeded = true;
                break;
              }
              serviceNames.set(name, {
                name,
                count: 1,
                total: price,
                operationTypes: new Set(opType ? [opType] : []),
              });
            }

            const a = firstMarker(name, ADS_MARKERS);
            if (a) addCandidate("ads", "service", name, a, price);
            const l = firstMarker(name, LOGISTICS_MARKERS);
            if (l) addCandidate("logistics", "service", name, l, price);
            const st = firstMarker(name, STORAGE_MARKERS);
            if (st) addCandidate("storage", "service", name, st, price);
          }
        }
        if (limitExceeded) break;

        const residual = amount - (accr + comm + deliv + retDeliv + serviceSum);
        if (residual !== 0) b.other += residual;

        const t = types.get(opType);
        if (t) {
          t.count += 1;
          t.amount += amount;
          t.accrualsForSale += accr;
          t.saleCommission += comm;
          t.deliveryCharge += deliv;
          t.returnDeliveryCharge += retDeliv;
          t.servicesTotal += serviceSum;
          t.residualTotal += residual;
          if (!t.operationTypeName && opTypeName) t.operationTypeName = opTypeName;
        } else {
          if (types.size >= MAX_TAXONOMY_ENTRIES) {
            limitExceeded = true;
            break;
          }
          types.set(opType, {
            operationType: opType,
            operationTypeName: opTypeName,
            count: 1,
            amount,
            accrualsForSale: accr,
            saleCommission: comm,
            deliveryCharge: deliv,
            returnDeliveryCharge: retDeliv,
            servicesTotal: serviceSum,
            residualTotal: residual,
          });
        }

        // кандидаты по типу операции: и по коду, и по имени (если оно есть)
        const hay = `${opType} ${opTypeName ?? ""}`;
        const label = opTypeName ? `${opType} — ${opTypeName}` : opType;
        const a = firstMarker(hay, ADS_MARKERS);
        if (a) addCandidate("ads", "operation", label, a, amount);
        const l = firstMarker(hay, LOGISTICS_MARKERS);
        if (l) addCandidate("logistics", "operation", label, l, amount);
        const st = firstMarker(hay, STORAGE_MARKERS);
        if (st) addCandidate("storage", "operation", label, st, amount);
      }

      // Лимит таксономии: молча НЕ обрезаем — честно останавливаемся без сумм.
      if (limitExceeded) {
        return fail(
          422,
          "aggregation",
          "taxonomy_limit_exceeded",
          `Диагностика остановлена: уникальных категорий больше ${MAX_TAXONOMY_ENTRIES}. Финансовые суммы не возвращаются.`,
          { pagesRead, operationCount, sourceEndpoint: OZON_TX_URL, period }
        );
      }

      // Достигли последней страницы (или Ozon отдал пусто) → полный результат.
      if (page >= pageCount || ops.length === 0) break;

      // Дошли до потолка страниц, а данные ещё есть → результат НЕПОЛНЫЙ.
      // Финансовые суммы в этом случае НЕ отдаём вообще, чтобы неполный июнь
      // нельзя было принять за итоговый.
      if (page === MAX_PAGES) {
        return fail(
          422,
          "pagination",
          "page_limit_exceeded",
          "Диагностика остановлена: превышен безопасный лимит страниц. Финансовые суммы неполные и не должны использоваться.",
          {
            partial: true,
            pagesRead,
            operationCount,
            sourceEndpoint: OZON_TX_URL,
            period,
          }
        );
      }
      // ops выходит из области видимости на следующей итерации — страницу не держим.
    }

    // ---- 9) тождество учёта (НЕ проверка данных Ozon) ----
    const knownPlusResidual =
      b.revenue + b.commission + b.logistics + b.services + b.storage + b.other;
    const deltaKop = b.amountTotal - knownPlusResidual;

    // ---- 10) сортировка: самые крупные суммы наверх ----
    const byAbsDesc = <T,>(arr: T[], pick: (x: T) => number): T[] =>
      arr.sort((x, y) => Math.abs(pick(y)) - Math.abs(pick(x)));

    const mapCand = (m: Map<string, CandidateAcc>, source: "operation" | "service") =>
      byAbsDesc(Array.from(m.values()), (c) => c.total).map((c) => ({
        source,
        exactName: c.exactName,
        matchedMarker: c.matchedMarker,
        count: c.count,
        total: toRub(c.total),
        classification: "candidate_only" as const,
      }));

    const OVERLAP_WARNING =
      "operationCandidates содержат полный amount операции, а serviceCandidates — price услуги внутри операции. Эти массивы могут пересекаться, их суммы нельзя складывать.";

    const group = (g: CandidateGroup) => ({
      warning: OVERLAP_WARNING,
      mayOverlap: true as const,
      operationCandidates: mapCand(g.operation, "operation"),
      serviceCandidates: mapCand(g.service, "service"),
    });

    const body = {
      ok: true,
      diagnosticOnly: true as const,
      sourceEndpoint: OZON_TX_URL,
      period,
      pageCount,
      pagesRead,
      operationCount,
      partial: false as const,
      calculationConsumed: false as const,
      savedToDatabase: false as const,
      rawOperationsReturned: false as const,

      // Текущие бакеты M-PROF — по правилам production finance.ts как есть.
      currentBuckets: {
        revenue: toRub(b.revenue),
        returns: toRub(b.returns),
        commission: toRub(b.commission),
        logistics: toRub(b.logistics),
        services: toRub(b.services),
        storage: toRub(b.storage),
        other: toRub(b.other),
        amountTotal: toRub(b.amountTotal),
      },

      operationTypes: byAbsDesc(Array.from(types.values()), (t) => t.amount).map((t) => ({
        operationType: t.operationType,
        ...(t.operationTypeName ? { operationTypeName: t.operationTypeName } : {}),
        count: t.count,
        amount: toRub(t.amount),
        accrualsForSale: toRub(t.accrualsForSale),
        saleCommission: toRub(t.saleCommission),
        deliveryCharge: toRub(t.deliveryCharge),
        returnDeliveryCharge: toRub(t.returnDeliveryCharge),
        servicesTotal: toRub(t.servicesTotal),
        residualTotal: toRub(t.residualTotal),
      })),

      serviceNames: byAbsDesc(Array.from(serviceNames.values()), (s) => s.total).map(
        (s) => ({
          name: s.name,
          count: s.count,
          total: toRub(s.total),
          operationTypes: Array.from(s.operationTypes).sort(),
        })
      ),

      // ТОЛЬКО подсказка человеку. Не вычитается, не складывается, не сохраняется.
      candidateMatches: {
        diagnosticOnly: true as const,
        doNotSumCandidates: true as const,
        note: "Diagnostic hint only, NOT a financial classification. Эти суммы уже внутри currentBuckets (services/other) — поверх них ничего добавлять нельзя. Группы ads/logistics/storage тоже могут пересекаться между собой, пока таксономия не подтверждена вручную.",
        ads: group(cand.ads),
        logistics: group(cand.logistics),
        storage: group(cand.storage),
      },

      // Тождество ПО ПОСТРОЕНИЮ, а не независимая проверка данных Ozon.
      accountingIdentity: {
        amountTotal: toRub(b.amountTotal),
        knownComponentsPlusResidual: toRub(knownPlusResidual),
        delta: toRub(deltaKop),
        deltaKopecks: deltaKop,
        identityByConstruction: true as const,
        meaning:
          "Residual определяется как amount минус известные компоненты. Нулевая delta подтверждает только отсутствие внутренней потери при агрегации, но не правильность классификации рекламы или логистики.",
      },
    };

    return json(body, 200);
  } finally {
    // Снимаем in-flight ВСЕГДА: и при ошибке Ozon, и при таймауте, и при throw.
    // Иначе пользователь остался бы заблокирован до перезапуска инстанса.
    inFlight.delete(userId);
  }
}
