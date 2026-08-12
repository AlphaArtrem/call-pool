// One day, in full — the dialog behind the record table's "Details" button.
//
// The row is a summary; this is the whole day. It restates every figure in the
// row (so the dialog can be read without the row behind it), adds the two links
// that let a stranger check it, and then answers the question the table never
// could: **who was paid, and how much.**
//
// Provenance is the point, so the two halves are kept visibly apart:
//
//   * the figures from the row are read from the on-chain Epoch account by the
//     visitor's own browser — the chain badge;
//   * the payee list is read from that day's published `tree.json` and
//     `airdrop.json` — the snapshot badge, because we wrote those files.
//
// The list is fetched through `loadPayoutTrail`, the same loader the wallet
// panel uses, so this dialog and a holder's own page cannot disagree about
// whether they were paid.

import { explorerUrl, snapshotUrl } from './config.js';
import { dayLabel, dayNumber } from './history.js';
import { bitmapIsSized, isZeroRoot, rootHex } from './program.js';
import { DELIVERY, epochPayouts, loadPayoutTrail, payoutTotals } from './payouts.js';
import { exactTitle, formatSol, utcTime } from './standing.js';
import { addressNode, field, row, SOURCES } from './ui.js';

/**
 * The one dialog element, reused.
 *
 * A dialog per row would leave a stack of them in the document after the
 * minute refresh rebuilt the table under it, and `showModal` on a detached
 * element does nothing at all — which is exactly the failure that looks like a
 * dead button.
 */
let dialog = null;

/** Which day is on screen, so a late fetch cannot fill in the wrong one. */
let showing = null;

export function openEpochDetails(epoch, config) {
  showing = epoch.index;
  const node = ensureDialog();
  node.replaceChildren(header(epoch), facts(epoch, config), links(epoch, config), payeesSection());
  node.showModal();
  loadPayees(epoch, config);
}

/**
 * Day 0 in full — the span from coin creation to genesis that no on-chain
 * epoch covers. It reuses this dialog so a holder reads day 0 the same way
 * they read every other day, but its figures and payee list come from the
 * published day-0 files (`day0.json`, `receipts.json`) rather than from a
 * chain account and a `tree.json`, because there is no epoch account to read.
 */
export async function openDay0Details(config) {
  showing = 'day0';
  const node = ensureDialog();
  node.replaceChildren(day0Header(), state('reading the day-0 receipts…', 'pending'));
  node.showModal();

  const base = config.snapshotsBase;
  let day0 = null;
  let receipts = [];
  try {
    const [d, r] = await Promise.all([
      fetch(`${base}/day0/day0.json`).then((res) => (res.ok ? res.json() : null)),
      fetch(`${base}/day0/receipts.json`).then((res) => (res.ok ? res.json() : [])),
    ]);
    day0 = d;
    receipts = Array.isArray(r) ? r : [];
  } catch {
    day0 = null;
  }

  // Closed, or another day opened, while the fetch was in flight.
  if (showing !== 'day0') return;

  if (!day0) {
    node.replaceChildren(
      day0Header(),
      state('The day-0 receipts could not be read just now. They are also published at /snapshots/day0/.', 'note'),
    );
    return;
  }
  node.replaceChildren(day0Header(), day0Facts(day0), day0Payees(day0, receipts, config));
}

function day0Header() {
  const head = document.createElement('div');
  head.className = 'epoch-dialog-head';

  const title = document.createElement('h2');
  title.id = 'epoch-dialog-title';
  title.className = 'epoch-dialog-title display';
  title.textContent = 'Genesis';

  const when = document.createElement('p');
  when.className = 'note';
  when.textContent =
    'The coin launched at 16:52 UTC; the first full epoch opened at midnight. ' +
    'Genesis callers were paid at 00:00 UTC from the creator-fee share — same rules, same math as every day.';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'epoch-dialog-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => dialog.close());

  const text = document.createElement('div');
  text.append(title, when);
  head.append(text, close);
  return head;
}

