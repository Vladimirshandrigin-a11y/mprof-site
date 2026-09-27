// ============================================================================
// Ключи операций расчёта (см. save-flow и /api/cloud/calculation-operations; ручной
// режим и Ozon API — calc-operation-keys). Ключ (UUID) создаётся при первом
// сохранении для пары «пользователь + отпечаток» (файл XLSX или режим + параметры)
// и живёт до подтверждения сервером — в localStorage, поэтому переживает повтор,
// потерянный ответ и перезагрузку страницы. Это НЕ отметка «оплачено»: что сделано
// на самом деле, знает только сервер (статус операции по ключу).
// Без localStorage (приватный режим, запрет) ключи живут в памяти вкладки.
// ============================================================================

const STORAGE_KEY = "mprof_calc_operations_v1";
/** Незавершённые ключи старше этого срока не восстанавливаются. */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Entry = { id: string; at: number };
type Store = Record<string, Record<string, Entry>>; // userId → отпечаток файла → ключ

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface OperationStore {
  /** Незавершённый ключ операции файла (или null). */
  get(userId: string, attemptId: string): string | null;
  /** Ключ операции файла: существующий незавершённый или новый. */
  getOrCreate(userId: string, attemptId: string): string;
  /** Операция подтверждена сервером (или ключ отвергнут) — ключ больше не нужен. */
  settle(userId: string, attemptId: string): void;
  /** Незавершённые ключи пользователя (свежие), новые — первыми. */
  pending(userId: string): Array<{ attemptId: string; id: string; at: number }>;
}

export function createOperationStore(
  storage: StorageLike | null,
  newId: () => string,
  now: () => number = Date.now
): OperationStore {
  let memory: Store = {};

  const load = (): Store => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
    } catch {
      return memory;
    }
  };
  const save = (st: Store): void => {
    memory = st;
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(st));
    } catch {
      /* нет места / запрет — ключи остаются в памяти вкладки */
    }
  };
  const fresh = (e: Entry | undefined): e is Entry =>
    !!e && typeof e.id === "string" && typeof e.at === "number" && now() - e.at < TTL_MS;

  return {
    get(userId, attemptId) {
      const e = load()[userId]?.[attemptId];
      return fresh(e) ? e.id : null;
    },
    getOrCreate(userId, attemptId) {
      const st = load();
      const e = st[userId]?.[attemptId];
      if (fresh(e)) return e.id;
      const byUser: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(st[userId] ?? {})) if (fresh(v)) byUser[k] = v;
      const id = newId();
      byUser[attemptId] = { id, at: now() };
      save({ ...st, [userId]: byUser });
      return id;
    },
    settle(userId, attemptId) {
      const st = load();
      if (!st[userId]?.[attemptId]) return;
      const byUser = { ...st[userId] };
      delete byUser[attemptId];
      save({ ...st, [userId]: byUser });
    },
    pending(userId) {
      return Object.entries(load()[userId] ?? {})
        .filter((kv): kv is [string, Entry] => fresh(kv[1]))
        .map(([attemptId, e]) => ({ attemptId, id: e.id, at: e.at }))
        .sort((a, b) => b.at - a.at);
    },
  };
}

/** UUID ключа операции (формат проверяет сервер). */
export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${h(3)}-${h(12)}`;
}

/** localStorage браузера или null (SSR, приватный режим, запрет). */
export function browserOperationStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
