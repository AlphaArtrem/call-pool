// The RPC proxy: the page's only route to Solana, and the reason the key is
// not in the page.
//
// A provider endpoint is mandatory — `api.mainnet-beta.solana.com` answers a
// browser with `403 Access forbidden` — and a provider endpoint carries a key
// in its URL. `site/config.local.js` is fetched by every visitor, so a keyed
// URL there is a published key: gitignoring the file protects the repository
// and not the reader. The page therefore calls a same-origin `/rpc`, this
// forwards it, and the key lives in `CALLPOOL_RPC_URL` on the server where a
// browser cannot reach it.
//
// That moves the problem rather than solving it, and this file is the part that
// solves it. An open forwarder is exactly as abusable as a leaked key: anyone
// can `curl` it. So it is not a forwarder. It is a **narrow allowlist of the
// six read-only methods this website actually calls**, rate limited per client,
// bounded in body size and batch length, and it sends no CORS headers at all so
// no other site's browser can use it.
//
// Everything here is pure except `handleRpc`, so scripts/tests can walk the
// screening and the limiter without a socket.

/**
 * The six methods the site calls, and nothing else.
 *
 * Derived rather than guessed — read out of `site/js/` and the vendored
 * web3.js, which is where the wire names differ from the client ones:
 *
 *   getAccountInfo            the program's Config, and getParsedAccountInfo
 *   getMultipleAccounts       the epoch table, via getMultipleAccountsInfo
 *   getBalance                the pool and the creator vault
 *   getSignaturesForAddress   the wallet check's history walk
 *   getTransaction            the same walk, sent as a JSON-RPC batch
 *   getTokenAccountsByOwner   the "multiple token accounts" warning
 *
 * Adding one is a deliberate act. Two that must never appear: `sendTransaction`
 * would make this a spam relay signed by nobody and paid for by us, and
 * `getProgramAccounts` is the expensive scan every provider bills hardest for
 * and the site has no use for.
 */
export const ALLOWED_METHODS = Object.freeze([
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getSignaturesForAddress',
  'getTransaction',
  'getTokenAccountsByOwner',
]);

const ALLOWED = new Set(ALLOWED_METHODS);

/**
 * One route per cluster, so one key per cluster.
 *
 * The page could not choose its upstream through a single `/rpc` — the request
 * body is a JSON-RPC call and says nothing about which chain it is for — so the
 * cluster is in the path instead. `site/config.local.js` sets `rpc: '/rpc'` for
 * mainnet and `/rpc/devnet` for the rehearsal.
 *
 * Two keys rather than one because a key that serves both clusters means one
 * exposure burns both, and because the mainnet key is the one that will carry a
 * domain restriction — mixing the rehearsal's traffic through it would make
 * that restriction impossible to reason about.
 *
 * `CALLPOOL_RPC_URL` stays as an alias for the mainnet one: a host that was
 * configured before this split keeps working rather than silently serving a
 * page with no chain behind it.
 *
 * A devnet URL that is simply not set is the normal state of a production host.
 * The route then answers exactly as an unconfigured mainnet one does, and
 * nothing internal is reachable through it.
 */
export function resolveUpstream(route, env = globalThis.process?.env ?? {}) {
  if (route === '/rpc') {
    return { cluster: 'mainnet', upstream: env.CALLPOOL_RPC_URL_MAINNET || env.CALLPOOL_RPC_URL || null };
  }
  if (route === '/rpc/devnet') {
    return { cluster: 'devnet', upstream: env.CALLPOOL_RPC_URL_DEVNET || null };
  }
  return null;
}

/**
 * Longest batch the site can legitimately send.
 *
 * `balanceEventsFor` chunks `getParsedTransactions` at 25, which is the only
 * batch the page produces. 32 leaves room without leaving room for amplifying
 * one request into hundreds.
 */
export const MAX_BATCH = 32;

/** A 25-call getTransaction batch is ~3 KB. 64 KB is generous and bounded. */
export const MAX_BODY_BYTES = 64 * 1024;

/** How long to wait on the provider before giving up on the visitor's behalf. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Is this payload something the website could have sent?
 *
 * Accepts a single JSON-RPC call or a batch, and answers with the reason when
 * it says no — the reason goes to the server log, never to the client, because
 * "method getProgramAccounts is not allowed" is a map of the allowlist.
 *
 * @param {unknown} payload  the parsed JSON body
 * @returns {{ ok: true, calls: number } | { ok: false, status: number, reason: string }}
 */
export function screen(payload) {
  const calls = Array.isArray(payload) ? payload : [payload];

  if (calls.length === 0) {
    return { ok: false, status: 400, reason: 'empty batch' };
  }
  if (calls.length > MAX_BATCH) {
    return { ok: false, status: 413, reason: `batch of ${calls.length} exceeds ${MAX_BATCH}` };
  }

  for (const call of calls) {
    if (call === null || typeof call !== 'object' || Array.isArray(call)) {
      return { ok: false, status: 400, reason: 'call is not an object' };
    }
    if (call.jsonrpc !== '2.0') {
      return { ok: false, status: 400, reason: `jsonrpc is ${JSON.stringify(call.jsonrpc)}` };
    }
    if (typeof call.method !== 'string') {
      return { ok: false, status: 400, reason: 'method is not a string' };
    }
    if (!ALLOWED.has(call.method)) {
      return { ok: false, status: 403, reason: `method ${call.method} is not allowed` };
    }
    // A notification — no `id` — gets no response, so a batch of them is a way
    // to make the provider work for free with nothing coming back.
    if (call.id === undefined || call.id === null) {
      return { ok: false, status: 400, reason: `${call.method} has no id` };
    }
  }

  return { ok: true, calls: calls.length };
}

