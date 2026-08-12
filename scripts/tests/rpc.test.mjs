// The retrying fetch under every script's Connection.
//
// Written after the 2026-08-05 devnet dry run, where a single
// `TypeError: fetch failed` killed the crank *after* epoch 1's root was posted
// and *before* anyone was paid. The tests that matter here are the two halves
// of one judgement: retry what is transient, and hand back what was answered.

import assert from 'node:assert/strict';
import test from 'node:test';

import { failoverFetch, pacedFetch, retryingFetch, timeoutFetch, verifyHealth } from '../lib/rpc.mjs';

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

// --- the fallback endpoint -------------------------------------------------
//
// Added 2026-08-09, after QuickNode's *daily* quota ended a run with both hosts
// on one key. The pacer holds the per-second cap; nothing held the per-day one.

const okHealth = async () => ({ ok: true, reason: 'ok' });
const silent = () => {};

test('a response the retry could not fix moves the process to the fallback', async () => {
  const seen = [];
  const underlying = async (url) => {
    seen.push(url);
    return url === 'https://fallback.example' ? res(200) : res(429);
  };

  const failover = failoverFetch(underlying, {
    fallbackUrl: 'https://fallback.example',
    verify: okHealth,
    log: silent,
  });
  const response = await failover('https://primary.example');

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['https://primary.example', 'https://fallback.example']);
});

test('the switch is sticky — later calls do not go back to the primary', async () => {
  const seen = [];
  const underlying = async (url) => {
    seen.push(url);
    return url === 'https://fallback.example' ? res(200) : res(429);
  };

  const failover = failoverFetch(underlying, {
    fallbackUrl: 'https://fallback.example',
    verify: okHealth,
    log: silent,
  });
  await failover('https://primary.example');
  await failover('https://primary.example');
  await failover('https://primary.example');

  // One try at the primary, then everything after it on the fallback: an
  // endpoint that alternates makes read-after-write staleness a coin toss.
  assert.deepEqual(seen, [
    'https://primary.example',
    'https://fallback.example',
    'https://fallback.example',
    'https://fallback.example',
  ]);
});

test('a lagging fallback is refused, and the primary’s own answer is handed back', async () => {
  const seen = [];
  const underlying = async (url) => {
    seen.push(url);
    return res(429);
  };
  const lagging = async () => ({ ok: false, reason: 'Node is behind by 252127 slots' });

  const logged = [];
  const failover = failoverFetch(underlying, {
    fallbackUrl: 'https://ankr.example',
    verify: lagging,
    log: (line) => logged.push(line),
  });
  const response = await failover('https://primary.example');

  assert.equal(response.status, 429, 'the caller must see what the primary actually said');
  assert.deepEqual(seen, ['https://primary.example'], 'nothing was sent to the lagging endpoint');
  assert.match(logged.join(' '), /behind by 252127 slots/);
});

test('a refused fallback is not re-checked on every later call', async () => {
  let checks = 0;
  const failover = failoverFetch(async () => res(429), {
    fallbackUrl: 'https://ankr.example',
    verify: async () => {
      checks += 1;
      return { ok: false, reason: 'behind' };
    },
    log: silent,
  });

  await failover('https://primary.example');
  await failover('https://primary.example');

  assert.equal(checks, 1, 'a dead fallback must not add a health check to every failing request');
});

test('an ordinary failure is not a reason to switch endpoints', async () => {
  const seen = [];
  const failover = failoverFetch(
    async (url) => {
      seen.push(url);
      return res(500);
    },
    { fallbackUrl: 'https://fallback.example', verify: okHealth, log: silent },
  );

  // A 500 has already been retried five times by the layer beneath; what it is
  // not is the endpoint refusing to serve this key, which is what failing over
  // is for.
  const response = await failover('https://primary.example');
  assert.equal(response.status, 500);
  assert.deepEqual(seen, ['https://primary.example']);
});

test('no fallback configured returns the underlying fetch untouched', () => {
  const { fn } = scripted([res(200)]);
  assert.equal(failoverFetch(fn, { fallbackUrl: null }), fn);
  assert.equal(failoverFetch(fn, {}), fn);
});

test('verifyHealth believes only an explicit ok', async () => {
  const body = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

  assert.deepEqual(await verifyHealth('https://x.example', { fetchImpl: body({ result: 'ok' }) }), {
    ok: true,
    reason: 'ok',
  });

  const behind = await verifyHealth('https://x.example', {
    fetchImpl: body({ error: { message: 'Node is behind by 9 slots' } }),
  });
  assert.equal(behind.ok, false);
  assert.match(behind.reason, /behind by 9 slots/);
});

