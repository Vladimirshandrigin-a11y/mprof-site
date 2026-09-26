// Минимальная in-memory замена service-role клиента Supabase для тестов серверных
// модулей: только те вызовы, которые реально делают catalog-import и save-calculation
// (from().select/insert/upsert/update/delete/eq/in/order/range/single/maybeSingle).
// products.upsert(onConflict "user_id,sku_key", ignoreDuplicates) эмулирует уникальный
// индекс из миграции (ключ — нормализация расчёта); migrationApplied=false — как в БД
// без миграции (42703). ЭТО МОК: конкурентную гарантию БД доказывает только tests/db.
// Каждая операция асинхронна (уступает event loop), поэтому одновременные запросы
// действительно чередуются. Журнал ops считает ВСЕ обращения по таблицам.
// Сети и реального Supabase нет.

const tick = () => new Promise((r) => setImmediate(r));

const normKey = (s) => {
  const k = (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return k === "" ? null : k;
};

export function makeFakeSupabase(seed = {}, opts = {}) {
  const state = { migrationApplied: opts.migrationApplied !== false };
  const tables = { products: [], calculations: [], report_history: [], ozon_connections: [], ...seed };
  /** @type {{table:string, op:string, count:number}[]} */
  const ops = [];
  /** Инъекция сбоев: { table, op, message, persist?, short? }. */
  const faults = [];
  /** beforeInsert(table, rows, tables) — вклиниться в момент вставки (имитация другого писателя). */
  const hooks = { beforeInsert: null };
  let clock = Date.UTC(2026, 8, 1, 10, 0, 0);
  let idSeq = 0;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const nowIso = () => new Date((clock += 7)).toISOString();

  class Q {
    constructor(table) {
      this.t = table;
      this.op = "select";
      this.filters = [];
      this.payload = null;
      this.returning = false;
      this.ord = null;
      this.rng = null;
      this.mode = null;
    }
    select() {
      this.returning = true;
      return this;
    }
    insert(rows) {
      this.op = "insert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    upsert(rows, o = {}) {
      this.op = "insert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      this.onConflict = o.onConflict ?? null;
      this.ignoreDuplicates = o.ignoreDuplicates === true;
      return this;
    }
    update(patch) {
      this.op = "update";
      this.payload = patch;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(c, v) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    in(c, vs) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    order(c, { ascending = true } = {}) {
      this.ord = { c, ascending };
      return this;
    }
    range(a, b) {
      this.rng = [a, b];
      return this;
    }
    single() {
      this.mode = "one";
      return this;
    }
    maybeSingle() {
      this.mode = "maybe";
      return this;
    }
    then(res, rej) {
      return this.exec().then(res, rej);
    }
    async exec() {
      await tick();
      const fi = faults.findIndex((f) => f.table === this.t && f.op === this.op);
      const fault = fi >= 0 ? faults[fi] : null;
      if (fault && !fault.persist && !fault.short && !fault.drop) faults.splice(fi, 1);
      if (fault && !fault.short && !fault.drop) {
        ops.push({ table: this.t, op: this.op, count: 0, failed: true });
        return { data: null, error: { message: fault.message, ...(fault.code ? { code: fault.code } : {}) } };
      }
      const rows = (tables[this.t] ??= []);
      const match = (r) => this.filters.every((f) => f(r));
      let data;
      let count = 0;
      if (this.op === "insert" && this.onConflict) {
        if (this.t !== "products" || this.onConflict !== "user_id,sku_key" || !this.ignoreDuplicates) {
          ops.push({ table: this.t, op: "insert", count: 0, failed: true });
          return { data: null, error: { code: "42P10", message: "unsupported upsert in fake" } };
        }
        if (!state.migrationApplied) {
          ops.push({ table: this.t, op: "insert", count: 0, failed: true });
          return { data: null, error: { code: "42703", message: 'column "sku_key" does not exist' } };
        }
      }
      if (this.op === "insert") {
        if (hooks.beforeInsert) await hooks.beforeInsert(this.t, this.payload, tables, { nowIso, nextId: () => `id-${String(++idSeq).padStart(6, "0")}` });
        let payload = this.payload;
        // drop: БД «молча» не вставила последнюю строку и не вернула её (для проверки подтверждения).
        if (fault && fault.drop) payload = payload.slice(0, Math.max(0, payload.length - 1));
        if (this.onConflict) {
          // ON CONFLICT (user_id, sku_key) DO NOTHING: пропускаем совпадения с таблицей и внутри пачки.
          const taken = new Set(rows.map((r) => `${r.user_id}|${normKey(r.sku)}`));
          payload = payload.filter((p) => {
            const k = normKey(p.sku);
            if (k === null) return true;
            const key = `${p.user_id}|${k}`;
            if (taken.has(key)) return false;
            taken.add(key);
            return true;
          });
        }
        const inserted = payload.map((p) => ({
          id: p.id ?? `id-${String(++idSeq).padStart(6, "0")}`,
          created_at: nowIso(),
          ...(this.t === "products" ? { cost_price: 0, name: "" } : {}),
          ...clone(p),
        }));
        rows.push(...inserted);
        count = inserted.length;
        data = fault && fault.short ? inserted.slice(0, Math.max(0, inserted.length - 1)) : inserted;
      } else if (this.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, clone(this.payload));
        count = hit.length;
        data = hit;
      } else if (this.op === "delete") {
        const keep = rows.filter((r) => !match(r));
        count = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        data = [];
      } else {
        let out = rows.filter(match);
        if (this.ord) {
          const { c, ascending } = this.ord;
          out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
        data = out;
        count = out.length;
      }
      ops.push({ table: this.t, op: this.op, count });
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      data = clone(data);
      if (this.mode === "one") {
        if (data.length !== 1) return { data: null, error: { message: "no rows" } };
        return { data: data[0], error: null };
      }
      if (this.mode === "maybe") return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
  }

  const admin = { from: (t) => new Q(t) };
  return {
    admin,
    tables,
    ops,
    faults,
    hooks,
    state,
    /** Число обращений (не сбоев) заданного вида к таблице. */
    count: (table, op) => ops.filter((o) => o.table === table && o.op === op && !o.failed).length,
    /** Число записывающих операций (insert/update/delete) по таблице. */
    writes: (table) => ops.filter((o) => o.table === table && o.op !== "select" && !o.failed).length,
    rowsOf: (table, userId) => tables[table].filter((r) => (userId ? r.user_id === userId : true)),
  };
}
