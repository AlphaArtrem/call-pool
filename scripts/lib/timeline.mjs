// The minimum-balance computation, with no RPC in it.
//
// This is the load-bearing arithmetic of the whole project: `hold(w, d)` is
// the weight, and everything downstream is division. Keeping it pure means it
// can be tested exhaustively against synthetic histories offline (see
// scripts/tests/) and then confirmed against real devnet history (proofs 4, 6
// and 19) without the two sharing any code path that could hide a bug.
//
// The rule it implements, and it is settled — not a knob:
//
//   hold(w, d) = the MINIMUM balance of w's associated token account for the
//                mint at any point during day d.
//
// One account. No summing across accounts, no netting, no exception for
// moving tokens between wallets the same person owns. Any transfer out is a
// sale.
//
// `extractBalanceEvent` lives here too, and it belongs here for the same
// reason everything else does: it is pure, it takes an already-parsed
// transaction and returns two integers, and it touches no network. It sat in
// chain.mjs until Phase 07, when the website needed it — chain.mjs imports
// `@solana/spl-token`, which a browser cannot load, so leaving it there would
// have meant a second copy of the step that turns RPC shapes into the numbers
// `hold` is computed from. `chain.mjs` re-exports it, so nothing else moved.

/**
 * @typedef {object} BalanceEvent
 * @property {string}  signature   the transaction that changed the balance
 * @property {number}  slot
 * @property {number|null} blockTime  unix seconds
 * @property {bigint}  pre         raw balance before the transaction
 * @property {bigint}  post        raw balance after it
 */

/**
 * @typedef {object} Window
 * @property {number} start  unix seconds, inclusive
 * @property {number} end    unix seconds, exclusive
 */

/** Thrown when the input cannot support an exact answer. Never guess instead. */
export class TimelineError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TimelineError';
    this.detail = detail;
  }
}

/**
 * Assert the event list is a complete, ordered history of one token account.
 *
 * Two things are checked, and both exist to catch the same failure: an RPC
 * that silently returns partial history. Phase 05 §5.6 calls that "the most
 * likely real bug in the whole system", because a gap produces a `hold` that
 * is plausibly wrong rather than obviously wrong.
 *
 * @param {BalanceEvent[]} events  oldest first
 */
export function assertContiguous(events) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.pre < 0n || e.post < 0n) {
      throw new TimelineError('negative balance in event', { event: e });
    }
    if (i === 0) continue;

    const prev = events[i - 1];
    if (e.slot < prev.slot) {
      throw new TimelineError('events are not ordered oldest-first', {
        at: i,
        previous: prev.signature,
        current: e.signature,
      });
    }
    if (e.pre !== prev.post) {
      // The only honest reading of this is that a transaction between the two
      // was not fetched. Fail the epoch rather than publish a guess.
      throw new TimelineError(
        'gap in balance history — a transaction is missing between these two',
        {
          previous: { signature: prev.signature, slot: prev.slot, post: prev.post.toString() },
          current: { signature: e.signature, slot: e.slot, pre: e.pre.toString() },
        },
      );
    }
  }
}

/**
 * The balance at the first instant of the window.
 *
 * Phase 05 §5.2's seeding rule, generalised so it is also correct when
 * re-deriving an old epoch rather than the one that just closed:
 *
 *   1. an event inside the window   → its `pre`
 *   2. otherwise the last event before the window → its `post`
 *   3. otherwise the first event after the window → its `pre`
 *   4. otherwise no transfer bounds the window at all → `currentBalance`
 *
 * Case 2 is the one the naive implementation gets wrong: a wallet that bought
 * once and then sat still has no in-window activity, and reading that as zero
 * underpays exactly the holders the mechanic is meant to reward. That is
 * devnet proof 6.
 *
 * @param {BalanceEvent[]} events  oldest first, already asserted contiguous
 * @param {Window} window
 * @param {bigint|null} currentBalance  the account's balance now, if known
 * @returns {bigint}
 */
export function seedBalance(events, window, currentBalance = null) {
  const placed = events.map((e) => {
    if (e.blockTime == null) {
      throw new TimelineError('event has no blockTime, so it cannot be placed in the epoch', {
        signature: e.signature,
        slot: e.slot,
      });
    }
    return e;
  });

  const inWindow = placed.filter((e) => e.blockTime >= window.start && e.blockTime < window.end);
  if (inWindow.length > 0) return inWindow[0].pre;

  const before = placed.filter((e) => e.blockTime < window.start);
  if (before.length > 0) return before[before.length - 1].post;

  const after = placed.filter((e) => e.blockTime >= window.end);
  if (after.length > 0) return after[0].pre;

  if (currentBalance == null) {
    throw new TimelineError(
      'no transfer bounds this window and no current balance was supplied — cannot seed the timeline',
      { window },
    );
  }
  return currentBalance;
}

