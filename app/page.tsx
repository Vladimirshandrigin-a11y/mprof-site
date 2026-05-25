"use client";

import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <style jsx global>{`
@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap");
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
*{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:#04060e;color:var(--txt);font-family:var(--sans);line-height:1.6;
  background-image:
    radial-gradient(1100px 700px at 82% -8%, rgba(201,168,76,.12), transparent 62%),
    radial-gradient(1000px 800px at -12% 50%, rgba(70,100,200,.10), transparent 65%),
    radial-gradient(900px 700px at 105% 90%, rgba(120,90,200,.08), transparent 65%);
  background-attachment:fixed;min-height:100vh;
  -webkit-font-smoothing:antialiased;
  scroll-behavior:smooth
}
ul{list-style:none}
a{color:inherit;text-decoration:none}

/* ====== NAV ====== */
.ln-nav{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  padding:1.1rem 2rem;background:rgba(6,9,20,.72);backdrop-filter:blur(20px) saturate(1.35);
  -webkit-backdrop-filter:blur(20px) saturate(1.35);border-bottom:1px solid var(--edge)}
.ln-brand{font-family:var(--display);font-size:1.2rem;font-weight:700;letter-spacing:.005em;color:var(--txt)}
.ln-brand em{font-style:italic;color:var(--gold)}
.ln-brand-sub{font-family:var(--mono);font-size:.58rem;color:var(--txt3);letter-spacing:.14em;
  text-transform:uppercase;margin-left:10px;vertical-align:middle}
.ln-nav-links{display:flex;align-items:center;gap:1.6rem}
.ln-nav-link{font-size:.82rem;color:var(--txt2);font-weight:400;transition:color .18s ease}
.ln-nav-link:hover{color:var(--gold2)}
.ln-nav-cta{font-family:var(--sans);font-size:.82rem;font-weight:500;color:var(--txt);
  padding:8px 18px;border:1px solid var(--edge2);border-radius:10px;background:rgba(255,255,255,.03);
  transition:all .2s ease;cursor:pointer;backdrop-filter:blur(8px)}
.ln-nav-cta:hover{border-color:var(--gold);color:var(--gold2);background:var(--gold-bg);transform:translateY(-1px)}

/* ====== LAYOUT ====== */
.ln-wrap{max-width:1180px;margin:0 auto;padding:0 2rem}
.ln-section{padding:5.5rem 0;position:relative}
.ln-section-h{text-align:center;margin-bottom:3.4rem;max-width:720px;margin-left:auto;margin-right:auto}
.ln-section-eyebrow{font-family:var(--mono);font-size:.65rem;color:var(--gold2);
  letter-spacing:.18em;text-transform:uppercase;margin-bottom:.8rem}
.ln-h2{font-family:var(--display);font-size:clamp(1.8rem,3.5vw,2.6rem);font-weight:700;
  letter-spacing:-.02em;margin-bottom:.8rem;line-height:1.15}
.ln-h2 em{font-style:italic;color:var(--gold)}
.ln-section-sub{font-size:.95rem;color:var(--txt2);font-weight:300;line-height:1.6}

/* ====== HERO ====== */
.ln-hero{padding:6.5rem 0 4.5rem;position:relative;overflow:hidden}
.ln-hero::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(700px 400px at 50% 0%, rgba(201,168,76,.10), transparent 60%);
  z-index:0}
.ln-hero-inner{max-width:900px;margin:0 auto;text-align:center;position:relative;z-index:1}
.ln-eyebrow{display:inline-flex;align-items:center;gap:9px;font-family:var(--mono);font-size:.68rem;
  color:var(--gold2);letter-spacing:.1em;text-transform:uppercase;
  border:1px solid rgba(201,168,76,.32);padding:7px 18px;border-radius:100px;
  background:var(--gold-bg);margin-bottom:1.8rem;
  backdrop-filter:blur(10px);box-shadow:0 4px 16px rgba(201,168,76,.06)}
.ln-eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--gold);
  box-shadow:0 0 14px var(--gold);animation:pulseDot 2s ease-in-out infinite}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.65)}}
.ln-h1{font-family:var(--display);font-size:clamp(2.2rem,5vw,3.9rem);font-weight:700;
  letter-spacing:-.025em;line-height:1.08;margin-bottom:1.4rem}
.ln-h1 em{font-style:italic;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold3) 50%,var(--gold) 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ln-lead{font-size:clamp(1rem,1.55vw,1.16rem);color:var(--txt2);font-weight:300;
  max-width:700px;margin:0 auto 2.4rem;line-height:1.6}
.ln-cta-row{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:3.2rem}
.ln-btn{font-family:var(--sans);font-size:.95rem;font-weight:600;padding:14px 28px;
  border-radius:11px;cursor:pointer;letter-spacing:.01em;transition:all .22s ease;
  display:inline-flex;align-items:center;gap:10px;text-decoration:none;border:none}
.ln-btn-gold{background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);box-shadow:0 10px 32px rgba(201,168,76,.28)}
.ln-btn-gold:hover{transform:translateY(-2px);box-shadow:0 18px 44px rgba(201,168,76,.42)}
.ln-btn-ghost{background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--edge2);backdrop-filter:blur(10px)}
.ln-btn-ghost:hover{border-color:var(--gold);color:var(--gold2);
  background:var(--gold-bg);transform:translateY(-2px)}
.ln-btn .arr{display:inline-block;transition:transform .22s ease}
.ln-btn:hover .arr{transform:translateX(4px)}

.ln-hero-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;max-width:780px;margin:0 auto}
.ln-stat{background:var(--glass);border:1px solid var(--edge);border-radius:14px;
  padding:1.2rem 1.4rem;text-align:center;backdrop-filter:blur(14px);
  box-shadow:0 14px 40px rgba(0,0,0,.28);transition:all .25s ease}
.ln-stat:hover{transform:translateY(-3px);border-color:rgba(201,168,76,.3);background:var(--glass2)}
.ln-stat-v{font-family:var(--display);font-size:1.7rem;font-weight:700;color:var(--gold2);letter-spacing:-.02em}
.ln-stat-l{font-family:var(--mono);font-size:.6rem;color:var(--txt3);text-transform:uppercase;
  letter-spacing:.12em;margin-top:4px}

/* ====== FEATURES ====== */
.ln-feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem}
.ln-feat{background:var(--glass);border:1px solid var(--edge);border-radius:16px;
  padding:1.7rem 1.5rem;backdrop-filter:blur(12px);box-shadow:0 14px 40px rgba(0,0,0,.25);
  transition:all .28s ease;display:flex;flex-direction:column;gap:.55rem;position:relative;overflow:hidden}
.ln-feat::after{content:"";position:absolute;inset:0;background:radial-gradient(400px 200px at 100% 0%, rgba(201,168,76,.08), transparent 60%);
  opacity:0;transition:opacity .3s ease;pointer-events:none}
.ln-feat:hover{transform:translateY(-4px);border-color:rgba(201,168,76,.3);
  background:var(--glass2);box-shadow:0 20px 60px rgba(0,0,0,.32),0 0 38px rgba(201,168,76,.07)}
.ln-feat:hover::after{opacity:1}
.ln-feat-ico{width:44px;height:44px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(201,168,76,.2) 0%,rgba(201,168,76,.06) 100%);
  border:1px solid rgba(201,168,76,.25);color:var(--gold2);margin-bottom:.5rem;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.ln-feat-ico svg{width:20px;height:20px}
.ln-feat-title{font-family:var(--display);font-size:1.08rem;font-weight:700;color:var(--txt)}
.ln-feat-text{font-size:.86rem;color:var(--txt2);font-weight:300;line-height:1.55}

/* ====== HOW IT WORKS ====== */
.ln-how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.3rem;position:relative}
.ln-step{background:var(--glass);border:1px solid var(--edge);border-radius:16px;
  padding:2.1rem 1.7rem;text-align:left;backdrop-filter:blur(12px);
  position:relative;transition:all .28s ease;box-shadow:0 14px 40px rgba(0,0,0,.25)}
.ln-step:hover{transform:translateY(-4px);border-color:rgba(201,168,76,.3);background:var(--glass2)}
.ln-step-n{font-family:var(--display);font-size:3.4rem;font-weight:700;line-height:1;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold3) 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  margin-bottom:.8rem;letter-spacing:-.04em;opacity:.95}
.ln-step-t{font-family:var(--display);font-size:1.15rem;font-weight:700;color:var(--txt);margin-bottom:.5rem}
.ln-step-d{font-size:.86rem;color:var(--txt2);font-weight:300;line-height:1.55}

/* ====== PRICING ====== */
.ln-pricing-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem;align-items:stretch}
.ln-tariff{position:relative;background:rgba(255,255,255,.025);border:1px solid var(--edge);
  border-radius:16px;padding:2.1rem 1.7rem 1.7rem;display:flex;flex-direction:column;gap:.8rem;
  backdrop-filter:blur(12px);transition:all .28s ease;box-shadow:0 14px 40px rgba(0,0,0,.22)}
.ln-tariff:hover{transform:translateY(-4px);border-color:var(--smoke);background:rgba(255,255,255,.045)}
.ln-tariff.featured{
  border-color:rgba(201,168,76,.45);
  background:linear-gradient(160deg,rgba(201,168,76,.09) 0%,rgba(255,255,255,.025) 60%);
  box-shadow:0 18px 50px rgba(0,0,0,.3),0 0 50px rgba(201,168,76,.1)
}
.ln-tariff.featured:hover{border-color:rgba(201,168,76,.65);transform:translateY(-5px);
  box-shadow:0 24px 64px rgba(0,0,0,.36),0 0 64px rgba(201,168,76,.18)}
.ln-tariff-badge{position:absolute;top:-12px;right:20px;font-family:var(--mono);font-size:.58rem;
  font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  padding:5px 14px;border-radius:100px;box-shadow:0 6px 18px rgba(201,168,76,.42)}
.ln-tariff-name{font-family:var(--display);font-size:1.12rem;font-weight:700;color:var(--txt)}
.ln-tariff-price{font-family:var(--display);font-size:2.35rem;font-weight:700;letter-spacing:-.03em;
  color:var(--txt);line-height:1;display:flex;align-items:baseline;gap:.3rem}
.ln-tariff-price em{font-style:normal;color:var(--gold)}
.ln-tariff-price .per{font-family:var(--mono);font-size:.72rem;color:var(--txt3);font-weight:400;letter-spacing:.04em}
.ln-tariff-period{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;
  letter-spacing:.12em;color:var(--txt3);margin-top:-.2rem}
.ln-tariff-list{padding:.2rem 0;margin:.4rem 0;display:flex;flex-direction:column;gap:.55rem;flex:1}
.ln-tariff-list li{font-size:.84rem;color:var(--txt2);display:flex;gap:.6rem;
  line-height:1.45;font-weight:300}
.ln-tariff-list li::before{content:"";flex-shrink:0;margin-top:.45rem;width:5px;height:5px;
  border-radius:50%;background:var(--gold);box-shadow:0 0 7px rgba(201,168,76,.6)}
.ln-tariff-btn{font-family:var(--sans);font-size:.88rem;font-weight:600;background:transparent;
  border:1px solid var(--edge2);color:var(--txt);padding:12px 16px;border-radius:10px;cursor:pointer;
  transition:all .22s ease;margin-top:auto;text-align:center;text-decoration:none;display:inline-block}
.ln-tariff-btn:hover{border-color:var(--gold);color:var(--gold2);background:var(--gold-bg);
  transform:translateY(-1px)}
.ln-tariff-btn.primary{background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border:none;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.ln-tariff-btn.primary:hover{transform:translateY(-2px);box-shadow:0 16px 40px rgba(201,168,76,.42);
  color:var(--void)}

/* ====== FINAL CTA ====== */
.ln-final{padding:5rem 0 6rem;text-align:center}
.ln-final-card{background:linear-gradient(155deg,rgba(201,168,76,.11) 0%,rgba(255,255,255,.025) 70%);
  border:1px solid rgba(201,168,76,.32);border-radius:22px;padding:3.6rem 2.5rem;
  backdrop-filter:blur(16px);box-shadow:0 26px 70px rgba(0,0,0,.32),0 0 70px rgba(201,168,76,.08);
  max-width:840px;margin:0 auto;position:relative;overflow:hidden}
.ln-final-card::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(500px 300px at 50% -10%, rgba(201,168,76,.15), transparent 60%)}
.ln-final-card > *{position:relative}

/* ====== FOOTER ====== */
.ln-footer{border-top:1px solid var(--edge);padding:2.4rem 0;background:rgba(6,9,20,.55);
  backdrop-filter:blur(14px);margin-top:1rem}
.ln-footer-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem}
.ln-foot-brand{font-family:var(--display);font-size:.95rem;font-weight:700;color:var(--txt2)}
.ln-foot-brand em{font-style:italic;color:var(--gold)}
.ln-foot-c{font-family:var(--mono);font-size:.7rem;color:var(--txt3);letter-spacing:.06em}
.ln-foot-links{display:flex;gap:1.4rem}
.ln-foot-link{font-size:.8rem;color:var(--txt2);transition:color .18s ease}
.ln-foot-link:hover{color:var(--gold2)}

/* ====== RESPONSIVE ====== */
@media(max-width:980px){
  .ln-feat-grid{grid-template-columns:repeat(2,1fr)}
  .ln-how-grid{grid-template-columns:1fr}
  .ln-pricing-grid{grid-template-columns:1fr}
  .ln-hero{padding:4.5rem 0 3rem}
  .ln-section{padding:4rem 0}
}
@media(max-width:640px){
  .ln-nav{padding:.9rem 1.2rem}
  .ln-wrap{padding:0 1.2rem}
  .ln-brand-sub{display:none}
  .ln-nav-links{gap:.8rem}
  .ln-nav-link{display:none}
  .ln-feat-grid{grid-template-columns:1fr}
  .ln-hero-stats{grid-template-columns:1fr;gap:.7rem;max-width:340px}
  .ln-cta-row{flex-direction:column;align-items:stretch}
  .ln-btn{justify-content:center;width:100%}
  .ln-final-card{padding:2.5rem 1.5rem}
  .ln-footer-row{flex-direction:column;text-align:center}
  .ln-foot-links{justify-content:center;flex-wrap:wrap}
  .ln-tariff{padding:1.7rem 1.4rem 1.4rem}
}
      `}</style>

      {/* ====== NAV ====== */}
      <nav className="ln-nav">
        <a href="/" className="ln-brand">
          M&#8209;<em>Prof</em>
          <span className="ln-brand-sub">Аналитика прибыли</span>
        </a>
        <div className="ln-nav-links">
          <a href="#features" className="ln-nav-link">Возможности</a>
          <a href="#how" className="ln-nav-link">Как работает</a>
          <a href="#pricing" className="ln-nav-link">Тарифы</a>
          <Link href="/app" className="ln-nav-cta">Открыть Dashboard</Link>
        </div>
      </nav>

      {/* ====== HERO ====== */}
      <section className="ln-hero">
        <div className="ln-wrap">
          <div className="ln-hero-inner">
            <div className="ln-eyebrow">
              <span className="dot" />
              Для продавцов Ozon и Wildberries
            </div>

            <h1 className="ln-h1">
              Считай <em>чистую прибыль</em> Ozon и Wildberries за 30 секунд
            </h1>

            <p className="ln-lead">
              M&#8209;Prof автоматически помогает продавцам маркетплейсов понимать
              реальную прибыль, маржу и расходы — без таблиц, формул и догадок.
            </p>

            <div className="ln-cta-row">
              <Link href="/app" className="ln-btn ln-btn-gold">
                Попробовать бесплатно
                <span className="arr">→</span>
              </Link>
              <Link href="/app" className="ln-btn ln-btn-ghost">
                Открыть Dashboard
              </Link>
            </div>

            <div className="ln-hero-stats">
              <div className="ln-stat">
                <div className="ln-stat-v">30 сек</div>
                <div className="ln-stat-l">Один расчёт</div>
              </div>
              <div className="ln-stat">
                <div className="ln-stat-v">2 МП</div>
                <div className="ln-stat-l">Ozon · Wildberries</div>
              </div>
              <div className="ln-stat">
                <div className="ln-stat-v">0 ₽</div>
                <div className="ln-stat-l">Первый расчёт</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====== FEATURES ====== */}
      <section className="ln-section" id="features">
        <div className="ln-wrap">
          <div className="ln-section-h">
            <div className="ln-section-eyebrow">Возможности</div>
            <h2 className="ln-h2">
              Всё, что нужно для <em>контроля прибыли</em>
            </h2>
            <p className="ln-section-sub">
              Считайте, сохраняйте и подключайте маркетплейсы — в одном тонком интерфейсе без лишних кликов.
            </p>
          </div>

          <div className="ln-feat-grid">
            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M7 14l4-4 3 3 5-6" />
                </svg>
              </div>
              <div className="ln-feat-title">Аналитика прибыли</div>
              <div className="ln-feat-text">
                Чистая прибыль, маржа и доля расходов рассчитываются мгновенно — с учётом комиссий, логистики и налогов.
              </div>
            </div>

            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div className="ln-feat-title">История расчётов</div>
              <div className="ln-feat-text">
                Все ваши расчёты сохраняются в облаке и доступны с любого устройства — с агрегированной статистикой.
              </div>
            </div>

            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 7V3M15 7V3" />
                  <rect x="6" y="7" width="12" height="6" rx="1.5" />
                  <path d="M12 13v4a3 3 0 0 0 3 3h2" />
                </svg>
              </div>
              <div className="ln-feat-title">API-интеграция</div>
              <div className="ln-feat-text">
                Подключите Ozon и Wildberries по API-ключам в личном кабинете и подтягивайте данные автоматически.
              </div>
            </div>

            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
                </svg>
              </div>
              <div className="ln-feat-title">Быстрые расчёты</div>
              <div className="ln-feat-text">
                Чистая прибыль за 30 секунд: введите данные — получите цифры. Без таблиц и сложных формул.
              </div>
            </div>

            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l2-5h14l2 5" />
                  <path d="M3 9v11h18V9" />
                  <path d="M3 9h18" />
                  <path d="M9 9v4a3 3 0 0 0 6 0V9" />
                </svg>
              </div>
              <div className="ln-feat-title">Поддержка Ozon и Wildberries</div>
              <div className="ln-feat-text">
                Учитываем особенности каждой площадки: комиссии, логистику, хранение, рекламу и возвраты.
              </div>
            </div>

            <div className="ln-feat">
              <div className="ln-feat-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M3 9h18" />
                  <circle cx="7" cy="6.6" r=".8" fill="currentColor" />
                  <circle cx="10" cy="6.6" r=".8" fill="currentColor" />
                </svg>
              </div>
              <div className="ln-feat-title">Тонкий интерфейс</div>
              <div className="ln-feat-text">
                Премиальный dark-UI, который удобно открывать каждый день — ничего лишнего, только цифры и решения.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====== HOW IT WORKS ====== */}
      <section className="ln-section" id="how">
        <div className="ln-wrap">
          <div className="ln-section-h">
            <div className="ln-section-eyebrow">Как это работает</div>
            <h2 className="ln-h2">
              Три шага до <em>чистой прибыли</em>
            </h2>
            <p className="ln-section-sub">
              От открытия страницы до сохранённого расчёта — меньше минуты.
            </p>
          </div>

          <div className="ln-how-grid">
            <div className="ln-step">
              <div className="ln-step-n">01</div>
              <div className="ln-step-t">Введите данные</div>
              <div className="ln-step-d">
                Выручка, комиссии, логистика, реклама, себестоимость, налог — по товару или периоду. Вручную или из API.
              </div>
            </div>

            <div className="ln-step">
              <div className="ln-step-n">02</div>
              <div className="ln-step-t">Получите чистую прибыль</div>
              <div className="ln-step-d">
                Сервис мгновенно считает чистую прибыль, маржинальность и долю расходов — с понятной разбивкой.
              </div>
            </div>

            <div className="ln-step">
              <div className="ln-step-n">03</div>
              <div className="ln-step-t">Сохраните расчёт</div>
              <div className="ln-step-d">
                Результат сохраняется в личный кабинет — можно сравнить с прошлыми расчётами и отследить динамику.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====== PRICING ====== */}
      <section className="ln-section" id="pricing">
        <div className="ln-wrap">
          <div className="ln-section-h">
            <div className="ln-section-eyebrow">Тарифы</div>
            <h2 className="ln-h2">
              Прозрачные тарифы, <em>без лишних переплат</em>
            </h2>
            <p className="ln-section-sub">
              Попробуйте первый расчёт бесплатно. Дальше — только то, что нужно вам.
            </p>
          </div>

          <div className="ln-pricing-grid">
            <div className="ln-tariff">
              <div className="ln-tariff-name">Старт</div>
              <div className="ln-tariff-price">Бесплатно</div>
              <div className="ln-tariff-period">Первый расчёт</div>
              <ul className="ln-tariff-list">
                <li>Один расчёт для оценки сервиса</li>
                <li>Все функции калькулятора</li>
                <li>Сохранение результата в историю</li>
              </ul>
              <Link href="/app" className="ln-tariff-btn">
                Попробовать
              </Link>
            </div>

            <div className="ln-tariff">
              <div className="ln-tariff-name">Разовый расчёт</div>
              <div className="ln-tariff-price">
                <em>149</em> ₽
              </div>
              <div className="ln-tariff-period">Один платёж</div>
              <ul className="ln-tariff-list">
                <li>Дополнительный расчёт по любому товару</li>
                <li>Без подписки и автосписаний</li>
                <li>Подходит, если расчёты нужны редко</li>
              </ul>
              <Link href="/app" className="ln-tariff-btn">
                Купить расчёт 149₽
              </Link>
            </div>

            <div className="ln-tariff featured">
              <span className="ln-tariff-badge">Выгодно</span>
              <div className="ln-tariff-name">Безлимит</div>
              <div className="ln-tariff-price">
                <em>449</em> ₽<span className="per">/мес</span>
              </div>
              <div className="ln-tariff-period">Подписка на 30 дней</div>
              <ul className="ln-tariff-list">
                <li>Неограниченное число расчётов в месяц</li>
                <li>Приоритетный доступ к новым функциям</li>
                <li>Полная история без ограничений</li>
              </ul>
              <Link href="/app" className="ln-tariff-btn primary">
                Оформить безлимит 449₽
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ====== FINAL CTA ====== */}
      <section className="ln-final">
        <div className="ln-wrap">
          <div className="ln-final-card">
            <h2 className="ln-h2">
              Посчитайте свою прибыль <em>прямо сейчас</em>
            </h2>
            <p className="ln-section-sub" style={{ marginBottom: "1.8rem", maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
              Первый расчёт бесплатно. Без обязательной регистрации и привязки карты.
            </p>
            <Link href="/app" className="ln-btn ln-btn-gold">
              Попробовать бесплатно
              <span className="arr">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ====== FOOTER ====== */}
      <footer className="ln-footer">
        <div className="ln-wrap ln-footer-row">
          <div className="ln-foot-brand">
            M&#8209;<em>Prof</em>
          </div>
          <div className="ln-foot-c">M&#8209;Prof © 2026</div>
          <div className="ln-foot-links">
            <Link href="/app" className="ln-foot-link">Dashboard</Link>
            <a href="#features" className="ln-foot-link">Возможности</a>
            <a href="#pricing" className="ln-foot-link">Тарифы</a>
          </div>
        </div>
      </footer>
    </>
  );
}
