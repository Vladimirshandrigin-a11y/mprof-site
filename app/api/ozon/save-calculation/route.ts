import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, getUserScopedClient } from "../../cloud/_lib/auth";
import { decryptOzonApiKey, isEncryptionConfigured } from "../_lib/crypto";
import { isMonthInFuture, monthToRange } from "../_lib/finance";
import {
  errorResponse,
  loadAndComputeApiProfit,
  parseManualExpenses,
  round2,
} from "../_lib/profit";

// ============================================================================
// POST /api/ozon/save-calculation — ФИНАЛЬНОЕ сохранение API-расчёта Ozon в
// историю + списание попытки (PR #19).
//
//   Вход: { month: "YYYY-MM", manualExpenses? }.
//
// Поток (server-authoritative, бэкенд НЕ доверяет числам с фронтенда):
//   1. auth (user_id ТОЛЬКО из токена), ключ Ozon ТОЛЬКО из ozon_connections;
//   2. заново тянем данные Ozon API + каталог и ПЕРЕСЧИТЫВАЕМ ту же формулу,
//      что и preview (общий _lib/profit → loadAndComputeApiProfit);
//   3. финальное сохранение разрешено ТОЛЬКО при ПОЛНОМ покрытии себестоимостью
//      (status === "complete_cost" И unmatchedItems === 0 И matchedNoCostCount === 0 —
//      т.е. НЕТ ни одного matched-товара с cost_price = 0) — иначе 400, без
//      сохранения и БЕЗ списания;
//   4. списываем РОВНО один расчёт тем же RPC consume_calculation (free/149₽/
//      безлимит решает сам RPC) — ПЕРЕД сохранением. Нет доступа → 402, без
//      сохранения (RPC при лимите ничего не инкрементит);
//   5. пишем строку в calculations (mode='api', снимок в ai_insights) и снимок
//      за месяц в report_history (для помесячных графиков).
//
// Списание идёт ПЕРЕД insert (как в рабочем ручном/файловом сохранении: оно тоже
// зовёт consume_calculation до сохранения). Атомарной транзакции «списал+сохранил»
// в текущей архитектуре нет (RPC идёт user-scoped клиентом, insert — service-role
// клиентом), поэтому повторяем существующий порядок. Остаточный риск (списание
// прошло, а insert упал → расчёт «потрачен» без строки) такой же, как в текущем
// рабочем флоу, и описан в отчёте PR #19.
//
// Безопасность: raw-ключ Ozon не логируем и не возвращаем; api_key_encrypted,
// client_id и расшифрованный ключ наружу НЕ уходят.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type ConsumeResult = {
  ok?: boolean;
  reason?: string;
  used?: number;
  allowance?: number;
  unlimited?: boolean;
};

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return auth.response;
  const { admin, userId } = auth;

  // Bearer-токен для USER-SCOPED клиента (consume_calculation опирается на
  // auth.uid()). authenticateRequest уже подтвердил, что токен валиден.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return NextResponse.json(
      { error: "Требуется авторизация" },
      { status: 401, headers: NO_STORE }
    );
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      {
        error: "Шифрование ключей не настроено на сервере",
        code: "encryption_misconfigured",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  // ---- input ----
  let body: { month?: unknown; manualExpenses?: unknown };
  try {
    body = (await req.json()) as { month?: unknown; manualExpenses?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400, headers: NO_STORE }
    );
  }

  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!month) {
    return NextResponse.json(
      { error: "Укажите месяц" },
      { status: 400, headers: NO_STORE }
    );
  }
  const range = monthToRange(month);
  if (!range) {
    return NextResponse.json(
      { error: "Месяц должен быть в формате ГГГГ-ММ" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (isMonthInFuture(month)) {
    return NextResponse.json(
      { error: "Нельзя выбрать будущий месяц" },
      { status: 400, headers: NO_STORE }
    );
  }

  // ---- ручные расходы: optional; валидируем заново (не берём с фронтенда «как есть») ----
  const meParsed = parseManualExpenses(body.manualExpenses);
  if (!meParsed.ok) {
    return NextResponse.json(
      { error: meParsed.error },
      { status: 400, headers: NO_STORE }
    );
  }
  const manualExpenses = meParsed.value;

  // ---- подключение Ozon текущего пользователя (ключ ТОЛЬКО отсюда) ----
  const { data: conn, error: connErr } = await admin
    .from("ozon_connections")
    .select("client_id, api_key_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] connection select error", connErr);
    return NextResponse.json(
      { error: "Ошибка чтения подключения" },
      { status: 502, headers: NO_STORE }
    );
  }
  if (!conn || !conn.client_id || !conn.api_key_encrypted) {
    return errorResponse("not_connected");
  }

  // ---- расшифровка ключа (ТОЛЬКО сервер; не логируем, не возвращаем) ----
  let apiKey: string;
  try {
    apiKey = decryptOzonApiKey(conn.api_key_encrypted as string);
  } catch {
    return NextResponse.json(
      { error: "Ключ Ozon нужно переподключить", code: "decrypt_failed" },
      { status: 400, headers: NO_STORE }
    );
  }
  const clientId = conn.client_id as string;

  // ---- 1) ЗАНОВО получаем данные Ozon + каталог и пересчитываем (общий модуль) ----
  const loaded = await loadAndComputeApiProfit({
    admin,
    userId,
    clientId,
    apiKey,
    range,
    manualExpenses,
  });
  if (!loaded.ok) {
    if (loaded.kind === "ozon") return errorResponse(loaded.code);
    return NextResponse.json(
      { error: "Ошибка чтения каталога себестоимости" },
      { status: 502, headers: NO_STORE }
    );
  }

  const t = loaded.draft.totals;
  const c = loaded.computed;

  // ---- 2) финальное сохранение ТОЛЬКО при ПОЛНОМ покрытии себестоимостью ----
  // НЕ сохраняем и НЕ списываем, если есть несопоставленные товары ИЛИ есть хотя бы
  // ОДИН сопоставленный товар без себестоимости (cost_price = 0 → matchedNoCostCount).
  // Строго: unmatchedItems === 0 И matchedNoCostCount === 0. Одного status мало:
  // он допускает complete_cost, когда часть matched-товаров имеет cost_price = 0
  // (их стоимость просто не входит в matchedCostTotal) — это занизило бы расходы,
  // поэтому matchedNoCostCount проверяем ЯВНО.
  if (
    c.status !== "complete_cost" ||
    loaded.cost.coverage.unmatchedItems !== 0 ||
    loaded.cost.matchedNoCostCount !== 0
  ) {
    return NextResponse.json(
      {
        error:
          "Сохранение доступно только когда все товары сопоставлены и у каждого заполнена себестоимость.",
        code: "incomplete_cost",
        status: c.status,
        unmatchedItems: loaded.cost.coverage.unmatchedItems,
        matchedNoCostCount: loaded.cost.matchedNoCostCount,
      },
      { status: 400, headers: NO_STORE }
    );
  }

  // ---- 3) списываем РОВНО один расчёт (server-authoritative, ПЕРЕД сохранением) ----
  // USER-SCOPED клиент: consume_calculation опирается на auth.uid(); service-role
  // обошёл бы auth и вернул not_authenticated. Тот же RPC, что у файлового/ручного
  // расчёта — никаких новых правил тарификации и хардкода цен.
  const userClient = getUserScopedClient(token);
  if (!userClient) {
    return NextResponse.json(
      {
        error:
          "Supabase не настроен (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)",
        code: "supabase_env_missing",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  const { data: consumeData, error: consumeErr } =
    await userClient.rpc("consume_calculation");
  if (consumeErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] consume rpc error", consumeErr);
    return NextResponse.json(
      { error: consumeErr.message || "Ошибка списания расчёта", code: "consume_failed" },
      { status: 502, headers: NO_STORE }
    );
  }
  const consume = (consumeData ?? {}) as ConsumeResult;
  if (consume.ok !== true) {
    // Нет доступа → НЕ сохраняем. При limit_reached RPC ничего не инкрементит,
    // так что попытка НЕ потрачена. Фронт откроет окно тарифа.
    const notAuth = consume.reason === "not_authenticated";
    return NextResponse.json(
      {
        error: notAuth
          ? "Сессия недействительна"
          : "Доступные расчёты закончились. Оформите тариф, чтобы сохранить API-расчёт.",
        code: notAuth ? "not_authenticated" : "limit_reached",
        consume: {
          ok: false,
          reason: consume.reason,
          used: consume.used,
          allowance: consume.allowance,
        },
      },
      { status: notAuth ? 401 : 402, headers: NO_STORE }
    );
  }

  // ---- 4) строка calculations: положительные величины расходов; reconcile с profit.
  // other_expenses — балансирующая статья (Ozon-услуги/прочее + ручные расходы
  // кроме налога), так что revenue − total_expenses === profit. Полный снимок —
  // в ai_insights (тот же приём, что у файлового net-profit расчёта).
  const revenue = round2(t.revenue);
  const commissionCol = round2(Math.max(0, -t.commission));
  const logisticsCol = round2(Math.max(0, -t.logistics));
  const storageCol = round2(Math.max(0, -t.storage));
  const adsCol = 0;
  const costCol = round2(c.matchedCostTotal);
  const taxCol = c.manualExpenses.tax;
  const otherExpensesCol = round2(
    revenue - commissionCol - logisticsCol - storageCol - adsCol - costCol - taxCol - c.netProfit
  );
  const totalExpensesCol = round2(
    commissionCol + logisticsCol + storageCol + adsCol + costCol + taxCol + otherExpensesCol
  );

  const snapshot = {
    kind: "ozon-api-v1",
    source: "ozon_api",
    period: { month, dateFrom: range.dateFrom, dateTo: range.dateTo },
    apiTotals: {
      ozonAccruals: t.revenue,
      returns: t.returns,
      commission: t.commission,
      logistics: t.logistics,
      services: t.services,
      storage: t.storage,
      other: t.other,
      operationCount: t.operationCount,
    },
    productCoverage: loaded.cost.coverage,
    cost: {
      matchedCostTotal: c.matchedCostTotal,
      matchedNoCostCount: loaded.cost.matchedNoCostCount,
    },
    manualExpenses: c.manualExpenses,
    preliminary: {
      ozonOperationsTotal: c.ozonOperationsTotal,
      matchedCostTotal: c.matchedCostTotal,
      profitBeforeManualExpenses: c.profitBeforeManualExpenses,
    },
    netProfit: c.netProfit,
    margin: c.margin,
    savedAt: new Date().toISOString(),
  };

  const calcRow = {
    user_id: userId, // ТОЛЬКО из токена
    marketplace: "ozon",
    mode: "api",
    revenue,
    commission: commissionCol,
    logistics: logisticsCol,
    ads: adsCol,
    storage: storageCol,
    tax: taxCol,
    cost: costCol,
    other_expenses: otherExpensesCol,
    total_expenses: totalExpensesCol,
    profit: c.netProfit,
    margin: c.margin,
    ai_insights: snapshot,
  };

  const { data: savedCalc, error: calcErr } = await admin
    .from("calculations")
    .insert([calcRow])
    .select("id, created_at")
    .single();

  if (calcErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] calculations insert error", calcErr);
    // Расчёт уже списан (см. остаточный риск в шапке). Сообщаем об ошибке сейва.
    return NextResponse.json(
      { error: calcErr.message || "Не удалось сохранить расчёт", code: "save_failed" },
      { status: 502, headers: NO_STORE }
    );
  }

  // ---- 5) снимок за месяц для помесячных графиков (best-effort: не валит сейв) ----
  let reportHistorySaved = false;
  const { error: histErr } = await admin.from("report_history").insert([
    {
      user_id: userId,
      report_month: `${month}-01`, // первое число месяца отчёта (date)
      revenue,
      expenses: totalExpensesCol,
      profit: c.netProfit,
      margin: c.margin,
    },
  ]);
  if (histErr) {
    // eslint-disable-next-line no-console
    console.error("[api/ozon/save-calculation] report_history insert error", histErr);
  } else {
    reportHistorySaved = true;
  }

  return NextResponse.json(
    {
      ok: true,
      calculationId: savedCalc.id,
      createdAt: savedCalc.created_at,
      reportHistorySaved,
      consume: {
        ok: true,
        unlimited: consume.unlimited === true,
        used: typeof consume.used === "number" ? consume.used : undefined,
        allowance: typeof consume.allowance === "number" ? consume.allowance : undefined,
      },
      result: {
        month,
        status: c.status,
        ozonOperationsTotal: c.ozonOperationsTotal,
        matchedCostTotal: c.matchedCostTotal,
        manualExpensesTotal: c.manualExpenses.total,
        netProfit: c.netProfit,
        margin: c.margin,
      },
    },
    { headers: NO_STORE }
  );
}
