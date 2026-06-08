"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../app/lib/supabase-cloud";

export type TariffTier = "single" | "unlimited";

interface Props {
  open: boolean;
  tier: TariffTier | null;
  onClose: () => void;
}

const TIER_DATA: Record<
  TariffTier,
  {
    name: string;
    priceNumber: number;
    isSub: boolean;
    period: string;
    perks: string[];
  }
> = {
  single: {
    name: "Разовый расчёт",
    priceNumber: 149,
    isSub: false,
    period: "Один платёж",
    perks: [
      "Один расчёт за месячный отчёт",
      "Сохранение результата в историю",
      "Без подписки и автосписаний",
    ],
  },
  unlimited: {
    name: "Безлимит",
    priceNumber: 449,
    isSub: true,
    period: "Подписка на 30 дней",
    perks: [
      "Неограниченное число расчётов в месяц",
      "AI аналитика и рекомендации",
      "Полная история без ограничений",
      "Приоритетная поддержка",
    ],
  },
};

const PROCESSING_DELAY_MS = 2400;

// === RELEASE v1.0 ===
// Premium РАЗБЛОКИРОВАН — модалка показывает рабочий интерфейс тарифа (шаги 1–3).
// Реальная онлайн-оплата (ЮKassa) ещё подключается: шаг 3 честно сообщает, что
// оплата завершается, все функции пока бесплатны. «🔒 Скоро»-состояние модалки
// сохранено в коде ниже (поставь флаг → true), ничего не удалено.
const PAYMENT_COMING_SOON: boolean = false;

