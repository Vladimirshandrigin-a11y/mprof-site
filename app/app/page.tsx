"use client";

import { createClient } from "@supabase/supabase-js"
import { useEffect, useState } from "react"

import type { User } from "@supabase/supabase-js"
import { StatsCards } from "./components/StatsCards"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  {
    auth: {
      persistSession: false,
    },
  }
)

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

const eyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 12s4-7.5 10.5-7.5S22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const eyeOffIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.9 5.1A11.7 11.7 0 0 1 12 4.5C18.5 4.5 22.5 12 22.5 12a18 18 0 0 1-3.3 4.3M6.3 6.3A18 18 0 0 0 1.5 12s4 7.5 10.5 7.5a11.7 11.7 0 0 0 4.8-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
);

export default function AppPage() {
  const [marketplace, setMarketplace] = useState<Marketplace>("ozon");
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const [result, setResult] = useState<CalcResult | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<CalcResult[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [ozonClientId, setOzonClientId] = useState("");
  const [ozonApiKey, setOzonApiKey] = useState("");
  const [wbApiKey, setWbApiKey] = useState("");
  const [apiSaveStatus, setApiSaveStatus] = useState<"idle" | "ok" | "err" | "saving">("idle");
  const [apiSaveMessage, setApiSaveMessage] = useState("");
  const [showOzonKey, setShowOzonKey] = useState(false);
  const [showWbKey, setShowWbKey] = useState(false);
  const [tariffMessage, setTariffMessage] = useState("");
  const [calcMode, setCalcMode] = useState<"manual" | "api">("manual");

  const totalRevenue = history.reduce((sum, h) => sum + h.revenue, 0);
  const totalProfit = history.reduce((sum, h) => sum + h.profit, 0);
  const avgMargin =
    history.length > 0
      ? history.reduce((sum, h) => sum + h.margin, 0) / history.length
      : 0;

  // Получаем пользователя, затем сразу грузим его историю и API-ключи
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      loadHistory(data.user?.id ?? null);
      if (data.user?.id) {
        loadApiKeys(data.user.id);
      }
    });
  }, []);

  const signIn = async () => {
    if (!email.trim()) {
      setAuthMessage("Введите email");
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: "http://localhost:3000/app",
      },
    });

    if (error) {
      setAuthMessage(error.message);
    } else {
      setAuthMessage("Письмо для входа отправлено на email");
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setHistory([]);
    setResult(null);
    setOzonClientId("");
    setOzonApiKey("");
    setWbApiKey("");
    setApiSaveMessage("");
    setApiSaveStatus("idle");
  };

  const loadApiKeys = async (userId: string) => {
    const { data, error } = await supabase
      .from("api_keys")
      .select("ozon_client_id, ozon_api_key, wb_api_key")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("loadApiKeys error:", error);
      return;
    }

    if (data) {
      setOzonClientId(data.ozon_client_id ?? "");
      setOzonApiKey(data.ozon_api_key ?? "");
      setWbApiKey(data.wb_api_key ?? "");
    }
  };

  const saveApiKeys = async () => {
    if (!user?.id) {
      setApiSaveStatus("err");
      setApiSaveMessage("Войдите в аккаунт, чтобы сохранить ключи");
      return;
    }

    setApiSaveStatus("saving");
    setApiSaveMessage("");

    const { error } = await supabase
      .from("api_keys")
      .upsert(
        [
          {
            user_id: user.id,
            ozon_client_id: ozonClientId.trim() || null,
            ozon_api_key: ozonApiKey.trim() || null,
            wb_api_key: wbApiKey.trim() || null,
          },
        ],
        { onConflict: "user_id" }
      );

    if (error) {
      console.error("saveApiKeys error:", error);
      setApiSaveStatus("err");
      setApiSaveMessage("Ошибка: " + error.message);
      return;
    }

    setApiSaveStatus("ok");
    setApiSaveMessage("Ключи сохранены");
  };

  const clearHistory = async () => {
    const ok = confirm("Удалить всю историю?");
    if (!ok) return;

    setHistory([]);
    setSelectedId(null);

    if (user?.id) {
      await supabase.from("calculations").delete().eq("user_id", user.id);
    } else {
      await supabase.from("calculations").delete().is("user_id", null);
    }
  };

  const deleteHistoryItem = async (id: number) => {
    const { error } = await supabase
      .from("calculations")
      .delete()
      .eq("id", id);

    if (error) {
      console.error(error);
      return;
    }

    setHistory(prev => prev.filter(h => h.id !== id));

    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  const loadHistory = async (userId: string | null) => {
    let query = supabase
      .from("calculations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(8);

    if (userId) {
      query = query.eq("user_id", userId);
    } else {
      query = query.is("user_id", null);
    }

    const { data, error } = await query;

    if (error) {
      console.error(error);
      setIsLoadingHistory(false);
      return;
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
    }));

    setHistory(mapped);
    setIsLoadingHistory(false);
  };

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
        user_id: user?.id ?? null,
      },
    ]);

    if (error) {
      alert(error.message);
      console.error("Supabase save error:", error);
    }

    setResult(res);
    setHistory((prev) => [res, ...prev].slice(0, 8));
  };

  const handleTariff = (tier: "single" | "unlimited") => {
    setTariffMessage(
      tier === "single"
        ? "Оплата разового расчёта скоро будет доступна"
        : "Оформление безлимита скоро будет доступно"
    );
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

.dash-user{display:inline-flex;align-items:center;gap:10px}
.dash-user-email{font-family:var(--mono);font-size:.63rem;color:var(--txt2);letter-spacing:.04em;
  max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-signout{font-family:var(--sans);font-size:.75rem;font-weight:500;background:transparent;
  border:1px solid var(--edge2);color:var(--txt2);padding:5px 13px;border-radius:8px;
  cursor:pointer;transition:all .18s;line-height:1}
.dash-signout:hover{border-color:rgba(224,85,102,.4);color:var(--red)}

.auth-card{margin-bottom:1.4rem;padding:1.4rem 1.5rem}
.auth-title{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);margin:0 0 .9rem}
.auth-row{display:flex;gap:10px;align-items:stretch}
.auth-input{flex:1;width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);
  border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:.92rem;padding:12px 14px;
  outline:none;transition:border .18s,box-shadow .18s,background .18s;
  -webkit-text-fill-color:var(--txt);caret-color:var(--gold);
  appearance:none;-webkit-appearance:none}
