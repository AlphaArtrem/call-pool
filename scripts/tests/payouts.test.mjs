// "Was I actually paid?" — the two answers that must never be swapped.
//
// A share can be allocated and never delivered two ways, and they mean opposite
// things: the airdrop broke (owed, act on it) or the holder had sold below the
// floor (not owed, working as designed). Telling a holder the wrong one is
// either a false claim on the pool or a silent underpayment.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVERY, deliveryFor, payoutHistory, describeDelivery, projectedShare, settledEpochIndices,
} from '../../site/js/payouts.js';

const W = 'EXbcXYZJTRFLjix9CPLFa4p79WhxtxFnBZz7kyQiYgXZ';
const OTHER = 'Amn5WXq5eYtMab1QADor82tQoWXY4EgSPWbiWLsDqLxw';

const tree = (owner = W, amount = '49995000', index = 0) => ({
  epoch: 25, root: 'ab', leafCount: 1, allocate: amount,
  leaves: [{ index, owner, amount, proof: [] }],
});

test('a delivered leaf reports paid, and carries the signature that proves it', () => {
  const airdrop = { sent: [{ signature: '392Wfcog', leaves: [0] }], failed: [] };
  const r = deliveryFor(tree(), airdrop, W);
  assert.equal(r.state, DELIVERY.paid);
  assert.equal(r.amount, 49_995_000n);
  assert.equal(r.signature, '392Wfcog');
});

test('a policy refusal is NOT reported as a failure', () => {
  // The holder sold below the floor before the airdrop ran (§4.5). The money
  // correctly stayed in the pool. Calling this "failed" would tell them the
  // system owes them something it does not.
  const airdrop = {
    sent: [],
    failed: [{ leaves: [0], policy: true, error: 'BelowMinHold' }],
  };
  const r = deliveryFor(tree(), airdrop, W);
  assert.equal(r.state, DELIVERY.refused);
});

test('a mechanical failure IS reported as owed', () => {
  // No `policy` flag: the send broke. Someone should re-run the airdrop, and
  // the leaf stays claimable until the deadline.
  const airdrop = { sent: [], failed: [{ leaves: [0], error: 'blockhash not found' }] };
  const r = deliveryFor(tree(), airdrop, W);
  assert.equal(r.state, DELIVERY.failed);
});

test('a settled epoch whose airdrop has not run yet is pending, not broken', () => {
  const r = deliveryFor(tree(), null, W);
  assert.equal(r.state, DELIVERY.pending);
  assert.equal(r.amount, 49_995_000n);
});

test('a leaf the run never reached is reported, not silently omitted', () => {
  // In the tree, the airdrop ran, and the leaf is in neither list. Practically
  // the same position as a failure, so it is not quietly dropped.
  const airdrop = { sent: [{ signature: 's', leaves: [7] }], failed: [] };
  const r = deliveryFor(tree(), airdrop, W);
  assert.equal(r.state, DELIVERY.failed);
});

test('a wallet not in the tree earned nothing that epoch', () => {
  const r = deliveryFor(tree(OTHER), { sent: [], failed: [] }, W);
  assert.equal(r.state, DELIVERY.none);
  assert.equal(r.amount, 0n);
});

test('refused amounts are never counted as owed', () => {
  // The line that would otherwise present a false claim on the pool.
  const epochs = [
    { epoch: 1, tree: tree(W, '100'), airdrop: { sent: [{ signature: 'a', leaves: [0] }], failed: [] } },
    { epoch: 2, tree: tree(W, '200'), airdrop: { sent: [], failed: [{ leaves: [0], policy: true }] } },
    { epoch: 3, tree: tree(W, '300'), airdrop: { sent: [], failed: [{ leaves: [0] }] } },
  ];
  const h = payoutHistory(epochs, W);
  assert.equal(h.paid, 100n);
  assert.equal(h.refused, 200n, 'refused is reported separately');
  assert.equal(h.owed, 300n, 'only the mechanical failure is owed');
});

test('pending counts as owed — the money is coming, it just has not arrived', () => {
  const h = payoutHistory([{ epoch: 4, tree: tree(W, '500'), airdrop: null }], W);
  assert.equal(h.owed, 500n);
  assert.equal(h.paid, 0n);
});

