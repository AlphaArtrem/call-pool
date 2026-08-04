#!/usr/bin/env node
//
// scripts/snapshot.mjs — steps 1 to 8 of the crank.
//
// Reads the merged callout store and the chain, replays every caller's balance
// history, computes the weights and the tree, and writes `snapshots/epoch-N/`.
// **It does not post anything and touches no key** — that is post-root.mjs.
//
// Publish before posting, so the inputs are timestamped ahead of the root
// rather than after it. The challenge window is only meaningful if there was
// something to check during it.
//
// Usage:
//   CALLOUT_API_KEY=... node scripts/snapshot.mjs --day 2026-08-04
//   node scripts/snapshot.mjs --epoch 12        # by on-chain index instead
//   ... --rpc <URL> --mint <MINT>     # mint defaults to the on-chain config
//   ... --dry-run                     # compute and print, write nothing
//
// `--day` is how a human refers to an epoch and `--epoch` is how the chain
// does. They must agree — `initialize` refuses a genesis that is not aligned to
// an epoch boundary precisely so that they can.
//
// Refuses rather than guesses, in three places that matter:
//   * a truncated feed with no usable fallback list
//   * a caller whose balance history has a gap (holds.mjs raises)
//   * a window that is not an epoch boundary for the on-chain genesis

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Connection } from '@solana/web3.js';

import { apiKeyFromEnv, collectByWallet, isTruncated, mergeById, recordsInWindow } from './lib/callouts.mjs';
import { DEFAULT_RPC_URL, LOCKOUT_EPOCHS } from './lib/config.mjs';
import { emptyCarry, reconcile } from './lib/carry.mjs';
import { buildEpoch, payoutsCsv } from './lib/epoch-build.mjs';
import { iso, windowForDay } from './lib/epoch.mjs';
import {
  epochIndexFor,
  fetchConfig,
  poolAvailable,
  poolPda,
  PROGRAM_ID,
  windowForEpoch,
} from './lib/program.mjs';
import { readJson, readStore, snapshotDir, writeJson } from './lib/store.mjs';
import { holdsFor } from './holds.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.day && args.epoch === undefined) {
    throw new Error('one of --day (YYYY-MM-DD, UTC) or --epoch N is required');
  }
  return args;
}

const serialiseBig = (value) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Resolve the callout record set for the window, falling back when truncated.
 *
 * Truncation is adversarially triggerable for free (Phase 02 §2.6), so this is
 * the normal path as often as the exception. The fallback needs a candidate
 * list, and the right one is **holders above the floor** — enumerable from
 * chain — rather than callers, which are not.
 */