/** Day 0's figures, badged as snapshot because they come from files we wrote. */
function day0Facts(day0) {
  const table = document.createElement('table');
  table.className = 'facts';
  const body = document.createElement('tbody');
  table.append(body);

  const snap = (value, title = null) => {
    const span = document.createElement('span');
    field(span, { value, title, source: SOURCES.snapshot });
    return span;
  };
  const pot = BigInt(day0.potLamports ?? day0.allocateLamports);
  const allocated = BigInt(day0.allocateLamports);
  const paid = day0.standings.filter((s) => s.lamports).length;

  body.append(
    row('Window', text(`${isoMinute(day0.window.start)} → ${isoMinute(day0.window.end)} UTC`)),
    row('Pot', snap(`${formatSol(pot)} SOL`, exactTitle(pot))),
    row('Callers', snap(String(day0.standings.length))),
    row('Paid', snap(`${paid} wallet${paid === 1 ? '' : 's'}, ${formatSol(allocated)} SOL`, exactTitle(allocated))),
  );
  return table;
}

function isoMinute(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Why a caller earned nothing — the same three reasons the settlement uses. */
function day0Reason(entry) {
  if (entry.eligible) return null;
  if (!entry.meetsFloor) return 'held less than the 100,000 floor';
  if (entry.locked) return 'locked — sold recently';
  return 'hold did not qualify for the window';
}

function day0Payees(day0, receipts, config) {
  const section = document.createElement('section');
  section.className = 'epoch-dialog-payees';
  const heading = document.createElement('h3');
  heading.textContent = 'Who was paid';
  section.append(heading);

  // receipts.json carries the tx signature per wallet; fall back to the
  // standings (no receipts) if it was not published.
  const source = receipts.length ? receipts : day0.standings;
  const rows = [...source].sort((a, b) => {
    const av = a.lamports ? BigInt(a.lamports) : -1n;
    const bv = b.lamports ? BigInt(b.lamports) : -1n;
    return bv > av ? 1 : bv < av ? -1 : 0;
  });

  const table = document.createElement('table');
  table.className = 'payees';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const label of ['Wallet', 'Amount', '']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    hr.append(th);
  }
  thead.append(hr);

  const body = document.createElement('tbody');
  for (const entry of rows) {
    const line = document.createElement('tr');

    const who = document.createElement('td');
    who.append(addressNode(entry.wallet, { href: explorerUrl(config, 'address', entry.wallet), responsive: true }));

    const amount = document.createElement('td');
    amount.className = 'mono num';
    amount.textContent = entry.lamports ? `${formatSol(BigInt(entry.lamports))} SOL` : '—';
    if (entry.lamports) amount.title = exactTitle(BigInt(entry.lamports));

    const last = document.createElement('td');
    const reason = day0Reason(entry);
    if (reason) {
      last.className = 'note';
      last.textContent = reason;
      line.classList.add('is-unpaid');
    } else if (entry.txSig) {
      const a = document.createElement('a');
      a.href = explorerUrl(config, 'tx', entry.txSig);
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.textContent = 'receipt ↗';
      last.append(a);
    }

    line.append(who, amount, last);
    body.append(line);
  }
  table.append(thead, body);

  const scroll = document.createElement('div');
  scroll.className = 'payees-scroll';
  scroll.append(table);
  section.append(scroll);
  return section;
}

function ensureDialog() {
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.className = 'epoch-dialog';
  dialog.setAttribute('aria-labelledby', 'epoch-dialog-title');
  // Clicking the backdrop is the gesture everyone tries first. The target is
  // the dialog itself only when the click landed outside its content box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    // Focus goes back to the row that opened it, found by index rather than by
    // reference — see the note on `data-epoch-details` in epochs.js. The
    // browser's own restoration cannot help here, because the button it would
    // restore to may have been replaced by the minute refresh.
    const opener = document.querySelector(`[data-epoch-details="${showing}"]`);
    showing = null;
    opener?.focus();
  });
  document.body.append(dialog);
  return dialog;
}

function header(epoch) {
  const head = document.createElement('div');
  head.className = 'epoch-dialog-head';

  const title = document.createElement('h2');
  title.id = 'epoch-dialog-title';
  title.className = 'epoch-dialog-title display';
  title.textContent = dayLabel(epoch.index);

  const when = document.createElement('p');
  when.className = 'note';
  when.textContent = epoch.posted
    ? `Settled and posted on chain at ${utcTime(epoch.postedTs)}.`
    : 'Never settled. A skipped day stays postable, so this one is still open.';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'epoch-dialog-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => dialog.close());

  const text = document.createElement('div');
  text.append(title, when);
  head.append(text, close);
  return head;
}

