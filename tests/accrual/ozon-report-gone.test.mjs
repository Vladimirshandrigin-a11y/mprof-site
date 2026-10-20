// /api/ozon/report отключён (app/api/ozon/report/route.ts): GET и POST — 410 Gone
// с code "deprecated_flow" и Cache-Control: no-store. Обработчик не читает запрос
// (тело, заголовки, cookies, ключи Ozon), не обращается к Ozon и пишет в лог только
// факт вызова. Настоящий скомпилированный маршрут, без моков Next.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { REPO_ROOT, ozonReportRoute as R } from "./helpers/modules.mjs";

const LOG_LINE = "[api/ozon/report] 410 deprecated call";
const SECRET_CLIENT_ID = "client-id-SHOULD-NOT-LEAK-123";
const SECRET_API_KEY = "api-key-SHOULD-NOT-LEAK-456";

/** Запрос, любое обращение к которому записывается (обработчик не должен его трогать). */
function trapRequest(log) {
  const real = new Request("https://mprof-seller.ru/api/ozon/report", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Id": SECRET_CLIENT_ID, "Api-Key": SECRET_API_KEY, Cookie: "sb=session" },
    body: JSON.stringify({ clientId: SECRET_CLIENT_ID, apiKey: SECRET_API_KEY, daysBack: 30 }),
  });
  return new Proxy(real, {
    get(target, prop, receiver) {
      log.push(String(prop));
      return Reflect.get(target, prop, receiver);
    },
  });
}

let fetchCalls;
let logs;
const saved = {};

beforeEach(() => {
  fetchCalls = [];
  logs = [];
  saved.fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("обращение к сети запрещено в тесте");
  };
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    saved[m] = console[m];
    console[m] = (...args) => logs.push({ level: m, args });
  }
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  for (const m of ["log", "info", "warn", "error", "debug"]) console[m] = saved[m];
});

for (const method of ["GET", "POST"]) {
  describe(`/api/ozon/report ${method}`, () => {
    it("410 Gone, JSON с deprecated_flow и сообщением, Cache-Control: no-store", async () => {
      const res = await R[method]();
      assert.equal(res.status, 410);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await res.json(), {
        code: "deprecated_flow",
        message: "Этот API-маршрут больше не поддерживается.",
      });
    });

    it("не обращается к Ozon и другим системам (fetch не вызывается)", async () => {
      await R[method]();
      assert.equal(fetchCalls.length, 0);
    });

    it("не читает запрос: ни тело, ни заголовки, ни cookies, ни ключи", async () => {
      assert.equal(R[method].length, 0, "обработчик не принимает запрос");
      const touched = [];
      const res = await R[method](trapRequest(touched));
      assert.deepEqual(touched, [], `обращения к запросу: ${touched.join(", ")}`);
      const text = await res.text();
      assert.ok(!text.includes(SECRET_CLIENT_ID) && !text.includes(SECRET_API_KEY));
      assert.equal(fetchCalls.length, 0);
    });

    it("лог — ровно одна строка о факте вызова, без данных запроса", async () => {
      await R[method](trapRequest([]));
      assert.deepEqual(logs, [{ level: "warn", args: [LOG_LINE] }]);
      const all = JSON.stringify(logs);
      for (const s of [SECRET_CLIENT_ID, SECRET_API_KEY, "sb=session", "mprof-seller.ru"]) {
        assert.ok(!all.includes(s), s);
      }
    });
  });
}

describe("/api/ozon/report: исходный код заглушки", () => {
  const src = readFileSync(path.join(REPO_ROOT, "app/api/ozon/report/route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("нет обращений к Ozon, ключам, окружению и запросу", () => {
    for (const bad of ["api-seller.ozon.ru", "fetch(", "Client-Id", "Api-Key", "apiKey", "clientId", "process.env", ".json()", "req.", "request.", "headers()", "cookies()"]) {
      assert.ok(!src.includes(bad), bad);
    }
  });

  it("экспортирует только GET и POST (и настройки маршрута)", () => {
    const exported = [...src.matchAll(/export (?:async function|const|function) (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(exported, ["GET", "POST", "dynamic", "runtime"]);
  });
});
