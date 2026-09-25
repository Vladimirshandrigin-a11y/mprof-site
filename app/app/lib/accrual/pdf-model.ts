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
  accrualSnapshotRoi,
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
  keyProducts: { best: PdfKeyProduct; worst: PdfKeyProduct | null } | null;
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
    keyProducts: kp.best ? { best: toPdf(kp.best), worst: kp.worst ? toPdf(kp.worst) : null } : null,
    noticesTitle: "ПРЕДУПРЕЖДЕНИЯ",
    notices: accrualNotices(s).map((n) => n.text),
    explanationsTitle: "КАК СЧИТАЕМ",
    explanations: accrualExplanations(s),
    footer: `Сформировано сервисом M-Prof · ${accrualProfitLabel(s).toLowerCase()} по отчёту начислений Ozon`,
  };
}
