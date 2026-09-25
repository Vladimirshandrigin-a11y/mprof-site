"use client";

// ============================================================================
// Сессия загрузки «Отчёта по начислениям» (PR-3). Хук живёт в page.tsx, поэтому
// разобранный файл, ручные вводы и состояние оплаты/сохранения ПЕРЕЖИВАЮТ
// переключение вкладок (например, переход в «Каталог» за себестоимостью и
// возврат — повторная проверка того же файла без новой загрузки).
//
// Вся арифметика — в ядре (upload-session.evaluateAccrual → computeAccrualProfit);
// списание и запись — в AccrualSaveController (save-flow.ts). Хук только держит
// состояние и связывает их с UI. Файл читается в браузере и на сервер не уходит:
// сохраняется лишь снимок результата.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccrualSaveController,
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
  validateAccrualFile,
  type AccrualEvaluation,
  type AccrualParsedReport,
  type AccrualUploadInputs,
  type InputField,
} from "./upload-session";
import type { AccrualSnapshotV1 } from "./snapshot";
import type { CatalogEntry } from "../product-breakdown-calc";
import type { AccrualParseResult } from "../report-parsers/accrual-xlsx-parser";

/** Внешние сервисы. По умолчанию — реальные (supabase-cloud, парсер, PDF); в preview/тестах подменяются. */
export interface AccrualUploadServices {
  parseFile(file: File): Promise<AccrualParseResult>;
  loadCatalog(userId: string): Promise<{ entries: CatalogEntry[]; error: string | null }>;
  insertCalculation(cols: AccrualCalculationColumns, userId: string): Promise<CloudResult<CloudRow>>;
  updateCalculation(id: string, cols: AccrualCalculationColumns, userId: string): Promise<CloudResult<CloudRow>>;
  insertReportHistory(cols: AccrualReportHistoryColumns, userId: string): Promise<CloudResult<unknown>>;
  downloadPdf(snapshot: AccrualSnapshotV1): Promise<void>;
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
};

/** Сервисы с учётом подмены из опций (preview/тесты). */
function resolveServices(o: AccrualUploadSessionOptions): AccrualUploadServices {
  return { ...DEFAULT_SERVICES, ...o.services };
}

