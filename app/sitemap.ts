import type { MetadataRoute } from "next";
import { PUBLIC_PATHS, SITE_URL } from "./seo";

// /sitemap.xml — только публичные индексируемые страницы (без кабинета,
// восстановления пароля и API). Даты изменения не указываем: надёжного
// источника нет.
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({ url: path === "/" ? SITE_URL : `${SITE_URL}${path}` }));
}
