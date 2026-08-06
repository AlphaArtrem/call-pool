// The crank's arithmetic, offline: eligibility, the split, carry-forward, and
// the reproducer round-trip.
//
// Nothing here touches a network. `buildEpoch` is deliberately pure so that the
// property the whole audit story rests on — *anyone with the published inputs
// derives the same output* — can be tested rather than asserted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import {
  activeWallets,
  batches,
  calloutTime,
  countable,
  FEED_CAP,
  isForMint,
  isTruncated,
  mergeById,
  recordsInWindow,
} from '../lib/callouts.mjs';
import {
  advanceCarry,
  carriedFor,
  CARRY_EXPIRY_EPOCHS,
  DUST_THRESHOLD_LAMPORTS,
  emptyCarry,
  hashCarryFile,
  previousCarryFor,
  reconcile,
  verifyCarryChain,
} from '../lib/carry.mjs';
import { buildEpoch, payoutsCsv } from '../lib/epoch-build.mjs';
import { windowForDay } from '../lib/epoch.mjs';
import { MIN_HOLD_RAW } from '../lib/config.mjs';
import { buildTree, verifyProof } from '../lib/merkle.mjs';
import { verifyOffline } from '../lib/verify.mjs';

const DAY = '2026-08-04';
const W = windowForDay(DAY);
const wallet = (i) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => i)).publicKey.toBase58();

/** A callout record with only the fields the crank actually reads. */
let calloutSeq = 0;
function callout(address, hoursIntoDay, overrides = {}) {
  calloutSeq += 1;
  return {
    id: `callout-${calloutSeq}`,
    walletAddress: address,
    tokenAddress: 'MINT',
    createdAt: new Date((W.start + hoursIntoDay * 3600) * 1000).toISOString(),
    isSpam: false,
    isHarmful: false,
    deletedAt: null,
    ...overrides,
  };
}

const storeOf = (records) => Object.fromEntries(records.map((r) => [r.id, r]));
const holdsOf = (entries) =>
  new Map(entries.map(([address, hold, locked = false]) => [address, { hold, locked }]));

// ── the callout feed ───────────────────────────────────────────────────────

test('truncation is exactly "50 records AND the oldest is still inside the window"', () => {
  const full = Array.from({ length: FEED_CAP }, (_, i) => callout(wallet(1), i * 0.4));
  assert.equal(isTruncated(full, W), true, 'the window has no visible beginning');

  // The same 50 records, but the oldest predates the window — so nothing inside
  // it can have been cut off.
  const spilling = [...full.slice(1), callout(wallet(1), -5)];
  assert.equal(isTruncated(spilling, W), false);

  assert.equal(isTruncated(full.slice(0, 49), W), false, '49 records is not a full page');
});

test('moderation flags exclude a record, and every flag counts', () => {
  assert.equal(countable(callout(wallet(1), 1)), true);
  assert.equal(countable(callout(wallet(1), 1, { isSpam: true })), false);
  assert.equal(countable(callout(wallet(1), 1, { isHarmful: true })), false);
  assert.equal(countable(callout(wallet(1), 1, { deletedAt: '2026-08-04T12:00:00Z' })), false);
});

test('merging keeps the raw record, the first sighting, and the latest flags', () => {
  const clean = callout(wallet(1), 3);
  let store = mergeById({}, [clean], 1000);
  assert.equal(store[clean.id].firstSeenAt, 1000);
  assert.equal(store[clean.id].lastSeenAt, 1000);

  // Flagged two hours later, still before settlement — so it must not be paid.
  store = mergeById(store, [{ ...clean, isSpam: true }], 8200);
  assert.equal(store[clean.id].firstSeenAt, 1000, 'when we first saw it does not change');
  assert.equal(store[clean.id].lastSeenAt, 8200);
  assert.equal(countable(store[clean.id]), false);
});

test('activity does not carry over between days', () => {
  const store = storeOf([callout(wallet(1), -2), callout(wallet(2), 5), callout(wallet(3), 30)]);
  const { active } = activeWallets(store, W);
  assert.deepEqual([...active], [wallet(2)], 'only the record inside the window counts');
  assert.equal(recordsInWindow(store, W).length, 1);
});

