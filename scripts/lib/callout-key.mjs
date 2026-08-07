// Deriving pump.fun's public callout key, because it rotates without notice.
//
// `CALLOUT_API_KEY` is the `x-api-key` pump.fun ships to every visitor of
// `pump.fun/callouts`. It is not a secret — it is in their public bundle — but
// it is *theirs*, there is no API that hands it out, and when it changes our
// hourly poll starts returning 401 and the crank settles an epoch with no
// callers. Phase 02 §2.6 risk 2 required that a rotation be an **alerted**
// failure rather than a silent one. This module is the other half: alerted
// *and* recovered from, without a human pasting a new key onto two boxes.
//
// Where the key actually lives, measured 2026-08-07 rather than assumed:
//
//   configureApi({ baseUrl:"https://api.coin-communities.xyz", fetch:l,
//     auth: async e => { …
//       if("apiKey"===e.type) return "cc_367f…" }})
//
// So the key sits a few hundred characters from the base URL that
// `callouts.mjs` already hard-codes, inside the same `configureApi` call. That
// co-location is the anchor, and it is worth far more than a bare `cc_` regex:
// the bundle is minified with per-build identifiers (`e`, `i`, `l`, `s` all
// change between deploys) but `"https://api.coin-communities.xyz"` and
// `"apiKey"` are string literals from pump.fun's own source and survive
// reminification.
//
// Three rules this module follows, and each is load-bearing.
//
//   * **Never execute what it downloads.** This fetches ~2.5 MB of a third
//     party's JavaScript. It is read as text and matched with regexes, and
//     there is no `eval`, no `import()`, no `new Function` anywhere in this
//     file. A key extractor that runs pump.fun's bundle to get the key would
//     hand pump.fun's CDN arbitrary code execution inside the crank.
//   * **Never accept a key it has not used.** An extracted string is a
//     candidate. It becomes the key only after a live request with it returns
//     something other than 401/403. A key that parses but does not work is
//     worse than a stale one, because it converts a loud failure into a
//     confusing one.
//   * **Recovering is not the same as being quiet.** A rotation is a change in
//     someone else's system that we depend on. `onRotate` fires even when the
//     recovery succeeded, so the operator learns it happened.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, writeJson, REPO_ROOT } from './store.mjs';
import { DEFAULT_BASE_URL, CalloutError } from './callouts.mjs';

/** The page that loads the callout UI, and therefore the bundle with the key. */
export const CALLOUT_PAGE_URL = 'https://pump.fun/callouts';

/**
 * Where a derived key is remembered between runs.
 *
 * Working state, exactly like the callout store beside it — not the audit
 * trail, and gitignored for the same reason. Deleting it costs one derivation.
 */
export const KEY_CACHE_PATH = resolve(REPO_ROOT, 'epochs/callout-key.json');

/**
 * `cc_` and exactly 64 lowercase hex. Measured against the live key.
 *
 * Deliberately strict, because this string goes into an outbound header. A
 * loose pattern would let a half-matched fragment of minified JS through and
 * turn a clean 401 into a mystery.
 */
export const KEY_SHAPE = /^cc_[0-9a-f]{64}$/;

/** The same shape, for scanning bundle text rather than validating a whole string. */
const KEY_IN_TEXT = /cc_[0-9a-f]{64}/g;

/**
 * Bounds. Every one of these is a limit on a third party's response, and they
 * exist so that a change on pump.fun's side is a failure here rather than an
 * unbounded download inside a crank that runs on a timer.
 */
export const LIMITS = Object.freeze({
  maxChunks: 120,        // the page loaded 51 on 2026-08-07
  maxBytesPerChunk: 12 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  concurrency: 8,
  timeoutMs: 25_000,
});

/** How near the anchor a candidate must sit to count as anchored. */
const ANCHOR_WINDOW = 6_000;

// ── pure extraction ────────────────────────────────────────────────────────

/** Is this exactly the shape of a callout key? */
export function isWellFormedKey(value) {
  return typeof value === 'string' && KEY_SHAPE.test(value);
}

/** Show a key in a log or an alert without writing the whole thing down. */
export function fingerprint(key) {
  if (!isWellFormedKey(key)) return String(key);
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}

