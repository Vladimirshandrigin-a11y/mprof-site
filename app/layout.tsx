import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "M-Prof — Аналитика прибыли для маркетплейсов",
  description:
    "M-Prof автоматически рассчитывает реальную чистую прибыль продавцов Ozon и Wildberries с учётом комиссий, логистики, хранения, рекламы, возвратов и налога.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