/** Every figure the row shows, plus the two it has no column for. */
function facts(epoch, config) {
  const table = document.createElement('table');
  table.className = 'facts';
  const body = document.createElement('tbody');
  table.append(body);

  if (!epoch.posted) {
    body.append(row('Status', text('This day was never settled, so it has no pool, no tree and no payees.')));
    return table;
  }

  const chain = (value, title = null) => {
    const span = document.createElement('span');
    field(span, { value, title, source: SOURCES.chain });
    return span;
  };

  body.append(
    row('Pool that day', chain(`${formatSol(epoch.poolLamports)} SOL`, exactTitle(epoch.poolLamports))),
    row('Callers', chain(String(epoch.leafCount))),
    row('Paid out', chain(`${formatSol(epoch.claimedLamports)} SOL`, exactTitle(epoch.claimedLamports))),
    row(
      'Unclaimed',
      chain(
        `${formatSol(epoch.poolLamports - epoch.claimedLamports)} SOL`,
        exactTitle(epoch.poolLamports - epoch.claimedLamports),
      ),
    ),
    row('Fingerprint', fingerprint(epoch)),
    row(
      'Epoch account',
      addressNode(epoch.address, {
        href: explorerUrl(config, 'address', epoch.address),
        responsive: true,
      }),
      // Days are numbered from one and epochs from zero (history.js), so the
      // reader who goes to check this account finds it filed under a number
      // one below the heading above. Better said here than discovered there.
      `Day ${dayNumber(epoch.index)} is on-chain epoch ${epoch.index}: epochs are counted from zero, ` +
        `days from one. This account and the published working are both addressed as ${epoch.index}.`,
    ),
  );

  return table;
}

/**
 * The merkle root, and D2's check run in the reader's browser.
 *
 * Same two states the table cell shows, because the dialog is meant to be
 * readable on its own and an undersized bitmap is the one thing here that
 * means somebody cannot be paid.
 */
function fingerprint(epoch) {
  const wrap = document.createElement('span');
  if (isZeroRoot(epoch)) {
    wrap.className = 'pending';
    wrap.textContent = 'nobody called out that day';
    return wrap;
  }

  wrap.append(addressNode(rootHex(epoch), { responsive: true }));
  if (!bitmapIsSized(epoch)) {
    const warn = document.createElement('strong');
    warn.className = 'warn';
    warn.textContent = ' ⚠️ bitmap too small for leaf_count — some leaves cannot be claimed';
    wrap.append(warn);
  }
  return wrap;
}

/** The published directory and the account, as buttons rather than fine print. */
function links(epoch, config) {
  const wrap = document.createElement('p');
  wrap.className = 'epoch-dialog-links';

  const dir = snapshotUrl(config, epoch.index);
  if (dir && epoch.posted) {
    const a = document.createElement('a');
    a.className = 'button';
    a.href = dir;
    a.textContent = 'Published working';
    // The directory is named for the epoch index, which is one below the day
    // number (history.js). Saying both here is what stops "Day 3" opening
    // `epoch-2/` from reading as the wrong day's working.
    a.title = `Everything needed to reproduce day ${dayNumber(epoch.index)}, published as epoch-${epoch.index}: callouts.json, balances.json, pool.json, tree.json, carry.json, payouts.csv`;
    wrap.append(a);
  }

  const account = explorerUrl(config, 'address', epoch.address);
  if (account) {
    const a = document.createElement('a');
    a.className = 'button';
    a.href = account;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    a.textContent = 'Epoch account on the explorer';
    wrap.append(a);
  }

  return wrap;
}

function payeesSection() {
  const section = document.createElement('section');
  section.className = 'epoch-dialog-payees';

  const heading = document.createElement('h3');
  heading.textContent = 'Who was paid';
  section.append(heading, state('reading the published working…', 'pending'));
  return section;
}

/** Replace the payee section's body, leaving its heading alone. */
function setPayees(...nodes) {
  const section = dialog?.querySelector('.epoch-dialog-payees');
  if (!section) return;
  const heading = section.firstElementChild;
  section.replaceChildren(heading, ...nodes);
}

