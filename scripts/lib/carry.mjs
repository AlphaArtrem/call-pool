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
import { existsSync, readFileSync } from 'node:fs';

export const CARRY_EXPIRY_EPOCHS = 30;

/**
 * Re-exported, not defined here. Moved to config.mjs in Phase 07 so the
 * website can read it without importing this module's `node:crypto`
 * dependency. Same constant, one definition.
 */
export { DUST_THRESHOLD_LAMPORTS } from './config.mjs';

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
 * The previous epoch's ledger — or a refusal.
 *
 * This used to be `readJson(path, emptyCarry())`: if the file was missing, the
 * settlement started the ledger over. That turns the project's most-feared
 * failure — an epoch that does not settle — into a silent one. Every wallet's
 * dust credit is wiped, the hash chain restarts, and the epoch it produces is
 * internally consistent, so nothing downstream can tell. It was the one place
 * the repo guessed instead of refusing.
 *
 * `--carry-reset` still allows a restart, deliberately and on the record.
 *
 * @param {object} args
 * @param {number} args.epoch          the epoch being built
 * @param {string} args.path           the previous epoch's carry.json
 * @param {boolean} [args.carryReset]  permit an absent ledger and start fresh
 */
export function previousCarryFor({ epoch, path, carryReset = false }) {
  // Epoch 0 has no predecessor. That is genesis, not a restart.
  if (epoch === 0) return emptyCarry();
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));

  if (carryReset) {
    console.warn(
      `warn      no carry ledger at ${path}\n` +
        `warn      --carry-reset given: starting a new carry chain at epoch ${epoch}.\n` +
        'warn      Every unpaid dust balance from before this epoch is forfeited.',
    );
    return emptyCarry();
  }

  throw new Error(
    `no carry ledger for epoch ${epoch - 1}: ${path}\n` +
      `Epoch ${epoch - 1} has not settled, so every wallet's carried dust is unknown. ` +
      'Settle it first, or pass --carry-reset to forfeit those balances and start a new chain.',
  );
}

/**
 * Decide, once, which entries this epoch still owes and which have expired.
 *
 * This exists because expiry used to be decided in two places that could
 * disagree inside a single epoch: `buildEpoch` read a wallet's balance to pay
 * it while `advanceCarry` expired that same balance back into the pool. Both
 * callers now consume this, so expiry is settled *before* anything reads a
 * balance and the two answers cannot drift.
 *
 * @param {object} previous  the previous epoch's carry.json (or emptyCarry())
 * @param {number} epoch     the epoch being built
 * @returns {{ active: object, expired: object[], expiredLamports: bigint, activeTotal: bigint }}
 */
export function splitCarry(previous, epoch) {
  const active = {};
  const expired = [];
  let expiredLamports = 0n;
  let activeTotal = 0n;

  for (const [wallet, entry] of Object.entries(previous.balances ?? {})) {
    if (epoch - entry.sinceEpoch >= CARRY_EXPIRY_EPOCHS) {
      expired.push({ wallet, lamports: entry.lamports, sinceEpoch: entry.sinceEpoch, expiredAt: epoch });
      expiredLamports += BigInt(entry.lamports);
      continue;
    }
    active[wallet] = { ...entry };
    activeTotal += BigInt(entry.lamports);
  }

  return { active, expired, expiredLamports, activeTotal };
}

/**
 * Fold this epoch's withheld dust into the running ledger.
 *
 * `withheld` carries **only the dust that arose this epoch** — the wallet's
 * existing balance is retained here, so passing `share + carried` would credit
 * the carried part twice and compound it every epoch.
 *
 * @param {object} previous       the previous epoch's carry.json (or emptyCarry())
 * @param {object} args
 * @param {number} args.epoch
 * @param {Map<string, bigint>} args.withheld  wallet → lamports newly withheld this epoch
 * @param {Set<string>} args.paid              wallets that were paid this epoch
 * @param {object} [args.split]                `splitCarry` result, when the caller already has one
 * @returns {{ carry: object, expiredLamports: bigint }}
 */
export function advanceCarry(previous, { epoch, withheld, paid, split }) {
  const { active, expired, expiredLamports } = split ?? splitCarry(previous, epoch);
  const balances = {};

  for (const [wallet, entry] of Object.entries(active)) {
    // A wallet paid this epoch has had its carry included in the payout, so it
    // starts again from zero rather than being counted twice.
    if (paid.has(wallet)) continue;
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

/**
 * What a wallet is owed from previous epochs, to fold into this epoch's share.
 *
 * Give this the **active** balances (`splitCarry().active`), never the raw
 * previous ledger: an entry expiring this epoch is owed to the pool, not to
 * the wallet, and reading it here would pay it out and return it at once.
 */
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
 * Does every allocatable lamport end up allocated, carried, or expired?
 *
 * This checks **one epoch**, not the stream — the docstring used to promise a
 * running Σ-inflows reconciliation that the implementation never did. Per-epoch
 * is now a real check rather than a tautology: since shares divide the pool net
 * of what the ledger owes, `allocated + carried + expired` cannot exceed
 * `inflows` unless something is genuinely wrong. Before that fix the two sides
 * were computed from the same over-counted numbers and always agreed.
 *
 * The caller passes `inflows` as the epoch's allocatable balance. A running
 * total across epochs would additionally catch a crank that under-allocates
 * every day — individually harmless, since the money stays in the pool — and
 * that remains unbuilt.
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
