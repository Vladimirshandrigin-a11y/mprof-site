// ============================================================================
// Диагностика отчёта о реализации Ozon за месяц. ТОЛЬКО сервер. ТОЛЬКО чтение.
//
// Тонкая обёртка над Ozon Seller API  POST /v2/finance/realization:
//   • строит запрос из { month: 1..12, year } (месяц отчёта реализации);
//   • читает result.rows[] и агрегирует СПРАВОЧНЫЕ суммы (кол-во, выручка,
//     возвраты, баллы, программы партнёров) + «кандидатную себестоимость»
//     (candidate COGS) = Σ количество × cost_price из каталога, сопоставленного
//     по тому же артикулу (offer_id ↔ products.sku), что и документальный расчёт.
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ (диагностика, а НЕ смена формулы):
//   Боевой API-расчёт берёт себестоимость из ОТПРАВЛЕНИЙ (postings, delivered) —
//   период по дате создания/обработки отправления, возвраты у delivered не
//   вычитаются. Документальный расчёт берёт количество из ОТЧЁТА О РЕАЛИЗАЦИИ.
//   Из-за разных источников за один месяц себестоимости расходятся. Этот модуль
//   ПРОВЕРЯЕТ, можно ли из отчёта реализации получить надёжные количество+артикул,
//   чтобы посчитать себестоимость из ТОГО ЖЕ источника, что и документы.
//
//   ВАЖНО: модуль НИЧЕГО не меняет в прибыли/налоге/COGS. Он только СЧИТАЕТ
//   справочные числа и «кандидатную» себестоимость и отдаёт их для показа.
//   candidate COGS НЕ идёт ни в netProfit, ни в matchedCostTotal, ни в историю.
//
// Api-Key приходит сюда уже расшифрованным (из route) и НИКОГДА не логируется и
// не возвращается. Форма ответа v2 сверена с офиц. полями:
//   result.rows[]: row_number, product_id, product_name, offer_id, barcode,
//   commission_ratio, seller_price_per_instance,
//   delivery_commission{amount,bonus,commission,compensation,price_per_instance,
//     quantity,standard_fee,bank_coinvestment,stars,total},
//   return_commission{ ...та же форма... }.
// Если Ozon отдаёт другую (старую «плоскую») форму — мягко читаем запасные поля
// (sale_qty/sale_amount/return_qty/return_amount) и сообщаем, каких полей нет.
// ============================================================================

import type { OzonFinanceErrorCode } from "./finance";
import type { CatalogRow } from "./postings";

const REALIZATION_URL = "https://api-seller.ozon.ru/v2/finance/realization";
const TIMEOUT_MS = 25000;
const MAX_SAMPLE = 12; // сколько строк показать в примере (без денежных секретов)

const num = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Нормализация артикула — ЗЕРКАЛО postings.normArticle (там она приватная). */
const normArticle = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// Сырые типы ответа (всё опционально — не падаем на любой форме)
// ---------------------------------------------------------------------------

type RealizationCommission = {
  amount?: number;
  bonus?: number;
  commission?: number;
  compensation?: number;
  price_per_instance?: number;
  quantity?: number;
  standard_fee?: number;
  bank_coinvestment?: number;
  stars?: number;
  total?: number;
};

type RealizationRow = {
  row_number?: number;
  product_id?: number;
  product_name?: string;
  offer_id?: string;
  barcode?: string;
  commission_ratio?: number;
  seller_price_per_instance?: number;
  delivery_commission?: RealizationCommission;
  return_commission?: RealizationCommission;
  // Запасная «плоская» форма (на случай иной версии ответа):
  sale_qty?: number;
  sale_amount?: number;
  return_qty?: number;
  return_amount?: number;
  quantity?: number;
};

type RealizationResponse = {
  result?: {
    header?: unknown;
    rows?: RealizationRow[];
  };
};

// ---------------------------------------------------------------------------
// Публичные типы
// ---------------------------------------------------------------------------

export type RealizationFetchResult =
  | { ok: true; rows: RealizationRow[]; rawRowCount: number }
  | { ok: false; code: OzonFinanceErrorCode; status?: number };

/** Какие поля реально пришли (виден хотя бы один непустой раз). Для отчёта
 *  «каких полей не хватает», если структура не даёт количество/артикул. */
export type RealizationFieldPresence = {
  offerId: boolean;
  productId: boolean;
  barcode: boolean;
  deliveryQuantity: boolean;
  returnQuantity: boolean;
  deliveryAmount: boolean;
  returnAmount: boolean;
  sellerPricePerInstance: boolean;
  bonus: boolean;
  bankCoinvestment: boolean;
  stars: boolean;
};

