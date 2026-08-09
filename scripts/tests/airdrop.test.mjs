// The airdrop record — the file that says who was paid, and who was not.
//
// `airdrop.json` is the evidence that a scheduled job ran. Its most important
// reader is whoever is recovering from a partial run, and the run they most
// need to see is the one that failed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLAIMS_PER_TX,
  TX_SIZE_LIMIT,
  describeFailure,
  isPolicyRefusal,
  mergeAirdropRuns,
  packClaims,
} from '../airdrop.mjs';

const run = (ranAt, sent, failed = []) => ({
  ranAt,
  submitter: 'SubmitterPubkey',
  sent,
  failed,
});

test('a first run records itself', () => {
  const merged = mergeAirdropRuns(null, run(100, [{ signature: 'sig1', leaves: [0, 1] }]));

  assert.equal(merged.runs.length, 1);
  assert.equal(merged.runs[0].ranAt, 100);
  assert.equal(merged.ranAt, 100, 'the newest run stays readable at the top level');
});

test('a recovery run is appended, and does not erase what it is recovering from', () => {
  // The whole point: run 1 failed two leaves, run 2 delivered them. A reader
  // asking "was leaf 7 ever paid, and did anything go wrong?" needs both.
  const first = mergeAirdropRuns(
    null,
    run(100, [{ signature: 'sig1', leaves: [0] }], [{ leaves: [7], error: 'below the floor' }]),
  );
  const second = mergeAirdropRuns(first, run(200, [{ signature: 'sig2', leaves: [7] }]));

  assert.equal(second.runs.length, 2);
  assert.deepEqual(second.runs[0].failed, [{ leaves: [7], error: 'below the floor' }]);
  assert.deepEqual(second.runs[1].sent, [{ signature: 'sig2', leaves: [7] }]);
  assert.equal(second.ranAt, 200, 'the top level describes the latest run');
  assert.deepEqual(second.failed, [], 'which had no failures');
});

test('a record written before runs existed is carried forward, not dropped', () => {
  // The old shape had one run flattened at the top level. A rehearsal directory
  // written by the previous code must not lose its history on the next run.
  const old = {
    epoch: 12,
    ranAt: 50,
    submitter: 'SubmitterPubkey',
    sent: [{ signature: 'old', leaves: [3] }],
    failed: [],
  };

  const merged = mergeAirdropRuns(old, run(60, [{ signature: 'new', leaves: [4] }]));
  assert.equal(merged.runs.length, 2);
  assert.equal(merged.runs[0].ranAt, 50);
  assert.deepEqual(merged.runs[0].sent, [{ signature: 'old', leaves: [3] }]);
  assert.equal(merged.epoch, 12);
});

test('every transaction ever sent for the epoch stays reachable', () => {
  let record = null;
  for (const [at, sig] of [[1, 'a'], [2, 'b'], [3, 'c']]) {
    record = mergeAirdropRuns(record, run(at, [{ signature: sig, leaves: [at] }]));
  }

  const signatures = record.runs.flatMap((r) => r.sent.map((s) => s.signature));
  assert.deepEqual(signatures, ['a', 'b', 'c']);
});

// ── a batch that reverts, and what the exit code owes the operator ─────────
//
// Found on the devnet rehearsal, epoch 2. `dumper` sold mid-epoch, so `claim`
// refused it at payout time (§4.5) — correctly. But all three claims shared one
// transaction, and a transaction is all or nothing, so two holders who had done
// nothing wrong went unpaid. The run then printed "1 failed" and exited 0, and
// the crank read that as a completed airdrop.

test('the min-hold refusal is recognised, and named rather than dumped', () => {
  const real = 'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x177e.';
  assert.equal(isPolicyRefusal(real), true);
  assert.match(describeFailure(real), /sold since the snapshot/);
  assert.doesNotMatch(describeFailure(real), /0x177e/, 'the operator gets the reason, not the code');
});

