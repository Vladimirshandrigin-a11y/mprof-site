// Содержимое PDF нового формата (чистая модель pdf-model.ts): период, итог,
// себестоимость, налог, ручные расходы, прибыль, маржа («—» при null),
// разбивка по реальным категориям, ключевые товары, предупреждения и пояснения.
// Рисование на canvas/jsPDF проверяется визуально отдельно (см. README).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshotFor, viaJson } from "./helpers/snapshot-fixtures.mjs";
import { pdfModel as P, snapshot as S } from "./helpers/modules.mjs";

const NOW = new Date(2026, 6, 1, 10, 30); // 01.07.2026 10:30 (локальное время)
const nb = (s) => s.replace(/ | /g, " ");
const model = (snap, now = NOW) => {
  const m = P.buildAccrualPdfModel(snap, now);
  // единообразные пробелы для сравнения строк
  return JSON.parse(nb(JSON.stringify(m)));
};

describe("PDF нового формата: полный расчёт", () => {
  const { snapshot } = buildSnapshotFor("basic");
  const m = model(snapshot);

  it("имя файла, заголовок, период и дата формирования", () => {
    assert.equal(m.fileName, "mprof-accrual-report-2026-06.pdf");
    assert.equal(m.title, "ОТЧЁТ ПО НАЧИСЛЕНИЯМ OZON");
    assert.equal(m.periodLine, "Июнь 2026 · 01.06.2026 — 30.06.2026");
    assert.match(m.dateStr, /01\.07\.2026/);
  });
  it("hero: итоговая чистая прибыль, маржа, ROI", () => {
    assert.equal(m.hero.label, "ИТОГОВАЯ ЧИСТАЯ ПРИБЫЛЬ");
    assert.equal(m.hero.value, "+590,13 ₽");
    assert.equal(m.hero.positive, true);
    assert.deepEqual(
      m.hero.stats.map((x) => [x.label, x.value.startsWith("49,2") || x.value.startsWith("236,") ? "ok" : x.value, x.neg]),
      [["МАРЖИНАЛЬНОСТЬ", "ok", false], ["ROI", "ok", false]]
    );
    assert.equal(m.hero.stats[0].value, "49,2 %");
  });
  it("разбивка: реальные категории начислений, итог начислений, себестоимость, налог, ручные, прибыль", () => {
    assert.deepEqual(
      m.rows.map((r) => [r.label, r.value, r.kind]),
      [
        ["Реализация (выручка)", "+1 500,00 ₽", "income"],
        ["Возвраты выручки", "−300,00 ₽", "expense"],
        ["Программы партнёров", "+5,00 ₽", "income"],
        ["Баллы за скидки", "+25,00 ₽", "income"],
        ["Комиссия Ozon (вознаграждение)", "−180,00 ₽", "expense"],
        ["Доставка и связанные услуги", "−67,00 ₽", "expense"],
        ["Продвижение и реклама", "−60,00 ₽", "expense"],
        ["Компенсации", "+30,01 ₽", "income"],
        ["Прочие начисления и сборы", "−15,55 ₽", "expense"],
        ["Итог начислений Ozon", "937,46 ₽", "subtotal"],
        ["Себестоимость", "−250,00 ₽", "expense"],
        ["Налог (7%)", "−84,00 ₽", "expense"],
        ["Ручные расходы", "−13,33 ₽", "expense"],
        ["Итоговая чистая прибыль", "+590,13 ₽", "total"],
      ]
    );
  });
  it("итог начислений снабжён пояснением, что категории уже включены", () => {
    const net = m.rows.find((r) => r.label === "Итог начислений Ozon");
    assert.match(net.sub, /уже включены в этот итог/);
  });
  it("покрытие каталога и товары только с услугами", () => {
    assert.equal(
      m.coverageLine,
      "Товаров в расчёте: 3 · с себестоимостью: 2 из 2 · только услуги (себестоимость не нужна): 1 товар"
    );
  });
  it("ключевые товары: лучший и худший, «—» у неопределимой маржи", () => {
    assert.deepEqual(m.keyProducts.best, {
      name: "Товар Б", article: "ART-B", profit: "+329,64 ₽", margin: "65,9 %", positive: true, marginNeg: false,
    });
    assert.deepEqual(m.keyProducts.worst, {
      name: "Товар В", article: "ART-C", profit: "−7,00 ₽", margin: "—", positive: false, marginNeg: false,
    });
  });
  it("предупреждения и пояснения присутствуют; нет упоминаний УПД", () => {
    assert.equal(m.noticesTitle, "ПРЕДУПРЕЖДЕНИЯ");
    assert.ok(m.notices.some((t) => /неизвестных типов/.test(t)));
    assert.equal(m.explanations.length, 6);
    assert.doesNotMatch(JSON.stringify(m), /УПД|агентск/i);
  });
  it("подвал; готовый результат без плашек статуса", () => {
    assert.match(m.footer, /чистая прибыль/);
    assert.deepEqual(m.badges, []);
  });
});

