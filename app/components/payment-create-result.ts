// ============================================================================
// Разбор ответа POST /api/payment/create для окна оплаты (TariffModal). Только
// текст для пользователя: сумма, тариф и сам запрос не меняются.
//
// Сервер сейчас отвечает (app/api/payment/create/route.ts):
//   200 { ok:true, confirmationUrl }        — платёж создан, уходим в ЮKassa;
//   401 «Требуется авторизация» / «Недействительная сессия»;
//   503 { code:"yookassa_not_configured" } — оплата не настроена на сервере;
//   500 / 502                               — не удалось создать подписку/платёж;
//   400                                     — некорректный запрос.
// 403 и 429 маршрут не возвращает, но их может отдать прокси хостинга.
// Тексты ошибок сервера НЕ показываем: среди них технические («ЮKassa ответила
// статусом …», имена переменных окружения). Причину называем только когда её
// однозначно задаёт статус или код ответа; иначе — нейтральное сообщение.
// ============================================================================

export const PAY_MSG = {
  noSession: "Войдите в аккаунт, чтобы оформить тариф.",
  sessionExpired: "Сессия истекла. Войдите в аккаунт повторно.",
  network: "Проверьте интернет-соединение и повторите попытку.",
  tooMany: "Слишком много попыток. Подождите минуту и повторите.",
  unavailable: "Оплата временно недоступна. Попробуйте позже.",
  failed: "Не удалось создать платёж. Попробуйте позже.",
} as const;

export type PaymentCreateOutcome = { redirect: string } | { message: string };

/** Адрес страницы оплаты: только https (без javascript:, data: и т. п.). */
function safeConfirmationUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Что делать после ответа сервера. body — разобранный JSON или null (тело не
 * JSON / пустое).
 */
export function paymentCreateOutcome(status: number, body: unknown): PaymentCreateOutcome {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;

  if (status >= 200 && status < 300) {
    const url = b?.ok === true ? safeConfirmationUrl(b.confirmationUrl) : null;
    return url ? { redirect: url } : { message: PAY_MSG.failed };
  }
  if (status === 401) return { message: PAY_MSG.sessionExpired };
  if (status === 429) return { message: PAY_MSG.tooMany };
  if (status === 503 && b?.code === "yookassa_not_configured") return { message: PAY_MSG.unavailable };
  return { message: PAY_MSG.failed };
}
