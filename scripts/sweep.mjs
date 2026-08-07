#!/usr/bin/env node
//
// scripts/sweep.mjs — step 0. Move the coin's creator fees into the pool.
//
// Two halves, because the money arrives in two shapes (Phase 03 §3.4a):
//
//   pump's `distribute_creator_fees`  the fee-sharing config pays each
//                                     shareholder its bps. Ours is the pool.
//   our `sweep_wsol`                  post-graduation fees can land as wrapped
//                                     SOL in an ATA owned by the pool. wSOL
//                                     cannot be unwrapped in place; closing the
//                                     ATA into the pool is the only route back.
//
// **Both are permissionless.** `distribute_creator_fees` carries no signer at
// all (proven on devnet 2026-08-07, signed by a wallet that was neither the
// creator nor a shareholder), and `sweep_wsol`'s destination is fixed by its
// account constraints. So this needs a wallet that pays gas and controls
// nothing — never the snapshot key, never a multisig member key.
//
//   node scripts/sweep.mjs --keypair <GAS_PAYER>   # sweep
//   node scripts/sweep.mjs                         # read-only: what is there
//
// ⚠️ **Never read a successful distribute as "fees arrived."** Below pump's
// minimum distributable fee it succeeds and moves nothing (F4), and the SDK
// reports `canDistribute: false` for a *failed simulation* too — it swallows
// the error and returns zeroes. The only honest statement about whether money
// moved is the pool's balance before and after, which is what this prints and
// what the exit code does NOT depend on.
//
// A sweep that moves nothing is not a failure. Fees stay in pump's creator
// vault and roll into the next epoch; nothing is lost by missing one.
//
// ── where pump's SDK is, and why it is not here ────────────────────────────
//
// `@pump-fun/pump-sdk` is **not a dependency of this repository**. It lives in
// `tools/sweep/`, which has its own `package.json` and its own lockfile, and is
// loaded from here by a dynamic import.
//
// The reason is the root `package-lock.json`. It is committed for the same
// reason `Cargo.lock` is — `post-root.mjs` and `cosign.mjs` hold the snapshot
// key and sign with it, so their dependency versions have to be as fixed as the
// deployed binary's. Naming the SDK there would add anchor, pump-swap-sdk,
// agent-payments-sdk and bn.js to that surface on every host that runs
// `npm ci`, including the co-signer, whose only job is to be a second opinion.
//
// Running this in its own process was necessary and not sufficient: the process
// boundary decides what is resident at runtime, the manifest decides what gets
// installed. Both had to move.
//
// **Nothing pump's SDK constructs is signed here.** `tools/sweep` hands back
// base58 strings and base64 bytes, and the instructions below are rebuilt from
// those primitives with this repository's own pinned `@solana/web3.js`.

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
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import { connect } from './lib/rpc.mjs';

import { currentBalanceRaw } from './lib/chain.mjs';
import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { fetchConfig, poolPda, poolWsolAta, sweepWsolIx } from './lib/program.mjs';

/**
 * Headroom for pump's distribute, which may carry an AMM transfer beside it.
 *
 * Raising the limit without setting a unit *price* costs nothing — the fee is
 * per signature, and the priority component only applies when a price is set.
 * So this is free insurance against the one failure that would be maddening to
 * diagnose from a log line reading `exceeded CUs`.
 */
const COMPUTE_UNIT_LIMIT = 400_000;

/** Where the SDK-dependent half lives. Its own package, its own lockfile. */
const PUMP_FEES = '../tools/sweep/pump-fees.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL`;

/**
 * Load the isolated pump helper, or say exactly what is missing.
 *
 * Deliberately a dynamic import: a static one would make this file unloadable
 * on a host that has not installed `tools/sweep`, and `sweep.test.mjs` needs to
 * import the pure functions below without pulling anchor in behind them.
 */
export async function loadPumpFees(specifier = PUMP_FEES) {
  try {
    return await import(specifier);
  } catch (error) {
    throw new Error(
      'tools/sweep is not installed, so pump\'s fee instructions cannot be built. It is a ' +
        'separate package on purpose — the SDK must not be in the lockfile that pins the ' +
        'signing scripts. Run:  cd tools/sweep && npm ci\n' +
        `  (${error.message})`,
    );
  }
}

