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

// ── updates: the L2 path nothing could stage until 2026-08-09 ───────────────
//
// `mock-callouts` wrote callouts only, so `parentCalloutId`/`isUpdate` records
// existed in production and in unit fixtures and nowhere in between — C9 was
// listed in the gate matrix as unobserved and was in fact unstageable.
// Measured on five live coins: 30% of callouts carry an update, mean 2.42,
// max 29, median delay ~7.6h.

const { stageUpdates } = await import('../tools/mock-callouts.mjs');

test('an update is staged against its author\'s own callout (L2/C9)', () => {
  const records = select({ count: 5, updates: 2 });
  const updates = records.filter((r) => r.isUpdate);

  assert.equal(updates.length, 2);
  for (const u of updates) {
    const parent = records.find((r) => r.id === u.parentCalloutId);
    assert.ok(parent, 'every update names a callout in the same batch');
    // The rule the whole ruling rests on: an update can only ever be the
    // author's own. A staged update authored by anyone else would be a fixture
    // asserting something the API cannot produce.
    assert.equal(u.walletAddress, parent.walletAddress);
  }
});

test('updates land inside the window, so they count', () => {
  const seen = asSnapshotSees(select({ count: 3, updates: 3 }));
  assert.equal(seen.filter((r) => r.isUpdate).length, 3);
});

test('--update-age earns the window on the update alone', () => {
  // The real median delay is ~7.6h — forty-five epochs at a ten-minute clock —
  // so the callout is long outside the window and only the update is in it.
  // A settlement that looked at callouts alone would credit nobody here.
  const records = select({ count: 0, updates: 2, updateAgeSeconds: 27_301 });
  const seen = asSnapshotSees(records);

  assert.equal(seen.length, 2, 'only the updates are in the window');
  assert.ok(seen.every((r) => r.isUpdate));

  // The parents exist, and are outside.
  const parents = records.filter((r) => !r.isUpdate);
  assert.equal(parents.length, 2);
  for (const p of parents) {
    assert.ok(Math.floor(Date.parse(p.createdAt) / 1000) < WINDOW.start);
  }
});

test('an update with no callout to attach to is refused, not invented', () => {
  assert.throws(
    () => stageUpdates({ callers: cast(2), epoch: 3, mint: 'MintAddr', window: WINDOW,
      createdAt: CREATED_AT, updates: 1, staged: [] }),
    /no callout in epoch 3 to update/,
  );
});

test('staged records carry the full mainnet field set, not the seven we read', () => {
  // The rehearsal settled against seven-field records for five runs while the
  // real API returns twenty-nine. Anything downstream that touches a field we
  // do not read — the mock API, the site, a verifier — met a shape in the
  // rehearsal that does not exist in production.
  const [record] = select({ count: 1 });
  for (const field of [
    'id', 'communityId', 'userId', 'username', 'displayName', 'content', 'likeCount',
    'createdAt', 'multiplier', 'isSpam', 'isHarmful', 'replyCount', 'tokenAddress',
    'walletAddress', 'deletedAt', 'mentions', 'mentionedUserIds',
  ]) {
    assert.ok(field in record, `a real callout has ${field}`);
  }
  assert.ok(Array.isArray(record.mentions));
});
