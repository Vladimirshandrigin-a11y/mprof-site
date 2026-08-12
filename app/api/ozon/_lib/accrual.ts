// ============================================================================
// Новый источник финансов Ozon для основного API-расчёта: отчёт НАЧИСЛЕНИЙ
// (/v1/finance/accrual/by-day). ТОЛЬКО сервер. Feature-flagged, с полным откатом
// на существующий legacy-агрегатор при ЛЮБОЙ проблеме.
//
// Строит ТОТ ЖЕ OzonDraftAggregate (totals + taxonomy), что и aggregateDraft, чтобы
// формула прибыли, БД, история и UI-контракт остались байт-в-байт. Единственный
// net-source-of-truth — Σ total_amount.amount (доказано: == legacy Σ amount, delta 0).
// Nested-суммы (commission/logistics/services/storage) — ТОЛЬКО разбивка того же
// net; повторно к net НЕ прибавляются. residual `other` балансирует до net.
//
// Rollout: server-only env OZON_FINANCE_ACCRUAL_ENABLED === "true" включает путь.
// Отсутствует/иное → вызывающий использует legacy control-flow без изменений.
// Api-Key приходит расшифрованным; здесь НЕ логируется и НЕ возвращается.
// ============================================================================

import {
  type OzonDraftAggregate,
  type OzonDraftTotals,
  type OzonTaxonomyBreakdown,
  type SignedBreakdown,
} from "./finance";
import {
  OZON_TAXONOMY_VERSION,
  emptyChargeCredit,
  accumulateSigned,
  type ChargeCreditAcc,
} from "./taxonomy";

const SELLER = "https://api-seller.ozon.ru";
const BY_DAY_URL = `${SELLER}/v1/finance/accrual/by-day`;
const TIMEOUT_MS = 15000; // таймаут одной страницы
const MIN_REQUEST_INTERVAL_MS = 1100; // единый pacer между стартами запросов
const NEW_API_MAX_REQUESTS = 130; // жёсткий потолок новых запросов за расчёт
const BY_DAY_MAX_PAGES_PER_DAY = 5; // доказанный практический предел страниц/день
const DEADLINE_MS = 40000; // мягкий общий дедлайн (до и после sleep)

// ITEM nested taxonomy — доказанные type_id. Всё прочее/невалидное → residual (не угадываем).
const ITEM_SERVICES_TYPE_IDS: ReadonlySet<number> = new Set([1, 38, 39]);
const ITEM_STORAGE_TYPE_IDS: ReadonlySet<number> = new Set([79]);

/** Включён ли новый accrual-источник. ТОЛЬКО точная строка "true" (server-only env). */
export function isAccrualFinanceEnabled(): boolean {
  return process.env.OZON_FINANCE_ACCRUAL_ENABLED === "true";
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Строгий парсер денежной строки (тот же контракт, что доказан для accrual-методов):
// finite number ИЛИ строгая десятичная строка. Иначе null.
const MONEY_RE = /^[+-]?\d+(\.\d+)?$/;
function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || !MONEY_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Дни месяца "YYYY-MM" → ["YYYY-MM-01", …] в UTC. Пустой массив при неверном формате. */
function daysOfMonth(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const y = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return [];
  const last = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= last; d++) days.push(`${month}-${String(d).padStart(2, "0")}`);
  return days;
}

// present-leaf доказанного пути объекта: `container[key].amount`. present=true, если
// объект key присутствует (не undefined/null). raw = его .amount (может быть невалиден).
function presentAmount(container: Record<string, unknown>, key: string): { present: boolean; raw: unknown } {
  const sub = container[key];
  if (sub === undefined || sub === null) return { present: false, raw: undefined };
  return { present: true, raw: asObj(sub).amount };
}

