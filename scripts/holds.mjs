#!/usr/bin/env node
//
// scripts/holds.mjs — step 2 of the crank, in isolation.
//
// Given a wallet, a mint and a UTC day, print that wallet's balance timeline
// and the two numbers the whole mechanic reduces to:
//
//   hold(w, d)   the minimum balance held at any point during the day — the
//                weight, and therefore the payout
//   locked(w, d) whether the wallet sold in the 7 epochs before the day
//
// Everything downstream is arithmetic on this output, so this script is the
// one place a bug is unrecoverable. It reads exactly one token account (L6),
// replays every transaction that touched it, and refuses to answer at all if
// the history it fetched has a gap.
//
// Usage:
//   node scripts/holds.mjs --wallet <ADDRESS> --mint <MINT> --day 2026-08-04
//   node scripts/holds.mjs --wallet ... --mint ... --day ... --json
//
// Reads SOLANA_RPC_URL from the environment; defaults to devnet.

import { connect } from './lib/rpc.mjs';

import {
  DEFAULT_RPC_URL,
  LOCKOUT_EPOCHS,
  MINT_DECIMALS,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
} from './lib/config.mjs';
import { iso, lockoutWindow, windowForDay } from './lib/epoch.mjs';
import { lpMint } from './lib/pump-addresses.mjs';
import { computeHold, computeLocked, TimelineError } from './lib/timeline.mjs';
import {
  associatedTokenAddress,
  balanceEventsFor,
  currentBalanceRaw,
  tokenProgramForMint,
} from './lib/chain.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${arg}`);
  }
  for (const required of ['wallet', 'mint', 'day']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

/** Raw units → a readable token figure. Display only; never compare on this. */
function tokens(raw) {
  const scale = 10n ** BigInt(MINT_DECIMALS);
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(MINT_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}

/**
 * Compute `hold` and `locked` for one wallet and one epoch.
 *
 * Exported so the snapshot crank and the devnet proofs call exactly the same
 * code the CLI does — a second implementation is a second set of bugs.
 *
 * `day` addresses a UTC calendar day, which is what production uses. `window`
 * takes an explicit `{start, end}` instead, which is what lets the proofs
 * exercise a full buy/sell/rebuy cycle against real chain history without
 * waiting for a real midnight to pass.
 */
export async function holdsFor(connection, { wallet, mint, day, window: explicit }) {
  const window = explicit ?? windowForDay(day);
  const lockWindow = lockoutWindow(window, LOCKOUT_EPOCHS);

  const tokenProgram = await tokenProgramForMint(connection, mint);
  const ata = associatedTokenAddress(wallet, mint, tokenProgram);

  // Fetch from the start of the lockout window so one pass answers both
  // questions, and one epoch further back so the timeline is always seeded by
  // a real transaction rather than by the current balance where possible. One
  // epoch is the window's own length, not the mainnet constant — a rehearsal
  // running short epochs would otherwise fetch seven days of history it has no
  // use for.
  const since = lockWindow.start - (window.end - window.start);
  // L16 — the coin's own pool LP mint, so a deposit into it can be told apart
  // from a sale. A pure PDA of the coin's mint: no RPC call, no trust, and no
  // dependency on pump's SDK in a path that must stay web3.js-only.
  const events = await balanceEventsFor(connection, ata, since, { lpMint: lpMint(mint) });
  const current = await currentBalanceRaw(connection, ata);

  const result = computeHold(events, window, { currentBalance: current });
  const lock = computeLocked(events, lockWindow);

  return {
    wallet,
    mint,
    day: day ?? `${iso(window.start)} → ${iso(window.end)}`,
    tokenProgram: tokenProgram.toBase58(),
    ata: ata.toBase58(),
    window,
    lockoutWindow: lockWindow,
    hold: result.hold,
    opening: result.opening,
    closing: result.closing,
    maximum: result.maximum,
    currentBalance: current,
    locked: lock.locked,
    lockoutDecreases: lock.decreases,
    // Published alongside the decreases rather than folded into them: a
    // verifier re-deriving this epoch has to be able to see which movements
    // were exempted and check that judgement, not just inherit it (L16).
    lpDeposits: lock.lpDeposits,
    meetsFloor: result.hold >= MIN_HOLD_RAW,
    points: result.points,
    windowEvents: result.events,
    allEvents: events,
  };
}

function report(r) {
  const line = (label, value) => console.log(`${label.padEnd(25)}${value}`);

  console.log(`\nCALLPOOL — hold(w, d) for ${r.day} (UTC)\n`);
  line('wallet', r.wallet);
  line('mint', r.mint);
  line('token account', `${r.ata}   ← the only account that counts (L6)`);
  line('epoch window', `${iso(r.window.start)} → ${iso(r.window.end)}`);

  console.log('\nbalance timeline');
  for (const p of r.points) {
    const at = p.at === r.window.start ? `${iso(p.at)} (opening)` : iso(p.at);
    console.log(`  ${at.padEnd(32)}${tokens(p.balance).padStart(18)}  ${p.signature ?? ''}`);
  }
  if (r.windowEvents.length === 0) {
    console.log('  (no transfers during the epoch — the balance was flat)');
  }

  console.log('');
  line('opening', tokens(r.opening));
  line('maximum', tokens(r.maximum));
  line('closing', tokens(r.closing));
  line('hold (minimum)', `${tokens(r.hold)}   ← the weight`);

  console.log('');
  line('floor', `${MIN_HOLD_TOKENS.toLocaleString('en-US')} tokens — 0.01% of supply (L12)`);
  line('clears the floor', r.meetsFloor ? 'yes' : 'NO');
  line(
    `locked (prev ${LOCKOUT_EPOCHS} epochs)`,
    r.locked ? `YES — ${r.lockoutDecreases.length} decrease(s)` : 'no',
  );
  for (const d of r.lockoutDecreases) {
    console.log(
      `  ${iso(d.blockTime).padEnd(32)}${tokens(d.pre)} → ${tokens(d.post)}  ${d.signature}`,
    );
  }

  console.log('');
  line(
    'eligible on holdings',
    r.meetsFloor && !r.locked
      ? 'yes, if they also called out or posted an update in the window'
      : 'no',
  );
  console.log('');
}

function toJson(r) {
  const event = (e) => ({
    signature: e.signature,
    slot: e.slot,
    blockTime: e.blockTime,
    pre: e.pre.toString(),
    post: e.post.toString(),
  });
  return {
    wallet: r.wallet,
    mint: r.mint,
    day: r.day,
    tokenAccount: r.ata,
    tokenProgram: r.tokenProgram,
    window: r.window,
    lockoutWindow: r.lockoutWindow,
    minHoldRaw: MIN_HOLD_RAW.toString(),
    holdRaw: r.hold.toString(),
    openingRaw: r.opening.toString(),
    closingRaw: r.closing.toString(),
    maximumRaw: r.maximum.toString(),
    meetsFloor: r.meetsFloor,
    locked: r.locked,
    // The evidence trail, not just the answer: a holder who thinks they were
    // underpaid can point at a signature instead of arguing with a number
    // (Phase 05 §5.3).
    lockoutDecreases: r.lockoutDecreases.map(event),
    windowEvents: r.windowEvents.map(event),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const result = await holdsFor(connection, args);

  if (args.json) console.log(JSON.stringify(toJson(result), null, 2));
  else report(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    if (error instanceof TimelineError) {
      // Phase 05 §5.6: fail the epoch rather than publish a guess.
      console.error(`\nREFUSING TO ANSWER — ${error.message}`);
      if (Object.keys(error.detail ?? {}).length > 0) {
        console.error(JSON.stringify(error.detail, null, 2));
      }
    } else {
      console.error(`\n${error.stack ?? error.message}`);
    }
    process.exitCode = 1;
  });
}
