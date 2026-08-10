// The hourly poll's own bookkeeping.
//
// The callout store is append-only by design — a record that vanishes from the
// public feed must survive in ours — but the *truncation log* beside it is
// operational noise, not evidence, and it had no bound at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pollOnce, pruneTruncations, TRUNCATION_RETENTION_DAYS } from '../poll-callouts.mjs';
import { LOCKOUT_EPOCHS } from '../lib/config.mjs';
import { windowForDay } from '../lib/epoch.mjs';

const DAY = 86_400;
const NOW = windowForDay('2026-08-04').end;

test('the log keeps long enough to cover any epoch still being settled', () => {
  // A truncation matters while the epoch it happened in can still affect a
  // settlement, and the lockout reaches back LOCKOUT_EPOCHS. Two days of slack
  // on top, so nothing in flight is ever pruned.
  assert.equal(TRUNCATION_RETENTION_DAYS, LOCKOUT_EPOCHS + 2);
});

test('truncations older than the retention window are dropped', () => {
  const entries = [
    { observedAt: NOW - 30 * DAY, day: '2026-07-05', feedSize: 50 },
    { observedAt: NOW - 12 * DAY, day: '2026-07-23', feedSize: 50 },
    { observedAt: NOW - 3 * DAY, day: '2026-08-01', feedSize: 50 },
    { observedAt: NOW, day: '2026-08-04', feedSize: 50 },
  ];

  const kept = pruneTruncations(entries, NOW);
  assert.deepEqual(kept.map((e) => e.day), ['2026-08-01', '2026-08-04']);
});

test('an entry exactly on the boundary is kept, not lost to an off-by-one', () => {
  const onBoundary = { observedAt: NOW - TRUNCATION_RETENTION_DAYS * DAY, day: 'edge', feedSize: 50 };
  assert.deepEqual(pruneTruncations([onBoundary], NOW), [onBoundary]);

  const justPast = { observedAt: NOW - TRUNCATION_RETENTION_DAYS * DAY - 1, day: 'gone', feedSize: 50 };
  assert.deepEqual(pruneTruncations([justPast], NOW), []);
});

test('an empty or absent log stays empty rather than becoming undefined', () => {
  assert.deepEqual(pruneTruncations([], NOW), []);
  assert.deepEqual(pruneTruncations(undefined, NOW), []);
});

test('a poll prunes the log it inherits, and never the callouts beside it', async () => {
  const window = windowForDay('2026-08-04');
  const store = {
    mint: 'MINT',
    callouts: { 'old-callout': { id: 'old-callout', walletAddress: 'W', tokenAddress: 'MINT' } },
    truncations: [{ observedAt: NOW - 40 * DAY, day: '2026-06-25', feedSize: 50 }],
  };

  const result = await pollOnce({
    mint: 'MINT',
    window,
    store,
    apiKey: 'k',
    now: NOW,
    fetchImpl: async () => new Response(JSON.stringify({ callouts: [] }), { status: 200 }),
  });

  assert.deepEqual(result.store.truncations, [], 'the stale truncation is gone');
  assert.ok(result.store.callouts['old-callout'], 'the callout store is append-only and untouched');
});

// ── which store a poll writes ─────────────────────────────────────────────
//
// `--store` was parsed and then ignored, so every poll used the production
// store whatever it was told. MAINNET-PREP's P2 probe points it at a scratch
// file and polls a STRANGER's coin — so following the documented step wrote
// foreign callouts into the one file settlement reads, and the mint guard then
// refuses every later poll. It fires on launch day, at the step that must run
// first, before genesis.

test('--store sends the poll somewhere other than the production store', async () => {
  const { resolveStorePath } = await import('../poll-callouts.mjs');
  const { STORE_PATH } = await import('../lib/store.mjs');

  const probe = resolveStorePath('probe.json', '/tmp');
  assert.equal(probe, '/tmp/probe.json');
  assert.notEqual(probe, STORE_PATH, 'a probe must never land on the production store');
});

test('no --store still means the production store, which is what the unit wants', async () => {
  const { resolveStorePath } = await import('../poll-callouts.mjs');
  const { STORE_PATH } = await import('../lib/store.mjs');
  // deploy/mainnet/callpool-poll-callouts.service passes no --store on purpose.
  assert.equal(resolveStorePath(undefined), STORE_PATH);
  assert.equal(resolveStorePath(''), STORE_PATH);
});

test('a relative --store resolves against the working directory, not the repo root', async () => {
  const { resolveStorePath } = await import('../poll-callouts.mjs');
  assert.equal(resolveStorePath('./sub/probe.json', '/var/tmp'), '/var/tmp/sub/probe.json');
  assert.equal(resolveStorePath('/abs/probe.json', '/var/tmp'), '/abs/probe.json');
});
