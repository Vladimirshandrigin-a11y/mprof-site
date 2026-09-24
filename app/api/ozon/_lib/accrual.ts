// ============================================================================
// Новый источник финансов Ozon для основного API-расчёта: отчёт НАЧИСЛЕНИЙ
// (/v1/finance/accrual/by-day). ТОЛЬКО сервер. Feature-flagged.
//
// ВАЖНО (миграция PR): легаси-источник (/v3/finance/transaction/list) officially
// отключён Ozon 2026-09-08 (подтверждено официальным Telegram-каналом Ozon Seller
// API). Поэтому этот модуль БОЛЬШЕ НЕ имеет отката на legacy при собственной
// неудаче — откатываться некуда, endpoint мёртв. Любая неудача (429 после
// ограниченных повторов, общий дедлайн, потолок запросов, потолок страниц/день,
// невалидная форма ответа, provaленная reconciliation) возвращает ЧЕСТНЫЙ код
// ошибки вызывающему (profit.ts), который останавливает расчёт ДО consume/save —
// вместо тихого отката на несуществующий метод. Флаг OZON_FINANCE_ACCRUAL_ENABLED
// решает только «пробовать ли accrual вообще»; при flag=false вызывающий
// продолжает использовать legacy control-flow без изменений (как раньше).
//
// Строит ТОТ ЖЕ OzonDraftAggregate (totals + taxonomy), что и aggregateDraft, чтобы
// формула прибыли, БД, история и UI-контракт остались байт-в-байт. Единственный
// net-source-of-truth — Σ total_amount.amount (доказано: == legacy Σ amount, delta 0
// на исторических месяцах, когда legacy ещё отвечал). Nested-суммы (commission/
// logistics/services/storage/…) — ТОЛЬКО разбивка того же net; повторно к net НЕ
// прибавляются, и НИКОГДА не вычитаются из net truth второй раз — единственное
// место, где Σ total_amount.amount складывается, это netTruth ниже; всё остальное
// читает те же records ТОЛЬКО для разбивки на корзины.
//
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
const TIMEOUT_MS = 15000; // таймаут ОДНОЙ попытки страницы
const MIN_REQUEST_INTERVAL_MS = 1100; // единый pacer между стартами запросов
const NEW_API_MAX_REQUESTS = 130; // жёсткий потолок РЕАЛЬНЫХ запросов за расчёт
const BY_DAY_MAX_PAGES_PER_DAY = 5; // доказанный практический предел страниц/день
const DEADLINE_MS = 40000; // мягкий общий дедлайн (до и после sleep) — см. doc-comment
// у loadAccrualDraft ниже про то, почему это НЕ повышается вслепую в этом PR.

// Ограниченный ретрай 429 — ТОТ ЖЕ проверенный паттерн, что уже в
// accrual-migration-diagnostic/route.ts (ozonPost): полный Retry-After (не
// урезается), не больше RETRY_WAIT_CAP_MS, и только если помещается в остаток
// budget.deadline — иначе сдаёмся БЕЗ раннего повтора с урезанным ожиданием.
const MAX_429_RETRIES_PER_CALL = 2;
const RETRY_DEFAULT_WAIT_MS = 2000;
const RETRY_WAIT_CAP_MS = 10000;

// ITEM nested taxonomy — доказанные type_id. Всё прочее/невалидное → residual (не угадываем).
const ITEM_SERVICES_TYPE_IDS: ReadonlySet<number> = new Set([1, 38, 39]);
const ITEM_STORAGE_TYPE_IDS: ReadonlySet<number> = new Set([79]);

/** Включён ли новый accrual-источник. ТОЛЬКО точная строка "true" (server-only env). */
export function isAccrualFinanceEnabled(): boolean {
  return process.env.OZON_FINANCE_ACCRUAL_ENABLED === "true";
}