function state(message, className) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = message;
  return p;
}

function text(value) {
  const span = document.createElement('span');
  span.textContent = value;
  return span;
}

async function loadPayees(epoch, config) {
  if (!epoch.posted) {
    setPayees(state('A day that was never settled allocated nothing, so nobody was paid.', 'note'));
    return;
  }

  // `loadPayoutTrail` resolves rather than throws, and returns nothing at all
  // for an epoch with no published `tree.json` — a real state (posted on chain,
  // directory not published yet), not a failure to report as one.
  const [entry] = await loadPayoutTrail({
    epochFileUrl: (index, file) => snapshotUrl(config, index, file),
    epochs: [epoch.index],
  });

  // The reader may have closed this, or opened another day, while the fetch
  // was in flight. Filling in now would put one day's payees under another
  // day's heading.
  if (showing !== epoch.index) return;

  if (!entry) {
    setPayees(
      state(
        'No published working for this day yet, so there is no list to show. Every figure above is read from chain either way.',
        'note',
      ),
    );
    return;
  }

  const rows = epochPayouts(entry.tree, entry.airdrop);
  if (rows.length === 0) {
    setPayees(state('Nobody called out that day, so nothing was allocated.', 'note'));
    return;
  }

  setPayees(summary(payoutTotals(rows)), payeesTable(rows, config));
}

/**
 * The totals, each labelled with what it actually is.
 *
 * "Allocated" and "delivered" are only the same number on a clean day, and the
 * two that differ — a refusal and a broken send — mean opposite things. They
 * are shown separately, and only when they are not zero, so a clean day reads
 * as clean rather than as three zeros a reader has to interpret.
 */
function summary(totals) {
  const dl = document.createElement('dl');
  dl.className = 'epoch-dialog-totals';

  const add = (label, value, title = null) => {
    // Each pair in its own wrapper — a bare dt/dd sequence in a grid lays the
    // label and its number out as two independent cells, which puts them in
    // different columns the moment one label wraps.
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    field(dd, { value, title, source: SOURCES.snapshot });
    pair.append(dt, dd);
    dl.append(pair);
  };

  add('Wallets in the tree', String(totals.wallets));
  add('Allocated', `${formatSol(totals.allocated)} SOL`, exactTitle(totals.allocated));
  add('Delivered', `${formatSol(totals.paid)} SOL`, exactTitle(totals.paid));
  if (totals.refused > 0n) {
    add('Below the minimum', `${formatSol(totals.refused)} SOL`, exactTitle(totals.refused));
  }
  if (totals.undelivered > 0n) {
    add('Still to be delivered', `${formatSol(totals.undelivered)} SOL`, exactTitle(totals.undelivered));
  }

  return dl;
}

/** What is true of a leaf that is not simply paid. Never left unsaid. */
function payeeNote(deliveryState) {
  switch (deliveryState) {
    case DELIVERY.refused:
      return 'not paid — this wallet held less than the minimum when the airdrop ran, so its share stayed in the pool';
    case DELIVERY.failed:
      return 'allocated but not delivered — still claimable until the deadline';
    case DELIVERY.pending:
      return 'allocated — the airdrop for this day has not run yet';
    default:
      return null;
  }
}

function payeesTable(rows, config) {
  const table = document.createElement('table');
  table.className = 'payees';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Wallet', 'Amount', '']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const payee of rows) {
    const line = document.createElement('tr');

    const who = document.createElement('td');
    who.append(
      addressNode(payee.owner, {
        href: explorerUrl(config, 'address', payee.owner),
        responsive: true,
      }),
    );

    const amount = document.createElement('td');
    amount.className = 'mono num';
    amount.textContent = `${formatSol(payee.amount)} SOL`;
    amount.title = exactTitle(payee.amount);

    const why = document.createElement('td');
    const note = payeeNote(payee.state);
    if (note) {
      why.className = 'note';
      why.textContent = note;
      line.classList.add('is-unpaid');
    }

    line.append(who, amount, why);
    body.append(line);
  }

  table.append(head, body);

  // Long days are long: the list scrolls inside the dialog rather than making
  // the dialog itself taller than the viewport.
  const scroll = document.createElement('div');
  scroll.className = 'payees-scroll';
  scroll.append(table);
  return scroll;
}
