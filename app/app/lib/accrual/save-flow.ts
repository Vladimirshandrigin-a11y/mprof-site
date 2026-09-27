// ============================================================================
// Граница списания и сохранения расчёта по «Отчёту по начислениям» (PR-3).
// Чистый оркестратор с внедряемыми зависимостями (consume, cloud-запись, дубль-
// гард) — поэтому вся граница проверяется в Node на моках, без Supabase.
//
// ПОПЫТКА РАСЧЁТА (Attempt). Всё состояние — отметка «списано», подтверждение
// дубля месяца, строка calculations и то, ЧТО именно записано — принадлежит
// конкретной попытке, а не сессии в целом. Попытка = один загруженный файл
// (отпечаток разобранного отчёта, см. upload-session.reportFingerprint):
//   • другой файл начинает новую попытку и НЕ наследует чужую отметку «списано»;
//   • списанная, но так и не записанная попытка остаётся за своим файлом:
//     если вернуться к тому же файлу (пока страница открыта), сохранение пройдёт
//     без нового списания; для другого файла попытка спишется отдельно;
//   • сохранённая попытка закрыта: тот же файл, загруженный снова, — новый расчёт
//     (подтверждение дубля месяца + новое списание), как и задумано.
// Правка ставки/расходов/каталога внутри попытки попытку не меняет.
//
// ПОРЯДОК save() (для текущей попытки):
//   1. результат не готов (неполная себестоимость и т.п.) → not_ready: НИКАКИХ
//      побочных эффектов — ни списания, ни записи;
//   2. результат уже полностью записан (то же содержимое снимка) → unchanged:
//      НИ списания, НИ записи — повторное «Сохранить» ничего не создаёт;
//   3. нет попытки (paywall) и нет списанной попытки → paywall: без списания;
//   4. дубль месяца: подтверждение ДО списания; «Отмена» → cancelled: без
//      списания и записи;
//   5. аккаунт, первое сохранение попытки — ОДНА серверная операция
//      (saveOperation → /api/cloud/calculation-operations → одна транзакция БД):
//      списание + calculations + report_history + отметка операции. Сбой до COMMIT
//      не оставляет ни списания, ни частичных записей. Ключ операции (UUID) хранится
//      у страницы (operationIdFor) до подтверждения: потерянный ответ, двойной клик
//      или перезагрузка → повтор с ТЕМ ЖЕ ключом возвращает уже сохранённый расчёт
//      без нового списания. Ключ привязан к пользователю и файлу (requestHash =
//      отпечаток попытки): с другим файлом сервер отвечает конфликтом;
//   6. после сохранения — обновление той же строки calculations без списания
//      (правка ставки/расходов), ничего (содержимое уже записано);
//   7. report_history при обновлении — best-effort: сбой даёт предупреждение и НЕ
//      отменяет сохранённый расчёт; повтор дописывает ТОЛЬКО недостающую запись.
// Аноним: списание через consume (localStorage у страницы), запись только локальная.
//
// Чтение файла, ошибка формата и отмена дубля происходят ДО операции — они её не
// вызывают. Двойной клик: пока идёт сохранение, повторный вызов возвращает busy;
// сменить попытку (файл) во время сохранения нельзя (beginAttempt → false).
// После перезагрузки тот же файл находит свою незавершённую операцию по ключу:
// страница спрашивает статус у сервера и, если расчёт уже сохранён, передаёт его
// в adoptSaved — без дубль-гарда, без списания и без повторной записи.
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

/** Операция расчёта: списание + сохранение одной транзакцией на сервере. */
export interface CalculationOperationRequest {
  operationId: string;
  /** Отпечаток файла попытки: операция привязана к нему. */
  requestHash: string;
  /** Хеш содержимого снимка: при повторе показывает, то ли содержимое сохранено. */
  contentHash: string;
  calculation: AccrualCalculationColumns;
  history: AccrualReportHistoryColumns;
}

export type CalculationOperationResult =
  /** Сохранено (replay — уже было сохранено этой операцией раньше; row = null — строку удалили). */
  | { kind: "ok"; replay: boolean; row: CloudRow | null; contentHash: string | null }
  /** Сервер отказал в списании (нет попытки / нет сессии): ничего не записано. */
  | { kind: "refused"; reason: string }
  /** Ключ операции не совпадает с файлом или пользователем: ничего не записано. */
  | { kind: "conflict" }
  /** Сохранение недоступно (например, не применена миграция): ничего не записано. */
  | { kind: "unavailable"; message: string }
  /** Нет подтверждения: операция могла успеть сохраниться — повторять с тем же ключом. */
  | { kind: "failed"; message: string };

