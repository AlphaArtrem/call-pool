// The `/rpc` proxy's screening and rate limiting.
//
// This is the file that decides whether the provider key is protected or merely
// moved. The page calls a same-origin `/rpc` so the key never reaches a
// browser — but an endpoint that forwards anything is exactly as abusable as a
// leaked key, because anyone can `curl` it. What makes it safe is the allowlist
// and the limiter, so both are pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_METHODS,
  clientKey,
  createRateLimiter,
  handleRpc,
  MAX_BATCH,
  resolveUpstream,
  screen,
} from '../lib/rpc-proxy.mjs';

const call = (method, id = 1, extra = {}) => ({ jsonrpc: '2.0', id, method, params: [], ...extra });

// ── the allowlist ──────────────────────────────────────────────────────────

test('every method the website actually calls is allowed', () => {
  // Read out of site/js/ and the vendored web3.js, where the wire names differ
  // from the client ones: getParsedAccountInfo → getAccountInfo,
  // getMultipleAccountsInfo → getMultipleAccounts, getParsedTransactions → a
  // batch of getTransaction, getParsedTokenAccountsByOwner →
  // getTokenAccountsByOwner.
  for (const method of [
    'getAccountInfo',
    'getMultipleAccounts',
    'getBalance',
    'getSignaturesForAddress',
    'getTransaction',
    'getTokenAccountsByOwner',
  ]) {
    assert.equal(screen(call(method)).ok, true, `${method} must be allowed`);
  }
});

test('the two that would turn this into somebody else\'s tool are refused', () => {
  // sendTransaction makes it a spam relay we pay for; getProgramAccounts is the
  // scan providers bill hardest for and the site never needs.
  for (const method of ['sendTransaction', 'getProgramAccounts', 'requestAirdrop', 'simulateTransaction']) {
    const verdict = screen(call(method));
    assert.equal(verdict.ok, false, `${method} must be refused`);
    assert.equal(verdict.status, 403);
  }
});

test('the allowlist is exactly six methods, so adding one is a deliberate act', () => {
  assert.equal(ALLOWED_METHODS.length, 6);
  assert.ok(Object.isFrozen(ALLOWED_METHODS));
});

test('the refusal reason names the method for the log, and never leaves this process', async () => {
  const verdict = screen(call('getProgramAccounts'));
  assert.match(verdict.reason, /getProgramAccounts/);

  // What the caller gets back must not name it: telling somebody which methods
  // are refused is telling them which are not.
  const lines = [];
  const res = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getProgramAccounts')) }), res, {
    upstream: 'https://provider.example/key',
    limiter: createRateLimiter(),
    log: (l) => lines.push(l),
    fetchImpl: () => assert.fail('must not reach the provider'),
  });

  assert.equal(res.status, 403);
  assert.ok(!res.body.includes('getProgramAccounts'), `leaked the method: ${res.body}`);
  assert.ok(lines.some((l) => l.includes('getProgramAccounts')), 'but the log must say');
});

// ── batches ────────────────────────────────────────────────────────────────

test('a batch is allowed, because getParsedTransactions sends one', () => {
  const batch = Array.from({ length: 25 }, (_, i) => call('getTransaction', i));
  const verdict = screen(batch);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.calls, 25);
});

test('one bad call spoils the batch', () => {
  const batch = [call('getTransaction', 1), call('sendTransaction', 2)];
  assert.equal(screen(batch).ok, false, 'a batch is screened per call, not on its first');
});

test('an oversized batch is refused, so one request cannot become hundreds', () => {
  const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => call('getAccountInfo', i));
  const verdict = screen(batch);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 413);
});

test('an empty batch is refused rather than forwarded as a no-op', () => {
  assert.equal(screen([]).ok, false);
});

test('a notification is refused — it makes the provider work with nothing coming back', () => {
  const verdict = screen({ jsonrpc: '2.0', method: 'getAccountInfo', params: [] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no id/);
});

test('malformed calls are refused before anything is forwarded', () => {
  for (const payload of [null, 42, 'getAccountInfo', [null], [[]], { jsonrpc: '1.0', id: 1, method: 'getBalance' }, { jsonrpc: '2.0', id: 1, method: 7 }]) {
    assert.equal(screen(payload).ok, false, `${JSON.stringify(payload)} must be refused`);
  }
});

// ── the rate limiter ───────────────────────────────────────────────────────

test('a bucket lets a real session through and then stops a loop', () => {
  let now = 0;
  const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 1, now: () => now });

  // A page load plus a wallet check, back to back.
  for (let i = 0; i < 10; i++) assert.equal(limiter.take('visitor').allowed, true, `call ${i}`);

  const stopped = limiter.take('visitor');
  assert.equal(stopped.allowed, false);
  assert.ok(stopped.retryAfter >= 1, 'and says how long to wait');
});

