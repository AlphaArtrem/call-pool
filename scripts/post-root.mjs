#!/usr/bin/env node
//
// scripts/post-root.mjs — step 9. **The only script that touches a key.**
//
// It posts one epoch's root. That is the entire trusted action in this system:
// steps 1–8 are deterministic and anyone can check them, step 11 needs only
// gas, and this needs the snapshot key.
//
// Read Phase 05 §5.5 before changing anything here. A stolen key takes the
// pool's current balance and every future creator fee, permanently, because
// there is no rotation — which is why the key is a 2-of-3 multisig (L3) and
// why this script prefers `--unsigned` by default in that setup.
//
// Usage:
//   node scripts/post-root.mjs --epoch 12 --keypair <PATH>     # single signer
//   node scripts/post-root.mjs --epoch 12 --unsigned           # emit base64 for a multisig
//   node scripts/post-root.mjs --epoch 12 --empty              # zeroed root, no snapshot needed
//
// **Post a root for every epoch, including empty ones** (L3/D7). An epoch with
// no root stays postable forever, and a backlog of open windows is a stored-up
// liability a stolen key drains in one sitting. "Nobody called" is not a reason
// to skip the transaction; it is a reason for the root to be zeroed.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { DEFAULT_RPC_URL } from './lib/config.mjs';
import {
  epochPda,
  fetchConfig,
  fetchEpoch,
  poolAvailable,
  postEpochRootIx,
} from './lib/program.mjs';
import { readJson, snapshotDir } from './lib/store.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, unsigned: false, empty: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--unsigned') args.unsigned = true;
    else if (argv[i] === '--empty') args.empty = true;
    else if (argv[i] === '--yes') args.yes = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.epoch === undefined) throw new Error('--epoch is required');
  return args;
}

/**
 * The challenge window in the unit a human would use for it.
 *
 * Not always hours: `challenge_seconds` is an `initialize` argument, and a
 * rehearsal running a 10-second window would otherwise be told claims open in
 * `0.002777777777777778h`.
 */
function afterThis(seconds) {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 2)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(seconds % 60 === 0 ? 0 : 1)}m`;
  return `${seconds}s`;
}

function loadKeypair(path) {
  const bytes = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = Number(args.epoch);
  const connection = new Connection(args.rpc, 'confirmed');
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();

  // An epoch that already has a root cannot be posted again, by anyone —
  // including us. Checking here turns a confusing on-chain failure into a
  // clear message, and catches a double-run of the crank.
  const existing = await fetchEpoch(connection, mint, epoch);
  if (existing) {
    console.log(`\nepoch ${epoch} already has a root: ${existing.root.toString('hex')}`);
    console.log(`posted at ${new Date(existing.postedTs * 1000).toISOString()}`);
    console.log('Nothing to do. Roots are write-once, and corrections go forward.\n');
    return;
  }

  let root;
  let leafCount;
  let allocate;

  if (args.empty) {
    root = Buffer.alloc(32);
    leafCount = 0;
    allocate = 0n;
  } else {
    const dir = snapshotDir(epoch);
    const tree = readJson(resolve(dir, 'tree.json'));
    if (tree.epoch !== epoch) {
      throw new Error(`${dir}/tree.json is for epoch ${tree.epoch}, not ${epoch}`);
    }
    root = Buffer.from(tree.root, 'hex');
    leafCount = tree.leafCount;
    allocate = BigInt(tree.allocate);
  }

  const pool = await poolAvailable(connection, config);
  if (allocate > pool.available) {
    throw new Error(
      `the snapshot allocates ${allocate} but the pool can only back ${pool.available}. ` +
        'Re-run the snapshot against the current pool balance — do not trim the number here.',
    );
  }

  console.log(`\nCALLPOOL — post_epoch_root, epoch ${epoch}\n`);
  console.log(`mint         ${mint}`);
  console.log(`epoch PDA    ${epochPda(mint, epoch).toBase58()}`);
  console.log(`root         ${root.toString('hex')}`);
  console.log(`leaf_count   ${leafCount}`);
  console.log(`allocate     ${allocate} of ${pool.available} available`);
  console.log(`snapshot key ${config.snapshotKey.toBase58()}`);
  console.log(`challenge    ${config.challengeSeconds}s — claims open ${afterThis(config.challengeSeconds)} after this lands\n`);

  const ix = postEpochRootIx({
    snapshotKey: config.snapshotKey,
    mint,
    epoch,
    root,
    leafCount,
    allocate,
  });

  if (args.unsigned || !args.keypair) {
    // The 2-of-3 layout signs through a multisig program, so the normal path is
    // to hand the encoded transaction to it rather than to sign here.
    const tx = new Transaction().add(ix);
    tx.feePayer = config.snapshotKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const encoded = tx.serialize({ requireAllSignatures: false }).toString('base64');
    const out = resolve(snapshotDir(epoch), 'post-root.unsigned.txt');
    writeFileSync(out, `${encoded}\n`);
    console.log('unsigned transaction (base64), for the multisig:\n');
    console.log(encoded);
    console.log(`\nwritten to ${out}\n`);
    return;
  }

  const signer = loadKeypair(args.keypair);
  if (!signer.publicKey.equals(config.snapshotKey)) {
    throw new Error(
      `${args.keypair} is ${signer.publicKey.toBase58()}, not the snapshot key ` +
        `${config.snapshotKey.toBase58()}`,
    );
  }

  if (!args.yes) {
    console.log('This writes a root that can never be replaced. Re-run with --yes to send.\n');
    return;
  }

  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [signer], {
    commitment: 'confirmed',
  });
  console.log(`posted: ${signature}\n`);

  if (!args.empty) {
    const rootTxt = resolve(snapshotDir(epoch), 'root.txt');
    writeFileSync(
      rootTxt,
      `root=${root.toString('hex')}\nleaf_count=${leafCount}\nallocate=${allocate}\nposted_signature=${signature}\n`,
    );
    console.log(`recorded in ${rootTxt}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
