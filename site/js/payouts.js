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
 * Everyone in one epoch's tree, largest share first.
 *
 * The whole-day view of the same question `deliveryFor` answers for one wallet
 * — and it answers it by calling that function per leaf rather than reading
 * the batches a second way, because two readers of `airdrop.json` would
 * eventually disagree and the one on this table would be the one nobody
 * tested.
 *
 * The state travels with each row for the same reason it does there: a leaf
 * that was allocated and refused is not a payment, and a list that prints it
 * beside the paid ones without saying so is a claim we cannot support.
 *
 * @param {{leaves?: {index:number, owner:string, amount:string}[]}} tree
 * @param {{sent?: object[], failed?: object[]}|null} airdrop
 */
export function epochPayouts(tree, airdrop) {
  return (tree?.leaves ?? [])
    .map((leaf) => ({ owner: leaf.owner, ...deliveryFor(tree, airdrop, leaf.owner) }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

/**
 * The biggest single allocation in a day's tree, or null.
 *
 * The record table's "Largest share" column. Null rather than zero when the
 * tree is missing or empty: zero would claim the day allocated nothing, which
 * is a different fact from "we have not read that day's working".
 */
export function largestShare(tree) {
  let largest = null;
  for (const leaf of tree?.leaves ?? []) {
    const amount = BigInt(leaf.amount);
    if (largest == null || amount > largest) largest = amount;
  }
  return largest;
}

/**
 * One day's list summed into the four figures worth stating above it.
 *
 * Deliberately four rather than one. "Allocated" and "paid" are different
 * numbers whenever a wallet sold below the floor before the airdrop ran or a
 * send broke, and a single total would quietly pick one of them and be wrong
 * about the other — the same conflation `payoutHistory` refuses for a wallet.
 *
 * @param {{amount: bigint, state: string}[]} rows  as `epochPayouts` returns them
 */
export function payoutTotals(rows) {
  const totals = { wallets: rows.length, allocated: 0n, paid: 0n, refused: 0n, undelivered: 0n };
  for (const row of rows) {
    totals.allocated += row.amount;
    if (row.state === DELIVERY.paid) totals.paid += row.amount;
    else if (row.state === DELIVERY.refused) totals.refused += row.amount;
    else totals.undelivered += row.amount; // failed and pending are both still owed
  }
  return totals;
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
 * Fold the genesis payout into a wallet's history.
 *
 * Day 0 — coin creation to genesis — was never an on-chain epoch, so it has no
 * tree and `payoutHistory` cannot see it. It was still money that arrived in
 * somebody's wallet, and a panel that leaves it out tells thirteen wallets
 * they have never been paid anything.
 *
 * It is always `paid`: the transfers are published as receipts, so there is no
 * allocated-but-undelivered state to represent. It carries `label` rather than
 * an epoch number because on this site "day 0" means on-chain epoch 0, which
 * is a different, later day — see the note on `day0Row` in epochs.js.
 *
 * @param {{rows: object[], paid: bigint}} history  as `payoutHistory` returns it
 * @param {bigint|null} genesisLamports  what the genesis payout sent this wallet
 */
export function withGenesis(history, genesisLamports) {
  if (genesisLamports == null || genesisLamports <= 0n) return history;
  return {
    ...history,
    rows: [...history.rows, { epoch: null, label: 'Genesis', state: DELIVERY.paid, amount: genesisLamports }],
    paid: history.paid + genesisLamports,
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

/**
 * Today's estimate from the hourly sample — the accurate basis, when there is
 * one.
 *
 * `projectedShare` below has to reach for *yesterday's* ratio because a page
 * load cannot replay every caller's history. `sample-standings.mjs` can, and
 * does, every hour: it runs the crank's own `holdsFor` and `buildEpoch` over
 * the part of today that has happened. So when a sample exists this is the
 * figure to show, and the reason is specific — the denominator is **today's**
 * total weight rather than a settled day's.
 *
 * That matters most for exactly the wallet yesterday's ratio serves worst. A
 * wallet that bought at 20:00 yesterday has a leaf prorated to a sixth of a
 * day; carrying that ratio into a day it has held from the start understates
 * it roughly sixfold. This does not, because it never looks at yesterday.
 *
 * The ratio is applied to the pool **now** rather than the pool at sample
 * time, so fees that arrived since are included. What it cannot include is the
 * rest of the day: `elapsedFraction` says how much of it the sample covers,
 * and the caller is expected to say so.
 *
 * Returns null when there is no usable sample, when this wallet is not
 * eligible in it, or when today has no weight yet — never a zero, which would
 * claim the split considered this wallet and gave it nothing.
 */
export function sampledShare({ provisional, wallet, poolLamports }) {
  if (provisional == null || provisional.settled === true) return null;

  const totalWeight = BigInt(provisional.totalWeight ?? 0);
  if (totalWeight <= 0n) return null;

  const standing = (provisional.standings ?? []).find((s) => s.wallet === wallet);
  if (!standing) return null;

  const weight = BigInt(standing.hold ?? 0);
  // Ineligible is a different answer from "nothing yet", and the page has
  // different words for each: `eligible` is false for a locked wallet and for
  // one below the floor, and `standing` still carries which.
  if (!standing.eligible || weight <= 0n) {
    return { eligible: false, locked: standing.locked === true, meetsFloor: standing.meetsFloor === true,
      sampledAt: provisional.sampledAt ?? null, elapsedFraction: provisional.elapsedFraction ?? null,
      truncated: provisional.truncated === true, indicative: null };
  }

  const pool = BigInt(poolLamports ?? 0);
  return {
    eligible: true,
    locked: false,
    meetsFloor: true,
    numerator: weight,
    denominator: totalWeight,
    indicative: (pool * weight) / totalWeight,
    sampledAt: provisional.sampledAt ?? null,
    elapsedFraction: provisional.elapsedFraction ?? null,
    // Both are reasons the estimate can be short of the truth, and neither is
    // visible in the number. A truncated feed means the sample may have missed
    // callers, which inflates this wallet's share of the total weight.
    truncated: provisional.truncated === true,
    carryKnown: provisional.carryKnown !== false,
  };
}

/**
 * How much of today the estimate is actually based on, and why it will move.
 *
 * The owner's requirement for this tile was that it be as close to reality as
 * possible at the moment someone looks, *and* that it say how close that is.
 * The number alone cannot: a figure drawn from twenty minutes of a day and one
 * drawn from twenty-three hours look identical on screen and are worth
 * completely different amounts of confidence.
 *
 * Kept out of the renderer so the wording is testable, since every sentence
 * here is a claim about money that has not been decided yet.
 *
 * @param {number} nowSeconds  so an old sample is described as old rather than
 *   silently presented as current — the sampler can stall.
 */
export function describeEstimate(sampled, nowSeconds) {
  const covered = Math.round((sampled?.elapsedFraction ?? 0) * 100);
  const ageMinutes =
    sampled?.sampledAt == null ? null : Math.max(0, Math.floor((nowSeconds - sampled.sampledAt) / 60));

  // Two sentences, and only two. This is a tile caption: everything the panel
  // has to say about proration, carry and settlement is said elsewhere, and a
  // paragraph here is a paragraph nobody reads.
  const parts = [
    `Not owed and not promised — from the ${covered}% of the day measured so far.`,
    'The real one is worked out at 00:00 UTC.',
  ];

  // An hourly sample is at most an hour old in normal operation. Past that the
  // sampler has stalled, and the page must not present a stale figure as a
  // current one — the whole point of the tile is that it tracks the day.
  if (ageMinutes != null && ageMinutes >= 90) {
    parts.push(`⚠️ Measured ${Math.floor(ageMinutes / 60)}h ago, so this is out of date.`);
  }

  if (sampled?.truncated) {
    // A full feed means callers may be missing from the denominator, which can
    // only push this wallet's share up.
    parts.push('The callout feed was full, so this may read high.');
  }

  return parts.join(' ');
}

/**
 * What today *might* pay — explicitly a projection, never a promise.
 *
 * **The fallback, used only when no hourly sample is available.** `sampledShare`
 * above is the accurate answer; this is what the page had before anything
 * published one, and what it falls back to if the sampler has stalled.
 *
 * Today's epoch has not settled. Nobody knows the eligible set until it does,
 * and this cannot compute it: that would mean every caller's callout record and
 * every one of their balance histories, which is the crank's job and takes far
 * more than a page load.
 *
 * So it does the one honest thing available. Your share of a settled epoch is
 * `yourAmount / allocate` — a fraction recoverable from the published tree
 * without knowing anyone's balances. Apply the most recent settled fraction to
 * the pool as it stands now, and you have "if today turns out like the last
 * settled day". That is a **basis**, stated as such, not a forecast.
 *
 * Its known weakness, and the reason `sampledShare` exists: under L20/L21 that
 * settled leaf was prorated, so a wallet whose basis day was a part-day carries
 * that day's handicap into today.
 *
 * Returns null when it cannot be computed — you were not in the last tree, or
 * that epoch allocated nothing. **A missing answer is correct here**; inventing
 * one would be exactly the yield framing L9 forbids.
 */
export function projectedShare({ previousTree, wallet, poolLamports }) {
  const allocate = BigInt(previousTree?.allocate ?? 0);
  if (allocate <= 0n) return null;

  const leaf = (previousTree?.leaves ?? []).find((l) => l.owner === wallet);
  if (!leaf) return null;

  const mine = BigInt(leaf.amount);
  if (mine <= 0n) return null;

  const pool = BigInt(poolLamports ?? 0);
  return {
    // Kept as a ratio rather than a float so the arithmetic stays exact and
    // the caller decides how to round for display.
    numerator: mine,
    denominator: allocate,
    basisEpoch: previousTree.epoch ?? null,
    indicative: (pool * mine) / allocate,
  };
}

/**
 * Fetch the published working for a range of epochs.
 *
 * Reads only the audit trail — the same files any stranger can fetch and check
 * — so nothing here depends on our server telling the truth about a balance.
 *
 * A missing `airdrop.json` is a normal, temporary state (settled, not yet
 * paid), so it resolves to null rather than failing the whole load. A missing
 * `tree.json` means the epoch is not published and it is skipped entirely: a
 * wallet cannot have been owed by an epoch that was never settled.
 */
/**
 * Today's sample, or null.
 *
 * Null is an ordinary answer, not an error: the file is absent before the
 * first sample of a deployment, and absent again if the sampler is stalled.
 * The page degrades to `projectedShare` and the hourly card says how old the
 * last sample was — which is the whole reason the card has a staleness state.
 *
 * `settled` is checked by the caller rather than here so that a file of the
 * wrong shape is treated the same as no file at all: this returns what it
 * fetched, and `sampledShare` decides whether it is usable.
 */
export async function loadProvisional({ url, fetchImpl = fetch }) {
  if (!url) return null;
  try {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const parsed = await response.json();
    // A stray object is not a sample. Anything that does not name itself is
    // refused rather than read for fields that might coincidentally be there.
    return parsed?.kind === 'provisional-standings' ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadPayoutTrail({ epochFileUrl, epochs, fetchImpl = fetch }) {
  const readJson = async (url) => {
    if (!url) return null;
    try {
      const response = await fetchImpl(url, { cache: 'no-store' });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const loaded = await Promise.all(
    epochs.map(async (epoch) => {
      const tree = await readJson(epochFileUrl(epoch, 'tree.json'));
      if (!tree) return null;
      return { epoch, tree, airdrop: await readJson(epochFileUrl(epoch, 'airdrop.json')) };
    }),
  );
  return loaded.filter(Boolean);
}

/**
 * Which settled epochs the wallet panel should fetch, newest first.
 *
 * A function, in a module Node can import, for one reason: **the caller got
 * this wrong twice and neither mistake could fail visibly.** It read the rows
 * off the wrong object (`state`, which has no `epochs`, rather than `live`)
 * and then took the wrong field (`epoch`, where `loadEpochs` and `decodeEpoch`
 * both say `index`). Either slip yields an empty list, an empty list yields an
 * empty trail, and an empty trail renders exactly like a wallet that has never
 * been paid — so the paid/owed panel silently never appeared for anyone.
 *
 * Everything it guards is therefore a shape assertion rather than a policy:
 * unposted rows are dropped, non-numeric indices are dropped rather than
 * becoming `epoch-undefined` URLs, and the list is bounded because a holder
 * checking today does not need last quarter and each epoch costs two fetches.
 *
 * @param {{posted?: boolean, index?: number}[]} epochs  as `loadEpochs` returns them
 * @param {number} limit  how many of the newest to keep
 */
export function settledEpochIndices(epochs, limit = 14) {
  return (Array.isArray(epochs) ? epochs : [])
    .filter((e) => e?.posted && Number.isInteger(e.index))
    .map((e) => e.index)
    .sort((a, b) => b - a)
    .slice(0, limit);
}
