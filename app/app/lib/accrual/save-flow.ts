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
//      не оставляет ни списания, ни частичных записей. Операция привязана к файлу:
//      попытка без отпечатка файла (beginAttempt не вызван) → save_failed ДО запроса.
//      Ключ операции (UUID) хранится у страницы (operationIdFor) до подтверждения:
//      потерянный ответ, двойной клик или перезагрузка → повтор с ТЕМ ЖЕ ключом
//      ничего не списывает и не пишет, а возвращает сохранённый снимок (restored) —
//      данные повтора не применяются, даже если отличаются. Расчёт этой операции
//      удалён из истории → deleted: заново не создаётся, попытка закрыта;
//   6. после сохранения — явная правка (ставка/расходы): обновление той же строки
//      calculations без списания; то же содержимое — ничего не пишется;
//   7. report_history при обновлении — best-effort: сбой даёт предупреждение и НЕ
//      отменяет сохранённый расчёт; повтор дописывает ТОЛЬКО недостающую запись.
// Аноним: списание через consume (localStorage у страницы), запись только локальная.
//
// Чтение файла, ошибка формата и отмена дубля происходят ДО операции — они её не
// вызывают. Двойной клик: пока идёт сохранение, повторный вызов возвращает busy;
// сменить попытку (файл) во время сохранения нельзя (beginAttempt → false).
// После перезагрузки тот же файл находит свою незавершённую операцию по ключу:
// страница спрашивает статус у сервера и, если расчёт уже сохранён, передаёт его
// в adoptSaved и показывает сохранённый снимок — без дубль-гарда, списания и записи.
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
  calculation: AccrualCalculationColumns;
  history: AccrualReportHistoryColumns;
}

export type CalculationOperationResult =
  /**
   * Операция выполнена. replay — выполнена раньше: ничего не списано и не записано;
   * snapshot — сохранённый снимок (null — не читается); contentMatch — данные повтора
   * совпали с сохранёнными (сервер сверяет отпечаток данных операции).
   */
  | { kind: "ok"; replay: boolean; row: CloudRow; snapshot: AccrualSnapshotV1 | null; contentMatch: boolean }
  /** Операция выполнена раньше, но расчёт удалён из истории: заново не создаётся. */
  | { kind: "deleted" }
  /** Сервер отказал в списании (нет попытки / нет сессии): ничего не записано. */
  | { kind: "refused"; reason: string }
  /** Ключ операции не совпадает с файлом или пользователем: ничего не записано. */
  | { kind: "conflict" }
  /** Сохранение недоступно (например, не применена миграция): ничего не записано. */
  | { kind: "unavailable"; message: string }
  /** Нет подтверждения: операция могла успеть сохраниться — повторять с тем же ключом. */
  | { kind: "failed"; message: string };

export type CalculationOperationStatus =
  /** Сохранён: снимок — как на сервере (показывается без пересчёта). */
  | { kind: "done"; row: CloudRow; snapshot: AccrualSnapshotV1 | null }
  /** Расчёт удалён из истории. */
  | { kind: "deleted" }
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
  /** Статус выполненной операции (удалён ли её расчёт из истории — решает сервер). */
  operationStatus(operationId: string, requestHash: string): Promise<CalculationOperationStatus>;
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
  /**
   * Операция этого файла выполнена раньше (повтор после потерянного ответа): ничего не
   * списано и не записано. Показывается СОХРАНЁННЫЙ снимок, а не текущий пересчёт;
   * contentMatch = false — сохранены другие значения, текущие не применены.
   */
  | { status: "restored"; row: SavedRef; snapshot: AccrualSnapshotV1 | null; contentMatch: boolean }
  /** Расчёт этой попытки удалён из истории: заново не создаётся, попытка закрыта. */
  | { status: "deleted" }
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
  /** Строки сохранённого расчёта нет в истории страницы (аккаунт: удалён ли — решает сервер). */
  savedRowMissing?: boolean;
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
  /** Ключ выполненной операции (после подтверждения сервером). */
  operationId: string | null;
}