// ---------------------------------------------------------------------------
// ЧИСТАЯ сборка OzonDraftAggregate из уже полученных by-day записей.
// Возвращает null при любом нарушении инвариантов → вызывающий делает legacy fallback.
// ---------------------------------------------------------------------------
export function buildAccrualDraft(records: unknown[]): OzonDraftAggregate | null {
  if (records.length === 0) return null; // нет accrual-данных → legacy

  let netTruth = 0;
  let revenue = 0;
  let commission = 0;
  let logistics = 0;
  let services = 0;
  let storage = 0;
  const ccLogistics = emptyChargeCredit();
  const ccServices = emptyChargeCredit();

  for (const it of records) {
    const o = asObj(it);
    // net truth: total_amount.amount ОБЯЗАН распарситься (иначе весь путь невалиден).
    const amt = parseMoney(asObj(o.total_amount).amount);
    if (amt === null) return null;
    netTruth += amt;

    const cat = typeof o.accrued_category === "string" ? o.accrued_category : "";
    if (cat === "POSTING") {
      // revenue/commission/logistics — из посительных product-полей. Отсутствие объекта
      // допустимо («не применимо»); present + невалидный amount → путь невалиден.
      for (const prod of asArr(asObj(o.posting).products)) {
        const po = asObj(prod);
        const comm = asObj(po.commission);
        const deliv = asObj(po.delivery);
        const rv = presentAmount(comm, "sale_amount");
        if (rv.present) {
          const v = parseMoney(rv.raw);
          if (v === null) return null;
          revenue += v;
        }
        const cm = presentAmount(comm, "commission");
        if (cm.present) {
          const v = parseMoney(cm.raw);
          if (v === null) return null;
          commission += v;
        }
        const lg = presentAmount(deliv, "total_accrued");
        if (lg.present) {
          const v = parseMoney(lg.raw);
          if (v === null) return null;
          logistics += v;
          accumulateSigned(ccLogistics, v);
        }
      }
    } else if (cat === "ITEM") {
      // Доказанный ДВУХуровневый путь: item_fees.fees[] (SKU-группы) → .fees[] (записи).
      // type_id 1/38/39 → services; 79 → storage; прочее/невалидный amount → residual.
      for (const g of asArr(asObj(o.item_fees).fees)) {
        for (const f of asArr(asObj(g).fees)) {
          const fo = asObj(f);
          const tid = fo.type_id;
          const a = parseMoney(asObj(fo.accrued).amount);
          if (typeof tid === "number" && ITEM_SERVICES_TYPE_IDS.has(tid)) {
            if (a !== null) {
              services += a;
              accumulateSigned(ccServices, a);
            }
          } else if (typeof tid === "number" && ITEM_STORAGE_TYPE_IDS.has(tid)) {
            if (a !== null) storage += a;
          }
          // прочее/невалидное → остаётся в residual (не угадываем)
        }
      }
    }
    // NON_ITEM и любые прочие категории → residual (через балансирующий other)
  }

  // ---- сборка totals с балансирующим other и строгой reconciliation ----
  const revenueR = round2(revenue);
  const commissionR = round2(commission);
  const logisticsR = round2(logistics);
  const servicesR = round2(services);
  const storageR = round2(storage);
  const adsR = 0; // не угадываем
  const adjustmentsR = 0; // не угадываем
  const netTruthR = round2(netTruth);
  const otherR = round2(
    netTruthR - (revenueR + commissionR + logisticsR + servicesR + storageR + adsR + adjustmentsR)
  );
  const recon = round2(
    revenueR + commissionR + logisticsR + servicesR + storageR + adsR + adjustmentsR + otherR
  );
  if (!Number.isFinite(recon) || recon !== netTruthR) return null; // reconciliation failure → legacy

  const totals: OzonDraftTotals = {
    revenue: revenueR,
    returns: 0,
    commission: commissionR,
    logistics: logisticsR,
    logisticsLegacy: logisticsR, // вся логистика из delivery → legacy-корзина; services=0
    logisticsServices: 0,
    storage: storageR,
    services: servicesR,
    ads: adsR,
    adjustments: adjustmentsR,
    other: otherR,
    operationCount: records.length,
  };

  const ccOther = emptyChargeCredit();
  accumulateSigned(ccOther, otherR);
  const mk = (acc: ChargeCreditAcc): SignedBreakdown => {
    const charges = round2(acc.charges);
    const credits = round2(acc.credits);
    return { signedTotal: round2(credits - charges), charges, credits };
  };
  const taxonomy: OzonTaxonomyBreakdown = {
    classifierVersion: OZON_TAXONOMY_VERSION,
    logistics: mk(ccLogistics),
    ads: mk(emptyChargeCredit()),
    adjustments: mk(emptyChargeCredit()),
    remainingServices: mk(ccServices),
    remainingOther: mk(ccOther),
  };

  return { totals, taxonomy, warnings: [], notes: [] };
}

