// "Your position" — the address calculator (Phase 07 §7.2 item 2).
//
// The most-used thing on the site, and treated as the product rather than a
// widget. Paste any address, no wallet connection, and get an answer derived
// in this browser from chain history plus a published snapshot.
//
// The callout lookup goes **from the visitor's browser straight to pump.fun**,
// not proxied through us (§7.8). That is what makes this a verification tool
// rather than a dashboard: the confirmation that a callout exists does not
// depend on our snapshot being right.

import { computeHold, computeLocked, TimelineError } from '../../scripts/lib/timeline.mjs';
import { lockoutWindow } from '../../scripts/lib/epoch.mjs';
import { calloutTime, countable, fetchWalletCallouts, isForMint } from '../../scripts/lib/callouts.mjs';
import { LOCKOUT_EPOCHS, MINT_DECIMALS } from '../../scripts/lib/config.mjs';

import {
  allTokenAccounts,
  balanceEventsFor,
  currentBalanceRaw,
  tokenProgramForMint,
} from './chain.js';
import { associatedTokenAddress, lpMint } from './addresses.js';
import { explorerUrl, snapshotUrl } from './config.js';
import { DELIVERY, describeDelivery, loadPayoutTrail, payoutHistory, projectedShare } from './payouts.js';
import { exactTitle, formatSolShort, formatTokens, standingFor, utcDate } from './standing.js';
import { addressNode, escapeHtml, failure, field, row, SOURCES } from './ui.js';

/** SOL, short enough to scan. Always paired with `exactTitle` on the element. */
const solText = (lamports) => `${formatSolShort(lamports)} SOL`;

/** Base58 is 32–44 chars from a fixed alphabet. Reject before spending an RPC call. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeAddress(value) {
  return BASE58.test(value.trim());
}

/**
 * Everything the standing needs, fetched concurrently where it is safe to.
 *
 * The callout lookup is allowed to fail on its own without taking the chain
 * reads with it — holdings are still worth showing, and `callout.checked`
 * false produces an honest "could not check" rather than "no callout".
 */
export async function loadPosition({
  connection, config, address, window: epochWindow, now,
  settledEpochs = [], poolLamports = 0n, minHoldRaw = null,
}) {
  const tokenProgram = await tokenProgramForMint(connection, config.mint);
  const ata = associatedTokenAddress(address, config.mint, tokenProgram);

  const lockout = lockoutWindow(epochWindow, LOCKOUT_EPOCHS);

  const [currentRaw, accounts, events, calloutResult, trail] = await Promise.all([
    currentBalanceRaw(connection, ata),
    allTokenAccounts(connection, address, config.mint, tokenProgram),
    // L16 — the same LP mint the crank derives, from the same pure function,
    // so this page and the settlement job cannot disagree about whether a
    // wallet supplied liquidity or sold.
    balanceEventsFor(connection, ata, lockout.start, { lpMint: lpMint(config.mint) }),
    loadCallouts({ config, address, window: epochWindow }),
    // The audit trail. Fetched, not trusted — these are the same files a
    // stranger checks the epoch with. Failure here must not cost the holder
    // their holdings view, so `loadPayoutTrail` resolves rather than throws.
    loadPayoutTrail({
      epochFileUrl: (epoch, file) => snapshotUrl(config, epoch, file),
      epochs: settledEpochs,
    }).catch(() => []),
  ]);

  const held = computeHold(events, epochWindow, { currentBalance: currentRaw });
  // `computeLocked`, not `decreasesIn` — it is the one that applies L16's
  // exemption. Calling `decreasesIn` here would have this page tell a holder
  // they are locked out while the crank pays them, which is a worse failure
  // than either answer alone: the page exists to be checkable against the
  // settlement, and a page that disagrees with it is a page nobody can use.
  // L22 — the floor is passed so this page and the settlement job cannot
  // disagree about whether a decrease was a sale. `minHoldRaw` comes from the
  // on-chain config, so a deployment running a different floor locks on its own.
  const { locked, decreases, lpDeposits, belowFloor } = computeLocked(events, lockout, {
    minHold: minHoldRaw,
  });

  const payouts = payoutHistory(trail, address.toBase58 ? address.toBase58() : String(address));
  // The basis for today is the newest settled tree the wallet appears in.
  const newest = [...trail].sort((a, b) => b.epoch - a.epoch)[0] ?? null;

  return {
    payouts,
    projected: projectedShare({
      previousTree: newest?.tree ?? null,
      wallet: address.toBase58 ? address.toBase58() : String(address),
      poolLamports,
    }),
    ata: ata.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    accounts,
    currentRaw,
    held,
    events,
    lockout: {
      locked,
      // L22 — dated from the drop that actually locked, not from any decrease.
      // Keying these off `decreases` would print a lockout date for a wallet
      // that only trimmed its position and is not locked at all.
      lastDecreaseAt: belowFloor.length > 0 ? belowFloor[belowFloor.length - 1].blockTime : null,
      // The lockout runs from the epoch after the drop, so it lifts at the
      // start of the epoch LOCKOUT_EPOCHS after the one it fell in.
      liftsAt: belowFloor.length > 0 ? liftsAt(belowFloor[belowFloor.length - 1], epochWindow) : null,
      decreases,
      // The subset that crossed the floor — what "locked" is actually about.
      belowFloor,
      // Kept so the page can say *why* a wallet whose balance visibly dropped
      // is not locked out. Without it the exemption looks like a bug to the one
      // person best placed to report it.
      lpDeposits,
    },
    callout: calloutResult,
    now,
  };
}

