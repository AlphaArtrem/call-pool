// The co-signer's refusals.
//
// A 2-of-3 whose second signer approves whatever it is handed is a 1-of-3
// wearing a costume: own host 1, propose a root that pays you, and host 2
// rubber-stamps it. The only thing standing between those two sentences is
// `sameInstruction` — signer B approves a proposal *only* when its bytes are
// the bytes B derived itself from the published snapshot.
//
// So these tests are about the comparison being strict, not about it being
// correct on the happy path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Keypair, PublicKey } from '@solana/web3.js';

import { publishedRoot, sameInstruction } from '../cosign.mjs';
import { postEpochRootIx } from '../lib/program.mjs';

const VAULT = new PublicKey('4yoTWJ4Hdxy8kRiiA2CJ4netQGkDhvmnbvLeQS4CKYsn');
const MINT = new PublicKey('CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK').toBase58();
const ROOT = Buffer.alloc(32, 7);

const ix = (overrides = {}) =>
  postEpochRootIx({
    snapshotKey: VAULT,
    mint: MINT,
    epoch: 1,
    root: ROOT,
    leafCount: 3,
    allocate: 2_499_104_119n,
    ...overrides,
  });

test('an instruction matches itself', () => {
  assert.equal(sameInstruction(ix(), ix()), true);
});

test('one flipped byte in the root is not a match', () => {
  const tampered = Buffer.from(ROOT);
  tampered[31] ^= 0x01;
  assert.equal(sameInstruction(ix(), ix({ root: tampered })), false);
});

test('a different allocation is not a match — this is the one that steals money', () => {
  assert.equal(sameInstruction(ix(), ix({ allocate: 2_499_104_120n })), false);
  assert.equal(sameInstruction(ix(), ix({ allocate: 1n })), false);
});

test('a different epoch is not a match', () => {
  assert.equal(sameInstruction(ix(), ix({ epoch: 2 })), false);
});

test('a different leaf count is not a match', () => {
  assert.equal(sameInstruction(ix(), ix({ leafCount: 4 })), false);
});

test('a different mint is not a match, even with everything else identical', () => {
  // Same root, same allocation, different coin — the epoch PDA moves, so this
  // would post our root against somebody else's history.
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(sameInstruction(ix(), ix({ mint: other })), false);
});

test('a different program id is not a match', () => {
  const mine = ix();
  const impostor = { ...ix(), programId: Keypair.generate().publicKey };
  assert.equal(sameInstruction(mine, impostor), false);
});

test('swapping an account is not a match', () => {
  const mine = ix();
  const swapped = {
    ...mine,
    keys: mine.keys.map((k, i) => (i === 0 ? { ...k, pubkey: Keypair.generate().publicKey } : k)),
  };
  assert.equal(sameInstruction(mine, swapped), false);
});

test('flipping an account flag is not a match', () => {
  // Same accounts in the same order, but one no longer signs. The comparison
  // has to cover the metadata, not just the keys.
  const mine = ix();
  const relaxed = {
    ...mine,
    keys: mine.keys.map((k, i) => (i === 0 ? { ...k, isSigner: false } : k)),
  };
  assert.equal(sameInstruction(mine, relaxed), false);

  const widened = {
    ...mine,
    keys: mine.keys.map((k, i) => (i === 2 ? { ...k, isWritable: true } : k)),
  };
  assert.equal(sameInstruction(mine, widened), false);
});

test('a truncated instruction is not a match', () => {
  const mine = ix();
  assert.equal(sameInstruction(mine, { ...mine, data: mine.data.subarray(0, 8) }), false);
  assert.equal(sameInstruction(mine, { ...mine, keys: mine.keys.slice(0, 2) }), false);
});

// ── what the signer derives from ───────────────────────────────────────────

test('the root is read from the published snapshot, not from an argument', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  writeFileSync(
    resolve(dir, 'root.txt'),
    'root=0d1b5a09cfe76986d93f704bb9f2b5ea3341847e72210abf70441fc4ea395d01\n' +
      'leaf_count=3\nallocate=2499104119\nposted_signature=\n',
  );

  const parsed = publishedRoot(dir);
  assert.equal(
    parsed.root.toString('hex'),
    '0d1b5a09cfe76986d93f704bb9f2b5ea3341847e72210abf70441fc4ea395d01',
  );
  assert.equal(parsed.leafCount, 3);
  assert.equal(parsed.allocate, 2_499_104_119n);
});

test('a root.txt missing a field is refused rather than defaulted', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'callpool-'));
  writeFileSync(resolve(dir, 'root.txt'), 'root=abcd\n');
  assert.throws(() => publishedRoot(dir), /leaf_count/);
});

// ── the proposal-index collision, diagnosed 2026-08-08 ─────────────────────

test('every name Squads gives a taken transaction index counts as a lost race', () => {
  // Two members propose on their own timers, so losing the race is ordinary
  // and recoverable — re-scan and approve what is there. The recovery is
  // gated on this regex, and for two rehearsals it did not match the name
  // that actually came back.
  //
  // When the transaction PDA for an index already exists, Squads fails with a
  // bare `custom program error` that the client maps through the WRONG error
  // table: it surfaces as `TokenLendingError#AlreadyInitialized`, naming a
  // program not in the transaction. The crank exited "no root was posted" on
  // every epoch, and the cause was filed as undiagnosed.
  const RACED = /ConstraintSeeds|already in use|InvalidTransactionIndex|AlreadyInitialized|already initialized/i;

  for (const message of [
    'AnchorError#ConstraintSeeds',
    'Allocate: account Address { .. } already in use',
    'InvalidTransactionIndex',
    'TokenLendingError#AlreadyInitialized: Account is already initialized',
    'Account is already initialized',
  ]) {
    assert.ok(RACED.test(message), `must be treated as a lost race: ${message}`);
  }

  // And the cases that must still be raised rather than swallowed.
  for (const message of [
    'insufficient lamports',
    'Blockhash not found',
    'the snapshot is not internally consistent',
  ]) {
    assert.ok(!RACED.test(message), `must NOT be swallowed as a race: ${message}`);
  }
});
