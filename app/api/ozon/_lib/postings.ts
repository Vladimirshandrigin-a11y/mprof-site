// ============================================================================
// Диагностика отправлений Ozon за месяц (PR #15). ТОЛЬКО сервер.
//
// Тонкие обёртки над Ozon Seller API:
//   • POST /v2/posting/fbo/list  — отправления со склада Ozon (FBO);
//   • POST /v3/posting/fbs/list  — отправления со своего склада (FBS).
//
// Зачем postings, а НЕ /v3/finance/transaction/list: в финансовом эндпоинте у
// позиции есть только { name, sku } (Ozon-SKU), но НЕТ offer_id (артикул
// продавца) и НЕТ quantity — а каталог себестоимости (таблица products) матчится
// по products.sku = артикул продавца (см. OzonProductBreakdown: offer_id↔sku).
// В postings у каждой позиции products[] есть offer_id, sku, name, quantity,
// price — это и есть надёжный ключ + количество для сопоставления.
//
// Поля сверены с офиц. схемой:
//   FBO products[]: offer_id(string), sku(int64), name, price(string), quantity(int64);
//   FBS products[]: offer_id(string), sku(int64), name, price(string), quantity(int32).
//   FBO ответ: result[] (массив отправлений), пагинация limit/offset (без has_next);
//   FBS ответ: result.postings[] + result.has_next(bool), пагинация limit/offset.
//
// Api-Key приходит сюда уже расшифрованным (из route) и НИКОГДА не логируется и
// не возвращается. Эта диагностика НИЧЕГО не сохраняет и не считает прибыль —
// только «нашёлся товар в каталоге себестоимости или нет».
// ============================================================================

import type { MonthRange, OzonFinanceErrorCode } from "./finance";

const FBO_URL = "https://api-seller.ozon.ru/v2/posting/fbo/list";
const FBS_URL = "https://api-seller.ozon.ru/v3/posting/fbs/list";
const PAGE_SIZE = 1000; // максимум Ozon для этих list-методов
const MAX_PAGES = 20; // защита: максимум 20×1000 отправлений за схему
const TIMEOUT_MS = 25000; // таймаут на КАЖДУЮ страницу
const MAX_LIST = 1000; // ограничение размера matched/unmatched в ответе

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

/** Нормализованная позиция товара из отправления (минимум нужных полей). */
export type OzonPostingItem = {
  /** offer_id — артикул продавца. "" если Ozon не вернул. Ключ матча с products.sku. */
  offerId: string;
  /** Ozon-SKU как строка. "" если нет. Безопасный запасной ключ матча. */
  sku: string;
  name: string;
  quantity: number;
  /** Цена за единицу (из строки price). null — если поля нет/не число. */
  price: number | null;
  scheme: "fbo" | "fbs";
};

type PostingsFetch =
  | { ok: true; items: OzonPostingItem[]; postingCount: number; partial: boolean }
  | { ok: false; code: OzonFinanceErrorCode };

/** Каталог себестоимости пользователя — ровно то, что отдаёт таблица products. */
export type CatalogRow = {
  sku: string | null;
  name: string | null;
  cost_price: number | null;
};

export type MatchedItem = {
  offerId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  price?: number;
  catalogProductName?: string;
  catalogCost?: number;
  matchBy: "offer_id" | "sku" | "article";
};

export type UnmatchedItem = {
  offerId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  price?: number;
  reason: string;
};

export type PostingsMatchTotals = {
  postingCount: number;
  itemRows: number;
  uniqueOzonItems: number;
  matchedItems: number;
  unmatchedItems: number;
  matchedQuantity: number;
  unmatchedQuantity: number;
};

export type PostingsMatchResult = {
  totals: PostingsMatchTotals;
  matched: MatchedItem[];
  unmatched: UnmatchedItem[];
  warnings: string[];
  notes: string[];
};

/** Итог получения отправлений за месяц по ОБЕИМ схемам (FBO+FBS). */
export type MonthPostings = {
  items: OzonPostingItem[];
  postingCount: number;
  partial: boolean;
  warnings: string[];
  /** Фатальная ошибка (например ключ невалиден) — route отдаёт errorResponse. */
  fatalCode?: OzonFinanceErrorCode;
};

// ---------------------------------------------------------------------------
// Низкоуровневый POST к Ozon (общий для FBO и FBS). Никогда не бросает.
// ---------------------------------------------------------------------------

