// Wiring. Everything that decides a number lives in the modules this imports;
// this file decides only what is on screen and in what order.
//
// The load order matters and is deliberate:
//
//   1. config — if the site is not configured, say so and stop. Never render
//      a placeholder that reads like a real value.
//   2. the on-chain Config — every later number depends on genesis_ts and
//      min_hold, and both come from chain rather than from this bundle.
//   3. the floor check — the browser half of devnet proof 20. Loudly.
//   4. everything else, each region failing independently.

import { MINT_DECIMALS, MIN_HOLD_RAW, MIN_HOLD_TOKENS, EPOCH_SECONDS } from '../../scripts/lib/config.mjs';

import { lamportsOf } from './chain.js';
import { configPda, connect, poolPda } from './addresses.js';
import {
  dailyState,
  epochAt,
  firstRecordNote,
  freshnessNote,
  hourlyState,
  PROVISIONAL_EXPLANATION,
  windowFor,
} from './clocks.js';
import { explorerUrl, FLOOR_PERCENT_LABEL, siteConfig } from './config.js';
import { loadEpochs, renderEpochs, renderTotals } from './epochs.js';
import { decodeConfig } from './program.js';
import { settledEpochIndices } from './payouts.js';
import { loadPosition, looksLikeAddress, renderPosition, renderPositionFailure } from './position.js';
import { countdown, formatSol, formatTokens } from './standing.js';
import { wireTopbar } from './topbar.js';
import { addressNode, bars, chartState, el, failure, field, progressRail, sparkline, SOURCES } from './ui.js';

const state = {
  config: null,
  connection: null,
  chainConfig: null,
  window: null,
  // Why the live numbers are missing, in words a reader can act on. Set once,
  // at the point of failure, and reused everywhere a value would otherwise
  // have to invent its own explanation — see UNAVAILABLE.
  unavailable: null,
  // Has the first read finished, however it finished? The calculator is wired
  // before it has, so that pressing Check during load cannot navigate — and
  // without this, "still reading" would be reported as "not launched yet",
  // which is a different and untrue statement.
  settled: false,
};

/**
 * The last values that were actually read, and when.
 *
 * The page re-reads every minute, and two things follow that are not optional.
 * A value is replaced only on success, so a figure never flashes "reading…"
 * once a minute; and a refresh that fails leaves the last good figure on screen
 * rather than erasing it, because a number that was true 60 seconds ago is
 * worth more to a reader than a blank. What is not allowed is doing that
 * quietly — `renderLiveStatus` says how old the figures are the moment a
 * refresh fails.
 */
const live = {
  poolLamports: null,
  vaultLamports: null,
  epochs: null,
  /** When a full pass last succeeded, and when one last failed. Unix seconds. */
  readAt: null,
  failedAt: null,
  /** When a pass was last *started* — what the minute timer counts from. */
  attemptedAt: 0,
  refreshing: false,
};

/** How often the page re-reads chain data. */
const REFRESH_SECONDS = 60;

/**
 * The three reasons a live number can be missing, said plainly.
 *
 * `short` goes in the slot where the number would have been, so it has to read
 * as an answer rather than as an error code. `clock` replaces a countdown, and
 * has to be a sentence because a countdown that has stopped is alarming if it
 * does not say why.
 *
 * The rule this serves is §7.4 — never a blank — but the wording is a separate
 * decision on top of it: "Unknown" and "not read" are technically honest and
 * tell a reader nothing they can do anything with.
 */
const UNAVAILABLE = {
  notLaunched: {
    short: 'not launched yet',
    clock: 'The first round starts when the coin launches.',
  },
  unreachable: {
    short: 'can’t reach Solana',
    clock: 'Could not reach Solana just now, so the countdown is not running. Reloading usually fixes it.',
  },
  notSetUp: {
    short: 'not set up yet',
    clock: 'This page has not been pointed at a coin yet.',
  },
};

