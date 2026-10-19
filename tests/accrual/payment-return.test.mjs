// Возврат из ЮKassa на /app?payment=return (app/app/lib/payment-return.ts): статус
// оплаты по перечитке прав. «Оплата подтверждена» — только при росте доступа
// относительно снимка «до оплаты», не по адресу; проверка конечна, без дублей и
// останавливается при размонтировании. Платёж и списание расчётов не трогаются.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, paymentReturn as PR } from "./helpers/modules.mjs";

const BEFORE = { hasPremium: false, premiumUntil: null, singleCredits: 0 };
const UNL = (until) => ({ hasPremium: true, premiumUntil: until, singleCredits: 0 });
const read = (snap, complete = true) => ({ ...snap, complete });

/**
 * Проверка на фейковых зависимостях: readings[i] — права после i-й перечитки
 * (последняя повторяется). Паузы мгновенные, их длительности записываются.
 */
function harness(readings, { recheckThrowsAt = -1 } = {}) {
  const log = { phases: [], rechecks: 0, sleeps: [] };
  let current = read(BEFORE);
  let done;
  const finished = new Promise((r) => (done = r));
  const check = PR.createPaymentReturnCheck({
    recheck: async () => {
      if (log.rechecks === recheckThrowsAt) {
        log.rechecks += 1;
        throw new Error("network");
      }
      current = readings[Math.min(log.rechecks, readings.length - 1)];
      log.rechecks += 1;
    },
    read: () => current,
    settle: async () => {},
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    onPhase: (phase, growth) => {
      log.phases.push(growth ? `${phase}:${growth}` : phase);
      if (phase !== "checking") done();
    },
  });
  return { check, log, finished };
}

describe("payment-return: признак возврата и адрес", () => {
  it("payment=return — признак возврата; другие значения и отсутствие — нет", () => {
    assert.equal(PR.isPaymentReturn("?payment=return"), true);
    assert.equal(PR.isPaymentReturn("?payment=return&sub=8d1f"), true);
    assert.equal(PR.isPaymentReturn("?payment=ok"), false);
    assert.equal(PR.isPaymentReturn("?tab=calc"), false);
    assert.equal(PR.isPaymentReturn(""), false);
  });

  it("убираются только payment и sub; остальные параметры и hash сохраняются", () => {
    assert.equal(
      PR.stripPaymentReturnParams("https://mprof-seller.ru/app?tab=calc&payment=return&sub=8d1f&x=1#hist"),
      "/app?tab=calc&x=1#hist"
    );
    assert.equal(PR.stripPaymentReturnParams("https://mprof-seller.ru/app?payment=return&sub=8d1f"), "/app");
  });

  it("без payment=return адрес не меняется (null)", () => {
    assert.equal(PR.stripPaymentReturnParams("https://mprof-seller.ru/app?tab=calc&sub=8d1f"), null);
    assert.equal(PR.stripPaymentReturnParams("https://mprof-seller.ru/app"), null);
    assert.equal(PR.stripPaymentReturnParams("не адрес"), null);
  });
});

describe("payment-return: рост доступа", () => {
  it("первый безлимит и продление (срок позже) — рост unlimited", () => {
    assert.equal(PR.accessGrowth(BEFORE, UNL("2026-11-19T10:00:00Z")), "unlimited");
    assert.equal(PR.accessGrowth(UNL("2026-11-19T10:00:00Z"), UNL("2026-12-19T10:00:00Z")), "unlimited");
  });

  it("тот же срок, истёкший безлимит или неактивный — не рост", () => {
    assert.equal(PR.accessGrowth(UNL("2026-11-19T10:00:00Z"), UNL("2026-11-19T10:00:00Z")), null);
    const expiredLater = { hasPremium: false, premiumUntil: "2026-12-19T10:00:00Z", singleCredits: 0 };
    assert.equal(PR.accessGrowth(BEFORE, expiredLater), null);
    assert.equal(PR.accessGrowth(BEFORE, BEFORE), null);
  });

  it("разовых расчётов стало больше — рост single; меньше или столько же — нет", () => {
    assert.equal(PR.accessGrowth({ ...BEFORE, singleCredits: 2 }, { ...BEFORE, singleCredits: 3 }), "single");
    assert.equal(PR.accessGrowth({ ...BEFORE, singleCredits: 2 }, { ...BEFORE, singleCredits: 2 }), null);
    assert.equal(PR.accessGrowth({ ...BEFORE, singleCredits: 2 }, { ...BEFORE, singleCredits: 1 }), null);
  });
});

describe("payment-return: снимок «до оплаты» в sessionStorage", () => {
  const NOW = 1_800_000_000_000;
  it("свой снимок читается обратно", () => {
    const raw = PR.serializeBaseline("u1", UNL("2026-11-19T10:00:00Z"), NOW - 1000);
    assert.deepEqual(PR.parseBaseline(raw, "u1", NOW), UNL("2026-11-19T10:00:00Z"));
  });

  it("чужой, старый, из будущего или повреждённый — не используется", () => {
    const raw = PR.serializeBaseline("u1", BEFORE, NOW - 1000);
    assert.equal(PR.parseBaseline(raw, "u2", NOW), null);
    assert.equal(PR.parseBaseline(PR.serializeBaseline("u1", BEFORE, NOW - PR.PAYMENT_BASELINE_MAX_AGE_MS - 1), "u1", NOW), null);
    assert.equal(PR.parseBaseline(PR.serializeBaseline("u1", BEFORE, NOW + 60_000), "u1", NOW), null);
    assert.equal(PR.parseBaseline("{не json", "u1", NOW), null);
    assert.equal(PR.parseBaseline(JSON.stringify({ v: 1, userId: "u1", savedAt: NOW, hasPremium: true, premiumUntil: 5, singleCredits: 0 }), "u1", NOW), null);
    assert.equal(PR.parseBaseline(null, "u1", NOW), null);
  });
});

