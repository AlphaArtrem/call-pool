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

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { connect } from './lib/rpc.mjs';

import { associatedTokenAddress, tokenProgramForMint } from './lib/chain.mjs';
import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { claimIx, fetchConfig, fetchEpoch, isClaimed } from './lib/program.mjs';
import { readJson, snapshotDir, writeJson } from './lib/store.mjs';
import { writeSnapshotIndex } from './lib/snapshot-index.mjs';

/**
 * The wire limit a signed transaction has to fit inside.
 *
 * Solana's packet is 1,232 bytes, and that is the whole signed transaction —
 * signatures, message header, every account key, the blockhash and all the
 * instruction data.
 */
export const TX_SIZE_LIMIT = 1232;

/**
 * A ceiling on claims per transaction, independent of size.
 *
 * Size is the binding constraint in practice, but a shallow tree would let the
 * packer build a batch large enough to run into the compute budget instead —
 * a different limit with a much less obvious failure.
 */
export const MAX_CLAIMS_PER_TX = 8;

/**
 * How many claims fit in one transaction — **measured, not assumed.**
 *
 * This replaces a hardcoded `CLAIMS_PER_TX = 5` whose comment claimed five
 * "stays comfortably inside the 1,232-byte packet limit even for a large tree".
 * It never did. On 2026-08-09 **every** batch of five reverted — eleven out of
 * eleven — and epoch 3 paid 57 people in 53 transactions instead of 12.
 *
 * The arithmetic the old constant missed is that a claim is not one fixed size.
 * Seven of its nine accounts are shared by every claim in the same transaction
 * and cost 32 bytes once; only `recipient` and its token account are per-claim.
 * What actually scales is the **merkle proof** — 32 bytes per tree level — so
 * the answer depends on how many leaves the epoch has, and no constant can be
 * right for every tree.
 *
 * At a 57-leaf tree that works out to ~301 bytes a claim against ~905 usable,
 * so three fit and five cannot. Rather than encode that sum and be wrong again
 * when an account is added or the instruction grows, the packer **builds the
 * batch and measures it**, which is the only figure that cannot drift away from
 * what the network will accept.
 *
 * Nothing was ever lost to the old value: `send` retries a reverted batch one
 * leaf at a time, so everyone was paid — at five times the transactions and
 * five times the fees, silently. That is why it survived this long.
 *
 * @param measure  called with a candidate batch, returns its signed byte size.
 */
