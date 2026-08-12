// Epoch history — the audit trail (Phase 07 §7.2 item 4).
//
// One row per epoch: pool, callers, distributed, unclaimed, root, and a button
// that opens the whole day. §7.2 calls this one of the two sections a copycat
// cannot fake, and the reason is that every row is an invitation to check it.
//
// The rows are built from the on-chain Epoch accounts, not from a file we
// publish. Behind the Details button (epoch-details.js) sit the published
// directory, the account, and that day's payee list, so the two can be
// compared; if they ever disagree, the chain is right and the directory is
// evidence of what we claimed.

import { decodeEpoch, bitmapIsSized, isZeroRoot, rootHex } from './program.js';
import { epochPda } from './addresses.js';
import { multipleAccounts } from './chain.js';
import { dayLabel, dayNumber, epochIndices, totalClaimed } from './history.js';
import { openDay0Details, openEpochDetails } from './epoch-details.js';
import { pageOf } from './paging.js';
import { largestShare } from './payouts.js';
import { snapshotUrl } from './config.js';
import { exactTitle, formatSol, formatSolShort } from './standing.js';
import { field, SOURCES } from './ui.js';

/**
 * Read every epoch since genesis, newest first.
 *
 * A missing account is a real state — the epoch was never posted — and it is
 * rendered as such rather than skipped. A skipped epoch stays postable forever
 * (Phase 05 §5.5), so a gap in this table is a thing readers should see.
 *
 * All of them, because "Paid out so far" is summed from these rows and its
 * caption promises every past day. `pageOf` is what keeps the table readable.
 */
export async function loadEpochs(connection, config, currentEpoch) {
  const indices = epochIndices(currentEpoch);

  const addresses = indices.map((e) => epochPda(config.mint, e, config.programId));
  const datas = await multipleAccounts(connection, addresses);

  return Promise.all(
    indices.map(async (index, i) => {
      const data = datas[i];
      if (data == null) return { index, posted: false, address: addresses[i].toBase58() };
      const decoded = await decodeEpoch(data);
      return { ...decoded, posted: true, address: addresses[i].toBase58() };
    }),
  );
}

/**
 * Which page the reader is on. Module state on purpose.
 *
 * The minute refresh calls `renderEpochs` again with fresh rows. Holding this
 * in the caller would mean either threading it through every call site or
 * resetting to page 1 every sixty seconds, which would yank a reader off page 3
 * while they were reading it.
 */
let currentPage = 0;

// Day 0 held in module state, like `currentPage`, so a pager step keeps it
// without every call site threading it back through.
let day0State = null;

export function renderEpochs(tbody, epochs, config, { pager = null, emptyNote = null, day0 = null } = {}) {
  day0State = day0;
  tbody.replaceChildren();

  if (epochs.length === 0) {
    // Day 0 predates the first on-chain epoch, so before any epoch settles it
    // is the only row the record has — and it IS a paid day, so it shows here
    // rather than under the "nothing yet" note.
    if (day0) {
      tbody.append(day0Row(day0, config));
      if (pager) renderPager(pager, pageOf([], 0), tbody, config);
      return;
    }
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'pending';
    // Before the first settled day this is the only thing in the section, so
    // it has to answer "is this broken, am I early, or did something go
    // wrong?" — see firstRecordNote in clocks.js.
    td.textContent =
      emptyNote ?? 'No days yet. The first is settled at the first 00:00 UTC after launch.';
    tr.append(td);
    tbody.append(tr);
    if (pager) renderPager(pager, pageOf([], 0), tbody, config);
    return;
  }

  const view = pageOf(epochs, currentPage);
  currentPage = view.page;

  for (const epoch of view.rows) {
    tbody.append(epochRow(epoch, config));
  }

  // Day 0 is older than every epoch, so it sits at the bottom of the last page.
  if (day0 && view.page >= view.totalPages - 1) {
    tbody.append(day0Row(day0, config));
  }

  if (pager) renderPager(pager, view, tbody, config, epochs);
}

