// Offline tests for the minimum-balance arithmetic.
//
// These run with no RPC and no keys, against synthetic histories whose answers
// are known by construction. They are not a substitute for the devnet proofs
// (4, 6 and 19) — those confirm that real chain data reaches this code in the
// shape it expects — but they are what makes each edge case cheap to pin down.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EPOCH_SECONDS,
  LOCKOUT_EPOCHS,
  MAX_ELIGIBLE_WALLETS,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
} from '../lib/config.mjs';
import { lockoutWindow, windowForDay } from '../lib/epoch.mjs';
import {
  assertContiguous,
  computeHold,
  computeLocked,
  decreasesIn,
  seedBalance,
  TimelineError,
} from '../lib/timeline.mjs';
import { extractBalanceEvent } from '../lib/chain.mjs';

const DAY = '2026-08-04';
const W = windowForDay(DAY);
const LOCK = lockoutWindow(W, LOCKOUT_EPOCHS);

/** Whole tokens → raw units, so the tests read in the units humans use. */
const T = (n) => BigInt(n) * 1_000_000n;

/** A balance event at `hoursIntoDay` past the epoch start (may be negative). */
let counter = 0;
function at(hoursFromEpochStart, pre, post) {
  counter += 1;
  const blockTime = W.start + Math.round(hoursFromEpochStart * 3600);
  return {
    signature: `sig${counter}`,
    slot: 1000 + counter,
    blockTime,
    pre: T(pre),
    post: T(post),
  };
}

test('config: the floor is 0.01% of supply, in raw units, per L12', () => {
  assert.equal(MIN_HOLD_TOKENS, 100_000n);
  assert.equal(MIN_HOLD_RAW, 100_000_000_000n);
  // The ceiling on the eligible set, which bounds the tree, the bitmap and the
  // airdrop gas bill. L12 raised it from 2,000.
  assert.equal(MAX_ELIGIBLE_WALLETS, 10_000);
});

test('epoch windows are UTC calendar days', () => {
  assert.equal(W.end - W.start, EPOCH_SECONDS);
  assert.equal(new Date(W.start * 1000).toISOString(), '2026-08-04T00:00:00.000Z');
  assert.equal(LOCK.end, W.start);
  assert.equal(LOCK.start, W.start - LOCKOUT_EPOCHS * EPOCH_SECONDS);
  assert.throws(() => windowForDay('4 Aug 2026'), /YYYY-MM-DD/);
});

// The epoch length is an `initialize` argument, so it is not always 86,400.
// `lockoutWindow` hardcoded the constant until 2026-08-05, which made the
// lookback seven *days* on any deployment running short epochs — including the
// one inside the verifier the crank runs before posting a root.
test('the lockout scales with the epoch length, not with the calendar', () => {
  const short = { start: 1_785_801_600, end: 1_785_801_600 + 300 };
  const lock = lockoutWindow(short, LOCKOUT_EPOCHS);

  assert.equal(lock.end, short.start);
  assert.equal(lock.start, short.start - LOCKOUT_EPOCHS * 300, '7 epochs of 300s, not 7 days');

  // The boundary the whole rule turns on, at a length that is not a day: a sale
  // one epoch back locks, one epoch further back has expired.
  const decrease = (secondsBack) => ({
    signature: `s${secondsBack}`,
    slot: 1,
    blockTime: short.start - secondsBack,
    pre: 500n,
    post: 400n,
  });
  assert.equal(computeLocked([decrease(300)], lock).locked, true, '1 epoch back locks');
  assert.equal(computeLocked([decrease(7 * 300)], lock).locked, true, '7 epochs back still locks');
  assert.equal(
    computeLocked([decrease(7 * 300 + 1)], lock).locked,
    false,
    'past 7 epochs it has expired',
  );
});

// ── proof 4 ────────────────────────────────────────────────────────────────
// "A wallet buys, calls, sells half, rebuys; hold must return the trough, not
// the closing balance or the maximum."