test('a callout update counts as activity, exactly like a callout (L2)', () => {
  const update = callout(wallet(4), 6, { isUpdate: true, parentCalloutId: 'callout-0' });
  const { active, counted } = activeWallets(storeOf([update]), W);
  assert.deepEqual([...active], [wallet(4)]);
  assert.equal(counted.length, 1);
});

test('a record with no walletAddress is refused, not skipped', () => {
  const broken = { ...callout(wallet(1), 2), walletAddress: undefined };
  assert.throws(() => activeWallets(storeOf([broken]), W), /no walletAddress/);
});

test('the fallback splits candidates into bounded sublists', () => {
  const holders = Array.from({ length: 320 }, (_, i) => `holder-${i}`);
  const split = batches(holders);
  assert.equal(split.length, 3);
  assert.deepEqual(split.map((b) => b.length), [150, 150, 20]);
  assert.equal(split.flat().length, 320);
});

test('the mint filter reads the field pump.fun actually sends', () => {
  // Pinned against a real captured response, because this is a trust boundary:
  // the field name is pump.fun's to choose, and a wrong guess fails *open* into
  // a confident "no callout found" rather than into an error anyone would see.
  const sample = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../docs/fixtures/callouts-sample.json'), 'utf8'),
  );
  const records = sample.callouts;
  const mint = 'Cg1hswfyVfnFaKHSEVyNdFWEj1bmnZoA8ZnWLVbApump';

  assert.equal(records.filter((r) => isForMint(r, mint)).length, records.length, 'all 27 match');
  assert.equal(records.filter((r) => isForMint(r, 'SomeOtherMint')).length, 0);

  // The site used to filter on `r.mint || r.coinMint`. Neither field exists on
  // anything pump.fun returns, so the filter matched nothing and every visitor
  // was told their callout did not exist.
  assert.ok(
    records.every((r) => !('mint' in r) && !('coinMint' in r)),
    'neither field pump.fun never sends has appeared',
  );

  // One predicate, so the crank and the browser cannot drift apart.
  assert.deepEqual(
    records.filter((r) => isForMint(r, mint)).map((r) => r.id),
    records.filter((r) => r.tokenAddress === mint).map((r) => r.id),
  );
});

test('createdAt is parsed as UTC, to the second', () => {
  const record = callout(wallet(1), 0);
  assert.equal(calloutTime(record), W.start);
  assert.throws(() => calloutTime({ createdAt: 'yesterday' }), /unparseable/);
});

// ── eligibility and the split ──────────────────────────────────────────────

const BIG = MIN_HOLD_RAW * 10n;

test('eligible = active AND above the floor AND not locked', () => {
  const store = storeOf([
    callout(wallet(1), 2),
    callout(wallet(2), 3),
    callout(wallet(3), 4),
    callout(wallet(4), 5),
  ]);
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: store,
    holds: holdsOf([
      [wallet(1), BIG], //           active, above the floor, unlocked → paid
      [wallet(2), MIN_HOLD_RAW - 1n], // below the floor
      [wallet(3), BIG, true], //     sold in the last 7 epochs
      [wallet(4), 0n], //            called out holding nothing
    ]),
    available: 100n * 1_000_000_000n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  assert.deepEqual(
    built.rows.map((r) => [r.wallet, r.eligible]).filter(([, e]) => e),
    [[wallet(1), true]],
  );
  assert.equal(built.tree.length, 1);
  assert.equal(built.tree[0].owner, wallet(1));
});

test('a wallet that held but never called earns nothing', () => {
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: {},
    holds: new Map(),
    available: 100n * 1_000_000_000n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });
  assert.equal(built.tree.length, 0);
  assert.equal(built.allocate, 0n);
  assert.equal(built.root.toString('hex'), '0'.repeat(64), 'an empty epoch is a zeroed root');
});

