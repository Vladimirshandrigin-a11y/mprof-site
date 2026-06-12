"use client";

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
      "Приоритетный доступ к новым функциям",
      "Полная история без ограничений",
      "Приоритетная поддержка",
    ],
  },
};

export function TariffModal({ open, tier, onClose }: Props) {
  // Реальная оплата через POST /api/payment/create → redirect в ЮKassa.
  const [loadingPlan, setLoadingPlan] = useState<TariffTier | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Сбрасываем платёжное состояние при каждом открытии модалки
  useEffect(() => {
    if (open) {
      setLoadingPlan(null);
      setError(null);
    }
  }, [open, tier]);

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

  // tier === null → режим выбора: показываем оба тарифа сразу (после
  // бесплатного расчёта). tier !== null → карточка одного тарифа (клик по
  // конкретному тарифу в прайсинге).
  const dual = tier === null;
  const data = TIER_DATA[tier ?? "unlimited"];
  const plan: TariffTier = tier ?? "unlimited";

  // Создаёт платёж на бэкенде и редиректит в ЮKassa. Сумма и провайдер —
  // на сервере (PLAN_PRICING); сюда приходит только confirmationUrl. Какой
  // тариф оплачивать — приходит из нажатой кнопки (payPlan).
  const handlePay = async (payPlan: TariffTier) => {
    setError(null);
    setLoadingPlan(payPlan);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError("Войдите в аккаунт, чтобы оформить тариф.");
        setLoadingPlan(null);
        return;
      }

      const res = await fetch("/api/payment/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: payPlan }),
      });
      const result = (await res.json().catch(() => null)) as {
        ok?: boolean;
        confirmationUrl?: string;
        error?: string;
      } | null;

      if (result?.ok && result.confirmationUrl) {
        // Уходим на страницу оплаты ЮKassa — loadingPlan не снимаем.
        window.location.href = result.confirmationUrl;
        return;
      }

      // ЮKassa не настроена / любая иная ошибка — честное сообщение в модалке.
      setError("Оплата пока не настроена. Попробуйте позже.");
      setLoadingPlan(null);
    } catch {
      setError("Оплата пока не настроена. Попробуйте позже.");
      setLoadingPlan(null);
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

        /* === Режим выбора тарифа: оба тарифа сразу === */
        .tm-sub{
          font-size:.9rem;color:#8A9FBB;font-weight:300;
          margin:.6rem 0 0;line-height:1.5
        }
        .tm-tiers{
          display:flex;flex-direction:column;gap:.85rem;margin:1.3rem 0 0
        }
        .tm-tier{
          border:1px solid rgba(255,255,255,.12);border-radius:14px;
          padding:1.05rem 1.15rem;background:rgba(255,255,255,.03);
          display:flex;flex-direction:column;gap:.7rem
        }
        .tm-tier-hot{
          border-color:rgba(201,168,76,.4);
          background:linear-gradient(160deg,
            rgba(201,168,76,.10),rgba(255,255,255,.02))
        }
        .tm-tier-head{
          display:flex;align-items:baseline;justify-content:space-between;gap:.8rem
        }
        .tm-tier-name{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.15rem;font-weight:700;color:#E8EEF8
        }
        .tm-tier-price{
          font-family:'Playfair Display',Georgia,serif;
          font-size:1.5rem;font-weight:700;letter-spacing:-.02em;
          color:#E8EEF8;white-space:nowrap
        }
        .tm-tier-price em{font-style:normal;
          background:linear-gradient(135deg,#C9A84C 0%,#E8C97A 60%,#C9A84C 100%);
          -webkit-background-clip:text;background-clip:text;
          -webkit-text-fill-color:transparent}
        .tm-tier-price .per{
          font-family:'DM Mono',monospace;font-size:.62rem;
          color:#8A9FBB;letter-spacing:.06em;margin-left:.3rem
        }
        .tm-tier-desc{
          font-size:.82rem;color:#8A9FBB;font-weight:300;
          line-height:1.45;margin:0
        }
        .tm-tier .tm-btn{width:100%;min-width:0}

        @media(max-width:640px){
          .tm-card{padding:2.1rem 1.45rem 1.6rem;border-radius:18px;min-height:340px}
          .tm-title{font-size:1.3rem}
          .tm-price{font-size:2.5rem}
          .tm-actions{flex-direction:column}
          .tm-btn{width:100%;min-width:0}
          .tm-close{width:44px;height:44px}
          .tm-tier-name{font-size:1.05rem}
          .tm-tier-price{font-size:1.3rem}
        }

        @media (prefers-reduced-motion: reduce){
          .tm-overlay, .tm-card, .tm-step{
            animation:none !important;transform:none !important;opacity:1 !important
          }
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

          <div className="tm-step">
            <span className="tm-pro-badge">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L13.4 9.2L20 10.6L13.4 12L12 19.2L10.6 12L4 10.6L10.6 9.2L12 2Z" />
              </svg>
              PRO
            </span>
            {dual ? (
              <>
                <h3 id="tm-title" className="tm-title">
                  Выберите <em>тариф</em>
                </h3>
                <p className="tm-sub">
                  Бесплатный расчёт использован. Чтобы продолжить, выберите
                  подходящий тариф.
                </p>

                {error && (
                  <p className="tm-error" role="alert">
                    {error}
                  </p>
                )}

                <div className="tm-tiers">
                  <div className="tm-tier">
                    <div className="tm-tier-head">
                      <span className="tm-tier-name">Разовый расчёт</span>
                      <span className="tm-tier-price">
                        <em>149</em> ₽
                      </span>
                    </div>
                    <p className="tm-tier-desc">
                      Один расчёт за месячный отчёт · без подписки и
                      автосписаний.
                    </p>
                    <button
                      type="button"
                      className="tm-btn tm-btn-ghost"
                      onClick={() => handlePay("single")}
                      disabled={loadingPlan !== null}
                      aria-busy={loadingPlan === "single"}
                    >
                      {loadingPlan === "single"
                        ? "Создаём платёж…"
                        : "Купить разовый расчёт — 149 ₽"}
                    </button>
                  </div>

                  <div className="tm-tier tm-tier-hot">
                    <div className="tm-tier-head">
                      <span className="tm-tier-name">Безлимит</span>
                      <span className="tm-tier-price">
                        <em>449</em> ₽<span className="per">/30 дней</span>
                      </span>
                    </div>
                    <p className="tm-tier-desc">
                      Неограниченные расчёты 30 дней · полная история ·
                      приоритетная поддержка.
                    </p>
                    <button
                      type="button"
                      className="tm-btn tm-btn-gold"
                      onClick={() => handlePay("unlimited")}
                      disabled={loadingPlan !== null}
                      aria-busy={loadingPlan === "unlimited"}
                    >
                      {loadingPlan === "unlimited" ? (
                        "Создаём платёж…"
                      ) : (
                        <>
                          Оформить безлимит — 449 ₽
                          <span className="arr" aria-hidden="true">→</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
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
                    onClick={() => handlePay(plan)}
                    disabled={loadingPlan !== null}
                    aria-busy={loadingPlan === plan}
                  >
                    {loadingPlan === plan ? (
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
          </div>
        </div>
      </div>
    </>
  );
}
