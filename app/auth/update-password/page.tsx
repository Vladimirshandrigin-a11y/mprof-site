"use client";

/**
 * Страница установки нового пароля после восстановления.
 *
 * БЕЗОПАСНОСТЬ (главное):
 * - Сменить пароль можно ТОЛЬКО при наличии подтверждённой Supabase-сессии.
 *   Сессия появляется здесь одним из двух способов:
 *     1) пользователь перешёл по ссылке из письма восстановления
 *        (resetPasswordForEmail) — supabase-js (detectSessionInUrl) разбирает
 *        токен из URL-хэша и поднимает сессию, событие onAuthStateChange =
 *        "PASSWORD_RECOVERY";
 *     2) пользователь уже вошёл обычным образом (валидная сессия).
 *   В обоих случаях updateUser({ password }) меняет пароль ТОЛЬКО владельца
 *   текущей сессии (auth.uid()), email никуда не передаётся. Угнать чужой
 *   аккаунт нельзя: чужую сессию получить можно лишь через доступ к чужой почте
 *   (ссылка восстановления) или зная чужой пароль.
 * - Если страницу открыли без ссылки восстановления и без активной сессии —
 *   форма не показывается, смена пароля заблокирована.
 *
 * Пароль не пишем в localStorage/sessionStorage и не логируем; после успешной
 * смены сразу очищаем поля из state.
 */

import { useEffect, useState } from "react";
import { supabase } from "../../app/lib/supabase-cloud";

// Фазы экрана. updateUser доступен ТОЛЬКО когда phase === "ready" (или во время
// сохранения) — то есть после подтверждённой recovery/обычной сессии.
type Phase = "checking" | "ready" | "invalid" | "saving" | "done";

