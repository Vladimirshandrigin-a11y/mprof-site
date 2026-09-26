// Автодобавление отсутствующих товаров в каталог: XLSX «Отчёт по начислениям» и API-расчёт.
// Реальные модули проекта (общая функция импорта, загрузчик API-расчёта, маршруты) на моках:
// in-memory «Supabase», подмена Ozon-fetch, подмена auth/consume. Живых Ozon-запросов, записей
// в БД и списаний нет; ожидания — независимые литералы.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { makeFakeSupabase } from "./helpers/fake-supabase.mjs";
import { makeMockCloud } from "./helpers/mock-cloud.mjs";
import {
  authLib,
  catalogImport as CI,
  catalogSync,
  cryptoLib,
  diagnosticRoutePath,
  importRoute,
  nextServer,
  parseBuf,
  profitLib,
  quietly,
  realizationLib,
  saveCalcRoute,
  saveFlow as SF,
  session as SES,
  product as PB,
} from "./helpers/modules.mjs";

const cand = (offerId, name = `Товар ${offerId}`, sku = "") => ({ offerId, name, ...(sku ? { sku } : {}) });
const prod = (user_id, sku, cost_price = 0, name = `имя ${sku}`) => ({ user_id, sku, name, cost_price });
const bySku = (fake, user) => Object.fromEntries(fake.rowsOf("products", user).map((r) => [r.sku, r]));
const skusOf = (fake, user) => fake.rowsOf("products", user).map((r) => r.sku).sort();

// ---------------------------------------------------------------------------
describe("общая точка импорта: планирование по существующим правилам сопоставления", () => {
  it("нормализация артикула совпадает с расчётным правилом (normArticleKey): trim, lower, схлопывание пробелов", () => {
    for (const s of ["ART-A", "  art-a ", "Art   B", "ТОВАР  1", "", "   ", null, undefined]) {
      assert.equal(CI.normArticle(s), PB.normArticleKey(s), JSON.stringify(s));
    }
  });
  it("план: отсутствующие → toCreate (sku = артикул как в отчёте, cost не задаём), совпавшие → alreadyInCatalog", () => {
    const plan = CI.planCatalogImport(
      [cand("ART-A"), cand("  art-b  ", "Б"), cand("NEW-1", "Новый один"), cand("NEW-2", "")],
      [{ sku: "art-a" }, { sku: "ART-B" }]
    );
    assert.deepEqual(plan.toCreate, [
      { sku: "NEW-1", name: "Новый один" },
      { sku: "NEW-2", name: "NEW-2" }, // нет названия → артикул
    ]);
    assert.equal(plan.alreadyInCatalog, 2);
    assert.deepEqual([plan.noArticle, plan.invalid, plan.ambiguous.length], [0, 0, 0]);
  });
  it("неоднозначность не сливаем: две строки каталога с одним артикулом / разные Ozon SKU у одного артикула → ambiguous, не добавляем", () => {
    const plan = CI.planCatalogImport(
      [cand("DUP", "д"), cand("CONF", "к1", "100"), cand("CONF", "к2", "200"), cand("OK", "ок", "1"), cand("OK", "ок", "1")],
      [{ sku: "dup" }, { sku: "DUP " }]
    );
    assert.deepEqual(plan.ambiguous, [
      { article: "DUP", reason: "catalog_duplicates" },
      { article: "CONF", reason: "conflicting_sku" },
    ]);
    assert.deepEqual(plan.toCreate, [{ sku: "OK", name: "ок" }]); // тот же SKU повторно — не конфликт
  });
  it("без артикула добавить нельзя (noArticle), слишком длинный артикул — invalid; товар только с Ozon-SKU не «сливается» по SKU", () => {
    const plan = CI.planCatalogImport(
      [{ offerId: "", sku: "555", name: "без артикула" }, cand("X".repeat(201)), cand("REAL", "р", "555")],
      [{ sku: "555" }] // в каталоге строка с sku = Ozon-SKU: артикулом это не считается
    );
    assert.deepEqual([plan.noArticle, plan.invalid], [1, 1]);
    assert.deepEqual(plan.toCreate, [{ sku: "REAL", name: "р" }]);
  });
});