/**
 * Every live value, before anything has been read.
 *
 * Called first so that a page which bails out early still shows a *state* in
 * each slot rather than an empty box. §7.4 asks for a loading and error state
 * for every live value; an empty box is neither, and a reader fills it in
 * themselves with whatever they were hoping for.
 */
function resetLiveFields(reason = null) {
  state.unavailable = reason;

  for (const id of [
    'pool-balance',
    'vault-balance',
    'current-epoch',
    'total-distributed',
    'chain-floor',
  ]) {
    field(el(id), { value: null, unavailable: reason?.short ?? null });
  }

  // The clocks, the cards and the history are regions rather than single
  // values, so they get the same treatment in their own shape.
  el('daily-clock').textContent = reason?.clock ?? 'reading…';

  // The hourly estimate is NOT downstream of the chain: it reports whether
  // provisional standings have been published, and the honest answer to that
  // is the same whether or not an RPC answered. Saying "could not reach
  // Solana" here would blame the wrong thing.
  el('hourly-clock').textContent = hourlyState({
    now: Math.floor(Date.now() / 1000),
    lastSampleAt: null,
  }).label;

  for (const [valueId, chartId] of CARDS) {
    field(el(valueId), { value: null, unavailable: reason?.short ?? null });
    chartState(el(chartId), reason?.clock ?? 'reading…', { unavailable: reason != null });
  }

  if (reason != null) {
    renderEpochs(el('epoch-rows'), [], state.config ?? {}, {
      pager: el('epoch-pagination'),
      emptyNote: firstRecordNote({ now: Math.floor(Date.now() / 1000), window: state.window }),
    });
  }
}

/** The three card charts, as [value slot, chart slot]. */
const CARDS = [
  ['card-pool-value', 'card-pool-chart'],
  ['card-history-value', 'card-history-chart'],
  ['card-clock-value', 'card-clock-chart'],
];

/** `formatSol` that survives a balance which never loaded. */
function sol(lamports) {
  return lamports == null ? '—' : `${formatSol(lamports)} SOL`;
}

/**
 * The headline countdown, re-rendered once a second.
 *
 * Two states and no third: the round is running, or it has closed and the
 * payouts are being worked out. Both are things a reader wants to know without
 * learning what an epoch is.
 */
function renderHeroCountdown(now) {
  const label = el('hero-countdown-label');
  const value = el('hero-countdown');

  if (state.window == null) {
    label.textContent = 'Today’s round';
    value.replaceChildren(pendingNode(state.unavailable?.short ?? 'reading…'));
    return;
  }

  if (now < state.window.end) {
    label.textContent = 'Today’s round ends in';
    value.textContent = countdown(state.window.end - now);
    return;
  }

  label.textContent = 'Right now';
  value.textContent = 'working out today’s payouts…';
}

/**
 * The one-second tick.
 *
 * A countdown that only redraws on load is a number somebody typed, and it is
 * wrong from the first second onwards. This also catches the rollover: when
 * the clock passes midnight the epoch index changes, the window moves with it,
 * and the chain data reloads — a page left open overnight would otherwise still
 * be counting down to a boundary that has already passed.
 *
 * The minute refresh lives here too rather than in a timer of its own, so a
 * rollover and a scheduled re-read can never run over each other: there is one
 * clock, and `refresh` is one function that both reach.
 */
function startTicking() {
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    const chainConfig = state.chainConfig;

    if (chainConfig != null) {
      const epoch = epochAt(chainConfig.genesisTs, now, chainConfig.epochSeconds);
      const rolledOver = state.window == null || epoch !== state.window.epoch;

      if (rolledOver) {
        state.window = windowFor(chainConfig.genesisTs, epoch, chainConfig.epochSeconds);
        field(el('current-epoch'), { value: String(epoch), source: SOURCES.derived });
      }

      if (rolledOver || now - live.attemptedAt >= REFRESH_SECONDS) {
        refresh().catch((error) => console.error('refresh', error));
      }

      renderClocks(chainConfig, now);
    }

    renderHeroCountdown(now);
  };

  tick();
  setInterval(tick, 1000);
}

