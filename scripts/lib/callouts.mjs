// The one trusted input: pump.fun's record of who called out.
//
// Everything else in this system is computed from public chain history and can
// be re-derived by a stranger. This cannot — it exists only in pump.fun's
// database, reached through `api.coin-communities.xyz` (Phase 02). Keeping the
// trusted list at exactly one item is the point, so this module does as little
// as possible: fetch, merge, and say plainly when the answer is incomplete.
//
// Three things it must get right, and each was a finding rather than a guess:
//
//   * The `/public` feed is **hard-capped at 50 records with no pagination**
//     (Phase 02 §2.6, measured — 20 candidate params were silently ignored).
//     Truncation is adversarially triggerable for free: about 13 throwaway
//     accounts posting every six hours keep the window permanently full, and
//     the attacker holds no tokens. Treat the fallback as the normal path.
//   * A **reply is a callout update**, not a comment (L2). It appears in the
//     callout feed and in followers' feeds, so it carries the same reach and
//     counts as activity. Do not re-derive this from the API shape.
//   * Records flagged `isSpam` / `isHarmful`, or carrying `deletedAt`, do not
//     count (L7). The flags are mutable and retroactive, which is disclosed
//     rather than solved.

import { EPOCH_SECONDS } from './config.mjs';

export const DEFAULT_BASE_URL = 'https://api.coin-communities.xyz';

/** The `/public` route's hard cap. Not a page size — there is no next page. */
export const FEED_CAP = 50;

/** Phase 02 §2.6a / L5: the per-wallet fallback runs in sublists this big. */
export const FALLBACK_BATCH_SIZE = 150;

/** Thrown when the feed cannot support an exact answer for the window. */
export class CalloutError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CalloutError';
    this.detail = detail;
  }
}

/**
 * The public client key pump.fun ships to every visitor.
 *
 * Read from the environment rather than committed. It is not a secret — it is
 * in pump.fun's own JS bundle — but it is *theirs*, it can rotate without
 * notice, and Phase 02 §2.6 risk 2 requires that a rotation be an **alerted**
 * failure rather than a silent one. Re-extract it by loading
 * `pump.fun/callouts` and grepping the same-origin scripts for
 * `coin-communities`.
 */
export function apiKeyFromEnv(env = globalThis.process?.env ?? {}) {
  const key = env.CALLOUT_API_KEY;
  if (!key) {
    throw new CalloutError(
      'CALLOUT_API_KEY is not set. It is the public x-api-key from pump.fun\'s own ' +
        'bundle — load pump.fun/callouts and grep the same-origin scripts for ' +
        '"coin-communities".',
    );
  }
  return key;
}

async function get(path, { apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403) {
    // Phase 02 §2.6 risk 2. This is the shape a key rotation takes, and the
    // crank must stop loudly rather than settle an epoch with no callers.
    throw new CalloutError(
      `the callout API rejected the public key (${response.status}) — it may have rotated`,
      { path, status: response.status },
    );
  }
  if (!response.ok) {
    throw new CalloutError(`callout API returned ${response.status}`, {
      path,
      status: response.status,
    });
  }
  return response.json();
}

/** `createdAt` is ISO-8601 UTC with microseconds. Unix seconds is enough here. */
export function calloutTime(record) {
  const ms = Date.parse(record.createdAt);
  if (Number.isNaN(ms)) {
    throw new CalloutError('callout has an unparseable createdAt', { record });
  }
  return Math.floor(ms / 1000);
}

/**
 * Does this record count toward eligibility?
 *
 * L7 / Decision 24. Paying for a callout pump.fun flagged as abusive is
 * indefensible, and the flags are in the published snapshot so the rule stays
 * checkable. The accepted cost is that the flags are a third party's, mutable,
 * and retroactive.
 */
export function countable(record) {
  return !record.isSpam && !record.isHarmful && !record.deletedAt;
}

/**
 * Is this record about our coin?
 *
 * `tokenAddress` is pump.fun's field name, pinned by
 * `docs/fixtures/callouts-sample.json` and by a test that reads it. One
 * predicate for every caller — the crank and the browser both answer this
 * question, and the site once answered it with `record.mint`, a field that has
 * never existed in a pump.fun response. A wrong field name here does not throw;
 * it silently matches nothing and reports that nobody ever called anything.
 */
