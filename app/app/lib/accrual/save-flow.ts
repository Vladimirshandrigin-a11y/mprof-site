// ============================================================================
// Граница списания и сохранения расчёта по «Отчёту по начислениям» (PR-3).
// Чистый оркестратор с внедряемыми зависимостями (consume, cloud-запись, дубль-
// гард) — поэтому вся граница проверяется в Node на моках, без Supabase.
//
// ПОРЯДОК (для одного расчёта):
//   1. результат не готов (неполная себестоимость и т.п.) → not_ready: НИКАКИХ
//      побочных эффектов — ни списания, ни записи;
//   2. нет попытки (paywall) и нет удержанного кредита → paywall: без списания;
//   3. дубль месяца: подтверждение ДО списания; «Отмена» → cancelled: без
//      списания и записи;
//   4. consume — РОВНО ОДИН РАЗ на расчёт: флаг paid держится в контроллере, повтор
//      сохранения (после ошибки записи или при правке ставки) НЕ списывает снова;
//   5. запись calculations: insert (первый раз) или update (та же строка).
//      Ошибка записи → save_failed (видна пользователю), оплата сохраняется;
//   6. report_history — best-effort: сбой даёт предупреждение, но не отменяет
//      уже сохранённый расчёт.
//
// Чтение файла, ошибка формата и отмена дубля происходят ДО consume — они его не
// вызывают. Двойной клик: пока идёт сохранение, повторный вызов возвращает busy.
//
// Ограничение архитектуры: consume (/api/cloud/consume) и запись (/api/cloud/
// calculations) — два независимых HTTP-вызова без общей серверной транзакции.
// Между ними «оплачено, но не записано» возможно; контроллер держит кредит в
// памяти сессии для повтора, но после перезагрузки страницы он теряется.
// ============================================================================

import {
  accrualSnapshotToCalculationColumns,
  accrualSnapshotToReportHistoryColumns,
  type AccrualCalculationColumns,
  type AccrualReportHistoryColumns,
} from "./columns";
import type { AccrualSnapshotV1 } from "./snapshot";

export interface ConsumeResult {
  ok: boolean;
  reason?: string;
}

export interface CloudRow {
  id: string;
  created_at: string;
}

export interface CloudResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface AccrualSaveDeps {
  /** Право на ещё один расчёт (paywall). Вычисляется в момент вызова. */
  canCalculate(): boolean;
  /** Подтверждение повторного месяца; false = «Отмена». */
  confirmNoMonthDuplicate(monthKey: string | null): Promise<boolean>;
  /** Server-authoritative списание одной попытки. */
  consume(): Promise<ConsumeResult>;
  insertCalculation(cols: AccrualCalculationColumns): Promise<CloudResult<CloudRow>>;
  updateCalculation(id: string, cols: AccrualCalculationColumns): Promise<CloudResult<CloudRow>>;
  insertReportHistory(cols: AccrualReportHistoryColumns): Promise<CloudResult<unknown>>;
  /** id для записи, не попавшей в облако (аноним). */
  newLocalId(): string;
  nowIso(): string;
}

export interface SavedRef {
  id: string;
  /** true — строка есть в облаке. */
  synced: boolean;
  createdAt: string;
}

export interface SaveState {
  /** Попытка списана (или удерживается для повтора сохранения). */
  paid: boolean;
  /** Дубль месяца уже подтверждён для этого расчёта. */
  dupConfirmed: boolean;
  saved: SavedRef | null;
  /** Последняя запись report_history удалась (для повтора). */
  historyOk: boolean;
}

export type SaveOutcome =
  | { status: "busy" }
  | { status: "not_ready"; reason: string }
  | { status: "cancelled" }
  | { status: "paywall"; reason?: string }
  | {
      status: "saved";
      row: SavedRef;
      /** true — строка создана (insert), false — обновлена (update). */
      created: boolean;
      /** true — запись только локальная (нет входа в аккаунт). */
      local: boolean;
      historyWarning: string | null;
      columns: AccrualCalculationColumns;
    }
  | { status: "save_failed"; error: string };

