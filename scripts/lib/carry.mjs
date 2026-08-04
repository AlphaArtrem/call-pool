// Carry-forward: the dust ledger, hash-chained.
//
// With daily epochs most shares are small, and a share worth less than the fee
// to send it costs more to deliver than it is worth. Decision 18 carries those
// forward rather than paying them, which under daily airdrops (L8) is
// **mandatory, not a nicety** — we pay the gas.
//
// The ledger is off-chain state, which is a real weakness (§9.7), so two
// things make it checkable:
//
//   * every `carry.json` records the **SHA-256 of the previous epoch's file**,
//     making the ledger append-only and tamper-evident. Without it, an epoch
//     that quietly under-allocates is invisible.
//   * every epoch publishes a reconciliation of
//     `Σ allocations + Σ carried + Σ expired` against `Σ pool inflows`, so a
//     verifier can check the *stream* and not only one epoch in isolation.
//
// Carry belonging to someone who never becomes eligible again expires after
// CARRY_EXPIRY_EPOCHS and returns to the pool.

import { createHash } from 'node:crypto';

export const CARRY_EXPIRY_EPOCHS = 30;

/**
 * Below this, a share is not worth the transaction that would deliver it.
 *
 * A claim costs one signature (5,000 lamports) plus whatever priority fee the
 * network demands, and the airdrop batches several claims per transaction —
 * so the true per-recipient cost is a fraction of that plus the compute. Ten
 * thousand lamports is two base signatures: comfortably above the real cost,
 * and still ~0.00001 SOL, so nothing meaningful is ever withheld.
 *
 * Withholding is not forfeiting. The amount is credited in the next epoch.
 */
export const DUST_THRESHOLD_LAMPORTS = 10_000n;

/** SHA-256 of a carry file's canonical JSON, for the next epoch to record. */
export function hashCarryFile(carry) {
  return createHash('sha256').update(`${JSON.stringify(carry, null, 2)}\n`).digest('hex');
}

/** The genesis of the chain: epoch 0 has no predecessor to hash. */
export function emptyCarry() {
  return {
    epoch: null,
    previousCarrySha256: null,
    balances: {},
    expired: [],
    totals: { carried: '0', expired: '0' },
  };
}

/**
 * Fold this epoch's withheld dust into the running ledger.
 *
 * @param {object} previous       the previous epoch's carry.json (or emptyCarry())
 * @param {object} args
 * @param {number} args.epoch
 * @param {Map<string, bigint>} args.withheld  wallet → lamports withheld this epoch
 * @param {Set<string>} args.paid              wallets that were paid this epoch
 * @returns {{ carry: object, expiredLamports: bigint }}
 */
export function advanceCarry(previous, { epoch, withheld, paid }) {
  const balances = {};
  const expired = [];
  let expiredLamports = 0n;

  for (const [wallet, entry] of Object.entries(previous.balances ?? {})) {
    // A wallet paid this epoch has had its carry included in the payout, so it
    // starts again from zero rather than being counted twice.
    if (paid.has(wallet)) continue;

    if (epoch - entry.sinceEpoch >= CARRY_EXPIRY_EPOCHS) {
      expired.push({ wallet, lamports: entry.lamports, sinceEpoch: entry.sinceEpoch, expiredAt: epoch });
      expiredLamports += BigInt(entry.lamports);
      continue;
    }
    balances[wallet] = { ...entry };
  }

  for (const [wallet, lamports] of withheld) {
    if (lamports <= 0n) continue;
    const existing = balances[wallet];
    balances[wallet] = {
      lamports: ((existing ? BigInt(existing.lamports) : 0n) + lamports).toString(),
      // The clock runs from when the wallet's carry *started* accumulating, so
      // topping it up daily cannot keep dust alive forever.
      sinceEpoch: existing?.sinceEpoch ?? epoch,
    };
  }

  const carried = Object.values(balances).reduce((sum, e) => sum + BigInt(e.lamports), 0n);

  return {
    carry: {
      epoch,
      previousCarrySha256: previous.epoch === null ? null : hashCarryFile(previous),
      balances,
      expired,
      totals: { carried: carried.toString(), expired: expiredLamports.toString() },
    },
    expiredLamports,
  };
}

/** What a wallet is owed from previous epochs, to fold into this epoch's share. */
export function carriedFor(carry, wallet) {
  const entry = carry.balances?.[wallet];
  return entry ? BigInt(entry.lamports) : 0n;
}

/**
 * Walk the chain and assert every link. This is what makes the ledger a ledger.
 *
 * @param {object[]} files  carry.json for consecutive epochs, oldest first
 */
export function verifyCarryChain(files) {
  const problems = [];
  for (let i = 1; i < files.length; i++) {
    const expected = hashCarryFile(files[i - 1]);
    if (files[i].previousCarrySha256 !== expected) {
      problems.push({
        epoch: files[i].epoch,
        expected,
        found: files[i].previousCarrySha256,
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The stream reconciliation: does every lamport the pool received end up
 * allocated, carried, or expired?
 *
 * Checking one epoch in isolation cannot catch a crank that quietly
 * under-allocates every day, because under-allocating is individually
 * harmless — the money simply stays in the pool. Only the running total shows it.
 */
export function reconcile({ inflows, allocated, carried, expired }) {
  const accounted = allocated + carried + expired;
  return {
    inflows: inflows.toString(),
    allocated: allocated.toString(),
    carried: carried.toString(),
    expired: expired.toString(),
    unallocated: (inflows - accounted).toString(),
    ok: accounted <= inflows,
  };
}
