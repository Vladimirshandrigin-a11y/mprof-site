// ============================================================================
// Возврат из ЮKassa на /app?payment=return — проверка статуса доступа (только
// клиент, без React). Платёж здесь НЕ создаётся и расчёты НЕ списываются: права
// перечитываются тем же безопасным механизмом, что и кнопка «Проверить доступ»
// (useEntitlements.recheck — профиль и число разовых расчётов через cloud-proxy).
//
// Параметр payment=return НЕ доказывает оплату: его ставит return_url платежа при
// любом исходе. «Оплата подтверждена» показываем только когда доступ ВЫРОС
// относительно снимка «до оплаты»:
//   • срок безлимита (premium_until) стал позже — webhook выдаёт +30 дней, срок
//     только растёт;
//   • число оплаченных разовых расчётов (active single) стало больше — оно тоже
//     только растёт (израсходованный расчёт учитывается в calculations_used).
// Снимок «до оплаты» — из sessionStorage (сохраняется, пока открыто окно оплаты в
// /app); если его нет (оплата начата с главной, другой вкладки и т. п.) — первое
// полное чтение прав после возврата. Тогда доступ, выданный ещё до загрузки
// страницы, ростом не считается: показываем нейтральное «может ещё обрабатываться».
//
// Проверка конечна: PAYMENT_RECHECK_DELAYS_MS (~30 с), затем «Проверить снова»
// запускает ещё один такой же круг. Повторный запуск во время круга игнорируется.
// ============================================================================

/** Служебные параметры return_url платежа (app/api/payment/create/route.ts). */
export const PAYMENT_RETURN_PARAM = "payment";
export const PAYMENT_RETURN_VALUE = "return";
const PAYMENT_RETURN_EXTRA_PARAMS = ["sub"] as const;

/** Ключ sessionStorage для снимка прав «до оплаты». */
export const PAYMENT_BASELINE_KEY = "mprof_payment_baseline";
/** Снимок старше этого срока не используем. */
export const PAYMENT_BASELINE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Паузы перед каждой перечиткой прав, мс (сумма ≈ 30 с). */
export const PAYMENT_RECHECK_DELAYS_MS: readonly number[] = [0, 2000, 3000, 5000, 5000, 5000, 10000];

export interface AccessSnapshot {
  hasPremium: boolean;
  premiumUntil: string | null;
  singleCredits: number;
}

/** Текущие права страницы; complete=false — последняя перечитка не удалась. */
export interface EntitlementsReading extends AccessSnapshot {
  complete: boolean;
}

/** Что именно выросло: безлимит или разовые расчёты. */
export type AccessGrowth = "unlimited" | "single";

export type PaymentReturnPhase = "checking" | "confirmed" | "pending" | "failed";

export function isPaymentReturn(search: string): boolean {
  try {
    return new URLSearchParams(search).get(PAYMENT_RETURN_PARAM) === PAYMENT_RETURN_VALUE;
  } catch {
    return false;
  }
}

/**
 * Адрес без служебных параметров возврата (path + query + hash) или null, если
 * убирать нечего. Остальные параметры и hash сохраняются как были.
 */
export function stripPaymentReturnParams(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.searchParams.get(PAYMENT_RETURN_PARAM) !== PAYMENT_RETURN_VALUE) return null;
  url.searchParams.delete(PAYMENT_RETURN_PARAM);
  for (const p of PAYMENT_RETURN_EXTRA_PARAMS) url.searchParams.delete(p);
  const query = url.searchParams.toString();
  return url.pathname + (query ? `?${query}` : "") + url.hash;
}

function untilMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Вырос ли доступ относительно снимка «до оплаты»; null — не вырос. */
export function accessGrowth(before: AccessSnapshot, now: AccessSnapshot): AccessGrowth | null {
  if (now.hasPremium && untilMs(now.premiumUntil) > untilMs(before.premiumUntil)) return "unlimited";
  if (now.singleCredits > before.singleCredits) return "single";
  return null;
}

