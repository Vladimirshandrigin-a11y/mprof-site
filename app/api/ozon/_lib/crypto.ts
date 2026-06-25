import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// ============================================================================
// Шифрование Api-Key кабинета Ozon. ТОЛЬКО сервер.
//
// AES-256-GCM (аутентифицированное шифрование: GCM ловит подмену шифротекста).
// Ключ шифрования берётся из СЕРВЕРНОГО env OZON_KEYS_ENC_SECRET (без NEXT_PUBLIC
// — иначе утечёт в браузер-бандл). Из секрета SHA-256 даёт ровно 32 байта (256 бит).
//
// Формат хранимой строки:  base64(iv) : base64(authTag) : base64(ciphertext)
//   iv      — 12 байт (рекомендованный размер nonce для GCM);
//   authTag — 16 байт.
//
// ВАЖНО: ни сам ключ, ни plaintext (api key) НИКОГДА не логируются.
// ============================================================================

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const MIN_SECRET_LEN = 32;

/** 32-байтный ключ из env-секрета. Бросает, если секрет не настроен/короткий. */
function getKey(): Buffer {
  const secret = process.env.OZON_KEYS_ENC_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error("OZON_KEYS_ENC_SECRET не задан или короче 32 символов");
  }
  return createHash("sha256").update(secret, "utf8").digest(); // ровно 32 байта
}

/** Настроено ли шифрование — для аккуратной 503 в route без раскрытия деталей. */
export function isEncryptionConfigured(): boolean {
  const secret = process.env.OZON_KEYS_ENC_SECRET;
  return !!secret && secret.length >= MIN_SECRET_LEN;
}

/** Зашифровать Api-Key → "iv:tag:ciphertext" (всё base64). */
export function encryptOzonApiKey(apiKey: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Расшифровать "iv:tag:ciphertext" → Api-Key. Бросает при подмене/повреждении. */
export function decryptOzonApiKey(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Повреждённый формат зашифрованного ключа");
  }
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("Повреждённый зашифрованный ключ (iv/tag)");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Последние 4 символа ключа — для отображения ••••1234 (не секрет). */
export function last4(apiKey: string): string {
  return apiKey.slice(-4);
}