test('weight is exactly linear — splitting a bag changes nothing', () => {
  const available = 90n * 1_000_000_000n;
  const whole = buildEpoch({
    epoch: 1,
    window: W,
    calloutStore: storeOf([callout(wallet(1), 1), callout(wallet(9), 1)]),
    holds: holdsOf([
      [wallet(1), 3n * BIG],
      [wallet(9), BIG],
    ]),
    available,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  // The same holder, split across three wallets, all of which call out.
  const split = buildEpoch({
    epoch: 1,
    window: W,
    calloutStore: storeOf([
      callout(wallet(1), 1),
      callout(wallet(2), 1),
      callout(wallet(3), 1),
      callout(wallet(9), 1),
    ]),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), BIG],
      [wallet(3), BIG],
      [wallet(9), BIG],
    ]),
    available,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const paidTo = (built, addresses) =>
    built.tree.filter((l) => addresses.includes(l.owner)).reduce((s, l) => s + l.amount, 0n);

  const wholeShare = paidTo(whole, [wallet(1)]);
  const splitShare = paidTo(split, [wallet(1), wallet(2), wallet(3)]);
  // Equal to within the floor-division remainder — which stays in the pool.
  assert.ok(wholeShare - splitShare <= 3n, `${wholeShare} vs ${splitShare}`);
});

test('the division floors, so the remainder stays in the pool', () => {
  const built = buildEpoch({
    epoch: 2,
    window: W,
    calloutStore: storeOf([callout(wallet(1), 1), callout(wallet(2), 1), callout(wallet(3), 1)]),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), BIG],
      [wallet(3), BIG],
    ]),
    available: 100n, // does not divide by three
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });
  // Each share is 33 and below the dust threshold, so all three carry — but the
  // point stands: nothing over-allocates.
  assert.ok(built.allocate <= 100n);
  const shares = built.payouts.reduce((s, p) => s + p.share, 0n);
  assert.ok(shares <= 100n, 'never allocate more than is available');
  assert.equal(shares, 99n);
});

