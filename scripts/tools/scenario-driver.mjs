#!/usr/bin/env node
//
// scripts/tools/scenario-driver.mjs — the matrix, executed.
//
//   node scripts/tools/scenario-driver.mjs --assign          # rows → wallets, once
//   node scripts/tools/scenario-driver.mjs --epoch 3 --plan  # what would happen
//   node scripts/tools/scenario-driver.mjs --epoch 3         # do it
//
// **Devnet only.**
//
// §5 of FINAL-DEVNET-TEST.md is ~55 rows, and thirty of them are a wallet doing
// something at a particular moment of an epoch: buy at 25% in, sell down to
// 120,000, top up three times, deposit to the pool. Driving that by hand across
// sixty wallets is not possible to do twice the same way, and a rehearsal whose
// inputs cannot be reproduced cannot be re-run when it finds something.
//
// So the matrix is a table here, and the runner walks it. Three consequences
// that are the whole point:
//
// - **The assertions become mechanical.** Each row states the weight it expects,
//   so the run compares against the row rather than against someone's memory of
//   what the row meant.
// - **A re-run is the same run.** `--assign` writes the row→wallet mapping into
//   the manifest once; every later invocation reads it. Re-assigning would give
//   b3's history to a different wallet halfway through a rehearsal.
// - **Timing is relative.** Rows say "25% into the epoch", not a timestamp, so
//   the same table drives a 600-second rehearsal and an 86,400-second mainnet
//   day without editing.
//
// ## What it deliberately does not do
//
// Callouts. Those are `mock-callouts.mjs`, which owns the store and the
// 50-record cap. A driver that also wrote callout records would be a second
// writer of the one input that decides who gets paid.

import { LAMPORTS_PER_SOL, ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL, MINT_DECIMALS, MIN_HOLD_RAW } from '../lib/config.mjs';
import { associatedTokenAddress, currentBalanceRaw, tokenProgramForMint } from '../lib/chain.mjs';
import { iso } from '../lib/epoch.mjs';
import { fetchConfig, windowForEpoch } from '../lib/program.mjs';
import { assertNotMainnet, loadKeypair, readManifest, writeManifest } from './devnet.mjs';
import { instructionFrom } from './mk-pump-coin.mjs';
import { settledBalance } from './pump-trade.mjs';

const COMPUTE_UNIT_LIMIT = 400_000;

/**
 * Headroom a buy needs beyond its own lamports: signature fees, and the
 * associated-token-account rent a first buy on a fresh venue still has to pay.
 */
const RESERVE_LAMPORTS = 6_000_000;
const PUMP_FEES = '../../tools/sweep/pump-fees.mjs';

/** Raw units for a round number of whole tokens. */
export const T = (whole) => BigInt(whole) * 10n ** BigInt(MINT_DECIMALS);

/**
 * The matrix, as data.
 *
 * `at` is a fraction of the epoch, so this table is clock-independent. `hold`
 * is the balance the wallet must end the action at, in raw units — expressed
 * as an absolute target rather than a delta because that is how §5 states it
 * and because a delta would silently mean something different after a curve
 * moved the buy.
 *
 * `expect` is prose from §5, carried along so the run's output can be read
 * against the plan without opening the document.
 *
 * Only the rows that require *action during an epoch* are here. A1 ("holds all
 * epoch") needs no driving — it is the wallet the cast builder already made,
 * and its row is proved by leaving it alone.
 */
