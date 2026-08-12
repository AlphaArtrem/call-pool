// scripts/lib/rpc.mjs — one Connection factory, with retries underneath it.
//
// Why this exists, in one sentence: on 2026-08-05 the devnet dry run posted
// epoch 1's root, then died on a single `TypeError: fetch failed` before paying
// anybody, and the loop stopped with money owed and unsent.
//
// That failure is worth reading carefully, because the shape of it is the point:
//
//   * The trusted, once-only action succeeded and finalized.
//   * The repeatable one did not.
//   * Recovery was one re-run of airdrop.mjs, which correctly reported
//     "3 leaves, 3 unpaid" and sent them.
//
// So the ordering in crank.mjs is right and is not what needs changing. What
// needed changing is that one dropped TCP connection anywhere in a multi-minute
// job aborted the whole thing. `chain.mjs` already had `withRetry`, but it wrapped
// exactly two calls — `getSignaturesForAddress` and `getParsedTransactions` —
// while thirteen scripts each built their own bare `new Connection(...)` and every
// other RPC call went out unprotected.
//
// Wrapping each method at each call site would be thirteen edits and a fourteenth
// one forgotten later. `Connection` takes the `fetch` it uses as an option, so
// putting the retry there covers every call through the connection, including the
// ones web3.js makes internally that no wrapper of ours could reach — which is
// precisely where the dry run died (`getAccountInfo`, inside `ClientBrowser`).
//
// **This does not make the crank safe to leave unwatched.** Phase 09 §9.3 is
// about a scheduled job that dies quietly looking exactly like a rug from
// outside; retries make that rarer, not impossible. Alert on the *absence* of a
// completed airdrop, not only on errors.

// A second failure, 2026-08-08, needed a second answer in the same place. The
// 63-wallet replay hit QuickNode's 15 req/s cap and every retry below hit it
// too: backoff spaces out *one* request's attempts, it does not slow the job
// down, so the run spent its five attempts inside six seconds of a rate limit
// that lasts as long as the job does. Retrying a self-inflicted 429 is just
// asking the same question faster. The fix is to not exceed the cap in the
// first place — see `pacedFetch`.

// A third failure, 2026-08-12, needed a third answer here. Ankr's mainnet
// endpoint — keyed, allowlisted, answering `getSlot` in 80ms — accepted the
// connection for a large `getProgramAccounts` and then sent nothing back: no
// status to retry, no throw to catch, just a socket held open. The first
// settlement's holder snapshot hung on it for thirty-four minutes because
// nothing beneath had a clock. So every request now runs under a timeout
// (`timeoutFetch`), which turns a black-hole into the kind of throw the retry
// can see; and `failoverFetch` now treats a primary that stops answering as a
// reason to switch, not only one that answers "no". A hang on the primary is
// now a few seconds and a move to the fallback, not a stalled night.

import { Connection } from '@solana/web3.js';

/** Attempts per request, including the first. */
const ATTEMPTS = 5;

/** First backoff step; doubles each attempt — 0.4s, 0.8s, 1.6s, 3.2s. */
const BASE_DELAY_MS = 400;

/**
 * How long one request may take before it is aborted.
 *
 * A whole request's patience, not a blip's. Every healthy call this system
 * makes answers well under a second — a large `getProgramAccounts` is ~160ms on
 * dRPC — so the number is high enough that a slow-but-working endpoint is never
 * cut off, and finite so that one that has stopped answering cannot hold a job
 * open forever. Override with `CALLPOOL_RPC_TIMEOUT_MS`; `0` disables it.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Is this worth trying again?
 *
 * The distinction that matters is transient versus answered. A dropped
 * connection, a 429 or a 5xx are the endpoint being busy or unlucky. A 4xx is
 * the endpoint telling us something true — and the one we now expect to meet is
 * **403 from an IP that is not on the provider's allowlist**. Retrying that five
 * times with backoff turns an instant, accurate "this key is not allowed from
 * here" into eight seconds of silence followed by a misleading timeout. Answered
 * is answered; hand it straight back.
 */
