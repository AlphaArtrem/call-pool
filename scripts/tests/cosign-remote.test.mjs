// The remote co-signer's fetching — which epoch it goes after, and what it
// refuses to proceed on.
//
// The decisions worth pinning are the boring ones. Picking the *newest*
// unsettled epoch would leave the oldest one's challenge window open forever;
// treating a 404 as "no such file, carry on" would let a signer reproduce an
// epoch from half its inputs and call that agreement.
//
// Nothing here touches a network or a chain: `hasRoot` and `fetch` are both
// arguments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.env.CALLPOOL_SNAPSHOTS_DIR = mkdtempSync(resolve(tmpdir(), 'callpool-remote-'));

const { epochAt, fileUrl, fetchEpochInputs, outstandingEpoch } = await import('../tools/cosign-remote.mjs');

const CONFIG = { genesisTs: 1_000, epochSeconds: 300 };

test('the epoch index is derived from the genesis and the clock', () => {
  assert.equal(epochAt(1_000, CONFIG), 0);
  assert.equal(epochAt(1_299, CONFIG), 0);
  assert.equal(epochAt(1_300, CONFIG), 1);
  assert.equal(epochAt(4_000, CONFIG), 10);
});

test('the oldest unsettled epoch is chosen, not the newest', () => {
  // 40 and 43 are both outstanding. 40's challenge window has been open
  // longer, so it is the one that needs a signature.
  const settled = new Set([41, 42]);
  const hasRoot = async (e) => settled.has(e) || e < 40;

  return outstandingEpoch({ current: 45, lookback: 30, hasRoot }).then((epoch) => {
    assert.equal(epoch, 40);
  });
});

test('a fully settled window reports nothing outstanding', async () => {
  assert.equal(await outstandingEpoch({ current: 10, lookback: 30, hasRoot: async () => true }), null);
});

test('the current epoch is never chosen — it has not closed', async () => {
  // Only epoch 9 lacks a root, and 9 is `current`. Proposing a root for an
  // epoch still open is something the program rejects anyway.
  const hasRoot = async (e) => e < 9;
  assert.equal(await outstandingEpoch({ current: 9, lookback: 30, hasRoot }), null);
});

test('the lookback bounds how far back it will reach', async () => {
  const hasRoot = async (e) => e !== 2;
  assert.equal(await outstandingEpoch({ current: 50, lookback: 5, hasRoot }), null, 'epoch 2 is out of range');
  assert.equal(await outstandingEpoch({ current: 50, lookback: 60, hasRoot }), 2);
});

test('urls join without doubling the slash', () => {
  assert.equal(fileUrl('http://h:8100', 7, 'tree.json'), 'http://h:8100/epoch-7/tree.json');
  assert.equal(fileUrl('http://h:8100/', 7, 'tree.json'), 'http://h:8100/epoch-7/tree.json');
  assert.equal(fileUrl('http://h:8100///', 7, 'root.txt'), 'http://h:8100/epoch-7/root.txt');
});

// ── fetching ───────────────────────────────────────────────────────────────

const ok = (body) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) });
const missing = { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };

test('every input file is fetched, plus the previous epoch\'s carry ledger', async () => {
  const asked = [];
  const written = [];
  await fetchEpochInputs({
    base: 'http://h:8100',
    epoch: 5,
    fetchFn: async (url) => {
      asked.push(url);
      return ok('{}');
    },
    write: (path) => written.push(path),
  });

  assert.ok(asked.includes('http://h:8100/epoch-5/tree.json'));
  assert.ok(asked.includes('http://h:8100/epoch-5/root.txt'));
  assert.ok(asked.includes('http://h:8100/epoch-5/balances.json'));
  assert.ok(
    asked.includes('http://h:8100/epoch-4/carry.json'),
    'without the predecessor ledger, a restarted carry chain looks like a genesis epoch',
  );
  assert.equal(written.length, 7, 'six inputs, plus the predecessor carry');
});

test('a missing input is fatal — half an epoch is not something to agree with', async () => {
  await assert.rejects(
    () =>
      fetchEpochInputs({
        base: 'http://h:8100',
        epoch: 5,
        fetchFn: async (url) => (url.endsWith('pool.json') ? missing : ok('{}')),
        write: () => {},
      }),
    /pool\.json returned 404/,
  );
});

test('a missing predecessor ledger is not fatal — genesis has none', async () => {
  const written = [];
  await fetchEpochInputs({
    base: 'http://h:8100',
    epoch: 5,
    fetchFn: async (url) => (url.includes('epoch-4') ? missing : ok('{}')),
    write: (path) => written.push(path),
  });
  assert.equal(written.length, 6, 'the epoch itself still landed');
});

test('epoch 0 does not go looking for a predecessor', async () => {
  const asked = [];
  await fetchEpochInputs({
    base: 'http://h:8100',
    epoch: 0,
    fetchFn: async (url) => {
      asked.push(url);
      return ok('{}');
    },
    write: () => {},
  });
  assert.ok(!asked.some((url) => url.includes('epoch--1')));
});
