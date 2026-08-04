// The JS side of the program interface, checked against the generated IDL.
//
// scripts/lib/program.mjs hand-encodes Anchor's instruction format so that a
// stranger reproducing an epoch needs only web3.js. The cost of hand-encoding
// is drift, so every discriminator, argument order, account order and account
// layout here is derived from `target/idl/callpool.json` rather than restated —
// if the program changes shape, these fail rather than silently building a
// malformed transaction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
  claimIx,
  configPda,
  decodeConfig,
  decodeEpoch,
  epochIndexFor,
  epochPda,
  isClaimed,
  poolPda,
  postEpochRootIx,
  PROGRAM_ID,
} from '../lib/program.mjs';

const IDL_PATH = resolve(import.meta.dirname, '../../target/idl/callpool.json');
let IDL;
try {
  IDL = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
} catch {
  IDL = null;
}

const ix = (name) => IDL.instructions.find((i) => i.name === name);
const acc = (name) => IDL.accounts.find((a) => a.name === name);
const type = (name) => IDL.types.find((t) => t.name === name);

// Every test needs the IDL. Skipping loudly beats passing vacuously.
const requireIdl = () => {
  assert.ok(IDL, `no IDL at ${IDL_PATH} — run ./scripts/verify.sh first`);
};

test('the IDL still exposes exactly the six instructions this client knows', () => {
  requireIdl();
  assert.deepEqual(
    IDL.instructions.map((i) => i.name).sort(),
    ['claim', 'close_epoch', 'create_pool', 'initialize', 'post_epoch_root', 'sweep_wsol'],
  );
});

test('discriminators match Anchor\'s sha256 namespacing', () => {
  requireIdl();
  for (const instruction of IDL.instructions) {
    const computed = createHash('sha256')
      .update(`global:${instruction.name}`)
      .digest()
      .subarray(0, 8);
    assert.deepEqual([...computed], instruction.discriminator, instruction.name);
  }
  for (const account of IDL.accounts) {
    const computed = createHash('sha256')
      .update(`account:${account.name}`)
      .digest()
      .subarray(0, 8);
    assert.deepEqual([...computed], account.discriminator, account.name);
  }
});

test('post_epoch_root encodes the IDL\'s arguments in the IDL\'s order', () => {
  requireIdl();
  const idl = ix('post_epoch_root');
  assert.deepEqual(
    idl.args.map((a) => a.name),
    ['epoch', 'root', 'leaf_count', 'allocate'],
  );

  const mint = Keypair.generate().publicKey;
  const built = postEpochRootIx({
    snapshotKey: Keypair.generate().publicKey,
    mint,
    epoch: 7,
    root: Buffer.alloc(32, 0xab),
    leafCount: 3,
    allocate: 1_234_567n,
  });

  assert.deepEqual([...built.data.subarray(0, 8)], idl.discriminator);
  assert.equal(built.data.readBigUInt64LE(8), 7n);
  assert.ok(built.data.subarray(16, 48).every((b) => b === 0xab));
  assert.equal(built.data.readUInt32LE(48), 3);
  assert.equal(built.data.readBigUInt64LE(52), 1_234_567n);
  assert.equal(built.data.length, 60);
});

test('claim encodes a Borsh vec of 32-byte proof nodes', () => {
  requireIdl();
  const idl = ix('claim');
  assert.deepEqual(idl.args.map((a) => a.name), ['epoch', 'index', 'amount', 'proof']);

  const proof = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const built = claimIx({
    submitter: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    recipientTokenAccount: Keypair.generate().publicKey,
    epoch: 12,
    index: 5,
    amount: 900n,
    proof,
  });

  assert.deepEqual([...built.data.subarray(0, 8)], idl.discriminator);
  assert.equal(built.data.readBigUInt64LE(8), 12n);
  assert.equal(built.data.readUInt32LE(16), 5);
  assert.equal(built.data.readBigUInt64LE(20), 900n);
  assert.equal(built.data.readUInt32LE(28), 2, 'vec length prefix');
  assert.equal(built.data.length, 32 + 2 * 32);
});

test('an empty proof is encoded as a zero-length vec, not omitted', () => {
  // A single-leaf tree has an empty proof: the leaf is the root. Dropping the
  // length prefix would make the instruction undecodable.
  const built = claimIx({
    submitter: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    recipientTokenAccount: Keypair.generate().publicKey,
    epoch: 0,
    index: 0,
    amount: 1n,
    proof: [],
  });
  assert.equal(built.data.readUInt32LE(28), 0);
  assert.equal(built.data.length, 32);
});

test('account metas match the IDL\'s account order and signer flags', () => {
  requireIdl();
  const mint = Keypair.generate().publicKey;

  const post = postEpochRootIx({
    snapshotKey: Keypair.generate().publicKey,
    mint,
    epoch: 1,
    root: Buffer.alloc(32),
    leafCount: 0,
    allocate: 0n,
  });
  assert.equal(post.keys.length, ix('post_epoch_root').accounts.length);
  assert.deepEqual(
    post.keys.map((k) => k.isSigner),
    [true, false, false, false, false],
    'only the snapshot key signs',
  );

  const claim = claimIx({
    submitter: Keypair.generate().publicKey,
    mint,
    recipient: Keypair.generate().publicKey,
    recipientTokenAccount: Keypair.generate().publicKey,
    epoch: 1,
    index: 0,
    amount: 1n,
    proof: [],
  });
  assert.equal(claim.keys.length, ix('claim').accounts.length);
  assert.deepEqual(
    claim.keys.map((k) => k.isSigner),
    [true, false, false, false, false, false, false, false, false],
    'the recipient must NOT be a signer — that is what makes the airdrop work (L8)',
  );
});