test('every leaf in a built tree verifies against its own root', () => {
  const store = storeOf(Array.from({ length: 7 }, (_, i) => callout(wallet(i + 1), i)));
  const built = buildEpoch({
    epoch: 3,
    window: W,
    calloutStore: store,
    holds: holdsOf(Array.from({ length: 7 }, (_, i) => [wallet(i + 1), BIG * BigInt(i + 1)])),
    available: 100n * 1_000_000_000n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  assert.equal(built.tree.length, 7);
  const rebuilt = buildTree(
    built.tree.map((l) => ({ owner: l.owner, amount: l.amount })),
    3,
  );
  for (const leaf of built.tree) {
    assert.ok(verifyProof(leaf.proof, built.root, rebuilt.levels[0][leaf.index]));
  }
  assert.equal(
    built.allocate,
    built.tree.reduce((s, l) => s + l.amount, 0n),
    'allocate is exactly what the tree pays',
  );
});

// ── carry-forward ──────────────────────────────────────────────────────────

test('a share below the dust threshold is carried, not paid', () => {
  const built = buildEpoch({
    epoch: 4,
    window: W,
    calloutStore: storeOf([callout(wallet(1), 1)]),
    holds: holdsOf([[wallet(1), BIG]]),
    available: DUST_THRESHOLD_LAMPORTS - 1n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  assert.equal(built.tree.length, 0, 'nothing is paid');
  assert.equal(built.allocate, 0n, 'and nothing is allocated, so it stays in the pool');
  assert.equal(carriedFor(built.carry, wallet(1)), DUST_THRESHOLD_LAMPORTS - 1n);
});

test('carried dust is folded into the next epoch and clears the threshold', () => {
  const previous = advanceCarry(emptyCarry(), {
    epoch: 5,
    withheld: new Map([[wallet(1), 9_000n]]),
    paid: new Set(),
  }).carry;

  const built = buildEpoch({
    epoch: 6,
    window: W,
    calloutStore: storeOf([callout(wallet(1), 1)]),
    holds: holdsOf([[wallet(1), BIG]]),
    // 9,000 of carried dust was never allocated on chain, so it is still in the
    // pool and still inside `available`; 5,000 arrived today. This used to read
    // `5_000n`, which describes a pool that had somehow spent money it still
    // owed — a state only reachable because the old code re-divided `available`
    // without regard for the ledger. Today's share is still the 5,000.
    available: 14_000n,
    previousCarry: previous,
    minHold: MIN_HOLD_RAW,
  });

  assert.equal(built.divisible, 5_000n, 'only what arrived today is divisible');

  assert.equal(built.tree.length, 1);
  assert.equal(built.tree[0].amount, 14_000n, '9,000 carried + 5,000 today');
  assert.equal(built.allocate, 14_000n);
  assert.equal(carriedFor(built.carry, wallet(1)), 0n, 'the carry is spent, not double-counted');
});

test('carry expires after 30 epochs and returns to the pool', () => {
  let carry = advanceCarry(emptyCarry(), {
    epoch: 0,
    withheld: new Map([[wallet(1), 4_000n]]),
    paid: new Set(),
  }).carry;

  const justBefore = advanceCarry(carry, {
    epoch: CARRY_EXPIRY_EPOCHS - 1,
    withheld: new Map(),
    paid: new Set(),
  });
  assert.equal(carriedFor(justBefore.carry, wallet(1)), 4_000n);
  assert.equal(justBefore.expiredLamports, 0n);

  const atExpiry = advanceCarry(carry, {
    epoch: CARRY_EXPIRY_EPOCHS,
    withheld: new Map(),
    paid: new Set(),
  });
  assert.equal(carriedFor(atExpiry.carry, wallet(1)), 0n);
  assert.equal(atExpiry.expiredLamports, 4_000n);
  assert.equal(atExpiry.carry.expired[0].wallet, wallet(1));
});

test('topping up a carry does not restart its expiry clock', () => {
  let carry = advanceCarry(emptyCarry(), {
    epoch: 0,
    withheld: new Map([[wallet(1), 1_000n]]),
    paid: new Set(),
  }).carry;
  carry = advanceCarry(carry, {
    epoch: 10,
    withheld: new Map([[wallet(1), 1_000n]]),
    paid: new Set(),
  }).carry;

  assert.equal(carry.balances[wallet(1)].sinceEpoch, 0, 'the clock runs from the first crumb');
  assert.equal(carriedFor(carry, wallet(1)), 2_000n);
});

test('the carry ledger hash-chains, and a tampered link is caught', () => {
  const a = advanceCarry(emptyCarry(), {
    epoch: 0,
    withheld: new Map([[wallet(1), 1_000n]]),
    paid: new Set(),
  }).carry;
  const b = advanceCarry(a, { epoch: 1, withheld: new Map(), paid: new Set() }).carry;
  const c = advanceCarry(b, { epoch: 2, withheld: new Map(), paid: new Set() }).carry;

  assert.equal(verifyCarryChain([a, b, c]).ok, true);
  assert.equal(b.previousCarrySha256, hashCarryFile(a));

  // Quietly change a past balance: the chain no longer adds up.
  const tampered = { ...a, balances: { [wallet(1)]: { lamports: '999999', sinceEpoch: 0 } } };
  const broken = verifyCarryChain([tampered, b, c]);
  assert.equal(broken.ok, false);
  assert.equal(broken.problems[0].epoch, 1);
});

test('the stream reconciliation catches over-allocation across epochs', () => {
  assert.equal(reconcile({ inflows: 100n, allocated: 60n, carried: 30n, expired: 5n }).ok, true);
  assert.equal(reconcile({ inflows: 100n, allocated: 60n, carried: 30n, expired: 5n }).unallocated, '5');
  assert.equal(reconcile({ inflows: 100n, allocated: 90n, carried: 30n, expired: 0n }).ok, false);
});

// ── carry across chained epochs ────────────────────────────────────────────
//
// The tests above drive `advanceCarry` directly, and that is exactly why they
// passed over a money bug for so long: the defect lives in the *seam* between
// `buildEpoch` and `advanceCarry`, so it is only visible when an epoch is fed
// the carry ledger its own predecessor produced. Everything below chains
// `buildEpoch` through its own output.
//
// The pool model matters as much as the arithmetic. Withheld dust is never
// allocated on chain, so it stays in the pool and is still inside `available`
// the next day. `available(n) = carried(n-1) + inflow` is not a convenience
// here — it is what the program actually reports, and assuming otherwise is
// what made the bug invisible.

/** Run `buildEpoch` over consecutive epochs, feeding each its predecessor's carry. */
function chainEpochs({ wallets, inflow, epochs, from = 0 }) {
  const results = [];
  let carry = emptyCarry();
  let retained = 0n; // dust withheld so far — still sitting in the pool

  for (let i = 0; i < epochs; i++) {
    const epoch = from + i;
    const available = retained + inflow;
    const built = buildEpoch({
      epoch,
      window: W,
      calloutStore: storeOf(wallets.map((w) => callout(w, 1))),
      holds: holdsOf(wallets.map((w) => [w, BIG])),
      available,
      previousCarry: carry,
      minHold: MIN_HOLD_RAW,
    });

    results.push({ epoch, available, built });
    carry = built.carry;
    retained = available - built.allocate - built.expiredLamports;
  }
  return results;
}

test('chained dusty epochs accumulate linearly, and the crossing payout is exact', () => {
  const share = 3_000n; // one wallet, so the whole divisible pool is its share
  const run = chainEpochs({ wallets: [wallet(1)], inflow: share, epochs: 4 });

  // Epochs 0-2 stay under the 10,000 threshold: the ledger is n·share, not the
  // doubling `b(n) = 2·b(n-1) + share` the unfixed code produced.
  for (const [i, { built }] of run.slice(0, 3).entries()) {
    assert.equal(
      carriedFor(built.carry, wallet(1)),
      share * BigInt(i + 1),
      `epoch ${i}: the ledger grows by one share, not by doubling`,
    );
    assert.equal(built.allocate, 0n, `epoch ${i}: nothing is paid while under the threshold`);
  }

  // Epoch 3 crosses. The payout must equal exactly what four epochs earned.
  const crossing = run[3].built;
  assert.equal(crossing.tree.length, 1, 'the fourth epoch pays');
  assert.equal(crossing.tree[0].amount, share * 4n, 'paid exactly what was earned, not inflated');
  assert.equal(carriedFor(crossing.carry, wallet(1)), 0n, 'and the ledger is emptied');
});

test("one wallet's accumulated carry does not inflate another's share", () => {
  const a = wallet(1);
  const b = wallet(2);

  // Epoch 0: only A is active, and its share is dust.
  const first = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf([callout(a, 1)]),
    holds: holdsOf([[a, BIG]]),
    available: 3_000n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });
  assert.equal(carriedFor(first.carry, a), 3_000n);

  // Epoch 1: both are active with equal holds. A's 3,000 is still in the pool,
  // so `available` is 8,000 — but only the 5,000 that arrived today is anyone's
  // to divide. Dividing all 8,000 would pay B out of money already owed to A.
  const second = buildEpoch({
    epoch: 1,
    window: W,
    calloutStore: storeOf([callout(a, 1), callout(b, 2)]),
    holds: holdsOf([[a, BIG], [b, BIG]]),
    available: 8_000n,
    previousCarry: first.carry,
    minHold: MIN_HOLD_RAW,
  });

  const shareOf = (w) => second.payouts.find((p) => p.wallet === w).share;
  assert.equal(shareOf(b), 2_500n, "B's share divides the pool net of what A is owed");
  assert.equal(shareOf(a), 2_500n, 'and A is not paid twice for the same lamports');
  assert.equal(second.payouts.find((p) => p.wallet === a).carried, 3_000n);
});

test('carry expiring this epoch returns to the pool and is not also paid', () => {
  // A's dust was banked at epoch 0; at epoch 30 it expires. The same lamports
  // must not both "return to the pool" and be handed to A as carry.
  const previous = advanceCarry(emptyCarry(), {
    epoch: 0,
    withheld: new Map([[wallet(1), 4_000n]]),
    paid: new Set(),
  }).carry;

  const built = buildEpoch({
    epoch: CARRY_EXPIRY_EPOCHS,
    window: W,
    calloutStore: storeOf([callout(wallet(1), 1)]),
    holds: holdsOf([[wallet(1), BIG]]),
    available: 24_000n, // the 4,000 expired dust, plus 20,000 that arrived today
    previousCarry: previous,
    minHold: MIN_HOLD_RAW,
  });

  assert.equal(built.expiredLamports, 4_000n, 'the entry expired');
  assert.equal(built.payouts[0].carried, 0n, 'an expired entry is not paid as carry');
  assert.equal(built.payouts[0].amount, 24_000n, 'it comes back through the divisible pool instead');
  assert.ok(built.allocate <= built.available, 'and the epoch cannot over-allocate');
  assert.equal(carriedFor(built.carry, wallet(1)), 0n);
});

test('allocate never exceeds available, over a chain and per epoch', () => {
  const run = chainEpochs({ wallets: [wallet(1), wallet(2), wallet(3)], inflow: 7_000n, epochs: 8 });

  let inflows = 0n;
  for (const { epoch, available, built } of run) {
    assert.ok(
      built.allocate <= available,
      `epoch ${epoch}: allocated ${built.allocate} of ${available} available`,
    );
    inflows += 7_000n;
    const carried = BigInt(built.carry.totals.carried);
    const check = reconcile({
      inflows,
      allocated: run.slice(0, epoch + 1).reduce((s, r) => s + r.built.allocate, 0n),
      carried,
      expired: run.slice(0, epoch + 1).reduce((s, r) => s + r.built.expiredLamports, 0n),
    });
    assert.equal(check.ok, true, `epoch ${epoch}: ${JSON.stringify(check)}`);
  }
});

test('a pool smaller than the ledger it owes stops the crank', () => {
  // The ledger says 9,000 is owed but the pool reports 5,000 allocatable. That
  // is not a rounding artefact — it means the ledger and the chain disagree,
  // and guessing which is right is how a settlement quietly underpays.
  const previous = advanceCarry(emptyCarry(), {
    epoch: 0,
    withheld: new Map([[wallet(1), 9_000n]]),
    paid: new Set(),
  }).carry;

  assert.throws(
    () =>
      buildEpoch({
        epoch: 1,
        window: W,
        calloutStore: storeOf([callout(wallet(1), 1)]),
        holds: holdsOf([[wallet(1), BIG]]),
        available: 5_000n,
        previousCarry: previous,
        minHold: MIN_HOLD_RAW,
      }),
    /owed .* exceeds|carry ledger/i,
  );
});

// ── a missing carry ledger ─────────────────────────────────────────────────

test('a missing carry ledger stops the crank instead of starting over', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  const missing = resolve(dir, 'epoch-4', 'carry.json');

  assert.throws(
    () => previousCarryFor({ epoch: 5, path: missing }),
    (err) => err.message.includes(missing) && /--carry-reset/.test(err.message),
    'the error names the file it wanted and the flag that overrides it',
  );
});

test('--carry-reset is the explicit way to restart the carry chain', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  const missing = resolve(dir, 'epoch-4', 'carry.json');

  const reset = previousCarryFor({ epoch: 5, path: missing, carryReset: true });
  assert.deepEqual(reset, emptyCarry(), 'the ledger restarts, but only because it was asked to');

  // Epoch 0 has no predecessor by definition — that is genesis, not a restart.
  assert.deepEqual(previousCarryFor({ epoch: 0, path: missing }), emptyCarry());
});

