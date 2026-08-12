// "Your position" — the address calculator (Phase 07 §7.2 item 2).
//
// The most-used thing on the site, and treated as the product rather than a
// widget. Paste any address, no wallet connection, and get an answer derived
// in this browser from chain history plus a published snapshot.
//
// The callout lookup was designed to go from the visitor's browser straight
// to pump.fun (§7.8) — but their API answers 403 to any request whose Origin
// is another website (measured at launch, 2026-08-10), which a browser always
// sends. So it goes through `/callouts`, a dumb relay on this site's origin
// that forwards exactly one path shape and cannot enrich what comes back
// (scripts/lib/callout-proxy.mjs). The check stays advisory either way:
// settlement pays from the published snapshots, not from this panel.

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
import { dayLabel, dayNumber } from './history.js';
import {
  DELIVERY,
  describeDelivery,
  describeEstimate,
  loadPayoutTrail,
  payoutHistory,
  projectedShare,
  sampledShare,
  withGenesis,
} from './payouts.js';
import {
  exactTitle,
  formatSolShort,
  formatTokens,
  holdFigures,
  soldWithoutCrossingFloor,
  standingFor,
  utcDate,
} from './standing.js';
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
  settledEpochs = [], poolLamports = 0n, minHoldRaw = null, provisional = null, day0 = null,
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

  const walletKey = address.toBase58 ? address.toBase58() : String(address);
  // The genesis payout has no tree to be read from, so it is folded in here
  // rather than fetched — app.js already read day0.json for the record table.
  const payouts = withGenesis(payoutHistory(trail, walletKey), day0?.paidTo?.get(walletKey) ?? null);
  // The basis for today is the newest settled tree the wallet appears in.
  const newest = [...trail].sort((a, b) => b.epoch - a.epoch)[0] ?? null;

  // Today's sample first, yesterday's ratio only if there is no sample. Both
  // are computed rather than one-or-the-other, because the renderer needs to
  // say *which* basis it used — an estimate whose provenance is invisible is
  // the kind of number this page exists not to print.
  const sampled = sampledShare({ provisional, wallet: walletKey, poolLamports });

  return {
    payouts,
    sampled,
    projected: projectedShare({
      previousTree: newest?.tree ?? null,
      wallet: walletKey,
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
    const records = await fetchWalletCallouts(address, {
      apiKey: config.calloutApiKey,
      // Same-origin relay — pump.fun 403s a browser's cross-site Origin.
      baseUrl: '/callouts',
    });
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

  // L20/L21 — `sustained` and `hold` answer different questions and must never
  // be printed as each other. `sustained` is the lowest balance held, which is
  // what the floor is tested against; `hold` is that figure prorated by how
  // much of the day it was held for, which is what the split is weighted by.
  // This row showed `hold` under a label and a hint that both describe
  // `sustained`, so a wallet that bought at 20:00 read its prorated weight as
  // its floor number — and the "counted for today's split" row below printed
  // the very same number again under a contradictory label.
  const figures = holdFigures(loaded.held);

  const holdCell = document.createElement('span');
  field(holdCell, {
    value: `${formatTokens(figures.sustained, MINT_DECIMALS)} CALLPOOL`,
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
  if (figures.differ) {
    const shareCell = document.createElement('span');
    const toppedUp = figures.hold > figures.sustained;
    const hours = Math.max(0, Math.round((loaded.held.heldSeconds ?? 0) / 360) / 10);
    field(shareCell, {
      value: `${formatTokens(figures.hold, MINT_DECIMALS)} CALLPOOL`,
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

  // L22 — the case the ruling created, and the one the page had no words for.
  // A wallet that sold while staying at or above the floor keeps earning, but
  // its whole day is counted at the reduced balance. It sees a smaller share
  // and no lockout, which reads as a bug to exactly the person best placed to
  // report it. `decreases` minus `belowFloor` is precisely this set, the same
  // way `lpDeposits` names the L18 exemption rather than leaving it to be
  // inferred from a number that quietly went down.
  const trimmed = loaded.lockout.decreases ?? [];
  if (soldWithoutCrossingFloor(loaded.lockout)) {
    const trimCell = document.createElement('span');
    trimCell.textContent =
      trimmed.length === 1
        ? `Sold on ${utcDate(trimmed[0].blockTime)} and stayed at or above the minimum, so there is no lockout.`
        : `Sold ${trimmed.length} times in the last ${LOCKOUT_EPOCHS} days and stayed at or above the minimum each time, so there is no lockout.`;
    table.append(row(
      'sold, and not locked out',
      trimCell,
      'Selling only locks you out if it takes you under the minimum. What it does cost is the day it happened on: that whole day counts at the lowest balance you were left with, not the balance you started it with.',
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
    unavailable: loaded.callout.checked ? null : 'could not check — pump.fun did not answer',
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

  renderTiles(nodes.tiles, loaded, standing);
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
 *
 * The one thing that is never simply absent is today's estimate. A missing
 * figure there was read as a broken panel rather than as "there is nothing to
 * compute one from", so every path below ends in a tile that says which.
 */
function renderTiles(container, loaded, standing = null) {
  if (!container) return;
  container.replaceChildren();

  const payouts = loaded.payouts;
  const settled = payouts && payouts.rows.length > 0;
  const tiles = [];

  // Always present, and the largest thing in the panel: "how much has this
  // wallet actually been paid" is the question people come here to ask, and a
  // tile that disappears when the answer is "none yet" reads as a panel that
  // failed to load rather than as an answer.
  tiles.push({
    label: 'Paid so far',
    lead: true,
    lamports: settled ? payouts.paid : null,
    // Never `0 SOL` — a measured zero and "no settled day has paid this wallet
    // anything yet" are different claims, and only one of them is true here.
    text: settled ? null : 'nothing yet',
    note: !settled
      ? 'No day has paid this wallet yet. Days appear here as they settle.'
      // The genesis payout is in this figure when there was one, so the note
      // has to account for it — it is not a settled day and never will be.
      : payouts.rows.some((r) => r.label)
        ? 'Delivered on settled days, and at genesis.'
        : 'Delivered on settled days.',
  });

  if (settled) {
    tiles.push({
      label: 'Owed',
      lamports: payouts.owed,
      warn: payouts.needsAttention,
      note: payouts.needsAttention
        ? 'An airdrop failed. It stays claimable — nobody has to do anything for it to remain yours.'
        : payouts.owed > 0n
          // L19 — this tile's meaning changed with the ruling. "Owed" used to
          // be an ordinary state that lasted a day, so the note only had to
          // explain that waiting was normal. Now the airdrop follows the root
          // by minutes, and an "owed" that persists is a stopped crank rather
          // than a queue. Say so: `needsAttention` only fires on a *recorded*
          // airdrop failure, so the case where the job never ran at all has no
          // other signal on the page.
          // L19 — minutes, not a day. An "owed" that outlives the hour is a
          // stopped crank, and saying so is the only signal for the case where
          // the job never ran at all.
          ? 'Allocated and not yet sent. The airdrop runs minutes after a day settles — still here in an hour means something has stalled.'
          : 'Every settled day has paid out or correctly withheld.',
    });
  }

  // The estimate, and — just as important — which basis produced it. The two
  // bases are not equally good and the difference is not visible in the
  // number, so the note names the one in use rather than letting a sixfold
  // better figure and a sixfold worse one wear the same caption.
  const sampled = loaded.sampled;
  if (sampled?.eligible && sampled.indicative != null) {
    tiles.push({
      label: 'Estimated today',
      accent: true,
      lamports: sampled.indicative,
      approximate: true,
      note: describeEstimate(sampled, loaded.now),
    });
  } else if (loaded.projected) {
    tiles.push({
      label: 'Estimated today',
      accent: true,
      lamports: loaded.projected.indicative,
      approximate: true,
      // Said plainly, because this basis is the weaker of the two: a holder
      // who bought partway through the basis day is understated by it, through
      // no fault of their own.
      note:
        `Not owed and not promised — your share of day ${dayNumber(loaded.projected.basisEpoch)}, ` +
        `applied to the pool now. Today has not been sampled yet, so this reads low ` +
        `if you held for only part of that day.`,
    });
  } else if (sampled && !sampled.eligible) {
    // The sample HAS been read and this wallet is not in today's eligible set.
    // Silence here reads as a broken panel to the one person who most needs a
    // straight answer, so the tile stays and says which of the two reasons.
    tiles.push({
      label: 'Estimated today',
      text: 'nothing yet',
      note: sampled.locked
        ? 'Locked out, so today pays this wallet nothing. See the lockout row below.'
        : !sampled.meetsFloor
          ? 'Under the minimum today, so no share of today’s split.'
          : 'No weight in today’s split yet — no callout on record, or nothing held.',
    });
  } else if (standing?.eligible !== false) {
    // Eligible, or too early to say, and there is nothing to compute an
    // estimate FROM: no hourly sample published and no settled day to lean on.
    // That is a fact about our publishing, not about this wallet, and the
    // panel says so rather than leaving a gap where a figure belongs.
    tiles.push({
      label: 'Estimated today',
      text: 'not yet',
      note:
        'Nothing to work one out from yet — today has not been sampled and no day has settled. ' +
        'Whether this wallet is earning is the standing above.',
    });
  }

  container.hidden = tiles.length === 0;
  if (tiles.length === 0) return;

  for (const tile of tiles) {
    const item = document.createElement('div');
    // `lead` is the paid figure: the same green the wall gives the pool, and a
    // size above everything else in the panel.
    item.className = ['tile', tile.lead ? 'tile-lead' : '', tile.accent ? 'tile-accent' : '',
      tile.warn ? 'tile-warn' : '']
      .filter(Boolean)
      .join(' ');

    const dt = document.createElement('dt');
    dt.textContent = tile.label;

    const dd = document.createElement('dd');
    dd.className = tile.text ? 'tile-value is-empty' : 'tile-value';
    if (tile.text) {
      // A word, not a zero. `0 SOL` here would assert that today's split
      // considered this wallet and gave it nothing.
      dd.textContent = tile.text;
    } else {
      dd.textContent = `${tile.approximate ? '≈ ' : ''}${solText(tile.lamports)}`;
      // Short for reading, exact for checking. Never one without the other.
      dd.title = exactTitle(tile.lamports);
    }

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

    // The amount is the thing being read, so it is set apart from the sentence
    // around it. `describeDelivery` still writes that sentence — asked for the
    // amount as a marker, it says where the figure goes, and the two halves are
    // rejoined around a styled node. One source of copy, one place to change it.
    const [before, after = ''] = describeDelivery(entry, () => '\u0000').split('\u0000');
    const amount = document.createElement('strong');
    amount.className = 'day-amount';
    amount.textContent = solText(entry.amount);
    amount.title = exactTitle(entry.amount);
    dayCell.append(before, amount, after);

    // `label` is the genesis payout, which is no epoch and so has no day number
    // of its own to print. Every other row is the day, not the epoch index.
    tbody.append(row(entry.label ?? dayLabel(entry.epoch), dayCell));
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
