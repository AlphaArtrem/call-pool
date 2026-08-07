// Deriving pump.fun's callout key, and surviving a rotation of it.
//
// The key is a third party's, it rotates without notice, and there is no API
// that hands it out. So we read it out of their public bundle. That makes these
// tests unusual in one specific way: the fixture below is not invented, it is
// the **measured** shape of pump.fun's minified bundle on 2026-08-07, and the
// tests that matter most are the ones that prove the extraction does not depend
// on anything a minifier is free to change between builds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  chooseKey,
  createCalloutKeySource,
  deriveCalloutKey,
  extractKey,
  fingerprint,
  isWellFormedKey,
  readCachedKey,
  scrapeCalloutKey,
  scriptUrlsFrom,
  validateKey,
  LIMITS,
} from '../lib/callout-key.mjs';
import { fetchMintCallouts, CalloutError } from '../lib/callouts.mjs';

const KEY_A = `cc_${'a1b2c3d4'.repeat(8)}`;
const KEY_B = `cc_${'9f8e7d6c'.repeat(8)}`;
const MINT = 'So11111111111111111111111111111111111111112';

/**
 * The real thing, trimmed. Copied from
 * `_next/static/chunks/…js` as served on 2026-08-07, with the key swapped for a
 * test value. Everything else — the minified identifiers, the property order,
 * the `configureApi` shape — is verbatim, because a fixture that has been
 * tidied up stops testing the thing that actually has to work.
 */
const REAL_BUNDLE = (key = KEY_A, ident = 'e') =>
  `rn n;let i=await o();if(!i)return n;let s=new Headers(r.headers);return s.set("Authorization",` +
  '`Bearer ${i}`),fetch(new Request(r,{headers:s}))},u=!1;function c(){u||((0,i.configureApi)(' +
  `{baseUrl:"https://api.coin-communities.xyz",fetch:l,auth:async ${ident}=>{if("bearer"===${ident}.scheme)` +
  `{let ${ident}=(0,s.getCommunityAccessToken)();return ${ident}?(0,s.isJwtExpired)(${ident})?await o()??void 0:${ident}:void 0}` +
  `if("apiKey"===${ident}.type)return"${key}"}}),u=!0)}e.s(["CommunitySdkProvider",0,function(e){`;

// ── extraction ─────────────────────────────────────────────────────────────

test('the key is found in pump.fun\'s real minified bundle shape', () => {
  const found = extractKey(REAL_BUNDLE());
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'baseUrl');
});

test('extraction survives reminification — identifiers are not part of the anchor', () => {
  // The single most important property here. `e`, `i`, `l` and `s` are
  // minifier output and change between pump.fun deploys; the string literals
  // "https://api.coin-communities.xyz" and "apiKey" come from their source and
  // do not. An extractor anchored on identifiers would work today and break on
  // a deploy we do not control and cannot predict.
  for (const ident of ['e', 'x', '_a', '$b']) {
    const found = extractKey(REAL_BUNDLE(KEY_A, ident));
    assert.equal(found.key, KEY_A, `identifier ${ident} broke extraction`);
  }
});

test('a bundle with the key but no base URL falls back to the apiKey anchor', () => {
  const chunk = `if("apiKey"===e.type)return"${KEY_A}"`;
  const found = extractKey(chunk);
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'apiKey');
});

test('a lone key in a coin-communities bundle is accepted as the sole candidate', () => {
  const chunk = `fetch("https://coin-communities.example/x",{h:"${KEY_A}"})`;
  const found = extractKey(chunk);
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'sole-candidate');
});

test('distance decides between candidates, so a far one loses to a near one', () => {
  // Anchoring is the whole point: when a bundle holds more than one `cc_`-shaped
  // string, the one sitting inside the `configureApi` call is the key and the
  // other is some unrelated constant.
  const chunk =
    `{baseUrl:"https://api.coin-communities.xyz",auth:"${KEY_A}"}` +
    `${'x'.repeat(20_000)}"${KEY_B}"`;
  const found = extractKey(chunk);
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'baseUrl');
});

test('ambiguous candidates, none of them anchored, are refused', () => {
  // Two equally unidentifiable candidates. Returning either would put an
  // arbitrary bundle constant into an outbound header, so it returns neither.
  const chunk =
    `"https://api.coin-communities.xyz"${'x'.repeat(20_000)}"${KEY_A}"..."${KEY_B}"`;
  assert.equal(extractKey(chunk), null);
});

test('a sole candidate is accepted however far it sits from the anchor', () => {
  // Deliberate, and the reason the layer exists: it is the fallback for
  // pump.fun restructuring their bundle so that neither string literal lands
  // near the key any more. With exactly one well-formed candidate in a bundle
  // that talks to this API, there is nothing to confuse it with — and the
  // candidate is still validated against the live API before it is ever used.
  const chunk =
    `"https://api.coin-communities.xyz"${'x'.repeat(20_000)}"${KEY_A}"`;
  const found = extractKey(chunk);
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'sole-candidate');
});