/** Ключ «содержимого» снимка без времени формирования — чтобы отличать правки вводов. */
function snapshotKey(s: AccrualSnapshotV1): string {
  return JSON.stringify({ ...s, generatedAt: null });
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
  /** Попытка списана, но расчёт не записан (повтор сохранения не спишет снова). */
  creditHeld: boolean;
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
  const [inputs, setInputs] = useState<AccrualUploadInputs>({ ...EMPTY_ACCRUAL_INPUTS });
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<SaveNote | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [creditHeld, setCreditHeld] = useState(false);
  const [needsRetry, setNeedsRetry] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const reqRef = useRef(0);
  const savingRef = useRef(false);

  const toast = (m: string, t: "ok" | "warn" | "err") => optsRef.current.showToast?.(m, t);

  const loadCatalogFor = async (req: number): Promise<void> => {
    const userId = optsRef.current.userId;
    if (!userId) {
      setCatalog({ status: "idle", entries: [], error: null });
      return;
    }
    setCatalog((c) => ({ ...c, status: "loading", error: null }));
    let res: { entries: CatalogEntry[]; error: string | null };
    try {
      res = await resolveServices(optsRef.current).loadCatalog(userId);
    } catch (e) {
      res = { entries: [], error: e instanceof Error ? e.message : "Не удалось загрузить каталог" };
    }
    if (req !== reqRef.current) return;
    setCatalog(
      res.error
        ? { status: "error", entries: [], error: res.error }
        : { status: "ready", entries: res.entries, error: null }
    );
  };

  const chooseFile = async (f: File | null | undefined): Promise<void> => {
    if (!f) return;
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
    const controller = getController();
    controller.startNewFile();
    setCreditHeld(controller.state.paid);
    setNeedsRetry(false);
    setSavedKey(null);
    setFile({ name: f.name, size: f.size });
    setParsed(null);
    setErrors([]);
    setPhase("reading");
    setCatalog({ status: "idle", entries: [], error: null });

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
    setParsed({
      rows: res.report.rows,
      period: res.report.period,
      warnings: res.warnings,
      sheet: res.report.sheetName,
      rowCount: res.report.summary.rowCount,
    });
    setParsedAt(new Date().toISOString());
    setPhase("ready");
    await loadCatalogFor(req);
  };

  const clearFile = () => {
    reqRef.current++;
    const controller = getController();
    controller.startNewFile();
    setCreditHeld(controller.state.paid);
    setNeedsRetry(false);
    setFile(null);
    setParsed(null);
    setErrors([]);
    setPhase("idle");
    setCatalog({ status: "idle", entries: [], error: null });
    setSavedKey(null);
    setSaveNote(null);
  };

  const refreshCatalog = async (): Promise<void> => {
    if (!parsed) return;
    await loadCatalogFor(reqRef.current);
  };

  const setInput = (field: InputField, value: string) => setInputs((prev) => ({ ...prev, [field]: value }));

  const evaluation = useMemo<AccrualEvaluation | null>(() => {
    if (!parsed) return null;
    if (catalog.status === "loading" || catalog.status === "error") return null;
    return evaluateAccrual({ report: parsed, catalog: catalog.entries, inputs, generatedAt: parsedAt });
  }, [parsed, catalog, inputs, parsedAt]);

  const currentKey = evaluation && evaluation.status === "ok" ? snapshotKey(evaluation.snapshot) : null;
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
    try {
      const o = optsRef.current;
      const controller = getController();
      const st = controller.state;
      if (st.saved && !o.isRowPresent(st.saved.id)) controller.forgetSaved();
      const out = await controller.save({ snapshot: ev.snapshot, ready: ev.readyToSave, userId: o.userId });
      setCreditHeld(controller.state.paid && controller.state.saved === null);
      switch (out.status) {
        case "busy":
          break;
        case "not_ready":
          setSaveNote({ kind: "warn", text: out.reason });
          break;
        case "cancelled":
          setSaveNote({ kind: "warn", text: "Сохранение отменено. Попытка расчёта не списана, запись не создана." });
          break;
        case "paywall":
          setSaveNote({
            kind: "warn",
            text: out.reason
              ? `Не удалось списать попытку расчёта (${out.reason}). Расчёт не сохранён, попытка не списана.`
              : "Нет доступной попытки расчёта. Расчёт не сохранён, попытка не списана.",
          });
          o.onPaywall();
          break;
        case "save_failed":
          setNeedsRetry(true);
          setSaveNote({
            kind: "err",
            text: `Не удалось сохранить расчёт: ${out.error}. Попытка расчёта уже списана и закреплена за этим расчётом — повторное сохранение не спишет её снова.`,
          });
          toast("Не удалось сохранить расчёт", "err");
          break;
        case "saved":
          setNeedsRetry(out.historyWarning !== null);
          setSavedKey(snapshotKey(ev.snapshot));
          setSaveNote(
            out.historyWarning
              ? { kind: "warn", text: out.historyWarning }
              : out.local
              ? { kind: "warn", text: "Расчёт сохранён только на этом устройстве: войдите в аккаунт, чтобы он попал в историю." }
              : { kind: "ok", text: out.created ? "Расчёт сохранён в историю." : "Изменения сохранены. Попытка не списывалась повторно." }
          );
          o.onSaved({
            row: out.row,
            columns: out.columns,
            created: out.created,
            local: out.local,
            historyRecorded: !out.local && out.historyWarning === null,
          });
          toast(out.local ? "Расчёт сохранён локально" : "Расчёт сохранён", out.local || out.historyWarning ? "warn" : "ok");
          break;
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const downloadPdf = async (): Promise<void> => {
    if (!evaluation || evaluation.status !== "ok" || pdfBusy) return;
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
    creditHeld,
    downloadPdf,
    pdfBusy,
  };
}