test('proof 4: hold is the trough, not the close and not the maximum', () => {
  const history = [
    at(-30, 0, 1_000_000), // opening position, set before the epoch
    at(6, 1_000_000, 500_000), // sold half, mid-epoch
    at(18, 500_000, 1_200_000), // bought back, more than before
  ];

  const r = computeHold(history, W);
  assert.equal(r.opening, T(1_000_000));
  assert.equal(r.maximum, T(1_200_000));
  assert.equal(r.closing, T(1_200_000));
  assert.equal(r.hold, T(500_000), 'the trough is what is paid on');
});

test('proof 4: rebuying inside the epoch does not repair the trough', () => {
  const history = [
    at(-1, 0, 800_000),
    at(2, 800_000, 0), // dumped everything an hour into the day
    at(3, 0, 800_000), // and rebought an hour later
  ];
  assert.equal(computeHold(history, W).hold, 0n);
});

test('buying an hour before the close earns nothing for the day', () => {
  const history = [at(23, 0, 5_000_000)];
  const r = computeHold(history, W, { currentBalance: T(5_000_000) });
  assert.equal(r.opening, 0n, 'the minimum includes the hours holding nothing');
  assert.equal(r.hold, 0n);
});

// ── proof 6 ────────────────────────────────────────────────────────────────
// "A wallet that transacted only *before* the epoch still shows a flat
// non-zero timeline." The seeding bug: reading this as zero underpays exactly
// the holders the mechanic exists to reward.

test('proof 6: a wallet that only ever bought before the epoch holds its balance', () => {
  const history = [at(-72, 0, 250_000)]; // bought three days earlier, then sat still
  const r = computeHold(history, W, { currentBalance: T(250_000) });

  assert.equal(r.opening, T(250_000));
  assert.equal(r.hold, T(250_000), 'flat, non-zero — not seeded from the empty window');
  assert.equal(r.events.length, 0);
  assert.equal(r.points.length, 1);
});

test('proof 6: seeding also works when the only transfer comes after the epoch', () => {
  // Re-deriving an old epoch: the seed has to come from the *next* transfer's
  // pre-balance, because there is nothing before the window to read.
  const history = [at(40, 700_000, 0)];
  const r = computeHold(history, W);
  assert.equal(r.hold, T(700_000));
});

test('seeding falls back to the current balance only when nothing bounds the window', () => {
  const r = computeHold([], W, { currentBalance: T(42) });
  assert.equal(r.hold, T(42));
  assert.throws(() => computeHold([], W), TimelineError);
});

test('seedBalance prefers the in-window opening over the prior close', () => {
  const history = [at(-5, 0, 900), at(4, 900, 100)];
  assert.equal(seedBalance(history, W), T(900));
});

// ── proof 19 ───────────────────────────────────────────────────────────────
// "Sending tokens to your own second wallet triggers the lockout." L6: any
// transfer out is a sale. No netting, no summing, no housekeeping exemption.

test('proof 19: a transfer to the owner\'s own second wallet collapses hold', () => {
  const history = [
    at(-10, 0, 1_000_000),
    at(8, 1_000_000, 0), // consolidating into another wallet the same person owns
  ];
  const r = computeHold(history, W);
  assert.equal(r.hold, 0n, 'the destination is irrelevant — it left the account');
  assert.equal(decreasesIn(history, W).length, 1);
});

test('proof 19: the decrease locks the following 7 epochs', () => {
  const sale = at(-10, 1_000_000, 400_000); // sold ten hours before this epoch
  const { locked, decreases } = computeLocked([sale], LOCK);
  assert.equal(locked, true);
  assert.equal(decreases.length, 1);
  assert.equal(decreases[0].signature, sale.signature);
});

test('the lockout is exactly 7 epochs, not 6 and not 8', () => {
  const hours = (epochsBack) => -epochsBack * 24;
  const decrease = (epochsBack) => at(hours(epochsBack) + 1, 500, 400);

  // A sale on the epoch's own day is paid for by the minimum collapsing, so it
  // must NOT also count here — that would make the penalty 8 days.
  assert.equal(computeLocked([at(1, 500, 400)], LOCK).locked, false);

  assert.equal(computeLocked([decrease(1)], LOCK).locked, true, '1 epoch back locks');
  assert.equal(computeLocked([decrease(7)], LOCK).locked, true, '7 epochs back still locks');
  assert.equal(computeLocked([decrease(8)], LOCK).locked, false, '8 epochs back has expired');
});

