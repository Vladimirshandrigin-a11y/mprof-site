import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRequire } from "node:module";
import { numberedReportFixture, FILE_HOST, REPORT_LINES } from "./helpers/numbered-report-fixture.mjs";
const require = createRequire(import.meta.url);
const { fetchNumberedRealization } = require("../../node_modules/.cache/accrual-tests/build/api/ozon/_lib/numbered-realization.js");

let now;
let shop = 0;
beforeEach(() => {
  now = Date.parse("2026-11-25T15:00:00Z");
  mock.method(Date, "now", () => now);
});
afterEach(() => mock.restoreAll());

function scenario(options = {}) {
  const fixture = numberedReportFixture(options);
  const key = "shop-" + ++shop;
  mock.method(globalThis, "fetch", async (url, params = {}) => fixture.upstream({
    url, body: params.body === undefined ? undefined : JSON.parse(params.body), headers: params.headers,
  }));
  return { ...fixture, call: (month = 6, year = 2026) => fetchNumberedRealization(key, "fixture-key", month, year) };
}

async function firstExport(call) {
  assert.deepEqual(await call(), { ok: false, code: "realization_pending" });
  now += 45_000;
}

describe("numbered Ozon realization", () => {
  it("corroborates exact rows, consumes both copies once and leaves financial signs intact", async () => {
    const { call, calls } = scenario();
    await firstExport(call);
    const result = await call();
    assert.equal(result.ok, true);
    assert.equal(result.completeness, "verified");
    assert.equal(result.rows[0].item.name, 'Товар, "А"');
    assert.equal(result.rows[0].delivery_commission.quantity, 10);
    assert.equal(result.rows[0].return_commission.quantity, 2);
    assert.equal(result.rows[0].return_commission.amount, 300);
    assert.equal(calls.filter(c => c.host === FILE_HOST).length, 2);
    assert.ok(calls.filter(c => c.host === FILE_HOST).every(c => c.headers === undefined));
  });

  for (const [title, options] of [
    ["complete transport with a trailing row removed", { postingLines: REPORT_LINES.slice(0, -1) }],
    ["partial line", { partialLine: true }],
    ["content-length mismatch", { invalidLength: true }],
    ["duplicate row number", { duplicate: true }],
    ["duplicate row payload with renumbering", { postingLines: [...REPORT_LINES, REPORT_LINES[0]] }],
    ["empty report when the other export records sales", { postingLines: [] }],
    ["two empty files without an authoritative zero-activity marker", { lines: [] }],
    ["changed document number after an adjustment", { mismatchedNumber: true }],
    ["different financial amount with the same count", { postingLines: REPORT_LINES.map((r, i) => i ? r : r.map((v, j) => j === 5 ? 1500.01 : v)) }],
    ["wrong download origin", { fileUrl: "https://wrong-origin.invalid/file" }],
  ]) {
    it("rejects " + title, async () => {
      const { call } = scenario(options);
      await firstExport(call);
      assert.deepEqual(await call(), { ok: false, code: "realization_incomplete" });
    });
  }

  it("distinguishes explicit zero-quantity records from a missing or empty file", async () => {
    const { call } = scenario({ lines: [["ART-A", 111, "", "Без операций", 0, 0, 0, 0]] });
    await firstExport(call);
    assert.deepEqual(await call(), { ok: false, code: "realization_no_activity" });
  });

  it("does not consider explicit postings with returns only to be an empty period", async () => {
    const { call } = scenario({ lines: [["ART-A", 111, "", "Возврат", 0, 0, 1, 300]] });
    await firstExport(call);
    const r = await call();
    assert.equal(r.ok, true);
    assert.equal(r.rows[0].delivery_commission.quantity, 0);
    assert.equal(r.rows[0].return_commission.amount, 300);
  });

  for (const [title, list, code] of [
    ["no document", { reports: [] }, "realization_report_missing"],
    ["arbitrary partial period", { reports: [{ number: "a", from: "2026-06-02", to: "2026-06-30" }] }, "realization_incomplete"],
    ["missing part of the period", { reports: [{ number: "a", from: "2026-06-01", to: "2026-06-29" }] }, "realization_incomplete"],
    ["multiple reports or corrections", { reports: [{ number: "a" }, { number: "a-corrected" }] }, "realization_reports_ambiguous"],
    ["undocumented pagination", { reports: [{ number: "a" }], cursor: "next" }, "realization_incomplete"],
  ]) {
    it("rejects " + title + " before creating exports", async () => {
      const { call, calls } = scenario({ list });
      assert.deepEqual(await call(), { ok: false, code });
      assert.equal(calls.length, 1);
    });
  }

  it("rejects the current month and honors the Moscow reporting close boundary", async () => {
    const { call, calls } = scenario();
    assert.deepEqual(await call(11), { ok: false, code: "realization_period_unavailable" });
    now = Date.parse("2026-07-07T20:59:59Z");
    assert.deepEqual(await call(), { ok: false, code: "realization_period_unavailable" });
    assert.equal(calls.length, 0);
    now += 1_000;
    await firstExport(call);
  });

  it("retains the already completed export when a second poll hits a rate limit", async () => {
    const { call, calls } = scenario({ rateLimitPosting: true });
    await firstExport(call);
    assert.deepEqual(await call(), { ok: false, code: "rate_limited" });
    now += 59_000;
    assert.deepEqual(await call(), { ok: false, code: "realization_pending" });
    now += 1_000;
    assert.equal((await call()).ok, true);
    assert.equal(calls.filter(c => c.p === "/v1/report/info" && c.body.code === "document-standard").length, 1);
    assert.equal(calls.filter(c => c.p.endsWith("/create")).length, 2);
  });

  it("concurrent attempts reuse two export requests scoped to the same shop and period", async () => {
    const { call, calls } = scenario();
    const results = await Promise.all([call(), call()]);
    assert.deepEqual(results.map(r => r.code), ["realization_pending", "realization_pending"]);
    assert.equal(calls.filter(c => c.p.endsWith("/create")).length, 2);
    now += 45_000;
    assert.ok((await call()).ok);
  });

  it("returns pending while an export is processing, without regenerating it", async () => {
    const { call, calls } = scenario({ waiting: true });
    await firstExport(call);
    await firstExport(call);
    assert.equal((await call()).ok, true);
    assert.equal(calls.filter(c => c.p.endsWith("/create")).length, 2);
  });

  it("does not use the older API after a failure", async () => {
    const { call, calls } = scenario({ listError: 503 });
    assert.deepEqual(await call(), { ok: false, code: "unavailable" });
    assert.equal(calls.length, 1);
  });
});
