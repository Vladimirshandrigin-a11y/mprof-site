"use client";
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      persistSession: false,
    },
  }
)
import { useEffect, useState } from "react";

type Marketplace = "ozon" | "wb";

interface CalcResult {
  id: number;
  marketplace: Marketplace;
  revenue: number;
  commission: number;
  logistics: number;
  storage: number;
  ads: number;
  cost: number;
  tax: number;
  other: number;
  expenses: number;
  profit: number;
  margin: number;
  date: string;
}


const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "revenue", label: "Выручка", hint: "Сумма продаж за период" },
  { key: "commission", label: "Комиссия маркетплейса" },
  { key: "logistics", label: "Логистика" },
  { key: "storage", label: "Хранение" },
  { key: "ads", label: "Реклама" },
  { key: "cost", label: "Себестоимость" },
  { key: "tax", label: "Налог" },
  { key: "other", label: "Прочие расходы" },
];

const EMPTY: Record<string, string> = {
  revenue: "",
  commission: "",
  logistics: "",
  storage: "",
  ads: "",
  cost: "",
  tax: "",
  other: "",
};

export default function AppPage() {
  const [marketplace, setMarketplace] = useState<Marketplace>("ozon");
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const [result, setResult] = useState<CalcResult | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [history, setHistory] = useState<CalcResult[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const totalRevenue = history.reduce((sum, h) => sum + h.revenue, 0);
const totalProfit = history.reduce((sum, h) => sum + h.profit, 0);
const avgMargin =
  history.length > 0
    ? history.reduce((sum, h) => sum + h.margin, 0) / history.length
    : 0;
useEffect(() => {
  loadHistory()
}, [])
const clearHistory = async () => {
  const ok = confirm("Удалить всю историю?")

  if (!ok) return

  setHistory([])
  setSelectedId(null)

  await supabase
    .from("calculations")
    .delete()
    .neq("id", "")
}

const deleteHistoryItem = async (id: number) => {
  const { error } = await supabase
    .from("calculations")
    .delete()
    .eq("id", id)

  if (error) {
    console.error(error)
    return
  }

  setHistory(prev => prev.filter(h => h.id !== id))

  if (selectedId === id) {
    setSelectedId(null)
  }
}
const loadHistory = async () => {
  
  const { data, error } = await supabase
    .from("calculations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(8)

  if (error) {
  console.error(error)
  setIsLoadingHistory(false)
  return
}

  const mapped: CalcResult[] = data.map((item: any) => ({
    id: item.id,
    marketplace: item.marketplace,
    revenue: item.revenue,
    commission: item.commission,
logistics: item.logistics,
storage: item.storage,
ads: item.ads,
cost: item.cost_price,
tax: item.tax,
other: item.other_expenses,
    expenses: item.total_expenses,
    profit: item.profit,
    margin: item.margin,
    date: new Date(item.created_at).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  }))

  setHistory(mapped)
  setIsLoadingHistory(false)
}
  const num = (v: string) => {
    const n = parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  const fmt = (n: number) =>
    n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });

  const handleField = (key: string, value: string) => {
    if (value !== "" && !/^-?\d*[.,]?\d*$/.test(value)) return;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const calculate = async () => {
    const revenue = num(form.revenue);
    const expenses =
      num(form.commission) +
      num(form.logistics) +
      num(form.storage) +
      num(form.ads) +
      num(form.cost) +
      num(form.tax) +
      num(form.other);
    const profit = revenue - expenses;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    const res: CalcResult = {
      
      id: Date.now(),
      marketplace,
      revenue,
      commission: num(form.commission),
      logistics: num(form.logistics),
      storage: num(form.storage),
      ads: num(form.ads),
      cost: num(form.cost),
      tax: num(form.tax),
      other: num(form.other),
      expenses,
      profit,
      margin,
      date: new Date().toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    const { error } = await supabase.from("calculations").insert([
  {
    marketplace,
    revenue,
    commission: num(form.commission),
    logistics: num(form.logistics),
    storage: num(form.storage),
    ads: num(form.ads),
    cost_price: num(form.cost),
    tax: num(form.tax),
    other_expenses: num(form.other),
    total_expenses: expenses,
    profit,
    margin,
  },
])

if (error) {
  alert(error.message)
  console.error("Supabase save error:", error)
}
    setResult(res);
    setHistory((prev) => [res, ...prev].slice(0, 8));
  };

  const clearForm = () => {
  setForm({ ...EMPTY });
  setResult(null);

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
};

  return (
    <>
      <style jsx global>{`
@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap");
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
*{box-sizing:border-box}
body{margin:0;background:var(--void);color:var(--txt);font-family:var(--sans);line-height:1.6;
  background-image:radial-gradient(900px 500px at 85% -5%,rgba(201,168,76,.10),transparent 60%),
  radial-gradient(700px 500px at -10% 110%,rgba(201,168,76,.05),transparent 60%);
  background-attachment:fixed;min-height:100vh}

.dash-top{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  padding:1rem 2rem;background:rgba(8,10,20,.75);backdrop-filter:blur(18px) saturate(1.3);
  border-bottom:1px solid var(--edge)}
.dash-brand{font-family:var(--display);font-size:1.15rem;font-weight:700;letter-spacing:.01em;color:var(--txt);text-decoration:none}
.dash-brand em{font-style:italic;color:var(--gold)}
.dash-brand-sub{font-family:var(--mono);font-size:.58rem;color:var(--txt3);letter-spacing:.14em;text-transform:uppercase;margin-left:10px;vertical-align:middle}
.dash-status{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.66rem;
  color:var(--gold2);letter-spacing:.06em;border:1px solid rgba(201,168,76,.3);
  padding:6px 16px;border-radius:100px;background:var(--gold-bg)}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--gold);
  animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.6)}}

.dash-wrap{max-width:1100px;margin:0 auto;padding:2.5rem 2rem 5rem}
.dash-h1{font-family:var(--display);font-size:clamp(1.8rem,3vw,2.4rem);font-weight:700;letter-spacing:-.02em;margin:0 0 .4rem}
.dash-h1 em{font-style:italic;color:var(--gold)}
.dash-lead{color:var(--txt2);font-size:.92rem;font-weight:300;margin-bottom:2rem}

.dash-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:1.25rem;align-items:start}

.card{background:var(--glass);border:1px solid var(--edge);border-radius:14px;
  backdrop-filter:blur(10px);box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;
  padding:1.1rem 1.5rem;border-bottom:1px solid var(--edge)}
.card-title{font-family:var(--display);font-size:.95rem;font-weight:700;color:var(--txt)}
.card-body{padding:1.5rem}

.mp-row{display:flex;gap:8px;margin-bottom:1.5rem}
.mp-tab{flex:1;font-family:var(--sans);font-size:.85rem;font-weight:600;padding:11px;border-radius:9px;
  cursor:pointer;letter-spacing:.02em;border:1px solid var(--edge2);background:transparent;
  color:var(--txt2);transition:all .18s;text-align:center}
.mp-tab:hover{border-color:var(--smoke);color:var(--txt)}
.mp-tab.act-ozon{border-color:#3d7bff;color:#7fb0ff;background:rgba(61,123,255,.1)}
.mp-tab.act-wb{border-color:#cb11ab;color:#e878d6;background:rgba(203,17,171,.1)}

.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.fld{display:flex;flex-direction:column;gap:5px}
.fld label{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3)}
.fld .rev-badge{color:var(--gold)}
.in-wrap{position:relative;display:flex;align-items:center}
.in-wrap input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);border-radius:8px;
  color:var(--txt);font-family:var(--mono);font-size:.92rem;padding:11px 32px 11px 12px;outline:none;transition:border .18s}
.in-wrap input:focus{border-color:var(--gold)}
.in-wrap input::placeholder{color:var(--txt3)}
.in-cur{position:absolute;right:12px;font-family:var(--mono);font-size:.8rem;color:var(--txt3);pointer-events:none}
.fld-hint{font-size:.62rem;color:var(--txt3);font-weight:300}

.btn-row{display:flex;gap:10px;margin-top:1.5rem}
.btn-gold{flex:1;font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:13px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.btn-gold:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.btn-ghost{font-family:var(--sans);font-size:.85rem;font-weight:500;background:transparent;
  border:1px solid var(--edge2);color:var(--txt2);padding:13px 20px;border-radius:9px;cursor:pointer;transition:all .18s}
.btn-ghost:hover{border-color:var(--gold);color:var(--gold2)}

.result-card{background:linear-gradient(135deg,var(--panel) 0%,rgba(201,168,76,.05) 100%);
  border:1px solid rgba(201,168,76,.3);border-radius:14px;overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 50px rgba(201,168,76,.06)}
.result-card .card-head{border-bottom-color:rgba(201,168,76,.18)}
.res-hero{padding:1.5rem;text-align:center;border-bottom:1px solid var(--edge)}
.res-hero-lbl{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);margin-bottom:.5rem}
.res-hero-val{font-family:var(--display);font-size:2.6rem;font-weight:700;letter-spacing:-.03em;line-height:1}
.res-hero-val.pos{color:var(--green)}
.res-hero-val.neg{color:var(--red)}
.res-margin{display:inline-block;margin-top:.7rem;font-family:var(--mono);font-size:.75rem;
  padding:4px 14px;border-radius:100px;border:1px solid}
.res-margin.pos{color:var(--green);border-color:rgba(46,204,138,.3);background:rgba(46,204,138,.08)}
.res-margin.neg{color:var(--red);border-color:rgba(224,85,102,.3);background:rgba(224,85,102,.08)}
.res-rows{padding:1.2rem 1.5rem}
.res-row{display:flex;justify-content:space-between;align-items:center;padding:.6rem 0;
  border-bottom:1px solid var(--edge);font-size:.85rem}
.res-row:last-child{border-bottom:none}
.res-row .rl{color:var(--txt2)}
.res-row .rv{font-family:var(--mono);font-weight:500;color:var(--txt)}
.res-row .rv.neg{color:var(--red)}

.empty-res{padding:3rem 1.5rem;text-align:center;color:var(--txt3)}
.empty-icon{font-size:2rem;opacity:.4;margin-bottom:.7rem;display:block}
.empty-title{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt2);margin-bottom:.3rem}
.empty-sub{font-size:.8rem;font-weight:300}

.hist-card{margin-top:1.25rem}
.hist-list{display:flex;flex-direction:column}
.hist-item{
  display:flex;
  align-items:center;
  gap:1rem;
  padding:.85rem 1.5rem;
  border-bottom:1px solid var(--edge);
  cursor:pointer;
  transition:.2s ease;
}

.hist-item:hover{
  background:rgba(255,255,255,.03);
}
  .hist-item.active{
  background:rgba(255,255,255,.04);
  border-left:2px solid var(--accent);
}
.hist-item:last-child{border-bottom:none}
.hist-mp{font-family:var(--mono);font-size:.58rem;padding:3px 9px;border-radius:3px;border:1px solid;flex-shrink:0;letter-spacing:.06em}
.hist-mp.ozon{border-color:rgba(61,123,255,.35);color:#7fb0ff;background:rgba(61,123,255,.08)}
.hist-mp.wb{border-color:rgba(203,17,171,.35);color:#e878d6;background:rgba(203,17,171,.08)}
.hist-info{flex:1;min-width:0}
.hist-rev{font-size:.82rem;color:var(--txt);font-weight:500}
.hist-date{font-family:var(--mono);font-size:.62rem;color:var(--txt3);margin-top:1px}
.hist-profit{font-family:var(--display);font-size:1.05rem;font-weight:700;letter-spacing:-.02em;flex-shrink:0;text-align:right}
.hist-profit.pos{color:var(--green)}
.hist-profit.neg{color:var(--red)}
.hist-profit .hm{display:block;font-family:var(--mono);font-size:.6rem;font-weight:400;color:var(--txt3);letter-spacing:.04em}
.stats-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:1rem;
  margin-bottom:1.4rem;
}

.stat-card{
  background:var(--glass);
  border:1px solid var(--edge);
  border-radius:14px;
  padding:1rem 1.1rem;
  backdrop-filter:blur(10px);
  box-shadow:0 10px 30px rgba(0,0,0,.22);
}

.stat-label{
  font-family:var(--mono);
  font-size:.62rem;
  text-transform:uppercase;
  letter-spacing:.08em;
  color:var(--txt3);
  margin-bottom:.55rem;
}

.stat-value{
  font-family:var(--display);
  font-size:1.5rem;
  font-weight:700;
  letter-spacing:-.03em;
  color:var(--txt);
}

.stat-value.pos{
  color:var(--green);
}

.stat-value.neg{
  color:var(--red);
}
@media(max-width:900px){
  .dash-top{padding:.85rem 1.2rem}
  .dash-brand-sub{display:none}
  .dash-status{font-size:.6rem;padding:5px 12px}
  .dash-wrap{padding:1.8rem 1.2rem 4rem}
  .dash-grid{grid-template-columns:1fr}
}
@media(max-width:480px){
  .form-grid{grid-template-columns:1fr}
  .btn-row{flex-direction:column}
  .res-hero-val{font-size:2.1rem}
}
      `}</style>

      <div className="dash-top">
        <a href="/" className="dash-brand">
          M&#8209;<em>Prof</em>
          <span className="dash-brand-sub">Dashboard</span>
        </a>
        <div className="dash-status">
          <span className="status-dot"></span>
          Первый расчёт бесплатно
        </div>
      </div>

      <div className="dash-wrap">
        <h1 className="dash-h1">
          Новый <em>расчёт</em>
        </h1>
        <p className="dash-lead">
          Введите данные по товару или периоду — посчитаем чистую прибыль и маржинальность.
        </p>
<div className="stats-grid">
  <div className="stat-card">
    <div className="stat-label">Общая выручка</div>
    <div className="stat-value">
      {fmt(totalRevenue)} ₽
    </div>
  </div>

  <div className="stat-card">
    <div className="stat-label">Общая прибыль</div>
    <div
      className={
        "stat-value " + (totalProfit >= 0 ? "pos" : "neg")
      }
    >
      {totalProfit >= 0 ? "+" : "−"}
      {fmt(Math.abs(totalProfit))} ₽
    </div>
  </div>

  <div className="stat-card">
    <div className="stat-label">Средняя маржа</div>
    <div className="stat-value">
      {avgMargin.toFixed(1)}%
    </div>
  </div>

  <div className="stat-card">
    <div className="stat-label">Всего расчётов</div>
    <div className="stat-value">
      {history.length}
    </div>
  </div>
</div>
        <div className="dash-grid">
          <div className="card">
            <div className="card-head">
              <div className="card-title">Параметры расчёта</div>
            </div>
            <div className="card-body">
              <div className="mp-row">
                <div
                  className={"mp-tab" + (marketplace === "ozon" ? " act-ozon" : "")}
                  onClick={() => setMarketplace("ozon")}
                >
                  Ozon
                </div>
                <div
                  className={"mp-tab" + (marketplace === "wb" ? " act-wb" : "")}
                  onClick={() => setMarketplace("wb")}
                >
                  Wildberries
                </div>
              </div>

              <div className="form-grid">
                {FIELDS.map((f) => (
                  <div className="fld" key={f.key}>
                    <label>
                      {f.label}
                      {f.key === "revenue" && <span className="rev-badge"> ●</span>}
                    </label>
                    <div className="in-wrap">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={form[f.key]}
                        onChange={(e) => handleField(f.key, e.target.value)}
                      />
                      <span className="in-cur">₽</span>
                    </div>
                    {f.hint && <span className="fld-hint">{f.hint}</span>}
                  </div>
                ))}
              </div>

              <div className="btn-row">
                <button className="btn-gold" onClick={calculate}>
                  Рассчитать чистую прибыль
                </button>
                <button className="btn-ghost" onClick={clearForm}>
                  Очистить форму
                </button>
              </div>
            </div>
          </div>

          <div className="result-card">
            <div className="card-head">
              <div className="card-title">Результат</div>
            </div>
            {result ? (
              
              <>
                <div className="res-hero">
                  <div className="res-hero-lbl">Чистая прибыль</div>
                  <div className={"res-hero-val " + (result.profit >= 0 ? "pos" : "neg")}>
                    {result.profit >= 0 ? "+" : "−"}
                    {fmt(Math.abs(result.profit))} ₽
                  </div>
                  <div className={"res-margin " + (result.margin >= 0 ? "pos" : "neg")}>
                    Маржинальность {result.margin.toFixed(1)}%
                  </div>
                </div>
                <div className="res-rows">
                  <div className="res-row">
                    <span className="rl">Выручка</span>
                    <span className="rv">{fmt(result.revenue)} ₽</span>
                  </div>
                  <div className="res-row">
                    <span className="rl">Сумма расходов</span>
                    <span className="rv neg">− {fmt(result.expenses)} ₽</span>
                  </div>
                  <div className="res-row">
                    <span className="rl">Чистая прибыль</span>
                    <span className="rv">
                      {result.profit >= 0 ? "+" : "−"}
                      {fmt(Math.abs(result.profit))} ₽
                    </span>
                  </div>
                  <div className="res-row">
                    <span className="rl">Маржинальность</span>
                    <span className="rv">{result.margin.toFixed(1)}%</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-res">
                <span className="empty-icon">◇</span>
                <div className="empty-title">Результат появится здесь</div>
                <div className="empty-sub">
                  Заполните поля слева и нажмите «Рассчитать»
                </div>
              </div>
            )}
          </div>
        </div>

        {isLoadingHistory && (
  <div className="card hist-card">
    <div className="card-head">
      <div className="card-title">Последние расчёты</div>
    </div>

    <div className="card-body">
      Загрузка истории...
    </div>
  </div>
  )}





 {!isLoadingHistory && history.length > 0 && (
  <div className="card hist-card">
    <div className="card-head">
  <div className="card-title">Последние расчёты</div>
  <button
  onClick={clearHistory}
  style={{
    boxShadow: "0 0 22px rgba(246,200,107,.22), inset 0 1px 0 rgba(255,255,255,.12)",
backdropFilter: "blur(10px)",
    all: "unset",
    height: "42px",
    padding: "0 18px",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.035))",
    color: "#f6c86b",
    textShadow: "0 0 10px rgba(246,200,107,.25)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 700,
    transition: "all .2s ease",
  }}
>
  Очистить историю
</button>
  
</div>

    <div className="hist-list">
      {history.map((h) => (
        <div
          className={`hist-item ${selectedId === h.id ? "active" : ""}`}
          key={h.id}
          onClick={() => {
            setMarketplace(h.marketplace)
            setForm({
              revenue: String(h.revenue),
              commission: String(h.commission),
              logistics: String(h.logistics),
              storage: String(h.storage),
              ads: String(h.ads),
              cost: String(h.cost),
              tax: String(h.tax),
              other: String(h.other),
            })
            setResult(h)
            setSelectedId(h.id)
          }}
        >
          <div className={"hist-mp " + h.marketplace}>
            {h.marketplace === "ozon" ? "Ozon" : "WB"}
          </div>

          <div className="hist-info">
            <div className="hist-rev">Выручка {fmt(h.revenue)} ₽</div>
            <div className="hist-date">{h.date}</div>
          </div>

          <div className={"hist-profit " + (h.profit >= 0 ? "pos" : "neg")}>
            {h.profit >= 0 ? "+" : "-"}
            {fmt(Math.abs(h.profit))} ₽
            <span className="hm">маржа {h.margin.toFixed(1)}%</span>
          </div>

          <button
  type="button"
  className="hist-del"
  onClick={(e) => {
  e.stopPropagation()

  const ok = confirm("Удалить этот расчёт?")

  if (ok) {
    deleteHistoryItem(h.id)
  }
}}
  style={{
    width: "32px",
    height: "32px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#c9a34f",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: "16px",
    transition: "0.2s ease",
  }}
>
  ✕
</button>
        </div>
      ))}
    </div>
  </div>
)}
</div>
</>
)
}