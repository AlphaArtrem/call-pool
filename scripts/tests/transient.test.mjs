// A transient RPC error is a question to ask the chain, not a verdict.
//
// These tests are about the seam between those two readings. The settlement
// failed on 2026-08-14 and 2026-08-15 because the code read "the endpoint did
// not answer" as "the chain says no", so the tests that matter are the two
// directions of that mistake:
//
//   - a blip must NOT fail a run whose next poll would have succeeded;
//   - a genuine outage, and anything that is not a blip at all, MUST still fail.
//
// The second is the one worth guarding hardest. Tolerance that never gives up
// would trade a false failure for a settlement that hangs forever, and a
// classifier that called everything transient would retry a refusal.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chainTimeAtLeast, isTransientRpcError } from '../lib/transient.mjs';

/** The 2026-08-15 error, as web3.js raises it. */
const confirmTimeout = () => {
  const error = new Error(
    'Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. ' +
      'Check signature 24a549e using the Solana Explorer or CLI tools.',
  );
  error.name = 'TransactionExpiredTimeoutError';
  return error;
};

/** The 2026-08-14 error, as dRPC's load balancer phrases it. */
const slotBehind = () =>
  new Error(
    'failed to get block time for slot 439121462: no available upstreams to process a request. ' +
      'Cause - cherry-eu-bcn-01-solana-mainnet - Upstream slot height 439121461 is less than 439121462',
  );

/**
 * A connection whose clock is scripted.
 *
 * Each entry is either a number (the block time to return), null, or an Error to
 * throw. `getSlot` always answers, because the failure being modelled is the
 * second call disagreeing with the first.
 */
function fakeConnection(script) {
  const remaining = [...script];
  let slot = 1_000;
  return {
    calls: 0,
    async getSlot() {
      return (slot += 1);
    },
    async getBlockTime() {
      this.calls += 1;
      const next = remaining.length > 1 ? remaining.shift() : remaining[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const noSleep = async () => {};

// ── what counts as transient ───────────────────────────────────────────────

test('the two errors that actually failed mainnet are transient', () => {
  assert.equal(isTransientRpcError(confirmTimeout()), true);
  assert.equal(isTransientRpcError(slotBehind()), true);
});

test('a rate limit, a dead socket and an abort are transient', () => {
  assert.equal(isTransientRpcError(new Error('429 Too Many Requests')), true);
  assert.equal(isTransientRpcError(new Error('socket hang up')), true);
  assert.equal(isTransientRpcError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), true);
});

test('a transient cause under an opaque wrapper still counts', () => {
  const wrapped = new Error('fetch failed', { cause: new Error('ECONNRESET') });
  assert.equal(isTransientRpcError(wrapped), true);
});

test('the chain answering is NOT transient — this is the half that must not slip', () => {
  // Retrying any of these would either loop on a permanent condition or, worse,
  // treat a refusal as noise and carry on past it.
  assert.equal(isTransientRpcError(new Error('custom program error: 0x1771')), false);
  assert.equal(isTransientRpcError(new Error('AnchorError#ConstraintSeeds')), false);
  assert.equal(isTransientRpcError(new Error('TokenLendingError#AlreadyInitialized')), false);
  assert.equal(
    isTransientRpcError(new Error('epoch 2 allocates 500 but only 100 is available — NOT signing')),
    false,
  );
  assert.equal(isTransientRpcError(null), false);
});

// ── the challenge-window wait ──────────────────────────────────────────────

test('a clock already past the target returns at once, without waiting', async () => {
  const connection = fakeConnection([5_000]);
  let slept = 0;
  const now = await chainTimeAtLeast(connection, 4_000, { sleepFn: async () => (slept += 1) });
  assert.equal(now, 5_000);
  assert.equal(slept, 0);
});

test('it waits for the cluster clock, and announces the wait exactly once', async () => {
  const connection = fakeConnection([1_000, 1_100, 1_200, 2_000]);
  const announced = [];
  const now = await chainTimeAtLeast(connection, 2_000, {
    sleepFn: noSleep,
    onWait: (at) => announced.push(at),
  });
  assert.equal(now, 2_000);
  assert.deepEqual(announced, [1_000], 'one line about waiting, not one per poll');
});

test('a slot-behind upstream is polled through, not thrown — this is Day 3', async () => {
  const connection = fakeConnection([slotBehind(), slotBehind(), 9_999]);
  const now = await chainTimeAtLeast(connection, 5_000, { sleepFn: noSleep });
  assert.equal(now, 9_999, 'the settlement survived a transient read');
  assert.equal(connection.calls, 3);
});

test('a null block time is a non-answer, and is retried like one', async () => {
  const connection = fakeConnection([null, null, 7_000]);
  assert.equal(await chainTimeAtLeast(connection, 6_000, { sleepFn: noSleep }), 7_000);
});

test('an endpoint that never answers still fails the run, and names itself', async () => {
  const connection = fakeConnection([slotBehind()]);
  await assert.rejects(
    () => chainTimeAtLeast(connection, 5_000, { sleepFn: noSleep, maxTransient: 4 }),
    (error) =>
      /no longer transient/.test(error.message) &&
      /Upstream slot height/.test(error.message) &&
      !/^\s*$/.test(error.message),
  );
  assert.equal(connection.calls, 5, 'it gave up after the ceiling, not before and not never');
});

test('the failure counter resets on a good read, so a long wait never accumulates into one', async () => {
  // Two failures, a good read, then two more: with a ceiling of 2 this must
  // still succeed. A counter that only ever climbed would abort a legitimate
  // day-long window on scattered blips.
  const connection = fakeConnection([slotBehind(), slotBehind(), 1_000, slotBehind(), slotBehind(), 5_000]);
  assert.equal(
    await chainTimeAtLeast(connection, 5_000, { sleepFn: noSleep, maxTransient: 2 }),
    5_000,
  );
});

test('an error the chain raised is re-thrown immediately, never polled on', async () => {
  const fatal = new Error('custom program error: 0x1');
  const connection = fakeConnection([fatal]);
  await assert.rejects(() => chainTimeAtLeast(connection, 5_000, { sleepFn: noSleep }), fatal);
  assert.equal(connection.calls, 1);
});
