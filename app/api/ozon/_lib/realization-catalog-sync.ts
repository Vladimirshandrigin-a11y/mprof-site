// ============================================================================
// Автодобавление товаров из ОТЧЁТА О РЕАЛИЗАЦИИ в каталог — шаг пользовательского
// save-calculation ДО consume и сохранения расчёта.
//
// Боевая себестоимость API-расчёта берётся из отчёта реализации (сопоставление
// item.offer_id ↔ products.sku). Если часть строк реализации не сопоставлена с
// каталогом (resolution.code === "unmatched"), эти товары добавляются в каталог
// ЕДИНОЙ функцией cloud/_lib/catalog-import (cost_price = 0 — «не указана»), после
// чего расчёт останавливается как «не хватает себестоимости»: consume не вызывается,
// calculations/report_history не пишутся. Пользователь заполняет стоимость в
// каталоге и запускает расчёт снова.
//
// Источник — именно строки реализации (а не отправления): товар нужен для расчёта,
// даже если его нет в выборке postings. Здесь нет сети и Ozon-запросов: модуль
// получает уже загруженные данные и только пишет в каталог через общую функцию.
// Диагностики (fullCalcCheck и др.) этот модуль не вызывают.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { importMissingCatalogProducts, normArticle } from "../../cloud/_lib/catalog-import";
import type { RealizationCostResolution } from "./profit";
import type { RealizationUnmatchedSummary } from "./realization";

/** Что сообщаем клиенту об автодобавлении (без названий и артикулов товаров). */
export type CatalogImportSummary =
  | { attempted: false }
  | {
      attempted: true;
      ok: true;
      /** Сколько товаров добавлено в каталог. */
      created: number;
      alreadyInCatalog: number;
      /** Не добавлены из-за неоднозначного сопоставления. */
      ambiguous: number;
      /** Строк реализации без артикула — добавить нельзя. */
      rowsWithoutOfferId: number;
    }
  | {
      attempted: true;
      ok: false;
      error: string;
      /** Успело добавиться до сбоя (повтор безопасен). */
      created: number;
    };

export type RealizationCatalogSync = {
  /** Строки реализации, всё ещё не сопоставленные с каталогом. */
  unmatchedItems: number;
  /** Строки реализации, сопоставленные, но без себестоимости (0 ₽). */
  matchedNoCostCount: number;
  catalogImport: CatalogImportSummary;
};

export async function syncMissingRealizationProducts(params: {
  admin: SupabaseClient;
  /** ТОЛЬКО из проверенного токена (authenticateRequest). */
  userId: string;
  resolution: Extract<RealizationCostResolution, { ok: false }>;
  unmatched: RealizationUnmatchedSummary;
}): Promise<RealizationCatalogSync> {
  const { admin, userId, resolution, unmatched } = params;
  const base = {
    unmatchedItems: resolution.unmatchedRows,
    matchedNoCostCount: resolution.noCostRows,
  };
  // Импортируем только когда причина — несопоставленные строки и есть что добавлять.
  if (resolution.code !== "unmatched" || unmatched.products.length === 0) {
    return { ...base, catalogImport: { attempted: false } };
  }

  const res = await importMissingCatalogProducts(
    admin,
    userId,
    unmatched.products.map((p) => ({ offerId: p.offerId, sku: p.sku, name: p.name }))
  );

  const createdKeys = new Set(res.created.map((c) => normArticle(c.sku)));
  let rowsOfCreated = 0;
  for (const p of unmatched.products) if (createdKeys.has(normArticle(p.offerId))) rowsOfCreated += p.rows;
  const counts = {
    unmatchedItems: Math.max(0, resolution.unmatchedRows - rowsOfCreated),
    matchedNoCostCount: resolution.noCostRows + rowsOfCreated,
  };

  if (!res.ok) {
    return { ...counts, catalogImport: { attempted: true, ok: false, error: res.error, created: res.created.length } };
  }
  return {
    ...counts,
    catalogImport: {
      attempted: true,
      ok: true,
      created: res.created.length,
      alreadyInCatalog: res.alreadyInCatalog,
      ambiguous: res.ambiguous.length,
      rowsWithoutOfferId: unmatched.rowsWithoutOfferId,
    },
  };
}
