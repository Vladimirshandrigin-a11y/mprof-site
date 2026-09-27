// Операции ручного расчёта и Ozon API на уровне клиента: отпечатки параметров
// (calc-operation-keys), исходы → сообщения и судьба ключа (calc-operation-notes),
// список незавершённых ключей (operation-store). Транзакцию, права и маршруты на
// настоящей PostgreSQL проверяет tests/db/calculation-operations-manual-api.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calcOpKeys as K, calcOpNotes as N, hash53 as H, opStore as OS } from "./helpers/modules.mjs";

const MANUAL = { marketplace: "ozon", revenue: 100000, commission: 15000, logistics: 8000, storage: 2000, ads: 5000, cost: 40000, tax: 6000, other: 1500 };
const EXP = { tax: 7, packaging: 100, warehouseDelivery: 0, salary: 0, other: 0 };

describe("отпечаток параметров: пользователь + режим + параметры", () => {
  it("hash53 вынесен без изменений: эталонные значения (от них зависят уже выданные ключи XLSX)", () => {
    assert.equal(H.hash53("mprof").toString(36), "1epyp0ybu14");
    assert.equal(H.hash53("mprof", 7).toString(36), "f4i4xe7jwr");
  });

  it("ручной: тот же ввод — тот же отпечаток; любое поле или маркетплейс меняют его", () => {
    const base = K.manualRequestHash(MANUAL);
    assert.equal(K.manualRequestHash({ ...MANUAL }), base);
    assert.ok(base.startsWith(K.MANUAL_REQUEST_PREFIX));
    const seen = new Set([base]);
    for (const f of K.MANUAL_INPUT_FIELDS) seen.add(K.manualRequestHash({ ...MANUAL, [f]: MANUAL[f] + 1 }));
    seen.add(K.manualRequestHash({ ...MANUAL, marketplace: "wb" }));
    assert.equal(seen.size, K.MANUAL_INPUT_FIELDS.length + 2);
    assert.ok(base.length <= 200);
  });

  it("API: месяц и каждый ручной расход входят в отпечаток; режим различим по префиксу", () => {
    const base = K.apiRequestHash("2026-06", EXP);
    assert.ok(base.startsWith(`${K.API_REQUEST_PREFIX}2026-06:`));
    const seen = new Set([base, K.apiRequestHash("2026-05", EXP)]);
    for (const f of Object.keys(EXP)) seen.add(K.apiRequestHash("2026-06", { ...EXP, [f]: EXP[f] + 1 }));
    assert.equal(seen.size, 2 + Object.keys(EXP).length);
    assert.equal(K.operationModeOf(base), "api");
    assert.equal(K.operationModeOf(K.manualRequestHash(MANUAL)), "manual");
    assert.equal(K.operationModeOf("2026-06:45:abc:def"), "upload");
  });

  it("итог ручного расчёта: та же арифметика и порядок сложения, что в форме", () => {
    const c = K.computeManualColumns(MANUAL);
    const expenses = 15000 + 8000 + 2000 + 5000 + 40000 + 6000 + 1500;
    assert.deepEqual(
      [c.total_expenses, c.profit, c.margin, c.other_expenses, c.marketplace],
      [expenses, 100000 - expenses, ((100000 - expenses) / 100000) * 100, 1500, "ozon"]
    );
    assert.equal(K.computeManualColumns({ ...MANUAL, revenue: 0 }).margin, 0);
    const frac = { ...MANUAL, commission: 0.1, logistics: 0.2 };
    assert.equal(K.computeManualColumns(frac).total_expenses, 0.1 + 0.2 + 2000 + 5000 + 40000 + 6000 + 1500);
  });

  it("разбор ввода (сервер): только конечные числа и известный маркетплейс", () => {
    assert.equal(K.parseManualInputs(MANUAL).ok, true);
    for (const bad of [null, [], {}, { ...MANUAL, marketplace: "ya" }, { ...MANUAL, tax: "1" }, { ...MANUAL, cost: Infinity }, { ...MANUAL, ads: 1e14 }]) {
      assert.equal(K.parseManualInputs(bad).ok, false, JSON.stringify(bad));
    }
    const { value } = K.parseManualInputs({ ...MANUAL, profit: -1, mode: "api" });
    assert.deepEqual(Object.keys(value).sort(), ["ads", "commission", "cost", "logistics", "marketplace", "other", "revenue", "storage", "tax"]);
  });
});

