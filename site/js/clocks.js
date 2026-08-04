// The two clocks, and the rule that they must never blur (Phase 07 §7.9).
//
//   hourly  — a data refresh. Provisional standings from balance samples.
//   daily   — when money is decided. An exact replay of every transfer.
//
// A visitor who reads the hourly number as their payout will be angry when the
// exact replay moves it, and they will say so publicly. So every hourly figure
// carries the word "provisional" in the same breath as the number, and this
// module is what makes that structural rather than a thing someone remembered
// to write in the HTML.
//
// Pure — no DOM, no network — so scripts/tests/site.test.mjs can walk it
// through a whole day.

import { EPOCH_SECONDS } from '../../scripts/lib/config.mjs';
import { countdown, utcTime } from './standing.js';

const HOUR = 3600;

/** Which epoch index `at` falls in, given the on-chain genesis. */
export function epochAt(genesisTs, at, epochSeconds = EPOCH_SECONDS) {
  return Math.floor((at - genesisTs) / epochSeconds);
}

/** The window for an epoch index — the chain's clock, not a calendar. */
export function windowFor(genesisTs, epoch, epochSeconds = EPOCH_SECONDS) {
  const start = genesisTs + epoch * epochSeconds;
  return { epoch, start, end: start + epochSeconds };
}

/**
 * How to describe the moment an epoch closes.
 *
 * "00:00 UTC" is true for the launch parameters and false for any other epoch
 * length — a rehearsal deployment running 60-second epochs would otherwise
 * have the page announce a midnight boundary every minute. Derived from the
 * window rather than asserted, because §7.4 applies to times as much as to
 * amounts.
 */
export function boundaryLabel(window) {
  const length = window.end - window.start;
  const alignedToMidnight = length === 86_400 && window.end % 86_400 === 0;
  return alignedToMidnight ? '00:00 UTC' : utcTime(window.end);
}

/**
 * The hourly clock's state.
 *
 * `lastSampleAt` is the top of the hour the published provisional standings
 * cover. Behind by more than one hour is **stalled**, and the page says so —
 * a stale number presented as live is the one thing §7.4 forbids outright.
 *
 * @returns {{state: string, label: string, provisional: boolean, stale: boolean}}
 */
export function hourlyState({ now, lastSampleAt, calculating = false }) {
  if (lastSampleAt == null) {
    return {
      state: 'unknown',
      label: 'No provisional standings published yet.',
      provisional: true,
      stale: false,
    };
  }

  const nextSampleAt = lastSampleAt + HOUR;
  const behindBy = now - nextSampleAt;

  if (calculating) {
    return {
      state: 'running',
      label: `Calculating ${utcTime(lastSampleAt)} – ${utcTime(lastSampleAt + HOUR)}…`,
      provisional: true,
      stale: false,
    };
  }

  // One full hour late is not "a moment ago" — it means a refresh was missed.
  if (behindBy > HOUR) {
    return {
      state: 'stalled',
      label: `Last updated ${utcTime(lastSampleAt)} — behind schedule.`,
      provisional: true,
      stale: true,
    };
  }

  return {
    state: 'fresh',
    label: `Updated ${utcTime(lastSampleAt)}. Provisional — final at 00:00 UTC.`,
    provisional: true,
    stale: false,
  };
}

/**
 * The daily clock's state: running → settling → challenge → paid.
 *
 * `settledAt` is the epoch account's `posted_ts`; until a root exists the
 * epoch is either still running or being replayed, and the page must not
 * claim which without evidence.
 */
export function dailyState({ now, window, settledAt = null, challengeSeconds = null }) {
  if (now < window.end) {
    return {
      state: 'running',
      label: `Epoch ${window.epoch} closes in ${countdown(window.end - now)} (${boundaryLabel(window)}).`,
      decidesMoney: true,
    };
  }

  if (settledAt == null) {
    return {
      state: 'settling',
      label: `Settling epoch ${window.epoch}… every transfer is being replayed exactly.`,
      decidesMoney: true,
    };
  }

  if (challengeSeconds != null && now < settledAt + challengeSeconds) {
    const opensAt = settledAt + challengeSeconds;
    return {
      state: 'challenge',
      label: `Epoch ${window.epoch} settled. Payouts sent in ${countdown(opensAt - now)}.`,
      decidesMoney: true,
      challengeEndsAt: opensAt,
    };
  }

  return {
    state: 'payable',
    label: `Epoch ${window.epoch} settled and payable.`,
    decidesMoney: true,
    challengeEndsAt: challengeSeconds == null ? null : settledAt + challengeSeconds,
  };
}

/**
 * Why the provisional number and the final one can differ.
 *
 * One line, on the page, because someone will ask and the honest answer is
 * reassuring. The difference is deliberate (Phase 05 §5.11): sampling is cheap
 * enough to run hourly for every holder, and too weak to pay from.
 */
export const PROVISIONAL_EXPLANATION =
  'Hourly figures come from balance samples taken once an hour. The daily settlement replays every transfer, so it catches a sale and rebuy that happened between two samples. The final number is the exact one; the hourly one is an estimate that is usually identical.';
