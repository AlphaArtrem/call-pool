// Steps 3–7 of the crank, with no I/O in them.
//
// Given the callout records for a window, a `hold` for each caller, the pool's
// allocatable balance and the previous carry ledger, this produces the payouts,
// the tree and the root — deterministically. Anyone with the published inputs
// derives the same output, which is the property the whole audit story rests
// on, so it lives apart from the fetching that produced those inputs.
//
//   eligible(w, d) = active(w, d) ∧ hold(w, d) ≥ min_hold ∧ ¬locked(w, d)
//   weight(w, d)   = hold(w, d)                       ← linear, no multiplier
//   payout(w, d)   = pool(d) · weight(w, d) / Σ weight
//
// Weight is **exactly linear**, and that is load-bearing rather than
// convenient: any concave function pays sybils a premium, because splitting one
// bag across n wallets would increase total weight. Never "make it fairer".

import { advanceCarry, carriedFor, DUST_THRESHOLD_LAMPORTS, splitCarry } from './carry.mjs';
import { activeWallets } from './callouts.mjs';
import { buildProof, buildTree } from './merkle.mjs';

/**
 * @param {object} args
 * @param {number} args.epoch
 * @param {{start:number,end:number}} args.window
 * @param {object} args.calloutStore          the rolling store, raw records
 * @param {Map<string, object>} args.holds    wallet → result from holds.mjs
 * @param {bigint} args.available             lamports the program will let us allocate
 * @param {object} args.previousCarry
 * @param {bigint} args.minHold               raw units
 * @param {bigint} [args.dustThreshold]
 */
export function buildEpoch({
  epoch,
  window,
  calloutStore,
  holds,
  available,
  previousCarry,
  minHold,
  dustThreshold = DUST_THRESHOLD_LAMPORTS,
}) {
  // ── step 1: who was active ───────────────────────────────────────────────
  const { active, counted, excluded } = activeWallets(calloutStore, window);

  // ── step 3: filter ───────────────────────────────────────────────────────
  const rows = [];
  for (const wallet of [...active].sort()) {
    const held = holds.get(wallet);
    if (!held) {
      // Every active wallet must have had its history replayed. A missing one
      // means the crank skipped a caller, which would silently underpay them.
      throw new Error(`no hold computed for active wallet ${wallet}`);
    }
    // L20 — the floor is checked against `sustained`, the weight is `hold`.
    //
    // They are the same number for a wallet that held all day, which is why
    // existing holders' payouts do not move. They differ for a wallet that
    // bought partway through: 500,000 tokens bought at 20:00 clears a 100,000
    // floor on what it held, and is paid on 4/24 of it. Checking the floor
    // against the prorated number instead would exclude exactly the holders
    // this rule exists to include.
    //
    // `sustained` falls back to `hold` so a caller passing pre-L20 hold objects
    // (or a fixture) keeps the old, stricter behaviour rather than silently
    // treating every wallet as eligible.
    const sustained = held.sustained ?? held.hold;
    rows.push({
      wallet,
      hold: held.hold,
      sustained,
      locked: held.locked,
      meetsFloor: sustained >= minHold,
      eligible: sustained >= minHold && !held.locked,
    });
  }

  const eligible = rows.filter((r) => r.eligible);
  const totalWeight = eligible.reduce((sum, r) => sum + r.hold, 0n);

  // ── steps 4-6: weight and split ──────────────────────────────────────────
  // BigInt throughout, and division floors — so the rounding remainder stays in
  // the pool rather than being allocated to someone. That is the safe direction:
  // an epoch can under-allocate harmlessly, but over-allocating turns claims
  // into a race.
  //
  // Expiry is decided once, here, before any balance is read.
  const split = splitCarry(previousCarry, epoch);
  const activeCarry = { balances: split.active };

  // Withheld dust was never allocated on chain, so it is still sitting in the
  // pool and is still inside `available` — but it is already promised. Only
  // what is left after the ledger's claim is anyone's to divide; dividing all
  // of `available` would re-divide money that is owed, every single epoch.
  // Expired lamports are deliberately *not* subtracted: they are free again.
  if (available < split.activeTotal) {
    throw new Error(
      `carry ledger disagrees with the pool at epoch ${epoch}: ` +
        `${split.activeTotal} lamports owed as carry exceeds ${available} allocatable. ` +
        'Settle the previous epoch or reconcile the ledger — do not clamp this.',
    );
  }
  const divisible = available - split.activeTotal;

  const payouts = [];
  const withheld = new Map();
  const paid = new Set();

  for (const row of eligible) {
    const share = totalWeight === 0n ? 0n : (divisible * row.hold) / totalWeight;
    const carried = carriedFor(activeCarry, row.wallet);
    const total = share + carried;

    if (total < dustThreshold) {
      // Not forfeited — credited in the next epoch (Decision 18). With daily
      // epochs this is most wallets on most days. Only `share` is new: the
      // carried part is already in the ledger and is retained there.
      withheld.set(row.wallet, share);
      payouts.push({ ...row, share, carried, amount: 0n, withheld: total });
    } else {
      paid.add(row.wallet);
      payouts.push({ ...row, share, carried, amount: total, withheld: 0n });
    }
  }

  // ── step 7: the tree ─────────────────────────────────────────────────────
  const leafInputs = payouts
    .filter((p) => p.amount > 0n)
    .map((p) => ({ owner: p.wallet, amount: p.amount }));
  const { root, leaves, levels } = buildTree(leafInputs, epoch);

  // `allocate` is exactly what the tree pays. Anything the division left over,
  // plus every withheld share, stays free in the pool for tomorrow rather than
  // sitting as `outstanding` until close_epoch.
  const allocate = leafInputs.reduce((sum, l) => sum + l.amount, 0n);

  const { carry, expiredLamports } = advanceCarry(previousCarry, {
    epoch,
    withheld,
    paid,
    split,
  });

  const tree = leaves.map((leaf) => ({
    index: leaf.index,
    owner: leaf.owner,
    amount: leaf.amount,
    proof: buildProof(levels, leaf.index),
  }));

  return {
    epoch,
    window,
    root,
    leafCount: leaves.length,
    allocate,
    available,
    divisible,
    carryOwed: split.activeTotal,
    totalWeight,
    rows,
    payouts,
    tree,
    carry,
    expiredLamports,
    callouts: { counted, excluded, activeCount: active.size },
  };
}

/** `payouts.csv` — the human-readable row per caller, per Phase 05 §5.3. */
export function payoutsCsv(built) {
  const byWallet = new Map(built.payouts.map((p) => [p.wallet, p]));
  const indexOf = new Map(built.tree.map((leaf) => [leaf.owner, leaf.index]));

  const lines = ['index,owner,hold,locked,eligible,weight,carried,payout_lamports,withheld_lamports'];
  for (const row of built.rows) {
    const p = byWallet.get(row.wallet);
    lines.push(
      [
        indexOf.has(row.wallet) ? indexOf.get(row.wallet) : '',
        row.wallet,
        row.hold.toString(),
        row.locked,
        row.eligible,
        row.eligible ? row.hold.toString() : '0',
        (p?.carried ?? 0n).toString(),
        (p?.amount ?? 0n).toString(),
        (p?.withheld ?? 0n).toString(),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
