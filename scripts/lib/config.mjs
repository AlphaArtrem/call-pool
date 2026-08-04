// CALLPOOL — the parameters, in one place.
//
// Two kinds live here, and the difference matters:
//
//   1. **On-chain and immutable.** Written exactly once by `initialize` and
//      never changeable afterwards (Phase 04 §4.2 — no admin path): the mint's
//      supply and decimals, the floor, the epoch length. Until that
//      transaction is signed, this file is the only place they live, so a
//      change here is a change to the coin.
//   2. **Crank policy.** Applied off chain by the settlement job and therefore
//      revisable: currently just `DUST_THRESHOLD_LAMPORTS`. Marked as such
//      where it appears. The program neither knows nor enforces it.
//
// The crank, the verifier, the tests and the website all read from here so
// that the off-chain eligibility filter and the on-chain `claim` check can
// never drift apart. That identity is devnet proof 20.
//
// Browser-safe on purpose — the website imports this file directly rather
// than restating the floor (Phase 07 §7.3). Nothing here may touch `process`,
// `Buffer`, or `node:` built-ins without a `globalThis?.` guard.

/** Total supply of the mint. Verified 2026-08-04: calloutMarketCap / calloutPrice = 999,939,122. */
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000n;

/**
 * The eligibility floor, as a fraction of total supply.
 *
 * Ruled by L12 (2026-08-04), revising L4's 0.05%. Expressed in basis points of
 * a *percent* so it stays an integer: 0.01% = 1 part in 10,000.
 *
 * SETTLED by L13 (2026-08-05). L12's instruction contained two numbers — 0.01%
 * and "$500 at a $10M cap", which is 0.005% — and the owner was asked directly
 * and chose 0.01%. The floor is $1,000 at a $10M cap, understood and accepted.
 * The percentage is the parameter; the dollar figure was only ever the sanity
 * check on it, and a fixed token count cannot track a dollar value anyway (L4
 * deleted the price oracle for that reason).
 *
 * Do not "fix" this to 50,000 tokens. That alternative is rejected, not open.
 */
export const FLOOR_NUMERATOR = 1n;
export const FLOOR_DENOMINATOR = 10_000n;

/** The floor in whole tokens: 0.01% of 1,000,000,000 = 100,000. */
export const MIN_HOLD_TOKENS =
  (TOTAL_SUPPLY_TOKENS * FLOOR_NUMERATOR) / FLOOR_DENOMINATOR;

/**
 * Mint decimals. pump.fun mints use 6.
 *
 * `VERIFY` against the live mint before launch — this multiplies the floor, so
 * getting it wrong writes a floor 1,000× off and there is no repair path
 * (Phase 04 §4.1, the decimals footgun).
 */
export const MINT_DECIMALS = 6;

/**
 * The floor in raw token units — the number `initialize` is called with and
 * the number every balance comparison uses. Never compare in whole tokens.
 */
export const MIN_HOLD_RAW = MIN_HOLD_TOKENS * 10n ** BigInt(MINT_DECIMALS);

/** One epoch is one calendar day, 00:00 UTC to 00:00 UTC (Decision 3). */
export const EPOCH_SECONDS = 86_400;

/**
 * A balance decrease locks the wallet out of the next 7 epochs (Decision 23).
 *
 * Precision, settled in HANDOFF §13 against §9.6: a sale on day D costs day D
 * itself — the minimum collapses, no special case needed — *plus* days
 * D+1 through D+7. So when judging day d we look for decreases in the 7 whole
 * epochs immediately before d.
 */
export const LOCKOUT_EPOCHS = 7;

/**
 * The eligible set can never exceed 100% / floor wallets, because every
 * eligible wallet holds at least the floor. L12 raised this from 2,000.
 *
 * It bounds tier-2 replay, the merkle tree, the epoch bitmap and the airdrop
 * gas bill (Phase 05 §5.11), so it is worth deriving rather than hardcoding.
 */
export const MAX_ELIGIBLE_WALLETS = Number(FLOOR_DENOMINATOR / FLOOR_NUMERATOR);

/**
 * **Crank policy, not an on-chain parameter.** Below this, a share is not
 * worth the transaction that would deliver it.
 *
 * A claim costs one signature (5,000 lamports) plus whatever priority fee the
 * network demands, and the airdrop batches several claims per transaction — so
 * the true per-recipient cost is a fraction of that plus the compute. Ten
 * thousand lamports is two base signatures: comfortably above the real cost,
 * and still ~0.00001 SOL, so nothing meaningful is ever withheld.
 *
 * Withholding is not forfeiting. The amount is credited in the next epoch.
 *
 * It lives here rather than in carry.mjs because the website has to render the
 * withheld-dust state (Phase 07 §7.8) and carry.mjs imports `node:crypto`,
 * which a browser cannot load. `carry.mjs` re-exports it.
 */
export const DUST_THRESHOLD_LAMPORTS = 10_000n;

/**
 * Default cluster for every script. Devnet is where Phase 06's proofs run.
 *
 * `globalThis.process?.` rather than `process.` because the website imports
 * this same file in a browser (Phase 07 §7.3) — the immutable parameters have
 * exactly one home, and a second copy in `site/` is how the on-chain floor and
 * the rendered floor would eventually disagree. A bare `process` here is a
 * load-time ReferenceError there.
 */
export const DEFAULT_RPC_URL =
  globalThis.process?.env?.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
