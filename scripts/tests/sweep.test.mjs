// Step 0's two ways of being wrong.
//
// The sweep is not where money is stolen — every instruction in it is
// permissionless and every destination is fixed by something other than us. It
// is where money is *believed to have moved when it did not*, which is quieter
// and worse: an epoch that divides a pool it thinks grew allocates fees that
// are still sitting in pump's creator vault.
//
// So these tests are about the reporting, and about the instruction the crank
// has never had a way to send.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { describeDistributable, explainPumpFailure, instructionFrom, loadPumpFees } from '../sweep.mjs';
import { PROGRAM_ID, configPda, poolPda, poolWsolAta, sweepWsolIx } from '../lib/program.mjs';

// ── what the operator is told ──────────────────────────────────────────────

test('a below-minimum accrual is reported as pump\'s claim, and as one to be tried anyway', () => {
  const text = describeDistributable({
    minimumRequired: 1_880_747n,
    distributableFees: 400_000n,
    canDistribute: false,
  });
  assert.match(text, /pump reports NOT distributable/);
  assert.match(text, /Trying anyway/);
  // The reading must never be presented as a decision. Measured 2026-08-07: a
  // coin with 8,017,920 lamports accrued reported 0 against a minimum of 0 and
  // then distributed 5,204,484 when asked. Gating on this emptied no pool
  // loudly and every pool quietly.
  assert.match(text, /unreliable/);
});

test('the minimum and the accrual are both named, so the gap is readable', () => {
  const text = describeDistributable({
    minimumRequired: 1_880_747n,
    distributableFees: 400_000n,
    canDistribute: false,
  });
  assert.match(text, /0\.000400000 SOL/);
  assert.match(text, /0\.001880747 SOL/);
});

test('a distributable accrual says so, and says how much', () => {
  const text = describeDistributable({
    minimumRequired: 890_880n,
    distributableFees: 2_617_787n,
    canDistribute: true,
  });
  assert.match(text, /distributable now: 0\.002617787 SOL/);
});

// F4: pump's distribute succeeds and moves nothing below the minimum, and the
// SDK reports a *failed simulation* the same way it reports a small balance.
// Neither may ever be reported as money having arrived.
test('nothing distributable never reads as fees having arrived', () => {
  for (const fees of [0n, 1n, 400_000n]) {
    const text = describeDistributable({
      minimumRequired: 1_880_747n,
      distributableFees: fees,
      canDistribute: false,
    });
    assert.doesNotMatch(text, /distributable now/);
  }
});

// ── a missing sharing config is not a quiet day ─────────────────────────────

test('a missing sharing config is explained as a launch fault, not a small balance', () => {
  const text = explainPumpFailure('Sharing config not found for mint: So111…');
  assert.match(text, /NO fee-sharing config/);
  assert.match(text, /no fee can reach the pool/);
  // The recovery is the creator's, not ours, and naming it is the whole point.
  assert.match(text, /collect_creator_fee/);
});

test('any other pump failure is passed through unchanged rather than guessed at', () => {
  const raw = 'Transaction simulation failed: Blockhash not found';
  assert.equal(explainPumpFailure(raw), raw);
});

// ── sweep_wsol ─────────────────────────────────────────────────────────────

const CALLER = new PublicKey('4yoTWJ4Hdxy8kRiiA2CJ4netQGkDhvmnbvLeQS4CKYsn');

test('sweep_wsol names the accounts the program declares, in order', () => {
  const ix = sweepWsolIx({ caller: CALLER });
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    [
      CALLER.toBase58(),
      configPda().toBase58(),
      poolPda().toBase58(),
      NATIVE_MINT.toBase58(),
      poolWsolAta().toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    ],
  );
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
});

test('only the caller signs, and only the caller, pool and ATA are writable', () => {
  const ix = sweepWsolIx({ caller: CALLER });
  assert.deepEqual(
    ix.keys.map((k) => k.isSigner),
    [true, false, false, false, false, false, false],
  );
  assert.deepEqual(
    ix.keys.map((k) => k.isWritable),
    [true, false, true, false, true, false, false],
  );
});

