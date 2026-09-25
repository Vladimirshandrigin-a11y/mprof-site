#!/usr/bin/env node
// Запуск тестов расчёта по «Отчёту по начислениям»:  npm run test:accrual
//
// 1) компилирует РЕАЛЬНЫЕ модули проекта (TypeScript → CommonJS) во временную
//    папку node_modules/.cache/accrual-tests/build (не попадает в git);
// 2) запускает встроенный раннер `node --test` по tests/accrual/*.test.mjs.
//
// Нужны только установленные зависимости проекта (`npm ci`) и Node.js 20+.
// Ни сети, ни Python, ни файлов вне репозитория не требуется.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const buildDir = path.join(repoRoot, "node_modules", ".cache", "accrual-tests", "build");
const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Нужен Node.js 20+ (сейчас ${process.versions.node}).`);
  process.exit(2);
}
if (!existsSync(tscBin) || !existsSync(path.join(repoRoot, "node_modules", "xlsx"))) {
  console.error("Зависимости не установлены. Выполните `npm ci` в корне репозитория.");
  process.exit(2);
}

// Модули под тестом (остальные подтянутся по импортам).
const SOURCES = [
  "app/app/lib/report-parsers/accrual-xlsx-parser.ts",
  "app/app/lib/report-parsers/xlsx-safe-read.ts",
  "app/app/lib/report-parsers/ozon-parser.ts",
  "app/app/lib/accrual/profit-calc.ts",
  "app/app/lib/accrual/product-analytics.ts",
  "app/app/lib/accrual/buckets.ts",
  "app/app/lib/accrual/money.ts",
  "app/app/lib/accrual/format.ts",
  "app/app/lib/accrual/snapshot.ts",
  "app/app/lib/accrual/pdf-model.ts",
  "app/app/lib/product-breakdown-calc.ts",
];

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log("Компиляция модулей проекта (tsc → CommonJS)…");
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    "--outDir", buildDir,
    "--rootDir", "app/app/lib",
    "--module", "commonjs",
    "--target", "es2019",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--skipLibCheck",
    "--strict",
    ...SOURCES,
  ],
  { cwd: repoRoot, stdio: "inherit" }
);
if (tsc.status !== 0) {
  console.error("Компиляция не удалась — тесты не запущены.");
  process.exit(tsc.status ?? 1);
}

const tests = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => path.join(here, f));

const res = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...tests], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ACCRUAL_BUILD_DIR: buildDir },
});
process.exit(res.status ?? 1);
