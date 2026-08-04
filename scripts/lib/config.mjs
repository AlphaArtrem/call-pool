// CALLPOOL — the immutable parameters, in one place.
//
// Everything here is written on chain exactly once by `initialize` and can
// never be changed afterwards (Phase 04 §4.2 — no admin path). Until that
// transaction is signed, this file is the only place any of these numbers
// live, so a change here is a change to the coin.
//
// The crank, the verifier and the tests all read from here so that the
// off-chain eligibility filter and the on-chain `claim` check can never drift
// apart. That identity is devnet proof 20.

/** Total supply of the mint. Verified 2026-08-04: calloutMarketCap / calloutPrice = 999,939,122. */
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000n;

/**
 * The eligibility floor, as a fraction of total supply.
 *
 * Ruled by L12 (2026-08-04), revising L4's 0.05%. Expressed in basis points of
 * a *percent* so it stays an integer: 0.01% = 1 part in 10,000.
 *
 * ⚠️ UNRESOLVED — see DECISIONS-LOCKED.md L12. The instruction that set this
 * asked for 0.01% AND for "$500 at a $10M market cap". Those are different
 * numbers: 0.01% is $1,000 at a $10M cap, and $500 would be 0.005%
 * (FLOOR_NUMERATOR = 5, i.e. 50,000 tokens). 0.01% is implemented because the
 * percentage is the parameter and the dollar figure was the check on it.
 *
 * This must be settled before `initialize` — Phase 08 has the stop-line. Until
 * then it is the one-line edit below.
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

/** Default cluster for every script. Devnet is where Phase 06's proofs run. */
export const DEFAULT_RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
