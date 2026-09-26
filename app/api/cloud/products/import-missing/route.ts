import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "../../_lib/auth";
import { importMissingCatalogProducts, type CatalogImportCandidate } from "../../_lib/catalog-import";

// ============================================================================
// POST /api/cloud/products/import-missing — автодобавление ОТСУТСТВУЮЩИХ товаров
// в каталог себестоимости (сценарий XLSX «Отчёт по начислениям»).
//
//   Тело: { products: [{ offerId, sku?, name? }, …] } — ТОЛЬКО товарные поля.
//   Файл целиком и финансовые операции сюда не передаются. Любые другие поля
//   (в том числе user_id) игнорируются.
//
// Вся логика — в общей функции cloud/_lib/catalog-import (та же, что у API-расчёта):
// добавляются только отсутствующие товары (sku = артикул, cost_price = 0), существующие
// не меняются и не удаляются; дубли исключает уникальный индекс БД (user_id, sku_key) —
// без миграции 20260926_products_article_unique ничего не вставляется (503 + код).
// user_id — ТОЛЬКО из проверенного токена.
// ============================================================================
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_PRODUCTS = 5000;

function parseCandidates(body: unknown): CatalogImportCandidate[] | null {
  const list = (body as { products?: unknown } | null)?.products;
  if (!Array.isArray(list) || list.length > MAX_PRODUCTS) return null;
  const out: CatalogImportCandidate[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as { offerId?: unknown; sku?: unknown; name?: unknown };
    if (typeof p.offerId !== "string") return null;
    out.push({
      offerId: p.offerId,
      ...(typeof p.sku === "string" ? { sku: p.sku } : {}),
      ...(typeof p.name === "string" ? { name: p.name } : {}),
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный JSON в теле запроса" }, { status: 400, headers: NO_STORE });
  }
  const candidates = parseCandidates(body);
  if (!candidates) {
    return NextResponse.json(
      { error: `Ожидается список товаров: { products: [{ offerId, sku?, name? }] }, не более ${MAX_PRODUCTS}` },
      { status: 400, headers: NO_STORE }
    );
  }

  const res = await importMissingCatalogProducts(admin, userId, candidates);
  if (!res.ok) {
    console.error("[api/cloud/products/import-missing] import failed", res.error);
    return NextResponse.json(
      {
        error: res.error || "Не удалось добавить товары в каталог",
        ...(res.code ? { code: res.code } : {}),
        data: { created: res.created.length },
      },
      { status: res.code === "migration_missing" ? 503 : 502, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    {
      data: {
        created: res.created.length,
        alreadyInCatalog: res.alreadyInCatalog,
        ambiguous: res.ambiguous.length,
        noArticle: res.noArticle,
        invalid: res.invalid,
      },
    },
    { headers: NO_STORE }
  );
}
