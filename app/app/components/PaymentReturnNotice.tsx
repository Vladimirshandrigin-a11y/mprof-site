"use client";

import type { AccessGrowth } from "../lib/payment-return";
import type { PaymentReturnStatus } from "../lib/usePaymentReturn";

// Статус после возврата из ЮKassa (/app?payment=return). Успех показываем только
// по подтверждённому росту доступа (см. app/app/lib/payment-return.ts), не по адресу.
// Стили — .pay-return* в глобальных стилях app/app/page.tsx.

interface Props {
  status: PaymentReturnStatus;
  growth: AccessGrowth | null;
  /** Срок безлимита ДД.ММ.ГГГГ, если он активен; иначе "". */
  premiumUntilText: string;
  onRetry: () => void;
  onDismiss: () => void;
}

export function PaymentReturnNotice({ status, growth, premiumUntilText, onRetry, onDismiss }: Props) {
  if (status === "idle") return null;

  let tone: "info" | "ok" | "warn" = "info";
  let text: string;
  let detail: string | null = null;
  let canRetry = false;

  switch (status) {
    case "needs_login":
      text = "Войдите в аккаунт, чтобы проверить статус оплаты.";
      break;
    case "checking":
      text = "Проверяем статус оплаты…";
      break;
    case "confirmed":
      tone = "ok";
      text = "Оплата подтверждена. Доступ активирован.";
      if (growth === "unlimited" && premiumUntilText) detail = `«Безлимит» действует до ${premiumUntilText}.`;
      else if (growth === "single") detail = "Разовый расчёт добавлен.";
      break;
    case "pending":
      tone = "warn";
      text = "Платёж может ещё обрабатываться. Проверьте доступ через несколько минут.";
      canRetry = true;
      break;
    case "failed":
      tone = "warn";
      text = "Не удалось проверить статус оплаты. Проверьте интернет-соединение и повторите проверку.";
      canRetry = true;
      break;
  }

  const closable = status === "confirmed" || status === "pending" || status === "failed";

  return (
    <div className={`pay-return pay-return-${tone}`} role="status" aria-live="polite">
      {status === "checking" && <span className="pay-return-spin" aria-hidden="true" />}
      <span className="pay-return-text">
        {text}
        {detail && <span className="pay-return-detail">{detail}</span>}
      </span>
      {canRetry && (
        <button type="button" className="btn-ghost pay-return-btn" onClick={onRetry}>
          Проверить снова
        </button>
      )}
      {closable && (
        <button type="button" className="pay-return-close" onClick={onDismiss} aria-label="Скрыть сообщение">
          ×
        </button>
      )}
    </div>
  );
}