// Единый типизированный контракт МЕТА-ИНФОРМАЦИИ фактически выбранного источника —
// определяется по ОДНОМУ разу на источник (здесь accrual; legacy — в profit.ts).
// classifierVersion / snapshot.kind НЕ дифференцируем: их гейтят page.tsx (месяц по
// kind==="ozon-api-v1") и ozon-finance-taxonomy-view (classifierVersion===поддерживаемый),
// поэтому честное различие несёт sourceEndpoint (+ additive-маркер в snapshot).
export type FinanceSource = "accrual_by_day" | "transaction_list";
export type FinanceSourceMeta = { source: FinanceSource; sourceEndpoint: string };
export const ACCRUAL_FINANCE_SOURCE: FinanceSourceMeta = {
  source: "accrual_by_day",
  sourceEndpoint: BY_DAY_URL,
};

// ---------------------------------------------------------------------------
// Честный код неудачи загрузки accrual — БЕЗ отката на legacy (endpoint мёртв).
// profit.ts переводит это в понятное сообщение ДО consume/save.
// ---------------------------------------------------------------------------
export type AccrualLoadErrorCode =
  | "rate_limited" // 429, ограниченные повторы (MAX_429_RETRIES_PER_CALL) исчерпаны
  | "deadline_exceeded" // общий мягкий бюджет DEADLINE_MS истёк до/во время загрузки
  | "request_limit_exceeded" // NEW_API_MAX_REQUESTS исчерпан
  | "pagination_truncated" // BY_DAY_MAX_PAGES_PER_DAY исчерпан для какого-то дня
  | "malformed_response" // невалидная форма ответа / обязательное поле не распарсилось
  | "reconciliation_mismatch" // сумма корзин не сошлась с netTruth (округление/инвариант)
  | "network_error" // fetch бросил НЕ-AbortError (DNS/TLS/соединение оборвано)
  | "bad_month" // month не парсится в дни (внутренняя проверка входа)
  | "no_data"; // весь месяц ЧЕСТНО пройден, начислений действительно нет (НЕ ошибка сети)

export type AccrualLoadResult =
  | { ok: true; draft: OzonDraftAggregate }
  | { ok: false; code: AccrualLoadErrorCode };

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

// accrual_id — идентификатор КОНКРЕТНОЙ ЗАПИСИ начисления (доказано: см. doc-comment
// safeAccrualId в accrual-migration-diagnostic/route.ts — "по одному on by-day
// record", НЕ идентификатор типа услуги). Один JSON-record может внутри себя
// содержать НЕСКОЛЬКО operations (posting.products[]/item_fees.fees[][]) — они
// остаются ВНУТРИ одного record и обрабатываются вместе; dedup ниже пропускает
// ТОЛЬКО повторно пришедший ЦЕЛИКОМ record с уже виденным accrual_id (защита от
// повторной страницы при pagination/retry-артефакте), а НЕ разные операции одной
// отправки — те всегда живут в одном record и не могут быть спутаны с дублем.
function safeAccrualId(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1_000_000_000) return null;
  return v;
}

