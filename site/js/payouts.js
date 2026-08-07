// "Was I actually paid?" — answered from the published audit trail alone.
//
// The wallet panel tells you your *standing*: whether you qualify today. It
// deliberately shows no lamport figure, because today's epoch has not settled
// so no amount exists, and quoting a projection would be a return rather than a
// mechanic (L9).
//
// But that left a real hole. A share can be allocated and never delivered two
// ways, and they mean opposite things:
//
//   * the airdrop failed for that leaf — RPC, funding, a crash mid-run. Someone
//     should re-run it, and the money is still owed.
//   * `claim` refused the holder because they had sold below the floor by the
//     time it ran (§4.5). Working as designed, and the money correctly stayed
//     in the pool.
//
// The watchdog notices the epoch-wide case — allocated money with nothing
// claimed at all — but a single wallet's undelivered share fired nothing and
// appeared nowhere, so its owner could not tell those two apart, or even know
// there was something to ask about.
//
// This needs **no chain reads**. Every fact is already published: `tree.json`
// carries the leaves with their owners and amounts, and `airdrop.json` records
// which leaf indices were sent, which failed, and why. That is the point of
// publishing them — a stranger can audit any epoch, and so can the person it
// belongs to.

/** A leaf's delivery state. Ordered by how much attention it deserves. */
export const DELIVERY = Object.freeze({
  paid: 'paid',
  refused: 'refused',   // policy — sold below the floor. Correct, not a fault.
  failed: 'failed',     // mechanical — owed, and someone should re-run it.
  pending: 'pending',   // settled, but the airdrop has not run yet.
  none: 'none',         // not in this epoch's tree at all.
});

/** Is this leaf index in one of the recorded batches? */
function inBatches(batches, index) {
  return (batches ?? []).find((b) => (b.leaves ?? []).includes(index)) ?? null;
}

/**
 * Every batch the airdrop ever recorded for this epoch, across all runs.
 *
 * **Not the top-level `sent`/`failed`.** Those describe the *most recent* run
 * only. A re-run after a partial failure sends nothing — the already-paid
 * leaves are refused on chain as write-once — so the top level ends up empty
 * and every leaf paid by the first run looks undelivered.
 *
 * Caught by running this against the real epoch-1 audit trail, where two leaves
 * had signatures and still reported as failures. `runs[]` is the durable record
 * and the only honest source; the top level is a summary of the last attempt.
 */
function allBatches(airdrop) {
  const runs = Array.isArray(airdrop?.runs) && airdrop.runs.length > 0 ? airdrop.runs : [airdrop];
  const sent = [];
  const failed = [];
  for (const run of runs) {
    sent.push(...(run?.sent ?? []));
    failed.push(...(run?.failed ?? []));
  }
  return { sent, failed };
}

/**
 * What happened to one wallet in one epoch.
 *
 * `airdrop` may be null — a settled epoch whose airdrop has not run yet is a
 * normal, temporary state, and saying "pending" is the honest answer rather
 * than implying something went wrong.
 *
 * @param {{leaves?: {index:number, owner:string, amount:string}[]}} tree
 * @param {{sent?: object[], failed?: object[]}|null} airdrop
 * @param {string} wallet
 */
export function deliveryFor(tree, airdrop, wallet) {
  const leaf = (tree?.leaves ?? []).find((l) => l.owner === wallet);
  if (!leaf) return { state: DELIVERY.none, amount: 0n };

  const amount = BigInt(leaf.amount);
  if (!airdrop) return { state: DELIVERY.pending, amount, index: leaf.index };

  // Paid wins over failed, always: a leaf can be sent by one run and refused
  // by a later one (claims are write-once, so the re-run bounces). The send is
  // the fact; the bounce is an artefact of asking twice.
  const batches = allBatches(airdrop);
  const sent = inBatches(batches.sent, leaf.index);
  if (sent) {
    return { state: DELIVERY.paid, amount, index: leaf.index, signature: sent.signature };
  }

  const failed = inBatches(batches.failed, leaf.index);
  if (failed) {
    // `policy` distinguishes "the chain refused this on purpose" from "the
    // send broke". Collapsing them would tell a holder who sold that the
    // system owes them money, and tell someone genuinely unpaid that it does
    // not. They are the two answers that must never be swapped.
    return {
      state: failed.policy ? DELIVERY.refused : DELIVERY.failed,
      amount,
      index: leaf.index,
      reason: failed.error ?? null,
    };
  }

  // In the tree, the airdrop ran, and this leaf appears in neither list. The
  // run did not reach it — same practical position as a failure, so it is
  // reported as one rather than quietly omitted.
  return { state: DELIVERY.failed, amount, index: leaf.index, reason: null };
}

/**
 * Roll several epochs into the one line a holder actually wants.
 *
 * Deliberately does **not** sum `refused` into anything owed. A holder who sold
 * below the floor is not owed that money — it stayed in the pool for everyone
 * else — and presenting it as a balance would be a false claim on the pool.
 *
 * @param {{epoch:number, tree:object, airdrop:object|null}[]} epochs
 * @param {string} wallet
 */
export function payoutHistory(epochs, wallet) {
  const rows = [];
  let paid = 0n;
  let owed = 0n;
  let refused = 0n;

  for (const { epoch, tree, airdrop } of epochs) {
    const result = deliveryFor(tree, airdrop, wallet);
    if (result.state === DELIVERY.none) continue;
    rows.push({ epoch, ...result });
    if (result.state === DELIVERY.paid) paid += result.amount;
    else if (result.state === DELIVERY.refused) refused += result.amount;
    else owed += result.amount; // failed and pending are both still owed
  }

  rows.sort((a, b) => b.epoch - a.epoch);
  return {
    rows,
    paid,
    owed,
    refused,
    // The only condition that should make a holder act, as opposed to read.
    needsAttention: rows.some((r) => r.state === DELIVERY.failed),
  };
}

/**
 * One sentence per epoch, in the voice the rest of the site uses.
 *
 * A refusal says what the holder did, not that something broke — it is the
 * mechanic working, and the copy has to make that unmistakable or it reads as
 * an outage.
 */
export function describeDelivery(row, formatSol) {
  const amount = formatSol(row.amount);
  switch (row.state) {
    case DELIVERY.paid:
      return `paid ${amount}`;
    case DELIVERY.refused:
      return `${amount} not paid — this wallet held less than the floor when the airdrop ran, so its share stayed in the pool`;
    case DELIVERY.failed:
      return `${amount} allocated but not delivered — still claimable until the deadline`;
    case DELIVERY.pending:
      return `${amount} allocated — the airdrop for this epoch has not run yet`;
    default:
      return 'nothing allocated';
  }
}
