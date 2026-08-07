// The main tree's pump PDA derivations, checked against pump's own SDK.
//
// `scripts/lib/pump-addresses.mjs` re-implements three of pump's derivations
// with `@solana/web3.js` alone, because the SDK cannot go where they are needed
// — a browser, and the repository that signs with the snapshot key. The risk of
// a re-implementation is that it drifts and derives a plausible address for the
// wrong thing.
//
// **This test lives here rather than in `scripts/tests/` for the same reason
// the sweep does.** It is the one thing in the project that legitimately needs
// pump's SDK as an oracle, and putting it in the main suite would have put the
// SDK back in the root lockfile through the back door — which is exactly the
// constraint the split exists to hold.
//
// So: run it from here, and let `verify.sh` insist that it ran before a
// deployment build.
//
//   cd tools/sweep && npm ci && npm test
//
// A wrong LP mint fails **safe** — an unrecognised deposit is treated as a
// sale, so L18's lockout applies where it might not have. That is the right
// direction for a mistake to point, and not a reason to skip the test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// From `scripts/lib/`, so its own `@solana/web3.js` resolves to the repository
// root's pinned copy — not this package's nested one. Every assertion below
// compares base58 **strings**, so the two copies never have to interoperate.
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  bondingCurve,
  canonicalPumpPool,
  lpMint,
  pumpPoolAuthority,
} from '../../../scripts/lib/pump-addresses.mjs';

const require_ = createRequire(import.meta.url);
const pump = require_('@pump-fun/pump-sdk');
const swap = require_('@pump-fun/pump-swap-sdk');
const { PublicKey } = require_('@solana/web3.js');

// Several mints, because a single example can agree by luck on a seed whose
// encoding is wrong — the little-endian u16 pool index especially.
const MINTS = [
  'CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK',
  '9uAzrjSJBBYKwzQdHBSWrcdEVfwA6MbNjT1DbsT7TFFf',
  'So11111111111111111111111111111111111111112',
  '11111111111111111111111111111111',
].map((m) => new PublicKey(m));

test('the program ids are the ones the SDK uses', () => {
  assert.equal(PUMP_PROGRAM_ID.toBase58(), pump.PUMP_PROGRAM_ID.toBase58());
  assert.equal(PUMP_AMM_PROGRAM_ID.toBase58(), swap.PUMP_AMM_PROGRAM_ID.toBase58());
});

test('the pool authority matches, for every mint', () => {
  for (const mint of MINTS) {
    assert.equal(
      pumpPoolAuthority(mint.toBase58()).toBase58(),
      swap.pumpPoolAuthorityPda(mint).toBase58(),
      `pool authority diverged for ${mint.toBase58()}`,
    );
  }
});

test('the canonical pool matches, for every mint', () => {
  for (const mint of MINTS) {
    assert.equal(
      canonicalPumpPool(mint.toBase58()).toBase58(),
      swap.canonicalPumpPoolPda(mint).toBase58(),
      `canonical pool diverged for ${mint.toBase58()}`,
    );
  }
});

test('the LP mint matches — this is the address L18 turns on', () => {
  for (const mint of MINTS) {
    assert.equal(
      lpMint(mint.toBase58()).toBase58(),
      swap.lpMintPda(swap.canonicalPumpPoolPda(mint)).toBase58(),
      `LP mint diverged for ${mint.toBase58()}`,
    );
  }
});

test('the bonding curve matches, for every mint', () => {
  for (const mint of MINTS) {
    assert.equal(
      bondingCurve(mint.toBase58()).toBase58(),
      pump.bondingCurvePda(mint).toBase58(),
      `bonding curve diverged for ${mint.toBase58()}`,
    );
  }
});
