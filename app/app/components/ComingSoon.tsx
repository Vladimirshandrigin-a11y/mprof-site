"use client";

// === RELEASE v1.0 ===
// Универсальное «красивое» состояние для функций, которые ещё не готовы к v1.
// Показывает: бейдж «🔒 Скоро», иконку-замок, название функции, краткое
// описание и неактивную кнопку «Скоро». Чисто презентационный компонент —
// ничего не вызывает и не ломает существующую логику.

type Props = {
  title: string;
  description: string;
};

export function ComingSoon({ title, description }: Props) {
  return (
    <div className="soon-card" role="region" aria-label={`${title} — скоро`}>
      <style jsx>{`
        .soon-card {
          position: relative;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 0.7rem;
          padding: 2.9rem 2rem;
          border-radius: 18px;
          border: 1px solid rgba(201, 168, 76, 0.26);
          background: linear-gradient(
            160deg,
            rgba(201, 168, 76, 0.08) 0%,
            rgba(13, 16, 32, 0.92) 70%
          );
          backdrop-filter: blur(14px) saturate(1.2);
          -webkit-backdrop-filter: blur(14px) saturate(1.2);
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4),
            inset 0 1px 0 rgba(255, 255, 255, 0.05);
          font-family: "Outfit", sans-serif;
          animation: soonIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .soon-card::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          background: radial-gradient(
            560px 240px at 50% -10%,
            rgba(201, 168, 76, 0.16),
            transparent 60%
          );
        }
        .soon-card > * {
          position: relative;
          z-index: 1;
        }
        @keyframes soonIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }

        .soon-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: "DM Mono", monospace;
          font-size: 0.6rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: #05070f;
          background: linear-gradient(135deg, #c9a84c 0%, #e8c97a 100%);
          padding: 5px 12px;
          border-radius: 100px;
          box-shadow: 0 6px 16px rgba(201, 168, 76, 0.4);
        }

        .soon-icon {
          width: 62px;
          height: 62px;
          border-radius: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(
            135deg,
            rgba(201, 168, 76, 0.28) 0%,
            rgba(201, 168, 76, 0.08) 100%
          );
          border: 1px solid rgba(201, 168, 76, 0.4);
          color: #e8c97a;
          box-shadow: 0 14px 38px rgba(201, 168, 76, 0.2),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
          animation: soonGlow 3s ease-in-out infinite;
        }
        @keyframes soonGlow {
          0%,
          100% {
            box-shadow: 0 14px 38px rgba(201, 168, 76, 0.2),
              0 0 0 0 rgba(201, 168, 76, 0.18),
              inset 0 1px 0 rgba(255, 255, 255, 0.08);
          }
          50% {
            box-shadow: 0 14px 38px rgba(201, 168, 76, 0.3),
              0 0 0 13px rgba(201, 168, 76, 0.04),
              inset 0 1px 0 rgba(255, 255, 255, 0.08);
          }
        }
        .soon-icon svg {
          width: 27px;
          height: 27px;
          display: block;
        }

        .soon-title {
          font-family: "Playfair Display", Georgia, serif;
          font-size: 1.4rem;
          font-weight: 700;
          color: #e8eef8;
          letter-spacing: -0.01em;
          margin: 0.2rem 0 0;
        }
        .soon-desc {
          font-size: 0.92rem;
          color: #8a9fbb;
          font-weight: 300;
          line-height: 1.6;
          max-width: 440px;
          margin: 0;
        }

        .soon-btn {
          margin-top: 0.5rem;
          font-family: "Outfit", sans-serif;
          font-size: 0.9rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: #e8c97a;
          background: linear-gradient(
            135deg,
            rgba(201, 168, 76, 0.2),
            rgba(201, 168, 76, 0.08)
          );
          border: 1px solid rgba(201, 168, 76, 0.4);
          padding: 12px 30px;
          border-radius: 12px;
          cursor: default;
          opacity: 0.92;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .soon-btn:disabled {
          cursor: default;
        }

        @media (prefers-reduced-motion: reduce) {
          .soon-card,
          .soon-icon {
            animation: none;
          }
        }
      `}</style>

      <span className="soon-badge">🔒 Скоро</span>

      <div className="soon-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </div>

      <h3 className="soon-title">{title}</h3>
      <p className="soon-desc">{description}</p>

      <button
        type="button"
        className="soon-btn"
        disabled
        aria-disabled="true"
      >
        Скоро
      </button>
    </div>
  );
}
