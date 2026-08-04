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
    available: 5_000n, // on its own, still dust
    previousCarry: previous,
    minHold: MIN_HOLD_RAW,
  });

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
