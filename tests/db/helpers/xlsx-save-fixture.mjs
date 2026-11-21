import assert from "node:assert/strict";
import { accrualRow, buildReport } from "../../accrual/helpers/fixtures.mjs";
import { buildRequire } from "./pay-db.mjs";

const { parseAccrualXlsxBuffer } = buildRequire("./app/lib/report-parsers/accrual-xlsx-parser.js");
const { evaluateAccrual } = buildRequire("./app/lib/accrual/upload-session.js");
const columns = buildRequire("./app/lib/accrual/columns.js");

export function xlsxSaveFixture({
  rows = [accrualRow("2026-06-10", "Продажи", "Выручка", "ART-A", 1, "850.00", "S-1")],
  article = "ART-A", taxPercent = "7", cost = 100, packaging = "40.50", ads = "",
  generatedAt = "2026-07-01T10:00:00.000Z",
} = {}) {
  const parsed = parseAccrualXlsxBuffer(buildReport(rows));
  assert.equal(parsed.ok, true);
  const report = parsed.report;
  const result = evaluateAccrual({
    report: { rows: report.rows, period: report.period, warnings: parsed.warnings,
      sheet: report.sheetName, rowCount: report.summary.rowCount },
    catalog: [{ sku: article, name: "Test item", cost_price: cost }],
    inputs: { taxPercent, packaging, deliveryToWarehouse: "", salary: "", other: "", adsOutsideOzon: ads },
    generatedAt,
  });
  assert.equal(result.readyToSave, true);
  return {
    calculation: columns.accrualSnapshotToCalculationColumns(result.snapshot),
    history: columns.accrualSnapshotToReportHistoryColumns(result.snapshot),
  };
}
