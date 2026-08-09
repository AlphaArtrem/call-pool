#!/usr/bin/env node
//
// scripts/tools/mainnet-launch.mjs — `create_pool` and `initialize`, on
// mainnet, and nothing else.
//
// Six rehearsals sent these two instructions through `deploy-devnet.mjs`,
// which is (correctly) hard-gated off mainnet — and launch prep 2026-08-10
// found that no tool could send them on the real cluster at all. This is that
// tool. It deliberately does none of the rehearsal work: no coin, no cast, no
// manifest, no funding of stand-ins. Two subcommands, each of which reads its
// own write back from the chain before calling itself done (the rehearsal
// pattern: a confirmed write followed by an immediate read is not a read of
// that write — so both reread with a fresh connection until the account
// appears).
//
//   node scripts/tools/mainnet-launch.mjs create-pool \
//     --payer secrets/mainnet-payer.json --rpc <MAINNET_RPC>
//
//   node scripts/tools/mainnet-launch.mjs initialize \
//     --initializer secrets/mainnet-initializer.json \
//     --mint <THE_REAL_MINT> --snapshot-key <SQUADS_VAULT> \
//     --rpc <MAINNET_RPC>
//
// `initialize` writes L19's clock (86400/300) and `config.mjs`'s floor. There
// are deliberately no flags to override them: a fat-fingered override here is
// permanent, and a rehearsal wanting other values has `deploy-devnet.mjs`.
// Genesis is the NEXT epoch boundary computed from CHAIN time (the F20 ceil
// rule, copied from deploy-devnet.mjs), and the command refuses to run within
// ten minutes of a boundary so the landing slot cannot straddle one.
//
// The inverse of `assertNotMainnet`: this tool refuses every cluster whose
// genesis hash is NOT mainnet's. One tool per cluster, no flag to blur them.

import { readFileSync } from 'node:fs';

import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { MIN_HOLD_RAW } from '../lib/config.mjs';
import {
  configPda,
  createPoolIx,
  decodeConfig,
  initializeIx,
  poolPda,
  PROGRAM_ID,
} from '../lib/program.mjs';
import { MAINNET_GENESIS_HASH } from './devnet.mjs';

export const EPOCH_SECONDS = 86_400; // L19
export const CHALLENGE_SECONDS = 300; // L19 — NOT 86400 (that was L14), NOT 0
const BOUNDARY_MARGIN_SECONDS = 600;

/**
 * The genesis `initialize` will write: the NEXT boundary after chain-now.
 *
 * Copied from deploy-devnet.mjs, where the comment block records F20: flooring
 * puts genesis in the past, epoch 0 then has no polled inputs and can never
 * settle, and the carry chain wedges epoch 1 behind it. Ceiling costs at most
 * one epoch of waiting and buys an epoch 0 that settles normally.
 */
export function genesisFor(chainNow, epochSeconds = EPOCH_SECONDS) {
  return Math.ceil(chainNow / epochSeconds) * epochSeconds;
}

/**
 * Refuse to initialize near a boundary.
 *
 * MAINNET-DEPLOYMENT: "the *boundary* rule is the one that bites: do not run
 * this at 00:00 UTC." A transaction sent just before midnight can land just
 * after it, turning the genesis the preflight checked into the boundary that
 * already passed. Early-to-mid epoch satisfies every constraint at once.
 */
export function boundaryGuard(chainNow, epochSeconds = EPOCH_SECONDS, margin = BOUNDARY_MARGIN_SECONDS) {
  const sinceBoundary = chainNow % epochSeconds;
  const untilBoundary = epochSeconds - sinceBoundary;
  if (sinceBoundary < margin || untilBoundary < margin) {
    throw new Error(
      `chain time is ${sinceBoundary}s past / ${untilBoundary}s before an epoch boundary ` +
        `(margin ${margin}s). A boundary-timed initialize is F20. Wait and rerun.`,
    );
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else if (!args.command) args.command = argv[i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.command) throw new Error('subcommand required: create-pool | initialize');
  if (!args.rpc) throw new Error('--rpc <MAINNET_RPC> is required — there is no default here');
  return args;
}

const load = (path) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

async function assertMainnet(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `mainnet-launch.mjs refuses to run: ${connection.rpcEndpoint} is not mainnet-beta ` +
        `(genesis ${genesis}). Rehearsals go through deploy-devnet.mjs.`,
    );
  }
}

