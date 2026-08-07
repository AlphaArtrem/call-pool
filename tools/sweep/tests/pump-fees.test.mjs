// The boundary: nothing pump's SDK builds may cross it.
//
// This package resolves its own nested `@solana/web3.js` — whatever the SDK
// pins — while the caller resolves the repository's. Two module instances, so
// `instanceof` fails between them and any object handed across would be
// interoperating by luck. Passing primitives is what makes the seam explicit,
// and it buys a property worth stating: **no object built by pump's SDK is ever
// signed.** `scripts/sweep.mjs` rebuilds every instruction from a base58 string
// and some bytes before it goes near a transaction.
//
// So these tests are about the shape of what comes back, not about pump.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { available } from '../pump-fees.mjs';

const require_ = createRequire(import.meta.url);

test('the SDK is installed HERE, and this is the package that may say so', () => {
  assert.equal(available(), true);
});

test('it loads through require, which is the only way it loads', () => {
  // F19: the transitive `@pump-fun/agent-payments-sdk` emits invalid ESM and
  // throws a SyntaxError under `import` on Node 22. If this starts failing, the
  // sweep is broken on every host — better to learn it here than at 3am.
  const sdk = require_('@pump-fun/pump-sdk');
  assert.equal(typeof sdk.OnlinePumpSdk, 'function');
  assert.equal(typeof sdk.OnlinePumpSdk.prototype.buildDistributeCreatorFeesInstructions, 'function');
  assert.equal(typeof sdk.OnlinePumpSdk.prototype.getMinimumDistributableFee, 'function');
});

test('this package really does resolve a DIFFERENT web3 than the repository', () => {
  // The premise of the whole primitive boundary. If npm ever hoists these into
  // one copy the boundary becomes belt-and-braces rather than load-bearing —
  // but it must not quietly become the reverse, so assert the premise rather
  // than assuming it.
  const nested = require_.resolve('@solana/web3.js');
  assert.match(nested, /tools\/sweep\/node_modules/);
});

test('what crosses the boundary is JSON, with no web3 objects in it', async () => {
  // Exercised against a hand-built instruction rather than a live RPC: the
  // property under test is the serialisation, and pump's servers are not.
  const { PublicKey, TransactionInstruction } = require_('@solana/web3.js');
  const { plainForTest } = await import('../pump-fees.mjs');

  const ix = new TransactionInstruction({
    programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    keys: [
      { pubkey: new PublicKey('So11111111111111111111111111111111111111112'), isSigner: true, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3, 255]),
  });

  const plain = plainForTest(ix);

  // Survives a round trip through JSON — the strongest available statement
  // that nothing structural came with it.
  assert.deepEqual(JSON.parse(JSON.stringify(plain)), plain);

  assert.equal(typeof plain.programId, 'string');
  assert.equal(plain.programId, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  assert.deepEqual(plain.keys, [
    { pubkey: 'So11111111111111111111111111111111111111112', isSigner: true, isWritable: false },
    { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: true },
  ]);
  assert.equal(plain.data, Buffer.from([1, 2, 3, 255]).toString('base64'));
});

test('both exported reads reach the SDK rather than throwing on the way there', async () => {
  // Regression: `online()` was written as `new sdk().OnlinePumpSdk(conn)`, which
  // parses as `(new sdk()).OnlinePumpSdk(conn)` — constructing the module
  // namespace and then calling the class as a function. Every offline test
  // passed; a live run reported "Class constructor OnlinePumpSdk cannot be
  // invoked without 'new'" as a pump fault, which is the wrong diagnosis
  // entirely.
  //
  // An unroutable URL is enough: the failure has to be a *network* failure, not
  // a construction one, and this asserts which.
  const { readDistributable, buildDistributeInstructions } = await import('../pump-fees.mjs');
  const dead = 'http://127.0.0.1:1';
  const mint = 'CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK';

  for (const call of [
    () => readDistributable(dead, mint),
    () => buildDistributeInstructions(dead, mint),
  ]) {
    await assert.rejects(call, (error) => {
      assert.doesNotMatch(error.message, /cannot be invoked without/i, error.message);
      assert.doesNotMatch(error.message, /is not a (function|constructor)/i, error.message);
      return true;
    });
  }
});

test('amounts cross as strings, because they exceed what a Number holds', async () => {
  // BN inside the SDK, BigInt in the caller. A Number in between silently loses
  // precision above 2^53 — and lamport figures reach that.
  const { amountForTest } = await import('../pump-fees.mjs');
  const big = '18446744073709551615'; // u64::MAX
  assert.equal(amountForTest({ toString: () => big }), big);
  assert.equal(BigInt(amountForTest({ toString: () => big })).toString(), big);
});
