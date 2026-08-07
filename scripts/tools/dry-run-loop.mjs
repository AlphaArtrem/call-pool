#!/usr/bin/env node
//
// scripts/tools/dry-run-loop.mjs — the whole mainnet cycle, every five minutes.
//
// Waits for an epoch to close, sweeps the stand-in creator vault into the pool,
// cranks the epoch, waits out the challenge window, pays, and seeds the next
// epoch's callouts. Then does it again.
//
//   node scripts/tools/dry-run-loop.mjs
//   node scripts/tools/dry-run-loop.mjs --epochs 12
//   node scripts/tools/dry-run-loop.mjs --no-schedule   # no sales, spam or gaps
//
//   # against a deployment whose snapshot key is a Squads vault — mainnet's shape
//   node scripts/tools/dry-run-loop.mjs --multisig <ADDRESS> --signer <MEMBER_KEY>
//
// **It prints what it skipped and why.** A loop that silently stops settling
// looks exactly like a working loop from the outside, and that is the failure
// Phase 09 §9.3 is about — the thing most likely to kill this project is not a
// hack, it is the crank quietly stopping. Every epoch ends up in the ledger
// this prints, settled or not, with a reason.
//
// Everything it writes goes under `epochs/devnet/`: the fabricated callout
// store, and the snapshot directories (via `CALLPOOL_SNAPSHOTS_DIR`). The
// public audit trail in `snapshots/` is never touched, because a fake epoch
// left in the audit trail is worse than no audit trail.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';

import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { iso } from '../lib/epoch.mjs';
import { fetchConfig, fetchEpoch, windowForEpoch } from '../lib/program.mjs';
import { REPO_ROOT } from '../lib/store.mjs';
import { assertNotMainnet, DEVNET_DIR, DEVNET_STORE_PATH, readManifest } from './devnet.mjs';

/**
 * Where the rehearsal's snapshot directories go.
 *
 * Relative, because `SNAPSHOTS_DIR` resolves it against the repository root in
 * every child process.
 */
const SNAPSHOTS_SUBDIR = 'epochs/devnet/snapshots';

/**
 * The states nothing else in the rehearsal would produce, on a timer.
 *
 * Keyed by how many epochs into the run we are, so the whole checklist happens
 * unattended inside half an hour. `--no-schedule` turns it off; each entry can
 * also be moved with its own flag.
 */
const SCHEDULE = {
  1: { sell: 'dumper' },
  2: { spam: 'steady' },
  3: { silent: true },
  4: { skip: true },
};

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, schedule: true, accrue: '0.05' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-schedule') args.schedule = false;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.multisig && !args.signer) {
    throw new Error('--multisig <ADDRESS> needs --signer <PATH>: this host\'s multisig member key');
  }
  return args;
}

/**
 * How the loop's crank signs — and it is not always a snapshot key.
 *
 * A deployment made with `--snapshot-key <vault>` has no snapshot keypair
 * anywhere, so `manifest.snapshotKey.keypair` is null and the loop must post
 * through the multisig instead. Reading it blindly is how a rehearsal in
 * mainnet's own shape ends up passing `--keypair null`.
 */
function postingArgs(args, manifest) {
  if (args.multisig) return ['--multisig', args.multisig, '--keypair', args.signer];
  if (!manifest.snapshotKey.keypair) {
    throw new Error(
      `this deployment's snapshot key ${manifest.snapshotKey.address} is external — a multisig ` +
        'vault, with no keypair here. Pass --multisig <ADDRESS> --signer <PATH>.',
    );
  }
  return ['--keypair', manifest.snapshotKey.keypair];
}

/**
 * Where an epoch's carry ledger lives — its absence means that epoch never settled.
 *
 * Built from `SNAPSHOTS_SUBDIR` rather than `snapshotDir()`, because
 * `CALLPOOL_SNAPSHOTS_DIR` is set on the **children** and not on this process:
 * asking `store.mjs` here would resolve to the public `snapshots/` tree, find
 * nothing ever, and pass `--carry-reset` on every single epoch — turning the
 * guard off while looking like it was on.
 */