export const SCENARIOS = [
  // ── A. holding and weight (L20 / L21) ────────────────────────────────────
  { id: 'A2', at: 0, target: T(100_000), expect: 'exactly the floor — eligible, floor is inclusive' },
  { id: 'A3', at: 0, target: T(99_999), expect: 'one under the floor — not eligible' },
  { id: 'A4', at: 0.25, buy: 0.05, expect: 'first buy 25% in — weight ≈ balance × 0.75' },
  { id: 'A5', at: 0.5, buy: 0.05, expect: 'first buy at half — weight ≈ balance × 0.5' },
  { id: 'A6', at: 0.99, buy: 0.05, expect: 'first buy in the last 1% — weight ≈0 but > 0' },
  { id: 'A8', at: 0.5, buy: 0.02, topUp: true, expect: 'one top-up — weight above the pre-top-up figure' },
  { id: 'A9', at: 0.25, buy: 0.02, topUp: true, expect: 'top-up 1 of 3' },
  { id: 'A9b', id2: 'A9', at: 0.5, buy: 0.02, topUp: true, expect: 'top-up 2 of 3' },
  { id: 'A9c', id2: 'A9', at: 0.75, buy: 0.02, topUp: true, expect: 'top-up 3 of 3 — strictly increasing vs A1' },
  { id: 'A10', at: 0.99, buy: 0.02, topUp: true, expect: 'top-up in the last minute — weight ≈ unchanged' },

  // ── B. decreases (L22) ───────────────────────────────────────────────────
  { id: 'B1', at: 0.5, target: T(120_000), expect: 'trimmed but above the floor — weight 120,000, NOT locked' },
  { id: 'B2', at: 0.5, target: T(100_000), expect: 'trimmed to exactly the floor — NOT locked' },
  { id: 'B3', at: 0.5, target: T(99_999), expect: 'one under — excluded AND locked 7 epochs' },
  { id: 'B4', at: 0.5, target: T(50_000), expect: 'well under — excluded and locked' },
  { id: 'B5', at: 0.5, target: 0n, expect: 'sold everything — excluded and locked' },
  { id: 'B6', at: 0.25, target: T(120_000), expect: 'down to 120,000 (stays above floor)' },
  { id: 'B6b', id2: 'B6', at: 0.5, buy: 0.05, topUp: true, expect: 'and back up — suffix-min, NOT locked' },
  { id: 'B7', at: 0.25, target: T(50_000), expect: 'below the floor first' },
  { id: 'B7b', id2: 'B7', at: 0.5, buy: 0.05, topUp: true, expect: 'and back up — still locked, it touched below' },
  { id: 'B8', at: 0.25, target: T(300_000), expect: 'first decrease, above the floor' },
  { id: 'B8b', id2: 'B8', at: 0.6, target: T(150_000), expect: 'second decrease — weight is the lowest of them' },
  { id: 'B9', at: 0.5, target: T(200_000), transferToOwn: true, expect: 'transfer to a second wallet, staying above the floor — NOT locked under L22' },
  { id: 'B10', at: 0.5, target: T(50_000), transferToOwn: true, expect: 'transfer that drops below the floor — locked' },
];

/**
 * Every distinct wallet the matrix needs.
 *
 * Rows sharing an `id2` are the same wallet acting twice, so they must not be
 * counted twice — B6 and B6b are one wallet's morning and afternoon.
 */
export function requiredWallets(scenarios = SCENARIOS) {
  return [...new Set(scenarios.map((s) => s.id2 ?? s.id))];
}

/**
 * Row → wallet, fixed once and then read.
 *
 * Assignment is by position over the scenario wallets in the order the cast
 * builder made them, which is stable because `w01`…`wNN` sort that way. The
 * named roles are excluded: `dumper` sells on `dry-run-loop`'s schedule and a
 * matrix row pointing at it would be fighting another script for the same
 * balance.
 *
 * Re-assigning mid-run is the failure this guards: b3's lockout is seven
 * epochs long, so moving b3 to a different wallet on epoch 4 leaves a locked
 * wallet nobody is looking at and an unlocked one being asserted against.
 */
export function assignWallets(cast, scenarios = SCENARIOS) {
  const pool = cast.filter((m) => m.scenario === true).map((m) => m.name).sort();
  const rows = requiredWallets(scenarios);
  if (pool.length < rows.length) {
    throw new Error(
      `the matrix needs ${rows.length} scenario wallets and the cast has ${pool.length}. ` +
        `Run: node scripts/tools/mk-pump-cast.mjs --count ${rows.length} --keypair <PATH>`,
    );
  }
  return Object.fromEntries(rows.map((row, i) => [row, pool[i]]));
}

