"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ANALYTICS_CHANGED, ANALYTICS_PREFERENCE, safePath, safeReferrer, type Attribution } from "./model";
import { analyticsAvailable, captureLanding, chooseAnalytics, parseAnalyticsPreference, trackingBlocked } from "./browser";
import styles from "./privacy-analytics.module.css";

function subscribe(refresh: () => void) {
  window.addEventListener(ANALYTICS_CHANGED, refresh);
  window.addEventListener("storage", refresh);
  return () => {
    window.removeEventListener(ANALYTICS_CHANGED, refresh);
    window.removeEventListener("storage", refresh);
  };
}

function snapshot() {
  if (!analyticsAvailable() || trackingBlocked()) return null;
  try { return window.localStorage.getItem(ANALYTICS_PREFERENCE) ?? ""; }
  catch { return null; }
}

const serverSnapshot = () => null;

export default function PrivacyAnalytics() {
  const pathname = usePathname();
  const landing = useRef<Attribution | null>(null);
  const referrer = useRef<string | null>(null);
  const lastView = useRef<string | null>(null);
  const stored = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const preference = useMemo(() => parseAnalyticsPreference(stored), [stored]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!analyticsAvailable() || trackingBlocked()) return;
    landing.current ??= captureLanding(window.location.search);
    referrer.current = safeReferrer(document.referrer);
  }, []);

  useEffect(() => {
    if (preference?.choice !== "allow" || trackingBlocked()) return;
    const path = safePath(pathname);
    if (!path) {
      lastView.current = null;
      return;
    }
    if (lastView.current === path) return;
    const first = lastView.current === null;
    const source = first ? (landing.current ?? {}) : {};
    lastView.current = path;
    void fetch("/api/metrika/view", {
      method: "POST", credentials: "omit", cache: "no-store", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: preference.clientId, path, source, referrer: first ? referrer.current : null }),
    }).catch(() => {});
  }, [pathname, preference]);

  if (stored === null) return null;

  const choose = (allowed: boolean) => {
    chooseAnalytics(allowed, landing.current ?? {});
    setEditing(false);
    if (!allowed) lastView.current = null;
  };

  return (
    <aside className={styles.settings} aria-label="Настройки аналитики">
      {preference && !editing ? (
        <button className={styles.manage} type="button" onClick={() => setEditing(true)}>Аналитика</button>
      ) : (
        <div className={styles.panel}>
          <p>Разрешить Яндекс Метрику для статистики посещений и действий в сервисе? Выбор можно изменить в любое время.</p>
          <Link href="/privacy#analytics">Подробнее об аналитике</Link>
          <div className={styles.actions}>
            <button type="button" onClick={() => choose(false)}>Отклонить</button>
            <button type="button" onClick={() => choose(true)}>Разрешить</button>
          </div>
        </div>
      )}
    </aside>
  );
}
