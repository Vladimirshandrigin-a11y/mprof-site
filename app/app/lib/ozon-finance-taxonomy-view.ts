// ============================================================================
// Pure client-safe парсер снапшота ai_insights.financeTaxonomy (PR B).
//
// Классификатор бэкенда (PR A, taxonomy.ts) кладёт в ai_insights.financeTaxonomy
// signed-разбивку операций Ozon (логистика/реклама/корректировки) + gross
// charges/credits. Этот модуль ТОЛЬКО читает и валидирует снапшот, чтобы история/
// отчёты честно показали расходы и отдельную строку доходов-компенсаций, НИЧЕГО
// не пересчитывая: единственный источник итогов — stored total_expenses/profit.
//
// БЕЗОПАСНОСТЬ: не доверяет произвольному JSON, не бросает исключений, не мутирует
// вход, не делает fetch/DB, не импортирует server-only модули. Любая проблема →
// null → вызывающий использует старый flat-fallback. Старые/неизвестные версии
// классификатора → null.
// ============================================================================

/** Единственная поддерживаемая версия классификатора (PR A). */
export const SUPPORTED_TAXONOMY_VERSION = "ozon-v3-finance-taxonomy-2026-06-v1";

/** Допуск на накопленное округление round2 (₽). */
const RECON_TOLERANCE = 0.05;
/** Допуск на равенства внутри снапшота (signedTotal, combined logistics). */
const EXACT_TOLERANCE = 0.01;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** number только если конечное число, иначе null (строка/NaN/Infinity/undefined). */
function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

type Breakdown = { signedTotal: number; charges: number; credits: number };

/** Валидирует один gross-блок: charges/credits ≥ 0 и signedTotal === credits − charges. */
function parseBreakdown(o: unknown): Breakdown | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const signedTotal = num(r.signedTotal);
  const charges = num(r.charges);
  const credits = num(r.credits);
  if (signedTotal === null || charges === null || credits === null) return null;
  if (charges < 0 || credits < 0) return null;
  if (Math.abs(signedTotal - (credits - charges)) > EXACT_TOLERANCE) return null;
  return { signedTotal, charges, credits };
}

/** Flat-колонки записи (положительные расходы) + stored total_expenses — для сверки. */
export type FlatContext = {
  commission: number;
  logistics: number;
  ads: number;
  storage: number;
  other: number;
  cost: number;
  tax: number;
  totalExpenses: number;
};

/** Провалидированная честная разбивка для UI (всё в ₽, расходы положительные). */
export type OzonTaxonomyView = {
  /** Логистика (gross charges). */
  logisticsCharges: number;
  /** Реклама и продвижение (gross charges). */
  adsCharges: number;
  /** Прочие расходы Ozon = charges(adjustments + remainingServices + remainingOther). */
  otherCharges: number;
  /** Хранение (flat storage). */
  storage: number;
  /** Корректировки и компенсации Ozon = сумма credits всех пяти категорий (доход). */
  ozonIncome: number;
  /** Чистые расходы Ozon по taxonomy: charges(log+ads+other)+storage − income. */
  taxonomyNetOzonExpenses: number;
};

/**
 * Разобрать и провалидировать ai_insights.financeTaxonomy. Возвращает null при
 * любой проблеме (нет снапшота / чужая версия / нечисло / нарушен инвариант /
 * не сходится сверка) — вызывающий тогда использует старый flat-fallback.
 *
 * Сверка (обе стороны обязаны совпасть в пределах допуска):
 *   taxonomyNetOzonExpenses ≈ flat(logistics + ads + storage + other)
 *   commission + taxonomyNetOzonExpenses + cost + tax ≈ stored total_expenses
 */
export function parseOzonFinanceTaxonomy(
  aiInsights: unknown,
  flat: FlatContext
): OzonTaxonomyView | null {
  if (!aiInsights || typeof aiInsights !== "object") return null;
  const ins = aiInsights as Record<string, unknown>;
  const ft = ins.financeTaxonomy;
  if (!ft || typeof ft !== "object") return null;
  const f = ft as Record<string, unknown>;

  // Только поддерживаемая версия — иначе безопасный flat-fallback.
  if (f.classifierVersion !== SUPPORTED_TAXONOMY_VERSION) return null;

  // combined logistics === logisticsLegacy + logisticsServices.
  const logistics = num(f.logistics);
  const logisticsLegacy = num(f.logisticsLegacy);
  const logisticsServices = num(f.logisticsServices);
  if (logistics === null || logisticsLegacy === null || logisticsServices === null) {
    return null;
  }
  if (Math.abs(logistics - (logisticsLegacy + logisticsServices)) > EXACT_TOLERANCE) {
    return null;
  }

  const br = f.breakdown;
  if (!br || typeof br !== "object") return null;
  const b = br as Record<string, unknown>;
  const bLog = parseBreakdown(b.logistics);
  const bAds = parseBreakdown(b.ads);
  const bAdj = parseBreakdown(b.adjustments);
  const bRS = parseBreakdown(b.remainingServices);
  const bRO = parseBreakdown(b.remainingOther);
  if (!bLog || !bAds || !bAdj || !bRS || !bRO) return null;

  const logisticsCharges = bLog.charges;
  const adsCharges = bAds.charges;
  const otherCharges = round2(bAdj.charges + bRS.charges + bRO.charges);
  // Доход — сумма credits ВСЕХ пяти категорий (в т.ч. возможные рефанды логистики/
  // рекламы), чтобы при вычитании сойтись с flat-логистикой/рекламой (которые уже
  // нетто). Двойного счёта нет: расходные строки берут charges, а не flat-нетто.
  const ozonIncome = round2(
    bLog.credits + bAds.credits + bAdj.credits + bRS.credits + bRO.credits
  );
  const storage = flat.storage;
  const taxonomyNetOzonExpenses = round2(
    logisticsCharges + adsCharges + otherCharges + storage - ozonIncome
  );

  // Сверка 1: taxonomy net == flat Ozon-классификация (logistics+ads+storage+other).
  const flatOzonExpenses = round2(
    flat.logistics + flat.ads + flat.storage + flat.other
  );
  if (Math.abs(taxonomyNetOzonExpenses - flatOzonExpenses) > RECON_TOLERANCE) {
    return null;
  }

  // Сверка 2: commission + taxonomyNet + cost + tax == stored total_expenses.
  const reconTotal = round2(
    flat.commission + taxonomyNetOzonExpenses + flat.cost + flat.tax
  );
  if (Math.abs(reconTotal - flat.totalExpenses) > RECON_TOLERANCE) {
    return null;
  }

  return {
    logisticsCharges,
    adsCharges,
    otherCharges,
    storage,
    ozonIncome,
    taxonomyNetOzonExpenses,
  };
}
