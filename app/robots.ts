import type { MetadataRoute } from "next";
import { SITE_URL } from "./seo";

// /robots.txt. Кабинет (/app) и восстановление пароля (/auth) здесь НЕ закрыты
// намеренно: их запрет индексации — meta robots noindex, а его поисковик видит,
// только если может открыть страницу. Закрыт лишь технический /api/.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