test('buying does not lock, and buying back does not clear a lock', () => {
  const buy = at(-20, 100, 900);
  assert.equal(computeLocked([buy], LOCK).locked, false);

  const sellThenRebuy = [at(-30, 900, 100), at(-20, 100, 2_000)];
  assert.equal(
    computeLocked(sellThenRebuy, LOCK).locked,
    true,
    'rebuying does not shorten the lockout (L1)',
  );
});

// ── window boundaries ──────────────────────────────────────────────────────

test('the window is start-inclusive and end-exclusive', () => {
  const onOpen = { ...at(0, 1_000, 300), blockTime: W.start };
  const onClose = { ...at(0, 300, 5_000), blockTime: W.end };

  const r = computeHold([onOpen, onClose], W);
  assert.equal(r.opening, T(1_000), 'a transfer at 00:00:00 is inside the day');
  assert.equal(r.hold, T(300));
  assert.equal(r.events.length, 1, 'a transfer at the next 00:00:00 belongs to the next day');
});

// ── refusing to answer ─────────────────────────────────────────────────────
// Phase 05 §5.6 calls a partial history the most likely real bug in the whole
// system, because it produces a plausible wrong number rather than an error.

test('a gap in the fetched history is refused, not smoothed over', () => {
  const history = [
    at(-5, 0, 1_000_000),
    at(6, 400_000, 400_000 - 1), // pre does not match the previous post
  ];
  assert.throws(() => assertContiguous(history), (e) => {
    assert.ok(e instanceof TimelineError);
    assert.match(e.message, /gap in balance history/);
    return true;
  });
  assert.throws(() => computeHold(history, W), TimelineError);
});

test('out-of-order events are refused', () => {
  const a = at(-5, 0, 100);
  const b = { ...at(2, 100, 50), slot: a.slot - 1 };
  assert.throws(() => assertContiguous([a, b]), /not ordered oldest-first/);
});

test('an event with no blockTime cannot be placed in an epoch', () => {
  const history = [{ ...at(2, 0, 100), blockTime: null }];
  assert.throws(() => computeHold(history, W), /no blockTime/);
});

test('a contiguous history with an account close and reopen is accepted', () => {
  // Closing the ATA takes the balance to zero; recreating it starts from zero,
  // so the chain is unbroken and the lockout fires on the close.
  const history = [at(-30, 0, 900_000), at(4, 900_000, 0), at(9, 0, 900_000)];
  assert.doesNotThrow(() => assertContiguous(history));
  assert.equal(computeHold(history, W).hold, 0n);
});

// ── the RPC response shape ─────────────────────────────────────────────────

const ACCOUNT = 'Bpf5rRHRnfWcNvqBonKD3fAtvNtvz9oNJKUJ84ULo3tt';
const OTHER = 'So11111111111111111111111111111111111111112';

function parsedTx({ pre, post, err = null, keys = [ACCOUNT, OTHER] }) {
  const balance = (index, amount) => ({
    accountIndex: index,
    mint: 'mint',
    owner: 'owner',
    uiTokenAmount: { amount: String(amount), decimals: 6 },
  });
  return {
    slot: 77,
    blockTime: W.start + 60,
    meta: {
      err,
      preTokenBalances: pre == null ? [] : [balance(0, pre)],
      postTokenBalances: post == null ? [] : [balance(0, post)],
    },
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
  };
}

test('extractBalanceEvent reads a plain transfer out', () => {
  const e = extractBalanceEvent(parsedTx({ pre: 900, post: 400 }), ACCOUNT, 'sigA');
  assert.deepEqual({ pre: e.pre, post: e.post, slot: e.slot }, { pre: 900n, post: 400n, slot: 77 });
});