function retryable(response, error) {
  if (error != null) return true; // network-level throw: fetch failed, ECONNRESET, socket hang up
  if (response == null) return false;
  return response.status === 429 || response.status >= 500;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch`, with backoff on the failures that are worth a second try.
 *
 * Exported for tests. Takes the underlying fetch so a test can drive it without
 * a network.
 */
export function retryingFetch(underlying = fetch, { attempts = ATTEMPTS, baseDelayMs = BASE_DELAY_MS } = {}) {
  return async function retryingFetchImpl(input, init) {
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await underlying(input, init);
        lastError = undefined;
      } catch (error) {
        lastError = error;
        response = undefined;
      }

      if (!retryable(response, lastError)) {
        if (lastError != null) throw lastError;
        return response;
      }

      // Out of attempts: give back whatever we last had rather than inventing an
      // error. A 429 body says more about what to do next than we could.
      if (attempt === attempts - 1) {
        if (lastError != null) throw lastError;
        return response;
      }

      await sleep(baseDelayMs * 2 ** attempt);
    }

    /* c8 ignore next */
    throw lastError ?? new Error('retryingFetch: unreachable');
  };
}

/**
 * `fetch`, held to at most `maxRps` request starts per second.
 *
 * Requests are not serialised — a batch still has its responses in flight
 * together — only their *start* times are spaced, which is what a provider's
 * cap actually measures. Each caller claims the next slot as it arrives, so the
 * order requests were made in is the order they go out.
 *
 * `maxRps <= 0` disables pacing and returns the underlying fetch untouched:
 * mainnet's key has no cap worth pacing, and an unconfigured environment must
 * behave exactly as it did before this existed.
 *
 * Exported for tests. Takes the clock and sleep so a test needs no real time.
 */
export function pacedFetch(underlying = fetch, { maxRps = 0, now = () => Date.now(), sleep: wait = sleep } = {}) {
  if (!(maxRps > 0)) return underlying;

  const intervalMs = 1000 / maxRps;
  let nextSlot = 0;

  return async function pacedFetchImpl(input, init) {
    const at = now();
    const slot = Math.max(at, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > at) await wait(slot - at);
    return underlying(input, init);
  };
}

/**
 * `fetch`, with a clock on every request.
 *
 * `AbortSignal.timeout` makes a request that has not answered within
 * `timeoutMs` reject rather than wait, which is the only thing that reaches an
 * endpoint that accepts the socket and then sends nothing: no status arrives to
 * retry and no error is thrown, so without this the call waits forever. The
 * rejection it produces is transient by the reckoning of `retryable`, so the
 * retry above still gives the endpoint a few more tries; a primary that keeps
 * timing out then falls through to the fallback, which is where a black-hole
 * belongs.
 *
 * A caller's own `signal` is kept alongside the deadline where the runtime can
 * combine them, so nothing that could already cancel a request loses that.
 * `timeoutMs <= 0` returns the underlying fetch untouched, exactly as the pacer
 * does when unconfigured.
 *
 * Exported for tests. Takes the underlying fetch so a test can drive it.
 */
export function timeoutFetch(underlying = fetch, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!(timeoutMs > 0)) return underlying;

  return function timeoutFetchImpl(input, init) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal =
      init?.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
    return underlying(input, { ...init, signal });
  };
}

/**
 * Is this response the endpoint saying it is finished with us for now?
 *
 * The distinction that matters here is *busy* versus *done*. A 429 that clears
 * on the second attempt is busy, and the retry above already handled it — this
 * only ever sees what survived five attempts. A quota that has run out, a
 * suspended key, a payment wall: those do not clear by waiting, and on
 * 2026-08-08 the whole run ended on one of them (`-32003 daily request limit
 * reached`) with both hosts pointed at the same key.
 */
function exhausted(response) {
  if (response == null) return false;
  // 429 quota or rate, 402 unpaid, 403 not allowed from here, 401 key refused.
  // 401 is in the list because a rotated or mistyped key is the same situation
  // from the caller's side as a spent quota — this endpoint will not serve us,
  // and waiting will not change that. It is also the one an operator is most
  // likely to cause at 3am, which is exactly when a second endpoint earns its
  // keep. The switch is logged, so it cannot hide a bad key indefinitely.
  return [401, 402, 403, 429].includes(response.status);
}

/**
 * `fetch`, with a second endpoint for when the first one is done.
 *
 * Three properties this deliberately has, each one a lesson already paid for:
 *
 * **It fails over only after the retry has given up.** `exhausted` is asked
 * about a response that already survived five attempts, so a busy moment does
 * not move a run onto a smaller key.
 *
 * **It verifies the fallback's slot lag before trusting it.** Ankr devnet spent
 * two sessions answering HTTP 200 with a view 250k slots old, which is worse
 * than an outage: reads return `null` for accounts that exist while writes land
 * fine. A fallback that has to be checked by hand is a fallback nobody checked,
 * so a failover that cannot verify health hands the original failure back and
 * says why.
 *
 * **It is sticky, and it is loud.** Once switched the process stays switched —
 * alternating endpoints mid-run makes read-after-write staleness a coin toss —
 * and it prints the switch, because an endpoint that changed silently is a
 * whole class of "impossible" symptom in a system whose reads are its evidence.
 */
export function failoverFetch(underlying, { fallbackUrl, verify = verifyHealth, log = console.error } = {}) {
  if (!fallbackUrl) return underlying;

  let active = null; // the fallback, once we have switched to it
  let refused = false; // the fallback was tried, and was not healthy

  return async function failoverFetchImpl(input, init) {
    if (active) return underlying(active, init);

    // The primary is "done with us" two ways: it answered a terminal status
    // (quota spent, key refused, IP not allowed), or it never answered at all —
    // a throw that survived every retry, which since 2026-08-12 we know includes
    // an endpoint that holds a socket open and sends nothing back. A blip is
    // already gone by here; the retry beneath saw to that.
    let response;
    let thrown;
    try {
      response = await underlying(input, init);
    } catch (error) {
      thrown = error;
    }

    const done = thrown != null || exhausted(response);
    if (!done || refused) {
      if (thrown != null) throw thrown;
      return response;
    }

    const gave = thrown != null ? `stopped answering (${thrown.message})` : `answered ${response.status}`;
    const health = await verify(fallbackUrl);
    if (!health.ok) {
      refused = true;
      log(
        `rpc: the primary endpoint ${gave} and the fallback is not healthy ` +
          `(${health.reason}). Staying on the primary and handing its answer back.`,
      );
      if (thrown != null) throw thrown;
      return response;
    }

    active = fallbackUrl;
    log(`rpc: the primary endpoint ${gave}; switched to the fallback for the rest of this process.`);
    return underlying(active, init);
  };
}

/**
 * Does this endpoint serve a current view of the chain?
 *
 * `getHealth` is the one call that answers both questions at once: an endpoint
 * that is behind says so here (`Node is behind by N slots`) while still
 * answering `getSlot` with a stale number as though nothing were wrong.
 */
export async function verifyHealth(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: `getHealth returned HTTP ${response.status}` };
    const body = await response.json();
    if (body?.result === 'ok') return { ok: true, reason: 'ok' };
    return { ok: false, reason: body?.error?.message ?? `getHealth returned ${JSON.stringify(body?.result)}` };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * The cap to pace to, from the environment.
 *
 * A provider's published limit, not a guess: set `CALLPOOL_RPC_MAX_RPS` to
 * something under it (QuickNode devnet is 15/s; the boxes run 12). Unset means
 * unpaced, which is what every path that is not rate limited wants.
 */
function configuredMaxRps(env = process.env) {
  const raw = env.CALLPOOL_RPC_MAX_RPS;
  if (raw == null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`CALLPOOL_RPC_MAX_RPS must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * The per-request timeout, from the environment.
 *
 * Unset means `DEFAULT_TIMEOUT_MS`; `0` disables the clock, for a caller that
 * really does want the old wait-forever behaviour. Anything else is treated as
 * milliseconds.
 */
function configuredTimeoutMs(env = process.env) {
  const raw = env.CALLPOOL_RPC_TIMEOUT_MS;
  if (raw == null || raw === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`CALLPOOL_RPC_TIMEOUT_MS must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * A Connection that survives a blip.
 *
 * Use this everywhere a script talks to a cluster. The only deliberate
 * exception is the website (`site/js/addresses.js`), which must NOT retry
 * silently: the page re-reads once a minute, keeps the last good figure on
 * screen and says how old it is, and burying failures under retries would make
 * a stale number look live. Different job, different answer.
 */
export function connect(rpc, commitment = 'confirmed') {
  // Four layers, and the order is the argument:
  //
  //   failover   outermost — asked only about what the retry could not fix
  //   retry      a blip, five attempts with backoff
  //   pacing     every attempt, including retries, waits its turn
  //   timeout    innermost — each attempt is given a clock, so a request that
  //              never answers becomes a throw the layers above can act on
  //
  // Pacing under the retry stops a burst of retries walking through the cap
  // that caused them. Failover over the retry stops a busy moment from moving a
  // run onto the smaller key. The timeout under the pacer bounds the request
  // itself, not the wait for its slot.
  const fetchImpl = failoverFetch(
    retryingFetch(pacedFetch(timeoutFetch(fetch, { timeoutMs: configuredTimeoutMs() }), { maxRps: configuredMaxRps() })),
    { fallbackUrl: process.env.CALLPOOL_RPC_URL_FALLBACK || null },
  );
  return new Connection(rpc, { commitment, fetch: fetchImpl });
}
