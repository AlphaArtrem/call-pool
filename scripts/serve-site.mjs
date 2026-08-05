// A static file server for local development. Not for production.
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
// Deliberately not a dependency and deliberately not clever: no directory
// listings, no caching, no HTTPS, and it refuses any path that escapes the
// repository.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { REPO_ROOT } from './lib/store.mjs';

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

const server = createServer(async (req, res) => {
  // `/` redirects rather than serving the page in place: the page's assets are
  // root-absolute under /site/, and a production host does the same rewrite.
  if ((req.url ?? '/').split('?')[0] === '/') {
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
});
