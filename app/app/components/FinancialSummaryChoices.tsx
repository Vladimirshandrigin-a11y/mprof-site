import { useState } from "react";
import type { FinancialSummary, SummaryChoice } from "../lib/financial-summary";

type Decision = FinancialSummary["decisions"][number];

function SummaryDecision({ row, shops, choice, onChoice }: {
  row: Decision; shops: FinancialSummary["shops"]; choice?: SummaryChoice;
  onChoice: (id: string, choice: SummaryChoice | null) => void;
}) {
  const [shop, setShop] = useState(row.knownStore ?? choice?.shop ?? "");
  const [label, setLabel] = useState(choice?.shop.startsWith("label:") ? choice.shop.slice(6) : "");
  const [month, setMonth] = useState(choice?.month ?? row.month ?? "");
  const format = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const source = row.mode === "api" ? "Ozon API" : "Документы";
  const chosenShop = shop === "label" || shop.startsWith("label:") ? "label:" + label.trim() : shop;
  return (
    <li>
      <p><b>{source} · {row.marketplace === "ozon" ? "Ozon" : "Wildberries"} · {format(row.profit)} ₽</b>
        {" · сохранён "}{new Date(row.createdAt).toLocaleDateString("ru-RU")}
        {" · "}{row.included ? "учтён" : "исключён"}</p>
      <p>{row.period ? `${row.period.from} — ${row.period.to}` : "Точные границы периода неизвестны."}</p>
      {!row.knownStore && (
        <label>Магазин{" "}
          <select value={shop.startsWith("label:") ? "label" : shop} onChange={e => setShop(e.target.value)}>
            <option value="">Выберите магазин</option>
            {row.marketplace === "ozon" && shops.map(({ key, label }) => (
              <option key={key} value={key}>Магазин Ozon · {label}</option>
            ))}
            <option value="label">Указать магазин вручную</option>
          </select>
        </label>
      )}
      {!row.knownStore && (shop === "label" || shop.startsWith("label:")) && (
        <label> Название магазина{" "}<input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} /></label>
      )}
      {!row.hasPeriod && (
        <label> Подтвердите полный отчётный месяц{" "}
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        </label>
      )}
      {" "}<button type="button" className="reports-pill"
        disabled={!chosenShop || chosenShop === "label:" || (!row.hasPeriod && !month)}
        onClick={() => onChoice(row.id, { id: row.id, shop: chosenShop, ...(row.hasPeriod ? {} : { month }) })}>
        Подтвердить магазин и учесть расчёт
      </button>
      {choice && <button type="button" className="reports-pill" onClick={() => onChoice(row.id, null)}>Снять подтверждение</button>}
    </li>
  );
}

export function FinancialSummaryChoices({ result, page, choices, onPage, onChoice }: {
  result: FinancialSummary; page: number; choices: SummaryChoice[];
  onPage: (page: number) => void;
  onChoice: (id: string, choice: SummaryChoice | null) => void;
}) {
  if (!result.decisionCount) return null;
  return (
    <details className="reports-warn">
      <summary>Проверка расчётов для сводки · исключено {result.excludedCount} из {result.decisionCount}</summary>
      <p>Подтвердите магазин и период для каждой спорной записи, которую нужно учесть.
        Если для одного магазина периоды пересекаются, сводка учитывает последнее подтверждение.
        Выбор сохраняется в этом браузере. Исходные расчёты остаются в истории.</p>
      <ul>
        {result.decisions.map(row => (
          <SummaryDecision key={row.id} row={row} shops={result.shops}
            choice={choices.find(choice => choice.id === row.id)} onChoice={onChoice} />
        ))}
      </ul>
      {page > 0 && <button type="button" className="reports-pill" onClick={() => onPage(page - 1)}>Назад</button>}
      {(page + 1) * result.decisionPageSize < result.decisionCount && (
        <button type="button" className="reports-pill" onClick={() => onPage(page + 1)}>Далее</button>
      )}
    </details>
  );
}
