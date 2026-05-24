"use client";

import { useEffect } from "react";
import type { MouseEvent } from "react";

export default function Home() {
  // FAQ accordion toggle
  const handleFaq = (e: MouseEvent<HTMLButtonElement>) => {
    const item = (e.currentTarget as HTMLElement).closest(".faq-item");
    if (!item) return;
    const wasOpen = item.classList.contains("open");
    document.querySelectorAll(".faq-item").forEach((i) => i.classList.remove("open"));
    if (!wasOpen) item.classList.add("open");
  };

  // Scroll reveal via IntersectionObserver
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add("visible");
        });
      },
      { threshold: 0.1 }
    );
    document.querySelectorAll(".reveal").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  return (
    <>
      <style jsx global>{`
@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Outfit:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap");
:root{
  --void:#05070f;--deep:#080a14;--panel:#0d1020;
  --glass:rgba(255,255,255,.032);--glass2:rgba(255,255,255,.055);
  --edge:rgba(255,255,255,.07);--edge2:rgba(255,255,255,.12);
  --gold:#C9A84C;--gold2:#E8C97A;--gold3:#F5DFA0;--gold-d:#8B6E28;
  --gold-bg:rgba(201,168,76,.07);--gold-bg2:rgba(201,168,76,.13);
  --platinum:#B0C0D8;--silver:#7A8FA8;--smoke:#3A4A60;
  --txt:#E8EEF8;--txt2:#8A9FBB;--txt3:#425068;
  --green:#2ECC8A;--red:#E05566;
  --display:'Playfair Display',Georgia,serif;
  --sans:'Outfit',sans-serif;--mono:'DM Mono',monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--void);color:var(--txt);font-family:var(--sans);font-weight:400;line-height:1.6;overflow-x:hidden}

/* AMBIENT */
.ambient{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.ab{position:absolute;border-radius:50%;filter:blur(130px)}
.ab1{width:700px;height:700px;background:radial-gradient(circle,rgba(201,168,76,.18) 0%,transparent 70%);top:-200px;right:-200px}
.ab2{width:500px;height:500px;background:radial-gradient(circle,rgba(26,58,110,.25) 0%,transparent 70%);bottom:20%;left:-150px}
.ab3{width:350px;height:350px;background:radial-gradient(circle,rgba(201,168,76,.09) 0%,transparent 70%);bottom:-80px;right:25%}
.ambient::after{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(201,168,76,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(201,168,76,.03) 1px,transparent 1px);background-size:72px 72px}

/* HEADER */
header{position:fixed;top:0;left:0;right:0;z-index:900;display:flex;align-items:center;justify-content:space-between;padding:1.1rem 3rem;background:rgba(5,7,15,.78);backdrop-filter:blur(24px) saturate(1.4);border-bottom:1px solid var(--edge)}
.logo{font-family:var(--display);font-size:1.3rem;font-weight:700;letter-spacing:.01em;color:var(--txt);text-decoration:none}
.logo em{color:var(--gold);font-style:italic}
.logo-sep{display:inline-block;width:1px;height:14px;background:var(--smoke);margin:0 12px;vertical-align:middle}
.logo-sub{font-family:var(--mono);font-size:.58rem;color:var(--txt3);letter-spacing:.14em;text-transform:uppercase;vertical-align:middle}
nav{display:flex;align-items:center;gap:2.5rem}
nav a{font-size:.82rem;font-weight:500;color:var(--txt2);text-decoration:none;letter-spacing:.02em;transition:color .2s}
nav a:hover{color:var(--gold2)}
.btn-nav{font-family:var(--sans);font-size:.8rem;font-weight:600;color:var(--void);background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);padding:9px 26px;border-radius:2px;text-decoration:none;letter-spacing:.04em;transition:all .2s;box-shadow:0 4px 24px rgba(201,168,76,.25)}
.btn-nav:hover{opacity:.9;transform:translateY(-1px)}

/* HERO */
.hero{position:relative;z-index:1;min-height:100vh;display:grid;grid-template-columns:1fr 380px;gap:4rem;align-items:center;padding:9rem 3rem 5rem;max-width:1300px;margin:0 auto}
.hero-eyebrow{display:inline-flex;align-items:center;gap:10px;font-family:var(--mono);font-size:.63rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:2.2rem;border:1px solid rgba(201,168,76,.22);padding:7px 18px;border-radius:1px;background:rgba(201,168,76,.04)}
.eb-dot{width:5px;height:5px;border-radius:50%;background:var(--gold);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.65)}}
.hero h1{font-family:var(--display);font-size:clamp(3rem,5.5vw,5.5rem);font-weight:700;line-height:1.0;letter-spacing:-.02em;margin-bottom:1.8rem}
.hero h1 em{font-style:italic;color:var(--gold);display:block}
.hero-desc{font-size:1rem;font-weight:300;color:var(--txt2);line-height:1.8;max-width:500px;margin-bottom:2.8rem}
.hero-desc strong{color:var(--txt);font-weight:500}
.hero-cta{display:flex;align-items:center;gap:1.5rem;margin-bottom:3.5rem;flex-wrap:wrap}
.btn-gold{font-family:var(--sans);font-size:.9rem;font-weight:600;background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);padding:14px 38px;border-radius:2px;text-decoration:none;letter-spacing:.04em;transition:all .2s;box-shadow:0 8px 32px rgba(201,168,76,.28)}
.btn-gold:hover{transform:translateY(-2px);box-shadow:0 16px 48px rgba(201,168,76,.38)}
.btn-ghost{font-family:var(--sans);font-size:.88rem;font-weight:500;color:var(--txt2);text-decoration:none;letter-spacing:.02em;display:flex;align-items:center;gap:6px;transition:color .2s}
.btn-ghost:hover{color:var(--gold2)}
.btn-ghost span{transition:transform .2s}
.btn-ghost:hover span{transform:translateX(4px)}
.hero-stats{display:flex;gap:0;border:1px solid var(--edge);border-radius:2px;overflow:hidden;background:var(--glass);backdrop-filter:blur(12px);max-width:480px}
.hs-item{flex:1;padding:1.1rem 1.3rem;border-right:1px solid var(--edge)}
.hs-item:last-child{border-right:none}
.hs-val{font-family:var(--display);font-size:1.5rem;font-weight:700;color:var(--gold2);line-height:1;margin-bottom:3px}
.hs-lbl{font-family:var(--mono);font-size:.58rem;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3)}

/* HERO CARD */
.hero-card{background:var(--glass2);border:1px solid var(--edge2);border-radius:6px;padding:1.8rem;backdrop-filter:blur(20px);box-shadow:0 24px 80px rgba(0,0,0,.45),0 0 0 1px rgba(201,168,76,.08)}
.hc-lbl{font-family:var(--mono);font-size:.58rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);margin-bottom:1.3rem;display:flex;align-items:center;gap:8px}
.hc-lbl::before{content:'';width:18px;height:1px;background:var(--gold);opacity:.4}
.hc-row{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--edge);font-size:.81rem}
.hc-row:last-child{border-bottom:none}
.hc-name{color:var(--txt2)}
.hc-v{font-family:var(--mono);font-weight:500}
.hc-v.neg{color:var(--red)}.hc-v.pos{color:var(--green)}.hc-v.g{color:var(--gold2);font-size:.92rem}
.hc-div{border:none;border-top:1px solid var(--edge2);margin:.7rem 0}

/* SECTIONS */
.section{position:relative;z-index:1;max-width:1300px;margin:0 auto;padding:7rem 3rem}
.s-label{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.22em;color:var(--gold);margin-bottom:1rem;display:flex;align-items:center;gap:14px}
.s-label::before{content:'';width:30px;height:1px;background:linear-gradient(to right,var(--gold),transparent)}
.s-h2{font-family:var(--display);font-size:clamp(2rem,3.5vw,3rem);font-weight:700;line-height:1.1;letter-spacing:-.02em;margin-bottom:.8rem}
.s-h2 em{font-style:italic;color:var(--gold)}
.s-sub{color:var(--txt2);font-size:.95rem;font-weight:300;max-width:460px;line-height:1.75;margin-bottom:3.5rem}
.sep{position:relative;z-index:1;height:1px;background:linear-gradient(to right,transparent,var(--edge2) 30%,var(--edge2) 70%,transparent);max-width:1300px;margin:0 auto}

/* COMPARE */
.cmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:4px;overflow:hidden}
.cmp-col{background:var(--panel);padding:2.2rem}
.cmp-col.gold-tint{background:linear-gradient(135deg,var(--panel) 0%,rgba(201,168,76,.03) 100%)}
.cmp-head{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.14em;margin-bottom:1.5rem;display:flex;align-items:center;gap:8px}
.cmp-head.bad{color:var(--red)}.cmp-head.good{color:var(--gold)}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot.bad{background:var(--red)}.dot.good{background:var(--gold)}
.cmp-list{display:flex;flex-direction:column;gap:.8rem}
.cmp-item{display:flex;gap:10px;font-size:.84rem;color:var(--txt2);line-height:1.5}
.ci{flex-shrink:0;margin-top:1px}

.cmp-table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:2rem;border:1px solid var(--edge);border-radius:4px;overflow:hidden}
.cmp-table thead th{background:var(--panel);padding:.85rem 1.2rem;text-align:left;border-bottom:1px solid var(--edge);font-family:var(--mono);font-size:.58rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);font-weight:400}
.cmp-table thead th:last-child{color:var(--gold)}
.cmp-table td{padding:.82rem 1.2rem;border-bottom:1px solid rgba(255,255,255,.04);color:var(--txt2);vertical-align:middle}
.cmp-table td:first-child{color:var(--txt);font-weight:500}
.cmp-table td:last-child{color:var(--gold2);font-family:var(--mono);font-size:.78rem}
.cmp-table tr:last-child td{border-bottom:none}
.cmp-table tr:hover td{background:var(--glass)}
.c-yes{color:var(--green)}.c-no{color:var(--txt3)}.c-maybe{color:var(--silver)}

/* FEATURES */
.feat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:4px;overflow:hidden}
.feat{background:var(--panel);padding:2rem;transition:background .25s;position:relative}
.feat::after{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,rgba(201,168,76,.35),transparent);opacity:0;transition:opacity .3s}
.feat:hover{background:var(--glass2)}.feat:hover::after{opacity:1}
.feat-n{font-family:var(--display);font-size:2.6rem;font-weight:700;font-style:italic;color:rgba(201,168,76,.14);line-height:1;margin-bottom:.8rem}
.feat-t{font-size:.9rem;font-weight:600;margin-bottom:.4rem}
.feat-d{font-size:.8rem;color:var(--txt2);line-height:1.65;font-weight:300}

/* STEPS */
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:2rem;position:relative;margin-top:1rem}
.steps::before{content:'';position:absolute;top:22px;left:11%;right:11%;height:1px;background:linear-gradient(to right,transparent,var(--edge2) 20%,var(--edge2) 80%,transparent);z-index:0}
.step{position:relative;z-index:1}
.step-c{width:44px;height:44px;border-radius:50%;border:1px solid var(--edge2);background:var(--panel);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.7rem;color:var(--txt3);margin-bottom:1.2rem;transition:all .3s}
.step:hover .step-c{border-color:var(--gold);color:var(--gold);background:var(--gold-bg);box-shadow:0 0 24px rgba(201,168,76,.15)}
.step-t{font-size:.88rem;font-weight:600;margin-bottom:.4rem}
.step-d{font-size:.78rem;color:var(--txt2);line-height:1.6;font-weight:300}

/* PRICING */
.price-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1rem}
.pc{border:1px solid var(--edge2);border-radius:4px;padding:2.5rem;background:var(--panel);position:relative;overflow:hidden;transition:transform .25s}
.pc:hover{transform:translateY(-3px)}
.pc.feat{border-color:rgba(201,168,76,.38);background:linear-gradient(135deg,var(--panel) 0%,rgba(201,168,76,.04) 100%);box-shadow:0 0 60px rgba(201,168,76,.08),0 24px 60px rgba(0,0,0,.3)}
.pc.feat::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,var(--gold),transparent)}
.p-badge{position:absolute;top:1.5rem;right:1.5rem;font-family:var(--mono);font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);border:1px solid rgba(201,168,76,.28);padding:4px 12px;border-radius:1px;background:var(--gold-bg)}
.p-name{font-family:var(--mono);font-size:.63rem;text-transform:uppercase;letter-spacing:.16em;color:var(--txt3);margin-bottom:1.2rem}
.p-amount{font-family:var(--display);font-size:3.8rem;font-weight:700;line-height:1;letter-spacing:-.03em;color:var(--txt);margin-bottom:.3rem}
.p-amount sup{font-size:1.3rem;vertical-align:super;color:var(--gold2)}
.p-period{font-family:var(--mono);font-size:.68rem;color:var(--txt3);margin-bottom:2rem}
.p-list{list-style:none;display:flex;flex-direction:column;gap:.7rem;margin-bottom:2rem}
.p-list li{font-size:.84rem;color:var(--txt2);font-weight:300;display:flex;gap:10px}
.p-list .pi{color:var(--gold);flex-shrink:0}
.btn-pg{display:block;text-align:center;text-decoration:none;font-family:var(--sans);font-size:.84rem;font-weight:600;background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);padding:.9rem;border-radius:2px;letter-spacing:.04em;transition:all .2s;box-shadow:0 4px 20px rgba(201,168,76,.25)}
.btn-pg:hover{opacity:.9;transform:translateY(-1px)}
.btn-po{display:block;text-align:center;text-decoration:none;font-family:var(--sans);font-size:.84rem;font-weight:500;border:1px solid var(--edge2);color:var(--txt2);padding:.9rem;border-radius:2px;letter-spacing:.03em;transition:all .2s}
.btn-po:hover{border-color:var(--gold);color:var(--gold2)}

/* FAQ */
.faq{border:1px solid var(--edge);border-radius:4px;overflow:hidden}
.faq-item{border-bottom:1px solid var(--edge)}
.faq-item:last-child{border-bottom:none}
.faq-q{width:100%;background:none;border:none;padding:1.3rem 1.6rem;display:flex;justify-content:space-between;align-items:center;color:var(--txt);font-family:var(--sans);font-size:.88rem;font-weight:500;cursor:pointer;text-align:left;transition:background .15s}
.faq-q:hover{background:var(--glass)}
.faq-icon{font-family:var(--mono);font-size:1rem;color:var(--gold);transition:transform .2s;flex-shrink:0;margin-left:1rem}
.faq-item.open .faq-icon{transform:rotate(45deg)}
.faq-a{max-height:0;overflow:hidden;transition:max-height .3s ease}
.faq-item.open .faq-a{max-height:260px}
.faq-a-inner{padding:.3rem 1.6rem 1.4rem;font-size:.83rem;color:var(--txt2);line-height:1.7;font-weight:300}
.faq-a-inner a{color:var(--gold);text-decoration:none}
.faq-a-inner a:hover{text-decoration:underline}

/* CTA BAND */
.cta-band{
  position:relative;
  z-index:1;
  background:var(--panel);
  border-top:1px solid var(--edge);
  border-bottom:1px solid var(--edge);
  text-align:center;
}
.cta-inner{max-width:1300px;margin:0 auto;padding:6rem 3rem;display:grid;grid-template-columns:1fr auto;gap:3rem;align-items:center}
.cta-h{font-family:var(--display);font-size:clamp(2rem,3.5vw,2.8rem);font-weight:700;line-height:1.1;letter-spacing:-.02em;margin-bottom:.6rem}
.cta-h em{font-style:italic;color:var(--gold)}
.cta-sub{color:var(--txt2);font-size:.9rem;font-weight:300}
.cta-note{font-family:var(--mono);font-size:.63rem;color:var(--txt3);text-transform:uppercase;letter-spacing:.1em;margin-top:.6rem;text-align:center;margin-left:auto;margin-right:auto}

/* FOOTER */
footer{position:relative;z-index:1;max-width:1300px;margin:0 auto;padding:2.5rem 3rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1.5rem;border-top:1px solid var(--edge)}
.f-logo{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt);text-decoration:none}
.f-logo em{color:var(--gold);font-style:italic}
.f-links{display:flex;gap:2rem;align-items:center}
.f-links a{font-size:.78rem;color:var(--txt3);text-decoration:none;transition:color .15s;letter-spacing:.02em}
.f-links a:hover{color:var(--gold2)}
.f-links a.em{color:var(--gold)}
.f-links a.em:hover{color:var(--gold2)}
.f-copy{font-family:var(--mono);font-size:.62rem;color:var(--txt3);letter-spacing:.06em}

/* REVEAL */
.reveal{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s ease}
.reveal.visible{opacity:1;transform:translateY(0)}
.d1{transition-delay:.1s}.d2{transition-delay:.2s}.d3{transition-delay:.3s}.d4{transition-delay:.4s}

/* RESPONSIVE */
@media(max-width:1100px){
  .hero{grid-template-columns:1fr}
  .hero-card-wrap{display:none}
  .hero h1{font-size:3.5rem}
}
@media(max-width:900px){
  header{padding:.9rem 1.5rem}
  nav{display:none}
  .hero{padding:7rem 1.5rem 4rem}
  .hero h1{font-size:2.6rem}
  .section{padding:4.5rem 1.5rem}
  .cmp-grid{grid-template-columns:1fr}
  .steps{grid-template-columns:1fr 1fr}
  .steps::before{display:none}
  .price-grid{grid-template-columns:1fr}
  .cta-inner{grid-template-columns:1fr;text-align:center}
  .cta-note{text-align:center}
  footer{padding:2rem 1.5rem}
  .hero-stats{flex-direction:column;max-width:260px}
  .hs-item{border-right:none;border-bottom:1px solid var(--edge)}
  .hs-item:last-child{border-bottom:none}.cta-band{overflow:hidden}
.cta-inner{position:relative;z-index:2;grid-template-columns:1fr;justify-items:center}
.cta-inner>*{position:relative;z-index:2;width:100%}
.cta-right{text-align:center;display:flex;flex-direction:column;justify-content:center}
.cta-right .btn-gold{display:inline-block;align-self:center}
.cta-note{text-align:center;max-width:18rem;margin-left:auto;margin-right:auto}
.hero-stats{flex-direction:column;width:100%;max-width:320px;margin-left:auto;margin-right:auto}
.hs-item{flex:none;width:100%;text-align:center;border-right:none}
.hs-item:last-child{border-bottom:none}
.cta-band::before,
.cta-band::after,
.cta-inner::before,
.cta-inner::after{
  display:none!important;
}
      `}</style>

      <div className="ambient"><div className="ab ab1"></div><div className="ab ab2"></div><div className="ab ab3"></div></div>

      <header>
        <a href="/" className="logo">M&#8209;<em>Prof</em><span className="logo-sep"></span><span className="logo-sub">Analytics</span></a>
        <nav>
          <a href="#problem">Проблема</a>
          <a href="#features">Возможности</a>
          <a href="#pricing">Тарифы</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a href="/app" className="btn-nav">Начать расчёт</a>
      </header>

      <section className="hero">
        <div>
          <div className="hero-eyebrow reveal"><span className="eb-dot"></span>Аналитика для Ozon и Wildberries</div>
          <h1 className="reveal d1">Вы знаете,<br />сколько<br /><em>вы реально 
          
           зарабатываете?</em></h1>
          <p className="hero-desc reveal d2">Большинство продавцов считают прибыль неверно. <strong>M&#8209;Prof</strong> автоматически получает данные из вашего кабинета и рассчитывает реальную чистую прибыль с учётом всех расходов.</p>
          <div className="hero-cta reveal d3">
            <a href="/app" className="btn-gold">Рассчитать прибыль</a>
            <a href="#problem" className="btn-ghost">Узнать больше <span>→</span></a>
          </div>
          <div className="hero-stats reveal d4">
            <div className="hs-item"><div className="hs-val">8+</div><div className="hs-lbl">статей расходов</div></div>
            <div className="hs-item"><div className="hs-val">Ozon&WB</div><div className="hs-lbl">маркетплейсы</div></div>
            <div className="hs-item"><div className="hs-val">Бесплатно</div><div className="hs-lbl">первый расчёт</div></div>
          </div>
        </div>
        <div className="hero-card-wrap reveal d2">
          <div className="hero-card">
            <div className="hc-lbl">Пример расчёта · апрель 2026</div>
            <div className="hc-row"><span className="hc-name">Цена продажи</span><span className="hc-v">2 774 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Комиссия Ozon</span><span className="hc-v neg">− 416 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Логистика + возврат</span><span className="hc-v neg">− 148 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Хранение</span><span className="hc-v neg">− 12 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Реклама</span><span className="hc-v neg">− 55 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Себестоимость</span><span className="hc-v neg">− 800 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Налог УСН 6%</span><span className="hc-v neg">− 142 ₽</span></div>
            <hr className="hc-div" />
            <div className="hc-row"><span className="hc-name" style={{ fontWeight: 600, color: "var(--txt)" }}>Чистая прибыль</span><span className="hc-v pos">+ 1 201 ₽</span></div>
            <div className="hc-row"><span className="hc-name">Маржинальность</span><span className="hc-v g">43.3%</span></div>
          </div>
        </div>
      </section>

      <div className="sep"></div>

      <section className="section" id="problem">
        <div className="s-label reveal">Проблема</div>
        <h2 className="s-h2 reveal">Почему реальная прибыль<br /><em>всегда ниже ожидаемой</em></h2>
        <p className="s-sub reveal">Маркетплейс удерживает десятки разных расходов. Большинство продавцов не учитывают их все.</p>
        <div className="cmp-grid reveal">
          <div className="cmp-col">
            <div className="cmp-head bad"><span className="dot bad"></span>Как считают обычно</div>
            <div className="cmp-list">
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Цена продажи минус закупка = «прибыль»</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Комиссию берут приблизительно по категории</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Логистику возвратов не считают вовсе</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Хранение и реклама «в уме» или игнорируются</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Налог вспоминают в конце квартала</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--red)" }}>✕</span>Реальный % выкупа не отслеживается</div>
            </div>
          </div>
          <div className="cmp-col gold-tint">
            <div className="cmp-head good"><span className="dot good"></span>Как считает M&#8209;Prof</div>
            <div className="cmp-list">
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Точные данные из финансового отчёта</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Реальная комиссия по каждой позиции</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Логистика туда + обратная магистраль</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Хранение и реклама из кабинета</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Налог УСН 6% или 15% на выбор</div>
              <div className="cmp-item"><span className="ci" style={{ color: "var(--gold)" }}>✦</span>Реальный % выкупа за период</div>
            </div>
          </div>
        </div>
        <table className="cmp-table reveal">
          <thead><tr><th>Статья расхода</th><th>Excel вручную</th><th>Кабинет МП</th><th>M&#8209;Prof</th></tr></thead>
          <tbody>
            <tr><td>Комиссия</td><td className="c-maybe">≈ примерно</td><td className="c-yes">Да</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Логистика</td><td className="c-no">Нет</td><td className="c-maybe">Частично</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Возвраты</td><td className="c-no">Нет</td><td className="c-no">Нет</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Хранение</td><td className="c-no">Нет</td><td className="c-maybe">Отдельно</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Реклама на единицу</td><td className="c-no">Нет</td><td className="c-no">Нет</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Налог УСН</td><td className="c-no">Нет</td><td className="c-no">Нет</td><td className="c-yes">✦ авто</td></tr>
            <tr><td>Время на анализ</td><td className="c-no">3–4 часа</td><td className="c-maybe">1–2 часа</td><td className="c-yes">Меньше минуты</td></tr>
          </tbody>
        </table>
      </section>

      <div className="sep"></div>

      <section className="section" id="features">
        <div className="s-label reveal">Возможности</div>
        <h2 className="s-h2 reveal">Всё необходимое<br /><em>в одном инструменте</em></h2>
        <p className="s-sub reveal">Два способа загрузки. Полная разбивка расходов. История и экспорт.</p>
        <div className="feat-grid">
          <div className="feat reveal"><div className="feat-n">01</div><div className="feat-t">Два способа загрузки</div><div className="feat-d">API-ключ для полной автоматизации или xlsx-отчёт из личного кабинета — результат одинаковый.</div></div>
          <div className="feat reveal d1"><div className="feat-n">02</div><div className="feat-t">Ozon и Wildberries</div><div className="feat-d">Оба маркетплейса поддерживаются. Алгоритмы адаптированы под формат финансовых отчётов каждого из них.</div></div>
          <div className="feat reveal d2"><div className="feat-n">03</div><div className="feat-t">Расчёт по каждому SKU</div><div className="feat-d">Не средние цифры — отдельная строка для каждой позиции с полной разбивкой по восьми статьям расходов.</div></div>
          <div className="feat reveal"><div className="feat-n">04</div><div className="feat-t">Маржа и ROI</div><div className="feat-d">Маржинальность и рентабельность инвестиций сразу — без формул и сводных таблиц.</div></div>
          <div className="feat reveal d1"><div className="feat-n">05</div><div className="feat-t">История расчётов</div><div className="feat-d">Все расчёты сохраняются в кабинете. Сравнивайте периоды и отслеживайте динамику прибыли.</div></div>
          <div className="feat reveal d2"><div className="feat-n">06</div><div className="feat-t">Экспорт в CSV</div><div className="feat-d">Готовая таблица для бухгалтера, партнёра или дальнейшего анализа в Excel и Google Sheets.</div></div>
        </div>
      </section>

      <div className="sep"></div>

      <section className="section">
        <div className="s-label reveal">Процесс</div>
        <h2 className="s-h2 reveal">Четыре шага<br /><em>до результата</em></h2>
        <div className="steps">
          <div className="step reveal"><div className="step-c">01</div><div className="step-t">Выберите маркетплейс</div><div className="step-d">Ozon или Wildberries. Интерфейс подстраивается автоматически.</div></div>
          <div className="step reveal d1"><div className="step-c">02</div><div className="step-t">Загрузите данные</div><div className="step-d">API-ключ — данные подтянутся сами. Или загрузите xlsx из раздела «Финансы».</div></div>
          <div className="step reveal d2"><div className="step-c">03</div><div className="step-t">Введите себестоимость</div><div className="step-d">Только закупочную цену. Всё остальное уже получено из кабинета.</div></div>
          <div className="step reveal d3"><div className="step-c">04</div><div className="step-t">Получите расчёт</div><div className="step-d">Прибыль, маржа и ROI по каждой позиции. Экспорт в один клик.</div></div>
        </div>
      </section>

      <div className="sep"></div>

      <section className="section" id="pricing">
        <div className="s-label reveal">Тарифы</div>
        <h2 className="s-h2 reveal">Прозрачное<br /><em>ценообразование</em></h2>
        <p className="s-sub reveal">Без скрытых платежей и обязательных подписок.</p>
        <div className="price-grid">
          <div className="pc reveal">
            <div className="p-name">Разовый</div>
            <div className="p-amount"><sup>₽</sup>149</div>
            <div className="p-period">за один расчёт</div>
            <ul className="p-list">
              <li><span className="pi">✦</span>Один период и маркетплейс</li>
              <li><span className="pi">✦</span>Все позиции без ограничений</li>
              <li><span className="pi">✦</span>Экспорт в CSV</li>
              <li><span className="pi">✦</span>API или xlsx — на выбор</li>
            </ul>
            <a href="/app" className="btn-po">Начать →</a>
          </div>
          <div className="pc feat reveal d1">
            <div className="p-badge">Выгодно</div>
            <div className="p-name">Безлимит</div>
            <div className="p-amount"><sup>₽</sup>449</div>
            <div className="p-period">в месяц · неограниченные расчёты</div>
            <ul className="p-list">
              <li><span className="pi">✦</span>Неограниченные расчёты</li>
              <li><span className="pi">✦</span>Ozon + Wildberries одновременно</li>
              <li><span className="pi">✦</span>История за все периоды</li>
              <li><span className="pi">✦</span>Экспорт в CSV</li>
              <li><span className="pi">✦</span>Приоритетная поддержка</li>
            </ul>
            <a href="/app" className="btn-pg">Подключить →</a>
          </div>
        </div>
      </section>

      <div className="sep"></div>

      <section className="section" id="faq">
        <div className="s-label reveal">FAQ</div>
        <h2 className="s-h2 reveal">Частые<br /><em>вопросы</em></h2>
        <div className="faq reveal" style={{ marginTop: "2rem" }}>
          <div className="faq-item">
            <button className="faq-q" onClick={handleFaq}>Мои данные в безопасности?<span className="faq-icon">+</span></button>
            <div className="faq-a"><div className="faq-a-inner">API-ключ используется только в момент расчёта и нигде не сохраняется. Финансовые данные не хранятся на наших серверах — расчёт производится на лету.</div></div>
          </div>
          <div className="faq-item">
            <button className="faq-q" onClick={handleFaq}>Как получить API-ключ Ozon?<span className="faq-icon">+</span></button>
            <div className="faq-a"><div className="faq-a-inner">Войдите в seller.ozon.ru → Настройки → API-ключи → Создать ключ. Укажите название и отметьте роли «Финансы» и «Аналитика». Ключ появится сразу после создания.</div></div>
          </div>
          <div className="faq-item">
            <button className="faq-q" onClick={handleFaq}>Где скачать xlsx-отчёт в Ozon?<span className="faq-icon">+</span></button>
            <div className="faq-a"><div className="faq-a-inner">Личный кабинет Ozon → Финансы → Документы → Отчёт о реализации товара. Выберите нужный месяц и скачайте файл .xlsx.</div></div>
          </div>
          <div className="faq-item">
            <button className="faq-q" onClick={handleFaq}>Как получить API-ключ Wildberries?<span className="faq-icon">+</span></button>
            <div className="faq-a"><div className="faq-a-inner">Войдите в seller.wildberries.ru → Профиль → Настройки → Доступ к API. Создайте токен с правами «Статистика» и «Финансы». Скопируйте токен — он показывается один раз.</div></div>
          </div>
          <div className="faq-item">
            <button className="faq-q" onClick={handleFaq}>Как связаться с поддержкой?<span className="faq-icon">+</span></button>
            <div className="faq-a"><div className="faq-a-inner">По всем вопросам пишите на <a href="mailto:ozonpochtamail@mail.ru">ozonpochtamail@mail.ru</a> — отвечаем в течение рабочего дня.</div></div>
          </div>
        </div>
      </section>

      <div className="cta-band">
        <div className="cta-inner">
          <div>
            <h2 className="cta-h reveal">Начните считать<br /><em>правильно</em></h2>
            <p className="cta-sub reveal">Первый расчёт занимает меньше двух минут</p>
          </div>
          <div className="reveal d1" style={{ textAlign: "right" }}>
            <a href="/app" className="btn-gold">Начать бесплатный расчёт →</a>
            <div className="cta-note">первый расчёт бесплатно, далее от 149 ₽</div>
          </div>
        </div>
      </div>

      <footer>
        <a href="/" className="f-logo">M&#8209;<em>Prof</em></a>
        <div className="f-links">
          <a href="#">Условия</a>
          <a href="#">Конфиденциальность</a>
          <a href="mailto:ozonpochtamail@mail.ru" className="em">ozonpochtamail@mail.ru</a>
        </div>
        <span className="f-copy">© 2025 M-Prof Analytics</span>
      </footer>
    </>
  );
}
