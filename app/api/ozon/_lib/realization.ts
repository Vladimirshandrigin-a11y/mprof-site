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
// не возвращается. Форма ответа v2 (сверена с офиц. схемой Ozon Seller API,
// метод «Отчёт о реализации товаров»):
//   result.rows[]: rowNumber, commission_ratio, seller_price_per_instance,
//     item{ name, barcode, offer_id, sku },   ← идентификаторы товара ВЛОЖЕНЫ в item
//     delivery_commission{amount,bonus,commission,compensation,price_per_instance,
//       quantity,standard_fee,bank_coinvestment,stars,total},
//     return_commission{ ...та же форма... }.
//   ВАЖНО: offer_id / sku лежат в row.item.*, а НЕ на верхнем уровне строки. Из-за
//   этого раньше сопоставление по r.offer_id давало 0 совпадений (строки и
//   количества читались, а идентификатор — нет). Теперь артикул берём через
//   item.offer_id (с запасом на старую «плоскую» форму offer_id на верхнем уровне).
// Если Ozon отдаёт другую (старую «плоскую») форму — мягко читаем запасные поля
// (offer_id/sale_qty/sale_amount/return_qty/return_amount) и сообщаем, каких нет.
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

/** Вложенный объект item из строки отчёта v2 — идентификаторы товара. */
type RealizationItem = {
  name?: string;
  barcode?: string;
  offer_id?: string;
  sku?: number;
};

