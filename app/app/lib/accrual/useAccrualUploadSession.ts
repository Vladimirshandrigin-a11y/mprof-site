"use client";

// ============================================================================
// Сессия загрузки «Отчёта по начислениям» (PR-3). Хук живёт в page.tsx, поэтому
// разобранный файл, ручные вводы и состояние оплаты/сохранения ПЕРЕЖИВАЮТ
// переключение вкладок (например, переход в «Каталог» за себестоимостью и
// возврат — повторная проверка того же файла без новой загрузки).
//
// Вся арифметика — в ядре (upload-session.evaluateAccrual → computeAccrualProfit);
// списание и запись — в AccrualSaveController (save-flow.ts). Хук только держит
// состояние и связывает их с UI. Файл читается в браузере и на сервер не уходит: на
// сервер попадают снимок результата и — для автодобавления в каталог — только артикулы,
// SKU и названия отсутствующих товаров (не строки отчёта и не суммы).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccrualSaveController,
  snapshotContentKey,
  type AccrualSaveDeps,
  type CloudResult,
  type CloudRow,
  type ConsumeResult,
  type SavedRef,
} from "./save-flow";
import type { AccrualCalculationColumns, AccrualReportHistoryColumns } from "./columns";
import {
  EMPTY_ACCRUAL_INPUTS,
  evaluateAccrual,
  formatParseErrors,
  accrualMissingCatalogCandidates,
  reportFingerprint,
  resultAccess,
  saveOutcomeUi,
  validateAccrualFile,
  type AccrualEvaluation,
  type AccrualParsedReport,
  type AccrualUploadInputs,
  type InputField,
  type ResultAccess,
} from "./upload-session";
import type { AccrualSnapshotV1 } from "./snapshot";
import type { CatalogEntry } from "../product-breakdown-calc";
import type { CatalogCandidate } from "./upload-session";
import type { CatalogImportOutcome } from "../supabase-cloud";
import type { AccrualParseResult } from "../report-parsers/accrual-xlsx-parser";

/** Внешние сервисы. По умолчанию — реальные (supabase-cloud, парсер, PDF); в preview/тестах подменяются. */
export interface AccrualUploadServices {
  parseFile(file: File): Promise<AccrualParseResult>;
  loadCatalog(userId: string): Promise<{ entries: CatalogEntry[]; error: string | null }>;
  insertCalculation(cols: AccrualCalculationColumns, userId: string): Promise<CloudResult<CloudRow>>;
  updateCalculation(id: string, cols: AccrualCalculationColumns, userId: string): Promise<CloudResult<CloudRow>>;
  insertReportHistory(cols: AccrualReportHistoryColumns, userId: string): Promise<CloudResult<unknown>>;
  downloadPdf(snapshot: AccrualSnapshotV1): Promise<void>;
  /** Добавить в каталог отсутствующие товары (сервер, единая точка импорта). */
  importMissingProducts(items: readonly CatalogCandidate[]): Promise<{ data: CatalogImportOutcome | null; error: string | null }>;
}

export interface AccrualSavedEvent {
  row: SavedRef;
  columns: AccrualCalculationColumns;
  created: boolean;
  /** Только локально (нет входа в аккаунт). */
  local: boolean;
  /** report_history записан — можно обновить «Аналитику по месяцам». */
  historyRecorded: boolean;
}

export interface AccrualUploadSessionOptions {
  userId: string | null;
  /** Право на ещё одну попытку (paywall). */
  canCalculate: boolean;
  consumeCalculation: () => Promise<ConsumeResult>;
  confirmNoMonthDuplicate: (monthKey: string | null) => Promise<boolean>;
  /** Открыть окно тарифов (нет попытки / списание отклонено). */
  onPaywall: () => void;
  onSaved: (e: AccrualSavedEvent) => void;
  /** Каталог изменился (автодобавление) — обновить открытые списки каталога. */
  onCatalogChanged?: () => void;
  /** Строка с таким id ещё есть в истории (иначе следующая запись создаст новую). */
  isRowPresent: (id: string) => boolean;
  showToast?: (message: string, type: "ok" | "warn" | "err") => void;
  services?: Partial<AccrualUploadServices>;
}

export type CatalogState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: CatalogEntry[];
  error: string | null;
};

