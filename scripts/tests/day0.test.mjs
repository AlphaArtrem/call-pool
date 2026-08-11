// Day 0 — the span between coin creation and genesis — reconciles.
//
// It is the one paid day the program did not settle and never will. The pool
// account pays from day 1; day 0 predates the first on-chain epoch, so it was
// computed with the settlement's own `holdsFor`/`buildEpoch` over the day-0
// window and honored from the creator-fee share by hand
// (`snapshots/day0/pay-day0.sh`).
//
// That makes it the only paid day with **no chain artefact to check it
// against**: no Epoch account, no merkle root, no `claim` that would refuse a
// wrong amount. Every other day in `snapshots/` is checkable by a stranger with
// `verify-epoch.mjs`; this one is checkable only against itself. So the
// self-consistency is asserted here rather than assumed, because the file IS
// the evidence and a file nothing reads is a file that can rot unnoticed.
//
// What this pins:
//
//   * every wallet the receipts paid was a wallet the standings said to pay,
//     for exactly the amount the standings said;
//   * the receipts add up to `allocateLamports`, to the lamport;
//   * every payment carries a transaction signature, so each one is findable
//     on chain by anyone who wants to check it;
//   * the pot covers the allocation.
//
// It does NOT re-derive the standings from chain history. That is
// `day0-standings.mjs`'s job and it needs an RPC; this runs offline, on the
// published files, which is what a reader has.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT } from '../lib/store.mjs';

const DIR = resolve(REPO_ROOT, 'snapshots/day0');
const read = (file) => JSON.parse(readFileSync(resolve(DIR, file), 'utf8'));

const day0 = read('day0.json');
// An object keyed by row index rather than an array — every standing is in
// here, paid or not, and the paid ones carry `txSig`.
const receipts = Object.values(read('receipts.json'));

/** The standings that were owed something, keyed by wallet. */
function owed() {
  return new Map(
    day0.standings.filter((s) => s.lamports).map((s) => [s.wallet, BigInt(s.lamports)]),
  );
}

/** The receipt rows that actually moved money. */
function sent() {
  return receipts.filter((r) => r.lamports && BigInt(r.lamports) > 0n);
}

test('day 0 is the creator-fee honor, not a settled epoch', () => {
  // The `kind` is what tells a reader this day was NOT settled by the program.
  // A day-0 file that called itself an epoch would invite exactly the check
  // that cannot be run on it.
  assert.equal(day0.kind, 'day0-creator-fee-honor');
  assert.ok(day0.window.start < day0.window.end);
  assert.ok(day0.standings.length > 0, 'a paid day with no standings is not a paid day');
});

test('every payment made was a payment the standings called for', () => {
  const expected = owed();
  for (const row of sent()) {
    assert.ok(
      expected.has(row.wallet),
      `${row.wallet} was paid but is not owed anything in the standings`,
    );
    assert.equal(
      BigInt(row.lamports),
      expected.get(row.wallet),
      `${row.wallet} was paid a different amount from the one it was owed`,
    );
  }
});

test('every wallet the standings owed was actually paid', () => {
  // The direction the check above cannot catch: a wallet allocated a share and
  // then missed by the manual run would leave no trace in the receipts at all.
  const paid = new Set(sent().map((r) => r.wallet));
  for (const [wallet] of owed()) {
    assert.ok(paid.has(wallet), `${wallet} was owed a share and has no receipt`);
  }
});

test('the receipts add up to the allocation, to the lamport', () => {
  const total = sent().reduce((sum, r) => sum + BigInt(r.lamports), 0n);
  assert.equal(total, BigInt(day0.allocateLamports));
  // The pot is what was available; the allocation is what the split could
  // divide out of it. The remainder is the rounding dust that stayed behind.
  assert.ok(BigInt(day0.potLamports) >= BigInt(day0.allocateLamports));
});

test('every payment can be found on chain', () => {
  // Without a signature a receipt is a claim rather than evidence, and this
  // day has no merkle root standing behind it to make up the difference.
  for (const row of sent()) {
    assert.ok(
      typeof row.txSig === 'string' && row.txSig.length >= 64,
      `${row.wallet} has no usable transaction signature`,
    );
  }
});

test('the payment script pays exactly the wallets the receipts record', () => {
  // pay-day0.sh is committed as the record of what was actually run. If it
  // ever drifts from the receipts, one of the two is lying about where the
  // money went.
  const script = readFileSync(resolve(DIR, 'pay-day0.sh'), 'utf8');
  const lines = [...script.matchAll(/^send (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]);

  assert.equal(lines.length, sent().length, 'the script and the receipts pay a different count');

  const byWallet = new Map(sent().map((r) => [r.wallet, BigInt(r.lamports)]));
  for (const [wallet, sol] of lines) {
    assert.ok(byWallet.has(wallet), `${wallet} is paid by the script and has no receipt`);
    // The script is written in SOL and the receipts in lamports. Compared as
    // integers rather than floats, because 0.004684961 SOL is not exactly
    // representable and a float compare here would pass on a wrong number.
    const [whole, frac = ''] = sol.split('.');
    const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0'));
    assert.equal(lamports, byWallet.get(wallet), `${wallet}: script and receipt disagree`);
  }
});