export type RealizationDiagnostic = {
  /** true — endpoint ответил 200 и отдал разбираемый result. */
  connected: boolean;
  /** код ошибки Ozon, если запрос не удался (connected=false). */
  errorCode?: OzonFinanceErrorCode;
  month: number;
  year: number;
  rowCount: number;
  sums: {
    /** Σ количество продаж (delivery quantity). */
    saleQuantity: number;
    /** Σ количество возвратов (return quantity). */
    returnQuantity: number;
    /** saleQuantity − returnQuantity. */
    netQuantity: number;
    /** Σ выручка по доставкам (delivery amount). */
    deliveryAmount: number;
    /** Σ сумма возвратов (return amount). */
    returnAmount: number;
    /** Σ баллы за скидки (bonus, delivery+return). */
    bonus: number;
    /** Σ со-инвестирование банка (bank_coinvestment, delivery+return). */
    bankCoinvestment: number;
    /** Σ «Звёзды»/программы партнёров (stars, delivery+return). */
    stars: number;
    /** Σ seller_price_per_instance × saleQty (справочная выручка продавца). */
    sellerPriceValue: number;
  };
  candidateCogs: {
    /** Σ saleQty × cost по сопоставленным (offer_id↔products.sku) с cost>0. */
    bySaleQty: number;
    /** Σ (saleQty − returnQty) × cost по тем же сопоставленным. */
    byNetQty: number;
    matchedRows: number;
    unmatchedRows: number;
    matchedNoCostRows: number;
    matchedSaleQuantity: number;
    unmatchedSaleQuantity: number;
  };
  fieldsPresent: RealizationFieldPresence;
  /** Первые строки для наглядности (без сумм-секретов: артикул, имя, кол-ва). */
  sample: Array<{
    offerId: string;
    productName: string;
    saleQty: number;
    returnQty: number;
    matched: boolean;
    costPerUnit: number | null;
  }>;
  notes: string[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Сеть: один POST-запрос отчёта реализации. Никогда не бросает.
// ---------------------------------------------------------------------------

/**
 * Получить отчёт о реализации Ozon за конкретный месяц.
 * apiKey уже расшифрован; НЕ логируется и НЕ возвращается.
 */
export async function fetchRealizationReport(
  clientId: string,
  apiKey: string,
  month: number,
  year: number
): Promise<RealizationFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(REALIZATION_URL, {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ month, year }),
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
    const data = (json as RealizationResponse) ?? {};
    const rows = Array.isArray(data.result?.rows) ? (data.result!.rows as RealizationRow[]) : [];
    return { ok: true, rows, rawRowCount: rows.length };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, code: aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Чистая агрегация: суммы + candidate COGS. Никаких сетей и БД.
// ---------------------------------------------------------------------------

/** Достать количество продаж из строки (нов. форма → запасная плоская). */
function saleQtyOf(r: RealizationRow): number {
  const dq = r.delivery_commission?.quantity;
  if (typeof dq === "number" && Number.isFinite(dq)) return dq;
  if (typeof r.sale_qty === "number" && Number.isFinite(r.sale_qty)) return r.sale_qty;
  if (typeof r.quantity === "number" && Number.isFinite(r.quantity)) return r.quantity;
  return 0;
}

/** Достать количество возвратов из строки. */
function returnQtyOf(r: RealizationRow): number {
  const rq = r.return_commission?.quantity;
  if (typeof rq === "number" && Number.isFinite(rq)) return rq;
  if (typeof r.return_qty === "number" && Number.isFinite(r.return_qty)) return r.return_qty;
  return 0;
}

/**
 * Собрать диагностику по строкам отчёта реализации + каталогу себестоимости.
 * ЧИСТАЯ функция. candidate COGS — СПРАВОЧНАЯ величина, она НЕ участвует в
 * netProfit/matchedCostTotal/налоге и никуда не сохраняется.
 *
 * Матч с каталогом — как в документальном/боевом расчёте: по нормализованному
 * offer_id ↔ products.sku (точное совпадение, без fuzzy).
 */
export function buildRealizationDiagnostic(
  fetched: RealizationFetchResult,
  catalog: CatalogRow[],
  month: number,
  year: number
): RealizationDiagnostic {
  const fieldsPresent: RealizationFieldPresence = {
    offerId: false,
    productId: false,
    barcode: false,
    deliveryQuantity: false,
    returnQuantity: false,
    deliveryAmount: false,
    returnAmount: false,
    sellerPricePerInstance: false,
    bonus: false,
    bankCoinvestment: false,
    stars: false,
  };
  const notes: string[] = [];
  const warnings: string[] = [];

  // Сетевой сбой / ошибка ключа → диагностика «не подключилась», без цифр.
  if (!fetched.ok) {
    warnings.push(
      "Отчёт о реализации Ozon не получен — endpoint вернул ошибку. Диагностика недоступна."
    );
    return {
      connected: false,
      errorCode: fetched.code,
      month,
      year,
      rowCount: 0,
      sums: {
        saleQuantity: 0,
        returnQuantity: 0,
        netQuantity: 0,
        deliveryAmount: 0,
        returnAmount: 0,
        bonus: 0,
        bankCoinvestment: 0,
        stars: 0,
        sellerPriceValue: 0,
      },
      candidateCogs: {
        bySaleQty: 0,
        byNetQty: 0,
        matchedRows: 0,
        unmatchedRows: 0,
        matchedNoCostRows: 0,
        matchedSaleQuantity: 0,
        unmatchedSaleQuantity: 0,
      },
      fieldsPresent,
      sample: [],
      notes,
      warnings,
    };
  }

  const rows = fetched.rows;

  // Индекс каталога по нормализованному products.sku (артикул продавца) — как в
  // aggregateProfitCostDraft/OzonProductBreakdown.
  const catIndex = new Map<string, { name: string; cost: number }>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (!key || catIndex.has(key)) continue;
    catIndex.set(key, {
      name: typeof c.name === "string" ? c.name : "",
      cost:
        typeof c.cost_price === "number" && Number.isFinite(c.cost_price)
          ? c.cost_price
          : 0,
    });
  }

  let saleQuantity = 0;
  let returnQuantity = 0;
  let deliveryAmount = 0;
  let returnAmount = 0;
  let bonus = 0;
  let bankCoinvestment = 0;
  let stars = 0;
  let sellerPriceValue = 0;

  let candBySaleQty = 0;
  let candByNetQty = 0;
  let matchedRows = 0;
  let unmatchedRows = 0;
  let matchedNoCostRows = 0;
  let matchedSaleQuantity = 0;
  let unmatchedSaleQuantity = 0;

  const sample: RealizationDiagnostic["sample"] = [];

  for (const r of rows) {
    const dc = r.delivery_commission ?? {};
    const rc = r.return_commission ?? {};

    // presence-детект (виден хотя бы раз непустой ключ соответствующей формы).
    if (typeof r.offer_id === "string" && r.offer_id.trim() !== "") fieldsPresent.offerId = true;
    if (typeof r.product_id === "number") fieldsPresent.productId = true;
    if (typeof r.barcode === "string" && r.barcode.trim() !== "") fieldsPresent.barcode = true;
    if (typeof dc.quantity === "number" || typeof r.sale_qty === "number" || typeof r.quantity === "number")
      fieldsPresent.deliveryQuantity = true;
    if (typeof rc.quantity === "number" || typeof r.return_qty === "number")
      fieldsPresent.returnQuantity = true;
    if (typeof dc.amount === "number" || typeof r.sale_amount === "number")
      fieldsPresent.deliveryAmount = true;
    if (typeof rc.amount === "number" || typeof r.return_amount === "number")
      fieldsPresent.returnAmount = true;
    if (typeof r.seller_price_per_instance === "number") fieldsPresent.sellerPricePerInstance = true;
    if (typeof dc.bonus === "number" || typeof rc.bonus === "number") fieldsPresent.bonus = true;
    if (typeof dc.bank_coinvestment === "number" || typeof rc.bank_coinvestment === "number")
      fieldsPresent.bankCoinvestment = true;
    if (typeof dc.stars === "number" || typeof rc.stars === "number") fieldsPresent.stars = true;

    const sQty = saleQtyOf(r);
    const rQty = returnQtyOf(r);
    saleQuantity += sQty;
    returnQuantity += rQty;
    deliveryAmount += num(dc.amount) || num(r.sale_amount);
    returnAmount += num(rc.amount) || num(r.return_amount);
    bonus += num(dc.bonus) + num(rc.bonus);
    bankCoinvestment += num(dc.bank_coinvestment) + num(rc.bank_coinvestment);
    stars += num(dc.stars) + num(rc.stars);
    sellerPriceValue += num(r.seller_price_per_instance) * sQty;

    // candidate COGS: матч по offer_id ↔ products.sku (точное, без fuzzy).
    const offer = normArticle(r.offer_id);
    const hit = offer ? catIndex.get(offer) : undefined;
    let matched = false;
    let costPerUnit: number | null = null;
    if (hit) {
      matchedRows += 1;
      matchedSaleQuantity += sQty;
      if (hit.cost > 0 && Number.isFinite(hit.cost)) {
        matched = true;
        costPerUnit = round2(hit.cost);
        candBySaleQty += sQty * hit.cost;
        candByNetQty += (sQty - rQty) * hit.cost;
      } else {
        matchedNoCostRows += 1;
      }
    } else {
      unmatchedRows += 1;
      unmatchedSaleQuantity += sQty;
    }

    if (sample.length < MAX_SAMPLE) {
      sample.push({
        offerId: typeof r.offer_id === "string" ? r.offer_id : "",
        productName: typeof r.product_name === "string" ? r.product_name : "",
        saleQty: sQty,
        returnQty: rQty,
        matched,
        costPerUnit,
      });
    }
  }

  const netQuantity = saleQuantity - returnQuantity;

  // ---- пояснения / предупреждения ----
  if (rows.length === 0) {
    notes.push("Отчёт о реализации Ozon за выбранный месяц пуст (нет строк).");
  } else {
    notes.push(
      "Диагностика справочная: candidate COGS считается из количества отчёта реализации и себестоимости каталога, НЕ участвует в чистой прибыли и никуда не сохраняется."
    );
  }
  if (rows.length > 0 && !fieldsPresent.offerId) {
    warnings.push(
      "В строках отчёта нет артикула (offer_id) — сопоставить с каталогом себестоимости нельзя. candidate COGS ненадёжен."
    );
  }
  if (rows.length > 0 && !fieldsPresent.deliveryQuantity) {
    warnings.push(
      "В строках отчёта нет количества (delivery_commission.quantity / sale_qty) — candidate COGS посчитать нельзя."
    );
  }
  if (rows.length > 0 && catIndex.size === 0) {
    warnings.push("Каталог себестоимости пуст — candidate COGS не с чем сопоставлять.");
  }
  if (unmatchedRows > 0) {
    warnings.push(
      `Не сопоставлено строк реализации с каталогом: ${unmatchedRows} (${round2(unmatchedSaleQuantity)} ед.). Их себестоимость в candidate COGS не вошла.`
    );
  }
  if (matchedNoCostRows > 0) {
    warnings.push(
      `Сопоставлено строк без себестоимости (cost=0): ${matchedNoCostRows}. Их стоимость в candidate COGS не вошла.`
    );
  }

  return {
    connected: true,
    month,
    year,
    rowCount: rows.length,
    sums: {
      saleQuantity: round2(saleQuantity),
      returnQuantity: round2(returnQuantity),
      netQuantity: round2(netQuantity),
      deliveryAmount: round2(deliveryAmount),
      returnAmount: round2(returnAmount),
      bonus: round2(bonus),
      bankCoinvestment: round2(bankCoinvestment),
      stars: round2(stars),
      sellerPriceValue: round2(sellerPriceValue),
    },
    candidateCogs: {
      bySaleQty: round2(candBySaleQty),
      byNetQty: round2(candByNetQty),
      matchedRows,
      unmatchedRows,
      matchedNoCostRows,
      matchedSaleQuantity: round2(matchedSaleQuantity),
      unmatchedSaleQuantity: round2(unmatchedSaleQuantity),
    },
    fieldsPresent,
    sample,
    notes,
    warnings,
  };
}

/**
 * Удобная обёртка: распарсить "YYYY-MM", получить отчёт и собрать диагностику.
 * Используется gated-роутом save-calculation ПОСЛЕ успешного списания/сохранения.
 * Никогда не бросает — при любой ошибке вернёт connected:false с кодом.
 */
export async function loadRealizationDiagnostic(params: {
  clientId: string;
  apiKey: string;
  month: string; // "YYYY-MM"
  catalog: CatalogRow[];
}): Promise<RealizationDiagnostic> {
  const { clientId, apiKey, month, catalog } = params;
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const year = m ? Number(m[1]) : 0;
  const monthNum = m ? Number(m[2]) : 0;
  if (!m || monthNum < 1 || monthNum > 12) {
    return buildRealizationDiagnostic(
      { ok: false, code: "bad_response" },
      catalog,
      monthNum,
      year
    );
  }
  const fetched = await fetchRealizationReport(clientId, apiKey, monthNum, year);
  return buildRealizationDiagnostic(fetched, catalog, monthNum, year);
}
