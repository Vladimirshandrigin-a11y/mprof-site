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

function evaluate(buf, inputs = INPUTS, catalog = CAT) {
  const parsed = parseBuf(buf);
  assert.equal(parsed.ok, true);
  const report = {
    rows: parsed.report.rows,
    period: parsed.report.period,
    warnings: parsed.warnings,
    sheet: parsed.report.sheetName,
    rowCount: parsed.report.summary.rowCount,
  };
  const ev = SES.evaluateAccrual({ report, catalog, inputs, generatedAt: "2026-07-01T10:00:00.000Z" });
  return { fp: SES.reportFingerprint(report), ev, req: { snapshot: ev.snapshot, ready: ev.readyToSave, userId: "u1" } };
}
const A = (inputs) => evaluate(scenario("basic"), inputs);
const B = () => evaluate(scenario("incomplete_month"));

function openFile(ctl, x) {
  assert.equal(ctl.beginAttempt(null), true);
  assert.equal(ctl.beginAttempt(x.fp), true);
}

describe("операция привязана к файлу: без начатой попытки сохранение не начинается", () => {
  it("аккаунт без отпечатка файла (beginAttempt не вызван): понятная ошибка ДО запроса — ни ключа, ни операции, ни дубль-гарда, ни списания", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const out = await ctl.save(a.req);
    assert.deepEqual([out.status, out.charge], ["save_failed", "none"]);
    assert.match(out.error, /файл отчёта не определён/);
    assert.match(SES.saveOutcomeUi(out).note.text, /загрузите отчёт заново.*Попытка расчёта не списана/);
    assert.deepEqual([cloud.log.opTry, cloud.log.opIds.length, cloud.log.dup, cloud.log.canCalc, cloud.log.consume], [0, 0, 0, 0, 0]);
    assert.equal(cloud.pendingKeys.size, 0, "идентичность файла не придумана");
    // «Убрать файл» → тоже нет отпечатка.
    openFile(ctl, a);
    ctl.beginAttempt(null);
    assert.equal((await ctl.save(a.req)).status, "save_failed");
    assert.equal(cloud.log.opTry, 0);
  });

  it("аноним без начатой попытки — как раньше: локальная запись со списанием локального счётчика", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const out = await ctl.save({ ...A().req, userId: null });
    assert.deepEqual([out.status, out.local], ["saved", true]);
    assert.deepEqual([cloud.log.consume, cloud.log.opTry], [1, 0]);
  });
});

