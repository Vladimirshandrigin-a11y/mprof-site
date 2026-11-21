export function extractReportMonthFromText(
  text: string | null | undefined
): string | null {
  if (!text) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = text.toLowerCase();
  // Собрать 'YYYY-MM-01' с валидацией номера месяца (отсекает мусор вроде 99).
  const mk = (year: string, month: number): string | null =>
    month >= 1 && month <= 12 ? `${year}-${pad(month)}-01` : null;

  // 1) Диапазон ДД.ММ.ГГГГ … ДД.ММ.ГГГГ → месяц КОНЕЧНОЙ даты (группы 4,5,6).
  const range = p.match(
    /(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\s*(?:-|—|–|по|до|to)\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/
  );
  if (range) {
    const res = mk(range[6], Number(range[5]));
    if (res) return res;
  }

  // 2) Компактный YYYYMMDD (в т.ч. в имени файла «_20260430.xlsx»).
  const compact = p.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) {
    const res = mk(compact[1], Number(compact[2]));
    if (res) return res;
  }

  // 3) ISO — год впереди: 2026-04-30 / 2026/04 / 2026.04.
  const iso = p.match(/(20\d{2})[-./](\d{1,2})/);
  if (iso) {
    const res = mk(iso[1], Number(iso[2]));
    if (res) return res;
  }

  // 4) Одиночная ДД.ММ.ГГГГ — день впереди: 30.04.2026.
  const dmy = p.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/);
  if (dmy) {
    const res = mk(dmy[3], Number(dmy[2]));
    if (res) return res;
  }

  // 5) Русские месяцы (порядок основ важен: специфичные раньше короткой «ма»).
  const MONTHS = [
    "январ", "феврал", "март", "апрел", "ма", "июн", "июл",
    "август", "сентябр", "октябр", "ноябр", "декабр",
  ];
  const yearM = p.match(/20\d{2}/);
  if (yearM) {
    for (let i = 0; i < MONTHS.length; i++) {
      if (p.includes(MONTHS[i])) return mk(yearM[0], i + 1);
    }
  }

  return null;
}