test('an existing ledger is read, flag or no flag', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  const path = resolve(dir, 'carry.json');
  const carry = advanceCarry(emptyCarry(), {
    epoch: 4,
    withheld: new Map([[wallet(1), 2_500n]]),
    paid: new Set(),
  }).carry;
  writeFileSync(path, `${JSON.stringify(carry, null, 2)}\n`);

  assert.deepEqual(previousCarryFor({ epoch: 5, path }), carry);
  assert.deepEqual(
    previousCarryFor({ epoch: 5, path, carryReset: true }),
    carry,
    'the flag permits a restart, it does not force one',
  );
});

// ── the reproducer ─────────────────────────────────────────────────────────

/** Write a snapshot directory the way snapshot.mjs does, then reproduce it. */
function writeSnapshot(dir, { epoch, built, records, available }) {
  mkdirSync(dir, { recursive: true });
  const json = (name, value) =>
    writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);

  json('callouts.json', {
    mint: 'MINT',
    window: W,
    capturedAt: W.end,
    truncated: false,
    usedFallback: false,
    counted: records.filter(countable),
    excluded: records.filter((r) => !countable(r)),
  });
  json(
    'balances.json',
    Object.fromEntries(
      built.rows.map((r) => [
        r.wallet,
        {
          tokenAccount: `ata-${r.wallet}`,
          hold: r.hold.toString(),
          locked: r.locked,
          windowEvents: [],
          lockoutDecreases: [],
        },
      ]),
    ),
  );
  json('pool.json', { available: available.toString() });
  json('carry.json', built.carry);
  json('tree.json', {
    epoch,
    root: built.root.toString('hex'),
    leafCount: built.leafCount,
    allocate: built.allocate.toString(),
    leaves: built.tree.map((l) => ({
      index: l.index,
      owner: l.owner,
      amount: l.amount.toString(),
      proof: l.proof.map((n) => n.toString('hex')),
    })),
  });
}

