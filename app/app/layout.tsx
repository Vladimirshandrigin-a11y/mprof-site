import type { Metadata } from "next";
import type { ReactNode } from "react";
import { privatePageMetadata } from "../seo";

// Личный кабинет: свой заголовок вкладки, не индексируется.
export const metadata: Metadata = privatePageMetadata("Личный кабинет — M-Prof");

export default function AppLayout({ children }: { children: ReactNode }) {
  return children;
}
