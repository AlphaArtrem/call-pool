// What the audit trail covers, and what it adds up to.
//
// Its own module, dependency-free, for the reason `paging.js` and `clocks.js`
// are: `scripts/tests/site.test.mjs` exercises it in Node. `epochs.js` cannot
// be imported there — it reaches web3.js through `addresses.js`, which needs a
// browser global — so anything that decides *what a reader sees* has to live
// outside it to be asserted rather than eyeballed.
//
// The headline "Paid out so far" is exactly that kind of claim, and it used to
// be false: the table fetched the newest 30 epochs and summed those, under a
// caption promising every past day. From day 31 it silently undercounted, and
// the devnet rehearsal reached epoch 130 — where "so far" quietly meant
// "101 to 130".

/**
 * Every epoch since genesis, newest first.
 *
 * All of them, not a window. `multipleAccounts` chunks at 100 addresses per
 * request, so this costs one extra RPC call per ~100 days — years of headroom
 * before it is worth bounding, and bounding it is what made the number wrong.
 *
 * @param {number} currentEpoch  the on-chain index of the newest epoch
 */
export function epochIndices(currentEpoch) {
  const indices = [];
  for (let e = currentEpoch; e >= 0; e--) indices.push(e);
  return indices;
}

/**
 * Total distributed across every epoch given. Derived here, never fetched.
 *
 * An unposted epoch contributes nothing rather than being skipped or treated as
 * missing data — "nobody was paid that day" is a real, displayable answer.
 */
export function totalClaimed(epochs) {
  return epochs.reduce((sum, e) => sum + (e.posted ? e.claimedLamports : 0n), 0n);
}