export function packClaims(leaves, measure, { limitBytes = TX_SIZE_LIMIT, maxPerTx = MAX_CLAIMS_PER_TX } = {}) {
  const batches = [];
  let current = [];

  for (const leaf of leaves) {
    // A batch is only ever grown when the grown version still fits. A single
    // leaf that does not fit on its own is still emitted alone — it cannot be
    // made smaller, and failing at `send` records it as the failure it is
    // rather than dropping someone who is owed.
    if (current.length > 0 && (current.length >= maxPerTx || measure([...current, leaf]) > limitBytes)) {
      batches.push(current);
      current = [];
    }
    current.push(leaf);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * A transaction of `claim` instructions for a batch of leaves.
 *
 * At module scope, not inside `main`, because two paths need it: the paying
 * path (with the real submitter) and the `--keypair`-less "would send" path.
 * The measurer used to be a `const` declared after the dry-run block that
 * called it — a temporal-dead-zone ReferenceError on every dry run, invisible
 * to a suite that only exercised `packClaims` with a modelled measure.
 *
 * @param {object} context  `{ submitter: PublicKey, mint, epoch, tokenProgram }`
 */
export function claimTxBuilder({ submitter, mint, epoch, tokenProgram }) {
  return (leaves) => {
    const tx = new Transaction();
    for (const leaf of leaves) {
      tx.add(
        claimIx({
          submitter,
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
    return tx;
  };
}

/**
 * The signed size of a candidate batch, for `packClaims`.
 *
 * `serializeMessage` needs a fee payer and a blockhash; neither affects the
 * length, so any 32-byte key does — which is what lets the dry run measure
 * without a keypair. One signature is added back because the submitter is the
 * only signer.
 */
export function claimTxMeasurer(context) {
  const build = claimTxBuilder(context);
  return (leaves) => {
    const tx = build(leaves);
    tx.feePayer = context.submitter;
    tx.recentBlockhash = PublicKey.default.toBase58();
    return tx.serializeMessage().length + 1 + 64;
  };
}

/**
 * `CallpoolError::BelowMinHold` — 6014, which the RPC reports in hex.
 *
 * A recipient who sold below the floor between the snapshot and the payout is
 * refused by `claim` on purpose (§4.5). That is the mechanic working, not a
 * fault, and it must not make a scheduled airdrop look broken — the leaf simply
 * stays claimable until the deadline.
 */
const BELOW_MIN_HOLD_HEX = '0x177e';

/** Is this failure the mechanic refusing, rather than something going wrong? */
export function isPolicyRefusal(message = '') {
  return message.toLowerCase().includes(BELOW_MIN_HOLD_HEX);
}

/** A one-line reason, with the expected refusal named rather than dumped. */
export function describeFailure(message = '') {
  return isPolicyRefusal(message)
    ? 'refused: holds less than min_hold — sold since the snapshot (§4.5), still claimable'
    : message;
}

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.epoch === undefined) throw new Error('--epoch is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = Number(args.epoch);
  const connection = connect(args.rpc);

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
    const wouldMeasure = claimTxMeasurer({ submitter: PublicKey.default, mint, epoch, tokenProgram });
    console.log(
      `\n${packClaims(outstanding, wouldMeasure).length} transaction(s). ` +
        'Anyone can send these — the destination is inside the leaf.\n',
    );
    return;
  }

  const submitter = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(resolve(args.keypair), 'utf8'))),
  );
  console.log(`submitter  ${submitter.publicKey.toBase58()} (pays gas, controls nothing)\n`);

  const txContext = { submitter: submitter.publicKey, mint, epoch, tokenProgram };
  const buildTx = claimTxBuilder(txContext);
  const measure = claimTxMeasurer(txContext);

  const send = async (leaves) =>
    sendAndConfirmTransaction(connection, buildTx(leaves), [submitter], { commitment: 'confirmed' });

  const sent = [];
  const failed = [];
  for (const batch of packClaims(outstanding, measure)) {
    try {
      const signature = await send(batch);
      sent.push({ signature, leaves: batch.map((l) => l.index) });
      console.log(`  ✔ ${batch.length} leaf/leaves  ${signature}`);
      continue;
    } catch (error) {
      if (batch.length === 1) {
        const only = batch[0];
        failed.push({ leaves: [only.index], error: error.message, policy: isPolicyRefusal(error.message) });
        console.log(`  ✘ ${only.index}  ${describeFailure(error.message)}`);
        continue;
      }
      // **A transaction is all or nothing.** One refused claim reverts every
      // other claim beside it, so a single holder who sold below the floor
      // costs their whole batch its payout — four other people, in silence,
      // for someone else's sale. Observed on the devnet rehearsal at epoch 2.
      //
      // Retrying one at a time is what keeps a refusal the refused holder's
      // own. It costs one extra transaction per affected batch, which is
      // nothing next to not paying people who are owed.
      console.log(
        `  ↻ ${batch.map((l) => l.index).join(', ')}  batch reverted — retrying one at a time`,
      );
    }

    for (const leaf of batch) {
      try {
        const signature = await send([leaf]);
        sent.push({ signature, leaves: [leaf.index] });
        console.log(`  ✔ ${leaf.index}  ${signature}`);
      } catch (error) {
        failed.push({ leaves: [leaf.index], error: error.message, policy: isPolicyRefusal(error.message) });
        console.log(`  ✘ ${leaf.index}  ${describeFailure(error.message)}`);
      }
    }
  }

  // Appended, never overwritten. See `mergeAirdropRuns`.
  const recordPath = resolve(snapshotDir(epoch), 'airdrop.json');
  const existing = existsSync(recordPath) ? readJson(recordPath) : null;
  writeJson(
    recordPath,
    mergeAirdropRuns(existing, {
      ranAt: now,
      submitter: submitter.publicKey.toBase58(),
      sent,
      failed,
    }),
  );

  // airdrop.json did not exist when the snapshot wrote its index, so the
  // listing is now one file short of the truth.
  writeSnapshotIndex(snapshotDir(epoch), { epoch });

  console.log(`\n${sent.length} transaction(s) sent, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log('Failed leaves stay claimable by anyone until the 30-epoch deadline.');
  }

  // A holder who sold is the mechanic working, and the run is a success. Any
  // other failure is a payout that was owed and did not happen, and this
  // process is the only thing that knows — it used to print the word "failed"
  // and exit 0, so the crank saw success and an unattended run never alerted.
  // Phase 09 §9.3: alert on the absence of a completed airdrop.
  const unexplained = failed.filter((entry) => !entry.policy);
  if (unexplained.length > 0) {
    console.log(
      `\n${unexplained.length} leaf/leaves failed for reasons that are NOT the min-hold rule. ` +
        'Money is owed and unsent.\n',
    );
    process.exitCode = 1;
    return;
  }
  console.log('');
}

/**
 * Fold one run into the epoch's airdrop record, keeping every earlier run.
 *
 * This used to overwrite. The reader who needs this file most is whoever is
 * recovering from a partial run — and overwriting erased exactly the run they
 * were recovering from, along with the signatures proving what *had* been
 * delivered. A record of a scheduled job that deletes its own failures is not
 * evidence of anything.
 *
 * The newest run is also flattened onto the top level, so `ranAt` / `sent` /
 * `failed` still mean what they always did to anything already reading them.
 *
 * @param {object|null} existing  the parsed airdrop.json, or null on a first run
 * @param {object} run            `{ ranAt, submitter, sent, failed }`
 */
export function mergeAirdropRuns(existing, run) {
  const previous = existing?.runs
    ? existing.runs
    : // Written before `runs` existed: one run, flattened at the top level.
      existing?.ranAt !== undefined
      ? [{ ranAt: existing.ranAt, submitter: existing.submitter, sent: existing.sent, failed: existing.failed }]
      : [];

  return { ...existing, ...run, runs: [...previous, run] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