/**
 * Every same-origin script the page pulls in.
 *
 * Matched on the chunk path rather than on `<script src=…>`, because Next.js
 * also references chunks from its inline bootstrap and from preload hints, and
 * the chunk carrying the key has no reason to be one of the `<script>` tags.
 * Capped: a page that suddenly lists ten thousand chunks is a change we want to
 * fail on, not to download.
 */
export function scriptUrlsFrom(html, origin = 'https://pump.fun') {
  const paths = String(html).match(/\/_next\/static\/chunks\/[A-Za-z0-9_~.\-/]*\.js/g) ?? [];
  const unique = [...new Set(paths)];
  return unique.slice(0, LIMITS.maxChunks).map((path) => `${origin}${path}`);
}

/**
 * Pull the key out of one bundle, and say which anchor found it.
 *
 * Three layers, most specific first. The `via` label is not decoration: when
 * pump.fun restructures their bundle this is how the next reader learns that
 * the strong anchor stopped matching and we fell back — while it still works,
 * rather than after it breaks.
 *
 * @returns {{key: string, via: string}|null}
 */
export function extractKey(js, { baseUrl = DEFAULT_BASE_URL } = {}) {
  const text = String(js);
  const candidates = [...text.matchAll(KEY_IN_TEXT)].map((m) => ({
    key: m[0],
    at: m.index,
  }));
  if (candidates.length === 0) return null;

  // Distinct keys in one bundle would mean this heuristic cannot tell which one
  // the callout API wants. Guessing would be indefensible — the whole point of
  // anchoring is not to guess — so anchoring has to break the tie or we fail.
  const nearest = (anchorAt) =>
    candidates
      .map((c) => ({ ...c, distance: Math.abs(c.at - anchorAt) }))
      .filter((c) => c.distance <= ANCHOR_WINDOW)
      .sort((a, b) => a.distance - b.distance)[0];

  // Layer 1 — the base URL our own code already hard-codes, in the same
  // `configureApi` call as the key.
  const baseAt = text.indexOf(baseUrl);
  if (baseAt !== -1) {
    const hit = nearest(baseAt);
    if (hit) return { key: hit.key, via: 'baseUrl' };
  }

  // Layer 2 — the `"apiKey"` discriminant of the auth callback. Survives the
  // base URL moving to a different chunk than the key.
  const apiKeyAt = text.search(/["']apiKey["']/);
  if (apiKeyAt !== -1) {
    const hit = nearest(apiKeyAt);
    if (hit) return { key: hit.key, via: 'apiKey' };
  }

  // Layer 3 — a lone well-formed key in a bundle that talks to this API at all.
  // Only when it is unambiguous.
  const distinct = [...new Set(candidates.map((c) => c.key))];
  if (distinct.length === 1 && text.includes('coin-communities')) {
    return { key: distinct[0], via: 'sole-candidate' };
  }

  return null;
}

/**
 * Choose between per-chunk findings.
 *
 * Anchored beats unanchored; ties go to the strongest anchor. If two chunks
 * yield two *different* anchored keys we stop, because at that point the
 * bundle's shape has changed enough that any answer is a guess.
 */
export function chooseKey(findings) {
  const rank = { baseUrl: 0, apiKey: 1, 'sole-candidate': 2 };
  const sorted = [...findings].sort((a, b) => rank[a.via] - rank[b.via]);
  const best = sorted[0];
  if (!best) return null;

  const conflicting = sorted.filter(
    (f) => rank[f.via] === rank[best.via] && f.key !== best.key,
  );
  if (conflicting.length > 0) {
    throw new CalloutError(
      'pump.fun\'s bundle yielded two different equally-anchored callout keys, ' +
        'so which one the API wants cannot be determined without guessing',
      { keys: [best.key, ...conflicting.map((c) => c.key)].map(fingerprint) },
    );
  }
  return best;
}

// ── fetching ───────────────────────────────────────────────────────────────

async function getText(url, { fetchImpl, maxBytes, signalFor }) {
  const response = await fetchImpl(url, {
    headers: {
      // Their CDN serves a different (or no) bundle to something that does not
      // look like a browser. This is the page a visitor loads; ask for it as a
      // visitor would.
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
    signal: signalFor?.(),
  });
  if (!response.ok) {
    throw new CalloutError(`fetching ${url} returned ${response.status}`, {
      url,
      status: response.status,
    });
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new CalloutError(`response from ${url} exceeded ${maxBytes} bytes`, { url });
  }
  return text;
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function mapWithLimit(items, limit, worker) {
  const results = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Load pump.fun's callout page and read the key out of its bundle.
 *
 * Does no validation against the live API — `deriveCalloutKey` does that. Split
 * so the extraction is testable without a network and the validation is
 * testable without a bundle.
 */
export async function scrapeCalloutKey({
  fetchImpl = fetch,
  pageUrl = CALLOUT_PAGE_URL,
  log = () => {},
} = {}) {
  const timeout = () => AbortSignal.timeout(LIMITS.timeoutMs);
  const origin = new URL(pageUrl).origin;

  const html = await getText(pageUrl, {
    fetchImpl,
    maxBytes: LIMITS.maxBytesPerChunk,
    signalFor: timeout,
  });

  // Occasionally the key is inlined in the document itself. Cheap to check, and
  // it saves fifty requests when it is true.
  const inline = extractKey(html);
  if (inline) {
    log(`callout key found in the page itself (via ${inline.via})`);
    return { ...inline, source: pageUrl, chunksScanned: 0 };
  }

  const urls = scriptUrlsFrom(html, origin);
  if (urls.length === 0) {
    throw new CalloutError(
      'pump.fun/callouts listed no script chunks — the page shape has changed',
      { pageUrl },
    );
  }

  let total = 0;
  const findings = [];
  await mapWithLimit(urls, LIMITS.concurrency, async (url) => {
    let js;
    try {
      js = await getText(url, {
        fetchImpl,
        maxBytes: LIMITS.maxBytesPerChunk,
        signalFor: timeout,
      });
    } catch {
      // One chunk failing is normal — the page lists chunks for routes we are
      // not on. Only the absence of any finding is an error.
      return;
    }
    total += js.length;
    if (total > LIMITS.maxTotalBytes) {
      throw new CalloutError('pump.fun\'s bundle exceeded the total size bound', {
        maxTotalBytes: LIMITS.maxTotalBytes,
      });
    }
    const found = extractKey(js);
    if (found) findings.push({ ...found, source: url });
  });

  const best = chooseKey(findings);
  if (!best) {
    throw new CalloutError(
      'no callout key found in pump.fun\'s bundle — the key\'s shape or its ' +
        'position relative to the coin-communities base URL has changed, and ' +
        'scripts/lib/callout-key.mjs needs a new anchor',
      { pageUrl, chunksScanned: urls.length },
    );
  }
  log(
    `callout key ${fingerprint(best.key)} found via ${best.via} ` +
      `in ${urls.length} chunks`,
  );
  return { ...best, chunksScanned: urls.length };
}

/**
 * Does this key actually work?
 *
 * The only question that matters, and the reason a derived key is a candidate
 * until this returns true. Any non-auth failure (the API being down, a bad
 * mint) is reported as inconclusive rather than as a bad key, so a pump.fun
 * outage never causes us to discard a key that was fine.
 */
export async function validateKey(key, { mint, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  if (!isWellFormedKey(key)) return { ok: false, reason: 'malformed' };
  if (!mint) return { ok: true, reason: 'shape-only (no mint to test against)' };
  try {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/communities/${mint}/callouts/public`,
      {
        headers: { 'x-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(LIMITS.timeoutMs),
      },
    );
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: `rejected (${response.status})` };
    }
    if (!response.ok) {
      return { ok: true, reason: `inconclusive (API returned ${response.status})` };
    }
    return { ok: true, reason: 'accepted' };
  } catch (error) {
    return { ok: true, reason: `inconclusive (${error.message})` };
  }
}

// ── cache ──────────────────────────────────────────────────────────────────

/**
 * The cache, or `null` when there isn't one yet.
 *
 * `existsSync` rather than `readJson(path, null)`: a null fallback is that
 * helper's "this file must exist" signal and it throws. Having no cached key is
 * the ordinary state on a fresh box, not a failure.
 *
 * A corrupt or half-written cache is treated as no cache. It costs one
 * derivation and cannot wedge the poll, which is the right trade for a file
 * whose entire contents are re-derivable.
 */
export function readCachedKey(path = KEY_CACHE_PATH) {
  if (!existsSync(path)) return null;
  try {
    const cached = readJson(path, null);
    return isWellFormedKey(cached?.key) ? cached : null;
  } catch {
    return null;
  }
}

export function writeCachedKey(entry, path = KEY_CACHE_PATH) {
  writeJson(path, entry);
  return entry;
}

// ── the whole path ─────────────────────────────────────────────────────────

/**
 * Scrape, validate, and cache. The full derivation.
 */
export async function deriveCalloutKey({
  mint,
  fetchImpl = fetch,
  cachePath = KEY_CACHE_PATH,
  log = () => {},
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const found = await scrapeCalloutKey({ fetchImpl, log });
  const check = await validateKey(found.key, { mint, fetchImpl });
  if (!check.ok) {
    throw new CalloutError(
      `derived a callout key from pump.fun's bundle but the API ${check.reason} it`,
      { key: fingerprint(found.key), via: found.via },
    );
  }
  const entry = {
    key: found.key,
    via: found.via,
    source: found.source,
    validated: check.reason,
    derivedAt: now(),
  };
  writeCachedKey(entry, cachePath);
  log(`callout key ${fingerprint(entry.key)} derived and cached (${check.reason})`);
  return entry;
}

/**
 * The key source the poll and the crank hold.
 *
 * `get()` is the cheap path and answers from the environment or the cache.
 * `refresh()` is the expensive one and runs only when the API has actually
 * rejected us — which is the only trustworthy signal that the key rotated. A
 * timer-based refresh would download 2.5 MB of someone else's bundle every hour
 * to learn something a single 401 tells us for free.
 *
 * `CALLOUT_API_KEY` in the environment always wins and is never overwritten:
 * an operator who pinned a key is answering a question, and a background
 * process that silently replaced it would be arguing.
 */
export function createCalloutKeySource({
  env = globalThis.process?.env ?? {},
  mint,
  fetchImpl = fetch,
  cachePath = KEY_CACHE_PATH,
  log = () => {},
  onRotate = null,
} = {}) {
  const pinned = env.CALLOUT_API_KEY;
  if (pinned && !isWellFormedKey(pinned)) {
    throw new CalloutError(
      `CALLOUT_API_KEY is set but is not the shape of a callout key ` +
        `(expected cc_ followed by 64 hex characters)`,
    );
  }
  let current = pinned || null;

  return {
    pinned: Boolean(pinned),

    async get() {
      if (current) return current;
      const cached = readCachedKey(cachePath);
      if (cached) {
        current = cached.key;
        return current;
      }
      const derived = await deriveCalloutKey({ mint, fetchImpl, cachePath, log });
      current = derived.key;
      return current;
    },

    async refresh() {
      if (pinned) {
        // Pinned and rejected: re-deriving would override an explicit choice,
        // and the operator needs to know their pinned key stopped working.
        throw new CalloutError(
          'the callout API rejected the CALLOUT_API_KEY set in the environment. ' +
            'It has rotated. Unset CALLOUT_API_KEY to let the crank derive it, ' +
            'or set the current one.',
          { key: fingerprint(pinned) },
        );
      }
      const previous = current;
      const derived = await deriveCalloutKey({ mint, fetchImpl, cachePath, log });
      current = derived.key;
      const rotated = Boolean(previous) && previous !== derived.key;
      if (rotated && onRotate) {
        // Phase 02 §2.6 risk 2: recovered is still a change worth hearing about.
        await onRotate({
          previous: fingerprint(previous),
          next: fingerprint(derived.key),
          via: derived.via,
        });
      }
      return current;
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
//
// `node scripts/lib/callout-key.mjs [--mint <MINT>]`
//
// For the day pump.fun restructures their bundle and the anchor stops matching.
// It prints which layer found the key and which chunk it came from, which is
// the difference between "the derivation broke" and a two-minute fix.

async function main() {
  const argv = process.argv.slice(2);
  const mintFlag = argv.indexOf('--mint');
  const mint = mintFlag === -1 ? undefined : argv[mintFlag + 1];

  const found = await scrapeCalloutKey({ log: console.log });
  console.log(`anchor    ${found.via}`);
  console.log(`chunk     ${found.source}`);
  console.log(`key       ${fingerprint(found.key)}`);

  const check = await validateKey(found.key, { mint });
  console.log(`live API  ${check.reason}`);
  if (!check.ok) {
    console.error('\nthe API refused this key — the anchor found the wrong string');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      error instanceof CalloutError ? `\nCALLOUT KEY: ${error.message}` : `\n${error.stack}`,
    );
    process.exitCode = 1;
  });
}
