// Мок «облака» для проверки границы списания и сохранения: считает ВСЕ побочные
// эффекты (consume, дубль-гард, insert/update calculations, report_history).
// Никакого Supabase/сети — только счётчики и память.
//
// saveOperation ведёт себя как серверная транзакция (save_calculation_operation):
// повтор по ключу операции возвращает сохранённое без списания; списание, строка
// calculations и строка report_history фиксируются вместе, сбой записи откатывает
// списание; dropResponse — COMMIT прошёл, а ответ «потерян» (kind: failed).

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
    /** Откат списания (транзакция операции не зафиксирована). */
    rollback: () => {
      if (!st.unlimited) st.used--;
      st.granted--;
    },
  };
}

/** Небольшой детерминированный хеш строки (хеш содержимого снимка в тестах). */
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `h${s.length}:${(h >>> 0).toString(36)}`;
}

export function makeMockCloud(over = {}) {
  // inserts/updates/histories — только УСПЕШНЫЕ записи; *Try — все обращения, включая отказы.
  // consume — вызовы списания, не отменённые откатом (отказ сервера тоже считается).
  const log = {
    consume: 0,
    canCalc: 0,
    dup: 0,
    insertTry: 0,
    updateTry: 0,
    historyTry: 0,
    inserts: [],
    updates: [],
    histories: [],
    opTry: 0,
    replays: 0,
    rolledBack: 0,
    opIds: [],
  };
  const cfg = {
    consumeOk: true,
    canCalculate: true,
    dupAnswer: true,
    insertError: null,
    updateError: null,
    historyError: null,
    delayMs: 0,
    /** Операция не дошла до сервера / нет ответа (kind: failed, ничего не записано). */
    opNetworkError: null,
    /** COMMIT прошёл, но ответ потерян (kind: failed). */
    dropResponse: false,
    /** Сервер без миграции (kind: unavailable). */
    opUnavailable: false,
    ...over,
  };
  let seq = 0;
  let opSeq = 0;
  const rows = new Map(); // «таблица calculations»
  const ops = new Map(); // «таблица calculation_operations»: ключ → { requestHash, contentHash, rowId }
  const pendingKeys = new Map(); // «localStorage» страницы: попытка → ключ операции
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
    saveOperation: async (req) => {
      log.opTry++;
      log.lastOp = clone(req);
      if (cfg.delayMs) await sleep(cfg.delayMs);
      if (cfg.opNetworkError) return { kind: "failed", message: cfg.opNetworkError };
      if (cfg.opUnavailable) return { kind: "unavailable", message: "Сохранение расчёта временно недоступно" };
      const prev = ops.get(req.operationId);
      if (prev) {
        if (prev.requestHash !== req.requestHash) return { kind: "conflict" };
        log.replays++;
        const r = prev.rowId ? rows.get(prev.rowId) : null;
        return { kind: "ok", replay: true, row: r ? { id: prev.rowId, created_at: r.created_at } : null, contentHash: prev.contentHash };
      }
      // Списание по правилам consume_calculation.
      log.consume++;
      const c = cfg.entitlement ? await cfg.entitlement.consume() : cfg.consumeOk ? { ok: true } : { ok: false, reason: "limit_reached" };
      if (!c.ok) return { kind: "refused", reason: c.reason ?? "limit_reached" };
      // Записи — в той же транзакции: сбой откатывает списание, ничего не остаётся.
      log.insertTry++;
      log.historyTry++;
      if (cfg.insertError || cfg.historyError) {
        cfg.entitlement?.rollback();
        log.consume--;
        log.rolledBack++;
        return { kind: "failed", message: cfg.insertError ?? cfg.historyError };
      }
      const row = { id: `calc-${++seq}`, created_at: "2026-07-01T10:00:00.000Z" };
      rows.set(row.id, { ...row, ...clone(req.calculation) });
      log.inserts.push(row.id);
      log.histories.push(clone(req.history));
      ops.set(req.operationId, { requestHash: req.requestHash, contentHash: req.contentHash, rowId: row.id });
      if (cfg.dropResponse) return { kind: "failed", message: "ответ потерян" };
      return { kind: "ok", replay: false, row, contentHash: req.contentHash };
    },
    operationIdFor: (attemptId) => {
      if (!pendingKeys.has(attemptId)) {
        const id = `op-${++opSeq}`;
        pendingKeys.set(attemptId, id);
        log.opIds.push(id);
      }
      return pendingKeys.get(attemptId);
    },
    operationSettled: (attemptId) => {
      pendingKeys.delete(attemptId);
    },
    hasPendingOperation: (attemptId) => pendingKeys.has(attemptId),
    contentHash: strHash,
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
  /** Статус операции «на сервере» (восстановление после перезагрузки). */
  const status = (operationId, requestHash) => {
    const op = ops.get(operationId);
    if (!op) return { kind: "none" };
    if (op.requestHash !== requestHash) return { kind: "conflict" };
    const r = op.rowId ? rows.get(op.rowId) : null;
    return { kind: "done", row: r ? { id: op.rowId, created_at: r.created_at } : null, contentHash: op.contentHash };
  };
  return { deps, log, rows, cfg, counts, ops, pendingKeys, status };
}