test('the bucket refills over time, so a visitor is never locked out for good', () => {
  let now = 0;
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });

  limiter.take('visitor');
  limiter.take('visitor');
  assert.equal(limiter.take('visitor').allowed, false);

  now += 3000;
  assert.equal(limiter.take('visitor').allowed, true);
});

test('one client running hot does not spend another client\'s budget', () => {
  let now = 0;
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });

  limiter.take('noisy');
  limiter.take('noisy');
  assert.equal(limiter.take('noisy').allowed, false);
  assert.equal(limiter.take('someone-else').allowed, true);
});

test('refilled buckets are swept, so the map cannot grow forever', () => {
  let now = 0;
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });

  limiter.take('a');
  limiter.take('b');
  assert.equal(limiter.size, 2);

  now += 60_000;
  assert.equal(limiter.sweep(), 0, 'both have refilled and are forgotten');
});

test('X-Forwarded-For is only believed when the operator says there is a proxy', () => {
  const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };

  // Default: a header anyone can set must not choose their own rate-limit key.
  assert.equal(clientKey(req), '127.0.0.1');
  assert.equal(clientKey(req, { trustProxy: true }), '9.9.9.9');
});

// ── one route, one key, per cluster ────────────────────────────────────────
//
// A single `/rpc` could not pick an upstream: the body is a JSON-RPC call and
// says nothing about which chain it is for. So the cluster is in the path, and
// each route reads its own variable — one exposure cannot burn both, and the
// mainnet key is the only one a restriction has to reason about.

test('each cluster resolves to its own key', () => {
  const env = {
    CALLPOOL_RPC_URL_MAINNET: 'https://provider.example/mainnet-key',
    CALLPOOL_RPC_URL_DEVNET: 'https://provider.example/devnet-key',
  };

  assert.deepEqual(resolveUpstream('/rpc', env), {
    cluster: 'mainnet',
    upstream: 'https://provider.example/mainnet-key',
  });
  assert.deepEqual(resolveUpstream('/rpc/devnet', env), {
    cluster: 'devnet',
    upstream: 'https://provider.example/devnet-key',
  });
});

test('CALLPOOL_RPC_URL still means mainnet, so a host configured before the split keeps working', () => {
  const { cluster, upstream } = resolveUpstream('/rpc', { CALLPOOL_RPC_URL: 'https://provider.example/one-key' });
  assert.equal(cluster, 'mainnet');
  assert.equal(upstream, 'https://provider.example/one-key');

  // The explicit variable wins when both are present.
  assert.equal(
    resolveUpstream('/rpc', {
      CALLPOOL_RPC_URL: 'https://old.example/k',
      CALLPOOL_RPC_URL_MAINNET: 'https://new.example/k',
    }).upstream,
    'https://new.example/k',
  );
});

test('a production host leaves devnet unset, and that route then serves nothing', () => {
  const env = { CALLPOOL_RPC_URL_MAINNET: 'https://provider.example/mainnet-key' };
  assert.equal(resolveUpstream('/rpc/devnet', env).upstream, null);
  assert.equal(resolveUpstream('/rpc', env).upstream, 'https://provider.example/mainnet-key');
});

test('the mainnet key is never reachable through the devnet route, or the reverse', () => {
  const env = {
    CALLPOOL_RPC_URL_MAINNET: 'https://provider.example/mainnet-key',
    CALLPOOL_RPC_URL_DEVNET: 'https://provider.example/devnet-key',
  };
  assert.notEqual(resolveUpstream('/rpc', env).upstream, env.CALLPOOL_RPC_URL_DEVNET);
  assert.notEqual(resolveUpstream('/rpc/devnet', env).upstream, env.CALLPOOL_RPC_URL_MAINNET);
});

test('anything else is not a route, so it cannot be made into one', () => {
  for (const route of ['/rpc/mainnet', '/rpc/', '/rpc/devnet/x', '/rpcx', '/', '/site/', '/rpc/../rpc']) {
    assert.equal(resolveUpstream(route, {}), null, `${route} must not route`);
  }
});

