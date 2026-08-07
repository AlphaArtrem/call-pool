// The two values in the coin-creation path that cannot be taken back.
//
// `updateFeeShares` sets `admin_revoked` on its first call (F7), so the
// shareholder list is a one-shot, unrecoverable decision — on devnet as much as
// on mainnet. That makes it worth a test that does not need a chain.

import assert from 'node:assert/strict';
import test from 'node:test';

import { shareholdersFor } from '../tools/mk-pump-coin.mjs';
import { resolveSellAmount } from '../tools/pump-trade.mjs';

// ── the split ──────────────────────────────────────────────────────────────

test('the split is 9000/1000 and totals exactly 10000 bps', () => {
  const shares = shareholdersFor('POOL', 'OPS');
  assert.deepEqual(shares, [
    { address: 'POOL', shareBps: 9_000 },
    { address: 'OPS', shareBps: 1_000 },
  ]);
  assert.equal(
    shares.reduce((sum, s) => sum + s.shareBps, 0),
    10_000,
    'pump rejects anything that does not total 10000',
  );
});

test('the pool comes first, because it is the 90% one', () => {
  // Order is not semantically load-bearing to pump, but a reader checking a
  // one-shot instruction should meet the big number first.
  assert.equal(shareholdersFor('POOL', 'OPS')[0].shareBps, 9_000);
});

test('a duplicate shareholder is refused rather than sent', () => {
  // pump rejects it anyway — but it rejects it at send time, after the mint
  // keypair has been spent and with admin_revoked already in play.
  assert.throws(() => shareholdersFor('SAME', 'SAME'), /same address/);
});

// ── how much to sell ───────────────────────────────────────────────────────

test('`all` sells the whole balance — the F18 recovery path', () => {
  assert.equal(resolveSellAmount('all', 1_234_567n), 1_234_567n);
});

test('a percentage sells that fraction, floored', () => {
  assert.equal(resolveSellAmount('50%', 1_000n), 500n);
  assert.equal(resolveSellAmount('10%', 999n), 99n, 'floors rather than rounding up');
  assert.equal(resolveSellAmount('100%', 777n), 777n);
});

test('a raw amount is taken literally', () => {
  assert.equal(resolveSellAmount('250', 1_000n), 250n);
});

test('selling more than the wallet holds is refused', () => {
  assert.throws(() => resolveSellAmount('2000', 1_000n), /exceeds the balance/);
});

test('a nonsense percentage is refused rather than silently clamped', () => {
  assert.throws(() => resolveSellAmount('0%', 1_000n), /out of range/);
  assert.throws(() => resolveSellAmount('150%', 1_000n), /out of range/);
});

test('a zero balance yields zero, and the caller decides what that means', () => {
  assert.equal(resolveSellAmount('all', 0n), 0n);
  assert.equal(resolveSellAmount('50%', 0n), 0n);
});
