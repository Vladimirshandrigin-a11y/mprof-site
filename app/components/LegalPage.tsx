"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Тёмно-золотой «правовой» шаблон для публичных страниц (/contacts, /privacy,
 * /offer). Маршруты вне лендинга НЕ наследуют его <style jsx global>, поэтому
 * тема (шрифты + токены) живёт здесь и одинаково применяется на всех трёх
 * страницах. Сам контент страницы передаётся через children.
 */
export function LegalPage({
  eyebrow,
  title,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <>
      <style jsx global>{`
@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap");
:root{
  --void:#05070f;--deep:#080a14;--panel:#0d1020;
  --glass:rgba(255,255,255,.032);--glass2:rgba(255,255,255,.055);
  --edge:rgba(255,255,255,.07);--edge2:rgba(255,255,255,.12);
  --gold:#C9A84C;--gold2:#E8C97A;--gold3:#F5DFA0;
  --gold-bg:rgba(201,168,76,.07);
  --txt:#E8EEF8;--txt2:#8A9FBB;--txt3:#425068;
  --display:'Playfair Display',Georgia,serif;
  --sans:'Outfit',sans-serif;--mono:'DM Mono',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:#04060e;color:var(--txt);font-family:var(--sans);line-height:1.6;
  background-image:
    radial-gradient(1100px 700px at 82% -8%, rgba(201,168,76,.12), transparent 62%),
    radial-gradient(1000px 800px at -12% 50%, rgba(70,100,200,.10), transparent 65%);
  background-attachment:fixed;min-height:100vh;
  -webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}

.lg-wrap{max-width:840px;margin:0 auto;padding:0 2rem}

.lg-nav{border-bottom:1px solid var(--edge);background:rgba(6,9,20,.55);
  backdrop-filter:blur(14px);position:sticky;top:0;z-index:10}
.lg-nav-row{display:flex;align-items:center;justify-content:space-between;
  padding:1.1rem 0;gap:1rem}
.lg-brand{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt)}
.lg-brand em{font-style:italic;color:var(--gold)}
.lg-back{font-family:var(--sans);font-size:.82rem;color:var(--txt2);
  display:inline-flex;align-items:center;gap:.45rem;transition:color .18s ease}
.lg-back:hover{color:var(--gold2)}

.lg-main{padding:3.4rem 0 4.5rem;min-height:60vh}
.lg-eyebrow{font-family:var(--mono);font-size:.65rem;color:var(--gold2);
  letter-spacing:.18em;text-transform:uppercase;margin-bottom:.9rem}
.lg-title{font-family:var(--display);font-size:clamp(1.7rem,3.4vw,2.4rem);font-weight:700;
  letter-spacing:-.02em;line-height:1.15;margin-bottom:.6rem}
.lg-updated{font-family:var(--mono);font-size:.68rem;color:var(--txt3);
  letter-spacing:.05em;margin-bottom:2.4rem}

.lg-content{font-size:.95rem;color:var(--txt2);font-weight:300}
.lg-content h2{font-family:var(--display);font-size:1.25rem;font-weight:700;color:var(--txt);
  letter-spacing:-.01em;margin:2.4rem 0 .9rem;line-height:1.3}
.lg-content h2:first-child{margin-top:0}
.lg-content p{margin:0 0 1rem;line-height:1.7}
.lg-content ul{margin:0 0 1.1rem;padding:0;list-style:none;display:flex;flex-direction:column;gap:.55rem}
.lg-content li{position:relative;padding-left:1.2rem;line-height:1.6}
.lg-content li::before{content:"";position:absolute;left:0;top:.62rem;width:5px;height:5px;
  border-radius:50%;background:var(--gold);box-shadow:0 0 7px rgba(201,168,76,.6)}
.lg-content strong{color:var(--txt);font-weight:600}
.lg-content a{color:var(--gold2);border-bottom:1px solid rgba(232,201,122,.3);transition:border-color .18s ease}
.lg-content a:hover{border-color:var(--gold2)}

.lg-card{background:var(--glass);border:1px solid var(--edge);border-radius:16px;
  padding:1.9rem 1.8rem;backdrop-filter:blur(12px);box-shadow:0 14px 40px rgba(0,0,0,.22);
  display:flex;flex-direction:column;gap:1rem;margin-bottom:1.6rem}
.lg-row{display:flex;gap:1rem;flex-wrap:wrap;align-items:baseline}
.lg-row-k{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;
  color:var(--txt3);min-width:120px;flex-shrink:0;padding-top:.15rem}
.lg-row-v{font-size:.98rem;color:var(--txt);font-weight:400}
.lg-row-v a{color:var(--gold2)}

.lg-footer{border-top:1px solid var(--edge);padding:2.2rem 0;background:rgba(6,9,20,.55);
  backdrop-filter:blur(14px)}
.lg-foot-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem}
.lg-foot-c{font-family:var(--mono);font-size:.7rem;color:var(--txt3);letter-spacing:.06em}
.lg-foot-links{display:flex;gap:1.4rem;flex-wrap:wrap}
.lg-foot-link{font-size:.8rem;color:var(--txt2);transition:color .18s ease}
.lg-foot-link:hover{color:var(--gold2)}

@media(max-width:640px){
  .lg-wrap{padding:0 1.2rem}
  .lg-main{padding:2.4rem 0 3.2rem}
  .lg-card{padding:1.5rem 1.3rem}
  .lg-row-k{min-width:auto}
  .lg-foot-row{flex-direction:column;text-align:center}
  .lg-foot-links{justify-content:center}
}
      `}</style>

      <header className="lg-nav">
        <div className="lg-wrap lg-nav-row">
          <Link href="/" className="lg-brand">
            M&#8209;<em>Prof</em>
          </Link>
          <Link href="/" className="lg-back">
            <span aria-hidden="true">←</span> На главную
          </Link>
        </div>
      </header>

      <main className="lg-main">
        <div className="lg-wrap">
          <div className="lg-eyebrow">{eyebrow}</div>
          <h1 className="lg-title">{title}</h1>
          {updated ? <div className="lg-updated">{updated}</div> : null}
          <div className="lg-content">{children}</div>
        </div>
      </main>

      <footer className="lg-footer">
        <div className="lg-wrap lg-foot-row">
          <div className="lg-foot-c">M&#8209;Prof © 2026</div>
          <div className="lg-foot-links">
            <Link href="/" className="lg-foot-link">
              Главная
            </Link>
            <Link href="/contacts" className="lg-foot-link">
              Контакты
            </Link>
            <Link href="/privacy" className="lg-foot-link">
              Политика конфиденциальности
            </Link>
            <Link href="/offer" className="lg-foot-link">
              Публичная оферта
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
