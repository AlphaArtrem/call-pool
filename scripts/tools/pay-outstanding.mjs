#!/usr/bin/env node
//
// scripts/tools/pay-outstanding.mjs — pay every epoch whose challenge window
// has closed and whose leaves are not all claimed.
//
// Why this exists: `airdrop.mjs` needs `--epoch N`, and on a daily clock
// nothing knows what N is. The rehearsals hid that behind `crank --and-pay`,
// which waits the challenge window out *in-process* — fine for 60 seconds and
// absurd for 24 hours, since it means a process held open for a day and a
// crank that dies when the host reboots. So mainnet runs the airdrop on its
// own timer, and this is what that timer runs.
//
//   node scripts/tools/pay-outstanding.mjs --keypair <GAS_WALLET> \
//     [--lookback 40] [--max 5] [--grace 60]
//
// `--keypair` is the **gas-only payer** and nothing else. `claim` takes no
// signature from the recipient and its destination is fixed inside the merkle
// leaf, so this wallet is a submitter with no authority — it must never be the
// snapshot key or a multisig member key. Anyone can run this; a holder who
// distrusts our bot can submit the same instructions themselves.
//
// **It continues past a failure, and that is the opposite of
// `settle-outstanding` on purpose.** Settlement is a chain: epoch N+1 is built
// on N's carry ledger, so stopping at the first failure is what stops a silent
// hole. Airdrops are independent — one epoch failing to pay says nothing about
// the next — so stopping early would strand money that was ready to send.
//
// **Re-running is safe by construction.** Claims are write-once on chain, so a
// leaf already paid is refused by the program rather than paid twice, and
// `airdrop.mjs` skips what it can already see is claimed. That is what lets
// this run on a timer without any state of its own.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { fetchConfig, fetchEpoch } from '../lib/program.mjs';
import { REPO_ROOT } from '../lib/store.mjs';
import { epochAt } from './cosign-remote.mjs';

/** Epochs to look back over. Beyond the claim deadline there is nothing to send. */
const DEFAULT_LOOKBACK = 40;

/** The most epochs one tick will pay, so a backlog cannot run for an hour. */
const DEFAULT_MAX = 5;

/**
 * Seconds to wait past the challenge window before trying.
 *
 * `claim` compares against the cluster's clock, not ours. A tick that fires the
 * instant the window closes can be a second early by that clock and comes back
 * `ChallengeWindowOpen`, which reads as a fault and is not one.
 */
const DEFAULT_GRACE = 60;

/** After this many epochs the unclaimed remainder goes back to the pool (D5). */
export const CLAIM_DEADLINE_EPOCHS = 30;

export function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    dryRun: false,
    lookback: DEFAULT_LOOKBACK,
    max: DEFAULT_MAX,
    grace: DEFAULT_GRACE,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    // Named explicitly: the generic branch would store these hyphenated and
    // the values would silently never be read.
    else if (argv[i] === '--lookback') args.lookback = Number(argv[++i]);
    else if (argv[i] === '--max') args.max = Number(argv[++i]);
    else if (argv[i] === '--grace') args.grace = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair && !args.dryRun) {
    throw new Error(
      '--keypair <PATH> is required: the gas-only wallet that submits claims. It controls ' +
        'nothing — the destination is fixed inside the merkle leaf — and it must never be ' +
        'the snapshot key or a multisig member key.',
    );
  }
  for (const name of ['lookback', 'max']) {
    if (!Number.isInteger(args[name]) || args[name] < 1) {
      throw new Error(`--${name} must be a positive integer, got ${args[name]}`);
    }
  }
  if (!Number.isFinite(args.grace) || args.grace < 0) {
    throw new Error(`--grace must be a non-negative number of seconds, got ${args.grace}`);
  }
  return args;
}

/**
 * Epochs that can be paid right now, oldest first.
 *
 * Four conditions, and each excludes a different mistake:
 *
 *   * a root exists — an unsettled epoch is `settle-outstanding`'s business;
 *   * the challenge window has closed, plus grace — the program refuses
 *     earlier, and being refused is not information;
 *   * something is actually outstanding (`claimed < allocated`), which catches
 *     a *partly* paid epoch as well as an untouched one;
 *   * the claim deadline has not passed — after it the remainder belongs to
 *     the pool again and sending is not ours to do.
 *
 * `readEpoch` is injected so this is testable without a chain.
 */
