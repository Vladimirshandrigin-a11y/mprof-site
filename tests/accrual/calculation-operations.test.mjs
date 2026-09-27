// Операции расчёта по XLSX на уровне клиента: контроллер сохранения (save-flow) с моком
// серверной транзакции (helpers/mock-cloud: saveOperation) и хранилище ключей операций
// (operation-store). Серверная транзакция на настоящей PostgreSQL и маршрут — в tests/db.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { makeEntitlements, makeMockCloud } from "./helpers/mock-cloud.mjs";
import { opStore as OS, parseBuf, saveFlow as SF, session as SES } from "./helpers/modules.mjs";
import { CAT } from "./helpers/expected.mjs";

const INPUTS = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "", salary: "", other: "3,33", adsOutsideOzon: "" };

function evaluate(buf, inputs = INPUTS) {
  const parsed = parseBuf(buf);
  assert.equal(parsed.ok, true);
  const report = {
    rows: parsed.report.rows,
    period: parsed.report.period,
    warnings: parsed.warnings,
    sheet: parsed.report.sheetName,
    rowCount: parsed.report.summary.rowCount,
  };
  const ev = SES.evaluateAccrual({ report, catalog: CAT, inputs, generatedAt: "2026-07-01T10:00:00.000Z" });
  return { fp: SES.reportFingerprint(report), ev, req: { snapshot: ev.snapshot, ready: ev.readyToSave, userId: "u1" } };
}
const A = (inputs) => evaluate(scenario("basic"), inputs);
const B = () => evaluate(scenario("incomplete_month"));

function openFile(ctl, x) {
  assert.equal(ctl.beginAttempt(null), true);
  assert.equal(ctl.beginAttempt(x.fp), true);
}

describe("операция расчёта: отказы до записи ничего не списывают", () => {
  it("сервер без миграции (unavailable): save_failed «не списано», списаний и строк нет, ключ сохраняется для повтора", async () => {
    const cloud = makeMockCloud({ opUnavailable: true });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(ctl, a);
    const out = await ctl.save(a.req);
    assert.deepEqual([out.status, out.charge], ["save_failed", "none"]);
    assert.deepEqual([cloud.log.consume, cloud.rows.size, cloud.log.histories.length, ctl.state.paid], [0, 0, 0, false]);
    assert.match(SES.saveOutcomeUi(out).note.text, /Попытка расчёта не списана/);
    cloud.cfg.opUnavailable = false;
    assert.equal((await ctl.save(a.req)).status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.opIds.length], [1, 1]);
  });

  it("ключ операции не совпадает с файлом (conflict): ничего не записано, ключ сброшен — следующее сохранение идёт с новым ключом", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    // Ключ A уже использован для другого файла (например, подменённое хранилище).
    const key = cloud.deps.operationIdFor(a.fp);
    cloud.ops.set(key, { requestHash: b.fp, contentHash: "x", rowId: null });
    openFile(ctl, a);
    const out = await ctl.save(a.req);
    assert.deepEqual([out.status, out.charge], ["save_failed", "none"]);
    assert.equal(cloud.pendingKeys.has(a.fp), false, "ключ сброшен");
    assert.deepEqual([cloud.log.consume, cloud.rows.size], [0, 0]);
    const again = await ctl.save(a.req);
    assert.equal(again.status, "saved");
    assert.notEqual(cloud.log.opIds.at(-1), key, "новый ключ");
    assert.equal(cloud.log.lastOp.requestHash, a.fp);
  });

  it("отказ в списании (limit_reached): paywall, дубль-гард спросят снова, строк нет", async () => {
    const cloud = makeMockCloud({ entitlement: makeEntitlements({ used: 1 }) });
    const ctl = new SF.AccrualSaveController({ ...cloud.deps, canCalculate: () => true }); // клиент устарел
    const a = A();
    openFile(ctl, a);
    const out = await ctl.save(a.req);
    assert.equal(out.status, "paywall");
    assert.equal(ctl.state.dupConfirmed, false);
    assert.deepEqual([cloud.rows.size, cloud.log.histories.length, cloud.log.consume], [0, 0, 1]);
  });
});

