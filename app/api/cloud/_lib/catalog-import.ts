// ============================================================================
// Единая серверная точка автодобавления ОТСУТСТВУЮЩИХ товаров в каталог
// себестоимости (таблица products). Используют оба пользовательских сценария:
//   • XLSX «Отчёт по начислениям» → POST /api/cloud/products/import-missing;
//   • API-расчёт → POST /api/ozon/save-calculation (до consume и сохранения).
// Ручной импорт из отправлений (/api/ozon/import-missing-products) тоже идёт сюда,
// так что запись в products в этой части кода ОДНА.
//
// ПРАВИЛА (те же, что у расчётов: сопоставление по артикулу, без fuzzy):
//   • ключ товара — нормализованный артикул/offer_id (trim + lower + схлопывание
//     пробелов) ↔ products.sku; каталог хранит sku = артикул продавца;
//   • добавляем ТОЛЬКО отсутствующие товары: sku = артикул (как в отчёте), name =
//     название из источника (иначе артикул), cost_price = 0 — по текущему контракту
//     каталога (NOT NULL default 0; «не указана» = 0, валидна только > 0);
//   • существующие строки не читаются на запись: ни update, ни upsert; их
//     себестоимость и название не перезаписываются;
//   • не объединяем «наугад»: если в каталоге УЖЕ несколько строк с этим артикулом
//     или в запросе под одним артикулом разные Ozon-SKU — товар НЕ добавляется и
//     не сливается, он попадает в ambiguous с причиной; без артикула добавить
//     нельзя (noArticle);
//   • user_id — ТОЛЬКО параметр вызывающего route (из проверенного токена), тело
//     запроса его не несёт и не влияет.
//
// ДУБЛИКАТЫ. В таблице нет уникального индекса (user_id, sku), поэтому защита
// прикладная, в два слоя:
//   1) сериализация: запросы одного пользователя в этом процессе выполняются
//      строго по очереди, внутри очереди каталог перечитывается ЗАНОВО — повторный
//      и одновременный запрос видит строки предыдущего и ничего не добавляет;
//   2) проверка после вставки: каталог перечитывается, и если под тем же артикулом
//      оказалась параллельно созданная строка (другой процесс / другой писатель),
//      остаётся самая ранняя (created_at, затем id), а наши свежие строки с
//      cost_price = 0 удаляются. Остаточный риск — только при нескольких инстансах
//      и пересечении коммитов в узком окне; полностью закрывается уникальным
//      индексом в БД (это отдельная миграция, здесь не применяется).
//
// Ничего не считает, consume не вызывает, calculations/report_history не трогает.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

/** Товар-кандидат из источника (XLSX / отчёт реализации / отправления). */
export type CatalogImportCandidate = {
  /** Артикул продавца (offer_id). Пусто → добавить нельзя. */
  offerId: string;
  /** Ozon SKU (если есть) — только для распознавания конфликтов, в каталог не пишется. */
  sku?: string;
  /** Название из источника. */
  name?: string;
};

export type AmbiguousReason = "catalog_duplicates" | "conflicting_sku";

export type CatalogImportPlan = {
  toCreate: Array<{ sku: string; name: string }>;
  alreadyInCatalog: number;
  ambiguous: Array<{ article: string; reason: AmbiguousReason }>;
  noArticle: number;
  invalid: number;
};

export type CatalogImportOk = {
  ok: true;
  /** Реально созданные строки (после проверки на гонки). */
  created: Array<{ sku: string; name: string }>;
  alreadyInCatalog: number;
  ambiguous: Array<{ article: string; reason: AmbiguousReason }>;
  noArticle: number;
  invalid: number;
  /** Сколько наших строк удалено как дубликат параллельно созданной. */
  duplicatesRemoved: number;
  /** Не удалось убрать найденные дубликаты (данные целы, но строк больше одной). */
  cleanupFailed: boolean;
};

export type CatalogImportFail = {
  ok: false;
  error: string;
  /** Что успело записаться до сбоя (повтор безопасен — существующие пропускаются). */
  created: Array<{ sku: string; name: string }>;
};

export type CatalogImportResult = CatalogImportOk | CatalogImportFail;

