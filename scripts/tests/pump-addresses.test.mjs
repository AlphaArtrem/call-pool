// Our web3.js-only copies of pump's PDA derivations.
//
// The copies exist because pump's SDK cannot go where they are needed: a
// browser, and this repository, whose lockfile pins the scripts that sign with
// the snapshot key.
//
// ⚠️ **The check that these derive the RIGHT addresses is not here.** It needs
// pump's SDK as an oracle, and importing that from the main suite would put the
// SDK back into the root lockfile through the back door — the exact constraint
// the split exists to hold. It lives in
// **`tools/sweep/tests/pump-addresses.test.mjs`**, and `verify.sh` insists it
// has run before a deployment build.
//
// What is testable without the oracle is everything structural: that the
// derivations are distinct from one another, that both argument forms agree,
// and that they are deterministic. A seed typo that collapses two derivations
// into one, or an argument form that silently derives something else, is caught
// here; a seed typo that produces a consistently *wrong* address is not, and
// that is what the oracle is for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PublicKey } from '@solana/web3.js';

import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  NATIVE_MINT,
  bondingCurve,
  canonicalPumpPool,
  lpMint,
  pumpPoolAuthority,
} from '../lib/pump-addresses.mjs';

const MINTS = [
  'CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK',
  '9uAzrjSJBBYKwzQdHBSWrcdEVfwA6MbNjT1DbsT7TFFf',
  'So11111111111111111111111111111111111111112',
  '11111111111111111111111111111111',
];

const ALL = [pumpPoolAuthority, canonicalPumpPool, lpMint, bondingCurve];

test('the program ids are the published ones, written out rather than derived', () => {
  assert.equal(PUMP_PROGRAM_ID.toBase58(), '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  assert.equal(PUMP_AMM_PROGRAM_ID.toBase58(), 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  assert.equal(NATIVE_MINT.toBase58(), 'So11111111111111111111111111111111111111112');
});

test('every derived address is distinct from every other, for every mint', () => {
  // A seed typo that collapses two derivations into one would otherwise pass
  // every equality check that happens to compare a value with itself.
  for (const mint of MINTS) {
    const derived = ALL.map((fn) => fn(mint).toBase58());
    assert.equal(new Set(derived).size, derived.length, `collision for ${mint}`);
  }
});

test('different mints derive different addresses', () => {
  for (const fn of ALL) {
    const derived = MINTS.map((m) => fn(m).toBase58());
    assert.equal(new Set(derived).size, derived.length, `${fn.name} ignores its mint`);
  }
});

test('a base58 string and a PublicKey derive the same address', () => {
  // Both forms are passed in from different callers — `holds.mjs` has a string
  // off the CLI, `verify.mjs` has one out of callouts.json. An asymmetry here
  // is the same class of trap as a wrong seed, and quieter.
  for (const fn of ALL) {
    const mint = MINTS[0];
    assert.equal(fn(mint).toBase58(), fn(new PublicKey(mint)).toBase58(), fn.name);
  }
});

test('the derivations are deterministic', () => {
  for (const fn of ALL) {
    assert.equal(fn(MINTS[0]).toBase58(), fn(MINTS[0]).toBase58());
  }
});

test('the LP mint depends on the quote mint, and defaults to wrapped SOL', () => {
  // The canonical pool is quoted in wSOL. If the default ever changed, every
  // L18 exemption would silently stop matching — a deposit would look like a
  // sale, which fails safe but wrongly.
  const mint = MINTS[0];
  assert.equal(lpMint(mint).toBase58(), lpMint(mint, NATIVE_MINT).toBase58());
  assert.notEqual(lpMint(mint).toBase58(), lpMint(mint, MINTS[1]).toBase58());
});
