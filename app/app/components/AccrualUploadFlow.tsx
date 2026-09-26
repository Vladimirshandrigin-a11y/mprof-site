"use client";

// ============================================================================
// AccrualUploadFlow — «Расчёт по отчёту начислений Ozon»: один слот XLSX вместо
// прежних двух (отчёт о реализации + УПД). Только интерфейс: состояние, разбор,
// каталог, расчёт, списание и сохранение живут в useAccrualUploadSession (хук в
// page.tsx — состояние переживает переключение вкладок), арифметика — в ядре.
//
// Переиспользованы готовые компоненты: AccrualSnapshotView (итог, разбивка, PDF),
// OzonProductBreakdown (товарная аналитика, лучший/убыточный) и глобальные классы
// страницы (upload-3-*, profit-calc, fld, calc-check).
// ============================================================================

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { AccrualSnapshotView } from "./AccrualSnapshotView";
import type { AccrualUploadSession } from "../lib/accrual/useAccrualUploadSession";
import type { InputField } from "../lib/accrual/upload-session";
import { fmtDateRange, fmtMonthLabel, pluralRu } from "../lib/accrual/format";
import { ACCRUAL_DOWNLOAD_STEPS } from "../lib/accrual/download-guide";

const FIELDS: { key: InputField; label: string; unit: "₽" | "%"; hint?: string }[] = [
  { key: "taxPercent", label: "Налог", unit: "%", hint: "Ваша ставка налога. База — выручка после возвратов." },
  { key: "packaging", label: "Упаковка", unit: "₽" },
  { key: "deliveryToWarehouse", label: "Доставка до склада", unit: "₽" },
  { key: "salary", label: "Зарплата / подрядчики", unit: "₽" },
  { key: "other", label: "Прочие расходы", unit: "₽" },
  {
    key: "adsOutsideOzon",
    label: "Реклама вне Ozon",
    unit: "₽",
    hint: "Вводите только расходы, не включённые в загруженный отчёт. Реклама Ozon уже учтена в начислениях — повторно её вводить не нужно.",
  },
];

const PROBLEM_LIMIT = 10;