describe("PDF: маржа «—», предварительный результат, неполный месяц, убыток", () => {
  it("null-маржа → «—» в hero (а не «0,0 %»)", () => {
    const { snapshot } = buildSnapshotFor("basic");
    const withNull = S.asAccrualSnapshot({ ...viaJson(snapshot), marginPercent: null });
    const m = model(withNull);
    assert.equal(m.hero.stats[0].value, "—");
    assert.equal(m.hero.stats[0].neg, false);
  });
  it("настоящая нулевая маржа → «0,0 %»", () => {
    const { snapshot } = buildSnapshotFor("basic", { manualExpenses: { packaging: 10, other: 593.46 } });
    const m = model(snapshot);
    assert.equal(m.hero.stats[0].value, "0,0 %");
    assert.equal(m.hero.value, "0,00 ₽");
  });
  it("неполная себестоимость: «предварительный результат», прибыль не называется чистой", () => {
    const { snapshot } = buildSnapshotFor("basic", { catalog: [{ sku: "ART-A", name: "a", cost_price: 100 }] });
    const m = model(snapshot);
    assert.equal(m.hero.label, "ПРЕДВАРИТЕЛЬНАЯ ПРИБЫЛЬ");
    assert.match(m.hero.caption, /предварительный/);
    assert.ok(m.badges.some((b) => /ПРЕДВАРИТЕЛЬНЫЙ РЕЗУЛЬТАТ/.test(b.text)));
    assert.equal(m.rows.at(-1).label, "Предварительная прибыль");
    assert.equal(m.rows.find((r) => r.key === undefined && r.label === "Себестоимость (неполная)").kind, "expense");
    assert.ok(m.notices.some((t) => /Предварительный результат: у 1 из 2 товаров нет себестоимости/.test(t)));
    assert.match(m.coverageLine, /без себестоимости: 1/);
    assert.doesNotMatch(m.footer, /чистая прибыль/);
  });
  it("неполный месяц: плашка и предупреждение", () => {
    const { snapshot } = buildSnapshotFor("incomplete_month");
    const m = model(snapshot);
    assert.ok(m.badges.some((b) => b.text === "НЕПОЛНЫЙ МЕСЯЦ"));
    assert.ok(m.notices.some((t) => /не весь календарный месяц/.test(t)));
    assert.equal(m.periodLine, "Июнь 2026 · 01.06.2026 — 20.06.2026");
  });
  it("убыток: подпись, знак минус и красный итог", () => {
    const { snapshot } = buildSnapshotFor("basic", { manualExpenses: { other: 2000 } });
    const m = model(snapshot);
    assert.equal(m.hero.label, "ЧИСТЫЙ УБЫТОК");
    assert.equal(m.hero.positive, false);
    assert.match(m.hero.value, /^\u2212[\d ]+,\d{2} ₽$/);
    assert.equal(m.rows.at(-1).kind, "total");
    assert.match(m.rows.at(-1).value, /^−/);
  });
  it("нет товаров с себестоимостью → блок ключевых товаров не рисуется (как в старом PDF)", () => {
    const { snapshot } = buildSnapshotFor("return_only_product", { catalog: [] });
    assert.equal(model(snapshot).keyProducts, null);
  });
  it("неизвестные типы: предупреждение без товарных данных", () => {
    const { snapshot } = buildSnapshotFor("basic");
    assert.doesNotMatch(JSON.stringify(model(snapshot).notices), /ART-|Товар/);
  });
});