test('a bundle with no key at all yields nothing rather than a partial match', () => {
  assert.equal(extractKey('const a = "cc_notlongenough"; const b = 1;'), null);
  assert.equal(extractKey(''), null);
});

test('two different equally-anchored keys stop the derivation instead of a coin flip', () => {
  // If the bundle changes shape enough that two chunks both look authoritative,
  // any answer is a guess — and a guessed key is a silent 401 an hour later.
  assert.throws(
    () =>
      chooseKey([
        { key: KEY_A, via: 'baseUrl', source: 'a.js' },
        { key: KEY_B, via: 'baseUrl', source: 'b.js' },
      ]),
    (error) => error instanceof CalloutError && /two different/.test(error.message),
  );
});

test('a strong anchor beats a weak one rather than conflicting with it', () => {
  const chosen = chooseKey([
    { key: KEY_B, via: 'sole-candidate', source: 'b.js' },
    { key: KEY_A, via: 'baseUrl', source: 'a.js' },
  ]);
  assert.equal(chosen.key, KEY_A);
  assert.equal(chosen.via, 'baseUrl');
});

test('the same key found twice by the same anchor is agreement, not a conflict', () => {
  const chosen = chooseKey([
    { key: KEY_A, via: 'baseUrl', source: 'a.js' },
    { key: KEY_A, via: 'baseUrl', source: 'b.js' },
  ]);
  assert.equal(chosen.key, KEY_A);
});

// ── shape ──────────────────────────────────────────────────────────────────

test('only cc_ plus exactly 64 lowercase hex is a well-formed key', () => {
  assert.ok(isWellFormedKey(KEY_A));
  assert.ok(!isWellFormedKey(`cc_${'a'.repeat(63)}`));
  assert.ok(!isWellFormedKey(`cc_${'a'.repeat(65)}`));
  assert.ok(!isWellFormedKey(`cc_${'A'.repeat(64)}`));
  assert.ok(!isWellFormedKey(`xx_${'a'.repeat(64)}`));
  assert.ok(!isWellFormedKey(undefined));
  assert.ok(!isWellFormedKey(null));
});

test('a fingerprint identifies a key without writing the whole thing down', () => {
  const print = fingerprint(KEY_A);
  assert.ok(!print.includes(KEY_A));
  assert.ok(print.startsWith('cc_a1b2c3'));
  assert.ok(print.length < 20);
});

// ── page parsing ───────────────────────────────────────────────────────────

test('chunk URLs are read from the whole document, not only from script tags', () => {
  // Next.js references chunks from its inline bootstrap and from preload hints
  // as well as from <script src>, and the chunk carrying the key has no reason
  // to be one of the tags.
  const html = `
    <script src="/_next/static/chunks/aaa.js?dpl=x"></script>
    <link rel="preload" href="/_next/static/chunks/bbb.js"/>
    self.__next_f.push([1,"/_next/static/chunks/ccc.js"])
  `;
  const urls = scriptUrlsFrom(html);
  assert.deepEqual(urls, [
    'https://pump.fun/_next/static/chunks/aaa.js',
    'https://pump.fun/_next/static/chunks/bbb.js',
    'https://pump.fun/_next/static/chunks/ccc.js',
  ]);
});

test('a page listing absurdly many chunks is capped rather than downloaded', () => {
  const html = Array.from(
    { length: LIMITS.maxChunks + 500 },
    (_, i) => `<script src="/_next/static/chunks/c${i}.js"></script>`,
  ).join('');
  assert.equal(scriptUrlsFrom(html).length, LIMITS.maxChunks);
});

// ── validation ─────────────────────────────────────────────────────────────

test('a key the API rejects is not accepted, however well-anchored it was', async () => {
  const result = await validateKey(KEY_A, {
    mint: MINT,
    fetchImpl: async () => new Response('', { status: 401 }),
  });
  assert.equal(result.ok, false);
});

