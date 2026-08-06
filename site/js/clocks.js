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
      label: 'No estimate published yet.',
      provisional: true,
      stale: false,
    };
  }

  const nextSampleAt = lastSampleAt + HOUR;
  const behindBy = now - nextSampleAt;

  if (calculating) {
    return {
      state: 'running',
      label: `Working out the ${utcTime(lastSampleAt)} – ${utcTime(lastSampleAt + HOUR)} estimate…`,
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
    label: `Updated ${utcTime(lastSampleAt)}. An estimate — the real figure is set at 00:00 UTC.`,
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
      label: `Today’s round closes in ${countdown(window.end - now)}, at ${boundaryLabel(window)}.`,
      decidesMoney: true,
    };
  }

  if (settledAt == null) {
    return {
      state: 'settling',
      label: 'Working out today’s payouts — every transfer of the day is being replayed exactly.',
      decidesMoney: true,
    };
  }

  if (challengeSeconds != null && now < settledAt + challengeSeconds) {
    const opensAt = settledAt + challengeSeconds;
    return {
      state: 'challenge',
      label: `Today’s results are posted. Payouts go out in ${countdown(opensAt - now)}.`,
      decidesMoney: true,
      challengeEndsAt: opensAt,
    };
  }

  return {
    state: 'payable',
    label: 'Today’s results are posted and the payouts are going out.',
    decidesMoney: true,
    challengeEndsAt: challengeSeconds == null ? null : settledAt + challengeSeconds,
  };
}

/**
 * Whether the live figures on the page are still live, and what to say if not.
 *
 * The page re-reads chain data on a timer and **keeps the last figures it
 * actually read** when a re-read fails: a balance that was true a minute ago is
 * worth more to a reader than a blank, and a value that flashes "reading…"
 * every minute reads as broken. The cost of that choice is that a stopped page
 * looks exactly like a working one, which is the §7.4 failure — so the moment a
 * refresh fails, the page says how old the figures are and that they have
 * stopped moving.
 *
 * `readAt` is the last fully successful pass; `failedAt` the last failure. A
 * partial pass counts as a failure, because a timestamp covering half the page
 * is a more confident claim than the page can make.
 *
 * @returns {{stale: boolean, label: string|null}}
 */
export function freshnessNote({ readAt, failedAt }) {
  if (failedAt == null) return { stale: false, label: null };

  return {
    stale: true,
    label:
      readAt == null
        ? 'Could not reach Solana, so nothing above has been read yet. Reloading usually fixes it.'
        : `Could not reach Solana just now, so the figures above are from ${utcTime(readAt)} ` +
          'and are not updating. Reloading usually fixes it.',
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
  'The hourly figure is a spot check: it looks at balances once an hour. The daily settlement replays every single transfer of the day, so it catches a sale and a rebuy that happened between two of those checks. The daily number is the exact one. The hourly one is usually identical, and it is never what you are paid.';

/**
 * What the daily record says before there is a single settled day.
 *
 * §7.4 again: an empty table is a state, and "No days yet" leaves a reader
 * wondering whether it is broken, whether they are early, or whether something
 * went wrong. All three are answerable, so answer them.
 *
 * **It deliberately does not say "24 hours after launch".** Days close at the
 * epoch boundary, and launch happens somewhere inside the first one — launch at
 * 22:00 UTC and the first day closes two hours later, not twenty-four. Promising
 * a day and delivering in two hours is harmless; promising two hours and taking
 * a day is not, and the honest version costs nothing because the boundary is
 * known exactly.
 *
 * Three states, because the gap between a day closing and its root being posted
 * is real and a page that says nothing during it looks stuck.
 *
 * @param {{now: number, window: {start: number, end: number}|null}} facts
 */
export function firstRecordNote({ now, window = null }) {
  if (window == null) {
    return 'Nothing here yet — the first day starts when the coin launches, and its record appears here once that day has finished.';
  }

  if (now >= window.end) {
    return 'The first day has just closed. Its record appears here as soon as the day is settled, usually within a few minutes.';
  }

  return `Nothing to show yet — the first day is still running. It finishes at ${boundaryLabel(window)}, ${roughly(window.end - now)}, and this table fills in shortly after that.`;
}

/**
 * A duration a person would say out loud.
 *
 * `countdown()` shows seconds at every scale because the hero clock ticks and
 * needs them. Here they are noise dressed as precision — "about 23h 00m 00s"
 * is a stopwatch reading in a sentence that begins with "about". Nobody waiting
 * a day cares about the seconds, and the row will not appear at that second
 * anyway: it appears once the crank has settled the day.
 */
function roughly(seconds) {
  if (seconds <= 90) return 'any moment now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes from now`;

  const hours = Math.round(seconds / 3600);
  if (hours === 1) return 'about an hour from now';
  return `about ${hours} hours from now`;
}
