// PR-3: загрузка «Отчёта по начислениям» → каталог → расчёт → снимок → сохранение
// (мок облака) → восстановление; граница списания; маппинг колонок.
// Вызываются РЕАЛЬНЫЕ модули проекта; облако и consume — счётчики-моки, реальных
// списаний и записей нет. Ожидания — независимые литералы.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { CAT, EXPECTED_BASIC as E } from "./helpers/expected.mjs";
import { makeEntitlements, makeMockCloud } from "./helpers/mock-cloud.mjs";
import { columns as COL, guide as GUIDE, parseBuf, pdfModel as P, saveFlow as SF, session as SES, snapshot as S } from "./helpers/modules.mjs";

const viaJson = (x) => JSON.parse(JSON.stringify(x));
const NOW = "2026-07-01T10:00:00.000Z";
const INPUTS = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "", salary: "", other: "3,33", adsOutsideOzon: "" };
const FULL_INPUTS = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "20", salary: "30,50", other: "3,33", adsOutsideOzon: "100" };

/** Файл → проверка → разбор → (каталог) → оценка. Возвращает всё, что видел бы экран. */
function pipeline({ name = "Отчет по начислениям_01.06.2026-30.06.2026.xlsx", buf, catalog = CAT, inputs = INPUTS, generatedAt = NOW }) {
  const check = SES.validateAccrualFile({ name, size: buf.length });
  if (!check.ok) return { stage: "file_check", message: check.message };
  const parsed = parseBuf(buf);
  if (!parsed.ok) return { stage: "parse", errors: parsed.errors, messages: SES.formatParseErrors(parsed.errors) };
  const evaluation = SES.evaluateAccrual({
    report: {
      rows: parsed.report.rows,
      period: parsed.report.period,
      warnings: parsed.warnings,
      sheet: parsed.report.sheetName,
      rowCount: parsed.report.summary.rowCount,
    },
    catalog,
    inputs,
    generatedAt,
  });
  return { stage: "evaluated", parsed, evaluation };
}
const basicBuf = () => scenario("basic");

describe("сквозной сценарий: файл → каталог → расчёт → снимок → сохранение (мок) → восстановление", () => {
  const cloud = makeMockCloud();
  const res = pipeline({ buf: basicBuf() });
  const ctl = new SF.AccrualSaveController(cloud.deps);
  let out;
  it("файл принят, период распознан, результат готов", async () => {
    assert.equal(res.stage, "evaluated");
    assert.equal(res.parsed.report.period.month, "2026-06");
    assert.equal(res.evaluation.status, "ok");
    assert.equal(res.evaluation.readyToSave, true);
    assert.deepEqual(res.evaluation.blockers, []);
    assert.equal(res.evaluation.calc.netProfitKopecks, E.netProfit);
  });
  it("сохранение: списание ровно 1, запись расчёта 1, сводка по месяцам 1, дубль-гард спрошен 1 раз", async () => {
    out = await ctl.save({ snapshot: res.evaluation.snapshot, ready: res.evaluation.readyToSave, userId: "u1" });
    assert.equal(out.status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length, cloud.log.dup], [1, 1, 0, 1, 1]);
    assert.equal(cloud.log.lastDupMonth, "2026-06");
    assert.equal(out.created, true);
    assert.equal(out.local, false);
    assert.equal(out.historyWarning, null);
  });
  it("восстановление: ai_insights строки читается как ok и совпадает со снимком до записи", () => {
    const stored = cloud.rows.get(out.row.id);
    const back = S.readAccrualSnapshot(stored.ai_insights);
    assert.equal(back.status, "ok");
    assert.deepEqual(back.snapshot, res.evaluation.snapshot);
    assert.equal(stored.mode, "upload");
    assert.equal(stored.marketplace, "ozon");
  });
  it("из восстановленного снимка строятся те же детали истории, месяц и PDF", () => {
    const stored = cloud.rows.get(out.row.id);
    const snap = S.asAccrualSnapshot(stored.ai_insights);
    assert.equal(S.accrualSnapshotMonthKey(stored.ai_insights), "2026-06");
    assert.equal(S.accrualHistDetailRows(snap).at(-1).value, 590.13);
    const pdf = P.buildAccrualPdfModel(snap, new Date(2026, 6, 1, 10, 30));
    assert.equal(pdf.rows.at(-1).kind, "total");
    assert.equal(S.effectiveHistoryMargin(stored.ai_insights, stored.margin), 49.18);
  });
  it("товарная прибыль в сохранённом снимке = итоговой прибыли (до копейки)", () => {
    const snap = S.asAccrualSnapshot(cloud.rows.get(out.row.id).ai_insights);
    assert.equal(snap.products.reduce((a, p) => a + (p.profitKopecks ?? 0), 0), snap.netProfitKopecks);
    assert.equal(snap.reconciliation.reconciles, true);
  });
});

describe("налог и все ручные расходы учитываются по одному разу", () => {
  const withFull = pipeline({ buf: basicBuf(), inputs: FULL_INPUTS }).evaluation;
  it("итог: прибыль = итог начислений − себестоимость − налог − (упаковка + доставка + зарплата + прочие + реклама вне Ozon)", () => {
    // 937,46 − 250,00 − 84,00 − 163,83 = 439,63
    assert.equal(withFull.calc.manualExpenses.totalKopecks, 16383);
    assert.equal(withFull.calc.netProfitKopecks, 43963);
    assert.equal(withFull.calc.marginPercent, 36.64);
  });
  it("статьи ручных расходов в снимке по отдельности и «Реклама вне Ozon» — отдельное поле", () => {
    assert.deepEqual(withFull.snapshot.manualExpenses, {
      packagingKopecks: 1000,
      deliveryToWarehouseKopecks: 2000,
      salaryKopecks: 3050,
      otherKopecks: 333,
      adsOutsideOzonKopecks: 10000,
      totalKopecks: 16383,
    });
  });
  it("«Реклама вне Ozon» уменьшает прибыль ровно на свою сумму (не дублируется с рекламой Ozon из отчёта)", () => {
    const base = pipeline({ buf: basicBuf(), inputs: { ...FULL_INPUTS, adsOutsideOzon: "" } }).evaluation;
    assert.equal(base.calc.netProfitKopecks - withFull.calc.netProfitKopecks, 10000);
    assert.equal(withFull.calc.buckets.advertising, -6000); // реклама Ozon из отчёта не тронута
  });
  it("Σ прибыль товаров = итог при любых вводах", () => {
    for (const inputs of [INPUTS, FULL_INPUTS, { ...FULL_INPUTS, taxPercent: "0" }, { ...FULL_INPUTS, taxPercent: "6,5", other: "999,99" }]) {
      const ev = pipeline({ buf: basicBuf(), inputs }).evaluation;
      assert.equal(ev.calc.reconciliation.reconciles, true, JSON.stringify(inputs));
      assert.equal(ev.calc.productTotals.profitKopecks, ev.calc.netProfitKopecks);
      assert.equal(ev.calc.productTotals.allocatedTaxKopecks, ev.calc.taxKopecks);
      assert.equal(ev.calc.productTotals.allocatedManualKopecks, ev.calc.manualExpenses.totalKopecks);
    }
  });
  it("после изменения ставки/расходов итог, товарные строки и сохраняемый снимок обновляются согласованно", () => {
    const a = pipeline({ buf: basicBuf(), inputs: INPUTS }).evaluation;
    const b = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10", salary: "50" } }).evaluation;
    assert.notEqual(a.snapshot.netProfitKopecks, b.snapshot.netProfitKopecks);
    // 937,46 − 250 − 120,00 (10 % от 1200) − (10 + 50 + 3,33) = 504,13
    assert.equal(b.snapshot.netProfitKopecks, 50413);
    assert.equal(b.snapshot.products.reduce((s, p) => s + p.profitKopecks, 0), 50413);
    assert.equal(b.snapshot.tax.kopecks, 12000);
    assert.equal(b.calc.netProfitKopecks, b.snapshot.netProfitKopecks);
    assert.equal(S.readAccrualSnapshot(viaJson(b.snapshot)).status, "ok");
  });
  it("разбор вводов: запятая, пробелы, пустое = 0; нечисло и отрицательное — ошибка поля, а не молчаливый 0", () => {
    const ok = SES.parseUploadInputs({ ...SES.EMPTY_ACCRUAL_INPUTS, taxPercent: "6,5", packaging: "1 234,50", salary: "" });
    assert.equal(ok.ok, true);
    assert.equal(ok.taxRatePercent, 6.5);
    assert.equal(ok.manualExpenses.packaging, 1234.5);
    assert.equal(ok.manualExpenses.salary, 0);
    for (const bad of [{ taxPercent: "abc" }, { taxPercent: "101" }, { taxPercent: "7,123" }, { packaging: "-5" }, { adsOutsideOzon: "12ab" }, { other: "1e3" }]) {
      const r = SES.parseUploadInputs({ ...SES.EMPTY_ACCRUAL_INPUTS, ...bad });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.ok(Object.keys(r.errors).length > 0);
    }
  });
  it("некорректный ввод → input_error без расчёта", () => {
    const ev = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, packaging: "-1" } }).evaluation;
    assert.equal(ev.status, "input_error");
  });
});

