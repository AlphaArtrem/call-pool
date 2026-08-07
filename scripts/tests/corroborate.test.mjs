// The second signer's independent check on the one input it cannot re-derive.
//
// Most of this file is about the cases that must still REFUSE, for the same
// reason `lp-lockout.test.mjs` is: a check that passes everything looks
// identical to a check that works, on every log line, until the day it matters.

import assert from 'node:assert/strict';
import test from 'node:test';

import { corroborateCallouts, sawTruncation } from '../lib/corroborate.mjs';

const WINDOW = { start: 1_000, end: 2_000 };

/** A pump.fun callout record, minimally shaped. */
const callout = (id, wallet, at, extra = {}) => ({
  id,
  walletAddress: wallet,
  tokenAddress: 'MINT',
  createdAt: new Date(at * 1000).toISOString(),
  ...extra,
});

/** What the crank publishes: counted and excluded, already split by L7. */
const published = (counted, excluded = []) => ({
  mint: 'MINT',
  window: WINDOW,
  counted,
  excluded,
});

/** What this host polled for itself. `updatedAt` past the window by default. */
const ownStore = (records, { updatedAt = WINDOW.end + 60, truncations = [] } = {}) => ({
  mint: 'MINT',
  updatedAt,
  truncations,
  callouts: Object.fromEntries(records.map((r) => [r.id, r])),
});

// ── the honest case ────────────────────────────────────────────────────────