describe("исход операции → сообщение и ключ", () => {
  it("сохранено впервые — без сообщения, ключ убирается; повтор — «уже сохранён» (для API — без Ozon и списания)", () => {
    assert.deepEqual(N.opOutcomeUi({ kind: "ok", replay: false }, "manual"), { note: null, keepKey: false, paywall: false });
    assert.match(N.opOutcomeUi({ kind: "ok", replay: true }, "manual").note.text, /уже был сохранён/);
    assert.match(N.opOutcomeUi({ kind: "ok", replay: true }, "api").note.text, /Повторного обращения к Ozon и списания нет/);
  });

  it("потерянный ответ: НЕ утверждаем «не списано», ключ остаётся; недоступность — «не списана», ключ остаётся", () => {
    const failed = N.opOutcomeUi({ kind: "failed", message: "нет ответа сервера" }, "manual");
    assert.equal(failed.keepKey, true);
    assert.doesNotMatch(failed.note.text, /не списан/);
    assert.match(failed.note.text, /мог успеть сохраниться.*без повторного списания/);
    const unavailable = N.opOutcomeUi({ kind: "unavailable", message: "Сохранение расчёта временно недоступно" }, "api");
    assert.equal(unavailable.keepKey, true);
    assert.match(unavailable.note.text, /временно недоступно\. Попытка расчёта не списана\./);
  });

  it("отказ — окно тарифов, ключ остаётся; конфликт и «удалён» — ключ убирается, сообщение понятное", () => {
    assert.deepEqual(N.opOutcomeUi({ kind: "refused" }, "api"), { note: null, keepKey: true, paywall: true });
    const conflict = N.opOutcomeUi({ kind: "conflict" }, "manual");
    assert.deepEqual([conflict.keepKey, conflict.note.kind], [false, "err"]);
    assert.match(conflict.note.text, /другими значениями.*не списана/);
    const deleted = N.opOutcomeUi({ kind: "deleted" }, "api");
    assert.deepEqual([deleted.keepKey, deleted.note.kind], [false, "warn"]);
    assert.match(deleted.note.text, /удалён из истории.*не создаётся.*не списывается/);
  });

  it("восстановление: сохранено → показать (текст зависит от случая); удалено → сообщить; нет/не узнали → ключ остаётся", () => {
    assert.match(N.opRecoveryUi("done", "reload").note.text, /до перезагрузки/);
    assert.match(N.opRecoveryUi("done", "other").note.text, /с другими значениями уже сохранён.*нажмите кнопку ещё раз/);
    assert.equal(N.opRecoveryUi("done", "same").restore, true);
    assert.deepEqual([N.opRecoveryUi("deleted", "reload").keepKey, N.opRecoveryUi("deleted", "reload").restore], [false, false]);
    assert.deepEqual(N.opRecoveryUi("conflict", "same"), { note: null, keepKey: false, restore: false });
    for (const s of ["none", "failed"]) assert.deepEqual(N.opRecoveryUi(s, "reload"), { note: null, keepKey: true, restore: false });
  });

  it("ответ маршрута API → исход: новый, повтор, удалён, отказ, неполная себестоимость, конфликт, нет миграции, нет подтверждения, ошибка до операции", () => {
    const o = (status, data, net = null) => N.apiSaveOutcome(status, data, net).kind;
    assert.equal(o(200, { ok: true, replay: false, profit: {} }), "saved");
    assert.equal(o(200, { ok: true, replay: true, status: "done", calculation: { id: "c" } }), "replay");
    assert.deepEqual(N.apiSaveOutcome(200, { ok: true, replay: true, status: "done", calculation: { id: "c" } }, null), { kind: "replay", calculation: { id: "c" } });
    assert.equal(o(200, { ok: true, replay: true, status: "deleted" }), "deleted");
    assert.equal(o(402, { code: "limit_reached" }), "refused");
    assert.equal(o(400, { code: "incomplete_cost" }), "incomplete_cost");
    assert.equal(o(409, { code: "operation_conflict" }), "conflict");
    assert.equal(o(503, { code: "migration_missing", error: "…" }), "unavailable");
    assert.equal(o(502, { code: "operation_failed", error: "…" }), "failed");
    assert.equal(o(0, null, "нет ответа сервера"), "failed");
    assert.equal(o(500, {}), "failed", "5xx без ответа маршрута — исход неизвестен");
    assert.deepEqual(N.apiSaveOutcome(502, { error: "Ozon временно недоступен", code: "unavailable" }, null), { kind: "before", message: "Ozon временно недоступен" });
    assert.equal(o(400, { error: "Выберите месяц" }), "before");
  });
});

describe("operation-store: незавершённые ключи пользователя", () => {
  const memStorage = () => {
    let v = null;
    return { getItem: () => v, setItem: (_, x) => (v = x) };
  };
  let n = 0;
  const newId = () => `k-${++n}`;

  it("pending: свежие ключи пользователя, новые первыми; другой пользователь и устаревшие не попадают; settle убирает", () => {
    let t = 1000;
    const s = OS.createOperationStore(memStorage(), newId, () => t);
    const manual = K.manualRequestHash(MANUAL);
    const api = K.apiRequestHash("2026-06", EXP);
    s.getOrCreate("u1", "2026-06:45:file");
    t += 10;
    const kManual = s.getOrCreate("u1", manual);
    t += 10;
    const kApi = s.getOrCreate("u1", api);
    s.getOrCreate("u2", manual);
    assert.deepEqual(s.pending("u1").map((e) => [e.attemptId, e.id]), [[api, kApi], [manual, kManual], ["2026-06:45:file", "k-1"]]);
    s.settle("u1", api);
    assert.deepEqual(s.pending("u1").map((e) => e.attemptId), [manual, "2026-06:45:file"]);
    t += 15 * 24 * 60 * 60 * 1000;
    assert.deepEqual(s.pending("u1"), []);
  });
});
