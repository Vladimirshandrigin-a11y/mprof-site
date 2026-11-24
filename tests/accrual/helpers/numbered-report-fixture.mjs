export const FILE_HOST = "https://ir.ozone.ru";
const HEAD = [
  "row_number", "item_offer_id", "item_sku", "item_barcode", "item_name",
  "delivery_commission_quantity", "delivery_commission_amount",
  "return_commission_quantity", "return_commission_amount",
];

export const REPORT_LINES = [
  ["ART-A", 111, "10001", 'Товар, "А"', 10, 1500, 2, 300],
  ["ART-B", 222, "10002", "Товар Б", 5, 900, 0, 0],
  ["ART-C", 333, "10003", "Товар В", 1, 100, 0, 0],
];

const quote = v => '"' + String(v).replaceAll('"', '""') + '"';
export function reportCsv(lines, options = {}) {
  const posting = options.posting === true;
  const header = posting ? [...HEAD, "posting_posting_number"] : HEAD;
  const rows = lines.map((line, i) => {
    const fields = [options.duplicate && i === 1 ? 1 : i + 1, ...line];
    return posting ? [...fields, "test-posting-" + i] : fields;
  });
  return [header, ...rows].map(row => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

export function numberedReportFixture(options = {}) {
  const number = options.number ?? "test-report";
  const from = options.from ?? "2026-6-1";
  const to = options.to ?? "2026-06-30";
  const lines = options.lines ?? REPORT_LINES;
  const posting = options.postingLines ?? [...lines].reverse();
  const calls = [];
  let info429 = options.rateLimitPosting === true;
  let waiting = options.waiting === true;
  function upstream({ url, body, headers }) {
    const target = new URL(url);
    const p = target.pathname;
    calls.push({ p, body, headers, host: target.origin });
    if (p.endsWith("/list")) {
      if (options.listError) return Response.json({}, { status: options.listError });
      return Response.json(options.list ?? { reports: [{ number, from, to }] });
    }
    if (p.endsWith("/number/create")) return Response.json({ result: { code: "document-standard" } });
    if (p.endsWith("/number/posting/create")) return Response.json({ result: { code: "document-posting" } });
    if (p === "/v1/report/info") {
      const isPosting = body.code === "document-posting";
      if (isPosting && info429) {
        info429 = false;
        return Response.json({}, { status: 429, headers: { "retry-after": "60" } });
      }
      const status = waiting ? "processing" : options.infoStatus ?? "success";
      waiting = false;
      return Response.json({ result: {
        code: body.code,
        report_type: isPosting ? "finance_realization_number_posting" : "finance_realization_number",
        status,
        error: "",
        file: options.fileUrl ?? FILE_HOST + (isPosting ? "/posting" : "/standard"),
        additional_data: Object.entries({
          Number: isPosting && options.mismatchedNumber ? "other-report" : number,
          StartDate: from, StopDate: to, DocDate: to,
          ReceiverInn: "fixture-seller", CurrencySysName: "RUB",
        }).map(([key, value]) => ({ key, value })),
      } });
    }
    if (target.origin === FILE_HOST) {
      const isPosting = p === "/posting";
      let csv = reportCsv(isPosting ? posting : lines, { posting: isPosting, duplicate: isPosting && options.duplicate });
      if (isPosting && options.partialLine) csv = csv.slice(0, -3);
      const length = Buffer.byteLength(csv) + (isPosting && options.invalidLength ? 8 : 0);
      return new Response(csv, { headers: { "content-length": String(length) } });
    }
    throw new Error("unexpected fixture endpoint " + p);
  }
  return { upstream, calls };
}
