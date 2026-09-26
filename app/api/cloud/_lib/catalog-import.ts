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
//   • существующие строки НИКОГДА не меняются и не удаляются: вставка идёт как
//     INSERT … ON CONFLICT (user_id, sku_key) DO NOTHING — при совпадении ключа
//     строка просто не вставляется; update/delete здесь нет вовсе;
//   • не объединяем «наугад»: если в каталоге УЖЕ несколько строк с этим артикулом
//     или в запросе под одним артикулом разные Ozon-SKU — товар НЕ добавляется и
//     не сливается, он попадает в ambiguous с причиной; без артикула добавить
//     нельзя (noArticle);
//   • user_id — ТОЛЬКО параметр вызывающего route (из проверенного токена), тело
//     запроса его не несёт и не влияет.
//
// ДУБЛИКАТЫ — гарантия БД (миграция supabase/migrations/20260926_products_article_unique.sql):
//   колонка products.sku_key = canonical_article(sku) (та же нормализация, что у
//   расчёта) + уникальный индекс (user_id, sku_key). Одновременные запросы из разных
//   инстансов и любые другие пути записи не могут создать вторую строку артикула;
//   проигравший INSERT … ON CONFLICT DO NOTHING ждёт победителя и ничего не вставляет.
//   После вставки каталог перечитывается ТОЛЬКО для подтверждения: каждый товар плана
//   либо вставлен нами, либо уже есть (создан параллельно) — иначе это не успех.
//   Очередь запросов пользователя внутри процесса — лишь оптимизация (меньше пустых
//   конфликтов), а не защита.
//   Без миграции автодобавление НЕ выполняется: ошибка «миграция не применена»,
//   приблизительной защиты вместо гарантии БД нет.
//
// Существующие дубликаты каталога (если есть) не чистятся и не объединяются: это
// решение владельца по данным (см. supabase/checks/products_article_conflicts.sql).
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

/**
 * catalog_duplicates — в каталоге уже несколько строк с этим артикулом;
 * conflicting_sku — в источнике у артикула разные Ozon SKU;
 * catalog_conflict — БД считает артикул уже существующим, а расчётная нормализация его
 *   не находит (расхождение регистра на экзотических символах): не добавляем и не сливаем.
 */
export type AmbiguousReason = "catalog_duplicates" | "conflicting_sku" | "catalog_conflict";

export type CatalogImportPlan = {
  toCreate: Array<{ sku: string; name: string }>;
  alreadyInCatalog: number;
  ambiguous: Array<{ article: string; reason: AmbiguousReason }>;
  noArticle: number;
  invalid: number;
};

export type CatalogImportOk = {
  ok: true;
  /** Строки, которые вставил именно этот запрос. */
  created: Array<{ sku: string; name: string }>;
  /** Уже были в каталоге (в том числе созданные параллельным запросом). */
  alreadyInCatalog: number;
  ambiguous: Array<{ article: string; reason: AmbiguousReason }>;
  noArticle: number;
  invalid: number;
};

export type CatalogImportFail = {
  ok: false;
  error: string;
  /** Код ошибки: migration_missing — не применена миграция уникальности (ничего не вставлено). */
  code?: "migration_missing";
  /** Что успело записаться до сбоя (повтор безопасен — существующие пропускаются). */
  created: Array<{ sku: string; name: string }>;
};

export type CatalogImportResult = CatalogImportOk | CatalogImportFail;

const MAX_CANDIDATES = 5000;
const MAX_ARTICLE_LEN = 200;
const MAX_NAME_LEN = 300;
const INSERT_CHUNK = 500;
const PAGE = 1000;
const INSERT_ATTEMPTS = 3;
/** deadlock_detected / serialization_failure — повтор вставки безопасен (DO NOTHING идемпотентен). */
const RETRYABLE = new Set(["40P01", "40001"]);

/** Колонки конфликта для ON CONFLICT — уникальный индекс из миграции. */
export const PRODUCTS_CONFLICT_TARGET = "user_id,sku_key";

export const MIGRATION_MISSING_MESSAGE =
  "в базе не применена миграция уникальности артикулов (20260926_products_article_unique), автодобавление отключено";