describe("нет списания и нет записи: ошибки файла, нет стоимости, отмена дубля, нет попытки", () => {
  const untouched = (cloud) =>
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length], [0, 0, 0, 0]);

  for (const [label, name, buf] of [
    ["PDF (УПД) вместо XLSX", "УПД.pdf", new Uint8Array([1, 2, 3])],
    ["старый формат .xls", "report.xls", new Uint8Array([1, 2, 3])],
    ["CSV", "report.csv", new Uint8Array([1, 2, 3])],
    ["пустой файл", "report.xlsx", new Uint8Array(0)],
    ["не XLSX по содержимому (обрезан)", "report.xlsx", basicBuf().slice(0, 300)],
    ["нет колонки «Сумма итого»", "report.xlsx", scenario("no_amount_column")],
    ["нет товарных колонок (май, 6 колонок)", "report.xlsx", scenario("no_product_columns")],
    ["пустая сумма", "report.xlsx", scenario("missing_amount")],
    ["несколько месяцев", "report.xlsx", scenario("multi_month")],
    ["потеря строк при чтении", "report.xlsx", scenario("bad_dimension")],
  ]) {
    it(`${label}: понятная ошибка, consume = 0, записей = 0`, async () => {
      const cloud = makeMockCloud();
      const p = pipeline({ name, buf });
      assert.notEqual(p.stage, "evaluated", label);
      // экран не может вызвать сохранение: расчёта нет — проверяем, что оркестратор не тронут
      untouched(cloud);
      if (p.stage === "file_check") assert.ok(p.message.length > 10);
      else assert.ok(p.messages.every((m) => m.length > 10));
    });
  }

  it("нет себестоимости у части товаров: результат предварительный, конкретные товары названы, сохранение → not_ready без побочных эффектов", async () => {
    const cloud = makeMockCloud();
    const { evaluation } = pipeline({ buf: basicBuf(), catalog: [CAT[0]] });
    assert.equal(evaluation.readyToSave, false);
    assert.equal(evaluation.snapshot.preliminary, true);
    assert.deepEqual(evaluation.problemProducts, [{ article: "ART-B", name: "Товар Б", netQuantity: 1, reason: "not_in_catalog" }]);
    assert.equal(evaluation.blockers[0].code, "cost_incomplete");
    assert.match(evaluation.blockers[0].message, /У 1 из 2 товаров нет себестоимости/);
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const out = await ctl.save({ snapshot: evaluation.snapshot, ready: evaluation.readyToSave, userId: "u1" });
    assert.equal(out.status, "not_ready");
    untouched(cloud);
    assert.equal(cloud.log.dup, 0); // даже модалка дубля не открывается
    assert.equal(ctl.state.paid, false);
  });

  it("товар в каталоге, но с себестоимостью 0 → причина cost_missing (не подставляем ноль)", () => {
    const { evaluation } = pipeline({ buf: basicBuf(), catalog: [CAT[0], { sku: "ART-B", name: "b", cost_price: 0 }] });
    assert.equal(evaluation.readyToSave, false);
    assert.equal(evaluation.problemProducts[0].reason, "cost_missing");
  });

  it("отмена подтверждения дубля: consume = 0, записей = 0; повторная попытка после «Продолжить» проходит", async () => {
    const cloud = makeMockCloud({ dupAnswer: false });
    const { evaluation } = pipeline({ buf: basicBuf() });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const args = { snapshot: evaluation.snapshot, ready: true, userId: "u1" };
    assert.equal((await ctl.save(args)).status, "cancelled");
    untouched(cloud);
    assert.equal(cloud.log.dup, 1);
    cloud.cfg.dupAnswer = true;
    assert.equal((await ctl.save(args)).status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [1, 1]);
  });

  it("нет доступной попытки (paywall): consume не вызывается, записей нет", async () => {
    const cloud = makeMockCloud({ canCalculate: false });
    const { evaluation } = pipeline({ buf: basicBuf() });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    assert.equal((await ctl.save({ snapshot: evaluation.snapshot, ready: true, userId: "u1" })).status, "paywall");
    untouched(cloud);
  });

  it("сервер отказал в списании: paywall, записи нет, оплата не считается выполненной", async () => {
    const cloud = makeMockCloud({ consumeOk: false });
    const { evaluation } = pipeline({ buf: basicBuf() });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const out = await ctl.save({ snapshot: evaluation.snapshot, ready: true, userId: "u1" });
    assert.equal(out.status, "paywall");
    assert.equal(cloud.log.consume, 1);
    assert.deepEqual([cloud.log.inserts.length, cloud.log.histories.length], [0, 0]);
    assert.equal(ctl.state.paid, false);
  });

  it("после заполнения каталога тот же файл проверяется повторно — без повторной загрузки", async () => {
    const parsed = pipeline({ buf: basicBuf(), catalog: [CAT[0]] });
    assert.equal(parsed.evaluation.readyToSave, false);
    // владелец заполнил себестоимость B в каталоге; разобранный отчёт остаётся в памяти
    const again = SES.evaluateAccrual({
      report: {
        rows: parsed.parsed.report.rows,
        period: parsed.parsed.report.period,
        warnings: parsed.parsed.warnings,
        sheet: "Начисления",
        rowCount: parsed.parsed.report.summary.rowCount,
      },
      catalog: CAT,
      inputs: INPUTS,
      generatedAt: NOW,
    });
    assert.equal(again.readyToSave, true);
    assert.deepEqual(again.problemProducts, []);
    assert.equal(again.snapshot.netProfitKopecks, E.netProfit);
    const cloud = makeMockCloud();
    const out = await new SF.AccrualSaveController(cloud.deps).save({ snapshot: again.snapshot, ready: true, userId: "u1" });
    assert.equal(out.status, "saved");
    assert.equal(cloud.log.consume, 1);
  });

  it("аноним без каталога: результат предварительный, сохранить нельзя", () => {
    const { evaluation } = pipeline({ buf: basicBuf(), catalog: [] });
    assert.equal(evaluation.readyToSave, false);
    assert.equal(evaluation.problemProducts.length, 2);
  });

  it("налог 0 % не блокирует, но даёт замечание; неполный месяц — тоже только замечание", () => {
    const zero = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "0" } }).evaluation;
    assert.equal(zero.readyToSave, true);
    assert.ok(zero.notes.some((n) => /Налог не указан/.test(n)));
    const inc = pipeline({ buf: scenario("incomplete_month") }).evaluation;
    assert.equal(inc.readyToSave, true);
    assert.ok(inc.notes.some((n) => /не весь календарный месяц/.test(n)));
  });

  it("выручка без базы налога → calc_error no_tax_revenue, сохранять нечего", () => {
    const ev = pipeline({ buf: scenario("tax_zero") }).evaluation;
    assert.equal(ev.status, "calc_error");
    assert.equal(ev.code, "no_tax_revenue");
  });
});

