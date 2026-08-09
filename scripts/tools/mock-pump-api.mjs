#!/usr/bin/env node
//
// scripts/tools/mock-pump-api.mjs — pump.fun's per-wallet callout endpoint,
// answered from the rehearsal's own store.
//
//   node scripts/tools/mock-pump-api.mjs --store epochs/devnet/callout-store.json
//   ... --port 8200
//
// **Devnet only, and it refuses to serve anything but the rehearsal store.**
//
// ## Why this exists
//
// L5's truncation fallback is the one safety net that has never run on real
// data. When the feed returns 50 records with the oldest still inside the
// window, settlement stops trusting the feed and asks pump **per wallet**
// instead, for every wallet that could be eligible.
//
// That path could not be exercised on devnet at all. `collectByWallet` calls
// `api.coin-communities.xyz`, which only knows about mainnet coins, so every
// devnet wallet came back empty — and a truncated epoch settled with **nobody
// in it**, which looks exactly like a clean run with no callers. The rehearsal
// could reach the fallback and could never observe it working.
//
// So the seam moves one layer out. `mock-callouts.mjs` already owns the store;
// this serves the same records back through the shape pump uses, and
// `snapshot.mjs --callout-base http://127.0.0.1:8200` sends the fallback here.
// Production passes no `--callout-base` and reaches pump, unchanged.
//
// **It is a mock of the transport, not of the decision.** Which records count
// is still decided by `countable`, `isForMint` and the window test inside
// `collectByWallet` — this only answers "what has this wallet ever posted",
// exactly as pump does, and the settlement filters it.

import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { readStore } from '../lib/store.mjs';
import { STORE_PATH } from '../lib/store.mjs';

/**
 * The routes the fallback calls, in the order it calls them.
 *
 * `HISTORY` is the older per-wallet history route. The fallback no longer uses
 * it — it capped at 100 with no cursor — but it stays served because
 * `fetchWalletCallouts` is still exported and a rehearsal may reach for it.
 *
 * The other three are the exact path: wallet → userId → callout id for this
 * coin → the full public record. There is no real identity service behind this
 * mock, so a wallet's userId is simply the wallet: the seam being rehearsed is
 * the transport and the settlement's filtering, not pump's user table.
 */
const HISTORY = /^\/api\/v1\/users\/by-wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})\/callouts$/;
const BY_WALLET = /^\/api\/v1\/users\/by-wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const BY_MINT = /^\/api\/v1\/users\/([1-9A-HJ-NP-Za-km-z]{32,44})\/callouts\/by-mint\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
// The callout id is `[A-Za-z0-9-]+`, NOT a UUID pattern. pump's real ids are
// UUIDs, but this serves the rehearsal store, whose ids look like
// `mock-3-w07-pre` — a UUID-shaped route would 404 every id the rehearsal
// generates, and the fallback would die on its first caller.
const BY_ID = /^\/api\/v1\/communities\/([1-9A-HJ-NP-Za-km-z]{32,44})\/callouts\/([A-Za-z0-9-]+)\/public$/;
// The author's own updates on a callout (L2). `collectByWallet` fetches this
// for EVERY caller it recovers, so a mock without it fails the whole fallback,
// not just the update case.
const REPLIES = /^\/api\/v1\/communities\/([1-9A-HJ-NP-Za-km-z]{32,44})\/callouts\/([A-Za-z0-9-]+)\/replies\/public$/;

/**
 * Every **callout** this wallet has posted, newest first.
 *
 * Deliberately **unfiltered by window**: pump returns a wallet's history and
 * the caller decides what counts. Filtering here would mean the mock and the
 * settlement disagreed about the rule, and the rehearsal would be proving the
 * mock rather than the crank.
 *
 * ⚠️ **Updates are excluded, and that is the whole point.** The rehearsal store
 * is one flat map holding callouts and their updates together, but pump keeps
 * them on different routes: a callout is reachable by-mint and by-id, while an
 * author's update is reachable *only* through its parent's `/replies/public`.
 * Without this filter the newest record for a wallet is usually its update, so
 * `by-mint` handed the fallback an update id, the callout it belonged to was
 * never recovered, and the wallet was credited for the update alone.
 *
 * Measured 2026-08-09 on a mainnet-shaped store: 15 of 50 callouts vanished
 * exactly this way, silently, with the totals still looking plausible.
 */
export function calloutsForWallet(store, address) {
  return Object.values(store.callouts ?? {})
    .filter((record) => record?.walletAddress === address && !record.isUpdate)
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
}

