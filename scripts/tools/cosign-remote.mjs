#!/usr/bin/env node
//
// scripts/tools/cosign-remote.mjs — the second signer, on a host that did not
// build the epoch.
//
// `cosign.mjs` refuses to approve a proposal it cannot re-derive from the
// epoch's **published inputs**. That is the whole reason a 2-of-3 is worth
// having: signer B agreeing means "I built these bytes myself", not "signer A
// says so". But it reads those inputs from its own `snapshots/` directory —
// which, on the host that did not run the crank, is empty.
//
// Last rehearsal hid this by putting both signers on one box, where they shared
// a disk. A shared disk is a shared compromise: own the host and you own both
// approvals. So signer B lives elsewhere and this fetches the inputs the way a
// stranger auditing the pool would — over HTTP, from the published tree — and
// then hands off to `cosign.mjs`, which does the deciding.
//
//   node scripts/tools/cosign-remote.mjs \
//     --base http://host:8100 --multisig <ADDRESS> --keypair <MEMBER_KEY>
//
//   ... --epoch 12     one specific epoch instead of whatever is outstanding
//   ... --lookback 30  how far back to search for an unsettled epoch
//   ... --dry-run      fetch and reproduce, sign nothing
//
// **Fetching is not trusting.** Everything downloaded here is treated as a
// claim: `cosign.mjs` recomputes the root from it and compares the proposal
// byte for byte, and a mismatch is a refusal. A malicious box A can therefore
// make this signer *refuse*, which is the safe direction, but it cannot make it
// approve a root that its own inputs do not produce.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { fetchConfig, fetchEpoch } from '../lib/program.mjs';
import { REPO_ROOT, snapshotDir } from '../lib/store.mjs';

/**
 * The files an epoch is reproduced from.
 *
 * `carry.json` for the *previous* epoch is fetched too — `verifyOffline` uses
 * it to catch a carry chain that restarted mid-history, and without it every
 * epoch looks like a genesis epoch and that check silently passes.
 */
const EPOCH_FILES = ['callouts.json', 'balances.json', 'pool.json', 'carry.json', 'tree.json', 'root.txt'];

/** How many epochs back to look for something unsettled, by default. */
const DEFAULT_LOOKBACK = 30;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false, lookback: DEFAULT_LOOKBACK };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--lookback') args.lookback = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.base) throw new Error('--base <URL> is required: where the epoch directories are published');
  if (!args.multisig) throw new Error('--multisig <ADDRESS> is required');
  if (!args.keypair && !args.dryRun) throw new Error('--keypair <PATH> is required');
  if (!Number.isInteger(args.lookback) || args.lookback < 1) {
    throw new Error(`--lookback must be a positive integer, got ${args.lookback}`);
  }
  return args;
}

/** The epoch index that was running at `timestamp`. */
export function epochAt(timestamp, { genesisTs, epochSeconds }) {
  return Math.floor((timestamp - Number(genesisTs)) / Number(epochSeconds));
}

/**
 * Every closed epoch with no root, within the lookback, oldest first.
 *
 * Oldest first because epochs settle in order and an older unsettled epoch is
 * the more urgent one — its challenge window has been open longer. But it is a
 * *list*, not a pick, and that distinction is load-bearing: some unsettled
 * epochs can never be signed. Epoch 0 is never snapshotted, and the rehearsal
 * deliberately skips one to produce a "not posted" row. Returning only the
 * oldest meant signer B chose epoch 0, failed to fetch it, and never looked at
 * epoch 1 — one permanently unpublished epoch wedging every later one, forever.
 *
 * `hasRoot` is injected so the choosing is testable without a chain.
 */
export async function outstandingEpochs({ current, lookback, hasRoot }) {
  const oldest = Math.max(0, current - lookback);
  const epochs = [];
  for (let epoch = oldest; epoch < current; epoch++) {
    if (!(await hasRoot(epoch))) epochs.push(epoch);
  }
  return epochs;
}

/** Join a base URL and an epoch-relative path without doubling the slash. */
export function fileUrl(base, epoch, name) {
  return `${base.replace(/\/+$/, '')}/epoch-${epoch}/${name}`;
}

