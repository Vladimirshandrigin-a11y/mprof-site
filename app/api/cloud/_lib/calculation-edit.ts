import { readAccrualSnapshot } from "../../../app/lib/accrual/snapshot";
import {
  accrualSnapshotToCalculationColumns,
  accrualSnapshotToReportHistoryColumns,
} from "../../../app/lib/accrual/columns";
import { computeManualColumns, parseManualInputs } from "../../../app/lib/calc-operation-keys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Only the snapshot (XLSX) or manual inputs are accepted; columns are server-derived.
 * Ownership, completed-operation linkage and immutable source are checked under
 * database locks by edit_calculation_operation. No generic field updates.
 */
export function parseCalculationEdit(body: unknown) {
  if (!isObject(body) || typeof body.id !== "string" || !UUID.test(body.id)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => !["id", "snapshot", "inputs"].includes(k))) return null;
  if (("snapshot" in body) === ("inputs" in body)) return null;
  if ("snapshot" in body) {
    const read = readAccrualSnapshot(body.snapshot);
    if (read.status !== "ok" || read.snapshot.preliminary || !read.snapshot.costCoverage.complete) return null;
    return {
      id: body.id,
      calculation: accrualSnapshotToCalculationColumns(read.snapshot),
      history: accrualSnapshotToReportHistoryColumns(read.snapshot),
    };
  }
  const parsed = parseManualInputs(body.inputs);
  if (!parsed.ok || !isObject(body.inputs) ||
      Object.keys(body.inputs).some((k) => !(k in parsed.value))) return null;
  return { id: body.id, calculation: computeManualColumns(parsed.value), history: null };
}