.auth-input::placeholder{color:var(--txt3);opacity:1}
.auth-input::-webkit-input-placeholder{color:var(--txt3)}
.auth-input:hover{border-color:var(--smoke)}
.auth-input:focus,
.auth-input:focus-visible,
.auth-input:active{
  background:rgba(255,255,255,.04);
  border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(201,168,76,.18);
  color:var(--txt);
  -webkit-text-fill-color:var(--txt);
  outline:none
}
.auth-input:-webkit-autofill,
.auth-input:-webkit-autofill:hover,
.auth-input:-webkit-autofill:focus,
.auth-input:-webkit-autofill:active{
  -webkit-text-fill-color:var(--txt) !important;
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset !important;
  box-shadow:0 0 0 1000px #0d1020 inset !important;
  caret-color:var(--gold) !important;
  border:1px solid var(--edge2);
  transition:background-color 9999s ease-out 0s,color 9999s ease-out 0s
}
.auth-input:-webkit-autofill:focus{
  border-color:var(--gold);
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset,0 0 0 3px rgba(201,168,76,.18) !important;
  box-shadow:0 0 0 1000px #0d1020 inset,0 0 0 3px rgba(201,168,76,.18) !important
}
.auth-btn{font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:0 22px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28);white-space:nowrap}
.auth-btn:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.auth-msg{margin:.8rem 0 0;font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em}
@media(max-width:480px){.auth-row{flex-direction:column}.auth-btn{padding:13px}}

.api-card{margin-top:1.25rem}
.api-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
.api-fld{display:flex;flex-direction:column;gap:6px}
.api-fld.api-fld-full{grid-column:1 / -1}
.api-fld label{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;color:var(--txt3)}
.api-fld .api-hint{font-size:.62rem;color:var(--txt3);font-weight:300}
.api-input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--edge2);border-radius:8px;
  color:var(--txt);font-family:var(--mono);font-size:.88rem;padding:11px 12px;outline:none;
  transition:border .18s,box-shadow .18s,background .18s;
  -webkit-text-fill-color:var(--txt);caret-color:var(--gold);
  appearance:none;-webkit-appearance:none}