// ---------------------------------------------------------------------------
// ЧИСТАЯ сборка OzonDraftAggregate из уже полученных by-day записей (после
// dedup по accrual_id — см. loadAccrualDraft). Возвращает честный код ошибки
// при любом нарушении инвариантов — БЕЗ отката на legacy (endpoint мёртв).
// ---------------------------------------------------------------------------
export function buildAccrualDraft(records: unknown[]): AccrualLoadResult {
  if (records.length === 0) {
    return { ok: false, code: "no_data" };
  }

  let netTruth = 0;
  let revenue = 0;
  let commission = 0;
  let logistics = 0;
  let services = 0;
  let storage = 0;
  const ccLogistics = emptyChargeCredit();
  const ccServices = emptyChargeCredit();

  // ---- evidence-суммы (ТОЛЬКО для warnings/notes — НЕ отдельные UI-корзины,
  // НЕ вычитаются из netTruth повторно, остаются частью балансирующего other,
  // как и раньше). Проверенные поля — commission.coinvestment/commission.bonus
  // (см. GROSS_CANDIDATE_PATHS, accrual-migration-diagnostic/route.ts): та же
  // структура commission.<name>.amount, что и sale_amount/commission выше.
  // commission.bonus — гипотеза по аналогии с полем bonus в RealizationCommission
  // (realization.ts) и с GROSS_CANDIDATE_PATHS; численно подтверждена ТОЛЬКО в
  // офлайн-тесте на анонимизированных данных июньской выгрузки «Отчёт по
  // начислениям», НЕ переподтверждена свежим живым ответом Ozon.
  let coinvestmentSum = 0;
  let bonusSum = 0;
  let coinvestmentSeen = false;
  let bonusSeen = false;

  for (const it of records) {
    const o = asObj(it);
    // net truth: total_amount.amount ОБЯЗАН распарситься (иначе весь путь невалиден).
    const amt = parseMoney(asObj(o.total_amount).amount);
    if (amt === null) return { ok: false, code: "malformed_response" };
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
          if (v === null) return { ok: false, code: "malformed_response" };
          revenue += v;
        }
        const cm = presentAmount(comm, "commission");
        if (cm.present) {
          const v = parseMoney(cm.raw);
          if (v === null) return { ok: false, code: "malformed_response" };
          commission += v;
        }
        const lg = presentAmount(deliv, "total_accrued");
        if (lg.present) {
          const v = parseMoney(lg.raw);
          if (v === null) return { ok: false, code: "malformed_response" };
          logistics += v;
          accumulateSigned(ccLogistics, v);
        }
        // evidence-only: coinvestment/bonus НЕ добавляются в revenue/commission/
        // logistics/services/storage выше — остаются в балансирующем other (см.
        // otherR ниже), только суммируются здесь для честного warning-раскрытия
        // состава other, а не как подтверждённая отдельная UI-корзина.
        const ci = presentAmount(comm, "coinvestment");
        if (ci.present) {
          const v = parseMoney(ci.raw);
          if (v !== null) {
            coinvestmentSum += v;
            coinvestmentSeen = true;
          }
        }
        const bn = presentAmount(comm, "bonus");
        if (bn.present) {
          const v = parseMoney(bn.raw);
          if (v !== null) {
            bonusSum += v;
            bonusSeen = true;
          }
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
    // NON_ITEM и любые прочие категории → residual (через балансирующий other).
    // Реклама/продвижение, компенсации/декомпенсации, штрафы и корректировки
    // Ozon чаще всего приходят здесь (доказано NON_ITEM-полем non_item_fee.type_id
    // в диагностике, PR #79-81) — БЕЗ справочника type_id→категория из ЭТОГО
    // запуска классифицировать их дальше рискованно (не угадываем), поэтому
    // ads/adjustments ниже остаются 0 — см. warning об этом ниже, а не тихий 0.
  }

  // ---- сборка totals с балансирующим other и строгой reconciliation ----
  const revenueR = round2(revenue);
  const commissionR = round2(commission);
  const logisticsR = round2(logistics);
  const servicesR = round2(services);
  const storageR = round2(storage);
  const adsR = 0; // не классифицируется отдельно для accrual-источника (см. warning)
  const adjustmentsR = 0; // не классифицируется отдельно для accrual-источника (см. warning)
  const netTruthR = round2(netTruth);
  const otherR = round2(
    netTruthR - (revenueR + commissionR + logisticsR + servicesR + storageR + adsR + adjustmentsR)
  );
  const recon = round2(
    revenueR + commissionR + logisticsR + servicesR + storageR + adsR + adjustmentsR + otherR
  );
  if (!Number.isFinite(recon) || recon !== netTruthR) {
    return { ok: false, code: "reconciliation_mismatch" };
  }

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

  // ---- честные warnings/notes (раньше здесь были всегда пустые массивы) ----
  const warnings: string[] = [];
  const notes: string[] = [
    "Возвраты (returns) для источника accrual не выделяются отдельной строкой: они уже учтены внутри «Начислений Ozon» (net truth), как и раньше у документального расчёта — повторно в сумму не добавляются.",
  ];
  if (round2(otherR) !== 0) {
    const parts: string[] = [];
    if (coinvestmentSeen) parts.push(`программы партнёров/co-investment ≈ ${round2(coinvestmentSum)} ₽`);
    if (bonusSeen) parts.push(`баллы/бонусы за скидки ≈ ${round2(bonusSum)} ₽`);
    warnings.push(
      `«Прочие операции» (${round2(otherR)} ₽) для источника accrual пока НЕ разбиты по видам ` +
        `(реклама и продвижение / компенсации и декомпенсации / другие услуги и штрафы отдельно НЕ выделяются — ` +
        `справочник видов начислений (type_id) для этого запуска не используется). ` +
        (parts.length > 0 ? `Известная (не вычитаемая повторно) часть состава: ${parts.join(", ")}. ` : "") +
        `Итоговая сумма (net truth) корректна — не хватает только разбивки по корзинам «Реклама»/«Компенсации».`
    );
  }

  return { ok: true, draft: { totals, taxonomy, warnings, notes } };
}