async function resolveCallouts({ store, window, mint, apiKey, holdersAboveFloor }) {
  // The store wraps its records in `callouts` alongside the poll's own
  // bookkeeping; only the records are epoch input.
  const records = recordsInWindow(store.callouts ?? {}, window);
  const truncatedNow = isTruncated(records, window);
  const truncationsSeen = (store.truncations ?? []).filter(
    (t) => window.day && t.day === window.day,
  );

  if (!truncatedNow && truncationsSeen.length === 0) {
    return { records, usedFallback: false, truncated: false };
  }

  if (!holdersAboveFloor || holdersAboveFloor.length === 0) {
    throw new Error(
      'the callout feed was truncated for this window and no holder list was supplied, ' +
        'so the caller set cannot be established. Pass --holders <file> with the ' +
        'addresses holding at least min_hold, or settle later. Publishing a short ' +
        'list would be worse than settling late.',
    );
  }

  const recovered = await collectByWallet(holdersAboveFloor, mint, window, { apiKey });
  const merged = mergeById(
    Object.fromEntries(records.map((r) => [r.id, r])),
    recovered,
    Math.floor(Date.now() / 1000),
  );
  return { records: Object.values(merged), usedFallback: true, truncated: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, 'confirmed');

  const config = await fetchConfig(connection);
  const mint = args.mint ?? config.mint.toBase58();
  if (args.mint && args.mint !== config.mint.toBase58()) {
    throw new Error(`--mint ${args.mint} is not the coin this program is bound to`);
  }

  // Addressed either way, and they must resolve to the same window. A calendar
  // day that is not an epoch boundary for this genesis is refused rather than
  // rounded — that mismatch is exactly what `initialize`'s alignment check
  // exists to make impossible.
  const window = args.day ? windowForDay(args.day) : windowForEpoch(config, Number(args.epoch));
  const epoch = args.day ? epochIndexFor(window.start, config) : Number(args.epoch);
  const label = args.day ?? new Date(window.start * 1000).toISOString();

  console.log(`\nCALLPOOL — snapshot for ${label}, epoch ${epoch}\n`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`mint      ${mint}`);
  console.log(`pool      ${poolPda().toBase58()}`);
  console.log(`window    ${iso(window.start)} → ${iso(window.end)}`);

  // ── step 1 ───────────────────────────────────────────────────────────────
  const store = readStore();
  const holdersFile = args.holders ? readJson(resolve(process.cwd(), args.holders)) : null;
  const { records, usedFallback, truncated } = await resolveCallouts({
    store,
    window,
    mint,
    apiKey: args.holders ? apiKeyFromEnv() : null,
    holdersAboveFloor: holdersFile,
  });
  const windowStore = Object.fromEntries(records.map((r) => [r.id, r]));
  console.log(
    `callouts  ${records.length} record(s) in the window` +
      (truncated ? ` — feed was TRUNCATED, fallback ${usedFallback ? 'used' : 'REQUIRED'}` : ''),
  );

  // ── step 2 ───────────────────────────────────────────────────────────────
  // Callers only. This is what keeps the crank cheap: dozens of accounts, not
  // every holder (Phase 05 §5.11).
  const callers = [...new Set(records.filter((r) => r.walletAddress).map((r) => r.walletAddress))];
  const holds = new Map();
  for (const wallet of callers) {
    holds.set(wallet, await holdsFor(connection, { wallet, mint, window }));
  }
  console.log(`holds     replayed ${callers.length} caller(s) over ${LOCKOUT_EPOCHS + 1} epochs`);

  // ── step 5 ───────────────────────────────────────────────────────────────
  // Read the pool the way the program will compute it, so we ask for exactly
  // what will be accepted. Step 0 — the fee sweep — must already have run.
  const pool = await poolAvailable(connection, config);
  console.log(`pool      ${pool.lamports} lamports, ${pool.available} allocatable`);

  // ── steps 3, 4, 6, 7 ─────────────────────────────────────────────────────
  const previousCarry =
    epoch === 0
      ? emptyCarry()
      : readJson(resolve(snapshotDir(epoch - 1), 'carry.json'), emptyCarry());

  const built = buildEpoch({
    epoch,
    window,
    calloutStore: windowStore,
    holds,
    available: pool.available,
    previousCarry,
    minHold: config.minHold,
  });

  console.log(
    `eligible  ${built.tree.length} paid, ` +
      `${built.payouts.length - built.tree.length} carried as dust, ` +
      `${built.rows.length - built.payouts.length} ineligible`,
  );
  console.log(`root      ${built.root.toString('hex')}`);
  console.log(`allocate  ${built.allocate} of ${pool.available} available`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written\n');
    return;
  }

  // ── step 8 ───────────────────────────────────────────────────────────────
  const dir = snapshotDir(epoch);
  mkdirSync(dir, { recursive: true });

  // Raw, unmodified, every field. The public feed only ever returns the newest
  // 50, so this is the only surviving copy — an epoch whose callout file has
  // been summarised has destroyed its own evidence (Phase 05 §5.10).
  writeJson(resolve(dir, 'callouts.json'), {
    mint,
    window,
    capturedAt: Math.floor(Date.now() / 1000),
    truncated,
    usedFallback,
    counted: built.callouts.counted,
    excluded: built.callouts.excluded,
  });

  // The evidence behind every `hold`, not just the answer: a holder who thinks
  // they were underpaid can point at a signature rather than argue with a number.
  writeJson(
    resolve(dir, 'balances.json'),
    serialiseBig(
      Object.fromEntries(
        [...holds].map(([wallet, h]) => [
          wallet,
          {
            tokenAccount: h.ata,
            hold: h.hold,
            locked: h.locked,
            opening: h.opening,
            closing: h.closing,
            windowEvents: h.windowEvents,
            lockoutDecreases: h.lockoutDecreases,
          },
        ]),
      ),
    ),
  );

  writeJson(resolve(dir, 'pool.json'), {
    pool: poolPda().toBase58(),
    lamports: pool.lamports.toString(),
    rentMinimum: pool.rent.toString(),
    outstanding: pool.outstanding.toString(),
    available: pool.available.toString(),
    allocate: built.allocate.toString(),
    reconciliation: reconcile({
      inflows: pool.available,
      allocated: built.allocate,
      carried: BigInt(built.carry.totals.carried),
      expired: built.expiredLamports,
    }),
  });

  writeJson(resolve(dir, 'carry.json'), built.carry);
  writeFileSync(resolve(dir, 'payouts.csv'), payoutsCsv(built));
  writeJson(
    resolve(dir, 'tree.json'),
    serialiseBig({
      epoch,
      root: built.root.toString('hex'),
      leafCount: built.leafCount,
      allocate: built.allocate.toString(),
      leaves: built.tree.map((leaf) => ({
        index: leaf.index,
        owner: leaf.owner,
        amount: leaf.amount.toString(),
        proof: leaf.proof.map((node) => node.toString('hex')),
      })),
    }),
  );
  writeFileSync(
    resolve(dir, 'root.txt'),
    `root=${built.root.toString('hex')}\nleaf_count=${built.leafCount}\nallocate=${built.allocate}\nposted_signature=\n`,
  );
  // `build.mjs` must be runnable by a stranger with no keys, reading only the
  // files beside it — and the code that reads them, which is published in the
  // same repository. A copy of the reproducer would be a copy that drifts, so
  // this is a shim onto the one implementation everyone else uses.
  writeFileSync(
    resolve(dir, 'build.mjs'),
    `#!/usr/bin/env node
// Reproduce epoch ${epoch}'s root from the files in this directory.
//
//   node build.mjs                  recompute the root from what is here
//   node build.mjs --recheck-chain  ignore balances.json and rebuild it from an RPC
//
// No keys, no account, no permission. If this does not print the root in
// root.txt, this epoch did not happen properly — say so publicly.
import { verify } from '../../scripts/verify-epoch.mjs';

const recheck = process.argv.includes('--recheck-chain');
const { ok, problems, results } = await verify({
  dir: import.meta.dirname,
  recheckChain: recheck,
  rpc: process.env.SOLANA_RPC_URL,
});

console.log('root     ' + results.offline.recomputed.root.toString('hex'));
console.log('leaves   ' + results.offline.recomputed.leafCount);
console.log('allocate ' + results.offline.recomputed.allocate);
if (!ok) {
  for (const problem of problems) console.error('  • ' + problem);
  process.exit(1);
}
console.log('reproduced');
`,
  );

  console.log(`\nwrote ${dir}`);
  console.log('Publish this directory BEFORE posting the root — the challenge');
  console.log('window is only meaningful if there was something to check.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
