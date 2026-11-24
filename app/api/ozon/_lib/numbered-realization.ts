import { createHash } from "node:crypto";
import type { RealizationFetchResult, RealizationRow, RealizationSourceError } from "./realization";

const API = "https://api-seller.ozon.ru";
const REPORTS = "/v1/report/finance/realization";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const JOB_TTL_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 45_000;
const MAX_JOBS = 64;
const FORMATS = [
  { create: "number/create", type: "finance_realization_number" },
  { create: "number/posting/create", type: "finance_realization_number_posting" },
] as const;

export type NumberedRealizationError =
  | "realization_period_unavailable"
  | "realization_report_missing"
  | "realization_reports_ambiguous"
  | "realization_pending"
  | "realization_no_activity"
  | "realization_incomplete";

type Failure = Extract<RealizationFetchResult, { ok: false }>;
type Period = { from: string; to: string };
type ReportIdentity = Period & { number: string };
type Job = {
  expiresAt: number;
  nextCheckAt: number;
  exportCodes?: string[];
  exports?: { identity: string; link: string }[];
  running?: Promise<RealizationFetchResult>;
};
const jobs = new Map<string, Job>();

class ReportError extends Error {
  constructor(readonly code: RealizationSourceError, readonly retryMs?: number) {
    super(code);
  }
}

const bad = () => new ReportError("realization_incomplete");

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad();
  return input as Record<string, unknown>;
}

function dateKey(input: unknown): string | null {
  const m = typeof input === "string" ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input) : null;
  if (!m) return null;
  const key = [m[1], m[2].padStart(2, "0"), m[3].padStart(2, "0")].join("-");
  const date = new Date(key + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : null;
}

function monthPeriod(year: number, month: number): Period {
  const from = dateKey([year, month, 1].join("-"));
  if (!from || year < 2000) throw new ReportError("realization_period_unavailable");
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(Date.now());
  // Ozon closes a calendar month on the 8th of the following month.
  const closes = new Date(Date.UTC(year, month, 8)).toISOString().slice(0, 10);
  if (today < closes) throw new ReportError("realization_period_unavailable");
  return { from, to };
}

async function post(
  path: string, body: object, headers: Record<string, string>, deadline: number
): Promise<Record<string, unknown>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ReportError("deadline");
  const res = await fetch(API + path, {
    method: "POST", body: JSON.stringify(body), headers, cache: "no-store",
    redirect: "error", signal: AbortSignal.timeout(remaining),
  });
  if (res.status === 429) {
    const value = res.headers.get("retry-after");
    const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value ?? "") - Date.now();
    if (!Number.isFinite(delay)) throw new ReportError("rate_limited", POLL_INTERVAL_MS);
    throw new ReportError("rate_limited", Math.max(POLL_INTERVAL_MS, delay));
  }
  if (res.status === 401) throw new ReportError("invalid_key");
  if (res.status === 403) throw new ReportError("forbidden");
  if (!res.ok) throw new ReportError("unavailable");
  return object(await res.json());
}

function string(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw bad();
  return input.trim();
}

function oneReport(payload: Record<string, unknown>, period: Period): ReportIdentity {
  // The documented response is a list for the requested interval, with no continuation.
  if (Object.keys(payload).some(key => key !== "reports") || !Array.isArray(payload.reports)) throw bad();
  if (payload.reports.length === 0) throw new ReportError("realization_report_missing");
  if (payload.reports.length !== 1) throw new ReportError("realization_reports_ambiguous");
  const item = object(payload.reports[0]);
  if (dateKey(item.from) !== period.from || dateKey(item.to) !== period.to) throw bad();
  return { ...period, number: string(item.number) };
}

function exportMetadata(info: Record<string, unknown>, report: ReportIdentity) {
  if (!Array.isArray(info.additional_data)) throw bad();
  const metadata = new Map<string, unknown>();
  for (const value of info.additional_data) {
    const field = object(value);
    const key = string(field.key);
    if (metadata.has(key)) throw bad();
    metadata.set(key, field.value);
  }
  const issued = dateKey(metadata.get("DocDate"));
  if (metadata.get("Number") !== report.number || dateKey(metadata.get("StartDate")) !== report.from ||
      dateKey(metadata.get("StopDate")) !== report.to || !issued || issued < report.to) throw bad();
  return JSON.stringify([issued, string(metadata.get("ReceiverInn")), string(metadata.get("CurrencySysName"))]);
}