/**
 * The record row for the genesis honor — the span between coin creation and
 * genesis that no on-chain epoch covers (paid from the creator-fee share,
 * receipts in the dialog). Its Day cell reads "Genesis" rather than "Day 0":
 * it IS this coin's day zero — which is why the settled days above it start at
 * Day 1, see dayNumber() in history.js — but it is not an epoch, and a bare
 * number in this column would invite a reader to look for an Epoch account and
 * a directory that do not exist for it. It has no merkle root either, and the
 * fingerprint cell says exactly that rather than faking one.
 */
function day0Row(day0, config) {
  const tr = document.createElement('tr');
  tr.classList.add('day0-row');

  const cell = (child, className) => {
    const td = document.createElement('td');
    if (className) td.className = className;
    if (typeof child === 'string') td.textContent = child;
    else td.append(child);
    tr.append(td);
    return td;
  };

  cell('Genesis', 'mono day-cell');
  cell(`${formatSol(day0.allocateLamports)} SOL`, 'mono num paid-cell')
    .title = exactTitle(day0.allocateLamports);
  cell(String(day0.paidCount), 'mono num');

  // Day 0's shares come from day0.json's own standings, which app.js has
  // already read — no tree.json exists for a day that was never an epoch.
  const largest = document.createElement('span');
  if (day0.largestLamports == null) {
    largest.className = 'pending';
    largest.textContent = '—';
  } else {
    largest.textContent = `${formatSolShort(day0.largestLamports)} SOL`;
    largest.title = exactTitle(day0.largestLamports);
  }
  cell(largest, 'mono num');

  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'button row-button';
  details.textContent = 'Details';
  details.setAttribute('aria-haspopup', 'dialog');
  details.setAttribute('aria-label', 'Details for the genesis payout');
  details.dataset.epochDetails = 'day0';
  details.addEventListener('click', () => openDay0Details(config));
  cell(details);

  return tr;
}

/**
 * Previous / next, and where the reader is.
 *
 * The position is spelled out ("Days 11–20 of 30") rather than "Page 2 of 3",
 * because the row a reader is looking for is a day, not a page number.
 */
function renderPager(node, view, tbody, config, epochs = []) {
  node.replaceChildren();
  node.hidden = !view.needed;
  if (!view.needed) return;

  const step = (delta) => {
    currentPage = view.page + delta;
    renderEpochs(tbody, epochs, config, { pager: node, day0: day0State });
    // Keep the reader at the table rather than wherever the page happened to
    // be scrolled after the rows changed height.
    tbody.closest('table')?.scrollIntoView({ block: 'nearest' });
  };

  const button = (label, delta, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'button pager-button';
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener('click', () => step(delta));
    return b;
  };

  const position = document.createElement('p');
  position.className = 'note pager-position';
  position.setAttribute('aria-live', 'polite');
  position.textContent = `Days ${view.first}–${view.last} of ${view.count}`;

  node.append(
    button('Previous', -1, view.page === 0),
    position,
    button('Next', 1, view.page >= view.totalPages - 1),
  );
}

