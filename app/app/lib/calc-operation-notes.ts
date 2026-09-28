// ============================================================================
// Операции ручного расчёта и Ozon API: исход операции → что показать и что делать
// с ключом незавершённой операции. Чистые функции без React/сети (покрыты тестами).
//
// Правило ключа: ключ убирается, когда исход известен — сохранено, удалено, конфликт,
// отказ в списании или сохранение недоступно (в двух последних ничего не записано).
// Неизвестный исход (нет ответа) и статус «нет операции» ключ СОХРАНЯЮТ — в том числе
// после окончания окна перепроверки: «нет» не доказывает, что исходный запрос уже не
// завершится. Повтор с тем же ключом безопасен (сервер не спишет дважды). При
// потерянном ответе НЕ утверждаем «ничего не списано»: исход неизвестен.
// ============================================================================

export type OpMode = "manual" | "api";

export interface OpNote {
  kind: "ok" | "warn" | "err";
  text: string;
}

export const OP_TEXT = {
  restoredManual:
    "Этот расчёт уже был сохранён — показан сохранённый результат. Повторного списания нет.",
  restoredApi:
    "Расчёт через Ozon API за этот месяц с этими расходами уже сохранён — показан сохранённый результат. Повторного обращения к Ozon и списания нет.",
  restoredAfterReload:
    "Расчёт, начатый до перезагрузки страницы, успел сохраниться — показан сохранённый результат. Повторного списания нет.",
  restoredOther:
    "Незавершённый расчёт с другими значениями уже сохранён — показан он. Повторного списания нет. Чтобы рассчитать с новыми значениями, нажмите кнопку ещё раз.",
  restoredPending:
    "Расчёт, сохранение которого не было подтверждено, сохранён — показан сохранённый результат. Повторного списания нет.",
  pending:
    "Сохранение расчёта не подтверждено сервером — расчёт мог успеть сохраниться. Проверьте: сохранённый откроется без повторного списания, а если сервер его не получил, сохранение завершится той же операцией.",
  stillUnknown: (msg: string) =>
    `Не удалось проверить сохранение (${msg.replace(/\.\s*$/, "")}). Ключ операции сохранён — повторите проверку позже; повторного списания не будет.`,
  deleted:
    "Расчёт по этой операции был сохранён и затем удалён из истории. Заново он не создаётся, попытка повторно не списывается. Новый расчёт — отдельная попытка.",
  conflict:
    "Ключ операции относится к расчёту с другими значениями. Ничего не записано, попытка не списана. Нажмите кнопку ещё раз, чтобы начать новый расчёт.",
  unavailable: (msg: string) => `Не удалось сохранить расчёт: ${msg.replace(/\.\s*$/, "")}. Попытка расчёта не списана.`,
  unknown: (msg: string) =>
    `Сервер не подтвердил сохранение (${msg.replace(/\.\s*$/, "")}). Расчёт мог успеть сохраниться — повторите: если он уже сохранён, повтор вернёт его без повторного списания.`,
} as const;

