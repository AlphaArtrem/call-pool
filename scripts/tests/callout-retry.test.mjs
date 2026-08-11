// The 429 retry: a single throttled poll must not cost the whole hour.
//
// Launch night (2026-08-10/11) pump's callout API returned 429 on about half
// of polls at random minutes, clearing in seconds. The poller made one attempt
// and exited, so the crank host's store went stale. `get()` now retries the
// same key with backoff for transient statuses; these pin that behaviour and
// its boundary — it must still fail loudly on a status that is not transient,
// and after the attempts are exhausted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CalloutError, RETRYABLE_STATUS, fetchWalletCallouts, retryDelayMs } from '../lib/callouts.mjs';

const WALLET = 'A1iceWa11etAddress11111111111111111111111111';
const reply = (status, body) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => body,
});
// A sleep that records what it was asked to wait but returns instantly.
const fakeSleep = (log) => (ms) => {
  log.push(ms);
  return Promise.resolve();
};

test('429 is retried with the same key and then succeeds', async () => {
  const statuses = [429, 429, 200];
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => reply(statuses[calls++], { callouts: [{ id: 'c1' }] });

  const out = await fetchWalletCallouts(WALLET, {
    apiKey: 'cc_test',
    fetchImpl,
    sleep: fakeSleep(waits),
  });

  assert.equal(calls, 3, 'two 429s then one success = three sends');
  assert.equal(waits.length, 2, 'one backoff before each retry');
  assert.deepEqual(out, [{ id: 'c1' }]);
});

test('a run of 429s past the attempt cap still throws, loudly', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return reply(429, {});
  };

  await assert.rejects(
    fetchWalletCallouts(WALLET, { apiKey: 'cc_test', fetchImpl, sleep: () => Promise.resolve() }),
    (err) => err instanceof CalloutError && /429/.test(err.message),
  );
  // Bounded: the first attempt plus retries, not an unbounded hammer.
  assert.ok(calls >= 2 && calls <= 4, `attempts were bounded, got ${calls}`);
});

test('a non-transient status is not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return reply(418, {});
  };
  await assert.rejects(
    fetchWalletCallouts(WALLET, { apiKey: 'cc_test', fetchImpl, sleep: () => Promise.resolve() }),
    (err) => err instanceof CalloutError,
  );
  assert.equal(calls, 1, '418 is not in the retry set, so it is thrown on the first try');
  assert.ok(!RETRYABLE_STATUS.has(418));
});

test('Retry-After is honoured over the backoff when the API sends it', () => {
  const withHeader = { headers: { get: (k) => (k === 'retry-after' ? '7' : null) } };
  assert.equal(retryDelayMs(withHeader, 1), 7000);
  // Without the header, backoff grows and stays positive.
  const noHeader = { headers: { get: () => null } };
  assert.ok(retryDelayMs(noHeader, 1) >= 1500);
  assert.ok(retryDelayMs(noHeader, 2) >= 3000);
});