/** «M-PROF» не переносим по дефису на узком экране. */
function withBrand(text: string): ReactNode {
  const parts = text.split("M-PROF");
  if (parts.length === 1) return text;
  return parts.flatMap((part, i) =>
    i === 0 ? [part] : [<span className="accr-nobr" key={i}>M-PROF</span>, part]
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

interface Props {
  session: AccrualUploadSession;
  /** Перейти во вкладку «Каталог товаров». */
  onOpenCatalog: () => void;
  /** Войти нужно, чтобы подтянуть каталог (гость). */
  signedIn: boolean;
}

export function AccrualUploadFlow({ session: s, onOpenCatalog, signedIn }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [drag, setDrag] = useState(false);

  const pick = () => inputRef.current?.click();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 1) {
      void s.chooseFile(null);
      // несколько файлов: берём первый, остальное игнорируем — один слот
    }
    void s.chooseFile(files?.[0] ?? null);
  };

  const ev = s.evaluation;
  const ok = ev && ev.status === "ok" ? ev : null;
  const fieldErrors = ev && ev.status === "input_error" ? ev.errors : {};
  const period = s.parsed?.period;
  const access = s.access;

  // Проверка готовности — бесплатна и видна ДО списания; сохранение = расчёт (списание + запись).
  const readiness = ok ? (
    <div className="calc-check">
      <div className="calc-check-title">Проверка расчёта</div>
      <div className="calc-check-list">
        <div className="calc-check-row ok">
          <span className="calc-check-ico">✓</span>
          <div className="calc-check-body">
            <div className="calc-check-line">
              <span className="calc-check-label">Отчёт по начислениям прочитан</span>
              <span className="calc-check-val">{s.parsed?.rowCount} строк</span>
            </div>
          </div>
        </div>
        <div className={"calc-check-row " + (ok.snapshot.period.periodComplete ? "ok" : "warn")}>
          <span className="calc-check-ico">{ok.snapshot.period.periodComplete ? "✓" : "⚠"}</span>
          <div className="calc-check-body">
            <div className="calc-check-line">
              <span className="calc-check-label">Период: {fmtMonthLabel(ok.snapshot.period.month)}</span>
            </div>
            {!ok.snapshot.period.periodComplete && (
              <div className="calc-check-hint">отчёт охватывает не весь месяц — итоги неполные</div>
            )}
          </div>
        </div>
        <div className={"calc-check-row " + (ok.blockers.length === 0 ? "ok" : "warn")}>
          <span className="calc-check-ico">{ok.blockers.length === 0 ? "✓" : "⚠"}</span>
          <div className="calc-check-body">
            <div className="calc-check-line">
              <span className="calc-check-label">
                {ok.blockers.length === 0
                  ? "Себестоимость заполнена"
                  : `У ${ok.calc.costCoverage.missingCost} ${pluralRu(ok.calc.costCoverage.missingCost, "товара", "товаров", "товаров")} нет себестоимости`}
              </span>
              <span className="calc-check-val">
                {ok.calc.costCoverage.withCost} / {ok.calc.costCoverage.requiredProducts}
              </span>
            </div>
            {ok.blockers.length > 0 && (
              <div className="calc-check-hint">
                {access.showResult
                  ? "результат предварительный — его нельзя сохранить как готовый"
                  : "расчёт станет доступен, когда себестоимость будет у всех товаров"}
              </div>
            )}
          </div>
        </div>
        <div className={"calc-check-row " + (ok.calc.taxRatePercent === 0 ? "warn" : "ok")}>
          <span className="calc-check-ico">{ok.calc.taxRatePercent === 0 ? "⚠" : "✓"}</span>
          <div className="calc-check-body">
            <div className="calc-check-line">
              <span className="calc-check-label">{ok.calc.taxRatePercent === 0 ? "Налог не указан" : "Налог указан"}</span>
              {ok.calc.taxRatePercent !== 0 && (
                <span className="calc-check-val">
                  {ok.calc.taxRatePercent.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%
                </span>
              )}
            </div>
            {ok.calc.taxRatePercent === 0 && <div className="calc-check-hint">итоговая прибыль может быть завышена</div>}
          </div>
        </div>
      </div>
      {ok.readyToSave ? (
        <div className="calc-check-status ok">
          <span className="calc-check-status-ico">✓</span>
          <span>
            <b>{access.showResult ? "Расчёт готов к сохранению" : "Готово к расчёту"}</b>
            <em>Все себестоимости на месте.</em>
          </span>
        </div>
      ) : (
        <div className="calc-check-status warn">
          <span className="calc-check-status-ico">⚠</span>
          <span>
            <b>{access.showResult ? "Сохранить как готовый результат нельзя" : "Рассчитать нельзя — попытка не списывается"}</b>
            <em>{ok.blockers.map((b) => b.message).join(" ")}</em>
          </span>
        </div>
      )}
    </div>
  ) : null;

  const saveSection = ok ? (
    <div className="accr-save">
      <p className="accr-save-hint">
        {s.saved
          ? "Расчёт уже в истории. Повторное нажатие без изменений ничего не пишет; после правки значений запись обновится без нового списания."
          : s.creditHeld
          ? "Попытка по этому файлу уже списана, но расчёт не записан — повторное сохранение не спишет её снова."
          : "Расчёт списывает одну попытку по вашему тарифу (при безлимите попытки не расходуются), затем открывает результат и сохраняет его в историю. Отмена, ошибка файла и неполная себестоимость попытку не списывают."}
      </p>
      <button
        type="button"
        className="upload-3-btn primary accr-save-btn"
        onClick={() => void s.save()}
        disabled={s.saving || !ok.readyToSave || (s.saved && !s.dirty && !s.needsRetry)}
        aria-busy={s.saving}
      >
        {s.saving
          ? "Сохраняем…"
          : s.needsRetry
          ? "Повторить сохранение"
          : s.saved
          ? s.dirty
            ? "Сохранить изменения"
            : "Расчёт сохранён ✓"
          : "Рассчитать и сохранить"}
      </button>
      {!ok.readyToSave && (
        <p className="accr-save-hint warn">Расчёт станет доступен, когда у всех товаров будет указана себестоимость.</p>
      )}
      {s.saveNote && (
        <div className={"accr-save-note " + s.saveNote.kind} role={s.saveNote.kind === "err" ? "alert" : "status"}>
          {s.saveNote.text}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="card upload-card accr-flow" role="region" aria-label="Расчёт по отчёту начислений Ozon">
      <div className="upload-3-head">
        <div className="upload-3-title">Расчёт по отчёту начислений Ozon</div>
        <p className="upload-3-sub">
          Загрузите один файл — XLSX «Отчёт по начислениям» из личного кабинета Ozon. Комиссии,
          логистика, реклама Ozon и другие операции <b>уже включены в отчёт</b>: они учитываются
          один раз в итоге начислений, вводить их отдельно не нужно.
        </p>
      </div>

      <details className="accr-guide" open>
        <summary>Как получить отчёт</summary>
        <ol>
          {ACCRUAL_DOWNLOAD_STEPS.map((t, i) => (
            <li key={i}>{withBrand(t)}</li>
          ))}
        </ol>
        <p className="accr-guide-note">
          Файл читается в вашем браузере и на сервер не загружается. На сервер передаются только итог расчёта
          и артикулы, SKU и названия товаров, которых ещё нет в вашем каталоге, — чтобы добавить их в каталог.
        </p>
      </details>

      <div
        className={"accr-drop" + (drag ? " is-drag" : "") + (s.phase === "ready" ? " is-ready" : "") + (s.phase === "error" ? " is-error" : "")}
        role="button"
        tabIndex={0}
        aria-label="Загрузить файл отчёта по начислениям (XLSX): перетащите или нажмите"
        onClick={pick}
        onKeyDown={onKey}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrag(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDrag(false);
        }}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          hidden
          aria-label="Выбор файла отчёта по начислениям"
          onChange={(e) => {
            void s.chooseFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {!s.file ? (
          <>
            <div className="accr-drop-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8 12 3 7 8" />
                <path d="M12 3v13" />
              </svg>
            </div>
            <div className="accr-drop-title">Перетащите XLSX сюда</div>
            <div className="accr-drop-meta">Один файл · только формат XLSX</div>
            <span className="upload-slot-pick">Выбрать файл</span>
          </>
        ) : (
          <div className="accr-file">
            <div className="accr-file-name" title={s.file.name}>
              {s.file.name}
            </div>
            <div className="accr-file-meta">{fmtSize(s.file.size)}</div>
            <div className="accr-status" aria-live="polite">
              {s.phase === "reading" && <span className="accr-st reading">Читаем отчёт…</span>}
              {s.phase === "ready" && period && (
                <span className="accr-st ok">
                  ✓ Отчёт распознан · {fmtMonthLabel(period.month)} ·{" "}
                  {fmtDateRange(period.declaredFrom ?? period.dateFrom, period.declaredTo ?? period.dateTo)} ·{" "}
                  {s.parsed?.rowCount} {pluralRu(s.parsed?.rowCount ?? 0, "строка", "строки", "строк")}
                </span>
              )}
              {s.phase === "error" && <span className="accr-st err">Файл не удалось использовать</span>}
            </div>
            <div className="accr-file-actions" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="upload-3-btn ghost" onClick={pick}>
                Выбрать другой файл
              </button>
              <button type="button" className="upload-3-btn ghost" onClick={s.clearFile} disabled={s.phase === "reading"}>
                Убрать
              </button>
            </div>
          </div>
        )}
      </div>

      {s.otherHeldCredits > 0 && (
        <p className="accr-held-note" role="status">
          {s.otherHeldCredits === 1
            ? "Для другого файла попытка уже списана, но расчёт не записан. Этот файл её не наследует: для него попытка спишется отдельно. Вернувшись к прежнему файлу (пока страница открыта), вы сохраните его без нового списания."
            : `Для ${s.otherHeldCredits} других файлов попытки уже списаны, но расчёты не записаны. Этот файл их не наследует: для него попытка спишется отдельно. Вернувшись к прежним файлам (пока страница открыта), вы сохраните их без нового списания.`}
        </p>
      )}

      {s.phase === "error" && s.errors.length > 0 && (
        <div className="upload-3-error" role="alert">
          <div className="upload-3-error-title">Не удалось обработать файл</div>
          {s.errors.map((m, i) => (
            <p className="upload-3-error-sub" key={i}>
              {m}
            </p>
          ))}
          <p className="upload-3-error-sub accr-noconsume">Попытка расчёта не списана.</p>
        </div>
      )}

      {s.phase === "ready" && s.parsed && s.parsed.warnings.length > 0 && (
        <ul className="accr-notes" aria-label="Замечания к отчёту">
          {s.parsed.warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      )}

      {s.phase === "ready" && s.parsed && (
        <>
          <div className="profit-calc accr-inputs">
            <div className="profit-calc-head">Налог и дополнительные расходы</div>
            <p className="accr-inputs-sub">
              Только то, чего нет в отчёте Ozon. Итог, категории начислений и товарные строки
              пересчитываются сразу при изменении значений.
            </p>
            <div className="form-grid profit-grid">
              {FIELDS.map((f) => (
                <div className="fld" key={f.key}>
                  <label htmlFor={"accr-" + f.key}>{f.label}</label>
                  <div className="in-wrap">
                    <input
                      id={"accr-" + f.key}
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={s.inputs[f.key]}
                      aria-invalid={fieldErrors[f.key] ? true : undefined}
                      onChange={(e) => s.setInput(f.key, e.target.value)}
                    />
                    <span className="in-cur">{f.unit}</span>
                  </div>
                  {fieldErrors[f.key] ? (
                    <span className="fld-hint accr-fld-err">{fieldErrors[f.key]}</span>
                  ) : (
                    f.hint && <span className="fld-hint">{f.hint}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="accr-catalog" aria-live="polite">
            {s.catalog.status === "loading" && (
              <span className="accr-cat-line">
                {s.catalogImport.status === "running"
                  ? "Добавляем недостающие товары в каталог…"
                  : "Загружаем каталог себестоимости…"}
              </span>
            )}
            {s.catalog.status === "ready" && (
              <span className="accr-cat-line">
                Каталог себестоимости: {s.catalog.entries.length}{" "}
                {pluralRu(s.catalog.entries.length, "товар", "товара", "товаров")}
              </span>
            )}
            {s.catalog.status === "idle" && !signedIn && (
              <span className="accr-cat-line warn">
                Войдите в аккаунт: без каталога себестоимости результат будет предварительным.
              </span>
            )}
            {s.catalog.status === "error" && (
              <span className="accr-cat-line err" role="alert">
                Не удалось загрузить каталог: {s.catalog.error}. Расчёт остановлен — попытка не списана.
              </span>
            )}
            <button
              type="button"
              className="upload-3-btn ghost"
              onClick={() => void s.refreshCatalog()}
              disabled={s.catalog.status === "loading" || !signedIn}
            >
              Проверить снова
            </button>
          </div>

          {s.catalogImport.status === "done" &&
            s.catalogImport.created > 0 &&
            (!ok || ok.problemProducts.length > 0) && (
            <div className="accr-import-note" role="status">
              Добавлено в каталог: {s.catalogImport.created}{" "}
              {pluralRu(s.catalogImport.created, "товар", "товара", "товаров")} — без себестоимости. Укажите её в
              каталоге и нажмите «Проверить снова».
            </div>
          )}
          {s.catalogImport.status === "done" && s.catalogImport.ambiguous > 0 && (
            <div className="accr-import-note warn" role="status">
              Не добавлено из-за неоднозначного сопоставления: {s.catalogImport.ambiguous}{" "}
              {pluralRu(s.catalogImport.ambiguous, "товар", "товара", "товаров")} (в каталоге несколько строк с
              одним артикулом или у артикула разные Ozon SKU). Проверьте каталог и добавьте их вручную.
            </div>
          )}
          {s.catalogImport.status === "error" && (
            <div className="accr-import-note err" role="alert">
              Не удалось добавить товары в каталог: {s.catalogImport.message}. Товары не добавлены — нажмите
              «Проверить снова», чтобы повторить, или добавьте их вручную.
            </div>
          )}

          {ev && ev.status === "input_error" && (
            <div className="upload-3-error" role="alert">
              <div className="upload-3-error-title">Проверьте введённые значения</div>
              <p className="upload-3-error-sub">Исправьте выделенные поля — до этого итог не считается.</p>
            </div>
          )}
          {ev && ev.status === "calc_error" && (
            <div className="upload-3-error" role="alert">
              <div className="upload-3-error-title">Расчёт невозможен</div>
              <p className="upload-3-error-sub">{ev.message}</p>
              <p className="upload-3-error-sub accr-noconsume">Попытка расчёта не списана.</p>
            </div>
          )}

          {ok && ok.problemProducts.length > 0 && (
            <div className="accr-problems" role="region" aria-label="Товары без себестоимости">
              <div className="accr-problems-title">
                Не хватает себестоимости у {ok.problemProducts.length}{" "}
                {pluralRu(ok.problemProducts.length, "товара", "товаров", "товаров")}
              </div>
              <p className="accr-problems-sub">
                Пока она не указана в каталоге, результат остаётся предварительным и не сохраняется как готовый;
                попытка расчёта не списывается.
              </p>
              <ul>
                {ok.problemProducts.slice(0, PROBLEM_LIMIT).map((p) => (
                  <li key={p.article}>
                    <b>{p.article}</b>
                    {p.name && p.name !== p.article ? ` · ${p.name}` : ""} · {p.netQuantity}{" "}
                    шт · {p.reason === "not_in_catalog" ? "нет в каталоге" : "себестоимость не указана"}
                  </li>
                ))}
              </ul>
              {ok.problemProducts.length > PROBLEM_LIMIT && (
                <p className="accr-problems-sub">…и ещё {ok.problemProducts.length - PROBLEM_LIMIT}</p>
              )}
              <div className="accr-problems-actions">
                <button type="button" className="upload-3-btn primary" onClick={onOpenCatalog}>
                  Открыть каталог товаров
                </button>
                <button
                  type="button"
                  className="upload-3-btn ghost"
                  onClick={() => void s.refreshCatalog()}
                  disabled={s.catalog.status === "loading"}
                >
                  Проверить снова
                </button>
              </div>
              <p className="accr-problems-sub">
                Заполните себестоимость в каталоге и вернитесь сюда: файл повторно загружать не нужно —
                нажмите «Проверить снова».
              </p>
            </div>
          )}
        </>
      )}

      {ok && access.showResult && (
        <AccrualSnapshotView
          live
          view={{ status: "ok", snapshot: ok.snapshot }}
          onDownloadPdf={() => void s.downloadPdf()}
          pdfBusy={s.pdfBusy}
        >
          {readiness}
          {saveSection}
        </AccrualSnapshotView>
      )}

      {ok && !access.showResult && (
        <div className="accr-locked" role="region" aria-label="Результат откроется после расчёта">
          <div className="accr-locked-kicker">Результат откроется после расчёта</div>
          <p className="accr-locked-text">
            Чистая прибыль, разбивка начислений и аналитика по товарам появятся после расчёта — он списывает одну
            попытку по вашему тарифу (при безлимите попытки не расходуются). Проверка файла и поиск товаров без
            себестоимости бесплатны и попытку не списывают.
            {!ok.readyToSave && " Пока себестоимость указана не у всех товаров, расчёт не выполняется."}
          </p>
          {readiness}
          {saveSection}
        </div>
      )}
      {/* Литерал прямо в теге: styled-jsx считает id стиля по тексту на этапе сборки. Константа-идентификатор
          получает общий id «undefined» и молча вытесняется стилем AccrualSnapshotView. */}
      <style jsx global>{`
  .accr-guide{margin:0 0 1rem;border:1px solid var(--edge);border-radius:12px;padding:.65rem .9rem;
    background:rgba(255,255,255,.02)}
  .accr-guide summary{cursor:pointer;font-family:var(--mono);font-size:.68rem;text-transform:uppercase;
    letter-spacing:.09em;color:var(--gold2)}
  .accr-guide ol{margin:.7rem 0 .3rem;padding-left:1.25rem;list-style:decimal;display:flex;flex-direction:column;gap:.4rem}
  .accr-guide li{display:list-item}
  .accr-guide li::marker{color:var(--gold2);font-family:var(--mono);font-size:.78rem}
  .accr-guide li{font-size:.82rem;line-height:1.5;color:var(--txt2)}
  .accr-nobr{white-space:nowrap}
  .accr-guide-note{margin:.6rem 0 .1rem;font-size:.75rem;line-height:1.45;color:var(--txt3)}
  .accr-drop{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:.35rem;text-align:center;padding:1.5rem 1rem;border:1.5px dashed rgba(201,168,76,.35);border-radius:14px;
    background:rgba(255,255,255,.025);cursor:pointer;transition:border-color .2s,background .2s;min-width:0}
  .accr-drop:hover,.accr-drop:focus-visible{border-color:var(--gold);background:rgba(201,168,76,.06);outline:none}
  .accr-drop.is-drag{border-color:var(--gold);background:rgba(201,168,76,.1);
    box-shadow:0 0 0 1px rgba(201,168,76,.25),0 8px 22px rgba(201,168,76,.08)}
  .accr-drop.is-ready{border-style:solid;border-color:rgba(46,204,138,.32);background:rgba(46,204,138,.05)}
  .accr-drop.is-error{border-style:solid;border-color:rgba(224,85,102,.35);background:rgba(224,85,102,.05)}
  .accr-drop-ico{width:34px;height:34px;color:var(--gold2)}
  .accr-drop-ico svg{width:100%;height:100%;display:block}
  .accr-drop-title{font-size:.98rem;color:var(--txt);font-weight:500}
  .accr-drop-meta{font-size:.74rem;color:var(--txt3)}
  .accr-file{width:100%;display:flex;flex-direction:column;align-items:center;gap:.4rem;min-width:0}
  .accr-file-name{max-width:100%;font-size:.92rem;color:var(--txt);font-weight:500;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .accr-file-meta{font-family:var(--mono);font-size:.68rem;color:var(--txt3)}
  .accr-status{min-height:1.2rem;font-size:.8rem;line-height:1.45;overflow-wrap:anywhere}
  .accr-st.ok{color:#7be8b2}
  .accr-st.reading{color:var(--gold2)}
  .accr-st.err{color:#f0a4a4}
  .accr-file-actions{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:.3rem}
  .accr-noconsume{color:var(--gold2)}
  .accr-locked{margin-top:1.2rem;padding:1.1rem 1.1rem 1.2rem;border-radius:16px;border:1px solid rgba(201,168,76,.28);
    background:linear-gradient(180deg,rgba(201,168,76,.06),rgba(255,255,255,.02))}
  .accr-locked-kicker{font-family:var(--mono);font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;color:var(--gold2)}
  .accr-locked-text{margin:.55rem 0 1rem;font-size:.84rem;line-height:1.5;color:var(--txt2)}
  .accr-import-note{margin:.7rem 0 0;padding:.6rem .8rem;border-radius:10px;font-size:.78rem;line-height:1.5;
    color:#7be8b2;border:1px solid rgba(46,204,138,.3);background:rgba(46,204,138,.07)}
  .accr-import-note.warn{color:#f0cd84;border-color:rgba(232,176,75,.32);background:rgba(232,176,75,.07)}
  .accr-import-note.err{color:#f0b0b3;border-color:rgba(224,85,102,.4);background:rgba(224,85,102,.09)}
  .accr-held-note{margin:.7rem 0 0;padding:.6rem .8rem;border-radius:10px;font-size:.76rem;line-height:1.45;
    color:#f0cd84;border:1px solid rgba(232,176,75,.32);background:rgba(232,176,75,.07)}
  .accr-notes{list-style:none;margin:.8rem 0 0;padding:0;display:flex;flex-direction:column;gap:.4rem}
  .accr-notes li{font-size:.76rem;line-height:1.45;color:var(--txt2);padding:.5rem .75rem;border-radius:9px;
    border:1px solid var(--edge);background:rgba(255,255,255,.02)}
  .accr-inputs{margin-top:1.1rem}
  .accr-inputs-sub{margin:.1rem 0 .8rem;font-size:.78rem;line-height:1.45;color:var(--txt3)}
  .accr-fld-err{color:#f0a4a4}
  .accr-catalog{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem .9rem;margin-top:1rem}
  .accr-cat-line{font-size:.8rem;color:var(--txt2);flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
  .accr-cat-line.warn{color:var(--gold2)}
  .accr-cat-line.err{color:#f0a4a4}
  .accr-problems{margin-top:1rem;padding:1rem 1.1rem;border-radius:14px;border:1px solid rgba(232,176,75,.32);
    background:rgba(232,176,75,.06)}
  .accr-problems-title{font-size:.95rem;color:#f0cd84;font-weight:600}
  .accr-problems-sub{margin:.35rem 0;font-size:.76rem;line-height:1.45;color:var(--txt2)}
  .accr-problems ul{margin:.5rem 0;padding-left:1.1rem;display:flex;flex-direction:column;gap:.25rem}
  .accr-problems li{font-size:.8rem;line-height:1.4;color:var(--txt2);overflow-wrap:anywhere}
  .accr-problems li b{color:var(--txt);font-weight:600}
  .accr-problems-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.6rem 0 .2rem}
  .accr-save{margin-top:1.1rem}
  .accr-save-hint{margin:0 0 .7rem;font-size:.76rem;line-height:1.45;color:var(--txt3)}
  .accr-save-hint.warn{color:var(--gold2);margin:.6rem 0 0}
  .accr-save-btn{width:100%}
  .accr-drop .upload-slot-pick{width:auto;padding:.5rem 1.3rem}
  .accr-save-note{margin-top:.7rem;padding:.65rem .85rem;border-radius:10px;font-size:.8rem;line-height:1.45;
    border:1px solid var(--edge);background:rgba(255,255,255,.03);color:var(--txt2)}
  .accr-save-note.ok{border-color:rgba(46,204,138,.3);background:rgba(46,204,138,.07);color:#7be8b2}
  .accr-save-note.warn{border-color:rgba(232,176,75,.32);background:rgba(232,176,75,.07);color:#f0cd84}
  .accr-save-note.err{border-color:rgba(224,85,102,.4);background:rgba(224,85,102,.09);color:#f0b0b3}
`}</style>
    </div>
  );
}
