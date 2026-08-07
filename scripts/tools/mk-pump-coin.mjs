#!/usr/bin/env node
//
// scripts/tools/mk-pump-coin.mjs — a real pump.fun coin for the rehearsal.
//
//   node scripts/tools/mk-pump-coin.mjs --keypair <FUNDED> --rpc <DEVNET_RPC> \
//     --name CALLPOOL-REHEARSAL --symbol CPR --dev-buy 0.05
//
//   ... --ops <ADDRESS>   the 1000 bps shareholder (defaults to the payer)
//   ... --dry-run         print the plan, send nothing
//
// **Devnet only.** `assertNotMainnet` runs before anything is built, by genesis
// hash rather than by the shape of the URL, exactly like every other tool under
// `scripts/tools/`.
//
// ── why this exists ────────────────────────────────────────────────────────
//
// The rehearsal can run against a synthetic `createMint`, and that is the
// documented fallback. But a synthetic mint has no bonding curve, no callout
// feed and no fee-sharing config, so it exercises none of the three things that
// have **never run live**: step 0's real `distribute_creator_fees`,
// `sweep_wsol`, and L18's LP discrimination. Those three are also the newest
// code in the repository. A green run on a synthetic mint re-proves what already
// worked and says nothing about them, and REHEARSAL-PLAN-1H.md is explicit that
// a report must not let one imply the other.
//
// ── the order, which is not negotiable ─────────────────────────────────────
//
//   1. `create_pool` — already done by deploy-devnet.mjs. The pool is seeded on
//      a CONSTANT, not on the mint, precisely so its address exists before the
//      coin does and can be named as a fee recipient at creation (§4.2).
//   2. this tool: create + createFeeSharingConfig + updateFeeShares, in ONE
//      transaction (F6). Bundling closes F5's window, where fees accrued before
//      the config exists are stranded in the creator vault and reachable only by
//      the creator's own `collect_creator_fee`.
//   3. the dev buy, separately — it does not fit (1485 bytes vs 1232).
//
// ⚠️ `updateFeeShares` sets `admin_revoked` (F7). **One shot**, even on devnet.
// Get 9000/1000 right the first time; it is the same muscle memory mainnet needs.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { poolPda } from '../lib/program.mjs';
import { assertNotMainnet, loadKeypair, readManifest, writeManifest } from './devnet.mjs';

/** The pool takes 90%, ops takes 10%. The same split mainnet will use. */
const POOL_SHARE_BPS = 9_000;
const OPS_SHARE_BPS = 1_000;

const COMPUTE_UNIT_LIMIT = 400_000;

/** Where the SDK-dependent half lives. Its own package, its own lockfile. */
const PUMP_FEES = '../../tools/sweep/pump-fees.mjs';

function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    // Short on purpose — all three ride in the create bundle, which sits ~20
    // bytes under the transaction limit. See the send below.
    name: 'CPR',
    symbol: 'CPR',
    uri: 'https://callpool.fun/r.json',
    devBuy: '0.05',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--dev-buy') args.devBuy = argv[++i];
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair && !args.dryRun) throw new Error('--keypair <PATH> is required');
  return args;
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

/** Rebuild an instruction from primitives, with our own web3. The boundary. */
export function instructionFrom({ programId, keys, data }) {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: Boolean(k.isSigner),
      isWritable: Boolean(k.isWritable),
    })),
    data: Buffer.from(data, 'base64'),
  });
}

/**
 * The 90/10 split, as pump wants it.
 *
 * Separated out and exported because it is the one value in this file that is
 * unrecoverable if wrong (F7) and therefore the one worth testing directly
 * rather than only exercising through a live send.
 */
