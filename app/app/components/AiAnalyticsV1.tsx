"use client";

import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase-cloud";

// ============================================================================
// AI Аналитика v1 — компактный платный блок.
//
// Источник данных — ТОЛЬКО серверный /api/ai/profit-advice (Timeweb AI Gateway,
// GPT-5 mini). Реальный AI рендерим лишь при source==="timeweb_gateway" с валидным
// aiDoc. Нет настоящего ответа → честные состояния (loading / временно недоступно /
// заглушка для не-премиум). Никакой rule-based «Базовой аналитики» под видом AI.
//
// Запрос уходит только для premium (449₽ unlimited); сервер всё равно проверяет
// тариф независимо. Тело — готовая безопасная подпись агрегатов (payloadSig).
// ============================================================================

type ProfitLeak = {
  title: string;
  why: string;
  action: string;
  expectedEffect: string;
};
type SkuInsight = { name: string; issue: string; action: string };
type ActionItem = { action: string; expectedEffect: string };

type AiDoc = {
  verdict: string;
  summary: string;
  profitLeaks: ProfitLeak[];
  skuInsights: SkuInsight[];
  actionPlan: ActionItem[];
};

type ApiResponse = {
  source?: string;
  model?: string;
  aiDoc?: Partial<AiDoc>;
};

type Props = {
  /** Готовая безопасная подпись агрегатов (тело запроса). "" → данных нет. */
  payloadSig: string;
  /** Активный тариф 449₽ unlimited. Без него запрос не уходит. */
  hasPremium: boolean;
  /** Открыть окно покупки тарифа (для не-премиум состояния). */
  onOpenPremium?: () => void;
};

type Status = "idle" | "loading" | "ready" | "error";

const SparkIcon = () => (
  <span className="ai-spark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
    </svg>
  </span>
);

/** Контент валиден только если есть главный вывод и хотя бы утечка или шаг плана. */
function isValidDoc(doc: Partial<AiDoc> | undefined): doc is AiDoc {
  if (!doc || typeof doc !== "object") return false;
  if (typeof doc.verdict !== "string" || !doc.verdict.trim()) return false;
  const leaks = Array.isArray(doc.profitLeaks) ? doc.profitLeaks.length : 0;
  const plan = Array.isArray(doc.actionPlan) ? doc.actionPlan.length : 0;
  return leaks > 0 || plan > 0;
}