/**
 * Boot, however it ends.
 *
 * Split from `main` only so that `state.settled` can be set on *every* way out
 * — four early returns and a throw. The calculator is wired before any of them
 * and reads that flag to tell "still reading" from "nothing to read", and a
 * flag set at four of five exits is worse than no flag at all.
 */
async function boot() {
  const config = siteConfig();
  state.config = config;

  // Before the configured check: the theme toggle, the cluster switch and the
  // social links must work on a page that cannot read a single number, which
  // is exactly the page someone lands on when the RPC is down.
  wireTopbar(config);

  // And the calculator, for a third reason that is not obvious: this form has
  // no `action`, so an unprevented submit is a **GET to the current path with
  // the form's fields as the query string** — which navigates, reloads, and
  // replaces `?cluster=devnet` with `?address=…`. An internal devnet session
  // silently falls back to mainnet the first time anyone presses Check.
  //
  // It was wired on two of the four paths out of `main`, so on the pre-launch
  // and unconfigured pages the button reloaded the page instead of answering.
  // Wiring it once, early, fixes both: the handler always calls
  // preventDefault(), and it already explains a state it cannot compute in.
  wireCalculator(config);

  // Same reasoning for the contract strip: it renders a state on every path,
  // including the unconfigured one, rather than sitting as an empty slot.
  renderTrade(config, config.configured ? null : 'not set up on this page yet');

  // No cluster line in the body: the switch in the top bar already names it,
  // and saying it twice made the hero read like a status page.
  renderRules();
  resetLiveFields();
  startTicking();

  if (!config.configured || config.rpc == null) {
    resetLiveFields(UNAVAILABLE.notSetUp);
    failure(el('hero-status'), {
      what: 'This page has not been set up yet.',
      consequence:
        'Nothing is shown from a default, because a default here would be a number with nothing behind it. Everything that explains how this works is below and is final.',
      error: 'window.CALLPOOL_SITE_CONFIG is missing or has no rpc for this cluster. Copy site/config.local.example.js to site/config.local.js and fill in the RPC endpoint.',
    });
    return;
  }

  state.connection = connect(config.rpc);

  renderStaticFacts(config);

  if (config.programId == null) {
    resetLiveFields(UNAVAILABLE.notLaunched);
    // No `error`, deliberately. Everywhere else the folded technical detail is
    // an RPC message or a missing account — something a technical reader can
    // check us on, which is why it is offered. This state is not a failure at
    // all: it is the designed pre-launch page, and the only "detail" available
    // is a line about our own config file. That answers no question a visitor
    // has, cannot be verified by anyone, and puts a "Technical detail"
    // disclosure under a sentence that is simply true — which reads as
    // something being broken. `failure()` omits the fold when error is null.
    failure(el('hero-status'), {
      what: 'The coin has not launched yet.',
      consequence:
        'The rules on this page are final and you can read them now. The live numbers arrive the moment the coin does.',
    });
    return;
  }

  await loadChainConfig(config);

  // Without the program's own config there is nothing worth reading, and
  // reading anyway is actively worse than not: `getAccountInfo` on an account
  // that does not exist yet reports a balance of zero, and "0 SOL" with a
  // `chain` badge beside it is a far more convincing wrong answer than "not
  // launched yet". The state set above already says which it is.
  if (state.chainConfig == null) {
    resetLiveFields(state.unavailable ?? UNAVAILABLE.unreachable);
    return;
  }

  await refresh();
}

/**
 * The rule itself — true before any RPC answers, and true if none ever does.
 *
 * Rendered before the configuration is even checked, because "how it works" is
 * the half of this page that does not depend on a chain being reachable, and a
 * visitor who arrives while the RPC is down should still be able to read it.
 * All three values come from scripts/lib/config.mjs, which is also what the
 * crank and the tests read.
 */
