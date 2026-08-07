// The second signer's independent view of the one input it cannot re-derive.
//
// `cosign.mjs` already refuses to approve a root it did not rebuild itself: it
// reproduces the epoch from the published inputs and compares the proposal byte
// for byte. That closes every path where box A gets the *arithmetic* wrong or
// lies about it.
//
// It does not close the path where box A lies about the **inputs**.
//
// `callouts.json` is the one thing in this system that cannot be re-derived
// from chain — it exists only in pump.fun's database (§5.1). Box B verifies
// that the root follows from it and that `balances.json` matches chain, and
// then it approves. So an attacker who owns box A can fabricate a callout
// capture naming wallets they control, each holding `min_hold` — a bounded,
// recoverable cost — publish it, and propose. The epoch reproduces perfectly.
// Every balance rechecks against chain, because those wallets really do hold
// the floor. Box B approves, and the 2-of-3 pays the attacker.
//
// **The fix is not more arithmetic. It is a second observation.** Box B polls
// pump.fun itself, into its own store on its own disk, and refuses to credit a
// wallet it never saw call out. That converts "steal the pool" from a one-box
// compromise into a two-box one, which is the whole reason there are two boxes.
//
// ── what this can and cannot say ───────────────────────────────────────────
//
// Two honest limits, and both are here rather than in a comment on the far side
// of the codebase, because a check whose blind spots are undocumented is a
// check people over-trust:
//
//   * **A stale store proves nothing.** If box B's poller has not run since the
//     window closed, its silence about a wallet is not evidence — it is just
//     silence. That is a refusal, not a pass, and it is self-healing: box B
//     polls every minute and the co-sign timer runs every minute, so a stale
//     store delays approval by a tick rather than wedging the epoch.
//   * **Truncation defeats it.** When the 50-record feed truncates, the honest
//     crank recovers the window with the per-wallet fallback (L5), which needs
//     the holder list — a chain read box B deliberately does not do. Box B's
//     plain feed poll will then legitimately hold fewer records than box A's
//     recovered set, and refusing on that would deadlock every truncated epoch.
//     So a truncation box B observed itself downgrades this to a warning.
//
// The second limit is a real weakening and is worth stating plainly: an
// attacker who can keep the feed truncated — about 13 throwaway accounts, per
// §2.6 — can also keep this check in warn-only mode. It still costs them a
// second, visible, sustained action, and the warning is alertable. That is a
// smaller claim than "this makes fabrication impossible", and it is the true
// one.

import { activeWallets } from './callouts.mjs';

/**
 * Rebuild the store shape `activeWallets` expects from a published capture.
 *
 * `callouts.json` splits its records into `counted` and `excluded` — the
 * moderation filter (L7) already applied. Both halves go back in, because
 * `activeWallets` applies that same filter itself and re-deriving it here would
 * be a second copy of a rule that must not drift.
 */
function storeFrom(published) {
  const records = [...(published.counted ?? []), ...(published.excluded ?? [])];
  return Object.fromEntries(records.map((r) => [r.id, r]));
}

/**
 * Did box B see a truncated feed anywhere in this window?
 *
 * The poll records truncation as it observes it, with the timestamp. Anything
 * observed between the window opening and the store's last update bears on this
 * window — a feed that was full at 14:00 may have hidden a 13:55 callout.
 */
export function sawTruncation(ownStore, window) {
  return (ownStore.truncations ?? []).some(
    (entry) => entry.observedAt >= window.start && entry.observedAt <= (ownStore.updatedAt ?? 0),
  );
}

/**
 * Compare a published callout capture against our own independent one.
 *
 * Both sides go through `activeWallets`, deliberately: the same predicate
 * decides countability, in-window placement and the presence of an attested
 * `walletAddress` on both, so any difference this reports is a difference in
 * the *data* rather than in two subtly different filters.
 *
 * @param {object} args
 * @param {object} args.published   the epoch's callouts.json
 * @param {object} args.ownStore    this host's own rolling callout store
 * @param {{start:number,end:number}} args.window
 * @returns {{
 *   ok: boolean,
 *   reason: string|null,
 *   credited: string[],
 *   unverified: string[],
 *   missed: string[],
 *   truncated: boolean,
 * }}
 */
export function corroborateCallouts({ published, ownStore, window }) {
  const credited = [...activeWallets(storeFrom(published), window).active].sort();

  // A store that has not been updated since the window closed cannot speak to
  // it. Checked before anything is compared, because the comparison would
  // otherwise produce a confident answer from an empty observation.
  const updatedAt = ownStore.updatedAt ?? 0;
  if (updatedAt < window.end) {
    return {
      ok: false,
      reason:
        `this host's callout store was last updated at ${updatedAt} but the window closes at ` +
        `${window.end}, so it has not observed the whole window and its silence about a wallet ` +
        'is not evidence of anything. Waiting for the poll to catch up.',
      credited,
      unverified: [],
      missed: [],
      truncated: false,
    };
  }

  const mine = activeWallets(ownStore.callouts ?? {}, window).active;
  const unverified = credited.filter((w) => !mine.has(w));
  const missed = [...mine].filter((w) => !credited.includes(w)).sort();
  const truncated = sawTruncation(ownStore, window);

  // Truncation is the documented blind spot. Say so in the result rather than
  // silently passing, so the caller can log it and an operator can notice that
  // the check has been degraded for a suspiciously long time.
  if (unverified.length > 0 && truncated) {
    return {
      ok: true,
      reason:
        `${unverified.length} credited wallet(s) are absent from this host's own capture, but ` +
        'this host observed a TRUNCATED feed in this window — the crank recovers a truncated ' +
        'window with the per-wallet fallback (L5) and this host does not, so the difference is ' +
        'expected and cannot be told from fabrication. Corroboration is degraded, not passed.',
      credited,
      unverified,
      missed,
      truncated,
    };
  }

  if (unverified.length > 0) {
    return {
      ok: false,
      reason:
        `${unverified.length} wallet(s) are credited with a callout that this host never ` +
        'observed, on a window where its own feed was never truncated. The published capture ' +
        'claims activity that pump.fun did not show us.',
      credited,
      unverified,
      missed,
      truncated,
    };
  }

  return { ok: true, reason: null, credited, unverified, missed, truncated };
}