test('a key the API accepts is accepted', async () => {
  const result = await validateKey(KEY_A, {
    mint: MINT,
    fetchImpl: async () => new Response(JSON.stringify({ callouts: [] }), { status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'accepted');
});

test('an API outage is inconclusive, not a verdict on the key', async () => {
  // The distinction that keeps a pump.fun 500 from making us throw away a key
  // that was working perfectly well.
  const down = await validateKey(KEY_A, {
    mint: MINT,
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  assert.equal(down.ok, true);
  assert.match(down.reason, /inconclusive/);

  const offline = await validateKey(KEY_A, {
    mint: MINT,
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert.equal(offline.ok, true);
  assert.match(offline.reason, /inconclusive/);
});

// ── scraping end to end, without a network ─────────────────────────────────

/** A fake pump.fun: one page listing chunks, one of which carries the key. */
function fakePumpFun({ key = KEY_A, keyed = 'b.js', chunks = ['a.js', 'b.js', 'c.js'] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/callouts')) {
      const html = chunks
        .map((c) => `<script src="/_next/static/chunks/${c}"></script>`)
        .join('');
      return new Response(html, { status: 200 });
    }
    if (String(url).includes(keyed)) return new Response(REAL_BUNDLE(key), { status: 200 });
    return new Response('window.x=1;', { status: 200 });
  };
  return { fetchImpl, calls };
}

test('the key is scraped out of whichever chunk happens to carry it', async () => {
  const { fetchImpl, calls } = fakePumpFun();
  const found = await scrapeCalloutKey({ fetchImpl });
  assert.equal(found.key, KEY_A);
  assert.equal(found.via, 'baseUrl');
  assert.equal(found.chunksScanned, 3);
  assert.ok(calls.some((u) => u.endsWith('b.js')));
});

test('a key inlined in the document short-circuits fifty chunk requests', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(REAL_BUNDLE(), { status: 200 });
  };
  const found = await scrapeCalloutKey({ fetchImpl });
  assert.equal(found.key, KEY_A);
  assert.equal(found.chunksScanned, 0);
  assert.equal(calls.length, 1);
});

test('one dead chunk does not fail the scrape', async () => {
  // The page lists chunks for routes we are not on; some 404. Only the absence
  // of any finding is an error.
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/callouts')) {
      return new Response(
        '<script src="/_next/static/chunks/dead.js"></script>' +
          '<script src="/_next/static/chunks/live.js"></script>',
        { status: 200 },
      );
    }
    if (String(url).includes('dead.js')) return new Response('', { status: 404 });
    return new Response(REAL_BUNDLE(), { status: 200 });
  };
  const found = await scrapeCalloutKey({ fetchImpl });
  assert.equal(found.key, KEY_A);
});

test('a bundle that no longer contains a key fails with an actionable message', async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith('/callouts')
      ? new Response('<script src="/_next/static/chunks/a.js"></script>', { status: 200 })
      : new Response('window.x=1;', { status: 200 });

  await assert.rejects(
    () => scrapeCalloutKey({ fetchImpl }),
    (error) =>
      error instanceof CalloutError &&
      /needs a new anchor/.test(error.message) &&
      /callout-key\.mjs/.test(error.message),
  );
});

test('a derived key the API rejects is never cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    const { fetchImpl } = fakePumpFun();
    const rejecting = async (url) =>
      String(url).includes('coin-communities.xyz')
        ? new Response('', { status: 401 })
        : fetchImpl(url);

    await assert.rejects(
      () => deriveCalloutKey({ mint: MINT, fetchImpl: rejecting, cachePath }),
      (error) => error instanceof CalloutError && /rejected/.test(error.message),
    );
    assert.equal(existsSync(cachePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a derived key the API accepts is cached with how it was found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    const { fetchImpl } = fakePumpFun();
    const accepting = async (url) =>
      String(url).includes('coin-communities.xyz')
        ? new Response(JSON.stringify({ callouts: [] }), { status: 200 })
        : fetchImpl(url);

    const entry = await deriveCalloutKey({ mint: MINT, fetchImpl: accepting, cachePath });
    assert.equal(entry.key, KEY_A);
    assert.equal(entry.via, 'baseUrl');
    assert.equal(readCachedKey(cachePath).key, KEY_A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the key source ─────────────────────────────────────────────────────────

test('a pinned CALLOUT_API_KEY wins and no derivation is attempted', async () => {
  let fetched = false;
  const source = createCalloutKeySource({
    env: { CALLOUT_API_KEY: KEY_B },
    fetchImpl: async () => {
      fetched = true;
      return new Response('', { status: 200 });
    },
  });
  assert.equal(await source.get(), KEY_B);
  assert.equal(fetched, false, 'a pinned key must not trigger a bundle download');
  assert.equal(source.pinned, true);
});

test('a malformed pinned key is rejected at construction, not at the first request', async () => {
  // Failing here names the problem. Failing at the first request produces a
  // 401 from pump.fun and sends the reader looking at pump.fun.
  assert.throws(
    () => createCalloutKeySource({ env: { CALLOUT_API_KEY: 'not-a-key' } }),
    (error) => error instanceof CalloutError && /not the shape/.test(error.message),
  );
});

test('a rejected pinned key tells the operator rather than overriding their choice', async () => {
  const source = createCalloutKeySource({ env: { CALLOUT_API_KEY: KEY_B } });
  await assert.rejects(
    () => source.refresh(),
    (error) => error instanceof CalloutError && /Unset CALLOUT_API_KEY/.test(error.message),
  );
});

test('a cached key is used without re-deriving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    const { fetchImpl } = fakePumpFun();
    const accepting = async (url) =>
      String(url).includes('coin-communities.xyz')
        ? new Response(JSON.stringify({ callouts: [] }), { status: 200 })
        : fetchImpl(url);
    await deriveCalloutKey({ mint: MINT, fetchImpl: accepting, cachePath });

    let downloads = 0;
    const source = createCalloutKeySource({
      env: {},
      cachePath,
      fetchImpl: async (url) => {
        downloads += 1;
        return accepting(url);
      },
    });
    assert.equal(await source.get(), KEY_A);
    assert.equal(downloads, 0, 'the cache exists so that the hourly poll is one request');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rotation is recovered from AND announced', async () => {
  // Phase 02 §2.6 risk 2 asked for a rotation to be an alerted failure. Now
  // that it is recovered from automatically, "alerted" is the part that is easy
  // to lose — and a silent dependency change in someone else's system is
  // exactly what this project exists to not have.
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    let served = KEY_A;
    const pump = ({ url }) => fakePumpFun({ key: served }).fetchImpl(url);
    const fetchImpl = async (url) =>
      String(url).includes('coin-communities.xyz')
        ? new Response(JSON.stringify({ callouts: [] }), { status: 200 })
        : pump({ url });

    const announced = [];
    const source = createCalloutKeySource({
      env: {},
      mint: MINT,
      cachePath,
      fetchImpl,
      onRotate: (event) => announced.push(event),
    });

    assert.equal(await source.get(), KEY_A);
    served = KEY_B; // pump.fun rotates
    assert.equal(await source.refresh(), KEY_B);

    assert.equal(announced.length, 1);
    assert.equal(announced[0].previous, fingerprint(KEY_A));
    assert.equal(announced[0].next, fingerprint(KEY_B));
    // The alert must carry a fingerprint, never the whole key.
    assert.ok(!JSON.stringify(announced[0]).includes(KEY_B));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the integration that matters ───────────────────────────────────────────

test('a 401 mid-poll re-derives the key and completes the request', async () => {
  // The whole feature in one test: pump.fun rotates the key between two hourly
  // polls, the API rejects us, and the poll finishes anyway rather than
  // settling an epoch with an empty caller list.
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    let live = KEY_A;
    const feed = { callouts: [{ id: '1', walletAddress: 'W', tokenAddress: MINT }] };
    const attempts = [];

    const fetchImpl = async (url, init) => {
      const target = String(url);
      if (target.includes('coin-communities.xyz')) {
        const sent = init?.headers?.['x-api-key'];
        attempts.push(sent);
        return sent === live
          ? new Response(JSON.stringify(feed), { status: 200 })
          : new Response('', { status: 401 });
      }
      return fakePumpFun({ key: live }).fetchImpl(url);
    };

    const source = createCalloutKeySource({ env: {}, mint: MINT, cachePath, fetchImpl });
    assert.equal(await source.get(), KEY_A);

    live = KEY_B; // rotated between polls
    const records = await fetchMintCallouts(MINT, { keySource: source, fetchImpl });

    assert.deepEqual(records, feed.callouts);
    // Deduplicated in order: the old key was tried, then the new one. Asserting
    // on the raw list would couple this test to how many times the derivation
    // probes the API to validate a candidate, which is not what it is about.
    const inOrder = attempts.filter((k, i) => k !== attempts[i - 1]);
    assert.deepEqual(inOrder, [KEY_A, KEY_B]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 401 that survives re-derivation still fails loudly', async () => {
  // Auto-recovery must not become an infinite apology. If the freshly derived
  // key is also refused, the crank stops — settling with no callers is worse
  // than not settling.
  const dir = mkdtempSync(join(tmpdir(), 'callpool-key-'));
  const cachePath = join(dir, 'callout-key.json');
  try {
    const fetchImpl = async (url) =>
      String(url).includes('coin-communities.xyz')
        ? new Response('', { status: 401 })
        : fakePumpFun().fetchImpl(url);

    const source = createCalloutKeySource({ env: {}, cachePath, fetchImpl });
    await assert.rejects(
      () => fetchMintCallouts(MINT, { keySource: source, fetchImpl }),
      (error) => error instanceof CalloutError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a literal apiKey still behaves exactly as it did', async () => {
  // Every existing caller and test passes a string. None of them should have
  // acquired a network dependency.
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers['x-api-key'], KEY_A);
    return new Response(JSON.stringify({ callouts: [] }), { status: 200 });
  };
  assert.deepEqual(await fetchMintCallouts(MINT, { apiKey: KEY_A, fetchImpl }), []);
});
