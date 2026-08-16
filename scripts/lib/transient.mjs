// Transient RPC conditions, and the one wait that has to survive them.
//
// `rpc.mjs` gives every *request* a clock and fails over when the primary goes
// silent (commit f02f39d). That is the fetch layer, and it cannot see the class
// of failure this module is about: throws raised **above** it, by web3.js, on
// requests that were answered.
//
//   - `confirmTransaction` gives up after 30s and throws
//     `TransactionExpiredTimeoutError` — on a transaction that, on 2026-08-15,
//     had already finalized. The confirmation expired; the transaction did not.
//   - `getBlockTime(slot)` is answered by a load-balanced upstream that is one
//     slot behind the upstream that answered `getSlot` a moment earlier, and the
//     answer is an error: "no available upstreams … Upstream slot height N-1 is
//     less than N" (2026-08-14). Or it is simply `null`.
//
// Neither says anything about the chain. Both were fatal to a settlement, two
// nights running. The principle the codebase already applies to multisig races
// applies here too: **a transient RPC error is a question to ask the chain, not
// a verdict.**
//
// So the tolerance is only ever half a fix. Every caller of `isTransientRpcError`
// must, on `true`, go and read back the effect the failed call was supposed to
// prove, and still fail loudly when that effect never appears. Swallowing the
// error alone would trade a false failure for a false success, which is the
// worse of the two by a wide margin.

/** Seconds between polls in {@link chainTimeAtLeast}. */
const POLL_SECONDS = 2;

/**
 * Consecutive transient failures tolerated before a wait gives up.
 *
 * 150 × 2s ≈ 5 minutes of an RPC that answers nothing but errors. Long enough
 * that a slot-behind upstream, a failover, or a rate-limit burst passes through
 * unnoticed; short enough that a genuinely dead endpoint still fails the run
 * rather than holding a settlement open forever. The counter resets on every
 * good read, so a long legitimate wait never accumulates toward it.
 */
const MAX_CONSECUTIVE_TRANSIENT = 150;

const TRANSIENT_NAMES = new Set([
  // The confirmation's clock ran out. Says nothing about the transaction.
  'TransactionExpiredTimeoutError',
  // The blockhash expired before confirmation was observed. Usually means the
  // transaction did not land — but "usually" is not "did not", so it is still a
  // question for the chain rather than an answer.
  'TransactionExpiredBlockheightExceededError',
  // `AbortSignal.timeout` in rpc.mjs's timeoutFetch, surfacing as a throw.
  'TimeoutError',
  'AbortError',
]);

const TRANSIENT_MESSAGES = [
  /was not confirmed in/i,
  /block height exceeded/i,
  // dRPC / load-balanced upstream lag, both spellings it has produced.
  /no available upstreams/i,
  /upstream slot height/i,
  /failed to get block time/i,
  /blockhash not found/i,
  /node is behind/i,
  /timed ?out|timeout/i,
  /socket hang up|fetch failed|network error|econnreset|etimedout|eai_again|enotfound/i,
  /too many requests|service unavailable|bad gateway|gateway time-?out/i,
];

/**
 * Is this error the endpoint failing to answer, rather than the chain answering?
 *
 * Deliberately narrow. An Anchor or SPL program failure arrives as "custom
 * program error", a Squads collision as `ConstraintSeeds` / `AlreadyInitialized`,
 * a refusal from this codebase as its own prose — none of which match anything
 * here, and none of which should be retried against the chain as if the truth
 * were still in doubt.
 *
 * `fetch` wraps its cause, so the chain of causes is checked too.
 */
export function isTransientRpcError(error, depth = 3) {
  if (!error || depth < 0) return false;
  if (TRANSIENT_NAMES.has(error.name)) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  if (message && TRANSIENT_MESSAGES.some((pattern) => pattern.test(message))) return true;
  return isTransientRpcError(error.cause, depth - 1);
}

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

/**
 * Block until the **cluster's** clock reaches `target`, and return it.
 *
 * The cluster's clock, not this host's, because that is the clock the program
 * compares against: `claim` rejects a payout the validator still considers
 * inside the challenge window, whatever `Date.now()` here believes.
 *
 * Reading it takes two calls — `getSlot` then `getBlockTime` — and they can be
 * answered by different upstreams, so the second can fail purely because it has
 * not caught up with the first. Inside a loop that is about to sleep and ask
 * again anyway, that is not a failure at all; it is the poll working. It became
 * a failure only because the read was written as a single unguarded expression.
 *
 * A *persistent* failure still throws: see {@link MAX_CONSECUTIVE_TRANSIENT}.
 *
 * @param {object} connection            web3.js Connection (or a fake, in tests)
 * @param {number} target                unix seconds to wait for
 * @param {(now: number) => void} [options.onWait]  called once, when the wait begins
 */
export async function chainTimeAtLeast(
  connection,
  target,
  { sleepFn = sleep, onWait, pollSeconds = POLL_SECONDS, maxTransient = MAX_CONSECUTIVE_TRANSIENT } = {},
) {
  let failures = 0;
  let lastReason = '';
  let announced = false;

  for (;;) {
    let now = null;
    try {
      const slot = await connection.getSlot('confirmed');
      now = await connection.getBlockTime(slot);
      // Not an error, and not a time either. Same treatment: ask again.
      if (now == null) lastReason = `the RPC returned no block time for slot ${slot}`;
    } catch (error) {
      if (!isTransientRpcError(error)) throw error;
      lastReason = error.message;
      now = null;
    }

    if (now == null) {
      failures += 1;
      if (failures > maxTransient) {
        throw new Error(
          `the RPC has not served a block time in ${failures} consecutive attempts ` +
            `(~${Math.round((failures * pollSeconds) / 60)} minutes) while waiting for ` +
            `${new Date(target * 1000).toISOString()}. This is no longer transient — ` +
            `check the endpoint. The last attempt said: ${lastReason}`,
        );
      }
      await sleepFn(pollSeconds);
      continue;
    }

    failures = 0;
    if (now >= target) return now;
    if (!announced) {
      onWait?.(now);
      announced = true;
    }
    await sleepFn(pollSeconds);
  }
}
