#!/usr/bin/env node
//
// scripts/crank.mjs — one epoch, end to end.
//
// The thing most likely to kill this project is not a hack. It is **the crank
// quietly stopping** — a cron job dying with the laptop it ran on, an API path
// changing, and epoch 6 never settling while fees keep accruing and holders
// keep calling. Everything here is arranged to make that failure loud.
//
// Two rules it follows without exception:
//
//   * **Publish before posting.** The inputs must be timestamped ahead of the
//     root, or the challenge window is decoration.
//   * **Post a root for every epoch, including empty ones** (L3/D7). "Nobody
//     called" is a reason for the root to be zeroed, never a reason to skip the
//     transaction.
//
// Usage:
//   node scripts/crank.mjs --day 2026-08-04 --keypair <SNAPSHOT_KEY>
//   node scripts/crank.mjs --epoch 7 --keypair <SNAPSHOT_KEY>   # by chain index
//   node scripts/crank.mjs --day 2026-08-04 --dry-run     # print the plan
//
// `--day` is the mainnet ergonomic: one epoch is one UTC day, and a human
// refers to it by date. `--epoch N` addresses the on-chain index instead and is
// the only way to reach an epoch that is not a calendar day — a rehearsal
// running 300-second epochs has 288 of them per date. Both resolve through the
// on-chain genesis, and `initialize`'s alignment check is what lets them agree.
//
// The airdrop is normally a **separate invocation**, because it runs after the
// challenge window closes — typically a day later. Run it from its own schedule
// and alert on the absence of a completed one (Phase 09 §9.3). `--and-pay`
// collapses the two into one command by waiting the window out in-process,
// which is only sensible when that window is seconds rather than a day.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Connection } from '@solana/web3.js';

import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { iso, windowForDay } from './lib/epoch.mjs';
import { epochIndexFor, fetchConfig, fetchEpoch, windowForEpoch } from './lib/program.mjs';
import { REPO_ROOT, snapshotDir } from './lib/store.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false, andPay: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--and-pay') args.andPay = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.day && args.epoch !== undefined) {
    throw new Error('--day and --epoch address the same thing; pass one of them');
  }
  // Yesterday, in UTC — the epoch that most recently closed on a daily clock.
  // Only a default when nothing was asked for: `--epoch 0` is a real request.
  if (!args.day && args.epoch === undefined) {
    args.day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  }
  if (args.andPay && !args.payer) {
    throw new Error(
      '--and-pay needs --payer <PATH>: the airdrop is submitted by a wallet that pays gas ' +
        'and controls nothing, which must not be the snapshot key.',
    );
  }
  return args;
}

/** Resolve however the epoch was addressed into one window and one index. */
function resolveTarget(args, config) {
  if (args.day) {
    const window = windowForDay(args.day);
    return { window, epoch: epochIndexFor(window.start, config), label: `${args.day} (UTC)` };
  }
  const epoch = Number(args.epoch);
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`--epoch must be a non-negative integer, got ${JSON.stringify(args.epoch)}`);
  }
  const window = windowForEpoch(config, epoch);
  return { window, epoch, label: `${iso(window.start)} → ${iso(window.end)}` };
}

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

