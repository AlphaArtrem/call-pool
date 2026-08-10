// The site's server: static files, plus the `/rpc` proxy that holds the
// provider key.
//
// The site needs one because ES modules cannot be loaded over `file://` — a
// browser refuses the import for cross-origin reasons and the page silently
// renders nothing. Opening site/index.html by double-clicking it will not
// work, and this is the shortest path to a page that does.
//
// It serves the **repository root**, not `site/`, which is deliberate: the
// page imports the real `scripts/lib/*.mjs` rather than carrying a second copy
// of the floor and the `hold` arithmetic, and the published epoch directories
// live in `snapshots/`. A production host is pointed at the repo root the same
// way, with `/` rewritten to `/site/index.html`.
//
//   node scripts/serve-site.mjs            → http://127.0.0.1:8099/site/
//   node scripts/serve-site.mjs --port 3000
//
//   CALLPOOL_PUBLIC=1 node scripts/serve-site.mjs
//     → serves only site/, scripts/lib/ and snapshots/, the same three trees
//       the live edge allows, and 404s everything else. Caddy is still the
//       documented gate and the one verified from outside; this is so that a
//       Caddyfile misedit cannot re-expose the repository root — which is also
//       where .env, .callout-auth, .git/ and any stray key live — through the
//       process sitting behind it.
//
//   CALLPOOL_RPC_URL_MAINNET='https://<provider>/<key>' node scripts/serve-site.mjs
//     → /rpc forwards to that endpoint, and /rpc/devnet to
//       CALLPOOL_RPC_URL_DEVNET. One route and one key per cluster, so one
//       exposure cannot burn both and the mainnet key is the only one a
//       restriction has to reason about. The page is configured with
//       `rpc: '/rpc'` and never sees either. See lib/rpc-proxy.mjs for what is
//       allowed through and why it is a narrow list rather than a forwarder.
//
// **It binds 127.0.0.1 and speaks no TLS**, so in production it belongs behind
// a reverse proxy that terminates HTTPS for callpool.fun and forwards to it —
// set `CALLPOOL_TRUST_PROXY=1` there so the rate limiter reads the real client
// address out of `X-Forwarded-For` rather than seeing every request as coming
// from the proxy.
//
// Deliberately not a dependency and deliberately not clever: no directory
// listings, no caching, and it refuses any path that escapes the repository.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

import { REPO_ROOT } from './lib/store.mjs';
import { CALLOUT_PROXY_PREFIX, handleCalloutProxy } from './lib/callout-proxy.mjs';
import { clientKey, createRateLimiter, handleRpc, resolveUpstream } from './lib/rpc-proxy.mjs';
import { resolvePath } from './lib/site-paths.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
// `--port`, then `PORT` from the environment (which is how a supervising tool
// hands one over), then the default. Two people serving this at once is normal.
const port =
  portFlag === -1 ? Number(process.env.PORT ?? 8099) : Number(args[portFlag + 1]);

/**
 * `CALLPOOL_PUBLIC=1` narrows this server to the three trees the live edge
 * serves. Off by default: locally, serving the repository is the point.
 */
const publicMode = process.env.CALLPOOL_PUBLIC === '1';

/**
 * The RPC proxy's shared state.
 *
 * Same origin as the page, so the browser needs no CORS and neither key ever
 * leaves this process. A route whose variable is unset answers 503 with a plain
 * reason rather than 404 — a missing route and a missing configuration look
 * identical from the page, and only one of them is fixable by the person
 * reading the log. A production host is expected to leave the devnet one unset.
 */
const trustProxy = process.env.CALLPOOL_TRUST_PROXY === '1';

/**
 * The bucket, overridable — because the default is not always right.
 *
 * 60 tokens assumes "the heaviest thing a visitor can do sits around 10",
 * which is true of the dashboard and **not** of the wallet panel: that one
 * fetches a transaction per signature across the whole lockout window, so a
 * wallet with a busy week can want hundreds of calls in one click and 429
 * itself against our own proxy. Measured 2026-08-08 against a rehearsal
 * wallet, where it also surfaced as a *different* error — the partial history
 * that comes back fails the timeline's ordering check, so the page reports
 * "events are not ordered oldest-first" rather than "rate limited".
 *
 * Defaults are unchanged, so nothing moves unless a host asks. Raise it where
 * one client legitimately makes many calls — a tunnelled dev host, or a
 * mainnet box once real wallets are hitting it.
 */
const rateNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
};
const limiter = createRateLimiter({
  capacity: rateNumber('CALLPOOL_RPC_RATE_CAPACITY', 60),
  refillPerSecond: rateNumber('CALLPOOL_RPC_RATE_REFILL', 1),
});
// Buckets that have refilled are dropped, so a busy day cannot grow the map
// without bound. `unref` so this timer never holds the process open.
setInterval(() => limiter.sweep(), 60_000).unref();

const server = createServer(async (req, res) => {
  const route = (req.url ?? '/').split('?')[0];

  // One route per cluster so each can hold its own provider key. Unknown
  // `/rpc/...` paths are not routes and fall through to the 404 below.
  const rpc = resolveUpstream(route);
  if (rpc) {
    await handleRpc(req, res, {
      upstream: rpc.upstream,
      cluster: rpc.cluster,
      // One limiter across both routes, keyed on the client: alternating
      // between them must not buy anyone a second budget.
      limiter,
      trustProxy,
      log: (line) => console.warn(line),
    });
    return;
  }

  // The callout relay (see lib/callout-proxy.mjs for why a browser cannot ask
  // pump.fun itself). Behind the same limiter as /rpc: alternating routes must
  // not buy anyone a second budget.
  if (route.startsWith(`${CALLOUT_PROXY_PREFIX}/`)) {
    if (!limiter.take(clientKey(req, { trustProxy })).allowed) {
      res.writeHead(429, { 'content-type': 'text/plain' }).end('rate limited\n');
      return;
    }
    await handleCalloutProxy(req, res, { log: (line) => console.warn(line) });
    return;
  }

  // `/` redirects rather than serving the page in place: the page's assets are
  // root-absolute under /site/, and a production host does the same rewrite.
  if (route === '/') {
    res.writeHead(302, { location: '/site/' }).end();
    return;
  }

  const path = resolvePath(req.url ?? '/', { publicMode });
  if (path == null) {
    // In public mode a refusal is a 404, not a 403: "you may not have this"
    // confirms it exists, and the live edge answers 404 for the same paths.
    if (publicMode) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${req.url}\n`);
    } else {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('outside the repository\n');
    }
    return;
  }

  try {
    const info = await stat(path);
    // A directory request is an epoch directory link; serve its index if there
    // is one, otherwise say plainly that there is no listing.
    const target = info.isDirectory() ? join(path, 'index.html') : path;
    await stat(target);

    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${req.url}\n`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${REPO_ROOT}`);
  console.log(`  http://127.0.0.1:${port}/   → site/index.html`);
  for (const [route, variable] of [
    ['/rpc', 'CALLPOOL_RPC_URL_MAINNET'],
    ['/rpc/devnet', 'CALLPOOL_RPC_URL_DEVNET'],
  ]) {
    const { upstream } = resolveUpstream(route);
    console.log(
      upstream
        ? `  ${route.padEnd(11)} → ${new URL(upstream).origin}   (key held here, never sent to the page)`
        : `  ${route.padEnd(11)} → not configured. Set ${variable}.`,
    );
  }
});
