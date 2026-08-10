// The checks that must pass before `initialize`, as pure functions.
//
// `initialize` writes five values and **none of them can ever be changed**.
// There is no `set_params`, no admin path and no upgrade (§4.2), so a wrong
// number here is not a bug to fix later — it is a new deployment and a new coin.
//
// The program already refuses the *obviously* wrong. `min_raw_floor` catches
// `min_hold` written in whole tokens instead of raw units, alignment catches a
// genesis off a boundary, and the range checks catch a zero or absurd challenge
// window. What none of it catches, and what its own test says out loud, is a
// value that is **wrong but plausible**:
//
//     assert!(1_000_000_000u64 >= min_raw_floor(6), "1,000 tokens passes — wrong, but plausible");
//
// Against that, MAINNET-DEPLOYMENT.md §5 said "Read the command twice. Then
// read it again." That is a procedure, and procedures are performed by whoever
// is most tired at the most irreversible moment. This is the same intent as a
// mechanism: derive what the parameters *should* be from the chain and from
// `config.mjs`, compare, and refuse to print a green light when they disagree.
//
// Pure on purpose — every check here is decided from values, so the whole set
// can be exercised against fabricated mints in a test rather than only against
// the one mint that matters, once, on the day.

import {
  EPOCH_SECONDS,
  FLOOR_DENOMINATOR,
  FLOOR_NUMERATOR,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
  MINT_DECIMALS,
} from './config.mjs';

/**
 * L19 (supersedes L14). The mainnet challenge window, in seconds.
 *
 * Five minutes, so holders are paid within minutes of 00:00 UTC the same
 * night; the public snapshots are the audit trail after the fact. This
 * constant sat at L14's 86_400 until the actual launch (2026-08-10), which
 * made the preflight refuse the ruled value at the moment it mattered —
 * DECISIONS-LOCKED L19 is the ruling, and this file mirrors it.
 */
export const CHALLENGE_SECONDS = 300;

/** Mirrors `min_raw_floor` in lib.rs — the on-chain guard, restated. */
export const minRawFloor = (decimals) => 10n ** BigInt(decimals);

/** A finding. `fatal` means the deployment must not proceed. */
const problem = (fatal, check, message) => ({ fatal, check, message });

/**
 * Everything that must be true about the mint itself.
 *
 * The decimals check is the one that earns this whole module. `MIN_HOLD_RAW` is
 * computed as `MIN_HOLD_TOKENS × 10^MINT_DECIMALS` from a constant that says
 * "pump.fun mints use 6" — a true statement about `create` that is **not** true
 * of every mint pump.fun can produce, and the file itself carries a `VERIFY`
 * note about it. If the live mint has different decimals, the floor written on
 * chain is wrong by a factor of a thousand or more, permanently, and every
 * other number in the preflight still looks right.
 */
export function checkMint({ decimals, supply }) {
  const problems = [];

  if (decimals !== MINT_DECIMALS) {
    problems.push(
      problem(
        true,
        'decimals',
        `the live mint has ${decimals} decimals but config.mjs assumes ${MINT_DECIMALS}. ` +
          `MIN_HOLD_RAW is derived from that assumption, so the floor would be written as ` +
          `${MIN_HOLD_RAW} raw units — which is ${MIN_HOLD_RAW / 10n ** BigInt(decimals)} whole ` +
          `tokens at the real decimals, not ${MIN_HOLD_TOKENS}. Fix MINT_DECIMALS before anything else.`,
      ),
    );
  }

  // A pump.fun mint is fully minted at creation, so a supply that is not the
  // billion the floor is a percentage OF means this is not the coin we planned.
  const expectedSupply = MIN_HOLD_TOKENS * FLOOR_DENOMINATOR / FLOOR_NUMERATOR;
  const supplyTokens = supply / 10n ** BigInt(decimals);
  if (supplyTokens !== expectedSupply) {
    problems.push(
      problem(
        true,
        'supply',
        `the live mint's supply is ${supplyTokens} whole tokens, but the floor was chosen as ` +
          `${FLOOR_NUMERATOR}/${FLOOR_DENOMINATOR} of ${expectedSupply}. The floor is a fixed ` +
          `token count (L4), so against this supply it is actually ` +
          `${(MIN_HOLD_TOKENS * FLOOR_DENOMINATOR * 100n) / supplyTokens / FLOOR_DENOMINATOR}% ` +
          'of supply rather than 0.01%, and the eligible-set ceiling moves with it.',
      ),
    );
  }

  return problems;
}

