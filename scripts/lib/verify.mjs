// Reproducing a published epoch, exactly.
//
// "Every epoch publishes its raw inputs and its script. An epoch whose root
// cannot be recomputed by a stranger is an epoch that did not happen properly."
// This is that script's engine, and it has two modes whose difference is the
// whole point (Phase 05 §5.3):
//
//   offline        recompute the root from the committed files. Proves the
//                  arithmetic.
//   recheck-chain  re-derive balances.json from an RPC, ignoring the committed
//                  copy, and assert it matches. Proves the balance data was not
//                  fabricated.
//
// Only `callouts.json` cannot be checked this way — which is exactly the trust
// boundary drawn in §5.1, and exactly why the per-wallet route matters: a
// holder can always check their own row.
//
// ⚠️ `--recheck-chain` on an old epoch needs **archival** RPC access, because
// `getSignaturesForAddress` and `getTransaction` do not keep six-month-old
// history on an ordinary node. So it means "anyone with an archival provider
// and an afternoon", not "anyone" — publishing the signatures in balances.json
// is what keeps the claim defensible (§5.10).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { emptyCarry, hashCarryFile, reconcile } from './carry.mjs';
import { buildEpoch } from './epoch-build.mjs';
import { readJson } from './store.mjs';
import { lpMint } from './pump-addresses.mjs';
import { computeHold, computeLocked } from './timeline.mjs';
import { lockoutWindow } from './epoch.mjs';
import { LOCKOUT_EPOCHS } from './config.mjs';

const big = (v) => BigInt(v);

/** Rebuild the callout store shape the snapshot used, from its own capture. */
function storeFrom(callouts) {
  const records = [...callouts.counted, ...callouts.excluded];
  return Object.fromEntries(records.map((r) => [r.id, r]));
}

/** Turn balances.json back into the `holds` map `buildEpoch` expects. */
function holdsFrom(balances) {
  return new Map(
    Object.entries(balances).map(([wallet, entry]) => [
      wallet,
      { hold: big(entry.hold), locked: entry.locked, ata: entry.tokenAccount },
    ]),
  );
}

/**
 * Recompute an epoch from its own directory.
 *
 * @param {string} dir      snapshots/epoch-N
 * @param {object} options
 * @param {bigint} options.minHold   the on-chain floor, in raw units
 * @returns {{ ok: boolean, problems: string[], recomputed: object, published: object }}
 */
