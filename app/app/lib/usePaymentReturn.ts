"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PAYMENT_BASELINE_KEY,
  createPaymentReturnCheck,
  isPaymentReturn,
  parseBaseline,
  serializeBaseline,
  stripPaymentReturnParams,
  type AccessGrowth,
  type EntitlementsReading,
  type PaymentReturnCheck,
  type PaymentReturnPhase,
} from "./payment-return";

// Возврат из ЮKassa на /app?payment=return: статус оплаты по правам доступа.
// Логика и правила — в ./payment-return.ts; здесь только привязка к странице:
// права и recheck — из useEntitlements, таймеры снимаются при размонтировании.

export interface PaymentReturnEntitlements {
  loaded: boolean;
  checking: boolean;
  checkFailed: boolean;
  hasPremium: boolean;
  premiumUntil: string | null;
  singleCredits: number;
  recheck: () => Promise<void>;
}

export type PaymentReturnStatus = "idle" | "needs_login" | PaymentReturnPhase;

export interface PaymentReturnState {
  status: PaymentReturnStatus;
  /** Что выросло при подтверждении (для текста); иначе null. */
  growth: AccessGrowth | null;
  /** «Проверить снова» — ещё один конечный круг проверки. */
  retry: () => void;
  /** Скрыть сообщение и остановить проверку. */
  dismiss: () => void;
}

/** Сколько ждать, пока страница применит результат перечитки. */
const SETTLE_MAX_MS = 500;

function readStoredBaseline(userId: string) {
  try {
    return parseBaseline(window.sessionStorage.getItem(PAYMENT_BASELINE_KEY), userId, Date.now());
  } catch {
    return null;
  }
}

function clearStoredBaseline() {
  try {
    window.sessionStorage.removeItem(PAYMENT_BASELINE_KEY);
  } catch {
    /* sessionStorage недоступен */
  }
}

/** Убрать payment=return и sub из адреса, сохранив остальные параметры и hash. */
function stripReturnParamsFromUrl() {
  try {
    const next = stripPaymentReturnParams(window.location.href);
    if (next !== null) window.history.replaceState(window.history.state, "", next);
  } catch {
    /* history недоступна */
  }
}

export function usePaymentReturn({
  userId,
  authResolved,
  tariffModalOpen,
  entitlements: ent,
}: {
  userId: string | null;
  /** Проверка сессии при загрузке страницы завершена. */
  authResolved: boolean;
  /** Открыто окно оплаты — запоминаем права «до оплаты». */
  tariffModalOpen: boolean;
  entitlements: PaymentReturnEntitlements;
}): PaymentReturnState {
  const [active, setActive] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<PaymentReturnPhase | null>(null);
  const [growth, setGrowth] = useState<AccessGrowth | null>(null);

  // Последние права страницы; после каждого коммита — будим ожидающих settle().
  const latestRef = useRef<EntitlementsReading>({
    hasPremium: false,
    premiumUntil: null,
    singleCredits: 0,
    complete: false,
  });
  const recheckRef = useRef(ent.recheck);
  const waitersRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    latestRef.current = {
      hasPremium: ent.hasPremium,
      premiumUntil: ent.premiumUntil,
      singleCredits: ent.singleCredits,
      complete: ent.loaded && !ent.checkFailed,
    };
    recheckRef.current = ent.recheck;
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const wake of waiters) wake();
  });

  // Паузы проверки: при остановке все снимаются и сразу завершаются.
  const sleepsRef = useRef(new Map<number, () => void>());
  const sleep = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(() => {
          sleepsRef.current.delete(id);
          resolve();
        }, Math.max(0, ms));
        sleepsRef.current.set(id, resolve);
      }),
    []
  );
  const cancelSleeps = useCallback(() => {
    for (const [id, resolve] of sleepsRef.current) {
      window.clearTimeout(id);
      resolve();
    }
    sleepsRef.current.clear();
  }, []);

  const checkRef = useRef<PaymentReturnCheck | null>(null);
  const getCheck = useCallback((): PaymentReturnCheck => {
    if (!checkRef.current) {
      checkRef.current = createPaymentReturnCheck({
        recheck: () => recheckRef.current(),
        read: () => latestRef.current,
        settle: () =>
          new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };
            waitersRef.current.push(finish);
            void sleep(SETTLE_MAX_MS).then(finish);
          }),
        sleep,
        onPhase: (p, g) => {
          setPhase(p);
          setGrowth(g);
          if (p !== "checking") {
            stripReturnParamsFromUrl();
            clearStoredBaseline();
          }
        },
      });
    }
    return checkRef.current;
  }, [sleep]);

  // Размонтирование: проверка останавливается, таймеры снимаются.
  const startedRef = useRef(false);
  useEffect(
    () => () => {
      checkRef.current?.dispose();
      checkRef.current = null;
      startedRef.current = false;
      cancelSleeps();
    },
    [cancelSleeps]
  );

  // Признак возврата читаем один раз при открытии страницы.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (isPaymentReturn(window.location.search)) setActive(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  // Пока открыто окно оплаты — права «до оплаты» (только полные, без идущей проверки).
  useEffect(() => {
    if (!tariffModalOpen || !userId || !ent.loaded || ent.checking || ent.checkFailed) return;
    try {
      window.sessionStorage.setItem(
        PAYMENT_BASELINE_KEY,
        serializeBaseline(
          userId,
          { hasPremium: ent.hasPremium, premiumUntil: ent.premiumUntil, singleCredits: ent.singleCredits },
          Date.now()
        )
      );
    } catch {
      /* sessionStorage недоступен — после возврата снимок возьмём из первой перечитки */
    }
  }, [tariffModalOpen, userId, ent.loaded, ent.checking, ent.checkFailed, ent.hasPremium, ent.premiumUntil, ent.singleCredits]);

  // Старт — один раз, когда есть вход и первичные права загружены.
  useEffect(() => {
    if (!active || dismissed || !authResolved || !userId || !ent.loaded || startedRef.current) return;
    const t = window.setTimeout(() => {
      startedRef.current = true;
      getCheck().run(readStoredBaseline(userId));
    }, 0);
    return () => window.clearTimeout(t);
  }, [active, dismissed, authResolved, userId, ent.loaded, getCheck]);

  const retry = useCallback(() => {
    if (!userId) return;
    getCheck().run(null);
  }, [getCheck, userId]);

  const dismiss = useCallback(() => {
    checkRef.current?.dispose();
    checkRef.current = null;
    cancelSleeps();
    setDismissed(true);
    stripReturnParamsFromUrl();
    clearStoredBaseline();
  }, [cancelSleeps]);

  let status: PaymentReturnStatus = "idle";
  if (active && !dismissed) {
    if (phase) status = phase;
    else if (authResolved && !userId) status = "needs_login";
    else status = "checking";
  }

  return { status, growth, retry, dismiss };
}
