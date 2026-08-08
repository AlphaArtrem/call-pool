// The cast builder — who gets built, in what order, and what a resume keeps.
//
// The tool itself buys coin on devnet and cannot be tested here. What can be,
// and what the sixty-wallet run actually depends on, is the bookkeeping around
// the buying: a roster that drops the four named roles breaks three other
// tools, a batcher that loses its last group leaves a funded wallet nobody
// holds the key to, and a resume that misjudges "already built" either
// re-spends SOL the faucets cannot replace or skips a wallet that never bought.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { roster, fundingBatches, alreadyBuilt, GAS_SOL } = await import('../tools/mk-pump-cast.mjs');

// ── the roster ─────────────────────────────────────────────────────────────

test('the four named roles are built even when no scenario wallets are asked for', () => {
  // `mock-callouts.mjs` keys fader's silence off the string, `mock-sale.mjs`
  // takes `--wallet dumper`, and `dry-run-loop.mjs` scripts both. Losing these
  // names breaks all three without touching them.
  const names = roster({ count: 0 }).map((m) => m.name);
  assert.deepEqual(names, ['steady', 'fader', 'dumper', 'minnow']);
});

test('scenario wallets are added after the named roles, never instead of them', () => {
  const names = roster({ count: 3 }).map((m) => m.name);
  assert.deepEqual(names, ['steady', 'fader', 'dumper', 'minnow', 'w01', 'w02', 'w03']);
});

test('scenario names sort in the order they were made', () => {
  // `w2` before `w10` under a string sort would shuffle the driver's row
  // assignment between runs, which is how a matrix row silently changes wallet.
  const scenario = roster({ count: 12 }).filter((m) => m.scenario).map((m) => m.name);
  assert.deepEqual([...scenario].sort(), scenario);
  assert.equal(scenario[1], 'w02');
  assert.equal(scenario[11], 'w12');
});

test('minnow is the only role that wants to be under the floor', () => {
  const below = roster({ count: 60 }).filter((m) => !m.wantAboveFloor).map((m) => m.name);
  assert.deepEqual(below, ['minnow']);
});

test('sixty scenario wallets is the size the matrix actually needs', () => {
  // D1 wants 60 eligible in one epoch, to prove 12 airdrop transactions at
  // CLAIMS_PER_TX = 5.
  const scenario = roster({ count: 60 }).filter((m) => m.scenario);
  assert.equal(scenario.length, 60);
  assert.equal(Math.ceil(scenario.length / 5), 12);
});

test('--no-legacy builds scenario wallets alone', () => {
  const names = roster({ count: 2, noLegacy: true }).map((m) => m.name);
  assert.deepEqual(names, ['w01', 'w02']);
});

test('the scenario buy size is overridable and does not touch the named roles', () => {
  const all = roster({ count: 1, scenarioSol: 0.5 });
  assert.equal(all.find((m) => m.name === 'w01').sol, 0.5);
  assert.equal(all.find((m) => m.name === 'minnow').sol, 0.0015);
});

test('the roster hands out fresh objects, so a --sol override cannot leak between runs', () => {
  const first = roster({ count: 0 });
  first[0].sol = 99;
  assert.notEqual(roster({ count: 0 })[0].sol, 99);
});

// ── funding batches ────────────────────────────────────────────────────────

test('every member lands in exactly one batch', () => {
  const members = roster({ count: 60 });
  const batched = fundingBatches(members).flat();
  assert.equal(batched.length, members.length);
  assert.deepEqual(batched.map((m) => m.name), members.map((m) => m.name));
});

test('a partial final batch is kept, not dropped', () => {
  // 64 members at 15 per transaction is four full batches and a remainder of
  // four. Losing the remainder funds nobody and is invisible until the buy.
  const batches = fundingBatches(roster({ count: 60 }), 15);
  assert.equal(batches.length, 5);
  assert.equal(batches.at(-1).length, 4);
});

test('a roster smaller than one batch is a single batch', () => {
  assert.equal(fundingBatches(roster({ count: 0 }), 15).length, 1);
});

test('an empty roster produces no transactions at all', () => {
  assert.deepEqual(fundingBatches([], 15), []);
});

// ── resume ─────────────────────────────────────────────────────────────────

test('a wallet holding coin is done', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '500000000000' }], 'w01'), true);
});

test('a funded wallet whose buy failed is NOT done — that is the case resume is for', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '0' }], 'w01'), false);
  assert.equal(alreadyBuilt([{ name: 'w01' }], 'w01'), false);
});

test('a wallet the manifest has never heard of is not done', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '1' }], 'w02'), false);
  assert.equal(alreadyBuilt(undefined, 'w01'), false);
  assert.equal(alreadyBuilt([], 'w01'), false);
});

test('balances are compared as BigInt, not as Numbers', () => {
  // A raw balance well past 2^53. Read as a Number this still tests truthy, so
  // the bug would hide here and surface as a precision error somewhere else.
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '9007199254740993' }], 'w01'), true);
});

// ── the ordering rule that cost 5.03 SOL ───────────────────────────────────

test('gas covers a graduated buy, which pays for two ATAs and not one', () => {
  // 0.02 was sized for the bonding curve. The AMM path wraps SOL through its
  // own account as well as creating the token account, and exhausted it:
  // `Transfer: insufficient lamports 603240, need 2039280` (2026-08-08).
  const ATA_RENT = 0.00204;
  assert.ok(
    GAS_SOL >= 2 * ATA_RENT + 0.01,
    `gas is ${GAS_SOL}; it must cover two ATAs plus fee and slippage headroom`,
  );
});