export interface SaveRequest {
  snapshot: AccrualSnapshotV1;
  /** Результат готов к сохранению (полная себестоимость и т.п.). */
  ready: boolean;
  /** null — аноним: запись только локально. */
  userId: string | null;
}

export class AccrualSaveController {
  private st: SaveState = { paid: false, dupConfirmed: false, saved: null, historyOk: true };
  private inFlight = false;

  constructor(private readonly deps: AccrualSaveDeps) {}

  get state(): Readonly<SaveState> {
    return this.st;
  }

  /**
   * Новый файл: строка и подтверждение дубля относятся к прежнему расчёту.
   * Списанная, но так и не сохранённая попытка удерживается для следующего
   * сохранения (чтобы не списывать дважды); сохранённый расчёт оплату «закрыл».
   */
  startNewFile(): void {
    const holdCredit = this.st.paid && this.st.saved === null;
    this.st = { paid: holdCredit, dupConfirmed: false, saved: null, historyOk: true };
  }

  /** Сохранённая строка удалена из истории — следующая запись создаст новую (без нового списания). */
  forgetSaved(): void {
    this.st = { ...this.st, saved: null, historyOk: true };
  }

  async save(req: SaveRequest): Promise<SaveOutcome> {
    if (this.inFlight) return { status: "busy" };
    this.inFlight = true;
    try {
      const { snapshot, ready, userId } = req;
      if (!ready) {
        return { status: "not_ready", reason: "Результат предварительный: заполните себестоимость всех товаров." };
      }

      if (!this.st.paid && !this.deps.canCalculate()) return { status: "paywall" };

      if (!this.st.saved && !this.st.dupConfirmed) {
        const proceed = await this.deps.confirmNoMonthDuplicate(snapshot.period.month);
        if (!proceed) return { status: "cancelled" };
        this.st = { ...this.st, dupConfirmed: true };
      }

      if (!this.st.paid) {
        const consumed = await this.deps.consume();
        if (!consumed.ok) {
          this.st = { ...this.st, dupConfirmed: false };
          return { status: "paywall", reason: consumed.reason };
        }
        this.st = { ...this.st, paid: true };
      }

      const columns = accrualSnapshotToCalculationColumns(snapshot);

      // Аноним: только локально (как прежний document flow), без облака.
      if (!userId) {
        const row: SavedRef = this.st.saved ?? {
          id: this.deps.newLocalId(),
          synced: false,
          createdAt: this.deps.nowIso(),
        };
        const created = this.st.saved === null;
        this.st = { ...this.st, saved: row };
        return { status: "saved", row, created, local: true, historyWarning: null, columns };
      }

      let row: SavedRef;
      let created: boolean;
      if (this.st.saved?.synced) {
        const up = await this.deps.updateCalculation(this.st.saved.id, columns);
        if (up.error || !up.data) {
          return { status: "save_failed", error: up.error?.message ?? "Не удалось обновить расчёт" };
        }
        row = { id: up.data.id, synced: true, createdAt: up.data.created_at };
        created = false;
      } else {
        const ins = await this.deps.insertCalculation(columns);
        if (ins.error || !ins.data) {
          return { status: "save_failed", error: ins.error?.message ?? "Не удалось сохранить расчёт" };
        }
        row = { id: ins.data.id, synced: true, createdAt: ins.data.created_at };
        created = true;
      }
      this.st = { ...this.st, saved: row };

      // report_history — best-effort: не отменяет уже сохранённый расчёт.
      let historyWarning: string | null = null;
      const hist = await this.deps.insertReportHistory(accrualSnapshotToReportHistoryColumns(snapshot));
      if (hist.error) {
        historyWarning = `Расчёт сохранён, но сводка по месяцам не обновилась: ${hist.error.message}`;
        this.st = { ...this.st, historyOk: false };
      } else {
        this.st = { ...this.st, historyOk: true };
      }
      return { status: "saved", row, created, local: false, historyWarning, columns };
    } finally {
      this.inFlight = false;
    }
  }
}
