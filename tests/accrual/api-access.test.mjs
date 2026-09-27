// Доступ к расчёту через Ozon API для отображения (app/app/lib/api-access.ts): какую
// кнопку и какое окно оплаты показать. Та же модель, что у RPC consume_api_calculation:
// активный безлимит или неизрасходованная общая бесплатная попытка; разовые кредиты
// (149 ₽) API не открывают.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiAccess as AA } from "./helpers/modules.mjs";

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
