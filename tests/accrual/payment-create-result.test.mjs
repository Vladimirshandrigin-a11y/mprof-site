// Сообщения окна оплаты (app/components/payment-create-result.ts + TariffModal):
// причина называется только когда её задаёт статус/код ответа, технические тексты
// сервера не показываются, в ЮKassa уходим только по https-адресу из ответа ok.
// Запрос, сумма и тариф не меняются.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, paymentCreateResult as P } from "./helpers/modules.mjs";

const M = P.PAY_MSG;
const out = (status, body) => P.paymentCreateOutcome(status, body);

describe("payment-create-result: ответ /api/payment/create → действие окна", () => {
  it("200 ok + https-адрес → переход в ЮKassa", () => {
    const url = "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2f1e";
    assert.deepEqual(out(200, { ok: true, confirmationUrl: url, plan: "single", amount: 149 }), { redirect: url });
  });

  it("200 без адреса, без ok или с небезопасным адресом → «не удалось создать», без перехода", () => {
    assert.deepEqual(out(200, { ok: true }), { message: M.failed });
    assert.deepEqual(out(200, { ok: false, confirmationUrl: "https://yoomoney.ru/x" }), { message: M.failed });
    assert.deepEqual(out(200, { ok: true, confirmationUrl: "javascript:alert(1)" }), { message: M.failed });
    assert.deepEqual(out(200, { ok: true, confirmationUrl: "http://yoomoney.ru/x" }), { message: M.failed });
    assert.deepEqual(out(200, { ok: true, confirmationUrl: "не адрес" }), { message: M.failed });
    assert.deepEqual(out(200, null), { message: M.failed });
  });

  it("401 → «Сессия истекла. Войдите в аккаунт повторно»", () => {
    assert.deepEqual(out(401, { ok: false, error: "Недействительная сессия" }), { message: M.sessionExpired });
    assert.deepEqual(out(401, null), { message: M.sessionExpired });
    assert.equal(M.sessionExpired, "Сессия истекла. Войдите в аккаунт повторно.");
  });

  it("429 → «слишком много попыток»", () => {
    assert.deepEqual(out(429, null), { message: M.tooMany });
  });

  it("403 → нейтральное «не удалось создать платёж» (причина не подтверждена)", () => {
    assert.deepEqual(out(403, { error: "Forbidden" }), { message: M.failed });
  });

  it("503 yookassa_not_configured → «оплата временно недоступна»; 503 без кода → нейтрально", () => {
    assert.deepEqual(out(503, { ok: false, error: "ЮKassa не настроена", code: "yookassa_not_configured" }), {
      message: M.unavailable,
    });
    assert.deepEqual(out(503, null), { message: M.failed });
  });

  it("500 / 502 / 400 / тело не JSON → «Не удалось создать платёж. Попробуйте позже»", () => {
    assert.equal(M.failed, "Не удалось создать платёж. Попробуйте позже.");
    for (const [status, body] of [
      [500, { ok: false, error: "Supabase service role не настроен (SUPABASE_SERVICE_ROLE_KEY)", code: "service_role_missing" }],
      [500, { ok: false, error: "Не удалось создать подписку" }],
      [502, { ok: false, error: "ЮKassa ответила статусом 401" }],
      [502, { ok: false, error: "ЮKassa недоступна: fetch failed" }],
      [400, { ok: false, error: "plan должен быть 'single' или 'unlimited'" }],
      [504, null],
    ]) {
      assert.deepEqual(out(status, body), { message: M.failed }, `status ${status}`);
    }
  });

  it("технические тексты сервера в сообщения не попадают", () => {
    const leaky = { ok: false, error: "ЮKassa ответила статусом 401 SUPABASE_SERVICE_ROLE_KEY", code: "x" };
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      const r = out(status, leaky);
      assert.ok("message" in r);
      assert.ok(!/ЮKassa ответила|SUPABASE|статусом/.test(r.message), `${status}: ${r.message}`);
    }
  });

  it("сообщение о сети — отдельное и без технических деталей", () => {
    assert.equal(M.network, "Проверьте интернет-соединение и повторите попытку.");
  });
});

describe("TariffModal: запрос и защита от повторов (по исходному коду)", () => {
  const src = readFileSync(path.join(REPO_ROOT, "app/components/TariffModal.tsx"), "utf8");

  it("в запрос уходит только тариф — сумма и цена задаются сервером", () => {
    assert.ok(src.includes('fetch("/api/payment/create"'));
    assert.ok(src.includes("body: JSON.stringify({ plan: payPlan })"));
    assert.ok(!/amount\s*:/.test(src.slice(src.indexOf("handlePay"))), "amount в запросе");
  });

  it("второй запрос не отправляется, пока идёт первый (синхронная защита до await)", () => {
    const start = src.indexOf("const handlePay = async");
    const firstAwait = src.indexOf("await", start);
    const guard = src.indexOf("if (payInFlight.current) return;", start);
    const set = src.indexOf("payInFlight.current = true;", start);
    assert.ok(guard > start && guard < firstAwait, "проверка до первого await");
    assert.ok(set > guard && set < firstAwait, "флаг ставится до первого await");
  });

  it("старое общее сообщение «Оплата пока не настроена» больше не используется", () => {
    assert.ok(!src.includes("Оплата пока не настроена"));
  });
});
