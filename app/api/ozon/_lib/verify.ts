// ============================================================================
// Проверка Api-Key кабинета Ozon. ТОЛЬКО сервер.
//
// «Пинг» лёгким методом, чтобы понять, валиден ли Client-Id + Api-Key, БЕЗ
// загрузки финансов/отчётов (это задача PR #2, не PR #1).
//
// Эндпоинт: POST /v3/product/list, limit:1 — универсальный (есть у любого
// продавца), лёгкий, и для ответа Ozon обязан проверить заголовки Client-Id/Api-Key:
//   • 2xx                        → connected (ключ рабочий);
//   • 401                        → invalid_key (неверный Client-Id/Api-Key);
//   • 403                        → forbidden (ключ опознан, но нет прав на метод);
//   • 429 / 5xx / timeout / сеть  → unavailable (временно недоступно, повторить).
//
// Таймаут 12с (AbortController): Ozon иногда отвечает медленно, но висеть на
// проверке ключа нельзя. Api-Key В ЛОГИ НЕ ПИШЕТСЯ.
// ============================================================================

const OZON_PING_URL = "https://api-seller.ozon.ru/v3/product/list";
const TIMEOUT_MS = 12000;

export type OzonStatus = "connected" | "invalid_key" | "forbidden" | "unavailable";

export type OzonVerifyResult = {
  status: OzonStatus;
  /** Безопасная для клиента строка (без секретов). */
  detail?: string;
};

export async function verifyOzonKey(
  clientId: string,
  apiKey: string
): Promise<OzonVerifyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OZON_PING_URL, {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filter: { visibility: "ALL" }, last_id: "", limit: 1 }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (res.ok) return { status: "connected" };
    if (res.status === 401) {
      return { status: "invalid_key", detail: "Неверный Client ID или API-ключ" };
    }
    if (res.status === 403) {
      return { status: "forbidden", detail: "У ключа нет прав на нужные методы" };
    }
    return { status: "unavailable", detail: `Ozon ответил статусом ${res.status}` };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      status: "unavailable",
      detail: aborted ? "Ozon не ответил вовремя" : "Не удалось связаться с Ozon",
    };
  } finally {
    clearTimeout(timer);
  }
}