/**
 * Rebuild an instruction from primitives, with our own web3.
 *
 * This is the boundary. Everything past it was constructed by code in this
 * repository from a base58 string and some bytes — nothing pump's SDK built
 * reaches a transaction we sign.
 */
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
 * What pump says it will distribute right now, in words. **Advisory only.**
 *
 * `canDistribute: false` has two causes that look identical from here: the
 * accrued fee is genuinely below `minimumRequired`, or the SDK's simulation
 * errored and it returned zeroes rather than raising. Neither is a reason to
 * stop, and — measured 2026-08-07 — the second is not hypothetical: a coin with
 * 8,017,920 lamports of accrued fees reported `0` against a minimum of `0` and
 * distributed 5,204,484 lamports when asked anyway.
 *
 * So this describes and decides nothing. The distribute is attempted either way
 * and the pool's balance delta settles the question.
 */
export function describeDistributable({ minimumRequired, distributableFees, canDistribute }) {
  if (canDistribute) return `distributable now: ${sol(distributableFees)}`;
  return (
    `pump reports NOT distributable: ${sol(distributableFees)} accrued against a minimum of ` +
    `${sol(minimumRequired)}. Trying anyway — this reading is unreliable, and a zero/zero ` +
    'answer has meant 0.005 SOL sitting there. The delta below is the real answer.'
  );
}

/**
 * Say what a missing fee-sharing config actually costs, in our terms.
 *
 * pump's own message names the mint and stops. What it means here is that the
 * 90/10 split does not exist on chain, so **no fee has ever been routed to the
 * pool and none will be** — every lamport is accruing in the original creator
 * vault, reachable only by the creator's own `collect_creator_fee` (F5). That
 * is a launch-order fault, not a quiet day, and it should not read like one.
 */
