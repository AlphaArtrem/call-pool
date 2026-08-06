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

/** `confirmed` matches what the crank settles against. Not `processed`. */
export function connect(rpcUrl) {
  return new Connection(rpcUrl, 'confirmed');
}
