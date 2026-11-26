import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { paymentIntentClient as C, paymentCreateResult as R } from './helpers/modules.mjs';

const USER_A = '12345678-1234-4234-8234-123456789abc';
const USER_B = '87654321-4321-4321-8321-cba987654321';
const TOKEN = 'opaque-runtime-token-do-not-store';
const confirmationUrl = 'https://yoomoney.ru/checkout/test';
const pending = () => ({ status: 200, body: { ok: true, confirmationUrl } });
function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function locks() {
  const waiting = new Map(), held = new Set();
  const withLock = async (scope, operation) => {
    const previous = waiting.get(scope) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    waiting.set(scope, next);
    await previous;
    held.add(scope);
    try { return await operation(); }
    finally {
      held.delete(scope); release();
      if (waiting.get(scope) === next) waiting.delete(scope);
    }
  };
  return Object.assign(withLock, { held });
}
function fixture(storage = memory()) {
  const f = { storage, withIntentLock: locks(), requests: [], ids: [], user: USER_A, respond: async () => pending() };
  f.controller = () => C.createCheckoutController({
    storage: () => f.storage,
    withIntentLock: (scope, operation) => f.withIntentLock(scope, operation),
    createId: () => { const id = randomUUID(); f.ids.push(id); return id; },
    getSession: async () => f.user ? { userId: f.user, token: TOKEN } : null,
    request: async (body, token) => { f.requests.push({ ...body, token }); return f.respond(body); },
  });
  return f;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('checkout: one durable intent per conscious purchase', () => {
  it('double click sends one request; the synchronous lock also covers session lookup', async () => {
    const gate = deferred(), f = fixture();
    f.respond = () => gate.promise;
    const c = f.controller(), first = c.pay('single');
    assert.deepEqual(await c.pay('single'), { busy: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
    gate.resolve(pending());
    assert.deepEqual(await first, { outcome: { redirect: confirmationUrl } });
  });

  it('two mounted controllers reuse the stored intention for parallel requests', async () => {
    const gate = deferred(), f = fixture(); f.respond = () => gate.promise;
    const a = f.controller().pay('single'), b = f.controller().pay('single');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].intentId, f.requests[1].intentId);
    assert.equal(f.ids.length, 1);
    gate.resolve(pending()); await Promise.all([a, b]);
  });

  it('a new browser session resumes the persistent intention instead of inventing a new purchase', async () => {
    const persistentStorage = memory(), firstBrowser = fixture(persistentStorage);
    firstBrowser.respond = async () => { throw Error('browser closed before receiving response'); };
    await firstBrowser.controller().pay('unlimited');
    const nextBrowser = fixture(persistentStorage);
    await nextBrowser.controller().pay('unlimited');
    assert.equal(nextBrowser.requests[0].intentId, firstBrowser.requests[0].intentId);
    assert.equal(nextBrowser.ids.length, 0);
  });

  it('concurrent explicit new-purchase actions create only one replacement intention', async () => {
    const f = fixture(), gate = deferred();
    f.respond = async () => ({ status: 409, body: { code: 'payment_canceled' } });
    await f.controller().pay('single');
    f.respond = () => gate.promise;
    const first = f.controller().pay('single', true);
    const second = f.controller().pay('single', true);
    assert.deepEqual(await second, { outcome: { message: R.PAY_MSG.unresolved } });
    assert.equal(f.requests.length, 2, 'one old canceled request plus one new purchase');
    assert.equal(f.ids.length, 2);
    gate.resolve(pending()); await first;
  });

  it('a delayed old terminal response cannot overwrite another tab’s new intention', async () => {
    const f = fixture(), delayed = deferred();
    f.respond = async () => ({ status: 409, body: { code: 'payment_canceled' } });
    await f.controller().pay('single');
    const oldId = f.requests[0].intentId;
    f.respond = body => body.intentId === oldId ? delayed.promise : Promise.resolve(pending());
    const oldRetry = f.controller().pay('single');
    await new Promise(resolve => setImmediate(resolve));
    await f.controller().pay('single', true);
    const newId = f.requests.at(-1).intentId;
    assert.notEqual(newId, oldId);
    delayed.resolve({ status: 409, body: { code: 'payment_canceled' } }); await oldRetry;
    await f.controller().pay('single');
    assert.equal(f.requests.at(-1).intentId, newId);
    assert.equal(f.ids.length, 2);
  });

  it('the cross-tab lock is released before network requests', async () => {
    const f = fixture();
    f.respond = async () => { assert.equal(f.withIntentLock.held.size, 0); return pending(); };
    await f.controller().pay('single');
  });

  it('unavailable reliable cross-tab exclusion blocks HTTP instead of racing new IDs', async () => {
    const f = fixture(); f.withIntentLock = async () => { throw Error('Web Locks unavailable'); };
    assert.deepEqual(await f.controller().pay('single'), { outcome: { message: R.PAY_MSG.storageUnavailable } });
    assert.equal(f.requests.length, 0); assert.equal(f.ids.length, 0);
  });

  it('an account switch while waiting for another tab’s lock prevents a stale-account request', async () => {
    const f = fixture(), gate = deferred(), withLock = f.withIntentLock;
    f.withIntentLock = async (scope, operation) => { await gate.promise; return withLock(scope, operation); };
    const request = f.controller().pay('single');
    await new Promise(resolve => setImmediate(resolve));
    f.user = USER_B; gate.resolve();
    assert.deepEqual(await request, { outcome: { message: R.PAY_MSG.sessionChanged } });
    assert.equal(f.requests.length, 0);
  });

  for (const plan of ['single', 'unlimited']) {
    it(`${plan}: server-response loss and reload preserve the same intention`, async () => {
      const f = fixture(); f.respond = async () => { throw Error('response lost'); };
      assert.deepEqual(await f.controller().pay(plan), { outcome: { message: R.PAY_MSG.network } });
      const id = f.requests[0].intentId;
      f.respond = async () => pending();
      assert.deepEqual(await f.controller().pay(plan), { outcome: { redirect: confirmationUrl } });
      assert.equal(f.requests[1].intentId, id);
      assert.equal(f.ids.length, 1);
      assert.deepEqual(Object.keys(f.requests[1]).sort(), ['intentId', 'plan', 'token']);
    });
  }

  it('malformed/lost JSON and generic errors never discard an existing intent', async () => {
    const f = fixture(), c = f.controller();
    for (const [status, body] of [[200, null], [502, null], [401, null], [409, { code: 'intent_conflict' }]]) {
      f.respond = async () => ({ status, body });
      assert.ok('message' in (await c.pay('single')).outcome);
    }
    assert.equal(new Set(f.requests.map(x => x.intentId)).size, 1);
  });

  it('busy server requests may retry only the same intent', async () => {
    const f = fixture(), c = f.controller();
    f.respond = async () => ({ status: 202, body: { code: 'payment_in_progress' } });
    assert.deepEqual(await c.pay('single'), { outcome: { message: R.PAY_MSG.processing } });
    await c.pay('single');
    assert.equal(f.requests[0].intentId, f.requests[1].intentId);
    assert.deepEqual(await c.pay('single', true), { outcome: { message: R.PAY_MSG.unresolved } });
    assert.equal(f.requests.length, 2);
  });

  it('unknown provider outcome beyond 24h has no expiry-based ID rotation', async () => {
    const f = fixture();
    f.respond = async () => ({ status: 409, body: { code: 'reconciliation_required' } });
    assert.deepEqual(await f.controller().pay('unlimited'), { outcome: { message: R.PAY_MSG.reconciliation } });
    // A new component after arbitrarily long time still reads the unresolved ID.
    await f.controller().pay('unlimited');
    assert.equal(f.requests[0].intentId, f.requests[1].intentId);
    assert.deepEqual(await f.controller().pay('unlimited', true), { outcome: { message: R.PAY_MSG.unresolved } });
    assert.equal(f.ids.length, 1);
  });

  for (const terminal of ['canceled', 'succeeded']) {
    it(`${terminal}: only an explicit new-purchase action replaces the old intent`, async () => {
      const f = fixture(), c = f.controller();
      f.respond = async () => ({ status: terminal === 'canceled' ? 409 : 200,
        body: { ok: terminal === 'succeeded', code: `payment_${terminal}` } });
      assert.equal((await c.pay('single')).outcome.terminal, terminal);
      const id = f.requests[0].intentId;
      await f.controller().pay('single');
      assert.equal(f.requests[1].intentId, id, 'ordinary retry is not a new purchase');
      f.respond = async () => pending();
      assert.deepEqual(await f.controller().pay('single', true), { outcome: { redirect: confirmationUrl } });
      assert.notEqual(f.requests[2].intentId, id);
      assert.equal(f.ids.length, 2);
    });
  }

  it('a changed account cannot reuse another account order or receive its checkout URL', async () => {
    const gate = deferred(), f = fixture(), c = f.controller(); f.respond = () => gate.promise;
    const oldRequest = c.pay('single');
    await new Promise(resolve => setImmediate(resolve));
    f.user = USER_B; gate.resolve(pending());
    assert.deepEqual(await oldRequest, { outcome: { message: R.PAY_MSG.sessionChanged } });
    f.respond = async () => pending(); await c.pay('single');
    assert.notEqual(f.requests[0].intentId, f.requests[1].intentId);
    f.user = USER_A; await c.pay('single');
    assert.equal(f.requests[0].intentId, f.requests[2].intentId);
  });

  it('different plans are separate explicit purchases, and neither supplies an amount', async () => {
    const f = fixture(), c = f.controller();
    await c.pay('single'); await c.pay('unlimited');
    assert.notEqual(f.requests[0].intentId, f.requests[1].intentId);
    assert.ok(f.requests.every(r => !('amount' in r)));
    for (const value of f.storage.values.values()) {
      assert.ok(!value.includes(TOKEN));
      assert.ok(!value.includes('https://'));
      assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['id', 'plan', 'state', 'v']);
    }
  });

  it('unavailable browser storage blocks HTTP instead of using an ephemeral intention', async () => {
    const f = fixture({ getItem() { throw Error('blocked'); }, setItem() {} });
    assert.deepEqual(await f.controller().pay('single'), { outcome: { message: R.PAY_MSG.storageUnavailable } });
    assert.equal(f.requests.length, 0);
  });

  it('a storage implementation that silently drops writes blocks the payment', async () => {
    const f = fixture({ getItem: () => null, setItem() {} });
    assert.deepEqual(await f.controller().pay('single'), { outcome: { message: R.PAY_MSG.storageUnavailable } });
    assert.equal(f.requests.length, 0);
  });

  it('corrupt existing storage fails closed rather than losing a possibly pending intention', async () => {
    const f = fixture(); await f.controller().pay('single');
    f.storage.values.set([...f.storage.values.keys()][0], '{corrupt');
    const count = f.requests.length;
    assert.deepEqual(await f.controller().pay('single'), { outcome: { message: R.PAY_MSG.storageUnavailable } });
    assert.equal(f.requests.length, count);
    assert.equal(f.ids.length, 1);
  });

  it('missing session cannot create an intent or payment', async () => {
    const f = fixture(); f.user = null;
    assert.deepEqual(await f.controller().pay('single'), { outcome: { message: R.PAY_MSG.noSession } });
    assert.equal(f.requests.length, 0); assert.equal(f.ids.length, 0);
  });

  it('new-purchase flag cannot bypass an unresolved or absent intent', async () => {
    const f = fixture();
    assert.deepEqual(await f.controller().pay('single', true), { outcome: { message: R.PAY_MSG.unresolved } });
    assert.equal(f.requests.length, 0); assert.equal(f.ids.length, 0);
  });
});
