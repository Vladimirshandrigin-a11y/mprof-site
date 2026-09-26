// ============================================================================
// Модель PDF-отчёта по расчёту «Отчёт по начислениям» (PR-2). ЧИСТАЯ функция:
// снимок → готовые строки текста (без DOM/canvas). Рисует её pdf-render.ts;
// тесты проверяют содержимое модели (период, итог, категории, маржа «—»,
// предварительный результат, предупреждения, ключевые товары).
// ============================================================================

import {
  accrualBreakdownRows,
  accrualCostCoverageView,
  accrualExplanations,
  accrualKeyProducts,
  accrualNotices,
  accrualPeriodLabel,
  accrualPeriodRange,
  accrualProfitLabel,
  accrualSalesSplitView,
  accrualSplitReconciliationText,
  accrualSnapshotRoi,
  accrualSplitUnavailableText,
  type AccrualRowKind,
  type AccrualSnapshotV1,
} from "./snapshot";
import { fmtAmount, fmtPercent, fmtRub, fmtSignedRub, pluralRu } from "./format";

export interface PdfRow {
  label: string;
  value: string;
  kind: AccrualRowKind;
  /** Пояснение под строкой. */
  sub?: string;
}

export interface PdfStat {
  label: string;
  value: string;
  neg: boolean;
}

export interface PdfKeyProduct {
  name: string;
  article: string;
  profit: string;
  margin: string;
  positive: boolean;
  marginNeg: boolean;
}

export interface AccrualPdfModel {
  fileName: string;
  dateStr: string;
  title: string;
  periodLine: string;
  /** Плашки статуса: предварительный результат, неполный месяц. */
  badges: { text: string; tone: "warn" | "info" }[];
  hero: {
    label: string;
    value: string;
    positive: boolean;
    caption: string;
    stats: PdfStat[];
  };
  breakdownTitle: string;
  rows: PdfRow[];
  coverageLine: string;
  /** null — товаров с себестоимостью нет: блок не рисуется (как в старом PDF). */
  keyProducts: {
    best: PdfKeyProduct;
    worst: PdfKeyProduct | null;
    /** Подписи карточки убыточного: по продажам или по полной прибыли (старый снимок). */
    worstTitle: string;
    worstProfitLabel: string;
    worstMarginLabel: string;
    worstEmptyText: string;
  } | null;
  /** Разделение результата товаров: продажи / возвраты / без продаж / неразделённые. */
  splitTitle: string;
  splitLines: string[];
  noticesTitle: string;
  notices: string[];
  explanationsTitle: string;
  explanations: string[];
  footer: string;
}

function rowValue(kind: AccrualRowKind, kopecks: number): string {
  switch (kind) {
    case "income":
    case "expense":
      // знак задаёт вид строки; величина — модуль
      return (kind === "income" ? "+" : "−") + fmtAmount(kopecks) + " ₽";
    case "subtotal":
      return fmtRub(kopecks);
    case "total":
      return fmtSignedRub(kopecks);
    default:
      return fmtRub(kopecks);
  }
}