type RealizationRow = {
  row_number?: number;
  rowNumber?: number; // v2 отдаёт camelCase
  // v2: идентификаторы товара ВЛОЖЕНЫ в item (item.offer_id / item.sku).
  item?: RealizationItem;
  commission_ratio?: number;
  seller_price_per_instance?: number;
  delivery_commission?: RealizationCommission;
  return_commission?: RealizationCommission;
  // Запасная «плоская»/старая форма (идентификаторы на верхнем уровне строки):
  product_id?: number;
  product_name?: string;
  offer_id?: string;
  barcode?: string;
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

/** Диагностика СТРУКТУРЫ ответа: реальные имена полей первой строки, чтобы увидеть,
 *  где лежит идентификатор товара (item.offer_id vs offer_id верхнего уровня).
 *  Значения полей НЕ раскрываются — только имена ключей, типы и признак «непусто».
 *  Персональные/секретные данные (Api-Key, ИНН из header) сюда не попадают. */
export type RealizationDebug = {
  /** Object.keys(rows[0]) — имена полей верхнего уровня первой строки. */
  rowKeys: string[];
  /** Для каждого вложенного объекта в rows[0] — его ключи (item / *_commission). */
  nestedKeys: Array<{ key: string; keys: string[] }>;
  /** Скан «идентификаторных» ключей: путь + тип + признак непустоты (БЕЗ значений). */
  identifierScan: Array<{ path: string; type: string; present: boolean }>;
  /** true — в строке есть вложенный объект item (форма v2). */
  hasNestedItem: boolean;
  /** Где реально найден offer_id: "item.offer_id" | "offer_id" | null. */
  resolvedOfferIdPath: string | null;
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
    /** База налога API-расчёта: выручка реализации за вычетом возвратов (deliveryAmount − returnAmount). */
    taxRevenueBase: number;
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
  /** Диагностика структуры ответа (имена ключей rows[0], где лежит offer_id). */
  debug: RealizationDebug;
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

// --- Идентификаторы товара: сначала вложенный item (v2), потом плоская форма. ---

/** Артикул продавца: item.offer_id (v2) → offer_id верхнего уровня (запас). */
function offerIdOf(r: RealizationRow): string {
  const nested = r.item?.offer_id;
  if (typeof nested === "string" && nested.trim() !== "") return nested;
  if (typeof r.offer_id === "string" && r.offer_id.trim() !== "") return r.offer_id;
  return "";
}

/** Имя товара: item.name (v2) → product_name (запас). */
function productNameOf(r: RealizationRow): string {
  const nested = r.item?.name;
  if (typeof nested === "string" && nested.trim() !== "") return nested;
  return typeof r.product_name === "string" ? r.product_name : "";
}

/** Штрихкод: item.barcode (v2) → barcode (запас). */
function barcodeOf(r: RealizationRow): string {
  const nested = r.item?.barcode;
  if (typeof nested === "string" && nested.trim() !== "") return nested;
  return typeof r.barcode === "string" ? r.barcode : "";
}

/** Ozon-sku/идентификатор товара: item.sku (v2) → product_id (запас). */
function skuNumOf(r: RealizationRow): number | null {
  const s = r.item?.sku;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  if (typeof r.product_id === "number" && Number.isFinite(r.product_id)) return r.product_id;
  return null;
}

// «Идентификаторные» ключи для скана структуры (offer/sku/article/barcode/…):
const ID_KEY_RE = /offer|sku|article|barcode|posting|product|item|name/i;

/**
 * Собрать СПРАВОЧНУЮ диагностику структуры первой строки: имена ключей верхнего
 * уровня, ключи вложенных объектов и скан «идентификаторных» полей. ТОЛЬКО имена
 * ключей/типы/признак непустоты — значения (в т.ч. персональные) не раскрываются.
 */
function buildRealizationDebug(rows: RealizationRow[]): RealizationDebug {
  const empty: RealizationDebug = {
    rowKeys: [],
    nestedKeys: [],
    identifierScan: [],
    hasNestedItem: false,
    resolvedOfferIdPath: null,
  };
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return empty;

  const rowKeys = Object.keys(first);
  const nestedKeys: RealizationDebug["nestedKeys"] = [];
  for (const k of rowKeys) {
    const v = first[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      nestedKeys.push({ key: k, keys: Object.keys(v as Record<string, unknown>) });
    }
  }

  const identifierScan: RealizationDebug["identifierScan"] = [];
  const scan = (obj: Record<string, unknown>, base: string, depth: number): void => {
    if (depth > 3 || identifierScan.length >= 24) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = base ? `${base}.${k}` : k;
      if (ID_KEY_RE.test(k)) {
        const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        const present =
          type === "string"
            ? (v as string).trim() !== ""
            : type === "number"
              ? Number.isFinite(v as number)
              : v != null && type !== "null";
        identifierScan.push({ path, type, present });
      }
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) {
        scan(v as Record<string, unknown>, path, depth + 1);
      }
    }
  };
  scan(first, "", 0);

  const item = (rows[0] as RealizationRow).item;
  const hasNestedItem = !!item && typeof item === "object";
  const itemOffer = item?.offer_id;
  const topOffer = (rows[0] as RealizationRow).offer_id;
  const resolvedOfferIdPath =
    typeof itemOffer === "string" && itemOffer.trim() !== ""
      ? "item.offer_id"
      : typeof topOffer === "string" && topOffer.trim() !== ""
        ? "offer_id"
        : null;

  return { rowKeys, nestedKeys, identifierScan, hasNestedItem, resolvedOfferIdPath };
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
        taxRevenueBase: 0,
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
      debug: {
        rowKeys: [],
        nestedKeys: [],
        identifierScan: [],
        hasNestedItem: false,
        resolvedOfferIdPath: null,
      },
      sample: [],
      notes,
      warnings,
    };
  }

  const rows = fetched.rows;
  const debug = buildRealizationDebug(rows);

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

    // Идентификаторы — через item.* (v2) с запасом на плоскую форму.
    const offerId = offerIdOf(r);
    const barcode = barcodeOf(r);
    const skuNum = skuNumOf(r);

    // presence-детект (виден хотя бы раз непустой ключ соответствующей формы).
    if (offerId !== "") fieldsPresent.offerId = true;
    if (skuNum !== null) fieldsPresent.productId = true;
    if (barcode !== "") fieldsPresent.barcode = true;
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
    const offer = normArticle(offerId);
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
        offerId,
        productName: productNameOf(r),
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
  if (rows.length > 0 && debug.hasNestedItem) {
    notes.push(
      "Форма ответа v2: идентификаторы товара лежат в объекте item (item.offer_id, item.sku) — сопоставление берёт item.offer_id."
    );
  }
  if (rows.length > 0 && debug.resolvedOfferIdPath) {
    notes.push(`Артикул (offer_id) найден по пути: ${debug.resolvedOfferIdPath}.`);
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
      taxRevenueBase: round2(deliveryAmount - returnAmount),
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
    debug,
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
