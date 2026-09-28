// Подмена сети для тестов серверных обработчиков: globalThis.fetch.
//
//   • https://api.yookassa.ru/…      → ответ, заданный тестом (настоящей ЮKassa нет);
//   • https://api-seller.ozon.ru/…   → ответ, заданный тестом (state.ozon; настоящего Ozon нет);
//   • http://supabase.test/auth/v1/user → пользователь из тестового JWT (как GoTrue getUser);
//   • http://supabase.test/rest/v1/… → минимальная эмуляция PostgREST поверх НАСТОЯЩЕЙ
//     PostgreSQL: каждый HTTP-запрос — своё соединение из пула и своя транзакция от имени
//     service_role (service-ключ) или authenticated с auth.uid() из JWT пользователя
//     (user-scoped клиент). Покрыто ровно то, что вызывают обработчики через supabase-js:
//     GET/PATCH/DELETE таблицы с фильтрами eq, upsert
//     (POST … on_conflict, Prefer: resolution=merge-duplicates) и POST /rpc/<функция>;
//   • любой другой адрес — ошибка (сеть в тестах запрещена).
// Журнал всех запросов (метод, адрес, заголовки, тело) доступен тесту.

export const SUPABASE_URL = "http://supabase.test";
export const SERVICE_KEY = "test-service-role-key";
const YOOKASSA = "https://api.yookassa.ru/";
const OZON = "https://api-seller.ozon.ru/";

/** Полезная нагрузка JWT без проверки подписи (тестовые токены). */
function jwtClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Тестовый JWT пользователя (без подписи): sub = userId, role = authenticated. */
export function userJwt(userId) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, role: "authenticated", aud: "authenticated" })}.test`;
}

/** numeric (OID 1700) → JSON-число, как отдаёт PostgREST (драйвер pg возвращает строку). */
const NUMERIC_OID = 1700;
function asPostgrestRows(res) {
  const numeric = (res.fields ?? []).filter((f) => f.dataTypeID === NUMERIC_OID).map((f) => f.name);
  if (numeric.length === 0) return res.rows ?? [];
  return (res.rows ?? []).map((row) => {
    const out = { ...row };
    for (const k of numeric) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
    return out;
  });
}

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
    /** Ответ Ozon Seller API: (req) => Response; null — обращение к Ozon в тесте запрещено. */
    ozon: null,
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
      // Роль как у PostgREST: service-ключ → service_role; JWT пользователя → authenticated
      // с auth.uid() = sub (подпись не проверяется — только локальная тестовая БД).
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const claims = jwtClaims(bearer);
      if (bearer === SERVICE_KEY || !claims) {
        await c.query(`set local role ${bearer === SERVICE_KEY ? "service_role" : "anon"}`);
      } else {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [claims.sub ?? ""]);
      }
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
          const m = /^(eq|neq)\.(.*)$/.exec(v);
          if (!m) throw new Error(`фильтр ${k}=${v} не поддержан`);
          params.push(m[2]);
          where.push(`${ident(k)} ${m[1] === "eq" ? "=" : "<>"} $${params.length}`);
        }
        // Prefer: return=representation → строки в ответе; Accept object+json → ровно одна.
        const wantRows = (req.headers.prefer ?? "").includes("return=representation");
        const wantOne = (req.headers.accept ?? "").includes("vnd.pgrst.object+json");
        const represent = (rows, created) => {
          if (!wantRows) return () => json(created ? 201 : 204);
          if (!wantOne) return () => json(created ? 201 : 200, rows);
          if (rows.length !== 1) {
            return () => json(406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
          }
          return () => json(created ? 201 : 200, rows[0]);
        };
        if (req.method === "GET") {
          const cols = (u.searchParams.get("select") ?? "*").split(",").map((x) => (x === "*" ? x : ident(x))).join(", ");
          const r = await c.query(`select ${cols} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}`, params);
          response = () => json(200, asPostgrestRows(r));
        } else if (req.method === "PATCH") {
          const sets = Object.entries(req.body).map(([k, v]) => {
            params.push(v);
            return `${ident(k)} = $${params.length}`;
          });
          const r = await c.query(`update public.${table} set ${sets.join(", ")} where ${where.join(" and ")}${wantRows ? " returning *" : ""}`, params);
          response = represent(asPostgrestRows(r), false);
        } else if (req.method === "POST") {
          const rows = Array.isArray(req.body) ? req.body : [req.body];
          const cols = Object.keys(rows[0]).map(ident);
          const values = rows.map((row) => `(${cols.map((col) => { params.push(row[col]); return `$${params.length}`; }).join(", ")})`);
          const onConflict = u.searchParams.get("on_conflict");
          const merge = (req.headers.prefer ?? "").includes("resolution=merge-duplicates");
          const conflict = onConflict
            ? ` on conflict (${onConflict.split(",").map(ident).join(", ")}) ${merge ? `do update set ${cols.map((col) => `${col} = excluded.${col}`).join(", ")}` : "do nothing"}`
            : "";
          const r = await c.query(`insert into public.${table} (${cols.join(", ")}) values ${values.join(", ")}${conflict}${wantRows ? " returning *" : ""}`, params);
          response = represent(asPostgrestRows(r), true);
        } else if (req.method === "DELETE") {
          if (!where.length) throw new Error("DELETE без фильтра не поддержан");
          await c.query(`delete from public.${table} where ${where.join(" and ")}`, params);
          response = () => json(204);
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
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      // admin.auth.getUser(jwt): пользователь из тестового JWT (подпись не проверяется).
      const claims = jwtClaims((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
      if (!claims?.sub) return json(401, { code: 401, msg: "invalid JWT" });
      return json(200, { id: claims.sub, aud: "authenticated", role: "authenticated", email: `${claims.sub.slice(0, 8)}@example.test`, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
    }
    if (url.startsWith(OZON)) {
      if (!state.ozon) throw new Error(`обращение к Ozon в этом тесте не ожидалось: ${url}`);
      return state.ozon(req);
    }
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
    /** Обращения к Ozon Seller API. */
    ozonCalls: () => state.log.filter((r) => r.url.startsWith(OZON)),
    reset() {
      state.log.length = 0;
      state.gates.length = 0;
      state.dropAfterCommit = null;
      state.override = null;
      state.ozon = null;
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
