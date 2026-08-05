// Epoch history — the audit trail (Phase 07 §7.2 item 4).
//
// One row per epoch: pool, callers, distributed, unclaimed, root, the
// `post_epoch_root` signature, and a link to the directory that reproduces it.
// §7.2 calls this one of the two sections a copycat cannot fake, and the
// reason is that every row is an invitation to check it.
//
// The rows are built from the on-chain Epoch accounts, not from a file we
// publish. The published directory is linked beside each row so the two can be
// compared; if they ever disagree, the chain is right and the directory is
// evidence of what we claimed.

import { decodeEpoch, bitmapIsSized, isZeroRoot, rootHex } from './program.js';
import { epochPda } from './addresses.js';
import { multipleAccounts } from './chain.js';
import { explorerUrl, snapshotUrl } from './config.js';
import { formatSol, utcTime } from './standing.js';
import { addressNode, field, SOURCES } from './ui.js';

/**
 * Read the last `count` epochs, newest first.
 *
 * A missing account is a real state — the epoch was never posted — and it is
 * rendered as such rather than skipped. A skipped epoch stays postable forever
 * (Phase 05 §5.5), so a gap in this table is a thing readers should see.
 */
export async function loadEpochs(connection, config, currentEpoch, count = 30) {
  const indices = [];
  for (let e = currentEpoch; e >= 0 && indices.length < count; e--) indices.push(e);

  const addresses = indices.map((e) => epochPda(config.programId, config.mint, e));
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

/** Total distributed across every epoch read. Derived here, never fetched. */
export function totalClaimed(epochs) {
  return epochs.reduce((sum, e) => sum + (e.posted ? e.claimedLamports : 0n), 0n);
}

export function renderEpochs(tbody, epochs, config) {
  tbody.replaceChildren();

  if (epochs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'pending';
    td.textContent = 'No days yet. The first is settled at the first 00:00 UTC after launch.';
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const epoch of epochs) {
    tbody.append(epochRow(epoch, config));
  }
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

  const links = document.createElement('span');
  links.className = 'links';

  const dir = snapshotUrl(config, epoch.index);
  if (dir) {
    const a = document.createElement('a');
    a.href = dir;
    a.textContent = 'snapshot';
    a.title = `Everything needed to reproduce epoch ${epoch.index}: callouts.json, balances.json, pool.json, tree.json, carry.json, payouts.csv`;
    links.append(a);
  }

  const account = explorerUrl(config, 'address', epoch.address);
  if (account) {
    const a = document.createElement('a');
    a.href = account;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    a.textContent = 'account';
    links.append(' · ', a);
  }

  const posted = document.createElement('span');
  posted.className = 'note';
  posted.textContent = ` posted ${utcTime(epoch.postedTs)}`;
  links.append(posted);

  cell(links);
  return tr;
}

/** The hero's "total distributed to date". Derived, and labelled as derived. */
export function renderTotals(node, epochs) {
  field(node, {
    value: `${formatSol(totalClaimed(epochs))} SOL`,
    source: SOURCES.derived,
  });
}
