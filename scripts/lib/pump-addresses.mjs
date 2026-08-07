// pump.fun addresses we need to *recognise*, derived with web3.js alone.
//
// These duplicate three functions from `@pump-fun/pump-swap-sdk`, and that is
// deliberate rather than lazy. Every consumer here is somewhere the SDK must
// not go:
//
//   * **the browser.** `site/js/` computes a holder's standing from the same
//     code the crank does, so a wallet's own machine and the settlement job
//     cannot disagree. The SDK does not load in a browser.
//   * **the co-signer.** `verify-epoch.mjs` must stay runnable by a stranger
//     with `@solana/web3.js` and nothing else — that is the whole audit claim
//     (Phase 05 §5.3) — and it must not have anchor resident beside a key.
//
// A PDA derivation is seeds and a program id. Both are published, both are
// immutable, and getting one wrong produces an address that matches nothing,
// which fails safe: an unrecognised pool means a lockout applies where it might
// not have. `scripts/tests/pump-addresses.test.mjs` pins these against the
// SDK's own output so the copy cannot drift silently.

import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** Wrapped SOL — the quote side of every canonical pump pool. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** The canonical pool is index 0. Others exist and are not this coin's pool. */
const CANONICAL_POOL_INDEX = 0;

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** `pool-authority` — pump's own authority over the coin's canonical AMM pool. */
export function pumpPoolAuthority(mint) {
  return pda([Buffer.from('pool-authority'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM_ID);
}

/**
 * The coin's canonical pump AMM pool — the one it graduates into.
 *
 * Index is a **little-endian u16**, which is the one part of this easy to get
 * wrong and impossible to notice: a wrong index derives a valid-looking address
 * for a pool that does not exist.
 */
export function canonicalPumpPool(mint, quoteMint = NATIVE_MINT) {
  const index = Buffer.alloc(2);
  index.writeUInt16LE(CANONICAL_POOL_INDEX);
  return pda(
    [
      Buffer.from('pool'),
      index,
      pumpPoolAuthority(mint).toBuffer(),
      new PublicKey(mint).toBuffer(),
      new PublicKey(quoteMint).toBuffer(),
    ],
    PUMP_AMM_PROGRAM_ID,
  );
}

/**
 * The pool's LP mint — **the thing that tells a deposit from a sale.**
 *
 * This is the address L16 turns on. Selling and supplying liquidity send the
 * coin to the *same place*, so the destination cannot distinguish them; what
 * distinguishes them is that a deposit mints LP tokens back to the depositor
 * and a sale does not. See `isLpDeposit` in timeline.mjs.
 */
export function lpMint(mint, quoteMint = NATIVE_MINT) {
  return pda(
    [Buffer.from('pool_lp_mint'), canonicalPumpPool(mint, quoteMint).toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
}

/** The bonding curve, where the coin trades before it graduates. */
export function bondingCurve(mint) {
  return pda([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM_ID);
}
