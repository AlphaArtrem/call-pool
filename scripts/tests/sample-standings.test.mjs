// The hourly estimate — the window it measures, and what it publishes.
//
// The sampler's value is that it does NOT reimplement the split: `holdsFor`
// and `buildEpoch` do the arithmetic and are tested elsewhere. What is new,
// and therefore what is pinned here, is the window it hands them and the shape
// of the file it writes — including the two flags that are the difference
// between an estimate a holder can trust and one that is quietly short.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { elapsedWindow, provisionalFrom, MIN_ELAPSED_SECONDS, PROVISIONAL_FILE } = await import(
  '../sample-standings.mjs'
);
const { epochContaining, windowForEpoch } = await import('../lib/program.mjs');

const DAY = 86_400;
const WINDOW = { start: 1_767_225_600, end: 1_767_225_600 + DAY };

// ── the window ─────────────────────────────────────────────────────────────

test('the elapsed window is the part of the day that has happened', () => {
  const elapsed = elapsedWindow(WINDOW, WINDOW.start + 6 * 3600);
  assert.equal(elapsed.start, WINDOW.start);
  assert.equal(elapsed.end, WINDOW.start + 6 * 3600);
});

test('a clock past the epoch close cannot produce a window longer than the day', () => {
  // Otherwise `computeHold` would divide by more than a day and understate
  // every weight in the sample.
  const elapsed = elapsedWindow(WINDOW, WINDOW.end + 9_999);
  assert.equal(elapsed.end, WINDOW.end);
});

test('a clock before the epoch opens cannot produce a negative window', () => {
  const elapsed = elapsedWindow(WINDOW, WINDOW.start - 500);
  assert.equal(elapsed.end, WINDOW.start);
  assert.ok(elapsed.end >= elapsed.start);
});

test('the minimum elapsed slice is long enough to be worth dividing by', () => {
  assert.ok(MIN_ELAPSED_SECONDS >= 60);
});

// ── which epoch is running ─────────────────────────────────────────────────

test('epochContaining floors an arbitrary moment into its epoch', () => {
  const config = { genesisTs: WINDOW.start, epochSeconds: DAY };
  assert.equal(epochContaining(WINDOW.start, config), 0);
  assert.equal(epochContaining(WINDOW.start + DAY - 1, config), 0);
  assert.equal(epochContaining(WINDOW.start + DAY, config), 1);
  assert.equal(epochContaining(WINDOW.start + 3 * DAY + 17, config), 3);
});

test('epochContaining agrees with windowForEpoch about where it put the moment', () => {
  const config = { genesisTs: WINDOW.start, epochSeconds: DAY };
  const now = WINDOW.start + 5 * DAY + 4_242;
  const w = windowForEpoch(config, epochContaining(now, config));
  assert.ok(now >= w.start && now < w.end);
});

test('epochContaining refuses a moment before genesis rather than going negative', () => {
  const config = { genesisTs: WINDOW.start, epochSeconds: DAY };
  assert.throws(() => epochContaining(WINDOW.start - 1, config), /before genesis/);
});

// ── the published file ─────────────────────────────────────────────────────

const built = {
  epoch: 12,
  available: 5_000_000_000n,
  divisible: 4_000_000_000n,
  allocate: 3_000_000_000n,
  totalWeight: 1_500_000n,
  callouts: { counted: 4, excluded: 1, activeCount: 3 },
  rows: [
    { wallet: 'Alice', hold: 1_000_000n, sustained: 1_000_000n, locked: false, meetsFloor: true, eligible: true },
    { wallet: 'Bob', hold: 500_000n, sustained: 500_000n, locked: false, meetsFloor: true, eligible: true },
    { wallet: 'Carol', hold: 10n, sustained: 10n, locked: false, meetsFloor: false, eligible: false },
    { wallet: 'Dave', hold: 900_000n, sustained: 900_000n, locked: true, meetsFloor: true, eligible: false },
  ],
  payouts: [
    { wallet: 'Alice', share: 2_000_000_000n, carried: 7n, amount: 2_000_000_007n, withheld: 0n },
    { wallet: 'Bob', share: 1_000_000_000n, carried: 0n, amount: 1_000_000_000n, withheld: 0n },
  ],
};

const sample = () =>
  provisionalFrom(built, {
    sampledAt: WINDOW.start + 6 * 3600,
    window: WINDOW,
    elapsed: elapsedWindow(WINDOW, WINDOW.start + 6 * 3600),
    truncated: false,
    carryKnown: true,
  });

test('the file says outright that it is not settled', () => {
  const out = sample();
  assert.equal(out.kind, 'provisional-standings');
  assert.equal(out.settled, false);
  assert.equal(PROVISIONAL_FILE, 'provisional.json');
});

test('every wallet the store saw is listed, not only the ones in the money', () => {
  const wallets = sample().standings.map((s) => s.wallet);
  assert.deepEqual(wallets, ['Alice', 'Bob', 'Carol', 'Dave']);
});

test('an ineligible wallet has no indicative figure rather than a zero', () => {
  // Zero would assert the split gave them nothing. It never considered them.
  const out = sample();
  const carol = out.standings.find((s) => s.wallet === 'Carol');
  assert.equal(carol.indicative, null);
  assert.equal(carol.meetsFloor, false);
  assert.equal(carol.locked, false);
});

test('a locked wallet is distinguishable from one below the floor', () => {
  const dave = sample().standings.find((s) => s.wallet === 'Dave');
  assert.equal(dave.locked, true);
  assert.equal(dave.meetsFloor, true);
  assert.equal(dave.eligible, false);
  assert.equal(dave.indicative, null);
});

test('the indicative figure includes carried dust, because the payout would', () => {
  const alice = sample().standings.find((s) => s.wallet === 'Alice');
  assert.equal(alice.indicative, '2000000007');
});

test('lamports and raw token units are strings, never Numbers', () => {
  const out = sample();
  assert.equal(typeof out.poolLamports, 'string');
  assert.equal(typeof out.totalWeight, 'string');
  for (const s of out.standings) {
    assert.equal(typeof s.hold, 'string');
    assert.equal(typeof s.sustained, 'string');
    if (s.indicative != null) assert.equal(typeof s.indicative, 'string');
  }
});

test('the sample reports how much of the day it covers', () => {
  assert.equal(sample().elapsedFraction, 0.25);
});

test('a truncated feed is carried into the file, because the numbers cannot show it', () => {
  const out = provisionalFrom(built, {
    sampledAt: WINDOW.start + 3600,
    window: WINDOW,
    elapsed: elapsedWindow(WINDOW, WINDOW.start + 3600),
    truncated: true,
    carryKnown: false,
  });
  assert.equal(out.truncated, true);
  assert.equal(out.carryKnown, false);
});