test('the pool PDA is seeded on a constant, so it exists before the coin', () => {
  const mint = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  // Derivable with no knowledge of the mint at all — which is the whole reason
  // it can be pasted into pump.fun's creator-rewards dialog at creation time.
  assert.equal(poolPda().toBase58(), poolPda().toBase58());
  assert.notEqual(poolPda().toBase58(), configPda().toBase58());
  assert.notEqual(epochPda(mint, 0).toBase58(), epochPda(other, 0).toBase58());
  assert.notEqual(epochPda(mint, 0).toBase58(), epochPda(mint, 1).toBase58());
});

test('decodeConfig reads every field at the offset the IDL declares', () => {
  requireIdl();
  const fields = type('Config').type.fields.map((f) => f.name);
  assert.deepEqual(fields, [
    'mint',
    'genesis_ts',
    'epoch_seconds',
    'min_hold',
    'challenge_seconds',
    'snapshot_key',
    'outstanding',
    'bump',
    'pool_bump',
  ]);

  const mint = Keypair.generate().publicKey;
  const snapshotKey = Keypair.generate().publicKey;
  const data = Buffer.alloc(106);
  Buffer.from(acc('Config').discriminator).copy(data, 0);
  mint.toBuffer().copy(data, 8);
  data.writeBigInt64LE(1_785_801_600n, 40);
  data.writeUInt32LE(86_400, 48);
  data.writeBigUInt64LE(100_000_000_000n, 52);
  data.writeUInt32LE(86_400, 60);
  snapshotKey.toBuffer().copy(data, 64);
  data.writeBigUInt64LE(7_777n, 96);
  data[104] = 254;
  data[105] = 253;

  const config = decodeConfig(data);
  assert.equal(config.mint.toBase58(), mint.toBase58());
  assert.equal(config.genesisTs, 1_785_801_600);
  assert.equal(config.epochSeconds, 86_400);
  assert.equal(config.minHold, 100_000_000_000n);
  assert.equal(config.challengeSeconds, 86_400);
  assert.equal(config.snapshotKey.toBase58(), snapshotKey.toBase58());
  assert.equal(config.outstanding, 7_777n);
  assert.equal(config.bump, 254);
  assert.equal(config.poolBump, 253);
});

test('decodeConfig refuses an account of the wrong type', () => {
  const data = Buffer.alloc(106);
  assert.throws(() => decodeConfig(data), /not a Config/);
});

test('decodeEpoch reads the bitmap and its length prefix', () => {
  requireIdl();
  const data = Buffer.alloc(81 + 2);
  Buffer.from(acc('Epoch').discriminator).copy(data, 0);
  data.writeBigUInt64LE(9n, 8);
  Buffer.alloc(32, 0x5a).copy(data, 16);
  data.writeBigUInt64LE(500n, 48);
  data.writeBigUInt64LE(200n, 56);
  data.writeBigInt64LE(1_785_888_000n, 64);
  data.writeUInt32LE(12, 72);
  data[76] = 1;
  data.writeUInt32LE(2, 77);
  data[81] = 0b0000_0101;
  data[82] = 0b1000_0000;

  const epoch = decodeEpoch(data);
  assert.equal(epoch.index, 9);
  assert.equal(epoch.root.toString('hex'), '5a'.repeat(32));
  assert.equal(epoch.poolLamports, 500n);
  assert.equal(epoch.claimedLamports, 200n);
  assert.equal(epoch.postedTs, 1_785_888_000);
  assert.equal(epoch.leafCount, 12);
  assert.equal(epoch.closed, true);
  assert.equal(epoch.claimedBits.length, 2);

  assert.equal(isClaimed(epoch, 0), true);
  assert.equal(isClaimed(epoch, 1), false);
  assert.equal(isClaimed(epoch, 2), true);
  assert.equal(isClaimed(epoch, 15), true);
  assert.equal(isClaimed(epoch, 14), false);
  assert.equal(isClaimed(epoch, 99), false, 'out of range reads as unclaimed');
});

test('epochIndexFor maps a UTC day onto the on-chain index, or refuses', () => {
  const config = { genesisTs: 1_785_801_600, epochSeconds: 86_400 };
  assert.equal(epochIndexFor(1_785_801_600, config), 0);
  assert.equal(epochIndexFor(1_785_801_600 + 86_400, config), 1);
  assert.equal(epochIndexFor(1_785_801_600 + 10 * 86_400, config), 10);

  // A genesis that is not a UTC midnight would put every epoch boundary at an
  // arbitrary time of day. The program refuses to write one; this refuses to
  // paper over one if it somehow exists.
  assert.throws(() => epochIndexFor(1_785_801_600 + 3_600, config), /not an epoch boundary/);
  assert.throws(() => epochIndexFor(1_785_801_600 - 86_400, config), /not an epoch boundary/);
});

test('the program id round-trips as a real address', () => {
  assert.equal(new PublicKey(PROGRAM_ID.toBase58()).toBase58(), PROGRAM_ID.toBase58());
  if (IDL) assert.equal(PROGRAM_ID.toBase58(), IDL.address, 'client and IDL disagree on the program id');
});
