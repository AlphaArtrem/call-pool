// The relay must forward exactly one path shape — anything looser is an open
// forwarder to pump.fun wearing our origin.

import assert from 'node:assert/strict';
import test from 'node:test';

import { calloutUpstreamUrl, CALLOUT_UPSTREAM_ORIGIN } from '../lib/callout-proxy.mjs';

const WALLET = 'CQWhotHc9uuYw2yEiQUdXNp7MJpXcQsmdw47tBkiJHP';

test('the by-wallet listing is forwarded, limit and all', () => {
  assert.equal(
    calloutUpstreamUrl(`/callouts/api/v1/users/by-wallet/${WALLET}/callouts?limit=100`),
    `${CALLOUT_UPSTREAM_ORIGIN}/api/v1/users/by-wallet/${WALLET}/callouts?limit=100`,
  );
  // No limit is fine; the upstream default applies.
  assert.equal(
    calloutUpstreamUrl(`/callouts/api/v1/users/by-wallet/${WALLET}/callouts`),
    `${CALLOUT_UPSTREAM_ORIGIN}/api/v1/users/by-wallet/${WALLET}/callouts`,
  );
});

test('everything else is refused, including near misses', () => {
  for (const url of [
    '/callouts/api/v1/coins/whatever', // a different API surface
    `/callouts/api/v1/users/by-wallet/${WALLET}`, // missing the /callouts tail
    `/callouts/api/v1/users/by-wallet/not-base58!/callouts`, // junk address
    `/callouts/api/v1/users/by-wallet/${WALLET}/callouts/extra`, // trailing path
    '/callouts/', // bare prefix
    '/rpc', // not our prefix at all
    `/callouts/api/v1/users/by-wallet/${WALLET}/callouts/../../../admin`, // traversal
  ]) {
    assert.equal(calloutUpstreamUrl(url), null, url);
  }
});

test('foreign query parameters are dropped, not forwarded', () => {
  assert.equal(
    calloutUpstreamUrl(`/callouts/api/v1/users/by-wallet/${WALLET}/callouts?limit=50&admin=1`),
    `${CALLOUT_UPSTREAM_ORIGIN}/api/v1/users/by-wallet/${WALLET}/callouts?limit=50`,
  );
  // A non-numeric limit is not forwarded either.
  assert.equal(
    calloutUpstreamUrl(`/callouts/api/v1/users/by-wallet/${WALLET}/callouts?limit=DROP`),
    `${CALLOUT_UPSTREAM_ORIGIN}/api/v1/users/by-wallet/${WALLET}/callouts`,
  );
});
