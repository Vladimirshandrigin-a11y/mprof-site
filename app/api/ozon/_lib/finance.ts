// ============================================================================
// Черновик финансовых данных Ozon за месяц (PR #2). ТОЛЬКО сервер.
//
// Тонкая обёртка над Ozon Seller API  POST /v3/finance/transaction/list:
//   • строит период месяца в UTC из "YYYY-MM" (без смещения месяца);
//   • безопасно пагинирует (жёсткий лимит страниц, никаких бесконечных циклов);
//   • агрегирует операции в ЧЕРНОВИК (НЕ P&L и НЕ чистую прибыль) — независимые
//     суммы по полям финансовых операций, со знаком из API.
//
// Api-Key приходит сюда уже расшифрованным (из route) и НИКОГДА не логируется и
// не возвращается. Структура ответа сверена с офиц. полями v3 (result.operations[]:
// accruals_for_sale, sale_commission, delivery_charge, return_delivery_charge,
// services[].price, type, operation_type, amount; result.page_count/row_count).
// ============================================================================

import {
  OZON_TAXONOMY_VERSION,
  accumulateSigned,
  classifyOperationResidual,
  emptyChargeCredit,
  isLogisticsServiceName,
} from "./taxonomy";

const OZON_TX_URL = "https://api-seller.ozon.ru/v3/finance/transaction/list";
const PAGE_SIZE = 1000; // максимум Ozon для этого метода
const MAX_PAGES = 20; // защита: максимум 20×1000 = 20000 операций за вызов
const TIMEOUT_MS = 20000; // таймаут на КАЖДУЮ страницу

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Код ошибки получения финансов — route переводит его в человеко-понятный текст. */
export type OzonFinanceErrorCode =
  | "not_connected" // нет строки подключения (route проверяет раньше; дублируем для полноты)
  | "invalid_key" // 401
  | "forbidden" // 403
  | "rate_limited" // 429
  | "unavailable" // 5xx / сеть
  | "timeout" // abort по таймауту
  | "bad_response"; // не-JSON / неожиданная форма ответа

/** Минимальная форма операции — читаем ТОЛЬКО нужные поля. Всё опционально:
 *  если Ozon вернёт иначе, мягко коалесцируем в 0/пусто, а не падаем. */
export type OzonOperation = {
  operation_id?: number;
  operation_type?: string;
  operation_type_name?: string;
  operation_date?: string;
  accruals_for_sale?: number;
  sale_commission?: number;
  delivery_charge?: number;
  return_delivery_charge?: number;
  amount?: number;
  type?: string;
  services?: Array<{ name?: string; price?: number }>;
};

type OzonTxResponse = {
  result?: {
    operations?: OzonOperation[];
    page_count?: number;
    row_count?: number;
  };
};

export type OzonFinanceFetchResult =
  | {
      ok: true;
      operations: OzonOperation[];
      partial: boolean;
      pageCount: number;
      rowCount: number;
    }
  | { ok: false; code: OzonFinanceErrorCode; status?: number };

export type MonthRange = { dateFrom: string; dateTo: string };

export type OzonDraftTotals = {
  revenue: number;
  returns: number;
  commission: number;
  /** Combined signed logistics = logisticsLegacy + logisticsServices. */
  logistics: number;
  /** Signed delivery_charge + return_delivery_charge (legacy Ozon fields). */
  logisticsLegacy: number;
  /** Signed exact logistics service prices (services[].name из LOGISTICS set). */
  logisticsServices: number;
  storage: number;
  /** Remaining signed services (без storage и без logistics-services). */
  services: number;
  /** Signed ads/promotion residual (operation_type из ADS set). */
  ads: number;
  /** Signed adjustment/compensation residual (operation_type из ADJUSTMENT set). */
  adjustments: number;
  /** Remaining signed residual (неизвестные операции). */
  other: number;
  operationCount: number;
};

/** Gross-разбивка одной корзины: signedTotal === credits − charges (§8). */
export type SignedBreakdown = {
  signedTotal: number;
  charges: number;
  credits: number;
};

