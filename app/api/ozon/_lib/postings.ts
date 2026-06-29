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
  /**
   * Статус отправления Ozon в нижнем регистре (delivered/cancelled/delivering/…).
   * "" если Ozon не вернул статус. ТОЛЬКО для диагностики разбивки себестоимости
   * по статусам (aggregateCostByStatus) — боевой расчёт (aggregateProfitCostDraft)
   * это поле НЕ читает и поведение НЕ меняет.
   */
  status: string;
};

type PostingsFetch =
  | {
      ok: true;
      items: OzonPostingItem[];
      postingCount: number;
      partial: boolean;
      /** Кол-во отправлений по нормализованному статусу (для диагностики). */
      statusPostingCounts: Record<string, number>;
    }
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
  /** Кол-во отправлений по нормализованному статусу (FBO+FBS, для диагностики). */
  statusPostingCounts: Record<string, number>;
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

/** Статус отправления → нижний регистр без пробелов по краям. "" если нет. */
function readPostingStatus(posting: unknown): string {
  const s = (posting as { status?: unknown })?.status;
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** Инкремент счётчика отправлений по статусу (для диагностики). */
function bumpStatus(counts: Record<string, number>, status: string): void {
  counts[status] = (counts[status] ?? 0) + 1;
}

function extractItems(
  products: unknown,
  scheme: "fbo" | "fbs",
  status: string
): OzonPostingItem[] {
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
    out.push({ offerId, sku, name, quantity, price: parsePrice(p.price), scheme, status });
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
  const statusPostingCounts: Record<string, number> = {};
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
      const status = readPostingStatus(posting);
      bumpStatus(statusPostingCounts, status);
      items.push(...extractItems((posting as { products?: unknown })?.products, "fbo", status));
    }

    if (postings.length < PAGE_SIZE) {
      return { ok: true, items, postingCount, partial: false, statusPostingCounts };
    }
  }
  return { ok: true, items, postingCount, partial: true, statusPostingCounts };
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
  const statusPostingCounts: Record<string, number> = {};
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
      const status = readPostingStatus(posting);
      bumpStatus(statusPostingCounts, status);
      items.push(...extractItems((posting as { products?: unknown })?.products, "fbs", status));
    }

    const hasNext = result?.has_next === true;
    if (!hasNext || postings.length === 0) {
      return { ok: true, items, postingCount, partial: false, statusPostingCounts };
    }
  }
  return { ok: true, items, postingCount, partial: true, statusPostingCounts };
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
  const statusPostingCounts: Record<string, number> = {};
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
      for (const [st, n] of Object.entries(r.statusPostingCounts)) {
        statusPostingCounts[st] = (statusPostingCounts[st] ?? 0) + n;
      }
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

  return { items, postingCount, partial, warnings, statusPostingCounts, fatalCode };
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

// ---------------------------------------------------------------------------
// ДИАГНОСТИКА (read-only): разбивка СОПОСТАВЛЕННОЙ себестоимости по статусам
// отправлений Ozon (delivered / cancelled / delivering / awaiting_* / …).
//
// Зачем: понять, из каких статусов складывается API-себестоимость и почему она
// расходится с расчётом по документам. Документы берут только РЕАЛИЗОВАННОЕ
// количество (за вычетом возвратов), а боевой API-расчёт (aggregateProfitCostDraft)
// суммирует себестоимость по ВСЕМ отправлениям всех статусов (GROSS). Эта функция
// НИЧЕГО не фильтрует и не меняет боевой расчёт — только раскладывает ту же
// сумму по статусам, чтобы измерить вклад «Отменён» / «Не доставлено».
//
// Матч идентичен боевому: offer_id↔products.sku, затем точное Ozon-sku↔products.sku,
// учитываем стоимость только при cost_price > 0. Сумма totalMatchedCost совпадает
// с matchedCostTotal из aggregateProfitCostDraft (та же логика, один round2).
// ---------------------------------------------------------------------------