export function serializeBaseline(userId: string, snap: AccessSnapshot, savedAt: number): string {
  return JSON.stringify({
    v: 1,
    userId,
    savedAt,
    hasPremium: snap.hasPremium,
    premiumUntil: snap.premiumUntil,
    singleCredits: snap.singleCredits,
  });
}

/** Снимок «до оплаты» этого пользователя, не старше maxAgeMs; иначе null. */
export function parseBaseline(
  raw: string | null,
  userId: string,
  now: number,
  maxAgeMs: number = PAYMENT_BASELINE_MAX_AGE_MS
): AccessSnapshot | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || r.userId !== userId) return null;
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt)) return null;
  if (r.savedAt > now || now - r.savedAt > maxAgeMs) return null;
  if (typeof r.hasPremium !== "boolean") return null;
  if (r.premiumUntil !== null && typeof r.premiumUntil !== "string") return null;
  if (typeof r.singleCredits !== "number" || !Number.isInteger(r.singleCredits) || r.singleCredits < 0) return null;
  return { hasPremium: r.hasPremium, premiumUntil: r.premiumUntil, singleCredits: r.singleCredits };
}

export interface PaymentReturnDeps {
  /** Перечитать права (useEntitlements.recheck). */
  recheck: () => Promise<void>;
  /** Права страницы после применения перечитки. */
  read: () => EntitlementsReading;
  /** Дождаться, пока страница применит результат перечитки. */
  settle: () => Promise<void>;
  /** Пауза; при отмене обязана завершиться без ожидания. */
  sleep: (ms: number) => Promise<void>;
  onPhase: (phase: PaymentReturnPhase, growth: AccessGrowth | null) => void;
  delays?: readonly number[];
}

export interface PaymentReturnCheck {
  /** Запустить круг проверки. false — круг уже идёт или проверка остановлена. */
  run(baseline: AccessSnapshot | null): boolean;
  /** Остановить навсегда (размонтирование, «Скрыть»). */
  dispose(): void;
  readonly running: boolean;
}

export function createPaymentReturnCheck(deps: PaymentReturnDeps): PaymentReturnCheck {
  const delays = deps.delays ?? PAYMENT_RECHECK_DELAYS_MS;
  let disposed = false;
  let running = false;
  // Снимок «до оплаты» переживает «Проверить снова».
  let base: AccessSnapshot | null = null;

  type Outcome = { phase: Exclude<PaymentReturnPhase, "checking">; growth: AccessGrowth | null } | null;

  const loop = async (): Promise<Outcome> => {
    let anyComplete = false;
    for (const ms of delays) {
      await deps.sleep(ms);
      if (disposed) return null;
      await deps.recheck();
      await deps.settle();
      if (disposed) return null;
      const r = deps.read();
      if (!r.complete) continue;
      anyComplete = true;
      const snap: AccessSnapshot = {
        hasPremium: r.hasPremium,
        premiumUntil: r.premiumUntil,
        singleCredits: r.singleCredits,
      };
      if (!base) {
        base = snap;
        continue;
      }
      const growth = accessGrowth(base, snap);
      if (growth) return { phase: "confirmed", growth };
    }
    return { phase: anyComplete ? "pending" : "failed", growth: null };
  };

  return {
    run(baseline) {
      if (disposed || running) return false;
      if (!base && baseline) base = baseline;
      running = true;
      deps.onPhase("checking", null);
      void loop()
        .catch((): Outcome => ({ phase: "failed", growth: null }))
        .then((outcome) => {
          // Круг закончен ДО сообщения об итоге: «Проверить снова» сразу доступна.
          running = false;
          if (outcome && !disposed) deps.onPhase(outcome.phase, outcome.growth);
        });
      return true;
    },
    dispose() {
      disposed = true;
    },
    get running() {
      return running;
    },
  };
}
