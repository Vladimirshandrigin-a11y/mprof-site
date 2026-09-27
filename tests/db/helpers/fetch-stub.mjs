// Подмена сети для тестов webhook-обработчика: globalThis.fetch.
//
//   • https://api.yookassa.ru/…      → ответ, заданный тестом (настоящей ЮKassa нет);
//   • http://supabase.test/rest/v1/… → минимальная эмуляция PostgREST поверх НАСТОЯЩЕЙ
//     PostgreSQL: каждый HTTP-запрос — своё соединение из пула и своя транзакция от имени
//     service_role (как PostgREST с service-ключом). Покрыто ровно то, что вызывает
//     обработчик через supabase-js: GET/PATCH таблицы с фильтрами eq, upsert
//     (POST … on_conflict, Prefer: resolution=merge-duplicates) и POST /rpc/<функция>;
//   • любой другой адрес — ошибка (сеть в тестах запрещена).
// Журнал всех запросов (метод, адрес, заголовки, тело) доступен тесту.

export const SUPABASE_URL = "http://supabase.test";
export const SERVICE_KEY = "test-service-role-key";
const YOOKASSA = "https://api.yookassa.ru/";

const ident = (s) => {
  if (!/^[a-z_]+$/.test(s)) throw new Error(`идентификатор ${s}`);
  return s;
};

const json = (status, payload) =>
  new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
  });

/** Ошибка PostgreSQL → ответ PostgREST (коды как у Supabase для нужных случаев). */
function pgError(e, fn) {
  if (fn && e.code === "42883") {
    return json(404, {
      code: "PGRST202",
      details: null,
      hint: null,
      message: `Could not find the function public.${fn} in the schema cache`,
    });
  }
  return json(400, { code: e.code ?? "", details: e.detail ?? null, hint: e.hint ?? null, message: e.message });
}

export function installFetch() {
  const realFetch = globalThis.fetch;
  const state = {
    /** Все запросы: { method, url, path, headers, body }. */
    log: [],
    /** Ответ ЮKassa: (paymentId) => Response. */
    yookassa: null,
    /** pg.Pool текущей тестовой базы. */
    pool: null,
    /** Задержки: [{ match(req), wait: Promise }] — запрос ждёт перед выполнением SQL. */
    gates: [],
    /** После COMMIT: (req) => true — «потерять» ответ (fetch падает как при обрыве сети). */
    dropAfterCommit: null,
    /** Подменить ответ PostgREST целиком: (req) => Response | undefined. */
    override: null,
  };

  async function postgrest(req) {
    const u = new URL(req.url);
    const rest = u.pathname.slice("/rest/v1/".length);
    for (const g of state.gates) if (g.match(req)) await g.wait;
    const forced = state.override?.(req);
    if (forced) return forced;

    const c = await state.pool.connect();
    let response;
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      if (rest.startsWith("rpc/")) {
        const fn = ident(rest.slice(4));
        const args = req.body ?? {};
        const keys = Object.keys(args);
        const r = await c.query(
          `select public.${fn}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => args[k])
        );
        response = () => json(200, r.rows[0].r);
      } else {
        const table = ident(rest);
        const params = [];
        const where = [];
        for (const [k, v] of u.searchParams) {
          if (k === "select" || k === "on_conflict" || k === "columns") continue;
          if (!v.startsWith("eq.")) throw new Error(`фильтр ${k}=${v} не поддержан`);
          params.push(v.slice(3));
          where.push(`${ident(k)} = $${params.length}`);
        }
        if (req.method === "GET") {
          const cols = (u.searchParams.get("select") ?? "*").split(",").map((x) => (x === "*" ? x : ident(x))).join(", ");
          const r = await c.query(`select ${cols} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}`, params);
          response = () => json(200, r.rows);
        } else if (req.method === "PATCH") {
          const sets = Object.entries(req.body).map(([k, v]) => {
            params.push(v);
            return `${ident(k)} = $${params.length}`;
          });
          await c.query(`update public.${table} set ${sets.join(", ")} where ${where.join(" and ")}`, params);
          response = () => json(204);
        } else if (req.method === "POST") {
          const rows = Array.isArray(req.body) ? req.body : [req.body];
          const cols = Object.keys(rows[0]).map(ident);
          const values = rows.map((row) => `(${cols.map((col) => { params.push(row[col]); return `$${params.length}`; }).join(", ")})`);
          const onConflict = u.searchParams.get("on_conflict");
          const merge = (req.headers.prefer ?? "").includes("resolution=merge-duplicates");
          const conflict = onConflict
            ? ` on conflict (${onConflict.split(",").map(ident).join(", ")}) ${merge ? `do update set ${cols.map((col) => `${col} = excluded.${col}`).join(", ")}` : "do nothing"}`
            : "";
          await c.query(`insert into public.${table} (${cols.join(", ")}) values ${values.join(", ")}${conflict}`, params);
          response = () => json(201);
        } else {
          throw new Error(`метод ${req.method} не поддержан`);
        }
      }
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      c.release();
      return pgError(e, rest.startsWith("rpc/") ? rest.slice(4) : null);
    }
    c.release();
    if (state.dropAfterCommit?.(req)) throw new TypeError("fetch failed (ответ потерян после COMMIT)");
    return response();
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body == null ? null : JSON.parse(String(init.body));
    const req = { method, url, path: new URL(url).pathname, headers, body };
    state.log.push(req);
    if (url.startsWith(YOOKASSA)) {
      const id = decodeURIComponent(url.slice(`${YOOKASSA}v3/payments/`.length));
      return state.yookassa(id, req);
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return postgrest(req);
    throw new Error(`сеть в тестах запрещена: ${url}`);
  };

  return {
    state,
    restore() {
      globalThis.fetch = realFetch;
    },
    /** Запросы к БД (без ЮKassa). */
    dbRequests: () => state.log.filter((r) => r.url.startsWith(SUPABASE_URL)),
    rpcCalls: () => state.log.filter((r) => r.path.startsWith("/rest/v1/rpc/")),
    reset() {
      state.log.length = 0;
      state.gates.length = 0;
      state.dropAfterCommit = null;
      state.override = null;
    },
  };
}

/** Ручка «пауза до сигнала» для state.gates. */
export function gate(match) {
  let open;
  const wait = new Promise((res) => (open = res));
  let hit;
  const reached = new Promise((res) => (hit = res));
  return {
    match: (req) => {
      if (!match(req)) return false;
      hit(req);
      return true;
    },
    wait,
    reached,
    open: () => open(),
  };
}
