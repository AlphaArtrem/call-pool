// The arithmetic behind the card charts. Pure — no DOM, no network — so
// scripts/tests/site.test.mjs can assert the one property that matters here.
//
// Phase 07 §7.4 says never render a number that cannot be sourced, and §7.3
// says a page that renders trusted and untrusted data in the same style trains
// people not to notice which is which. **A chart is a number.** A sparkline
// with no data drawn as a flat line at zero is a claim that the value is zero;
// an empty axis with tidy gridlines is a claim that we looked and found
// nothing. Both are numbers this page has not earned the right to show.
//
// So every function here returns `null` rather than a degenerate shape when it
// does not have enough to draw, and the render helpers in ui.js are written so
// that `null` becomes a stated state — "no epoch has settled yet" — and never
// an empty frame. The refusal lives here, in the pure layer, because that is
// the layer a test can hold to it.

/**
 * Lamports (BigInt), a plain number, or null — as a finite Number, or null.
 *
 * BigInt is what the chain decoders produce and it cannot be divided into a
 * fraction, so every chart converts once, here. The magnitudes involved (SOL
 * balances, epoch counts) are far below 2^53, and the result is only ever used
 * to size a bar — never to decide money, which stays in BigInt end to end.
 */
function finite(value) {
  if (value == null) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bars, scaled against the largest value in the set.
 *
 * @param {Array<{label: string, value: bigint|number|null, display: string, secondary?: boolean}>} series
 * @returns {Array<{label: string, ratio: number, display: string, secondary: boolean}> | null}
 *
 * Returns null — refuses — when any value is missing, or when every value is
 * zero. "All zero" matters: three empty tracks look identical to three tracks
 * that failed to load, and the reader cannot tell which they are looking at.
 */
export function barSeries(series) {
  if (!Array.isArray(series) || series.length === 0) return null;

  const values = series.map((s) => finite(s.value));
  if (values.some((v) => v == null || v < 0)) return null;

  const max = Math.max(...values);
  if (max <= 0) return null;

  return series.map((s, i) => ({
    label: s.label,
    ratio: values[i] / max,
    display: s.display,
    secondary: s.secondary === true,
  }));
}

/**
 * A sparkline path over a series, oldest first.
 *
 * @returns {{line: string, area: string, last: {x: number, y: number}} | null}
 *
 * Refuses below two points, because one point is not a trend and drawing it as
 * a flat line asserts a history that does not exist. A series that is entirely
 * flat IS drawn — a run of equal epochs is a real, meaningful shape — and it
 * sits at the top of the box rather than being scaled by zero.
 */
export function sparkPath(values, { width = 220, height = 56, pad = 4 } = {}) {
  if (!Array.isArray(values) || values.length < 2) return null;

  const points = values.map(finite);
  if (points.some((v) => v == null)) return null;

  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min;

  const stepX = (width - pad * 2) / (points.length - 1);
  const usableY = height - pad * 2;

  const coords = points.map((v, i) => ({
    x: pad + i * stepX,
    // Flat series (span 0) sit at the top: the line is at its own maximum,
    // which is true, rather than pinned to a floor it never touched.
    y: pad + (span === 0 ? 0 : usableY - ((v - min) / span) * usableY),
  }));

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${round(c.x)} ${round(c.y)}`).join(' ');
  const area = `${line} L${round(coords[coords.length - 1].x)} ${height} L${round(coords[0].x)} ${height} Z`;

  return { line, area, last: coords[coords.length - 1] };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

/**
 * How far through an epoch `now` is, as a fraction, plus the challenge window
 * that follows it drawn on the same rail.
 *
 * @returns {{elapsed: number, remaining: number, challengeShare: number} | null}
 *
 * Refuses without a window, which means refusing until the on-chain genesis
 * has been read. The page must never draw an epoch clock from the visitor's
 * local calendar: `genesis_ts` is an on-chain argument and the two can differ.
 *
 * `elapsed` is clamped to [0, 1]. Past the end of the window the epoch is
 * closed and the bar is full — that is settling, not overflow.
 */
export function epochProgress({ window: w, now, challengeSeconds = null }) {
  if (w == null || !Number.isFinite(now)) return null;
  const length = w.end - w.start;
  if (!(length > 0)) return null;

  const elapsed = Math.min(1, Math.max(0, (now - w.start) / length));
  const challenge = finite(challengeSeconds);

  return {
    elapsed,
    remaining: 1 - elapsed,
    // The challenge window is shown relative to the epoch it follows, so a 24 h
    // window on a 24 h epoch reads as "the same length again".
    challengeShare: challenge == null || challenge <= 0 ? 0 : challenge / length,
  };
}
