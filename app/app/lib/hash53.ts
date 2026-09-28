// ============================================================================
// 53-битный строковый хэш (cyrb53): без crypto, синхронный, одинаков в браузере и
// Node. Общий для отпечатков попыток расчёта (XLSX — upload-session.ts; ручной и
// Ozon API — calc-operation-keys.ts). Менять нельзя: от него зависят уже выданные
// ключи операций и request_hash в журнале calculation_operations.
// ============================================================================

export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
