// Epoch boundary arithmetic.
//
// An epoch is one calendar day in UTC. Epoch 0 starts at a genesis timestamp
// fixed at launch; before that exists, scripts address epochs by their UTC
// date (YYYY-MM-DD), which is unambiguous and needs no on-chain state.

import { EPOCH_SECONDS } from './config.mjs';

/**
 * Resolve a `YYYY-MM-DD` UTC date to its epoch window.
 *
 * @param {string} day  e.g. "2026-08-04"
 * @returns {{ day: string, start: number, end: number }} unix seconds,
 *          start inclusive, end exclusive.
 */
export function windowForDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`epoch day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  if (!Number.isFinite(start)) {
    throw new Error(`not a real date: ${day}`);
  }
  return { day, start, end: start + EPOCH_SECONDS };
}

/**
 * The lockout lookback for a given epoch: the `epochs` whole epochs
 * immediately before it, end-exclusive so the epoch's own day is not included.
 *
 * A sale inside the epoch is already paid for by the minimum collapsing to the
 * trough, so counting it here as well would make the penalty 8 days, not 7.
 *
 * The epoch length is taken from the window itself rather than from
 * `EPOCH_SECONDS`, because it is an `initialize` argument and lives on chain: a
 * deployment running 300-second epochs must look back 7 × 300 seconds, not 7
 * days. A window is exactly one epoch by construction — `windowForDay` and
 * `windowForEpoch` both build it that way — so its own length is the only
 * epoch length that can never disagree with the window being judged.
 *
 * This was hardcoded to `EPOCH_SECONDS` until 2026-08-05. At any non-default
 * epoch length it looked back seven *days*, and it reaches the verifier the
 * crank runs before posting a root — so a wrong lookback would have been
 * confirmed rather than caught.
 */
export function lockoutWindow(window, epochs) {
  return { start: window.start - epochs * (window.end - window.start), end: window.start };
}

/** Format a unix-seconds timestamp for human-readable output. */
export function iso(unixSeconds) {
  return unixSeconds == null
    ? 'unknown'
    : new Date(unixSeconds * 1000).toISOString().replace('.000', '');
}