function run(script, scriptArgs, { dryRun }) {
  const command = `node scripts/${script} ${scriptArgs.join(' ')}`;
  if (dryRun) {
    console.log(`  would run: ${command}`);
    return { status: 0 };
  }
  console.log(`\n$ ${command}\n`);
  return spawnSync('node', [resolve(REPO_ROOT, 'scripts', script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, 'confirmed');
  const config = await fetchConfig(connection);
  const { window, epoch, label } = resolveTarget(args, config);

  console.log(`\nCALLPOOL — crank for ${label}, epoch ${epoch}\n`);

  const now = Math.floor(Date.now() / 1000);
  if (now < window.end) {
    throw new Error(
      `epoch ${epoch} has not ended yet (${new Date(window.end * 1000).toISOString()}). ` +
        'The program refuses an early root, and so does this.',
    );
  }

  const existing = await fetchEpoch(connection, config.mint, epoch);
  if (existing) {
    console.log(`Already settled: root ${existing.root.toString('hex')}`);
    console.log('Roots are write-once. If it is wrong, corrections go forward.\n');
    // Not a reason to skip the payout: a run that posted the root and then died
    // leaves exactly this state, and the money is still owed.
    if (args.andPay) await pay(connection, config, epoch, existing, args);
    return;
  }

  // Step 0 — the fee sweep — belongs immediately before the pool is read, but
  // it needs pump.fun's own instructions and is not implemented here yet. It is
  // permissionless and anyone can run it, so a missed sweep costs a day's fees
  // rolling forward rather than being lost.
  console.log('step 0   sweep — NOT AUTOMATED YET (see Phase 03 / devnet proofs 1, 3, 12b).');
  console.log('         Anything still in pump\'s creator_vault rolls into the next epoch.\n');

  // Addressed downstream exactly as it was addressed here. `--day` is not
  // interchangeable with `--epoch` inside snapshot.mjs: only the day carries the
  // date the truncation records are keyed on.
  const snapshotArgs = args.day ? ['--day', args.day] : ['--epoch', String(epoch)];
  if (args.store) snapshotArgs.push('--store', args.store);
  const snapshot = run('snapshot.mjs', [...snapshotArgs, '--rpc', args.rpc], args);
  if (snapshot.status !== 0) throw new Error('snapshot failed — nothing was posted');

  const dir = snapshotDir(epoch);
  const empty = !args.dryRun && !existsSync(resolve(dir, 'tree.json'));

  // The independent check runs before the root is posted, not after. Catching a
  // bad root afterwards is a press release; catching it here is a fix.
  const verified = run(
    'verify-epoch.mjs',
    ['--epoch', String(epoch), '--rpc', args.rpc, '--recheck-chain', '--allow-unposted'],
    args,
  );
  if (verified.status !== 0) throw new Error('the snapshot does not reproduce — nothing was posted');

  console.log('\n⏸  Publish snapshots/epoch-' + epoch + '/ now, before posting the root.');
  console.log('   The challenge window is only meaningful if the inputs came first.\n');

  const postArgs = ['--epoch', String(epoch), '--rpc', args.rpc];
  if (empty) postArgs.push('--empty');
  if (args.keypair) postArgs.push('--keypair', args.keypair, '--yes');
  const posted = run('post-root.mjs', postArgs, args);
  if (posted.status !== 0) throw new Error('post-root failed');

  if (args.andPay) {
    const onChain = args.dryRun ? null : await fetchEpoch(connection, config.mint, epoch);
    await pay(connection, config, epoch, onChain, args);
    return;
  }

  console.log('\nSettled. The airdrop runs separately, after the challenge window:');
  console.log(`  node scripts/airdrop.mjs --epoch ${epoch} --keypair <PAYER>\n`);
}

/**
 * Wait the challenge window out, then pay.
 *
 * Only worth doing in-process when the window is seconds long, which is why it
 * is opt-in. On mainnet it would mean holding a process open for a day, and a
 * process held open for a day is a crank that stops when the laptop sleeps.
 *
 * The wait is computed from `posted_ts` on chain rather than from local time,
 * because `claim` compares against the cluster's clock and that is the only
 * clock that decides whether the transaction lands.
 */
async function pay(connection, config, epoch, onChain, args) {
  if (args.dryRun) {
    console.log(`  would wait ${config.challengeSeconds}s, then run airdrop.mjs --epoch ${epoch}`);
    return;
  }
  if (!onChain) throw new Error(`epoch ${epoch} has no root on chain — nothing to pay`);

  const opensAt = onChain.postedTs + config.challengeSeconds;
  const waitFor = opensAt - Math.floor(Date.now() / 1000);
  if (waitFor > 0) {
    console.log(`\n⏳ the challenge window closes at ${iso(opensAt)} — waiting ${waitFor}s\n`);
    // A second of slack: the cluster's clock and this one are not the same, and
    // being one second early costs a whole extra run.
    await sleep(waitFor + 1);
  }

  const paid = run('airdrop.mjs', ['--epoch', String(epoch), '--rpc', args.rpc, '--keypair', args.payer], args);
  if (paid.status !== 0) throw new Error(`the root for epoch ${epoch} is posted, but the airdrop failed`);
  console.log(`\nEpoch ${epoch} settled and paid.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nCRANK FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
