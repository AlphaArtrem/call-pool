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

import { computeHold, decreasesIn, TimelineError } from '../../scripts/lib/timeline.mjs';
import { lockoutWindow } from '../../scripts/lib/epoch.mjs';
import { calloutTime, countable, fetchWalletCallouts } from '../../scripts/lib/callouts.mjs';
import { LOCKOUT_EPOCHS, MINT_DECIMALS } from '../../scripts/lib/config.mjs';

import {
  allTokenAccounts,
  balanceEventsFor,
  currentBalanceRaw,
  tokenProgramForMint,
} from './chain.js';
import { associatedTokenAddress } from './addresses.js';
import { explorerUrl } from './config.js';
import { formatSol, formatTokens, standingFor, utcDate } from './standing.js';
import { addressNode, escapeHtml, failure, field, row, SOURCES } from './ui.js';

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
export async function loadPosition({ connection, config, address, window: epochWindow, now }) {
  const tokenProgram = await tokenProgramForMint(connection, config.mint);
  const ata = associatedTokenAddress(address, config.mint, tokenProgram);

  const lockout = lockoutWindow(epochWindow, LOCKOUT_EPOCHS);

  const [currentRaw, accounts, events, calloutResult] = await Promise.all([
    currentBalanceRaw(connection, ata),
    allTokenAccounts(connection, address, config.mint, tokenProgram),
    balanceEventsFor(connection, ata, lockout.start),
    loadCallouts({ config, address, window: epochWindow }),
  ]);

  const held = computeHold(events, epochWindow, { currentBalance: currentRaw });
  const decreases = decreasesIn(events, lockout);

  return {
    ata: ata.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    accounts,
    currentRaw,
    held,
    events,
    lockout: {
      locked: decreases.length > 0,
      lastDecreaseAt: decreases.length > 0 ? decreases[decreases.length - 1].blockTime : null,
      // The lockout runs from the epoch after the decrease, so it lifts at the
      // start of the epoch LOCKOUT_EPOCHS after the one the decrease fell in.
      liftsAt: decreases.length > 0 ? liftsAt(decreases[decreases.length - 1], epochWindow) : null,
      decreases,
    },
    callout: calloutResult,
    now,
  };
}

function liftsAt(decrease, epochWindow) {
  const epochsAgo = Math.floor((epochWindow.start - decrease.blockTime) / 86_400);
  return epochWindow.start + (LOCKOUT_EPOCHS - epochsAgo) * 86_400;
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
    const forMint = records.filter((r) => r.mint === config.mint || r.coinMint === config.mint);
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
    holdRaw: loaded.held.hold,
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
    row('hold — lowest balance this epoch', holdCell, 'The number that decides the reward.'),
  );

  const nowCell = document.createElement('span');
  field(nowCell, {
    value: `${formatTokens(loaded.currentRaw, MINT_DECIMALS)} CALLPOOL`,
    source: SOURCES.chain,
  });
  table.append(row('balance now', nowCell));

  // §7.2: "if you sell now, this becomes X" — the single most useful line on
  // the page, and the one that stops a lockout being discovered by losing a
  // week to it.
  const sellCell = document.createElement('span');
  sellCell.className = 'warn';
  sellCell.textContent = loaded.lockout.locked
    ? 'Already locked out — a further sale does not extend it, but it does not shorten it either.'
    : `hold drops to 0 and this wallet earns nothing for ${LOCKOUT_EPOCHS} epochs, starting tomorrow.`;
  table.append(row('if you sell any amount now', sellCell));

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
      : `${LOCKOUT_EPOCHS} epochs from the decrease`;
    table.append(row('locked out', lockCell, 'Buying back does not shorten it.'));
  }

  return standing;
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

export { escapeHtml, formatSol };