function renderRules() {
  const floor = `${MIN_HOLD_TOKENS.toLocaleString('en-US')} CALLPOOL`;
  el('floor-tokens').textContent = floor;
  el('floor-tokens-formula').textContent = floor;
  // L22 made the floor part of the prose rather than only a heading — the
  // lockout rule is stated in terms of it — so any number of inline slots get
  // the same value from the same constant. A hardcoded "100,000" in the copy
  // would be a second source of truth for the one parameter that is immutable.
  for (const slot of document.querySelectorAll('.floor-inline')) slot.textContent = floor;
  el('floor-percent').textContent = FLOOR_PERCENT_LABEL;
  el('provisional-explanation').textContent = PROVISIONAL_EXPLANATION;
}

/**
 * The addresses.
 *
 * The program id is allowed to be unset — that is the pre-launch page — and
 * both addresses derived from it then render the pending state instead. This
 * used to throw: `poolPda(null)` reaches `new PublicKey(null)`, and because
 * this runs *before* the "has not launched" branch below it took the whole page
 * down to "The page failed to load" for a configuration the code has an
 * explicit, deliberate state for.
 */
function renderStaticFacts(config) {
  const pool = config.programId == null ? null : poolPda(config.programId).toBase58();

  el('pool-address').replaceChildren(
    pool == null
      ? pendingNode('not launched yet')
      : addressNode(pool, { href: explorerUrl(config, 'address', pool) }),
  );
  el('program-address').replaceChildren(
    config.programId == null
      ? pendingNode('not launched yet')
      : addressNode(config.programId, { href: explorerUrl(config, 'address', config.programId) }),
  );
  el('mint-address').replaceChildren(
    config.mint
      ? addressNode(config.mint, { href: explorerUrl(config, 'address', config.mint) })
      : pendingNode('not launched yet'),
  );

  // Read from the on-chain Config, so until that loads it says so rather than
  // sitting empty.
  el('snapshot-key').replaceChildren(pendingNode('reading…'));

  const feeTx = el('fee-share-tx');
  if (config.feeShareTx) {
    feeTx.replaceChildren(
      addressNode(config.feeShareTx, {
        href: explorerUrl(config, 'tx', config.feeShareTx),
        truncate: true,
      }),
    );
  } else {
    feeTx.replaceChildren(
      pendingNode('not published yet — until this transaction is here, treat the 90/10 split as unverified'),
    );
  }
}

function pendingNode(text) {
  const span = document.createElement('span');
  span.className = 'pending';
  span.textContent = text;
  return span;
}

/**
 * The contract-address strip and the hero's trade button.
 *
 * One function for both, because they must never disagree: the address people
 * copy and the coin the trade button opens have to be the same mint the rest
 * of the page reads. Rendered from config on load and again from the program's
 * own on-chain Config once that arrives — the same two moments `mint-address`
 * in the fold is rendered.
 *
 * Before the coin exists there is nothing honest to link, so the address slot
 * says why and the button is a disabled chip — §7.4 applied to a link, the
 * same as the top-bar social links.
 */
function renderTrade(config, unavailableWhy = null) {
  const slot = el('ca-address');
  const button = el('trade-hero');
  const mint = unavailableWhy == null ? (config?.mint ?? null) : null;

  if (mint == null) {
    const why = unavailableWhy ?? 'not launched yet';
    slot.replaceChildren(pendingNode(why));
    button.setAttribute('aria-disabled', 'true');
    button.removeAttribute('href');
    button.title = `There is nothing to trade yet — the coin is ${why}.`;
    return;
  }

  slot.replaceChildren(addressNode(mint, { href: explorerUrl(config, 'address', mint) }));
  button.href = `https://pump.fun/coin/${mint}`;
  button.rel = 'noopener noreferrer';
  button.target = '_blank';
  button.removeAttribute('aria-disabled');
  button.removeAttribute('title');
}

/**
 * The on-chain Config, and the floor identity check.
 *
 * Devnet proof 20 asserts the off-chain eligibility filter and the on-chain
 * `claim` check use the same floor. The JS half is asserted in the test suite;
 * this is the half that runs in a stranger's browser, against the deployed
 * account, every time the page loads. If they ever disagree the page says so
 * before it says anything else — a site quietly rendering a floor the program
 * does not enforce is worse than a site that is down.
 */
