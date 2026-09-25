// ============================================================================
// Деньги в ЦЕЛЫХ КОПЕЙКАХ + точное распределение суммы методом наибольших
// остатков. Чистые функции без зависимостей — общий фундамент расчёта по
// «Отчёту по начислениям» (парсер, классификатор, формула, товарная аналитика).
//
// Все суммы внутри расчёта — целые копейки (number, safe integer): сложение
// целых не накапливает ошибку double, поэтому «до копейки» проверяется точным
// равенством, а не допуском.
// ============================================================================

/** Рубли → копейки, если число выражается целыми копейками (в пределах допуска). */
export interface KopecksParse {
  kopecks: number;
  /** false — в числе были доли копейки (округлено к ближайшей копейке). */
  exact: boolean;
}

/** Допуск «число — целые копейки»: доли копейки меньше 1% копейки — шум double. */
const KOPECK_EPSILON = 0.01;
/** Защита от мусора (1e11 ₽ — заведомо нереальная сумма отчёта). */
const MAX_ABS_RUB = 1e11;

/** Число рублей → целые копейки. null — не конечное число / нереальная величина. */
export function rublesToKopecks(rub: number): KopecksParse | null {
  if (typeof rub !== "number" || !Number.isFinite(rub)) return null;
  if (Math.abs(rub) > MAX_ABS_RUB) return null;
  const scaled = rub * 100;
  const rounded = Math.round(scaled);
  return {
    kopecks: rounded + 0, // + 0: нормализует -0 → 0
    exact: Math.abs(scaled - rounded) < KOPECK_EPSILON,
  };
}

/**
 * Текст суммы → целые копейки. Принимает «−379,04», «1 234,56», «1234.5»
 * (пробелы/nbsp как разделители тысяч, запятая или точка — десятичный
 * разделитель, знак `-`/`−`/`+`). Всё остальное — null (НЕ ноль).
 */
export function parseMoneyText(text: string): KopecksParse | null {
  const s = text.replace(/ /g, " ").trim().replace(/^−/, "-");
  if (s === "") return null;
  const m = /^([+-])?\s*(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2].replace(/ /g, "");
  const frac = m[3] ?? "";
  const asNumber = Number(`${intPart}${frac ? "." + frac : ""}`);
  if (!Number.isFinite(asNumber) || asNumber > MAX_ABS_RUB) return null;
  // Целые копейки из ДЕСЯТИЧНЫХ ЦИФР (без double): int*100 + первые 2 цифры доли.
  const frac2 = (frac + "00").slice(0, 2);
  let kop = Number(intPart) * 100 + Number(frac2);
  // Остаток доли (после 2 цифр): только нули — точно; иначе округляем half-up.
  const rest = frac.slice(2);
  let exact = true;
  if (/[^0]/.test(rest)) {
    exact = false;
    if (rest.charCodeAt(0) >= 53 /* '5' */) kop += 1;
  }
  return { kopecks: sign * kop + 0, exact };
}

/** Копейки → рубли для отображения/совместимых интерфейсов (k/100). */
export function kopecksToRub(kopecks: number): number {
  return kopecks / 100 + 0;
}

/** round-half-up для НЕОТРИЦАТЕЛЬНОГО num/den (целые, den > 0). */
function roundHalfUpDiv(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den));
}

/**
 * Процент от суммы в копейках: round-half-up(base × percent / 100), где percent
 * задан целыми сотыми долями процента (bp: 7% → 700). base ≥ 0.
 */
export function percentOfKopecks(baseKopecks: number, percentBp: number): number {
  return roundHalfUpDiv(baseKopecks * percentBp, 10000);
}

/** Ставка в процентах → целые сотые доли процента. null — не более 2 знаков. */
export function percentToBasisPoints(percent: number): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const scaled = percent * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
}

/** Процентное отношение (2 знака), null при невозможности вычислить. */
export function ratioPercent(numeratorKop: number, denominatorKop: number): number | null {
  if (!Number.isFinite(numeratorKop) || !Number.isFinite(denominatorKop)) return null;
  if (denominatorKop <= 0) return null;
  return Math.round((numeratorKop * 10000) / denominatorKop) / 100 + 0;
}

function floorDivBig(a: bigint, b: bigint): bigint {
  // b > 0. BigInt-деление усекает к нулю — для отрицательных a поправляем вниз.
  const q = a / b;
  return a % b !== BigInt(0) && a < BigInt(0) ? q - BigInt(1) : q;
}

/**
 * Точное распределение total (целые копейки, ЛЮБОГО знака) по весам методом
 * наибольших остатков: Σ результата === total РОВНО (никакой «поправки»
 * отдельной строкой — остаток копеек раздаётся самим товарам).
 *
 *  • weights — неотрицательные целые (например, копейки положительной базы);
 *  • tieKeys — детерминированный порядок при равных остатках (по возрастанию);
 *  • товары с нулевым весом не получают ничего (их остаток равен 0);
 *  • Σ weights === 0 → null (распределять не на что).
 */
export function allocateLargestRemainder(
  total: number,
  weights: readonly number[],
  tieKeys: readonly string[]
): number[] | null {
  const n = weights.length;
  if (n === 0) return null;
  let sumW = BigInt(0);
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) return null;
    sumW += BigInt(w);
  }
  if (sumW === BigInt(0)) return null;
  if (!Number.isSafeInteger(total)) return null;

  const T = BigInt(total);
  const base: bigint[] = new Array(n);
  const rem: bigint[] = new Array(n);
  let allocated = BigInt(0);
  for (let i = 0; i < n; i++) {
    const num = T * BigInt(weights[i]);
    const q = floorDivBig(num, sumW);
    base[i] = q;
    rem[i] = num - q * sumW; // 0 <= rem < sumW
    allocated += q;
  }
  const leftover = Number(T - allocated); // 0 <= leftover < n (Σrem = leftover × sumW)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    if (rem[a] !== rem[b]) return rem[a] > rem[b] ? -1 : 1;
    const ka = tieKeys[a] ?? "";
    const kb = tieKeys[b] ?? "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a - b;
  });
  for (let k = 0; k < leftover; k++) base[order[k]] += BigInt(1);
  return base.map((b) => Number(b) + 0);
}
