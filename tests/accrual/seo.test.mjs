// Базовое SEO (app/seo.ts, app/robots.ts, app/sitemap.ts, layout-файлы закрытых
// страниц): в sitemap — только публичные страницы на основном домене, robots.txt
// не закрывает главную, кабинет и восстановление пароля — noindex без canonical.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, seo, seoRobots, seoSitemap } from "./helpers/modules.mjs";

const SITE = "https://mprof-seller.ru";

describe("seo: sitemap.xml", () => {
  const urls = seoSitemap.default().map((e) => e.url);

  it("ровно публичные страницы на основном домене https://mprof-seller.ru", () => {
    assert.deepEqual(urls, [SITE, `${SITE}/offer`, `${SITE}/privacy`, `${SITE}/contacts`]);
  });

  it("без кабинета, восстановления пароля, API и www", () => {
    for (const u of urls) {
      assert.ok(u.startsWith(`${SITE}`) && !u.includes("www."), u);
      for (const p of seo.PRIVATE_PATH_PREFIXES) assert.ok(!new URL(u).pathname.startsWith(p), `${u} — ${p}`);
    }
  });

  it("без выдуманных дат изменения", () => {
    for (const e of seoSitemap.default()) assert.equal(e.lastModified, undefined);
  });
});

describe("seo: robots.txt", () => {
  const r = seoRobots.default();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  const disallow = rules.flatMap((x) => (Array.isArray(x.disallow) ? x.disallow : x.disallow ? [x.disallow] : []));

  it("главная открыта, закрыт только технический /api/", () => {
    assert.equal(rules[0].userAgent, "*");
    assert.equal(rules[0].allow, "/");
    assert.deepEqual(disallow, ["/api/"]);
  });

  it("кабинет и /auth не закрыты в robots — иначе поисковик не увидит их noindex", () => {
    for (const d of disallow) assert.ok(!["/", "/app", "/app/", "/auth", "/auth/"].includes(d), d);
  });

  it("ссылка на sitemap — на основном домене", () => {
    assert.equal(r.sitemap, `${SITE}/sitemap.xml`);
  });
});

describe("seo: metadata страниц", () => {
  it("публичная страница: canonical = свой путь, Open Graph на русском с тем же адресом", () => {
    const m = seo.pageMetadata({ path: "/offer", title: "T", description: "D" });
    assert.equal(m.alternates.canonical, "/offer");
    assert.deepEqual(m.openGraph, {
      type: "website",
      locale: "ru_RU",
      siteName: "M-Prof",
      url: "/offer",
      title: "T",
      description: "D",
    });
  });

  it("закрытая страница: noindex, nofollow и без canonical главной", () => {
    const m = seo.privatePageMetadata("X");
    assert.deepEqual(m.robots, { index: false, follow: false });
    assert.equal(m.alternates.canonical, null);
  });

  const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("кабинет /app и /auth/update-password используют privatePageMetadata", () => {
    assert.match(read("app/app/layout.tsx"), /privatePageMetadata\("Личный кабинет — M-Prof"\)/);
    assert.match(read("app/auth/update-password/layout.tsx"), /privatePageMetadata\("Новый пароль — M-Prof"\)/);
  });

  it("главная, оферта, политика и контакты задают свой canonical через pageMetadata", () => {
    assert.match(read("app/layout.tsx"), /metadataBase: new URL\(SITE_URL\)[\s\S]*pageMetadata\(\{\s*path: "\/"/);
    for (const [rel, p] of [
      ["app/offer/page.tsx", "/offer"],
      ["app/privacy/page.tsx", "/privacy"],
      ["app/contacts/page.tsx", "/contacts"],
    ]) {
      assert.match(read(rel), new RegExp(`pageMetadata\\(\\{\\s*path: "${p}"`), rel);
    }
  });

  it("описание главной без неподтверждённых обещаний («реальная», «гарантированная», «точная»)", () => {
    const src = read("app/layout.tsx");
    assert.ok(!/реальн|гарантир|точн|100\s*%/i.test(src), "рекламное обещание в metadata");
  });
});