const MAX_CANDIDATES = 5000;
const MAX_ARTICLE_LEN = 200;
const MAX_NAME_LEN = 300;
const INSERT_CHUNK = 500;
const PAGE = 1000;

/** Нормализация артикула для матчинга — ровно как в расчётах (normArticleKey / normArticle). */
export function normArticle(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

type CatalogRowLite = { id?: string; sku: string | null };

/**
 * Чистое планирование: что добавить, что уже есть, что неоднозначно. Ни сети, ни БД.
 * Порядок toCreate — порядок первого появления артикула в списке кандидатов.
 */
export function planCatalogImport(
  candidates: readonly CatalogImportCandidate[],
  catalog: readonly CatalogRowLite[]
): CatalogImportPlan {
  // Сколько строк каталога соответствует нормализованному артикулу.
  const catCount = new Map<string, number>();
  for (const c of catalog) {
    const key = normArticle(c.sku);
    if (key) catCount.set(key, (catCount.get(key) ?? 0) + 1);
  }

  type Group = { article: string; name: string; skus: Set<string> };
  const groups = new Map<string, Group>();
  let noArticle = 0;
  let invalid = 0;
  for (const c of candidates) {
    const article = typeof c.offerId === "string" ? c.offerId.trim() : "";
    const key = normArticle(article);
    if (!key) {
      noArticle++;
      continue;
    }
    if (article.length > MAX_ARTICLE_LEN) {
      invalid++;
      continue;
    }
    let g = groups.get(key);
    if (!g) {
      g = { article, name: "", skus: new Set() };
      groups.set(key, g);
    }
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!g.name && name) g.name = name;
    const sku = typeof c.sku === "string" ? normArticle(c.sku) : "";
    if (sku) g.skus.add(sku);
  }

  const plan: CatalogImportPlan = { toCreate: [], alreadyInCatalog: 0, ambiguous: [], noArticle, invalid };
  for (const [key, g] of groups) {
    const inCatalog = catCount.get(key) ?? 0;
    if (inCatalog > 1) {
      plan.ambiguous.push({ article: g.article, reason: "catalog_duplicates" });
    } else if (inCatalog === 1) {
      plan.alreadyInCatalog++;
    } else if (g.skus.size > 1) {
      plan.ambiguous.push({ article: g.article, reason: "conflicting_sku" });
    } else {
      plan.toCreate.push({ sku: g.article, name: (g.name || g.article).slice(0, MAX_NAME_LEN) });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Сериализация запросов одного пользователя в рамках процесса.
// ---------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(userId, tail);
  void tail.then(() => {
    if (chains.get(userId) === tail) chains.delete(userId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Работа с БД (service-role клиент; user_id из токена, передаётся вызывающим).
// ---------------------------------------------------------------------------

type ProductRow = { id: string; sku: string | null; name: string | null; cost_price: number | null; created_at: string | null };

async function readCatalog(admin: SupabaseClient, userId: string): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("products")
      .select("id, sku, name, cost_price, created_at")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message || "Ошибка чтения каталога");
    const page = (data ?? []) as ProductRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/** Самая ранняя строка группы: по created_at, затем по id — одинаково для всех писателей. */
function earlier(a: ProductRow, b: ProductRow): boolean {
  const ta = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
  const tb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb;
  return a.id < b.id;
}

async function importLocked(
  admin: SupabaseClient,
  userId: string,
  candidates: readonly CatalogImportCandidate[]
): Promise<CatalogImportResult> {
  let catalog: ProductRow[];
  try {
    catalog = await readCatalog(admin, userId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Ошибка чтения каталога", created: [] };
  }

  const plan = planCatalogImport(candidates, catalog);
  const insertedIds = new Set<string>();
  const insertedByKey = new Map<string, { sku: string; name: string }>();

  // ---- вставка только новых строк (sku = артикул, cost_price = 0) ----
  for (let i = 0; i < plan.toCreate.length; i += INSERT_CHUNK) {
    const chunk = plan.toCreate.slice(i, i + INSERT_CHUNK);
    const rows = chunk.map((p) => ({ user_id: userId, sku: p.sku, name: p.name, cost_price: 0 }));
    let inserted: ProductRow[] = [];
    let insErr: { message?: string } | null = null;
    try {
      const res = await admin.from("products").insert(rows).select("id, sku, name, cost_price, created_at");
      insErr = res.error;
      inserted = (res.data ?? []) as ProductRow[];
    } catch (e) {
      insErr = { message: e instanceof Error ? e.message : "Ошибка записи" };
    }
    if (insErr) {
      // Уже вставленные чанки остаются (это новые товары с cost 0); повтор их пропустит.
      // Проверка гонок здесь не нужна: ошибка честно возвращается вызывающему.
      const created = plan.toCreate.slice(0, i).filter((p) => insertedByKey.has(normArticle(p.sku)));
      return { ok: false, error: insErr.message || "Не удалось добавить товары в каталог", created };
    }
    for (const r of inserted) {
      if (r.id) insertedIds.add(r.id);
      if (r.sku) insertedByKey.set(normArticle(r.sku), { sku: r.sku, name: r.name ?? "" });
    }
    // Если БД вернула меньше строк, чем вставили (RLS/политики) — не выдаём за успех.
    if (inserted.length !== chunk.length) {
      return {
        ok: false,
        error: "Каталог подтвердил не все добавленные товары",
        created: plan.toCreate.slice(0, i + inserted.length).filter((p) => insertedByKey.has(normArticle(p.sku))),
      };
    }
  }

  // ---- проверка после вставки: параллельно созданные дубликаты ----
  let duplicatesRemoved = 0;
  let cleanupFailed = false;
  if (insertedIds.size > 0) {
    try {
      const after = await readCatalog(admin, userId);
      const byKey = new Map<string, ProductRow[]>();
      for (const r of after) {
        const key = normArticle(r.sku);
        if (!key) continue;
        const arr = byKey.get(key);
        if (arr) arr.push(r);
        else byKey.set(key, [r]);
      }
      const toDelete: string[] = [];
      for (const group of byKey.values()) {
        if (group.length < 2 || !group.some((r) => insertedIds.has(r.id))) continue;
        let survivor = group[0];
        for (const r of group) if (earlier(r, survivor)) survivor = r;
        for (const r of group) {
          // Удаляем только СВОИ ещё нетронутые строки (cost 0), не самую раннюю в группе.
          if (r.id !== survivor.id && insertedIds.has(r.id) && (r.cost_price ?? 0) === 0) toDelete.push(r.id);
        }
      }
      if (toDelete.length > 0) {
        const { error } = await admin.from("products").delete().in("id", toDelete).eq("user_id", userId).eq("cost_price", 0);
        if (error) cleanupFailed = true;
        else {
          duplicatesRemoved = toDelete.length;
          for (const id of toDelete) insertedIds.delete(id);
          for (const r of after) if (toDelete.includes(r.id)) insertedByKey.delete(normArticle(r.sku));
        }
      }
    } catch {
      cleanupFailed = true;
    }
  }

  const created = plan.toCreate
    .filter((p) => insertedByKey.has(normArticle(p.sku)))
    .map((p) => ({ sku: p.sku, name: p.name }));

  return {
    ok: true,
    created,
    alreadyInCatalog: plan.alreadyInCatalog,
    ambiguous: plan.ambiguous,
    noArticle: plan.noArticle,
    invalid: plan.invalid,
    duplicatesRemoved,
    cleanupFailed,
  };
}

/**
 * Добавить в каталог пользователя отсутствующие товары. Никогда не бросает.
 * `serialize: false` — только для тестов (имитация другого процесса).
 */
export async function importMissingCatalogProducts(
  admin: SupabaseClient,
  userId: string,
  candidates: readonly CatalogImportCandidate[],
  opts?: { serialize?: boolean }
): Promise<CatalogImportResult> {
  if (!userId) return { ok: false, error: "Не определён пользователь", created: [] };
  if (candidates.length > MAX_CANDIDATES) {
    return { ok: false, error: `Слишком много товаров за один запрос (максимум ${MAX_CANDIDATES})`, created: [] };
  }
  const run = () => importLocked(admin, userId, candidates);
  try {
    return opts?.serialize === false ? await run() : await withUserLock(userId, run);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Не удалось добавить товары в каталог", created: [] };
  }
}