/** Человеко-понятные подписи известных статусов Ozon (иначе показываем сам код). */
const STATUS_LABELS: Record<string, string> = {
  delivered: "Доставлен",
  cancelled: "Отменён",
  canceled: "Отменён",
  delivering: "В доставке",
  driver_pickup: "Передан водителю",
  awaiting_packaging: "Ожидает сборки",
  awaiting_deliver: "Ожидает отгрузки",
  awaiting_registration: "Ожидает регистрации",
  awaiting_approve: "Ожидает подтверждения",
  acceptance_in_progress: "Идёт приёмка",
  arbitration: "Арбитраж",
  client_arbitration: "Клиентский арбитраж",
  not_accepted: "Не принят на сортировке",
  sent_by_seller: "Отправлен продавцом",
};

function statusLabel(norm: string): string {
  if (!norm) return "(без статуса)";
  return STATUS_LABELS[norm] ?? norm;
}

/** Строка разбивки себестоимости по одному статусу отправлений. */
export type CostStatusRow = {
  /** Нормализованный код статуса ("delivered", "cancelled", "" — без статуса). */
  status: string;
  /** Человеко-понятная подпись (RU) либо сам код, если статус неизвестен. */
  label: string;
  /** Сколько отправлений Ozon с этим статусом (FBO+FBS). */
  postingCount: number;
  /** Суммарное количество единиц во всех позициях статуса. */
  itemsQuantity: number;
  /** Из них единиц с учтённой себестоимостью (сопоставлены, cost_price>0). */
  matchedQuantity: number;
  /** Единиц без учёта стоимости (не сопоставлены или cost_price=0). */
  unmatchedQuantity: number;
  /** Σ quantity×cost по сопоставленным позициям статуса, ₽ (round2). */
  matchedCost: number;
  /** Доля matchedCost от total (0..1, round4). */
  shareOfMatchedCost: number;
};

/** Итог разбивки себестоимости по статусам отправлений (диагностика). */
export type CostByStatus = {
  /** Σ сопоставленной себестоимости по всем статусам (= боевой matchedCostTotal). */
  totalMatchedCost: number;
  /** Σ единиц с учтённой себестоимостью. */
  totalMatchedQuantity: number;
  /** Себестоимость доставленных (status === "delivered"). */
  deliveredMatchedCost: number;
  /** Себестоимость отменённых (status содержит "cancel"). */
  cancelledMatchedCost: number;
  /** Себестоимость НЕ доставленных = total − delivered (включает «Отменён» и в пути). */
  nonDeliveredMatchedCost: number;
  /** Разбивка по каждому статусу, отсортирована по себестоимости (убыв.). */
  rows: CostStatusRow[];
  notes: string[];
};

/**
 * Разложить сопоставленную себестоимость отправлений по статусам Ozon.
 * Чистая функция: в БД не ходит, ничего не сохраняет, боевой расчёт не трогает.
 */
