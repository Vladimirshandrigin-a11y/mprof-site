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
// формулы/бакеты/история не меняются. candidateMatches — ТОЛЬКО подсказка
// глазами человека («candidate_only»), она НЕ вычитается и НЕ складывается
// в currentBuckets.
//
// БЕЗОПАСНОСТЬ:
//   • user_id берём ТОЛЬКО из проверенного токена (authenticateRequest);
//     из query/body идентификатор пользователя НЕ принимается вообще.
//   • service-role ОБХОДИТ RLS → фильтр .eq("user_id", userId) обязателен.
//   • Ключ расшифровывается только в памяти процесса; ни ключ, ни client_id,
//     ни сырой ответ Ozon, ни upstream-заголовки НЕ логируются и НЕ возвращаются.
//   • Наружу не уходят posting_number/order_id/SKU/offer_id/product_id/ФИО —
//     только агрегаты по типам операций и именам услуг.
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
  source: "operation" | "service";
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

/**
 * Безопасная upstream-ошибка: никакого сырого body/headers Ozon.
 * Свой HTTP всегда 502 (сбой вышестоящего сервиса), а фактический статус Ozon
 * едет отдельным полем httpStatus — так 429 виден, но не путается с нашим лимитом.
 */
function upstreamError(
  stage: string,
  httpStatus: number | null,
  errorCode: string,
  message: string,
  period: unknown
): NextResponse {
  return json(
    {
      ok: false,
      diagnosticOnly: true,
      stage,
      httpStatus,
      errorCode,
      message,
      sourceEndpoint: OZON_TX_URL,
      period,
      calculationConsumed: false,
      savedToDatabase: false,
      rawOperationsReturned: false,
    },
    502
  );
}

/** Форматированный UTF-8 JSON, удобный для копирования из браузера. */
function json(body: unknown, status: number): NextResponse {
  return new NextResponse(JSON.stringify(body, null, 2), {
    status,
    headers: NO_STORE,
  });
}