// ---------------------------------------------------------------------------
// Загрузка by-day за месяц + сборка. Возвращает draft ЛИБО честный код ошибки —
// БЕЗ отката на legacy (endpoint официально отключён 2026-09-08).
// ---------------------------------------------------------------------------

/** Одна РЕАЛЬНАЯ попытка HTTP (без ретрая) — инъецируется в тестах. */
export type PageFetchOnce =
  | { ok: true; json: unknown }
  | {
      ok: false;
      code: "rate_limited" | "timeout" | "deadline" | "network_error" | "bad_response" | "request_limit";
      retryAfter?: number | null;
    };
type PageFetcherOnce = (day: string, lastId: string) => Promise<PageFetchOnce>;

/** Итог ОДНОГО логического запроса (после исчерпания/успеха ретраев). */
type PageFetchOut =
  | { ok: true; json: unknown }
  | { ok: false; code: AccrualLoadErrorCode };
type PageFetcher = (day: string, lastId: string) => Promise<PageFetchOut>;

type Budget = { used: number; lastStart: number; deadline: number };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Одна РЕАЛЬНАЯ попытка: единый pacer + budget + deadline + timeout (ТОТ ЖЕ
// контракт, что и раньше в makeRealFetcher, но с распознаваемым кодом ошибки —
// нужно retry-обёртке ниже, чтобы отличить 429 от прочих отказов).
function makeRealFetcherOnce(clientId: string, apiKey: string, budget: Budget): PageFetcherOnce {
  const headers = { "Client-Id": clientId, "Api-Key": apiKey, "Content-Type": "application/json" };
  return async (day: string, lastId: string): Promise<PageFetchOnce> => {
    if (budget.used >= NEW_API_MAX_REQUESTS) return { ok: false, code: "request_limit" };
    if (Date.now() >= budget.deadline) return { ok: false, code: "deadline" };
    if (budget.lastStart !== 0) {
      const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - budget.lastStart);
      if (wait > 0) await sleep(wait);
    }
    if (Date.now() >= budget.deadline) return { ok: false, code: "deadline" };
    const remainingMs = budget.deadline - Date.now();
    if (remainingMs <= 0) return { ok: false, code: "deadline" };
    const effectiveTimeout = Math.min(TIMEOUT_MS, remainingMs);
    budget.lastStart = Date.now();
    budget.used += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
      const res = await fetch(BY_DAY_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ date: day, last_id: lastId }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 429) {
          const ra = res.headers.get("retry-after");
          let retryAfter: number | null = null;
          if (ra !== null) {
            const n = Number.parseInt(ra.trim(), 10);
            if (Number.isFinite(n) && n >= 0) retryAfter = n;
          }
          return { ok: false, code: "rate_limited", retryAfter };
        }
        return { ok: false, code: "bad_response" };
      }
      try {
        return { ok: true, json: await res.json() };
      } catch {
        return { ok: false, code: "bad_response" };
      }
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return { ok: false, code: aborted ? "deadline" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  };
}