test('only a mechanical failure asks the holder to do something', () => {
  const paidOnly = payoutHistory(
    [{ epoch: 1, tree: tree(W, '100'), airdrop: { sent: [{ signature: 'a', leaves: [0] }], failed: [] } }],
    W,
  );
  assert.equal(paidOnly.needsAttention, false);

  const refusedOnly = payoutHistory(
    [{ epoch: 2, tree: tree(W, '200'), airdrop: { sent: [], failed: [{ leaves: [0], policy: true }] } }],
    W,
  );
  assert.equal(refusedOnly.needsAttention, false, 'a correct refusal is not an incident');

  const broken = payoutHistory(
    [{ epoch: 3, tree: tree(W, '300'), airdrop: { sent: [], failed: [{ leaves: [0] }] } }],
    W,
  );
  assert.equal(broken.needsAttention, true);
});

test('history reads newest first, and skips epochs the wallet was not in', () => {
  const epochs = [
    { epoch: 1, tree: tree(W, '100'), airdrop: null },
    { epoch: 2, tree: tree(OTHER, '999'), airdrop: null },
    { epoch: 3, tree: tree(W, '300'), airdrop: null },
  ];
  const h = payoutHistory(epochs, W);
  assert.deepEqual(h.rows.map((r) => r.epoch), [3, 1]);
});

test('a refusal is worded as the mechanic working, not as an outage', () => {
  const sol = (n) => `${n} lamports`;
  const refused = describeDelivery(
    { state: DELIVERY.refused, amount: 200n }, sol,
  );
  assert.match(refused, /held less than the floor/);
  assert.match(refused, /stayed in the pool/);
  assert.ok(!/fail|error|problem/i.test(refused), 'must not read as a fault');

  const failed = describeDelivery({ state: DELIVERY.failed, amount: 300n }, sol);
  assert.match(failed, /still claimable/);
});

// ── the bug the real audit trail caught ────────────────────────────────────

test('delivery is read from runs[], not from the last run\'s summary', () => {
  // Found by running this against the real epoch-1 trail: two leaves had
  // signatures and still reported as failures.
  //
  // `airdrop.json`'s top-level sent/failed describes the MOST RECENT run. A
  // re-run after a partial failure sends nothing — already-paid leaves are
  // write-once on chain and bounce — so the top level ends up empty and every
  // leaf paid by the first run looks undelivered. runs[] is the durable record.
  const airdrop = {
    sent: [],                                   // last run sent nothing
    failed: [{ leaves: [0], policy: true }],    // and only re-bounced leaf 0
    runs: [
      { ranAt: 1, sent: [{ signature: 'first-run', leaves: [1, 2] }], failed: [{ leaves: [0], policy: true }] },
      { ranAt: 2, sent: [], failed: [{ leaves: [0], policy: true }] },
    ],
  };
  const tree = {
    leaves: [
      { index: 0, owner: 'A', amount: '100' },
      { index: 1, owner: 'B', amount: '200' },
      { index: 2, owner: 'C', amount: '300' },
    ],
  };

  assert.equal(deliveryFor(tree, airdrop, 'B').state, DELIVERY.paid);
  assert.equal(deliveryFor(tree, airdrop, 'C').state, DELIVERY.paid);
  assert.equal(deliveryFor(tree, airdrop, 'B').signature, 'first-run');
  // The one that really was refused still reads as refused.
  assert.equal(deliveryFor(tree, airdrop, 'A').state, DELIVERY.refused);
});

test('a send in any run beats a bounce in a later one', () => {
  // Claims are write-once, so re-running makes a paid leaf fail. The send is
  // the fact; the bounce is an artefact of asking twice.
  const airdrop = {
    runs: [
      { sent: [{ signature: 'paid-it', leaves: [0] }], failed: [] },
      { sent: [], failed: [{ leaves: [0], error: 'already claimed' }] },
    ],
  };
  const tree = { leaves: [{ index: 0, owner: 'A', amount: '100' }] };
  assert.equal(deliveryFor(tree, airdrop, 'A').state, DELIVERY.paid);
});