test('an epoch whose callers we all saw ourselves is corroborated', () => {
  const records = [callout('a', 'WALLET_A', 1_100), callout('b', 'WALLET_B', 1_200)];
  const result = corroborateCallouts({
    published: published(records),
    ownStore: ownStore(records),
    window: WINDOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.credited, ['WALLET_A', 'WALLET_B']);
  assert.deepEqual(result.unverified, []);
});

test('the two hosts need not have observed the records at the same moment', () => {
  // Same callouts, different `firstSeenAt`/`lastSeenAt` — the merge stamps
  // those per host and they must not enter the comparison.
  const theirs = [{ ...callout('a', 'WALLET_A', 1_100), firstSeenAt: 1_105, lastSeenAt: 1_900 }];
  const mine = [{ ...callout('a', 'WALLET_A', 1_100), firstSeenAt: 1_150, lastSeenAt: 1_950 }];

  const result = corroborateCallouts({
    published: published(theirs),
    ownStore: ownStore(mine),
    window: WINDOW,
  });
  assert.equal(result.ok, true);
});

// ── the case this exists for ───────────────────────────────────────────────

test('a credited wallet we never saw is REFUSED — this is the whole point', () => {
  const result = corroborateCallouts({
    published: published([callout('a', 'WALLET_A', 1_100), callout('x', 'ATTACKER', 1_300)]),
    ownStore: ownStore([callout('a', 'WALLET_A', 1_100)]),
    window: WINDOW,
  });

  assert.equal(result.ok, false, 'a fabricated caller must not be approved');
  assert.deepEqual(result.unverified, ['ATTACKER']);
  assert.match(result.reason, /never observed/);
});

test('a wholly fabricated capture is refused, not merely flagged', () => {
  const result = corroborateCallouts({
    published: published([callout('x', 'ATTACKER_1', 1_100), callout('y', 'ATTACKER_2', 1_200)]),
    ownStore: ownStore([]),
    window: WINDOW,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.unverified, ['ATTACKER_1', 'ATTACKER_2']);
});

// ── the two documented blind spots ─────────────────────────────────────────

test('a store that has not seen the whole window refuses rather than passing', () => {
  // Silence from a poller that has not run is not evidence of absence. The
  // dangerous version of this check would read an empty store as "nobody called
  // out" and refuse — or, worse, read it as agreement.
  const records = [callout('a', 'WALLET_A', 1_100)];
  const result = corroborateCallouts({
    published: published(records),
    ownStore: ownStore(records, { updatedAt: WINDOW.end - 1 }),
    window: WINDOW,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /has not observed the whole window/);
  assert.deepEqual(result.unverified, [], 'nothing is accused — the check simply cannot speak');
});

test('a truncated feed degrades to a warning instead of deadlocking the epoch', () => {
  // A truncated window is recovered by the crank with the per-wallet fallback,
  // which this host does not run. Refusing here would stall every truncated
  // epoch forever, so it passes — and says so rather than passing silently.
  const result = corroborateCallouts({
    published: published([callout('a', 'WALLET_A', 1_100), callout('b', 'WALLET_B', 1_200)]),
    ownStore: ownStore([callout('a', 'WALLET_A', 1_100)], {
      truncations: [{ observedAt: 1_500, feedSize: 50 }],
    }),
    window: WINDOW,
  });

  assert.equal(result.ok, true, 'truncation must not deadlock settlement');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.unverified, ['WALLET_B'], 'still reported, so the gap is visible');
  assert.match(result.reason, /degraded, not passed/);
});

test('a truncation observed OUTSIDE the window does not excuse an unseen caller', () => {
  // Otherwise one truncation, ever, would disable this check for all time.
  const result = corroborateCallouts({
    published: published([callout('x', 'ATTACKER', 1_300)]),
    ownStore: ownStore([], { truncations: [{ observedAt: WINDOW.start - 500, feedSize: 50 }] }),
    window: WINDOW,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.unverified, ['ATTACKER']);
});

// ── the moderation filter must not drift between the two sides ─────────────

test('a record we hold but pump.fun flagged is not treated as corroboration', () => {
  // Both sides run `activeWallets`, so a spam-flagged record is uncountable on
  // both. If this host counted it and the crank did not, a wallet the crank
  // correctly refused to pay would look "corroborated" — harmless — but the
  // reverse would let a flagged record vouch for a credited one.
  const result = corroborateCallouts({
    published: published([callout('a', 'WALLET_A', 1_100)]),
    ownStore: ownStore([callout('a', 'WALLET_A', 1_100, { isSpam: true })]),
    window: WINDOW,
  });

  assert.equal(result.ok, false, 'a flagged record cannot vouch for a credited caller');
  assert.deepEqual(result.unverified, ['WALLET_A']);
});

test('an excluded record on the published side is not credited in the first place', () => {
  const result = corroborateCallouts({
    published: published([], [callout('a', 'WALLET_A', 1_100, { isHarmful: true })]),
    ownStore: ownStore([]),
    window: WINDOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.credited, [], 'an excluded record credits nobody, so nothing to check');
});

test('a callout outside the window credits nobody', () => {
  const result = corroborateCallouts({
    published: published([callout('a', 'WALLET_A', WINDOW.end + 10)]),
    ownStore: ownStore([]),
    window: WINDOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.credited, []);
});

// ── the other direction: we saw more than they credited ────────────────────

test('a caller we saw that was NOT credited is reported but does not refuse', () => {
  // This is under-payment, not theft, and its ordinary cause is a poll race.
  // Refusing would turn every timing difference into a stalled epoch.
  const result = corroborateCallouts({
    published: published([callout('a', 'WALLET_A', 1_100)]),
    ownStore: ownStore([callout('a', 'WALLET_A', 1_100), callout('b', 'WALLET_B', 1_200)]),
    window: WINDOW,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missed, ['WALLET_B']);
});

// ── the truncation predicate ───────────────────────────────────────────────

test('truncation is only relevant between the window opening and our last poll', () => {
  const store = ownStore([], {
    updatedAt: 2_060,
    truncations: [{ observedAt: 900 }, { observedAt: 1_500 }, { observedAt: 3_000 }],
  });
  assert.equal(sawTruncation(store, WINDOW), true, '1500 is inside');
  assert.equal(sawTruncation({ ...store, truncations: [{ observedAt: 900 }] }, WINDOW), false);
  assert.equal(sawTruncation({ ...store, truncations: [] }, WINDOW), false);
  assert.equal(sawTruncation({ ...store, truncations: undefined }, WINDOW), false);
});
