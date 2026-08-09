#!/usr/bin/env node
//
// scripts/tools/settle-outstanding.mjs — settle whatever the chain says is
// owed, not "the epoch that just closed".
//
// Why this exists: `crank.mjs` settles exactly one epoch per invocation, and
// the carry chain — correctly — refuses to skip a predecessor. Put together,
// one transient failure (an RPC blip, a slow co-signer, a restart mid-flight)
// wedged every subsequent epoch permanently: the timer would fire, compute
// "the epoch that just closed", try N+1, fail on N's missing carry ledger, and
// do that forever. Nothing ever went back for N. Both rehearsals ended that
// way, with a human running the catch-up by hand.
//
// So this is what the timer runs instead. It asks the chain which closed
// epochs have no root — the same question the co-signer and the watchdog
// already ask — and cranks them oldest first, stopping at the first failure.
// There is no epoch arithmetic here to get wrong: the bespoke wrapper that
// computed "the epoch that just closed" from the manifest is exactly the thing
// this replaces.
//
//   node scripts/tools/settle-outstanding.mjs \
//     --multisig <ADDRESS> --keypair <SIGNER_A> --payer <GAS_WALLET> \
//     [--lookback 50] [--max 5] [--store epochs/devnet/callout-store.json]
//
// Every argument other than `--lookback` and `--max` is handed to `crank.mjs`
// unchanged, so the epochs a catch-up settles are settled exactly the way the
// timer would have settled them one at a time.
//
// Three rules that matter more than the code:
//
//   * **Oldest first, always.** Settling a later epoch first builds it against
//     a carry ledger that does not exist yet.
//   * **Stop on failure, never skip.** Every later epoch needs this one's
//     carry ledger; skipping is what produces a silent hole in the audit trail.
//   * **Never `--carry-reset`.** It forfeits real balances owed to real
//     wallets. If a gap is genuinely unsettleable, a human decides — the
//     watchdog's `stale` alert is what escalates that.
//
// The watchdog is unchanged and is still the thing that notices if this stalls.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { fetchConfig, fetchEpoch } from '../lib/program.mjs';
import { REPO_ROOT } from '../lib/store.mjs';
import { epochAt, outstandingEpochs } from './cosign-remote.mjs';

/** Epochs to look back over, by default — matches the watchdog's horizon. */
const DEFAULT_LOOKBACK = 50;

/** The most epochs one tick will settle, so a backlog cannot run for an hour. */
const DEFAULT_MAX = 5;

export function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false, andPay: false, lookback: DEFAULT_LOOKBACK, max: DEFAULT_MAX };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--carry-reset') {
      // The one argument this tool must never forward, so it does not accept
      // it at all. A reset forfeits carried balances owed to real wallets;
      // that is a human's call, made deliberately, on crank.mjs directly.
      throw new Error(
        '--carry-reset is refused here by design. If an epoch is genuinely unsettleable, ' +
          'a human runs `crank.mjs --epoch N --carry-reset` and owns the forfeiture.',
      );
    } else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--and-pay') args.andPay = true;
    // Named explicitly: the generic branch would store these under their
    // hyphenated names and the values would silently never be read.
    else if (argv[i] === '--await-root') args.awaitRoot = Number(argv[++i]);
    else if (argv[i] === '--callout-base') args.calloutBase = argv[++i];
    else if (argv[i] === '--lookback') args.lookback = Number(argv[++i]);
    else if (argv[i] === '--max') args.max = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair && !args.dryRun) {
    throw new Error(
      '--keypair <PATH> is required: the snapshot key for a single-signer setup, or ' +
        "this host's multisig member key alongside --multisig <ADDRESS>.",
    );
  }
  for (const name of ['lookback', 'max']) {
    if (!Number.isInteger(args[name]) || args[name] < 1) {
      throw new Error(`--${name} must be a positive integer, got ${args[name]}`);
    }
  }
  return args;
}

/**
 * The crank invocation for one epoch — the same arguments the timer used,
 * with only the epoch varying across a catch-up run.
 */
export function crankArgs(epoch, args) {
  return [
    '--epoch', String(epoch),
    '--rpc', args.rpc,
    ...(args.keypair ? ['--keypair', args.keypair] : []),
    ...(args.multisig ? ['--multisig', args.multisig] : []),
    ...(args.payer ? ['--payer', args.payer] : []),
    ...(args.store ? ['--store', args.store] : []),
    // Forwarded so a truncated feed can still settle (L5). Without it the
    // snapshot refuses, this stops at the first failure — correctly — and every
    // later epoch waits behind it.
    ...(args.holders ? ['--holders', args.holders] : []),
    // Forwarded so the truncation fallback talks to mock-pump-api.mjs on a
    // rehearsal instead of the real pump host, which has no devnet surface.
    // Without this the fallback resolves every devnet wallet to "no pump
    // account" and recovers nothing — which the store papers over (it is never
    // really capped), so the path settles while testing nothing. Never set on
    // mainnet: there it would mean settling real money from a mock.
    ...(args.calloutBase ? ['--callout-base', args.calloutBase] : []),
    ...(args.awaitRoot !== undefined ? ['--await-root', String(args.awaitRoot)] : []),
    ...(args.andPay ? ['--and-pay'] : []),
    ...(args.dryRun ? ['--dry-run'] : []),
  ];
}

/**
 * Crank each outstanding epoch, oldest first, up to `max` of them.
 *
 * A failure stops the run rather than moving on: the chain is ordered, and
 * every later epoch needs this one's carry ledger. Continuing would either
 * fail the same way N more times or — worse — settle a later epoch against a
 * predecessor that never existed.
 */
export async function settleOutstanding({ epochs, max, runCrank, log = console.log }) {
  const chosen = epochs.slice(0, max);
  if (epochs.length > max) {
    log(`settling ${max} of ${epochs.length} outstanding epochs this tick; the rest wait for the next one.`);
  }
  const settled = [];
  for (const epoch of chosen) {
    const result = runCrank(epoch);
    if (result.status !== 0) {
      throw new Error(
        `crank.mjs exited ${result.status} for epoch ${epoch} — stopping here. ` +
          `Later epochs need epoch ${epoch}'s carry ledger, so nothing after it was attempted.`,
      );
    }
    settled.push(epoch);
  }
  return { settled, remaining: epochs.length - chosen.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const mint = config.mint;

  const current = epochAt(Math.floor(Date.now() / 1000), config);
  const epochs = await outstandingEpochs({
    current,
    lookback: args.lookback,
    hasRoot: async (epoch) => (await fetchEpoch(connection, mint, epoch)) != null,
  });

  if (epochs.length === 0) {
    // The normal tick. One line, exit 0, nothing else to say.
    console.log(`nothing outstanding in the last ${args.lookback} epochs (current ${current}).`);
    return;
  }

  console.log(`\nCALLPOOL — settle outstanding\n`);
  console.log(`current epoch  ${current}`);
  console.log(`outstanding    ${epochs.join(', ')}\n`);

  const { settled, remaining } = await settleOutstanding({
    epochs,
    max: args.max,
    runCrank: (epoch) =>
      spawnSync('node', [resolve(REPO_ROOT, 'scripts/crank.mjs'), ...crankArgs(epoch, args)], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      }),
  });

  console.log(`\nsettled ${settled.length} epoch(s): ${settled.join(', ')}`);
  if (remaining > 0) console.log(`${remaining} still outstanding — the next tick continues from there.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nSETTLE OUTSTANDING FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
