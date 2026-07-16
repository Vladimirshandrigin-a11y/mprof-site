// ============================================================================
// Точная таксономия финансовых операций Ozon (PR A). ТОЛЬКО сервер, ЧИСТЫЙ модуль.
//
// Классификация для ФИНАНСОВОГО СОХРАНЕНИЯ выполняется ИСКЛЮЧИТЕЛЬНО по точным
// техническим идентификаторам Ozon (operation_type / services[].name). Никаких
// regex, substring, русских display-имён или keyword-fallback здесь НЕТ — они
// заведомо ненадёжны для денег. Неизвестное остаётся в существующих services/other.
//
// Наборы подтверждены реальным ответом /v3/finance/transaction/list за июнь 2026
// (см. диагностику finance-taxonomy-diagnostic). Версия классификатора вшита в
// снапшот, чтобы будущие изменения набора были прослеживаемы.
// ============================================================================

/** Версия классификатора — сохраняется в снапшот ai_insights. */
export const OZON_TAXONOMY_VERSION = "ozon-v3-finance-taxonomy-2026-06-v1";

/**
 * ЛОГИСТИКА — точные имена services[].name (service-level). Классифицируем ТОЛЬКО
 * саму service-строку (её signed price), а НЕ полный amount операции-носителя.
 */
export const LOGISTICS_SERVICE_NAMES: ReadonlySet<string> = new Set([
  "MarketplaceServiceItemDirectFlowLogistic",
  "MarketplaceServiceItemReturnFlowLogistic",
  "MarketplaceServiceItemRedistributionDropOffApvz",
  "MarketplaceServiceItemRedistributionLastMileCourier",
  "MarketplaceServiceItemDropoffPVZ",
  "MarketplaceServiceItemDeliveryToHandoverPlaceOzon",
  "MarketplaceServiceItemRedistributionReturnsPVZ",
]);

/**
 * РЕКЛАМА И ПРОДВИЖЕНИЕ — точные operation_type (operation-level). Классифицируем
 * ТОЛЬКО residual операции (amount − распознанные компоненты), а не полный amount.
 */
export const ADS_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "OperationPromotionWithCostPerOrder",
  "OperationMarketplaceCostPerClick",
  "OperationMarketplaceAcceleratedProductReviews",
]);

/**
 * КОРРЕКТИРОВКИ / КОМПЕНСАЦИИ — точные operation_type. Обычно ПОЛОЖИТЕЛЬНЫЕ
 * начисления (доход), классифицируем по residual. AccrualInternalClaim («Потеря
 * по вине Ozon в логистике») — это КОМПЕНСАЦИЯ, а НЕ логистический расход.
 */
export const ADJUSTMENT_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "AccrualWithoutDocs",
  "AccrualInternalClaim",
  "MarketplaceSellerCorrectionOperation",
]);

/** Точная логистическая service-строка? (по exact name, без substring). */
export function isLogisticsServiceName(name: string): boolean {
  return LOGISTICS_SERVICE_NAMES.has(name);
}

/**
 * Классификация RESIDUAL операции по точному operation_type.
 *   • ads        — реклама/продвижение;
 *   • adjustment — корректировка/компенсация;
 *   • other      — неизвестное (остаётся в «Прочие», как и раньше).
 * Никогда не переносит полный amount операции — вызывающий передаёт ТОЛЬКО residual.
 */
export function classifyOperationResidual(
  operationType: string
): "ads" | "adjustment" | "other" {
  if (ADS_OPERATION_TYPES.has(operationType)) return "ads";
  if (ADJUSTMENT_OPERATION_TYPES.has(operationType)) return "adjustment";
  return "other";
}

// ---------------------------------------------------------------------------
// Signed breakdown: charges (списания) и credits (начисления) по каждой корзине.
//
// charges/credits НАКАПЛИВАЮТСЯ из ОТДЕЛЬНЫХ signed-значений при обработке, их
// НЕЛЬЗЯ восстанавливать из уже netted signedTotal (иначе gross-разбивка теряется).
//   charges — положительное абсолютное значение суммы отрицательных строк;
//   credits — положительная сумма положительных строк.
// Инвариант: signedTotal === credits − charges.
// ---------------------------------------------------------------------------

/** Аккумулятор gross charges/credits (raw, до округления). */
export type ChargeCreditAcc = { charges: number; credits: number };

export function emptyChargeCredit(): ChargeCreditAcc {
  return { charges: 0, credits: 0 };
}

/** Накопить одно signed-значение: >0 → credits, <0 → charges (как |value|). Мутирует acc. */
export function accumulateSigned(acc: ChargeCreditAcc, value: number): void {
  if (value > 0) acc.credits += value;
  else if (value < 0) acc.charges += -value;
}