/**
 * A token bucket per client. In memory, which is the right scope: one process
 * in front of one site, and a restart that forgives everyone is not a problem
 * worth a dependency.
 *
 * A page load is ~4 calls and the minute refresh is 3, so a full wallet check —
 * the heaviest thing a visitor can do — sits around 10. A bucket of 60 that
 * refills at 1/s lets a real person work uninterrupted and stops a loop.
 */
export function createRateLimiter({ capacity = 60, refillPerSecond = 1, now = () => Date.now() } = {}) {
  const buckets = new Map();

  return {
    /** @returns {{ allowed: boolean, retryAfter: number }} */
    take(key, cost = 1) {
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: capacity, at };

      // Refill for the time that passed, capped at the bucket size.
      const refill = ((at - bucket.at) / 1000) * refillPerSecond;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.at = at;

      if (bucket.tokens < cost) {
        buckets.set(key, bucket);
        return { allowed: false, retryAfter: Math.ceil((cost - bucket.tokens) / refillPerSecond) };
      }

      bucket.tokens -= cost;
      buckets.set(key, bucket);
      return { allowed: true, retryAfter: 0 };
    },

    /** Drop buckets that have been full for a while, so this cannot grow forever. */
    sweep() {
      const at = now();
      for (const [key, bucket] of buckets) {
        if (bucket.tokens + ((at - bucket.at) / 1000) * refillPerSecond >= capacity) buckets.delete(key);
      }
      return buckets.size;
    },

    get size() {
      return buckets.size;
    },
  };
}

/**
 * Which client this request is from, for rate limiting.
 *
 * `X-Forwarded-For` is only believed when the operator says there is a reverse
 * proxy in front, because anyone can set that header and a limiter keyed on a
 * value the attacker chooses is not a limiter.
 */
export function clientKey(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

const jsonError = (res, status, message, extra = {}) => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: status === 429 ? -32005 : -32600, message },
  });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Deliberately no access-control-allow-origin. The page is same-origin, so
    // it needs none, and its absence is what stops another site's browser from
    // using this endpoint.
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
};

/** Read the body, refusing anything oversized without buffering it first. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The `/rpc` handler.
 *
 * @param {object} options
 * @param {string|null} options.upstream  CALLPOOL_RPC_URL — the keyed provider URL
 * @param {ReturnType<createRateLimiter>} options.limiter
 * @param {boolean} [options.trustProxy]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.log]
 */
export async function handleRpc(req, res, { upstream, cluster = 'mainnet', limiter, trustProxy = false, fetchImpl = fetch, log = () => {} }) {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'this endpoint takes POST', { allow: 'POST' });
  }

  const key = clientKey(req, { trustProxy });
  const { allowed, retryAfter } = limiter.take(key);
  if (!allowed) {
    return jsonError(res, 429, 'too many requests', { 'retry-after': String(retryAfter) });
  }

  let payload;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    payload = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    if (error.status === 413) return jsonError(res, 413, 'request too large');
    return jsonError(res, 400, 'request body is not JSON');
  }

  const verdict = screen(payload);
  if (!verdict.ok) {
    // The reason is logged, not returned. Telling a caller which methods are
    // refused is telling them which are not.
    log(`rpc: refused from ${key} — ${verdict.reason}`);
    return jsonError(res, verdict.status, 'that request is not allowed here');
  }

  // Screening happens above this line on purpose: a request that would be
  // refused is refused whether or not this server has an upstream, so an
  // unconfigured deployment still answers 403 to a probe rather than telling it
  // to come back later. It also means the allowlist can be exercised against a
  // real web3.js client without a provider key anywhere near the test.
  if (!upstream) {
    // A configuration fault, said plainly: the page renders "can't reach
    // Solana", and whoever deployed it needs to know why from the log — which
    // names the variable AND the cluster, because with one per cluster the
    // interesting mistake is having set the other one.
    log(
      `rpc: no upstream for ${cluster} — set ` +
        (cluster === 'devnet' ? 'CALLPOOL_RPC_URL_DEVNET' : 'CALLPOOL_RPC_URL_MAINNET'),
    );
    return jsonError(res, 503, 'the RPC endpoint is not configured on this server');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    // A fresh request. None of the caller's headers are forwarded — they have
    // no business reaching the provider, and one of them could carry an
    // identity we did not intend to spend.
    const upstreamResponse = await fetchImpl(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      // Never the provider's body: it can name the endpoint, and the endpoint
      // is the key.
      log(`rpc: upstream ${upstreamResponse.status} for ${verdict.calls} call(s)`);
      return jsonError(res, 502, 'the RPC provider returned an error');
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (error) {
    const timedOut = error.name === 'AbortError';
    log(`rpc: upstream ${timedOut ? 'timed out' : `failed — ${error.message}`}`);
    return jsonError(res, 504, timedOut ? 'the RPC provider timed out' : 'could not reach the RPC provider');
  } finally {
    clearTimeout(timer);
  }
}
