// ============================================================================
// Статус доступа к расчётам для «Личного кабинета» — ТОЛЬКО отображение прав,
// уже посчитанных useEntitlements (entitlements.ts). Серверные права, consume,
// цены, срок тарифов и подсчёт кредитов здесь не меняются.
//
// Модель (та же, что у consume_calculation): доступно = 1 бесплатный + число
// активных разовых кредитов − израсходовано; активный безлимит — без ограничений.
// Приоритет показа: загрузка прав → активный безлимит → доступные расчёты
// (первый бесплатный и/или разовые) → «Нет доступных расчётов».
// ============================================================================

export type AccessKind = "loading" | "unlimited" | "free" | "free_and_credits" | "credits" | "none";

export interface AccessStatusInput {
  /** Права загружены (до этого ничего не утверждаем, в том числе «нет расчётов»). */
  loaded: boolean;
  hasPremium: boolean;
  /** profiles.premium_until (ISO) — у активного и у закончившегося безлимита. */
  premiumUntil: string | null;
  /** Израсходовано расчётов (profiles.calculations_used). */
  calcCount: number;
  freeLimit: number;
  /** Активные разовые кредиты (оплаченные расчёты по 149 ₽). */
  singleCredits: number;
  /** Текущее время, мс (для проверки окончания безлимита). */
  now?: number;
}

export interface AccessStatus {
  kind: AccessKind;
  /** «Текущий тариф» и заголовок карточки тарифа. */
  planLabel: string;
  /** Короткая метка рядом с заголовком. */
  badge: string;
  /** Строка «Доступно расчётов». */
  available: string;
  /** Пояснение под статусом (без даты безлимита — её форматирует страница). */
  detail: string;
  /** Сколько расчётов доступно (для безлимита — null: без ограничений). */
  remaining: number | null;
  /** Безлимит закончился: ISO-дата окончания, иначе null. */
  expiredUntil: string | null;
}

const pl = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export function accessStatus(i: AccessStatusInput): AccessStatus {
  if (!i.loaded) {
    return {
      kind: "loading",
      planLabel: "…",
      badge: "…",
      available: "…",
      detail: "Загружаем данные тарифа…",
      remaining: null,
      expiredUntil: null,
    };
  }
  if (i.hasPremium) {
    return {
      kind: "unlimited",
      planLabel: "Безлимит",
      badge: "Активно",
      available: "Без ограничений",
      detail: "Неограниченное количество расчётов всеми способами, включая Ozon API.",
      remaining: null,
      expiredUntil: null,
    };
  }

  const now = i.now ?? Date.now();
  const untilMs = i.premiumUntil ? Date.parse(i.premiumUntil) : NaN;
  const expiredUntil = Number.isFinite(untilMs) && untilMs <= now ? i.premiumUntil : null;

  const used = Math.max(0, i.calcCount);
  const credits = Math.max(0, i.singleCredits);
  const remaining = Math.max(0, i.freeLimit + credits - used);
  const freeLeft = Math.min(remaining, Math.max(0, i.freeLimit - used));
  const creditsLeft = remaining - freeLeft;

  if (freeLeft > 0 && creditsLeft === 0) {
    return {
      kind: "free",
      planLabel: "Бесплатный расчёт",
      badge: "Бесплатно",
      available: "1 бесплатный",
      detail: "Доступен первый бесплатный расчёт — любым способом: XLSX «Отчёт по начислениям», вручную или по Ozon API.",
      remaining,
      expiredUntil,
    };
  }
  if (freeLeft > 0) {
    return {
      kind: "free_and_credits",
      planLabel: "Бесплатный и разовые расчёты",
      badge: "Доступно",
      available: `${remaining} (${freeLeft} бесплатный и ${creditsLeft} ${pl(creditsLeft, "разовый", "разовых", "разовых")})`,
      detail: `Доступно расчётов: ${remaining}. Первый бесплатный — любым способом, включая Ozon API; разовые — по XLSX «Отчёт по начислениям» или вручную, без Ozon API.`,
      remaining,
      expiredUntil,
    };
  }
  if (creditsLeft > 0) {
    return {
      kind: "credits",
      planLabel: "Разовые расчёты",
      badge: "Разовые",
      available: String(creditsLeft),
      detail: `Доступно ${creditsLeft} ${pl(creditsLeft, "разовый расчёт", "разовых расчёта", "разовых расчётов")} — по XLSX «Отчёт по начислениям» или вручную, без Ozon API.`,
      remaining,
      expiredUntil,
    };
  }
  return {
    kind: "none",
    planLabel: "Нет доступных расчётов",
    badge: "Нет расчётов",
    available: "0",
    detail:
      credits > 0
        ? "Бесплатный расчёт и оплаченные разовые расчёты использованы — оформите тариф ниже."
        : "Бесплатный расчёт использован — оформите тариф ниже.",
    remaining: 0,
    expiredUntil,
  };
}
