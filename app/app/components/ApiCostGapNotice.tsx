"use client";

// ============================================================================
// Блок «Не хватает себестоимости у товаров» API-расчёта (ответ 400 incomplete_cost).
// Вынесен из page.tsx без изменения разметки и классов (стили api-costgap* / api-pro-*
// — глобальные, в page.tsx), чтобы его можно было отрисовать в изолированном стенде
// с мок-ответом. Расчёт не сделан, попытка не списана; итог автодобавления товаров в
// каталог показывается честно: число добавленных, неоднозначные, строки без артикула
// или ошибка (при ошибке «успех» не показывается).
// ============================================================================

import { pluralRu } from "../lib/accrual/format";
import type { ApiCostGap } from "../lib/api-cost-gap";

const fmt = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });

export function ApiCostGapNotice({ gap, onOpenCatalog }: { gap: ApiCostGap; onOpenCatalog: () => void }) {
  return (
    <div className="api-costgap" role="alert">
      <div className="api-costgap-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18, flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" />
          <circle cx="12" cy="16.4" r=".7" fill="currentColor" />
        </svg>
        Не хватает себестоимости у товаров
      </div>
      <p className="api-costgap-sub">
        Чтобы рассчитать чистую прибыль, заполните себестоимость всех
        товаров в каталоге. Сейчас расчёт не сделан и попытка не
        списана.
      </p>
      <div className="api-costgap-stats">
        {gap.unmatchedItems > 0 && (
          <span className="api-costgap-chip">
            Не сопоставлено с каталогом: {fmt(gap.unmatchedItems)}
          </span>
        )}
        {gap.matchedNoCostCount > 0 && (
          <span className="api-costgap-chip">
            Без себестоимости (0 ₽): {fmt(gap.matchedNoCostCount)}
          </span>
        )}
        {gap.status === "no_cost" &&
          gap.unmatchedItems === 0 &&
          gap.matchedNoCostCount === 0 && (
            <span className="api-costgap-chip">
              Себестоимость не найдена
            </span>
          )}
      </div>
      <div className="api-costgap-actions">
        <button type="button" className="api-pro-btn" onClick={onOpenCatalog}>
          Перейти в каталог товаров
        </button>
      </div>
      {gap.catalogImport.attempted &&
        gap.catalogImport.ok &&
        gap.catalogImport.created > 0 && (
          <p className="api-pro-msg ok" style={{ marginTop: ".8rem" }}>
            Добавлено в каталог: {fmt(gap.catalogImport.created)}{" "}
            {pluralRu(gap.catalogImport.created, "товар", "товара", "товаров")} без
            себестоимости. Укажите её в каталоге товаров и повторите расчёт.
          </p>
        )}
      {gap.catalogImport.attempted &&
        gap.catalogImport.ok &&
        gap.catalogImport.ambiguous > 0 && (
          <p className="api-pro-msg" style={{ marginTop: ".8rem" }}>
            Не добавлено из-за неоднозначного сопоставления:{" "}
            {fmt(gap.catalogImport.ambiguous)}. Проверьте каталог и добавьте такие
            товары вручную.
          </p>
        )}
      {gap.catalogImport.attempted &&
        gap.catalogImport.ok &&
        gap.catalogImport.rowsWithoutOfferId > 0 && (
          <p className="api-pro-msg" style={{ marginTop: ".8rem" }}>
            Строк отчёта без артикула: {fmt(gap.catalogImport.rowsWithoutOfferId)} —
            их нельзя добавить в каталог автоматически.
          </p>
        )}
      {gap.catalogImport.attempted && !gap.catalogImport.ok && (
        <p className="api-pro-msg err" style={{ marginTop: ".8rem" }}>
          Не удалось добавить товары в каталог: {gap.catalogImport.error}. Товары не
          добавлены — повторите расчёт или добавьте их вручную.
        </p>
      )}
    </div>
  );
}
