"use client";

// ============================================================================
// AccrualSnapshotView — просмотр СОХРАНЁННОГО расчёта по XLSX «Отчёт по
// начислениям» (snapshot kind "ozon-accrual-xlsx-v1"), открытого из истории.
//
// Только чтение: все числа берутся из снимка (accrual/snapshot.ts), ничего не
// пересчитывается — ни формулами, ни по сегодняшнему каталогу. Компонент не
// обращается к Supabase/сети. Повреждённый снимок показывается как «данные
// недоступны», а не как нулевой расчёт.
//
// Оформление — существующие глобальные классы страницы (profit-summary,
// upload-3-row, …), в тех же цветах, что и результат расчёта по документам.
// ============================================================================

import { OzonProductBreakdown } from "./OzonProductBreakdown";
import {
  accrualBreakdownRows,
  accrualExplanations,
  accrualNotices,
  accrualPeriodLabel,
  accrualPeriodRange,
  accrualProductBreakdownRows,
  accrualProfitLabel,
  accrualSnapshotRoi,
  type AccrualSnapshotV1,
} from "../lib/accrual/snapshot";
import { fmtAmount, fmtPercent, fmtRub } from "../lib/accrual/format";

export type AccrualViewState =
  | { status: "ok"; snapshot: AccrualSnapshotV1 }
  | { status: "invalid"; reason: string };

interface Props {
  view: AccrualViewState;
  onClose: () => void;
  onDownloadPdf?: () => void;
  pdfBusy?: boolean;
}