/**
 * Route one request against one store. Pure, and exported so the suite can
 * drive the REAL fallback (`collectByWallet`) through the REAL router.
 *
 * It was inlined in the request handler, and the tests modelled the routes with
 * their own stub — which is how two devnet-killing gaps shipped green on
 * 2026-08-09: the callout-id pattern was UUID-shaped while the rehearsal's own
 * ids look like `mock-3-w07`, and the `/replies/public` route the fallback hits
 * for every caller was not served at all. The stub proved the stub; only
 * routing the settlement's own requests through this function proves the mock.
 *
 * @returns {{status: number, body: object, note: string}}
 */
export function respond(store, path) {
  let m;
  if ((m = HISTORY.exec(path))) {
    const callouts = calloutsForWallet(store, m[1]);
    return { status: 200, body: { callouts }, note: `${callouts.length} record(s)` };
  }

  if ((m = BY_WALLET.exec(path))) {
    // 404 with pump's own message when the wallet has posted nothing, so the
    // rehearsal exercises the no-account branch rather than only the happy
    // one. A holder with no pump account is the common case in production.
    const has = calloutsForWallet(store, m[1]).length > 0;
    return has
      ? { status: 200, body: { userId: m[1] }, note: 'user found' }
      : { status: 404, body: { message: 'No user linked to this wallet' }, note: 'no user' };
  }

  if ((m = BY_MINT.exec(path))) {
    const [, userId, mint] = m;
    const callout = calloutsForWallet(store, userId).find((r) => r.tokenAddress === mint);
    // `{callout: null}` with a 200 is what pump returns for "never called
    // out" — and, importantly, also for a userId that does not exist.
    return {
      status: 200,
      body: {
        callout: callout ? { calloutId: callout.id, coinMint: mint } : null,
        updates: [],
        updateCount: 0,
      },
      note: callout ? `callout ${callout.id}` : 'no callout',
    };
  }

  // REPLIES before BY_ID is not load-bearing (the id segment cannot contain a
  // slash) but keeps the specific route ahead of the general one.
  if ((m = REPLIES.exec(path))) {
    const [, mint, calloutId] = m;
    const parent = (store.callouts ?? {})[calloutId];
    if (!parent || parent.tokenAddress !== mint) {
      return { status: 404, body: { error: 'not found' }, note: 'no such callout' };
    }
    // The author's own updates, exactly as pump scopes this route. The staging
    // tool does not write updates today, so this is usually empty — which is
    // also pump's normal answer for a callout nobody updated.
    const replies = Object.values(store.callouts ?? {}).filter(
      (r) => r?.parentCalloutId === calloutId,
    );
    return { status: 200, body: { replies }, note: `${replies.length} update(s)` };
  }

  if ((m = BY_ID.exec(path))) {
    const [, mint, calloutId] = m;
    const record = (store.callouts ?? {})[calloutId];
    if (!record || record.tokenAddress !== mint) {
      return { status: 404, body: { error: 'not found' }, note: 'no such callout' };
    }
    return { status: 200, body: { callout: record }, note: 'full record' };
  }

  return { status: 404, body: { error: 'not found' }, note: 'unrouted' };
}

function parseArgs(argv) {
  const args = { port: '8200' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const storePath = args.store ? resolve(process.cwd(), args.store) : null;

  // The production store is what the real crank settles from. Serving it back
  // as if it were pump's answer would make a fabricated record indistinguishable
  // from a real one at the only point where that distinction still exists.
  if (!storePath || storePath === STORE_PATH) {
    throw new Error(
      '--store <PATH> is required and must not be the production callout store. ' +
        'Point it at the rehearsal store under epochs/devnet/.',
    );
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];

    // Re-read per request rather than caching: the loop writes the store every
    // epoch, and a cached copy would answer the fallback with the previous
    // epoch's callers — which is precisely the silent wrongness this whole
    // rehearsal exists to catch.
    const store = readStore(storePath);
    const { status, body, note } = respond(store, path);

    console.log(`${new Date().toISOString()}  ${status}  ${path}  ${note}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  server.listen(Number(args.port), '127.0.0.1', () => {
    console.log(`\nCALLPOOL — mock pump.fun callout API\n`);
    console.log(`store   ${storePath}`);
    console.log(`listen  http://127.0.0.1:${args.port}`);
    console.log(`routes  /api/v1/users/by-wallet/<address>`);
    console.log(`        /api/v1/users/<userId>/callouts/by-mint/<mint>`);
    console.log(`        /api/v1/communities/<mint>/callouts/<calloutId>/public`);
    console.log(`        /api/v1/communities/<mint>/callouts/<calloutId>/replies/public`);
    console.log(`        /api/v1/users/by-wallet/<address>/callouts   (legacy)`);
    console.log('\nPoint settlement at it:');
    console.log(`  node scripts/crank.mjs --callout-base http://127.0.0.1:${args.port} …\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
