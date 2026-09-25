// PR-3: загрузка «Отчёта по начислениям» → каталог → расчёт → снимок → сохранение
// (мок облака) → восстановление; граница списания; маппинг колонок.
// Вызываются РЕАЛЬНЫЕ модули проекта; облако и consume — счётчики-моки, реальных
// списаний и записей нет. Ожидания — независимые литералы.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scenario } from "./helpers/fixtures.mjs";
import { CAT, EXPECTED_BASIC as E } from "./helpers/expected.mjs";
import { makeMockCloud } from "./helpers/mock-cloud.mjs";
import { columns as COL, parseBuf, pdfModel as P, saveFlow as SF, session as SES, snapshot as S } from "./helpers/modules.mjs";

const viaJson = (x) => JSON.parse(JSON.stringify(x));
const NOW = "2026-07-01T10:00:00.000Z";
const INPUTS = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "", salary: "", other: "3,33", adsOutsideOzon: "" };
const FULL_INPUTS = { taxPercent: "7", packaging: "10", deliveryToWarehouse: "20", salary: "30,50", other: "3,33", adsOutsideOzon: "100" };

/** Файл → проверка → разбор → (каталог) → оценка. Возвращает всё, что видел бы экран. */
function pipeline({ name = "Отчет по начислениям_01.06.2026-30.06.2026.xlsx", buf, catalog = CAT, inputs = INPUTS }) {
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
    generatedAt: NOW,
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
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length, cloud.log.updates.length, cloud.log.histories.length], [1, 1, 1, 1]);
  });

  it("ошибка обновления не создаёт вторую строку", async () => {
    const cloud = makeMockCloud();
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    cloud.cfg.updateError = "network";
    const out = await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
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

  it("новый файл после сохранённого расчёта — новая оплата; после НЕсохранённого — удержанная попытка не списывается второй раз", async () => {
    const cloud = makeMockCloud({ insertError: "down" });
    const ctl = new SF.AccrualSaveController(cloud.deps);
    const ev = pipeline({ buf: basicBuf() }).evaluation;
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" }); // оплачено, записи нет
    assert.equal(cloud.log.consume, 1);
    ctl.startNewFile(); // пользователь выбрал другой файл
    assert.equal(ctl.state.paid, true);
    cloud.cfg.insertError = null;
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [1, 1]);
    ctl.startNewFile(); // после успешного сохранения оплата «закрыта»
    assert.equal(ctl.state.paid, false);
    await ctl.save({ snapshot: ev.snapshot, ready: true, userId: "u1" });
    assert.deepEqual([cloud.log.consume, cloud.log.inserts.length], [2, 2]);
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
