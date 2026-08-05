#!/usr/bin/env node
//
// scripts/verify-epoch.mjs — the stranger's reproducer.
//
// If reproducing an epoch is awkward, the snapshot format is wrong, and it is
// much cheaper to learn that before epoch 1 than after epoch 12. So this needs
// **no keys, no account and no permission** — an RPC at most.
//
//   node scripts/verify-epoch.mjs --epoch 12                 # offline
//   node scripts/verify-epoch.mjs --epoch 12 --recheck-chain  # + re-derive from RPC
//   node scripts/verify-epoch.mjs --dir snapshots/epoch-12    # anywhere
//   ... --allow-unposted    # the epoch has no root yet, and that is expected
//
// `--allow-unposted` is for the crank's own pre-flight, which checks the
// snapshot *before* posting — catching a bad root beforehand is a fix, catching
// it afterwards is a press release. For anyone auditing a published epoch, a
// missing root is a real problem and the default says so.
//
// `--offline` proves the arithmetic: the published inputs really do produce the
// published root. `--recheck-chain` proves the *inputs* — it ignores the
// committed balances.json and rebuilds it from chain. Only callouts.json cannot
// be checked this way, and that is precisely the trust boundary this project
// claims. Do not let anyone describe it as smaller than that.
//
// Exit code 0 means reproduced. Anything else means say so, loudly, before the
// challenge window closes.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { connect } from './lib/rpc.mjs';

import * as chain from './lib/chain.mjs';
import { DEFAULT_RPC_URL, MIN_HOLD_RAW } from './lib/config.mjs';
import { fetchConfig, fetchEpoch } from './lib/program.mjs';
import { readJson, snapshotDir } from './lib/store.mjs';
import { recheckChain, verifyOffline } from './lib/verify.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, recheckChain: false, allowUnposted: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--recheck-chain') args.recheckChain = true;
    else if (argv[i] === '--allow-unposted') args.allowUnposted = true;
    else if (argv[i] === '--offline') args.recheckChain = false;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

export async function verify({ dir, recheckChain: doRecheck, rpc, allowUnposted = false }) {
  const problems = [];
  const results = {};

  // The floor comes from chain when we can reach it, because the whole claim is
  // that the number the snapshot filtered on is the number the program holds.
  // Falling back to the local constant is honest but weaker, so it is stated.
  let minHold = MIN_HOLD_RAW;
  let connection = null;
  let config = null;
  if (doRecheck) {
    connection = connect(rpc);
    config = await fetchConfig(connection);
    minHold = config.minHold;
    results.minHoldSource = 'on-chain config';
  } else {
    results.minHoldSource = 'scripts/lib/config.mjs (offline — not read from chain)';
  }

  const offline = verifyOffline(dir, { minHold });
  results.offline = offline;
  problems.push(...offline.problems);

  if (doRecheck) {
    const rechecked = await recheckChain(dir, { connection, chain });
    results.chain = rechecked;
    problems.push(...rechecked.problems);

    // And the last link: does the root on chain match the one published here?
    const tree = readJson(resolve(dir, 'tree.json'));
    const onChain = await fetchEpoch(connection, config.mint, tree.epoch);
    if (!onChain) {
      results.notPosted = true;
      if (!allowUnposted) problems.push(`epoch ${tree.epoch} has no root on chain yet`);
    } else {
      if (onChain.root.toString('hex') !== tree.root) {
        problems.push(
          `the root on chain is ${onChain.root.toString('hex')}, not the published ${tree.root}`,
        );
      }
      if (onChain.leafCount !== tree.leafCount) {
        problems.push(
          `on-chain leaf_count is ${onChain.leafCount}, published ${tree.leafCount} — ` +
            'an undersized bitmap strands every leaf above it (D2)',
        );
      }
      if (onChain.poolLamports !== BigInt(tree.allocate)) {
        problems.push(
          `on-chain allocation is ${onChain.poolLamports}, published ${tree.allocate}`,
        );
      }
      results.onChain = onChain;
    }
  }

  return { ok: problems.length === 0, problems, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir
    ? resolve(process.cwd(), args.dir)
    : args.epoch !== undefined
      ? snapshotDir(Number(args.epoch))
      : process.cwd();

  if (!existsSync(resolve(dir, 'tree.json'))) {
    throw new Error(`no epoch snapshot at ${dir} — pass --epoch N or --dir <path>`);
  }

  console.log(`\nCALLPOOL — reproducing ${dir}`);
  console.log(`mode      ${args.recheckChain ? 'offline + recheck-chain' : 'offline'}\n`);

  const { ok, problems, results } = await verify({ ...args, dir });

  console.log(`floor     from ${results.minHoldSource}`);
  console.log(`root      ${results.offline.recomputed.root.toString('hex')}`);
  console.log(`leaves    ${results.offline.recomputed.leafCount}`);
  console.log(`allocate  ${results.offline.recomputed.allocate}`);
  if (results.chain) console.log(`chain     re-derived ${results.chain.checked} balance timeline(s)`);
  console.log(`stream    ${JSON.stringify(results.offline.streamed)}`);

  if (ok) {
    if (results.notPosted) {
      console.log('\n✅ the snapshot is internally consistent — and NOT yet posted.');
      console.log('   Publish this directory, then post the root.\n');
      return;
    }
    console.log('\n✅ reproduced — the published inputs produce the published root\n');
    if (!args.recheckChain) {
      console.log('This proved the arithmetic. It did NOT prove the balance data.');
      console.log('Run again with --recheck-chain to rebuild balances.json from an RPC.\n');
    }
    return;
  }

  console.log(`\n❌ NOT reproduced — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.log(`  • ${problem}`);
  console.log('\nIf this epoch is still inside its challenge window, say so publicly now.');
  console.log('Nothing on chain can stop a bad root — being noticed is the only defence.\n');
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
