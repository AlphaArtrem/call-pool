// Which files the local server is allowed to hand out.
//
// `serve-site.mjs` serves the repository root. That is correct for a dev server
// — the site imports `scripts/lib/` directly, and the whole point of the
// published snapshots is that you can read the code beside them — and it is
// wrong on the public internet, where the repository root is also `.env`,
// `.callout-auth`, `.git/` and any signing key someone left lying about.
//
// In production Caddy is the gate and serves three trees. `CALLPOOL_PUBLIC=1`
// applies the same list here. Caddy remains the documented and verified
// boundary; this exists so that a Caddyfile misedit cannot re-expose the
// repository through the process sitting behind it. Belt, and braces.

import { normalize, relative, resolve, sep } from 'node:path';

import { REPO_ROOT } from './store.mjs';

/**
 * The three trees the live edge serves, and nothing else.
 *
 * `scripts/lib/` rather than `scripts/`: the site imports from it, and §7.2's
 * verification tile tells readers to run those exact files. The crank, the
 * airdrop and the devnet tooling are not part of what a visitor needs.
 */
export const PUBLIC_TREES = Object.freeze(['site', `scripts${sep}lib`, 'snapshots']);

/**
 * Resolve a request path to a file inside the repository, or null.
 *
 * The containment check is the security-relevant line: without it,
 * `GET /../../.ssh/id_rsa` is served. `normalize` collapses the traversal and
 * the prefix test rejects anything that still lands outside. Decoding happens
 * first, so a percent-encoded traversal is caught by the same check.
 *
 * @param {string} urlPath
 * @param {object} [options]
 * @param {boolean} [options.publicMode]  apply the live edge's allowlist
 */
export function resolvePath(urlPath, { publicMode = false } = {}) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/site/' ? '/site/index.html' : decoded;
  const full = resolve(REPO_ROOT, `.${normalize(requested)}`);

  const inside = full === REPO_ROOT || full.startsWith(REPO_ROOT + sep);
  if (!inside) return null;
  if (!publicMode) return full;

  // A tree is a directory, not a string prefix: `site-backup/` must not ride in
  // on `site`.
  const rel = relative(REPO_ROOT, full);
  const allowed = PUBLIC_TREES.some((tree) => rel === tree || rel.startsWith(tree + sep));
  return allowed ? full : null;
}
