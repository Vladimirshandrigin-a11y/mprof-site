"use client";

import { useState } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase-cloud";

// ============================================================================
// /app/ozon-finance-diagnostic — ВРЕМЕННАЯ скрытая страница-клиент.
//
// Единственная задача: удобно запустить уже существующий защищённый endpoint
// GET /api/ozon/finance-taxonomy-diagnostic по клику (вместо DevTools Console)
// и дать скопировать безопасный JSON-ответ.
//
// Страница НАМЕРЕННО не добавлена ни в какую навигацию/меню/кабинет — ссылку
// на неё Владимир получает напрямую. После снятия июньского отчёта страница и
// endpoint удаляются отдельным cleanup-PR.
//
// БЕЗОПАСНОСТЬ (вся серверная защита остаётся на сервере, здесь только клиент):
//   • access_token берём из существующей browser-сессии (supabase.auth.getSession),
//     держим ТОЛЬКО в локальной const обработчика — НЕ в state, НЕ в DOM, НЕ в лог;
//   • запрос уходит ТОЛЬКО по явному клику (никакого useEffect/auto-fetch, чтобы
//     Strict Mode не выстрелил дважды);
//   • тело/параметры не шлём: ни userId, ни месяц, ни ключи — сервер сам берёт
//     пользователя из токена и жёстко фиксирует июнь 2026 и тариф 449₽;
//   • копируем ТОЛЬКО отформатированный JSON ответа, никогда не токен/сессию;
//   • сырой не-JSON (например HTML-страница ошибки) НЕ рендерим и НЕ копируем.
// ============================================================================

const ENDPOINT = "/api/ozon/finance-taxonomy-diagnostic";

type StatusKind = "ok" | "error" | "warn" | "info";

/** HTTP-статус + errorCode → человекопонятное сообщение и цвет статуса. */
function describe(
  httpStatus: number,
  ok: boolean,
  errorCode: string
): { kind: StatusKind; message: string } {
  if (httpStatus === 200 && ok) {
    return { kind: "ok", message: "Отчёт готов" };
  }
  switch (httpStatus) {
    case 401:
      return { kind: "error", message: "Сессия истекла. Перезайдите в M-PROF." };
    case 403:
      return {
        kind: "error",
        message: "Диагностика доступна только при активном тарифе 449 ₽.",
      };
    case 404:
      return {
        kind: "error",
        message: "Диагностический endpoint ещё не доступен. Проверьте деплой.",
      };
    case 410:
      return {
        kind: "error",
        message: "Ozon отключил используемый финансовый метод.",
      };
    case 422:
      return {
        kind: "warn",
        message:
          "Ozon вернул слишком большой или неполный набор данных. Не используйте суммы из этого ответа.",
      };
    case 429:
      if (errorCode === "diagnostic_in_progress") {
        return { kind: "warn", message: "Диагностика уже выполняется. Подождите." };
      }
      if (errorCode === "diagnostic_cooldown") {
        return {
          kind: "warn",
          message: "Повторный запуск временно ограничен. Подождите 60 секунд.",
        };
      }
      return { kind: "warn", message: "Слишком много запросов. Подождите немного." };
    case 500:
    case 502:
    case 503:
      return {
        kind: "error",
        message:
          "Не удалось получить данные Ozon. Скопируйте ответ и отправьте его для проверки.",
      };
    default:
      return {
        kind: "error",
        message: `Не удалось получить отчёт (HTTP ${httpStatus}).`,
      };
  }
}

