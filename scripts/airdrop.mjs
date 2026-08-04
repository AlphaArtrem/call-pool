#!/usr/bin/env node
//
// scripts/airdrop.mjs — step 11. Pay everybody, once the challenge window closes.
//
// Rewards are **pushed, not claimed** (L8). The bot submits `claim` for every
// leaf, batching several recipients per transaction; holders do nothing. It
// cannot redirect a payment — the destination is inside the merkle leaf — so it
// is a submitter, not an authority, and **anyone can run this** from the
// published tree.json. That property is what makes push-based delivery safe,
// and it required no program change at all.
//
// Usage:
//   node scripts/airdrop.mjs --epoch 12 --keypair <PATH>       # send
//   node scripts/airdrop.mjs --epoch 12                        # what would be sent
//
// ⚠️ This is a scheduled job that can die quietly, and that failure looks
// exactly like a rug from outside. Phase 09 §9.3: alert on the **absence** of a
// completed airdrop, not only on errors. The claim page stays as the fallback,
// and the 30-epoch deadline covers whatever this never delivered.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { associatedTokenAddress, tokenProgramForMint } from './lib/chain.mjs';
import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { claimIx, fetchConfig, fetchEpoch, isClaimed } from './lib/program.mjs';
import { readJson, snapshotDir, writeJson } from './lib/store.mjs';

/**
 * Claims per transaction.
 *
 * Each `claim` carries a merkle proof — about 32 bytes per tree level, so
 * ~5 levels at 30 leaves — plus nine accounts. Five per transaction stays
 * comfortably inside the 1,232-byte packet limit even for a large tree, and the
 * cost of being wrong is a rejected transaction rather than a lost payment.
 */
const CLAIMS_PER_TX = 5;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.epoch === undefined) throw new Error('--epoch is required');
  return args;
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = Number(args.epoch);
  const connection = new Connection(args.rpc, 'confirmed');

  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const tree = readJson(resolve(snapshotDir(epoch), 'tree.json'));
  const onChain = await fetchEpoch(connection, mint, epoch);

  if (!onChain) throw new Error(`epoch ${epoch} has no root on chain — post it first`);
  if (onChain.root.toString('hex') !== tree.root) {
    // Refusing here is the point. If the chain and the published tree disagree,
    // the proofs will not verify and every claim would fail anyway — but a
    // mismatch is something to shout about, not to retry.
    throw new Error(
      `the root on chain (${onChain.root.toString('hex')}) is not the published root ` +
        `(${tree.root}). Do not pay against this. Say so publicly.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const opensAt = onChain.postedTs + config.challengeSeconds;
  if (now < opensAt) {
    throw new Error(
      `the challenge window closes at ${new Date(opensAt * 1000).toISOString()} — ` +
        `${Math.ceil((opensAt - now) / 60)} minute(s) away. Claims are rejected until then.`,
    );
  }

  const tokenProgram = await tokenProgramForMint(connection, mint);
  const outstanding = tree.leaves.filter((leaf) => !isClaimed(onChain, leaf.index));

  console.log(`\nCALLPOOL — airdrop, epoch ${epoch}\n`);
  console.log(`root       ${tree.root}`);
  console.log(`leaves     ${tree.leaves.length}, ${outstanding.length} unpaid`);
  console.log(`allocated  ${onChain.poolLamports}, ${onChain.claimedLamports} already claimed`);

  if (outstanding.length === 0) {
    console.log('\nEverybody has been paid.\n');
    return;
  }

  if (!args.keypair) {
    console.log('\nwould send (no --keypair given):\n');
    for (const leaf of outstanding) {
      console.log(`  ${leaf.index.toString().padStart(4)}  ${leaf.owner}  ${leaf.amount} lamports`);
    }
    console.log(
      `\n${chunk(outstanding, CLAIMS_PER_TX).length} transaction(s). ` +
        'Anyone can send these — the destination is inside the leaf.\n',
    );
    return;
  }

  const submitter = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(resolve(args.keypair), 'utf8'))),
  );
  console.log(`submitter  ${submitter.publicKey.toBase58()} (pays gas, controls nothing)\n`);

  const sent = [];
  const failed = [];
  for (const batch of chunk(outstanding, CLAIMS_PER_TX)) {
    const tx = new Transaction();
    for (const leaf of batch) {
      tx.add(
        claimIx({
          submitter: submitter.publicKey,
          mint,
          recipient: leaf.owner,
          recipientTokenAccount: associatedTokenAddress(leaf.owner, mint, tokenProgram),
          epoch,
          index: leaf.index,
          amount: BigInt(leaf.amount),
          proof: leaf.proof.map((hex) => Buffer.from(hex, 'hex')),
          tokenProgram,
        }),
      );
    }

    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [submitter], {
        commitment: 'confirmed',
      });
      sent.push({ signature, leaves: batch.map((l) => l.index) });
      console.log(`  ✔ ${batch.length} leaf/leaves  ${signature}`);
    } catch (error) {
      // One batch failing must not stop the rest. The commonest cause is a
      // recipient who has since sold below the floor, which `claim` refuses by
      // design (§4.5) — that is policy, not a bug, and it is worth naming per
      // batch rather than aborting the run.
      failed.push({ leaves: batch.map((l) => l.index), error: error.message });
      console.log(`  ✘ ${batch.map((l) => l.index).join(', ')}  ${error.message}`);
    }
  }

  writeJson(resolve(snapshotDir(epoch), 'airdrop.json'), {
    epoch,
    ranAt: now,
    submitter: submitter.publicKey.toBase58(),
    sent,
    failed,
  });

  console.log(`\n${sent.length} transaction(s) sent, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log('Failed leaves stay claimable by anyone until the 30-epoch deadline.');
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
