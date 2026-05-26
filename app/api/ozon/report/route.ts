import { NextRequest, NextResponse } from "next/server";

// Ozon Seller API нужен Node-рантайм для произвольных заголовков
export const runtime = "nodejs";
// Никогда не кешируем — это всегда живой запрос с приватными ключами
export const dynamic = "force-dynamic";

const OZON_URL = "https://api-seller.ozon.ru/v1/analytics/data";

type OzonReportRequest = {
  clientId?: string;
  apiKey?: string;
  daysBack?: number;
};

type OzonAnalyticsRow = {
  dimensions?: unknown;
  metrics?: number[];
};

type OzonAnalyticsResponse = {
  result?: {
    data?: OzonAnalyticsRow[];
    totals?: number[];
  };
  message?: string;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function POST(req: NextRequest) {
  let payload: OzonReportRequest;

  try {
    payload = (await req.json()) as OzonReportRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const clientId = (payload.clientId ?? "").trim();
  const apiKey = (payload.apiKey ?? "").trim();
  const daysBack =
    typeof payload.daysBack === "number" && payload.daysBack > 0 && payload.daysBack <= 365
      ? Math.floor(payload.daysBack)
      : 30;

  if (!clientId || !apiKey) {
    return NextResponse.json(
      { ok: false, error: "Не указаны Ozon Client ID или Api Key" },
      { status: 400 }
    );
  }

  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);

  let ozonRes: Response;
  try {
    ozonRes = await fetch(OZON_URL, {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        date_from: ymd(dateFrom),
        date_to: ymd(dateTo),
        metrics: ["revenue", "ordered_units"],
        dimension: ["day"],
        limit: 1000,
        offset: 0,
      }),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "сеть недоступна";
    return NextResponse.json(
      { ok: false, error: `Не удалось обратиться к Ozon API: ${msg}` },
      { status: 502 }
    );
  }

  const raw = await ozonRes.text();
  let data: OzonAnalyticsResponse | null = null;
  try {
    data = raw ? (JSON.parse(raw) as OzonAnalyticsResponse) : null;
  } catch {
    data = null;
  }

  if (!ozonRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        status: ozonRes.status,
        error:
          data?.message ||
          `Ozon API ответил со статусом ${ozonRes.status}`,
      },
      { status: 502 }
    );
  }

  const rows = data?.result?.data ?? [];
  let totalRevenue = 0;
  let totalUnits = 0;
  for (const row of rows) {
    const m = row?.metrics ?? [];
    if (typeof m[0] === "number") totalRevenue += m[0];
    if (typeof m[1] === "number") totalUnits += m[1];
  }

  return NextResponse.json({
    ok: true,
    revenue: Math.round(totalRevenue),
    units: Math.round(totalUnits),
    period: { from: ymd(dateFrom), to: ymd(dateTo), days: daysBack },
    rowsCount: rows.length,
  });
}
