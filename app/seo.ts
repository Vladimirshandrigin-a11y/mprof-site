import type { Metadata } from "next";

// ============================================================================
// Базовое SEO: основной адрес сайта, публичные страницы и правила индексации.
//
// Next.js сливает metadata сегментов ПОВЕРХНОСТНО: alternates / openGraph /
// robots дочерней страницы заменяют родительские целиком. Поэтому каждая
// публичная страница задаёт свои canonical и Open Graph (pageMetadata), а
// закрытые — privatePageMetadata (noindex, без canonical).
// ============================================================================

/** Основной домен (www.mprof-seller.ru сейчас не работает по HTTPS). */
export const SITE_URL = "https://mprof-seller.ru";
export const SITE_NAME = "M-Prof";

/** Публичные индексируемые страницы — ровно они попадают в sitemap.xml. */
export const PUBLIC_PATHS = ["/", "/offer", "/privacy", "/contacts"] as const;

/** Личный кабинет, восстановление пароля, API — не индексируются. */
export const PRIVATE_PATH_PREFIXES = ["/app", "/auth", "/api"] as const;

/** Metadata публичной страницы: title, description, canonical и Open Graph. */
export function pageMetadata(page: {
  path: (typeof PUBLIC_PATHS)[number];
  title: string;
  description: string;
}): Metadata {
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph: {
      type: "website",
      locale: "ru_RU",
      siteName: SITE_NAME,
      url: page.path,
      title: page.title,
      description: page.description,
    },
  };
}

/**
 * Закрытая страница: не индексировать и не идти по ссылкам; canonical не задаём
 * (иначе унаследовался бы canonical главной).
 */
export const PRIVATE_PAGE_ROBOTS = { index: false, follow: false } as const;

export function privatePageMetadata(title: string): Metadata {
  return {
    title,
    robots: PRIVATE_PAGE_ROBOTS,
    alternates: { canonical: null },
  };
}
