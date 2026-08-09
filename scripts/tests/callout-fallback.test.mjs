// The truncation fallback, and the two API behaviours that make it dangerous.
//
// Measured against the live API on 2026-08-09, on real mainnet coins:
//
//   * The per-mint feed is a hard 50 with **no** pagination — 43 parameter
//     variants returned the byte-identical page, and pump's own generated
//     client has no cursor for that route either. Four of five real coins were
//     already at the cap, so the fallback is the normal path.
//   * `users/{id}/callouts/by-mint/{mint}` answers exactly, per user, with no
//     feed to truncate. That is what the fallback now uses.
//
// The two traps this file pins down, because both fail *silently*:
//
//   * a userId that does not exist returns `200 {"callout": null}` — identical
//     to an honest "never called out";
//   * `by-wallet` answers 404 for a malformed address exactly as it does for a
//     real address with no pump account.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE58_ADDRESS,
  CalloutError,
  collectByWallet,
  fetchWalletCallouts,
  resolveUserId,
  WALLET_FEED_CAP,
} from '../lib/callouts.mjs';
import { windowForDay } from '../lib/epoch.mjs';

const MINT = 'CaLLPooLMintAddress1111111111111111111111111';
const ALICE = 'A1iceWa11etAddress11111111111111111111111111';
const BOB = 'BobWa11etAddress1111111111111111111111111111';
const WINDOW = windowForDay('2026-08-04');

const record = (id, wallet, offsetSeconds, mint = MINT) => ({
  id,
  walletAddress: wallet,
  tokenAddress: mint,
  createdAt: new Date((WINDOW.start + offsetSeconds) * 1000).toISOString(),
  isSpam: false,
  isHarmful: false,
  deletedAt: null,
});

/**
 * A stand-in for the three routes the fallback walks, driven by a fixture of
 * `{wallet: {userId, callout}}`. Records the paths it was asked for.
 */
function stubApi(users, { records = {}, updates = {} } = {}) {
  const paths = [];
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });

  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);

    let m;
    if ((m = /^\/api\/v1\/users\/by-wallet\/([^/]+)$/.exec(path))) {
      const user = users[m[1]];
      return user
        ? reply(200, { userId: user.userId })
        : reply(404, { message: 'No user linked to this wallet' });
    }
    if ((m = /^\/api\/v1\/users\/([^/]+)\/callouts\/by-mint\/([^/]+)$/.exec(path))) {
      const user = Object.values(users).find((u) => u.userId === m[1]);
      // A userId nobody owns returns 200 + null, exactly as the live API does.
      return reply(200, {
        callout: user?.callout ? { calloutId: user.callout } : null,
        updates: [],
        updateCount: 0,
      });
    }
    if ((m = /^\/api\/v1\/communities\/([^/]+)\/callouts\/([^/]+)\/replies\/public$/.exec(path))) {
      return reply(200, { replies: updates[m[2]] ?? [] });
    }
    if ((m = /^\/api\/v1\/communities\/([^/]+)\/callouts\/([^/]+)\/public$/.exec(path))) {
      return reply(200, { callout: records[m[2]] });
    }
    return reply(404, { error: 'not found' });
  };

  return { fetchImpl, paths };
}

test('a holder with no pump account is a complete answer, not an error', async () => {
  // The common case: the candidate list comes from chain, and most holders have
  // never touched pump's social product.
  const { fetchImpl } = stubApi({});

  const { records, incomplete } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records, []);
  assert.deepEqual(incomplete, []);
});

test('a caller is resolved to the full canonical record, flags and all', async () => {
  const full = record('callout-1', ALICE, 60);
  const { fetchImpl, paths } = stubApi(
    { [ALICE]: { userId: 'user-a', callout: 'callout-1' } },
    { records: { 'callout-1': full } },
  );

  const { records } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  // The by-mint route's own record omits walletAddress and the moderation
  // flags, so the id is resolved to the public record rather than normalised.
  assert.deepEqual(records, [full]);
  assert.equal(records[0].walletAddress, ALICE);
  assert.equal(records[0].isSpam, false);

  assert.deepEqual(paths, [
    `/api/v1/users/by-wallet/${ALICE}`,
    '/api/v1/users/user-a/callouts/by-mint/' + MINT,
    `/api/v1/communities/${MINT}/callouts/callout-1/public`,
    // L2: the caller's own updates are activity too, so they are always asked
    // for once a callout is known to exist.
    `/api/v1/communities/${MINT}/callouts/callout-1/replies/public`,
  ]);
});