// ---------------------------------------------------------------------------
describe("общая точка импорта: запись в каталог (in-memory БД)", () => {
  it("добавляет только отсутствующие товары: sku/название из источника, cost_price = 0 («не указана»); существующие не тронуты", async () => {
    const fake = makeFakeSupabase({ products: [prod("u1", "ART-A", 150, "Мой товар А")] });
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("ART-A", "Другое имя"), cand("ART-B", "Товар Б"), cand("ART-C", "Товар В")]);
    assert.equal(res.ok, true);
    assert.deepEqual(res.created, [{ sku: "ART-B", name: "Товар Б" }, { sku: "ART-C", name: "Товар В" }]);
    assert.equal(res.alreadyInCatalog, 1);
    const rows = bySku(fake, "u1");
    assert.deepEqual([rows["ART-B"].cost_price, rows["ART-C"].cost_price], [0, 0]);
    assert.deepEqual([rows["ART-A"].cost_price, rows["ART-A"].name], [150, "Мой товар А"]);
    assert.deepEqual([fake.count("products", "update"), fake.count("products", "delete")], [0, 0], "существующие строки не обновлялись и не удалялись");
  });
  it("существующая стоимость и название не перезаписываются даже при другом названии в источнике и повторе", async () => {
    const fake = makeFakeSupabase({ products: [prod("u1", "ART-A", 99.5, "Оригинал")] });
    for (let i = 0; i < 3; i++) await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("art-a", "Совсем другое имя")]);
    assert.deepEqual(fake.rowsOf("products").map((r) => [r.sku, r.name, r.cost_price]), [["ART-A", "Оригинал", 99.5]]);
    assert.equal(fake.writes("products"), 0);
  });
  it("повторный запрос дублей не создаёт: created = 0, строк столько же", async () => {
    const fake = makeFakeSupabase();
    const items = [cand("A1"), cand("A2"), cand("A3")];
    const first = await CI.importMissingCatalogProducts(fake.admin, "u1", items);
    const second = await CI.importMissingCatalogProducts(fake.admin, "u1", items);
    assert.deepEqual([first.created.length, second.created.length, second.alreadyInCatalog], [3, 0, 3]);
    assert.deepEqual(skusOf(fake, "u1"), ["A1", "A2", "A3"]);
    assert.equal(fake.count("products", "insert"), 1, "второй запрос вообще не писал");
  });
  it("одновременные запросы (5 параллельных) — по одной строке на артикул; сумма created = числу товаров", async () => {
    const fake = makeFakeSupabase();
    const items = [cand("C1"), cand("C2"), cand("C3"), cand("C4")];
    const results = await Promise.all(Array.from({ length: 5 }, () => CI.importMissingCatalogProducts(fake.admin, "u1", items)));
    assert.ok(results.every((r) => r.ok));
    assert.equal(results.reduce((a, r) => a + r.created.length, 0), 4);
    assert.deepEqual(skusOf(fake, "u1"), ["C1", "C2", "C3", "C4"]);
    assert.equal(fake.count("products", "insert"), 1);
  });
  it("запросы с разным написанием одного артикула (регистр/пробелы) дают одну строку", async () => {
    const fake = makeFakeSupabase();
    await Promise.all([
      CI.importMissingCatalogProducts(fake.admin, "u1", [cand("Art  1", "первое")]),
      CI.importMissingCatalogProducts(fake.admin, "u1", [cand("ART 1", "второе")]),
      CI.importMissingCatalogProducts(fake.admin, "u1", [cand(" art 1 ", "третье")]),
    ]);
    assert.equal(fake.rowsOf("products", "u1").length, 1);
  });
  it("другой процесс (без сериализации), оба видели пустой каталог: остаётся одна строка на артикул, лишняя удалена", async () => {
    const fake = makeFakeSupabase();
    const items = [cand("R1"), cand("R2")];
    const [a, b] = await Promise.all([
      CI.importMissingCatalogProducts(fake.admin, "u1", items, { serialize: false }),
      CI.importMissingCatalogProducts(fake.admin, "u1", items, { serialize: false }),
    ]);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(skusOf(fake, "u1"), ["R1", "R2"]);
    assert.equal(a.duplicatesRemoved + b.duplicatesRemoved, 2);
    assert.equal(a.created.length + b.created.length, 2, "каждая строка засчитана ровно одному из запросов");
  });
  it("параллельно созданная пользователем строка с введённой стоимостью (старше нашей) остаётся; наша нулевая удаляется", async () => {
    const fake = makeFakeSupabase();
    fake.hooks.beforeInsert = async (table, rows, tables, h) => {
      // «другой писатель» успел вставить тот же артикул раньше нас и уже указал стоимость
      if (table === "products" && !tables.products.some((r) => r.sku === "RACE")) {
        tables.products.push({ id: h.nextId(), created_at: "2026-01-01T00:00:00.000Z", user_id: "u1", sku: "RACE", name: "пользовательская", cost_price: 120 });
      }
    };
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("RACE", "из отчёта")]);
    assert.ok(res.ok);
    assert.equal(res.duplicatesRemoved, 1);
    assert.deepEqual(fake.rowsOf("products", "u1").map((r) => [r.sku, r.name, r.cost_price]), [["RACE", "пользовательская", 120]]);
    assert.deepEqual(res.created, [], "созданной эту строку не объявляем");
  });
  it("строки с уже указанной стоимостью при очистке дублей не удаляются", async () => {
    const fake = makeFakeSupabase();
    fake.hooks.beforeInsert = async (table, rows, tables, h) => {
      if (table === "products" && !tables.products.some((r) => r.sku === "KEEP")) {
        tables.products.push({ id: h.nextId(), created_at: "2026-01-01T00:00:00.000Z", user_id: "u1", sku: "KEEP", name: "старая", cost_price: 10 });
      }
    };
    // пока идёт запись, пользователь уже выставил стоимость новой строке
    const realExec = fake.admin.from.bind(fake.admin);
    fake.admin.from = (t) => {
      const q = realExec(t);
      if (t !== "products") return q;
      const orig = q.exec.bind(q);
      q.exec = async () => {
        const r = await orig();
        if (q.op === "insert") for (const row of fake.tables.products) if (row.sku === "KEEP" && row.cost_price === 0) row.cost_price = 33;
        return r;
      };
      return q;
    };
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("KEEP")]);
    assert.ok(res.ok);
    assert.deepEqual(fake.rowsOf("products", "u1").map((r) => r.cost_price).sort((x, y) => x - y), [10, 33]);
    assert.equal(res.duplicatesRemoved, 0);
  });
  it("изоляция: у разных пользователей каталоги независимы — импорт одного не читает и не меняет строки другого", async () => {
    const fake = makeFakeSupabase({ products: [prod("u2", "SHARED", 500, "чужой")] });
    const r1 = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("SHARED", "мой"), cand("ONLY-U1")]);
    assert.deepEqual(r1.created.map((c) => c.sku), ["SHARED", "ONLY-U1"], "чужой SHARED каталог u1 не закрывает");
    const r2 = await CI.importMissingCatalogProducts(fake.admin, "u2", [cand("SHARED"), cand("ONLY-U1")]);
    assert.deepEqual(r2.created.map((c) => c.sku), ["ONLY-U1"]);
    assert.deepEqual(bySku(fake, "u2")["SHARED"].cost_price, 500);
    assert.deepEqual(skusOf(fake, "u1"), ["ONLY-U1", "SHARED"]);
    assert.deepEqual(skusOf(fake, "u2"), ["ONLY-U1", "SHARED"]);
    assert.ok(fake.ops.every((o) => o.table === "products"));
  });
  it("неоднозначное сопоставление в каталоге: товар не добавляется и ничего не объединяется", async () => {
    const fake = makeFakeSupabase({ products: [prod("u1", "DUP", 10), prod("u1", "dup ", 20)] });
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("DUP"), cand("FRESH")]);
    assert.ok(res.ok);
    assert.deepEqual(res.ambiguous, [{ article: "DUP", reason: "catalog_duplicates" }]);
    assert.deepEqual(res.created.map((c) => c.sku), ["FRESH"]);
    assert.equal(fake.rowsOf("products", "u1").filter((r) => CI.normArticle(r.sku) === "dup").length, 2, "дубликаты каталога не тронуты");
  });
  it("ошибка записи возвращается явно (ok=false), created пуст; после устранения причины повтор создаёт товары один раз", async () => {
    const fake = makeFakeSupabase();
    fake.faults.push({ table: "products", op: "insert", message: "insert boom", persist: true });
    const bad = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("E1"), cand("E2")]);
    assert.deepEqual([bad.ok, bad.error, bad.created], [false, "insert boom", []]);
    assert.equal(fake.rowsOf("products").length, 0);
    fake.faults.length = 0;
    const good = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("E1"), cand("E2")]);
    assert.deepEqual([good.ok, good.created.length], [true, 2]);
    assert.equal(fake.rowsOf("products").length, 2);
  });
  it("БД подтвердила не все строки (например, политика) — не выдаём за успех", async () => {
    const fake = makeFakeSupabase();
    fake.faults.push({ table: "products", op: "insert", short: true, persist: true });
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("S1"), cand("S2")]);
    assert.equal(res.ok, false);
    assert.match(res.error, /не все/);
  });
  it("ошибка чтения каталога → ok=false без записи", async () => {
    const fake = makeFakeSupabase();
    fake.faults.push({ table: "products", op: "select", message: "read boom", persist: true });
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("Z1")]);
    assert.deepEqual([res.ok, res.error], [false, "read boom"]);
    assert.equal(fake.writes("products"), 0);
  });
  it("каталог больше одной страницы (2500 строк): существующий товар на дальней странице виден, дубль не создаётся", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => prod("u1", `SKU-${String(i).padStart(4, "0")}`, 5));
    const fake = makeFakeSupabase({ products: many.map((r, i) => ({ id: `p-${String(i).padStart(5, "0")}`, created_at: "2026-01-01T00:00:00.000Z", ...r })) });
    const res = await CI.importMissingCatalogProducts(fake.admin, "u1", [cand("SKU-2400"), cand("NEW-X")]);
    assert.deepEqual(res.created.map((c) => c.sku), ["NEW-X"]);
    assert.equal(fake.rowsOf("products", "u1").length, 2501);
  });
  it("нет пользователя / слишком много товаров → явная ошибка без записи", async () => {
    const fake = makeFakeSupabase();
    assert.equal((await CI.importMissingCatalogProducts(fake.admin, "", [cand("A")])).ok, false);
    const big = Array.from({ length: 5001 }, (_, i) => cand(`B${i}`));
    assert.equal((await CI.importMissingCatalogProducts(fake.admin, "u1", big)).ok, false);
    assert.equal(fake.ops.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Патчи модулей (auth/crypto/fetch) — восстанавливаются после каждого теста.
const undo = [];
function patch(obj, key, value) {
  const prev = obj[key];
  obj[key] = value;
  undo.push(() => {
    obj[key] = prev;
  });
}
afterEach(() => {
  while (undo.length) undo.pop()();
});

function nextReq(url, body, headers = {}) {
  return new nextServer.NextRequest(url, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function asUser(fake, userId) {
  patch(authLib, "authenticateRequest", async () => ({ ok: true, admin: fake.admin, userId }));
}

describe("сценарий XLSX: файл → сопоставление → автодобавление → повторная проверка → стоимость → расчёт", () => {
  const fileRows = () => parseBuf(scenario("basic")).report.rows;
  const asEntries = (fake, u) => fake.rowsOf("products", u).map((r) => ({ sku: r.sku, name: r.name, cost_price: r.cost_price }));
  const evaluate = (catalog) => {
    const p = parseBuf(scenario("basic"));
    return SES.evaluateAccrual({
      report: { rows: p.report.rows, period: p.report.period, warnings: p.warnings, sheet: p.report.sheetName, rowCount: p.report.summary.rowCount },
      catalog,
      inputs: { taxPercent: "7", packaging: "", deliveryToWarehouse: "", salary: "", other: "", adsOutsideOzon: "" },
      generatedAt: "2026-07-01T10:00:00.000Z",
    });
  };

  it("кандидаты — только товары, где себестоимость нужна и которых нет в каталоге; только артикул/SKU/название (не строки отчёта и суммы)", () => {
    assert.deepEqual(SES.accrualMissingCatalogCandidates(fileRows(), []), [
      { offerId: "ART-A", sku: "111", name: "Товар А" },
      { offerId: "ART-B", sku: "222", name: "Товар Б" },
    ]); // ART-C — только услуги (нетто-количество 0): в каталог не добавляется
    for (const c of SES.accrualMissingCatalogCandidates(fileRows(), [])) assert.deepEqual(Object.keys(c).sort(), ["name", "offerId", "sku"]);
    // существующий (даже с нулевой стоимостью) не кандидат
    assert.deepEqual(SES.accrualMissingCatalogCandidates(fileRows(), [{ sku: "art-a", name: "a", cost_price: 0 }]).map((c) => c.offerId), ["ART-B"]);
  });

  it("автодобавление через маршрут: товары в каталоге, повторная проверка видит их; стоимости нет → расчёт неполный, consume 0 и записей расчёта 0", async () => {
    const fake = makeFakeSupabase();
    asUser(fake, "u1");
    const res = await importRoute.POST(nextReq("http://localhost/api/cloud/products/import-missing", { products: SES.accrualMissingCatalogCandidates(fileRows(), []) }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, { created: 2, alreadyInCatalog: 0, ambiguous: 0, noArticle: 0, invalid: 0, duplicatesRemoved: 0 });
    assert.deepEqual(skusOf(fake, "u1"), ["ART-A", "ART-B"]);

    // повторная проверка того же файла: каталог обновлён, кандидатов больше нет
    const catalog = asEntries(fake, "u1");
    assert.deepEqual(SES.accrualMissingCatalogCandidates(fileRows(), catalog), []);
    const ev = evaluate(catalog);
    assert.equal(ev.readyToSave, false);
    assert.deepEqual(ev.problemProducts.map((p) => [p.article, p.reason]), [["ART-A", "cost_missing"], ["ART-B", "cost_missing"]]);

    // попытка сохранить: consume 0, записей расчёта 0
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const out = await ctl.save({ snapshot: ev.snapshot, ready: ev.readyToSave, userId: "u1" });
    assert.equal(out.status, "not_ready");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length, cloud.log.dup], [0, 0, 0, 0, 0]);
  });

  it("после заполнения стоимости повторная проверка готова: сохранение — один consume и одна запись", async () => {
    const fake = makeFakeSupabase();
    asUser(fake, "u1");
    await importRoute.POST(nextReq("http://localhost/api/cloud/products/import-missing", { products: SES.accrualMissingCatalogCandidates(fileRows(), []) }));
    for (const r of fake.tables.products) r.cost_price = r.sku === "ART-A" ? 100 : 50; // владелец заполнил стоимость
    const ev = evaluate(asEntries(fake, "u1"));
    assert.equal(ev.readyToSave, true);
    assert.deepEqual(ev.problemProducts, []);
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    assert.equal((await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" })).status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.histories.length], [1, 1, 1]);
    assert.equal(fake.rowsOf("products", "u1").length, 2, "каталог при расчёте не менялся");
  });

  it("повторный и одновременный импорт того же файла: дублей нет, стоимость не перезаписывается", async () => {
    const fake = makeFakeSupabase();
    asUser(fake, "u1");
    const products = SES.accrualMissingCatalogCandidates(fileRows(), []);
    const call = () => importRoute.POST(nextReq("http://localhost/x", { products }));
    const results = await Promise.all([call(), call(), call()]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    assert.equal(bodies.reduce((a, b) => a + b.data.created, 0), 2);
    for (const r of fake.tables.products) r.cost_price = 77;
    await call();
    assert.deepEqual(fake.rowsOf("products").map((r) => r.cost_price), [77, 77]);
    assert.equal(fake.rowsOf("products").length, 2);
  });

  it("ошибка импорта отдаётся явно (502, error), товары не добавлены; повтор после исправления проходит", async () => {
    const fake = makeFakeSupabase();
    asUser(fake, "u1");
    fake.faults.push({ table: "products", op: "insert", message: "db is down", persist: true });
    const products = SES.accrualMissingCatalogCandidates(fileRows(), []);
    const bad = await quietly(() => importRoute.POST(nextReq("http://localhost/x", { products })));
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /db is down/);
    assert.equal(fake.rowsOf("products").length, 0);
    fake.faults.length = 0;
    const ok = await importRoute.POST(nextReq("http://localhost/x", { products }));
    assert.equal((await ok.json()).data.created, 2);
  });

  it("user_id из тела игнорируется: строки создаются только владельцу токена; изоляция каталогов", async () => {
    const fake = makeFakeSupabase({ products: [prod("victim", "ART-A", 999, "чужой")] });
    asUser(fake, "u1");
    const res = await importRoute.POST(
      nextReq("http://localhost/x", { user_id: "victim", products: [{ offerId: "ART-A", user_id: "victim", name: "n" }, { offerId: "ART-Z", user_id: "victim" }] })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(skusOf(fake, "u1"), ["ART-A", "ART-Z"]);
    assert.deepEqual(fake.rowsOf("products", "victim").map((r) => [r.sku, r.cost_price, r.name]), [["ART-A", 999, "чужой"]]);
  });

  it("некорректное тело → 400 без записи; без авторизации маршрут отдаёт ответ auth и в БД не идёт", async () => {
    const fake = makeFakeSupabase();
    asUser(fake, "u1");
    for (const body of [{ products: "x" }, { products: [{ offerId: 5 }] }, { products: [null] }, {}]) {
      assert.equal((await importRoute.POST(nextReq("http://localhost/x", body))).status, 400, JSON.stringify(body));
    }
    assert.equal(fake.ops.length, 0);
    const denied = new nextServer.NextResponse(null, { status: 401 });
    patch(authLib, "authenticateRequest", async () => ({ ok: false, response: denied }));
    assert.equal((await importRoute.POST(nextReq("http://localhost/x", { products: [] }))).status, 401);
  });
});

// ---------------------------------------------------------------------------
// API-сценарий: сервер save-calculation целиком на моках.
const rzRow = (offer, sku, name, saleQty, saleAmount, retQty = 0, retAmount = 0) => ({
  item: { offer_id: offer, sku, name },
  delivery_commission: { amount: saleAmount, quantity: saleQty },
  return_commission: { amount: retAmount, quantity: retQty },
  seller_price_per_instance: saleAmount / Math.max(1, saleQty),
});
const REALIZATION = [
  rzRow("ART-A", 111, "Товар А", 10, 1500, 2, 300),
  rzRow("ART-B", 222, "Товар Б", 5, 900),
  rzRow("ART-C", 333, "Товар В", 1, 100),
];

function stubOzon(state) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    state.calls.push(u);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/v3/finance/transaction/list")) {
      return json({ result: { operations: state.operations, page_count: 1, row_count: state.operations.length } });
    }
    if (u.includes("/v2/finance/realization")) return json({ result: { header: {}, rows: state.rows } });
    if (u.includes("/v2/posting/fbo/list")) return json({ result: [] });
    if (u.includes("/v3/posting/fbs/list")) return json({ result: { postings: [], has_next: false } });
    return new Response("{}", { status: 404 });
  };
  undo.push(() => {
    globalThis.fetch = orig;
  });
}

function setupApi({ userId = "u1", catalog = [], rows = REALIZATION, extraTables = {} } = {}) {
  const fake = makeFakeSupabase({
    ozon_connections: [{ user_id: userId, client_id: "c1", api_key_encrypted: "enc" }],
    products: catalog,
    ...extraTables,
  });
  const state = {
    calls: [],
    rows,
    operations: [{ operation_type: "OperationAgentDeliveredToCustomer", type: "orders", accruals_for_sale: 1000, sale_commission: -150, amount: 850, services: [] }],
  };
  const rpc = [];
  stubOzon(state);
  asUser(fake, userId);
  patch(authLib, "getUserScopedClient", () => ({
    rpc: async (name) => {
      rpc.push(name);
      return { data: { ok: true, unlimited: false, used: 1, allowance: 1 }, error: null };
    },
  }));
  patch(cryptoLib, "isEncryptionConfigured", () => true);
  patch(cryptoLib, "decryptOzonApiKey", () => "plain-api-key");
  const prevFlag = process.env.OZON_FINANCE_ACCRUAL_ENABLED;
  delete process.env.OZON_FINANCE_ACCRUAL_ENABLED; // legacy-источник финансов: подменён fetch-моком
  undo.push(() => {
    if (prevFlag !== undefined) process.env.OZON_FINANCE_ACCRUAL_ENABLED = prevFlag;
  });
  const post = async () => {
    const res = await quietly(() =>
      saveCalcRoute.POST(nextReq("http://localhost/api/ozon/save-calculation", { month: "2026-06", manualExpenses: { tax: 7 } }))
    );
    return { status: res.status, json: await res.json() };
  };
  return { fake, state, rpc, post };
}

const noCalcWrites = (fake) => [fake.count("calculations", "insert"), fake.count("report_history", "insert"), fake.rowsOf("calculations").length, fake.rowsOf("report_history").length];

describe("сценарий API: автодобавление в save-calculation до consume и сохранения", () => {
  it("каталог пуст: товары реализации добавляются, ответ incomplete_cost со счётчиком, consume 0, calculations/report_history 0", async () => {
    const { fake, rpc, post } = setupApi();
    const { status, json } = await post();
    assert.equal(status, 400);
    assert.equal(json.code, "incomplete_cost");
    assert.deepEqual(json.catalogImport, { attempted: true, ok: true, created: 3, alreadyInCatalog: 0, ambiguous: 0, rowsWithoutOfferId: 0 });
    assert.deepEqual([json.unmatchedItems, json.matchedNoCostCount], [0, 3]);
    assert.deepEqual(fake.rowsOf("products", "u1").map((r) => [r.sku, r.name, r.cost_price]).sort(), [
      ["ART-A", "Товар А", 0],
      ["ART-B", "Товар Б", 0],
      ["ART-C", "Товар В", 0],
    ]);
    assert.deepEqual(rpc, [], "consume не вызывался");
    assert.deepEqual(noCalcWrites(fake), [0, 0, 0, 0]);
  });

  it("источник — строки реализации: товары добавляются, даже если в выборке отправлений (postings) их нет", async () => {
    const { fake, state, post } = setupApi();
    await post();
    assert.ok(state.calls.some((u) => u.includes("/v2/finance/realization")));
    assert.ok(state.calls.some((u) => u.includes("/v2/posting/fbo/list")), "отправления запрашивались и вернули пусто");
    assert.equal(fake.rowsOf("products", "u1").length, 3);
  });

  it("повторный расчёт: дублей нет, стоимость нулевая → по-прежнему неполно (без нового импорта), consume 0", async () => {
    const { fake, rpc, post } = setupApi();
    await post();
    const again = await post();
    assert.equal(again.status, 400);
    assert.deepEqual(again.json.catalogImport, { attempted: false }, "нечего добавлять — импорт не вызывается");
    assert.deepEqual([again.json.unmatchedItems, again.json.matchedNoCostCount], [0, 3]);
    assert.equal(fake.rowsOf("products", "u1").length, 3);
    assert.equal(fake.count("products", "insert"), 1);
    assert.deepEqual(rpc, []);
  });

  it("одновременные save-calculation одного пользователя: по одной строке на товар, consume 0", async () => {
    const { fake, rpc, post } = setupApi();
    const rs = await Promise.all([post(), post(), post()]);
    assert.deepEqual(rs.map((r) => r.status), [400, 400, 400]);
    assert.equal(rs.reduce((a, r) => a + (r.json.catalogImport.created ?? 0), 0), 3);
    assert.deepEqual(skusOf(fake, "u1"), ["ART-A", "ART-B", "ART-C"]);
    assert.deepEqual(rpc, []);
  });

  it("заполнение стоимости → расчёт проходит: ровно один consume, одна запись calculations и report_history, каталог не тронут", async () => {
    const { fake, rpc, post } = setupApi();
    await post();
    const before = JSON.stringify(fake.tables.products);
    for (const r of fake.tables.products) r.cost_price = { "ART-A": 100, "ART-B": 50, "ART-C": 20 }[r.sku];
    const withCosts = JSON.stringify(fake.tables.products);
    const ok = await post();
    assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 300));
    assert.equal(ok.json.ok, true);
    assert.deepEqual(rpc, ["consume_api_calculation"]);
    assert.deepEqual(noCalcWrites(fake), [1, 1, 1, 1]);
    assert.notEqual(before, withCosts);
    assert.equal(JSON.stringify(fake.tables.products), withCosts, "каталог при расчёте не менялся");
    assert.equal(fake.count("products", "insert"), 1);
  });

  it("существующие товары не перезаписываются: чужая стоимость/название сохраняются, добавляются только отсутствующие", async () => {
    const existing = [{ id: "e-1", created_at: "2026-01-01T00:00:00.000Z", ...prod("u1", "art-a", 123.45, "Мой А") }];
    const { fake, post } = setupApi({ catalog: existing });
    const { json } = await post();
    assert.equal(json.catalogImport.created, 2);
    const rows = bySku(fake, "u1");
    assert.deepEqual([rows["art-a"].cost_price, rows["art-a"].name], [123.45, "Мой А"]);
    assert.deepEqual([fake.count("products", "update"), fake.count("products", "delete")], [0, 0]);
    assert.deepEqual([json.unmatchedItems, json.matchedNoCostCount], [0, 2], "ART-A с корректной стоимостью в «без себестоимости» не попал");
  });

  it("изоляция: каталог другого пользователя не влияет на импорт и не меняется", async () => {
    const other = [{ id: "o-1", created_at: "2026-01-01T00:00:00.000Z", ...prod("u2", "ART-A", 500, "чужой А") }];
    const { fake, post } = setupApi({ catalog: other });
    const { json } = await post();
    assert.equal(json.catalogImport.created, 3, "у u1 своего ART-A нет — добавляется");
    assert.deepEqual(fake.rowsOf("products", "u2").map((r) => [r.sku, r.cost_price, r.name]), [["ART-A", 500, "чужой А"]]);
    assert.equal(fake.rowsOf("products", "u1").length, 3);
  });

  it("ошибка импорта не маскируется: ответ несёт catalogImport.ok=false и текст ошибки, товары не добавлены, consume 0; повтор после исправления добавляет", async () => {
    const { fake, rpc, post } = setupApi();
    fake.faults.push({ table: "products", op: "insert", message: "insert refused", persist: true });
    const bad = await post();
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.catalogImport, { attempted: true, ok: false, error: "insert refused", created: 0 });
    assert.deepEqual([bad.json.unmatchedItems, bad.json.matchedNoCostCount], [3, 0], "счётчики честные: ничего не добавлено");
    assert.equal(fake.rowsOf("products").length, 0);
    assert.deepEqual(rpc, []);
    assert.deepEqual(noCalcWrites(fake), [0, 0, 0, 0]);
    fake.faults.length = 0;
    const good = await post();
    assert.equal(good.json.catalogImport.created, 3);
  });

  it("строки без артикула не добавляются и явно посчитаны; неоднозначные не сливаются", async () => {
    const rows = [...REALIZATION, rzRow("", 999, "без артикула", 1, 50)];
    const { fake, post } = setupApi({ rows });
    const { json } = await post();
    assert.equal(json.catalogImport.created, 3);
    assert.equal(json.catalogImport.rowsWithoutOfferId, 1);
    assert.equal(json.unmatchedItems, 1, "строка без артикула остаётся несопоставленной");
    assert.equal(fake.rowsOf("products").length, 3);

    const conflicting = [rzRow("CONF", 1, "к1", 1, 10), rzRow("CONF", 2, "к2", 1, 10)];
    const x = setupApi({ rows: conflicting });
    const r2 = await x.post();
    assert.equal(r2.json.catalogImport.ambiguous, 1);
    assert.equal(x.fake.rowsOf("products").length, 0, "разные Ozon SKU под одним артикулом не объединяем наугад");
  });
});

describe("диагностика остаётся read-only", () => {
  it("загрузчик расчёта (его использует fullCalcCheck) возвращает товары реализации, но не пишет ни в одну таблицу", async () => {
    const { fake, state } = setupApi();
    const before = JSON.stringify(fake.tables);
    const loaded = await quietly(() =>
      profitLib.loadAndComputeApiProfit({
        admin: fake.admin,
        userId: "u1",
        clientId: "c1",
        apiKey: "k",
        range: { dateFrom: "2026-06-01T00:00:00.000Z", dateTo: "2026-06-30T23:59:59.999Z" },
        month: "2026-06",
        manualExpenses: { tax: 0, packaging: 0, warehouseDelivery: 0, salary: 0, other: 0 },
      })
    );
    assert.equal(loaded.ok, false);
    assert.equal(loaded.kind, "realization_cost");
    assert.equal(loaded.resolution.code, "unmatched");
    assert.deepEqual(loaded.unmatched.products.map((p) => p.offerId).sort(), ["ART-A", "ART-B", "ART-C"]);
    assert.equal(fake.ops.filter((o) => o.op !== "select").length, 0, "0 записей в любые таблицы");
    assert.equal(JSON.stringify(fake.tables), before);
    assert.ok(state.calls.length > 0);
  });

  it("публичный loadRealizationDiagnostic (диагностики) по-прежнему возвращает только диагностику", async () => {
    const { state } = setupApi();
    void state;
    const rz = await realizationLib.loadRealizationDiagnostic({ clientId: "c", apiKey: "k", month: "2026-06", catalog: [] });
    assert.equal(rz.connected, true);
    assert.equal("unmatched" in rz, false);
    assert.equal(rz.candidateCogs.unmatchedRows, 3);
  });

  it("маршрут диагностики не импортирует общую точку записи и не пишет в products", () => {
    const src = readFileSync(diagnosticRoutePath, "utf8");
    assert.doesNotMatch(src, /catalog-import|importMissingCatalogProducts|realization-catalog-sync|syncMissingRealizationProducts/);
    assert.doesNotMatch(src, /from\("products"\)[\s\S]{0,240}\.(insert|upsert|update|delete)\(/);
  });

  it("автодобавление вызывается только из пользовательских маршрутов (save-calculation, import-missing, ручной импорт отправлений)", () => {
    const routes = ["app/api/ozon/save-calculation/route.ts", "app/api/cloud/products/import-missing/route.ts", "app/api/ozon/import-missing-products/route.ts"];
    const root = diagnosticRoutePath.replace(/app\/api\/ozon\/accrual-migration-diagnostic\/route\.ts$/, "");
    for (const r of routes) {
      const src = readFileSync(root + r, "utf8");
      assert.match(src, /catalog-import|realization-catalog-sync/, r);
    }
    for (const r of ["app/api/ozon/_lib/profit.ts", "app/api/ozon/_lib/realization.ts", "app/api/ozon/postings-match-diagnostic/route.ts", "app/api/ozon/calc-draft/route.ts"]) {
      const src = readFileSync(root + r, "utf8");
      assert.doesNotMatch(src, /importMissingCatalogProducts|syncMissingRealizationProducts/, r);
    }
  });

  it("realization-catalog-sync без несопоставленных строк / для no_cost ничего не пишет", async () => {
    const fake = makeFakeSupabase();
    const base = { admin: fake.admin, userId: "u1", unmatched: { products: [{ offerId: "X", sku: "", name: "x", rows: 1 }], rowsWithoutOfferId: 0 } };
    const noCost = await catalogSync.syncMissingRealizationProducts({ ...base, resolution: { ok: false, code: "no_cost", unmatchedRows: 0, noCostRows: 4 } });
    assert.deepEqual(noCost, { unmatchedItems: 0, matchedNoCostCount: 4, catalogImport: { attempted: false } });
    assert.equal(fake.ops.length, 0);
  });
});
