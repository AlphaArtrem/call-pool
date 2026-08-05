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
 * Which cluster to read.
 *
 * `?cluster=devnet` wins over the local file so a rehearsal deployment can be
 * linked directly (§7.5). Anything unrecognised falls back to the configured
 * cluster rather than silently reading mainnet.
 */
export function resolveCluster(search = globalThis.location?.search ?? '') {
  const requested = new URLSearchParams(search).get('cluster');
  const configured = globalThis.CALLPOOL_SITE_CONFIG?.cluster;
  const candidate = requested ?? configured ?? 'devnet';
  return candidate === 'mainnet' || candidate === 'devnet' ? candidate : 'devnet';
}

/**
 * The resolved, validated config for this page load.
 *
 * Every field is `string | null`. Callers must branch on null and render the
 * pending state; nothing here invents a fallback value, because a fallback
 * value on this page is a lie with a plausible shape.
 */
export function siteConfig(root = globalThis.CALLPOOL_SITE_CONFIG, search) {
  const cluster = resolveCluster(search);
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
    rpc: orNull(forCluster.rpc),
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
