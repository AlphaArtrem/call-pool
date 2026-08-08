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

/** The one route the fallback calls. */
const ROUTE = /^\/api\/v1\/users\/by-wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})\/callouts$/;

/**
 * Every record this wallet has ever posted, newest first.
 *
 * Deliberately **unfiltered by window**: pump returns a wallet's history and
 * the caller decides what counts. Filtering here would mean the mock and the
 * settlement disagreed about the rule, and the rehearsal would be proving the
 * mock rather than the crank.
 */
export function calloutsForWallet(store, address) {
  return Object.values(store.callouts ?? {})
    .filter((record) => record?.walletAddress === address)
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
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
    const match = ROUTE.exec((req.url ?? '').split('?')[0]);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // Re-read per request rather than caching: the loop writes the store every
    // epoch, and a cached copy would answer the fallback with the previous
    // epoch's callers — which is precisely the silent wrongness this whole
    // rehearsal exists to catch.
    const store = readStore(storePath);
    const callouts = calloutsForWallet(store, match[1]);
    console.log(`${new Date().toISOString()}  ${match[1]}  ${callouts.length} record(s)`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ callouts }));
  });

  server.listen(Number(args.port), '127.0.0.1', () => {
    console.log(`\nCALLPOOL — mock pump.fun callout API\n`);
    console.log(`store   ${storePath}`);
    console.log(`listen  http://127.0.0.1:${args.port}`);
    console.log(`route   /api/v1/users/by-wallet/<address>/callouts`);
    console.log('\nPoint settlement at it:');
    console.log(`  node scripts/crank.mjs --callout-base http://127.0.0.1:${args.port} …\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