export function AccrualSnapshotView({ view, onClose, onDownloadPdf, pdfBusy }: Props) {
  if (view.status === "invalid") {
    return (
      <div className="card upload-card accr-view" role="region" aria-label="Сохранённый расчёт по отчёту начислений">
        <div className="upload-3-head">
          <div className="upload-3-title">Расчёт по отчёту начислений Ozon</div>
        </div>
        <div className="mode-note" role="alert">
          <div className="mode-note-title">Сохранённые данные расчёта недоступны</div>
          <p className="mode-note-text">
            Снимок этого расчёта повреждён, неполон или создан несовместимой версией, поэтому
            цифры не показываются — чтобы не выдать нули за результат. Итоговые суммы в списке
            «Последние расчёты» остаются как сохранены.
            <span className="mode-note-sub">Причина: {view.reason}</span>
          </p>
        </div>
        <div className="accr-actions">
          <button type="button" className="upload-3-btn ghost" onClick={onClose}>
            Закрыть просмотр
          </button>
        </div>
        <style jsx>{ACCR_CSS}</style>
      </div>
    );
  }

  const s = view.snapshot;
  const neg = s.netProfitKopecks < 0;
  const roi = accrualSnapshotRoi(s);
  const rows = accrualBreakdownRows(s).filter((r) => r.kind !== "total");
  const notices = accrualNotices(s);
  const profitLabel = neg && !s.preliminary ? "Чистый убыток" : accrualProfitLabel(s);
  // Предварительный результат подсвечиваем нейтрально-золотым, а не «готовым» зелёным.
  const cls = s.preliminary ? " accr-prelim" : neg ? " neg" : " pos";

  return (
    <>
      <div className="card upload-card accr-view" role="region" aria-label="Сохранённый расчёт по отчёту начислений">
        <div className="upload-3-head">
          <div className="upload-3-title">Расчёт по отчёту начислений Ozon</div>
          <p className="upload-3-sub">
            Сохранённый расчёт — только просмотр. Значения зафиксированы на момент расчёта и не
            пересчитываются по текущему каталогу и ценам.
          </p>
        </div>

        <div className="accr-meta">
          <span className="accr-period">
            {accrualPeriodLabel(s)} · {accrualPeriodRange(s)}
          </span>
          {s.preliminary && <span className="accr-badge warn">Предварительный результат</span>}
          {!s.period.periodComplete && <span className="accr-badge warn">Неполный месяц</span>}
        </div>

        <div className={"profit-summary" + cls}>
          <div className="profit-summary-head">
            <span className="profit-summary-kicker">
              {s.preliminary ? "Предварительно" : neg ? "Убыток" : "Прибыль"}
            </span>
            <div className="profit-summary-title">{profitLabel}</div>
            <div className="profit-summary-caption">
              {s.preliminary
                ? "Себестоимость указана не для всех товаров — результат предварительный, не готов к сохранению как итоговый."
                : "Итог начислений Ozon после себестоимости, налога и ручных расходов."}
            </div>
          </div>
          <div className={"profit-summary-big" + (neg ? " neg" : "")}>{fmtRub(s.netProfitKopecks)}</div>

          <div className="profit-stats">
            <div className="profit-stat">
              <span className="profit-stat-label">Маржинальность</span>
              <span
                className={"profit-stat-val" + (s.marginPercent !== null && s.marginPercent < 0 ? " neg" : "")}
                title={
                  s.marginPercent === null
                    ? "Маржа не определяется при нулевой или отрицательной реализации"
                    : undefined
                }
              >
                {fmtPercent(s.marginPercent)}
              </span>
            </div>
            <div className="profit-stat">
              <span className="profit-stat-label">ROI</span>
              <span className={"profit-stat-val" + (roi !== null && roi < 0 ? " neg" : "")}>
                {fmtPercent(roi)}
              </span>
            </div>
          </div>

          <div className="profit-breakdown">
            {rows.map((r) => (
              <div
                key={r.key}
                className={
                  "upload-3-row" +
                  (r.kind === "expense" ? " negative" : r.kind === "subtotal" ? " subtotal" : "")
                }
              >
                <span>
                  {r.label}
                  {r.note && <small className="accr-note">{r.note}</small>}
                </span>
                <span className="num">
                  {r.kind === "income" ? "+" : r.kind === "expense" ? "−" : r.kopecks < 0 ? "−" : ""}
                  {fmtAmount(r.kopecks)} ₽
                </span>
              </div>
            ))}
          </div>
        </div>

        {notices.length > 0 && (
          <ul className="accr-notices" aria-label="Предупреждения">
            {notices.map((n, i) => (
              <li key={i} className={n.tone}>
                {n.text}
              </li>
            ))}
          </ul>
        )}

        <details className="accr-explain">
          <summary>Как считаем</summary>
          <ul>
            {accrualExplanations(s).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </details>

        <div className="accr-actions">
          {onDownloadPdf && (
            <button type="button" className="upload-3-btn primary" onClick={onDownloadPdf} disabled={pdfBusy}>
              {pdfBusy ? "Готовим PDF…" : "Скачать PDF-отчёт"}
            </button>
          )}
          <button type="button" className="upload-3-btn ghost" onClick={onClose}>
            Закрыть просмотр
          </button>
        </div>
        <style jsx>{ACCR_CSS}</style>
      </div>

      <OzonProductBreakdown
        products={[]}
        user={null}
        precomputedRows={accrualProductBreakdownRows(s)}
      />
    </>
  );
}

const ACCR_CSS = `
  .accr-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem;margin:.2rem 0 .9rem}
  .accr-period{font-family:var(--mono);font-size:.74rem;color:var(--gold2);letter-spacing:.04em}
  .accr-badge{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.08em;
    padding:3px 10px;border-radius:999px;border:1px solid rgba(201,168,76,.35);color:var(--gold2);
    background:rgba(201,168,76,.08)}
  .accr-badge.warn{border-color:rgba(224,85,102,.4);color:#f0b8bb;background:rgba(224,85,102,.1)}
  .accr-prelim{border-color:rgba(201,168,76,.4)}
  .accr-prelim .profit-summary-big{color:var(--gold2);text-shadow:none}
  .accr-prelim .profit-summary-kicker{color:var(--gold2);background:rgba(201,168,76,.12);
    border-color:rgba(201,168,76,.3)}
  .accr-note{display:block;margin-top:2px;font-size:.68rem;color:var(--txt3);line-height:1.35;font-weight:300}
  .accr-notices{list-style:none;margin:1rem 0 0;padding:0;display:flex;flex-direction:column;gap:.45rem}
  .accr-notices li{font-size:.78rem;line-height:1.45;color:var(--txt2);padding:.55rem .75rem;border-radius:9px;
    border:1px solid var(--edge);background:rgba(255,255,255,.02)}
  .accr-notices li.warn{border-color:rgba(224,85,102,.3);background:rgba(224,85,102,.06);color:#f0c3c6}
  .accr-explain{margin-top:1rem;border:1px solid var(--edge);border-radius:10px;padding:.55rem .8rem;
    background:rgba(255,255,255,.015)}
  .accr-explain summary{cursor:pointer;font-family:var(--mono);font-size:.68rem;text-transform:uppercase;
    letter-spacing:.08em;color:var(--txt2)}
  .accr-explain ul{margin:.6rem 0 .2rem;padding-left:1.1rem;display:flex;flex-direction:column;gap:.4rem}
  .accr-explain li{font-size:.76rem;line-height:1.5;color:var(--txt2)}
  .accr-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.1rem}
`;