/**
 * `hold(w, d)` — the minimum balance held at any point in the window.
 *
 * The balance is piecewise constant between transactions, so the minimum over
 * the window is the minimum of the opening balance and every post-transaction
 * balance inside it. Nothing can hide between two transactions, which is why
 * this is exact where hourly sampling is only approximate (Phase 05 §5.11).
 *
 * @param {BalanceEvent[]} events  oldest first
 * @param {Window} window
 * @param {{ currentBalance?: bigint|null }} [options]
 * @returns {{
 *   hold: bigint,
 *   opening: bigint,
 *   closing: bigint,
 *   maximum: bigint,
 *   events: BalanceEvent[],
 *   points: Array<{ at: number|null, balance: bigint, signature: string|null }>,
 * }}
 */
export function computeHold(events, window, options = {}) {
  const { currentBalance = null } = options;
  assertContiguous(events);

  const opening = seedBalance(events, window, currentBalance);
  const inWindow = events.filter(
    (e) => e.blockTime != null && e.blockTime >= window.start && e.blockTime < window.end,
  );

  const points = [{ at: window.start, balance: opening, signature: null }];
  let hold = opening;
  let maximum = opening;
  let closing = opening;

  for (const e of inWindow) {
    points.push({ at: e.blockTime, balance: e.post, signature: e.signature });
    if (e.post < hold) hold = e.post;
    if (e.post > maximum) maximum = e.post;
    closing = e.post;
  }

  return { hold, opening, closing, maximum, events: inWindow, points };
}

/**
 * Every balance decrease inside a window — the evidence behind `locked`.
 *
 * A decrease is any transaction where the account ends with less than it
 * started with. Destination is irrelevant: sending to a second wallet you own
 * yourself is a sale (L6), and that is devnet proof 19.
 *
 * @param {BalanceEvent[]} events
 * @param {Window} window
 * @returns {BalanceEvent[]}
 */
export function decreasesIn(events, window) {
  return events.filter(
    (e) =>
      e.blockTime != null &&
      e.blockTime >= window.start &&
      e.blockTime < window.end &&
      e.post < e.pre,
  );
}

/**
 * `locked(w, d)` — true when the wallet sold in any of the epochs preceding d.
 *
 * Buying back does not shorten it and there is no proportional relief: this is
 * a hard cliff, ruled on deliberately in L1 and Decision 23.
 *
 * @param {BalanceEvent[]} events
 * @param {Window} lockoutWindow  the `epochs` whole epochs before the epoch
 * @returns {{ locked: boolean, decreases: BalanceEvent[] }}
 */
export function computeLocked(events, lockoutWindow) {
  const decreases = decreasesIn(events, lockoutWindow);
  return { locked: decreases.length > 0, decreases };
}

/**
 * One parsed transaction → at most one balance event for the account we care
 * about.
 *
 * This is where the SPL-token response shape gets turned into two integers,
 * and the two absence cases are easy to get wrong. An account missing from
 * `preTokenBalances` was created by this transaction (balance was 0 before);
 * missing from `postTokenBalances` means it was closed (balance is 0 after).
 *
 * Pure: it takes an already-parsed transaction object and reads no network.
 * Both the crank (via chain.mjs) and the website call this exact function, so
 * a holder's browser and the settlement job cannot disagree about what a
 * transaction did to a balance.
 *
 * @returns {BalanceEvent|null}
 */
export function extractBalanceEvent(tx, accountKey, signature) {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((k) => (k.pubkey?.toBase58?.() ?? String(k.pubkey)) === accountKey);
  if (index === -1) return null;

  const find = (list) => (list ?? []).find((b) => b.accountIndex === index);
  const pre = find(tx.meta?.preTokenBalances);
  const post = find(tx.meta?.postTokenBalances);
  if (!pre && !post) return null; // touched the account without moving tokens

  const preRaw = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
  const postRaw = post ? BigInt(post.uiTokenAmount.amount) : 0n;
  if (preRaw === postRaw) return null; // no step in a piecewise-constant timeline

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    pre: preRaw,
    post: postRaw,
  };
}
