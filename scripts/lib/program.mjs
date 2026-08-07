// Talking to the CALLPOOL program from JavaScript, with no Anchor client.
//
// Anchor's instruction and account encodings are simple and stable: an
// 8-byte discriminator followed by Borsh. Writing them out here rather than
// depending on `@coral-xyz/anchor` keeps the promise in Phase 05 §5.3 — that
// `build.mjs` is **runnable by a stranger with no keys**, reading only the
// files beside it. `web3.js` and this file are the whole toolchain.
//
// If the program's instruction set ever changes, `scripts/verify.sh` fails
// first: it asserts the IDL still exposes exactly the six names below.

import { createHash } from 'node:crypto';

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/** Set at deployment. Matches `declare_id!` and `Anchor.toml`. */
export const PROGRAM_ID = new PublicKey(
  process.env.CALLPOOL_PROGRAM_ID ?? 'ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7',
);

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

const CONFIG_SEED = Buffer.from('config');
const POOL_SEED = Buffer.from('pool');
const EPOCH_SEED = Buffer.from('epoch');

/** Anchor's discriminator: the first 8 bytes of sha256 over a namespaced name. */
function discriminator(namespace, name) {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// ── addresses ──────────────────────────────────────────────────────────────

export function configPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

/**
 * The pool. Seeded on a **constant, not on the mint**, so the address exists
 * before the coin does and can be pasted into pump.fun's creator-rewards
 * dialog at creation time (Phase 04 §4.2).
 */
export function poolPda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([POOL_SEED], programId)[0];
}

/**
 * The pool's wrapped-SOL ATA — where post-graduation creator fees land.
 *
 * `allowOwnerOffCurve` is true and has to be: the pool is a PDA, so it is off
 * the ed25519 curve by construction and the default would refuse to derive it.
 */
export function poolWsolAta(programId = PROGRAM_ID) {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    poolPda(programId),
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
  );
}

/**
 * `(mint, epoch, programId)` — the same order as the site's `addresses.js`,
 * which is the only other place this is derived. Both arguments accept a base58
 * string or a `PublicKey`, so the two are genuinely interchangeable: an
 * asymmetry there is the same class of trap as a differing argument order, just
 * one that happens to raise instead of deriving a plausible wrong address.
 */
export function epochPda(mint, epoch, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [EPOCH_SEED, new PublicKey(mint).toBuffer(), u64le(epoch)],
    new PublicKey(programId),
  )[0];
}

/** Which epoch index a UTC day is, given the on-chain genesis. */
export function epochIndexFor(windowStart, config) {
  const elapsed = windowStart - config.genesisTs;
  if (elapsed < 0 || elapsed % config.epochSeconds !== 0) {
    throw new Error(
      `window start ${windowStart} is not an epoch boundary for genesis ` +
        `${config.genesisTs} / ${config.epochSeconds}s — the on-chain index and the ` +
        'UTC day have diverged, which must never happen',
    );
  }
  return elapsed / config.epochSeconds;
}

/** The window for an on-chain epoch index. The chain's clock, not a calendar. */
export function windowForEpoch(config, epoch) {
  const start = config.genesisTs + epoch * config.epochSeconds;
  return { epoch, start, end: start + config.epochSeconds };
}

// ── instructions ───────────────────────────────────────────────────────────

/**
 * `create_pool` — permissionless, once.
 *
 * Run before the coin exists, so the pool address can be pasted into
 * pump.fun's creator-rewards dialog. Anyone may send this; the address is
 * identical either way and, with `INITIALIZER` a compile-time constant,
 * front-running it buys nothing.
 */
export function createPoolIx({ payer, programId = PROGRAM_ID }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: poolPda(programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator('global', 'create_pool'),
  });
}

/**
 * `initialize` — once, by the compile-time `INITIALIZER`.
 *
 * **Every argument is immutable afterwards.** There is no `set_params`, no
 * `set_snapshot_key`, no pause and no withdraw. Read Phase 08's checklist
 * before building this transaction, not after.
 *
 * `minHold` is in **raw units**: at 6 decimals the floor is
 * `100_000 × 10^6 = 100_000_000_000`, and writing the whole-token figure would
 * set it to a tenth of a token, silently and forever.
 */
