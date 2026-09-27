// Доступ к расчёту через Ozon API для отображения (app/app/lib/api-access.ts): какую
// кнопку и какое окно оплаты показать. Та же модель, что у RPC consume_api_calculation:
// активный безлимит или неизрасходованная общая бесплатная попытка; разовые кредиты
// (149 ₽) API не открывают. Плюс повторная проверка прав при возврате во вкладку
// (app/app/lib/single-flight.ts): без параллельных одинаковых запросов.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiAccess as AA, singleFlight as SF } from "./helpers/modules.mjs";

const FREE = 1;
const state = (o) => ({ loaded: true, hasPremium: false, calcCount: 0, freeLimit: FREE, ...o });

describe("api-access: доступ к расчёту через Ozon API", () => {
  it("права загружаются → loading (без требования оплаты)", () => {
    assert.equal(AA.apiCalcAccess(state({ loaded: false })), "loading");
    assert.equal(AA.apiCalcAccess(state({ loaded: false, calcCount: 5 })), "loading");
  });

  it("бесплатная попытка доступна → allowed, покупка не требуется", () => {
    assert.equal(AA.apiCalcAccess(state({ calcCount: 0 })), "allowed");
  });

  it("активный безлимит → allowed при любом числе расчётов", () => {
    assert.equal(AA.apiCalcAccess(state({ hasPremium: true, calcCount: 0 })), "allowed");
    assert.equal(AA.apiCalcAccess(state({ hasPremium: true, calcCount: 7 })), "allowed");
  });

  it("попытка израсходована, кредитов нет → needs_unlimited", () => {
    assert.equal(AA.apiCalcAccess(state({ calcCount: 1 })), "needs_unlimited");
  });

  it("попытка израсходована, есть разовые кредиты → всё равно needs_unlimited (149 ₽ API не открывает)", () => {
    const withCredits = { ...state({ calcCount: 1 }), singleCredits: 3 };
    assert.equal(AA.apiCalcAccess(withCredits), "needs_unlimited");
    // Даже когда кредитов хватает на файловые/ручные расчёты (calcCount < 1 + кредиты).
    assert.equal(AA.apiCalcAccess({ ...state({ calcCount: 2 }), singleCredits: 3 }), "needs_unlimited");
  });

  it("безлимит истёк (hasPremium=false) и попытка израсходована → needs_unlimited", () => {
    assert.equal(AA.apiCalcAccess(state({ hasPremium: false, calcCount: 4 })), "needs_unlimited");
  });

  it("истёкший безлимит без расходов (calcCount=0) → общая бесплатная попытка ещё есть", () => {
    assert.equal(AA.apiCalcAccess(state({ hasPremium: false, calcCount: 0 })), "allowed");
  });
});

describe("api-access: повторная проверка прав не выдаёт устаревшее «купите безлимит»", () => {
  const exhausted = state({ calcCount: 1 });

  it("идёт проверка → checking вместо предложения покупки", () => {
    assert.equal(AA.apiCalcAccess({ ...exhausted, checking: true }), "checking");
    assert.equal(AA.apiCalcAccess({ ...exhausted, checking: true, checkFailed: true }), "checking", "повтор после сбоя");
  });

  it("проверка не удалась → check_failed, а не «доступа нет»", () => {
    assert.equal(AA.apiCalcAccess({ ...exhausted, checkFailed: true }), "check_failed");
  });

  it("доступ есть — проверка и сбой проверки его не скрывают", () => {
    assert.equal(AA.apiCalcAccess(state({ hasPremium: true, calcCount: 3, checking: true })), "allowed");
    assert.equal(AA.apiCalcAccess(state({ calcCount: 0, checkFailed: true })), "allowed");
  });

  it("проверка завершилась, доступа нет → снова needs_unlimited", () => {
    assert.equal(AA.apiCalcAccess({ ...exhausted, checking: false, checkFailed: false }), "needs_unlimited");
  });

  it("проверка вернула безлимит → allowed (кнопка расчёта восстанавливается)", () => {
    assert.equal(AA.apiCalcAccess({ ...exhausted, hasPremium: true }), "allowed");
  });
});

describe("single-flight: повторные события фокуса", () => {
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };

  it("одновременные запуски получают один общий запрос", async () => {
    let calls = 0;
    const d = deferred();
    const f = SF.createSingleFlight(async () => {
      calls++;
      await d.promise;
    }, 2000, () => 0);
    const runs = [f.run(), f.run(), f.run(true), f.run()];
    assert.equal(calls, 1);
    d.resolve();
    assert.deepEqual(await Promise.all(runs), [true, true, true, true]);
    assert.equal(calls, 1);
  });

  it("повтор в пределах паузы пропускается; после паузы и по force — выполняется", async () => {
    let t = 0;
    let calls = 0;
    const f = SF.createSingleFlight(async () => {
      calls++;
    }, 2000, () => t);
    assert.equal(await f.run(), true);
    t = 500;
    assert.equal(await f.run(), false, "focus сразу после visibilitychange");
    assert.equal(calls, 1);
    assert.equal(await f.run(true), true, "«Проверить снова» — без паузы");
    assert.equal(calls, 2);
    t = 3000;
    assert.equal(await f.run(), true);
    assert.equal(calls, 3);
  });

  it("ошибка запуска не блокирует следующую попытку", async () => {
    let t = 0;
    let calls = 0;
    const f = SF.createSingleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error("сбой сети");
    }, 2000, () => t);
    await assert.rejects(f.run(), /сбой сети/);
    t = 10;
    assert.equal(await f.run(true), true);
    assert.equal(calls, 2);
  });
});