.api-input::placeholder{color:var(--txt3);opacity:1}
.api-input::-webkit-input-placeholder{color:var(--txt3)}
.api-input:hover{border-color:var(--smoke)}
.api-input:focus,
.api-input:focus-visible{
  background:rgba(255,255,255,.04);
  border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(201,168,76,.18);
  color:var(--txt);
  -webkit-text-fill-color:var(--txt);
  outline:none
}
.api-input:-webkit-autofill,
.api-input:-webkit-autofill:hover,
.api-input:-webkit-autofill:focus{
  -webkit-text-fill-color:var(--txt) !important;
  -webkit-box-shadow:0 0 0 1000px #0d1020 inset !important;
  caret-color:var(--gold) !important;
  transition:background-color 9999s ease-out 0s
}
.api-secret{position:relative}
.api-secret .api-input{padding-right:44px;font-family:var(--mono);letter-spacing:.04em}
.api-eye{position:absolute;top:50%;right:6px;transform:translateY(-50%);
  width:32px;height:32px;border-radius:7px;border:1px solid transparent;background:transparent;
  color:var(--txt3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  padding:0;transition:all .18s}
.api-eye:hover{color:var(--gold2);border-color:var(--edge2);background:rgba(255,255,255,.04)}
.api-eye:focus-visible{outline:none;color:var(--gold2);border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.18)}
.api-eye svg{width:16px;height:16px;display:block}
.api-foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;
  margin-top:1.4rem;flex-wrap:wrap}
.api-msg{font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em;margin:0;flex:1;min-width:0}
.api-msg.ok{color:var(--green)}
.api-msg.err{color:var(--red)}
.api-save{font-family:var(--sans);font-size:.9rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:12px 24px;border:none;border-radius:9px;cursor:pointer;letter-spacing:.02em;
  transition:all .18s;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.api-save:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38)}
.api-save:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none}
.api-locked{padding:2.2rem 1.5rem;text-align:center;color:var(--txt3)}
.api-locked-icon{font-size:1.6rem;opacity:.4;margin-bottom:.6rem;display:block}
.api-locked-title{font-family:var(--display);font-size:1rem;font-weight:700;color:var(--txt2);margin-bottom:.3rem}
.api-locked-sub{font-size:.8rem;font-weight:300}
@media(max-width:480px){
  .api-grid{grid-template-columns:1fr}
  .api-foot{flex-direction:column;align-items:stretch}
  .api-save{width:100%;padding:13px}
}

.calc-tabs{display:flex;gap:8px;background:var(--glass);border:1px solid var(--edge);
  border-radius:14px;padding:6px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  margin-bottom:1.25rem;box-shadow:0 14px 38px rgba(0,0,0,.22)}
.calc-tab{flex:1;font-family:var(--sans);font-size:.88rem;font-weight:600;padding:12px 16px;
  border-radius:10px;cursor:pointer;letter-spacing:.01em;border:1px solid transparent;
  background:transparent;color:var(--txt2);transition:all .22s ease;text-align:center;
  display:inline-flex;align-items:center;justify-content:center;gap:9px}
.calc-tab:hover{color:var(--txt);background:rgba(255,255,255,.03)}
.calc-tab.active{
  color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  box-shadow:0 8px 26px rgba(201,168,76,.3),inset 0 1px 0 rgba(255,255,255,.22)
}
.calc-tab-ico{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;opacity:.9}
.calc-tab-ico svg{width:16px;height:16px;display:block}
@media(max-width:640px){
  .calc-tabs{flex-direction:column;gap:6px}
  .calc-tab{padding:11px}
}

.api-pro-card{margin-bottom:.25rem;position:relative;overflow:hidden;
  box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 50px rgba(201,168,76,.06)}
.api-pro-card::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(520px 280px at 100% 0%, rgba(201,168,76,.10), transparent 60%);
  z-index:0}
.api-pro-card > *{position:relative;z-index:1}
.api-pro-head{padding:1.5rem 1.7rem 1.1rem;border-bottom:1px solid var(--edge)}
.api-pro-title{font-family:var(--display);font-size:1.15rem;font-weight:700;color:var(--txt);
  margin-bottom:.35rem;letter-spacing:-.005em}
