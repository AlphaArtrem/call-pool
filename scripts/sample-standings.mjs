#!/usr/bin/env node
//
// scripts/sample-standings.mjs — the provisional standings the site has
// promised since Phase 07 and never had.
//
// `hourlyState` has always been able to render a sample time, and `app.js` has
// always passed it `lastSampleAt: null`, because nothing published one. The
// card said "No estimate published yet" under a paragraph promising an hourly
// estimate. This is the job that writes it.
//
//   node scripts/sample-standings.mjs --rpc <RPC>
//
// **It computes the estimate with the settlement's own code.** `holdsFor` and
// `buildEpoch` are the functions the crank runs at 00:00 UTC; the only thing
// this passes differently is the window — the slice of today that has actually
// happened, rather than the whole day. That is deliberate and it is the whole
// design: a second implementation of the split would drift from the real one,
// and the drift would show up as a number that moved for no reason a holder
// could check. Same inputs, same arithmetic, shorter window.
//
// **Nothing settles from this file.** It is written to the root of the
// snapshots directory, beside the immutable `epoch-N/` folders and never
// inside one, because it is rewritten every hour and the audit trail is not.
// No instruction reads it, the crank does not consult it, and a wrong or
// missing provisional.json costs a visitor an estimate and nothing else.
//
// ## Why it is cheap
//
// Only wallets that have called out today can earn today, and the callout
// store already knows who they are. So this replays a few dozen accounts, not
// every holder — the same property that keeps the crank cheap (Phase 05
// §5.11). It reads and never writes chain, spends no SOL, and talks to the
// crank's own provider rather than the visitor-facing proxy.
//
// ## What it is not
//
// It is an estimate of an unfinished day, and the day is unfinished in every
// direction: holders can still buy, sell or call out, and the pool still grows
// with fees. `clocks.js` already refuses to let the hourly number be read as a
// payout and that copy stands.

import { resolve } from 'node:path';

import { connect } from './lib/rpc.mjs';
import { isTruncated, recordsInWindow } from './lib/callouts.mjs';
import { emptyCarry, previousCarryFor } from './lib/carry.mjs';
import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { buildEpoch } from './lib/epoch-build.mjs';
import { iso } from './lib/epoch.mjs';
import { epochContaining, fetchConfig, poolAvailable, windowForEpoch } from './lib/program.mjs';
import { readStore, SNAPSHOTS_DIR, snapshotDir, writeJson } from './lib/store.mjs';
import { holdsFor } from './holds.mjs';

/** Rewritten hourly, so it lives beside the epoch directories and not in one. */
export const PROVISIONAL_FILE = 'provisional.json';

/**
 * Below this much elapsed day there is nothing worth publishing.
 *
 * `computeHold` divides by the window's length, so a window of a few seconds
 * produces weights that swing wildly on rounding and would redraw the card
 * with noise at every refresh. Just after 00:00 UTC the honest answer is that
 * today has not started, which is what the *previous* sample's age already
 * says.
 */
export const MIN_ELAPSED_SECONDS = 60;

/**
 * The slice of the epoch that has actually happened.
 *
 * Clamped at both ends: a clock that has drifted past the epoch's close must
 * not produce a window longer than the day, and one that reads before its
 * start must not produce a negative one.
 */
export function elapsedWindow(window, now) {
  const end = Math.min(Math.max(now, window.start), window.end);
  return { start: window.start, end };
}

/**
 * The published shape, from a built epoch.
 *
 * Every wallet the store saw is listed, not only the ones in the money, and
 * `eligible` says which is which. A holder whose estimate is absent needs to
 * know whether they were left out because they are below the floor, because
 * they are locked, or because the sample never saw their callout — and those
 * are three different answers.
 *
 * BigInt is stringified rather than narrowed to a Number: lamports and raw
 * token units both exceed 2^53, and a figure that is quietly wrong in its low
 * digits is the kind of bug this project spends its comments avoiding.
 */