describe("операция расчёта: восстановление после перезагрузки и потерянного ответа", () => {
  it("незавершённая операция обходит устаревший клиентский paywall: сервер возвращает уже сохранённый расчёт без списания", async () => {
    const ent = makeEntitlements({ used: 0 });
    const cloud = makeMockCloud({ entitlement: ent, dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(tab1, a);
    assert.equal((await tab1.save(a.req)).status, "save_failed"); // зафиксировано, ответ потерян
    assert.equal(ent.st.used, 1);
    cloud.cfg.dropResponse = false;
    // Перезагрузка: права на клиенте уже «исчерпаны», но у файла есть незавершённый ключ.
    const tab2 = new SF.AccrualSaveController({ ...cloud.deps, canCalculate: () => ent.canCalculate() });
    openFile(tab2, a);
    const out = await tab2.save(a.req);
    assert.deepEqual([out.status, out.replay], ["saved", true]);
    assert.deepEqual([ent.st.used, cloud.rows.size, cloud.log.histories.length], [1, 1, 1]);
  });

  it("незавершённый ключ без записи на сервере и без попыток → paywall (сервер отказал), ничего не записано", async () => {
    const ent = makeEntitlements({ used: 1 });
    const cloud = makeMockCloud({ entitlement: ent });
    const ctl = new SF.AccrualSaveController({ ...cloud.deps, canCalculate: () => ent.canCalculate() });
    const a = A();
    cloud.deps.operationIdFor(a.fp); // ключ остался от прошлой сессии, но до сервера не дошёл
    openFile(ctl, a);
    assert.equal((await ctl.save(a.req)).status, "paywall");
    assert.deepEqual([ent.st.used, cloud.rows.size], [1, 0]);
  });

  it("восстановленный расчёт с другим содержимым (правка ставки после перезагрузки): обновление той же строки без списания", async () => {
    const cloud = makeMockCloud({ dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(tab1, a);
    await tab1.save(a.req);
    cloud.cfg.dropResponse = false;
    const key = cloud.pendingKeys.get(a.fp);
    const tab2 = new SF.AccrualSaveController(cloud.deps);
    openFile(tab2, a);
    assert.equal(tab2.adoptSaved(a.fp, cloud.status(key, a.fp)), true);
    const edited = A({ ...INPUTS, taxPercent: "10" });
    const out = await tab2.save(edited.req);
    assert.deepEqual([out.status, out.calculationWrite], ["saved", "update"]);
    assert.deepEqual([cloud.log.consume, cloud.rows.size, cloud.log.updates.length], [1, 1, 1]);
  });

  it("восстановленная операция, строку которой удалили из истории: «Сохранить» создаёт строку заново без списания", async () => {
    const cloud = makeMockCloud({ dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(tab1, a);
    await tab1.save(a.req);
    const key = cloud.pendingKeys.get(a.fp);
    cloud.rows.clear(); // пользователь удалил расчёт; ссылка операции обнулилась
    cloud.cfg.dropResponse = false;
    const tab2 = new SF.AccrualSaveController(cloud.deps);
    openFile(tab2, a);
    const st = cloud.status(key, a.fp);
    assert.deepEqual([st.kind, st.row], ["done", null]);
    assert.equal(tab2.adoptSaved(a.fp, st), true);
    const out = await tab2.save(a.req);
    assert.deepEqual([out.status, out.calculationWrite], ["saved", "insert"]);
    assert.equal(cloud.log.consume, 1, "без нового списания");
  });

  it("adoptSaved — только для текущей неоплаченной попытки и не во время сохранения", async () => {
    const cloud = makeMockCloud({ delayMs: 10 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    openFile(ctl, a);
    assert.equal(ctl.adoptSaved(b.fp, { row: null, contentHash: null }), false, "чужой файл");
    const pending = ctl.save(a.req);
    assert.equal(ctl.adoptSaved(a.fp, { row: null, contentHash: null }), false, "идёт сохранение");
    await pending;
    assert.equal(ctl.adoptSaved(a.fp, { row: null, contentHash: null }), false, "уже оплачено");
  });
});

describe("операция расчёта: одна оставшаяся попытка и две вкладки", () => {
  it("две разные операции одновременно при одной попытке: одна сохранена, вторая — paywall без записей", async () => {
    const ent = makeEntitlements({ used: 0 });
    const cloud = makeMockCloud({ entitlement: ent, delayMs: 5 });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const tab2 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    openFile(tab1, a);
    openFile(tab2, b);
    const [r1, r2] = await Promise.all([tab1.save(a.req), tab2.save(b.req)]);
    assert.deepEqual([r1.status, r2.status].sort(), ["paywall", "saved"]);
    assert.deepEqual([ent.st.used, cloud.rows.size, cloud.log.histories.length], [1, 1, 1]);
  });
});

describe("saveOutcomeUi: исходы операции", () => {
  const cols = {};
  it("save_failed: none / unknown / kept — разные тексты; повтор доступен", () => {
    const none = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "none" });
    const unknown = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "unknown" });
    const kept = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "kept" });
    assert.match(none.note.text, /Попытка расчёта не списана/);
    assert.match(unknown.note.text, /повтор вернёт его без повторного списания/);
    assert.match(kept.note.text, /уже списана за этот файл/);
    for (const u of [none, unknown, kept]) assert.equal(u.needsRetry, true);
  });
  it("saved replay — «уже был сохранён», без записи", () => {
    const ui = SES.saveOutcomeUi({
      status: "saved",
      row: { id: "c", synced: true, createdAt: "" },
      created: false,
      local: false,
      calculationWrite: "none",
      historyWrite: "written",
      historyWarning: null,
      columns: cols,
      replay: true,
    });
    assert.match(ui.note.text, /уже был сохранён/);
    assert.equal(ui.markSaved, true);
  });
});

describe("savedState: кнопка после сохранения и после восстановления", () => {
  const key = SF.snapshotContentKey(A().ev.snapshot);
  const other = SF.snapshotContentKey(A({ ...INPUTS, taxPercent: "6" }).ev.snapshot);
  it("не сохранено → «Рассчитать и сохранить»", () => {
    assert.deepEqual(SES.savedState(null, null, key), { saved: false, dirty: false });
  });
  it("сохранено в этой вкладке: то же содержимое — «сохранён», правка — «Сохранить изменения»", () => {
    assert.deepEqual(SES.savedState(key, null, key), { saved: true, dirty: false });
    assert.deepEqual(SES.savedState(key, null, other), { saved: true, dirty: true });
  });
  it("восстановлено с сервера (перезагрузка): совпадение по отпечатку — «сохранён», правка — изменения", () => {
    const h = SES.contentFingerprint(key);
    assert.deepEqual(SES.savedState(null, h, key), { saved: true, dirty: false });
    assert.deepEqual(SES.savedState(null, h, other), { saved: true, dirty: true });
  });
  it("расчёт ещё не готов (каталог грузится) — не «изменён»", () => {
    assert.deepEqual(SES.savedState(null, SES.contentFingerprint(key), null), { saved: true, dirty: false });
  });
});

describe("operation-store: ключи операций", () => {
  const memStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
  };
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  it("ключ стабилен для пары «пользователь + файл» и переживает «перезагрузку» (новый экземпляр на том же хранилище)", () => {
    const storage = memStorage();
    const s1 = OS.createOperationStore(storage, newId);
    const k = s1.getOrCreate("u1", "fpA");
    assert.equal(s1.getOrCreate("u1", "fpA"), k);
    const s2 = OS.createOperationStore(storage, newId);
    assert.equal(s2.get("u1", "fpA"), k);
    assert.notEqual(s2.getOrCreate("u1", "fpB"), k, "другой файл — другой ключ");
  });

  it("пользователи изолированы; settle удаляет ключ", () => {
    const s = OS.createOperationStore(memStorage(), newId);
    const k1 = s.getOrCreate("u1", "fp");
    const k2 = s.getOrCreate("u2", "fp");
    assert.notEqual(k1, k2);
    assert.equal(s.get("u2", "fp"), k2);
    s.settle("u1", "fp");
    assert.equal(s.get("u1", "fp"), null);
    assert.equal(s.get("u2", "fp"), k2);
  });

  it("устаревший ключ (старше 14 дней) не восстанавливается и заменяется новым", () => {
    let t = 0;
    const s = OS.createOperationStore(memStorage(), newId, () => t);
    const k = s.getOrCreate("u1", "fp");
    t = 15 * 24 * 60 * 60 * 1000;
    assert.equal(s.get("u1", "fp"), null);
    assert.notEqual(s.getOrCreate("u1", "fp"), k);
  });

  it("без localStorage или при сбое записи/повреждённых данных ключи живут в памяти вкладки", () => {
    const broken = { getItem: () => "{не json", setItem: () => { throw new Error("quota"); } };
    const s = OS.createOperationStore(broken, newId);
    const k = s.getOrCreate("u1", "fp");
    assert.ok(k);
    const none = OS.createOperationStore(null, newId);
    const k2 = none.getOrCreate("u1", "fp");
    assert.equal(none.get("u1", "fp"), k2);
  });
});