export function initializeIx({
  payer,
  mint,
  genesisTs,
  epochSeconds,
  minHold,
  challengeSeconds,
  snapshotKey,
  programId = PROGRAM_ID,
}) {
  const genesis = Buffer.alloc(8);
  genesis.writeBigInt64LE(BigInt(genesisTs));

  const data = Buffer.concat([
    discriminator('global', 'initialize'),
    genesis,
    u32le(epochSeconds),
    u64le(minHold),
    u32le(challengeSeconds),
    new PublicKey(snapshotKey).toBuffer(),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: poolPda(programId), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * `post_epoch_root` — the only instruction that needs a key.
 *
 * `allocate` is capped on chain at what the pool can actually back, so this
 * cannot ask for more than exists. It exists so carry-forward is exact:
 * allocating only what the tree pays leaves the dust free in the pool for
 * tomorrow, rather than locked as `outstanding` until `close_epoch`.
 */
export function postEpochRootIx({
  snapshotKey,
  mint,
  epoch,
  root,
  leafCount,
  allocate,
  programId = PROGRAM_ID,
}) {
  if (root.length !== 32) throw new Error('root must be 32 bytes');
  const data = Buffer.concat([
    discriminator('global', 'post_epoch_root'),
    u64le(epoch),
    Buffer.from(root),
    u32le(leafCount),
    u64le(allocate),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(snapshotKey), isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: poolPda(programId), isSigner: false, isWritable: false },
      { pubkey: epochPda(mint, epoch, programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * `claim` — takes **no signature from the recipient**.
 *
 * The payee is fixed inside the merkle leaf, so submitting this cannot
 * redirect the money. That is what makes the daily airdrop safe (L8): the bot
 * is a submitter, not an authority, and anyone — including a holder tired of
 * waiting — can run the same instruction from the published proof.
 */
export function claimIx({
  submitter,
  mint,
  recipient,
  recipientTokenAccount,
  epoch,
  index,
  amount,
  proof,
  tokenProgram = TOKEN_PROGRAM_ID,
  programId = PROGRAM_ID,
}) {
  const data = Buffer.concat([
    discriminator('global', 'claim'),
    u64le(epoch),
    u32le(index),
    u64le(amount),
    u32le(proof.length), // Borsh Vec length prefix
    ...proof.map((node) => Buffer.from(node)),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(submitter), isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: poolPda(programId), isSigner: false, isWritable: true },
      { pubkey: epochPda(mint, epoch, programId), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(recipient), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(recipientTokenAccount), isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * `sweep_wsol` — permissionless, and the other half of step 0.
 *
 * Post-graduation the coin's creator fees can arrive as **wrapped SOL** in an
 * ATA owned by the pool, and wSOL cannot be unwrapped in place: the only route
 * back to lamports is `close_account`, signed by the ATA's owner (Phase 03
 * §3.4a). The pool is that owner, so the program closes it into itself.
 *
 * `caller` pays gas and controls nothing — the destination is the pool, fixed
 * by the account constraints, so submitting this cannot redirect a lamport.
 * Same property that makes the airdrop safe to run from anywhere.
 *
 * The ATA does not survive the close, and this instruction cannot recreate it
 * (the System Program will not fund an account out of one it does not own).
 * Recreating it is the crank's job — D5 — and `sweep.mjs` does it in the same
 * transaction.
 */
export function sweepWsolIx({ caller, programId = PROGRAM_ID }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(caller), isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: poolPda(programId), isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: poolWsolAta(programId), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: discriminator('global', 'sweep_wsol'),
  });
}

// ── accounts ───────────────────────────────────────────────────────────────

function expectDiscriminator(data, name) {
  const expected = discriminator('account', name);
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error(`account is not a ${name}`);
  }
}

export function decodeConfig(data) {
  expectDiscriminator(data, 'Config');
  // Borsh, in declaration order. Offsets written out rather than accumulated,
  // because a decoder that silently reads one field late is exactly the kind
  // of bug that produces a plausible wrong number.
  return {
    mint: new PublicKey(data.subarray(8, 40)),
    genesisTs: Number(data.readBigInt64LE(40)),
    epochSeconds: data.readUInt32LE(48),
    minHold: data.readBigUInt64LE(52),
    challengeSeconds: data.readUInt32LE(60),
    snapshotKey: new PublicKey(data.subarray(64, 96)),
    outstanding: data.readBigUInt64LE(96),
    bump: data[104],
    poolBump: data[105],
  };
}

export function decodeEpoch(data) {
  expectDiscriminator(data, 'Epoch');
  let o = 8;
  const index = data.readBigUInt64LE(o);
  o += 8;
  const root = Buffer.from(data.subarray(o, o + 32));
  o += 32;
  const poolLamports = data.readBigUInt64LE(o);
  o += 8;
  const claimedLamports = data.readBigUInt64LE(o);
  o += 8;
  const postedTs = Number(data.readBigInt64LE(o));
  o += 8;
  const leafCount = data.readUInt32LE(o);
  o += 4;
  const closed = data[o] === 1;
  o += 1;
  const bitsLen = data.readUInt32LE(o);
  o += 4;
  const claimedBits = Buffer.from(data.subarray(o, o + bitsLen));

  return {
    index: Number(index),
    root,
    poolLamports,
    claimedLamports,
    postedTs,
    leafCount,
    closed,
    claimedBits,
  };
}

/** Has leaf `index` already been paid? Mirrors the program's bitmap read. */
export function isClaimed(epochAccount, index) {
  const byte = epochAccount.claimedBits[Math.floor(index / 8)];
  return byte === undefined ? false : (byte & (1 << index % 8)) !== 0;
}

// ── reads ──────────────────────────────────────────────────────────────────

export async function fetchConfig(connection, programId = PROGRAM_ID) {
  const info = await connection.getAccountInfo(configPda(programId));
  if (!info) throw new Error('the program is not initialized — no config account');
  return decodeConfig(info.data);
}

export async function fetchEpoch(connection, mint, epoch, programId = PROGRAM_ID) {
  const info = await connection.getAccountInfo(epochPda(mint, epoch, programId));
  return info ? decodeEpoch(info.data) : null;
}

/**
 * What the program itself will compute as allocatable, at this moment.
 *
 * Deliberately the same arithmetic as `post_epoch_root`: pool balance, minus
 * the pool's own rent, minus what open epochs already owe. Computing it here
 * the same way is what lets the crank ask for exactly what will be accepted
 * rather than discovering the cap by having a transaction rejected.
 */
export async function poolAvailable(connection, config, programId = PROGRAM_ID) {
  const pool = poolPda(programId);
  const lamports = BigInt(await connection.getBalance(pool));
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const available = lamports - rent - config.outstanding;
  return { lamports, rent, outstanding: config.outstanding, available: available > 0n ? available : 0n };
}