.api-pro-sub{font-size:.85rem;color:var(--txt2);font-weight:300;line-height:1.5;margin:0}
.api-pro-body{padding:1.5rem 1.7rem 1.7rem}
.api-pro-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.api-pro-grid .api-fld.api-fld-full{grid-column:1 / -1}
.api-pro-foot{display:flex;align-items:center;gap:1rem;margin-top:1.6rem;flex-wrap:wrap}
.api-pro-btn{flex:1;min-width:240px;font-family:var(--sans);font-size:.95rem;font-weight:600;
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:var(--void);
  padding:14px 22px;border:none;border-radius:11px;cursor:pointer;letter-spacing:.01em;
  transition:all .22s ease;box-shadow:0 10px 30px rgba(201,168,76,.28);
  display:inline-flex;align-items:center;justify-content:center;gap:8px}
.api-pro-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 18px 44px rgba(201,168,76,.42)}
.api-pro-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;
  background:linear-gradient(135deg,rgba(58,74,96,.5) 0%,rgba(122,143,168,.4) 100%);
  color:var(--txt2);box-shadow:none}
.api-pro-btn.locked{cursor:not-allowed;opacity:.85;color:var(--txt);
  background:rgba(255,255,255,.04);border:1px dashed var(--edge2);box-shadow:none}
.api-pro-btn.locked:hover{transform:none;box-shadow:none}
.api-pro-msg{font-family:var(--mono);font-size:.72rem;color:var(--txt2);letter-spacing:.02em;
  margin:0;flex:1;min-width:0}
.api-pro-msg.ok{color:var(--green)}
.api-pro-msg.err{color:var(--red)}
.api-pro-hint{margin-top:1.2rem;padding:.9rem 1.1rem;background:var(--gold-bg);
  border:1px solid rgba(201,168,76,.18);border-radius:11px;font-size:.78rem;
  color:var(--txt2);font-weight:300;line-height:1.55;display:flex;gap:.7rem;align-items:flex-start}
.api-pro-hint-ico{color:var(--gold2);flex-shrink:0;margin-top:1px;display:inline-flex}
.api-pro-hint-ico svg{width:16px;height:16px;display:block}
.api-input:disabled,
.api-input:disabled:hover{opacity:.5;cursor:not-allowed;background:rgba(255,255,255,.02);
  border-color:var(--edge);box-shadow:none}
.api-eye:disabled{opacity:.35;cursor:not-allowed}
.api-eye:disabled:hover{color:var(--txt3);border-color:transparent;background:transparent}
@media(max-width:640px){
  .api-pro-head{padding:1.3rem 1.3rem 1rem}
  .api-pro-body{padding:1.3rem}
  .api-pro-grid{grid-template-columns:1fr;gap:.85rem}
  .api-pro-foot{flex-direction:column;align-items:stretch;gap:.8rem}
  .api-pro-btn{width:100%;min-width:0;padding:13px}
}

.tariff-card{margin-top:1.25rem}
.tariff-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;padding:1.5rem}
.tariff-item{position:relative;background:rgba(255,255,255,.025);border:1px solid var(--edge);
  border-radius:13px;padding:1.4rem 1.3rem;display:flex;flex-direction:column;gap:.7rem;
  transition:all .22s ease;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.tariff-item:hover{transform:translateY(-2px);border-color:var(--smoke);background:rgba(255,255,255,.04)}
.tariff-item.featured{
  border-color:rgba(201,168,76,.4);
  background:linear-gradient(150deg,rgba(201,168,76,.07) 0%,rgba(255,255,255,.025) 60%);
  box-shadow:0 14px 38px rgba(0,0,0,.3),0 0 38px rgba(201,168,76,.08)
}
.tariff-item.featured:hover{border-color:rgba(201,168,76,.6);box-shadow:0 18px 46px rgba(0,0,0,.32),0 0 50px rgba(201,168,76,.14)}
.tariff-badge{position:absolute;top:-10px;right:14px;font-family:var(--mono);font-size:.55rem;
  font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--void);
  background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  padding:4px 12px;border-radius:100px;box-shadow:0 4px 14px rgba(201,168,76,.35)}
.tariff-name{font-family:var(--display);font-size:1.05rem;font-weight:700;color:var(--txt);letter-spacing:-.005em}
.tariff-price{font-family:var(--display);font-size:2.1rem;font-weight:700;letter-spacing:-.03em;
  color:var(--txt);line-height:1;display:flex;align-items:baseline;gap:.25rem}
