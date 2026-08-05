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
 * A Connection that survives a blip.
 *
 * Use this everywhere a script talks to a cluster. The only deliberate
 * exception is the website (`site/js/addresses.js`), which must NOT retry
 * silently: the page re-reads once a minute, keeps the last good figure on
 * screen and says how old it is, and burying failures under retries would make
 * a stale number look live. Different job, different answer.
 */
export function connect(rpc, commitment = 'confirmed') {
  return new Connection(rpc, { commitment, fetch: retryingFetch() });
}