/** Signed gross-разбивка по корзинам (для честного будущего UI; UI пока НЕ читает). */
export type OzonTaxonomyBreakdown = {
  classifierVersion: string;
  logistics: SignedBreakdown;
  ads: SignedBreakdown;
  adjustments: SignedBreakdown;
  remainingServices: SignedBreakdown;
  remainingOther: SignedBreakdown;
};

export type OzonDraftAggregate = {
  totals: OzonDraftTotals;
  /** Точная gross-разбивка (charges/credits) по классифицированным корзинам. */
  taxonomy: OzonTaxonomyBreakdown;
  warnings: string[];
  notes: string[];
};

// ---------------------------------------------------------------------------
// Период месяца
// ---------------------------------------------------------------------------

/** "YYYY-MM" → {dateFrom, dateTo} в UTC ISO. Первый день 00:00:00.000 →
 *  последний день 23:59:59.999. Считаем строго в UTC, чтобы не было смещения
 *  месяца из-за локальной таймзоны сервера. null, если формат неверный. */
export function monthToRange(month: string): MonthRange | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]); // 1..12
  if (mon < 1 || mon > 12) return null;
  // День 0 следующего месяца = последний день текущего месяца.
  const from = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999));
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() };
}

/** Месяц "YYYY-MM" строго в будущем относительно текущего (UTC)?
 *  Текущий месяц допустим (неполные данные — это нормально для черновика). */
export function isMonthInFuture(month: string, now: Date = new Date()): boolean {
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return month > cur; // лексикографическое сравнение корректно для фикс. ширины
}

// ---------------------------------------------------------------------------
// Получение операций (fetch + пагинация)
// ---------------------------------------------------------------------------

type PageResult =
  | { ok: true; data: OzonTxResponse }
  | { ok: false; code: OzonFinanceErrorCode; status?: number };

/** Одна страница транзакций. Никогда не бросает: сеть/таймаут → код ошибки. */
async function fetchPage(
  clientId: string,
  apiKey: string,
  range: MonthRange,
  page: number
): Promise<PageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OZON_TX_URL, {
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

    if (!res.ok) {
      if (res.status === 401) return { ok: false, code: "invalid_key", status: 401 };
      if (res.status === 403) return { ok: false, code: "forbidden", status: 403 };
      if (res.status === 429) return { ok: false, code: "rate_limited", status: 429 };
      return { ok: false, code: "unavailable", status: res.status };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, code: "bad_response" };
    }
    return { ok: true, data: (json as OzonTxResponse) ?? {} };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, code: aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Все операции за период с безопасной пагинацией. Если страниц больше лимита —
 *  возвращаем partial:true (то, что успели), без бесконечного цикла. */
export async function fetchOzonTransactions(
  clientId: string,
  apiKey: string,
  range: MonthRange
): Promise<OzonFinanceFetchResult> {
  const operations: OzonOperation[] = [];
  let pageCount = 1;
  let rowCount = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchPage(clientId, apiKey, range, page);
    if (!r.ok) return r;

    const result = r.data.result ?? {};
    const ops = Array.isArray(result.operations) ? result.operations : [];
    operations.push(...ops);
    pageCount = typeof result.page_count === "number" ? result.page_count : page;
    rowCount =
      typeof result.row_count === "number" ? result.row_count : operations.length;

    // Достигли последней страницы (или Ozon отдал пусто) → полный результат.
    if (page >= pageCount || ops.length === 0) {
      return { ok: true, operations, partial: false, pageCount, rowCount };
    }
  }

  // Вышли по лимиту страниц, а данных больше → частичный черновик.
  return { ok: true, operations, partial: true, pageCount, rowCount };
}

// ---------------------------------------------------------------------------
// Агрегация в черновик
// ---------------------------------------------------------------------------

const num = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Эвристика: операция — возврат? По группе `type` ("returns") или по
 *  operation_type, содержащему "return" (ClientReturn…, ItemReturn…). */
function isReturnOp(op: OzonOperation): boolean {
  const t = (op.type ?? "").toLowerCase();
  if (t.includes("return")) return true;
  return (op.operation_type ?? "").toLowerCase().includes("return");
}

