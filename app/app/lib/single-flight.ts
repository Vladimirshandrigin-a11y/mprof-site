// ============================================================================
// Один запуск за раз для повторных проверок (например, прав при возврате во
// вкладку): одновременные вызовы получают ОДИН общий запуск; после завершения
// повтор раньше minIntervalMs пропускается (focus и visibilitychange приходят
// парой). force — ручной «Проверить снова»: без паузы, но тоже без параллельных.
// Ошибка запуска не блокирует следующие попытки.
// ============================================================================

export interface SingleFlight {
  /** true — запуск выполнен (или идёт общий); false — пропущен из-за паузы. */
  run(force?: boolean): Promise<boolean>;
}

export function createSingleFlight(
  task: () => Promise<void>,
  minIntervalMs: number,
  now: () => number = Date.now
): SingleFlight {
  let inFlight: Promise<boolean> | null = null;
  let lastDoneAt = Number.NEGATIVE_INFINITY;

  return {
    run(force = false) {
      if (inFlight) return inFlight;
      if (!force && now() - lastDoneAt < minIntervalMs) return Promise.resolve(false);
      inFlight = (async () => {
        try {
          await task();
          return true;
        } finally {
          lastDoneAt = now();
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
