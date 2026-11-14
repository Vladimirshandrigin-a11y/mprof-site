import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, it, mock } from 'node:test';
import { BUILD_DIR, authLib, cloudClient, nextServer, parseBuf, saveFlow, session } from './helpers/modules.mjs';
import { makeMockCloud } from './helpers/mock-cloud.mjs';
import { scenario } from './helpers/fixtures.mjs';
import { CAT } from './helpers/expected.mjs';

const req = createRequire(path.join(BUILD_DIR, 'loader.js'));
const calculations = req('./api/cloud/calculations/route.js');
const history = req('./api/cloud/report-history/route.js');
const original = process.env.MPROF_CALCULATION_EDITS_ENABLED;
afterEach(() => {
  mock.restoreAll();
  if (original === undefined) delete process.env.MPROF_CALCULATION_EDITS_ENABLED;
  else process.env.MPROF_CALCULATION_EDITS_ENABLED = original;
});
const setFlag = value => {
  if (value === undefined) delete process.env.MPROF_CALCULATION_EDITS_ENABLED;
  else process.env.MPROF_CALCULATION_EDITS_ENABLED = value;
};
function authenticated(admin = {}) {
  mock.method(authLib, 'authenticateRequest', async () => ({ ok: true, userId: 'synthetic-user', admin }));
}
const body = () => ({
  id: randomUUID(), editOperationId: randomUUID(), expectedVersion: 0,
  inputs: { marketplace: 'ozon', revenue: 1000, commission: 100, logistics: 10, storage: 0, ads: 20, cost: 200, tax: 60, other: 10 },
});
const request = data => new nextServer.NextRequest('http://localhost/api/cloud/calculations', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
for (const value of [undefined, 'false', '', 'TRUE', ' true', 'true ', '1']) {
  it(`PATCH disabled for ${JSON.stringify(value)}: 503 before body read, zero RPC`, async () => {
    setFlag(value);
    const rpc = mock.fn(() => assert.fail('RPC must not run'));
    authenticated({ rpc });
    const json = mock.fn(() => assert.fail('Body must not be read'));
    const r = await calculations.PATCH({ json });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.equal((await r.json()).code, 'edits_disabled');
    assert.equal(json.mock.callCount(), 0);
    assert.equal(rpc.mock.callCount(), 0);
  });
}
it('authentication failure wins over the disabled switch', async () => {
  setFlag('false');
  mock.method(authLib, 'authenticateRequest', async () => ({ ok: false, response: nextServer.NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }));
  assert.equal((await calculations.PATCH({ json: () => assert.fail('Body must not be read') })).status, 401);
});
it('reads runtime flag each PATCH; true forwards original version/key and still maps 409', async () => {
  const payload = body();
  const rpc = mock.fn(async () => ({ data: { ok: true, calculation: { id: payload.id, edit_version: 1 } }, error: null }));
  authenticated({ rpc });
  setFlag('true');
  assert.equal((await calculations.PATCH(request(payload))).status, 200);
  assert.equal(rpc.mock.calls[0].arguments[0], 'edit_calculation_operation');
  const args = rpc.mock.calls[0].arguments[1];
  assert.equal(args.p_expected_version, payload.expectedVersion);
  assert.equal(args.p_edit_operation_id, payload.editOperationId);
  setFlag('false');
  assert.equal((await calculations.PATCH(request(payload))).status, 503);
  assert.equal(rpc.mock.callCount(), 1);
  setFlag('true');
  rpc.mock.mockImplementation(async () => ({ data: { ok: false, reason: 'version_conflict' }, error: null }));
  const conflict = await calculations.PATCH(request(payload));
  assert.deepEqual([conflict.status, (await conflict.json()).code], [409, 'version_conflict']);
});
it('GET and both closed generic POSTs are unaffected by switch state', async () => {
  const query = { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: [], error: null }; } };
  const rpc = mock.fn(() => assert.fail('Generic routes must not call RPC'));
  authenticated({ rpc, from: () => query });
  for (const flag of [undefined, 'false', 'true']) {
    setFlag(flag);
    assert.equal((await calculations.GET(new nextServer.NextRequest('http://localhost/api/cloud/calculations'))).status, 200);
    for (const route of [calculations, history]) {
      const r = await route.POST(request({}));
      assert.deepEqual([r.status, (await r.json()).code], [410, 'calculation_operation_required']);
    }
  }
  assert.equal(rpc.mock.callCount(), 0);
});
it('real client receives disabled 503, reports unsaved edit and retries same operation without another charge', async () => {
  const cloud = makeMockCloud();
  const ctl = new saveFlow.AccrualSaveController(cloud.deps);
  ctl.beginAttempt('synthetic-file');
  const parsed = parseBuf(scenario('basic'));
  const evaluate = taxPercent => session.evaluateAccrual({
    report: { rows: parsed.report.rows, period: parsed.report.period, rowCount: parsed.report.summary.rowCount, warnings: parsed.warnings, sheet: parsed.report.sheetName },
    catalog: CAT, inputs: { taxPercent, packaging: '10', deliveryToWarehouse: '', salary: '', other: '3.33', adsOutsideOzon: '' },
    generatedAt: '2026-07-01T10:00:00.000Z',
  });
  const saveRequest = e => ({ snapshot: e.snapshot, ready: e.readyToSave, userId: 'synthetic-user' });
  const saved = await ctl.save(saveRequest(evaluate('7')));
  assert.equal(saved.status, 'saved');
  // Mock IDs are replaced by a valid UUID at this HTTP boundary.
  const id = randomUUID(); const row = cloud.rows.get(saved.row.id);
  for (const op of cloud.ops.values()) if (op.rowId === saved.row.id) op.rowId = id;
  cloud.rows.delete(saved.row.id); cloud.rows.set(id, row);
  ctl.state.saved.id = id;
  const originalUpdate = cloud.deps.updateCalculation;
  const rpc = mock.fn(async (_name, args) => {
    const update = await originalUpdate(args.p_calculation_id, args.p_calculation, { expectedVersion: args.p_expected_version, editOperationId: args.p_edit_operation_id });
    return { data: { ok: true, calculation: update.data }, error: null };
  });
  authenticated({ rpc });
  mock.method(cloudClient.supabase.auth, 'getSession', async () => ({ data: { session: { access_token: 'synthetic-token' } }, error: null }));
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/cloud/calculations');
    sent.push(JSON.parse(init.body));
    return calculations.PATCH(request(sent.at(-1)));
  });
  mock.method(console, 'log', () => {}); mock.method(console, 'error', () => {});
  cloud.deps.updateCalculation = (calcId, columns, edit) => cloudClient.updateCalculationInCloud(calcId, columns, 'synthetic-user', edit);
  const before = structuredClone([...cloud.rows]); const counts = cloud.counts();
  setFlag('false');
  const denied = await ctl.save(saveRequest(evaluate('8')));
  assert.equal(denied.status, 'save_failed');
  assert.match(denied.error, /временно отключено/);
  assert.equal(session.saveOutcomeUi(denied).emitSaved, false);
  assert.equal(rpc.mock.callCount(), 0);
  assert.deepEqual([...cloud.rows], before);
  assert.deepEqual(cloud.counts(), counts);
  setFlag('true');
  const retry = await ctl.save(saveRequest(evaluate('8')));
  assert.equal(retry.status, 'saved');
  assert.equal(retry.created, false);
  assert.equal(sent[1].editOperationId, sent[0].editOperationId);
  assert.equal(sent[1].expectedVersion, sent[0].expectedVersion);
  assert.equal(cloud.log.consume, counts.consume);
  assert.equal(cloud.log.histories.length, counts.histories);
});
