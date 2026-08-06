// The index page for one published epoch directory.
//
// Why this exists: every row of the site's audit trail links to
// `/snapshots/epoch-N/` — a *directory* — and nothing ever wrote an index into
// one. `serve-site.mjs` serves a directory only through its `index.html` and
// says so in a comment ("serve its index if there is one"), and the production
// edge has no directory listing either, on purpose. So every "snapshot" link
// on the page 404'd, in dev and on the live host, and would have 404'd on
// mainnet from the first settled day.
//
// That is the section §7.2 calls one a copycat cannot fake, and its whole value
// is that each row is an invitation to check the working. An invitation that
// 404s is worse than no link at all.
//
// **No CSS, deliberately, and it is not an oversight.**
//
//   * The live edge sends `style-src 'self'`, so an inline <style> block would
//     be blocked in production and the page would arrive unstyled anyway.
//   * Linking `/site/app.css` would style it on the host and break the moment
//     someone downloads the directory to check it offline — which is exactly
//     what this directory is for.
//
// So: plain semantic HTML that renders the same everywhere, including from a
// `file://` copy on a stranger's laptop with no network. This is an audit
// artefact, not a marketing page.
//
// Regenerate it whenever the directory's contents change — `airdrop.json`
// lands after the challenge window, long after the snapshot is written, so
// `airdrop.mjs` writes this again when it is done.

import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What each file in a published epoch is, in the words a reader needs.
 *
 * Anything not listed here still gets linked — an unknown file in the audit
 * trail should be visible, not hidden because this table is out of date.
 */
const DESCRIPTIONS = {
  'callouts.json': 'Every callout counted for this day, exactly as it was read from pump.fun.',
  'balances.json': "Each caller's lowest balance across the day, replayed from chain history.",
  'pool.json': 'The pool balance the split was made from, and what was allocatable.',
  'tree.json': 'The merkle tree: every leaf, its amount, and the proof for it.',
  'carry.json': 'Shares too small to be worth their transaction fee, carried into the next day.',
  'payouts.csv': 'The same allocations as a spreadsheet, for reading rather than parsing.',
  'root.txt': 'The root posted on chain, the leaf count, and the amount allocated.',
  'build.mjs': 'Re-derives all of the above. No keys, no account, no permission needed.',
  'airdrop.json': 'What was actually sent, and when. Written after the challenge window closed.',
};

/** Minimal escaping — these strings are ours, but the file is served as HTML. */
function esc(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The index for one epoch directory, as a string.
 *
 * Pure, so `scripts/tests/` can assert it without touching a filesystem.
 *
 * @param {object} opts
 * @param {number|string} opts.epoch  the epoch index
 * @param {string[]} opts.files       filenames present in the directory
 * @param {{start: string, end: string}|null} opts.window  ISO bounds, if known
 */
export function snapshotIndexHtml({ epoch, files, window = null }) {
  const listed = [...files].filter((f) => f !== 'index.html').sort();

  const rows = listed
    .map((file) => {
      const what = DESCRIPTIONS[file] ?? 'Published with this epoch.';
      return `      <dt><a href="${esc(file)}">${esc(file)}</a></dt>\n` +
        `      <dd>${esc(what)}</dd>`;
    })
    .join('\n');

  const when = window
    ? `\n    <p>Covers <time>${esc(window.start)}</time> to <time>${esc(window.end)}</time>.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CALLPOOL — epoch ${esc(epoch)}, the working</title>
    <!--
      Not decoration. With no stylesheet the browser supplies the colours, and
      a page that does not declare a scheme gets dark-mode chrome with
      light-mode text on a dark-mode machine — black on near-black, which is
      how this rendered the first time. Declaring both lets the UA pick a
      readable pair either way, and costs no CSS.
    -->
    <meta name="color-scheme" content="dark light" />
    <meta name="robots" content="noindex" />
  </head>
  <body>
    <h1>CALLPOOL — epoch ${esc(epoch)}</h1>
    <p>
      Everything needed to reproduce this day's payouts, published
      <strong>before</strong> the root was posted on chain. If any of it
      disagrees with what the chain says, the chain is right and these files are
      evidence of what was claimed.
    </p>${when}

    <h2>Check it yourself</h2>
    <p>No keys, no account, and no permission from us:</p>
    <pre><code>node build.mjs                  recompute the root from these files
node build.mjs --recheck-chain  ignore balances.json, rebuild it from an RPC</code></pre>
    <p>
      If that does not print the root in <a href="root.txt">root.txt</a>, this
      epoch did not happen properly &mdash; say so publicly.
    </p>

    <h2>The files</h2>
    <dl>
${rows}
    </dl>
  </body>
</html>
`;
}

/** Write the index for a directory, listing whatever is actually in it. */
export function writeSnapshotIndex(dir, { epoch, window = null } = {}) {
  const files = readdirSync(dir);
  writeFileSync(resolve(dir, 'index.html'), snapshotIndexHtml({ epoch, files, window }));
}
