// Загрузка РЕАЛЬНЫХ модулей проекта, скомпилированных `tests/accrual/run.mjs`
// (tsc → node_modules/.cache/accrual-tests/build). Тесты вызывают именно их —
// никаких копий формул в тестах.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const BUILD_DIR =
  process.env.ACCRUAL_BUILD_DIR || path.join(REPO_ROOT, "node_modules", ".cache", "accrual-tests", "build");

if (!existsSync(path.join(BUILD_DIR, "app", "lib", "accrual", "profit-calc.js"))) {
  throw new Error(
    `Скомпилированные модули не найдены в ${BUILD_DIR}. Запустите тесты командой: npm run test:accrual`
  );
}

// createRequire от файла в BUILD_DIR: относительные require и `xlsx` (node_modules
// репозитория выше по дереву) резолвятся так же, как в приложении.
const req = createRequire(path.join(BUILD_DIR, "loader.js"));

export const parser = req("./app/lib/report-parsers/accrual-xlsx-parser.js");
export const safeRead = req("./app/lib/report-parsers/xlsx-safe-read.js");
export const oldParser = req("./app/lib/report-parsers/ozon-parser.js");
export const calc = req("./app/lib/accrual/profit-calc.js");
export const money = req("./app/lib/accrual/money.js");
export const buckets = req("./app/lib/accrual/buckets.js");
export const analytics = req("./app/lib/accrual/product-analytics.js");
export const snapshot = req("./app/lib/accrual/snapshot.js");
export const pdfModel = req("./app/lib/accrual/pdf-model.js");
export const format = req("./app/lib/accrual/format.js");
export const columns = req("./app/lib/accrual/columns.js");
export const session = req("./app/lib/accrual/upload-session.js");
export const saveFlow = req("./app/lib/accrual/save-flow.js");
export const salesSplit = req("./app/lib/accrual/sales-split.js");
export const guide = req("./app/lib/accrual/download-guide.js");
export const access = req("./app/lib/access-status.js");
export const XLSX = req("xlsx");

// Серверные модули (автодобавление товаров в каталог, загрузчик и маршруты на моках).
export const catalogImport = req("./api/cloud/_lib/catalog-import.js");
export const catalogSync = req("./api/ozon/_lib/realization-catalog-sync.js");
export const profitLib = req("./api/ozon/_lib/profit.js");
export const authLib = req("./api/cloud/_lib/auth.js");
export const cryptoLib = req("./api/ozon/_lib/crypto.js");
export const importRoute = req("./api/cloud/products/import-missing/route.js");
export const saveCalcRoute = req("./api/ozon/save-calculation/route.js");
export const realizationLib = req("./api/ozon/_lib/realization.js");
export const product = req("./app/lib/product-breakdown-calc.js");
export const apiCostGap = req("./app/lib/api-cost-gap.js");
export const cloudClient = req("./app/lib/supabase-cloud.js");
export const nextServer = req("next/server");
export const supabaseJs = req("@supabase/supabase-js");
export const diagnosticRoutePath = path.join(REPO_ROOT, "app", "api", "ozon", "accrual-migration-diagnostic", "route.ts");

/** Разбор XLSX-буфера настоящим парсером проекта. */
export const parseBuf = (buf) => parser.parseAccrualXlsxBuffer(new Uint8Array(buf));

/** Старый парсер вызывает много console.log — глушим на время вызова. */
export async function quietly(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}
