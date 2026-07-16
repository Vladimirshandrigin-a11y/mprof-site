// ============================================================================
// Pure client-safe парсер снапшота ai_insights.financeTaxonomy (PR B).
//
// Классификатор бэкенда (PR A, taxonomy.ts) кладёт в ai_insights.financeTaxonomy
// signed-разбивку операций Ozon (логистика/реклама/корректировки) + gross
// charges/credits. Этот модуль ТОЛЬКО читает и валидирует снапшот, чтобы история/
// отчёты честно показали расходы, отдельную строку доходов-компенсаций и
// дополнительные ручные расходы, НИЧЕГО не пересчитывая: единственный источник
// итогов — stored total_expenses/profit.
//
// Разделение обязанностей (для fail-closed guard и тестируемости):
//   • hasFinanceTaxonomyObject — есть ли объект financeTaxonomy (любой версии);
//   • parseFinanceTaxonomySnapshot — СТРУКТУРНАЯ проверка (shape/version/finite/
//     signedTotal/logistics identity), БЕЗ flat-reconciliation;
//   • buildOzonFinanceTaxonomyView — считает gross-строки, доход, taxonomyNet,
//     ДОПОЛНИТЕЛЬНЫЕ РУЧНЫЕ РАСХОДЫ (packaging/warehouse/salary/manual other,
//     сидящие в flat other) и сверяет со stored total_expenses.
//
// БЕЗОПАСНОСТЬ: не доверяет произвольному JSON, не бросает исключений, не мутирует
// вход, не делает fetch/DB, не импортирует server-only модули.
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

/** Пять gross-блоков снапшота (после структурной валидации). */
export type ParsedFinanceTaxonomy = {
  logistics: Breakdown;
  ads: Breakdown;
  adjustments: Breakdown;
  remainingServices: Breakdown;
  remainingOther: Breakdown;
};

/**
 * Есть ли в ai_insights объект financeTaxonomy (ЛЮБОЙ версии/валидности)?
 * Для fail-closed guard: наличие снапшота у API-расчёта = его нельзя безопасно
 * редактировать как ручной, независимо от reconciliation.
 */
export function hasFinanceTaxonomyObject(aiInsights: unknown): boolean {
  if (!aiInsights || typeof aiInsights !== "object") return false;
  const ft = (aiInsights as Record<string, unknown>).financeTaxonomy;
  return !!ft && typeof ft === "object" && !Array.isArray(ft);
}

/**
 * СТРУКТУРНАЯ проверка снапшота — БЕЗ сверки с flat-колонками. Возвращает пять
 * gross-блоков или null (нет объекта / чужая версия / нечисло / нарушен инвариант
 * shape). НЕ зависит от manual extra expenses.
 */
export function parseFinanceTaxonomySnapshot(
  aiInsights: unknown
): ParsedFinanceTaxonomy | null {
  if (!hasFinanceTaxonomyObject(aiInsights)) return null;
  const f = (aiInsights as Record<string, unknown>).financeTaxonomy as Record<
    string,
    unknown
  >;

  // Только поддерживаемая версия — иначе безопасный flat-fallback для ОТОБРАЖЕНИЯ.
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

  return {
    logistics: bLog,
    ads: bAds,
    adjustments: bAdj,
    remainingServices: bRS,
    remainingOther: bRO,
  };
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
  /** Дополнительные расходы (packaging/warehouse/salary/manual other из flat other). */
  manualExtraExpenses: number;
  /** Корректировки и компенсации Ozon = сумма credits всех пяти категорий (доход). */
  ozonIncome: number;
  /** Чистые расходы Ozon по taxonomy: charges(log+ads+other)+storage − income. */
  taxonomyNetOzonExpenses: number;
};

