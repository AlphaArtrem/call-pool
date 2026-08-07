// Address derivation — the only part of the site that needs a dependency.
//
// Deriving a program address needs an ed25519 on-curve check, and getting an
// associated token address wrong means replaying a *different account's*
// history into a confident wrong `hold`. Hand-rolling that arithmetic to keep
// a dependency count at zero would be trading a real risk for a cosmetic one,
// so this file uses the vendored, pinned `@solana/web3.js` and every other
// module stays free of it.
//
// The vendored bundle is an IIFE (`site/vendor/solana-web3.min.js`) rather
// than an ES module, because the library's ESM build still imports bare
// specifiers and so needs a bundler — and Phase 07 §7.5 requires no build
// step. It is loaded by a plain <script> tag before this module runs.

const web3 = globalThis.solanaWeb3;

if (!web3) {
  throw new Error(
    'solanaWeb3 is not loaded — site/vendor/solana-web3.min.js must be included before js/app.js',
  );
}

export const { Connection, PublicKey } = web3;

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

const seed = (text) => new TextEncoder().encode(text);

export function configPda(programId) {
  return PublicKey.findProgramAddressSync([seed('config')], new PublicKey(programId))[0];
}

/**
 * The pool. Seeded on a constant rather than on the mint, so the address
 * exists before the coin does — which is what let it be pasted into
 * pump.fun's creator-rewards dialog at creation time (Phase 04 §4.2).
 */
export function poolPda(programId) {
  return PublicKey.findProgramAddressSync([seed('pool')], new PublicKey(programId))[0];
}

/**
 * `(mint, epoch, programId)` — deliberately the same order as
 * `scripts/lib/program.mjs`, which is the only other place this is derived.
 *
 * They disagreed until now: this took `(programId, mint, epoch)`. Both
 * arguments are base58 strings, so swapping them raises nothing — it derives a
 * real-looking address for the wrong account, which is exactly the failure this
 * file's own header warns about. One order, checked by the header's own rule.
 */
export function epochPda(mint, epoch, programId) {
  const index = new Uint8Array(8);
  new DataView(index.buffer).setBigUint64(0, BigInt(epoch), true);
  return PublicKey.findProgramAddressSync(
    [seed('epoch'), new PublicKey(mint).toBytes(), index],
    new PublicKey(programId),
  )[0];
}

/**
 * The one token account that counts (L6, Phase 05 §5.2): the wallet's
 * associated token account for the mint.
 *
 * Derived rather than searched. `getTokenAccountsByOwner` returns every token
 * account the wallet holds for this mint, and picking the wrong one means
 * reading a different account's balance history.
 */
export function associatedTokenAddress(owner, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(tokenProgram).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// ── pump.fun, for L16 ──────────────────────────────────────────────────────
//
// These mirror `scripts/lib/pump-addresses.mjs`, for the same reason
// `epochPda` above mirrors `scripts/lib/program.mjs`: that module imports
// `@solana/web3.js` by bare specifier and this page has no bundler, so it
// reaches the library through the vendored global instead. Neither copy may
// drift from the other — `site.test.mjs` derives both and compares them, which
// is the only thing keeping a duplicated derivation honest.

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * The coin's LP mint on its canonical pump.fun pool.
 *
 * L16 turns on this address. Selling and supplying liquidity send the coin to
 * the same account, so the destination cannot tell them apart; what can is that
 * a deposit mints these tokens back to the depositor. See `computeLocked`.
 *
 * The pool index is a little-endian u16 and the canonical pool is index 0 — the
 * one part of this that derives a plausible wrong address when it is wrong.
 */
export function lpMint(mint, quoteMint = NATIVE_MINT) {
  const authority = PublicKey.findProgramAddressSync(
    [seed('pool-authority'), new PublicKey(mint).toBytes()],
    PUMP_PROGRAM_ID,
  )[0];

  const index = new Uint8Array(2);
  new DataView(index.buffer).setUint16(0, 0, true);

  const pool = PublicKey.findProgramAddressSync(
    [
      seed('pool'),
      index,
      authority.toBytes(),
      new PublicKey(mint).toBytes(),
      new PublicKey(quoteMint).toBytes(),
    ],
    PUMP_AMM_PROGRAM_ID,
  )[0];

  return PublicKey.findProgramAddressSync(
    [seed('pool_lp_mint'), pool.toBytes()],
    PUMP_AMM_PROGRAM_ID,
  )[0];
}

/** `confirmed` matches what the crank settles against. Not `processed`. */
export function connect(rpcUrl) {
  return new Connection(rpcUrl, 'confirmed');
}