export function isForMint(record, mint) {
  return record.tokenAddress === mint;
}

// ── fetching ───────────────────────────────────────────────────────────────

/** The per-mint feed. One request, newest first, capped at 50. */
export async function fetchMintCallouts(mint, options) {
  const body = await get(`/api/v1/communities/${mint}/callouts/public`, options);
  return body.callouts ?? [];
}

/**
 * The updates on one callout. These are callouts for our purposes (L2).
 *
 * Tagged with the parent id so the published record shows where each came
 * from — a verifier re-reading the feed needs to be able to follow the same
 * path we did.
 */
export async function fetchCalloutUpdates(mint, calloutId, options) {
  const body = await get(
    `/api/v1/communities/${mint}/callouts/${calloutId}/replies/public`,
    options,
  );
  const replies = body.replies ?? body.callouts ?? [];
  return replies.map((r) => ({ ...r, parentCalloutId: calloutId, isUpdate: true }));
}

/** One wallet's callout history, across all coins. Not tightly capped. */
export async function fetchWalletCallouts(address, options) {
  const body = await get(`/api/v1/users/by-wallet/${address}/callouts`, options);
  return body.callouts ?? [];
}

// ── truncation ─────────────────────────────────────────────────────────────

/**
 * Has the 50-cap hidden part of this window?
 *
 * Exactly the test from Phase 02 §2.6: the response is full **and** its oldest
 * record still falls inside the window, so there is no way to know what fell
 * off the end. A short list must never be published as if it were complete.
 */
export function isTruncated(records, window) {
  if (records.length < FEED_CAP) return false;
  const oldest = Math.min(...records.map(calloutTime));
  return oldest >= window.start;
}