export async function payableEpochs({ now, current, lookback, graceSeconds, config, readEpoch }) {
  const oldest = Math.max(0, current - lookback);
  const epochSeconds = Number(config.epochSeconds);
  const challengeSeconds = Number(config.challengeSeconds);
  const payable = [];

  for (let epoch = oldest; epoch < current; epoch++) {
    const account = await readEpoch(epoch);
    if (!account) continue;

    const opensAt = account.postedTs + challengeSeconds;
    if (now < opensAt + graceSeconds) continue;

    const deadline = account.postedTs + CLAIM_DEADLINE_EPOCHS * epochSeconds;
    if (now >= deadline) continue;

    if (account.claimedLamports >= account.poolLamports) continue;

    payable.push({
      epoch,
      allocated: account.poolLamports,
      claimed: account.claimedLamports,
    });
  }
  return payable;
}

/**
 * Pay each epoch, oldest first, continuing past failures.
 *
 * Oldest first because an older epoch is nearer its claim deadline, and that
 * deadline is the only thing here that expires.
 */
export async function payOutstanding({ epochs, max, runAirdrop, log = console.log }) {
  const chosen = epochs.slice(0, max);
  if (epochs.length > max) {
    log(`paying ${max} of ${epochs.length} outstanding epochs this tick; the rest wait for the next one.`);
  }

  const paid = [];
  const failed = [];
  for (const { epoch } of chosen) {
    const result = runAirdrop(epoch);
    if (result.status === 0) paid.push(epoch);
    else {
      // Recorded and stepped over. The next epoch's leaves are unrelated to
      // this one's, and money that is ready to send should not wait behind it.
      failed.push(epoch);
      log(`epoch ${epoch}: airdrop exited ${result.status} — continuing, the rest do not depend on it.`);
    }
  }
  return { paid, failed, remaining: epochs.length - chosen.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const now = Math.floor(Date.now() / 1000);
  const current = epochAt(now, config);

  const epochs = await payableEpochs({
    now,
    current,
    lookback: args.lookback,
    graceSeconds: args.grace,
    config,
    readEpoch: (epoch) => fetchEpoch(connection, config.mint, epoch),
  });

  if (epochs.length === 0) {
    // The normal tick, most days: yesterday's epoch is still inside its
    // challenge window and everything older has been paid.
    console.log(`nothing payable in the last ${args.lookback} epochs (current ${current}).`);
    return;
  }

  console.log(`\nCALLPOOL — pay outstanding\n`);
  console.log(`current epoch  ${current}`);
  console.log(`payable        ${epochs.map((e) => e.epoch).join(', ')}\n`);

  const { paid, failed, remaining } = await payOutstanding({
    epochs,
    max: args.max,
    runAirdrop: (epoch) =>
      spawnSync(
        'node',
        [
          resolve(REPO_ROOT, 'scripts/airdrop.mjs'),
          '--epoch', String(epoch),
          '--rpc', args.rpc,
          ...(args.dryRun ? [] : ['--keypair', args.keypair]),
        ],
        { stdio: 'inherit', cwd: REPO_ROOT },
      ),
  });

  console.log(`\npaid ${paid.length} epoch(s)${paid.length ? `: ${paid.join(', ')}` : ''}`);
  if (remaining > 0) console.log(`${remaining} still outstanding — the next tick continues from there.`);

  if (failed.length > 0) {
    // Non-zero exit so the timer's failure is visible to systemd and to the
    // watchdog's `unpaid` count, which is the thing that escalates it.
    throw new Error(
      `the airdrop failed for epoch(s) ${failed.join(', ')}. Claims are write-once, so re-running ` +
        'is safe — but if this persists the money is owed and undelivered, and that is the ' +
        'failure the watchdog reports as `unpaid`.',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nPAY OUTSTANDING FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
