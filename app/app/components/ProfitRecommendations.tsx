"use client";

// ============================================================================
// ProfitRecommendations — содержимое умных рекомендаций для блока «AI Аналитика».
//
// ВНУТРЕННИЙ компонент: рендерится ТОЛЬКО внутри карточки «AI Аналитика»
// (AnalyticsBlock). Свой заголовок/секцию не рисует — обёртку и шапку даёт
// host-карточка. Здесь только контент: вердикт, разбор расходов, товары,
// что проверить, как увеличить прибыль.
//
// Чисто презентационный, БЕЗ state / effect / сети. Все цифры приходят пропсами
// из уже посчитанных на странице данных (combinedResult + profitCalc +
// reportCostCoverage + reportKeyProducts). Никаких внешних AI/API — это
// rule-based разбор: пороги по марже, доле расходов и покрытию себестоимостью
// превращаются в человеческие практические рекомендации.
//
// НИЧЕГО не считает заново и не меняет формулы — только интерпретирует готовые
// значения. Парсеры, загрузка файлов, оплата, Supabase и PDF не затрагиваются.
// ============================================================================

interface ProductRef {
  article: string;
  name: string;
  profit: number;
  margin: number;
}

export interface ProfitRecommendationsProps {
  /** Загружен и распознан ли отчёт. false → аккуратное пустое состояние. */
  hasReport: boolean;
  /** Готов ли итог (в форме задана себестоимость > 0). false → «заполните данные». */
  ready: boolean;
  /** Выручка Ozon (XLSX). */
  revenue: number;
  /** Сумма к перечислению от Ozon до вычета ручных расходов. */
  profitBeforeCost: number;
  /** УПД: доп. услуги (реклама/продвижение/хранение и т.п.). */
  updServicesTotal: number;
  /** УПД: агентское вознаграждение Ozon. */
  updCommissionTotal: number;
  /** Итоговая чистая прибыль (profitCalc.netProfit). */
  netProfit: number;
  /** Маржа, % (profitCalc.margin). */
  margin: number;
  /** ROI, % (profitCalc.roi). */
  roi: number;
  /** Себестоимость товара (агрегат из формы / каталога). */
  costPrice: number;
  /** Налог, ₽. */
  tax: number;
  /** Ставка налога, %. 0 → не указана. */
  taxPercent: number;
  /** Расходы на рекламу из формы, ₽. */
  ads: number;
  /** Прочие ручные расходы (реклама+упаковка+доставка+ЗП+прочее), ₽. */
  otherExpenses: number;
  /** Покрытие себестоимостью по SKU. null — нет per-SKU данных. */
  coverage: { total: number; withCost: number; withoutCost: number } | null;
  /** Самый прибыльный товар. null — нет данных. */
  best: ProductRef | null;
  /** Самый убыточный / слабый товар. null — нет данных. */
  worst: ProductRef | null;
}

// ── Форматтеры ──────────────────────────────────────────────────────────────
function fmtRub(n: number): string {
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}
function fmtSigned(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? "−" : "+") + Math.abs(r).toLocaleString("ru-RU") + " ₽";
}
function pct(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%";
}
function shortName(s: string, max = 44): string {
  const t = (s || "").trim() || "Без названия";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function pluralTov(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return "товаров";
  if (b > 1 && b < 5) return "товара";
  if (b === 1) return "товар";
  return "товаров";
}

const INFO_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.8h.01" />
  </svg>
);