async function loadChainConfig(config) {
  const node = el('hero-status');
  try {
    const address = configPda(config.programId);
    const info = await state.connection.getAccountInfo(address);
    if (!info) {
      state.unavailable = UNAVAILABLE.notLaunched;
      failure(node, {
        what: 'The coin has not launched yet.',
        consequence:
          'No day has been settled, so there is nothing to pay out or check yet. The rules below are final and you can read them now.',
        error: `no Config account at ${address.toBase58()}`,
      });
      return;
    }

    const chainConfig = await decodeConfig(new Uint8Array(info.data));
    state.chainConfig = chainConfig;

    // The mint is a field of the on-chain Config, so it is read rather than
    // configured. config.local.js may name one too; if the two disagree,
    // something is pointed at the wrong deployment and the page says so
    // instead of rendering another coin's epochs as if they were this one's.
    if (config.mint != null && config.mint !== chainConfig.mint) {
      // Dropped, not kept: every later number is derived from this account, and
      // a ticking countdown built from the wrong coin's genesis would be the
      // most convincing wrong number on the page.
      state.chainConfig = null;
      state.unavailable = UNAVAILABLE.notSetUp;
      // The strip rendered config's mint on load; with the chain disagreeing,
      // a live "Trade" button would be an invitation to buy an address this
      // page just said it cannot vouch for.
      renderTrade(config, 'not checkable — this page is pointing at the wrong coin');
      failure(el('hero-status'), {
        what: 'This page is pointing at the wrong coin.',
        consequence:
          'Nothing further is read. Every address here is worked out from the coin, so carrying on would show another coin\u2019s history under this one\u2019s name.',
        error: `config.local.js says ${config.mint}; the program\u2019s config says ${chainConfig.mint}`,
      });
      return;
    }
    config.mint = chainConfig.mint;

    el('mint-address').replaceChildren(
      addressNode(chainConfig.mint, { href: explorerUrl(config, 'address', chainConfig.mint) }),
    );
    renderTrade(config);

    const now = Math.floor(Date.now() / 1000);
    const epoch = epochAt(chainConfig.genesisTs, now, chainConfig.epochSeconds);
    state.window = windowFor(chainConfig.genesisTs, epoch, chainConfig.epochSeconds);

    field(el('current-epoch'), { value: String(epoch), source: SOURCES.derived });

    const onChainFloor = document.createElement('span');
    field(onChainFloor, {
      value: `${formatTokens(chainConfig.minHold, MINT_DECIMALS)} CALLPOOL`,
      source: SOURCES.chain,
    });
    el('chain-floor').replaceChildren(onChainFloor);

    const mismatch = chainConfig.minHold !== MIN_HOLD_RAW;
    const banner = el('floor-mismatch');
    banner.hidden = !mismatch;
    if (mismatch) {
      banner.textContent =
        `⚠️ The floor this page shows (${MIN_HOLD_RAW} raw units) is NOT the floor the program enforces ` +
        `(${chainConfig.minHold} raw units). Trust the program, not this page, and treat every eligibility ` +
        `answer here as unreliable until it is fixed.`;
    }

    el('snapshot-key').replaceChildren(
      addressNode(chainConfig.snapshotKey, {
        href: explorerUrl(config, 'address', chainConfig.snapshotKey),
      }),
    );

    renderClocks(chainConfig, now);
    node.hidden = true;
  } catch (error) {
    state.chainConfig = null;
    state.unavailable = UNAVAILABLE.unreachable;
    failure(node, {
      what: 'Could not reach Solana just now.',
      consequence:
        'The live numbers are missing until it answers — reloading usually fixes it. Nothing else on this page depends on it.',
      error,
    });
  }
}