/** Split a candidate list into the sublists the fallback queries (L5). */
export function batches(items, size = FALLBACK_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── the rolling store ──────────────────────────────────────────────────────

/**
 * Merge a poll into the rolling store, keyed on callout `id`.
 *
 * Two timestamps are kept per record and they answer different questions:
 *
 *   `firstSeenAt` — when the crank first observed it, which is the honest
 *                   answer to "what did we know, and when"
 *   `lastSeenAt`  — when it was last re-observed, and whose *flags* the
 *                   settlement uses
 *
 * The latest observation wins on content, because a callout flagged as spam
 * two hours before settlement should not be paid. A flag applied *after*
 * settlement leaves that root permanently inconsistent with the published
 * rule, and corrections only go forward (§5.9a) — that is L7's disclosed cost,
 * not a bug to fix here.
 *
 * @param {Record<string, object>} store  keyed by callout id
 * @param {object[]} records
 * @param {number} observedAt  unix seconds
 */
export function mergeById(store, records, observedAt) {
  const merged = { ...store };
  for (const record of records) {
    if (!record?.id) {
      throw new CalloutError('callout record has no id, so it cannot be merged', { record });
    }
    const previous = merged[record.id];
    merged[record.id] = {
      ...record,
      firstSeenAt: previous?.firstSeenAt ?? observedAt,
      lastSeenAt: observedAt,
    };
  }
  return merged;
}

/** Every stored record whose `createdAt` falls inside the window. */
export function recordsInWindow(store, window) {
  return Object.values(store)
    .filter((r) => {
      const at = calloutTime(r);
      return at >= window.start && at < window.end;
    })
    .sort((a, b) => calloutTime(a) - calloutTime(b));
}

/**
 * `active(w, d)` — the wallets that called out or posted an update in the window.
 *
 * Activity does not carry over between days: yesterday's callout earns
 * yesterday only.
 *
 * @returns {{ active: Set<string>, counted: object[], excluded: object[] }}
 */
export function activeWallets(store, window) {
  const inWindow = recordsInWindow(store, window);
  const counted = [];
  const excluded = [];

  for (const record of inWindow) {
    if (!record.walletAddress) {
      // L11 says the address is attested per record. One without it is a shape
      // change in someone else's API, not something to paper over.
      throw new CalloutError('callout record has no walletAddress', { id: record.id });
    }
    (countable(record) ? counted : excluded).push(record);
  }

  return {
    active: new Set(counted.map((r) => r.walletAddress)),
    counted,
    excluded,
  };
}

// ── the two collection paths ───────────────────────────────────────────────

/**
 * The hourly poll: the per-mint feed plus updates on everything recent.
 *
 * Runs hourly rather than once per epoch because the feed caps at 50 and an
 * attacker can keep it full for free. The merge is what makes an hourly poll
 * add up to a complete day.
 *
 * @returns {{ records: object[], truncated: boolean, feedSize: number }}
 */
export async function pollMint(mint, window, options) {
  const feed = await fetchMintCallouts(mint, options);
  const truncated = isTruncated(feed, window);

  // Updates are only worth fetching for callouts recent enough to still be
  // producing activity. Two epochs of slack covers a callout posted just
  // before the window that is updated inside it.
  const recent = feed.filter((r) => calloutTime(r) >= window.start - 2 * EPOCH_SECONDS);
  const updates = [];
  for (const callout of recent) {
    updates.push(...(await fetchCalloutUpdates(mint, callout.id, options)));
  }

  return { records: [...feed, ...updates], truncated, feedSize: feed.length };
}

/**
 * The fallback: ask per wallet, in batches, for a known candidate list.
 *
 * Immune to the 50-cap because no individual wallet has many callouts, and
 * bounded because eligibility requires holding the floor — so the candidates
 * are *holders*, which are enumerable from chain, rather than *callers*, which
 * are not. At a 0.01% floor at most 10,000 wallets can qualify (L12), so this
 * is at most ~70 batches in the impossible worst case and a handful in practice.
 *
 * `POST /api/v1/communities/callouts/batch` would collapse each batch into one
 * request; it takes the public key and 404'd only on a guessed body shape
 * (Phase 02 §2.4). Worth another attempt — until then this is one request per
 * wallet, which is why the candidate list must be the holders above the floor
 * and never "everyone".
 */
export async function collectByWallet(candidates, mint, window, options) {
  // A flat loop, because that is what this is: one request per wallet, awaited
  // in turn. It used to iterate `batches(candidates)` and then each address
  // within a batch, which grouped the addresses without doing anything per
  // group — identical behaviour, arranged to look like it had a reason.
  // `batches` stays, tested and exported, for the batch POST described above:
  // that is where a sublist becomes one request and the grouping starts to mean
  // something.
  const records = [];
  for (const address of candidates) {
    const history = await fetchWalletCallouts(address, options);
    for (const record of history) {
      if (!isForMint(record, mint)) continue;
      const at = calloutTime(record);
      if (at >= window.start && at < window.end) records.push(record);
    }
  }
  return records;
}

/**
 * Resolve a pasted permalink to the record pump.fun actually holds.
 *
 * `https://pump.fun/callouts/{mint}/{calloutId}/{replyId}` — the first UUID is
 * the callout. The response carries `walletAddress`, so the check cannot be
 * forged: the data comes from pump.fun, not from the person pasting it. All
 * five conditions must hold, and a verified correction is credited in the
 * *next* epoch — never rewritten into a posted root (§5.9a).
 */
export async function verifyPermalink(url, { mint, address, window, ...options }) {
  const match = String(url).match(
    /callouts\/([1-9A-HJ-NP-Za-km-z]+)\/([0-9a-f-]{36})/i,
  );
  if (!match) throw new CalloutError('not a callout permalink', { url });
  const [, urlMint, calloutId] = match;
  if (urlMint !== mint) throw new CalloutError('permalink is for a different coin', { urlMint });

  const body = await get(`/api/v1/communities/${mint}/callouts/${calloutId}/public`, options);
  const record = body.callout ?? body;

  const checks = {
    tokenAddress: isForMint(record, mint),
    walletAddress: record.walletAddress === address,
    inWindow: calloutTime(record) >= window.start && calloutTime(record) < window.end,
    notModerated: countable(record),
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return { ok: failed.length === 0, failed, record };
}
