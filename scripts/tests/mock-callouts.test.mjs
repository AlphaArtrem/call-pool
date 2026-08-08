// The mock feed's record selection — and the 50-record boundary in particular.
//
// The owner's headline ask for the final devnet test is the truncation cap, and
// the cases either side of it differ by one record. Getting that wrong in the
// mock would produce a run that reports passing the boundary it never reached.
//
// The rule at the settlement end is narrower than `isTruncated` looks. Snapshot
// filters records to the window *before* calling it, so the "oldest is not
// older than the window" half is always true there and what remains is
// `count >= FEED_CAP`, inclusive. The oldest-record half only bites in
// `poll-callouts.mjs`, which sees the raw feed. Both are asserted here against
// the real `isTruncated` and `recordsInWindow`, not a copy of their logic.

import test from 'node:test';
import assert from 'node:assert/strict';

const { selectRecords } = await import('../tools/mock-callouts.mjs');
const { FEED_CAP, isTruncated, recordsInWindow } = await import('../lib/callouts.mjs');

const WINDOW = { start: 1_767_225_600, end: 1_767_225_600 + 600 };
const CREATED_AT = WINDOW.start + 60;

const cast = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `w${String(i + 1).padStart(2, '0')}`,
    address: `Addr${String(i + 1).padStart(3, '0')}`,
  }));

const select = (opts) =>
  selectRecords({
    cast: cast(70),
    epoch: 3,
    mint: 'MintAddr',
    window: WINDOW,
    createdAt: CREATED_AT,
    epochsIn: 0,
    fadeAfter: 3,
    ...opts,
  });

/** What settlement actually sees: the store, filtered to the window. */
const asSnapshotSees = (records) =>
  recordsInWindow(Object.fromEntries(records.map((r) => [r.id, r])), WINDOW);

// ── the boundary ───────────────────────────────────────────────────────────

test('49 in-window records is the normal path (C3)', () => {
  const seen = asSnapshotSees(select({ count: 49 }));
  assert.equal(seen.length, 49);
  assert.equal(isTruncated(seen, WINDOW), false);
});

test('exactly 50 in-window records IS truncated — the boundary is inclusive (C4)', () => {
  const seen = asSnapshotSees(select({ count: 50 }));
  assert.equal(seen.length, FEED_CAP);
  assert.equal(isTruncated(seen, WINDOW), true);
});

test('50 written with one outside the window is NOT truncated (C5)', () => {
  // The case most likely to be got wrong: fifty records exist, but only 49 of
  // them are input, so the feed was never full *for this window*.
  const records = select({ count: 49, before: 1 });
  assert.equal(records.length, 50, 'fifty records are written');
  const seen = asSnapshotSees(records);
  assert.equal(seen.length, 49, 'and only 49 of them are epoch input');
  assert.equal(isTruncated(seen, WINDOW), false);
});

test('60 records is well over the cap (C6)', () => {
  const seen = asSnapshotSees(select({ count: 60 }));
  assert.equal(isTruncated(seen, WINDOW), true);
});

// ── the near misses ────────────────────────────────────────────────────────

test('a record just before the window opens does not count (C10)', () => {
  const records = select({ count: 2, before: 1 });
  assert.equal(records.length, 3);
  assert.equal(asSnapshotSees(records).length, 2);
});

test('a record just after the window closes does not count (C11)', () => {
  const records = select({ count: 2, after: 1 });
  assert.equal(records.length, 3);
  assert.equal(asSnapshotSees(records).length, 2);
});

test('out-of-window records come from wallets that are not already counted', () => {
  // Reusing an in-window caller would write a second record for someone
  // already in the set — which changes nothing observable, so a broken
  // near-miss test would look like a passing one.
  const records = select({ count: 3, before: 1, after: 1 });
  const inWindow = new Set(asSnapshotSees(records).map((r) => r.walletAddress));
  const outside = records
    .filter((r) => !inWindow.has(r.walletAddress))
    .map((r) => r.walletAddress);
  assert.equal(outside.length, 2);
  assert.equal(new Set(outside).size, 2, 'and from two different wallets');
});

test('an out-of-window record cannot collide with the same epoch’s in-window id', () => {
  const ids = select({ count: 3, before: 1, after: 1 }).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique or mergeById would silently drop one');
});

// ── the ordinary behaviour it must not have broken ─────────────────────────

test('with no count, every eligible caller writes one record', () => {
  const records = select({ cast: cast(6) });
  assert.equal(records.length, 6);
  assert.equal(asSnapshotSees(records).length, 6);
});

test('--silent writes nothing, for the empty epoch (C1)', () => {
  assert.deepEqual(select({ silent: true }), []);
});

test('--only restricts the callers, and --count still applies within it', () => {
  const only = new Set(['w01', 'w02', 'w03']);
  assert.equal(select({ only }).length, 3);
  assert.equal(select({ only, count: 2 }).length, 2);
});

test('fader stops calling out after the fade epoch, and count respects that', () => {
  const withFader = [{ name: 'fader', address: 'AddrFader' }, ...cast(3)];
  assert.equal(select({ cast: withFader, epochsIn: 0 }).length, 4);
  assert.equal(select({ cast: withFader, epochsIn: 5 }).length, 3, 'fader has gone quiet');
});

test('asking for more callers than exist is refused, not quietly truncated', () => {
  // Silently writing 4 when 50 were asked for is a run that reports a boundary
  // it never approached.
  assert.throws(() => select({ cast: cast(4), count: 50 }), /only 4 are available/);
  assert.throws(() => select({ cast: cast(4), count: 3, before: 2 }), /distinct callers/);
});
