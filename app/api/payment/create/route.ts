import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  PLAN_PRICING,
  isYooKassaConfigured,
  createYooKassaPayment,
  type PaymentPlan,
} from "../_lib/yookassa";
import { getSupabaseAdmin } from "../_lib/supabase-admin";

// ЮKassa требует Node-рантайм (Basic-auth, произвольные заголовки, Buffer).
export const runtime = "nodejs";
// Платёж создаётся живым запросом — никогда не кешируем.
export const dynamic = "force-dynamic";

// ============================================================================
// POST /api/payment/create
//
// Этап 1 (каркас). Что делает:
//   1. валидирует plan ("single" | "unlimited") и берёт сумму с СЕРВЕРА
//      (149 / 449 ₽) — цену с клиента не принимаем;
//   2. если ЮKassa не настроена (нет YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY) —
//      сразу отдаёт понятную ошибку «ЮKassa не настроена», без сетевых вызовов
//      и без записи в БД (безопасный режим, пока ключей нет);
//   3. когда ключи появятся: создаёт pending-подписку (service-role, в обход
//      RLS), создаёт платёж в ЮKassa и возвращает confirmationUrl для редиректа.
//
// Любой сбой → JSON { ok:false, error } с осмысленным HTTP-статусом. Не бросает.
// ============================================================================

const VALID_PLANS: PaymentPlan[] = ["single", "unlimited"];

function isValidPlan(v: unknown): v is PaymentPlan {
  return typeof v === "string" && (VALID_PLANS as string[]).includes(v);
}

export async function POST(req: NextRequest) {
  // 1. Тело + валидация плана
  let body: { plan?: unknown };
  try {
    body = (await req.json()) as { plan?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }
  if (!isValidPlan(body.plan)) {
    return NextResponse.json(
      { ok: false, error: "plan должен быть 'single' или 'unlimited'" },
      { status: 400 }
    );
  }
  const plan = body.plan;
  const { amount } = PLAN_PRICING[plan];

  // 2. Главный gate этапа 1: без ключей ЮKassa ничего не делаем.
  if (!isYooKassaConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "ЮKassa не настроена",
        code: "yookassa_not_configured",
      },
      { status: 503 }
    );
  }

  // 3. Service-role клиент — нужен, чтобы писать в subscriptions в обход RLS.
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        error: "Supabase service role не настроен (SUPABASE_SERVICE_ROLE_KEY)",
        code: "service_role_missing",
      },
      { status: 500 }
    );
  }

  // 4. Авторизация: токен пользователя из заголовка Authorization: Bearer <jwt>.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Требуется авторизация" },
      { status: 401 }
    );
  }
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    return NextResponse.json(
      { ok: false, error: "Недействительная сессия" },
      { status: 401 }
    );
  }
  const userId = userData.user.id;

  // 5. Создаём pending-подписку.
  const { data: sub, error: insErr } = await admin
    .from("subscriptions")
    .insert([
      { user_id: userId, plan, status: "pending", provider: "yookassa" },
    ])
    .select("id")
    .single();
  if (insErr || !sub) {
    // eslint-disable-next-line no-console
    console.error("[payment/create] subscriptions insert error", insErr);
    return NextResponse.json(
      { ok: false, error: "Не удалось создать подписку" },
      { status: 500 }
    );
  }
  const subscriptionId = (sub as { id: string }).id;

  // 6. Создаём платёж в ЮKassa.
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000";
  const returnUrl = `${siteUrl}/app?payment=return&sub=${subscriptionId}`;
  const payment = await createYooKassaPayment({
    plan,
    returnUrl,
    idempotenceKey: randomUUID(),
    metadata: { subscription_id: subscriptionId, plan },
  });

  if (!payment.ok || !payment.confirmationUrl) {
    // Платёж не создан — помечаем подписку failed, чтобы не висела в pending.
    await admin
      .from("subscriptions")
      .update({ status: "failed" })
      .eq("id", subscriptionId);
    return NextResponse.json(
      { ok: false, error: payment.error || "Не удалось создать платёж" },
      { status: 502 }
    );
  }

  // 7. Сохраняем id платежа ЮKassa (webhook сопоставит по нему оплату).
  await admin
    .from("subscriptions")
    .update({ provider_payment_id: payment.paymentId })
    .eq("id", subscriptionId);

  return NextResponse.json({
    ok: true,
    subscriptionId,
    plan,
    amount,
    confirmationUrl: payment.confirmationUrl,
  });
}
