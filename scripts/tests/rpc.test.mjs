// The retrying fetch under every script's Connection.
//
// Written after the 2026-08-05 devnet dry run, where a single
// `TypeError: fetch failed` killed the crank *after* epoch 1's root was posted
// and *before* anyone was paid. The tests that matter here are the two halves
// of one judgement: retry what is transient, and hand back what was answered.

import assert from 'node:assert/strict';
import test from 'node:test';

import { pacedFetch, retryingFetch } from '../lib/rpc.mjs';

/** A fetch that replays a script of outcomes and counts how often it was called. */
function scripted(outcomes) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    const next = outcomes[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

const res = (status) => ({ status, ok: status >= 200 && status < 300 });

// Backoff is real time, so every test runs with a 1ms base rather than 400ms.
const fast = { baseDelayMs: 1 };

test('a network throw is retried, and a later success is returned', async () => {
  const { fn, calls } = scripted([
    new TypeError('fetch failed'),
    new TypeError('fetch failed'),
    res(200),
  ]);

  const response = await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3, 'should have tried three times');
});

test('429 is retried — this is the rate limit the public endpoints apply', async () => {
  const { fn, calls } = scripted([res(429), res(200)]);

  const response = await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test('a 5xx is retried', async () => {
  const { fn, calls } = scripted([res(502), res(503), res(200)]);

  const response = await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
});

// The one that keeps a real misconfiguration readable. The provider answers 403
// when the caller's IP is not on the allowlist — which is now the expected reply
// for anything running off the two servers. Retrying it would turn an instant,
// accurate answer into seconds of silence and then a misleading timeout.
test('a 403 is NOT retried — an answer is an answer', async () => {
  const { fn, calls } = scripted([res(403), res(200)]);

  const response = await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(response.status, 403, 'the 403 must come straight back');
  assert.equal(calls.length, 1, 'must not have tried again');
});

test('a 404 is not retried either', async () => {
  const { fn, calls } = scripted([res(404), res(200)]);

  const response = await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
});

test('a success on the first try costs exactly one call', async () => {
  const { fn, calls } = scripted([res(200)]);

  await retryingFetch(fn, fast)('https://rpc.example');

  assert.equal(calls.length, 1);
});

test('attempts are bounded, and the last response is returned rather than an invented error', async () => {
  const { fn, calls } = scripted([res(429), res(429), res(429), res(429), res(429)]);

  const response = await retryingFetch(fn, { ...fast, attempts: 5 })('https://rpc.example');

  assert.equal(calls.length, 5, 'must stop at the attempt limit');
  assert.equal(response.status, 429, 'the provider’s own answer is more useful than ours');
});

test('a throw that never clears is rethrown, not swallowed', async () => {
  const boom = new TypeError('fetch failed');
  const { fn, calls } = scripted([boom, boom, boom]);

  await assert.rejects(
    () => retryingFetch(fn, { ...fast, attempts: 3 })('https://rpc.example'),
    /fetch failed/,
  );
  assert.equal(calls.length, 3);
});

test('the request is passed through unchanged on every attempt', async () => {
  const { fn, calls } = scripted([new TypeError('fetch failed'), res(200)]);
  const init = { method: 'POST', body: '{"jsonrpc":"2.0"}' };

  await retryingFetch(fn, fast)('https://rpc.example/path', init);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.input, 'https://rpc.example/path');
    assert.deepEqual(call.init, init);
  }
});

// --- the pacer -------------------------------------------------------------
//
// Added 2026-08-08, after run 1 spent both of its attempts on a rate limit it
// was causing itself. These tests use a fake clock: the point is the spacing
// the pacer asks for, and real sleeps would only make the suite slow.

/**
 * A clock the test drives by hand.
 *
 * `sleep` records how long was asked for and returns without moving the clock:
 * a sleeping caller does not make time pass for the callers still queueing
 * behind it, and letting it would make concurrent waits read as if they had
 * happened one after another. Tests that want time to pass call `advance`.
 */
function fakeClock() {
  let at = 1_000;
  const waits = [];
  return {
    now: () => at,
    sleep: async (ms) => {
      waits.push(ms);
    },
    advance: (ms) => {
      at += ms;
    },
    waits,
  };
}

test('pacing spaces request starts by the provider’s interval', async () => {
  const { fn, calls } = scripted([res(200), res(200), res(200)]);
  const clock = fakeClock();
  const paced = pacedFetch(fn, { maxRps: 10, now: clock.now, sleep: clock.sleep });

  await Promise.all([
    paced('https://rpc.example'),
    paced('https://rpc.example'),
    paced('https://rpc.example'),
  ]);

  assert.equal(calls.length, 3);
  // Three requests made at the same instant leave 0, 100 and 200ms in: the
  // first goes straight out, each later one claims the next free slot.
  assert.deepEqual(clock.waits, [100, 200]);
});

test('a caller that arrives after the cap has drained does not wait', async () => {
  const { fn } = scripted([res(200), res(200)]);
  const clock = fakeClock();
  const paced = pacedFetch(fn, { maxRps: 10, now: clock.now, sleep: clock.sleep });

  await paced('https://rpc.example');
  clock.advance(500); // idle far longer than one slot
  await paced('https://rpc.example');

  assert.deepEqual(clock.waits, [], 'an idle gap is not a debt to repay');
});

test('pacing off returns the underlying fetch untouched', () => {
  const { fn } = scripted([res(200)]);
  assert.equal(pacedFetch(fn, { maxRps: 0 }), fn);
  assert.equal(pacedFetch(fn, {}), fn, 'unconfigured behaves exactly as before the pacer existed');
});

test('a retried attempt is paced too — the burst that caused the 429 cannot walk through it', async () => {
  const { fn, calls } = scripted([res(429), res(200)]);
  const clock = fakeClock();
  const paced = pacedFetch(fn, { maxRps: 10, now: clock.now, sleep: clock.sleep });

  const response = await retryingFetch(paced, fast)('https://rpc.example');

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(clock.waits.includes(100), 'the second attempt claimed the next slot');
});
