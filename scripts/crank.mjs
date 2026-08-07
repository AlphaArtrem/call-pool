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
//   node scripts/crank.mjs --epoch 7 --carry-reset        # epoch 6 never
//     settled: forfeit its carried dust and start a new carry chain. Deliberate
//     and on the record — without it a missing ledger stops the crank.
//
//   # mainnet's shape: the snapshot key is a 2-of-3 vault, not a keypair
//   node scripts/crank.mjs --day 2026-08-04 \
//     --multisig <SQUADS_ADDRESS> --keypair <THIS_HOST'S_MEMBER_KEY>
//
// With `--multisig`, `--keypair` is **this host's multisig member key**, not the
// snapshot key — nobody holds the snapshot key, because it is a vault address.
// The posting step becomes `cosign.mjs`, which reproduces the epoch and matches
// the proposal byte for byte before it approves anything.
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
import { resolve } from 'node:path';

import { connect } from './lib/rpc.mjs';

import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { iso, windowForDay } from './lib/epoch.mjs';
import { epochIndexFor, fetchConfig, fetchEpoch, windowForEpoch } from './lib/program.mjs';
import { REPO_ROOT } from './lib/store.mjs';

/** Seconds between polls while waiting for a root to show up on chain. */
const ROOT_POLL_SECONDS = 5;

/**
 * How long the multisig path waits for the root, by default.
 *
 * The second signer runs on its own timer on another host, so the root lands a
 * few minutes after this run proposes — not a few milliseconds. Set it shorter
 * than one epoch, or a late root and a dead co-signer look the same.
 */