test('the unconfigured log names the cluster, because the mistake is setting the other one', async () => {
  const lines = [];
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), fakeRes(), {
    upstream: null,
    cluster: 'devnet',
    limiter: createRateLimiter(),
    log: (l) => lines.push(l),
  });
  assert.ok(lines.some((l) => l.includes('devnet') && l.includes('CALLPOOL_RPC_URL_DEVNET')), lines.join('|'));
});

// ── the handler ────────────────────────────────────────────────────────────

function fakeReq({ method = 'POST', body = '', headers = {} } = {}) {
  const handlers = {};
  const req = {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      handlers[event] = fn;
      // Deliver synchronously on the next tick, once both listeners are set.
      if (event === 'end') {
        queueMicrotask(() => {
          if (body) handlers.data?.(Buffer.from(body));
          handlers.end?.();
        });
      }
      return req;
    },
    destroy() {},
  };
  return req;
}

function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body = '') {
      this.body += body;
      return this;
    },
  };
}

test('a GET is refused — this endpoint takes POST', async () => {
  const res = fakeRes();
  await handleRpc(fakeReq({ method: 'GET' }), res, { upstream: 'https://p.example/k', limiter: createRateLimiter() });
  assert.equal(res.status, 405);
});

test('an unconfigured server says so in the log and 503s, rather than 404ing', async () => {
  const lines = [];
  const res = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), res, {
    upstream: null,
    limiter: createRateLimiter(),
    log: (l) => lines.push(l),
  });

  assert.equal(res.status, 503);
  assert.ok(lines.some((l) => l.includes('CALLPOOL_RPC_URL')), 'the log names the missing variable');
});

test('an unconfigured server still refuses a disallowed method, rather than 503ing it', async () => {
  // Screening runs before the upstream check, so a probe gets the same answer
  // whether or not this deployment happens to be configured — and the allowlist
  // stays testable against a real client without a provider key in sight.
  const res = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('sendTransaction')) }), res, {
    upstream: null,
    limiter: createRateLimiter(),
  });
  assert.equal(res.status, 403);
});

test('an allowed call is forwarded, and the caller\'s headers are not', async () => {
  let seen = null;
  const res = fakeRes();
  await handleRpc(
    fakeReq({
      body: JSON.stringify(call('getBalance')),
      headers: { authorization: 'Bearer someone-elses-identity', cookie: 'session=abc' },
    }),
    res,
    {
      upstream: 'https://provider.example/the-key',
      limiter: createRateLimiter(),
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, text: async () => '{"jsonrpc":"2.0","id":1,"result":42}' };
      },
    },
  );

  assert.equal(res.status, 200);
  assert.match(res.body, /"result":42/);
  assert.equal(seen.url, 'https://provider.example/the-key');
  assert.deepEqual(Object.keys(seen.init.headers), ['content-type'], 'a fresh request, not a relayed one');
});

test('the provider\'s error body never reaches the caller — it can name the endpoint', async () => {
  const res = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), res, {
    upstream: 'https://provider.example/the-key',
    limiter: createRateLimiter(),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized for https://provider.example/the-key',
    }),
  });

  assert.equal(res.status, 502);
  assert.ok(!res.body.includes('the-key'), `leaked the key: ${res.body}`);
  assert.ok(!res.body.includes('provider.example'), `leaked the provider: ${res.body}`);
});

test('no CORS header is sent, so another site\'s browser cannot use this', async () => {
  const res = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), res, {
    upstream: 'https://provider.example/k',
    limiter: createRateLimiter(),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });

  const names = Object.keys(res.headers).map((h) => h.toLowerCase());
  assert.ok(!names.some((h) => h.startsWith('access-control-')), `sent ${names.join(', ')}`);
});

test('a body that is not JSON is refused without reaching the provider', async () => {
  const res = fakeRes();
  await handleRpc(fakeReq({ body: 'not json at all' }), res, {
    upstream: 'https://provider.example/k',
    limiter: createRateLimiter(),
    fetchImpl: () => assert.fail('must not reach the provider'),
  });
  assert.equal(res.status, 400);
});

test('a rate-limited caller gets 429 and a retry-after, and the provider is not called', async () => {
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 });
  const options = {
    upstream: 'https://provider.example/k',
    limiter,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  };

  const first = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), first, options);
  assert.equal(first.status, 200);

  const second = fakeRes();
  await handleRpc(fakeReq({ body: JSON.stringify(call('getBalance')) }), second, {
    ...options,
    fetchImpl: () => assert.fail('must not reach the provider once limited'),
  });
  assert.equal(second.status, 429);
  assert.ok(second.headers['retry-after'], 'and says when to come back');
});
