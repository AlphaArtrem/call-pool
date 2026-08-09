// The mock pump.fun endpoint — what it answers, and what it must never serve.
//
// It exists so L5's truncation fallback can be observed on devnet at all: the
// real API only knows mainnet coins, so `collectByWallet` came back empty and a
// truncated epoch settled with nobody in it — indistinguishable from a clean
// run with no callers.
//
// The rule worth pinning is that this mocks the TRANSPORT and not the decision.
// If it filtered by window, the mock and the settlement would each hold their
// own copy of the rule and the rehearsal would be proving the mock.

import test from 'node:test';
import assert from 'node:assert/strict';

const { calloutsForWallet } = await import('../tools/mock-pump-api.mjs');

const record = (id, wallet, iso) => ({
  id, walletAddress: wallet, tokenAddress: 'MintA', createdAt: iso,
  isSpam: false, isHarmful: false, deletedAt: null,
});

const store = {
  callouts: {
    a: record('a', 'Alice', '2026-08-08T10:00:00.000Z'),
    b: record('b', 'Bob', '2026-08-08T11:00:00.000Z'),
    c: record('c', 'Alice', '2026-08-08T12:00:00.000Z'),
    d: record('d', 'Alice', '2020-01-01T00:00:00.000Z'),
  },
};

test('a wallet gets its own records and nobody else\'s', () => {
  assert.deepEqual(calloutsForWallet(store, 'Alice').map((r) => r.id), ['c', 'a', 'd']);
  assert.deepEqual(calloutsForWallet(store, 'Bob').map((r) => r.id), ['b']);
});

test('newest first, the way pump returns a history', () => {
  const times = calloutsForWallet(store, 'Alice').map((r) => Date.parse(r.createdAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times);
});

test('records outside any window are still returned — the caller filters', () => {
  // 2020 is far outside every rehearsal window. Dropping it here would move the
  // window rule into the mock, where the settlement could not disagree with it.
  assert.ok(calloutsForWallet(store, 'Alice').some((r) => r.createdAt.startsWith('2020')));
});

test('an unknown wallet gets an empty list, not an error', () => {
  assert.deepEqual(calloutsForWallet(store, 'Nobody'), []);
});

test('an empty or malformed store is empty, not a crash', () => {
  assert.deepEqual(calloutsForWallet({}, 'Alice'), []);
  assert.deepEqual(calloutsForWallet({ callouts: {} }, 'Alice'), []);
});

// ── the real fallback through the real router ───────────────────────────────
//
// The routes used to be tested only by a stub inside callout-fallback.test.mjs,
// which modelled them independently — and the stub proved the stub. Two gaps
// shipped green that way on 2026-08-09: BY_ID demanded a UUID while the
// rehearsal's own ids look like `mock-3-w07`, and `/replies/public` (fetched
// for EVERY recovered caller) was not served at all. Either one killed the
// devnet fallback on its first truncated epoch. These tests route the
// settlement's own requests through `respond`, so the mock and the fallback
// cannot drift apart unseen again.

const { respond } = await import('../tools/mock-pump-api.mjs');
const { collectByWallet } = await import('../lib/callouts.mjs');
const { Keypair } = await import('@solana/web3.js');

const wallet = () => Keypair.generate().publicKey.toBase58();

const fetchVia = (s) => async (url) => {
  const { status, body } = respond(s, new URL(url).pathname);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('collectByWallet recovers a caller through the mock, mock-style id and all', async () => {
  const mint = wallet();
  const caller = wallet();
  const silent = wallet();
  const window = { start: 1_700_000_000, end: 1_700_000_600 };
  const s = {
    callouts: {
      'mock-0-w01': {
        id: 'mock-0-w01', walletAddress: caller, tokenAddress: mint,
        createdAt: new Date((window.start + 60) * 1000).toISOString(),
        isSpam: false, isHarmful: false, deletedAt: null,
      },
    },
  };

  const { records, incomplete } = await collectByWallet([caller, silent], mint, window, {
    apiKey: 'rehearsal-key', baseUrl: 'http://mock', fetchImpl: fetchVia(s),
  });

  assert.deepEqual(records.map((r) => r.id), ['mock-0-w01']);
  assert.deepEqual(incomplete, []);
});

test('an update inside the window is recovered even when its callout is not (L2)', async () => {
  const mint = wallet();
  const caller = wallet();
  const window = { start: 1_700_000_000, end: 1_700_000_600 };
  const s = {
    callouts: {
      'mock-0-w02': {
        id: 'mock-0-w02', walletAddress: caller, tokenAddress: mint,
        createdAt: new Date((window.start - 3_600) * 1000).toISOString(),
        isSpam: false, isHarmful: false, deletedAt: null,
      },
      'mock-0-w02-up': {
        id: 'mock-0-w02-up', walletAddress: caller, tokenAddress: mint,
        parentCalloutId: 'mock-0-w02',
        createdAt: new Date((window.start + 120) * 1000).toISOString(),
        isSpam: false, isHarmful: false, deletedAt: null,
      },
    },
  };

  const { records } = await collectByWallet([caller], mint, window, {
    apiKey: 'rehearsal-key', baseUrl: 'http://mock', fetchImpl: fetchVia(s),
  });

  assert.deepEqual(records.map((r) => r.id), ['mock-0-w02-up']);
});

test('the replies route 404s for a callout the store does not hold', () => {
  const { status } = respond({ callouts: {} }, `/api/v1/communities/${wallet()}/callouts/mock-9-x/replies/public`);
  assert.equal(status, 404);
});