export type CalculationOperationStatus =
  | { kind: "done"; row: CloudRow | null; contentHash: string | null }
  | { kind: "none" }
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

export interface AccrualSaveDeps {
  /** Право на ещё один расчёт (paywall). Вычисляется в момент вызова. */
  canCalculate(): boolean;
  /** Подтверждение повторного месяца; false = «Отмена». */
  confirmNoMonthDuplicate(monthKey: string | null): Promise<boolean>;
  /** Списание одной попытки — только для анонима (локальный счётчик страницы). */
  consume(): Promise<ConsumeResult>;
  /** Аккаунт: списание и сохранение одной транзакцией на сервере (идемпотентно по ключу). */
  saveOperation(req: CalculationOperationRequest): Promise<CalculationOperationResult>;
  /** Ключ операции попытки: тот же до подтверждения (переживает перезагрузку). */
  operationIdFor(attemptId: string): string;
  /** Сервер подтвердил операцию попытки — ключ больше не нужен. */
  operationSettled(attemptId: string): void;
  /** У попытки есть неподтверждённая операция (решает сервер, а не клиентский paywall). */
  hasPendingOperation(attemptId: string): boolean;
  /** Хеш содержимого снимка (snapshotContentKey). */
  contentHash(contentKey: string): string;
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

/** Только чтение состояния ТЕКУЩЕЙ попытки (для UI и тестов). */
export interface SaveState {
  /** Отпечаток файла текущей попытки (null — файла нет). */
  attemptId: string | null;
  /** Попытка списана (или удерживается для повтора сохранения). */
  paid: boolean;
  /** Дубль месяца уже подтверждён для этой попытки. */
  dupConfirmed: boolean;
  saved: SavedRef | null;
  /** Содержимое снимка, записанное в calculations (null — ничего). */
  calcKey: string | null;
  /** Содержимое снимка, записанное в report_history (null — ничего). */
  historyKey: string | null;
  /** Сводка по месяцам соответствует сохранённому расчёту (или её не требуется). */
  historyOk: boolean;
}

export type CalculationWrite = "insert" | "update" | "none" | "local";
export type HistoryWrite = "written" | "failed" | "local";

export type SaveOutcome =
  | { status: "busy" }
  | { status: "not_ready"; reason: string }
  | { status: "cancelled" }
  | { status: "paywall"; reason?: string }
  /** Тот же результат уже записан полностью: ни списания, ни записи. */
  | { status: "unchanged"; row: SavedRef }
  | {
      status: "saved";
      row: SavedRef;
      /** true — строка создана (insert), false — обновлена / уже была. */
      created: boolean;
      /** true — запись только локальная (нет входа в аккаунт). */
      local: boolean;
      /** Что реально сделано с calculations в ЭТОМ вызове. */
      calculationWrite: CalculationWrite;
      /** Что реально сделано с report_history в ЭТОМ вызове. */
      historyWrite: HistoryWrite;
      historyWarning: string | null;
      columns: AccrualCalculationColumns;
      /** Расчёт уже был сохранён этой операцией (повтор после потерянного ответа). */
      replay?: boolean;
    }
  | {
      status: "save_failed";
      error: string;
      /**
       * Что с попыткой: none — точно не списана; unknown — нет подтверждения (могла
       * сохраниться, повтор с тем же ключом не спишет дважды); kept — списана раньше,
       * не удалось сохранить изменения.
       */
      charge: "none" | "unknown" | "kept";
    };

export interface SaveRequest {
  snapshot: AccrualSnapshotV1;
  /** Результат готов к сохранению (полная себестоимость и т.п.). */
  ready: boolean;
  /** null — аноним: запись только локально. */
  userId: string | null;
}

/** Ключ содержимого снимка без времени формирования: различает правки вводов, а не повторный вызов. */
export function snapshotContentKey(s: AccrualSnapshotV1): string {
  return JSON.stringify({ ...s, generatedAt: null });
}

interface Attempt {
  id: string | null;
  paid: boolean;
  dupConfirmed: boolean;
  saved: SavedRef | null;
  calcKey: string | null;
  historyKey: string | null;
  /** Хеш содержимого расчёта, восстановленного с сервера (сверяется при сохранении). */
  adoptedHash: string | null;
}

const freshAttempt = (id: string | null): Attempt => ({
  id,
  paid: false,
  dupConfirmed: false,
  saved: null,
  calcKey: null,
  historyKey: null,
  adoptedHash: null,
});

export class AccrualSaveController {
  private cur: Attempt = freshAttempt(null);
  /** Списанные, но не записанные попытки, у которых сейчас другой файл: id → попытка. */
  private readonly held = new Map<string, Attempt>();
  private inFlight = false;

