import { NextResponse } from "next/server";

// ============================================================================
// /api/ozon/report — ОТКЛЮЧЁН / DEPRECATED.
//
// Раньше маршрут без авторизации принимал Client ID и Api Key Ozon в теле запроса
// и проксировал их в Ozon Analytics (/v1/analytics/data). Интерфейс перестал его
// вызывать в PR #1 (2026-06-25): подключение Ozon с тех пор хранит ключ
// зашифрованным на сервере, а расчёт прибыли идёт через
// POST /api/ozon/save-calculation. Открытый прокси к Ozon за счёт сервера больше
// не нужен — это только риск злоупотребления.
//
// Заглушка по образцу calc-draft / profit-draft: 410 Gone для GET и POST.
// Обработчики не принимают запрос — тело, заголовки, cookies и ключи Ozon не
// читаются; к Ozon и другим системам обращений нет. В лог — только факт вызова
// (чтобы перед удалением маршрута было видно, обращается ли к нему кто-то снаружи).
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const GONE = {
  code: "deprecated_flow",
  message: "Этот API-маршрут больше не поддерживается.",
} as const;

function gone(): NextResponse {
  // Только факт обращения: без ключей, clientId, тела, заголовков, cookies и IP.
  console.warn("[api/ozon/report] 410 deprecated call");
  return NextResponse.json(GONE, { status: 410, headers: NO_STORE });
}

export async function POST() {
  return gone();
}

export async function GET() {
  return gone();
}