/** Poll until an account exists, because a confirmed write is not yet a read. */
async function waitForAccount(connection, address, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const info = await connection.getAccountInfo(address, 'confirmed');
    if (info) return info;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${address.toBase58()} still not readable after the write was confirmed`);
}

async function createPool(args, connection) {
  if (!args.payer) throw new Error('--payer <PATH> is required');
  const payer = load(args.payer);
  const pool = poolPda();

  const existing = await connection.getAccountInfo(pool, 'confirmed');
  if (existing) {
    console.log(`pool ${pool.toBase58()} already exists — verifying instead of creating`);
  } else {
    const program = await connection.getAccountInfo(PROGRAM_ID, 'confirmed');
    if (!program || !program.executable) {
      throw new Error(`program ${PROGRAM_ID.toBase58()} is not deployed on this cluster`);
    }
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(createPoolIx({ payer: payer.publicKey })),
      [payer],
      { commitment: 'confirmed' },
    );
  }

  // MAINNET-DEPLOYMENT step 2: present, System-owned, zero data.
  const info = await waitForAccount(connection, pool);
  const owner = info.owner.toBase58();
  if (owner !== SystemProgram.programId.toBase58()) {
    throw new Error(`pool is owned by ${owner}, not the System Program — stop and investigate`);
  }
  if (info.data.length !== 0) {
    throw new Error(`pool carries ${info.data.length} bytes of data, expected zero — stop and investigate`);
  }
  console.log(`pool      ${pool.toBase58()}`);
  console.log(`owner     System Program ✓   data 0 bytes ✓   lamports ${info.lamports}`);
}

async function initialize(args, connection) {
  if (!args.initializer) throw new Error('--initializer <PATH> is required');
  if (!args.mint) throw new Error('--mint <ADDRESS> is required');
  if (!args['snapshot-key']) throw new Error('--snapshot-key <SQUADS_VAULT> is required');
  const initializer = load(args.initializer);
  const mint = new PublicKey(args.mint);
  const snapshotKey = new PublicKey(args['snapshot-key']);

  const already = await connection.getAccountInfo(configPda(), 'confirmed');
  if (already) throw new Error('config already exists: initialize has already run for this program id');

  const slot = await connection.getSlot('confirmed');
  const chainNow = await connection.getBlockTime(slot);
  boundaryGuard(chainNow);
  const genesisTs = genesisFor(chainNow);

  console.log(`chain now   ${new Date(chainNow * 1000).toISOString()}`);
  console.log(`genesis_ts  ${new Date(genesisTs * 1000).toISOString()}  (the NEXT boundary)`);
  console.log(`epoch       ${EPOCH_SECONDS}s, challenge ${CHALLENGE_SECONDS}s, min_hold ${MIN_HOLD_RAW} raw`);

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      initializeIx({
        payer: initializer.publicKey,
        mint,
        genesisTs,
        epochSeconds: EPOCH_SECONDS,
        minHold: MIN_HOLD_RAW,
        challengeSeconds: CHALLENGE_SECONDS,
        snapshotKey,
      }),
    ),
    [initializer],
    { commitment: 'confirmed' },
  );

  // Read every immutable parameter back from the chain — the crank/multisig
  // rehearsals' invariant. What was sent is not what matters; what was
  // WRITTEN is, and this is the last moment a mismatch is cheap to know about
  // (it is never cheap to fix — but a wrong value discovered now stops the
  // coin from being created on top of it).
  const info = await waitForAccount(connection, configPda());
  const config = decodeConfig(info.data);
  const checks = [
    ['mint', config.mint.toBase58(), mint.toBase58()],
    ['genesis_ts', String(config.genesisTs), String(genesisTs)],
    ['epoch_seconds', String(config.epochSeconds), String(EPOCH_SECONDS)],
    ['challenge_seconds', String(config.challengeSeconds), String(CHALLENGE_SECONDS)],
    ['min_hold', String(config.minHold), String(MIN_HOLD_RAW)],
    ['snapshot_key', config.snapshotKey.toBase58(), snapshotKey.toBase58()],
  ];
  let failed = false;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    failed ||= !ok;
    console.log(`${ok ? '  ok' : 'FAIL'}  ${name} = ${got}${ok ? '' : `  (sent ${want})`}`);
  }
  if (failed) throw new Error('the chain disagrees with what was sent — read the checks above');
  console.log('\ninitialized — every parameter above is now permanent.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertMainnet(connection);
  if (args.command === 'create-pool') await createPool(args, connection);
  else if (args.command === 'initialize') await initialize(args, connection);
  else throw new Error(`unknown subcommand ${args.command}: create-pool | initialize`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nMAINNET LAUNCH FAILED: ${err.message}`);
    process.exit(1);
  });
}