export default function OzonFinanceDiagnosticPage() {
  const [loading, setLoading] = useState(false);
  const [statusKind, setStatusKind] = useState<StatusKind | "">("");
  const [statusMsg, setStatusMsg] = useState("");
  // reportJson — ТОЛЬКО безопасный отформатированный JSON ответа (без токена).
  const [reportJson, setReportJson] = useState("");
  const [copyMsg, setCopyMsg] = useState("");

  async function runDiagnostic() {
    setLoading(true);
    setStatusKind("");
    setStatusMsg("");
    setReportJson("");
    setCopyMsg("");

    try {
      // access_token живёт только здесь, в локальной const — не в state/DOM/лог.
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token ?? "";
      if (!accessToken) {
        setStatusKind("info");
        setStatusMsg("Сессия не найдена. Войдите в M-PROF и повторите.");
        return;
      }

      const response = await fetch(ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });

      const text = await response.text();

      let parsed: unknown = null;
      let isJson = false;
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }

      if (!isJson || parsed === null || typeof parsed !== "object") {
        // Не-JSON (например HTML-страница ошибки) не показываем и не копируем.
        setStatusKind("error");
        setStatusMsg(`Сервер вернул неожиданный ответ (HTTP ${response.status}).`);
        return;
      }

      const obj = parsed as { ok?: unknown; errorCode?: unknown };
      const okFlag = obj.ok === true;
      const errorCode = typeof obj.errorCode === "string" ? obj.errorCode : "";

      // Любой корректный JSON (в т.ч. ошибка) показываем и разрешаем скопировать.
      setReportJson(JSON.stringify(parsed, null, 2));
      const d = describe(response.status, okFlag, errorCode);
      setStatusKind(d.kind);
      setStatusMsg(d.message);
    } catch {
      // Сетевой сбой/прерывание — без деталей запроса.
      setStatusKind("error");
      setStatusMsg(
        "Не удалось связаться с сервером. Проверьте соединение и повторите."
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyReport() {
    if (!reportJson) return;
    try {
      await navigator.clipboard.writeText(reportJson);
      setCopyMsg("Отчёт скопирован — вставьте его в чат.");
    } catch {
      setCopyMsg(
        "Не удалось скопировать автоматически. Выделите текст отчёта вручную."
      );
    }
  }

  return (
    <main className="ofd-wrap">
      <div className="ofd-card">
        <div className="ofd-brand">M‑Prof</div>
        <h1 className="ofd-title">Диагностика финансов Ozon</h1>
        <p className="ofd-subtitle">
          Временная защищённая страница для определения логистики и рекламы за июнь
          2026 года.
        </p>
        <p className="ofd-note">
          Отчёт ничего не сохраняет и не списывает расчёт.
        </p>

        <button
          type="button"
          className="ofd-btn ofd-btn-gold"
          onClick={runDiagnostic}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? "Получаем отчёт…" : "Получить отчёт за июнь 2026"}
        </button>

        <div className="ofd-status-region" aria-live="polite">
          {statusMsg && (
            <p className={`ofd-status ofd-status--${statusKind || "info"}`}>
              {statusMsg}
            </p>
          )}
        </div>

        {reportJson && (
          <div className="ofd-result">
            <div className="ofd-result-head">
              <span className="ofd-result-label">Ответ диагностики (JSON)</span>
              <button
                type="button"
                className="ofd-btn ofd-btn-copy"
                onClick={copyReport}
              >
                Скопировать отчёт
              </button>
            </div>
            <pre className="ofd-json">{reportJson}</pre>
            <div className="ofd-copy-region" aria-live="polite">
              {copyMsg && <p className="ofd-copy-msg">{copyMsg}</p>}
            </div>
          </div>
        )}

        <Link href="/app" className="ofd-back">
          ← Вернуться в M‑PROF
        </Link>
      </div>

      <style jsx>{`
        @import url("https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Outfit:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap");

        .ofd-wrap {
          min-height: 100vh;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem 1.2rem;
          background: radial-gradient(
              120% 120% at 50% 0%,
              #0d1020 0%,
              #05070f 70%
            )
            fixed;
          font-family: "Outfit", sans-serif;
          color: #e8eef8;
        }

        .ofd-card {
          width: 100%;
          max-width: 680px;
          box-sizing: border-box;
          background: linear-gradient(
            160deg,
            rgba(201, 168, 76, 0.1) 0%,
            rgba(13, 16, 32, 0.96) 68%
          );
          border: 1px solid rgba(201, 168, 76, 0.32);
          border-radius: 20px;
          padding: 2.4rem 2rem 2rem;
          box-shadow: 0 32px 90px rgba(0, 0, 0, 0.6),
            0 0 90px rgba(201, 168, 76, 0.1);
        }

        .ofd-brand {
          font-family: "Playfair Display", Georgia, serif;
          font-weight: 700;
          font-size: 1.15rem;
          letter-spacing: 0.02em;
          color: #e8c97a;
          margin-bottom: 1.2rem;
        }

        .ofd-title {
          font-family: "Playfair Display", Georgia, serif;
          font-size: 1.7rem;
          font-weight: 700;
          line-height: 1.2;
          letter-spacing: -0.01em;
          margin: 0 0 0.7rem;
          color: #e8eef8;
        }

        .ofd-subtitle {
          font-size: 0.98rem;
          font-weight: 300;
          line-height: 1.55;
          color: #b9c6da;
          margin: 0 0 0.6rem;
        }

        .ofd-note {
          font-size: 0.85rem;
          color: #8a9fbb;
          margin: 0 0 1.6rem;
        }

        .ofd-btn {
          font-family: "Outfit", sans-serif;
          font-size: 0.95rem;
          font-weight: 600;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          -webkit-appearance: none;
          appearance: none;
          transition: transform 0.18s ease, box-shadow 0.18s ease,
            background 0.18s ease, opacity 0.18s ease;
        }

        .ofd-btn:focus-visible {
          outline: 2px solid #e8c97a;
          outline-offset: 2px;
        }

        .ofd-btn-gold {
          width: 100%;
          padding: 15px 22px;
          background: linear-gradient(135deg, #c9a84c 0%, #e8c97a 100%);
          color: #05070f;
          box-shadow: 0 10px 28px rgba(201, 168, 76, 0.3);
        }

        .ofd-btn-gold:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 18px 44px rgba(201, 168, 76, 0.45);
        }

        .ofd-btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .ofd-status-region {
          min-height: 0.5rem;
        }

        .ofd-status {
          font-size: 0.92rem;
          line-height: 1.5;
          margin: 1rem 0 0;
          padding: 0.75rem 0.95rem;
          border-radius: 11px;
          border: 1px solid transparent;
        }

        .ofd-status--ok {
          color: #8ff0be;
          background: rgba(46, 204, 130, 0.1);
          border-color: rgba(46, 204, 130, 0.3);
        }

        .ofd-status--error {
          color: #ff9b9b;
          background: rgba(255, 90, 90, 0.09);
          border-color: rgba(255, 90, 90, 0.28);
        }

        .ofd-status--warn {
          color: #e8c97a;
          background: rgba(201, 168, 76, 0.1);
          border-color: rgba(201, 168, 76, 0.3);
        }

        .ofd-status--info {
          color: #b9c6da;
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.12);
        }

        .ofd-result {
          margin-top: 1.4rem;
        }

        .ofd-result-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          flex-wrap: wrap;
          margin-bottom: 0.7rem;
        }

        .ofd-result-label {
          font-size: 0.8rem;
          letter-spacing: 0.02em;
          color: #8a9fbb;
        }

        .ofd-btn-copy {
          padding: 9px 16px;
          font-size: 0.85rem;
          background: rgba(255, 255, 255, 0.05);
          color: #e8eef8;
          border: 1px solid rgba(201, 168, 76, 0.35);
        }

        .ofd-btn-copy:hover {
          border-color: #c9a84c;
          color: #e8c97a;
          background: rgba(201, 168, 76, 0.08);
        }

        .ofd-json {
          font-family: "DM Mono", ui-monospace, monospace;
          font-size: 0.8rem;
          line-height: 1.5;
          color: #d7e2f2;
          background: rgba(4, 6, 14, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 1rem 1.1rem;
          margin: 0;
          max-height: 460px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
        }

        .ofd-copy-region {
          min-height: 0.5rem;
        }

        .ofd-copy-msg {
          font-size: 0.85rem;
          color: #8ff0be;
          margin: 0.7rem 0 0;
        }

        .ofd-back {
          display: inline-block;
          margin-top: 1.6rem;
          font-size: 0.9rem;
          color: #b9c6da;
          text-decoration: none;
          border-bottom: 1px solid transparent;
          transition: color 0.18s ease, border-color 0.18s ease;
        }

        .ofd-back:hover,
        .ofd-back:focus-visible {
          color: #e8c97a;
          border-color: rgba(201, 168, 76, 0.5);
          outline: none;
        }

        @media (max-width: 560px) {
          .ofd-card {
            padding: 1.8rem 1.3rem 1.5rem;
            border-radius: 16px;
          }
          .ofd-title {
            font-size: 1.4rem;
          }
          .ofd-result-head {
            flex-direction: column;
            align-items: stretch;
          }
          .ofd-btn-copy {
            width: 100%;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .ofd-btn {
            transition: none;
          }
          .ofd-btn-gold:hover:not(:disabled) {
            transform: none;
          }
        }
      `}</style>
    </main>
  );
}