// The epoch length comes from the window rather than from a constant: it is an
// `initialize` argument, so a deployment running short epochs lifts its lockout
// proportionally sooner. Same reason `lockoutWindow` derives it that way.
function liftsAt(decrease, epochWindow) {
  const epochSeconds = epochWindow.end - epochWindow.start;
  const epochsAgo = Math.floor((epochWindow.start - decrease.blockTime) / epochSeconds);
  return epochWindow.start + (LOCKOUT_EPOCHS - epochsAgo) * epochSeconds;
}

/**
 * One wallet's callouts, asked of pump.fun directly.
 *
 * `countable` and the window test are the same functions the crank applies
 * (L2, L7), so "does this count?" is answered here exactly as it will be
 * answered at settlement — not approximated for display.
 */
async function loadCallouts({ config, address, window: epochWindow }) {
  if (config.calloutApiKey == null) {
    return { checked: false, lastAt: null, activeInWindow: false, reason: 'no-api-key' };
  }

  try {
    const records = await fetchWalletCallouts(address, { apiKey: config.calloutApiKey });
    const forMint = records.filter((r) => isForMint(r, config.mint));
    const usable = forMint.filter(countable);

    const times = usable.map(calloutTime);
    const inWindow = times.some((t) => t >= epochWindow.start && t < epochWindow.end);

    return {
      checked: true,
      lastAt: times.length > 0 ? Math.max(...times) : null,
      activeInWindow: inWindow,
      total: usable.length,
      excluded: forMint.length - usable.length,
    };
  } catch (error) {
    return { checked: false, lastAt: null, activeInWindow: false, reason: error.message };
  }
}