test('an airdrop.json with no runs[] still works — older files, and first runs', () => {
  const airdrop = { sent: [{ signature: 's', leaves: [0] }], failed: [] };
  const tree = { leaves: [{ index: 0, owner: 'A', amount: '100' }] };
  assert.equal(deliveryFor(tree, airdrop, 'A').state, DELIVERY.paid);
});

// ── today: a projection, and it must refuse to guess ───────────────────────

test('today\'s indicative share is the last settled fraction applied to the pool now', () => {
  const previousTree = { epoch: 9, allocate: '1000', leaves: [{ index: 0, owner: W, amount: '250' }] };
  const p = projectedShare({ previousTree, wallet: W, poolLamports: 4000n });
  assert.equal(p.numerator, 250n);
  assert.equal(p.denominator, 1000n);
  assert.equal(p.indicative, 1000n, 'a quarter of the last tree, against a pool of 4000');
  assert.equal(p.basisEpoch, 9);
});

test('no basis means no number — it must not invent one', () => {
  // L9: state the mechanic, not a return. A projection with nothing behind it
  // is the yield framing the whole site is written to avoid.
  const tree = { epoch: 9, allocate: '1000', leaves: [{ index: 0, owner: OTHER, amount: '250' }] };
  assert.equal(projectedShare({ previousTree: tree, wallet: W, poolLamports: 4000n }), null);
  assert.equal(projectedShare({ previousTree: null, wallet: W, poolLamports: 4000n }), null);
  assert.equal(
    projectedShare({ previousTree: { epoch: 9, allocate: '0', leaves: [] }, wallet: W, poolLamports: 4000n }),
    null,
  );
});

test('an empty pool projects zero rather than failing', () => {
  const previousTree = { epoch: 9, allocate: '1000', leaves: [{ index: 0, owner: W, amount: '250' }] };
  assert.equal(projectedShare({ previousTree, wallet: W, poolLamports: 0n }).indicative, 0n);
});

// ── which epochs the panel asks for ────────────────────────────────────────
//
// The bug these pin shipped and was invisible: app.js read the epoch rows off
// the wrong object and then took a field that does not exist on them. Both
// produce an empty list, an empty list produces an empty trail, and an empty
// trail renders identically to a wallet that has never been paid — so the
// paid/owed panel never appeared for anyone and nothing looked wrong.

test('settled epochs are taken by index, newest first', () => {
  assert.deepEqual(
    settledEpochIndices([
      { posted: true, index: 3 },
      { posted: true, index: 11 },
      { posted: true, index: 7 },
    ]),
    [11, 7, 3],
  );
});

test('unposted epochs are not asked for — they have no published inputs', () => {
  assert.deepEqual(
    settledEpochIndices([
      { posted: false, index: 12 },
      { posted: true, index: 4 },
      { posted: false, index: 13 },
    ]),
    [4],
  );
});

test('a row without a numeric index is dropped, never turned into a URL', () => {
  // `epoch-undefined/tree.json` 404s, and `loadPayoutTrail` swallows a 404 by
  // design — so this is precisely the shape that failed silently. The field is
  // `index`; a row carrying only `epoch` is the mistake, not an alias for it.
  assert.deepEqual(settledEpochIndices([{ posted: true, epoch: 5 }]), []);
  assert.deepEqual(settledEpochIndices([{ posted: true, index: undefined }]), []);
  assert.deepEqual(settledEpochIndices([{ posted: true, index: 2 }, { posted: true, epoch: 9 }]), [2]);
});

test('the list is bounded, and keeps the newest', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ posted: true, index: i }));
  assert.deepEqual(settledEpochIndices(rows, 3), [29, 28, 27]);
  assert.equal(settledEpochIndices(rows).length, 14, 'defaults to a fortnight');
});

test('a missing or unread epochs list is empty, not a crash', () => {
  // The panel is wired before the first chain read finishes.
  assert.deepEqual(settledEpochIndices(undefined), []);
  assert.deepEqual(settledEpochIndices(null), []);
  assert.deepEqual(settledEpochIndices([]), []);
});