/**
 * The pool card: what can be divided now, against what is still accruing.
 *
 * The two bars are the same two numbers as the first two metrics above, drawn
 * against each other because "the pool is small but a sweep is due" and "the
 * pool is small and nothing is coming" are the same two figures and completely
 * different situations. Both are chain reads, so the card carries the chain
 * badge; if either failed the chart says which, rather than drawing one bar
 * and letting the missing one read as zero.
 */
function renderPoolCard(config, poolLamports, vaultLamports) {
  field(el('card-pool-value'), {
    value: poolLamports == null ? null : sol(poolLamports),
    source: SOURCES.chain,
    unavailable: poolLamports == null ? UNAVAILABLE.unreachable.short : null,
  });

  const missing =
    config.creatorVault == null
      ? 'Nothing to compare against yet — the creator vault has not been set on this page.'
      : 'Both figures have to load before they can be put side by side. One of them did not.';

  bars(el('card-pool-chart'), {
    series: [
      { label: 'Pool', value: poolLamports, display: sol(poolLamports) },
      { label: 'Accrued', value: vaultLamports, display: sol(vaultLamports), secondary: true },
    ],
    empty:
      poolLamports == null || vaultLamports == null
        ? missing
        : 'Both are empty. No fees have come in yet.',
    unavailable: poolLamports == null || vaultLamports == null,
  });
}

/**
 * The history card: one point per settled epoch, oldest first.
 *
 * Deliberately counts *settled* epochs rather than epochs elapsed. An epoch
 * that was never posted has no distribution to plot, and quietly plotting it
 * as zero would hide the gap that section 4 goes out of its way to show.
 */
function renderHistoryCard(epochs) {
  const settled = epochs.filter((e) => e.posted).reverse();

  field(el('card-history-value'), {
    value: settled.length === 1 ? '1 day paid' : `${settled.length} days paid`,
    source: SOURCES.chain,
  });

  sparkline(el('card-history-chart'), {
    values: settled.map((e) => e.claimedLamports),
    label: `Paid out on each of the ${settled.length} days settled so far, oldest first.`,
    empty:
      settled.length === 0
        ? 'No day has been paid out yet. The first is settled at the first 00:00 UTC after launch.'
        : 'One day so far. A single point is not a shape, so there is nothing to draw yet.',
  });
}

/**
 * The clock card: how far through the current epoch we are.
 *
 * Sized from the on-chain window, so a rehearsal deployment running 60-second
 * epochs draws 60-second epochs rather than a day that never advances.
 */
function renderClockCard(chainConfig, now) {
  const running = state.window != null && now < state.window.end;

  field(el('card-clock-value'), {
    value:
      state.window == null
        ? null
        : running
          ? `${countdown(state.window.end - now)} left`
          : 'closed for today',
    source: SOURCES.derived,
    unavailable: state.window == null ? (state.unavailable?.short ?? 'reading…') : null,
  });

  progressRail(el('card-clock-chart'), {
    window: state.window,
    now,
    challengeSeconds: chainConfig?.challengeSeconds ?? null,
    empty: state.unavailable?.clock ?? 'Reading the day’s window from Solana…',
    unavailable: true,
  });
}

function renderClocks(chainConfig, now) {
  const daily = dailyState({
    now,
    window: state.window,
    settledAt: null,
    challengeSeconds: chainConfig.challengeSeconds,
  });
  el('daily-clock').textContent = daily.label;

  // `lastSampleAt` comes from the published provisional standings once the
  // hourly poller writes them. Until then the counter says so rather than
  // implying a refresh that is not happening.
  const hourly = hourlyState({ now, lastSampleAt: null });
  const hourlyNode = el('hourly-clock');
  hourlyNode.textContent = hourly.label;
  hourlyNode.classList.toggle('warn', hourly.stale);

  renderClockCard(chainConfig, now);
}

/**
 * The pool, and the creator vault beside it — never folded together.
 *
 * Fees accrue in pump.fun's creator vault between epoch runs (Phase 03 §3.1).
 * Adding the two would overstate what is actually distributable right now, and
 * showing only the pool would understate what is coming.
 */