  constructor(private readonly deps: AccrualSaveDeps) {}

  get state(): Readonly<SaveState> {
    const a = this.cur;
    return {
      attemptId: a.id,
      paid: a.paid,
      dupConfirmed: a.dupConfirmed,
      saved: a.saved,
      calcKey: a.calcKey,
      historyKey: a.historyKey,
      historyOk: a.saved === null || !a.saved.synced || a.historyKey === a.calcKey,
    };
  }

  /** Сколько списанных, но не записанных попыток ждут своих файлов (не текущий). */
  get heldElsewhere(): number {
    return this.held.size;
  }

  /**
   * Смена файла = смена попытки. Возвращает false, если идёт сохранение (сменить
   * попытку нельзя — запись ушла бы в чужое состояние).
   *   • текущая списанная, но не записанная попытка паркуется за своим файлом;
   *   • для нового файла берётся ТОЛЬКО его же припаркованная попытка (тот же
   *     отпечаток); иначе — чистая попытка без отметки «списано»;
   *   • сохранённая попытка закрывается.
   * id = null — «файла нет» (выбор нового файла, «Убрать»).
   */
  beginAttempt(attemptId: string | null): boolean {
    if (this.inFlight) return false;
    const prev = this.cur;
    if (prev.paid && prev.saved === null && prev.id !== null) this.held.set(prev.id, prev);
    const resumed = attemptId !== null ? this.held.get(attemptId) : undefined;
    if (resumed && attemptId !== null) {
      this.held.delete(attemptId);
      this.cur = resumed;
    } else {
      this.cur = freshAttempt(attemptId);
    }
    return true;
  }

  /**
   * Операция этой попытки уже выполнена на сервере (восстановление после перезагрузки
   * или потерянного ответа): попытка оплачена и сохранена — без дубль-гарда, списания
   * и записи. Содержимое сверяется по хешу при следующем «Сохранить».
   */
  adoptSaved(attemptId: string, done: { row: CloudRow | null; contentHash: string | null }): boolean {
    const a = this.cur;
    if (this.inFlight || a.id !== attemptId || a.paid) return false;
    a.paid = true;
    a.dupConfirmed = true;
    a.saved = done.row ? { id: done.row.id, synced: true, createdAt: done.row.created_at } : null;
    a.calcKey = null;
    a.historyKey = null;
    a.adoptedHash = done.contentHash;
    return true;
  }

  /** Сохранённая строка удалена из истории — следующая запись создаст новую (без нового списания). */
  forgetSaved(): void {
    const a = this.cur;
    a.saved = null;
    a.calcKey = null;
    a.historyKey = null;
  }