/** Эвристика: услуга — складское хранение? По имени сервиса или operation_type. */
function isStorageMarker(serviceName: string, operationType: string): boolean {
  const s = `${serviceName} ${operationType}`.toLowerCase();
  return s.includes("storage") || s.includes("хранен") || s.includes("складск");
}

/**
 * Свести операции в ЧЕРНОВИК. Это НЕ строки P&L — это независимые агрегаты по
 * полям финансовых операций, со знаком из API (списания обычно отрицательные):
 *   • revenue    = Σ accruals_for_sale по ВСЕМ операциям (возвраты её уже уменьшают);
 *   • returns    = Σ accruals_for_sale по операциям-возвратам (подмножество revenue);
 *   • commission = Σ sale_commission;
 *   • logistics  = Σ (delivery_charge + return_delivery_charge);
 *   • storage    = Σ services[].price, опознанных как складское хранение (эвристика);
 *   • services   = Σ остальных services[].price;
 *   • other      = Σ (amount − сумма распознанных компонентов) по КАЖДОЙ операции —
 *                  нераспознанный остаток amount (реклама, доставка, штрафы,
 *                  корректировки, услуги партнёров и пр.). Для полностью
 *                  нераспознанной операции componentSum=0 → это весь amount.
 *   • operationCount = всего операций.
 * ИНВАРИАНТ: revenue + commission + logistics + services + storage + other === Σ amount
 * (op.amount — источник истины net Ozon по операции; компоненты выше — только
 * разбивка). Так «Операции Ozon» совпадают с «Итого» личного кабинета Ozon.
 * Если поле/структура отличается — не падаем, коалесцируем и добавляем warning.
 */