type PostResult =
  | { ok: true; json: unknown }
  | { ok: false; code: OzonFinanceErrorCode };

async function postOzon(
  url: string,
  clientId: string,
  apiKey: string,
  body: unknown
): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 401) return { ok: false, code: "invalid_key" };
      if (res.status === 403) return { ok: false, code: "forbidden" };
      if (res.status === 429) return { ok: false, code: "rate_limited" };
      return { ok: false, code: "unavailable" };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, code: "bad_response" };
    }
    return { ok: true, json };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, code: aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Извлечение позиций из products[] (мягко: чужая форма → пропуск, не падаем).
// ---------------------------------------------------------------------------

function parsePrice(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x.replace(",", ".").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractItems(products: unknown, scheme: "fbo" | "fbs"): OzonPostingItem[] {
  if (!Array.isArray(products)) return [];
  const out: OzonPostingItem[] = [];
  for (const raw of products) {
    const p = (raw ?? {}) as {
      offer_id?: unknown;
      sku?: unknown;
      name?: unknown;
      quantity?: unknown;
      price?: unknown;
    };
    const offerId = typeof p.offer_id === "string" ? p.offer_id.trim() : "";
    const sku =
      typeof p.sku === "number" && Number.isFinite(p.sku)
        ? String(p.sku)
        : typeof p.sku === "string"
          ? p.sku.trim()
          : "";
    const name = typeof p.name === "string" ? p.name : "";
    const quantity =
      typeof p.quantity === "number" && Number.isFinite(p.quantity) ? p.quantity : 0;
    out.push({ offerId, sku, name, quantity, price: parsePrice(p.price), scheme });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FBO: /v2/posting/fbo/list — result[] (массив), пагинация offset до короткой стр.
// ---------------------------------------------------------------------------

async function fetchFboPostings(
  clientId: string,
  apiKey: string,
  range: MonthRange
): Promise<PostingsFetch> {
  const items: OzonPostingItem[] = [];
  let postingCount = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await postOzon(FBO_URL, clientId, apiKey, {
      dir: "ASC",
      filter: { since: range.dateFrom, to: range.dateTo },
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      translit: true,
      with: { analytics_data: false, financial_data: false },
    });
    if (!r.ok) return { ok: false, code: r.code };

    const result = (r.json as { result?: unknown }).result;
    const postings = Array.isArray(result) ? result : [];
    postingCount += postings.length;
    for (const posting of postings) {
      items.push(...extractItems((posting as { products?: unknown })?.products, "fbo"));
    }

    if (postings.length < PAGE_SIZE) {
      return { ok: true, items, postingCount, partial: false };
    }
  }
  return { ok: true, items, postingCount, partial: true };
}

// ---------------------------------------------------------------------------
// FBS: /v3/posting/fbs/list — result.postings[] + result.has_next, пагинация offset.
// ---------------------------------------------------------------------------

async function fetchFbsPostings(
  clientId: string,
  apiKey: string,
  range: MonthRange
): Promise<PostingsFetch> {
  const items: OzonPostingItem[] = [];
  let postingCount = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await postOzon(FBS_URL, clientId, apiKey, {
      dir: "ASC",
      filter: { since: range.dateFrom, to: range.dateTo, status: "" },
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      with: {},
    });
    if (!r.ok) return { ok: false, code: r.code };

    const result = (r.json as { result?: { postings?: unknown; has_next?: unknown } }).result;
    const postings = Array.isArray(result?.postings) ? result!.postings : [];
    postingCount += postings.length;
    for (const posting of postings) {
      items.push(...extractItems((posting as { products?: unknown })?.products, "fbs"));
    }

    const hasNext = result?.has_next === true;
    if (!hasNext || postings.length === 0) {
      return { ok: true, items, postingCount, partial: false };
    }
  }
  return { ok: true, items, postingCount, partial: true };
}

// ---------------------------------------------------------------------------
// Обе схемы вместе. Падение одной схемы → warning, а не общий сбой.
// Невалидный ключ (401) при пустом результате → фатально (route отдаёт ошибку).
// ---------------------------------------------------------------------------

export async function fetchMonthPostings(
  clientId: string,
  apiKey: string,
  range: MonthRange
): Promise<MonthPostings> {
  const items: OzonPostingItem[] = [];
  const warnings: string[] = [];
  let postingCount = 0;
  let partial = false;
  let invalidKey = false;

  const schemes: Array<{
    label: string;
    run: () => Promise<PostingsFetch>;
  }> = [
    { label: "FBO (со склада Ozon)", run: () => fetchFboPostings(clientId, apiKey, range) },
    { label: "FBS (со своего склада)", run: () => fetchFbsPostings(clientId, apiKey, range) },
  ];

  for (const { label, run } of schemes) {
    const r = await run();
    if (r.ok) {
      items.push(...r.items);
      postingCount += r.postingCount;
      partial = partial || r.partial;
      continue;
    }
    switch (r.code) {
      case "invalid_key":
        invalidKey = true;
        break;
      case "forbidden":
        warnings.push(
          `Ключу не хватает прав на отправления ${label}. Эти товары не вошли в диагностику.`
        );
        break;
      case "rate_limited":
        warnings.push(
          `Ozon ограничил частоту запросов при загрузке ${label}. Попробуйте позже.`
        );
        break;
      case "timeout":
        warnings.push(
          `Ozon не ответил вовремя по ${label}. Часть товаров могла не войти в диагностику.`
        );
        break;
      default:
        warnings.push(
          `Не удалось получить отправления ${label}. Часть товаров могла не войти в диагностику.`
        );
    }
  }

  let fatalCode: OzonFinanceErrorCode | undefined;
  if (invalidKey && items.length === 0) {
    fatalCode = "invalid_key";
  } else if (invalidKey) {
    warnings.push(
      "Часть запросов к Ozon вернула ошибку авторизации — данные могут быть неполными."
    );
  }
  if (partial) {
    warnings.push(
      "Загружена только часть отправлений (достигнут лимит страниц). Диагностика неполная."
    );
  }

  return { items, postingCount, partial, warnings, fatalCode };
}

// ---------------------------------------------------------------------------
// Агрегация позиций + сопоставление с каталогом. ПРИБЫЛЬ НЕ СЧИТАЕМ.
// ---------------------------------------------------------------------------

/** Нормализация артикула/sku для матчинга — ровно как на фронте (OzonProductBreakdown). */
function normArticle(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

type AggItem = {
  offerId: string;
  sku: string;
  name: string;
  quantity: number;
  price: number | null;
  keyKind: "offer_id" | "sku" | "unknown";
};

/**
 * Свести позиции в уникальные товары и сопоставить с каталогом себестоимости.
 *   • агрегируем по offer_id (если есть), иначе по sku, иначе — «без идентификатора»;
 *   • матчим товар с products: сначала offer_id↔products.sku, затем sku↔products.sku
 *     (только ТОЧНОЕ совпадение по нормализованному значению, без fuzzy);
 *   • matched = товар найден в каталоге; unmatched = не найден / нет идентификатора.
 * Это диагностика: catalogCost показываем для справки, прибыль НЕ считаем.
 */
export function aggregatePostingsMatch(
  items: OzonPostingItem[],
  postingCount: number,
  partial: boolean,
  fetchWarnings: string[],
  catalog: CatalogRow[]
): PostingsMatchResult {
  const warnings = [...fetchWarnings];
  const notes: string[] = [];

  // Индекс каталога по нормализованному products.sku (артикул продавца).
  const catIndex = new Map<string, { name: string; cost: number }>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (!key || catIndex.has(key)) continue;
    catIndex.set(key, {
      name: typeof c.name === "string" ? c.name : "",
      cost: typeof c.cost_price === "number" && Number.isFinite(c.cost_price) ? c.cost_price : 0,
    });
  }

  // Агрегируем позиции в уникальные товары.
  const agg = new Map<string, AggItem>();
  let itemRows = 0;
  for (const it of items) {
    itemRows += 1;
    let keyKind: AggItem["keyKind"];
    let aggKey: string;
    if (it.offerId) {
      keyKind = "offer_id";
      aggKey = `o:${normArticle(it.offerId)}`;
    } else if (it.sku) {
      keyKind = "sku";
      aggKey = `s:${normArticle(it.sku)}`;
    } else {
      keyKind = "unknown";
      aggKey = `u:${normArticle(it.name) || "(без идентификатора)"}`;
    }

    const ex = agg.get(aggKey);
    if (ex) {
      ex.quantity += it.quantity;
      if (!ex.name && it.name) ex.name = it.name;
      if (ex.price == null && it.price != null) ex.price = it.price;
      if (!ex.offerId && it.offerId) ex.offerId = it.offerId;
      if (!ex.sku && it.sku) ex.sku = it.sku;
    } else {
      agg.set(aggKey, {
        offerId: it.offerId,
        sku: it.sku,
        name: it.name,
        quantity: it.quantity,
        price: it.price,
        keyKind,
      });
    }
  }

  const matched: MatchedItem[] = [];
  const unmatched: UnmatchedItem[] = [];
  let matchedQuantity = 0;
  let unmatchedQuantity = 0;
  let matchedNoCost = 0;

  for (const a of agg.values()) {
    // Сначала по offer_id, затем — точным совпадением по Ozon-SKU. Без fuzzy.
    let hit: { name: string; cost: number } | undefined;
    let matchBy: MatchedItem["matchBy"] | null = null;
    if (a.offerId) {
      const byOffer = catIndex.get(normArticle(a.offerId));
      if (byOffer) {
        hit = byOffer;
        matchBy = "offer_id";
      }
    }
    if (!hit && a.sku) {
      const bySku = catIndex.get(normArticle(a.sku));
      if (bySku) {
        hit = bySku;
        matchBy = "sku";
      }
    }

    if (hit && matchBy) {
      matchedQuantity += a.quantity;
      if (hit.cost <= 0) matchedNoCost += 1;
      matched.push({
        ...(a.offerId ? { offerId: a.offerId } : {}),
        ...(a.sku ? { sku: a.sku } : {}),
        ...(a.name ? { name: a.name } : {}),
        quantity: a.quantity,
        ...(a.price != null ? { price: a.price } : {}),
        ...(hit.name ? { catalogProductName: hit.name } : {}),
        catalogCost: hit.cost,
        matchBy,
      });
    } else {
      unmatchedQuantity += a.quantity;
      const reason =
        a.keyKind === "unknown"
          ? "Нет артикула (offer_id) и SKU — товар нельзя сопоставить с каталогом"
          : "Не найден в каталоге себестоимости (нет такого артикула)";
      unmatched.push({
        ...(a.offerId ? { offerId: a.offerId } : {}),
        ...(a.sku ? { sku: a.sku } : {}),
        ...(a.name ? { name: a.name } : {}),
        quantity: a.quantity,
        ...(a.price != null ? { price: a.price } : {}),
        reason,
      });
    }
  }

  // Сортировка по количеству (убыв.), затем по названию — крупное сверху.
  const byQty = (
    x: { quantity: number; name?: string },
    y: { quantity: number; name?: string }
  ) => y.quantity - x.quantity || (x.name ?? "").localeCompare(y.name ?? "", "ru");
  matched.sort(byQty);
  unmatched.sort(byQty);

  const matchedTotal = matched.length;
  const unmatchedTotal = unmatched.length;

  // Ограничиваем размер списков в ответе (тоталы остаются точными).
  const matchedOut = matched.slice(0, MAX_LIST);
  const unmatchedOut = unmatched.slice(0, MAX_LIST);
  if (matchedTotal > MAX_LIST || unmatchedTotal > MAX_LIST) {
    notes.push(
      `Показаны первые ${MAX_LIST} товаров в каждом списке (всего сопоставлено ${matchedTotal}, не сопоставлено ${unmatchedTotal}).`
    );
  }

  // Пояснения.
  if (catIndex.size === 0) {
    notes.push(
      "Каталог себестоимости пуст — добавьте товары с артикулом, чтобы сопоставление заработало."
    );
  }
  if (matchedNoCost > 0) {
    notes.push(
      `Сопоставлено товаров без себестоимости в каталоге: ${matchedNoCost}. Артикул совпал, но cost_price = 0 — добавьте себестоимость для будущего расчёта.`
    );
  }
  if (itemRows === 0) {
    notes.push("За выбранный месяц отправления Ozon не найдены.");
  } else {
    notes.push(
      "Это диагностика сопоставления: проверяем, какие товары из Ozon API есть в каталоге себестоимости. Прибыль здесь НЕ считается."
    );
  }

  return {
    totals: {
      postingCount,
      itemRows,
      uniqueOzonItems: matchedTotal + unmatchedTotal,
      matchedItems: matchedTotal,
      unmatchedItems: unmatchedTotal,
      matchedQuantity,
      unmatchedQuantity,
    },
    matched: matchedOut,
    unmatched: unmatchedOut,
    warnings,
    notes,
  };
}

// ---------------------------------------------------------------------------
// PR #16: предварительный COST-черновик. Себестоимость считаем ТОЛЬКО по
// сопоставленным товарам с указанной ценой: matchedCostTotal = Σ quantity*cost.
//   • матч — тот же, что в диагностике: offer_id↔products.sku, затем точное
//     Ozon-sku↔products.sku, без fuzzy;
//   • сопоставленный товар без cost_price (0/невалид) → проблемный: его стоимость
//     НЕ учитываем и кладём в itemsWithoutCost (это «неполнота» себестоимости);
//   • unmatched-товары тоже попадают в itemsWithoutCost (их стоимость не учтена).
// ПРИБЫЛЬ здесь НЕ считается — это делает route (operations − matchedCostTotal).
// ---------------------------------------------------------------------------

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Покрытие каталогом (счётчики) — для блока «Сопоставлено/Не сопоставлено». */
export type ProfitCoverage = {
  uniqueOzonItems: number;
  matchedItems: number;
  unmatchedItems: number;
  matchedQuantity: number;
  unmatchedQuantity: number;
};

/** Товар, чья себестоимость НЕ учтена (не сопоставлен или нет cost_price). */
export type ProfitProblemItem = {
  offerId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  reason: string;
};

/** Сопоставленный товар с себестоимостью — для списка крупнейших по стоимости. */
export type ProfitTopCostItem = {
  offerId?: string;
  sku?: string;
  name?: string;
  quantity: number;
  costPerUnit: number;
  totalCost: number;
  matchBy: "offer_id" | "sku" | "article";
};

export type ProfitCostDraft = {
  coverage: ProfitCoverage;
  matchedCostTotal: number;
  matchedNoCostCount: number;
  itemsWithoutCost: ProfitProblemItem[];
  topCostItems: ProfitTopCostItem[];
  warnings: string[];
  notes: string[];
};

/**
 * Свести позиции в уникальные товары и посчитать себестоимость сопоставленных.
 * Возвращает покрытие (matched/unmatched), Σ себестоимости сопоставленных с ценой,
 * список «без учёта стоимости» и топ по стоимости. Никакого fuzzy и никакой
 * выдуманной себестоимости для unmatched. ПРИБЫЛЬ НЕ СЧИТАЕМ.
 */
export function aggregateProfitCostDraft(
  items: OzonPostingItem[],
  fetchWarnings: string[],
  catalog: CatalogRow[]
): ProfitCostDraft {
  const warnings = [...fetchWarnings];
  const notes: string[] = [];

  // Индекс каталога по нормализованному products.sku (артикул продавца).
  const catIndex = new Map<string, { name: string; cost: number }>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (!key || catIndex.has(key)) continue;
    catIndex.set(key, {
      name: typeof c.name === "string" ? c.name : "",
      cost: typeof c.cost_price === "number" && Number.isFinite(c.cost_price) ? c.cost_price : 0,
    });
  }

  // Агрегируем позиции в уникальные товары (offer_id → sku → без идентификатора).
  const agg = new Map<string, AggItem>();
  for (const it of items) {
    let keyKind: AggItem["keyKind"];
    let aggKey: string;
    if (it.offerId) {
      keyKind = "offer_id";
      aggKey = `o:${normArticle(it.offerId)}`;
    } else if (it.sku) {
      keyKind = "sku";
      aggKey = `s:${normArticle(it.sku)}`;
    } else {
      keyKind = "unknown";
      aggKey = `u:${normArticle(it.name) || "(без идентификатора)"}`;
    }
    const ex = agg.get(aggKey);
    if (ex) {
      ex.quantity += it.quantity;
      if (!ex.name && it.name) ex.name = it.name;
      if (ex.price == null && it.price != null) ex.price = it.price;
      if (!ex.offerId && it.offerId) ex.offerId = it.offerId;
      if (!ex.sku && it.sku) ex.sku = it.sku;
    } else {
      agg.set(aggKey, {
        offerId: it.offerId,
        sku: it.sku,
        name: it.name,
        quantity: it.quantity,
        price: it.price,
        keyKind,
      });
    }
  }

  const coverage: ProfitCoverage = {
    uniqueOzonItems: 0,
    matchedItems: 0,
    unmatchedItems: 0,
    matchedQuantity: 0,
    unmatchedQuantity: 0,
  };
  let matchedCostRaw = 0;
  let matchedNoCostCount = 0;
  const itemsWithoutCost: ProfitProblemItem[] = [];
  const topCostItems: ProfitTopCostItem[] = [];

  for (const a of agg.values()) {
    coverage.uniqueOzonItems += 1;

    // Матч: сначала offer_id↔products.sku, затем точное Ozon-sku↔products.sku. Без fuzzy.
    let hit: { name: string; cost: number } | undefined;
    let matchBy: ProfitTopCostItem["matchBy"] | null = null;
    if (a.offerId) {
      const byOffer = catIndex.get(normArticle(a.offerId));
      if (byOffer) {
        hit = byOffer;
        matchBy = "offer_id";
      }
    }
    if (!hit && a.sku) {
      const bySku = catIndex.get(normArticle(a.sku));
      if (bySku) {
        hit = bySku;
        matchBy = "sku";
      }
    }

    if (hit && matchBy) {
      coverage.matchedItems += 1;
      coverage.matchedQuantity += a.quantity;
      const cost = hit.cost;
      if (cost > 0 && Number.isFinite(cost)) {
        matchedCostRaw += a.quantity * cost;
        topCostItems.push({
          ...(a.offerId ? { offerId: a.offerId } : {}),
          ...(a.sku ? { sku: a.sku } : {}),
          ...(a.name ? { name: a.name } : {}),
          quantity: a.quantity,
          costPerUnit: round2(cost),
          totalCost: round2(a.quantity * cost),
          matchBy,
        });
      } else {
        // Артикул найден, но cost_price отсутствует/0/невалиден — стоимость не учитываем.
        matchedNoCostCount += 1;
        itemsWithoutCost.push({
          ...(a.offerId ? { offerId: a.offerId } : {}),
          ...(a.sku ? { sku: a.sku } : {}),
          ...(a.name ? { name: a.name } : {}),
          quantity: a.quantity,
          reason: "Сопоставлен с каталогом, но себестоимость не указана (0) — стоимость не учтена",
        });
      }
    } else {
      coverage.unmatchedItems += 1;
      coverage.unmatchedQuantity += a.quantity;
      const reason =
        a.keyKind === "unknown"
          ? "Нет артикула (offer_id) и SKU — товар нельзя сопоставить, себестоимость не учтена"
          : "Не найден в каталоге себестоимости — себестоимость не учтена";
      itemsWithoutCost.push({
        ...(a.offerId ? { offerId: a.offerId } : {}),
        ...(a.sku ? { sku: a.sku } : {}),
        ...(a.name ? { name: a.name } : {}),
        quantity: a.quantity,
        reason,
      });
    }
  }

  const matchedCostTotal = round2(matchedCostRaw);

  // Сортировка: дорогие/крупные сверху.
  topCostItems.sort(
    (x, y) => y.totalCost - x.totalCost || (x.name ?? "").localeCompare(y.name ?? "", "ru")
  );
  itemsWithoutCost.sort(
    (x, y) => y.quantity - x.quantity || (x.name ?? "").localeCompare(y.name ?? "", "ru")
  );

  const topOut = topCostItems.slice(0, MAX_LIST);
  const withoutOut = itemsWithoutCost.slice(0, MAX_LIST);
  if (topCostItems.length > MAX_LIST || itemsWithoutCost.length > MAX_LIST) {
    notes.push(
      `Показаны первые ${MAX_LIST} позиций в каждом списке (с себестоимостью ${topCostItems.length}, без учёта стоимости ${itemsWithoutCost.length}).`
    );
  }

  // Пояснения / предупреждения.
  if (catIndex.size === 0) {
    warnings.push(
      "Каталог себестоимости пуст — добавьте товары с артикулом и себестоимостью перед API-расчётом."
    );
  }
  if (matchedNoCostCount > 0) {
    warnings.push(
      `Сопоставлено товаров без себестоимости в каталоге: ${matchedNoCostCount}. Их стоимость не учтена в черновике — добавьте cost_price.`
    );
  }
  if (coverage.unmatchedItems > 0) {
    warnings.push(
      `Не сопоставлено товаров: ${coverage.unmatchedItems} (${coverage.unmatchedQuantity} ед.). Их себестоимость не учтена — расчёт неполный.`
    );
  }
  if (coverage.uniqueOzonItems === 0) {
    notes.push("За выбранный месяц отправления Ozon не найдены — себестоимость считать не из чего.");
  } else {
    notes.push(
      "Себестоимость учтена только по сопоставленным товарам с указанной ценой. Несопоставленные товары и товары без cost_price в стоимость НЕ вошли."
    );
  }

  return {
    coverage,
    matchedCostTotal,
    matchedNoCostCount,
    itemsWithoutCost: withoutOut,
    topCostItems: topOut,
    warnings,
    notes,
  };
}
