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
  let floorMin = opening;
  let maximum = opening;
  let closing = opening;

  for (const e of inWindow) {
    points.push({ at: e.blockTime, balance: e.post, signature: e.signature });
    if (e.post < floorMin) floorMin = e.post;
    if (e.post > maximum) maximum = e.post;
    closing = e.post;
  }

  // ── L20 — when the wallet first held anything in this window ──────────────
  //
  // Everything below exists because `min(balance over the window)` treated "had
  // not bought yet" identically to "sold", so **every new holder earned nothing
  // on their first day, permanently**. Their balance at 00:00 was zero, so their
  // minimum was zero.
  //
  // The zero before a first purchase is not a decrease and must not be read as
  // one. `firstHeldAt` is where the wallet's day actually starts.
  const firstHeld = opening > 0n ? null : inWindow.find((e) => e.post > 0n) ?? null;
  const heldFromStart = opening > 0n;
  const firstHeldAt = heldFromStart ? window.start : firstHeld?.blockTime ?? null;

  // ── L21 — credited for what you KEEP ─────────────────────────────────────
  //
  // One sentence: **at any moment you are credited with the smallest balance you
  // still hold for the rest of the day.**
  //
  // That single rule produces the asymmetry deliberately, and it is the whole
  // point of L21:
  //
  //   * **Topping up pays, from when it lands.** The minutes before an increase
  //     are still capped by the smaller balance you held then, so there is no
  //     retroactive credit — but every minute after counts at the higher one.
  //   * **Selling costs the whole day, retroactively.** A decrease at 18:00 caps
  //     every earlier minute at the lower balance too, because from any earlier
  //     instant that lower balance is what you still hold by the day's end. Sell
  //     down to 120,000 and the day is worth 120,000, exactly as before.
  //
  // The balance is piecewise constant between transactions, so this is a suffix
  // minimum over the segments and then a time-weighted sum. Nothing can hide
  // between two transactions.
  const windowSeconds = BigInt(window.end - window.start);
  const heldSeconds = firstHeldAt == null ? 0n : BigInt(window.end - firstHeldAt);

  /** Segments of constant balance from `firstHeldAt` to the window's end. */
  const segments = [];
  if (firstHeldAt != null) {
    const changes = inWindow.filter((e) => e.blockTime >= firstHeldAt);
    let at = firstHeldAt;
    let balance = heldFromStart ? opening : firstHeld.post;
    // When the wallet held from the open, the first in-window event is a change
    // *away* from `opening`; when it bought inside the window, the event that
    // started the holding is itself the first balance and must not re-open a
    // segment at the same instant.
    for (const e of changes) {
      if (e === firstHeld) continue;
      segments.push({ from: at, to: e.blockTime, balance });
      at = e.blockTime;
      balance = e.post;
    }
    segments.push({ from: at, to: window.end, balance });
  }

  // Suffix minima, walked backwards: `keeps` is the smallest balance still held
  // from this segment onward.
  let running = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    running = running == null || segments[i].balance < running ? segments[i].balance : running;
    segments[i].keeps = running;
  }

  // The floor gate is the same number as before: the lowest balance held while
  // holding anything, which is exactly the suffix minimum at the first segment.
  // A dip below the floor still costs the whole day.
  const sustained = segments.length > 0 ? segments[0].keeps : 0n;

  // Integer division truncates, and it is applied once at the end rather than
  // per segment — dividing inside the loop would round every segment down and
  // lose real weight. The remainder stays in the pool, which is the safe
  // direction: an epoch may under-allocate harmlessly, but over-allocating
  // turns claims into a race.
  let weighted = 0n;
  for (const s of segments) {
    const seconds = BigInt(Math.max(0, s.to - s.from));
    weighted += s.keeps * seconds;
  }
  const hold = windowSeconds === 0n ? 0n : weighted / windowSeconds;

  return {
    hold,
    // Kept separate because they answer different questions: `sustained` decides
    // whether the wallet qualifies at all, `hold` decides how much of the split
    // it gets. Collapsing them is what made a late buyer of 500,000 tokens fail
    // a 100,000 floor on a prorated number.
    sustained,
    firstHeldAt,
    heldSeconds: Number(heldSeconds),
    windowSeconds: Number(windowSeconds),
    segments,
    opening,
    closing,
    maximum,
    events: inWindow,
    points,
  };
}

