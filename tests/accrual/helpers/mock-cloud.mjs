// Мок «облака» для проверки границы списания и сохранения: считает ВСЕ побочные
// эффекты (consume, дубль-гард, insert/update calculations, report_history).
// Никакого Supabase/сети — только счётчики и память.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Мок прав пользователя по модели, описанной в app/lib/entitlements.ts (расчёты, не платежи):
 *   canCalculate = безлимит || израсходовано < 1 бесплатный + N кредитов (149 ₽ = +1);
 *   consume      = server-authoritative: безлимит — ok без счётчика; иначе ok и +1, пока есть остаток,
 *                  иначе { ok:false, reason:"limit_reached" }.
 * Реального RPC/Supabase здесь нет: мок лишь считает вызовы и остаток. Живых списаний нет.
 */
export function makeEntitlements({ used = 0, credits = 0, unlimited = false } = {}) {
  const st = { used, credits, unlimited, consumeCalls: 0, granted: 0, refused: 0 };
  return {
    st,
    canCalculate: () => st.unlimited || st.used < 1 + st.credits,
    consume: async () => {
      st.consumeCalls++;
      if (st.unlimited) {
        st.granted++;
        return { ok: true };
      }
      if (st.used < 1 + st.credits) {
        st.used++;
        st.granted++;
        return { ok: true };
      }
      st.refused++;
      return { ok: false, reason: "limit_reached" };
    },
  };
}

export function makeMockCloud(over = {}) {
  // inserts/updates/histories — только УСПЕШНЫЕ записи; *Try — все обращения, включая отказы.
  const log = { consume: 0, canCalc: 0, dup: 0, insertTry: 0, updateTry: 0, historyTry: 0, inserts: [], updates: [], histories: [] };
  const cfg = {
    consumeOk: true,
    canCalculate: true,
    dupAnswer: true,
    insertError: null,
    updateError: null,
    historyError: null,
    delayMs: 0,
    ...over,
  };
  let seq = 0;
  const rows = new Map(); // «таблица calculations»
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const deps = {
    canCalculate: () => {
      log.canCalc++;
      return cfg.entitlement ? cfg.entitlement.canCalculate() : cfg.canCalculate;
    },
    confirmNoMonthDuplicate: async (monthKey) => {
      log.dup++;
      log.lastDupMonth = monthKey;
      return cfg.dupAnswer;
    },
    consume: async () => {
      log.consume++;
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.entitlement) return cfg.entitlement.consume();
      return cfg.consumeOk ? { ok: true } : { ok: false, reason: "limit_reached" };
    },
    insertCalculation: async (cols) => {
      log.insertTry++;
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.insertError) return { data: null, error: { message: cfg.insertError } };
      const row = { id: `calc-${++seq}`, created_at: "2026-07-01T10:00:00.000Z" };
      rows.set(row.id, { ...row, ...clone(cols) });
      log.inserts.push(row.id);
      return { data: row, error: null };
    },
    updateCalculation: async (id, cols) => {
      log.updateTry++;
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.updateError) return { data: null, error: { message: cfg.updateError } };
      const prev = rows.get(id);
      if (!prev) return { data: null, error: { message: "row not found" } };
      rows.set(id, { ...prev, ...clone(cols) });
      log.updates.push(id);
      return { data: { id, created_at: prev.created_at }, error: null };
    },
    insertReportHistory: async (cols) => {
      log.historyTry++;
      if (cfg.historyError) return { data: null, error: { message: cfg.historyError } };
      log.histories.push(clone(cols));
      return { data: {}, error: null };
    },
    newLocalId: () => `local-${++seq}`,
    nowIso: () => "2026-07-01T10:00:00.000Z",
  };
  /**
   * Компактные счётчики всех побочных эффектов: списание, дубль-гард, обращения к записи
   * (вместе с отказами) и успешно созданные строки calculations / report_history.
   */
  const counts = () => ({
    consume: log.consume,
    dup: log.dup,
    insertTry: log.insertTry,
    inserts: log.inserts.length,
    updateTry: log.updateTry,
    updates: log.updates.length,
    historyTry: log.historyTry,
    histories: log.histories.length,
    calcRows: rows.size,
  });
  return { deps, log, rows, cfg, counts };
}
