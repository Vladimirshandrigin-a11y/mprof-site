// ============================================================================
// Ответ save-calculation при неполной себестоимости (400 incomplete_cost): счётчики и
// итог автодобавления товаров в каталог. Чистые функции без React — их используют
// page.tsx (разбор ответа), компонент ApiCostGapNotice (показ) и тесты.
// ============================================================================

// Итог автодобавления отсутствующих товаров в каталог, который save-calculation
// присылает вместе с 400 incomplete_cost (ДО consume и сохранения). ok=false — запись
// не состоялась (успех не показываем). Названия и артикулы товаров в ответ не входят.
export type ApiCatalogImport =
  | { attempted: false }
  | {
      attempted: true;
      ok: true;
      created: number;
      alreadyInCatalog: number;
      ambiguous: number;
      rowsWithoutOfferId: number;
    }
  | { attempted: true; ok: false; error: string; created: number };

/** Мягкий разбор catalogImport из ответа сервера (чужая форма → «не выполнялось»). */
export function parseApiCatalogImport(raw: unknown): ApiCatalogImport {
  const r = raw as Record<string, unknown> | null;
  if (!r || r.attempted !== true) return { attempted: false };
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (r.ok === true) {
    return {
      attempted: true,
      ok: true,
      created: n(r.created),
      alreadyInCatalog: n(r.alreadyInCatalog),
      ambiguous: n(r.ambiguous),
      rowsWithoutOfferId: n(r.rowsWithoutOfferId),
    };
  }
  return {
    attempted: true,
    ok: false,
    error: typeof r.error === "string" && r.error ? r.error : "Сервер не подтвердил добавление",
    created: n(r.created),
  };
}

/** Состояние блока «Не хватает себестоимости» в API-режиме. */
export interface ApiCostGap {
  status?: string;
  unmatchedItems: number;
  matchedNoCostCount: number;
  catalogImport: ApiCatalogImport;
}

/** Разбор тела ответа 400 incomplete_cost (чужая форма → нули и «импорт не выполнялся»). */
export function parseApiCostGap(data: {
  status?: unknown;
  unmatchedItems?: unknown;
  matchedNoCostCount?: unknown;
  catalogImport?: unknown;
}): ApiCostGap {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    status: typeof data.status === "string" ? data.status : undefined,
    unmatchedItems: n(data.unmatchedItems),
    matchedNoCostCount: n(data.matchedNoCostCount),
    catalogImport: parseApiCatalogImport(data.catalogImport),
  };
}
