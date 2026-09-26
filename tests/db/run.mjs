#!/usr/bin/env node
// Тесты уникальности артикула каталога на НАСТОЯЩЕЙ PostgreSQL:  npm run test:db
//
// Нужна тестовая PostgreSQL 15+ (локальная / Docker / `supabase start`) и адрес в
// TEST_DATABASE_URL, например:
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
// Пользователь должен иметь право CREATE DATABASE: тест создаёт ОТДЕЛЬНУЮ временную базу
// mprof_dbtest_<случайно>, работает только в ней и удаляет её в конце. Базу из адреса
// тест не меняет. Адреса Supabase-облака отклоняются (защита от запуска на production).
//
// 1) компилирует общую функцию импорта (TypeScript → CommonJS) во временную папку;
// 2) запускает `node --test` по tests/db/*.test.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const buildDir = path.join(repoRoot, "node_modules", ".cache", "db-tests", "build");
const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error(
    "TEST_DATABASE_URL не задан — тест на настоящей БД НЕ выполнен.\n" +
      "Пример: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db"
  );
  process.exit(2);
}
if (/supabase\.(co|com|net)|pooler\./i.test(url)) {
  console.error("TEST_DATABASE_URL указывает на Supabase-облако — отказ (тест только для локальной/тестовой БД).");
  process.exit(2);
}
if (!existsSync(tscBin) || !existsSync(path.join(repoRoot, "node_modules", "pg"))) {
  console.error("Зависимости не установлены. Выполните `npm ci` в корне репозитория.");
  process.exit(2);
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    "--outDir", buildDir,
    "--rootDir", "app",
    "--module", "commonjs",
    "--target", "es2019",
    "--moduleResolution", "node",
    "--esModuleInterop",
    "--skipLibCheck",
    "--strict",
    "app/api/cloud/_lib/catalog-import.ts",
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
const res = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-concurrency=1", ...tests], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, DB_TEST_BUILD_DIR: buildDir },
});
process.exit(res.status ?? 1);