test('the verifier flags a chain that restarted mid-history', () => {
  // Epoch 5's directory exists, but its carry.json is gone — the shape a failed
  // settlement leaves behind. Epoch 6 was then built from an empty ledger. The
  // hash check cannot catch this on its own: with no predecessor file to hash,
  // "no previous carry" is exactly what a genesis epoch looks like, so the
  // restart reconciles perfectly with itself.
  const root = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  mkdirSync(resolve(root, 'epoch-5'), { recursive: true });

  const records = [callout(wallet(1), 1)];
  const available = 90n * 1_000_000_000n;
  const built = buildEpoch({
    epoch: 6,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([[wallet(1), BIG]]),
    available,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const dir = resolve(root, 'epoch-6');
  writeSnapshot(dir, { epoch: 6, built, records, available });

  const result = verifyOffline(dir, { minHold: MIN_HOLD_RAW });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => /carry chain restarted/i.test(p)),
    `expected a restart problem, got ${JSON.stringify(result.problems)}`,
  );
});

test('a published epoch reproduces exactly from its own directory', () => {
  const records = [callout(wallet(1), 1), callout(wallet(2), 2), callout(wallet(3), 3)];
  const available = 90n * 1_000_000_000n;
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), 2n * BIG],
      [wallet(3), MIN_HOLD_RAW - 1n],
    ]),
    available,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const dir = resolve(mkdtempSync(resolve(tmpdir(), 'callpool-')), 'epoch-0');
  writeSnapshot(dir, { epoch: 0, built, records, available });

  const result = verifyOffline(dir, { minHold: MIN_HOLD_RAW });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.recomputed.root.toString('hex'), built.root.toString('hex'));
});