export function buildAccrualPdfModel(s: AccrualSnapshotV1, now: Date = new Date()): AccrualPdfModel {
  const dateStr = now.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const netPositive = s.netProfitKopecks >= 0;

  const rows: PdfRow[] = accrualBreakdownRows(s).map((r) => ({
    label: r.label,
    value: rowValue(r.kind, r.kind === "income" || r.kind === "expense" ? Math.abs(r.kopecks) : r.kopecks),
    kind: r.kind,
    ...(r.note ? { sub: r.note } : {}),
  }));

  const roi = accrualSnapshotRoi(s);
  const cov = accrualCostCoverageView(s);
  const coverageLine =
    `Товаров в расчёте: ${cov.total} · с себестоимостью: ${cov.withCost} из ${cov.withCost + cov.withoutCost}` +
    (cov.withoutCost > 0 ? ` · без себестоимости: ${cov.withoutCost}` : "") +
    (cov.serviceOnly > 0
      ? ` · только услуги (себестоимость не нужна): ${cov.serviceOnly} ${pluralRu(cov.serviceOnly, "товар", "товара", "товаров")}`
      : "");

  const kp = accrualKeyProducts(s);
  const split = accrualSalesSplitView(s);
  const salesBasis = split.availability === "ok";
  const splitLines: string[] = [];
  const unavailable = accrualSplitUnavailableText(split.availability);
  if (unavailable) splitLines.push(unavailable);
  else {
    const money = (v: number | null) => (v === null ? "не определено (нет себестоимости)" : fmtRub(v));
    splitLines.push(
      `Расчётная прибыль от продаж: ${money(split.sales.totalKopecks)} (товаров с продажами: ${split.sales.products}).`
    );
    splitLines.push(
      `Результат возвратов — по начислениям этого периода (возврат может относиться к продаже прошлого периода): ${money(split.returns.totalKopecks)} (товаров: ${split.returns.rows.length}).`
    );
    splitLines.push(`Расходы без продаж в периоде: ${money(split.noSale.totalKopecks)} (товаров: ${split.noSale.rows.length}).`);
    if (split.unsplit.rows.length > 0) {
      splitLines.push(
        `Неразделённые операции: ${money(split.unsplit.totalKopecks)} (товаров: ${split.unsplit.rows.length}) — частичные возвраты, неоднозначные связи и операции без связи с продажей; отнесены отдельно, в продажи и возвраты не включены.`
      );
    }
    const rec = accrualSplitReconciliationText(split);
    if (rec) splitLines.push(`Сверка: ${rec}.`);
    splitLines.push(
      `Продажи в минус: ${split.losses.length}` +
        (split.excluded.length > 0
          ? `; не включены в рейтинг — неразделённые операции могут изменить вывод: ${split.excluded.length}`
          : "") +
        (split.salesWithoutCost > 0 ? `; без себестоимости: ${split.salesWithoutCost}` : "") +
        "."
    );
    splitLines.push(
      "Налог, ручные расходы и общие начисления без товара распределены внутри товара пропорционально положительной выручке части — это правило распределения, а не привязка расхода к отправлению."
    );
  }
  const toPdf = (p: NonNullable<typeof kp.best>): PdfKeyProduct => ({
    name: p.name || p.article,
    article: p.article,
    profit: fmtSignedRub(p.profitKopecks),
    margin: fmtPercent(p.marginPercent),
    positive: p.profitKopecks >= 0,
    marginNeg: p.marginPercent !== null && p.marginPercent < 0,
  });

  const badges: AccrualPdfModel["badges"] = [];
  if (s.preliminary) badges.push({ text: "ПРЕДВАРИТЕЛЬНЫЙ РЕЗУЛЬТАТ · СЕБЕСТОИМОСТЬ НЕПОЛНАЯ", tone: "warn" });
  if (!s.period.periodComplete) badges.push({ text: "НЕПОЛНЫЙ МЕСЯЦ", tone: "warn" });

  const heroLabel = s.preliminary
    ? netPositive
      ? "ПРЕДВАРИТЕЛЬНАЯ ПРИБЫЛЬ"
      : "ПРЕДВАРИТЕЛЬНЫЙ УБЫТОК"
    : netPositive
    ? "ИТОГОВАЯ ЧИСТАЯ ПРИБЫЛЬ"
    : "ЧИСТЫЙ УБЫТОК";

  return {
    fileName: `mprof-accrual-report-${s.period.month}.pdf`,
    dateStr,
    title: "ОТЧЁТ ПО НАЧИСЛЕНИЯМ OZON",
    periodLine: `${accrualPeriodLabel(s)} · ${accrualPeriodRange(s)}`,
    badges,
    hero: {
      label: heroLabel,
      value: fmtSignedRub(s.netProfitKopecks),
      positive: netPositive,
      caption: s.preliminary
        ? "Себестоимость указана не для всех товаров — результат предварительный"
        : netPositive
        ? "Расчёт по отчёту начислений Ozon за период"
        : "Расчёт показывает убыток — проверьте себестоимость и расходы",
      stats: [
        {
          label: "МАРЖИНАЛЬНОСТЬ",
          value: fmtPercent(s.marginPercent),
          neg: s.marginPercent !== null && s.marginPercent < 0,
        },
        { label: "ROI", value: fmtPercent(roi), neg: roi !== null && roi < 0 },
      ],
    },
    breakdownTitle: "РАЗБИВКА РАСЧЁТА",
    rows,
    coverageLine,
    keyProducts: kp.best
      ? {
          best: toPdf(kp.best),
          worst: kp.worst ? toPdf(kp.worst) : null,
          worstTitle: salesBasis ? "САМЫЙ УБЫТОЧНЫЙ ПО ПРОДАЖАМ" : "САМЫЙ УБЫТОЧНЫЙ (ПОЛНАЯ ПРИБЫЛЬ)",
          worstProfitLabel: salesBasis ? "ПРИБЫЛЬ ОТ ПРОДАЖ" : "ЧИСТАЯ ПРИБЫЛЬ",
          worstMarginLabel: salesBasis ? "МАРЖА ПРОДАЖ" : "МАРЖА",
          worstEmptyText: salesBasis ? "Убыточных продаж не найдено" : "Убыточных товаров не найдено",
        }
      : null,
    splitTitle: "РЕЗУЛЬТАТ ТОВАРОВ ПО ЧАСТЯМ",
    splitLines,
    noticesTitle: "ПРЕДУПРЕЖДЕНИЯ",
    notices: accrualNotices(s).map((n) => n.text),
    explanationsTitle: "КАК СЧИТАЕМ",
    explanations: [
      ...accrualExplanations(s),
      ...(s.marginPercent === null ||
      (kp.best && kp.best.marginPercent === null) ||
      (kp.worst && kp.worst.marginPercent === null)
        ? ["«—» в марже: выручка ≤ 0, маржа не определяется."]
        : []),
    ],
    footer: `Сформировано сервисом M-Prof · ${accrualProfitLabel(s).toLowerCase()} по отчёту начислений Ozon`,
  };
}
