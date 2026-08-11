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

/**
 * The per-wallet route's ceiling, and the `limit` we must ask for to reach it.
 *
 * Measured against the live API on 2026-08-09, against real mainnet wallets:
 * `/users/by-wallet/:w/callouts` **defaults to 50** and honours `limit` up to
 * 100, above which it silently clamps. `offset`, `page` and `cursor` are all
 * ignored, exactly as they are on the per-mint feed, so 100 is a ceiling and
 * not a page size.
 *
 * This is why the fallback asks explicitly. The comment above `collectByWallet`
 * used to say this endpoint was "not tightly capped"; it is capped at 50 unless
 * asked otherwise, which halved the depth of the one path that is supposed to
 * survive the per-mint feed being full.
 */
export const WALLET_FEED_CAP = 100;

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
 * Statuses worth retrying, and how hard.
 *
 * Measured on the mainnet coin's launch night (2026-08-10/11): pump's callout
 * API returns **429 on roughly half of polls, at any minute** — the same key
 * from the same IP succeeds seconds later, so it is a short sliding-window
 * limit, not a per-IP ban. A single-attempt poll therefore missed whole hours
 * and the crank host's store went stale, twice. These are the transient
 * upstream statuses; 401/403 are NOT here because those mean the key rotated
 * and are handled separately (re-derive, do not just retry the same key).
 */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1500;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before retry `attempt` (1-based).
 *
 * `Retry-After` is honoured when the API sends it (seconds), because guessing
 * under an explicit instruction is how a backoff turns into a hammer. Otherwise
 * exponential from `BASE_BACKOFF_MS` with a little jitter so many hosts that hit
 * the limit in the same minute do not all retry on the same tick.
 */
export function retryDelayMs(response, attempt) {
  const header = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return backoff + Math.floor(Math.random() * 400);
}

// The public client key pump.fun ships to every visitor lives in
// `callout-key.mjs`, not here. It is not a secret — it is in pump.fun's own JS
// bundle — but it is *theirs*, it rotates without notice, and there is no API
// that hands it out, so it is derived from their bundle and re-derived when
// this module sees a 401. `get()` below takes either a literal `apiKey` or a
// `keySource`; the source is injected rather than imported so that the one
// module that knows how to talk to the callout API stays free of any knowledge
// of how its key was obtained.

