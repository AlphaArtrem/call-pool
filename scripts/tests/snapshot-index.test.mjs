// The published epoch directory's index page.
//
// Written after every "snapshot" link in the site's audit trail was found to
// 404: the rows link to a directory, `serve-site.mjs` serves a directory only
// through its `index.html`, the production edge has no listing, and nothing
// ever wrote one. On mainnet that would have been dead from the first settled
// day, in the one section whose entire value is being checkable.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { snapshotIndexHtml, writeSnapshotIndex } from '../lib/snapshot-index.mjs';

const FILES = [
  'callouts.json', 'balances.json', 'pool.json', 'tree.json',
  'carry.json', 'payouts.csv', 'root.txt', 'build.mjs',
];

test('every file in the directory is linked', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: FILES });
  for (const f of FILES) {
    assert.ok(html.includes(`href="${f}"`), `${f} must be linked`);
  }
});

test('a file with no description is still listed — an unknown file must be visible', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: [...FILES, 'surprise.json'] });
  assert.ok(html.includes('href="surprise.json"'));
  assert.ok(html.includes('Published with this epoch.'));
});

test('index.html does not list itself', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: [...FILES, 'index.html'] });
  assert.ok(!html.includes('href="index.html"'));
});

// The bug this file exists to prevent a repeat of: with no stylesheet, a page
// that declares no colour scheme gets dark-mode chrome and light-mode text on a
// dark-mode machine — black on near-black.
test('a colour scheme is declared, because there is no stylesheet to set one', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: FILES });
  assert.match(html, /<meta name="color-scheme" content="dark light"/);
});

// Styling it would either be blocked by the live edge's `style-src 'self'` or
// break when the directory is downloaded and read offline — which is the whole
// point of publishing it.
test('no CSS is emitted: it must render identically from file:// with no network', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: FILES });
  assert.ok(!html.includes('<style'), 'an inline style block would be blocked by CSP');
  assert.ok(!html.includes('rel="stylesheet"'), 'a stylesheet link breaks an offline copy');
  assert.ok(!/<[^>]+\sstyle=/.test(html), 'no inline style attributes either');
});

test('the reproduce command is on the page — the link is an invitation to check', () => {
  const html = snapshotIndexHtml({ epoch: 12, files: FILES });
  assert.ok(html.includes('node build.mjs'));
  assert.ok(html.includes('--recheck-chain'));
});

test('the epoch number and window are stated', () => {
  const html = snapshotIndexHtml({
    epoch: 42,
    files: FILES,
    window: { start: '2026-08-05T00:00:00Z', end: '2026-08-06T00:00:00Z' },
  });
  assert.ok(html.includes('epoch 42'));
  assert.ok(html.includes('2026-08-05T00:00:00Z'));
  assert.ok(html.includes('2026-08-06T00:00:00Z'));
});

test('a missing window is simply omitted, not rendered as null', () => {
  const html = snapshotIndexHtml({ epoch: 42, files: FILES });
  assert.ok(!html.toLowerCase().includes('null'));
  assert.ok(!html.includes('undefined'));
});

test('filenames are escaped rather than injected as markup', () => {
  const html = snapshotIndexHtml({ epoch: 1, files: ['<img src=x onerror=alert(1)>.json'] });
  assert.ok(!html.includes('<img src=x'), 'must not emit raw markup from a filename');
  assert.ok(html.includes('&lt;img'));
});

test('writeSnapshotIndex lists what is actually on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-snap-'));
  try {
    writeFileSync(join(dir, 'tree.json'), '{}');
    writeFileSync(join(dir, 'root.txt'), 'root=00\n');

    writeSnapshotIndex(dir, { epoch: 7 });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');

    assert.ok(html.includes('href="tree.json"'));
    assert.ok(html.includes('href="root.txt"'));
    assert.ok(html.includes('epoch 7'));
    assert.ok(!html.includes('href="airdrop.json"'), 'must not link a file that is not there');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rewriting after airdrop.json lands picks it up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-snap-'));
  try {
    writeFileSync(join(dir, 'tree.json'), '{}');
    writeSnapshotIndex(dir, { epoch: 7 });
    assert.ok(!readFileSync(join(dir, 'index.html'), 'utf8').includes('airdrop.json'));

    writeFileSync(join(dir, 'airdrop.json'), '{}');
    writeSnapshotIndex(dir, { epoch: 7 });
    assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes('href="airdrop.json"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