export function aggregateCostByStatus(
  items: OzonPostingItem[],
  statusPostingCounts: Record<string, number>,
  catalog: CatalogRow[]
): CostByStatus {
  // Индекс каталога по нормализованному products.sku → cost_price (как в остальных функциях).
  const catIndex = new Map<string, number>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (!key || catIndex.has(key)) continue;
    catIndex.set(
      key,
      typeof c.cost_price === "number" && Number.isFinite(c.cost_price) ? c.cost_price : 0
    );
  }

  // Себестоимость единицы товара или null, если товар не сопоставлен с каталогом.
  const lookupCost = (it: OzonPostingItem): number | null => {
    if (it.offerId) {
      const v = catIndex.get(normArticle(it.offerId));
      if (v != null) return v;
    }
    if (it.sku) {
      const v = catIndex.get(normArticle(it.sku));
      if (v != null) return v;
    }
    return null;
  };

  type Acc = {
    postingCount: number;
    itemsQuantity: number;
    matchedQuantity: number;
    unmatchedQuantity: number;
    matchedCostRaw: number;
  };
  const groups = new Map<string, Acc>();
  const ensure = (norm: string): Acc => {
    let g = groups.get(norm);
    if (!g) {
      g = {
        postingCount: 0,
        itemsQuantity: 0,
        matchedQuantity: 0,
        unmatchedQuantity: 0,
        matchedCostRaw: 0,
      };
      groups.set(norm, g);
    }
    return g;
  };

  // Счётчики отправлений по статусам (чтобы статус без позиций тоже был виден).
  for (const [norm, n] of Object.entries(statusPostingCounts)) {
    ensure(norm).postingCount += n;
  }

  let totalMatchedRaw = 0;
  let totalMatchedQuantity = 0;
  for (const it of items) {
    const norm = (it.status ?? "").trim().toLowerCase();
    const g = ensure(norm);
    g.itemsQuantity += it.quantity;
    const cost = lookupCost(it);
    if (cost != null && cost > 0 && Number.isFinite(cost)) {
      g.matchedQuantity += it.quantity;
      g.matchedCostRaw += it.quantity * cost;
      totalMatchedRaw += it.quantity * cost;
      totalMatchedQuantity += it.quantity;
    } else {
      g.unmatchedQuantity += it.quantity;
    }
  }

  const totalMatchedCost = round2(totalMatchedRaw);

  const rows: CostStatusRow[] = [];
  let deliveredRaw = 0;
  let cancelledRaw = 0;
  for (const [norm, g] of groups.entries()) {
    if (norm === "delivered") deliveredRaw += g.matchedCostRaw;
    if (norm.includes("cancel")) cancelledRaw += g.matchedCostRaw;
    rows.push({
      status: norm,
      label: statusLabel(norm),
      postingCount: g.postingCount,
      itemsQuantity: g.itemsQuantity,
      matchedQuantity: g.matchedQuantity,
      unmatchedQuantity: g.unmatchedQuantity,
      matchedCost: round2(g.matchedCostRaw),
      shareOfMatchedCost:
        totalMatchedRaw > 0
          ? Math.round((g.matchedCostRaw / totalMatchedRaw) * 10000) / 10000
          : 0,
    });
  }

  // Дорогие статусы сверху, затем по количеству единиц.
  rows.sort((a, b) => b.matchedCost - a.matchedCost || b.itemsQuantity - a.itemsQuantity);

  const notes: string[] = [];
  if (items.length === 0) {
    notes.push("За выбранный месяц отправления Ozon не найдены — раскладывать по статусам нечего.");
  } else {
    notes.push(
      "Разбивка себестоимости по статусам — диагностика. «Доставлен» — выручка по этим отправлениям признана; «Отменён» и прочие НЕ доставленные статусы в расчёте по документам отсутствуют. Боевой API-расчёт сейчас берёт ВСЕ статусы (GROSS) — отсюда расхождение с документами."
    );
    notes.push(
      "«Не доставлено» = вся сопоставленная себестоимость минус «Доставлен» (включает «Отменён» и товары в пути/ожидании)."
    );
  }

  return {
    totalMatchedCost,
    totalMatchedQuantity,
    deliveredMatchedCost: round2(deliveredRaw),
    cancelledMatchedCost: round2(cancelledRaw),
    nonDeliveredMatchedCost: round2(totalMatchedRaw - deliveredRaw),
    rows,
    notes,
  };
}

// ---------------------------------------------------------------------------
// PR #17: план импорта несопоставленных товаров в каталог себестоимости.
//   • матч — тот же, что в диагностике: offer_id↔products.sku, затем точное
//     Ozon-sku↔products.sku, без fuzzy;
//   • товар уже в каталоге (matched) → skippedExisting (НЕ трогаем, не дублируем);
//   • не сопоставлен и БЕЗ offer_id → skippedNoOfferId (нельзя надёжно связать);
//   • не сопоставлен и С offer_id → eligible (кандидат: новый товар sku = offer_id).
// Чистая функция: в БД НЕ ходит, себестоимость НЕ выдумывает, ничего не пишет.
// Реальный insert и подсчёт created делает route.
// ---------------------------------------------------------------------------

/** Кандидат на добавление в каталог: новый товар sku = offer_id, name из Ozon. */
export type ImportEligibleItem = {
  offerId: string;
  name: string;
};

/** Пропущенный товар (уже в каталоге или без offer_id). */
export type ImportSkippedItem = {
  offerId?: string;
  sku?: string;
  name?: string;
  reason: string;
};