// ---------------------------------------------------------------------------
// GET — единственный метод. Тела/параметров нет by design.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // ---- 1) текущий пользователь: ТОЛЬКО из проверенного токена ----
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response; // 401/503, без утечек
  const { admin, userId } = auth;

  if (!isEncryptionConfigured()) {
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "encryption",
        errorCode: "encryption_misconfigured",
        message: "Шифрование ключей не настроено на сервере",
      },
      503
    );
  }

  // ---- 2) период: жёстко июнь 2026, тем же кодом, что и production ----
  const range = monthToRange(DIAG_MONTH);
  if (!range) {
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "period",
        errorCode: "bad_period",
        message: "Не удалось построить период диагностики",
      },
      500
    );
  }
  const period = {
    month: DIAG_MONTH,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  };

  // ---- 3) подключение Ozon СТРОГО текущего пользователя ----
  // service-role обходит RLS → .eq("user_id", userId) обязателен.
  const { data: conn, error: connErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr) {
    // Логируем ТОЛЬКО факт ошибки чтения, без строки подключения.
    // eslint-disable-next-line no-console
    console.error("[ozon/finance-taxonomy-diagnostic] connection select failed");
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "connection",
        errorCode: "connection_read_failed",
        message: "Ошибка чтения подключения",
      },
      502
    );
  }
  if (!conn || !conn.client_id || !conn.api_key_encrypted) {
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "connection",
        errorCode: "not_connected",
        message: "Подключение Ozon не найдено",
      },
      400
    );
  }
  if (conn.status !== "connected") {
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "connection",
        errorCode: "not_connected",
        message:
          "Подключение Ozon не в статусе «подключено». Проверьте его в Личном кабинете.",
      },
      400
    );
  }

  // ---- 4) расшифровка ключа: ТОЛЬКО в памяти процесса ----
  let apiKey: string;
  try {
    apiKey = decryptOzonApiKey(conn.api_key_encrypted as string);
  } catch {
    return json(
      {
        ok: false,
        diagnosticOnly: true,
        stage: "connection",
        errorCode: "decrypt_failed",
        message: "Ключ Ozon нужно переподключить",
      },
      400
    );
  }
  const clientId = conn.client_id as string;

  // ---- 5) страницы Ozon: тот же контракт, что и production finance.ts ----
  const operations: OzonOperation[] = [];
  let pageCount = 1;
  let partial = false;

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
      return upstreamError(
        "ozon_fetch",
        null,
        aborted ? "timeout" : "unavailable",
        aborted ? "Ozon не ответил вовремя" : "Ozon временно недоступен",
        period
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
      return upstreamError(
        "ozon_fetch",
        res.status,
        code,
        "Ozon вернул ошибку на запрос финансовых операций",
        period
      );
    }

    let data: {
      result?: { operations?: OzonOperation[]; page_count?: number };
    };
    try {
      data = await res.json();
    } catch {
      return upstreamError(
        "ozon_parse",
        res.status,
        "bad_response",
        "Ozon вернул неожиданный ответ",
        period
      );
    }

    const result = data.result ?? {};
    const ops = Array.isArray(result.operations) ? result.operations : [];
    operations.push(...ops);
    pageCount = typeof result.page_count === "number" ? result.page_count : page;

    if (page >= pageCount || ops.length === 0) break;
    if (page === MAX_PAGES) partial = true;
  }

  // ---- 6) агрегация (всё в копейках) ----
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
  const cand = {
    ads: new Map<string, CandidateAcc>(),
    logistics: new Map<string, CandidateAcc>(),
    storage: new Map<string, CandidateAcc>(),
  };

  const addCandidate = (
    group: keyof typeof cand,
    source: "operation" | "service",
    exactName: string,
    matchedMarker: string,
    totalKop: number
  ) => {
    const key = `${source} ${exactName}`;
    const cur = cand[group].get(key);
    if (cur) {
      cur.count += 1;
      cur.total += totalKop;
    } else {
      cand[group].set(key, {
        source,
        exactName,
        matchedMarker,
        count: 1,
        total: totalKop,
      });
    }
  };

  for (const op of operations) {
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

        // таблица по точным именам услуг
        const sv = serviceNames.get(name);
        if (sv) {
          sv.count += 1;
          sv.total += price;
          if (opType) sv.operationTypes.add(opType);
        } else {
          serviceNames.set(name, {
            name,
            count: 1,
            total: price,
            operationTypes: new Set(opType ? [opType] : []),
          });
        }

        // кандидаты по имени услуги
        const a = firstMarker(name, ADS_MARKERS);
        if (a) addCandidate("ads", "service", name, a, price);
        const l = firstMarker(name, LOGISTICS_MARKERS);
        if (l) addCandidate("logistics", "service", name, l, price);
        const st = firstMarker(name, STORAGE_MARKERS);
        if (st) addCandidate("storage", "service", name, st, price);
      }
    }

    const residual = amount - (accr + comm + deliv + retDeliv + serviceSum);
    if (residual !== 0) b.other += residual;

    // ---- таблица по типам операций ----
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

  // ---- 7) инвариант: всё в копейках, без искусственной балансировки ----
  const componentTotalKop =
    b.revenue + b.commission + b.logistics + b.services + b.storage + b.other;
  const deltaKop = b.amountTotal - componentTotalKop;

  // ---- 8) сортировка: самые крупные суммы наверх ----
  const byAbsDesc = <T,>(arr: T[], pick: (x: T) => number): T[] =>
    arr.sort((x, y) => Math.abs(pick(y)) - Math.abs(pick(x)));

  const body = {
    ok: true,
    diagnosticOnly: true as const,
    sourceEndpoint: OZON_TX_URL,
    period,
    pageCount,
    operationCount: operations.length,
    partial,
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

    operationTypes: byAbsDesc(Array.from(types.values()), (t) => t.amount).map(
      (t) => ({
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
      })
    ),

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
      note: "Diagnostic hint only. NOT a financial classification. These totals are already inside currentBuckets (services/other) and must NOT be added on top.",
      ads: byAbsDesc(Array.from(cand.ads.values()), (c) => c.total).map((c) => ({
        source: c.source,
        exactName: c.exactName,
        matchedMarker: c.matchedMarker,
        count: c.count,
        total: toRub(c.total),
        classification: "candidate_only" as const,
      })),
      logistics: byAbsDesc(Array.from(cand.logistics.values()), (c) => c.total).map(
        (c) => ({
          source: c.source,
          exactName: c.exactName,
          matchedMarker: c.matchedMarker,
          count: c.count,
          total: toRub(c.total),
          classification: "candidate_only" as const,
        })
      ),
      storage: byAbsDesc(Array.from(cand.storage.values()), (c) => c.total).map(
        (c) => ({
          source: c.source,
          exactName: c.exactName,
          matchedMarker: c.matchedMarker,
          count: c.count,
          total: toRub(c.total),
          classification: "candidate_only" as const,
        })
      ),
    },

    invariant: {
      amountTotal: toRub(b.amountTotal),
      componentTotal: toRub(componentTotalKop),
      delta: toRub(deltaKop),
      deltaKopecks: deltaKop,
      balanced: deltaKop === 0,
    },
  };

  return json(body, 200);
}