const DEFAULT_MULTISIG_WAIT_SECONDS = 600;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false, andPay: false, carryReset: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--and-pay') args.andPay = true;
    // Booleans, matched before the `--flag value` branch consumes what follows.
    else if (argv[i] === '--carry-reset') args.carryReset = true;
    // Named explicitly: the generic branch would store this as `await-root`.
    else if (argv[i] === '--await-root') args.awaitRoot = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.day && args.epoch !== undefined) {
    throw new Error('--day and --epoch address the same thing; pass one of them');
  }
  // A crank with no way to sign is a crank that cannot settle anything. It used
  // to run anyway, produce an unsigned file, and report success.
  if (!args.keypair && !args.dryRun) {
    throw new Error(
      '--keypair <PATH> is required: the snapshot key for a single-signer setup, or ' +
        "this host's multisig member key alongside --multisig <ADDRESS>. Use --dry-run " +
        'to print the plan without one.',
    );
  }
  if (args.awaitRoot !== undefined && (!Number.isFinite(args.awaitRoot) || args.awaitRoot < 0)) {
    throw new Error(`--await-root must be a non-negative number of seconds, got ${args.awaitRoot}`);
  }
  // A single signer's root is on chain before post-root.mjs returns, so there is
  // nothing to wait for and waiting would only delay the alarm.
  if (args.awaitRoot === undefined) {
    args.awaitRoot = args.multisig ? DEFAULT_MULTISIG_WAIT_SECONDS : 0;
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

/**
 * Which script posts this epoch's root, and with what arguments.
 *
 * Two shapes, and the second is the one mainnet runs. When `config.snapshot_key`
 * is a Squads vault there is no keypair for it — that is the entire point of a
 * multisig — so the root is posted *through* the multisig by `cosign.mjs`, and
 * `--keypair` names this host's member key instead.
 *
 * This used to be three lines that appended `--keypair` only if one was given,
 * and fell through to `post-root.mjs` regardless. In the multisig configuration
 * that produced an unsigned file and exit 0, every epoch, forever.
 */
export function postStep({ epoch, rpc, keypair, multisig }) {
  if (!keypair) throw new Error('no key to post with — this run cannot settle anything');

  if (multisig) {
    return {
      script: 'cosign.mjs',
      // `--execute` on both hosts: whichever one meets the threshold sends it.
      args: ['--epoch', String(epoch), '--rpc', rpc, '--multisig', multisig,
        '--keypair', keypair, '--execute', '--yes'],
    };
  }
  return {
    script: 'post-root.mjs',
    args: ['--epoch', String(epoch), '--rpc', rpc, '--keypair', keypair, '--yes'],
  };
}

/**
 * Return the epoch account once it exists on chain, or throw.
 *
 * **This is the check that makes the class of bug impossible rather than fixed
 * once.** A child process exiting 0 describes the child; only the chain
 * describes the chain. Whatever the posting path, whatever it printed, the run
 * has not settled an epoch until the account is readable — so read it.
 *
 * The wait is for the multisig path, where the root lands when the *other* host
 * approves. A missing root at the deadline is the loud failure Phase 09 §9.3
 * asks for: alert on the absence of a settlement, not only on errors.
 */
export async function confirmPosted(
  readEpoch,
  { epoch, awaitSeconds = 0, multisig, sleepFn = sleep, nowFn = () => Date.now() },
) {
  const deadline = nowFn() + awaitSeconds * 1000;
  let announced = false;

  for (;;) {
    const onChain = await readEpoch();
    if (onChain) return onChain;
    if (nowFn() >= deadline) break;
    if (!announced) {
      console.log(`\n⏳ no root for epoch ${epoch} yet — waiting up to ${awaitSeconds}s for it\n`);
      announced = true;
    }
    await sleepFn(ROOT_POLL_SECONDS);
  }

  throw new Error(
    `epoch ${epoch} has NO ROOT ON CHAIN${awaitSeconds ? ` after ${awaitSeconds}s` : ''}, ` +
      'even though the posting step reported success. This run settled nothing.\n' +
      (multisig
        ? '  The proposal may be sitting below the approval threshold: check the other ' +
          "signer's timer, that both hosts name the same --multisig, and the vault's SOL balance."
        : '  post-root.mjs exited 0 without posting. Check that --keypair really is the ' +
          'snapshot key.'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
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
  if (args.carryReset) snapshotArgs.push('--carry-reset');
  const snapshot = run('snapshot.mjs', [...snapshotArgs, '--rpc', args.rpc], args);
  if (snapshot.status !== 0) throw new Error('snapshot failed — nothing was posted');

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

  // No `--empty` here. A successful snapshot always writes tree.json, zero-leaf
  // included, so the detection that used to sit here could never fire — and
  // post-root handles a zero-leaf tree identically anyway. `post-root --empty`
  // stays: it is the documented manual path for posting a zeroed root when
  // there is no snapshot at all.
  const { script, args: postArgs } = postStep({
    epoch,
    rpc: args.rpc,
    keypair: args.keypair,
    multisig: args.multisig,
  });
  const posted = run(script, postArgs, args);
  if (posted.status !== 0) throw new Error(`${script} failed — no root was posted`);

  // And now the only statement that means anything: ask the chain.
  const onChain = args.dryRun
    ? null
    : await confirmPosted(() => fetchEpoch(connection, config.mint, epoch), {
        epoch,
        awaitSeconds: args.awaitRoot,
        multisig: args.multisig,
      });
  if (onChain) console.log(`\nroot on chain: ${onChain.root.toString('hex')}`);

  if (args.andPay) {
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

  // Wait on the **cluster's** clock, because that is the one `claim` compares
  // against. This used to wait on `Date.now()` plus a second of slack, which
  // assumes the two clocks differ by less than that second. A local validator's
  // clock advances with slots and can lag wall time by much more, so the wait
  // ended early and the airdrop came back `ChallengeWindowOpen` — the root
  // posted, the money unpaid, and the crank reporting failure for a settlement
  // that was fine. Polling the chain cannot be early by construction.
  const opensAt = onChain.postedTs + config.challengeSeconds;
  let announced = false;
  for (;;) {
    const slot = await connection.getSlot('confirmed');
    const chainNow = await connection.getBlockTime(slot);
    if (chainNow == null) throw new Error(`the RPC returned no block time for slot ${slot}`);
    if (chainNow >= opensAt) break;
    if (!announced) {
      console.log(
        `\n⏳ the challenge window closes at ${iso(opensAt)} — waiting ${opensAt - chainNow}s\n`,
      );
      announced = true;
    }
    await sleep(2);
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