/**
 * Построить провалидированную view из СТРУКТУРНО разобранного снапшота + flat.
 * Возвращает null, если снапшот несовместим с flat-данными.
 *
 * ВАЖНО: flat `other` в API-расчёте содержит НЕ ТОЛЬКО остаток Ozon, но и
 * ДОПОЛНИТЕЛЬНЫЕ РУЧНЫЕ РАСХОДЫ (packaging/warehouseDelivery/salary/manual other),
 * которые save-calculation вычитает через netProfit → они оседают в otherExpensesCol.
 * Поэтому:
 *   manualExtraRaw = flat(logistics+ads+storage+other) − taxonomyNetOzonExpenses
 *   • manualExtraRaw ∈ [−0.05, 0]  → нормализуем в 0 (округление);
 *   • manualExtraRaw < −0.05       → taxonomy net > flat → снапшот несовместим → null;
 *   • manualExtraRaw ≥ 0           → это ручные доп-расходы, показываем отдельной строкой.
 * Полная сверка: commission + taxonomyNet + manualExtra + cost + tax ≈ total_expenses.
 */
export function buildOzonFinanceTaxonomyView(
  snapshot: ParsedFinanceTaxonomy,
  flat: FlatContext
): OzonTaxonomyView | null {
  const logisticsCharges = snapshot.logistics.charges;
  const adsCharges = snapshot.ads.charges;
  const otherCharges = round2(
    snapshot.adjustments.charges +
      snapshot.remainingServices.charges +
      snapshot.remainingOther.charges
  );
  // Доход — сумма credits ВСЕХ пяти категорий (в т.ч. рефанды логистики/рекламы),
  // чтобы при вычитании сойтись с flat-логистикой/рекламой (уже нетто). Двойного
  // счёта нет: расходные строки берут charges, а не flat-нетто.
  const ozonIncome = round2(
    snapshot.logistics.credits +
      snapshot.ads.credits +
      snapshot.adjustments.credits +
      snapshot.remainingServices.credits +
      snapshot.remainingOther.credits
  );
  const storage = flat.storage;
  const taxonomyNetOzonExpenses = round2(
    logisticsCharges + adsCharges + otherCharges + storage - ozonIncome
  );

  // Разница flat vs taxonomy net = дополнительные ручные расходы, сидящие в flat other.
  const flatOzonAndManual = round2(
    flat.logistics + flat.ads + flat.storage + flat.other
  );
  const manualExtraRaw = round2(flatOzonAndManual - taxonomyNetOzonExpenses);

  let manualExtraExpenses: number;
  if (manualExtraRaw < -RECON_TOLERANCE) {
    // taxonomy net превышает flat → снапшот несовместим с данными → flat fallback.
    return null;
  } else if (manualExtraRaw <= 0) {
    manualExtraExpenses = 0; // нормализуем маленький отрицательный (округление) в 0.
  } else {
    manualExtraExpenses = round2(manualExtraRaw);
  }

  // Полная сверка: расходы (Ozon net + ручные доп) + себестоимость + налог + комиссия
  // == stored total_expenses. Ловит рассинхрон flat-колонок и stored total.
  const reconTotal = round2(
    flat.commission +
      taxonomyNetOzonExpenses +
      manualExtraExpenses +
      flat.cost +
      flat.tax
  );
  if (Math.abs(reconTotal - flat.totalExpenses) > RECON_TOLERANCE) {
    return null;
  }

  return {
    logisticsCharges,
    adsCharges,
    otherCharges,
    storage,
    manualExtraExpenses,
    ozonIncome,
    taxonomyNetOzonExpenses,
  };
}

/**
 * Удобная обёртка: структурный разбор + построение view. Возвращает view или null.
 * (Для guard используйте hasFinanceTaxonomyObject/parseFinanceTaxonomySnapshot
 * отдельно — guard НЕ должен зависеть от reconciliation.)
 */
export function parseOzonFinanceTaxonomy(
  aiInsights: unknown,
  flat: FlatContext
): OzonTaxonomyView | null {
  const snapshot = parseFinanceTaxonomySnapshot(aiInsights);
  if (!snapshot) return null;
  return buildOzonFinanceTaxonomyView(snapshot, flat);
}