export function ProfitRecommendations(props: ProfitRecommendationsProps) {
  const {
    hasReport,
    ready,
    revenue,
    profitBeforeCost,
    updServicesTotal,
    updCommissionTotal,
    netProfit,
    margin,
    roi,
    costPrice,
    tax,
    taxPercent,
    ads,
    otherExpenses,
    coverage,
    best,
    worst,
  } = props;

  // ── Состояние 1: отчёт ещё не загружен/не распознан ──
  if (!hasReport) {
    return (
      <div className="pr">
        <div className="pr-empty">
          <span className="pr-empty-ico" aria-hidden="true">
            {INFO_ICON}
          </span>
          <p className="pr-empty-tx">
            Загрузите отчёт и заполните данные, чтобы получить рекомендации по
            увеличению чистой прибыли.
          </p>
        </div>
        <style jsx>{PR_CSS}</style>
      </div>
    );
  }

  // ── Состояние 2: отчёт загружен, но себестоимость не задана ──
  if (!ready) {
    const fbMissing: string[] = ["себестоимость товаров"];
    if (taxPercent === 0) fbMissing.push("ставку налога");
    return (
      <div className="pr">
        <div className="pr-verdict ok">
          <span className="pr-verdict-ico" aria-hidden="true">
            •
          </span>
          <div className="pr-verdict-bd">
            <div className="pr-verdict-lbl">Главный вывод</div>
            <div className="pr-verdict-ttl">
              Заполните данные — и здесь появится разбор прибыли
            </div>
            <p className="pr-verdict-txt">
              Отчёт загружен: выручка {fmtRub(revenue)}, к перечислению от Ozon{" "}
              {fmtRub(profitBeforeCost)}. Чтобы получить разбор чистой прибыли —
              где она теряется и что проверить — заполните себестоимость товаров
              и ставку налога. После этого здесь появятся конкретные
              рекомендации по вашему отчёту.
            </p>
          </div>
        </div>
        <div className="pr-fill">
          <span className="pr-fill-ico" aria-hidden="true">
            {INFO_ICON}
          </span>
          <span className="pr-fill-tx">
            Для точного анализа заполните: <b>{fbMissing.join(", ")}</b>.
          </span>
        </div>
        <style jsx>{PR_CSS}</style>
      </div>
    );
  }

  // ── Производные доли (только интерпретация готовых сумм) ──
  const updTotal = updServicesTotal + updCommissionTotal;
  const shareOf = (v: number) => (revenue > 0 ? (v / revenue) * 100 : 0);
  const updShare = shareOf(updTotal);
  const servicesShare = shareOf(updServicesTotal);
  const commissionShare = shareOf(updCommissionTotal);
  const costShare = shareOf(costPrice);
  const otherShare = shareOf(otherExpenses);

  const total = coverage?.total ?? 0;
  const withoutCost = coverage?.withoutCost ?? 0;

  // ── 1. Главный вывод (verdict) ──
  let tone: "risk" | "warn" | "ok" | "good";
  let verdictTitle: string;
  let verdict: string;
  if (netProfit < 0) {
    tone = "risk";
    verdictTitle = "Магазин работает в минус по этому отчёту";
    verdict = `Чистый убыток ${fmtRub(Math.abs(netProfit))} при выручке ${fmtRub(
      revenue
    )}. Это не приговор: ниже видно, какие расходы и товары увели прибыль в минус — начните с них.`;
  } else if (margin < 5) {
    tone = "warn";
    verdictTitle = "Прибыль есть, но запас прочности минимальный";
    verdict = `Чистая прибыль ${fmtRub(netProfit)}, но маржа всего ${pct(
      margin
    )}. Небольшой рост расходов, возвратов или скидок легко уведёт магазин в минус — стоит поджать слабые места заранее.`;
  } else if (margin < 10) {
    tone = "warn";
    verdictTitle = "Рабочий, но тонкий результат";
    verdict = `Чистая прибыль ${fmtRub(netProfit)}, маржа ${pct(
      margin
    )}. Магазин зарабатывает, но без подушки — есть смысл точечно снизить расходы и пересмотреть слабые товары.`;
  } else if (margin < 20) {
    tone = "ok";
    verdictTitle = "Нормальный, устойчивый результат";
    verdict = `Чистая прибыль ${fmtRub(netProfit)}, маржа ${pct(
      margin
    )}. Магазин работает стабильно; основной потенциал роста — в слабых SKU и расходах, а не в спасении прибыли.`;
  } else {
    tone = "good";
    verdictTitle = "Сильный результат";
    verdict = `Чистая прибыль ${fmtRub(netProfit)}, маржа ${pct(margin)}${
      roi > 0 ? `, ROI ${pct(roi)}` : ""
    }. Магазин работает уверенно — дальше речь о тонкой настройке и масштабировании, а не о сокращении расходов.`;
  }
  const verdictIco = tone === "good" ? "✓" : tone === "ok" ? "•" : "⚠";
  const accuracyNote =
    withoutCost > 0
      ? `Учтите: у ${withoutCost} из ${total} ${pluralTov(
          total
        )} не заполнена себестоимость — реальная прибыль может быть ниже расчётной.`
      : "";

  // ── 2. Где теряется прибыль (расходы как доля выручки) ──
  const buckets = [
    {
      key: "cost",
      label: "Себестоимость товаров",
      amount: costPrice,
      share: costShare,
      hot: costShare > 60,
    },
    {
      key: "services",
      label: "Услуги Ozon: реклама, продвижение, хранение",
      amount: updServicesTotal,
      share: servicesShare,
      hot: servicesShare > 18,
    },
    {
      key: "commission",
      label: "Агентское вознаграждение Ozon",
      amount: updCommissionTotal,
      share: commissionShare,
      hot: commissionShare > 18,
    },
    {
      key: "tax",
      label: `Налог${taxPercent > 0 ? ` · ${pct(taxPercent)}` : ""}`,
      amount: tax,
      share: shareOf(tax),
      hot: false,
    },
    {
      key: "other",
      label: "Прочие расходы: упаковка, доставка, ЗП",
      amount: otherExpenses,
      share: otherShare,
      hot: otherShare > 15,
    },
  ]
    .filter((b) => b.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const maxBucket = buckets.length ? buckets[0].amount : 0;

  // ── 3. Товары под контролем (best / worst) ──
  type ProdCard = { kind: "risk" | "warn" | "good"; name: string; line: string };
  const prodCards: ProdCard[] = [];
  if (worst) {
    const wName = shortName(worst.name || worst.article);
    if (worst.profit < 0) {
      prodCards.push({
        kind: "risk",
        name: wName,
        line: `Убыток ${fmtRub(Math.abs(worst.profit))}, маржа ${pct(
          worst.margin
        )}. Главный кандидат на пересмотр: цена, закуп или вывод из ассортимента.`,
      });
    } else if (worst.margin < 10) {
      prodCards.push({
        kind: "warn",
        name: wName,
        line: `Самая слабая маржа ${pct(
          worst.margin
        )}. Проверьте закуп и логистику по этому SKU.`,
      });
    }
  }
  if (best && best.profit > 0 && (!worst || best.article !== worst.article)) {
    prodCards.push({
      kind: "good",
      name: shortName(best.name || best.article),
      line: `Самый прибыльный: ${fmtSigned(best.profit)}, маржа ${pct(
        best.margin
      )}. Опора ассортимента — держите остаток и карточку.`,
    });
  }

  // ── 4. Что проверить в первую очередь ──
  type Item = { kind: "risk" | "warn" | "ok"; text: string };
  const checks: Item[] = [];
  if (netProfit < 0)
    checks.push({
      kind: "risk",
      text: "Магазин в минусе — приоритет №1 закрыть источник убытка: самые крупные статьи расходов и убыточные товары.",
    });
  if (worst && worst.profit < 0)
    checks.push({
      kind: "risk",
      text: `Убыточный товар «${shortName(
        worst.name || worst.article
      )}» тянет общую прибыль вниз — разберите его первым.`,
    });
  if (withoutCost > 0)
    checks.push({
      kind: "warn",
      text: `Заполните себестоимость у ${withoutCost} ${pluralTov(
        withoutCost
      )} — без неё чистая прибыль считается приблизительно.`,
    });
  if (updShare > 30)
    checks.push({
      kind: "warn",
      text: `Расходы Ozon забирают ${pct(
        updShare
      )} выручки — сверьте отчёт по услугам и тарифы логистики/хранения.`,
    });
  if (taxPercent === 0)
    checks.push({
      kind: "warn",
      text: "Налог не указан — итог сейчас завышен. Добавьте ставку для честного результата.",
    });
  if (checks.length === 0)
    checks.push({
      kind: "ok",
      text: "Срочных проблем не видно — ключевые показатели в норме.",
    });
  const topChecks = checks.slice(0, 4);

  // ── 5. Как увеличить чистую прибыль (рычаги) ──
  const levers: string[] = [];
  if (costShare > 55 || (worst !== null && worst.profit < 0))
    levers.push(
      "Пересоберите закуп по топ-SKU: объёмные скидки у поставщика, дешевле упаковка и доставка до склада, отказ от позиций со стабильно отрицательной маржой."
    );
  if (servicesShare > 12 || ads > 0)
    levers.push(
      "Разберите услуги Ozon по окупаемости: сравните ДРР по товарам, снимите рекламу с неокупаемых SKU, проверьте платное продвижение и хранение неликвида."
    );
  if (commissionShare > 15)
    levers.push(
      "Сравните схемы (FBO/FBS) и категории — иногда смена схемы или корректная категория заметно снижают агентское вознаграждение."
    );
  if (margin >= 20)
    levers.push(
      "Прибыль здоровая: главный рычаг — масштабировать топ-SKU и удерживать маржу при росте оборота, а не резать расходы."
    );
  if (levers.length === 0)
    levers.push(
      "Снизьте долю возвратов и невыкупов — они скрыто съедают маржу: точные размерные сетки, честные фото, прочная упаковка."
    );
  const topLevers = levers.slice(0, 3);

  // ── 6. Что заполнить для точного анализа ──
  const missing: string[] = [];
  if (withoutCost > 0)
    missing.push(`себестоимость у ${withoutCost} ${pluralTov(withoutCost)}`);
  if (taxPercent === 0) missing.push("ставку налога");

  return (
    <div className="pr">
      <div className={"pr-verdict " + tone}>
        <span className="pr-verdict-ico" aria-hidden="true">
          {verdictIco}
        </span>
        <div className="pr-verdict-bd">
          <div className="pr-verdict-lbl">Главный вывод</div>
          <div className="pr-verdict-ttl">{verdictTitle}</div>
          <p className="pr-verdict-txt">{verdict}</p>
          {accuracyNote && <p className="pr-verdict-note">{accuracyNote}</p>}
        </div>
      </div>

      <div className="pr-grid">
        {buckets.length > 0 && (
          <div className="pr-card">
            <div className="pr-card-ttl">Где теряется прибыль</div>
            <ul className="pr-bars">
              {buckets.map((b) => (
                <li key={b.key} className={"pr-bar" + (b.hot ? " hot" : "")}>
                  <div className="pr-bar-row">
                    <span className="pr-bar-lbl">{b.label}</span>
                    <span className="pr-bar-val">{pct(b.share)}</span>
                  </div>
                  <div className="pr-bar-track">
                    <div
                      className="pr-bar-fill"
                      style={{
                        width: `${
                          maxBucket > 0
                            ? Math.max(
                                5,
                                Math.round((b.amount / maxBucket) * 100)
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="pr-bar-amt">{fmtRub(b.amount)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {prodCards.length > 0 && (
          <div className="pr-card">
            <div className="pr-card-ttl">Товары под контролем</div>
            <div className="pr-prods">
              {prodCards.map((p, i) => (
                <div key={i} className={"pr-prod " + p.kind}>
                  <div className="pr-prod-top">
                    <span className="pr-prod-dot" aria-hidden="true" />
                    <span className="pr-prod-nm">{p.name}</span>
                  </div>
                  <p className="pr-prod-tx">{p.line}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pr-card">
          <div className="pr-card-ttl">Что проверить в первую очередь</div>
          <ul className="pr-list">
            {topChecks.map((c, i) => (
              <li key={i} className={"pr-li " + c.kind}>
                <span className="pr-li-ico" aria-hidden="true">
                  {c.kind === "ok" ? "✓" : "⚠"}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="pr-card">
          <div className="pr-card-ttl">Как увеличить чистую прибыль</div>
          <ul className="pr-list">
            {topLevers.map((t, i) => (
              <li key={i} className="pr-li lever">
                <span className="pr-li-ico" aria-hidden="true">
                  →
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="pr-fill">
          <span className="pr-fill-ico" aria-hidden="true">
            {INFO_ICON}
          </span>
          <span className="pr-fill-tx">
            Для более точного анализа заполните: <b>{missing.join(", ")}</b>.
          </span>
        </div>
      )}

      <style jsx>{PR_CSS}</style>
    </div>
  );
}

// ── Стили M-PROF (тёмный фон, золото/зелёные акценты). Контент живёт внутри
//    карточки «AI Аналитика», поэтому .pr — это просто layout-контейнер без
//    собственной рамки/фона. ─────────────────────────────────────────────────
const PR_CSS = `
.pr{display:block}

.pr-empty{
  display:flex;gap:11px;align-items:flex-start;
  border:1px solid rgba(201,168,76,.22);background:rgba(201,168,76,.06);
  border-radius:13px;padding:16px 16px
}
.pr-empty-ico{flex:0 0 auto;color:var(--gold2);margin-top:.1rem}
.pr-empty-ico svg{width:18px;height:18px;display:block}
.pr-empty-tx{font-size:.82rem;line-height:1.5;color:var(--txt2);margin:0;overflow-wrap:anywhere}

.pr-verdict{
  display:flex;gap:11px;align-items:flex-start;
  border-radius:13px;padding:13px 14px;margin-bottom:13px;
  border:1px solid var(--edge);background:var(--glass)
}
.pr-verdict-ico{flex:0 0 auto;font-size:1.02rem;line-height:1.3;margin-top:.04rem}
.pr-verdict-bd{flex:1 1 auto;min-width:0}
.pr-verdict-lbl{font-size:.64rem;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin-bottom:.2rem}
.pr-verdict-ttl{font-size:.92rem;font-weight:600;color:var(--txt);margin-bottom:.3rem;letter-spacing:-.01em}
.pr-verdict-txt{font-size:.8rem;line-height:1.5;color:var(--txt2);margin:0;overflow-wrap:anywhere}
.pr-verdict-note{font-size:.72rem;line-height:1.45;margin:.55rem 0 0;padding-top:.5rem;border-top:1px dashed var(--edge);color:#bfa468;overflow-wrap:anywhere}
.pr-verdict.risk{border-color:rgba(224,85,102,.35);background:rgba(224,85,102,.07)}
.pr-verdict.risk .pr-verdict-ico{color:var(--red)}
.pr-verdict.warn{border-color:rgba(232,176,75,.32);background:rgba(232,176,75,.06)}
.pr-verdict.warn .pr-verdict-ico{color:#E8B04B}
.pr-verdict.ok{border-color:rgba(201,168,76,.26);background:rgba(201,168,76,.05)}
.pr-verdict.ok .pr-verdict-ico{color:var(--gold2)}
.pr-verdict.good{border-color:rgba(46,204,138,.3);background:rgba(46,204,138,.06)}
.pr-verdict.good .pr-verdict-ico{color:var(--green)}

.pr-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:11px}
@media (max-width:720px){.pr-grid{grid-template-columns:1fr}}
.pr-card{
  border:1px solid var(--edge);background:var(--glass);
  border-radius:13px;padding:12px 13px;min-width:0
}
.pr-card-ttl{font-size:.8rem;font-weight:600;color:var(--txt);margin-bottom:10px;letter-spacing:-.01em}

.pr-bars{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.pr-bar{min-width:0}
.pr-bar-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:3px}
.pr-bar-lbl{font-size:.72rem;color:var(--txt2);line-height:1.3;overflow-wrap:anywhere}
.pr-bar-val{flex:0 0 auto;font-size:.72rem;font-weight:600;color:var(--txt);font-variant-numeric:tabular-nums}
.pr-bar-track{height:6px;border-radius:6px;background:rgba(255,255,255,.05);overflow:hidden}
.pr-bar-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--gold-d),var(--gold2))}
.pr-bar.hot .pr-bar-fill{background:linear-gradient(90deg,#a23b46,var(--red))}
.pr-bar.hot .pr-bar-val{color:#f0a9a8}
.pr-bar-amt{font-size:.66rem;color:var(--txt3);margin-top:2px;font-variant-numeric:tabular-nums}

.pr-prods{display:grid;gap:8px}
.pr-prod{border-radius:10px;padding:8px 10px;border:1px solid var(--edge)}
.pr-prod-top{display:flex;align-items:center;gap:7px;margin-bottom:3px;min-width:0}
.pr-prod-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%}
.pr-prod-nm{font-size:.74rem;font-weight:600;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pr-prod-tx{font-size:.7rem;line-height:1.42;color:var(--txt2);margin:0;overflow-wrap:anywhere}
.pr-prod.risk{background:rgba(224,85,102,.06);border-color:rgba(224,85,102,.28)}
.pr-prod.risk .pr-prod-dot{background:var(--red)}
.pr-prod.warn{background:rgba(232,176,75,.05);border-color:rgba(232,176,75,.26)}
.pr-prod.warn .pr-prod-dot{background:#E8B04B}
.pr-prod.good{background:rgba(46,204,138,.05);border-color:rgba(46,204,138,.26)}
.pr-prod.good .pr-prod-dot{background:var(--green)}

.pr-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.pr-li{display:flex;gap:8px;align-items:flex-start;font-size:.74rem;line-height:1.45;color:var(--txt2);overflow-wrap:anywhere}
.pr-li-ico{flex:0 0 auto;margin-top:.02rem;font-size:.8rem;line-height:1.35;font-weight:700}
.pr-li.risk .pr-li-ico{color:var(--red)}
.pr-li.warn .pr-li-ico{color:#E8B04B}
.pr-li.ok .pr-li-ico{color:var(--green)}
.pr-li.lever .pr-li-ico{color:var(--gold2)}

.pr-fill{
  display:flex;gap:9px;align-items:flex-start;margin-top:4px;
  border:1px solid rgba(201,168,76,.22);background:rgba(201,168,76,.06);
  border-radius:11px;padding:10px 12px
}
.pr-fill-ico{flex:0 0 auto;color:var(--gold2);margin-top:.06rem}
.pr-fill-ico svg{width:15px;height:15px;display:block}
.pr-fill-tx{font-size:.74rem;line-height:1.45;color:var(--txt2);overflow-wrap:anywhere}
.pr-fill-tx b{color:var(--gold3);font-weight:600}
`;
