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
//   node scripts/crank.mjs --day 2026-08-04 --dry-run     # print the plan
//
// The airdrop is deliberately a **separate invocation**, because it runs after
// the challenge window closes — typically a day later. Run it from its own
// schedule and alert on the absence of a completed one (Phase 09 §9.3).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Connection } from '@solana/web3.js';

import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { windowForDay } from './lib/epoch.mjs';
import { epochIndexFor, fetchConfig, fetchEpoch } from './lib/program.mjs';
import { REPO_ROOT, snapshotDir } from './lib/store.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  args.day ??= new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return args;
}

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
  const window = windowForDay(args.day);
  const connection = new Connection(args.rpc, 'confirmed');
  const config = await fetchConfig(connection);
  const epoch = epochIndexFor(window.start, config);

  console.log(`\nCALLPOOL — crank for ${args.day} (UTC), epoch ${epoch}\n`);

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
    return;
  }

  // Step 0 — the fee sweep — belongs immediately before the pool is read, but
  // it needs pump.fun's own instructions and is not implemented here yet. It is
  // permissionless and anyone can run it, so a missed sweep costs a day's fees
  // rolling forward rather than being lost.
  console.log('step 0   sweep — NOT AUTOMATED YET (see Phase 03 / devnet proofs 1, 3, 12b).');
  console.log('         Anything still in pump\'s creator_vault rolls into the next epoch.\n');

  const snapshot = run('snapshot.mjs', ['--day', args.day, '--rpc', args.rpc], args);
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

  console.log('\nSettled. The airdrop runs separately, after the challenge window:');
  console.log(`  node scripts/airdrop.mjs --epoch ${epoch} --keypair <PAYER>\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nCRANK FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