describe("успешный расчёт списывает ровно один раз; повторное сохранение не списывает", () => {
  it("сохранить → изменить ставку → сохранить ещё раз: consume 1, insert 1, update 1, история 2", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = pipeline({ buf: basicBuf() }).evaluation;
    const first = await ctl.save({ snapshot: a.snapshot, ready: true, userId: "u1" });
    assert.equal(first.status, "saved");
    const b = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } }).evaluation;
    const second = await ctl.save({ snapshot: b.snapshot, ready: true, userId: "u1" });
    assert.equal(second.status, "saved");
    assert.equal(second.created, false);
    assert.equal(second.row.id, first.row.id);
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length, cloud.log.dup], [1, 1, 1, 2, 1]);
    // строка обновлена значениями второго расчёта
    assert.equal(cloud.rows.get(first.row.id).tax, 120);
    assert.equal(S.asAccrualSnapshot(cloud.rows.get(first.row.id).ai_insights).tax.kopecks, 12000);
  });

  it("ошибка записи видна (save_failed), оплата сохраняется; повтор записи не списывает и не открывает дубль-гард", async () => {
    const cloud = makeMockCloud({ insertError: "Ошибка сохранения: 502" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    const args = { snapshot: ev.snapshot, ready: true, userId: "u1" };
    const failed = await ctl.save(args);
    assert.equal(failed.status, "save_failed");
    assert.match(failed.error, /502/);
    assert.equal(cloud.log.consume, 1);
    assert.equal(ctl.state.paid, true);
    assert.equal(ctl.state.saved, null);
    cloud.cfg.insertError = null;
    const retry = await ctl.save(args);
    assert.equal(retry.status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.dup], [1, 1, 1]);
  });

  it("сбой сводки по месяцам: расчёт сохранён, предупреждение видно, повтор не списывает", async () => {
    const cloud = makeMockCloud({ historyError: "report_history 500" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    const out = await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    assert.equal(out.status, "saved");
    assert.match(out.historyWarning, /сводка по месяцам не обновилась/);
    assert.equal(ctl.state.historyOk, false);
    cloud.cfg.historyError = null;
    const again = await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    assert.equal(again.historyWarning, null);
    // повтор дописал ТОЛЬКО сводку: calculations не трогалась (ни insert, ни update)
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length], [1, 1, 0, 1]);
  });

  it("ошибка обновления (после правки ставки) не создаёт вторую строку", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } }).evaluation;
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    cloud.cfg.updateError = "network";
    const out = await ctl.save({ snapshot: edited.snapshot, ready: true, userId: "u1" });
    assert.equal(out.status, "save_failed");
    assert.deepEqual([cloud.log.inserts.length, cloud.log.consume], [1, 1]);
  });

  it("двойной клик: второй вызов → busy; списание 1, запись 1", async () => {
    const cloud = makeMockCloud({ delayMs: 20 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    const args = { snapshot: ev.snapshot, ready: true, userId: "u1" };
    const [a, b, c] = await Promise.all([ctl.save(args), ctl.save(args), ctl.save(args)]);
    assert.deepEqual([a.status, b.status, c.status].sort(), ["busy", "busy", "saved"]);
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [1, 1]);
  });

  it("строку удалили из истории: следующая запись создаёт новую строку без нового списания", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    ctl.forgetSaved();
    const out = await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    assert.equal(out.created, true);
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [1, 2]);
  });

  it("аноним: списание через consume (localStorage у страницы), запись только локальная и помечена local", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    const out = await ctl.save({ snapshot: ev.snapshot, ready: true, userId: null });
    assert.equal(out.status, "saved");
    assert.equal(out.local, true);
    assert.equal(out.row.synced, false);
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.histories.length], [1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Жизненный цикл consume/save: идемпотентность, частичный сбой, привязка к попытке.
// Счётчики мока считают ВСЕ обращения (включая отказы). Каждый вызов save() ждёт
// завершения предыдущего — это последовательные нажатия, а не одновременный клик.
// ---------------------------------------------------------------------------
describe("жизненный цикл: повторное «Сохранить» после успешного сохранения ничего не создаёт", () => {
  const fpOf = (p) =>
    SES.reportFingerprint({ rows: p.parsed.report.rows, period: p.parsed.report.period, rowCount: p.parsed.report.summary.rowCount });
  const A = () => pipeline({ buf: basicBuf() });
  const B = () => pipeline({ buf: scenario("incomplete_month") });
  const req = (p, userId = "u1") => ({ snapshot: p.evaluation.snapshot, ready: p.evaluation.readyToSave, userId });
  const ZERO = { consume: 0, dup: 0, insertTry: 0, inserts: 0, updateTry: 0, updates: 0, historyTry: 0, histories: 0, calcRows: 0 };

  it("три последовательных нажатия после завершения первого запроса: consume 1, calculations 1, report_history 1; повторы = unchanged без обращений к записи", async () => {
    const cloud = makeMockCloud({ delayMs: 5 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    ctl.beginAttempt(fpOf(a));
    const first = await ctl.save(req(a));
    assert.equal(first.status, "saved");
    const afterFirst = cloud.counts();
    assert.deepEqual(afterFirst, { ...ZERO, consume: 1, dup: 1, insertTry: 1, inserts: 1, historyTry: 1, histories: 1, calcRows: 1 });
    for (let i = 0; i < 3; i++) {
      const again = await ctl.save(req(a));
      assert.equal(again.status, "unchanged", `нажатие ${i + 2}`);
      assert.equal(again.row.id, first.row.id);
      assert.deepEqual(cloud.counts(), afterFirst, `после нажатия ${i + 2} счётчики не изменились`);
    }
  });

  it("тот же результат из заново собранного снимка (другое время формирования) — тоже unchanged", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a1 = pipeline({ buf: basicBuf(), generatedAt: "2026-07-01T10:00:00.000Z" });
    const a2 = pipeline({ buf: basicBuf(), generatedAt: "2026-07-01T10:07:31.000Z" });
    assert.notEqual(a1.evaluation.snapshot.generatedAt, a2.evaluation.snapshot.generatedAt);
    await ctl.save(req(a1));
    const before = cloud.counts();
    assert.equal((await ctl.save(req(a2))).status, "unchanged");
    assert.deepEqual(cloud.counts(), before);
  });

  it("правка ставки: одно обновление той же строки и одна дописанная сводка, без списания; повтор той же правки — unchanged; возврат к прежним значениям — снова обновление", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    const first = await ctl.save(req(a));
    const upd = await ctl.save(req(edited));
    assert.equal(upd.status, "saved");
    assert.equal(upd.calculationWrite, "update");
    assert.equal(upd.row.id, first.row.id);
    assert.deepEqual(cloud.counts(), { ...ZERO, consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 1, updates: 1, historyTry: 2, histories: 2, calcRows: 1 });
    const same = cloud.counts();
    assert.equal((await ctl.save(req(edited))).status, "unchanged");
    assert.deepEqual(cloud.counts(), same);
    assert.equal((await ctl.save(req(a))).calculationWrite, "update");
    assert.deepEqual(cloud.counts(), { ...same, updateTry: 2, updates: 2, historyTry: 3, histories: 3 });
    assert.equal(cloud.rows.get(first.row.id).tax, 84); // строка держит ПОСЛЕДНИЕ значения
  });

  it("намеренный новый расчёт за тот же месяц (другой файл): дубль-гард спрашивается заново, второе списание, вторая строка", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    assert.equal(a.evaluation.snapshot.period.month, b.evaluation.snapshot.period.month);
    ctl.beginAttempt(fpOf(a));
    await ctl.save(req(a));
    ctl.beginAttempt(null);
    ctl.beginAttempt(fpOf(b));
    const out = await ctl.save(req(b));
    assert.equal(out.status, "saved");
    assert.equal(out.created, true);
    assert.deepEqual(cloud.counts(), { ...ZERO, consume: 2, dup: 2, insertTry: 2, inserts: 2, historyTry: 2, histories: 2, calcRows: 2 });
    assert.equal(cloud.log.lastDupMonth, "2026-06");
  });

  it("тот же файл, загруженный заново ПОСЛЕ сохранения — новый расчёт: дубль-гард; отмена → ни списания, ни записи", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    ctl.beginAttempt(fpOf(a));
    await ctl.save(req(a));
    const before = cloud.counts();
    ctl.beginAttempt(null);
    ctl.beginAttempt(fpOf(a));
    assert.equal(ctl.state.paid, false, "сохранённая попытка закрыта, оплата не переходит");
    cloud.cfg.dupAnswer = false;
    assert.equal((await ctl.save(req(a))).status, "cancelled");
    assert.deepEqual(cloud.counts(), { ...before, dup: 2 });
    cloud.cfg.dupAnswer = true;
    assert.equal((await ctl.save(req(a))).status, "saved");
    assert.deepEqual(cloud.counts(), { ...before, dup: 3, consume: 2, insertTry: 2, inserts: 2, historyTry: 2, histories: 2, calcRows: 2 });
  });

  it("аноним: правка после сохранения обновляет ТУ ЖЕ локальную запись (без списания и облака), повтор — unchanged", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    const first = await ctl.save(req(a, null));
    const second = await ctl.save(req(edited, null));
    assert.equal(second.status, "saved");
    assert.deepEqual([second.local, second.created, second.calculationWrite, second.row.id], [true, false, "local", first.row.id]);
    assert.equal(second.columns.tax, 120);
    assert.equal((await ctl.save(req(edited, null))).status, "unchanged");
    assert.deepEqual(cloud.counts(), { ...ZERO, consume: 1, dup: 1 });
  });

  it("аноним: повторное сохранение после первого — unchanged, обращений к облаку нет", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const first = await ctl.save(req(a, null));
    assert.equal(first.local, true);
    const before = cloud.counts();
    assert.equal((await ctl.save(req(a, null))).status, "unchanged");
    assert.deepEqual(cloud.counts(), before);
    assert.deepEqual([before.inserts, before.histories, before.consume], [0, 0, 1]);
  });
});