// ---------------------------------------------------------------------------
// Загрузка by-day за месяц + сборка. Возвращает OzonDraftAggregate ЛИБО null (→ legacy).
// ---------------------------------------------------------------------------
type PageResult = { ok: true; json: unknown } | { ok: false };
type PageFetcher = (day: string, lastId: string) => Promise<PageResult>;
type Budget = { used: number; lastStart: number; deadline: number };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Реальный fetcher: единый pacer + budget + deadline + timeout. ЛЮБОЙ не-200 (вкл. 429),
// сеть, таймаут, исчерпание budget или дедлайн → { ok:false } (без retry).
function makeRealFetcher(clientId: string, apiKey: string, budget: Budget): PageFetcher {
  const headers = { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" };
  return async (day: string, lastId: string): Promise<PageResult> => {
    if (budget.used >= NEW_API_MAX_REQUESTS) return { ok: false }; // потолок → fallback
    if (Date.now() >= budget.deadline) return { ok: false }; // дедлайн ДО sleep
    if (budget.lastStart !== 0) {
      const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - budget.lastStart);
      if (wait > 0) await sleep(wait);
    }
    if (Date.now() >= budget.deadline) return { ok: false }; // дедлайн ПОСЛЕ sleep
    budget.lastStart = Date.now();
    budget.used += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(BY_DAY_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ date: day, last_id: lastId }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false }; // 429 и любой не-200 → fallback, без retry
      try {
        return { ok: true, json: await res.json() };
      } catch {
        return { ok: false };
      }
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Собрать OzonDraftAggregate из /v1/finance/accrual/by-day за месяц.
 * Возвращает null при 429/deadline/потолке/pagination-truncation/сетевой ошибке/
 * невалидном обязательном поле/reconciliation-провале → вызывающий делает legacy.
 * fetcher инъектируется в тестах; в бою — реальный pacer/budget/deadline.
 */
export async function loadAccrualDraft(
  params: { clientId: string; apiKey: string; month: string },
  fetcher?: PageFetcher
): Promise<OzonDraftAggregate | null> {
  const days = daysOfMonth(params.month);
  if (days.length === 0) return null;
  const budget: Budget = { used: 0, lastStart: 0, deadline: Date.now() + DEADLINE_MS };
  const fetchPage = fetcher ?? makeRealFetcher(params.clientId, params.apiKey, budget);

  const records: unknown[] = [];
  for (const day of days) {
    let lastId = "";
    for (let p = 0; p < BY_DAY_MAX_PAGES_PER_DAY; p++) {
      const r = await fetchPage(day, lastId);
      if (!r.ok) return null; // 429/deadline/потолок/сеть/битый JSON → legacy
      const root = asObj(r.json);
      const items = asArr(root.accruals); // доказанный root.accruals[]
      for (const it of items) records.push(it);
      const prevLastId = lastId;
      const nextId = typeof root.last_id === "string" ? root.last_id : "";
      if (nextId === "" || nextId === prevLastId || items.length === 0) break; // конец дня
      if (p === BY_DAY_MAX_PAGES_PER_DAY - 1) return null; // страниц больше потолка → legacy
      lastId = nextId;
    }
  }
  return buildAccrualDraft(records);
}
