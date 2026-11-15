// Real API handlers -> supabase-js -> isolated PostgreSQL, never production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildRequire as req, payTestEnv, read, root, runScript } from './helpers/pay-db.mjs';
import { installFetch, SERVICE_KEY, SUPABASE_URL, userJwt } from './helpers/fetch-stub.mjs';
import { scenario } from '../accrual/helpers/fixtures.mjs';
import { CAT } from '../accrual/helpers/expected.mjs';
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
const { NextRequest } = createRequire(path.join(root, 'package.json'))('next/server');
const OPS = req('./api/cloud/calculation-operations/route.js');
const CALCS = req('./api/cloud/calculations/route.js');
const HISTORY = req('./api/cloud/report-history/route.js');
const COL = req('./app/lib/accrual/columns.js');
const SES = req('./app/lib/accrual/upload-session.js');
const PARSER = req('./app/lib/report-parsers/accrual-xlsx-parser.js');
const SNAP = req('./app/lib/accrual/snapshot.js');
const CLIENT = req('./app/lib/supabase-cloud.js');
const { AccrualSaveController } = req('./app/lib/accrual/save-flow.js');
const net = installFetch();
const originalEditSwitch = process.env.MPROF_CALCULATION_EDITS_ENABLED;
const { freshDb } = payTestEnv();
after(() => {
  net.restore();
  if (originalEditSwitch === undefined) delete process.env.MPROF_CALCULATION_EDITS_ENABLED;
  else process.env.MPROF_CALCULATION_EDITS_ENABLED = originalEditSwitch;
});
const migrations = ['20260928_calculation_operations.sql', '20260929_calculation_operations_manual_api.sql', '20261113221918_quota_atomic_edits.sql'].map(n => read(`supabase/migrations/${n}`));
const versionMigration = read('supabase/migrations/20261115180805_operation_saved_edit_version.sql');
const manual = { marketplace: 'ozon', revenue: 1000, commission: 100, logistics: 10, storage: 0, ads: 20, cost: 200, tax: 60, other: 10 };
function snapshot({ taxPercent = '7', cost = 100, other = '3.33' } = {}) {
  const parsed = PARSER.parseAccrualXlsxBuffer(new Uint8Array(scenario('basic')));
  assert.equal(parsed.ok, true);
  const r = parsed.report;
  const result = SES.evaluateAccrual({ report: { rows: r.rows, period: r.period, warnings: parsed.warnings, sheet: r.sheetName, rowCount: r.summary.rowCount },
    catalog: CAT.map(p => p.sku === 'ART-A' ? { ...p, cost_price: cost } : p),
    inputs: { taxPercent, packaging: '10', deliveryToWarehouse: '', salary: '', other, adsOutsideOzon: '' }, generatedAt: '2026-07-01T10:00:00.000Z' });
  assert.equal(result.readyToSave, true);
  assert.equal(SNAP.readAccrualSnapshot(result.snapshot).status, 'ok');
  return result.snapshot;
}
async function call(route, method, u, body) {
  const res = await route[method](new NextRequest('http://localhost/api/cloud/test', {
    method, headers: { 'content-type': 'application/json', ...(u ? { authorization: `Bearer ${userJwt(u)}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json() };
}
const uploadBody = s => ({ operationId: randomUUID(), requestHash: 'source-basic-2026-06', calculation: COL.accrualSnapshotToCalculationColumns(s), history: COL.accrualSnapshotToReportHistoryColumns(s) });
async function create(u, s = snapshot()) {
  const body = uploadBody(s);
  const result = await call(OPS, 'POST', u, body);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(typeof result.body.data?.calculationId, 'string');
  return { ...result.body.data, request: body };
}
const editMeta = (expectedVersion = 0) => ({ expectedVersion, editOperationId: randomUUID() });
const edit = (u, id, s = snapshot({ taxPercent: '10', cost: 120 }), meta = editMeta()) => call(CALCS, 'PATCH', u, { id, snapshot: s, ...meta });
async function asRole(db, role, u, sql, args = []) {
  const c = await db.client(role);
  await c.query("select set_config('request.jwt.claim.sub', $1, false)", [u ?? '']);
  return c.query(sql, args);
}
async function state(db, u) {
  const out = {};
  for (const t of ['calculations', 'report_history', 'calculation_operations']) out[t] = (await db.main.query(`select * from public.${t} where user_id = $1 order by id`, [u])).rows;
  out.used = Number((await db.main.query('select calculations_used from public.profiles where id = $1', [u])).rows[0].calculations_used);
  return out;
}
describe('P1 quota and immutable history boundaries', () => {
  let db;
  before(async () => { db = await freshDb({ extraMigrations: migrations }); });
  beforeEach(() => {
    net.state.pool = db.pool(15); net.state.dropAfterCommit = null;
    process.env.MPROF_CALCULATION_EDITS_ENABLED = 'true';
  });
  it('disabled PATCH preserves calculation, history, receipt and quota; anonymous stays 401', async () => {
    const u = await db.user(); const saved = await create(u); const before = await state(db, u);
    const receipts = () => db.main.query('select count(*)::int as n from public.calculation_edit_operations where user_id=$1', [u]);
    const beforeReceipts = (await receipts()).rows[0].n;
    for (const value of [undefined, 'false', 'TRUE', ' true', '1']) {
      if (value === undefined) delete process.env.MPROF_CALCULATION_EDITS_ENABLED;
      else process.env.MPROF_CALCULATION_EDITS_ENABLED = value;
      const r = await edit(u, saved.calculationId);
      assert.deepEqual([r.status, r.body.code], [503, 'edits_disabled']);
      assert.deepEqual(await state(db, u), before);
      assert.equal((await receipts()).rows[0].n, beforeReceipts);
      assert.equal((await call(CALCS, 'PATCH', null, {})).status, 401);
    }
    process.env.MPROF_CALCULATION_EDITS_ENABLED = 'true';
    assert.equal((await edit(u, saved.calculationId)).status, 200);
    assert.equal((await state(db, u)).used, before.used);
  });
  it('old POST routes are closed, require authentication, and never insert/consume', async () => {
    const u = await db.user();
    const before = await state(db, u);
    for (const route of [CALCS, HISTORY]) {
      assert.equal((await call(route, 'POST', null, {})).status, 401);
      for (const body of [null, {}, { user_id: u, mode: 'manual', profit: 100 }]) {
        const r = await call(route, 'POST', u, body);
        assert.deepEqual([r.status, r.body.code], [410, 'calculation_operation_required']);
      }
    }
    assert.deepEqual(await state(db, u), before);
    assert.equal((await call(OPS, 'POST', u, null)).status, 400);
  });
  it('direct inserts/updates denied for every mode and history; owner reads/deletes still work', async () => {
    const u = await db.user(), other = await db.user();
    const saved = await create(u); const id = saved.calculationId;
    assert.ok(id, JSON.stringify(saved));
    for (const role of ['anon', 'authenticated']) {
      for (const mode of ['manual', 'upload', 'api']) await assert.rejects(asRole(db, role, u,
        "insert into public.calculations(user_id,marketplace,mode) values($1,'ozon',$2)", [u, mode]), { code: '42501' });
      await assert.rejects(asRole(db, role, u, 'update public.calculations set profit=999 where id=$1', [id]), { code: '42501' });
      await assert.rejects(asRole(db, role, u, 'insert into public.report_history(user_id) values($1)', [u]), { code: '42501' });
      await assert.rejects(asRole(db, role, u, 'update public.report_history set profit=999 where user_id=$1', [u]), { code: '42501' });
      await assert.rejects(asRole(db, role, u, 'select public.edit_calculation_operation($1,$2,$3,null,0,gen_random_uuid())', [u, id, {}]), { code: '42501' });
    }
    assert.equal((await asRole(db, 'authenticated', other, 'select id from public.calculations where id=$1', [id])).rowCount, 0);
    assert.equal((await asRole(db, 'authenticated', u, 'select id from public.calculations where id=$1', [id])).rowCount, 1);
    assert.equal((await asRole(db, 'authenticated', other, 'delete from public.calculations where id=$1 returning id', [id])).rowCount, 0);
    assert.equal((await asRole(db, 'authenticated', u, 'delete from public.calculations where id=$1 returning id', [id])).rowCount, 1);
    assert.equal((await edit(u, id)).status, 404);
    const replay = await call(OPS, 'POST', u, saved.request);
    assert.equal(replay.body.data.status, 'deleted');
    assert.equal((await state(db, u)).used, 1);
    assert.equal((await state(db, u)).report_history.length, 1, 'deleting calculation preserves its monthly history');
    await db.sub(u, 'single', { status: 'active' });
    await create(u);
    const afterNew = await state(db, u);
    assert.deepEqual([afterNew.used, afterNew.calculations.length, afterNew.report_history.length], [2, 1, 2]);
  });
  it('edits keep IDs, source and chronology; update existing history; no quota even when exhausted', async () => {
    const u = await db.user(); const saved = await create(u); const before = await state(db, u);
    const s = snapshot({ taxPercent: '10', cost: 120 });
    const result = await edit(u, saved.calculationId, s);
    assert.equal(result.status, 200, JSON.stringify(result));
    const now = await state(db, u);
    assert.equal(now.used, before.used);
    assert.equal(now.calculations.length, 1); assert.equal(now.report_history.length, 1);
    assert.equal(now.calculations[0].id, before.calculations[0].id);
    assert.equal(now.report_history[0].id, before.report_history[0].id);
    assert.equal(now.report_history[0].created_at, before.report_history[0].created_at);
    assert.equal(Number(now.calculations[0].profit), 514.13);
    assert.equal(Number(now.report_history[0].profit), 514.13);
    assert.deepEqual(now.calculations[0].ai_insights, s);
    const replay = await call(OPS, 'POST', u, saved.request);
    assert.equal(replay.body.data.replay, true); assert.equal(replay.body.data.contentMatch, false);
    assert.deepEqual(await state(db, u), now);
    assert.equal((await call(OPS, 'POST', u, { ...saved.request, operationId: randomUUID() })).status, 402);
  });
  it('unauthenticated, foreign, generic-column and spoofed-user edits do not write', async () => {
    const u = await db.user(), foreign = await db.user(); const saved = await create(u);
    const before = await state(db, u);
    assert.equal((await edit(null, saved.calculationId)).status, 401);
    assert.equal((await edit(foreign, saved.calculationId)).status, 404);
    for (const body of [null, [], { id: saved.calculationId, fields: { profit: 1 } }, { id: saved.calculationId, snapshot: snapshot(), user_id: u }, { id: saved.calculationId, inputs: { ...manual, user_id: u } }]) {
      assert.equal((await call(CALCS, 'PATCH', u, body && !Array.isArray(body) ? { ...body, ...editMeta() } : body)).status, 400);
    }
    assert.deepEqual(await state(db, u), before);
  });
  it('edit version and operation key are mandatory and strictly validated', async () => {
    const u = await db.user(); const saved = await create(u); const before = await state(db,u);
    for (const meta of [{}, { ...editMeta(), expectedVersion: -1 }, { ...editMeta(), expectedVersion: 0.5 },
      { ...editMeta(), expectedVersion: '0' }, { ...editMeta(), expectedVersion: 2147483647 },
      { expectedVersion: 0, editOperationId: 'not-a-uuid' }]) {
      assert.equal((await call(CALCS,'PATCH',u,{id:saved.calculationId,snapshot:snapshot(),...meta})).status,400);
    }
    assert.deepEqual(await state(db,u),before);
  });
  it('source/period/marketplace/mode changes and damaged snapshots fail closed', async () => {
    const u = await db.user(); const saved = await create(u); const before = await state(db, u);
    for (const mutate of [s => { s.source.sheet += '-different'; }, s => { s.period.month = '2026-07'; }, s => { s.products[0].article = 'DIFFERENT'; }]) {
      const s = snapshot(); mutate(s);
      const r = await edit(u, saved.calculationId, s);
      assert.ok([400, 409].includes(r.status), JSON.stringify(r));
    }
    const broken = snapshot(); broken.netProfitKopecks++;
    assert.equal((await edit(u, saved.calculationId, broken)).status, 400);
    const service = await db.service();
    for (const patch of [{ mode: 'manual' }, { marketplace: 'wb' }, { revenue: 999 }]) {
      const r = await service.query('select public.edit_calculation_operation($1,$2,$3,$4,0,gen_random_uuid()) as r', [u, saved.calculationId, { ...saved.request.calculation, ...patch }, saved.request.history]);
      assert.equal(r.rows[0].r.reason, 'source_conflict');
    }
    assert.deepEqual(await state(db, u), before);
  });
  it('legacy rows remain intact and cannot acquire invented operations or quota', async () => {
    const u = await db.user(); const s = snapshot();
    const id = (await db.main.query("insert into public.calculations(user_id,marketplace,mode,revenue,ai_insights) values($1,'ozon','upload',1200,$2) returning id", [u, s])).rows[0].id;
    const before = await state(db, u);
    const r = await edit(u, id);
    assert.deepEqual([r.status, r.body.code], [403, 'legacy_read_only']);
    assert.equal(r.body.error, 'Редактирование этого исторического расчёта временно недоступно. Исходные данные сохранены');
    assert.deepEqual(await state(db, u), before);
    assert.equal((await call(CALCS, 'GET', u)).body.data.length, 1);
  });
  it('missing or foreign linked history prevents edits without recreating or touching other rows', async () => {
    const u = await db.user(), other = await db.user(); const saved = await create(u); const foreign = await create(other);
    await db.main.query('update public.calculation_operations set report_history_id=(select report_history_id from public.calculation_operations where id=$2) where id=$1', [saved.request.operationId, foreign.request.operationId]);
    const a = await state(db, u), b = await state(db, other);
    assert.equal((await edit(u, saved.calculationId)).body.code, 'history_missing');
    assert.deepEqual(await state(db, u), a); assert.deepEqual(await state(db, other), b);
    await db.main.query('update public.calculation_operations set report_history_id=null where id=$1', [saved.request.operationId]);
    assert.equal((await edit(u, saved.calculationId)).body.code, 'history_missing');
  });
  it('database failure in history rolls back calculation, operation hash and quota; retry succeeds', async () => {
    const u = await db.user(); const saved = await create(u); const before = await state(db, u); const meta = editMeta();
    await db.main.query("create function public.fail_history_edit() returns trigger language plpgsql as $$ begin raise exception 'test history failure'; end $$; create trigger fail_edit before update on public.report_history for each row execute function public.fail_history_edit()");
    try { assert.equal((await edit(u, saved.calculationId, snapshot(), meta)).status, 502); assert.deepEqual(await state(db, u), before); }
    finally { await db.main.query('drop trigger fail_edit on public.report_history; drop function public.fail_history_edit()'); }
    assert.equal((await db.main.query('select count(*)::int as n from public.calculation_edit_operations where user_id=$1',[u])).rows[0].n,0);
    assert.equal((await edit(u, saved.calculationId, snapshot(), meta)).status, 200);
    assert.equal((await state(db, u)).used, 1);
  });
  it('parallel edits of one version accept exactly one; duplicate edit replays once', async () => {
    const u = await db.user(); const saved = await create(u);
    const results = await Promise.all(['8','9','10','11'].map(taxPercent => edit(u, saved.calculationId, snapshot({ taxPercent }))));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 409 && r.body.code === 'version_conflict').length, 3);
    const meta = editMeta(1);
    const duplicates = await Promise.all([edit(u, saved.calculationId, snapshot(), meta), edit(u, saved.calculationId, snapshot(), meta)]);
    assert.ok(duplicates.every(r => r.status === 200), JSON.stringify(duplicates));
    const st = await state(db, u);
    assert.equal(st.calculations[0].edit_version, 2);
    assert.equal(st.calculations[0].profit, st.report_history[0].profit);
    assert.equal(st.used, 1); assert.equal(st.calculations.length, 1); assert.equal(st.report_history.length, 1);
    assert.equal((await db.main.query('select count(*)::int as n from public.calculation_edit_operations where user_id=$1',[u])).rows[0].n, 2);
  });
  it('A commits / response lost / B succeeds / replay A cannot overwrite B or charge', async () => {
    const u = await db.user(); const saved = await create(u); const a = editMeta();
    net.state.dropAfterCommit = r => r.url.includes('/rpc/edit_calculation_operation');
    assert.equal((await edit(u, saved.calculationId, snapshot({ taxPercent: '8' }), a)).status, 502);
    net.state.dropAfterCommit = null;
    assert.equal((await edit(u, saved.calculationId, snapshot({ taxPercent: '10' }), editMeta(1))).status, 200);
    const b = await state(db, u);
    const retry = await edit(u, saved.calculationId, snapshot({ taxPercent: '8' }), a);
    assert.deepEqual([retry.status, retry.body.code], [409, 'version_conflict']);
    assert.deepEqual(await state(db, u), b);
    assert.equal(b.calculations[0].ai_insights.tax.ratePercent, 10); assert.equal(b.used, 1);
    assert.equal((await edit(u, saved.calculationId, snapshot({ taxPercent: '8' }), editMeta())).status, 409);
    // Same edit key with another payload never becomes another edit.
    assert.equal((await edit(u, saved.calculationId, snapshot({ taxPercent: '12' }), a)).body.code, 'edit_operation_conflict');
  });
  it('lost edit response immediately replays the same receipt, without another write', async () => {
    const u = await db.user(); const saved = await create(u); const meta = editMeta();
    net.state.dropAfterCommit = r => r.url.includes('/rpc/edit_calculation_operation');
    assert.equal((await edit(u, saved.calculationId, snapshot(), meta)).status, 502);
    net.state.dropAfterCommit = null;
    const committed = await state(db, u);
    assert.equal((await edit(u, saved.calculationId, snapshot(), meta)).status, 200);
    assert.deepEqual(await state(db, u), committed); assert.equal(committed.calculations[0].edit_version, 1);
  });
  it('edit receipts and version cannot be forged via direct Supabase roles', async () => {
    const u = await db.user(); const saved = await create(u);
    for (const role of ['anon','authenticated']) {
      for (const sql of ['select * from public.calculation_edit_operations',
        "insert into public.calculation_edit_operations(id,user_id,calculation_id,request_hash,result_version) values(gen_random_uuid(),$1,$2,'fake',1)",
        'update public.calculation_edit_operations set result_version=99 where user_id=$1',
        'delete from public.calculation_edit_operations where user_id=$1']) {
        const args = sql.includes('$2') ? [u,saved.calculationId] : sql.includes('$1') ? [u] : [];
        await assert.rejects(asRole(db,role,u,sql,args), {code:'42501'});
      }
      await assert.rejects(asRole(db,role,u,'update public.calculations set edit_version=99 where id=$1',[saved.calculationId]), {code:'42501'});
    }
    assert.equal((await edit(u, saved.calculationId)).status, 200);
    assert.equal((await asRole(db,'authenticated',u,'delete from public.calculations where id=$1 returning id',[saved.calculationId])).rowCount,1);
    assert.equal((await db.main.query('select count(*)::int as n from public.calculation_edit_operations where user_id=$1',[u])).rows[0].n,0);
  });
  it('editing an earlier same-month calculation never replaces the latest monthly row', async () => {
    const u = await db.user({ plan: 'unlimited', premium: '10 days' }); const a = await create(u); const b = await create(u, snapshot({ taxPercent: '12' }));
    const before = await state(db, u); const latestId = before.calculation_operations.find(op => op.calculation_id === b.calculationId).report_history_id; const latest = before.report_history.find(h => h.id === latestId);
    assert.equal((await edit(u, a.calculationId)).status, 200);
    const now = await state(db, u);
    assert.deepEqual(now.report_history.find(h => h.id === latest.id), latest);
    assert.equal(now.calculations.length, 2); assert.equal(now.report_history.length, 2); assert.equal(now.used, 0);
    assert.notEqual(a.calculationId, b.calculationId);
  });
  it('manual operation edits preserve revenue, marketplace and one charge; API edits rejected', async () => {
    const u = await db.user(); const r = await call(OPS, 'POST', u, { mode: 'manual', operationId: randomUUID(), inputs: manual });
    assert.equal(r.status, 200); const id = r.body.data.calculationId;
    assert.equal((await call(CALCS, 'PATCH', u, { id, inputs: { ...manual, cost: 250 }, ...editMeta() })).status, 200);
    for (const inputs of [{ ...manual, revenue: 2000 }, { ...manual, marketplace: 'wb' }]) assert.equal((await call(CALCS, 'PATCH', u, { id, inputs, ...editMeta(1) })).status, 409);
    assert.equal((await state(db, u)).used, 1); assert.equal((await state(db, u)).report_history.length, 0);
    const apiId = (await db.main.query("insert into public.calculations(user_id,marketplace,mode) values($1,'ozon','api') returning id", [u])).rows[0].id;
    assert.equal((await edit(u, apiId)).body.code, 'api_mode_forbidden');
  });
  it('free/single/unlimited/expired quota and concurrent first saves survive lockdown', async () => {
    for (const [plan, premium, credits, expected] of [['free',null,0,1], ['free',null,1,2], ['unlimited','10 days',0,4], ['unlimited','-1 day',0,1]]) {
      const u = await db.user({ plan, premium });
      if (credits) await db.sub(u, 'single', { status: 'active' });
      const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => call(OPS, 'POST', u, i % 2 ? uploadBody(snapshot()) : { mode: 'manual', operationId: randomUUID(), inputs: manual })));
      assert.equal(rs.filter(r => r.status === 200).length, expected, JSON.stringify(rs));
      const st = await state(db, u); assert.equal(st.calculations.length, expected); assert.equal(st.calculation_operations.length, expected); assert.equal(st.used, expected === 4 ? 0 : expected);
    }
  });
});

describe('P1 migration defense in depth and compatibility', () => {
  it('removes column/PUBLIC grants; restrictive policies survive accidental broad grants', async () => {
    const db = await freshDb({ extraMigrations: migrations.slice(0,2) }); const u = await db.user();
    await db.main.query('grant insert(user_id), update(profit) on public.calculations to public; grant insert(user_id), update(profit) on public.report_history to authenticated');
    await runScript(db.main, migrations[2]); await runScript(db.main, migrations[2]);
    await db.main.query("insert into public.calculations(user_id,marketplace,mode,profit) values($1,'ozon','manual',12)",[u]);
    await db.main.query("insert into public.report_history(user_id,report_month,profit) values($1,'2026-06-01',12)",[u]);
    for (const t of ['calculations','report_history']) {
      for (const role of ['anon','authenticated']) {
        const r = await db.main.query("select has_any_column_privilege($1,$2,'INSERT') as i, has_any_column_privilege($1,$2,'UPDATE') as u", [role, `public.${t}`]);
        assert.deepEqual(r.rows[0], { i: false, u: false });
      }
      await db.main.query(`grant insert, update on public.${t} to authenticated; create policy test_broad on public.${t} for all to authenticated using(true) with check(true)`);
      await assert.rejects(asRole(db,'authenticated',u, `insert into public.${t}(user_id) values($1)`,[u]), {code:'42501'});
      assert.equal((await asRole(db,'authenticated',u,`update public.${t} set profit=999 returning id`)).rowCount,0);
      assert.equal(Number((await db.main.query(`select profit from public.${t} where user_id=$1`,[u])).rows[0].profit),12);
    }
    await db.main.query('grant execute on function public.edit_calculation_operation(uuid,uuid,jsonb,jsonb,integer,uuid) to authenticated');
    await assert.rejects(asRole(db,'authenticated',u,'select public.edit_calculation_operation($1,$2,$3,null,0,gen_random_uuid())',[u,randomUUID(),{}]), {code:'42501'});
  });
  it('migration preserves old data verbatim; no migration => edit fails closed; full schema matches', async () => {
    const db = await freshDb({ extraMigrations: migrations.slice(0,2) }); net.state.pool = db.pool(4);
    const u = await db.user(); const saved = await create(u); const before = await state(db,u);
    assert.equal((await edit(u,saved.calculationId)).body.code, 'migration_missing');
    await runScript(db.main,migrations[2]); await runScript(db.main,migrations[2]);
    const afterMigration = await state(db,u);
    for (const row of afterMigration.calculations) { assert.equal(row.edit_version,0); delete row.edit_version; }
    assert.deepEqual(afterMigration,before);
    const full = await freshDb({ migrated:false, fullSchema:true });
    const fingerprint = async c => (await c.query("select pg_get_functiondef(oid) as def, proacl::text from pg_proc where proname in ('edit_calculation_operation','calculation_edit_source') order by proname")).rows;
    assert.deepEqual(await fingerprint(db.main),await fingerprint(full.main));
    assert.equal((await edit(u,saved.calculationId)).status,200);
  });
});

// Real client + save controller -> actual Next handlers -> supabase-js -> SQL.
// Only auth and the PostgREST transport are local adapters; responses/versions,
// financial snapshots, transactions, grants and row locks come from PostgreSQL.
describe('operation version: creation -> history -> client PATCH -> replay/conflict', () => {
  let db, user, http, dropEditResponse, pgFetch;
  const originalSession = CLIENT.supabase.auth.getSession;
  const operationId = randomUUID();
  const request = (s = snapshot(), id = operationId) => ({ ...uploadBody(s), operationId: id });
  const saveRequest = (s = snapshot()) => ({ snapshot: s, ready: true, userId: user });
  const lastPatch = () => http.filter(x => x.method === 'PATCH').at(-1);
  function controller(id = operationId) {
    let pending = true;
    const ctl = new AccrualSaveController({
      canCalculate: () => true,
      confirmNoMonthDuplicate: async () => true,
      consume: async () => assert.fail('account path must never consume separately'),
      saveOperation: CLIENT.saveCalculationOperation,
      operationIdFor: () => id,
      operationSettled: () => { pending = false; },
      hasPendingOperation: () => pending,
      operationStatus: CLIENT.getCalculationOperationStatus,
      newEditOperationId: randomUUID,
      updateCalculation: (id, cols, meta) => CLIENT.updateCalculationInCloud(id, cols, user, meta),
      newLocalId: () => assert.fail('account path must never create a local fallback'),
      nowIso: () => new Date().toISOString(),
    });
    ctl.beginAttempt('source-basic-2026-06');
    return ctl;
  }
  async function recover(id = operationId) {
    const done = await CLIENT.getCalculationOperationStatus(id, 'source-basic-2026-06');
    assert.equal(done.kind, 'done');
    const ctl = controller(id);
    assert.equal(ctl.adoptSaved('source-basic-2026-06', { ...done, operationId: id }), true);
    return ctl;
  }
  async function receipts() {
    return (await db.main.query('select * from public.calculation_edit_operations where user_id=$1 order by id', [user])).rows;
  }
  before(() => {
    pgFetch = globalThis.fetch;
    CLIENT.supabase.auth.getSession = async () => ({ data: { session: { access_token: userJwt(user) } }, error: null });
    globalThis.fetch = async (input, init = {}) => {
      if (typeof input !== 'string' || !input.startsWith('/api/cloud/')) return pgFetch(input, init);
      const method = init.method ?? 'GET';
      const pathname = new URL(input, 'http://app.test').pathname;
      const route = pathname === '/api/cloud/calculation-operations' ? OPS
        : pathname === '/api/cloud/calculations' ? CALCS : HISTORY;
      const res = await route[method](new NextRequest('http://app.test' + input, init));
      http.push({ method, status: res.status, body: init.body ? JSON.parse(init.body) : null, response: await res.clone().json() });
      if (method === 'PATCH' && res.ok && dropEditResponse) {
        dropEditResponse = false;
        throw new TypeError('response lost after successful API/SQL COMMIT');
      }
      return res;
    };
  });
  beforeEach(async () => {
    db = await freshDb({ extraMigrations: [...migrations, versionMigration] });
    user = await db.user(); net.state.pool = db.pool(8); net.reset();
    http = []; dropEditResponse = false;
    process.env.MPROF_CALCULATION_EDITS_ENABLED = 'true'; // isolated handlers only
  });
  afterEach(() => { net.reset(); });
  after(() => {
    globalThis.fetch = pgFetch;
    CLIENT.supabase.auth.getSession = originalSession;
    CLIENT.supabase.auth.stopAutoRefresh();
  });
  it('new creation, sequential/concurrent replay expose real version through the client', async () => {
    const body = request();
    const first = await CLIENT.saveCalculationOperation(body);
    assert.equal(first.kind, 'ok');
    assert.equal(first.row.edit_version, 0); // fails against current production SQL
    const before = await state(db, user);
    const replies = [await CLIENT.saveCalculationOperation(body),
      ...await Promise.all([CLIENT.saveCalculationOperation(body), CLIENT.saveCalculationOperation(body)])];
    for (const r of replies) {
      assert.equal(r.kind, 'ok'); assert.equal(r.replay, true);
      assert.equal(r.row.id, first.row.id); assert.equal(r.row.edit_version, 0);
    }
    const done = await CLIENT.getCalculationOperationStatus(operationId, body.requestHash);
    assert.equal(done.kind, 'done'); assert.equal(done.row.edit_version, 0);
    assert.deepEqual(await state(db, user), before);
    assert.deepEqual([before.used, before.calculations.length, before.report_history.length], [1, 1, 1]);
  });
  it('history recovery, edit, same-key replay and stale-version HTTP 409 preserve one charge', async () => {
    const firstTab = controller();
    assert.equal((await firstTab.save(saveRequest())).status, 'saved');
    const initial = await state(db, user);
    const list = await CLIENT.loadCalculationsFromCloud(user);
    assert.equal(list.error, null); assert.equal(list.data[0].edit_version, 0);
    assert.deepEqual(list.data[0].ai_insights, snapshot());
    const tab = await recover();
    const edited = snapshot({ taxPercent: '10', cost: 120 });
    assert.equal((await tab.save(saveRequest(edited))).status, 'saved');
    const patch = lastPatch();
    assert.equal(patch.status, 200); assert.equal(patch.body.expectedVersion, 0);
    assert.equal(patch.response.data.edit_version, 1);
    const after = await state(db, user);
    assert.equal(after.calculations[0].id, initial.calculations[0].id);
    assert.equal(after.report_history[0].id, initial.report_history[0].id);
    assert.equal(after.report_history[0].created_at, initial.report_history[0].created_at);
    assert.equal(Number(after.calculations[0].profit), 514.13);
    assert.equal(Number(after.report_history[0].profit), 514.13);
    const replayEdit = await CLIENT.updateCalculationInCloud(patch.body.id, COL.accrualSnapshotToCalculationColumns(edited), user,
      { expectedVersion: patch.body.expectedVersion, editOperationId: patch.body.editOperationId });
    assert.equal(replayEdit.error, null); assert.equal(replayEdit.data.edit_version, 1);
    assert.equal((await receipts()).length, 1);
    assert.deepEqual(await state(db, user), after);
    const done = await CLIENT.getCalculationOperationStatus(operationId, 'source-basic-2026-06');
    assert.equal(done.row.edit_version, 1); assert.deepEqual(done.snapshot, edited);
    const replayCreate = await CLIENT.saveCalculationOperation(request());
    assert.equal(replayCreate.row.edit_version, 1); assert.equal(replayCreate.contentMatch, false);
    assert.equal((await firstTab.save(saveRequest(snapshot({ taxPercent: '9' })))).status, 'save_failed');
    assert.equal(lastPatch().status, 409); assert.equal(lastPatch().response.code, 'version_conflict');
    assert.deepEqual(await state(db, user), after); assert.equal(after.used, 1);
  });
  it('manual creation, saved-status and replay expose the current version too', async () => {
    const id = randomUUID();
    const result = await CLIENT.saveManualCalculationOperation({ operationId: id, inputs: manual });
    assert.equal(result.kind, 'ok'); assert.equal(result.calculation.edit_version, 0);
    const hash = req('./app/lib/calc-operation-keys.js').manualRequestHash(manual);
    const st = await CLIENT.getSavedOperationStatus(id, hash);
    assert.equal(st.kind, 'done'); assert.equal(st.calculation.edit_version, 0);
    const edited = await call(CALCS, 'PATCH', user, { id: st.calculation.id, inputs: { ...manual, cost: 250 }, ...editMeta(st.calculation.edit_version) });
    assert.equal(edited.status, 200); assert.equal(edited.body.data.edit_version, 1);
    const after = await state(db, user);
    const replay = await CLIENT.saveManualCalculationOperation({ operationId: id, inputs: manual });
    assert.equal(replay.kind, 'ok'); assert.equal(replay.replay, true); assert.equal(replay.calculation.edit_version, 1);
    assert.equal((await CLIENT.getSavedOperationStatus(id, hash)).calculation.edit_version, 1);
    assert.deepEqual(await state(db, user), after); assert.equal(after.used, 1);
  });
  it('A commit/lost response -> B recovered version/success -> A original-key retry returns 409', async () => {
    const a = controller(); assert.equal((await a.save(saveRequest())).status, 'saved');
    const sa = snapshot({ taxPercent: '8' });
    dropEditResponse = true;
    assert.equal((await a.save(saveRequest(sa))).status, 'save_failed');
    const original = lastPatch().body;
    const b = await recover();
    const sb = snapshot({ taxPercent: '10', cost: 120 });
    assert.equal((await b.save(saveRequest(sb))).status, 'saved');
    assert.equal(lastPatch().body.expectedVersion, 1);
    const committedB = await state(db, user);
    assert.equal((await a.save(saveRequest(sa))).status, 'save_failed');
    assert.deepEqual(lastPatch().body, original);
    assert.equal(lastPatch().status, 409); assert.equal(lastPatch().response.code, 'version_conflict');
    assert.deepEqual(await state(db, user), committedB);
    assert.deepEqual(committedB.calculations[0].ai_insights, sb);
    assert.equal(committedB.calculations[0].edit_version, 2); assert.equal(committedB.used, 1);
    assert.equal((await receipts()).length, 2);
  });
  it('client retry after a lost edit response reuses the original version/key without another write', async () => {
    const ctl = controller(); assert.equal((await ctl.save(saveRequest())).status, 'saved');
    const s = snapshot({ taxPercent: '8' }); dropEditResponse = true;
    assert.equal((await ctl.save(saveRequest(s))).status, 'save_failed');
    const original = lastPatch().body; const committed = await state(db, user);
    assert.equal((await ctl.save(saveRequest(s))).status, 'saved');
    assert.deepEqual(lastPatch().body, original); assert.equal(lastPatch().response.data.edit_version, 1);
    assert.deepEqual(await state(db, user), committed); assert.equal((await receipts()).length, 1);
  });
  it('foreign status/read/edit and disabled PATCH stay closed through real client and SQL', async () => {
    const ctl = controller(); assert.equal((await ctl.save(saveRequest())).status, 'saved');
    const owner = user; const original = await state(db, owner);
    user = await db.user();
    assert.equal((await CLIENT.getCalculationOperationStatus(operationId, 'source-basic-2026-06')).kind, 'none');
    assert.deepEqual((await CLIENT.loadCalculationsFromCloud(user)).data, []);
    const foreign = await CLIENT.updateCalculationInCloud(original.calculations[0].id,
      COL.accrualSnapshotToCalculationColumns(snapshot({ taxPercent: '10' })), user, editMeta());
    assert.ok(foreign.error); assert.equal(lastPatch().status, 404);
    assert.deepEqual(await state(db, owner), original);
    user = owner; process.env.MPROF_CALCULATION_EDITS_ENABLED = 'false';
    assert.equal((await ctl.save(saveRequest(snapshot({ taxPercent: '10' })))).status, 'save_failed');
    assert.equal(lastPatch().status, 503); assert.equal(lastPatch().response.code, 'edits_disabled');
    assert.deepEqual(await state(db, owner), original); assert.deepEqual(await receipts(), []);
  });
  it('upgrade from current production schema fixes existing rows without data/grant/role drift', async () => {
    db = await freshDb({ extraMigrations: migrations }); user = await db.user(); net.state.pool = db.pool(5);
    const saved = await CLIENT.saveCalculationOperation(request());
    assert.equal(saved.kind, 'ok'); assert.equal(saved.row.edit_version, undefined);
    const before = await state(db, user);
    const acl = () => db.main.query("select proowner,proacl::text,prosecdef,provolatile,proconfig from pg_proc where oid='public.calculation_operation_saved(uuid)'::regprocedure");
    const oldAcl = (await acl()).rows;
    await runScript(db.main, versionMigration); await runScript(db.main, versionMigration);
    assert.deepEqual((await acl()).rows, oldAcl); assert.deepEqual(await state(db, user), before);
    const ctl = await recover();
    assert.equal((await CLIENT.getCalculationOperationStatus(operationId, 'source-basic-2026-06')).row.edit_version, 0);
    assert.equal((await ctl.save(saveRequest(snapshot({ taxPercent: '10', cost: 120 })))).status, 'saved');
    const full = await freshDb({ migrated: false, fullSchema: true });
    const definition = async c => (await c.query("select pg_get_functiondef(oid) as definition,proacl::text from pg_proc where oid='public.calculation_operation_saved(uuid)'::regprocedure")).rows;
    assert.deepEqual(await definition(db.main), await definition(full.main));
  });
});