describe("жизненный цикл: частичный сбой — calculations записана, report_history нет", () => {
  const A = () => pipeline({ buf: basicBuf() });
  const req = (p) => ({ snapshot: p.evaluation.snapshot, ready: p.evaluation.readyToSave, userId: "u1" });

  it("повторы в той же сессии дописывают ТОЛЬКО сводку: без списания, без второй calculations, без лишнего update", async () => {
    const cloud = makeMockCloud({ historyError: "report_history 500" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const failed = await ctl.save(req(a));
    assert.equal(failed.status, "saved");
    assert.equal(failed.historyWrite, "failed");
    assert.equal(failed.calculationWrite, "insert");
    assert.equal(ctl.state.historyOk, false);
    assert.equal(SES.saveOutcomeUi(failed).needsRetry, true); // экран покажет «Повторить сохранение»
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 0, updates: 0, historyTry: 1, histories: 0, calcRows: 1 });

    // сбой держится — второй повтор снова только к сводке
    assert.equal((await ctl.save(req(a))).historyWrite, "failed");
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 0, updates: 0, historyTry: 2, histories: 0, calcRows: 1 });

    cloud.cfg.historyError = null;
    const done = await ctl.save(req(a));
    assert.equal(done.status, "saved");
    assert.equal(done.calculationWrite, "none");
    assert.equal(done.historyWrite, "written");
    assert.equal(done.created, false);
    assert.equal(done.row.id, failed.row.id);
    assert.equal(ctl.state.historyOk, true);
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 0, updates: 0, historyTry: 3, histories: 1, calcRows: 1 });
    const ui = SES.saveOutcomeUi(done);
    assert.equal(ui.needsRetry, false);
    assert.equal(ui.historyRecorded, true);
    assert.match(ui.note.text, /Сводка по месяцам дописана/);

    // дальше — ничего не пишется
    const settled = cloud.counts();
    assert.equal((await ctl.save(req(a))).status, "unchanged");
    assert.deepEqual(cloud.counts(), settled);
  });

  it("сбой сводки, затем правка ставки: обновляется calculations, пишется ОДНА сводка", async () => {
    const cloud = makeMockCloud({ historyError: "500" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    await ctl.save(req(a));
    cloud.cfg.historyError = null;
    const out = await ctl.save(req(edited));
    assert.deepEqual([out.calculationWrite, out.historyWrite], ["update", "written"]);
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 1, updates: 1, historyTry: 2, histories: 1, calcRows: 1 });
  });

  it("сбой сводки ПОСЛЕ обновления при правке: повтор дописывает только сводку (второй update не идёт)", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    await ctl.save(req(a));
    cloud.cfg.historyError = "500";
    assert.equal((await ctl.save(req(edited))).historyWrite, "failed");
    cloud.cfg.historyError = null;
    const done = await ctl.save(req(edited));
    assert.deepEqual([done.calculationWrite, done.historyWrite], ["none", "written"]);
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 1, updates: 1, historyTry: 3, histories: 2, calcRows: 1 });
  });

  it("возврат к уже записанным значениям после сбоя сводки на правке: calculations обновляется, а сводка НЕ дублируется (последняя запись сводки уже равна этим значениям)", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    await ctl.save(req(a)); // calculations K1 + сводка K1
    cloud.cfg.historyError = "500";
    assert.equal((await ctl.save(req(edited))).historyWrite, "failed"); // calculations K2, сводка осталась K1
    cloud.cfg.historyError = null;
    const back = await ctl.save(req(a)); // снова K1
    assert.deepEqual([back.calculationWrite, back.historyWrite], ["update", "written"]);
    assert.equal(cloud.log.histories.length, 1, "в сводке по-прежнему одна запись K1");
    assert.equal(cloud.log.historyTry, 2, "лишнего обращения к сводке нет");
    assert.equal(cloud.rows.get(back.row.id).tax, 84);
    assert.equal((await ctl.save(req(a))).status, "unchanged");
  });

  it("сбой записи calculations: повтор вставляет строку один раз, сводка одна, списание одно", async () => {
    const cloud = makeMockCloud({ insertError: "502" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const failed = await ctl.save(req(a));
    assert.equal(failed.status, "save_failed");
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 0, updateTry: 0, updates: 0, historyTry: 0, histories: 0, calcRows: 0 });
    assert.equal((await ctl.save(req(a))).status, "save_failed");
    cloud.cfg.insertError = null;
    const ok = await ctl.save(req(a));
    assert.deepEqual([ok.status, ok.calculationWrite, ok.historyWrite], ["saved", "insert", "written"]);
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 3, inserts: 1, updateTry: 0, updates: 0, historyTry: 1, histories: 1, calcRows: 1 });
  });

  it("сбой update при правке: сводка не пишется вслепую; после успешного повтора — ровно одна", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
    await ctl.save(req(a));
    cloud.cfg.updateError = "network";
    assert.equal((await ctl.save(req(edited))).status, "save_failed");
    assert.deepEqual([cloud.log.updateTry, cloud.log.historyTry], [1, 1]);
    cloud.cfg.updateError = null;
    assert.equal((await ctl.save(req(edited))).calculationWrite, "update");
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 1, inserts: 1, updateTry: 2, updates: 1, historyTry: 2, histories: 2, calcRows: 1 });
  });
});

