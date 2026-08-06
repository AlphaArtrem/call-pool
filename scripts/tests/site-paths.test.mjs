// What the dev server will and will not serve.
//
// `serve-site.mjs` serves the repository root, which is right for a dev server
// and wrong on the public internet: the root is where `.env`, `.callout-auth`,
// `.git/` and any stray signing key live. In production Caddy is the gate and
// serves an allowlist of three trees. `CALLPOOL_PUBLIC=1` applies the same list
// here, so a Caddyfile misedit cannot re-expose the repository through the
// process sitting behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';

import { PUBLIC_TREES, resolvePath } from '../lib/site-paths.mjs';
import { REPO_ROOT } from '../lib/store.mjs';

test('traversal can never reach outside the repository', () => {
  // `normalize` collapses a leading `..` on an absolute path rather than
  // preserving it, so these land *inside* the root and 404 there. The property
  // that matters is containment, not the shape of the refusal — asserting
  // `=== null` here would be asserting the wrong thing and would pass for the
  // wrong reason.
  const attempts = [
    '/../../.ssh/id_rsa',
    '/../.env',
    // Percent-encoded, because decoding happens before the containment check.
    '/%2e%2e/%2e%2e/.ssh/id_rsa',
    '/site/../../.ssh/id_rsa',
  ];

  for (const path of attempts) {
    const dev = resolvePath(path);
    assert.ok(
      dev === null || dev === REPO_ROOT || dev.startsWith(REPO_ROOT + sep),
      `${path} escaped to ${dev}`,
    );
    // And in public mode none of them is servable at all.
    assert.equal(resolvePath(path, { publicMode: true }), null, `${path} must not be served`);
  }
});

test('the dev server serves the repository, because that is what it is for', () => {
  assert.equal(resolvePath('/README.md'), resolve(REPO_ROOT, 'README.md'));
  assert.equal(resolvePath('/site/app.css'), resolve(REPO_ROOT, 'site/app.css'));
});

test('public mode serves exactly the three trees the live edge serves', () => {
  assert.deepEqual([...PUBLIC_TREES], ['site', `scripts${sep}lib`, 'snapshots']);

  assert.equal(resolvePath('/site/app.css', { publicMode: true }), resolve(REPO_ROOT, 'site/app.css'));
  assert.equal(
    resolvePath('/scripts/lib/carry.mjs', { publicMode: true }),
    resolve(REPO_ROOT, 'scripts/lib/carry.mjs'),
  );
  assert.equal(
    resolvePath('/snapshots/epoch-3/tree.json', { publicMode: true }),
    resolve(REPO_ROOT, 'snapshots/epoch-3/tree.json'),
  );
});

test('public mode refuses everything the repository root would otherwise leak', () => {
  for (const path of [
    '/.env',
    '/.callout-auth',
    '/.git/config',
    '/.secrets/hostinger/id_ed25519',
    '/package.json',
    '/README.md',
    '/docs/DECISIONS-LOCKED.md',
    '/scripts/crank.mjs', // the crank itself is not in the published tree
    '/target/deploy/callpool.so',
  ]) {
    assert.equal(resolvePath(path, { publicMode: true }), null, `${path} must not be served`);
  }
});

test('a tree name is a directory, not a prefix', () => {
  // `/site-backup/` must not ride in on `site`.
  assert.equal(resolvePath('/site-backup/secrets.txt', { publicMode: true }), null);
  assert.equal(resolvePath('/snapshots-old/epoch-1/tree.json', { publicMode: true }), null);
});

test('the site index rewrite still works in public mode', () => {
  assert.equal(resolvePath('/site/', { publicMode: true }), resolve(REPO_ROOT, 'site/index.html'));
});
