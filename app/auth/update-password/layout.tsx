import type { Metadata } from "next";
import type { ReactNode } from "react";
import { privatePageMetadata } from "../../seo";

// Задание нового пароля по ссылке из письма: не индексируется.
export const metadata: Metadata = privatePageMetadata("Новый пароль — M-Prof");

export default function UpdatePasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
