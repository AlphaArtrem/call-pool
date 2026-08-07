#!/usr/bin/env node
//
// scripts/tools/mock-fees.mjs — creator fees accruing, and step 0 sweeping them.
//
//   node scripts/tools/mock-fees.mjs --accrue 0.05    # payer → the stand-in vault
//   node scripts/tools/mock-fees.mjs --sweep          # the vault → the pool
//   node scripts/tools/mock-fees.mjs --accrue 0.05 --sweep
//
// Two separate accounts on purpose, because the website draws them as two bars
// and folding them together is the mistake that chart exists to prevent: money
// in the pool can be divided now, money still in the creator vault cannot.
//
// ⚠️ **This is a stand-in, not the sweep.** The real one is `scripts/sweep.mjs`
// and it needs a coin with a pump.fun fee-sharing config behind it. A plain SOL
// transfer between two accounts we control proves the *website* renders an
// accruing vault and a growing pool, on a cluster where no such coin exists. It
// proves nothing about pump.fun.

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { connect } from '../lib/rpc.mjs';

import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { poolPda } from '../lib/program.mjs';
import { assertNotMainnet, loadKeypair, readManifest } from './devnet.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, sweep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sweep') args.sweep = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.accrue && !args.sweep) {
    throw new Error('nothing to do: pass --accrue <SOL>, --sweep, or both');
  }
  return args;
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

async function move(connection, from, to, lamports) {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Number(lamports),
      }),
    ),
    [from],
    { commitment: 'confirmed' },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mock-fees.mjs');

  const manifest = readManifest();
  const vault = loadKeypair(manifest.creatorVault.keypair);
  const pool = poolPda();

  if (args.accrue) {
    const payer = loadKeypair(manifest.payer.keypair);
    const lamports = BigInt(Math.round(Number(args.accrue) * LAMPORTS_PER_SOL));
    const signature = await move(connection, payer, vault.publicKey, lamports);
    console.log(`accrued   ${sol(lamports)} into the creator vault  ${signature}`);
  }

  if (args.sweep) {
    // Everything except the rent-exempt minimum, which cannot leave without
    // closing the account. The real sweep has the same shape and the same
    // reason, so the number the website shows as "still accruing" is never
    // quite zero — that is honest, not a rounding error.
    const balance = BigInt(await connection.getBalance(vault.publicKey));
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    const fee = 5_000n;
    const movable = balance - rent - fee;

    if (movable <= 0n) {
      console.log(`sweep     nothing to sweep — the vault holds ${sol(balance)}, all of it rent`);
    } else {
      const signature = await move(connection, vault, pool, movable);
      console.log(`swept     ${sol(movable)} into the pool  ${signature}`);
    }
  }

  console.log(`vault     ${sol(await connection.getBalance(vault.publicKey))}  ${vault.publicKey.toBase58()}`);
  console.log(`pool      ${sol(await connection.getBalance(pool))}  ${pool.toBase58()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