  async save(req: SaveRequest): Promise<SaveOutcome> {
    if (this.inFlight) return { status: "busy" };
    this.inFlight = true;
    try {
      const at = this.cur;
      const { snapshot, ready, userId } = req;
      if (!ready) {
        return { status: "not_ready", reason: "Результат предварительный: заполните себестоимость всех товаров." };
      }

      const key = snapshotContentKey(snapshot);

      // Расчёт, восстановленный с сервера: то же содержимое → считаем записанным.
      if (at.saved && at.calcKey === null && at.adoptedHash !== null) {
        if (this.deps.contentHash(key) === at.adoptedHash) {
          at.calcKey = key;
          at.historyKey = key;
        }
        at.adoptedHash = null;
      }

      // Идемпотентность: то же содержимое уже записано (и в calculations, и — для
      // аккаунта — в report_history) → не пишем и не списываем ничего.
      if (at.saved && at.calcKey === key && (!userId || (at.saved.synced && at.historyKey === key))) {
        return { status: "unchanged", row: at.saved };
      }

      // Незавершённая операция попытки: решает сервер (повтор вернёт уже сохранённое).
      const pendingOp = !!userId && at.id !== null && !at.paid && this.deps.hasPendingOperation(at.id);
      if (!at.paid && !pendingOp && !this.deps.canCalculate()) return { status: "paywall" };

      if (!at.saved && !at.dupConfirmed) {
        const proceed = await this.deps.confirmNoMonthDuplicate(snapshot.period.month);
        if (!proceed) return { status: "cancelled" };
        at.dupConfirmed = true;
      }

      const columns = accrualSnapshotToCalculationColumns(snapshot);

      // Аноним: списание локальным счётчиком страницы, запись только локальная.
      if (!userId) {
        if (!at.paid) {
          const consumed = await this.deps.consume();
          if (!consumed.ok) {
            at.dupConfirmed = false;
            return { status: "paywall", reason: consumed.reason };
          }
          at.paid = true;
        }
        const created = at.saved === null;
        const row: SavedRef = at.saved ?? {
          id: this.deps.newLocalId(),
          synced: false,
          createdAt: this.deps.nowIso(),
        };
        at.saved = row;
        at.calcKey = key;
        return {
          status: "saved",
          row,
          created,
          local: true,
          calculationWrite: "local",
          historyWrite: "local",
          historyWarning: null,
          columns,
        };
      }

      // Аккаунт, первое сохранение попытки: ОДНА операция на сервере — списание,
      // calculations, report_history и отметка операции в одной транзакции.
      if (!at.paid) {
        // Попытка без отпечатка файла (в интерфейсе не бывает): своя уникальная привязка,
        // чтобы ключ операции не совпал с другой попыткой.
        if (at.id === null) at.id = `unbound-${this.deps.newLocalId()}`;
        const contentHash = this.deps.contentHash(key);
        const op = await this.deps.saveOperation({
          operationId: this.deps.operationIdFor(at.id),
          requestHash: at.id,
          contentHash,
          calculation: columns,
          history: accrualSnapshotToReportHistoryColumns(snapshot),
        });
        switch (op.kind) {
          case "refused":
            at.dupConfirmed = false;
            return { status: "paywall", reason: op.reason };
          case "conflict":
            // Сохранённый ключ относится к другому файлу: следующий раз — новый ключ.
            this.deps.operationSettled(at.id);
            return {
              status: "save_failed",
              error: "ключ операции не совпадает с этим файлом",
              charge: "none",
            };
          case "unavailable":
            return { status: "save_failed", error: op.message, charge: "none" };
          case "failed":
            return { status: "save_failed", error: op.message, charge: "unknown" };
        }
        at.paid = true;
        this.deps.operationSettled(at.id);
        if (op.row) {
          at.saved = { id: op.row.id, synced: true, createdAt: op.row.created_at };
          if (!op.replay || op.contentHash === contentHash) {
            at.calcKey = key;
            at.historyKey = key;
            return {
              status: "saved",
              row: at.saved,
              created: !op.replay,
              local: false,
              calculationWrite: op.replay ? "none" : "insert",
              historyWrite: "written",
              historyWarning: null,
              columns,
              replay: op.replay,
            };
          }
          // Повтор после правки ввода: сохранено прежнее содержимое — обновим ниже.
        }
        // op.row = null: сохранённую строку удалили из истории — ниже создаётся новая
        // без нового списания.
      }

      let row: SavedRef;
      let calculationWrite: CalculationWrite;
      if (at.saved?.synced && at.calcKey === key) {
        // calculations уже содержит именно этот результат (сбой был на сводке) — не пишем второй раз.
        row = at.saved;
        calculationWrite = "none";
      } else if (at.saved?.synced) {
        const up = await this.deps.updateCalculation(at.saved.id, columns);
        if (up.error || !up.data) {
          return { status: "save_failed", error: up.error?.message ?? "Не удалось обновить расчёт", charge: "kept" };
        }
        row = { id: up.data.id, synced: true, createdAt: up.data.created_at };
        calculationWrite = "update";
      } else {
        const ins = await this.deps.insertCalculation(columns);
        if (ins.error || !ins.data) {
          return { status: "save_failed", error: ins.error?.message ?? "Не удалось сохранить расчёт", charge: "kept" };
        }
        row = { id: ins.data.id, synced: true, createdAt: ins.data.created_at };
        calculationWrite = "insert";
      }
      at.saved = row;
      at.calcKey = key;

      // report_history — best-effort: не отменяет уже сохранённый расчёт. Повтор
      // дописывает только недостающую запись (historyKey ≠ key).
      let historyWrite: HistoryWrite = "written";
      let historyWarning: string | null = null;
      if (at.historyKey !== key) {
        const hist = await this.deps.insertReportHistory(accrualSnapshotToReportHistoryColumns(snapshot));
        if (hist.error) {
          historyWrite = "failed";
          historyWarning = `Расчёт сохранён, но сводка по месяцам не обновилась: ${hist.error.message}`;
        } else {
          at.historyKey = key;
        }
      }
      return {
        status: "saved",
        row,
        created: calculationWrite === "insert",
        local: false,
        calculationWrite,
        historyWrite,
        historyWarning,
        columns,
      };
    } finally {
      this.inFlight = false;
    }
  }
}