/**
 * Every balance decrease inside a window — the evidence behind `locked`.
 *
 * A decrease is any transaction where the account ends with less than it
 * started with. Destination is irrelevant: sending to a second wallet you own
 * yourself is a sale (L6), and that is devnet proof 19.
 *
 * **One exception, L16: supplying liquidity to the coin's own pump.fun pool.**
 * See `computeLocked` for why that is the only exception and how it is told
 * apart from a sale.
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
 * ── L16: supplying liquidity is not selling ────────────────────────────────
 *
 * Depositing into the coin's pump.fun pool empties the wallet's token account,
 * which every rule above reads as a transfer out and punishes with a 7-epoch
 * lockout. That is a week's exclusion for doing the one thing that makes the
 * coin tradeable, and it was never the intent.
 *
 * **The destination cannot be what distinguishes it.** Selling and depositing
 * send the coin to the *same account* — the bonding curve before graduation,
 * the AMM pool after it — so a rule of the form "exempt decreases whose
 * counterparty is a known pool" exempts selling, which is the entire mechanic.
 * That looks like the obvious implementation and it is the dangerous one.
 *
 * What actually separates them is what comes **back**: a deposit mints the
 * pool's LP tokens to the depositor and a sale does not. LP tokens cannot be
 * obtained without depositing, so this cannot be used to launder a sale. The LP
 * mint is a pure PDA of the coin's mint (`pump-addresses.mjs`), so recognising
 * one costs no extra RPC call and no trust.
 *
 * Deliberately narrow, and the site must say so in these words: **this exempts
 * the lockout, not the exclusion.** While the tokens are in the pool the wallet
 * holds ~0, so `hold` is ~0 and it earns ~nothing for those epochs regardless.
 * What it no longer does is lose the following week as well. Crediting LP'd
 * tokens toward `hold` is a different and much larger change, deliberately not
 * made: it would open LP-and-withdraw cycling, which L1 currently closes.
 *
 * Only the coin's **canonical pump.fun pool** counts. Liquidity supplied
 * anywhere else is indistinguishable from a sale from here, and is still a
 * lockout — which is the safe direction for the boundary to fall.
 *
 * @param {BalanceEvent[]} events
 * @param {Window} lockoutWindow  the `epochs` whole epochs before the epoch
 * @returns {{ locked: boolean, decreases: BalanceEvent[], lpDeposits: BalanceEvent[] }}
 */
export function computeLocked(events, lockoutWindow) {
  const all = decreasesIn(events, lockoutWindow);
  const lpDeposits = all.filter((e) => e.lpDeposit === true);
  const decreases = all.filter((e) => e.lpDeposit !== true);
  return { locked: decreases.length > 0, decreases, lpDeposits };
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
export function extractBalanceEvent(tx, accountKey, signature, { lpMint = null } = {}) {
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

  const event = {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    pre: preRaw,
    post: postRaw,
  };

  // L16. Only asked on the way down: a decrease is the only thing the lockout
  // reads, and an increase that happens to arrive with LP tokens is not a
  // question anyone has.
  if (lpMint != null && postRaw < preRaw) {
    // The owner is read off this account's own balance record rather than
    // passed in. `balanceEventsFor` is given an ATA, not the wallet behind it,
    // and re-deriving the owner would mean an extra RPC call per account for
    // something the transaction already states.
    const owner = post?.owner ?? pre?.owner ?? null;
    if (owner != null) event.lpDeposit = isLpDeposit(tx, owner, lpMint);
  }

  return event;
}

/**
 * Did this transaction mint the pool's LP tokens to `owner`?
 *
 * The test for L16, and the reason it is a test on what came *back* rather than
 * on where the coin went: a sale and a deposit share a destination. LP tokens
 * cannot be obtained without depositing, so an increase in them is evidence a
 * sale cannot manufacture.
 *
 * Strictly an *increase*. A wallet that already held LP tokens and then sold
 * the coin would otherwise be exempted by a balance it had all along.
 *
 * @param {object} tx        a parsed transaction
 * @param {string} owner     the wallet, base58
 * @param {string} lpMint    the pool's LP mint, base58
 */
export function isLpDeposit(tx, owner, lpMint) {
  const of = (list) =>
    (list ?? []).filter((b) => b.mint === lpMint && b.owner === owner);

  const before = new Map(of(tx.meta?.preTokenBalances).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  return of(tx.meta?.postTokenBalances).some(
    (b) => BigInt(b.uiTokenAmount.amount) > (before.get(b.accountIndex) ?? 0n),
  );
}
