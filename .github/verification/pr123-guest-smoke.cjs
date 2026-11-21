const assert = require("node:assert/strict");
const { chromium } = require(process.argv[2]);
const origin = "http://127.0.0.1:39472";
const authOrigin = "http://127.0.0.1:39473";
const uid = "00000000-0000-4000-a000-000000000042";
const user = { id: uid, email: "client@example.test", aud: "authenticated", role: "authenticated" };
const pack = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const expires = Math.floor(Date.now() / 1000) + 3600;
const token = pack({ alg: "HS256", typ: "JWT" }) + "." + pack({ sub: uid, exp: expires }) + ".test";
const session = { access_token: token, refresh_token: "synthetic-refresh", expires_in: 3600,
  expires_at: expires, token_type: "bearer", user };

(async () => {
  const browser = await chromium.launch({
    headless: true,
  });
  try {
    let submissions = 0;
    let used = 0;
    let registrations = 0;
    const context = await browser.newContext();
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === authOrigin) {
        const headers = {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "*",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/auth/v1/signup") {
          registrations += 1;
          return route.fulfill({ json: user, headers });
        }
        if (url.pathname === "/auth/v1/token") return route.fulfill({ json: session, headers });
        if (url.pathname === "/auth/v1/user") return route.fulfill({ json: user, headers });
        if (url.pathname === "/rest/v1/uploaded_reports") return route.fulfill({ json: [], headers });
        throw new Error("Unexpected fixture Auth path " + url.pathname);
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      switch (url.pathname) {
        case "/api/cloud/profile":
          return route.fulfill({ json: { data: { id: uid, plan: "free", premium_until: null, calculations_used: used } } });
        case "/api/cloud/single-credits":
          return route.fulfill({ json: { count: 0 } });
        case "/api/cloud/calculations":
        case "/api/cloud/products":
          return route.fulfill({ json: { data: [] } });
        case "/api/ozon/connection":
        case "/api/ozon/performance/connection":
          return route.fulfill({ json: { connected: false } });
        case "/api/cloud/calculation-operations": {
          if (request.method() === "GET") return route.fulfill({ json: { data: { status: "none" } } });
          assert.equal(request.headers().authorization, "Bearer " + token);
          const { inputs, mode } = request.postDataJSON();
          assert.equal(mode, "manual");
          assert.equal(inputs.revenue, 1000);
          assert.equal(inputs.cost, 250);
          submissions++;
          if (used) return route.fulfill({ status: 402, json: { code: "limit_reached" } });
          used++;
          return route.fulfill({ json: { data: { status: "done", replay: false, calculation: {
            ...inputs, id: "00000000-0000-4000-a000-000000000041",
            user_id: uid, mode, edit_version: 0, created_at: new Date().toISOString(),
            profit: 750, margin: 75, total_expenses: 250,
          } } } });
        }
        case "/api/cloud/consume":
          throw new Error("Browser called retired consume endpoint");
        default:
          return route.fulfill({ json: { data: [] } });
      }
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("mprof_calc_count", "1");
    });
    await page.goto(origin + "/app", { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Ручной калькулятор" }).click();
    const revenue = page.locator(".mcalc-grid .fld").filter({ hasText: /^Выручка/ }).locator("input");
    const cost = page.locator(".mcalc-grid .fld").filter({ hasText: /^Себестоимость/ }).locator("input");
    await revenue.fill("1000");
    await cost.fill("250");
    await page.getByRole("button", { name: "Войти и рассчитать" }).click();
    await page.getByText(/Войдите или создайте аккаунт, чтобы получить первый/).waitFor();
    assert.equal(submissions, 0);
    assert.ok(await page.getByPlaceholder("Ваш email").evaluate(el => el === document.activeElement));

    await page.getByPlaceholder("Ваш email").fill("client@example.test");
    await page.getByPlaceholder("Пароль", { exact: true }).fill("synthetic-only-password");
    await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    await page.getByText(/вернитесь в эту вкладку к расчёту/).waitFor();
    assert.equal(registrations, 1);
    assert.equal(submissions, 0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Войти и рассчитать" }).waitFor();
    assert.equal(await revenue.inputValue(), "1000");
    assert.equal(await cost.inputValue(), "250");
    await page.getByPlaceholder("Ваш email").fill("client@example.test");
    await page.getByPlaceholder("Пароль", { exact: true }).fill("synthetic-only-password");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    const calculate = page.getByRole("button", { name: "Рассчитать чистую прибыль", exact: true });
    await calculate.waitFor();
    assert.equal(await revenue.inputValue(), "1000");
    assert.equal(await cost.inputValue(), "250");
    assert.equal(submissions, 0);
    await calculate.click();
    await page.getByText("Расчёт сохранён", { exact: true }).first().waitFor({ timeout: 15000 });
    assert.equal(submissions, 1);
    assert.ok(await page.locator(".mcalc-layout-grid").getByText(/750/).count() > 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("mprof_manual_before_sign_in")), null);
    console.log("PASS: guest authentication gate, focus, registration prompt, tab reload and preserved amounts, one account calculation and server result");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
