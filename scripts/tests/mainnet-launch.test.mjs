// The launch tool's two pure rules: genesis is the NEXT boundary (F20), and
// initialize refuses to run near one. Everything else in mainnet-launch.mjs
// is chain I/O exercised by the launch itself; these two are the values that
// become permanent.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundaryGuard,
  CHALLENGE_SECONDS,
  EPOCH_SECONDS,
  genesisFor,
} from '../tools/mainnet-launch.mjs';

const DAY = 86_400;
const MIDNIGHT = 1_785_801_600; // 2026-08-04T00:00:00Z, a real UTC midnight

test('the clock constants are L19, not a rehearsal profile and not L14', () => {
  assert.equal(EPOCH_SECONDS, 86_400);
  assert.equal(CHALLENGE_SECONDS, 300);
});

test('genesis is the NEXT UTC midnight, never the one that has passed', () => {
  // Mid-afternoon: ceil to the coming midnight, not floor to the past one (F20).
  assert.equal(genesisFor(MIDNIGHT + 50_000), MIDNIGHT + DAY);
  // One second past midnight already belongs to the NEXT boundary.
  assert.equal(genesisFor(MIDNIGHT + 1), MIDNIGHT + DAY);
  // Exactly on the boundary is taken as itself — which is precisely why the
  // boundary guard exists: this value is legal and wrong.
  assert.equal(genesisFor(MIDNIGHT), MIDNIGHT);
  // Always aligned, and never in the past.
  const g = genesisFor(MIDNIGHT + 12_345);
  assert.equal(g % DAY, 0);
  assert.ok(g > MIDNIGHT + 12_345);
});

test('initialize refuses within the margin of a boundary, both sides', () => {
  // Too soon after midnight.
  assert.throws(() => boundaryGuard(MIDNIGHT + 60), /F20/);
  // Too close to the coming midnight.
  assert.throws(() => boundaryGuard(MIDNIGHT + DAY - 60), /F20/);
  // Early-to-mid epoch passes.
  boundaryGuard(MIDNIGHT + 50_000);
  boundaryGuard(MIDNIGHT + 601);
  boundaryGuard(MIDNIGHT + DAY - 601);
});
