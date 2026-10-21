// Семантика расходов AI: старые колонки УПД не должны называться комиссией
// и логистикой. Настоящие helper и POST компилирует общий test:accrual runner.
// Supabase/auth и Gateway здесь подменены; живые сеть, БД и платежи не нужны.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BUILD_DIR, authLib, nextServer } from "./helpers/modules.mjs";

const req = createRequire(path.join(BUILD_DIR, "loader.js"));
const { aggregateAiExpenseCategories: aggregate } = req("./app/lib/ai-expense-categories.js");
const route = req("./api/ai/profit-advice/route.js");

const legacy = (extra = {}) => ({ kind: "net-profit-3file", ...extra });
const record = (extra = {}) => ({
  revenue: 100000,
  profit: 30000,
  expenses: 70000,
  margin: 30,
  commission: 12000,
  logistics: 7000,
  cost: 40000,
  tax: 6000,
  ads: 3000,
  storage: 1000,
  other: 1000,
  date: "2026-10",
  aiInsights: null,
  ...extra,
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const sumCategories = (categories) => Object.values(categories).reduce((sum, n) => sum + n, 0);

// Совместимое расширение прежнего клиентского payload: старые commission и
// logistics остаются суммой колонок истории; новые поля раскрывают долю УПД.
function payloadForHistory(history) {
  const categories = aggregate(history);
  return {
    commission: history.reduce((sum, h) => sum + h.commission, 0),
    logistics: history.reduce((sum, h) => sum + h.logistics, 0),
    updServices: categories.updServices,
    updAgentFee: categories.updAgentFee,
  };
}

describe("AI expenses: реальные категории и неизменность финансовых сумм", () => {
  it("пустая история даёт четыре нулевых агрегата", () => {
    assert.deepEqual(aggregate([]), { commission: 0, logistics: 0, updServices: 0, updAgentFee: 0 });
  });

  for (const [name, meta, commission, logistics] of [
    ["старые два УПД", legacy({ docFormat: "dual-upd" }), 15000, 9000],
    ["единый УПД", legacy({ docFormat: "single-upd", commissionKnown: true }), 15000, 9000],
    ["УПД без выделенного агентского вознаграждения", legacy({ docFormat: "single-upd", commissionKnown: false }), 24000, 0],
  ]) {
    it(`${name}: расходы и вознаграждение переходят в свои категории`, () => {
      assert.deepEqual(aggregate([record({ commission, logistics, aiInsights: meta })]), {
        commission: 0,
        logistics: 0,
        updServices: commission,
        updAgentFee: logistics,
      });
    });
  }

  for (const [name, meta] of [
    ["ручной", null],
    ["API", { kind: "ozon-api-v1" }],
    ["отчёт по начислениям", { kind: "ozon-accrual-xlsx-v1" }],
    ["старая запись без снимка", undefined],
    ["похожий, но другой kind", { kind: "net-profit-3file-other" }],
    ["строка вместо снимка", "net-profit-3file"],
  ]) {
    it(`${name}: комиссия и логистика сохраняют исходное значение`, () => {
      assert.deepEqual(aggregate([record({ aiInsights: meta })]), {
        commission: 12000,
        logistics: 7000,
        updServices: 0,
        updAgentFee: 0,
      });
    });
  }

  it("смешанная история разных месяцев: каждая сумма учитывается ровно один раз", () => {
    const history = [
      record({ commission: 15000, logistics: 9000, date: "2026-08", aiInsights: legacy({ docFormat: "dual-upd" }) }),
      record({ commission: 12000, logistics: 7000, date: "2026-09" }),
      record({ commission: 10000, logistics: 3000, date: "2026-09", aiInsights: legacy({ docFormat: "single-upd" }) }),
      record({ commission: 11000, logistics: 6500, date: "2026-10", aiInsights: { kind: "ozon-api-v1" } }),
    ];
    const actual = aggregate(history);
    assert.deepEqual(actual, { commission: 23000, logistics: 13500, updServices: 25000, updAgentFee: 12000 });
    assert.equal(sumCategories(actual), history.reduce((sum, h) => sum + h.commission + h.logistics, 0));
  });

  it("дробные суммы и отрицательные корректировки сохраняются без округления и abs/clamp", () => {
    const history = [
      record({ commission: 10.125, logistics: -2.375, aiInsights: legacy() }),
      record({ commission: -3.5, logistics: 1.125, aiInsights: legacy({ docFormat: "single-upd" }) }),
      record({ commission: 4.25, logistics: -0.625 }),
      record({ commission: -0.125, logistics: 2.25, aiInsights: { kind: "ozon-api-v1" } }),
    ];
    const actual = aggregate(history);
    assert.deepEqual(actual, { commission: 4.125, logistics: 1.625, updServices: 6.625, updAgentFee: -1.25 });
    assert.equal(sumCategories(actual), history.reduce((sum, h) => sum + h.commission + h.logistics, 0));
  });

  it("не меняет историю, вложенные снимки, прибыль, выручку, расходы и маржу", () => {
    const history = [
      record({ profit: -1500.25, margin: -1.5, aiInsights: legacy({ costPrice: 12.5, nested: { marker: "keep" } }) }),
      record({ revenue: 0, profit: -500, expenses: 500, margin: 0, aiInsights: { kind: "ozon-api-v1" } }),
    ];
    const before = structuredClone(history);
    deepFreeze(history);
    const first = aggregate(history);
    assert.deepEqual(history, before);
    assert.deepEqual(aggregate(history), first, "повторный вызов не переносит суммы повторно");
    for (let i = 0; i < history.length; i++) {
      for (const field of ["profit", "revenue", "expenses", "margin", "commission", "logistics"]) {
        assert.equal(history[i][field], before[i][field], field);
      }
    }
  });
});

const FAKE_KEY = "test-only-ai-gateway-key";
const USER_ID = "ai-expense-test-user";
const VALID_AI_DOC = {
  verdict: "Прибыль положительная.",
  summary: "Проверьте расходы по документам.",
  profitLeaks: [{ title: "Расходы Ozon", why: "Сверьте суммы.", action: "Проверьте УПД.", expectedEffect: "Точная сверка." }],
  skuInsights: [],
  actionPlan: [{ action: "Сверить документы Ozon.", expectedEffect: "Найти расхождения." }],
};

describe("AI expenses: настоящий POST profit-advice с изолированными auth/profile/Gateway", { concurrency: false }, () => {
  let originalKey;
  let profile;
  let calls;
  let profileReads;
  let authenticated;

  beforeEach(() => {
    originalKey = process.env.TIMEWEB_AI_GATEWAY_KEY;
    process.env.TIMEWEB_AI_GATEWAY_KEY = FAKE_KEY;
    profile = { plan: "unlimited", premium_until: new Date(Date.now() + 86400000).toISOString() };
    calls = [];
    profileReads = [];
    authenticated = true;

    const admin = {
      from(table) {
        assert.equal(table, "profiles", "никаких обращений к расчётам, оплате или другим таблицам");
        return {
          select(columns) {
            assert.equal(columns, "plan, premium_until");
            return {
              eq(column, value) {
                assert.equal(column, "id");
                assert.equal(value, USER_ID, "профиль берётся из проверенной auth-сессии");
                return {
                  async single() {
                    profileReads.push(USER_ID);
                    return { data: profile, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    mock.method(authLib, "authenticateRequest", async () => authenticated
      ? { ok: true, userId: USER_ID, admin }
      : { ok: false, response: nextServer.NextResponse.json({ code: "unauthorized" }, { status: 401 }) });
    mock.method(console, "log", () => {});
    mock.method(globalThis, "fetch", async (_url, init) => {
      // Никакая ветка не вызывает исходный fetch; ответ модели полностью локален.
      calls.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { content: JSON.stringify(VALID_AI_DOC) }, finish_reason: "stop" }] });
    });
  });

  afterEach(() => {
    mock.restoreAll();
    if (originalKey === undefined) delete process.env.TIMEWEB_AI_GATEWAY_KEY;
    else process.env.TIMEWEB_AI_GATEWAY_KEY = originalKey;
  });

  const request = (body = {}) => new nextServer.NextRequest("https://mprof-test.invalid/api/ai/profit-advice", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-session" },
    body: JSON.stringify(body),
  });

  async function metricsFor(body) {
    const response = await route.POST(request(body));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(result.source, "timeweb_gateway");
    assert.deepEqual(result.aiDoc, VALID_AI_DOC, "выходной контракт ответа не меняется");
    assert.equal(calls.length, 1, "ровно один локальный Gateway-вызов без retry");
    assert.equal(profileReads.length, 1);
    const user = calls[0].messages.find((message) => message.role === "user").content;
    return JSON.parse(user.slice(user.indexOf("{")));
  }

  it("без авторизации возвращает 401 до чтения профиля и Gateway", async () => {
    authenticated = false;
    const response = await route.POST(request({ updServices: 15000, updAgentFee: 9000 }));
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
    assert.equal(profileReads.length, 0);
  });

  for (const [name, plan, expiration] of [
    ["бесплатный тариф", "free", "future"],
    ["разовый расчёт 149 ₽", "single", "future"],
    ["истёкший безлимит", "unlimited", "past"],
    ["безлимит без срока", "unlimited", null],
  ]) {
    it(`${name}: 403 и ни одного Gateway-вызова`, async () => {
      profile = {
        plan,
        premium_until: expiration === null ? null : new Date(Date.now() + (expiration === "future" ? 86400000 : -86400000)).toISOString(),
      };
      const response = await route.POST(request({ updServices: 15000, updAgentFee: 9000 }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "no_active_plan");
      assert.equal(calls.length, 0);
      assert.equal(profileReads.length, 1);
    });
  }

  it("активный безлимит: агентское вознаграждение УПД не уходит как логистика", async () => {
    const payload = payloadForHistory([record({ commission: 15000, logistics: 9000, aiInsights: legacy() })]);
    const metrics = await metricsFor({ ...payload, revenue: 100000, profit: 30000, margin: 30, marketplace: "ozon", fulfillmentMode: "fbs" });
    const expenses = metrics.расходы;
    assert.equal(expenses.комиссииМаркетплейса.сумма, 0);
    assert.equal(expenses.логистика.сумма, 0);
    assert.equal(expenses.расходыOzonПоУПД.сумма, 15000);
    assert.equal(expenses.агентскоеВознаграждениеПоУПД.сумма, 9000);
    assert.equal(expenses.расходыOzonПоУПД.процентОтВыручки, 15);
    assert.equal(expenses.агентскоеВознаграждениеПоУПД.процентОтВыручки, 9);
    assert.equal(Object.values(expenses).reduce((sum, item) => sum + item.сумма, 0), 24000, "без двойного учёта старых колонок");
    assert.equal(metrics.выручка, 100000);
    assert.equal(metrics.чистаяПрибыль, 30000);
    assert.equal(metrics.маржаПроцент, 30);
    assert.equal(metrics.схемаДоставки, "fbs");
  });

  it("смешанная история передаёт настоящие комиссию/логистику отдельно от УПД", async () => {
    const payload = payloadForHistory([
      record({ commission: 15000, logistics: 9000, aiInsights: legacy() }),
      record({ commission: 12000, logistics: 7000 }),
    ]);
    const metrics = await metricsFor({ ...payload, revenue: 200000, profit: 60000, margin: 30 });
    assert.equal(metrics.расходы.комиссииМаркетплейса.сумма, 12000);
    assert.equal(metrics.расходы.логистика.сумма, 7000);
    assert.equal(metrics.расходы.расходыOzonПоУПД.сумма, 15000);
    assert.equal(metrics.расходы.агентскоеВознаграждениеПоУПД.сумма, 9000);
    assert.equal(Object.values(metrics.расходы).reduce((sum, item) => sum + item.сумма, 0), 43000);
  });

  it("копейки и signed-корректировки: сумма четырёх категорий точно равна прежним двум округлённым агрегатам", async () => {
    const payload = payloadForHistory([
      record({ commission: 15000.49, logistics: 9000.51, aiInsights: legacy() }),
      record({ commission: 0.49, logistics: -0.49 }),
    ]);
    const metrics = await metricsFor({ ...payload, revenue: 200000.2, profit: 60000.2, margin: 30.04 });
    const expenses = metrics.расходы;
    assert.equal(expenses.расходыOzonПоУПД.сумма, 15000);
    assert.equal(expenses.агентскоеВознаграждениеПоУПД.сумма, 9001);
    assert.equal(
      expenses.комиссииМаркетплейса.сумма + expenses.логистика.сумма
        + expenses.расходыOzonПоУПД.сумма + expenses.агентскоеВознаграждениеПоУПД.сумма,
      Math.round(payload.commission) + Math.round(payload.logistics),
      "округление сохраняет прежнюю общую сумму, а не округляет её заново после переноса",
    );
    assert.equal(metrics.выручка, 200000);
    assert.equal(metrics.чистаяПрибыль, 60000);
    assert.equal(metrics.маржаПроцент, 30);
  });

  it("старый payload без новых полей сохраняет обычные категории без нулевых УПД-ярлыков", async () => {
    const metrics = await metricsFor({ revenue: 100000, profit: 30000, margin: 30, commission: 12000, logistics: 7000 });
    assert.equal(metrics.расходы.комиссииМаркетплейса.сумма, 12000);
    assert.equal(metrics.расходы.логистика.сумма, 7000);
    assert.equal(Object.hasOwn(metrics.расходы, "расходыOzonПоУПД"), false);
    assert.equal(Object.hasOwn(metrics.расходы, "агентскоеВознаграждениеПоУПД"), false);
  });

  it("нулевые и нечисловые новые поля не выдумывают УПД-расходы", async () => {
    const metrics = await metricsFor({ commission: 12000, logistics: 7000, updServices: "15000", updAgentFee: null });
    assert.equal(Object.hasOwn(metrics.расходы, "расходыOzonПоУПД"), false);
    assert.equal(Object.hasOwn(metrics.расходы, "агентскоеВознаграждениеПоУПД"), false);
    assert.equal(metrics.расходы.комиссииМаркетплейса.сумма, 12000);
    assert.equal(metrics.расходы.логистика.сумма, 7000);
  });

  it("отрицательная УПД-корректировка остаётся отдельной категорией, без abs/clamp и логистики", async () => {
    const metrics = await metricsFor({ revenue: 100000, commission: -1500, logistics: -250, updServices: -1500, updAgentFee: -250 });
    assert.equal(metrics.расходы.расходыOzonПоУПД.сумма, -1500);
    assert.equal(metrics.расходы.агентскоеВознаграждениеПоУПД.сумма, -250);
    assert.equal(metrics.расходы.логистика.сумма, 0);
    assert.equal(metrics.расходы.комиссииМаркетплейса.сумма, 0);
  });
});
