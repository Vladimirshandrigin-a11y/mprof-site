// ============================================================================
// Безопасная проекция строки ozon_connections для отдачи в браузер.
//
// Здесь НЕТ api_key_encrypted и НЕТ полного client_id — только то, что можно
// показать пользователю. Живёт в одном месте, чтобы все /api/ozon/connection*
// routes маскировали/фильтровали поля одинаково и ничего не утекло случайно.
// ============================================================================

/** Колонки, которые route ВПРАВЕ селектить для отдачи клиенту (без encrypted key). */
export const SAFE_COLUMNS =
  "client_id, key_last4, status, last_checked_at, last_error, updated_at";

export type OzonConnectionRow = {
  client_id: string;
  key_last4: string | null;
  status: string;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string | null;
};

export type OzonConnectionView =
  | { connected: false; status: "not_connected" }
  | {
      connected: boolean;
      status: string;
      clientIdMasked: string;
      keyLast4: string | null;
      lastCheckedAt: string | null;
      lastError: string | null;
      updatedAt: string | null;
    };

/** Маскируем Client-Id: показываем только последние 3 символа (••••678). */
export function maskClientId(clientId: string): string {
  const tail = clientId.slice(-3);
  return `••••${tail}`;
}

/** Строка БД → безопасный для клиента объект (или «не подключено»). */
export function toConnectionView(row: OzonConnectionRow | null): OzonConnectionView {
  if (!row) return { connected: false, status: "not_connected" };
  return {
    connected: row.status === "connected",
    status: row.status,
    clientIdMasked: maskClientId(row.client_id),
    keyLast4: row.key_last4,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