// Ограниченный ретрай 429 поверх ОДНОЙ попытки — ТОТ ЖЕ проверенный паттерн, что
// ozonPost в accrual-migration-diagnostic/route.ts: полный Retry-After (НЕ
// урезается), максимум MAX_429_RETRIES_PER_CALL повторов, отказ БЕЗ повтора если
// waitMs больше RETRY_WAIT_CAP_MS или не помещается в остаток budget.deadline.
// Любая ДРУГАЯ ошибка (не 429) не ретраится — сразу мапится в честный код.
function withPacedRetry429(once: PageFetcherOnce, budget: Budget): PageFetcher {
  return async (day: string, lastId: string): Promise<PageFetchOut> => {
    let last: Extract<PageFetchOnce, { ok: false }> = { ok: false, code: "network_error" };
    for (let attempt = 0; attempt <= MAX_429_RETRIES_PER_CALL; attempt++) {
      const r = await once(day, lastId);
      if (r.ok) return r;
      if (r.code !== "rate_limited") return { ok: false, code: mapOnceCode(r.code) };
      last = r;
      if (attempt === MAX_429_RETRIES_PER_CALL) break; // повторы исчерпаны
      const waitMs =
        typeof r.retryAfter === "number" ? Math.max(0, r.retryAfter * 1000) : RETRY_DEFAULT_WAIT_MS;
      if (waitMs > RETRY_WAIT_CAP_MS) break; // Ozon просит больше, чем мы готовы ждать один retry
      const remainingMs = budget.deadline - Date.now();
      if (waitMs > remainingMs - 500) break; // не помещается в бюджет — не ждём меньше запрошенного
      if (waitMs > 0) await sleep(waitMs);
    }
    return { ok: false, code: mapOnceCode(last.code) };
  };
}
function mapOnceCode(code: Extract<PageFetchOnce, { ok: false }>["code"]): AccrualLoadErrorCode {
  switch (code) {
    case "rate_limited":
      return "rate_limited";
    case "deadline":
      return "deadline_exceeded";
    case "request_limit":
      return "request_limit_exceeded";
    case "timeout":
      return "network_error";
    case "network_error":
      return "network_error";
    case "bad_response":
      return "malformed_response";
  }
}

/**
 * Собрать OzonDraftAggregate из /v1/finance/accrual/by-day за месяц.
 * Возвращает честный код ошибки при 429 (после ограниченных повторов)/дедлайне/
 * потолке запросов/потолке страниц-в-день/сетевой ошибке/невалидном обязательном
 * поле/reconciliation-провале — БЕЗ отката на legacy (endpoint официально
 * отключён 2026-09-08, откатываться некуда). fetcherOnce инъецируется в тестах
 * (ОДНА попытка HTTP без ретрая — ретрай оборачивает его ВСЕГДА, в т.ч. в тестах,
 * так что тесты проверяют РЕАЛЬНУЮ retry-логику, а не мок retry).
 *
 * ЕСЛИ ТЕКУЩИЙ RUNTIME НЕ ПОЗВОЛЯЕТ НАДЁЖНО ЗАВЕРШИТЬ ЗАГРУЗКУ МЕСЯЦА:
 * DEADLINE_MS=40000 — тот же мягкий бюджет, что и раньше. Полный месяц (28-31
 * pacer-старт по 1100мс = 30800-34100мс) уже близок к этому бюджету даже БЕЗ
 * единого 429/повтора; каждый добавленный retry (см. withPacedRetry429) может
 * унести общее время СИЛЬНО за 40с на практике. Здесь НЕ увеличен DEADLINE_MS
 * вслепую — это архитектурное решение, а не число: либо подтвердить реальный
 * лимит выполнения serverless-функции на Timeweb (неизвестен), либо
 * распараллелить/батчировать дни (не в этом PR, поменяло бы pacer/rate-limit
 * контракт), либо принять, что часть месяцев будет честно возвращать
 * deadline_exceeded (это теперь ВИДИМАЯ, а не тихая ошибка). Решение — за
 * владельцем, не за силовым увеличением таймаута.
 */