/**
 * Download one epoch's inputs into the local snapshots tree.
 *
 * A missing file is fatal rather than skipped: reproducing an epoch from a
 * partial copy is how a signer talks itself into approving something it only
 * half-checked. The one exception is the previous epoch's carry ledger, which
 * genuinely does not exist for a genesis epoch.
 */
export async function fetchEpochInputs({ base, epoch, fetchFn = fetch, write = writeFileSync }) {
  const dir = snapshotDir(epoch);
  mkdirSync(dir, { recursive: true });

  for (const name of EPOCH_FILES) {
    const url = fileUrl(base, epoch, name);
    const response = await fetchFn(url);
    if (!response.ok) {
      // Marked, not just thrown. The caller needs to tell "this epoch has no
      // published inputs" (try the next one) from "the fetch itself broke"
      // (stop and say so). Both arrive here as an exception otherwise.
      const error = new Error(
        `${url} returned ${response.status}. The epoch is not published yet, or not published ` +
          'completely — either way there is nothing here to reproduce, so nothing gets signed.',
      );
      error.notPublished = true;
      throw error;
    }
    write(resolve(dir, name), Buffer.from(await response.arrayBuffer()));
  }

  if (epoch > 0) {
    const previous = snapshotDir(epoch - 1);
    const url = fileUrl(base, epoch - 1, 'carry.json');
    const response = await fetchFn(url);
    if (response.ok) {
      mkdirSync(previous, { recursive: true });
      write(resolve(previous, 'carry.json'), Buffer.from(await response.arrayBuffer()));
    } else {
      // Not fatal here. `verifyOffline` decides what a missing predecessor
      // means; this only declines to invent one.
      console.log(`note: no carry ledger published for epoch ${epoch - 1} (${response.status})`);
    }
  }

  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();

  const hasRoot = async (epoch) => (await fetchEpoch(connection, mint, epoch)) != null;

  let candidates;
  if (args.epoch !== undefined) {
    candidates = [Number(args.epoch)];
  } else {
    const current = epochAt(Math.floor(Date.now() / 1000), config);
    candidates = await outstandingEpochs({ current, lookback: args.lookback, hasRoot });
    if (candidates.length === 0) {
      console.log(`nothing outstanding in the last ${args.lookback} epochs (current ${current}).\n`);
      return;
    }
  }

  console.log(`\nCALLPOOL — remote co-sign\n`);
  console.log(`published at ${args.base}`);
  console.log(`outstanding  ${candidates.join(', ')}\n`);

  for (const epoch of candidates) {
    if (args.epoch !== undefined && (await hasRoot(epoch))) {
      console.log(`epoch ${epoch} already has a root on chain. Nothing to do.\n`);
      return;
    }

    let dir;
    try {
      dir = await fetchEpochInputs({ base: args.base, epoch });
    } catch (error) {
      // Not published: either it has not been built yet — in which case the
      // next tick of the timer finds it — or it never will be, and blocking on
      // it forever would strand every later epoch behind one that cannot move.
      if (error.notPublished) {
        console.log(`epoch ${epoch}: ${error.message}\n         moving on to the next one.\n`);
        continue;
      }
      throw error;
    }
    console.log(`epoch ${epoch}: fetched into ${dir}\n`);

    // `cosign.mjs` owns every decision from here: it reproduces the epoch from
    // what was just downloaded, rebuilds the instruction, and refuses unless
    // the proposal's bytes are the bytes it derived.
    const result = spawnSync(
      'node',
      [
        resolve(REPO_ROOT, 'scripts/cosign.mjs'),
        '--epoch', String(epoch),
        '--rpc', args.rpc,
        '--multisig', args.multisig,
        ...(args.dryRun ? ['--dry-run'] : ['--keypair', args.keypair, '--execute', '--yes']),
      ],
      { stdio: 'inherit', cwd: REPO_ROOT },
    );
    if (result.status !== 0) throw new Error(`cosign.mjs exited ${result.status} for epoch ${epoch}`);
    return;
  }

  // Nothing was signed, and that is a normal idle tick — every outstanding
  // epoch is simply not published yet. This deliberately does NOT fail: the
  // alarm for "a root never landed" belongs to the crank on the other host,
  // which knows what it posted and reads the chain back to check. A second
  // process shouting about the same thing from less information is noise.
  console.log('nothing signable this tick — no outstanding epoch has published inputs.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nREMOTE CO-SIGN FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
