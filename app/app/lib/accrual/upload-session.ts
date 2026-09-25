// ============================================================================
// Расчётная сессия загрузки «Отчёта по начислениям» (PR-3): проверка файла,
// разбор ручных вводов, оценка «результат + готовность». ЧИСТЫЕ функции без
// React/Supabase/сети — вся арифметика в ядре (profit-calc.ts) и снимке
// (snapshot.ts); здесь только склейка и перевод строк формы в числа.
// ============================================================================

import type { AccrualRow } from "./types";
import type { AccrualPeriod, AccrualParseError, AccrualWarning } from "../report-parsers/accrual-xlsx-parser";
import { computeAccrualProfit, type AccrualManualExpenses, type AccrualProfitCalc } from "./profit-calc";
import { buildAccrualSnapshot, type AccrualSnapshotV1 } from "./snapshot";
import { pluralRu } from "./format";
import type { CatalogEntry } from "../product-breakdown-calc";

// ---------------------------------------------------------------------------
// Файл
// ---------------------------------------------------------------------------

export type FileCheck = { ok: true } | { ok: false; message: string };

/** Проверка выбранного файла ДО чтения: расширение и пустота. Списания здесь нет и быть не может. */
export function validateAccrualFile(file: { name: string; size: number }): FileCheck {
  const name = file.name.trim();
  if (file.size <= 0) return { ok: false, message: "Файл пустой. Скачайте отчёт заново и загрузите его ещё раз." };
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "xlsx") return { ok: true };
  if (ext === "xls") {
    return { ok: false, message: "Формат .xls не поддерживается. Скачайте отчёт по начислениям в формате XLSX." };
  }
  if (ext === "csv") {
    return { ok: false, message: "CSV не поддерживается. Скачайте отчёт по начислениям в формате XLSX." };
  }
  if (ext === "pdf") {
    return {
      ok: false,
      message: "PDF для расчёта не нужен. Загрузите один файл — XLSX «Отчёт по начислениям».",
    };
  }
  return { ok: false, message: "Загрузите файл в формате XLSX — «Отчёт по начислениям» из личного кабинета Ozon." };
}

/** Сообщения об ошибках разбора для показа пользователю (без товарных данных). */
export function formatParseErrors(errors: readonly AccrualParseError[]): string[] {
  return errors.map((e) => {
    const parts = [e.message];
    if (e.rows && e.rows.length > 0) {
      parts.push(`Строки листа: ${e.rows.join(", ")}${e.count && e.count > e.rows.length ? " и др." : ""}.`);
    }
    return parts.join(" ");
  });
}

// ---------------------------------------------------------------------------
// Ручные вводы
// ---------------------------------------------------------------------------

export interface AccrualUploadInputs {
  taxPercent: string;
  packaging: string;
  deliveryToWarehouse: string;
  salary: string;
  other: string;
  /** «Реклама вне Ozon» — только расходы, не включённые в загруженный отчёт. */
  adsOutsideOzon: string;
}

export const EMPTY_ACCRUAL_INPUTS: AccrualUploadInputs = {
  taxPercent: "",
  packaging: "",
  deliveryToWarehouse: "",
  salary: "",
  other: "",
  adsOutsideOzon: "",
};

export type InputField = keyof AccrualUploadInputs;

function parseNonNegative(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, "").replace(",", ".");
  if (s === "") return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type ParsedInputs =
  | { ok: true; taxRatePercent: number; manualExpenses: Required<AccrualManualExpenses> }
  | { ok: false; errors: Partial<Record<InputField, string>> };

/** Строки формы → числа. Пустое поле = 0; нечисло/отрицательное → ошибка поля (а не молчаливый 0). */
export function parseUploadInputs(i: AccrualUploadInputs): ParsedInputs {
  const errors: Partial<Record<InputField, string>> = {};
  const tax = parseNonNegative(i.taxPercent);
  if (tax === null || tax > 100 || Math.abs(tax * 100 - Math.round(tax * 100)) > 1e-6) {
    errors.taxPercent = "Ставка налога — число от 0 до 100, не более двух знаков после запятой";
  }
  const money = (field: Exclude<InputField, "taxPercent">): number => {
    const v = parseNonNegative(i[field]);
    if (v === null) {
      errors[field] = "Введите неотрицательное число";
      return 0;
    }
    return v;
  };
  const packaging = money("packaging");
  const deliveryToWarehouse = money("deliveryToWarehouse");
  const salary = money("salary");
  const other = money("other");
  const adsOutsideOzon = money("adsOutsideOzon");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    taxRatePercent: tax as number,
    manualExpenses: { packaging, deliveryToWarehouse, salary, other, adsOutsideOzon },
  };
}