test('sweep_wsol carries the anchor discriminator and no arguments', () => {
  // Eight bytes and nothing else: the instruction takes no parameters, because
  // every address it touches is derived. Anything it *could* be told is
  // something it could be told wrongly.
  assert.equal(sweepWsolIx({ caller: CALLER }).data.length, 8);
});

test('the pool wSOL ATA is derived off-curve — the pool is a PDA', () => {
  // getAssociatedTokenAddressSync throws on an off-curve owner unless asked
  // not to, so this passing at all is the assertion.
  assert.ok(poolWsolAta() instanceof PublicKey);
  assert.notEqual(poolWsolAta().toBase58(), poolPda().toBase58());
});

// ── the boundary with tools/sweep ──────────────────────────────────────────
//
// pump's SDK is NOT a dependency of this repository — it lives in
// `tools/sweep/`, with its own package.json and lockfile, because the root
// lockfile pins the scripts that sign with the snapshot key. So nothing here
// imports it, and what is tested instead is the seam: that instructions are
// rebuilt from primitives, and that a missing package says so in a sentence.

test('an instruction is rebuilt from base58 and bytes, not carried across as an object', () => {
  // The property this buys: no object pump's SDK constructed is ever signed.
  // `tools/sweep` resolves its own nested web3.js, so anything handed across
  // structurally would be interoperating between two module instances by luck.
  const plain = {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    keys: [
      { pubkey: 'So11111111111111111111111111111111111111112', isSigner: true, isWritable: false },
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3, 255]).toString('base64'),
  };

  const ix = instructionFrom(plain);

  // Built with THIS repository's web3, which is what makes the instanceof true.
  assert.ok(ix instanceof TransactionInstruction);
  assert.ok(ix.programId instanceof PublicKey);
  assert.ok(ix.keys.every((k) => k.pubkey instanceof PublicKey));

  assert.equal(ix.programId.toBase58(), plain.programId);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), plain.keys.map((k) => k.pubkey));
  assert.deepEqual(ix.keys.map((k) => k.isSigner), [true, false]);
  assert.deepEqual(ix.keys.map((k) => k.isWritable), [false, true]);
  assert.ok(Buffer.from(ix.data).equals(Buffer.from([1, 2, 3, 255])));
});

test('rebuilding preserves every account flag exactly — a flipped one is a different instruction', () => {
  for (const [isSigner, isWritable] of [[true, true], [true, false], [false, true], [false, false]]) {
    const ix = instructionFrom({
      programId: '11111111111111111111111111111111',
      keys: [{ pubkey: 'So11111111111111111111111111111111111111112', isSigner, isWritable }],
      data: '',
    });
    assert.equal(ix.keys[0].isSigner, isSigner);
    assert.equal(ix.keys[0].isWritable, isWritable);
  }
});

test('a missing tools/sweep is a sentence naming the fix, not a MODULE_NOT_FOUND stack', async () => {
  await assert.rejects(
    () => loadPumpFees('./definitely-not-installed-anywhere.mjs'),
    /separate package on purpose.*cd tools\/sweep && npm ci/s,
  );
});

test('nothing in the main tree depends on pump\'s SDK', async () => {
  // The constraint itself, asserted rather than trusted to review. The root
  // lockfile pins `post-root.mjs` and `cosign.mjs`, which hold the snapshot key
  // and sign with it; anchor, pump-swap-sdk and agent-payments-sdk have no
  // business in that surface, on any host that runs `npm ci`.
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  assert.deepEqual(named.filter((n) => /pump|anchor/i.test(n)), []);

  const lock = readFileSync(resolve(root, 'package-lock.json'), 'utf8');
  assert.doesNotMatch(lock, /pump-fun|coral-xyz/);
});
