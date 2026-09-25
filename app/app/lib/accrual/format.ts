// Форматирование денег/процентов/периодов для показа расчёта по «Отчёту по
// начислениям» (экран, история, PDF). Чистые функции; деньги — целые копейки.

const RU_MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** «1 234,56» из копеек (без знака и валюты). */
export function fmtAmount(kopecks: number, decimals: 0 | 2 = 2): string {
  const rub = Math.abs(kopecks) / 100;
  return rub.toLocaleString("ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** «−1 234,56 ₽» / «1 234,56 ₽» — знак только минус (U+2212). */
export function fmtRub(kopecks: number, decimals: 0 | 2 = 2): string {
  return (kopecks < 0 ? "−" : "") + fmtAmount(kopecks, decimals) + " ₽";
}

/** «+1 234,56 ₽» / «−1 234,56 ₽»; ноль — «0,00 ₽» без знака. */
export function fmtSignedRub(kopecks: number, decimals: 0 | 2 = 2): string {
  if (kopecks === 0) return fmtRub(0, decimals);
  return (kopecks > 0 ? "+" : "−") + fmtAmount(kopecks, decimals) + " ₽";
}

/** «22,8 %» с одним знаком; null/NaN → «—» (неопределимая маржа НЕ равна 0 %). */
export function fmtPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return (
    (value < 0 ? "−" : "") +
    Math.abs(value).toLocaleString("ru-RU", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) +
    " %"
  );
}

/** «YYYY-MM» → «Июнь 2026»; неожиданный формат — как есть. */
export function fmtMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = RU_MONTHS[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : month;
}

/** «YYYY-MM-DD» → «ДД.ММ.ГГГГ». */
export function fmtIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** «01.06.2026 — 30.06.2026». */
export function fmtDateRange(fromIso: string, toIso: string): string {
  return `${fmtIsoDate(fromIso)} — ${fmtIsoDate(toIso)}`;
}

/** Склонение: 1 товар / 2 товара / 5 товаров. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
