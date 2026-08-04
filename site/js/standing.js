// "Where do I stand?" — every state from Phase 07 §7.8, as one pure function.
//
// Kept free of the DOM and the network so it can be tested exhaustively in
// Node (scripts/tests/site.test.mjs). The §7.8 table is a promise about what
// the page says in each situation, and a promise nothing asserts is a draft.
//
// Two rules govern everything here:
//
//   * **Never say "ineligible" without naming the condition that failed and
//     what to do about it.** "You haven't called out yet today" is actionable;
//     "ineligible" is an insult with a countdown.
//   * **Never state a number the caller could not source.** Anything unknown
//     comes back as a `pending` state, not as zero.

import { LOCKOUT_EPOCHS, MIN_HOLD_TOKENS, DUST_THRESHOLD_LAMPORTS } from '../../scripts/lib/config.mjs';

/** Ordered worst-first. The renderer uses this for tone, not just wording. */
export const SEVERITY = {
  pending: 'pending',
  blocked: 'blocked',
  action: 'action',
  ok: 'ok',
};

/**
 * Where does this address stand right now?
 *
 * @param {object} facts everything already fetched; nothing is fetched here
 * @param {number} facts.now                    unix seconds
 * @param {bigint|null} facts.currentRaw        the ATA's balance now
 * @param {bigint|null} facts.holdRaw           `hold` so far this epoch
 * @param {bigint} facts.minHoldRaw             the floor, from chain if known
 * @param {{checked: boolean, lastAt: number|null, activeInWindow: boolean}} facts.callout
 * @param {{locked: boolean, lastDecreaseAt: number|null, liftsAt: number|null}} facts.lockout
 * @param {{start: number, end: number}} facts.window
 * @param {object} [facts.settlement]           the epoch's published/on-chain outcome
 * @returns {{state: string, severity: string, headline: string, detail: string[], eligible: boolean|null}}
 */
export function standingFor(facts) {
  const {
    now,
    currentRaw,
    holdRaw,
    minHoldRaw,
    callout,
    lockout,
    window: epochWindow,
    settlement = null,
  } = facts;

  // A settled epoch describes itself. Eligibility questions are about the
  // epoch that is still running, so a settled outcome takes precedence.
  if (settlement) {
    const settled = settlementState(settlement, now);
    if (settled) return settled;
  }

  if (currentRaw == null || holdRaw == null) {
    return {
      state: 'pending',
      severity: SEVERITY.pending,
      eligible: null,
      headline: 'Reading this wallet’s history from chain…',
      detail: ['Nothing is shown until it can be sourced.'],
    };
  }

  if (currentRaw === 0n && holdRaw === 0n) {
    return {
      state: 'not-a-holder',
      severity: SEVERITY.blocked,
      eligible: false,
      headline: 'This wallet holds no CALLPOOL.',
      detail: [
        `Earning needs a minimum of ${MIN_HOLD_TOKENS.toLocaleString('en-US')} CALLPOOL held through the whole day, plus a callout or callout update that day.`,
      ],
    };
  }

  // Lockout is checked BEFORE the floor, and the order is deliberate. A locked
  // wallet that is also under the floor would otherwise be told to buy more —
  // advice that costs money and changes nothing, because buying back does not
  // shorten a lockout (L1).
  if (lockout.locked) {
    return {
      state: 'locked-out',
      severity: SEVERITY.blocked,
      eligible: false,
      headline: 'Locked out — a balance decrease resets earning for 7 epochs.',
      detail: [
        lockout.lastDecreaseAt
          ? `Tokens left this wallet on ${utcDate(lockout.lastDecreaseAt)}.`
          : 'A decrease was found in the last 7 epochs.',
        lockout.liftsAt
          ? `Earning resumes ${utcDate(lockout.liftsAt)} (00:00 UTC).`
          : `The lockout runs ${LOCKOUT_EPOCHS} whole epochs from the decrease.`,
        'Any decrease triggers this, however small.',
        'Sending tokens to another wallet you own counts as selling. There is no netting and no housekeeping exemption.',
        'Buying back does not shorten it.',
      ],
    };
  }

  if (holdRaw < minHoldRaw) {
    return {
      state: 'below-floor',
      severity: SEVERITY.action,
      eligible: false,
      headline: `Below the minimum for this epoch.`,
      detail: [
        `The minimum is ${MIN_HOLD_TOKENS.toLocaleString('en-US')} CALLPOOL — 0.01% of the supply, fixed on chain.`,
        'It is measured as the lowest balance at any point in the day, not the balance now — so a dip below the floor costs the whole day even if you bought back.',
      ],
    };
  }

  if (!callout.checked) {
    return {
      state: 'callout-unknown',
      severity: SEVERITY.pending,
      eligible: null,
      headline: 'Holdings qualify. The callout could not be checked.',
      detail: [
        'This page asks pump.fun directly, from your browser, and the request did not come back.',
        'Eligibility also needs a callout or a callout update today, so this is not an answer yet.',
      ],
    };
  }

  if (!callout.activeInWindow) {
    return {
      state: 'no-activity',
      severity: SEVERITY.action,
      eligible: false,
      headline: 'Holdings qualify. No callout yet today.',
      detail: [
        callout.lastAt
          ? `Last callout: ${utcDate(callout.lastAt)}.`
          : 'No callout has been found for this wallet.',
        'Calls do not carry over. Call CALLPOOL out again, or post an update to your existing callout, before 00:00 UTC to earn today.',
        `This epoch closes ${utcTime(epochWindow.end)}.`,
      ],
    };
  }

  return {
    state: 'eligible',
    severity: SEVERITY.ok,
    eligible: true,
    headline: 'On track for this epoch.',
    detail: [
      'Held above the floor all day so far, and a callout is on record.',
      'Your share is a projection until 00:00 UTC — it moves as others call out, buy and sell.',
      'Nothing to claim and no wallet to connect. Rewards are sent to this address automatically.',
    ],
  };
}

