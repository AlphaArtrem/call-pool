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

import { Connection } from '@solana/web3.js';

/** Attempts per request, including the first. */
const ATTEMPTS = 5;

/** First backoff step; doubles each attempt — 0.4s, 0.8s, 1.6s, 3.2s. */
const BASE_DELAY_MS = 400;

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
 * A Connection that survives a blip.
 *
 * Use this everywhere a script talks to a cluster. The only deliberate
 * exception is the website (`site/js/addresses.js`), which must NOT retry
 * silently: the page re-reads once a minute, keeps the last good figure on
 * screen and says how old it is, and burying failures under retries would make
 * a stale number look live. Different job, different answer.
 */
export function connect(rpc, commitment = 'confirmed') {
  // Pacing goes *underneath* the retry, so a retried attempt waits its turn
  // like any other request. The other order would let a burst of retries walk
  // straight through the cap that caused them.
  const fetchImpl = retryingFetch(pacedFetch(fetch, { maxRps: configuredMaxRps() }));
  return new Connection(rpc, { commitment, fetch: fetchImpl });
}