async function loadPool(config) {
  let ok = true;

  try {
    live.poolLamports = await lamportsOf(state.connection, poolPda(config.programId));
  } catch (error) {
    // The previous balance stays in `live`, and therefore on screen. A failed
    // re-read is not evidence that the pool is empty.
    ok = false;
    console.error('pool balance', error);
  }

  if (config.creatorVault != null) {
    try {
      live.vaultLamports = await lamportsOf(state.connection, config.creatorVault);
    } catch (error) {
      ok = false;
      console.error('creator vault balance', error);
    }
  }

  field(el('pool-balance'), {
    value: live.poolLamports == null ? null : `${formatSol(live.poolLamports)} SOL`,
    source: SOURCES.chain,
    unavailable: live.poolLamports == null ? UNAVAILABLE.unreachable.short : null,
  });

  field(el('vault-balance'), {
    value: live.vaultLamports == null ? null : `${formatSol(live.vaultLamports)} SOL`,
    source: SOURCES.chain,
    unavailable:
      config.creatorVault == null
        ? 'not set on this page yet'
        : live.vaultLamports == null
          ? UNAVAILABLE.unreachable.short
          : null,
  });

  renderPoolCard(config, live.poolLamports, live.vaultLamports);
  return ok;
}

/**
 * Re-read everything that comes from chain. The one refresh path.
 *
 * Called on load, once a minute, and on the day rollover — deliberately the
 * same function each time, because two paths that both reload the history is
 * how one of them ends up subtly different from the other.
 *
 * Returns nothing and throws nothing: each region already renders its own
 * failure, and this decides only whether the page is showing figures older
 * than it claims.
 */
async function refresh() {
  if (state.chainConfig == null || live.refreshing) return;
  live.refreshing = true;
  live.attemptedAt = Math.floor(Date.now() / 1000);

  try {
    const results = await Promise.all([loadPool(state.config), loadHistory(state.config)]);
    const now = Math.floor(Date.now() / 1000);
    // Only a fully successful pass updates the timestamp. A partial one leaves
    // some region stale, and a "read at" that covers only half the page is a
    // more confident claim than the page can actually make.
    if (results.every(Boolean)) {
      live.readAt = now;
      live.failedAt = null;
    } else {
      live.failedAt = now;
    }
  } finally {
    live.refreshing = false;
    renderLiveStatus();
  }
}

/** Say how old the figures are, but only once they have stopped updating. */
function renderLiveStatus() {
  const node = el('live-status');
  const { stale, label } = freshnessNote(live);

  node.hidden = !stale;
  node.textContent = label ?? '';
}

async function loadHistory(config) {
  // No window means the program's config never loaded, and the epoch index is
  // derived from it. Say so in both places rather than leaving the table and
  // the card sitting on "reading…" forever.
  if (state.window == null) {
    field(el('card-history-value'), { value: null, unavailable: state.unavailable?.short ?? 'reading…' });
    chartState(el('card-history-chart'), state.unavailable?.clock ?? 'Reading the day’s window from Solana…', {
      unavailable: true,
    });
    return false;
  }

  try {
    live.epochs = await loadEpochs(state.connection, config, state.window.epoch);
  } catch (error) {
    console.error('daily record', error);

    // A record read once and not re-read is still the record. It is left on the
    // page exactly as it was, and `renderLiveStatus` says it is not updating —
    // replacing a correct table with an error is the worse of the two.
    if (live.epochs == null) {
      failure(el('history-status'), {
        what: 'Could not read the daily record just now.',
        consequence: 'The table below may be missing rows. Every day is still readable on Solana directly.',
        error,
      });
      field(el('card-history-value'), { value: null, unavailable: UNAVAILABLE.unreachable.short });
      chartState(el('card-history-chart'), 'The daily record could not be read just now, so there is nothing to draw.', {
        unavailable: true,
      });
    }
    return false;
  }

  el('history-status').replaceChildren();
  el('history-status').classList.remove('failed');
  renderEpochs(el('epoch-rows'), live.epochs, config, {
    pager: el('epoch-pagination'),
    emptyNote: firstRecordNote({ now: Math.floor(Date.now() / 1000), window: state.window }),
  });
  renderTotals(el('total-distributed'), live.epochs);
  renderHistoryCard(live.epochs);
  return true;
}