.tariff-price em{font-style:normal;color:var(--gold)}
.tariff-price .tariff-month{font-family:var(--mono);font-size:.7rem;font-weight:400;color:var(--txt3);letter-spacing:.04em}
.tariff-period{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;color:var(--txt3);margin-top:-.2rem}
.tariff-list{list-style:none;padding:0;margin:.5rem 0;display:flex;flex-direction:column;gap:.5rem;flex:1}
.tariff-list li{font-size:.81rem;color:var(--txt2);display:flex;gap:.55rem;line-height:1.45;font-weight:300}
.tariff-list li::before{content:"";flex-shrink:0;margin-top:.45rem;width:5px;height:5px;border-radius:50%;background:var(--gold);box-shadow:0 0 6px rgba(201,168,76,.6)}
.tariff-btn{font-family:var(--sans);font-size:.85rem;font-weight:600;background:transparent;
  border:1px solid var(--edge2);color:var(--txt);padding:11px 14px;border-radius:9px;cursor:pointer;
  transition:all .18s;margin-top:auto;letter-spacing:.01em}
.tariff-btn:hover{border-color:var(--gold);color:var(--gold2);background:var(--gold-bg)}
.tariff-btn.primary{background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);
  color:var(--void);border:none;box-shadow:0 8px 28px rgba(201,168,76,.28)}
.tariff-btn.primary:hover{transform:translateY(-1px);box-shadow:0 14px 38px rgba(201,168,76,.38);color:var(--void)}
.tariff-btn:disabled{opacity:.45;cursor:not-allowed;border-style:dashed}
.tariff-btn:disabled:hover{border-color:var(--edge2);color:var(--txt);background:transparent}
.tariff-msg{font-family:var(--mono);font-size:.72rem;color:var(--gold2);letter-spacing:.03em;
  text-align:center;margin:0;padding:0 1.5rem 1.4rem}
@media(max-width:900px){
  .tariff-grid{grid-template-columns:1fr;gap:.85rem;padding:1.2rem}
  .tariff-item{padding:1.2rem 1.2rem}
}

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
.hist-del{flex-shrink:0;width:28px;height:28px;border-radius:8px;border:1px solid var(--edge2);
  background:transparent;color:var(--txt3);font-size:1.05rem;line-height:1;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;transition:all .18s;padding:0}