/**
 * A settled epoch's own states: waiting out the challenge window, paid,
 * withheld as dust, or expired.
 *
 * Returns null when the epoch has not settled, so the caller falls through to
 * the live eligibility checks.
 */
function settlementState(settlement, now) {
  const { posted, challengeEndsAt, amountLamports, claimed, signature, carriedLamports, expired } =
    settlement;

  if (!posted) return null;

  if (expired) {
    return {
      state: 'expired',
      severity: SEVERITY.blocked,
      eligible: true,
      headline: 'This epoch closed unpaid and returned to the pool.',
      detail: [
        'Unclaimed rewards return to the pool after 30 epochs.',
        'It is shown rather than hidden: a number you once saw should never quietly vanish.',
      ],
    };
  }

  if (claimed) {
    return {
      state: 'paid',
      severity: SEVERITY.ok,
      eligible: true,
      headline: `${formatSol(amountLamports)} SOL sent to this address.`,
      detail: ['No action was required, and none is required now.'],
      signature,
    };
  }

  if (amountLamports != null && amountLamports > 0n && amountLamports < DUST_THRESHOLD_LAMPORTS) {
    return {
      state: 'withheld-dust',
      severity: SEVERITY.ok,
      eligible: true,
      headline: `This epoch’s share (${formatSol(amountLamports)} SOL) is smaller than the network fee to send it.`,
      detail: [
        'It is carried forward and paid automatically once it clears the threshold.',
        carriedLamports != null
          ? `Carried so far: ${formatSol(carriedLamports)} SOL.`
          : 'Carried amounts are listed in each epoch’s carry.json.',
        'Withholding is not forfeiting.',
      ],
    };
  }

  if (challengeEndsAt != null && now < challengeEndsAt) {
    return {
      state: 'challenge-window',
      severity: SEVERITY.ok,
      eligible: true,
      headline: `Settled: ${formatSol(amountLamports)} SOL. Payout sent in ${countdown(challengeEndsAt - now)}.`,
      detail: [
        'The root is posted and the numbers are published, so anyone can recompute them before the money moves.',
        'Be clear about what that window is: 24 hours in which anyone can discover a bad root, and nobody can stop it. There is no pause, no veto and no dispute instruction.',
      ],
    };
  }

  return {
    state: 'payout-pending',
    severity: SEVERITY.action,
    eligible: true,
    headline: `${formatSol(amountLamports)} SOL settled, not yet landed.`,
    detail: [
      'The daily airdrop sends this automatically — it may simply not have run yet.',
      'If it stays here, anyone can submit the claim on your behalf, including you. The destination is fixed inside the merkle leaf on chain, so submitting it cannot redirect the payment to anybody else.',
    ],
  };
}

// ── formatting shared with the renderer ────────────────────────────────────

/** Lamports → SOL, as a decimal string. Never rounded up into a lie. */
export function formatSol(lamports) {
  if (lamports == null) return '—';
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** Raw token units → whole tokens, with a thousands separator. */
export function formatTokens(raw, decimals) {
  if (raw == null) return '—';
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const head = whole.toLocaleString('en-US');
  return fraction === '' ? head : `${head}.${fraction}`;
}

export function utcDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function utcTime(unixSeconds) {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `13h 42m`, or `42m 05s` under an hour. Never "soon". */
export function countdown(seconds) {
  if (seconds == null || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}