test('the reproducer names the wallet when a published amount is wrong', () => {
  const records = [callout(wallet(1), 1), callout(wallet(2), 2)];
  const available = 90n * 1_000_000_000n;
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), BIG],
    ]),
    available,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const dir = resolve(mkdtempSync(resolve(tmpdir(), 'callpool-')), 'epoch-0');
  writeSnapshot(dir, { epoch: 0, built, records, available });

  // Inflate one published payout without touching anything else — exactly what
  // a dishonest snapshot would look like from outside.
  const treePath = resolve(dir, 'tree.json');
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  const victim = tree.leaves[0];
  tree.leaves[0] = { ...victim, amount: (BigInt(victim.amount) * 2n).toString() };
  writeFileSync(treePath, `${JSON.stringify(tree, null, 2)}\n`);

  const result = verifyOffline(dir, { minHold: MIN_HOLD_RAW });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => p.includes(victim.owner)),
    `expected a problem naming ${victim.owner}, got ${JSON.stringify(result.problems)}`,
  );
});

test('payouts.csv has one row per caller, eligible or not', () => {
  const records = [callout(wallet(1), 1), callout(wallet(2), 2)];
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), 1n],
    ]),
    available: 90n * 1_000_000_000n,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const lines = payoutsCsv(built).trim().split('\n');
  assert.equal(lines.length, 3, 'header plus both callers');
  assert.match(lines[0], /^index,owner,hold,locked,eligible,weight,carried,payout_lamports,withheld_lamports$/);
  assert.ok(lines.some((l) => l.includes(wallet(2)) && l.includes(',false,')));
});