test('extractBalanceEvent treats a missing pre-balance as account creation', () => {
  const e = extractBalanceEvent(parsedTx({ pre: null, post: 500 }), ACCOUNT, 'sigB');
  assert.equal(e.pre, 0n);
  assert.equal(e.post, 500n);
});

test('extractBalanceEvent treats a missing post-balance as account closure', () => {
  const e = extractBalanceEvent(parsedTx({ pre: 500, post: null }), ACCOUNT, 'sigC');
  assert.equal(e.pre, 500n);
  assert.equal(e.post, 0n, 'a closed account holds nothing — and that is a sale (L6)');
});

test('extractBalanceEvent ignores transactions that did not move the balance', () => {
  assert.equal(extractBalanceEvent(parsedTx({ pre: 500, post: 500 }), ACCOUNT, 'sigD'), null);
});

test('extractBalanceEvent ignores accounts the transaction never touched', () => {
  const tx = parsedTx({ pre: 900, post: 400, keys: [OTHER, OTHER] });
  assert.equal(extractBalanceEvent(tx, ACCOUNT, 'sigE'), null);
});

// ── balanceEventsFor, against a stub connection ────────────────────────────
//
// Added after a real failure: `extractBalanceEvent` moved to timeline.mjs in
// Phase 07 and chain.mjs re-exported it with `export ... from`, which does NOT
// bind the name in the re-exporting module's scope. Every unit test still
// passed — they call `extractBalanceEvent` directly — and `balanceEventsFor`
// threw a ReferenceError at the first RPC call, which only proof 13 caught,
// three minutes into a local-validator run.
//
// A stub connection is enough to walk the whole function without a network,
// so that class of mistake fails in a quarter of a second from now on.

function stubConnection({ signatures, transactions }) {
  return {
    async getSignaturesForAddress(_address, { before }) {
      // One page, then empty — the loop's normal termination.
      return before ? [] : signatures;
    },
    async getParsedTransactions(sigs) {
      return sigs.map((s) => transactions[s] ?? null);
    },
  };
}

test('balanceEventsFor turns RPC pages into an oldest-first timeline', async () => {
  const { balanceEventsFor } = await import('../lib/chain.mjs');

  const connection = stubConnection({
    // getSignaturesForAddress returns newest first.
    signatures: [
      { signature: 'newer', blockTime: W.start + 120 },
      { signature: 'older', blockTime: W.start - 10 },
    ],
    transactions: {
      older: parsedTx({ pre: null, post: 900 }),
      newer: parsedTx({ pre: 900, post: 400 }),
    },
  });

  const events = await balanceEventsFor(connection, ACCOUNT, W.start);
  assert.deepEqual(
    events.map((e) => e.signature),
    ['older', 'newer'],
    'oldest first — the timeline is replayed forwards',
  );
  assert.deepEqual(
    events.map((e) => [e.pre, e.post]),
    [
      [0n, 900n],
      [900n, 400n],
    ],
  );
});

test('balanceEventsFor skips failed transactions, which moved nothing', async () => {
  const { balanceEventsFor } = await import('../lib/chain.mjs');

  const connection = stubConnection({
    signatures: [{ signature: 'failed', blockTime: W.start - 10 }],
    transactions: { failed: parsedTx({ pre: 900, post: 0, err: { InstructionError: [0, 'x'] } }) },
  });

  assert.deepEqual(await balanceEventsFor(connection, ACCOUNT, W.start), []);
});

test('a signature the RPC lists but will not return is an incomplete history, not an absence', async () => {
  const { balanceEventsFor } = await import('../lib/chain.mjs');

  const connection = stubConnection({
    signatures: [{ signature: 'vanished', blockTime: W.start - 10 }],
    transactions: {},
  });

  // Phase 05 §5.6: a gap produces a hold that is plausibly wrong rather than
  // obviously wrong, so it must fail the epoch instead of returning fewer
  // events.
  await assert.rejects(() => balanceEventsFor(connection, ACCOUNT, W.start), /history is incomplete/);
});