/** Render a loaded position into the page. */
export function renderPosition(nodes, loaded, { config, minHoldRaw, window: epochWindow, settlement }) {
  const standing = standingFor({
    now: loaded.now,
    currentRaw: loaded.currentRaw,
    // L20 — the floor is checked against `sustained`, not the prorated weight.
    // Passing `hold` here told a wallet that bought 500,000 tokens at 20:00 it
    // was "below the minimum" on a number the proration had already reduced to
    // 83,000 — excluding exactly the holders L20 exists to include.
    holdRaw: loaded.held.sustained ?? loaded.held.hold,
    minHoldRaw,
    callout: loaded.callout,
    lockout: loaded.lockout,
    window: epochWindow,
    settlement,
  });

  nodes.result.hidden = false;
  nodes.result.className = `standing standing-${standing.severity}`;

  nodes.headline.textContent = standing.headline;

  nodes.detail.replaceChildren();
  for (const line of standing.detail) {
    const li = document.createElement('li');
    li.textContent = line;
    nodes.detail.append(li);
  }

  const table = nodes.facts;
  table.replaceChildren();

  const holdCell = document.createElement('span');
  field(holdCell, {
    value: `${formatTokens(loaded.held.hold, MINT_DECIMALS)} CALLPOOL`,
    source: SOURCES.derived,
  });
  table.append(
    row(
      'lowest balance today',
      holdCell,
      'The lowest you held for as long as you held it. The floor is checked against this.',
    ),
  );

  const nowCell = document.createElement('span');
  field(nowCell, {
    value: `${formatTokens(loaded.currentRaw, MINT_DECIMALS)} CALLPOOL`,
    source: SOURCES.chain,
  });
  table.append(row('balance now', nowCell));

  // Only shown when proration actually reduced the weight — i.e. the wallet
  // bought partway through today. For everyone who held the whole day the two
  // numbers are identical and a second row saying so would be noise.
  // L21 — the weight can now differ from the floor number in BOTH directions:
  // below it for a wallet that bought partway through, above it for one that
  // topped up. Shown whenever they differ, because a number that decides money
  // and is not on screen is a number nobody can check.
  const sustained = loaded.held.sustained ?? loaded.held.hold;
  if (loaded.held.hold !== sustained) {
    const shareCell = document.createElement('span');
    const toppedUp = loaded.held.hold > sustained;
    const hours = Math.max(0, Math.round((loaded.held.heldSeconds ?? 0) / 360) / 10);
    field(shareCell, {
      value: `${formatTokens(loaded.held.hold, MINT_DECIMALS)} CALLPOOL`,
      source: SOURCES.derived,
    });
    table.append(row(
      'counted for today’s split',
      shareCell,
      toppedUp
        ? 'Higher than your lowest balance because you added to your position today. ' +
          'The extra counts from the moment it landed — not for the hours before it.'
        : `You have held for about ${hours}h of today, so today’s share is scaled to that. ` +
          'Hold through a full day and the two numbers above match.',
    ));
  }

  // §7.2: "if you sell now, this becomes X" — the single most useful line on
  // the page, and the one that stops a lockout being discovered by losing a
  // week to it.
  const sellCell = document.createElement('span');
  sellCell.className = 'warn';
  // L22 — what actually happens depends on where a sale would leave the wallet,
  // so say that rather than the old blanket "any sale locks you out".
  sellCell.textContent = loaded.lockout.locked
    ? 'Already locked out — a further sale does not extend it, but it does not shorten it either.'
    : `selling down to at least the minimum only lowers today’s share to whatever you keep. ` +
      `Going UNDER the minimum earns nothing for ${LOCKOUT_EPOCHS} days, starting tomorrow.`;
  table.append(row('if you sell any amount now', sellCell));

  // ── what is definitely owed ──────────────────────────────────────────────
  // Facts, from the published audit trail. Every figure here is already
  // settled: a root was posted, the working was published, and either the
  // money moved or it did not.
  const payouts = loaded.payouts;
  if (payouts && payouts.rows.length > 0) {
    // Withheld stays in the table and never becomes a tile, because it is not
    // a balance. A wallet that sold below the floor is not owed that money —
    // it stayed in the pool for everyone else — and giving it the same
    // prominence as "owed" would read as a claim on other holders' funds.
    if (payouts.refused > 0n) {
      const refusedCell = document.createElement('span');
      field(refusedCell, { value: solText(payouts.refused), source: SOURCES.snapshot });
      refusedCell.title = exactTitle(payouts.refused);
      table.append(row(
        'allocated but withheld',
        refusedCell,
        'This wallet held less than the floor when those days paid out, so its share stayed in the pool. This is not owed to you.',
      ));
    }
  }

  // ── what today might pay ─────────────────────────────────────────────────
  // Deliberately separated from everything above, and deliberately vaguer.
  // Today has not settled: the eligible set is not known and no amount exists
  // yet. The figure is the last settled day's share of the pool applied to the
  // pool now — a basis, not a forecast — and it is absent entirely when there
  // is nothing to base it on, because inventing one would be the return
  // framing this site does not do.
  const ataCell = addressNode(loaded.ata, { href: explorerUrl(config, 'address', loaded.ata) });
  table.append(
    row('the account being read', ataCell, 'Only this associated token account counts.'),
  );

  if (loaded.accounts.length > 1) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = `This wallet has ${loaded.accounts.length} token accounts for CALLPOOL. Only the associated one above counts — tokens in the others earn nothing.`;
    table.append(row('⚠️ multiple token accounts', warn));
  }

  const calloutCell = document.createElement('span');
  field(calloutCell, {
    value: loaded.callout.checked
      ? loaded.callout.activeInWindow
        ? 'yes — callout or update on record today'
        : loaded.callout.lastAt
          ? `no — last was ${utcDate(loaded.callout.lastAt)}`
          : 'no callout found'
      : null,
    source: SOURCES.pumpfun,
    unavailable: loaded.callout.checked ? null : 'could not check — asked pump.fun and got no answer',
  });
  table.append(row('called out today?', calloutCell, 'A call does not carry over to the next day.'));

  if (loaded.lockout.locked) {
    const lockCell = document.createElement('span');
    lockCell.className = 'warn';
    lockCell.textContent = loaded.lockout.liftsAt
      ? `until ${utcDate(loaded.lockout.liftsAt)}`
      : `${LOCKOUT_EPOCHS} days from the decrease`;
    table.append(row('locked out', lockCell, 'Buying back does not shorten it.'));
  }

  renderTiles(nodes.tiles, loaded);
  renderDays(nodes.days, nodes.dayRows, loaded.payouts);

  return standing;
}

