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
import { extname, join, normalize, resolve, sep } from 'node:path';

import { REPO_ROOT } from './lib/store.mjs';
import { createRateLimiter, handleRpc, resolveUpstream } from './lib/rpc-proxy.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
// `--port`, then `PORT` from the environment (which is how a supervising tool
// hands one over), then the default. Two people serving this at once is normal.
const port =
  portFlag === -1 ? Number(process.env.PORT ?? 8099) : Number(args[portFlag + 1]);

/**
 * Resolve a request path to a file inside the repository, or null.
 *
 * The containment check is the only security-relevant line here: without it,
 * `GET /../../.ssh/id_rsa` is served. `normalize` collapses the traversal and
 * the prefix test rejects anything that still lands outside.
 */
function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/site/' ? '/site/index.html' : decoded;
  const full = resolve(REPO_ROOT, `.${normalize(requested)}`);
  return full === REPO_ROOT || full.startsWith(REPO_ROOT + sep) ? full : null;
}

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
const limiter = createRateLimiter();
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

  // `/` redirects rather than serving the page in place: the page's assets are
  // root-absolute under /site/, and a production host does the same rewrite.
  if (route === '/') {
    res.writeHead(302, { location: '/site/' }).end();
    return;
  }

  const path = resolvePath(req.url ?? '/');
  if (path == null) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('outside the repository\n');
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