describe("жизненный цикл: отметка «списано» принадлежит конкретной попытке (файлу)", () => {
  const fpOf = (p) =>
    SES.reportFingerprint({ rows: p.parsed.report.rows, period: p.parsed.report.period, rowCount: p.parsed.report.summary.rowCount });
  const A = () => pipeline({ buf: basicBuf() });
  const B = () => pipeline({ buf: scenario("incomplete_month") });
  const req = (p) => ({ snapshot: p.evaluation.snapshot, ready: p.evaluation.readyToSave, userId: "u1" });
  /** Выбор файла на экране: прежняя попытка паркуется, потом берётся попытка нового файла. */
  const openFile = (ctl, p) => {
    assert.equal(ctl.beginAttempt(null), true);
    assert.equal(ctl.beginAttempt(fpOf(p)), true);
  };

  it("другой файл НЕ наследует списание: списанная, но не записанная попытка A остаётся за A, B платит сам", async () => {
    const cloud = makeMockCloud({ insertError: "down" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    openFile(ctl, a);
    assert.equal((await ctl.save(req(a))).status, "save_failed");
    assert.deepEqual([cloud.log.consume, ctl.state.paid, ctl.heldElsewhere], [1, true, 0]);

    openFile(ctl, b);
    assert.equal(ctl.state.paid, false, "у файла B нет отметки «списано»");
    assert.equal(ctl.heldElsewhere, 1, "попытка A припаркована за своим файлом");
    cloud.cfg.insertError = null;
    const out = await ctl.save(req(b));
    assert.equal(out.status, "saved");
    assert.equal(cloud.log.consume, 2, "B списал свою попытку");
    assert.equal(cloud.log.dup, 2, "и прошёл свой дубль-гард");
    assert.deepEqual(cloud.counts(), { consume: 2, dup: 2, insertTry: 2, inserts: 1, updateTry: 0, updates: 0, historyTry: 1, histories: 1, calcRows: 1 });
  });

  it("вернулись к файлу A: его попытка возвращается — сохранение без нового списания; дубль-гард повторно не открывается", async () => {
    const cloud = makeMockCloud({ insertError: "down" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    openFile(ctl, a);
    await ctl.save(req(a)); // A: списано, не записано
    openFile(ctl, b);
    cloud.cfg.insertError = null;
    await ctl.save(req(b)); // B: платит сам
    openFile(ctl, a);
    assert.equal(ctl.state.paid, true, "A получила свою отметку обратно");
    assert.equal(ctl.heldElsewhere, 0);
    const out = await ctl.save(req(a));
    assert.equal(out.status, "saved");
    assert.deepEqual([out.calculationWrite, out.historyWrite], ["insert", "written"]);
    assert.deepEqual(cloud.counts(), { consume: 2, dup: 2, insertTry: 3, inserts: 2, updateTry: 0, updates: 0, historyTry: 2, histories: 2, calcRows: 2 });
  });

  it("повтор сохранения после ошибки записи не списывает снова (последовательные нажатия)", async () => {
    const cloud = makeMockCloud({ insertError: "502", delayMs: 3 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(ctl, a);
    for (let i = 0; i < 3; i++) assert.equal((await ctl.save(req(a))).status, "save_failed");
    assert.deepEqual([cloud.log.consume, cloud.log.dup, cloud.log.insertTry], [1, 1, 3]);
    cloud.cfg.insertError = null;
    assert.equal((await ctl.save(req(a))).status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.dup, cloud.log.insertTry, cloud.log.inserts.length], [1, 1, 4, 1]);
  });

  it("правка расходов внутри текущей попытки (оплачена, не записана): списание остаётся одно, запись берёт ПОСЛЕДНИЕ значения", async () => {
    const cloud = makeMockCloud({ insertError: "down" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10", salary: "50" } });
    openFile(ctl, a);
    await ctl.save(req(a));
    cloud.cfg.insertError = null;
    const out = await ctl.save(req(edited));
    assert.equal(out.status, "saved");
    assert.equal(cloud.log.consume, 1);
    const row = cloud.rows.get(out.row.id);
    assert.equal(row.tax, 120);
    assert.equal(row.profit, 504.13);
  });

  it("отказ сервера в списании не оставляет отметки: попытка не считается оплаченной, следующая проверка платит заново", async () => {
    const cloud = makeMockCloud({ consumeOk: false });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(ctl, a);
    assert.equal((await ctl.save(req(a))).status, "paywall");
    assert.equal(ctl.state.paid, false);
    assert.equal(ctl.heldElsewhere, 0);
    openFile(ctl, B());
    assert.equal(ctl.heldElsewhere, 0, "неоплаченную попытку парковать нечего");
    cloud.cfg.consumeOk = true;
    assert.equal((await ctl.save(req(B()))).status, "saved");
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [2, 1]);
  });

  it("сменить файл во время сохранения нельзя: запись не уходит в чужую попытку", async () => {
    const cloud = makeMockCloud({ delayMs: 15 });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    const b = B();
    openFile(ctl, a);
    const pending = ctl.save(req(a));
    assert.equal(ctl.beginAttempt(fpOf(b)), false, "во время save попытка не меняется");
    assert.equal(ctl.beginAttempt(null), false);
    const out = await pending;
    assert.equal(out.status, "saved");
    assert.equal(ctl.state.attemptId, fpOf(a));
    assert.equal(ctl.state.saved.id, out.row.id);
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.histories.length], [1, 1, 1]);
    assert.equal(ctl.beginAttempt(fpOf(b)), true, "после завершения смена разрешена");
  });

  it("строку удалили из истории: та же попытка создаёт новую строку и дописывает сводку заново — без нового списания", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const a = A();
    openFile(ctl, a);
    await ctl.save(req(a));
    ctl.forgetSaved();
    const out = await ctl.save(req(a));
    assert.equal(out.created, true);
    assert.deepEqual(cloud.counts(), { consume: 1, dup: 1, insertTry: 2, inserts: 2, updateTry: 0, updates: 0, historyTry: 2, histories: 2, calcRows: 2 });
  });
});

// ---------------------------------------------------------------------------
// Доступ к результату и списание: платный РАСЧЁТ, а не платная запись в историю.
// БЕСПЛАТНО: проверка файла, период, покрытие себестоимости, список товаров без неё.
// ПОСЛЕ списания попытки ЭТОГО файла: чистая прибыль, разбивка, товарная аналитика, PDF.
// Права — мок модели из lib/entitlements.ts (1 бесплатный + кредиты 149 ₽; безлимит 449 ₽).
// ---------------------------------------------------------------------------
describe("доступ к результату: пока попытка файла не списана, результат и PDF закрыты", () => {
  const LOCKED = { unlocked: false, showResult: false, pdfAllowed: false };
  const OPEN = { unlocked: true, showResult: true, pdfAllowed: true };
  const fpOf = (p) =>
    SES.reportFingerprint({ rows: p.parsed.report.rows, period: p.parsed.report.period, rowCount: p.parsed.report.summary.rowCount });
  const A = () => pipeline({ buf: basicBuf() });
  const B = () => pipeline({ buf: scenario("incomplete_month") });
  const C = () => pipeline({ buf: basicBuf(), catalog: [CAT[0]] }); // у товара Б нет себестоимости
  const req = (p) => ({ snapshot: p.evaluation.snapshot, ready: p.evaluation.readyToSave, userId: "u1" });
  const view = (ctl, p) => SES.resultAccess(ctl.state.paid, p.evaluation);
  const open = (ctl, p) => {
    assert.equal(ctl.beginAttempt(null), true);
    assert.equal(ctl.beginAttempt(fpOf(p)), true);
  };
  const setup = (rights) => {
    const ent = makeEntitlements(rights);
    const cloud = makeMockCloud({ entitlement: ent });
    return { ent, cloud, ctl: new SF.AccrualSaveController(cloud.deps) };
  };
  const ZERO_WRITES = { inserts: 0, updates: 0, histories: 0, calcRows: 0 };
  const writes = (cloud) => {
    const c = cloud.counts();
    return { inserts: c.inserts, updates: c.updates, histories: c.histories, calcRows: c.calcRows };
  };

  it("правило resultAccess: результат и PDF = попытка оплачена И расчёт корректен; ошибка файла/ввода/расчёта результата не открывает", () => {
    const ok = A().evaluation;
    assert.deepEqual(SES.resultAccess(false, ok), LOCKED);
    assert.deepEqual(SES.resultAccess(true, ok), OPEN);
    assert.deepEqual(SES.resultAccess(false, null), LOCKED);
    assert.deepEqual(SES.resultAccess(true, null), { unlocked: true, showResult: false, pdfAllowed: false }); // файла нет
    const inputErr = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, packaging: "-1" } }).evaluation;
    const calcErr = pipeline({ buf: scenario("tax_zero") }).evaluation;
    for (const bad of [inputErr, calcErr]) {
      assert.equal(SES.resultAccess(true, bad).showResult, false);
      assert.equal(SES.resultAccess(true, bad).pdfAllowed, false);
    }
  });

  it("бесплатно и без списания: любое число файлов можно открыть и проверить — результата и PDF нет, consume 0, записей 0 (даже у пользователя с кредитами)", async () => {
    const { ent, cloud, ctl } = setup({ used: 0, credits: 5 });
    for (const p of [A(), B(), C(), A(), B()]) {
      open(ctl, p);
      assert.deepEqual(view(ctl, p), LOCKED, "результат закрыт до расчёта");
      // бесплатная часть доступна: готовность и список товаров без себестоимости
      assert.equal(typeof p.evaluation.readyToSave, "boolean");
    }
    assert.equal(C().evaluation.problemProducts.length, 1);
    assert.equal(C().evaluation.problemProducts[0].article, "ART-B");
    assert.deepEqual([ent.st.consumeCalls, cloud.log.consume, cloud.log.dup], [0, 0, 0]);
    assert.deepEqual(writes(cloud), ZERO_WRITES);
  });

  it("неполная себестоимость не списывает и не открывает результат — даже при безлимите", async () => {
    const { ent, cloud, ctl } = setup({ unlimited: true });
    const c = C();
    open(ctl, c);
    const out = await ctl.save(req(c));
    assert.equal(out.status, "not_ready");
    assert.deepEqual(view(ctl, c), LOCKED);
    assert.deepEqual([ent.st.consumeCalls, cloud.log.dup], [0, 0]);
    assert.deepEqual(writes(cloud), ZERO_WRITES);
  });

  describe("сценарий 1: бесплатная попытка исчерпана, кредитов и подписки нет", () => {
    it("результат и PDF недоступны ни для одного файла; расчёт → paywall без списания, без дубль-гарда и без записей", async () => {
      const { ent, cloud, ctl } = setup({ used: 1, credits: 0 });
      assert.equal(ent.canCalculate(), false);
      for (const p of [A(), B(), A()]) {
        open(ctl, p);
        assert.deepEqual(view(ctl, p), LOCKED);
        const out = await ctl.save(req(p));
        assert.equal(out.status, "paywall");
        assert.equal(out.reason, undefined, "отказ по клиентской проверке, до сервера");
        assert.equal(SES.saveOutcomeUi(out).openPaywall, true);
        assert.deepEqual(view(ctl, p), LOCKED, "после отказа результат по-прежнему закрыт");
      }
      assert.deepEqual([ent.st.consumeCalls, cloud.log.consume, cloud.log.dup, ent.st.used], [0, 0, 0, 1]);
      assert.deepEqual(writes(cloud), ZERO_WRITES);
    });

    it("клиентская проверка устарела (права ещё не загрузились), но сервер отказывает: consume не проходит, результат закрыт, отметки «списано» нет", async () => {
      const { ent, cloud, ctl } = setup({ used: 1, credits: 0 });
      ent.canCalculate = () => true; // клиент думает, что попытка есть
      const a = A();
      open(ctl, a);
      const out = await ctl.save(req(a));
      assert.equal(out.status, "paywall");
      assert.equal(out.reason, "limit_reached");
      assert.deepEqual([ent.st.consumeCalls, ent.st.refused, ent.st.granted, ent.st.used], [1, 1, 0, 1]);
      assert.deepEqual(view(ctl, a), LOCKED);
      assert.equal(ctl.state.paid, false);
      assert.equal(ctl.state.dupConfirmed, false, "подтверждение дубля откатывается — следующая попытка спросит заново");
      assert.deepEqual(writes(cloud), ZERO_WRITES);
    });
  });

  describe("сценарий 2: один кредит 149 ₽ (1 бесплатная уже израсходована)", () => {
    it("первый расчёт списывает кредит и открывает результат/PDF; правки без списания; другой файл закрыт и уходит в paywall; после покупки — снова доступен", async () => {
      const { ent, cloud, ctl } = setup({ used: 1, credits: 1 });
      const a = A();
      open(ctl, a);
      assert.deepEqual(view(ctl, a), LOCKED, "до расчёта результата нет");
      const saved = await ctl.save(req(a));
      assert.equal(saved.status, "saved");
      assert.deepEqual(view(ctl, a), OPEN, "после списания открыт результат и PDF");
      assert.deepEqual([ent.st.consumeCalls, ent.st.used, ent.canCalculate()], [1, 2, false]);
      assert.deepEqual(writes(cloud), { inserts: 1, updates: 0, histories: 1, calcRows: 1 });

      // правка расходов внутри оплаченного расчёта — без нового списания, результат остаётся открытым
      const edited = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, taxPercent: "10" } });
      assert.equal((await ctl.save(req(edited))).calculationWrite, "update");
      assert.deepEqual([ent.st.consumeCalls, view(ctl, edited).showResult], [1, true]);

      // другой файл: оплата не наследуется, кредита больше нет → закрыт, paywall
      const b = B();
      open(ctl, b);
      assert.deepEqual(view(ctl, b), LOCKED);
      assert.equal((await ctl.save(req(b))).status, "paywall");
      assert.deepEqual(view(ctl, b), LOCKED);
      // тот же файл после сохранения — новый расчёт: снова закрыт и без кредита в paywall
      open(ctl, a);
      assert.deepEqual(view(ctl, a), LOCKED);
      assert.equal((await ctl.save(req(a))).status, "paywall");
      assert.deepEqual([ent.st.consumeCalls, ent.st.used], [1, 2]);
      assert.equal(cloud.counts().calcRows, 1);

      // покупка ещё одного кредита → B открывается своим списанием
      ent.st.credits++;
      open(ctl, b);
      assert.equal((await ctl.save(req(b))).status, "saved");
      assert.deepEqual([view(ctl, b), ent.st.consumeCalls, ent.st.used], [OPEN, 2, 3]);
      assert.equal(cloud.counts().calcRows, 2);
    });
  });

  describe("сценарий 3: доступна первая бесплатная попытка", () => {
    it("файлы можно проверять без списания; первый расчёт использует бесплатную попытку и открывает результат; второй файл — paywall", async () => {
      const { ent, cloud, ctl } = setup({ used: 0, credits: 0 });
      for (const p of [A(), B(), C()]) {
        open(ctl, p);
        assert.deepEqual(view(ctl, p), LOCKED);
      }
      assert.equal(ent.st.consumeCalls, 0, "проверка файлов и нехватка себестоимости не списывают");
      const a = A();
      open(ctl, a);
      assert.equal((await ctl.save(req(a))).status, "saved");
      assert.deepEqual([view(ctl, a), ent.st.consumeCalls, ent.st.used, ent.canCalculate()], [OPEN, 1, 1, false]);
      const b = B();
      open(ctl, b);
      assert.deepEqual(view(ctl, b), LOCKED);
      assert.equal((await ctl.save(req(b))).status, "paywall");
      assert.deepEqual([ent.st.consumeCalls, cloud.counts().calcRows], [1, 1]);
    });

    it("списание прошло, запись упала: результат уже открыт (оплачено), повтор без второго списания; другой файл остаётся закрытым и платит сам", async () => {
      const { ent, cloud, ctl } = setup({ used: 0, credits: 1 });
      cloud.cfg.insertError = "502";
      const a = A();
      const b = B();
      open(ctl, a);
      assert.equal((await ctl.save(req(a))).status, "save_failed");
      assert.deepEqual([view(ctl, a), ent.st.consumeCalls], [OPEN, 1]);
      assert.equal((await ctl.save(req(a))).status, "save_failed");
      assert.equal(ent.st.consumeCalls, 1, "повтор не списывает");

      open(ctl, b); // другой файл: отметка не наследуется
      assert.deepEqual(view(ctl, b), LOCKED);
      cloud.cfg.insertError = null;
      assert.equal((await ctl.save(req(b))).status, "saved"); // кредит 149 ₽ → свой расчёт
      assert.deepEqual([ent.st.consumeCalls, ent.st.used, view(ctl, b)], [2, 2, OPEN]);

      open(ctl, a); // вернулись к A: его оплаченная попытка возвращается вместе с результатом
      assert.deepEqual(view(ctl, a), OPEN);
      assert.equal((await ctl.save(req(a))).status, "saved");
      assert.deepEqual([ent.st.consumeCalls, cloud.counts().calcRows], [2, 2]);
    });
  });

  describe("сценарий 4: активен безлимит 449 ₽", () => {
    it("каждый новый файл открывается СВОИМ расчётом (consume без роста счётчика), результат не наследуется; повтор сохранения не списывает", async () => {
      const { ent, cloud, ctl } = setup({ unlimited: true });
      const a = A();
      const b = B();
      open(ctl, a);
      assert.deepEqual(view(ctl, a), LOCKED, "и у безлимита результат открывается расчётом, а не сам по себе");
      assert.equal((await ctl.save(req(a))).status, "saved");
      assert.deepEqual([view(ctl, a), ent.st.consumeCalls, ent.st.used], [OPEN, 1, 0]);
      assert.equal((await ctl.save(req(a))).status, "unchanged");
      assert.equal(ent.st.consumeCalls, 1);

      open(ctl, b);
      assert.deepEqual(view(ctl, b), LOCKED);
      assert.equal((await ctl.save(req(b))).status, "saved");
      assert.deepEqual([view(ctl, b), ent.st.consumeCalls, ent.st.used], [OPEN, 2, 0]);

      open(ctl, a); // тот же файл заново — новый расчёт
      assert.deepEqual(view(ctl, a), LOCKED);
      assert.equal((await ctl.save(req(a))).status, "saved");
      assert.deepEqual([ent.st.consumeCalls, cloud.counts().calcRows, cloud.log.dup], [3, 3, 3]);
    });
  });
});