export type SaveNote = { kind: "ok" | "warn" | "err"; text: string };

/**
 * Автодобавление отсутствующих товаров в каталог: состояние для экрана. «Успех» есть
 * только когда сервер подтвердил запись; при ошибке показывается error, а не добавление.
 */
export type CatalogImportState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; created: number; ambiguous: number }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Сервисы по умолчанию: реальные, но подключаются лениво (без Supabase в SSR/тестах).
// ---------------------------------------------------------------------------
const DEFAULT_SERVICES: AccrualUploadServices = {
  async parseFile(file) {
    const { parseAccrualXlsx } = await import("../report-parsers/accrual-xlsx-parser");
    return parseAccrualXlsx(file);
  },
  async loadCatalog(userId) {
    const { loadProductsFromCloud } = await import("../supabase-cloud");
    const { data, error } = await loadProductsFromCloud(userId);
    if (error) return { entries: [], error: error.message };
    return {
      entries: (data ?? []).map((p) => ({ sku: p.sku, name: p.name, cost_price: Number(p.cost_price) })),
      error: null,
    };
  },
  async insertCalculation(cols, userId) {
    const { saveCalculationToCloud } = await import("../supabase-cloud");
    const r = await saveCalculationToCloud(cols, userId);
    return { data: r.data ? { id: r.data.id, created_at: r.data.created_at } : null, error: r.error };
  },
  async updateCalculation(id, cols, userId) {
    const { updateCalculationInCloud } = await import("../supabase-cloud");
    const r = await updateCalculationInCloud(id, cols, userId);
    return { data: r.data ? { id: r.data.id, created_at: r.data.created_at } : null, error: r.error };
  },
  async insertReportHistory(cols, userId) {
    const { saveReportHistoryToCloud } = await import("../supabase-cloud");
    return saveReportHistoryToCloud(cols, userId);
  },
  async downloadPdf(snapshot) {
    const { downloadAccrualPdf } = await import("./pdf-render");
    await downloadAccrualPdf(snapshot);
  },
  async importMissingProducts(items) {
    const { importMissingProductsToCloud } = await import("../supabase-cloud");
    const r = await importMissingProductsToCloud(items);
    return { data: r.data, error: r.error ? r.error.message : null };
  },
};

/** Сервисы с учётом подмены из опций (preview/тесты). */
function resolveServices(o: AccrualUploadSessionOptions): AccrualUploadServices {
  return { ...DEFAULT_SERVICES, ...o.services };
}

function makeLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return "local-" + crypto.randomUUID();
  return "local-" + Math.random().toString(36).slice(2, 10);
}

export interface AccrualUploadSession {
  file: { name: string; size: number } | null;
  phase: "idle" | "reading" | "ready" | "error";
  errors: string[];
  parsed: AccrualParsedReport | null;
  catalog: CatalogState;
  /** Автодобавление отсутствующих товаров в каталог (после разбора файла). */
  catalogImport: CatalogImportState;
  inputs: AccrualUploadInputs;
  setInput: (field: InputField, value: string) => void;
  /** null — расчёта нет (нет файла, идёт загрузка каталога, ошибка каталога). */
  evaluation: AccrualEvaluation | null;
  chooseFile: (file: File | null | undefined) => Promise<void>;
  /** Убрать файл: сбрасывает загруженные данные (удержанная неиспользованная попытка сохраняется). */
  clearFile: () => void;
  refreshCatalog: () => Promise<void>;
  save: () => Promise<void>;
  saving: boolean;
  saveNote: SaveNote | null;
  /** Расчёт уже записан в историю. */
  saved: boolean;
  /** Введённые значения изменились после последнего сохранения. */
  dirty: boolean;
  /** Последнее сохранение не завершилось полностью (ошибка записи или сводки) — доступен повтор. */
  needsRetry: boolean;
  /**
   * Что открыто пользователю: полный результат и PDF — только после списания попытки
   * ЭТОГО файла (consume прошёл). Проверка файла и себестоимости — без списания.
   */
  access: ResultAccess;
  /** Попытка ЭТОГО файла списана, но расчёт не записан (повтор сохранения не спишет снова). */
  creditHeld: boolean;
  /** Сколько списанных, но не записанных попыток ждут ДРУГИХ файлов (эти файлы не наследуют списание). */
  otherHeldCredits: number;
  downloadPdf: () => Promise<void>;
  pdfBusy: boolean;
}

