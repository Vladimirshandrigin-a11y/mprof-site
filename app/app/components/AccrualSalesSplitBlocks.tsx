"use client";

// ============================================================================
// Разделение результата товаров по «Отчёту по начислениям»: сводка частей,
// «Результат возвратов», «Расходы без продаж в периоде» и «Неразделённые операции».
// Только показ готового вида accrualSalesSplitView (accrual/snapshot.ts) — никаких
// пересчётов по каталогу. Знаки сумм — настоящие: положительный результат возвратов
// не называется убытком.
// ============================================================================

import { useState } from "react";
import {
  accrualSplitReconciliationText,
  accrualSplitUnavailableText,
  type AccrualSalesSplitView,
  type AccrualSplitBlockRow,
  type AccrualUnsplitRow,
} from "../lib/accrual/snapshot";
import { fmtRub, pluralRu } from "../lib/accrual/format";

function money(k: number | null): string {
  return k === null ? "—" : fmtRub(k);
}

function tone(k: number | null): string {
  if (k === null || k === 0) return "";
  return k > 0 ? " pos" : " neg";
}

function BlockList({
  rows,
  label,
  id,
}: {
  rows: (AccrualSplitBlockRow | AccrualUnsplitRow)[];
  label: string;
  id: string;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className={"accs-toggle" + (open ? " open" : "")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Скрыть товары" : `Показать товары (${rows.length})`}
      </button>
      {open && (
        <ul className="accs-list" id={id} aria-label={label}>
          {rows.map((r, i) => (
            <li key={r.article + "#" + i}>
              <div className="accs-li-head">
                <span className="accs-li-name">
                  <b>{r.article}</b>
                  {r.name && r.name !== r.article ? ` · ${r.name}` : ""}
                </span>
                <span className={"accs-li-val" + tone(r.resultKopecks)}>{money(r.resultKopecks)}</span>
              </div>
              {"reasons" in r && (
                <>
                  <div className="accs-li-sub">
                    {r.reasons.map((x) => `${x.label}: ${x.count}`).join("; ")}
                  </div>
                  <div className="accs-li-comp">
                    {r.components.map((c) => (
                      <span key={c.label}>
                        {c.label} {fmtRub(c.kopecks)}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {r.resultKopecks === null && (
                <div className="accs-li-sub">Себестоимость неизвестна — результат не определён.</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AccrualSalesSplitBlocks({ view }: { view: AccrualSalesSplitView }) {
  const unavailable = accrualSplitUnavailableText(view.availability);
  if (unavailable) {
    return (
      <section className="accs" aria-label="Разделение результата товаров">
        <h3 className="accs-title">Продажи, возвраты и расходы без продаж</h3>
        <p className="accs-note">{unavailable}</p>
        <style jsx global>{`
          .accs{margin-top:1.2rem;padding:1.1rem 1.2rem;border:1px solid var(--edge);border-radius:16px;
            background:rgba(255,255,255,.015)}
          .accs-title{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);margin:0 0 .5rem}
          .accs-note{font-size:.8rem;line-height:1.5;color:var(--txt2);margin:0}
        `}</style>
      </section>
    );
  }

  const rec = accrualSplitReconciliationText(view);
  const returnsSign =
    view.returns.totalKopecks === null
      ? ""
      : view.returns.totalKopecks > 0
      ? "в плюс"
      : view.returns.totalKopecks < 0
      ? "в минус"
      : "";

  return (
    <section className="accs" aria-label="Разделение результата товаров">
      <h3 className="accs-title">Продажи, возвраты и расходы без продаж</h3>
      <p className="accs-note">
        Полная прибыль товара разложена на части по связи операций («ID начисления» + артикул). Все части
        учтены в полной прибыли; ничего не исчезает и не считается дважды.
      </p>

      <div className="accs-grid">
        <div className="accs-card">
          <span className="accs-l">Расчётная прибыль от продаж</span>
          <span className={"accs-v" + tone(view.sales.totalKopecks)}>{money(view.sales.totalKopecks)}</span>
          <span className="accs-s">
            {view.sales.products} {pluralRu(view.sales.products, "товар", "товара", "товаров")} с продажами
          </span>
        </div>
        <div className="accs-card">
          <span className="accs-l">Результат возвратов</span>
          <span className={"accs-v" + tone(view.returns.totalKopecks)}>{money(view.returns.totalKopecks)}</span>
          <span className="accs-s">{returnsSign ? `${returnsSign} · ` : ""}по начислениям этого периода</span>
        </div>
        <div className="accs-card">
          <span className="accs-l">Расходы без продаж в периоде</span>
          <span className={"accs-v" + tone(view.noSale.totalKopecks)}>{money(view.noSale.totalKopecks)}</span>
          <span className="accs-s">невыкупы, отмены, доставка без выручки в периоде</span>
        </div>
        {view.unsplit.rows.length > 0 && (
          <div className="accs-card warn">
            <span className="accs-l">Неразделённые операции</span>
            <span className={"accs-v" + tone(view.unsplit.totalKopecks)}>{money(view.unsplit.totalKopecks)}</span>
            <span className="accs-s">не отнесены ни к продажам, ни к возвратам</span>
          </div>
        )}
      </div>

      {rec && <p className="accs-rec">Сверка: {rec}</p>}
      {!rec && (
        <p className="accs-rec">Сверка частей появится, когда у всех товаров будет известна себестоимость.</p>
      )}

      <div className="accs-block">
        <h4 className="accs-h4">Результат возвратов</h4>
        <p className="accs-note">
          Сумма связанных операций возврата по начислениям выбранного периода (возврат выручки, возврат
          комиссии, обратная логистика, обработка) и себестоимость вернувшихся единиц. Это результат
          периода, а не обязательно всей истории заказа: продажа могла быть в прошлом периоде.
          {view.returns.rows.length === 0 ? " Возвратов в периоде нет." : ""}
        </p>
        <BlockList rows={view.returns.rows} label="Результат возвратов" id="accs-returns" />
      </div>

      <div className="accs-block">
        <h4 className="accs-h4">Расходы без продаж в периоде</h4>
        <p className="accs-note">
          Доставка и обработка по операциям без выручки и возврата в этом периоде.
          {view.noSale.rows.length === 0 ? " Таких расходов нет." : ""}
        </p>
        <BlockList rows={view.noSale.rows} label="Расходы без продаж в периоде" id="accs-nosale" />
      </div>

      {view.unsplit.rows.length > 0 && (
        <div className="accs-block">
          <h4 className="accs-h4">Неразделённые операции</h4>
          <p className="accs-note">
            Конкретные строки отчёта, которые нельзя достоверно отнести к продажам или возвратам: частичные
            возвраты (затраты по единицам не делятся), неоднозначные связи, операции без связи с продажей и
            строки без «ID начисления». Показаны их суммы по категориям.
          </p>
          <BlockList rows={view.unsplit.rows} label="Неразделённые операции" id="accs-unsplit" />
        </div>
      )}

      <p className="accs-note small">
        Налог, ручные расходы и общие начисления без товара распределены внутри товара пропорционально
        положительной выручке части — это правило распределения, а не привязка расхода к отправлению.
      </p>

      <style jsx global>{`
        .accs{margin-top:1.2rem;padding:1.1rem 1.2rem;border:1px solid var(--edge);border-radius:16px;
          background:rgba(255,255,255,.015)}
        .accs-title{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);margin:0 0 .5rem}
        .accs-note{font-size:.8rem;line-height:1.5;color:var(--txt2);margin:0 0 .7rem}
        .accs-note.small{font-size:.74rem;color:var(--txt3);margin:1rem 0 0}
        .accs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.7rem;margin:.4rem 0 .6rem}
        .accs-card{display:flex;flex-direction:column;gap:.25rem;padding:.8rem .9rem;border-radius:12px;
          border:1px solid var(--edge);background:rgba(255,255,255,.02);min-width:0}
        .accs-card.warn{border-color:rgba(232,176,75,.35);background:rgba(232,176,75,.06)}
        .accs-l{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--txt3)}
        .accs-v{font-size:1.15rem;font-weight:700;color:var(--txt)}
        .accs-v.pos{color:var(--green)}
        .accs-v.neg{color:var(--red)}
        .accs-s{font-size:.74rem;color:var(--txt3);line-height:1.4}
        .accs-rec{font-family:var(--mono);font-size:.74rem;color:var(--txt2);margin:.3rem 0 .6rem;overflow-wrap:anywhere}
        .accs-block{margin-top:1rem}
        .accs-h4{font-size:.9rem;font-weight:700;color:var(--txt);margin:0 0 .4rem}
        .accs-toggle{font:inherit;font-size:.8rem;color:var(--gold2);background:none;border:1px solid var(--edge2);
          border-radius:9px;padding:.4rem .8rem;cursor:pointer}
        .accs-list{list-style:none;margin:.6rem 0 0;padding:0;display:flex;flex-direction:column;gap:.45rem}
        .accs-list li{padding:.6rem .75rem;border:1px solid var(--edge);border-radius:10px;background:rgba(255,255,255,.02)}
        .accs-li-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.3rem .8rem}
        .accs-li-name{font-size:.82rem;color:var(--txt2);min-width:0;overflow-wrap:anywhere}
        .accs-li-name b{color:var(--txt)}
        .accs-li-val{font-size:.85rem;font-weight:700;color:var(--txt);white-space:nowrap}
        .accs-li-val.pos{color:var(--green)}
        .accs-li-val.neg{color:var(--red)}
        .accs-li-sub{margin-top:.25rem;font-size:.74rem;color:var(--txt3);line-height:1.45}
        .accs-li-comp{margin-top:.3rem;display:flex;flex-wrap:wrap;gap:.25rem .8rem;font-size:.74rem;color:var(--txt2)}
      `}</style>
    </section>
  );
}
