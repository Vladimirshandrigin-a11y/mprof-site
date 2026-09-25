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

if (!existsSync(path.join(BUILD_DIR, "accrual", "profit-calc.js"))) {
  throw new Error(
    `Скомпилированные модули не найдены в ${BUILD_DIR}. Запустите тесты командой: npm run test:accrual`
  );
}

// createRequire от файла в BUILD_DIR: относительные require и `xlsx` (node_modules
// репозитория выше по дереву) резолвятся так же, как в приложении.
const req = createRequire(path.join(BUILD_DIR, "loader.js"));

export const parser = req("./report-parsers/accrual-xlsx-parser.js");
export const safeRead = req("./report-parsers/xlsx-safe-read.js");
export const oldParser = req("./report-parsers/ozon-parser.js");
export const calc = req("./accrual/profit-calc.js");
export const money = req("./accrual/money.js");
export const buckets = req("./accrual/buckets.js");
export const analytics = req("./accrual/product-analytics.js");
export const XLSX = req("xlsx");

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