export type MissingProductsPlan = {
  /** Уникальных товаров Ozon, которых НЕТ в каталоге (eligible + без offer_id). */
  unmatchedFromOzon: number;
  /** Не сопоставлены и есть offer_id — кандидаты на insert. */
  eligible: ImportEligibleItem[];
  /** Уже есть в каталоге (matched) — пропускаем: не дублируем и не перезаписываем. */
  skippedExisting: ImportSkippedItem[];
  /** Не сопоставлены и нет offer_id — пропускаем (нельзя надёжно связать). */
  skippedNoOfferId: ImportSkippedItem[];
  warnings: string[];
  notes: string[];
};

/**
 * Спланировать, какие товары из Ozon postings нужно добавить в каталог.
 * Тот же матчинг, что в диагностике (offer_id↔products.sku, затем точное
 * Ozon-sku↔products.sku, без fuzzy). Никакой выдуманной себестоимости и
 * никакой записи в БД — только классификация. Реальный insert делает route.
 */
export function planMissingProductsImport(
  items: OzonPostingItem[],
  fetchWarnings: string[],
  catalog: CatalogRow[]
): MissingProductsPlan {
  const warnings = [...fetchWarnings];
  const notes: string[] = [];

  // Индекс существующих артикулов каталога (по нормализованному products.sku).
  const catIndex = new Set<string>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (key) catIndex.add(key);
  }

  // Свести позиции в уникальные товары (offer_id → sku → без идентификатора).
  // Агрегация гарантирует, что один offer_id даст ровно один кандидат (без дублей).
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

  const eligible: ImportEligibleItem[] = [];
  const skippedExisting: ImportSkippedItem[] = [];
  const skippedNoOfferId: ImportSkippedItem[] = [];

  for (const a of agg.values()) {
    // Уже в каталоге? Матч: offer_id↔products.sku, затем точное Ozon-sku↔products.sku. Без fuzzy.
    let inCatalog = false;
    if (a.offerId && catIndex.has(normArticle(a.offerId))) {
      inCatalog = true;
    } else if (a.sku && catIndex.has(normArticle(a.sku))) {
      inCatalog = true;
    }

    if (inCatalog) {
      // Товар уже есть — пропускаем, существующую строку не трогаем (ни cost, ни name).
      skippedExisting.push({
        ...(a.offerId ? { offerId: a.offerId } : {}),
        ...(a.sku ? { sku: a.sku } : {}),
        ...(a.name ? { name: a.name } : {}),
        reason: "Уже есть в каталоге — пропущен, существующий товар не изменён",
      });
      continue;
    }

    // Не в каталоге, но без offer_id — надёжно связать нельзя, не добавляем.
    if (!a.offerId) {
      skippedNoOfferId.push({
        ...(a.sku ? { sku: a.sku } : {}),
        ...(a.name ? { name: a.name } : {}),
        reason: "Нет артикула (offer_id) — нельзя надёжно связать с каталогом, не добавлен",
      });
      continue;
    }

    // Не в каталоге и есть offer_id — кандидат на добавление (sku = offer_id).
    eligible.push({
      offerId: a.offerId,
      name: a.name.trim() || a.offerId,
    });
  }

  // Стабильный, предсказуемый порядок кандидатов — по названию.
  eligible.sort((x, y) => x.name.localeCompare(y.name, "ru"));

  const unmatchedFromOzon = eligible.length + skippedNoOfferId.length;

  // Пояснения / предупреждения.
  if (catIndex.size === 0) {
    notes.push(
      "Каталог себестоимости пуст — будут добавлены все товары Ozon с артикулом."
    );
  }
  if (skippedNoOfferId.length > 0) {
    warnings.push(
      `Товаров без артикула (offer_id) пропущено: ${skippedNoOfferId.length}. Их нельзя надёжно связать с каталогом — добавьте вручную при необходимости.`
    );
  }
  if (eligible.length === 0) {
    notes.push(
      "Несопоставленных товаров с артикулом нет — все товары Ozon уже есть в каталоге, добавление не требуется."
    );
  } else {
    notes.push(
      "Добавляются только товары, которых ещё нет в каталоге. Существующие товары не изменяются, себестоимость НЕ выдумывается — её нужно заполнить вручную."
    );
  }

  return {
    unmatchedFromOzon,
    eligible,
    skippedExisting,
    skippedNoOfferId,
    warnings,
    notes,
  };
}
