import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAccount, dueCredit, summarize } from './watch.mjs';

const NOW = 1_800_000_000;
const credit = (id, expiresAt, extra = {}) => ({
  id, expiresAt, status: 'available', resetType: 'codexRateLimits', ...extra,
});
const snapshot = (credits = [], extra = {}) => ({
  accountId: 'test-account',
  rateLimitResetCredits: { availableCount: credits.length, credits },
  rateLimits: { primary: { usedPercent: 4 }, secondary: { usedPercent: 52 } },
  ...extra,
});
function options(overrides = {}) {
  return { state: {}, save: async () => {}, enabled: true, leadSeconds: 1800,
    now: () => NOW, log: () => {}, ...overrides };
}

test('waits until the configured lead time and never selects expired resets', () => {
  assert.equal(dueCredit(snapshot([credit('future', NOW + 1801)]), NOW, 1800), null);
  assert.equal(dueCredit(snapshot([credit('expired', NOW)]), NOW, 1800), null);
  assert.equal(dueCredit(snapshot([credit('boundary', NOW + 1800)]), NOW, 1800).id, 'boundary');
});

test('chooses the soonest available full reset even when rows are unsorted', () => {
  const data = snapshot([
    credit('later', NOW + 1700), credit('first', NOW + 1200),
    credit('redeemed', NOW + 1, { status: 'redeemed' }),
    credit('unsupported', NOW + 2, { resetType: 'other' }),
    credit('no-expiry', null),
  ]);
  assert.equal(dueCredit(data, NOW, 1800).id, 'first');
});

test('correctly converts real expiry timestamps to EDT and handles winter EST', () => {
  const result = summarize(snapshot([
    credit('first', 1792698671), credit('second', 1793298472),
    credit('winter', Date.parse('2026-12-01T20:00:00Z') / 1000),
  ]));
  assert.equal(result.resets[0].expiry.utc, '2026-10-22T19:51:11.000Z');
  assert.match(result.resets[0].expiry.local, /3:51:11 PM EDT/);
  assert.equal(result.resets[1].expiry.utc, '2026-10-29T18:27:52.000Z');
  assert.match(result.resets[1].expiry.local, /2:27:52 PM EDT/);
  assert.match(result.resets[2].expiry.local, /3:00:00 PM EST/);
});

test('dry run never calls the consume method, even for a due reset', async () => {
  const calls = [];
  const result = await checkAccount(options({ enabled: false,
    rpc: async method => { calls.push(method); return snapshot([credit('due', NOW + 1)]); },
  }));
  assert.equal(result.outcome, 'dry_run');
  assert.deepEqual(calls, ['account/rateLimits/read']);
});

test('missing details and unknown account fail without a redemption', async () => {
  for (const data of [
    snapshot([], { rateLimitResetCredits: { availableCount: 2, credits: null } }),
    snapshot([credit('due', NOW + 10)], { accountId: null }),
  ]) {
    const calls = [];
    await assert.rejects(checkAccount(options({ rpc: async method => {
      calls.push(method); return data;
    } })));
    assert.deepEqual(calls, ['account/rateLimits/read']);
  }
});

test('persists a retry key before redemption and refreshes limits afterward', async () => {
  const state = {};
  const saved = [];
  const methods = [];
  const result = await checkAccount(options({ state,
    save: async value => saved.push(structuredClone(value)),
    rpc: async (method, params) => {
      methods.push(method);
      if (method.endsWith('/consume')) {
        assert.equal(params.creditId, 'due');
        assert.equal(saved.at(-1).attempts.due.idempotencyKey, params.idempotencyKey);
        return { outcome: 'reset' };
      }
      return snapshot([credit('due', NOW + 600)]);
    },
  }));
  assert.equal(result.outcome, 'reset');
  assert.equal(state.attempts.due.status, 'redeemed');
  assert.deepEqual(methods, ['account/rateLimits/read', 'account/rateLimitResetCredit/consume',
    'account/rateLimits/read']);
});

test('a restart after an uncertain result reuses the same key and exact credit', async () => {
  let persisted = {};
  let key;
  await assert.rejects(checkAccount(options({ state: {},
    save: async value => { persisted = structuredClone(value); },
    rpc: async (method, params) => {
      if (method.endsWith('/consume')) {
        key = params.idempotencyKey;
        throw new Error('Network response was lost');
      }
      return snapshot([credit('due', NOW + 600)]);
    },
  })));
  const result = await checkAccount(options({ state: persisted,
    rpc: async (method, params) => {
      if (method.endsWith('/consume')) {
        assert.equal(params.idempotencyKey, key);
        assert.equal(params.creditId, 'due');
        return { outcome: 'alreadyRedeemed' };
      }
      return snapshot([credit('due', NOW + 500)]);
    },
  }));
  assert.equal(result.outcome, 'alreadyRedeemed');
});

test('nothingToReset creates a fresh attempt when a later window becomes eligible', async () => {
  const state = {};
  const keys = [];
  for (const outcome of ['nothingToReset', 'reset']) {
    await checkAccount(options({ state, rpc: async (method, params) => {
      if (method.endsWith('/consume')) {
        keys.push(params.idempotencyKey);
        return { outcome };
      }
      return snapshot([credit('due', NOW + 500)]);
    } }));
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(state.attempts.due.status, 'redeemed');
});

test('a confirmed reset is not repeated if the account refresh fails', async () => {
  const state = {};
  let reads = 0;
  await assert.rejects(checkAccount(options({ state, rpc: async method => {
    if (method.endsWith('/consume')) return { outcome: 'reset' };
    if (++reads > 1) throw new Error('Refresh failed');
    return snapshot([credit('due', NOW + 500)]);
  } })));
  const calls = [];
  const result = await checkAccount(options({ state, rpc: async method => {
    calls.push(method);
    return snapshot([credit('due', NOW + 400)]);
  } }));
  assert.equal(result.outcome, 'not_due');
  assert.deepEqual(calls, ['account/rateLimits/read']);
});

test('expiry is checked again after saving the redemption attempt', async () => {
  let time = NOW;
  const calls = [];
  const result = await checkAccount(options({ now: () => time,
    save: async state => { if (state.attempts?.due) time = NOW + 2; },
    rpc: async method => { calls.push(method); return snapshot([credit('due', NOW + 1)]); },
  }));
  assert.equal(result.outcome, 'expired');
  assert.deepEqual(calls, ['account/rateLimits/read']);
});
