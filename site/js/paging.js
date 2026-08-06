// Which slice of a list is on screen.
//
// Its own module, dependency-free, for the reason `standing.js` and `clocks.js`
// are: `scripts/tests/site.test.mjs` exercises it in Node. `epochs.js` cannot
// be imported there — it reaches web3.js through `addresses.js`, which needs a
// browser global — so anything that decides *what a reader sees* has to live
// outside it to be asserted rather than eyeballed.

/** Rows per page in the audit trail. */
export const PAGE_SIZE = 10;

/**
 * The page a reader is on, clamped to one that exists.
 *
 * `page` is clamped rather than trusted, and that is the whole point of this
 * being a function. The table re-reads the chain every minute, so the row count
 * can shrink under a reader who is sitting on the last page. An out-of-range
 * page must fall back to the last real rows — never to an empty table, which
 * reads as "there is no history" and is the most alarming thing this page could
 * say untruthfully.
 *
 * @param {Array} items  newest first, as the epoch table lists them
 * @param {number} page  zero-based; anything out of range is clamped
 * @param {number} size  rows per page
 */
export function pageOf(items, page, size = PAGE_SIZE) {
  const length = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(length / size));
  const current = Math.min(Math.max(Number.isFinite(page) ? Math.trunc(page) : 0, 0), totalPages - 1);
  const start = current * size;

  return {
    rows: Array.isArray(items) ? items.slice(start, start + size) : [],
    page: current,
    totalPages,
    // One page is not pagination. Two disabled buttons around "1 of 1" is
    // chrome answering a question nobody asked.
    needed: length > size,
    // 1-based and inclusive, because these are read by a person: "Days 11–20".
    first: length === 0 ? 0 : start + 1,
    last: Math.min(start + size, length),
    count: length,
  };
}
