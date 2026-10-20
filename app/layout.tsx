import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_URL, pageMetadata } from "./seo";

// Главная: canonical и Open Graph. Остальные страницы задают свои (см. ./seo.ts).
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  ...pageMetadata({
    path: "/",
    title: "M-Prof — Аналитика прибыли для маркетплейсов",
    description:
      "M-Prof считает чистую прибыль продавца Ozon по Ozon API, XLSX «Отчёт по начислениям» или вручную — с учётом комиссий, логистики, рекламы, возвратов, себестоимости и налога. Первый расчёт бесплатно.",
  }),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
