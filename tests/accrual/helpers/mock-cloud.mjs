// Мок «облака» для проверки границы списания и сохранения: считает ВСЕ побочные
// эффекты (consume, дубль-гард, insert/update calculations, report_history).
// Никакого Supabase/сети — только счётчики и память.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeMockCloud(over = {}) {
  const log = { consume: 0, canCalc: 0, dup: 0, inserts: [], updates: [], histories: [] };
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
      return cfg.canCalculate;
    },
    confirmNoMonthDuplicate: async (monthKey) => {
      log.dup++;
      log.lastDupMonth = monthKey;
      return cfg.dupAnswer;
    },
    consume: async () => {
      log.consume++;
      if (cfg.delayMs) await sleep(cfg.delayMs);
      return cfg.consumeOk ? { ok: true } : { ok: false, reason: "limit_reached" };
    },
    insertCalculation: async (cols) => {
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.insertError) return { data: null, error: { message: cfg.insertError } };
      const row = { id: `calc-${++seq}`, created_at: "2026-07-01T10:00:00.000Z" };
      rows.set(row.id, { ...row, ...clone(cols) });
      log.inserts.push(row.id);
      return { data: row, error: null };
    },
    updateCalculation: async (id, cols) => {
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.updateError) return { data: null, error: { message: cfg.updateError } };
      const prev = rows.get(id);
      if (!prev) return { data: null, error: { message: "row not found" } };
      rows.set(id, { ...prev, ...clone(cols) });
      log.updates.push(id);
      return { data: { id, created_at: prev.created_at }, error: null };
    },
    insertReportHistory: async (cols) => {
      if (cfg.historyError) return { data: null, error: { message: cfg.historyError } };
      log.histories.push(clone(cols));
      return { data: {}, error: null };
    },
    newLocalId: () => `local-${++seq}`,
    nowIso: () => "2026-07-01T10:00:00.000Z",
  };
  return { deps, log, rows, cfg };
}