export function verifyOffline(dir, { minHold }) {
  const problems = [];
  const callouts = readJson(resolve(dir, 'callouts.json'));
  const balances = readJson(resolve(dir, 'balances.json'));
  const pool = readJson(resolve(dir, 'pool.json'));
  const carry = readJson(resolve(dir, 'carry.json'));
  const tree = readJson(resolve(dir, 'tree.json'));

  const epoch = tree.epoch;
  const previousDir = resolve(dir, `../epoch-${epoch - 1}`);
  const previousCarry =
    epoch === 0 || !existsSync(resolve(previousDir, 'carry.json'))
      ? emptyCarry()
      : readJson(resolve(previousDir, 'carry.json'));

  const recomputed = buildEpoch({
    epoch,
    window: callouts.window,
    calloutStore: storeFrom(callouts),
    holds: holdsFrom(balances),
    available: big(pool.available),
    previousCarry,
    minHold,
  });

  // ── the root ─────────────────────────────────────────────────────────────
  if (recomputed.root.toString('hex') !== tree.root) {
    problems.push(
      `root mismatch: published ${tree.root}, recomputed ${recomputed.root.toString('hex')}`,
    );
  }
  if (recomputed.leafCount !== tree.leafCount) {
    problems.push(`leaf_count mismatch: published ${tree.leafCount}, recomputed ${recomputed.leafCount}`);
  }
  if (recomputed.allocate !== big(tree.allocate)) {
    problems.push(`allocate mismatch: published ${tree.allocate}, recomputed ${recomputed.allocate}`);
  }

  // What the epoch was allowed to divide, checked rather than taken on trust.
  // A snapshot that split all of `available` while owing carry would match on
  // the root — it recomputes from the same inputs — but not on these.
  if (pool.divisible !== undefined && recomputed.divisible !== big(pool.divisible)) {
    problems.push(`divisible mismatch: published ${pool.divisible}, recomputed ${recomputed.divisible}`);
  }
  if (pool.carryOwed !== undefined && recomputed.carryOwed !== big(pool.carryOwed)) {
    problems.push(`carry owed mismatch: published ${pool.carryOwed}, recomputed ${recomputed.carryOwed}`);
  }

  // ── every leaf, individually ─────────────────────────────────────────────
  // A matching root already implies this, but a mismatch is far easier to act
  // on when it names the wallet.
  const recomputedLeaves = new Map(recomputed.tree.map((l) => [l.owner, l]));
  for (const leaf of tree.leaves) {
    const mine = recomputedLeaves.get(leaf.owner);
    if (!mine) {
      problems.push(`published leaf ${leaf.index} pays ${leaf.owner}, who is not eligible`);
      continue;
    }
    if (mine.amount !== big(leaf.amount)) {
      problems.push(`${leaf.owner}: published ${leaf.amount}, recomputed ${mine.amount}`);
    }
    if (mine.index !== leaf.index) {
      problems.push(`${leaf.owner}: published index ${leaf.index}, recomputed ${mine.index}`);
    }
  }
  for (const leaf of recomputed.tree) {
    if (!tree.leaves.some((l) => l.owner === leaf.owner)) {
      problems.push(`${leaf.owner} is eligible for ${leaf.amount} but has no published leaf`);
    }
  }

  // ── the carry chain ──────────────────────────────────────────────────────
  // Without this, an epoch that quietly under-allocates is invisible: the money
  // simply stays in the pool and looks like nothing happened.
  const expectedPrevious = previousCarry.epoch === null ? null : hashCarryFile(previousCarry);
  if (carry.previousCarrySha256 !== expectedPrevious) {
    problems.push(
      `carry chain broken: this file records ${carry.previousCarrySha256}, ` +
        `epoch ${epoch - 1}'s carry.json hashes to ${expectedPrevious}`,
    );
  }

  // A restart is not caught by the hash check above, and cannot be: with no
  // predecessor file to hash, "no previous carry" is what a genesis epoch looks
  // like, so a restarted chain reconciles perfectly with itself. The predecessor
  // *directory* is the evidence — epoch N-1 was published, but its ledger is
  // gone, so this epoch forfeited balances it should have inherited.
  if (epoch > 0 && carry.previousCarrySha256 === null && existsSync(previousDir)) {
    problems.push(
      `carry chain restarted at epoch ${epoch}: epoch ${epoch - 1} was published but ` +
        'this ledger claims no predecessor, so every dust balance before it was forfeited',
    );
  }
  if (JSON.stringify(carry.balances) !== JSON.stringify(recomputed.carry.balances)) {
    problems.push('carry balances do not match the recomputed ledger');
  }

  // ── the stream ───────────────────────────────────────────────────────────
  const streamed = reconcile({
    inflows: big(pool.available),
    allocated: recomputed.allocate,
    carried: big(recomputed.carry.totals.carried),
    expired: recomputed.expiredLamports,
  });
  if (!streamed.ok) {
    problems.push(`more was allocated, carried and expired than the pool made available`);
  }

  return { ok: problems.length === 0, problems, recomputed, published: { tree, pool, carry }, streamed };
}

/**
 * Re-derive every balance from chain and assert the committed copy matches.
 *
 * This is the mode that proves the balance data was not fabricated. It reads
 * the same single ATA the crank read (L6) and replays the same transactions.
 *
 * @param {import('@solana/web3.js').Connection} connection
 */
export async function recheckChain(dir, { connection, chain, minHold = null }) {
  const problems = [];
  const callouts = readJson(resolve(dir, 'callouts.json'));
  const balances = readJson(resolve(dir, 'balances.json'));
  const { start, end } = callouts.window;
  const window = { start, end };
  const lockWindow = lockoutWindow(window, LOCKOUT_EPOCHS);

  // L16 — derived here from the mint the epoch's own inputs name, not passed
  // in. The verifier must reach the same lockout verdict as the builder, and
  // the exemption is part of that verdict: a reproducer that did not know
  // about it would call every LP'd wallet locked and refuse a correct epoch.
  const poolLpMint = callouts.mint ? lpMint(callouts.mint) : null;

  for (const [wallet, published] of Object.entries(balances)) {
    const events = await chain.balanceEventsFor(
      connection,
      published.tokenAccount,
      lockWindow.start - (end - start),
      { lpMint: poolLpMint },
    );
    const current = await chain.currentBalanceRaw(connection, published.tokenAccount);

    let derived;
    try {
      derived = computeHold(events, window, { currentBalance: current });
    } catch (error) {
      problems.push(`${wallet}: chain history could not be replayed — ${error.message}`);
      continue;
    }
    // L22 — the floor decides what counts as a sale, so the verifier needs it
    // for the same reason it needs the LP mint: a reproducer that did not know
    // the rule would call a wallet locked that the builder paid, and refuse a
    // correct epoch.
    const locked = computeLocked(events, lockWindow, { minHold }).locked;

    if (derived.hold !== big(published.hold)) {
      problems.push(`${wallet}: published hold ${published.hold}, chain says ${derived.hold}`);
    }
    if (locked !== published.locked) {
      problems.push(`${wallet}: published locked=${published.locked}, chain says ${locked}`);
    }
  }

  return { ok: problems.length === 0, problems, checked: Object.keys(balances).length };
}