async function get(
  path,
  { apiKey, keySource, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, notFound, sleep = defaultSleep } = {},
) {
  const send = (key) =>
    fetchImpl(`${baseUrl}${path}`, {
      headers: { 'x-api-key': key, accept: 'application/json' },
    });

  // A literal key still works exactly as it did, so every existing caller and
  // every test that passes a string is unaffected. `keySource` is the opt-in.
  let key = apiKey ?? (keySource ? await keySource.get() : undefined);
  let response = await send(key);

  if ((response.status === 401 || response.status === 403) && keySource && !apiKey) {
    // Phase 02 §2.6 risk 2. This is the shape a key rotation takes — and it is
    // the *only* trustworthy signal that one happened, which is why the key is
    // re-derived here rather than refreshed on a timer. `refresh()` throws if
    // it cannot produce a working key, so a genuine outage still fails loudly
    // instead of retrying forever.
    key = await keySource.refresh();
    response = await send(key);
  }

  // Transient upstream throttling: retry the SAME key with backoff before
  // giving up. pump 429s about half our polls at random and clears in seconds,
  // so one attempt per hour left the store stale; a bounded retry turns that
  // into a few seconds' wait. Exhausting the attempts falls through to the
  // `!response.ok` throw below, so a genuine outage still fails loudly.
  for (let attempt = 1; attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(response.status); attempt++) {
    await sleep(retryDelayMs(response, attempt));
    response = await send(key);
  }

  if (response.status === 401 || response.status === 403) {
    // Either there was no key source to recover with, or recovery produced a
    // key the API also refuses. Both mean: stop, rather than settle an epoch
    // with no callers.
    throw new CalloutError(
      `the callout API rejected the public key (${response.status}) — it may have rotated`,
      { path, status: response.status },
    );
  }
  // `notFound` is opt-in per call and covers exactly one status. A wallet that
  // has never touched pump's social product legitimately has no user record,
  // and for a candidate list read off the chain that is the *common* case, not
  // an error. It is a sentinel rather than a blanket catch because widening it
  // to "any failure means no callout" is how an outage would quietly become a
  // settlement that pays nobody.
  if (response.status === 404 && notFound !== undefined) return notFound;

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
 * **This route returns only the callout author's own updates**, never other
 * users' replies. Measured 2026-08-09 across 38 callouts on four live coins:
 * every returned record was authored by the callout's own wallet, and not one
 * foreign reply appeared. A public callout with `replyCount: 116` returned
 * exactly 2 — the author's two updates.
 *
 * So `replyCount` counts the whole public thread while this returns the author's
 * subset, and the two diverge freely (`replyCount: 1` with 0 returned is a reply
 * by somebody else). **Never treat `replyCount` as the expected length here** —
 * it is not a completeness check, and reading it as one would make a normal
 * thread look like a truncated fetch.
 *
 * The upshot for L2 is that "an update is activity" can only ever credit the
 * callout's author. A third party replying to someone else's callout is not
 * exposed by the public API at all, so it has never been creditable by any path.
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

/**
 * A Solana address, structurally. Checked before any wallet lookup.
 *
 * Not pedantry. `by-wallet` answers `404 {"message":"No user linked to this
 * wallet"}` for a malformed address and for a real address with no pump
 * account — the *same* response. Without this check a typo in a candidate list
 * is indistinguishable from an honest "never called out", and that wallet
 * silently loses its payout. Measured 2026-08-09.
 */
export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The pump user behind a wallet, or `null` if there is no account.
 *
 * `null` means "no pump user", a complete and correct answer for most holders —
 * they hold the coin and never touched the social product. Any other failure
 * throws, because "we could not ask" must never read as "they did not call out".
 */
export async function resolveUserId(address, options) {
  if (!BASE58_ADDRESS.test(String(address ?? ''))) {
    throw new CalloutError(
      `"${address}" is not a Solana address, and the wallet lookup answers 404 ` +
        'for a malformed address exactly as it does for a wallet with no pump ' +
        'account — so this would silently read as "did not call out"',
      { address },
    );
  }
  const body = await get(`/api/v1/users/by-wallet/${address}`, { ...options, notFound: null });
  return body?.userId ?? null;
}

/**
 * The callout this user made for this coin, by id, or `null`.
 *
 * The cap-immune answer, and the reason this path exists. There is no feed here
 * and therefore nothing to truncate: the route takes a user and a mint and
 * returns that user's one callout for that coin. Measured on live mainnet data
 * 2026-08-09 — across 220 records on five coins every wallet had **at most one**
 * callout per coin, which is the shape this route assumes.
 *
 * ⚠️ A userId that does not exist returns `200 {"callout": null}` rather than a
 * 404 — indistinguishable from a real "never called out". That is why
 * `resolveUserId` throws rather than returning a fallback id, and why nothing
 * here invents or guesses a userId.
 */
export async function fetchCalloutIdForMint(userId, mint, options) {
  const body = await get(`/api/v1/users/${userId}/callouts/by-mint/${mint}`, options);
  return body?.callout?.calloutId ?? null;
}

/**
 * One callout in the canonical feed shape, by id.
 *
 * `by-mint` returns a *different, lossier* record: `calloutId`/`coinMint`,
 * `createdAt` in epoch millis, and **no** `walletAddress`, `isSpam`,
 * `isHarmful` or `deletedAt`. Settlement needs all of those — L7's moderation
 * rule is not optional — so the id it hands back is resolved here to the full
 * public record rather than normalised by hand. One extra request per *caller*
 * (not per candidate) buys a record identical in shape to the feed's, so
 * everything downstream stays unchanged.
 */
export async function fetchCalloutById(mint, calloutId, options) {
  const body = await get(`/api/v1/communities/${mint}/callouts/${calloutId}/public`, options);
  return body?.callout ?? body;
}

/**
 * One wallet's callout history, across all coins. Newest first, ceiling 100.
 *
 * The `limit` is not optional tuning. Without it the API answers with 50, and
 * a wallet that has posted more than 50 callouts since the window opened would
 * have its callout for our coin fall off the end — reported as "did not call
 * out" rather than as "cannot tell", which is the one failure mode this whole
 * module exists to avoid.
 */
export async function fetchWalletCallouts(address, options) {
  const body = await get(
    `/api/v1/users/by-wallet/${address}/callouts?limit=${WALLET_FEED_CAP}`,
    options,
  );
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
 * Recover a window's callers for a known candidate list, exactly.
 *
 * Runs when the per-mint feed truncated, which on an active coin is the normal
 * case rather than the exception (four of five real coins measured 2026-08-09
 * were already at the 50-cap). Bounded because eligibility requires holding the
 * floor, so the candidates are *holders*, which are enumerable from chain,
 * rather than *callers*, which are not. At a 0.01% floor at most 10,000 wallets
 * can qualify (L12).
 *
 * Two routes per candidate, and the order matters:
 *
 *   1. `by-wallet/{address}` → userId, or `null` when there is no pump account.
 *      Most holders never touched the social product; `null` ends it, cheaply.
 *   2. `users/{userId}/callouts/by-mint/{mint}` → that user's callout id for
 *      this coin, **or null**. No feed, no cap, nothing to truncate.
 *   3. only if there *is* one, the full public record by id, for the canonical
 *      shape and L7's moderation flags.
 *
 * So it costs 2 requests per candidate and a third per actual caller. That is
 * more requests than reading a wallet's history, and it buys the thing the
 * history could not give: an answer that cannot be truncated. The history route
 * caps at 100 with no cursor (`WALLET_FEED_CAP`), so a wallet busy enough to
 * fill it had its callout for this coin fall off the end and read as silence.
 *
 * `POST /api/v1/communities/callouts/batch/server` would collapse this into one
 * request per batch, but its bundle definition requires `x-server-key` and
 * `x-server-secret` — pump's internal server credentials, not the public
 * browser key (measured 2026-08-09). `batches` stays exported for the day that
 * changes.
 *
 * @returns {{records: object[], incomplete: string[]}} `incomplete` is retained
 *   for the caller's guard and is always empty here — this path has no cap to
 *   hit. It is not removed because the guard downstream is what would catch a
 *   regression back to a truncating route.
 */
export async function collectByWallet(candidates, mint, window, options) {
  const records = [];
  for (const address of candidates) {
    const userId = await resolveUserId(address, options);
    if (userId === null) continue; // no pump account: a complete answer, not a gap

    const calloutId = await fetchCalloutIdForMint(userId, mint, options);
    if (calloutId === null) continue; // never called out this coin

    const record = await fetchCalloutById(mint, calloutId, options);

    // A callout persists across epochs, so the route being scoped to this coin
    // is not enough — only the ones *made* inside this window earn it, and
    // `isForMint` stays as the check that the record we were handed is the
    // record we asked for.
    const inWindow = (r) => {
      const at = calloutTime(r);
      return at >= window.start && at < window.end;
    };
    if (isForMint(record, mint) && inWindow(record)) records.push(record);

    // L2: an update is activity. A callout made *before* the window that the
    // caller updated *inside* it earns the window, so the callout falling
    // outside is not a reason to skip the updates — they are fetched either way.
    //
    // Deliberately the same route the hourly poll uses, so a recovered update is
    // byte-identical to a polled one. `by-mint` also returns an `updates` array,
    // but its entries carry only id/content/createdAt/likeCount — no
    // `walletAddress`, and none of L7's moderation flags — so they cannot be
    // settled from directly.
    const updates = await fetchCalloutUpdates(mint, calloutId, options);
    for (const update of updates) {
      if (isForMint(update, mint) && inWindow(update)) records.push(update);
    }
  }
  return { records, incomplete: [] };
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
