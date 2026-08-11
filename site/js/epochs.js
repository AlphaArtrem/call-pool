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
import { epochIndices, totalClaimed } from './history.js';
import { openDay0Details, openEpochDetails } from './epoch-details.js';
import { pageOf } from './paging.js';
import { exactTitle, formatSol, formatSolShort } from './standing.js';
import { addressNode, field, SOURCES } from './ui.js';

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
    td.colSpan = 7;
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
 * receipts in the dialog). Its Day cell reads "Genesis", NOT "0": on this site
 * "Day 0" is on-chain epoch 0 (the first full UTC day), and dayNumber() in
 * app.js requires the Day column to match the epoch index. The genesis span is
 * a different, earlier day, so it is named rather than given a colliding
 * number. It has no merkle root because it was never an on-chain epoch, and
 * the fingerprint cell says exactly that rather than faking one.
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

  cell('Genesis', 'mono');
  cell(`${formatSol(day0.potLamports)} SOL`, 'mono num');
  cell(String(day0.paidCount), 'mono num');
  cell(`${formatSol(day0.allocateLamports)} SOL`, 'mono num');
  cell(`${formatSol(day0.potLamports - day0.allocateLamports)} SOL`, 'mono num');

  const fp = document.createElement('span');
  fp.className = 'pending';
  fp.textContent = 'paid from the creator-fee share';
  cell(fp);

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

  cell(String(epoch.index), 'mono');

  if (!epoch.posted) {
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'pending';
    td.textContent = 'not posted';
    tr.append(td);
    tr.classList.add('unposted');
    return tr;
  }

  cell(`${formatSol(epoch.poolLamports)} SOL`, 'mono num');
  cell(String(epoch.leafCount), 'mono num');
  cell(`${formatSol(epoch.claimedLamports)} SOL`, 'mono num');
  cell(`${formatSol(epoch.poolLamports - epoch.claimedLamports)} SOL`, 'mono num');

  // The root, and the two things about it a reader should be able to see at a
  // glance: whether it is the empty-epoch zero root, and whether the bitmap
  // the signer sized can actually hold every leaf (D2).
  const rootCell = document.createElement('span');
  if (isZeroRoot(epoch)) {
    rootCell.className = 'pending';
    rootCell.textContent = 'nobody called out that day';
  } else {
    rootCell.append(addressNode(rootHex(epoch), { truncate: true }));
    if (!bitmapIsSized(epoch)) {
      const warn = document.createElement('strong');
      warn.className = 'warn';
      warn.textContent = ' ⚠️ bitmap too small for leaf_count — some leaves cannot be claimed';
      rootCell.append(warn);
    }
  }
  cell(rootCell);

  // One button, not a row of links. The links, the posting time and the payee
  // list all live behind it — a cell that carried them inline made the widest
  // column of the table the one carrying the least information per pixel, and
  // the list of who was paid had nowhere to go at all.
  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'button row-button';
  details.textContent = 'Details';
  details.setAttribute('aria-haspopup', 'dialog');
  details.setAttribute('aria-label', `Details for day ${epoch.index}`);
  // How the dialog hands focus back. Not the element reference itself: the
  // minute refresh rebuilds this row, and returning focus to a detached button
  // is the same as dropping it at the top of the document.
  details.dataset.epochDetails = String(epoch.index);
  details.addEventListener('click', () => openEpochDetails(epoch, config));
  cell(details);

  return tr;
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
