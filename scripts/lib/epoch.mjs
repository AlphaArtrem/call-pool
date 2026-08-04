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
 */
export function lockoutWindow(window, epochs) {
  return { start: window.start - epochs * EPOCH_SECONDS, end: window.start };
}

/** Format a unix-seconds timestamp for human-readable output. */
export function iso(unixSeconds) {
  return unixSeconds == null
    ? 'unknown'
    : new Date(unixSeconds * 1000).toISOString().replace('.000', '');
}