async function download(link: unknown, deadline: number): Promise<string> {
  const url = new URL(string(link));
  if (url.origin !== "https://ir.ozone.ru" || url.username || url.password || url.hash) throw bad();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ReportError("deadline");
  // The download URL authorizes the file, so never forward seller credentials.
  const response = await fetch(url, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(remaining),
  });
  const length = Number(response.headers.get("content-length"));
  if (response.status !== 200 || response.headers.has("content-range") || !response.body ||
      !Number.isSafeInteger(length) || length < 1 || length > MAX_FILE_BYTES) throw bad();
  const reader = response.body.getReader();
  const output = Buffer.alloc(length);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > length) throw bad();
      output.set(value, offset);
      offset += value.length;
    }
  } finally {
    if (offset !== length) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (offset !== length) throw bad();
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

const REQUIRED_COLUMNS = [
  "row_number", "item_offer_id", "item_sku", "item_barcode", "item_name",
  "delivery_commission_quantity", "delivery_commission_amount",
  "return_commission_quantity", "return_commission_amount",
] as const;

function csvRecords(text: string): string[][] {
  // Require complete records. Quoted names may contain delimiters, quotes or newlines.
  const field = /(?:"((?:[^"]|"")*)"|([^,"\r\n]*))(,|\r?\n)/gy;
  const records: string[][] = [];
  let record: string[] = [];
  while (field.lastIndex < text.length) {
    const match = field.exec(text);
    if (!match) throw bad();
    record.push(match[1]?.replace(/""/g, '"') ?? match[2]);
    if (match[3] !== ",") {
      records.push(record);
      record = [];
    }
  }
  if (record.length) throw bad();
  return records;
}

function scalar(value: string, money = false): number {
  if (!(money ? /^-?\d+(?:\.\d{0,2}0*)?$/ : /^\d+$/).test(value)) throw bad();
  const number = Number(value);
  if (!Number.isSafeInteger(money ? Math.round(number * 100) : number)) throw bad();
  return number;
}

function parseReport(csv: string, posting: boolean): { rows: RealizationRow[]; controls: string[] } {
  const [head, ...records] = csvRecords(csv);
  if (!head || new Set(head).size !== head.length || REQUIRED_COLUMNS.some(name => !head.includes(name)) ||
      (posting && !head.includes("posting_posting_number"))) throw bad();

  const controls: string[] = [];
  const rows = records.map((record, index) => {
    if (record.length !== head.length) throw bad();
    const cells = Object.fromEntries(head.map((key, i) => [key, record[i]]));
    if (scalar(cells.row_number) !== index + 1) throw bad();
    const offerId = string(cells.item_offer_id);
    const sku = scalar(cells.item_sku);
    if (sku <= 0) throw bad();
    const values = (side: "delivery" | "return") => {
      const q = cells[side + "_commission_quantity"];
      const amount = cells[side + "_commission_amount"];
      // Both cells blank means this particular row has no side, not that the month has no activity.
      if (q === "" && amount === "") return [0, 0] as const;
      const quantity = scalar(q);
      const rubles = scalar(amount, true);
      if (quantity === 0 && rubles !== 0) throw bad();
      return [quantity, rubles] as const;
    };
    const [sales, saleAmount] = values("delivery");
    const [returns, returnAmount] = values("return");
    controls.push(JSON.stringify([offerId, sku, cells.item_barcode, sales, returns,
      Math.round(saleAmount * 100), Math.round(returnAmount * 100)]));
    const optional = (k: string) => {
      if (!cells[k]) return undefined;
      const value = Number(cells[k]);
      return Number.isFinite(value) ? value : undefined;
    };
    return {
      rowNumber: index + 1,
      item: { offer_id: offerId, sku, name: cells.item_name, barcode: cells.item_barcode },
      seller_price_per_instance: optional("seller_price_per_instance"),
      delivery_commission: { quantity: sales, amount: saleAmount, bonus: optional("delivery_commission_bonus"),
        bank_coinvestment: optional("delivery_commission_bank_coinvestment"), stars: optional("delivery_commission_stars") },
      return_commission: { quantity: returns, amount: returnAmount, bonus: optional("return_commission_bonus"),
        bank_coinvestment: optional("return_commission_bank_coinvestment"), stars: optional("return_commission_stars") },
    };
  });
  return { rows, controls: controls.sort() };
}