describe("payment-return: проверка после возврата", () => {
  it("webhook уже пришёл (снимок до оплаты есть) — подтверждение с первой перечитки", async () => {
    const h = harness([read(UNL("2026-11-19T10:00:00Z"))]);
    assert.equal(h.check.run(BEFORE), true);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "confirmed:unlimited"]);
    assert.equal(h.log.rechecks, 1);
  });

  it("webhook пришёл позже — подтверждение, как только права выросли", async () => {
    const h = harness([read(BEFORE), read(BEFORE), read({ ...BEFORE, singleCredits: 1 })]);
    h.check.run(BEFORE);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "confirmed:single"]);
    assert.equal(h.log.rechecks, 3);
  });

  it("webhook не пришёл — после конечного круга «может ещё обрабатываться», без успеха", async () => {
    const h = harness([read(BEFORE)]);
    h.check.run(BEFORE);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "pending"]);
    assert.equal(h.log.rechecks, PR.PAYMENT_RECHECK_DELAYS_MS.length);
    assert.deepEqual(h.log.sleeps, [...PR.PAYMENT_RECHECK_DELAYS_MS]);
    const total = PR.PAYMENT_RECHECK_DELAYS_MS.reduce((a, b) => a + b, 0);
    assert.ok(total >= 20_000 && total <= 60_000, `круг ${total} мс`);
  });

  it("снимка до оплаты нет: уже действующий доступ НЕ считается подтверждением", async () => {
    const h = harness([read(UNL("2026-11-19T10:00:00Z"))]);
    h.check.run(null);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "pending"]);
  });

  it("снимка до оплаты нет: рост после первого полного чтения — подтверждение", async () => {
    const h = harness([read(BEFORE), read(BEFORE), read(UNL("2026-11-19T10:00:00Z"))]);
    h.check.run(null);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "confirmed:unlimited"]);
  });

  it("сеть недоступна всё время — «не удалось проверить», не успех и не «нет доступа»", async () => {
    const h = harness([read(UNL("2026-11-19T10:00:00Z"), false)]);
    h.check.run(BEFORE);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "failed"]);
  });

  it("неполное чтение не даёт ложного подтверждения; полное без роста — pending", async () => {
    const h = harness([read(UNL("2026-11-19T10:00:00Z"), false), read(BEFORE)]);
    h.check.run(BEFORE);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "pending"]);
  });

  it("исключение при перечитке — «не удалось проверить»", async () => {
    const h = harness([read(BEFORE)], { recheckThrowsAt: 0 });
    h.check.run(BEFORE);
    await h.finished;
    assert.deepEqual(h.log.phases, ["checking", "failed"]);
  });

  it("повторный запуск во время круга игнорируется — без дублей перечиток", async () => {
    const h = harness([read(BEFORE)]);
    assert.equal(h.check.run(BEFORE), true);
    assert.equal(h.check.run(BEFORE), false);
    assert.equal(h.check.running, true);
    await h.finished;
    assert.equal(h.log.rechecks, PR.PAYMENT_RECHECK_DELAYS_MS.length);
    assert.equal(h.log.phases.filter((p) => p === "checking").length, 1);
  });

  it("«Проверить снова» после pending — тот же снимок до оплаты, подтверждение при росте", async () => {
    const readings = [read(BEFORE)];
    const h = harness(readings);
    h.check.run(BEFORE);
    await h.finished;
    assert.equal(h.check.running, false);
    readings[0] = read(UNL("2026-11-19T10:00:00Z"));
    let done2;
    const second = new Promise((r) => (done2 = r));
    const origLen = h.log.phases.length;
    const timer = setInterval(() => {
      if (h.log.phases.length > origLen + 1) done2();
    }, 1);
    assert.equal(h.check.run(null), true);
    await second;
    clearInterval(timer);
    assert.deepEqual(h.log.phases.slice(origLen), ["checking", "confirmed:unlimited"]);
  });

  it("остановка (размонтирование) — больше ни перечиток, ни итогового сообщения", async () => {
    const log = { phases: [], rechecks: 0 };
    let release;
    const gate = new Promise((r) => (release = r));
    const check = PR.createPaymentReturnCheck({
      recheck: async () => {
        log.rechecks += 1;
      },
      read: () => read(BEFORE),
      settle: async () => {},
      sleep: (ms) => (ms === 0 ? Promise.resolve() : gate),
      onPhase: (p) => log.phases.push(p),
    });
    check.run(BEFORE);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(log.rechecks, 1);
    check.dispose();
    release();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(log.rechecks, 1);
    assert.deepEqual(log.phases, ["checking"]);
    assert.equal(check.run(BEFORE), false);
  });
});

describe("payment-return: границы изменения", () => {
  it("модуль и хук не создают платежей, не списывают расчёты и не ходят в сеть сами", () => {
    for (const rel of ["app/app/lib/payment-return.ts", "app/app/lib/usePaymentReturn.ts"]) {
      // Только код: комментарии могут ссылаться на маршруты оплаты.
      const src = readFileSync(path.join(REPO_ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/fetch\s*\(/.test(src), `${rel}: fetch`);
      assert.ok(!src.includes("/api/payment"), `${rel}: /api/payment`);
      assert.ok(!/consume/i.test(src), `${rel}: consume`);
    }
  });
});
