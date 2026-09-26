// Сборка снимка нового вида из НАСТОЯЩИХ парсера и ядра на синтетическом отчёте.

import assert from "node:assert/strict";
import { scenario } from "./fixtures.mjs";
import { CAT } from "./expected.mjs";
import { calc, parseBuf, snapshot } from "./modules.mjs";

export const GENERATED_AT = "2026-07-01T10:00:00.000Z";

export function buildSnapshotFor(
  name = "basic",
  { catalog = CAT, taxRatePercent = 7, manualExpenses = { packaging: 10, other: 3.33 } } = {}
) {
  const parsed = parseBuf(scenario(name));
  assert.equal(parsed.ok, true, parsed.ok ? "" : JSON.stringify(parsed.errors));
  const res = calc.computeAccrualProfit({ report: parsed.report, catalog, taxRatePercent, manualExpenses });
  assert.equal(res.ok, true, res.ok ? "" : JSON.stringify(res.error));
  const snap = snapshot.buildAccrualSnapshot({
    calc: res.calc,
    period: parsed.report.period,
    warnings: parsed.warnings,
    source: { sheet: parsed.report.sheetName, rowCount: parsed.report.summary.rowCount },
    generatedAt: GENERATED_AT,
  });
  return { snapshot: snap, parsed, calc: res.calc };
}

/** Как из БД: сериализация в JSON и обратно. */
export const viaJson = (obj) => JSON.parse(JSON.stringify(obj));

/** Снимок «как сохранённый до разделения результата»: без salesSplit и split у товаров. */
export function toLegacy(snap) {
  const x = viaJson(snap);
  delete x.salesSplit;
  for (const p of x.products) delete p.split;
  return x;
}
