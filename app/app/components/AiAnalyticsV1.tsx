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
        {/* 1. Главный вывод */}
        <section className="aiv1-sec">
          <h4 className="aiv1-sec-title">Главный вывод</h4>
          <p className="aiv1-verdict">{doc.verdict}</p>
          {doc.summary ? <p className="aiv1-summary">{doc.summary}</p> : null}
        </section>

        {/* 2. Что съедает прибыль */}
        {doc.profitLeaks.length > 0 ? (
          <section className="aiv1-sec">
            <h4 className="aiv1-sec-title">Что съедает прибыль</h4>
            <ul className="aiv1-list">
              {doc.profitLeaks.map((leak, i) => (
                <li className="aiv1-leak" key={i}>
                  <div className="aiv1-leak-title">{leak.title}</div>
                  {leak.why ? <p className="aiv1-leak-why">{leak.why}</p> : null}
                  {leak.action ? (
                    <p className="aiv1-leak-action">
                      <span className="aiv1-arrow" aria-hidden="true">
                        →
                      </span>
                      {leak.action}
                    </p>
                  ) : null}
                  {leak.expectedEffect ? (
                    <span className="aiv1-chip">Эффект: {leak.expectedEffect}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 3. Что проверить по товарам/SKU */}
        {doc.skuInsights.length > 0 ? (
          <section className="aiv1-sec">
            <h4 className="aiv1-sec-title">Что проверить по товарам</h4>
            <ul className="aiv1-list">
              {doc.skuInsights.map((sku, i) => (
                <li className="aiv1-sku" key={i}>
                  <div className="aiv1-sku-name">{sku.name}</div>
                  {sku.issue ? <p className="aiv1-sku-issue">{sku.issue}</p> : null}
                  {sku.action ? (
                    <p className="aiv1-leak-action">
                      <span className="aiv1-arrow" aria-hidden="true">
                        →
                      </span>
                      {sku.action}
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
            <h4 className="aiv1-sec-title">План действий на 7 дней</h4>
            <ol className="aiv1-plan">
              {doc.actionPlan.map((step, i) => (
                <li className="aiv1-step" key={i}>
                  <span className="aiv1-step-num">{i + 1}</span>
                  <span className="aiv1-step-body">
                    <span className="aiv1-step-action">{step.action}</span>
                    {step.expectedEffect ? (
                      <span className="aiv1-step-effect">{step.expectedEffect}</span>
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
          <div>
            <div className="aiv1-title">AI Аналитика</div>
            <div className="aiv1-subtitle">
              Персональный анализ на основе вашего отчёта
            </div>
          </div>
        </div>
      </div>
      {body}

      <style jsx global>{`
        .aiv1-card {
          position: relative;
          overflow: hidden;
        }
        .aiv1-head {
          margin-bottom: 0.6rem;
        }
        .aiv1-title-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .aiv1-title {
          font-weight: 700;
          font-size: 1.02rem;
          color: #0f172a;
          line-height: 1.2;
        }
        .aiv1-subtitle {
          font-size: 0.8rem;
          color: #64748b;
          margin-top: 0.1rem;
        }

        /* состояния (loading / error / locked / empty) */
        .aiv1-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 0.5rem;
          padding: 1.2rem 1rem;
          min-height: 220px;
        }
        .aiv1-state-title {
          margin: 0;
          font-weight: 700;
          font-size: 0.98rem;
          color: #0f172a;
        }
        .aiv1-state-note {
          margin: 0;
          font-size: 0.88rem;
          color: #64748b;
          max-width: 300px;
          line-height: 1.45;
        }
        .aiv1-lock,
        .aiv1-warn {
          width: 38px;
          height: 38px;
          color: #6366f1;
        }
        .aiv1-warn {
          color: #f59e0b;
        }
        .aiv1-lock svg,
        .aiv1-warn svg {
          width: 100%;
          height: 100%;
        }
        .aiv1-cta {
          margin-top: 0.4rem;
          border: none;
          cursor: pointer;
          padding: 0.55rem 1.1rem;
          border-radius: 10px;
          font-weight: 700;
          font-size: 0.9rem;
          color: #fff;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          box-shadow: 0 6px 18px rgba(99, 102, 241, 0.28);
          transition: transform 0.12s ease, box-shadow 0.12s ease;
        }
        .aiv1-cta:hover {
          transform: translateY(-1px);
          box-shadow: 0 8px 22px rgba(99, 102, 241, 0.36);
        }
        .aiv1-spinner {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 3px solid rgba(99, 102, 241, 0.22);
          border-top-color: #6366f1;
          animation: aiv1-spin 0.8s linear infinite;
        }
        @keyframes aiv1-spin {
          to {
            transform: rotate(360deg);
          }
        }

        /* реальный AI: 4 секции, компактно и со скроллом */
        .aiv1-scroll {
          flex: 1;
          overflow-y: auto;
          padding-right: 0.3rem;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          max-height: 340px;
        }
        .aiv1-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .aiv1-scroll::-webkit-scrollbar-thumb {
          background: rgba(100, 116, 139, 0.3);
          border-radius: 999px;
        }
        .aiv1-sec {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .aiv1-sec-title {
          margin: 0;
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #6366f1;
        }
        .aiv1-verdict {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: #0f172a;
          line-height: 1.45;
        }
        .aiv1-summary {
          margin: 0;
          font-size: 0.86rem;
          color: #475569;
          line-height: 1.45;
        }
        .aiv1-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .aiv1-leak,
        .aiv1-sku {
          background: rgba(99, 102, 241, 0.05);
          border: 1px solid rgba(99, 102, 241, 0.12);
          border-radius: 12px;
          padding: 0.6rem 0.7rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .aiv1-leak-title,
        .aiv1-sku-name {
          font-weight: 700;
          font-size: 0.9rem;
          color: #0f172a;
        }
        .aiv1-leak-why,
        .aiv1-sku-issue {
          margin: 0;
          font-size: 0.84rem;
          color: #475569;
          line-height: 1.4;
        }
        .aiv1-leak-action {
          margin: 0;
          font-size: 0.84rem;
          color: #1e293b;
          line-height: 1.4;
          display: flex;
          gap: 0.35rem;
        }
        .aiv1-arrow {
          color: #6366f1;
          font-weight: 700;
        }
        .aiv1-chip {
          align-self: flex-start;
          margin-top: 0.15rem;
          font-size: 0.76rem;
          font-weight: 600;
          color: #047857;
          background: rgba(16, 185, 129, 0.12);
          padding: 0.18rem 0.5rem;
          border-radius: 999px;
        }
        .aiv1-plan {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          counter-reset: aiv1;
        }
        .aiv1-step {
          display: flex;
          gap: 0.55rem;
          align-items: flex-start;
        }
        .aiv1-step-num {
          flex: none;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #fff;
          font-size: 0.76rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 0.05rem;
        }
        .aiv1-step-body {
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
        }
        .aiv1-step-action {
          font-size: 0.86rem;
          color: #1e293b;
          line-height: 1.4;
        }
        .aiv1-step-effect {
          font-size: 0.78rem;
          color: #64748b;
        }
      `}</style>
    </div>
  );
}
