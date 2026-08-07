// Which epochs a deliberate audit picks, and what it refuses to call a fault.
//
// Two ways for an audit to be worthless. It samples the epochs least likely to
// be wrong — the newest, built by today's code on today's pool — and concludes
// everything is fine. Or it reports a non-archival RPC's missing history as a
// bad epoch, produces a false alarm loud enough to be memorable, and the next
// audit gets skipped.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseEpochs, isArchiveLimit } from '../tools/audit-epochs.mjs';

const range = (n) => Array.from({ length: n }, (_, i) => i);
const nothingCarries = () => false;

test('a short history is audited whole rather than sampled', () => {
  assert.deepEqual(chooseEpochs([0, 1, 2], { sample: 8, carries: nothingCarries }), [0, 1, 2]);
});

test('the oldest is always audited — it is the one the code has changed most since', () => {
  const chosen = chooseEpochs(range(100), { sample: 5, carries: nothingCarries });
  assert.equal(chosen[0], 0);
});

test('the newest is audited too, so a fault introduced today is caught today', () => {
  const chosen = chooseEpochs(range(100), { sample: 5, carries: nothingCarries });
  assert.equal(chosen.at(-1), 99);
});

test('every carrying epoch is preferred — the carry chain links epochs to each other', () => {
  // A broken link is invisible from either side alone, and the dust path went
  // entirely unexercised until the 2026-08-07 rehearsal happened to hit it.
  const carrying = new Set([12, 34, 56]);
  const chosen = chooseEpochs(range(100), { sample: 6, carries: (e) => carrying.has(e) });

  for (const epoch of carrying) {
    assert.ok(chosen.includes(epoch), `epoch ${epoch} carries dust and was not audited`);
  }
});

test('the sample size is respected even when everything carries', () => {
  const chosen = chooseEpochs(range(100), { sample: 5, carries: () => true });
  assert.equal(chosen.length, 5);
});

test('what is left over is spread out, not clustered at one end', () => {
  const chosen = chooseEpochs(range(100), { sample: 6, carries: nothingCarries });
  assert.equal(chosen.length, 6);

  // The whole point of the spread: a systematic fault introduced partway
  // through the history has to be bracketed by two samples somewhere.
  const gaps = chosen.slice(1).map((e, i) => e - chosen[i]);
  assert.ok(Math.max(...gaps) < 40, `one gap of ${Math.max(...gaps)} epochs is not a spread`);
});

test('the result is sorted and free of duplicates', () => {
  const chosen = chooseEpochs(range(50), { sample: 10, carries: (e) => e === 0 || e === 49 });
  assert.deepEqual(chosen, [...new Set(chosen)].sort((a, b) => a - b));
});

test('an empty snapshots tree chooses nothing rather than throwing', () => {
  assert.deepEqual(chooseEpochs([], { sample: 8, carries: nothingCarries }), []);
});

// ── the node's fault, not the epoch's ──────────────────────────────────────

test('missing archival history is not reported as a bad epoch', () => {
  assert.equal(isArchiveLimit('wallet X: chain history could not be replayed — gap at slot 9'), true);
  assert.equal(
    isArchiveLimit('RPC returned no transaction for a signature it had just listed — history is incomplete'),
    true,
  );
  assert.equal(isArchiveLimit('getSignaturesForAddress failed after 5 attempts: 429'), true);
});

test('a real mismatch is still a failure, however it is worded', () => {
  assert.equal(isArchiveLimit('root mismatch: published abc, recomputed def'), false);
  assert.equal(isArchiveLimit('WALLET: published hold 100, chain says 50'), false);
  assert.equal(isArchiveLimit('carry chain broken: this file records null'), false);
});
