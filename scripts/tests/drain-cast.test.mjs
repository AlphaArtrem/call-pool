// The decision half of the cast drain.
//
// The rule worth testing without a cluster is the one that protects money: a
// wallet still holding tokens must never be emptied of the lamports it needs to
// sell them with. Run 1 lost 5.03 SOL to the same shape of mistake — value made
// unrecoverable by doing two correct steps in the wrong order.

import assert from 'node:assert/strict';
import test from 'node:test';

import { castNames, planFor } from '../tools/drain-cast.mjs';

const plan = (over) => planFor({ name: 'w01', lamports: 90_000_000n, tokens: 0n, keep: [], ...over });

test('an emptied wallet gives up every lamport', () => {
  const result = plan({ lamports: 90_000_000n });
  assert.equal(result.action, 'drain');
  // Not "balance less a fee": a system account may end at zero or at the
  // rent-exempt minimum and at nothing between, so a fee left behind is a
  // rejected transaction, not a smaller recovery. The payer signs and pays.
  assert.equal(result.lamports, 90_000_000n);
});

test('a wallet that still holds tokens is never drained', () => {
  const result = plan({ tokens: 1_083_446_545_044n });
  assert.equal(result.action, 'skip');
  assert.match(result.why, /sell first/);
});

test('the skip names the amount, so the operator can see what is at stake', () => {
  assert.match(plan({ tokens: 42n }).why, /42 raw units/);
});

test('--keep wins over everything else', () => {
  assert.deepEqual(plan({ keep: ['w01'] }), { action: 'skip', why: 'kept by --keep' });
});

test('dust is left where it is — the transfer costs about what it recovers', () => {
  assert.equal(plan({ lamports: 5_000n }).action, 'skip');
  assert.equal(plan({ lamports: 5_001n }).action, 'drain');
});

test('an empty wallet is skipped rather than sent a zero-lamport transfer', () => {
  assert.equal(plan({ lamports: 0n }).action, 'skip');
});

test('the cast is walked in a stable order, and only keypairs are walked', () => {
  const readdir = () => ['w02.json', 'steady.json', 'notes.txt', 'w01.json'];
  assert.deepEqual(castNames('/keys', { readdir }), ['steady', 'w01', 'w02']);
});