const carryLedgerFor = (epoch) =>
  resolve(REPO_ROOT, SNAPSHOTS_SUBDIR, `epoch-${epoch}`, 'carry.json');

/** Run one of our own scripts as a child process, the way a scheduler would. */
function run(script, scriptArgs) {
  const command = `node ${script} ${scriptArgs.join(' ')}`;
  console.log(`\n$ ${command}\n`);
  const result = spawnSync('node', [resolve(REPO_ROOT, script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, CALLPOOL_SNAPSHOTS_DIR: SNAPSHOTS_SUBDIR },
  });
  return { ok: result.status === 0, status: result.status, command };
}

/** The cluster's clock, which is the only one `claim` and `post_root` compare against. */
async function chainNow(connection) {
  const slot = await connection.getSlot('confirmed');
  const now = await connection.getBlockTime(slot);
  if (now == null) throw new Error(`the RPC returned no block time for slot ${slot}`);
  return now;
}

async function waitUntil(connection, target, what) {
  let announced = false;
  for (;;) {
    const now = await chainNow(connection);
    if (now >= target) return now;
    if (!announced) {
      console.log(`\n⏳ ${what} at ${iso(target)} — ${target - now}s away`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'dry-run-loop.mjs');

  const manifest = readManifest();
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const limit = args.epochs === undefined ? Infinity : Number(args.epochs);

  console.log('\nCALLPOOL — the devnet dry run\n');
  console.log(`cluster    ${args.rpc}`);
  console.log(`mint       ${mint}`);
  console.log(`epochs     ${config.epochSeconds}s, challenge window ${config.challengeSeconds}s`);
  console.log(`store      ${DEVNET_STORE_PATH}`);
  console.log(`snapshots  ${resolve(REPO_ROOT, SNAPSHOTS_SUBDIR)}`);
  console.log(`working    ${DEVNET_DIR}\n`);

  const ledger = [];
  const record = (epoch, outcome, why = '') => {
    ledger.push({ epoch, outcome, why });
    console.log(`\n▪ epoch ${epoch}: ${outcome}${why ? ` — ${why}` : ''}`);
  };
  const report = () => {
    console.log('\n── the run so far ──────────────────────────────────────────');
    for (const entry of ledger) {
      console.log(
        `  epoch ${String(entry.epoch).padStart(4)}  ${entry.outcome.padEnd(12)}${entry.why}`,
      );
    }
    console.log('');
  };

  // Seed the epoch that is open right now, so the first settlement has callers.
  let epoch = Math.max(
    manifest.startEpoch,
    Math.floor(((await chainNow(connection)) - config.genesisTs) / config.epochSeconds),
  );
  seed(epoch, manifest, args, record);

  let settled = 0;

  while (settled < limit) {
    const window = windowForEpoch(config, epoch);
    const plan = args.schedule ? (SCHEDULE[epoch - manifest.startEpoch] ?? {}) : {};

    // Mid-epoch events, while the window is still open and a sale can still
    // collapse the trough it is meant to collapse.
    if (plan.sell) {
      await waitUntil(connection, window.start + Math.floor(config.epochSeconds / 2), 'mid-epoch sale');
      const sold = run('scripts/tools/mock-sale.mjs', ['--wallet', plan.sell, '--rpc', args.rpc]);
      if (!sold.ok) console.log(`\n⚠️  ${plan.sell} did not sell — the lockout will not be rehearsed`);
    }
    if (plan.spam) {
      const flagged = run('scripts/tools/mock-callouts.mjs', [
        '--epoch', String(epoch), '--spam', plan.spam, '--rpc', args.rpc,
      ]);
      if (!flagged.ok) console.log(`\n⚠️  could not flag ${plan.spam} — it will settle as counted`);
    }

    await waitUntil(connection, window.end + 2, `epoch ${epoch} closes`);

    // Fees accrue during the epoch and the sweep runs immediately before the
    // pool is read, which is the order step 0 has on mainnet.
    run('scripts/tools/mock-fees.mjs', ['--accrue', args.accrue, '--sweep', '--rpc', args.rpc]);

    if (plan.skip) {
      // Deliberately unsettled, to produce the "not posted" row the epoch table
      // goes out of its way to show. On mainnet this must never happen: it
      // leaves the posting window open forever, and any dust carried into it is
      // dropped rather than credited — the money stays in the pool, but the
      // per-wallet credit does not survive.
      record(epoch, 'SKIPPED', 'on purpose, to render a "not posted" row');
    } else {
      // An epoch that never settled leaves no carry ledger where the next epoch
      // expects its predecessor's. The crank now refuses to guess rather than
      // silently restarting the chain — right on mainnet, and it would end an
      // unattended rehearsal at 2 a.m.
      //
      // Asking the filesystem covers all three cases with one rule: the
      // deliberate SKIP at offset 4, a crank that died before writing its
      // snapshot, and the **first epoch of any run** — the loop starts at
      // epoch 1 while `deploy-devnet.mjs` leaves epoch 0 unsettled, so there has
      // never been an epoch-0 ledger to inherit. That last one is why this is
      // `epoch > 0` and not `epoch > manifest.startEpoch`: the first epoch of a
      // rehearsal is precisely the one with no predecessor.
      const restarting = epoch > 0 && !existsSync(carryLedgerFor(epoch - 1));
      if (restarting) {
        console.log(
          `\n⚠️  epoch ${epoch - 1} left no carry ledger, so it never settled.\n` +
            `    Passing --carry-reset to epoch ${epoch}: any dust carried into it is\n` +
            '    forfeited. On mainnet this is a decision a human makes deliberately;\n' +
            '    here it is what keeps an unattended rehearsal running.',
        );
      }

      const cranked = run('scripts/crank.mjs', [
        '--epoch', String(epoch),
        '--rpc', args.rpc,
        ...postingArgs(args, manifest),
        '--payer', manifest.payer.keypair,
        '--store', DEVNET_STORE_PATH,
        '--and-pay',
        ...(restarting ? ['--carry-reset'] : []),
      ]);

      const onChain = cranked.ok ? await fetchEpoch(connection, mint, epoch) : null;

      if (onChain) {
        record(
          epoch,
          'settled',
          `root ${onChain.root.toString('hex').slice(0, 12)}…, ${onChain.claimedLamports} lamports claimed`,
        );
        settled += 1;
      } else if (cranked.ok) {
        // The crank exited 0 and there is still no root. `crank.mjs` now checks
        // this itself and should have thrown, so reaching here means something
        // upstream lied — which is exactly the reason not to record it as a
        // settlement on the strength of an exit code. This ledger's job is to
        // count roots, not happy children.
        record(epoch, 'FAILED', 'crank exited 0 but no epoch account exists — nothing settled');
      } else {
        // Not fatal, and not swallowed either. The next epoch is independent,
        // and a root can still be posted for this one later — that is exactly
        // why it goes in the ledger with a reason instead of stopping the run.
        record(epoch, 'FAILED', `crank exited ${cranked.status} — see the output above`);
      }
    }

    epoch += 1;
    seed(epoch, manifest, args, record);
    report();
  }

  console.log(`\n${settled} epoch(s) settled. Stopping because --epochs ${limit} was reached.\n`);
}

/** Write the next epoch's callouts, or record why that epoch will be empty. */
function seed(epoch, manifest, args, record) {
  const plan = args.schedule ? (SCHEDULE[epoch - manifest.startEpoch] ?? {}) : {};
  const seeded = run('scripts/tools/mock-callouts.mjs', [
    '--epoch', String(epoch),
    '--rpc', args.rpc,
    ...(plan.silent ? ['--silent'] : []),
  ]);
  if (plan.silent) {
    console.log(`\nepoch ${epoch} is a deliberate silence — it must settle to a zeroed root (L3/D7).`);
  }
  if (!seeded.ok) {
    record(epoch, 'unseeded', 'mock-callouts failed, so this epoch will have no callers');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nDRY RUN STOPPED: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