/**
 * Everything that must be true about the five immutable arguments.
 *
 * `expectRehearsal` flips the clock checks: a 300-second epoch is correct for a
 * rehearsal and catastrophic on mainnet, and the same comparison has to be able
 * to say both. It defaults to false so that forgetting the flag fails toward
 * the mainnet expectation rather than away from it.
 */
export function checkParameters({ minHold, epochSeconds, challengeSeconds, genesisTs, now, snapshotKey, decimals = MINT_DECIMALS }, { expectRehearsal = false } = {}) {
  const problems = [];

  // ── the floor ────────────────────────────────────────────────────────────
  if (minHold !== MIN_HOLD_RAW) {
    problems.push(
      problem(
        true,
        'min_hold',
        `min_hold is ${minHold} but config.mjs computes ${MIN_HOLD_RAW} ` +
          `(${MIN_HOLD_TOKENS} tokens × 10^${decimals}). These must be the same number — the ` +
          'on-chain check and the off-chain filter reading one floor is what makes them unable ' +
          'to drift (L4), and devnet proof 20 asserts it.',
      ),
    );
  }
  if (minHold < minRawFloor(decimals)) {
    problems.push(
      problem(true, 'min_hold', `min_hold ${minHold} is below one whole token — the program will reject it.`));
  }

  // ── the clocks ───────────────────────────────────────────────────────────
  const expectedEpoch = expectRehearsal ? null : EPOCH_SECONDS;
  if (expectedEpoch !== null && epochSeconds !== expectedEpoch) {
    problems.push(
      problem(
        true,
        'epoch_seconds',
        `epoch_seconds is ${epochSeconds}, not ${expectedEpoch}. One epoch is one UTC day ` +
          '(Decision 3). A rehearsal value reaching mainnet is permanent.',
      ),
    );
  }
  const expectedChallenge = expectRehearsal ? null : CHALLENGE_SECONDS;
  if (expectedChallenge !== null && challengeSeconds !== expectedChallenge) {
    problems.push(
      problem(
        true,
        'challenge_seconds',
        `challenge_seconds is ${challengeSeconds}, not ${expectedChallenge} (L19). A rehearsal ` +
          'window reaching mainnet is permanent, and L14’s 86400 pays everyone two days late.',
      ),
    );
  }
  if (challengeSeconds <= 0) {
    problems.push(problem(true, 'challenge_seconds', 'a zero challenge window is no window, ever.'));
  }
  if (BigInt(challengeSeconds) > 30n * BigInt(epochSeconds)) {
    problems.push(
      problem(true, 'challenge_seconds', 'the challenge window outlasts the 30-epoch claim deadline — the program will reject it.'));
  }

  // ── genesis ──────────────────────────────────────────────────────────────
  // Restated from the program rather than trusted to it, because a rejection
  // here costs a re-run and a rejection there costs a deployment slot.
  if (genesisTs % epochSeconds !== 0) {
    problems.push(
      problem(
        true,
        'genesis_ts',
        `genesis_ts ${genesisTs} is not aligned to a ${epochSeconds}s boundary. The on-chain ` +
          'epoch index and the crank\'s UTC day would not be the same thing.',
      ),
    );
  }
  if (Math.abs(genesisTs - now) > epochSeconds) {
    problems.push(
      problem(true, 'genesis_ts', `genesis_ts ${genesisTs} is more than one epoch from now (${now}) — the program will reject it.`));
  }
  // Epoch 0 has no inputs when the deploy lands inside its window (F20). Not
  // fatal, and deliberately not: it costs one epoch, and refusing would be a
  // worse trade than saying so.
  if (genesisTs < now) {
    problems.push(
      problem(
        false,
        'genesis_ts',
        `genesis_ts is ${now - genesisTs}s in the past, so epoch 0 began before the program ` +
          'existed and can never be settled — nothing polled the feed for that window (F20). ' +
          'Start on a boundary to avoid it.',
      ),
    );
  }

  // ── the key ──────────────────────────────────────────────────────────────
  if (!snapshotKey || /^1+$/.test(snapshotKey)) {
    problems.push(problem(true, 'snapshot_key', 'snapshot_key is unset or the default pubkey.'));
  }

  return problems;
}

/** Everything, in one call. `ok` is false if anything fatal was found. */
export function preflight(mint, parameters, options = {}) {
  const problems = [
    ...checkMint(mint),
    ...checkParameters({ ...parameters, decimals: mint.decimals }, options),
  ];
  return { ok: !problems.some((p) => p.fatal), problems };
}