export function AiAnalyticsV1({ payloadSig, hasPremium, onOpenPremium }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [doc, setDoc] = useState<AiDoc | null>(null);

  useEffect(() => {
    // Запрос только для премиума и при наличии данных. Иначе — без вызова.
    if (!hasPremium || !payloadSig) {
      setStatus("idle");
      setDoc(null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setStatus("loading");
    setDoc(null);

    (async () => {
      try {
        // Токен берём прямо перед запросом — сервер верифицирует его сам.
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) {
          if (active) setStatus("error");
          return;
        }
        const res = await fetch("/api/ai/profit-advice", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: payloadSig,
          signal: controller.signal,
        });
        if (!active) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as ApiResponse;
        if (!active) return;
        if (json.source === "timeweb_gateway" && isValidDoc(json.aiDoc)) {
          setDoc({
            verdict: json.aiDoc.verdict,
            summary:
              typeof json.aiDoc.summary === "string" ? json.aiDoc.summary : "",
            profitLeaks: Array.isArray(json.aiDoc.profitLeaks)
              ? json.aiDoc.profitLeaks
              : [],
            skuInsights: Array.isArray(json.aiDoc.skuInsights)
              ? json.aiDoc.skuInsights
              : [],
            actionPlan: Array.isArray(json.aiDoc.actionPlan)
              ? json.aiDoc.actionPlan
              : [],
          });
          setStatus("ready");
        } else {
          // source: "timeweb_gateway_error" или невалидный контент → недоступно.
          setStatus("error");
        }
      } catch {
        if (active) setStatus("error");
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [hasPremium, payloadSig]);

  // ── состояния без реального AI ──────────────────────────────────────────────
  let body: ReactNode;

  if (!hasPremium) {
    body = (
      <div className="aiv1-state" role="status">
        <span className="aiv1-lock" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
        <p className="aiv1-state-title">AI-аналитика на тарифе Безлимит</p>
        <p className="aiv1-state-note">
          Персональный разбор прибыли по вашему отчёту доступен в тарифе
          «Безлимит» (449&nbsp;₽/мес).
        </p>
        {onOpenPremium ? (
          <button type="button" className="aiv1-cta" onClick={onOpenPremium}>
            Открыть Безлимит
          </button>
        ) : null}
      </div>
    );
  } else if (!payloadSig) {
    body = (
      <div className="aiv1-state" role="status">
        <SparkIcon />
        <p className="aiv1-state-title">Добавьте расчёт</p>
        <p className="aiv1-state-note">
          Загрузите отчёт и сделайте расчёт — AI разберёт вашу прибыль.
        </p>
      </div>
    );
  } else if (status === "loading") {
    body = (
      <div className="aiv1-state" role="status" aria-live="polite">
        <span className="aiv1-spinner" aria-hidden="true" />
        <p className="aiv1-state-title">AI анализирует отчёт…</p>
        <p className="aiv1-state-note">Это занимает несколько секунд.</p>
      </div>
    );
  } else if (status === "error") {
    body = (
      <div className="aiv1-state" role="status" aria-live="polite">
        <span className="aiv1-warn" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        <p className="aiv1-state-title">AI-аналитика временно недоступна</p>
        <p className="aiv1-state-note">Попробуйте позже.</p>
      </div>
    );
  } else if (status === "ready" && doc) {
    body = (
      <div className="aiv1-scroll">
        {/* 1. Главный вывод — отдельная gold-плашка */}
        <section className="aiv1-sec aiv1-sec-verdict">
          <div className="aiv1-sec-label">Главный вывод</div>
          <p className="aiv1-verdict">{doc.verdict}</p>
          {doc.summary ? <p className="aiv1-summary">{doc.summary}</p> : null}
        </section>

        {/* 2. Что сильнее всего съедает прибыль */}
        {doc.profitLeaks.length > 0 ? (
          <section className="aiv1-sec">
            <div className="aiv1-sec-label">Что сильнее всего съедает прибыль</div>
            <ul className="aiv1-list">
              {doc.profitLeaks.map((leak, i) => (
                <li className="aiv1-plate aiv1-plate-risk" key={i}>
                  <div className="aiv1-plate-title">{leak.title}</div>
                  {leak.why ? <p className="aiv1-plate-text">{leak.why}</p> : null}
                  {leak.action ? (
                    <p className="aiv1-plate-action">
                      <span className="aiv1-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="aiv1-plate-action-text">{leak.action}</span>
                    </p>
                  ) : null}
                  {leak.expectedEffect ? (
                    <span className="aiv1-chip aiv1-chip-effect">
                      Эффект: {leak.expectedEffect}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 3. Что проверить в первую очередь */}
        {doc.skuInsights.length > 0 ? (
          <section className="aiv1-sec">
            <div className="aiv1-sec-label">Что проверить в первую очередь</div>
            <ul className="aiv1-list">
              {doc.skuInsights.map((sku, i) => (
                <li className="aiv1-plate" key={i}>
                  <div className="aiv1-plate-title">{sku.name}</div>
                  {sku.issue ? <p className="aiv1-plate-text">{sku.issue}</p> : null}
                  {sku.action ? (
                    <p className="aiv1-plate-action">
                      <span className="aiv1-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className="aiv1-plate-action-text">{sku.action}</span>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 4. План действий на 7 дней */}
        {doc.actionPlan.length > 0 ? (
          <section className="aiv1-sec">
            <div className="aiv1-sec-label">План действий на 7 дней</div>
            <ol className="aiv1-plan">
              {doc.actionPlan.map((step, i) => (
                <li className="aiv1-step" key={i}>
                  <span className="aiv1-step-num">{i + 1}</span>
                  <span className="aiv1-step-body">
                    <span className="aiv1-step-action">{step.action}</span>
                    {step.expectedEffect ? (
                      <span className="aiv1-chip aiv1-chip-effect">
                        Эффект: {step.expectedEffect}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    );
  } else {
    body = null;
  }

  return (
    <div
      className="an-card an-ai-card an-area-ai aiv1-card"
      role="region"
      aria-label="AI Аналитика"
    >
      <span className="ai-card-shine" aria-hidden="true" />
      <div className="an-card-head aiv1-head">
        <div className="aiv1-title-row">
          <SparkIcon />
          <div className="aiv1-title-col">
            <div className="aiv1-title">AI Аналитика</div>
            <div className="aiv1-subtitle">
              Персональный анализ на основе вашего отчёта
            </div>
          </div>
        </div>
      </div>
      {body}

      <style jsx global>{`
        /* ============ AI Аналитика v1 — премиальный тёмный блок ============ */
        /* Палитра сайта: тёмный фон + gold-акцент (#C9A84C/#E8C97A),
           текст #E8EEF8/#9FB1CB, зелёный #2ECC8A только для «эффекта/плюса»,
           красный #E05566 только для риска. Шрифты Playfair / DM Mono. */
        .aiv1-card {
          position: relative;
          overflow: hidden;
          min-width: 0;
        }
        /* ----- высота блока: компактная, как левая колонка; скролл ВНУТРИ ----- */
        /* Компаунд .an-ai-card.aiv1-card (специфичность 0,2,0) перекрывает
           min-height:390px из AnalyticsBlock — сам AnalyticsBlock НЕ трогаем.
           max-height ломает «растягивание» (AI больше не тянет сетку вниз):
           длинный ответ скроллится внутри .aiv1-scroll, страница не растёт.
           Значение подобрано по месту: низ AI-карточки доходит до низа блока
           «Последние расчёты» слева (левая колонка ≈539px), но НЕ растягивает
           сетку — recent остаётся в своём размере (порог растяжки выше ~537px). */
        .an-ai-card.aiv1-card {
          min-height: 240px;
          max-height: 535px;
          align-self: stretch;
        }
        /* мобайл (сетка уже стекается с 900px): обычный поток страницы, без
           внутреннего скролла и без горизонтального overflow. */
        @media (max-width: 900px) {
          .an-ai-card.aiv1-card {
            max-height: none;
            min-height: 0;
          }
        }

        /* шапка (работает поверх .an-card-head, ничего в нём не ломая) */
        .aiv1-title-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          min-width: 0;
        }
        .aiv1-title-col {
          min-width: 0;
        }
        .aiv1-title {
          font-family: "Playfair Display", Georgia, serif;
          font-weight: 700;
          font-size: 1rem;
          color: #e8eef8;
          line-height: 1.2;
          letter-spacing: -0.01em;
        }
        .aiv1-subtitle {
          font-family: "DM Mono", monospace;
          font-size: 0.55rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #e8c97a;
          opacity: 0.72;
          margin-top: 0.22rem;
          overflow-wrap: anywhere;
        }

        /* ---------- состояния: locked / empty / loading / error ---------- */
        .aiv1-state {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 0.55rem;
          padding: 1.4rem 1.3rem 1.7rem;
        }
        .aiv1-state-title {
          margin: 0;
          font-family: "Playfair Display", Georgia, serif;
          font-weight: 700;
          font-size: 1rem;
          color: #e8eef8;
        }
        .aiv1-state-note {
          margin: 0;
          font-size: 0.82rem;
          color: #9fb1cb;
          max-width: 300px;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        .aiv1-lock,
        .aiv1-warn {
          width: 40px;
          height: 40px;
        }
        .aiv1-lock {
          color: #e8c97a;
        }
        .aiv1-warn {
          color: #e8a14c; /* оранжевый — внимание/риск */
        }
        .aiv1-lock svg,
        .aiv1-warn svg {
          width: 100%;
          height: 100%;
        }
        .aiv1-cta {
          margin-top: 0.5rem;
          border: none;
          cursor: pointer;
          padding: 0.55rem 1.25rem;
          border-radius: 10px;
          font-family: "DM Mono", monospace;
          font-weight: 700;
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #05070f;
          background: linear-gradient(135deg, #c9a84c 0%, #e8c97a 100%);
          box-shadow: 0 8px 22px rgba(201, 168, 76, 0.35);
          transition: transform 0.12s ease, box-shadow 0.12s ease;
        }
        .aiv1-cta:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 26px rgba(201, 168, 76, 0.46);
        }
        .aiv1-spinner {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 3px solid rgba(201, 168, 76, 0.22);
          border-top-color: #e8c97a;
          animation: aiv1-spin 0.8s linear infinite;
        }
        @keyframes aiv1-spin {
          to {
            transform: rotate(360deg);
          }
        }

        /* ---------- реальный AI: аккуратный скролл внутри карточки ---------- */
        /* Сетка задаёт высоту AI-карточке (правая колонка на 2 строки), поэтому
           flex:1 + min-height:0 даёт внутренний скролл, не ломая общий блок. */
        .aiv1-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 0.1rem 1.05rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          scrollbar-width: thin;
          scrollbar-color: rgba(201, 168, 76, 0.32) transparent;
        }
        .aiv1-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .aiv1-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .aiv1-scroll::-webkit-scrollbar-thumb {
          background: rgba(201, 168, 76, 0.3);
          border-radius: 999px;
        }

        /* ---------- секции ---------- */
        .aiv1-sec {
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          min-width: 0;
        }
        .aiv1-sec-label {
          font-family: "DM Mono", monospace;
          font-size: 0.56rem;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #e8c97a;
          opacity: 0.92;
          overflow-wrap: anywhere;
        }

        /* главный вывод — выделенная gold-плашка */
        .aiv1-sec-verdict {
          background: rgba(201, 168, 76, 0.09);
          border: 1px solid rgba(201, 168, 76, 0.22);
          border-radius: 12px;
          padding: 0.7rem 0.8rem;
          gap: 0.35rem;
        }
        .aiv1-verdict {
          margin: 0;
          font-size: 0.92rem;
          font-weight: 600;
          color: #e8eef8;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        .aiv1-summary {
          margin: 0;
          font-size: 0.81rem;
          color: #9fb1cb;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }

        /* список плашек (утечки прибыли / проверки по товарам) */
        .aiv1-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .aiv1-plate {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 0.6rem 0.72rem;
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          min-width: 0;
        }
        /* риск — сдержанный красно-оранжевый акцент слева */
        .aiv1-plate-risk {
          border-left: 3px solid rgba(224, 85, 102, 0.75);
        }
        .aiv1-plate-title {
          font-weight: 700;
          font-size: 0.87rem;
          color: #e8eef8;
          line-height: 1.35;
          overflow-wrap: anywhere;
        }
        .aiv1-plate-text {
          margin: 0;
          font-size: 0.81rem;
          color: #9fb1cb;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        .aiv1-plate-action {
          margin: 0;
          font-size: 0.81rem;
          color: #cdd9ea;
          line-height: 1.5;
          display: flex;
          gap: 0.4rem;
          align-items: baseline;
          min-width: 0;
        }
        .aiv1-plate-action-text {
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .aiv1-arrow {
          color: #e8c97a;
          font-weight: 700;
          flex: none;
        }

        /* чип «Эффект» — зелёный (плюс) */
        .aiv1-chip {
          align-self: flex-start;
          max-width: 100%;
          margin-top: 0.1rem;
          font-family: "DM Mono", monospace;
          font-size: 0.66rem;
          font-weight: 600;
          line-height: 1.4;
          padding: 0.22rem 0.5rem;
          border-radius: 8px;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .aiv1-chip-effect {
          color: #2ecc8a;
          background: rgba(46, 204, 138, 0.12);
          border: 1px solid rgba(46, 204, 138, 0.24);
        }

        /* план действий — нумерованный список */
        .aiv1-plan {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .aiv1-step {
          display: flex;
          gap: 0.6rem;
          align-items: flex-start;
          min-width: 0;
        }
        .aiv1-step-num {
          flex: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: linear-gradient(135deg, #c9a84c, #e8c97a);
          color: #05070f;
          font-family: "DM Mono", monospace;
          font-size: 0.72rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 0.06rem;
        }
        .aiv1-step-body {
          display: flex;
          flex-direction: column;
          gap: 0.22rem;
          min-width: 0;
        }
        .aiv1-step-action {
          font-size: 0.84rem;
          color: #e2e9f4;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }

        /* ---------- mobile ---------- */
        @media (max-width: 560px) {
          .aiv1-scroll {
            padding: 0.1rem 0.85rem 0.9rem;
            gap: 0.65rem;
          }
          .aiv1-title {
            font-size: 0.95rem;
          }
          .aiv1-verdict {
            font-size: 0.88rem;
          }
          .aiv1-plate {
            padding: 0.55rem 0.65rem;
          }
        }
      `}</style>
    </div>
  );
}