test('any other program error is not policy — it is money owed and unsent', () => {
  // 0x1775 is InvalidProof: a real defect in what was published.
  const other = 'Transaction simulation failed: custom program error: 0x1775.';
  assert.equal(isPolicyRefusal(other), false);
  assert.equal(describeFailure(other), other, 'unexpected failures are shown verbatim');

  assert.equal(isPolicyRefusal('fetch failed'), false, 'a dropped connection is not policy');
  assert.equal(isPolicyRefusal(''), false);
  assert.equal(isPolicyRefusal(undefined), false);
});

// ── how many claims fit in one transaction (2026-08-09) ────────────────────
//
// `CLAIMS_PER_TX = 5` was a constant whose comment said five "stays comfortably
// inside the 1,232-byte packet limit even for a large tree". It never did, and
// could not have: a claim's size is dominated by its merkle proof, which grows
// with the tree. On run 3 every batch of five reverted — eleven out of eleven —
// and 57 people were paid in 53 transactions instead of the 12 the test matrix
// predicted. Nobody noticed because the one-at-a-time retry paid everyone
// anyway, at five times the fees.
//
// The packer measures a candidate batch instead of assuming. These tests pin
// the packing decisions, with `measure` modelled on the real message layout:
// ~327 bytes fixed (signature, header, the seven shared account keys,
// blockhash) plus ~301 per claim at a depth-6 proof.

const realistic = (fixed = 327, perClaim = 301) => (batch) => fixed + batch.length * perClaim;
const leaves = (n) => Array.from({ length: n }, (_, index) => ({ index }));

test('the batch that used to be five is three, and every one of them fits', () => {
  const measure = realistic();
  const batches = packClaims(leaves(57), measure);

  for (const batch of batches) {
    assert.ok(
      measure(batch) <= TX_SIZE_LIMIT,
      `a batch of ${batch.length} measured ${measure(batch)}, over the ${TX_SIZE_LIMIT} limit`,
    );
  }
  assert.deepEqual([...new Set(batches.map((b) => b.length))], [3]);
});

test('every leaf is packed exactly once — nobody is dropped or paid twice', () => {
  // The failure that would matter most: a packer that loses a leaf loses
  // someone's payout, and one that repeats a leaf tries to pay them twice.
  const all = leaves(57);
  const packed = packClaims(all, realistic()).flat().map((l) => l.index);

  assert.equal(packed.length, all.length);
  assert.deepEqual([...packed].sort((a, b) => a - b), all.map((l) => l.index));
});

test('a shallow tree packs more per transaction than a deep one', () => {
  // The whole reason a constant cannot be right: the answer depends on the
  // proof depth, so it must change with the tree.
  const shallow = packClaims(leaves(24), realistic(327, 141)); // depth 2
  const deep = packClaims(leaves(24), realistic(327, 429)); // depth 10

  assert.ok(
    shallow.length < deep.length,
    `shallow proofs should need fewer transactions (${shallow.length} vs ${deep.length})`,
  );
});

test('the size limit wins over the count cap, and the cap still applies', () => {
  // With tiny claims the packer would keep growing a batch until it met the
  // compute budget instead — a different limit with a much less obvious
  // failure — so the cap holds it back.
  const batches = packClaims(leaves(50), realistic(100, 5));
  assert.ok(batches.every((b) => b.length <= MAX_CLAIMS_PER_TX));
  assert.equal(batches[0].length, MAX_CLAIMS_PER_TX);
});

test('a single claim too large for any transaction is still emitted, alone', () => {
  // It cannot be made smaller. Emitting it lets `send` fail and record it as
  // the failure it is; dropping it would silently not pay someone who is owed.
  const batches = packClaims(leaves(3), () => TX_SIZE_LIMIT + 1);

  assert.equal(batches.length, 3);
  assert.ok(batches.every((b) => b.length === 1));
});

test('no leaves produce no transactions', () => {
  assert.deepEqual(packClaims([], realistic()), []);
});

test('the packer never emits an empty batch', () => {
  // An empty batch would send a transaction with no instructions.
  for (const n of [1, 2, 3, 7, 57, 120]) {
    assert.ok(packClaims(leaves(n), realistic()).every((b) => b.length > 0), `n=${n}`);
  }
});
