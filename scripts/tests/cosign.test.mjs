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

import { assertCanPropose, PROPOSE_MIN_LAMPORTS, publishedRoot, sameInstruction } from '../cosign.mjs';
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

// --- the member's own balance ----------------------------------------------
//
// 2026-08-09: signer A held 0.0027 SOL, and the create failed with "Account is
// already initialized" — the System program's insufficient-lamports error read
// through the wrong error table. Every message pointed at the multisig; the
// fault was an empty wallet. A balance cannot be misread that way.

test('a member that cannot pay for the proposal is stopped before it proposes', async () => {
  const connection = { getBalance: async () => 2_653_720 };

  await assert.rejects(
    () => assertCanPropose(connection, PublicKey.default),
    /holds 0\.002653720 SOL.*not enough to create a proposal/s,
  );
});

test('the refusal says the rent is the member’s, not the vault’s', async () => {
  const connection = { getBalance: async () => 0 };

  await assert.rejects(
    () => assertCanPropose(connection, PublicKey.default),
    /rent this member pays, not a fee the vault pays/,
  );
});

test('a funded member proposes, and gets its balance back', async () => {
  const connection = { getBalance: async () => 500_000_000 };

  assert.equal(await assertCanPropose(connection, PublicKey.default), 500_000_000n);
});

test('the threshold is inclusive — exactly the minimum is enough', async () => {
  const connection = { getBalance: async () => Number(PROPOSE_MIN_LAMPORTS) };

  assert.equal(await assertCanPropose(connection, PublicKey.default), PROPOSE_MIN_LAMPORTS);
});

// ── only the crank host proposes (2026-08-09, run 5) ───────────────────────
//
// Both members run the same command on their own timers, and both could
// create. On run 5's epoch 0 both did: signer A created index 83, and signer B
// — scanning a moment too early to see it — created 84. Two proposals for the
// **same root**, one signature each, neither ever reaching 2-of-2.
//
// The deadlock is silent. Every host logs `approved 1/2` and looks exactly like
// a host waiting patiently for the other one.
//
// The race is not worth winning: the second signer has no business proposing at
// all. Its job is to check that a root follows from the crank's published
// inputs and approve it, so if there is nothing to approve the answer is to
// wait for the next tick.

test('--approve-only is passed straight through to cosign', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const remote = readFileSync(resolve(REPO_ROOT, 'scripts/tools/cosign-remote.mjs'), 'utf8');

  assert.match(remote, /--approve-only/, 'the remote wrapper must forward the flag');
});

test('every co-signer unit runs approve-only, on devnet and on mainnet', async () => {
  // The crank host is the sole proposer everywhere. A unit that omits this is
  // one timer away from re-creating the deadlock.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');

  for (const unit of [
    'deploy/devnet/one_hour/callpool-cosign.service',
    'deploy/devnet/two_hour/callpool-cosign.service',
    'deploy/mainnet/callpool-cosign.service',
  ]) {
    const source = readFileSync(resolve(REPO_ROOT, unit), 'utf8');
    assert.match(source, /--approve-only/, `${unit} must not let the second signer propose`);
  }
});

test('the crank host is NOT approve-only, or nothing would ever be proposed', async () => {
  // The mirror of the rule above, and the way to get it exactly wrong.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');

  for (const unit of [
    'deploy/devnet/one_hour/callpool-crank.service',
    'deploy/devnet/two_hour/callpool-crank.service',
    'deploy/mainnet/callpool-crank.service',
  ]) {
    const source = readFileSync(resolve(REPO_ROOT, unit), 'utf8');
    assert.doesNotMatch(source, /--approve-only/, `${unit} proposes; it must not be approve-only`);
  }
});

// ── --trust-proposer: devnet only, and the reason is the product claim ─────
//
// Skipping the re-derivation is the whole of the second signer's value. A
// member that signs without reproducing is not a check — it is a second key
// held by the same decision. The 2-of-3 still stops a stolen key from moving
// the pool; it stops nothing about a WRONG root.
//
// It exists because `--recheck-chain` over sixty wallets takes ~60 seconds,
// which on a ten-minute devnet epoch is most of the window the crank spends
// waiting. On a rehearsal that trade is reasonable. On mainnet the site tells
// holders two independent parties check every root, and L15's custody argument
// rests on the same claim.

test('mainnet trusts the proposer too — L23, and it is announced', async () => {
  // Ruled by the owner on 2026-08-09. The second member stops being a second
  // opinion and becomes a second key: the 2-of-3 still stops one stolen key
  // from moving the pool, and no longer stops a wrong root.
  //
  // This test asserted the exact opposite until L23. It is inverted rather than
  // deleted so the change of position stays legible.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const unit = readFileSync(resolve(REPO_ROOT, 'deploy/mainnet/callpool-cosign.service'), 'utf8');

  assert.match(unit, /--trust-proposer/);
  // The one input that cannot be re-derived from chain at all is worth MORE now
  // that the arithmetic is only checked once.
  assert.match(unit, /--callout-store/, 'corroboration matters more, not less, after L23');
});

test('a mainnet run says out loud that it is not reproducing', async () => {
  // A quiet degradation is the kind nobody remembers making.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/cosign.mjs'), 'utf8');

  const guard = source.slice(source.indexOf('if (args.trustProposer)'));
  assert.match(guard.slice(0, 900), /MAINNET_GENESIS_HASH/, 'mainnet must be detected, not assumed');
  assert.match(guard.slice(0, 900), /MAINNET, and this signer is NOT reproducing/);
});

test('skipping the reproduction is announced, not silent', async () => {
  // Whoever reads the log during an incident has to be able to tell that this
  // signature means less than the last one did.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/cosign.mjs'), 'utf8');

  assert.match(source, /NOT reproduced before signing/);
  assert.match(source, /second key, not a second opinion/);
});