/** Исход операции (ручной: saveManualCalculationOperation; API: apiSaveOutcome). */
export type OpOutcome =
  | { kind: "ok"; replay: boolean }
  | { kind: "deleted" }
  | { kind: "refused" }
  | { kind: "conflict" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export interface OpOutcomeUi {
  /** null — сообщение не нужно (новый результат показан / окно тарифов). */
  note: OpNote | null;
  /** Ключ операции остаётся для повтора (исход не окончательный). */
  keepKey: boolean;
  /** Открыть окно тарифов (сервер отказал в списании — ничего не записано). */
  paywall: boolean;
}

export function opOutcomeUi(out: OpOutcome, mode: OpMode): OpOutcomeUi {
  switch (out.kind) {
    case "ok":
      return {
        note: out.replay
          ? { kind: "ok", text: mode === "api" ? OP_TEXT.restoredApi : OP_TEXT.restoredManual }
          : null,
        keepKey: false,
        paywall: false,
      };
    case "deleted":
      return { note: { kind: "warn", text: OP_TEXT.deleted }, keepKey: false, paywall: false };
    case "refused":
      // Операции по ключу нет и списание отклонено — ничего не записано.
      return { note: null, keepKey: false, paywall: true };
    case "conflict":
      return { note: { kind: "err", text: OP_TEXT.conflict }, keepKey: false, paywall: false };
    case "unavailable":
      // Функции операции на сервере нет (миграция не применена) — ничего не выполнено.
      return { note: { kind: "err", text: OP_TEXT.unavailable(out.message) }, keepKey: false, paywall: false };
    case "failed":
      return { note: { kind: "err", text: OP_TEXT.unknown(out.message) }, keepKey: true, paywall: false };
  }
}

/** Статус незавершённой операции при восстановлении (перед новым расчётом / после перезагрузки). */
export type OpRecoveryStatus = "done" | "deleted" | "conflict" | "none" | "failed";

export function opRecoveryUi(
  status: OpRecoveryStatus,
  context: "same" | "other" | "reload" | "pending"
): { note: OpNote | null; keepKey: boolean; restore: boolean } {
  switch (status) {
    case "done":
      return {
        note: {
          kind: "ok",
          text:
            context === "reload"
              ? OP_TEXT.restoredAfterReload
              : context === "other"
              ? OP_TEXT.restoredOther
              : context === "pending"
              ? OP_TEXT.restoredPending
              : OP_TEXT.restoredManual,
        },
        keepKey: false,
        restore: true,
      };
    case "deleted":
      return { note: { kind: "warn", text: OP_TEXT.deleted }, keepKey: false, restore: false };
    case "conflict":
      return { note: null, keepKey: false, restore: false };
    default:
      // none — операция на сервер не дошла (или ещё идёт); failed — не удалось узнать.
      return { note: null, keepKey: true, restore: false };
  }
}

/**
 * Ответ /api/ozon/save-calculation → исход. Ошибки ДО операции (Ozon, неполная
 * себестоимость, неверный ввод) — "before": попытка не списана, сообщение сервера.
 */
export type ApiSaveOutcome =
  | { kind: "saved" }
  | { kind: "replay"; calculation: unknown }
  | { kind: "deleted" }
  | { kind: "refused" }
  | { kind: "conflict" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "incomplete_cost" }
  | { kind: "before"; message: string };

export function apiSaveOutcome(
  status: number,
  data: { ok?: boolean; replay?: boolean; status?: string; code?: string; error?: string; calculation?: unknown } | null,
  networkError: string | null
): ApiSaveOutcome {
  if (networkError !== null || data === null) return { kind: "failed", message: networkError ?? "нет ответа" };
  if (status === 200 && data.ok === true) {
    if (data.replay === true) {
      return data.status === "deleted" ? { kind: "deleted" } : { kind: "replay", calculation: data.calculation ?? null };
    }
    return { kind: "saved" };
  }
  if (status === 402 || data.code === "limit_reached" || data.code === "calculation_required") return { kind: "refused" };
  if (status === 400 && data.code === "incomplete_cost") return { kind: "incomplete_cost" };
  if (status === 409 || data.code === "operation_conflict") return { kind: "conflict" };
  if (data.code === "migration_missing") {
    return { kind: "unavailable", message: "Сохранение расчёта временно недоступно" };
  }
  if (data.code === "operation_failed") {
    return { kind: "failed", message: "нет подтверждения сохранения" };
  }
  // 5xx без ответа маршрута (сбой мог случиться и после записи) — исход неизвестен.
  if (status >= 500 && !data.error) return { kind: "failed", message: `ошибка сервера ${status}` };
  return { kind: "before", message: data.error || "Не удалось рассчитать и сохранить расчёт" };
}

// ---------------------------------------------------------------------------
// Перепроверка после перезагрузки
// ---------------------------------------------------------------------------

/** «Молодой» ключ: сервер мог ещё сохранять, когда страницу перезагрузили. */
export const RECHECK_RECENT_MS = 120_000;
export const RECHECK_ATTEMPTS = 6;
export const RECHECK_DELAY_MS = 4_000;

/**
 * Ограниченное окно перепроверки после перезагрузки (без постоянного опроса):
 * check() — один проход по незавершённым операциям (true — показан сохранённый
 * расчёт); пока остаются «молодые» ключи, проход повторяется RECHECK_ATTEMPTS раз с
 * паузой. Окно закончилось — ключи НЕ удаляются: страница показывает действие
 * «проверить и завершить сохранение» (повтор той же операции тем же ключом).
 */
export async function recheckAfterReload(o: {
  check: () => Promise<boolean>;
  hasRecent: () => boolean;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<boolean> {
  const attempts = o.attempts ?? RECHECK_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    if (await o.check()) return true;
    if (i === attempts - 1 || !o.hasRecent()) return false;
    await o.sleep(o.delayMs ?? RECHECK_DELAY_MS);
  }
  return false;
}
