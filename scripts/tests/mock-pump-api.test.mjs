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