export function shareholdersFor(pool, ops) {
  if (String(pool) === String(ops)) {
    throw new Error(
      'the pool and the ops wallet are the same address. pump rejects a duplicate ' +
        'shareholder, and a 100% pool split is not the mechanic being rehearsed.',
    );
  }
  return [
    { address: String(pool), shareBps: POOL_SHARE_BPS },
    { address: String(ops), shareBps: OPS_SHARE_BPS },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mk-pump-coin.mjs');

  const payer = args.dryRun && !args.keypair
    ? Keypair.generate()
    : loadKeypair(args.keypair);
  const pool = poolPda();
  const ops = args.ops ? new PublicKey(args.ops) : payer.publicKey;
  const mintKeypair = Keypair.generate();
  const devBuyLamports = BigInt(Math.round(Number(args.devBuy) * LAMPORTS_PER_SOL));

  console.log('\nCALLPOOL — create a pump.fun devnet coin\n');
  console.log(`payer      ${payer.publicKey.toBase58()}`);
  console.log(`mint       ${mintKeypair.publicKey.toBase58()}   (new)`);
  console.log(`pool       ${pool.toBase58()}   ${POOL_SHARE_BPS} bps`);
  console.log(`ops        ${ops.toBase58()}   ${OPS_SHARE_BPS} bps`);
  console.log(`dev buy    ${sol(devBuyLamports)}`);

  // The pool must already exist as a bare System account, or pump will refuse
  // it as a fee recipient. deploy-devnet.mjs runs create_pool; this only checks,
  // because discovering it after the mint keypair is spent is expensive.
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error(
      `the pool PDA ${pool.toBase58()} does not exist yet. Run create_pool first — ` +
        'deploy-devnet.mjs does it. pump rejects an uninitialized fee recipient (§4.2).',
    );
  }
  console.log(`pool state exists, ${poolInfo.lamports} lamports, ${poolInfo.data.length} bytes\n`);

  const pump = await import(PUMP_FEES).catch((error) => {
    throw new Error(
      'tools/sweep is not installed, so pump\'s instructions cannot be built. Run:\n' +
        `  cd tools/sweep && npm ci\n  (${error.message})`,
    );
  });

  const shareholders = shareholdersFor(pool.toBase58(), ops.toBase58());
  const built = await pump.buildCreateCoinInstructions(args.rpc, {
    mint: mintKeypair.publicKey.toBase58(),
    creator: payer.publicKey.toBase58(),
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    shareholders,
    devBuyLamports: devBuyLamports.toString(),
  });

  console.log(`create     ${built.create.length} instruction(s): create + fee config + shares`);
  console.log(`dev buy    ${built.devBuy.length} instruction(s), sent separately (F6: 1485 > 1232 bytes)`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was sent. The mint keypair above was NOT persisted.\n');
    return;
  }

  // ── one transaction: create, config, shares ──────────────────────────────
  //
  // **No ComputeBudget instruction here, and that is not an oversight.** F6
  // measured these three fitting in one transaction with very little room: the
  // bundle lands around 1,250 of the 1,232-byte limit before anything else is
  // added, so a 40-byte compute-budget prefix is the difference between working
  // and `Transaction too large: 1293 > 1232`. Measured on 2026-08-07 by hitting
  // it. The create path does not need the extra units; the dev buy below gets
  // them because it can afford the bytes.
  //
  // Bundling is worth this fussiness. Splitting the three would reopen F5's
  // window — every lamport of fee accruing before the config exists is
  // unreachable through it forever, recoverable only by the creator's own
  // `collect_creator_fee`.
  const createTx = new Transaction().add(...built.create.map(instructionFrom));
  const createSig = await sendAndConfirmTransaction(connection, createTx, [payer, mintKeypair], {
    commitment: 'confirmed',
  }).catch((error) => {
    if (/too large/i.test(error.message)) {
      throw new Error(
        `${error.message}\n\n` +
          '  The create bundle is within ~20 bytes of the limit by design (F6), so the usual\n' +
          '  cause is metadata length. --name, --symbol and --uri are all in the transaction:\n' +
          `  name=${args.name.length}ch symbol=${args.symbol.length}ch uri=${args.uri.length}ch.\n` +
          '  Shorten them. Do NOT "fix" this by splitting the bundle — that reopens F5, where\n' +
          '  fees accruing before the fee-sharing config exists can never be routed through it.',
      );
    }
    throw error;
  });
  console.log(`\ncreated    ${createSig}`);
  console.log('           fee split is locked in the same transaction — F5\'s window is closed');

  // ── the dev buy, on its own ──────────────────────────────────────────────
  if (built.devBuy.length > 0 && devBuyLamports > 0n) {
    const buyTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ...built.devBuy.map(instructionFrom),
    );
    const buySig = await sendAndConfirmTransaction(connection, buyTx, [payer], {
      commitment: 'confirmed',
    });
    console.log(`dev buy    ${buySig}`);
  }

  // ── record it where every other tool looks ───────────────────────────────
  // The manifest is how the crank, the site and the sweep all learn the mint.
  // Writing it here rather than asking an operator to paste it is the
  // difference between one source of truth and three.
  let manifest = null;
  try {
    manifest = readManifest();
  } catch {
    console.log('\nnote: no deployment.json yet — record the mint yourself, or deploy first.');
  }
  if (manifest) {
    manifest.mint = mintKeypair.publicKey.toBase58();
    manifest.pumpCoin = {
      mint: mintKeypair.publicKey.toBase58(),
      creator: payer.publicKey.toBase58(),
      createdAt: Math.floor(Date.now() / 1000),
      signature: createSig,
      shareholders,
      // Recorded because it can never be changed and someone will ask.
      adminRevoked: true,
    };
    writeManifest(manifest);
    console.log('\nmanifest   epochs/devnet/deployment.json updated with the mint');
  }

  const distributable = await pump.readDistributable(args.rpc, mintKeypair.publicKey.toBase58());
  console.log(`\nfees       ${distributable.distributableFees} accrued, minimum ${distributable.minimumRequired}`);
  console.log(
    '           A brand-new coin has nothing to distribute. Trade it — the pool only grows if\n' +
      '           real fees accrue, and step 0 sweeping zero proves nothing.\n',
  );
  console.log(`mint       ${mintKeypair.publicKey.toBase58()}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nMK-PUMP-COIN FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