export default function UpdatePasswordPage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");

  // Подтверждение recovery-сессии. Ссылка из письма приводит сюда с токенами в
  // URL-хэше (#access_token=...&refresh_token=...&type=recovery). Авто-детект
  // (detectSessionInUrl) здесь хэш не подхватывал — поэтому разбираем его сами и
  // явно поднимаем сессию через setSession. Сессия нужна, чтобы updateUser сменил
  // пароль владельца ИМЕННО этой recovery-сессии (email никуда не передаётся).
  useEffect(() => {
    let settled = false;
    const finish = (p: Phase) => {
      if (settled) return;
      settled = true;
      setPhase(p);
    };

    const init = async () => {
      if (typeof window === "undefined") return;

      // Разбираем хэш руками. Токены НЕ логируем.
      const raw = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(raw);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      // type === "recovery" — справочно; решаем по наличию пары токенов.

      if (accessToken && refreshToken) {
        try {
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error || !data.session) {
            // Ссылка уже использована / просрочена / токены недействительны.
            finish("invalid");
            return;
          }
          // Успех: сразу убираем токены из адресной строки, чтобы не светить их
          // в истории браузера и не пересабмитить при перезагрузке.
          window.history.replaceState(null, "", "/auth/update-password");
          finish("ready");
          return;
        } catch {
          // Детали/токены не логируем.
          finish("invalid");
          return;
        }
      }

      // Токенов в хэше нет. Возможно, сессия уже поднята ранее или пользователь
      // уже вошёл — тогда менять пароль можно. Иначе ссылку не предъявили.
      try {
        const { data } = await supabase.auth.getSession();
        finish(data.session ? "ready" : "invalid");
      } catch {
        finish("invalid");
      }
    };

    void init();

    // Подстраховка от подвисшего setSession/getSession (navigator-lock): если за
    // 8с ничего не решилось — считаем ссылку недействительной.
    const timer = setTimeout(() => finish("invalid"), 8000);
    return () => clearTimeout(timer);
  }, []);

  const canSubmit = phase === "ready";

  const handleSave = async () => {
    if (!canSubmit) return; // защита: без подтверждённой сессии не сохраняем
    if (newPassword.length < 6) {
      setMessage("Пароль должен быть не короче 6 символов.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("Пароли не совпадают.");
      return;
    }

    setPhase("saving");
    setMessage("");
    try {
      // updateUser меняет пароль владельца ТЕКУЩЕЙ сессии. Email не передаём —
      // указать чужой аккаунт технически невозможно.
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setPhase("ready");
        const m = (error.message || "").toLowerCase();
        if (m.includes("should be at least") || m.includes("weak password")) {
          setMessage("Пароль должен быть не короче 6 символов.");
        } else if (m.includes("same") || m.includes("different from the old")) {
          setMessage("Новый пароль не должен совпадать со старым.");
        } else if (m.includes("session") || m.includes("not authenticated") || m.includes("jwt")) {
          // Сессия истекла прямо во время сохранения.
          setPhase("invalid");
          setMessage(
            "Ссылка восстановления недействительна или устарела. Запросите восстановление ещё раз."
          );
        } else {
          setMessage("Не удалось сохранить пароль. Попробуйте позже.");
        }
        return;
      }

      // Успех. Сразу очищаем пароли из state — дольше нужного не держим.
      setNewPassword("");
      setConfirmPassword("");
      setPhase("done");
      setMessage("Пароль успешно обновлён. Теперь можно войти.");

      // Best-effort: завершаем ВСЕ сессии (в т.ч. возможные чужие) глобальным
      // выходом, чтобы старый/чужой токен перестал работать. Глобальный signOut
      // может зависнуть на сетевом revoke — гоняем с таймаутом и в любом случае
      // уходим на /app (там форма входа), где можно войти с новым паролем.
      const signOutRace = Promise.race([
        supabase.auth.signOut({ scope: "global" }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      await signOutRace;
      if (typeof window !== "undefined") {
        window.location.href = "/app";
      }
    } catch {
      // Не печатаем пароль и детали в консоль.
      setPhase("ready");
      setMessage("Не удалось сохранить пароль. Попробуйте позже.");
    }
  };

  return (
    <div className="up-root">
      <div className="up-card">
        <div className="up-brand">
          M&#8209;<em>Prof</em>
        </div>
        <h1 className="up-title">Новый пароль</h1>

        {phase === "checking" && (
          <p className="up-status" role="status" aria-live="polite">
            <span className="up-ring" aria-hidden="true" />
            Проверяем ссылку восстановления…
          </p>
        )}

        {phase === "invalid" && (
          <div className="up-invalid" role="alert">
            <p className="up-msg up-msg-err">
              Ссылка восстановления недействительна или устарела. Запросите
              восстановление ещё раз.
            </p>
            <a className="up-link" href="/app">
              Вернуться ко входу
            </a>
          </div>
        )}

        {phase === "done" && (
          <div className="up-done" role="status" aria-live="polite">
            <p className="up-msg up-msg-ok">{message}</p>
            <p className="up-sub">Переадресуем на страницу входа…</p>
            <a className="up-link" href="/app">
              Перейти сейчас
            </a>
          </div>
        )}

        {(phase === "ready" || phase === "saving") && (
          <>
            <p className="up-lead">
              Придумайте новый пароль для входа. Минимум 6 символов.
            </p>

            <div className="up-fields">
              <input
                className="up-input"
                type="password"
                placeholder="Новый пароль"
                autoComplete="new-password"
                value={newPassword}
                disabled={phase === "saving"}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
              <input
                className="up-input"
                type="password"
                placeholder="Повторите пароль"
                autoComplete="new-password"
                value={confirmPassword}
                disabled={phase === "saving"}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
            </div>

            <button
              type="button"
              className="up-btn"
              onClick={handleSave}
              disabled={phase === "saving"}
              aria-busy={phase === "saving"}
            >
              {phase === "saving" ? "Сохраняем…" : "Сохранить новый пароль"}
            </button>

            {message && <p className="up-msg up-msg-err">{message}</p>}
          </>
        )}
      </div>

      <style jsx>{`
        .up-root {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background:
            radial-gradient(1200px 600px at 50% -10%, rgba(201, 168, 76, 0.08), transparent 60%),
            #0a0c16;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        }
        .up-card {
          width: 100%;
          max-width: 420px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 18px;
          padding: 32px 28px;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
        }
        .up-brand {
          font-size: 1.05rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #f6c86b;
          text-transform: uppercase;
        }
        .up-brand em {
          font-style: normal;
          color: #e7ebf5;
        }
        .up-title {
          margin: 14px 0 0;
          font-size: 1.5rem;
          font-weight: 700;
          color: #f4f6fb;
        }
        .up-lead {
          margin: 10px 0 20px;
          font-size: 0.9rem;
          line-height: 1.5;
          color: #aab2c8;
        }
        .up-fields {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .up-input {
          width: 100%;
          box-sizing: border-box;
          height: 48px;
          padding: 0 16px;
          border-radius: 11px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: #0d1020;
          color: #f4f6fb;
          font-size: 0.95rem;
          outline: none;
          transition: border-color 0.18s, box-shadow 0.18s;
        }
        .up-input::placeholder {
          color: #6b7591;
        }
        .up-input:focus {
          border-color: #c9a84c;
          box-shadow: 0 0 0 3px rgba(201, 168, 76, 0.18);
        }
        .up-input:disabled {
          opacity: 0.6;
        }
        .up-btn {
          width: 100%;
          margin-top: 16px;
          height: 50px;
          border: none;
          border-radius: 11px;
          cursor: pointer;
          font-size: 0.95rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: #111326;
          background: linear-gradient(135deg, #f6c86b 0%, #c9a84c 100%);
          box-shadow: 0 8px 28px rgba(201, 168, 76, 0.28);
          transition: transform 0.18s, box-shadow 0.18s;
        }
        .up-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 14px 38px rgba(201, 168, 76, 0.38);
        }
        .up-btn:disabled {
          opacity: 0.65;
          cursor: default;
        }
        .up-status {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 18px 0 0;
          font-size: 0.9rem;
          color: #aab2c8;
        }
        .up-ring {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid rgba(201, 168, 76, 0.25);
          border-top-color: #f6c86b;
          animation: up-spin 0.8s linear infinite;
        }
        @keyframes up-spin {
          to {
            transform: rotate(360deg);
          }
        }
        .up-msg {
          margin: 16px 0 0;
          font-size: 0.85rem;
          line-height: 1.5;
        }
        .up-msg-err {
          color: #ffb4a8;
        }
        .up-msg-ok {
          color: #8ce0b0;
          font-weight: 600;
        }
        .up-sub {
          margin: 8px 0 0;
          font-size: 0.82rem;
          color: #aab2c8;
        }
        .up-link {
          display: inline-block;
          margin-top: 16px;
          color: #f6c86b;
          font-size: 0.88rem;
          font-weight: 600;
          text-decoration: none;
          border-bottom: 1px solid rgba(246, 200, 107, 0.4);
        }
        .up-link:hover {
          border-bottom-color: #f6c86b;
        }
      `}</style>
    </div>
  );
}