export async function loadAccrualDraft(
  params: { clientId: string; apiKey: string; month: string },
  fetcherOnce?: PageFetcherOnce
): Promise<AccrualLoadResult> {
  const days = daysOfMonth(params.month);
  if (days.length === 0) return { ok: false, code: "bad_month" };
  const budget: Budget = { used: 0, lastStart: 0, deadline: Date.now() + DEADLINE_MS };
  const once = fetcherOnce ?? makeRealFetcherOnce(params.clientId, params.apiKey, budget);
  const fetchPage = withPacedRetry429(once, budget);

  const records: unknown[] = [];
  const seenAccrualIds = new Set<number>();
  // Fetch-уровневый guard (НЕ record-уровневый): если один и тот же (day,
  // lastId-курсор-ДО-запроса) почему-то запрошен повторно, его записи не
  // добавляются ВТОРОЙ раз. Это НЕ дедуп разных операций одной отправки (они
  // всегда живут ВНУТРИ одного record — см. doc-comment safeAccrualId) и НЕ
  // дедуп по accrual_id самих записей (см. отдельный seenAccrualIds ниже) —
  // это защита именно от повторной обработки ОДНОГО и того же HTTP-ответа.
  const seenPageKeys = new Set<string>();

  for (const day of days) {
    let lastId = "";
    for (let p = 0; p < BY_DAY_MAX_PAGES_PER_DAY; p++) {
      const pageKey = `${day}:${lastId}`;
      const r = await fetchPage(day, lastId);
      if (!r.ok) return { ok: false, code: r.code };
      // Строгий контракт КАЖДОГО HTTP 200: root — объект с СОБСТВЕННЫМ массивом accruals.
      // Пустой [] — валидный день без операций. Отсутствие/null/не-массив → invalid →
      // весь accrual draft отбрасывается (частичный месяц не выдаём за полный; один
      // malformed день среди валидных обнуляет весь результат).
      const root = r.json;
      if (root === null || typeof root !== "object" || Array.isArray(root)) {
        return { ok: false, code: "malformed_response" };
      }
      const rootObj = root as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(rootObj, "accruals")) {
        return { ok: false, code: "malformed_response" };
      }
      const accruals = rootObj.accruals;
      if (!Array.isArray(accruals)) return { ok: false, code: "malformed_response" };
      if (!seenPageKeys.has(pageKey)) {
        seenPageKeys.add(pageKey);
        for (const it of accruals) {
          const idRaw = asObj(it).accrual_id;
          const id = safeAccrualId(idRaw);
          // id===null (отсутствует/невалиден) → record НЕ дедуплицируется (не
          // рискуем молча отбросить легитимную запись из-за отсутствия ID).
          if (id !== null) {
            if (seenAccrualIds.has(id)) continue; // уже учтён — повтор страницы/id
            seenAccrualIds.add(id);
          }
          records.push(it);
        }
      }
      // last_id: если присутствует — обязан быть строкой (доказанный тип пагинации).
      const rawLastId = rootObj.last_id;
      if (rawLastId !== undefined && typeof rawLastId !== "string") {
        return { ok: false, code: "malformed_response" };
      }
      const prevLastId = lastId;
      const nextId = typeof rawLastId === "string" ? rawLastId : "";
      if (nextId === "" || nextId === prevLastId || accruals.length === 0) break; // конец дня
      if (p === BY_DAY_MAX_PAGES_PER_DAY - 1) return { ok: false, code: "pagination_truncated" };
      lastId = nextId;
    }
  }
  return buildAccrualDraft(records);
}