function wireCalculator(config) {
  const form = el('position-form');
  const input = el('position-input');
  const nodes = {
    result: el('position-result'),
    headline: el('position-headline'),
    detail: el('position-detail'),
    tiles: el('position-tiles'),
    facts: el('position-facts'),
    days: el('position-days'),
    dayRows: el('position-day-rows'),
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = input.value.trim();

    if (!looksLikeAddress(address)) {
      nodes.result.hidden = false;
      failure(nodes.result, {
        what: 'That does not look like a Solana address.',
        consequence: 'Paste the wallet address itself — 32 to 44 base58 characters. No wallet connection is needed, or ever asked for.',
        error: `rejected before any request was made: ${address.slice(0, 60)}`,
      });
      return;
    }

    if (!state.settled) {
      nodes.result.hidden = false;
      nodes.result.className = 'standing standing-pending';
      nodes.headline.textContent = 'Still reading Solana — try again in a moment.';
      nodes.detail.replaceChildren();
      nodes.facts.replaceChildren();
      return;
    }

    if (state.window == null || state.chainConfig == null) {
      nodes.result.hidden = false;
      failure(nodes.result, {
        what: `Nothing to check yet — ${state.unavailable?.short ?? 'the coin has not launched'}.`,
        consequence:
          'The day’s window and the minimum are both read from Solana, and without them any answer here would be a guess.',
        error: 'chain config unavailable',
      });
      return;
    }

    nodes.result.hidden = false;
    nodes.result.className = 'standing standing-pending';
    nodes.headline.textContent = 'Replaying this wallet’s transfers…';
    nodes.detail.replaceChildren();
    nodes.facts.replaceChildren();

    try {
      const loaded = await loadPosition({
        connection: state.connection,
        config,
        address,
        window: state.window,
        now: Math.floor(Date.now() / 1000),
        // The settled days this wallet could be owed by, newest first, and the
        // pool as it stands — the two inputs the payout panel needs. Bounded:
        // a holder checking today does not need last quarter, and each epoch
        // is two fetches from the audit trail.
        // **`live`, not `state`.** The read values live on `live`; `state` has
        // no `epochs` and no `poolLamports`, so this used to read `undefined`
        // and fall through to `[]` and `0n` — which meant the paid/owed panel
        // and the projected share had never once rendered for any wallet, on
        // any cluster. An empty trail renders exactly like a wallet with no
        // history, so nothing ever looked broken. Found 2026-08-08 on a local
        // validator carrying real settled payouts.
        //
        // The index selection is `settledEpochIndices` for the same reason:
        // the field is named `index`, this file twice said `epoch`, and the
        // mistake is only catchable in a test.
        settledEpochs: settledEpochIndices(live.epochs),
        poolLamports: live.poolLamports ?? 0n,
        // L22 — the lockout only fires on a drop below the floor, so the
        // computation needs the floor. From the on-chain config, so a
        // deployment running a different one locks on its own.
        minHoldRaw: state.chainConfig?.minHold ?? null,
      });
      nodes.result.classList.remove('failed');
      renderPosition(nodes, loaded, {
        config,
        minHoldRaw: state.chainConfig.minHold,
        window: state.window,
        settlement: null,
      });
    } catch (error) {
      renderPositionFailure(nodes, error);
    }
  });
}

const main = () => boot().finally(() => { state.settled = true; });

main().catch((error) => {
  // Anything that escapes to here means the page is not showing what it claims
  // to show, so it says that rather than sitting on a half-rendered layout.
  failure(el('hero-status'), {
    what: 'The page failed to load.',
    consequence: 'Nothing on it should be trusted until it loads cleanly. Reload, or read the numbers from chain directly using the commands in “Verify it yourself”.',
    error,
  });
});
