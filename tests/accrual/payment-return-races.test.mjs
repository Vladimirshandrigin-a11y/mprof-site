// Границы асинхронной проверки после возврата из оплаты. Только настоящий
// payment-return.ts с управляемыми зависимостями: без платежей, сети и БД.

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { paymentReturn as PR } from "./helpers/modules.mjs";

const BEFORE = { hasPremium: false, premiumUntil: null, singleCredits: 0 };
const UNLIMITED = {
  hasPremium: true,
  premiumUntil: "2026-12-01T00:00:00Z",
  singleCredits: 0,
};
const reading = (snap, complete = true) => ({ ...snap, complete });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("payment-return: отмена незавершённой асинхронной проверки", () => {
  for (const outcome of ["confirmed access", "network error"]) {
    it(`ответ после dispose (${outcome}) не показывает итог и не продолжает опрос`, async () => {
      const entered = deferred();
      const response = deferred();
      const phases = [];
      let rechecks = 0;
      let reads = 0;
      const check = PR.createPaymentReturnCheck({
        recheck: async () => {
          rechecks += 1;
          entered.resolve();
          await response.promise;
        },
        read: () => {
          reads += 1;
          return reading(UNLIMITED);
        },
        settle: async () => {},
        sleep: async () => {},
        onPhase: (phase) => phases.push(phase),
      });

      assert.equal(check.run(BEFORE), true);
      await entered.promise;
      check.dispose();
      if (outcome === "network error") response.reject(new Error("connection closed"));
      else response.resolve();
      await setImmediate();

      assert.deepEqual(phases, ["checking"]);
      assert.equal(reads, 0);
      assert.equal(rechecks, 1);
      assert.equal(check.running, false);
      assert.equal(check.run(BEFORE), false);
    });
  }

  it("dispose во время ожидания применения прав не подтверждает уже загруженный доступ", async () => {
    const entered = deferred();
    const render = deferred();
    const phases = [];
    let rechecks = 0;
    let reads = 0;
    const check = PR.createPaymentReturnCheck({
      recheck: async () => {
        rechecks += 1;
      },
      read: () => {
        reads += 1;
        return reading(UNLIMITED);
      },
      settle: async () => {
        entered.resolve();
        await render.promise;
      },
      sleep: async () => {},
      onPhase: (phase) => phases.push(phase),
    });

    check.run(BEFORE);
    await entered.promise;
    check.dispose();
    render.resolve();
    await setImmediate();

    assert.deepEqual(phases, ["checking"]);
    assert.equal(reads, 0);
    assert.equal(rechecks, 1);
    assert.equal(check.running, false);
  });
});

describe("payment-return: восстановление после неполного чтения", () => {
  it("повтор после ошибки сети сохраняет первоначальный baseline и подтверждает рост", async () => {
    const phases = [];
    let rechecks = 0;
    let nextOutcome = deferred();
    const check = PR.createPaymentReturnCheck({
      recheck: async () => {
        rechecks += 1;
        if (rechecks === 1) throw new Error("network");
      },
      read: () => reading(UNLIMITED),
      settle: async () => {},
      sleep: async () => {},
      onPhase: (phase, growth) => {
        phases.push([phase, growth]);
        if (phase !== "checking") nextOutcome.resolve([phase, growth]);
      },
      delays: [0],
    });

    check.run(BEFORE);
    assert.deepEqual(await nextOutcome.promise, ["failed", null]);
    assert.equal(check.running, false);
    nextOutcome = deferred();
    assert.equal(check.run(null), true);
    assert.deepEqual(await nextOutcome.promise, ["confirmed", "unlimited"]);
    assert.equal(rechecks, 2);
    assert.deepEqual(phases, [
      ["checking", null],
      ["failed", null],
      ["checking", null],
      ["confirmed", "unlimited"],
    ]);
  });

  it("без baseline неполный ответ с премиумом игнорируется, рост определяется по полным чтениям", async () => {
    const snapshots = [
      reading(UNLIMITED, false),
      reading(BEFORE),
      reading({ ...BEFORE, singleCredits: 1 }),
    ];
    const phases = [];
    const finished = deferred();
    let rechecks = 0;
    let current;
    const check = PR.createPaymentReturnCheck({
      recheck: async () => {
        current = snapshots[rechecks++];
      },
      read: () => current,
      settle: async () => {},
      sleep: async () => {},
      onPhase: (phase, growth) => {
        phases.push([phase, growth]);
        if (phase !== "checking") finished.resolve([phase, growth]);
      },
      delays: [0, 0, 0],
    });

    check.run(null);
    assert.deepEqual(await finished.promise, ["confirmed", "single"]);
    assert.equal(rechecks, 3);
    assert.deepEqual(phases, [["checking", null], ["confirmed", "single"]]);
  });
});
