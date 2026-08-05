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
import { dailyState, epochAt, hourlyState, PROVISIONAL_EXPLANATION, windowFor } from './clocks.js';
import { explorerUrl, FLOOR_PERCENT_LABEL, siteConfig } from './config.js';
import { loadEpochs, renderEpochs, renderTotals } from './epochs.js';
import { decodeConfig } from './program.js';
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
};

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

  if (reason != null) renderEpochs(el('epoch-rows'), [], state.config ?? {});
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
 * and the history table reloads — a page left open overnight would otherwise
 * still be counting down to a boundary that has already passed.
 */
function startTicking() {
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    const chainConfig = state.chainConfig;

    if (chainConfig != null) {
      const epoch = epochAt(chainConfig.genesisTs, now, chainConfig.epochSeconds);
      if (state.window == null || epoch !== state.window.epoch) {
        state.window = windowFor(chainConfig.genesisTs, epoch, chainConfig.epochSeconds);
        field(el('current-epoch'), { value: String(epoch), source: SOURCES.derived });
        loadHistory(state.config).catch((error) => console.error('rollover reload', error));
      }
      renderClocks(chainConfig, now);
    }

    renderHeroCountdown(now);
  };

  tick();
  setInterval(tick, 1000);
}

async function main() {
  const config = siteConfig();
  state.config = config;

  // Before the configured check: the theme toggle, the cluster switch and the
  // social links must work on a page that cannot read a single number, which
  // is exactly the page someone lands on when the RPC is down.
  wireTopbar(config);

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
    failure(el('hero-status'), {
      what: 'The coin has not launched yet.',
      consequence:
        'The rules on this page are final and you can read them now. The live numbers arrive the moment the coin does.',
      error: 'programId is unset in config.local.js',
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
    wireCalculator(config);
    return;
  }

  await Promise.allSettled([loadPool(config), loadHistory(config)]);
  wireCalculator(config);
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
  el('floor-percent').textContent = FLOOR_PERCENT_LABEL;
  el('provisional-explanation').textContent = PROVISIONAL_EXPLANATION;
}

/**
 * The addresses, which do need a configured program id.
 */
function renderStaticFacts(config) {
  const pool = poolPda(config.programId);
  el('pool-address').replaceChildren(
    addressNode(pool.toBase58(), { href: explorerUrl(config, 'address', pool.toBase58()) }),
  );
  el('program-address').replaceChildren(
    addressNode(config.programId, { href: explorerUrl(config, 'address', config.programId) }),
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
  let poolLamports = null;
  let vaultLamports = null;

  const node = el('pool-balance');
  try {
    const pool = poolPda(config.programId);
    poolLamports = await lamportsOf(state.connection, pool);
    field(node, { value: `${formatSol(poolLamports)} SOL`, source: SOURCES.chain });
  } catch (error) {
    field(node, { value: null, unavailable: UNAVAILABLE.unreachable.short });
    console.error('pool balance', error);
  }

  const vaultNode = el('vault-balance');
  if (config.creatorVault == null) {
    field(vaultNode, { value: null, unavailable: 'not set on this page yet' });
  } else {
    try {
      vaultLamports = await lamportsOf(state.connection, config.creatorVault);
      field(vaultNode, { value: `${formatSol(vaultLamports)} SOL`, source: SOURCES.chain });
    } catch (error) {
      field(vaultNode, { value: null, unavailable: UNAVAILABLE.unreachable.short });
      console.error('creator vault balance', error);
    }
  }

  renderPoolCard(config, poolLamports, vaultLamports);
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
    return;
  }

  try {
    const epochs = await loadEpochs(state.connection, config, state.window.epoch);
    renderEpochs(el('epoch-rows'), epochs, config);
    renderTotals(el('total-distributed'), epochs);
    renderHistoryCard(epochs);
  } catch (error) {
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
}

function wireCalculator(config) {
  const form = el('position-form');
  const input = el('position-input');
  const nodes = {
    result: el('position-result'),
    headline: el('position-headline'),
    detail: el('position-detail'),
    facts: el('position-facts'),
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

main().catch((error) => {
  // Anything that escapes to here means the page is not showing what it claims
  // to show, so it says that rather than sitting on a half-rendered layout.
  failure(el('hero-status'), {
    what: 'The page failed to load.',
    consequence: 'Nothing on it should be trusted until it loads cleanly. Reload, or read the numbers from chain directly using the commands in “Verify it yourself”.',
    error,
  });
});

export { EPOCH_SECONDS };