.hist-del:hover{border-color:rgba(224,85,102,.4);color:var(--red);background:rgba(224,85,102,.08)}
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
  .dash-user-email{display:none}
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

        {user ? (
          <div className="dash-user">
            <span className="dash-user-email">{user.email}</span>
            <button className="dash-signout" onClick={signOut}>
              Выйти
            </button>
          </div>
        ) : (
          <div className="dash-status">
            <span className="status-dot"></span>
            Первый расчёт бесплатно
          </div>
        )}
      </div>

      <div className="dash-wrap">
        {!user && (
          <div className="card auth-card">
            <h3 className="auth-title">Вход в аккаунт</h3>

            <div className="auth-row">
              <input
                className="auth-input"
                type="email"
                placeholder="Ваш email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") signIn();
                }}
              />
              <button type="button" className="auth-btn" onClick={signIn}>
                Войти
              </button>
            </div>

            {authMessage && <p className="auth-msg">{authMessage}</p>}
          </div>
        )}

        <h1 className="dash-h1">
          Новый <em>расчёт</em>
        </h1>
        <p className="dash-lead">
          Введите данные по товару или периоду — посчитаем чистую прибыль и маржинальность.
        </p>

        <StatsCards
          totalRevenue={totalRevenue}
          totalProfit={totalProfit}
          avgMargin={avgMargin}
          historyCount={history.length}
        />

        <div className="calc-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={calcMode === "manual"}
            className={"calc-tab" + (calcMode === "manual" ? " active" : "")}
            onClick={() => setCalcMode("manual")}
          >
            <span className="calc-tab-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="16" height="18" rx="2.5" />
                <path d="M8 7h8M8 11h8M8 15h5" />
              </svg>
            </span>
            Ручной расчёт
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={calcMode === "api"}
            className={"calc-tab" + (calcMode === "api" ? " active" : "")}
            onClick={() => setCalcMode("api")}
          >
            <span className="calc-tab-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
              </svg>
            </span>
            Авторасчёт через API
          </button>
        </div>

        {calcMode === "manual" ? (
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
        ) : (
        <div className="card api-pro-card">
          <div className="api-pro-head">
            <div className="api-pro-title">Подключение маркетплейсов</div>
            <p className="api-pro-sub">
              Подключите API и получайте автоматический расчёт прибыли
            </p>
          </div>

          <div className="api-pro-body">
            <div className="api-pro-grid">
              <div className="api-fld">
                <label>Ozon Client ID</label>
                <input
                  className="api-input"
                  type="text"
                  placeholder="Например, 123456"
                  value={ozonClientId}
                  onChange={(e) => setOzonClientId(e.target.value)}
                  disabled={!user}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="api-fld">
                <label>Ozon API Key</label>
                <div className="api-secret">
                  <input
                    className="api-input"
                    type={showOzonKey ? "text" : "password"}
                    placeholder="Вставьте секретный ключ"
                    value={ozonApiKey}
                    onChange={(e) => setOzonApiKey(e.target.value)}
                    disabled={!user}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="api-eye"
                    onClick={() => setShowOzonKey((v) => !v)}
                    disabled={!user}
                    aria-label={showOzonKey ? "Скрыть ключ" : "Показать ключ"}
                    title={showOzonKey ? "Скрыть" : "Показать"}
                  >
                    {showOzonKey ? eyeOffIcon : eyeIcon}
                  </button>
                </div>
              </div>

              <div className="api-fld api-fld-full">
                <label>Wildberries API Key</label>
                <div className="api-secret">
                  <input
                    className="api-input"
                    type={showWbKey ? "text" : "password"}
                    placeholder="Вставьте токен из личного кабинета WB"
                    value={wbApiKey}
                    onChange={(e) => setWbApiKey(e.target.value)}
                    disabled={!user}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="api-eye"
                    onClick={() => setShowWbKey((v) => !v)}
                    disabled={!user}
                    aria-label={showWbKey ? "Скрыть ключ" : "Показать ключ"}
                    title={showWbKey ? "Скрыть" : "Показать"}
                  >
                    {showWbKey ? eyeOffIcon : eyeIcon}
                  </button>
                </div>
              </div>
            </div>

            <div className="api-pro-foot">
              <p
                className={
                  "api-pro-msg" +
                  (apiSaveStatus === "ok" ? " ok" : "") +
                  (apiSaveStatus === "err" ? " err" : "")
                }
              >
                {apiSaveMessage}
              </p>
              {user ? (
                <button
                  type="button"
                  className="api-pro-btn"
                  onClick={saveApiKeys}
                  disabled={apiSaveStatus === "saving"}
                >
                  {apiSaveStatus === "saving" ? "Подключаем…" : "Подключить маркетплейс"}
                </button>
              ) : (
                <button type="button" className="api-pro-btn locked" disabled>
                  Войдите в аккаунт для подключения API
                </button>
              )}
            </div>

            <div className="api-pro-hint">
              <span className="api-pro-hint-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <circle cx="12" cy="16.4" r=".6" fill="currentColor" />
                </svg>
              </span>
              Ваши продажи, комиссии и расходы будут подтягиваться автоматически.
            </div>
          </div>
        </div>
        )}

        <div className="card tariff-card">
          <div className="card-head">
            <div className="card-title">Тарифы</div>
          </div>

          <div className="tariff-grid">
            <div className="tariff-item">
              <div className="tariff-name">Старт</div>
              <div className="tariff-price">Бесплатно</div>
              <div className="tariff-period">Первый расчёт</div>
              <ul className="tariff-list">
                <li>Один расчёт для оценки сервиса</li>
                <li>Все функции калькулятора</li>
                <li>Сохранение результата в историю</li>
              </ul>
              <button type="button" className="tariff-btn" disabled>
                Уже доступно
              </button>
            </div>

            <div className="tariff-item">
              <div className="tariff-name">Разовый расчёт</div>
              <div className="tariff-price">
                <em>149</em> ₽
              </div>
              <div className="tariff-period">Один платёж</div>
              <ul className="tariff-list">
                <li>Дополнительный расчёт по любому товару</li>
                <li>Без подписки и автосписаний</li>
                <li>Подходит, если расчёты нужны редко</li>
              </ul>
              <button
                type="button"
                className="tariff-btn"
                onClick={() => handleTariff("single")}
              >
                Купить расчёт 149₽
              </button>
            </div>

            <div className="tariff-item featured">
              <span className="tariff-badge">Выгодно</span>
              <div className="tariff-name">Безлимит</div>
              <div className="tariff-price">
                <em>449</em> ₽<span className="tariff-month">/мес</span>
              </div>
              <div className="tariff-period">Подписка на 30 дней</div>
              <ul className="tariff-list">
                <li>Неограниченное число расчётов в месяц</li>
                <li>Приоритетный доступ к новым функциям</li>
                <li>Полная история без ограничений</li>
              </ul>
              <button
                type="button"
                className="tariff-btn primary"
                onClick={() => handleTariff("unlimited")}
              >
                Оформить безлимит 449₽
              </button>
            </div>
          </div>

          {tariffMessage && <p className="tariff-msg">{tariffMessage}</p>}
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
                <div className="hist-item" key={h.id}>
                  <div className={"hist-mp " + h.marketplace}>
                    {h.marketplace === "ozon" ? "Ozon" : "WB"}
                  </div>

                  <div className="hist-info">
                    <div className="hist-rev">Выручка {fmt(h.revenue)} ₽</div>
                    <div className="hist-date">{h.date}</div>
                  </div>

                  <div className={"hist-profit " + (h.profit >= 0 ? "pos" : "neg")}>
                    {h.profit >= 0 ? "+" : "−"}
                    {fmt(Math.abs(h.profit))} ₽
                    <span className="hm">маржа {h.margin.toFixed(1)}%</span>
                  </div>

                  <button
                    type="button"
                    className="hist-del"
                    onClick={() => deleteHistoryItem(h.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card api-card">
          <div className="card-head">
            <div className="card-title">Подключение маркетплейсов</div>
          </div>

          {user ? (
            <div className="card-body">
              <div className="api-grid">
                <div className="api-fld">
                  <label>Ozon Client ID</label>
                  <input
                    className="api-input"
                    type="text"
                    placeholder="Например, 123456"
                    value={ozonClientId}
                    onChange={(e) => setOzonClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="api-fld">
                  <label>Ozon API Key</label>
                  <div className="api-secret">
                    <input
                      className="api-input"
                      type={showOzonKey ? "text" : "password"}
                      placeholder="Вставьте секретный ключ"
                      value={ozonApiKey}
                      onChange={(e) => setOzonApiKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="api-eye"
                      onClick={() => setShowOzonKey((v) => !v)}
                      aria-label={showOzonKey ? "Скрыть ключ" : "Показать ключ"}
                      title={showOzonKey ? "Скрыть" : "Показать"}
                    >
                      {showOzonKey ? eyeOffIcon : eyeIcon}
                    </button>
                  </div>
                </div>

                <div className="api-fld api-fld-full">
                  <label>Wildberries API Key</label>
                  <div className="api-secret">
                    <input
                      className="api-input"
                      type={showWbKey ? "text" : "password"}
                      placeholder="Вставьте токен из личного кабинета WB"
                      value={wbApiKey}
                      onChange={(e) => setWbApiKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="api-eye"
                      onClick={() => setShowWbKey((v) => !v)}
                      aria-label={showWbKey ? "Скрыть ключ" : "Показать ключ"}
                      title={showWbKey ? "Скрыть" : "Показать"}
                    >
                      {showWbKey ? eyeOffIcon : eyeIcon}
                    </button>
                  </div>
                  <span className="api-hint">
                    Ключи хранятся только для вашего аккаунта и используются для загрузки данных с маркетплейсов.
                  </span>
                </div>
              </div>

              <div className="api-foot">
                <p
                  className={
                    "api-msg" +
                    (apiSaveStatus === "ok" ? " ok" : "") +
                    (apiSaveStatus === "err" ? " err" : "")
                  }
                >
                  {apiSaveMessage}
                </p>
                <button
                  type="button"
                  className="api-save"
                  onClick={saveApiKeys}
                  disabled={apiSaveStatus === "saving"}
                >
                  {apiSaveStatus === "saving" ? "Сохраняем…" : "Сохранить API"}
                </button>
              </div>
            </div>
          ) : (
            <div className="api-locked">
              <span className="api-locked-icon">◇</span>
              <div className="api-locked-title">Войдите в аккаунт</div>
              <div className="api-locked-sub">
                API-ключи сохраняются индивидуально для каждого пользователя
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