export function aggregateDraft(
  operations: OzonOperation[],
  partial: boolean
): OzonDraftAggregate {
  const totals: OzonDraftTotals = {
    revenue: 0,
    returns: 0,
    commission: 0,
    logistics: 0,
    logisticsLegacy: 0,
    logisticsServices: 0,
    storage: 0,
    services: 0,
    ads: 0,
    adjustments: 0,
    other: 0,
    operationCount: operations.length,
  };
  const warnings: string[] = [];
  const notes: string[] = [];

  // Gross charges/credits по классифицированным корзинам — накапливаем из
  // ОТДЕЛЬНЫХ signed-значений (не восстанавливаем из netted итога).
  const ccLogistics = emptyChargeCredit();
  const ccAds = emptyChargeCredit();
  const ccAdjustments = emptyChargeCredit();
  const ccServices = emptyChargeCredit();
  const ccOther = emptyChargeCredit();

  let storageDetected = false;
  let servicesSeen = false;
  let unclassifiedAmount = 0;
  const unknownTypes = new Set<string>();

  for (const op of operations) {
    const accr = num(op.accruals_for_sale);
    const comm = num(op.sale_commission);
    const deliv = num(op.delivery_charge);
    const retDeliv = num(op.return_delivery_charge);

    totals.revenue += accr;
    totals.commission += comm;
    // Legacy-логистика (поля delivery). Для июня 0, но семантику сохраняем.
    totals.logisticsLegacy += deliv + retDeliv;
    accumulateSigned(ccLogistics, deliv);
    accumulateSigned(ccLogistics, retDeliv);
    if (isReturnOp(op)) totals.returns += accr;

    // Сумма услуг этой операции — для разбивки storage/logistics/services И для
    // residual ниже. Порядок: storage (существующий маркер, НЕ сужаем) →
    // точная logistics-строка (exact name) → остальное в services.
    let serviceSum = 0;
    if (Array.isArray(op.services)) {
      for (const s of op.services) {
        const price = num(s?.price);
        if (price === 0) continue;
        serviceSum += price;
        servicesSeen = true;
        const name = typeof s?.name === "string" ? s.name : "";
        if (isStorageMarker(name, op.operation_type ?? "")) {
          totals.storage += price;
          storageDetected = true;
        } else if (isLogisticsServiceName(name)) {
          // Точная логистическая service-строка → logisticsServices (НЕ в services).
          totals.logisticsServices += price;
          accumulateSigned(ccLogistics, price);
        } else {
          totals.services += price;
          accumulateSigned(ccServices, price);
        }
      }
    }

    // op.amount — БОЕВОЙ net Ozon по операции (источник истины). Компоненты выше —
    // только разбивка. Классифицируем ТОЛЬКО residual (amount − распознанные
    // компоненты), НИКОГДА не переносим полный amount, если операция содержит
    // выручку/комиссию/service-компоненты. Точная классификация residual по
    // operation_type: реклама → ads, корректировка → adjustments, иначе → «Прочие».
    // Инвариант суммы бакетов сохраняется: ads+adjustments+other == прежний other.
    const amount = num(op.amount);
    const componentSum = accr + comm + deliv + retDeliv + serviceSum;
    const residual = amount - componentSum;
    if (round2(residual) !== 0) {
      const kind = classifyOperationResidual(op.operation_type ?? "");
      if (kind === "ads") {
        totals.ads += residual;
        accumulateSigned(ccAds, residual);
      } else if (kind === "adjustment") {
        totals.adjustments += residual;
        accumulateSigned(ccAdjustments, residual);
      } else {
        totals.other += residual;
        accumulateSigned(ccOther, residual);
        unclassifiedAmount += residual;
        if (op.operation_type) unknownTypes.add(op.operation_type);
      }
    }
  }

  // Combined logistics = legacy + services (breakdown внутри logistics).
  totals.logistics = totals.logisticsLegacy + totals.logisticsServices;

  // Округляем денежные суммы до копеек (operationCount не трогаем).
  totals.revenue = round2(totals.revenue);
  totals.returns = round2(totals.returns);
  totals.commission = round2(totals.commission);
  totals.logistics = round2(totals.logistics);
  totals.logisticsLegacy = round2(totals.logisticsLegacy);
  totals.logisticsServices = round2(totals.logisticsServices);
  totals.storage = round2(totals.storage);
  totals.services = round2(totals.services);
  totals.ads = round2(totals.ads);
  totals.adjustments = round2(totals.adjustments);
  totals.other = round2(totals.other);

  // Signed gross-разбивка: charges/credits округляем, signedTotal := credits − charges
  // (по построению === соответствующему bucket-итогу до копейки).
  const mkBreakdown = (acc: { charges: number; credits: number }): SignedBreakdown => {
    const charges = round2(acc.charges);
    const credits = round2(acc.credits);
    return { signedTotal: round2(credits - charges), charges, credits };
  };
  const taxonomy: OzonTaxonomyBreakdown = {
    classifierVersion: OZON_TAXONOMY_VERSION,
    logistics: mkBreakdown(ccLogistics),
    ads: mkBreakdown(ccAds),
    adjustments: mkBreakdown(ccAdjustments),
    remainingServices: mkBreakdown(ccServices),
    remainingOther: mkBreakdown(ccOther),
  };

  // ---- предупреждения / пояснения ----
  if (partial) {
    warnings.push(
      "Загружена только часть операций (достигнут лимит страниц). Черновик неполный."
    );
  }
  if (servicesSeen && !storageDetected) {
    warnings.push(
      "Складское хранение не удалось выделить отдельно — эти суммы показаны в «Доп. услуги»."
    );
  }
  if (unclassifiedAmount !== 0) {
    const types = Array.from(unknownTypes).slice(0, 6).join(", ");
    warnings.push(
      `Часть операций не классифицирована и отнесена в «Прочие операции»${types ? ` (${types})` : ""}.`
    );
  }

  if (operations.length === 0) {
    notes.push("За выбранный месяц финансовые операции Ozon не найдены.");
  } else {
    notes.push(
      "Это независимые агрегаты по полям финансовых операций Ozon, со знаком из API (списания обычно отрицательные). Это предварительный черновик, а НЕ чистая прибыль."
    );
    if (totals.returns !== 0) {
      notes.push(
        "Возвраты уже учтены в «Выручке» (она суммирует accruals_for_sale по всем операциям) и показаны отдельно только для наглядности."
      );
    }
  }

  return { totals, taxonomy, warnings, notes };
}