describe("операция расчёта: отказы до записи ничего не списывают", () => {
  it("сервер ответил «сохранение недоступно» (503): save_failed без обещания «не списано» — ранее отправленный запрос с тем же ключом мог завершиться; списаний и строк нет, ключ сохраняется для повтора", async () => {
    const cloud = makeMockCloud({ opUnavailable: true });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(ctl, a);
    const out = await ctl.save(a.req);
    assert.deepEqual([out.status, out.charge], ["save_failed", "unconfirmed"]);
    assert.deepEqual([cloud.log.consume, cloud.rows.size, cloud.log.histories.length, ctl.state.paid], [0, 0, 0, false]);
    assert.equal(cloud.pendingKeys.has(a.fp), true, "ключ для повтора сохранён");
    const ui = SES.saveOutcomeUi(out);
    assert.doesNotMatch(ui.note.text, /не списан/);
    assert.match(ui.note.text, /^Сохранение не подтверждено: .*отправлялся раньше, тот запрос мог успеть его сохранить — нажмите «Повторить сохранение»/);
    assert.equal(ui.needsRetry, true, "существующее действие повтора доступно");
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
    cloud.ops.set(key, { requestHash: b.fp, payload: "x", rowId: null });
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
  it("незавершённая операция обходит устаревший клиентский paywall: сервер возвращает уже сохранённый снимок без списания", async () => {
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
    assert.deepEqual([out.status, out.contentMatch], ["restored", true]);
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

  it("потерянный ответ → смена себестоимости в каталоге → перезагрузка → тот же файл: показан СОХРАНЁННЫЙ снимок (налог, реклама, итог), без пересчёта, PATCH и списания", async () => {
    const SAVED_INPUTS = { taxPercent: "6,5", packaging: "10", deliveryToWarehouse: "", salary: "", other: "", adsOutsideOzon: "250,75" };
    const cloud = makeMockCloud({ dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A(SAVED_INPUTS);
    assert.ok(a.ev.snapshot.tax.kopecks > 0 && a.ev.snapshot.manualExpenses.adsOutsideOzonKopecks === 25075);
    openFile(tab1, a);
    assert.equal((await tab1.save(a.req)).status, "save_failed"); // COMMIT прошёл, ответ потерян
    const key = cloud.pendingKeys.get(a.fp);
    cloud.cfg.dropResponse = false;
    const before = cloud.counts();

    // Владелец поменял себестоимость; после перезагрузки поля формы пустые.
    const newCatalog = CAT.map((c) => (c.sku === "ART-A" ? { ...c, cost_price: c.cost_price + 40 } : c));
    const recomputed = evaluate(scenario("basic"), { ...SAVED_INPUTS, taxPercent: "", adsOutsideOzon: "" }, newCatalog);
    assert.notEqual(recomputed.ev.snapshot.netProfitKopecks, a.ev.snapshot.netProfitKopecks, "пересчёт дал бы другой итог");

    // Перезагрузка: новый контроллер, тот же файл → статус операции.
    const tab2 = new SF.AccrualSaveController(cloud.deps);
    openFile(tab2, a);
    const st = cloud.status(key, a.fp);
    assert.equal(st.kind, "done");
    assert.equal(tab2.adoptSaved(a.fp, { row: st.row, operationId: key, snapshot: st.snapshot }), true);
    cloud.deps.operationSettled(a.fp);

    // Экран: сохранённый снимок как есть — итог, налог, реклама и поля формы.
    const shown = SES.savedEvaluation(st.snapshot);
    assert.equal(shown.status, "ok");
    assert.equal(shown.calc, null, "ядро не пересчитывало");
    assert.equal(SF.snapshotContentKey(shown.snapshot), SF.snapshotContentKey(a.ev.snapshot));
    assert.deepEqual(
      [shown.snapshot.netProfitKopecks, shown.snapshot.tax.ratePercent, shown.snapshot.tax.kopecks, shown.snapshot.manualExpenses.adsOutsideOzonKopecks, shown.snapshot.productionCostKopecks],
      [a.ev.snapshot.netProfitKopecks, 6.5, a.ev.snapshot.tax.kopecks, 25075, a.ev.snapshot.productionCostKopecks]
    );
    assert.deepEqual(SES.inputsFromSnapshot(st.snapshot), SAVED_INPUTS);
    assert.deepEqual(SES.savedState(SF.snapshotContentKey(st.snapshot), SF.snapshotContentKey(shown.snapshot), true), { saved: true, dirty: false });
    assert.deepEqual(SES.resultAccess(tab2.state.paid, shown), { unlocked: true, showResult: true, pdfAllowed: true });
    assert.deepEqual(cloud.counts(), before, "ни записи, ни списания");
    assert.equal(cloud.log.updateTry, 0, "PATCH не было");

    // Явная правка → пересчёт по новому каталогу → «Сохранить изменения» = PATCH той же строки без списания.
    const edited = evaluate(scenario("basic"), SAVED_INPUTS, newCatalog);
    const out = await tab2.save(edited.req);
    assert.deepEqual([out.status, out.calculationWrite, out.row.id], ["saved", "update", st.row.id]);
    assert.equal(cloud.log.consume, 1);
  });

  it("то же содержимое после восстановления (правка и возврат значений): «Сохранить» ничего не пишет", async () => {
    const cloud = makeMockCloud({ dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(tab1, a);
    await tab1.save(a.req);
    cloud.cfg.dropResponse = false;
    const key = cloud.pendingKeys.get(a.fp);
    const tab2 = new SF.AccrualSaveController(cloud.deps);
    openFile(tab2, a);
    const st = cloud.status(key, a.fp);
    tab2.adoptSaved(a.fp, { row: st.row, operationId: key, snapshot: st.snapshot });
    const before = cloud.counts();
    assert.equal((await tab2.save(A().req)).status, "unchanged");
    assert.deepEqual(cloud.counts(), before);
  });

  it("расчёт операции удалён из истории: повтор прежней операции → «удалён», без списания и без повторного создания расчёта и сводки; журнал остаётся; новый расчёт — новая операция", async () => {
    const cloud = makeMockCloud({ dropResponse: true });
    const tab1 = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(tab1, a);
    await tab1.save(a.req); // зафиксировано, ответ потерян — ключ остался
    const key = cloud.pendingKeys.get(a.fp);
    cloud.cfg.dropResponse = false;
    const [rowId] = cloud.rows.keys();
    cloud.deleteRow(rowId); // штатное удаление из истории
    assert.deepEqual(cloud.status(key, a.fp), { kind: "deleted" });

    const tab2 = new SF.AccrualSaveController(cloud.deps);
    openFile(tab2, a);
    const before = cloud.counts();
    const out = await tab2.save(a.req); // повтор прежней операции (тот же ключ)
    assert.equal(out.status, "deleted");
    assert.equal(cloud.log.lastOp.operationId, key);
    assert.deepEqual(cloud.counts(), { ...before, dup: before.dup + 1 }, "ни списания, ни calculations, ни сводки");
    assert.equal(cloud.ops.size, 1, "журнал операции не исчез");
    assert.equal(cloud.pendingKeys.has(a.fp), false, "ключ закрыт");
    assert.deepEqual([tab2.state.paid, tab2.state.saved], [false, null]);
    assert.match(SES.saveOutcomeUi(out).note.text, /удалён из истории.*не создаётся.*не списывается/);

    const fresh = await tab2.save(a.req); // новый расчёт этого файла — отдельная попытка
    assert.deepEqual([fresh.status, fresh.created], ["saved", true]);
    assert.notEqual(cloud.log.lastOp.operationId, key);
    assert.equal(cloud.log.consume, 2);
  });

  it("adoptSaved — только для текущей неоплаченной попытки и не во время сохранения", async () => {
    const cloud = makeMockCloud({ delayMs: 10 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    const done = { row: { id: "c", created_at: "" }, operationId: "k", snapshot: null };
    openFile(ctl, a);
    assert.equal(ctl.adoptSaved(b.fp, done), false, "чужой файл");
    const pending = ctl.save(a.req);
    assert.equal(ctl.adoptSaved(a.fp, done), false, "идёт сохранение");
    await pending;
    assert.equal(ctl.adoptSaved(a.fp, done), false, "уже оплачено");
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
  it("save_failed: none / unknown / unconfirmed / kept — разные тексты; «не списана» только у none; повтор доступен", () => {
    const none = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "none" });
    const unknown = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "unknown" });
    const unconfirmed = SES.saveOutcomeUi({ status: "save_failed", error: "Сохранение расчёта временно недоступно", charge: "unconfirmed" });
    const kept = SES.saveOutcomeUi({ status: "save_failed", error: "x", charge: "kept" });
    assert.match(none.note.text, /Попытка расчёта не списана/);
    assert.match(unknown.note.text, /повтор вернёт его без повторного списания/);
    assert.equal(
      unconfirmed.note.text,
      "Сохранение не подтверждено: Сохранение расчёта временно недоступно. Если этот расчёт уже отправлялся раньше, тот запрос мог успеть его сохранить — нажмите «Повторить сохранение»: уже сохранённый расчёт вернётся без повторного списания."
    );
    assert.match(kept.note.text, /уже списана за этот файл/);
    for (const u of [unknown, unconfirmed, kept]) assert.doesNotMatch(u.note.text, /не списан/);
    for (const u of [none, unknown, unconfirmed, kept]) assert.equal(u.needsRetry, true);
  });
  it("restored: совпало — «уже был сохранён»; другие значения — предупреждение «текущие не применены»; снимок не прочитан — «откройте в истории»; ничего не пишется", () => {
    const row = { id: "c", synced: true, createdAt: "" };
    const snap = A().ev.snapshot;
    const same = SES.saveOutcomeUi({ status: "restored", row, snapshot: snap, contentMatch: true });
    const diff = SES.saveOutcomeUi({ status: "restored", row, snapshot: snap, contentMatch: false });
    const none = SES.saveOutcomeUi({ status: "restored", row, snapshot: null, contentMatch: true });
    assert.match(same.note.text, /уже был сохранён — показан сохранённый результат/);
    assert.equal(diff.note.kind, "warn");
    assert.match(diff.note.text, /другими значениями.*текущие значения не применены/);
    assert.match(none.note.text, /откройте его в истории/);
    for (const u of [same, diff, none]) {
      assert.deepEqual([u.markSaved, u.emitSaved, u.needsRetry, u.openPaywall], [false, false, false, false]);
    }
  });
  it("deleted — «удалён из истории», без повтора и paywall", () => {
    const ui = SES.saveOutcomeUi({ status: "deleted" });
    assert.equal(ui.note.text, SES.DELETED_NOTE);
    assert.deepEqual([ui.markSaved, ui.emitSaved, ui.needsRetry, ui.openPaywall], [false, false, false, false]);
  });
});

describe("сохранённый снимок на экране: без пересчёта, поля формы — как при сохранении", () => {
  it("inputsFromSnapshot → evaluateAccrual с тем же каталогом даёт тот же снимок (налог, реклама вне Ozon, расходы)", () => {
    const FULL = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "20", salary: "30,5", other: "3,33", adsOutsideOzon: "100" };
    const a = A(FULL);
    const back = SES.inputsFromSnapshot(a.ev.snapshot);
    assert.deepEqual(back, FULL);
    assert.equal(SF.snapshotContentKey(A(back).ev.snapshot), SF.snapshotContentKey(a.ev.snapshot));
    assert.deepEqual(SES.inputsFromSnapshot(A({ ...FULL, taxPercent: "", packaging: "", deliveryToWarehouse: "", salary: "", other: "", adsOutsideOzon: "" }).ev.snapshot), {
      taxPercent: "", packaging: "", deliveryToWarehouse: "", salary: "", other: "", adsOutsideOzon: "",
    });
  });
  it("savedEvaluation: снимок как есть, calc = null, готов к показу; замечания из снимка", () => {
    const b = B();
    const ev = SES.savedEvaluation(b.ev.snapshot);
    assert.deepEqual([ev.status, ev.calc, ev.readyToSave, ev.blockers, ev.problemProducts], ["ok", null, true, [], []]);
    assert.equal(ev.snapshot, b.ev.snapshot);
    assert.ok(ev.notes.some((n) => /не весь календарный месяц/.test(n)));
  });
});

describe("savedState: кнопка после сохранения и после восстановления", () => {
  const key = SF.snapshotContentKey(A().ev.snapshot);
  const other = SF.snapshotContentKey(A({ ...INPUTS, taxPercent: "6" }).ev.snapshot);
  it("не сохранено → «Рассчитать и сохранить»", () => {
    assert.deepEqual(SES.savedState(null, key, false), { saved: false, dirty: false });
  });
  it("сохранено: то же содержимое — «сохранён», правка — «Сохранить изменения»", () => {
    assert.deepEqual(SES.savedState(key, key, false), { saved: true, dirty: false });
    assert.deepEqual(SES.savedState(key, other, false), { saved: true, dirty: true });
  });
  it("на экране сохранённый снимок с сервера — «сохранён», записывать нечего", () => {
    assert.deepEqual(SES.savedState(key, other, true), { saved: true, dirty: false });
  });
  it("снимок не прочитан (RESTORED_KEY): любой пересчёт — изменение; расчёт ещё не готов — не «изменён»", () => {
    assert.deepEqual(SES.savedState(SES.RESTORED_KEY, key, false), { saved: true, dirty: true });
    assert.deepEqual(SES.savedState(key, null, false), { saved: true, dirty: false });
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