export function explainPumpFailure(message) {
  if (/sharing config not found/i.test(message)) {
    return (
      `${message}\n` +
      '  The coin has NO fee-sharing config, so the 90/10 split does not exist on chain and\n' +
      '  no fee can reach the pool. Everything accrued sits in pump\'s original creator vault\n' +
      '  and only the creator can move it, with collect_creator_fee. If the coin is live, this\n' +
      '  is the launch step that did not happen — see MAINNET-DEPLOYMENT.md.'
    );
  }
  return message;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);

  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const pool = poolPda();
  const wsolAta = poolWsolAta();

  console.log('\nCALLPOOL — step 0, the fee sweep\n');
  console.log(`mint       ${mint}`);
  console.log(`pool       ${pool.toBase58()}`);

  // Read before anything is sent. Every claim this script makes about money
  // moving is this number subtracted from the one taken at the end.
  const before = BigInt(await connection.getBalance(pool));
  console.log(`pool holds ${sol(before)}`);

  const pump = await loadPumpFees();

  // ── the two halves are independent, and so are their failures ────────────
  // A coin with no fee-sharing config throws here. That must not strand wrapped
  // SOL already sitting in the pool's ATA, which the other half can still
  // recover with no help from pump at all. So faults are collected, not thrown,
  // and the exit code is decided once at the end.
  const faults = [];

  let minimum = null;
  try {
    const distributable = await pump.readDistributable(args.rpc, mint);
    minimum = {
      minimumRequired: BigInt(distributable.minimumRequired),
      distributableFees: BigInt(distributable.distributableFees),
      canDistribute: distributable.canDistribute,
    };
    console.log(`pump       ${distributable.isGraduated ? 'graduated (AMM)' : 'on the bonding curve'}`);
    console.log(`fees       ${describeDistributable(minimum)}`);
  } catch (error) {
    faults.push(`could not read pump's distributable fee — ${explainPumpFailure(error.message)}`);
    console.log(`fees       UNKNOWN — ${error.message}`);
  }

  const wsolBefore = await currentBalanceRaw(connection, wsolAta);
  console.log(`pool wSOL  ${sol(wsolBefore)}  ${wsolAta.toBase58()}`);

  if (!args.keypair) {
    console.log(
      '\nRead-only: no --keypair given, so nothing was sent. This is a wallet that pays ' +
        'gas and controls nothing — anyone can run the sweep.',
    );
    if (faults.length > 0) {
      console.log(`\n${faults.length} fault(s):`);
      for (const fault of faults) console.log(`  • ${fault}`);
      process.exitCode = 1;
    }
    console.log('');
    return;
  }

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(resolve(args.keypair), 'utf8'))),
  );
  // The whole reason this runs apart from the signing scripts is to keep pump's
  // dependency tree away from a key that has authority. Handing it that key
  // anyway would defeat it.
  if (payer.publicKey.equals(config.snapshotKey)) {
    throw new Error(
      `--keypair is the snapshot key (${config.snapshotKey.toBase58()}). The sweep is ` +
        'permissionless and must be run with a gas-only wallet; the key that posts roots ' +
        'has no business in a process that loads pump.fun\'s SDK.',
    );
  }
  console.log(`payer      ${payer.publicKey.toBase58()} (pays gas, controls nothing)\n`);

  const send = (instructions) =>
    sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...instructions,
      ),
      [payer],
      { commitment: 'confirmed' },
    );

  // ── always attempt the distribute ────────────────────────────────────────
  //
  // **`canDistribute` is not a gate, and treating it as one silently stops the
  // pool from ever being paid.** Measured on devnet 2026-08-07 with a real
  // pump.fun coin: the fee-sharing config held 8,017,920 lamports with the
  // 9000/1000 split correct and `admin_revoked` set, and
  // `getMinimumDistributableFee` returned `distributableFees: 0`,
  // `minimumRequired: 0`, `canDistribute: false`. Sending the distribute anyway
  // moved 5,204,484 lamports into the pool.
  //
  // So this file's own header was right and this branch was wrong: the SDK
  // reports `canDistribute: false` for a *failed simulation* as well as for a
  // genuinely small balance, swallowing the error and returning zeroes. Gating
  // on it meant step 0 skipping every epoch, forever, on a coin whose fees were
  // accruing perfectly well — and skipping it *quietly*, as a normal quiet day.
  //
  // Attempting costs one transaction that either moves money or does not. Below
  // pump's real minimum the instruction succeeds and moves nothing (F4), which
  // is already handled and is not an error. A genuine failure is caught,
  // reported as a fault, and does not stop the wSOL half.
  //
  // The pool's balance before and after remains the only honest statement about
  // whether money moved. `canDistribute` is now printed as information and
  // decides nothing.
  try {
    const { instructions } = await pump.buildDistributeInstructions(args.rpc, mint);
    // Rebuilt here, from base58 and bytes, with our own web3.
    const signature = await send(instructions.map(instructionFrom));
    console.log(
      `distribute ${signature}` +
        (minimum?.canDistribute === false ? '   (sent despite canDistribute:false — see the delta)' : ''),
    );
  } catch (error) {
    faults.push(`distribute failed — ${explainPumpFailure(error.message)}`);
    console.log(`distribute FAILED — ${error.message}`);
  }

  // Re-read: on a graduated coin the distribute that just landed is itself a
  // reason for the pool's wSOL ATA to be non-empty when it was empty a moment
  // ago, and sweeping it next epoch instead would understate today's pool.
  const wsolAfter = await currentBalanceRaw(connection, wsolAta);
  if (wsolAfter > 0n) {
    try {
      // Recreated in the same transaction, immediately. `sweep_wsol` closes the
      // ATA and cannot recreate it, and the next post-graduation distribution
      // may need every shareholder's ATA to exist — including the ops wallet's.
      // Leaving it closed would take the other shareholder down with us (D5).
      const signature = await send([
        sweepWsolIx({ caller: payer.publicKey }),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          wsolAta,
          pool,
          NATIVE_MINT,
          TOKEN_PROGRAM_ID,
        ),
      ]);
      console.log(`sweep_wsol ${sol(wsolAfter)} unwrapped, ATA recreated  ${signature}`);
    } catch (error) {
      faults.push(`sweep_wsol failed: ${error.message}`);
      console.log(`sweep_wsol FAILED — ${error.message}`);
    }
  } else {
    console.log('sweep_wsol skipped — the pool holds no wrapped SOL');
  }

  // ── the only statement that means anything ──────────────────────────────
  const after = BigInt(await connection.getBalance(pool));
  const delta = after - before;
  console.log(`\npool       ${sol(before)} → ${sol(after)}`);
  console.log(
    delta > 0n
      ? `swept      ${sol(delta)} into the pool`
      : 'swept      NOTHING — the pool balance did not move. A successful distribute ' +
          "below pump's minimum does exactly this, and it is not an error.",
  );

  // The delta above is the truth about the money and never sets the exit code:
  // a sweep that correctly moves nothing is a success. The exit code is about
  // whether anything went *wrong*, which the crank turns into a warning and
  // settles the epoch regardless.
  if (faults.length > 0) {
    console.log(`\n${faults.length} fault(s):`);
    for (const fault of faults) console.log(`  • ${fault}`);
    console.log('');
    process.exitCode = 1;
    return;
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nSWEEP FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