// ---------------------------------------------------------------------------
// Оценка: результат + готовность
// ---------------------------------------------------------------------------

/** То, что нужно от результата парсера (rows + период + предупреждения + сведения об источнике). */
export interface AccrualParsedReport {
  rows: readonly AccrualRow[];
  period: AccrualPeriod;
  warnings: readonly AccrualWarning[];
  sheet: string;
  rowCount: number;
}

export interface ProblemProduct {
  article: string;
  name: string;
  /** Нетто-количество, для которого нужна себестоимость. */
  netQuantity: number;
  /** not_in_catalog — товара нет в каталоге; cost_missing — есть, но себестоимость не указана (0). */
  reason: "not_in_catalog" | "cost_missing";
}

export interface Blocker {
  code: "cost_incomplete" | "unattributed_sales";
  message: string;
}

export type AccrualEvaluation =
  | { status: "input_error"; errors: Partial<Record<InputField, string>> }
  | { status: "calc_error"; code: string; message: string }
  | {
      status: "ok";
      calc: AccrualProfitCalc;
      snapshot: AccrualSnapshotV1;
      /** Товары, без себестоимости которых итог нельзя считать готовым. */
      problemProducts: ProblemProduct[];
      /** Причины, по которым результат нельзя сохранить как готовый. Пусто → можно сохранять. */
      blockers: Blocker[];
      /** Не блокирующие замечания (налог 0 %, неполный месяц и т.п.). */
      notes: string[];
      readyToSave: boolean;
    };

export interface EvaluateArgs {
  report: AccrualParsedReport;
  catalog: readonly CatalogEntry[];
  inputs: AccrualUploadInputs;
  /** ISO-время, которое попадёт в снимок. */
  generatedAt: string;
}

/**
 * Один проход: ручные вводы → ядро (computeAccrualProfit) → снимок. Итог,
 * товарные строки и сохраняемый снимок берутся из ОДНОГО результата ядра, поэтому
 * согласованы всегда. Нехватка себестоимости не подставляется нулём: готовность
 * (readyToSave) даёт само ядро.
 */
export function evaluateAccrual(args: EvaluateArgs): AccrualEvaluation {
  const parsed = parseUploadInputs(args.inputs);
  if (!parsed.ok) return { status: "input_error", errors: parsed.errors };

  const res = computeAccrualProfit({
    report: { rows: args.report.rows, period: args.report.period },
    catalog: args.catalog,
    taxRatePercent: parsed.taxRatePercent,
    manualExpenses: parsed.manualExpenses,
  });
  if (!res.ok) return { status: "calc_error", code: res.error.code, message: res.error.message };

  const calc = res.calc;
  const snapshot = buildAccrualSnapshot({
    calc,
    period: args.report.period,
    warnings: args.report.warnings,
    source: { sheet: args.report.sheet, rowCount: args.report.rowCount },
    generatedAt: args.generatedAt,
  });

  const problemProducts: ProblemProduct[] = calc.products
    .filter((p) => p.costRequired && !p.hasCost)
    .map((p) => ({
      article: p.article,
      name: p.name,
      netQuantity: p.netQuantity,
      reason: p.matched ? "cost_missing" : "not_in_catalog",
    }));

  const blockers: Blocker[] = [];
  const cc = calc.costCoverage;
  if (cc.missingCost > 0) {
    blockers.push({
      code: "cost_incomplete",
      message: `У ${cc.missingCost} из ${cc.requiredProducts} ${pluralRu(cc.requiredProducts, "товара", "товаров", "товаров")} нет себестоимости в каталоге — результат предварительный.`,
    });
  }
  if (cc.unattributedNetQuantity !== 0) {
    blockers.push({
      code: "unattributed_sales",
      message: "В отчёте есть продажи или возвраты без артикула — себестоимость по ним посчитать нельзя.",
    });
  }

  const notes: string[] = [];
  if (calc.taxRatePercent === 0) notes.push("Налог не указан (0 %) — итоговая прибыль может быть завышена.");
  if (!calc.period.periodComplete) notes.push("Отчёт охватывает не весь календарный месяц — итоги неполные.");

  return {
    status: "ok",
    calc,
    snapshot,
    problemProducts,
    blockers,
    notes,
    readyToSave: calc.readyToSave && blockers.length === 0,
  };
}