test('verifyHealth treats an unreachable endpoint as unhealthy rather than throwing', async () => {
  const result = await verifyHealth('https://x.example', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'fetch failed' });
});

test('a refused key fails over too — 401 is not a blip either', async () => {
  const seen = [];
  const failover = failoverFetch(
    async (url) => {
      seen.push(url);
      return url === 'https://fallback.example' ? res(200) : res(401);
    },
    { fallbackUrl: 'https://fallback.example', verify: okHealth, log: silent },
  );

  assert.equal((await failover('https://primary.example')).status, 200);
  assert.deepEqual(seen, ['https://primary.example', 'https://fallback.example']);
});

// A primary that stops answering is the 2026-08-12 black-hole: the retry beneath
// has already given up (it saw only timeouts), so what reaches the failover is a
// throw, not a status. A silent endpoint is refusing to serve us just as surely
// as a 403, so it must move the run onto the fallback rather than end it.
test('a primary that stops answering fails over on the throw, not only on a status', async () => {
  const seen = [];
  const failover = failoverFetch(
    async (url) => {
      seen.push(url);
      if (url === 'https://fallback.example') return res(200);
      throw new TypeError('fetch failed'); // the shape retryingFetch rethrows after its attempts
    },
    { fallbackUrl: 'https://fallback.example', verify: okHealth, log: silent },
  );

  assert.equal((await failover('https://primary.example')).status, 200);
  assert.deepEqual(seen, ['https://primary.example', 'https://fallback.example']);
});

test('a primary throw with an unhealthy fallback rethrows the primary’s own failure', async () => {
  const logged = [];
  const failover = failoverFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    {
      fallbackUrl: 'https://ankr.example',
      verify: async () => ({ ok: false, reason: 'behind' }),
      log: (line) => logged.push(line),
    },
  );

  await assert.rejects(() => failover('https://primary.example'), /fetch failed/);
  assert.match(logged.join(' '), /stopped answering .fetch failed./);
});

// --- the per-request timeout -----------------------------------------------
//
// Added 2026-08-12, after Ankr accepted a large getProgramAccounts and sent
// nothing back, hanging the first settlement's holder snapshot for 34 minutes.
// A timeout turns that silence into a throw the retry and failover can act on.

// The black-hole shape: answers only if its signal aborts. The ref'd keep-alive
// timer stands in for the real network I/O that, in production, holds the event
// loop open long enough for `AbortSignal.timeout`'s own (unref'd) timer to fire;
// it is cleared on abort, so it never actually resolves.
const hangsUntilAborted = (input, init) =>
  new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 60_000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    });
  });

test('a request that never answers is aborted once the deadline passes, and the abort is thrown', async () => {
  const timed = timeoutFetch(hangsUntilAborted, { timeoutMs: 10 });

  await assert.rejects(
    () => timed('https://rpc.example', {}),
    (error) => error?.name === 'TimeoutError' || /timed out|abort/i.test(String(error?.message)),
  );
});

test('a request that answers within the deadline is returned, untouched', async () => {
  const timed = timeoutFetch(async () => res(200), { timeoutMs: 1000 });
  assert.equal((await timed('https://rpc.example', {})).status, 200);
});

test('the timeout throw is transient, so the retry gives a slow endpoint another try', async () => {
  // First attempt hangs to the deadline; the second answers. Real time, but the
  // deadline is 10ms and the backoff 1ms, so the whole test is a blink.
  let attempt = 0;
  const underlying = (input, init) => {
    attempt += 1;
    if (attempt === 1) return hangsUntilAborted(input, init);
    return Promise.resolve(res(200));
  };

  const timed = timeoutFetch(underlying, { timeoutMs: 10 });
  const response = await retryingFetch(timed, fast)('https://rpc.example', {});

  assert.equal(response.status, 200);
  assert.equal(attempt, 2, 'the timed-out attempt was retried');
});

test('timeout off returns the underlying fetch untouched', () => {
  const { fn } = scripted([res(200)]);
  assert.equal(timeoutFetch(fn, { timeoutMs: 0 }), fn);
  assert.equal(timeoutFetch(fn, { timeoutMs: -1 }), fn);
});
