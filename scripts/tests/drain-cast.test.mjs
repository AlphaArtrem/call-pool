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

// ── when "sell first" is impossible (2026-08-09, run 5) ────────────────────
//
// The guard tells you to sell before draining, and that is right in every case
// but one: a **completed bonding curve with no AMM pool**. A complete curve
// refuses buys and sells alike, and the AMM exists only once pump migrates —
// which on devnet has never been observed. The tokens are unrecoverable at that
// point, and leaving the gas beside them recovers nothing. Run 5 stranded ~3.2
// SOL across sixty-three wallets exactly this way.

test('a token holder is still skipped by default', () => {
  // The guard is the thing protecting real value; the override must not soften
  // the default even slightly.
  const plan = planFor({ name: 'w01', lamports: 50_000_000n, tokens: 5_000_000n, keep: [] });
  assert.equal(plan.action, 'skip');
  assert.match(plan.why, /sell first/);
});

test('--tokens-are-unsellable drains a holder whose tokens cannot be sold', () => {
  const plan = planFor({
    name: 'w01',
    lamports: 50_000_000n,
    tokens: 5_000_000n,
    keep: [],
    tokensAreUnsellable: true,
  });
  assert.notEqual(plan.action, 'skip');
});

test('the override does not overrule --keep', () => {
  // `--keep` is an explicit instruction about a named wallet; a blanket flag
  // about token sellability has nothing to say about it.
  const plan = planFor({
    name: 'steady',
    lamports: 50_000_000n,
    tokens: 5_000_000n,
    keep: ['steady'],
    tokensAreUnsellable: true,
  });
  assert.equal(plan.action, 'skip');
  assert.match(plan.why, /--keep/);
});

test('the override does not drain dust either', () => {
  // Below the threshold a transfer costs more than it moves, whatever the
  // tokens are doing.
  const plan = planFor({
    name: 'w01',
    lamports: 1n,
    tokens: 5_000_000n,
    keep: [],
    tokensAreUnsellable: true,
  });
  assert.equal(plan.action, 'skip');
  assert.match(plan.why, /dust/);
});