/**
 * When, in absolute seconds, each action of an epoch happens.
 *
 * Sorted, because the runner walks it in order and waits: an action at 25%
 * scheduled after one at 50% would either fire late or be skipped, and both
 * produce a balance history that no row describes.
 */
export function planFor({ scenarios = SCENARIOS, window, assignment }) {
  return scenarios
    .map((s) => ({
      ...s,
      wallet: assignment[s.id2 ?? s.id],
      at: window.start + Math.floor((window.end - window.start) * s.at),
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Which wallets cannot afford the step they are about to be asked to perform.
 *
 * `mk-pump-cast` funds each wallet with `GAS_SOL` (0.05) and spends part of it
 * on the initial buy and two ATAs, so a scenario wallet holds roughly 0.046 SOL
 * when the matrix starts. Three rows then ask for a **0.05 SOL buy** — more
 * than the whole gas allowance was ever going to cover. On 2026-08-09 that
 * surfaced as `custom program error: 0x1` from the buy at A4, twelve minutes
 * into a five-minute window, with twenty-one later rows abandoned behind it.
 *
 * The failure is entirely predictable before the epoch starts, so predict it:
 * every buy step needs its `buy` lamports plus a fee-and-rent reserve, and a
 * wallet that is short should be topped up while there is still time, not
 * discovered at the instant its row was supposed to fire.
 */
export function underfundedSteps(plan, { balances, reserveLamports = RESERVE_LAMPORTS }) {
  const short = [];
  for (const step of plan) {
    if (step.buy === undefined) continue;
    const need = BigInt(Math.round(step.buy * LAMPORTS_PER_SOL)) + BigInt(reserveLamports);
    const have = BigInt(balances.get(step.wallet) ?? 0);
    if (have < need) short.push({ id: step.id, wallet: step.wallet, need, have });
  }
  return short;
}

/** What this row does, in one word, for the log and the plan. */
export function actionOf(step) {
  if (step.buy !== undefined) return step.topUp ? 'top-up' : 'buy';
  if (step.transferToOwn) return 'transfer-out';
  if (step.target !== undefined) return 'sell-to';
  return 'hold';
}

/**
 * Move tokens between two accounts the rehearsal owns.
 *
 * `createTransferInstruction` rather than spl-token's `transfer` helper so the
 * token program is passed explicitly: `create_v2` coins are Token-2022 (G6),
 * and the helper defaults to the classic program id — which fails with an
 * owner mismatch that reads like a permissions problem.
 *
 * The destination ATA is created if absent, and paid for by the sender, who is
 * the only key this has.
 */
async function transferTokens({ connection, sender, source, recipient, mint, amount, tokenProgram }) {
  const { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } =
    await import('@solana/spl-token');

  // `mint` arrives as a base58 string — `config.mint.toBase58()` in main.
  // `associatedTokenAddress` coerces internally, which is why every other path
  // in this file works with it; spl-token's instruction builders do not, and
  // hand back `x.pubkey.toBase58 is not a function` from deep inside
  // `Transaction.add`. B9 and B10 are the only rows that reach this helper, so
  // the two rows that prove L22 — a transfer is not a sale — had never once run.
  const mintKey = new PublicKey(mint);
  const destination = associatedTokenAddress(recipient, mintKey, tokenProgram);
  const tx = new Transaction().add(
    // Idempotent: the recipient is another cast wallet and usually already has
    // the account, but B10's sink may not if it has never been bought into.
    createAssociatedTokenAccountIdempotentInstruction(
      sender.publicKey, destination, recipient, mintKey, tokenProgram,
    ),
    createTransferInstruction(source, destination, sender.publicKey, amount, [], tokenProgram),
  );
  return sendAndConfirmTransaction(connection, tx, [sender], { commitment: 'confirmed' });
}

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, plan: false, assign: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = true;
    else if (argv[i] === '--assign') args.assign = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

const tokens = (raw) => (Number(raw) / 10 ** MINT_DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'scenario-driver.mjs');

  const manifest = readManifest();
  if (!manifest.cast?.length) throw new Error('no cast in the manifest — run mk-pump-cast.mjs first');

  if (args.assign) {
    const assignment = assignWallets(manifest.cast);
    manifest.scenarioAssignment = assignment;
    writeManifest(manifest);
    console.log(`\nCALLPOOL — assigned ${Object.keys(assignment).length} matrix rows\n`);
    for (const [row, wallet] of Object.entries(assignment)) console.log(`  ${row.padEnd(5)} → ${wallet}`);
    console.log('\nWritten to the manifest. It is read from there from now on, never recomputed.\n');
    return;
  }

  const assignment = manifest.scenarioAssignment;
  if (!assignment) throw new Error('no assignment in the manifest — run with --assign first');
  if (args.epoch === undefined) throw new Error('--epoch <N> is required');

  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const epoch = Number(args.epoch);
  const window = windowForEpoch(config, epoch);
  const plan = planFor({ window, assignment });

  console.log(`\nCALLPOOL — scenario matrix for epoch ${epoch}`);
  console.log(`window    ${iso(window.start)} → ${iso(window.end)}`);
  console.log(`steps     ${plan.length}\n`);

  for (const step of plan) {
    console.log(
      `  ${iso(step.at).slice(11, 19)}  ${step.id.padEnd(5)} ${step.wallet.padEnd(5)} ` +
        `${actionOf(step).padEnd(13)} ${step.expect}`,
    );
  }

  if (args.plan) {
    console.log('\n--plan: nothing was sent.\n');
    return;
  }

  const pump = await import(PUMP_FEES);
  const tokenProgram = await tokenProgramForMint(connection, mint);
  const ammPool = await pump.readAmmPool(args.rpc, mint);
  const byName = new Map(manifest.cast.map((m) => [m.name, m]));
  console.log(`\nvenue     ${ammPool.exists ? 'AMM (graduated)' : 'bonding curve'}\n`);

  // Check affordability before the first row fires, not when each one does.
  const balances = new Map();
  for (const step of plan) {
    if (step.buy === undefined || balances.has(step.wallet)) continue;
    const member = byName.get(step.wallet);
    if (member) balances.set(step.wallet, await connection.getBalance(new PublicKey(member.address)));
  }
  const short = underfundedSteps(plan, { balances });
  if (short.length > 0) {
    console.log(`⚠️  ${short.length} step(s) cannot be afforded by the wallet assigned to them:\n`);
    for (const s of short) {
      console.log(
        `  ${s.id.padEnd(5)} ${s.wallet}  holds ${(Number(s.have) / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
          `needs ${(Number(s.need) / LAMPORTS_PER_SOL).toFixed(6)}`,
      );
    }
    console.log('\n  Top these up and re-run. Continuing — the rows that CAN run still will.\n');
  }

  const failures = [];
  for (const step of plan) {
   try {
    const member = byName.get(step.wallet);
    if (!member) throw new Error(`the assignment names ${step.wallet}, which is not in the cast`);

    // Relative timing is the point of the table, so the runner honours it. A
    // step that has already passed is skipped rather than fired late: firing it
    // late writes a balance history that no row in §5 describes, which is worse
    // than a missing row because it looks like a result.
    const now = Math.floor(Date.now() / 1000);
    if (now > step.at + 30) {
      console.log(`  SKIP  ${step.id} — its moment (${iso(step.at).slice(11, 19)}) has passed`);
      continue;
    }
    if (now < step.at) {
      await new Promise((r) => setTimeout(r, (step.at - now) * 1000));
    }

    const wallet = loadKeypair(member.keypair);
    const ata = associatedTokenAddress(wallet.publicKey, mint, tokenProgram);
    const before = await currentBalanceRaw(connection, ata);
    const action = actionOf(step);

    // B9/B10 — a transfer, not a sale, and the difference is the point of the
    // rows. L6 judges a wallet on where its own balance ends up, so proving
    // "there is no netting across wallets" needs the tokens to actually land
    // in another wallet the same person owns. A sell would move the balance
    // the same way and prove something else.
    if (step.transferToOwn) {
      const sink = manifest.cast.find((m) => m.name !== member.name && m.scenario === true);
      if (!sink) throw new Error(`${step.id} needs a second wallet to transfer into and the cast has none`);
      const target = BigInt(step.target);
      if (before <= target) {
        console.log(`  SKIP  ${step.id} — holds ${tokens(before)}, already at or under its target`);
        continue;
      }
      const signature = await transferTokens({
        connection,
        sender: wallet,
        source: ata,
        recipient: loadKeypair(sink.keypair).publicKey,
        mint,
        amount: before - target,
        tokenProgram,
      });
      const after = await settledBalance(connection, ata, before);
      console.log(
        `  ${step.id.padEnd(5)} ${'transfer-out'.padEnd(13)} ${tokens(before)} → ${tokens(after)} ` +
          `to ${sink.name}${after >= MIN_HOLD_RAW ? '' : '  (below the floor)'}  ${signature.slice(0, 8)}…`,
      );
      continue;
    }

    let built = null;
    if (step.buy !== undefined) {
      const lamports = BigInt(Math.round(step.buy * LAMPORTS_PER_SOL));
      built = ammPool.exists
        ? await pump.buildAmmBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), lamports.toString())
        : await pump.buildBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), lamports.toString());
    } else if (step.target !== undefined) {
      const target = BigInt(step.target);
      if (before <= target) {
        console.log(`  SKIP  ${step.id} — holds ${tokens(before)}, already at or under its ${tokens(target)} target`);
        continue;
      }
      const amount = before - target;
      built = ammPool.exists
        ? await pump.buildAmmSellInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString())
        : await pump.buildSellInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString());
    }

    const signature = built
      ? await sendAndConfirmTransaction(
          connection,
          new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
            ...built.instructions.map(instructionFrom),
          ),
          [wallet],
          { commitment: 'confirmed' },
        )
      : null;

    // `settledBalance`, not a bare read: the send above is confirmed, but the
    // read that follows can be answered by a node behind the one that confirmed.
    // On 2026-08-09 that printed `9,431,602 → 9,431,602` for A3 — a row whose
    // sale had in fact landed it on exactly 99,999 — which reads as "the sell
    // did nothing" and is the single most misleading thing this log can say.
    const after = await settledBalance(connection, ata, before);
    console.log(
      `  ${step.id.padEnd(5)} ${action.padEnd(13)} ${tokens(before)} → ${tokens(after)}` +
        `${after >= MIN_HOLD_RAW ? '' : '  (below the floor)'}` +
        `${signature ? `  ${signature.slice(0, 8)}…` : ''}`,
    );
   } catch (error) {
    // One row must not cost the other twenty-two.
    //
    // These steps fire at fixed fractions of an epoch, so a throw does not just
    // lose the failing row — every later row's moment passes while the process
    // is dead, and the epoch cannot be re-driven because its window has closed.
    // On 2026-08-09 a single unaffordable buy at A4 took twenty-one rows with
    // it. Record it and keep going: a matrix with one hole and twenty-two
    // results is worth incomparably more than a clean abort.
    failures.push({ id: step.id, wallet: step.wallet, message: error.message.split('\n')[0] });
    console.log(`  FAIL  ${step.id.padEnd(5)} ${step.wallet}  ${error.message.split('\n')[0]}`);
   }
  }

  if (failures.length > 0) {
    console.log(`\n⚠️  ${failures.length} step(s) failed and were skipped:\n`);
    for (const f of failures) console.log(`  ${f.id.padEnd(5)} ${f.wallet}  ${f.message}`);
    process.exitCode = 1;
  }

  console.log('\nEpoch driven. Assert against the `expect` column above.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nSCENARIO DRIVER FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