/**
 * The three figures a holder came for, above everything else.
 *
 * Only ever three, and each is absent rather than zero when there is nothing
 * to say: a tile reading `0 SOL` asserts that nothing is owed, which is a
 * different claim from having no settled history to look at.
 *
 * **Amber is reserved for money that is actually stuck.** It used to fire on
 * `owed > 0`, which painted the ordinary "settled today, the airdrop runs
 * after the challenge window" state as a fault — the single most common state
 * there is. Now only `needsAttention` (a recorded airdrop *failure*) is amber.
 */
function renderTiles(container, loaded) {
  if (!container) return;
  container.replaceChildren();

  const payouts = loaded.payouts;
  const settled = payouts && payouts.rows.length > 0;
  const tiles = [];

  if (settled) {
    tiles.push({
      label: 'Paid so far',
      lamports: payouts.paid,
      note: 'Delivered on settled days.',
    });
    tiles.push({
      label: 'Owed',
      lamports: payouts.owed,
      warn: payouts.needsAttention,
      note: payouts.needsAttention
        ? 'An airdrop failed. It stays claimable — nobody has to do anything for it to remain yours.'
        : payouts.owed > 0n
          ? 'Allocated and not yet sent. The airdrop runs after the challenge window.'
          : 'Every settled day has paid out or correctly withheld.',
    });
  }

  if (loaded.projected) {
    tiles.push({
      label: 'Estimated today',
      lamports: loaded.projected.indicative,
      approximate: true,
      note: `Not owed and not promised — today has not settled. Your share of day ${loaded.projected.basisEpoch}, applied to the pool as it stands now.`,
    });
  }

  container.hidden = tiles.length === 0;
  if (tiles.length === 0) return;

  for (const tile of tiles) {
    const item = document.createElement('div');
    item.className = tile.warn ? 'tile tile-warn' : 'tile';

    const dt = document.createElement('dt');
    dt.textContent = tile.label;

    const dd = document.createElement('dd');
    dd.className = 'tile-value';
    dd.textContent = `${tile.approximate ? '≈ ' : ''}${solText(tile.lamports)}`;
    // Short for reading, exact for checking. Never one without the other.
    dd.title = exactTitle(tile.lamports);

    const note = document.createElement('p');
    note.className = 'tile-note';
    note.textContent = tile.note;

    item.append(dt, dd, note);
    container.append(item);
  }
}

/**
 * The per-day history, as its own block rather than more table rows.
 *
 * Appended to the facts table it read as further properties of the wallet —
 * "day 2" sitting between "balance now" and "the account being read" — when it
 * is a list of days and wants a heading saying so.
 */
function renderDays(section, tbody, payouts) {
  if (!section || !tbody) return;
  tbody.replaceChildren();

  const rows = payouts?.rows ?? [];
  section.hidden = rows.length === 0;
  if (rows.length === 0) return;

  for (const entry of rows.slice(0, 7)) {
    const dayCell = document.createElement('span');
    // Only a mechanical failure is a warning. A refusal is the mechanic
    // working and a pending day is simply early.
    if (entry.state === DELIVERY.failed) dayCell.className = 'warn';
    dayCell.textContent = describeDelivery(entry, solText);
    dayCell.title = exactTitle(entry.amount);
    tbody.append(row(`day ${entry.epoch}`, dayCell));
  }
}

/** The failure path, kept separate so a partial answer is never dressed up. */
export function renderPositionFailure(nodes, error) {
  nodes.result.hidden = false;
  failure(nodes.result, {
    what:
      error instanceof TimelineError
        ? 'This wallet’s history could not be read completely.'
        : 'Could not reach the chain.',
    consequence:
      error instanceof TimelineError
        ? 'A gap in the history would produce a hold that is plausibly wrong rather than obviously wrong, so nothing is shown instead. Reload, or try a different RPC.'
        : 'No number is shown, because a wrong number here is worse than no number.',
    error,
  });
}