test('a wallet that never called this coin costs two requests and no third', async () => {
  const { fetchImpl, paths } = stubApi({ [ALICE]: { userId: 'user-a', callout: null } });

  const { records } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records, []);
  assert.equal(paths.length, 2, 'the record fetch must not run when there is no callout');
});

test('a callout outside the window does not earn it', async () => {
  // A callout persists across epochs; only the ones made inside this window count.
  const stale = record('callout-old', ALICE, -60);
  const { fetchImpl } = stubApi(
    { [ALICE]: { userId: 'user-a', callout: 'callout-old' } },
    { records: { 'callout-old': stale } },
  );

  const { records } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records, []);
});

test('L2: an older callout UPDATED inside the window earns it', async () => {
  // The whole point of L2. The callout predates the window, so on its own it
  // earns nothing — but the caller posted an update inside the window, and that
  // is activity. Recovering only the callout would silently drop this caller.
  const stale = record('callout-old', ALICE, -86_400);
  const update = record('update-in', ALICE, 120);
  const { fetchImpl } = stubApi(
    { [ALICE]: { userId: 'user-a', callout: 'callout-old' } },
    { records: { 'callout-old': stale }, updates: { 'callout-old': [update] } },
  );

  const { records } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records.map((r) => r.id), ['update-in']);
  // Tagged with its parent, exactly as the hourly poll tags it, so a verifier
  // can follow the same path.
  assert.equal(records[0].parentCalloutId, 'callout-old');
  assert.equal(records[0].isUpdate, true);
});

test('updates outside the window are not counted either', async () => {
  const inWindow = record('callout-in', ALICE, 60);
  const late = record('update-late', ALICE, 86_400 + 500);
  const { fetchImpl } = stubApi(
    { [ALICE]: { userId: 'user-a', callout: 'callout-in' } },
    { records: { 'callout-in': inWindow }, updates: { 'callout-in': [late] } },
  );

  const { records } = await collectByWallet([ALICE], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records.map((r) => r.id), ['callout-in']);
});

test('one candidate resolving to nothing does not discard the others', async () => {
  const bobs = record('callout-b', BOB, 120);
  const { fetchImpl } = stubApi(
    { [ALICE]: { userId: 'user-a', callout: null }, [BOB]: { userId: 'user-b', callout: 'callout-b' } },
    { records: { 'callout-b': bobs } },
  );

  const { records } = await collectByWallet([ALICE, BOB], MINT, WINDOW, {
    apiKey: 'cc_test',
    fetchImpl,
  });

  assert.deepEqual(records.map((r) => r.id), ['callout-b']);
});

test('a malformed address is refused rather than read as "did not call out"', async () => {
  // by-wallet returns the same 404 for a typo as for a real wallet with no
  // account, so without this check a bad candidate list silently underpays.
  const { fetchImpl, paths } = stubApi({});

  await assert.rejects(
    () => resolveUserId('not-an-address', { apiKey: 'cc_test', fetchImpl }),
    (error) => error instanceof CalloutError && /not a Solana address/.test(error.message),
  );
  assert.deepEqual(paths, [], 'it must not even ask');
});

test('the address shape accepts real addresses and rejects the near-misses', () => {
  assert.ok(BASE58_ADDRESS.test(ALICE));
  assert.ok(BASE58_ADDRESS.test('11111111111111111111111111111111'));
  assert.ok(!BASE58_ADDRESS.test(''));
  assert.ok(!BASE58_ADDRESS.test('short'));
  assert.ok(!BASE58_ADDRESS.test(`${ALICE}0OIl`), 'base58 excludes 0, O, I and l');
});

test('a non-404 failure throws rather than reading as no callout', async () => {
  // "We could not ask" must never become "they did not call out" — a 500 from
  // pump during settlement would otherwise pay nobody and look like a clean run.
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await assert.rejects(
    () => collectByWallet([ALICE], MINT, WINDOW, { apiKey: 'cc_test', fetchImpl }),
    (error) => error instanceof CalloutError && /500/.test(error.message),
  );
});

test('the legacy history route still asks for its ceiling, not the default 50', async () => {
  // No longer on the fallback path, but still exported and still served by the
  // devnet mock. Without the limit the API answers 50 and silently halves it.
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url);
    return { ok: true, status: 200, json: async () => ({ callouts: [] }) };
  };

  await fetchWalletCallouts(ALICE, { apiKey: 'cc_test', fetchImpl });

  assert.match(paths[0], new RegExp(`limit=${WALLET_FEED_CAP}$`));
});