describe("reportFingerprint: идентичность попытки = файл, а не ввод", () => {
  const rep = (buf) => {
    const p = parseBuf(buf);
    return { rows: p.report.rows, period: p.report.period, rowCount: p.report.summary.rowCount };
  };
  it("тот же файл → тот же отпечаток (даже при повторном разборе); другой файл → другой", () => {
    assert.equal(SES.reportFingerprint(rep(basicBuf())), SES.reportFingerprint(rep(basicBuf())));
    assert.notEqual(SES.reportFingerprint(rep(basicBuf())), SES.reportFingerprint(rep(scenario("incomplete_month"))));
  });
  it("изменение одной суммы в строке меняет отпечаток; период входит в отпечаток", () => {
    const r = rep(basicBuf());
    const tampered = { ...r, rows: r.rows.map((x, i) => (i === 0 ? { ...x, amountKopecks: x.amountKopecks + 1 } : x)) };
    assert.notEqual(SES.reportFingerprint(r), SES.reportFingerprint(tampered));
    assert.ok(SES.reportFingerprint(r).startsWith("2026-06:"));
  });
});

describe("saveOutcomeUi: что видит пользователь после каждого исхода", () => {
  const base = { row: { id: "c1", synced: true, createdAt: NOW }, columns: {}, created: false, local: false };
  it("busy — ничего не меняет", () => {
    const u = SES.saveOutcomeUi({ status: "busy" });
    assert.deepEqual([u.note, u.needsRetry, u.markSaved, u.emitSaved, u.openPaywall, u.toast], [null, null, false, false, false, null]);
  });
  it("unchanged — «уже сохранено», записи страницей не сообщается, повтор больше не нужен", () => {
    const u = SES.saveOutcomeUi({ status: "unchanged", row: base.row });
    assert.match(u.note.text, /уже сохранён, изменений нет/);
    assert.deepEqual([u.needsRetry, u.markSaved, u.emitSaved], [false, true, false]);
  });
  it("saved insert / update / none / history failed / local — свои тексты и признаки повтора", () => {
    const mk = (o) => SES.saveOutcomeUi({ status: "saved", historyWarning: null, ...base, calculationWrite: "insert", historyWrite: "written", ...o });
    assert.match(mk({ created: true }).note.text, /Расчёт сохранён в историю/);
    assert.match(mk({ calculationWrite: "update" }).note.text, /Изменения сохранены.*не списывалась/);
    assert.match(mk({ calculationWrite: "none" }).note.text, /Сводка по месяцам дописана/);
    const failed = mk({ historyWrite: "failed", historyWarning: "Расчёт сохранён, но сводка по месяцам не обновилась: 500" });
    assert.deepEqual([failed.needsRetry, failed.historyRecorded, failed.emitSaved, failed.note.kind], [true, false, true, "warn"]);
    const local = mk({ local: true, calculationWrite: "local", historyWrite: "local" });
    assert.deepEqual([local.needsRetry, local.historyRecorded, local.note.kind], [false, false, "warn"]);
  });
  it("save_failed — повтор доступен и явно сказано, что списание не повторится; paywall/cancelled/not_ready — попытка не списана", () => {
    const f = SES.saveOutcomeUi({ status: "save_failed", error: "502" });
    assert.equal(f.needsRetry, true);
    assert.match(f.note.text, /не спишет её снова/);
    assert.equal(SES.saveOutcomeUi({ status: "paywall", reason: "limit_reached" }).openPaywall, true);
    for (const st of [{ status: "cancelled" }, { status: "paywall" }]) assert.match(SES.saveOutcomeUi(st).note.text, /не списан/);
    assert.equal(SES.saveOutcomeUi({ status: "not_ready", reason: "x" }).markSaved, false);
  });
});

