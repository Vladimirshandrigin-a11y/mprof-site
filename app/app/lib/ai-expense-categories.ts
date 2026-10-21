/** Saved expense columns, before preparing the AI request. */
interface AiExpenseRecord {
  commission: number;
  logistics: number;
  aiInsights?: unknown;
}

interface AiExpenseCategories {
  commission: number;
  logistics: number;
  updServices: number;
  updAgentFee: number;
}

/**
 * Legacy document calculations store UPD services in commission and the agent
 * fee in logistics. Classify those amounts for AI only, across the full selected
 * history. Never infer a split inside UPD services or recalculate profit.
 */
export function aggregateAiExpenseCategories(history: readonly AiExpenseRecord[]) {
  return history.reduce<AiExpenseCategories>(
    (totals, row) => {
      const commission = Number(row.commission) || 0;
      const logistics = Number(row.logistics) || 0;
      const insights = row.aiInsights;
      const legacyUpd = !!insights && typeof insights === "object" &&
        (insights as Record<string, unknown>).kind === "net-profit-3file";
      if (legacyUpd) {
        totals.updServices += commission;
        totals.updAgentFee += logistics;
      } else {
        totals.commission += commission;
        totals.logistics += logistics;
      }
      return totals;
    },
    { commission: 0, logistics: 0, updServices: 0, updAgentFee: 0 }
  );
}