export function TariffModal({ open, tier, onClose }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Этап 1.5: реальная оплата через POST /api/payment/create.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Сбрасываем шаг и платёжное состояние при каждом открытии модалки
  useEffect(() => {
    if (open) {
      setStep(1);
      setLoading(false);
      setError(null);
    }
  }, [open, tier]);

  // Auto-advance step 2 → 3
  useEffect(() => {
    if (!open || step !== 2) return;
    const t = window.setTimeout(() => setStep(3), PROCESSING_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [open, step]);

  // Esc + body-lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const data = TIER_DATA[tier ?? "unlimited"];
  const plan: TariffTier = tier ?? "unlimited";

  // Создаёт платёж на бэкенде и редиректит в ЮKassa. Сумма и провайдер —
  // на сервере (PLAN_PRICING); сюда приходит только confirmationUrl.
  const handlePay = async () => {
    setError(null);
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError("Войдите в аккаунт, чтобы оформить тариф.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/payment/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });
      const result = (await res.json().catch(() => null)) as {
        ok?: boolean;
        confirmationUrl?: string;
        error?: string;
      } | null;

      if (result?.ok && result.confirmationUrl) {
        // Уходим на страницу оплаты ЮKassa — loading не снимаем.
        window.location.href = result.confirmationUrl;
        return;
      }

      // ЮKassa не настроена / любая иная ошибка — честное сообщение в модалке.
      setError("Оплата пока не настроена. Попробуйте позже.");
      setLoading(false);
    } catch {
      setError("Оплата пока не настроена. Попробуйте позже.");
      setLoading(false);
    }
  };

  return (
    <>
      <style jsx>{`
        .tm-overlay{
          position:fixed;inset:0;z-index:1000;
          background:rgba(4,6,14,.78);
          backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          display:flex;align-items:center;justify-content:center;
          padding:1.5rem;
          animation:tmFadeIn .28s ease both;
          font-family:'Outfit',sans-serif;color:#E8EEF8
        }
        @keyframes tmFadeIn{from{opacity:0}to{opacity:1}}

        .tm-card{
          position:relative;
          max-width:520px;width:100%;min-height:390px;
          background:linear-gradient(160deg,
            rgba(201,168,76,.10) 0%,
            rgba(13,16,32,.96) 70%);
          border:1px solid rgba(201,168,76,.32);
          border-radius:22px;
          padding:3.4rem 2.4rem 2.2rem;
          backdrop-filter:blur(22px) saturate(1.3);
          -webkit-backdrop-filter:blur(22px) saturate(1.3);
          box-shadow:0 32px 90px rgba(0,0,0,.6),
            0 0 90px rgba(201,168,76,.16);
          overflow:hidden;display:flex;flex-direction:column;
          animation:tmSlideIn .35s cubic-bezier(.22,1,.36,1) both
        }
        @keyframes tmSlideIn{
          from{opacity:0;transform:translateY(12px) scale(.97)}
          to{opacity:1;transform:translateY(0) scale(1)}
        }
        /* мягкий warm glow по всему верху card */
        .tm-card::before{
          content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
          background:radial-gradient(540px 300px at 50% -12%,
            rgba(201,168,76,.18), transparent 60%)
        }
        /* spotlight ограничен по ширине — НЕ заходит под крестик в правом углу */
        .tm-card::after{
          content:"";position:absolute;
          left:12%;right:32%;top:0;height:100px;
          background:radial-gradient(260px 70px at 40% 0%,
            rgba(232,201,122,.16), transparent 70%);
          pointer-events:none;z-index:0;
          filter:blur(20px)
        }
        .tm-card > *{position:relative;z-index:1}

        /* === Close button — floating glass island above ALL decorative layers === */
        .tm-close{
          position:absolute;top:14px;right:14px;
          width:36px;height:36px;border-radius:11px;
          /* opaque dark backdrop -> ни одна линия/glow/shimmer не «просвечивает» */
          background:rgba(11,14,28,.92);
          border:1px solid rgba(255,255,255,.12);
          color:#A1B3CC;cursor:pointer;padding:0;
          /* z-index выше всех decorative слоёв (::before, ::after, .tm-step) */
          z-index:100;
          display:inline-flex;align-items:center;justify-content:center;
          backdrop-filter:blur(14px) saturate(1.2);
          -webkit-backdrop-filter:blur(14px) saturate(1.2);
          box-shadow:0 4px 14px rgba(0,0,0,.4),
            inset 0 1px 0 rgba(255,255,255,.06);
          transition:transform .22s cubic-bezier(.22,1,.36,1),
            border-color .22s ease, background .22s ease,
            color .22s ease, box-shadow .22s ease;
          -webkit-appearance:none;appearance:none
        }
        .tm-close:hover{
          transform:scale(1.08);
          border-color:rgba(232,201,122,.6);
          color:#F5DFA0;
          background:rgba(36,28,14,.92);
          box-shadow:0 10px 26px rgba(201,168,76,.34),
            0 0 0 4px rgba(201,168,76,.10),
            inset 0 1px 0 rgba(255,255,255,.08)
        }
        .tm-close:active{transform:scale(.96);transition-duration:.08s}
        .tm-close:focus-visible{
          outline:none;
          border-color:rgba(232,201,122,.7);
          box-shadow:0 0 0 3px rgba(201,168,76,.32),
            0 4px 14px rgba(0,0,0,.4)
        }
        .tm-close svg{width:13px;height:13px;display:block}

        /* === Progress steps (Linear/Stripe-style: thin, clean, no visual noise) === */
        .tm-steps{
          display:flex;align-items:center;gap:.45rem;
          margin:0 0 1.5rem;
          /* отступ справа гарантирует что pills никогда не подходят
             вплотную к закрывающему крестику */
          padding-right:54px
        }
        .tm-step-dot{
          width:18px;height:3px;border-radius:2px;
          background:rgba(255,255,255,.10);
          transition:width .4s cubic-bezier(.22,1,.36,1),
            background .25s ease, box-shadow .25s ease
        }
        .tm-step-dot.active{
          width:28px;
          background:linear-gradient(90deg,#C9A84C 0%,#E8C97A 100%);
          box-shadow:0 0 10px rgba(201,168,76,.32)
        }
        .tm-step-dot.done{
          width:18px;
          background:rgba(201,168,76,.32)
        }

        .tm-step{
          display:flex;flex-direction:column;flex:1;min-height:0;
          animation:stepIn .38s cubic-bezier(.22,1,.36,1) both
        }
        @keyframes stepIn{
          from{opacity:0;transform:translateY(8px) scale(.985)}
          to{opacity:1;transform:translateY(0) scale(1)}
        }

        .tm-pro-badge{
          display:inline-flex;align-self:flex-start;align-items:center;gap:6px;
          font-family:'DM Mono',monospace;font-size:.58rem;font-weight:700;
          text-transform:uppercase;letter-spacing:.16em;color:#05070f;
          background:linear-gradient(135deg,#C9A84C,#E8C97A);
          padding:5px 11px;border-radius:100px;
          box-shadow:0 6px 16px rgba(201,168,76,.42);
          margin-bottom:.9rem
        }
        .tm-pro-badge svg{width:10px;height:10px;display:block}

        .tm-title{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.55rem;font-weight:700;color:#E8EEF8;
          letter-spacing:-.012em;line-height:1.2;margin:0
        }
        .tm-title em{font-style:italic;color:#E8C97A}

        .tm-price-row{
          display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap;
          margin:1.4rem 0 .25rem
        }
        .tm-price{
          font-family:'Playfair Display',Georgia,serif;
          font-size:3rem;font-weight:700;letter-spacing:-.032em;line-height:1;
          color:#E8EEF8
        }
        .tm-price em{font-style:normal;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 60%,#C9A84C 100%);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent}
        .tm-mo{
          font-family:'DM Mono',monospace;font-size:.78rem;
          color:#8A9FBB;font-weight:400;letter-spacing:.04em
        }
        .tm-period{
          font-family:'DM Mono',monospace;font-size:.6rem;
          text-transform:uppercase;letter-spacing:.14em;
          color:#8A9FBB;margin:0 0 1.4rem
        }

        .tm-perks{
          list-style:none;padding:0;margin:0 0 1.8rem;
          display:flex;flex-direction:column;gap:.55rem
        }
        .tm-perks li{
          display:flex;align-items:flex-start;gap:.7rem;
          font-size:.92rem;color:#E8EEF8;font-weight:300;line-height:1.5
        }
        .tm-check{
          width:20px;height:20px;border-radius:6px;flex-shrink:0;margin-top:1px;
          background:linear-gradient(135deg,rgba(201,168,76,.26),rgba(201,168,76,.06));
          border:1px solid rgba(201,168,76,.32);
          color:#E8C97A;
          display:inline-flex;align-items:center;justify-content:center
        }
        .tm-check svg{width:11px;height:11px;display:block}

        /* === STEP 2 processing === */
        .tm-loader{display:flex;align-items:center;justify-content:center;
          margin:2rem 0 1.6rem}
        .tm-spinner{
          width:84px;height:84px;border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg,
            rgba(201,168,76,.18),
            rgba(201,168,76,.04));
          border:1px solid rgba(201,168,76,.3);
          box-shadow:0 14px 38px rgba(201,168,76,.22),
            inset 0 1px 0 rgba(255,255,255,.08);
          animation:tmSpinnerPulse 2.4s ease-in-out infinite;
          position:relative
        }
        @keyframes tmSpinnerPulse{
          0%,100%{box-shadow:0 14px 38px rgba(201,168,76,.22),
            inset 0 1px 0 rgba(255,255,255,.08),
            0 0 0 0 rgba(201,168,76,.16)}
          50%{box-shadow:0 16px 42px rgba(201,168,76,.32),
            inset 0 1px 0 rgba(255,255,255,.08),
            0 0 0 14px rgba(201,168,76,.04)}
        }
        .tm-ring{
          width:40px;height:40px;border-radius:50%;
          border:2.5px solid rgba(201,168,76,.18);
          border-top-color:#E8C97A;
          animation:tmRing .85s linear infinite
        }
        @keyframes tmRing{to{transform:rotate(360deg)}}

        .tm-progress{
          width:100%;height:6px;border-radius:3px;
          background:rgba(255,255,255,.05);
          overflow:hidden;position:relative;
          margin-top:1.5rem
        }
        .tm-progress::before{
          content:"";position:absolute;top:0;left:-35%;width:35%;height:100%;
          border-radius:3px;
          background:linear-gradient(90deg,
            rgba(201,168,76,0) 0%,
            rgba(201,168,76,.6) 30%,
            rgba(232,201,122,1) 50%,
            rgba(201,168,76,.6) 70%,
            rgba(201,168,76,0) 100%);
          animation:tmProgress 1.6s ease-in-out infinite;
          box-shadow:0 0 14px rgba(201,168,76,.45)
        }
        @keyframes tmProgress{
          0%{left:-35%}
          100%{left:100%}
        }

        /* === STEP 3 success === */
        .tm-success-icon{
          width:88px;height:88px;border-radius:24px;align-self:center;
          display:inline-flex;align-items:center;justify-content:center;
          background:linear-gradient(135deg,
            rgba(46,204,138,.28),
            rgba(46,204,138,.06));
          border:1px solid rgba(46,204,138,.42);
          color:#7DEAB2;margin:1.2rem 0 1.4rem;
          box-shadow:0 16px 42px rgba(46,204,138,.32),
            inset 0 1px 0 rgba(255,255,255,.08);
          animation:tmSuccessIn .55s cubic-bezier(.34,1.56,.64,1) both,
            tmSuccessPulse 3s ease-in-out infinite 0.55s
        }
        @keyframes tmSuccessIn{
          from{opacity:0;transform:scale(.55) rotate(-14deg)}
          to{opacity:1;transform:scale(1) rotate(0)}
        }
        @keyframes tmSuccessPulse{
          0%,100%{box-shadow:0 16px 42px rgba(46,204,138,.32),
            inset 0 1px 0 rgba(255,255,255,.08),
            0 0 0 0 rgba(46,204,138,.16)}
          50%{box-shadow:0 18px 48px rgba(46,204,138,.38),
            inset 0 1px 0 rgba(255,255,255,.08),
            0 0 0 14px rgba(46,204,138,.04)}
        }
        .tm-success-icon svg{width:40px;height:40px;display:block}

        .tm-sub{
          font-size:.93rem;color:#8A9FBB;font-weight:300;line-height:1.6;
          margin:.6rem 0 1.8rem;text-align:center;
          max-width:380px;margin-left:auto;margin-right:auto
        }
        .tm-text-center{text-align:center}

        /* === Buttons === */
        .tm-actions{
          display:flex;gap:.7rem;flex-wrap:wrap;margin-top:auto
        }
        .tm-btn{
          flex:1;min-width:160px;
          font-family:'Outfit',sans-serif;font-size:.9rem;font-weight:600;
          padding:13px 22px;border-radius:11px;cursor:pointer;
          transition:transform .22s ease, box-shadow .22s ease, background .22s ease,
            color .22s ease, border-color .22s ease;
          display:inline-flex;align-items:center;justify-content:center;gap:8px;
          text-decoration:none;border:none;letter-spacing:.01em;
          -webkit-appearance:none;appearance:none
        }
        .tm-btn-ghost{
          background:rgba(255,255,255,.04);color:#E8EEF8;
          border:1px solid rgba(255,255,255,.12)
        }
        .tm-btn-ghost:hover{
          border-color:#C9A84C;color:#E8C97A;
          background:rgba(201,168,76,.08);transform:translateY(-1px)
        }
        .tm-btn-gold{
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 100%);
          color:#05070f;box-shadow:0 10px 28px rgba(201,168,76,.32)
        }
        .tm-btn-gold:hover{
          transform:translateY(-2px) scale(1.02);
          box-shadow:0 18px 44px rgba(201,168,76,.5),
            0 0 28px rgba(201,168,76,.22)
        }
        .tm-btn-gold .arr{display:inline-block;transition:transform .22s ease}
        .tm-btn-gold:hover .arr{transform:translateX(3px)}

        /* === Этап 1.5 — состояние «создаём платёж» / ошибка === */
        .tm-btn:disabled{opacity:.65;cursor:default}
        .tm-btn-gold:disabled,
        .tm-btn-gold:disabled:hover{
          transform:none;
          box-shadow:0 10px 28px rgba(201,168,76,.22)
        }
        .tm-error{
          font-size:.85rem;color:#FFB4B4;font-weight:400;line-height:1.5;
          margin:0 0 .95rem;
          background:rgba(255,90,90,.08);
          border:1px solid rgba(255,90,90,.24);
          border-radius:10px;padding:.7rem .85rem
        }

        /* === RELEASE v1.0 — «Скоро» (disabled) button === */
        .tm-btn.tm-btn-soon{
          background:linear-gradient(135deg,rgba(201,168,76,.22),rgba(201,168,76,.10));
          color:#E8C97A;border:1px solid rgba(201,168,76,.4);
          box-shadow:none;cursor:default;letter-spacing:.04em
        }
        .tm-btn.tm-btn-soon:hover{transform:none;box-shadow:none}

        @media(max-width:640px){
          .tm-card{padding:2.1rem 1.45rem 1.6rem;border-radius:18px;min-height:340px}
          .tm-title{font-size:1.3rem}
          .tm-price{font-size:2.5rem}
          .tm-actions{flex-direction:column}
          .tm-btn{width:100%;min-width:0}
          .tm-close{width:44px;height:44px}
        }

        @media (prefers-reduced-motion: reduce){
          .tm-overlay, .tm-card, .tm-step,
          .tm-spinner, .tm-ring,
          .tm-progress::before, .tm-success-icon,
          .tm-step-dot{animation:none !important;transform:none !important;opacity:1 !important}
        }
      `}</style>

      <div
        className="tm-overlay"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tm-title"
      >
        <div className="tm-card" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="tm-close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6 18 18M18 6 6 18" />
            </svg>
          </button>

          {PAYMENT_COMING_SOON ? (
            <div className="tm-step" key="soon">
              <span className="tm-pro-badge">🔒 Скоро</span>
              <h3 id="tm-title" className="tm-title">
                {data.name}
              </h3>

              <div className="tm-price-row">
                <div className="tm-price">
                  <em>{data.priceNumber}</em> ₽
                </div>
                {data.isSub && <span className="tm-mo">/мес</span>}
              </div>
              <p className="tm-period">{data.period}</p>

              <ul className="tm-perks">
                {data.perks.map((p, i) => (
                  <li key={i}>
                    <span className="tm-check" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 12 5 5L20 7" />
                      </svg>
                    </span>
                    {p}
                  </li>
                ))}
              </ul>

              <p
                className="tm-sub"
                style={{ textAlign: "left", maxWidth: "none", margin: "0 0 1.4rem" }}
              >
                Онлайн-оплата скоро заработает. Пока все функции расчёта
                доступны бесплатно — без подписки и платежей.
              </p>

              <div className="tm-actions">
                <button
                  type="button"
                  className="tm-btn tm-btn-soon"
                  disabled
                  aria-disabled="true"
                >
                  Скоро
                </button>
              </div>
            </div>
          ) : (
            <>
          {/* Progress dots */}
          <div className="tm-steps" aria-hidden="true">
            <span className={"tm-step-dot " + (step === 1 ? "active" : "done")} />
            <span className={"tm-step-dot " + (step === 2 ? "active" : step > 2 ? "done" : "")} />
            <span className={"tm-step-dot " + (step === 3 ? "active" : "")} />
          </div>

          <div className="tm-step" key={step}>
            {step === 1 && (
              <>
                <span className="tm-pro-badge">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
                  </svg>
                  PRO
                </span>
                <h3 id="tm-title" className="tm-title">
                  {data.name}
                </h3>

                <div className="tm-price-row">
                  <div className="tm-price">
                    <em>{data.priceNumber}</em> ₽
                  </div>
                  {data.isSub && <span className="tm-mo">/мес</span>}
                </div>
                <p className="tm-period">{data.period}</p>

                <ul className="tm-perks">
                  {data.perks.map((p, i) => (
                    <li key={i}>
                      <span className="tm-check" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                      </span>
                      {p}
                    </li>
                  ))}
                </ul>

                {error && (
                  <p className="tm-error" role="alert">
                    {error}
                  </p>
                )}

                <div className="tm-actions">
                  <button
                    type="button"
                    className="tm-btn tm-btn-gold"
                    onClick={handlePay}
                    disabled={loading}
                    aria-busy={loading}
                  >
                    {loading ? (
                      "Создаём платёж…"
                    ) : (
                      <>
                        Продолжить
                        <span className="arr" aria-hidden="true">→</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="tm-loader" aria-hidden="true">
                  <div className="tm-spinner">
                    <span className="tm-ring" />
                  </div>
                </div>
                <h3 id="tm-title" className="tm-title tm-text-center">
                  Подключаем оплату…
                </h3>
                <p className="tm-sub">
                  Проверяем платёжный шлюз и активируем тариф «{data.name}».
                </p>
                <div className="tm-progress" aria-hidden="true" />
              </>
            )}

            {step === 3 && (
              <>
                <div className="tm-success-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8 12.5 2.8 2.8L16.5 9.5" />
                  </svg>
                </div>
                <h3 id="tm-title" className="tm-title tm-text-center">
                  Premium скоро станет доступен
                </h3>
                <p className="tm-sub">
                  Мы завершаем подключение оплаты. Пока вы можете пользоваться
                  всеми функциями бесплатно.
                </p>

                <div className="tm-actions">
                  <button
                    type="button"
                    className="tm-btn tm-btn-ghost"
                    onClick={onClose}
                  >
                    Продолжить
                  </button>
                  <Link
                    href="/app"
                    className="tm-btn tm-btn-gold"
                    onClick={onClose}
                  >
                    Вернуться в Dashboard
                    <span className="arr" aria-hidden="true">→</span>
                  </Link>
                </div>
              </>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