const freshAttempt = (id: string | null): Attempt => ({
  id,
  paid: false,
  dupConfirmed: false,
  saved: null,
  calcKey: null,
  historyKey: null,
  operationId: null,
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
   * Операция этой попытки уже выполнена на сервере (восстановление после перезагрузки):
   * попытка оплачена и сохранена — без дубль-гарда, списания и записи. Что именно
   * сохранено, показывает снимок сервера; следующее «Сохранить» — только явная правка
   * (обновление той же строки без списания).
   */
  adoptSaved(
    attemptId: string,
    done: { row: CloudRow; operationId: string; snapshot: AccrualSnapshotV1 | null }
  ): boolean {
    const a = this.cur;
    if (this.inFlight || a.id !== attemptId || a.paid) return false;
    a.paid = true;
    a.dupConfirmed = true;
    a.saved = { id: done.row.id, synced: true, createdAt: done.row.created_at };
    // Записано то, что в снимке сервера (и в calculations, и в сводке операции).
    a.calcKey = a.historyKey = done.snapshot ? snapshotContentKey(done.snapshot) : null;
    a.operationId = done.operationId;
    return true;
  }

  /** Аноним: локальную запись удалили — следующая запись создаст новую (без нового списания). */
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

      // Аккаунт, первое сохранение: операция привязана к файлу. Без отпечатка файла
      // (попытка не начата) — понятная ошибка ДО запроса; идентичность не придумываем.
      if (userId && !at.paid && at.id === null) {
        return {
          status: "save_failed",
          error: "файл отчёта не определён — загрузите отчёт заново",
          charge: "none",
        };
      }

      // Аккаунт: строки сохранённого расчёта нет в истории страницы. Удалён ли он —
      // решает сервер (список страницы мог устареть); удалённый заново не создаётся.
      if (userId && at.saved && req.savedRowMissing && at.operationId !== null && at.id !== null) {
        const st = await this.deps.operationStatus(at.operationId, at.id);
        if (st.kind === "deleted") {
          this.cur = freshAttempt(at.id);
          return { status: "deleted" };
        }
        if (st.kind === "failed") {
          return { status: "save_failed", error: `не удалось проверить сохранённый расчёт: ${st.message}`, charge: "kept" };
        }
      }

      const key = snapshotContentKey(snapshot);

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
        const attemptId = at.id;
        if (attemptId === null) {
          return { status: "save_failed", error: "файл отчёта не определён — загрузите отчёт заново", charge: "none" };
        }
        const operationId = this.deps.operationIdFor(attemptId);
        const op = await this.deps.saveOperation({
          operationId,
          requestHash: attemptId,
          calculation: columns,
          history: accrualSnapshotToReportHistoryColumns(snapshot),
        });
        switch (op.kind) {
          case "refused":
            at.dupConfirmed = false;
            return { status: "paywall", reason: op.reason };
          case "conflict":
            // Сохранённый ключ относится к другому файлу: следующий раз — новый ключ.
            this.deps.operationSettled(attemptId);
            return {
              status: "save_failed",
              error: "ключ операции не совпадает с этим файлом",
              charge: "none",
            };
          case "unavailable":
            return { status: "save_failed", error: op.message, charge: "none" };
          case "failed":
            return { status: "save_failed", error: op.message, charge: "unknown" };
          case "deleted":
            // Операция выполнена раньше, её расчёт удалён из истории: не восстанавливаем.
            this.deps.operationSettled(attemptId);
            this.cur = freshAttempt(attemptId);
            return { status: "deleted" };
        }
        at.paid = true;
        at.operationId = operationId;
        this.deps.operationSettled(attemptId);
        at.saved = { id: op.row.id, synced: true, createdAt: op.row.created_at };
        if (op.replay) {
          // Сохранено раньше этой же операцией: на сервере — её снимок, а не текущий ввод.
          at.calcKey = at.historyKey = op.snapshot ? snapshotContentKey(op.snapshot) : null;
          return { status: "restored", row: at.saved, snapshot: op.snapshot, contentMatch: op.contentMatch };
        }
        at.calcKey = key;
        at.historyKey = key;
        return {
          status: "saved",
          row: at.saved,
          created: true,
          local: false,
          calculationWrite: "insert",
          historyWrite: "written",
          historyWarning: null,
          columns,
        };
      }

      // Явная правка уже сохранённого расчёта: та же строка, без списания.
      if (!at.saved?.synced) {
        // У оплаченной попытки аккаунта строка есть всегда; удалённая заново не создаётся.
        return { status: "save_failed", error: "сохранённый расчёт не найден", charge: "kept" };
      }
      let row: SavedRef;
      let calculationWrite: CalculationWrite;
      if (at.calcKey === key) {
        // calculations уже содержит именно этот результат (сбой был на сводке) — не пишем второй раз.
        row = at.saved;
        calculationWrite = "none";
      } else {
        const up = await this.deps.updateCalculation(at.saved.id, columns);
        if (up.error || !up.data) {
          return { status: "save_failed", error: up.error?.message ?? "Не удалось обновить расчёт", charge: "kept" };
        }
        row = { id: up.data.id, synced: true, createdAt: up.data.created_at };
        calculationWrite = "update";
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
        created: false,
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
