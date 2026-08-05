// Site configuration, and the one rule that governs every number on the page.
//
// Phase 07 §7.4: **never render a number that cannot be sourced from chain or
// from a published snapshot.** The practical shape of that rule is this file.
// Anything unset resolves to `null` and the renderer shows "not configured"
// — never a default, never a placeholder that reads like a real value.
//
// The immutable parameters are IMPORTED from scripts/lib/config.mjs rather
// than restated here. A second copy of the floor is how the number the site
// shows and the number the program enforces eventually disagree, and that
// disagreement would surface as a holder being told they qualify when they do
// not. One home for the parameters, forever.

import {
  EPOCH_SECONDS,
  LOCKOUT_EPOCHS,
  MINT_DECIMALS,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
  TOTAL_SUPPLY_TOKENS,
  FLOOR_NUMERATOR,
  FLOOR_DENOMINATOR,
} from '../../scripts/lib/config.mjs';

export {
  EPOCH_SECONDS,
  LOCKOUT_EPOCHS,
  MINT_DECIMALS,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
  TOTAL_SUPPLY_TOKENS,
};

/** The floor as a percentage string, derived — never typed out as "0.01%". */
export const FLOOR_PERCENT_LABEL = `${Number((FLOOR_NUMERATOR * 100n * 10000n) / FLOOR_DENOMINATOR) / 10000}%`;

/** Blank strings are "unset", not "empty". Trims so a stray space is not config. */
function orNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve a same-origin `rpc` path against the page.
 *
 * `rpc: '/rpc'` is the shape the config wants — it says "the proxy on this
 * origin" without naming a host, so the same file works on localhost and on
 * callpool.fun. web3.js will not take it: `Connection` parses its endpoint with
 * `new URL()` and throws on a relative path, and because that happens inside
 * `main()` the whole page falls through to "The page failed to load" rather
 * than to any of its designed states.
 *
 * So the relative form is resolved here, once, at the same point
 * `snapshotsBase` is normalised. Outside a browser — the test suite — there is
 * nothing to resolve against, and the value is left as written.
 */
function absoluteRpc(value) {
  if (value == null || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const base = globalThis.location?.href;
  return base == null ? value : new URL(value, base).toString();
}

/**
 * Which cluster to read.
 *
 * **Mainnet is the default and the only one the public page ever shows.** The
 * cluster switch was removed from the top bar on 2026-08-05: a devnet page
 * renders real chain reads of activity we generated ourselves, and that is the
 * most convincing wrong impression this site can give, so it is not something a
 * visitor should be able to reach by accident or by a pasted link.
 *
 * `?cluster=devnet` still works, and is now an **internal tool** — it is how we
 * point the page at a rehearsal deployment. Anything unrecognised falls back to
 * mainnet, which is the safe direction: the worst case is a page saying the
 * coin has not launched.
 */
export function resolveCluster(
  search = globalThis.location?.search ?? '',
  root = globalThis.CALLPOOL_SITE_CONFIG,
) {
  const requested = new URLSearchParams(search).get('cluster');
  const candidate = requested ?? root?.cluster ?? 'mainnet';
  return candidate === 'mainnet' || candidate === 'devnet' ? candidate : 'mainnet';
}

/**
 * The resolved, validated config for this page load.
 *
 * Every field is `string | null`. Callers must branch on null and render the
 * pending state; nothing here invents a fallback value, because a fallback
 * value on this page is a lie with a plausible shape.
 */
export function siteConfig(root = globalThis.CALLPOOL_SITE_CONFIG, search) {
  // `root`, not the global: this function honoured the object it was handed for
  // every field except the one naming the cluster, which read the global
  // instead. In a browser they are the same object so it never showed — but it
  // meant the cluster a caller asked for could be silently overridden by
  // whatever the page happened to have loaded.
  const cluster = resolveCluster(search, root);
  const forCluster = root?.[cluster] ?? {};

  const snapshotsBase = orNull(forCluster.snapshotsBase);

  return {
    cluster,
    configured: root != null,
    // Cluster-independent, because a repository and an account do not move
    // between devnet and mainnet. Unset renders as a stated "not published
    // yet" chip in the top bar rather than a link nobody has checked.
    links: {
      x: orNull(root?.links?.x),
      github: orNull(root?.links?.github),
    },
    rpc: absoluteRpc(orNull(forCluster.rpc)),
    mint: orNull(forCluster.mint),
    programId: orNull(forCluster.programId),
    // Trailing slash normalised once, here, so every call site can concatenate.
    snapshotsBase: snapshotsBase ? snapshotsBase.replace(/\/+$/, '') : null,
    calloutApiKey: orNull(forCluster.calloutApiKey),
    feeShareTx: orNull(forCluster.feeShareTx),
    creatorVault: orNull(forCluster.creatorVault),
  };
}

/** `<snapshotsBase>/epoch-<n>/` — the audit trail link for one epoch. */
export function snapshotUrl(config, epoch, file = '') {
  if (config.snapshotsBase == null) return null;
  return `${config.snapshotsBase}/epoch-${epoch}/${file}`;
}

/**
 * The explorer this cluster's links point at.
 *
 * Solscan on mainnet, the Solana explorer on devnet with the cluster pinned —
 * a devnet link without `?cluster=devnet` silently resolves to mainnet and
 * shows "account not found", which reads as "they made it up".
 */
export function explorerUrl(config, kind, id) {
  if (id == null) return null;
  const path = kind === 'tx' ? 'tx' : 'address';
  return config.cluster === 'mainnet'
    ? `https://solscan.io/${path}/${id}`
    : `https://explorer.solana.com/${path}/${id}?cluster=devnet`;
}