export function useAccrualUploadSession(opts: AccrualUploadSessionOptions): AccrualUploadSession {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Контроллер создаётся лениво в обработчике (не во время рендера) и живёт в ref.
  const controllerRef = useRef<AccrualSaveController | null>(null);
  const getController = (): AccrualSaveController => {
    if (!controllerRef.current) {
      controllerRef.current = new AccrualSaveController({
        canCalculate: () => optsRef.current.canCalculate,
        confirmNoMonthDuplicate: (m) => optsRef.current.confirmNoMonthDuplicate(m),
        consume: () => optsRef.current.consumeCalculation(),
        insertCalculation: (cols) =>
          resolveServices(optsRef.current).insertCalculation(cols, optsRef.current.userId ?? ""),
        updateCalculation: (id, cols) =>
          resolveServices(optsRef.current).updateCalculation(id, cols, optsRef.current.userId ?? ""),
        insertReportHistory: (cols) =>
          resolveServices(optsRef.current).insertReportHistory(cols, optsRef.current.userId ?? ""),
        newLocalId: makeLocalId,
        nowIso: () => new Date().toISOString(),
      } satisfies AccrualSaveDeps);
    }
    return controllerRef.current;
  };

  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "ready" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const [parsed, setParsed] = useState<AccrualParsedReport | null>(null);
  const [parsedAt, setParsedAt] = useState<string>("");
  const [catalog, setCatalog] = useState<CatalogState>({ status: "idle", entries: [], error: null });
  const [catalogImport, setCatalogImport] = useState<CatalogImportState>({ status: "idle" });
  const [inputs, setInputs] = useState<AccrualUploadInputs>({ ...EMPTY_ACCRUAL_INPUTS });
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<SaveNote | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [creditHeld, setCreditHeld] = useState(false);
  const [attemptPaid, setAttemptPaid] = useState(false);
  const [otherHeldCredits, setOtherHeldCredits] = useState(0);
  const [needsRetry, setNeedsRetry] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const reqRef = useRef(0);
  const savingRef = useRef(false);

  const toast = (m: string, t: "ok" | "warn" | "err") => optsRef.current.showToast?.(m, t);

  const loadCatalogFor = async (req: number): Promise<CatalogEntry[] | null> => {
    const userId = optsRef.current.userId;
    if (!userId) {
      setCatalog({ status: "idle", entries: [], error: null });
      return null;
    }
    setCatalog((c) => ({ ...c, status: "loading", error: null }));
    let res: { entries: CatalogEntry[]; error: string | null };
    try {
      res = await resolveServices(optsRef.current).loadCatalog(userId);
    } catch (e) {
      res = { entries: [], error: e instanceof Error ? e.message : "Не удалось загрузить каталог" };
    }
    if (req !== reqRef.current) return null;
    setCatalog(
      res.error
        ? { status: "error", entries: [], error: res.error }
        : { status: "ready", entries: res.entries, error: null }
    );
    return res.error ? null : res.entries;
  };

  /**
   * Автодобавление: товары, которых нет в каталоге и чья себестоимость нужна для расчёта,
   * уходят на сервер ОДНИМ запросом (только артикул/SKU/название) и попадают в каталог без
   * себестоимости. Затем каталог перечитывается — экран и повторная проверка видят обновлённый
   * список. Ошибка не маскируется под успех; повтор («Проверить снова») безопасен: сервер не
   * дублирует и не перезаписывает существующие товары. Расчёт при этом НЕ выполняется и НЕ
   * списывается — неполная себестоимость по-прежнему блокирует расчёт и сохранение.
   */
  const autoImportFor = async (req: number, report: AccrualParsedReport, entries: CatalogEntry[]): Promise<void> => {
    const o = optsRef.current;
    if (!o.userId) return;
    const items = accrualMissingCatalogCandidates(report.rows, entries);
    if (items.length === 0) {
      setCatalogImport((c) => (c.status === "error" ? { status: "idle" } : c));
      return;
    }
    setCatalogImport({ status: "running" });
    setCatalog({ status: "loading", entries, error: null });
    let res: { data: CatalogImportOutcome | null; error: string | null };
    try {
      res = await resolveServices(o).importMissingProducts(items);
    } catch (e) {
      res = { data: null, error: e instanceof Error ? e.message : "Не удалось связаться с сервером" };
    }
    if (req !== reqRef.current) return;
    if (res.error || !res.data) {
      setCatalog({ status: "ready", entries, error: null });
      setCatalogImport({ status: "error", message: res.error || "Сервер не подтвердил добавление товаров" });
      return;
    }
    const outcome = res.data;
    setCatalogImport((c) => ({
      status: "done",
      created: outcome.created + (c.status === "done" ? c.created : 0),
      ambiguous: outcome.ambiguous,
    }));
    if (outcome.created > 0) optsRef.current.onCatalogChanged?.();
    await loadCatalogFor(req);
  };

  /** Подтянуть в состояние экрана то, что известно контроллеру о текущей и «чужих» попытках. */
  const syncAttemptState = (controller: AccrualSaveController): void => {
    const st = controller.state;
    setAttemptPaid(st.paid);
    setCreditHeld(st.paid && st.saved === null);
    setOtherHeldCredits(controller.heldElsewhere);
  };

  const chooseFile = async (f: File | null | undefined): Promise<void> => {
    if (!f) return;
    if (savingRef.current) {
      // Сменить файл посреди сохранения нельзя: запись ушла бы в чужой расчёт.
      setSaveNote({ kind: "warn", text: "Дождитесь завершения сохранения, затем выберите другой файл." });
      return;
    }
    const req = ++reqRef.current;
    setSaveNote(null);
    const check = validateAccrualFile(f);
    if (!check.ok) {
      setFile({ name: f.name, size: f.size });
      setParsed(null);
      setPhase("error");
      setErrors([check.message]);
      return;
    }
    // Другой файл — другая попытка: она НЕ наследует отметку «списано» прежней. Списанная,
    // но не записанная попытка прежнего файла остаётся за ним (вернётся вместе с файлом).
    const controller = getController();
    controller.beginAttempt(null);
    syncAttemptState(controller);
    setNeedsRetry(false);
    setSavedKey(null);
    setFile({ name: f.name, size: f.size });
    setParsed(null);
    setErrors([]);
    setPhase("reading");
    setCatalog({ status: "idle", entries: [], error: null });
    setCatalogImport({ status: "idle" });

    let res: AccrualParseResult;
    try {
      res = await resolveServices(optsRef.current).parseFile(f);
    } catch {
      res = {
        ok: false,
        warnings: [],
        errors: [{ code: "read_failed", message: "Не удалось прочитать файл. Попробуйте скачать отчёт заново." }],
      };
    }
    if (req !== reqRef.current) return;
    if (!res.ok) {
      setPhase("error");
      setErrors(formatParseErrors(res.errors));
      return;
    }
    const report: AccrualParsedReport = {
      rows: res.report.rows,
      period: res.report.period,
      warnings: res.warnings,
      sheet: res.report.sheetName,
      rowCount: res.report.summary.rowCount,
    };
    // Тот же файл, что уже был списан, но не записан, возвращает СВОЮ попытку (без нового списания).
    controller.beginAttempt(reportFingerprint(report));
    syncAttemptState(controller);
    setNeedsRetry(controller.state.paid && controller.state.saved === null);
    setParsed(report);
    setParsedAt(new Date().toISOString());
    setPhase("ready");
    const entries = await loadCatalogFor(req);
    if (entries) await autoImportFor(req, report, entries);
  };

  const clearFile = () => {
    if (savingRef.current) {
      setSaveNote({ kind: "warn", text: "Дождитесь завершения сохранения, затем уберите файл." });
      return;
    }
    reqRef.current++;
    const controller = getController();
    controller.beginAttempt(null);
    syncAttemptState(controller);
    setNeedsRetry(false);
    setFile(null);
    setParsed(null);
    setErrors([]);
    setPhase("idle");
    setCatalog({ status: "idle", entries: [], error: null });
    setCatalogImport({ status: "idle" });
    setSavedKey(null);
    setSaveNote(null);
  };

  const refreshCatalog = async (): Promise<void> => {
    if (!parsed) return;
    const req = reqRef.current;
    const entries = await loadCatalogFor(req);
    // Повторная проверка: каталог перечитан; если товары так и не добавлены (ошибка импорта) —
    // пробуем ещё раз. Уже добавленные сервер пропустит.
    if (entries) await autoImportFor(req, parsed, entries);
  };

  const setInput = (field: InputField, value: string) => setInputs((prev) => ({ ...prev, [field]: value }));

  const evaluation = useMemo<AccrualEvaluation | null>(() => {
    if (!parsed) return null;
    if (catalog.status === "loading" || catalog.status === "error") return null;
    return evaluateAccrual({ report: parsed, catalog: catalog.entries, inputs, generatedAt: parsedAt });
  }, [parsed, catalog, inputs, parsedAt]);

  const currentKey = evaluation && evaluation.status === "ok" ? snapshotContentKey(evaluation.snapshot) : null;
  const saved = savedKey !== null;
  const dirty = saved && currentKey !== null && currentKey !== savedKey;

  const save = async (): Promise<void> => {
    if (savingRef.current) return; // двойной клик
    if (!parsed || catalog.status === "loading" || catalog.status === "error") return;
    // Итог считается заново из ТЕКУЩИХ вводов и каталога — сохраняется ровно то, что на экране.
    const ev = evaluateAccrual({ report: parsed, catalog: catalog.entries, inputs, generatedAt: new Date().toISOString() });
    if (ev.status !== "ok") return;
    savingRef.current = true;
    setSaving(true);
    setSaveNote(null);
    const controller = getController();
    try {
      const o = optsRef.current;
      const st = controller.state;
      if (st.saved && !o.isRowPresent(st.saved.id)) controller.forgetSaved();
      const out = await controller.save({ snapshot: ev.snapshot, ready: ev.readyToSave, userId: o.userId });
      syncAttemptState(controller);
      // Что показать — решает чистая saveOutcomeUi (покрыта тестами); хук только применяет.
      const ui = saveOutcomeUi(out);
      if (ui.needsRetry !== null) setNeedsRetry(ui.needsRetry);
      if (ui.markSaved) setSavedKey(snapshotContentKey(ev.snapshot));
      setSaveNote(ui.note);
      if (ui.openPaywall) o.onPaywall();
      if (ui.emitSaved && out.status === "saved") {
        o.onSaved({
          row: out.row,
          columns: out.columns,
          created: out.created,
          local: out.local,
          historyRecorded: ui.historyRecorded,
        });
      }
      if (ui.toast) toast(ui.toast.text, ui.toast.type);
    } catch (e) {
      // Исключение из сервиса не должно оставить экран «закрытым» при уже списанной попытке.
      console.error("[accrual] save", e);
      setNeedsRetry(true);
      setSaveNote({
        kind: "err",
        text: "Не удалось выполнить сохранение. Если попытка уже списана, повтор не спишет её снова.",
      });
    } finally {
      syncAttemptState(controller);
      savingRef.current = false;
      setSaving(false);
    }
  };

  const access = resultAccess(attemptPaid, evaluation);

  const downloadPdf = async (): Promise<void> => {
    // PDF — часть готового результата: без списанной попытки этого файла не выдаём.
    if (!evaluation || evaluation.status !== "ok" || pdfBusy) return;
    if (!resultAccess(getController().state.paid, evaluation).pdfAllowed) return;
    setPdfBusy(true);
    try {
      await resolveServices(optsRef.current).downloadPdf(evaluation.snapshot);
      toast("PDF-отчёт сформирован", "ok");
    } catch (e) {
      console.error("[pdf] downloadAccrualPdf", e);
      toast("Не удалось сформировать PDF", "err");
    } finally {
      setPdfBusy(false);
    }
  };

  return {
    file,
    phase,
    errors,
    parsed,
    catalog,
    catalogImport,
    inputs,
    setInput,
    evaluation,
    chooseFile,
    clearFile,
    refreshCatalog,
    save,
    saving,
    saveNote,
    saved,
    dirty,
    needsRetry,
    access,
    creditHeld,
    otherHeldCredits,
    downloadPdf,
    pdfBusy,
  };
}
