#!/usr/bin/env node
//
// scripts/tools/day0-standings.mjs — the split for the day no epoch covers.
//
// The coin was created 2026-08-10 16:52:49Z; genesis is 2026-08-11T00:00:00Z
// (F20: the NEXT boundary, immutably). The hours between belong to no epoch,
// so the program can never pay them — and the owner ruled on launch night
// that day 0 is honored anyway, out of the ops wallet, off-protocol.
//
// **This tool only computes and writes files. It moves no money.** It uses
// the settlement's own `holdsFor` and `buildEpoch` — same floor, same L20
// proration, same L2/L7 callout rules — over the day-0 window, so the manual
// payout is defensible by the same arithmetic as every real epoch after it.
//
//   node scripts/tools/day0-standings.mjs --rpc <RPC> \
//     --pot-lamports <TOTAL_TO_DISTRIBUTE> \
//     [--store epochs/callout-store.json] [--end 1786406400]
//
// Outputs, in snapshots/day0/:
//   day0.json     the full standings — window, pot, per-wallet holds, shares
//   pay-day0.sh   `solana transfer` lines from the OPS key. THE OWNER RUNS IT.
//   index.html    the receipts page the site links to
//
// The pot is a flag, not a measurement, so the owner states the number being
// honored. The measured guide: the pool's balance above rent at 00:00 UTC is
// exactly what day 0's fees delivered.

import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { isTruncated, recordsInWindow } from '../lib/callouts.mjs';
import { emptyCarry } from '../lib/carry.mjs';
import { buildEpoch } from '../lib/epoch-build.mjs';
import { iso } from '../lib/epoch.mjs';
import { fetchConfig } from '../lib/program.mjs';
import { readStore, SNAPSHOTS_DIR, writeJson } from '../lib/store.mjs';
import { holdsFor } from '../holds.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

// The coin's creation second, from tx 5NnnaHwG… (slot 438439092). Holding
// earlier was impossible, so the window starts here, not at 00:00.
export const DAY0_START = 1_786_380_769;
export const DAY0_END = 1_786_406_400; // genesis: 2026-08-11T00:00:00Z

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.rpc) throw new Error('--rpc is required');
  if (!args['pot-lamports']) throw new Error('--pot-lamports is required: the amount being honored');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const pot = BigInt(args['pot-lamports']);
  const window = { start: DAY0_START, end: Number(args.end ?? DAY0_END) };

  console.log(`\nCALLPOOL — day 0 standings (manual honor, off-protocol)\n`);
  console.log(`mint      ${mint}`);
  console.log(`window    ${iso(window.start)} → ${iso(window.end)}`);
  console.log(`pot       ${pot} lamports`);

  const store = readStore(args.store ? resolve(process.cwd(), args.store) : undefined);
  const records = recordsInWindow(store.callouts ?? {}, window);
  const truncated = isTruncated(records, window);
  console.log(`callouts  ${records.length} record(s)${truncated ? ' — window edge beyond oldest record, check completeness' : ''}`);

  const calloutStore = Object.fromEntries(records.map((r) => [r.id, r]));
  const callers = [...new Set(records.filter((r) => r.walletAddress).map((r) => r.walletAddress))];
  const holds = new Map();
  for (const wallet of callers) {
    holds.set(wallet, await holdsFor(connection, { wallet, mint, window }));
  }
  console.log(`holds     replayed ${callers.length} caller(s)`);

  // buildEpoch encodes the epoch into u64 leaves, so the label must be ≥ 0;
  // 0 here is only arithmetic scaffolding — nothing from this build is posted
  // on chain, and the artifacts identify themselves as day0-manual-honor with
  // their own window. previousCarry empty — nothing precedes day 0.
  const built = buildEpoch({
    epoch: 0,
    window,
    calloutStore,
    holds,
    available: pot,
    previousCarry: emptyCarry(),
    minHold: config.minHold,
  });

  const paid = built.payouts.filter((p) => p.share + p.carried > 0n);
  const outDir = resolve(SNAPSHOTS_DIR, 'day0');
  mkdirSync(outDir, { recursive: true });

  writeJson(resolve(outDir, 'day0.json'), {
    kind: 'day0-manual-honor',
    note:
      'Day 0 (coin creation to genesis) precedes the first on-chain epoch and cannot be ' +
      'settled by the program. The creator honored it from the ops wallet. Computed with ' +
      'the settlement’s own holdsFor/buildEpoch over the day-0 window.',
    window: { start: window.start, end: window.end },
    potLamports: String(pot),
    allocateLamports: String(built.allocate),
    totalWeight: String(built.totalWeight),
    truncated,
    callouts: built.callouts,
    standings: built.rows.map((row) => {
      const payout = built.payouts.find((p) => p.wallet === row.wallet);
      return {
        wallet: row.wallet,
        hold: String(row.hold),
        sustained: String(row.sustained),
        eligible: row.eligible,
        meetsFloor: row.meetsFloor,
        locked: row.locked,
        lamports: payout ? String(payout.share + payout.carried) : null,
      };
    }),
  });

  const lines = paid.map(
    (p) =>
      `send ${p.wallet} ${(Number(p.share + p.carried) / 1e9).toFixed(9)}`,
  );
  const script = [
    '#!/usr/bin/env bash',
    '# Day-0 manual honor — RUN BY THE OWNER. Requires the ops keypair.',
    '# Usage: bash pay-day0.sh <OPS_KEYPAIR_PATH> <RPC_URL>',
    'set -euo pipefail',
    'OPS="$1"; RPC="$2"',
    'S=~/.solana/solana-release/bin/solana',
    'send() {',
    '  echo "→ $1  $2 SOL"',
    '  "$S" transfer "$1" "$2" --keypair "$OPS" --url "$RPC" --allow-unfunded-recipient --commitment confirmed | tail -1',
    '}',
    ...lines,
    'echo "day-0 honor complete: ' + paid.length + ' wallet(s)"',
  ].join('\n');
  writeFileSync(resolve(outDir, 'pay-day0.sh'), script, { mode: 0o755 });

  console.log(`\neligible  ${built.rows.filter((r) => r.eligible).length} of ${built.rows.length} caller(s)`);
  console.log(`payable   ${paid.length} wallet(s), ${built.allocate} of ${pot} lamports allocated`);
  for (const p of paid) console.log(`  ${p.wallet}  ${(Number(p.share + p.carried) / 1e9).toFixed(9)} SOL`);
  console.log(`\nwrote ${outDir}/day0.json and ${outDir}/pay-day0.sh`);
  console.log('This tool moved no money. The owner runs pay-day0.sh.\n');
}

main().catch((err) => {
  console.error(`\nDAY0 STANDINGS FAILED: ${err.message}\n`);
  process.exit(1);
});