function fail(error: unknown): Failure {
  if (error instanceof ReportError) return { ok: false, code: error.code };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { ok: false, code: "timeout" };
  }
  if (error instanceof SyntaxError || (error instanceof TypeError && error.message === "Invalid URL")) {
    return { ok: false, code: "realization_incomplete" };
  }
  return { ok: false, code: "unavailable" };
}

export async function fetchNumberedRealization(
  clientId: string, apiKey: string, month: number, year: number, deadlineMs?: number
): Promise<RealizationFetchResult> {
  try {
    const period = monthPeriod(year, month);
    const deadline = Math.min(deadlineMs ?? Infinity, Date.now() + 25_000);
    const headers = { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" };
    const report = oneReport(await post(REPORTS + "/list", period, headers, deadline), period);
    const key = createHash("sha256").update(JSON.stringify([clientId, apiKey, period.from, report.number])).digest("hex");
    const now = Date.now();
    for (const [id, value] of jobs) if (value.expiresAt <= now) jobs.delete(id);
    let job = jobs.get(key);
    if (!job) {
      if (jobs.size >= MAX_JOBS) throw new ReportError("realization_pending");
      job = { expiresAt: now + JOB_TTL_MS, nextCheckAt: now };
      jobs.set(key, job);
    }
    if (job.running) return job.running;
    if (job.nextCheckAt > now) throw new ReportError("realization_pending");

    const active = job;
    active.running = (async (): Promise<RealizationFetchResult> => {
      try {
        active.exportCodes ??= [];
        if (active.exportCodes.length < FORMATS.length) {
          for (const format of FORMATS.slice(active.exportCodes.length)) {
            const output = await post(REPORTS + "/" + format.create, { number: report.number }, headers, deadline);
            active.exportCodes.push(string(object(output.result ?? output).code));
          }
          active.nextCheckAt = Date.now() + POLL_INTERVAL_MS;
          return { ok: false, code: "realization_pending" };
        }
        active.exports ??= [];
        for (let i = active.exports.length; i < FORMATS.length; i++) {
          const format = FORMATS[i];
          const code = active.exportCodes[i];
          const response = await post("/v1/report/info", { code }, headers, deadline);
          const info = object(response.result ?? response);
          if (info.code !== code || info.report_type !== format.type) throw bad();
          if (["waiting", "pending", "processing", "in_progress"].includes(String(info.status))) {
            active.nextCheckAt = Date.now() + POLL_INTERVAL_MS;
            return { ok: false, code: "realization_pending" };
          }
          if (info.status !== "success" || info.error) throw bad();
          active.exports.push({ identity: exportMetadata(info, report), link: string(info.file) });
        }
        const [standard, posting] = await Promise.all(active.exports.map(async ({ identity, link }, index) => ({
          identity, ...parseReport(await download(link, deadline), index === 1),
        })));
        // The two official representations corroborate each calculation input. An empty pair
        // has no independent zero-activity marker and must not be read as zero sales.
        if (standard.identity !== posting.identity || standard.rows.length === 0 ||
            standard.controls.length !== posting.controls.length ||
            standard.controls.some((value, i) => value !== posting.controls[i])) throw bad();
        if (standard.rows.every(row => !row.delivery_commission?.quantity && !row.return_commission?.quantity)) {
          throw new ReportError("realization_no_activity");
        }
        jobs.delete(key);
        return { ok: true, rows: standard.rows, rawRowCount: standard.rows.length, completeness: "verified" };
      } catch (error) {
        if (error instanceof ReportError && error.code === "rate_limited") {
          active.nextCheckAt = Date.now() + (error.retryMs ?? POLL_INTERVAL_MS);
        } else jobs.delete(key);
        return fail(error);
      } finally {
        active.running = undefined;
      }
    })();
    return active.running;
  } catch (error) {
    return fail(error);
  }
}