/**
 * Ошибка PostgREST/PostgreSQL означает «нет колонки sku_key или уникального индекса под
 * ON CONFLICT» — т.е. миграция не применена (42703 undefined_column, 42P10 нет подходящего
 * ограничения, PGRST204 колонка не найдена в кэше схемы).
 */
function isMigrationMissing(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "42P10" || err.code === "PGRST204") return true;
  return /sku_key|no unique or exclusion constraint/i.test(err.message ?? "");
}

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
  const insertedKeys = new Set<string>();

  // ---- вставка только новых строк: ON CONFLICT (user_id, sku_key) DO NOTHING ----
  // Существующие строки (в том числе созданные параллельно) не меняются; в ответе
  // возвращаются ТОЛЬКО реально вставленные строки.
  // Порядок строк — по каноническому ключу: одновременные вставки пересекающихся наборов
  // берут блокировки уникального индекса в одном порядке и не образуют взаимоблокировку
  // (проверено на настоящей PostgreSQL: без сортировки — deadlock detected). Если БД всё же
  // прервёт вставку как deadlock/serialization failure, её безопасно повторить: DO NOTHING
  // идемпотентен.
  const ordered = [...plan.toCreate].sort((x, y) => {
    const a = normArticle(x.sku);
    const b = normArticle(y.sku);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (let i = 0; i < ordered.length; i += INSERT_CHUNK) {
    const chunk = ordered.slice(i, i + INSERT_CHUNK);
    const rows = chunk.map((p) => ({ user_id: userId, sku: p.sku, name: p.name, cost_price: 0 }));
    let inserted: ProductRow[] = [];
    let insErr: { code?: string; message?: string } | null = null;
    for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt++) {
      inserted = [];
      insErr = null;
      try {
        const res = await admin
          .from("products")
          .upsert(rows, { onConflict: PRODUCTS_CONFLICT_TARGET, ignoreDuplicates: true })
          .select("id, sku, name, cost_price, created_at");
        insErr = res.error;
        inserted = (res.data ?? []) as ProductRow[];
      } catch (e) {
        insErr = { message: e instanceof Error ? e.message : "Ошибка записи" };
      }
      if (!insErr || !RETRYABLE.has(insErr.code ?? "")) break;
    }
    const createdSoFar = () =>
      plan.toCreate.filter((p) => insertedKeys.has(normArticle(p.sku))).map((p) => ({ sku: p.sku, name: p.name }));
    if (insErr) {
      if (isMigrationMissing(insErr)) {
        return { ok: false, code: "migration_missing", error: MIGRATION_MISSING_MESSAGE, created: createdSoFar() };
      }
      // Уже вставленные чанки остаются (новые товары без стоимости); повтор их пропустит.
      return { ok: false, error: insErr.message || "Не удалось добавить товары в каталог", created: createdSoFar() };
    }
    for (const r of inserted) if (r.sku) insertedKeys.add(normArticle(r.sku));
  }

  // ---- подтверждение (только чтение): каждый товар плана вставлен нами или уже есть ----
  let alreadyInCatalog = plan.alreadyInCatalog;
  const ambiguous = [...plan.ambiguous];
  const notInserted = plan.toCreate.filter((p) => !insertedKeys.has(normArticle(p.sku)));
  if (notInserted.length > 0) {
    let after: ProductRow[];
    try {
      after = await readCatalog(admin, userId);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Не удалось подтвердить добавление товаров",
        created: plan.toCreate.filter((p) => insertedKeys.has(normArticle(p.sku))),
      };
    }
    const present = new Set(after.map((r) => normArticle(r.sku)).filter(Boolean));
    for (const p of notInserted) {
      // Есть в каталоге → создан параллельно (другой запрос/инстанс/пользователь вручную).
      if (present.has(normArticle(p.sku))) alreadyInCatalog++;
      // Нет ни вставки, ни строки: БД считает ключ занятым иначе, чем расчёт — не сливаем.
      else ambiguous.push({ article: p.sku, reason: "catalog_conflict" });
    }
  }

  return {
    ok: true,
    created: plan.toCreate.filter((p) => insertedKeys.has(normArticle(p.sku))),
    alreadyInCatalog,
    ambiguous,
    noArticle: plan.noArticle,
    invalid: plan.invalid,
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