export function provisionalFrom(built, { sampledAt, window, elapsed, truncated, carryKnown }) {
  const shares = new Map(built.payouts.map((p) => [p.wallet, p]));

  return {
    // Named so that a file found on disk out of context cannot be mistaken for
    // part of the audit trail.
    kind: 'provisional-standings',
    settled: false,
    epoch: built.epoch,
    sampledAt,
    window: { start: window.start, end: window.end },
    elapsed: { start: elapsed.start, end: elapsed.end },
    // The share of the day this sample covers, so the page can say how much of
    // today the number is actually based on.
    elapsedFraction: (elapsed.end - elapsed.start) / (window.end - window.start),
    poolLamports: String(built.available),
    divisibleLamports: String(built.divisible),
    allocateLamports: String(built.allocate),
    totalWeight: String(built.totalWeight),
    // Both are reasons the figures below can be short, and both are invisible
    // from the numbers alone.
    truncated,
    carryKnown,
    callouts: built.callouts,
    standings: built.rows.map((row) => {
      const payout = shares.get(row.wallet);
      return {
        wallet: row.wallet,
        hold: String(row.hold),
        sustained: String(row.sustained),
        eligible: row.eligible,
        meetsFloor: row.meetsFloor,
        locked: row.locked,
        // Absent rather than zero for an ineligible wallet: zero would assert
        // that the split gave them nothing, when the truth is that the split
        // never considered them.
        indicative: payout ? String(payout.share + payout.carried) : null,
      };
    }),
  };
}

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const now = Math.floor(Date.now() / 1000);

  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const epoch = epochContaining(now, config);
  const window = windowForEpoch(config, epoch);
  const elapsed = elapsedWindow(window, now);

  console.log(`\nCALLPOOL — provisional standings for epoch ${epoch}\n`);
  console.log(`mint      ${mint}`);
  console.log(`window    ${iso(window.start)} → ${iso(window.end)}`);
  console.log(`elapsed   ${iso(elapsed.start)} → ${iso(elapsed.end)}`);

  if (elapsed.end - elapsed.start < MIN_ELAPSED_SECONDS) {
    console.log(`\nToday is ${elapsed.end - elapsed.start}s old — nothing to estimate yet.`);
    console.log('The previous sample keeps its own timestamp and ages honestly.\n');
    return;
  }

  const storePath = args.store ? resolve(process.cwd(), args.store) : undefined;
  const store = readStore(storePath);
  // `store.callouts`, not `store`. The store wraps its records alongside the
  // poll's own bookkeeping (`mint`, `updatedAt`, `truncations`), and iterating
  // the wrapper walks those too — `mint` defaults to null, so the first thing
  // this did on a fresh box was read `.createdAt` off it and die.
  const records = recordsInWindow(store.callouts ?? {}, elapsed);
  const truncated = isTruncated(records, elapsed);
  const calloutStore = Object.fromEntries(records.map((r) => [r.id, r]));
  console.log(`callouts  ${records.length} record(s) so far${truncated ? ' — FEED TRUNCATED' : ''}`);

  // Callers only. The set this walks is bounded by who has spoken today, not
  // by how many people hold the coin.
  const callers = [...new Set(records.filter((r) => r.walletAddress).map((r) => r.walletAddress))];
  const holds = new Map();
  for (const wallet of callers) {
    holds.set(wallet, await holdsFor(connection, { wallet, mint, window: elapsed }));
  }
  console.log(`holds     replayed ${callers.length} caller(s) over the elapsed window`);

  const pool = await poolAvailable(connection, config);

  // Carry is a nicety here, not a requirement. Between 00:00 UTC and the
  // crank finishing, epoch N-1 has no carry.json and the strict reading would
  // fail every sample in that gap — a display job taking itself down over dust
  // worth less than the fee to send it. It degrades instead, and says so.
  let previousCarry;
  let carryKnown = true;
  try {
    previousCarry = previousCarryFor({
      epoch,
      path: resolve(snapshotDir(epoch - 1), 'carry.json'),
    });
  } catch (error) {
    previousCarry = emptyCarry();
    carryKnown = false;
    console.log(`carry     unknown — ${error.message.split('\n')[0]}`);
    console.log('carry     estimating without it; carried dust is under the send threshold.');
  }

  const built = buildEpoch({
    epoch,
    window: elapsed,
    calloutStore,
    holds,
    available: pool.available,
    previousCarry,
    minHold: config.minHold,
  });

  const provisional = provisionalFrom(built, {
    sampledAt: now,
    window,
    elapsed,
    truncated,
    carryKnown,
  });

  const out = resolve(SNAPSHOTS_DIR, PROVISIONAL_FILE);
  writeJson(out, provisional);

  console.log(`eligible  ${built.rows.filter((r) => r.eligible).length} of ${built.rows.length}`);
  console.log(`pool      ${built.available} lamports, ${built.divisible} divisible`);
  console.log(`\nwrote ${out}`);
  console.log('Nothing settles from this file. It is an estimate of an unfinished day.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nSAMPLE STANDINGS FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