function epochRow(epoch, config) {
  const tr = document.createElement('tr');

  const cell = (child, className) => {
    const td = document.createElement('td');
    if (className) td.className = className;
    if (typeof child === 'string') td.textContent = child;
    else td.append(child);
    tr.append(td);
    return td;
  };

  // The day number, not the epoch index — see dayNumber() in history.js. The
  // index is still what this row's Details button carries, because that is how
  // the account and the published directory are addressed.
  cell(dayLabel(epoch.index), 'mono day-cell');

  if (!epoch.posted) {
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'pending';
    td.textContent = 'not posted';
    tr.append(td);
    tr.classList.add('unposted');
    return tr;
  }

  cell(`${formatSol(epoch.claimedLamports)} SOL`, 'mono num paid-cell')
    .title = exactTitle(epoch.claimedLamports);
  cell(String(epoch.leafCount), 'mono num');
  cell(largestCell(epoch, config), 'mono num');

  // D2's check has no column of its own now, but an undersized bitmap means
  // somebody cannot be paid — too loud to leave to a dialog nobody opens.
  if (!isZeroRoot(epoch) && !bitmapIsSized(epoch)) {
    const warn = document.createElement('strong');
    warn.className = 'warn';
    warn.textContent = '⚠️ bitmap too small for leaf_count — some leaves cannot be claimed';
    tr.firstElementChild.append(' ', warn);
  }

  // One button, not a row of links. The links, the posting time and the payee
  // list all live behind it — a cell that carried them inline made the widest
  // column of the table the one carrying the least information per pixel, and
  // the list of who was paid had nowhere to go at all.
  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'button row-button';
  details.textContent = 'Details';
  details.setAttribute('aria-haspopup', 'dialog');
  details.setAttribute('aria-label', `Details for day ${dayNumber(epoch.index)}`);
  // How the dialog hands focus back. Not the element reference itself: the
  // minute refresh rebuilds this row, and returning focus to a detached button
  // is the same as dropping it at the top of the document.
  details.dataset.epochDetails = String(epoch.index);
  details.addEventListener('click', () => openEpochDetails(epoch, config));
  cell(details);

  return tr;
}

// ── largest share ───────────────────────────────────────────────────────
//
// The one column that is not on chain: the biggest single allocation that day,
// which only the published `tree.json` knows. It is filled in after the row is
// drawn rather than blocking the table on a fetch per row — the rest of the
// row is chain data and must not wait on a file of ours to appear.

/**
 * Epoch index → the largest leaf, or null when there is no published tree.
 *
 * Cached for the life of the page and never invalidated, because a settled
 * epoch's tree is immutable: the root for it is posted on chain, so a tree
 * that changed would no longer hash to the day it belongs to.
 */
const largestCache = new Map();

function largestCell(epoch, config) {
  const span = document.createElement('span');

  if (largestCache.has(epoch.index)) {
    renderLargest(span, largestCache.get(epoch.index));
    return span;
  }

  span.className = 'pending';
  span.textContent = '…';
  readLargest(epoch.index, config).then((largest) => {
    largestCache.set(epoch.index, largest);
    // The minute refresh may have replaced this cell while the fetch was in
    // flight. That render reads the cache, which is now warm, so dropping the
    // result here loses nothing.
    if (span.isConnected) renderLargest(span, largest);
  });
  return span;
}

function renderLargest(span, largest) {
  if (largest == null) {
    span.className = 'pending';
    // Not "0 SOL": a day we have not read the working for is a different fact
    // from a day that allocated nothing to anybody.
    span.textContent = '—';
    span.title = 'No published working for this day yet, so the shares in it are not known here.';
    return;
  }
  span.className = '';
  span.textContent = `${formatSolShort(largest)} SOL`;
  span.title = exactTitle(largest);
}

async function readLargest(index, config) {
  const url = snapshotUrl(config, index, 'tree.json');
  if (!url) return null;
  try {
    const answer = await fetch(url, { cache: 'no-store' });
    return answer.ok ? largestShare(await answer.json()) : null;
  } catch {
    // A day whose working cannot be read is reported as unread, not as empty.
    return null;
  }
}

/**
 * The hero's "total distributed to date". Derived, and labelled as derived.
 *
 * `extraLamports` is day 0 — paid from the creator-fee share before the first
 * on-chain epoch existed, receipted at /snapshots/day0/. It is part of what
 * holders have been paid, so the headline includes it.
 */
export function renderTotals(node, epochs, extraLamports = 0n) {
  const total = totalClaimed(epochs) + extraLamports;
  field(node, {
    // Four decimals on screen, the exact figure on hover — the same pairing
    // every other headline amount uses. The table rows below stay at full
    // precision, because those are the numbers people reconcile against.
    value: `${formatSolShort(total)} SOL`,
    title: exactTitle(total),
    source: SOURCES.derived,
  });
}
