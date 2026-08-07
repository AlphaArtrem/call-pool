// The airdrop record — the file that says who was paid, and who was not.
//
// `airdrop.json` is the evidence that a scheduled job ran. Its most important
// reader is whoever is recovering from a partial run, and the run they most
// need to see is the one that failed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeFailure, isPolicyRefusal, mergeAirdropRuns } from '../airdrop.mjs';

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