describe("маппинг числовых колонок calculations / report_history", () => {
  const ev = pipeline({ buf: basicBuf() }).evaluation;
  const cols = COL.accrualSnapshotToCalculationColumns(ev.snapshot);
  const hist = COL.accrualSnapshotToReportHistoryColumns(ev.snapshot);
  const { snapshot: full } = pipeline({ buf: basicBuf(), inputs: FULL_INPUTS }).evaluation;
  const fullCols = COL.accrualSnapshotToCalculationColumns(full);

  it("revenue = реализация после возвратов (1 200,00), а НЕ итог начислений (937,46)", () => {
    assert.equal(cols.revenue, 1200);
    assert.notEqual(cols.revenue, 937.46);
  });
  it("категории — списания gross: комиссия 180, логистика 67, реклама 60, прочие сборы 15,55; storage 0", () => {
    assert.deepEqual(
      [cols.commission, cols.logistics, cols.ads, cols.storage],
      [180, 67, 60, 0]
    );
    assert.equal(cols.other_expenses, 28.88); // 15,55 (сборы Ozon) + 10,00 упаковка + 3,33 прочие
  });
  it("налог, себестоимость, прибыль, маржа", () => {
    assert.deepEqual([cols.tax, cols.cost, cols.profit, cols.margin], [84, 250, 590.13, 49.18]);
  });
  it("total_expenses = revenue − profit (609,87): тождество до копейки", () => {
    assert.equal(cols.total_expenses, 609.87);
    assert.equal(Math.round((cols.revenue - cols.total_expenses) * 100), Math.round(cols.profit * 100));
  });
  it("Σ колонок расходов (669,88) больше total_expenses ровно на доходные категории 60,01 = партнёры 5 + баллы 25 + компенсации 30,01 — без двойного счёта", () => {
    const gross = cols.commission + cols.logistics + cols.ads + cols.storage + cols.tax + cols.cost + cols.other_expenses;
    assert.equal(Math.round(gross * 100), 66988);
    assert.equal(Math.round((gross - cols.total_expenses) * 100), 6001);
  });
  it("«Реклама вне Ozon» → колонка ads (60 + 100), остальные ручные → other_expenses (15,55 + 10 + 20 + 30,50 + 3,33) — каждая сумма один раз", () => {
    assert.equal(fullCols.ads, 160);
    assert.equal(fullCols.other_expenses, 79.38);
    assert.equal(fullCols.total_expenses, 760.37);
    assert.equal(fullCols.profit, 439.63);
  });
  it("режим и площадка: mode = upload, marketplace = ozon", () => {
    assert.deepEqual([cols.mode, cols.marketplace], ["upload", "ozon"]);
  });
  it("ai_insights — сериализованный снимок нового вида", () => {
    assert.equal(cols.ai_insights.kind, "ozon-accrual-xlsx-v1");
    assert.equal(S.readAccrualSnapshot(cols.ai_insights).status, "ok");
  });
  it("report_history: первое число месяца отчёта и те же значения", () => {
    assert.deepEqual(hist, { report_month: "2026-06-01", revenue: 1200, expenses: 609.87, profit: 590.13, margin: 49.18 });
  });
  it("null-маржа: в колонки пишется 0 (NOT NULL), а показывается «—» из снимка", () => {
    const nullSnap = S.asAccrualSnapshot({ ...viaJson(ev.snapshot), marginPercent: null });
    const c = COL.accrualSnapshotToCalculationColumns(nullSnap);
    assert.equal(c.margin, 0);
    assert.equal(COL.accrualSnapshotToReportHistoryColumns(nullSnap).margin, 0);
    assert.equal(S.effectiveHistoryMargin(c.ai_insights, c.margin), null);
  });
  it("убыток: profit < 0, total_expenses > revenue, тождество сохраняется", () => {
    const loss = pipeline({ buf: basicBuf(), inputs: { ...INPUTS, other: "2000" } }).evaluation.snapshot;
    const c = COL.accrualSnapshotToCalculationColumns(loss);
    assert.ok(c.profit < 0 && c.total_expenses > c.revenue);
    assert.equal(Math.round((c.revenue - c.total_expenses) * 100), Math.round(c.profit * 100));
  });
  it("положительные (доходные) части списочных корзин не превращаются в расход", () => {
    const x = viaJson(ev.snapshot);
    // условная корзина с плюсом: комиссия +100 копеек вместо −18000; net и прибыль пересчитываем согласованно
    const delta = 100 - x.buckets.commission;
    x.buckets.commission = 100;
    x.netOzonOperationsKopecks += delta;
    x.netProfitKopecks += delta;
    x.marginPercent = Math.round((x.netProfitKopecks * 10000) / x.taxRevenueBaseKopecks) / 100;
    const snap = S.asAccrualSnapshot(x);
    assert.ok(snap, "гипотетический снимок должен быть корректным");
    assert.equal(COL.accrualSnapshotToCalculationColumns(snap).commission, 0);
  });
});

describe("старые снимки продолжают открываться; прежние v1-снимки без нового поля читаются", () => {
  it("net-profit-3file / ozon-api-v1 / без снимка — не наш вид (absent): открываются прежними ветками", () => {
    for (const v of [{ kind: "net-profit-3file", revenueOzon: 1 }, { kind: "ozon-api-v1", period: { month: "2026-05" } }, null, undefined]) {
      assert.equal(S.readAccrualSnapshot(v).status, "absent");
    }
    assert.equal(S.effectiveHistoryMargin({ kind: "net-profit-3file" }, 12.5), 12.5);
  });
  it("v1-снимок, сохранённый до PR-3 (без adsOutsideOzonKopecks), читается: поле = 0", () => {
    const old = viaJson(pipeline({ buf: basicBuf() }).evaluation.snapshot);
    delete old.manualExpenses.adsOutsideOzonKopecks;
    const r = S.readAccrualSnapshot(old);
    assert.equal(r.status, "ok");
    assert.equal(r.snapshot.manualExpenses.adsOutsideOzonKopecks, 0);
  });
  it("но если удалённое поле было ненулевым, сумма не сойдётся → invalid, а не тихий ноль", () => {
    const x = viaJson(pipeline({ buf: basicBuf(), inputs: FULL_INPUTS }).evaluation.snapshot);
    delete x.manualExpenses.adsOutsideOzonKopecks;
    assert.equal(S.readAccrualSnapshot(x).status, "invalid");
  });
  it("повреждённая ai_insights новой строки не даёт нулевой результат", () => {
    const x = viaJson(pipeline({ buf: basicBuf() }).evaluation.snapshot);
    x.netProfitKopecks += 1;
    assert.equal(S.readAccrualSnapshot(x).status, "invalid");
  });
});

describe("инструкция скачивания отчёта (путь подтверждён скриншотами владельца)", () => {
  it("ровно 7 шагов в заданном порядке и формулировках", () => {
    assert.deepEqual(
      [...GUIDE.ACCRUAL_DOWNLOAD_STEPS],
      [
        "Откройте личный кабинет Ozon Seller → «Финансы» → «Начисления и документы».",
        "На странице «Экономика магазина» откройте вкладку «Детализация начислений».",
        "Нажмите «Скачать отчёт».",
        "Выберите вариант «По начислениям».",
        "В окне скачивания укажите полный календарный месяц: с первого по последнее число. Например, 01.06.2026–30.06.2026.",
        "Нажмите «Скачать».",
        "Прикрепите полученный XLSX в M-PROF: перетащите его в область загрузки или нажмите «Выбрать файл».",
      ]
    );
  });
  it("нет выдуманного шага про выбор формата (на скриншотах его нет); пример периода — полный месяц", () => {
    const steps = GUIDE.ACCRUAL_DOWNLOAD_STEPS;
    assert.ok(steps.every((t) => !/выберите\s+(формат|xlsx)|формат\s+xlsx/i.test(t)), "шага «выберите XLSX» быть не должно");
    assert.match(steps[4], /01\.06\.2026–30\.06\.2026/);
  });
  it("пояснение рядом: нужен «По начислениям»; «По логистике», реализация и УПД не подходят", () => {
    assert.equal(
      GUIDE.ACCRUAL_REPORT_CHOICE_NOTE,
      "Нужен отчёт «По начислениям». Отчёт «По логистике», отчёт реализации и УПД для этого способа расчёта не подходят."
    );
  });
  it("файл другого отчёта (нет листа «Начисления» / нет колонок) — понятная ошибка с подсказкой про «По логистике»; обычные ошибки данных подсказки не получают", () => {
    for (const name of ["wrong_sheet", "no_amount_column"]) {
      const p = parseBuf(scenario(name));
      assert.equal(p.ok, false, name);
      const lines = SES.formatParseErrors(p.errors);
      assert.ok(lines.some((l) => /«По начислениям» — не «По логистике», не отчёт реализации и не УПД/.test(l)), name);
    }
    const dataErr = SES.formatParseErrors(parseBuf(scenario("missing_amount")).errors);
    assert.doesNotMatch(dataErr.join(" "), /По логистике/);
  });
  it("отказы по формату не просят «выбрать формат XLSX» в кабинете, а отсылают к инструкции и отчёту «По начислениям»", () => {
    for (const name of ["a.xls", "a.csv", "noext"]) {
      const r = SES.validateAccrualFile({ name, size: 5 });
      assert.equal(r.ok, false);
      assert.match(r.message, /«По начислениям»/);
      assert.match(r.message, /инструкци/);
      assert.doesNotMatch(r.message, /в формате XLSX/);
    }
  });
});

describe("проверка файла", () => {
  it(".xlsx принимается (регистр не важен)", () => {
    assert.equal(SES.validateAccrualFile({ name: "Отчет по начислениям_01.06.2026-30.06.2026.xlsx", size: 100 }).ok, true);
    assert.equal(SES.validateAccrualFile({ name: "REPORT.XLSX", size: 100 }).ok, true);
  });
  it(".pdf, .xls, .csv, без расширения, пустой — понятные отказы (в подсказках нет УПД как требования)", () => {
    const msgs = [
      SES.validateAccrualFile({ name: "a.pdf", size: 5 }),
      SES.validateAccrualFile({ name: "a.xls", size: 5 }),
      SES.validateAccrualFile({ name: "a.csv", size: 5 }),
      SES.validateAccrualFile({ name: "noext", size: 5 }),
      SES.validateAccrualFile({ name: "a.xlsx", size: 0 }),
    ];
    assert.ok(msgs.every((m) => m.ok === false && m.message.length > 15));
    assert.match(msgs[0].message, /PDF для расчёта не нужен/);
    assert.doesNotMatch(msgs.map((m) => m.message).join(" "), /загрузите.*УПД/i);
  });
  it("ошибки разбора форматируются без товарных данных, с номерами строк", () => {
    const p = parseBuf(scenario("missing_amount"));
    const lines = SES.formatParseErrors(p.errors);
    assert.match(lines[0], /Строки листа: \d+/);
    assert.doesNotMatch(lines.join(" "), /ART-|Товар/);
  });
});
