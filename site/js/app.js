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
};

/**
 * Every live value, before anything has been read.
 *
 * Called first so that a page which bails out early still shows a *state* in
 * each slot rather than an empty box. §7.4 asks for a loading and error state
 * for every live value; an empty box is neither, and a reader fills it in
 * themselves with whatever they were hoping for.
 */
function resetLiveFields(message = null) {
  for (const id of [
    'pool-balance',
    'vault-balance',
    'current-epoch',
    'total-distributed',
    'chain-floor',
  ]) {
    field(el(id), { value: null, unavailable: message });
  }

  // The clocks, the cards and the history are regions rather than single
  // values, so they get the same treatment in their own shape.
  const clockText = message ?? 'reading…';
  el('hourly-clock').textContent = clockText;
  el('daily-clock').textContent = clockText;

  for (const [valueId, chartId] of CARDS) {
    field(el(valueId), { value: null, unavailable: message });
    chartState(el(chartId), message ?? 'reading…', { unavailable: message != null });
  }

  if (message != null) renderEpochs(el('epoch-rows'), [], state.config ?? {});
}

/** The three card charts, as [value slot, chart slot]. */
const CARDS = [
  ['card-pool-value', 'card-pool-chart'],
  ['card-history-value', 'card-history-chart'],
  ['card-clock-value', 'card-clock-chart'],
];

/** `formatSol` that survives a balance which never loaded. */
function sol(lamports) {
  return lamports == null ? 'not read' : `${formatSol(lamports)} SOL`;
}

async function main() {
  const config = siteConfig();
  state.config = config;

  // Before the configured check: the theme toggle, the cluster switch and the
  // social links must work on a page that cannot read a single number, which
  // is exactly the page someone lands on when the RPC is down.
  wireTopbar(config);

  el('cluster-label').textContent = config.cluster;
  resetLiveFields();

  if (!config.configured || config.rpc == null) {
    resetLiveFields('not configured');
    failure(el('hero-status'), {
      what: 'This site is not configured.',
      consequence:
        'Copy site/config.local.example.js to site/config.local.js and fill in the RPC endpoint. Nothing is rendered from a default, because a default here would be a number with no source.',
      error: 'window.CALLPOOL_SITE_CONFIG is missing or has no rpc for this cluster',
    });
    return;
  }

  state.connection = connect(config.rpc);

  renderStaticFacts(config);

  if (config.programId == null) {
    resetLiveFields('waiting on the coin');
    failure(el('hero-status'), {
      what: 'The coin does not exist yet.',
      consequence:
        'Every live number waits on a deployed program. The mechanic below is final and readable now; the numbers arrive when the coin does.',
      error: 'programId is unset in config.local.js',
    });
    return;
  }

  await loadChainConfig(config);
  if (state.window == null) clocksWithoutAWindow();

  await Promise.allSettled([loadPool(config), loadHistory(config)]);
  wireCalculator(config);
}

/**
 * The things that are true before any RPC answers: the floor, the lockout, the
 * split. All sourced from scripts/lib/config.mjs, which is also what the crank
 * and the tests read.
 */
function renderStaticFacts(config) {
  el('floor-tokens').textContent = `${MIN_HOLD_TOKENS.toLocaleString('en-US')} CALLPOOL`;
  el('floor-percent').textContent = FLOOR_PERCENT_LABEL;
  el('provisional-explanation').textContent = PROVISIONAL_EXPLANATION;

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
      : pendingNode('the coin does not exist yet'),
  );

  // Read from the on-chain Config, so until that loads it says so rather than
  // sitting empty.
  el('snapshot-key').replaceChildren(pendingNode('reading from the program’s config…'));

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
      pendingNode('not yet set — until this transaction exists, treat the 90/10 split as unverified'),
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
      failure(node, {
        what: 'The program is deployed but not initialized.',
        consequence: 'No epochs exist yet, so there is nothing to distribute or verify.',
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
      failure(el('hero-status'), {
        what: 'This page is configured for a different coin than the program holds.',
        consequence:
          'Nothing further is read. Every epoch address is derived from the mint, so continuing would show a different coin\u2019s history under this coin\u2019s name.',
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
    failure(node, {
      what: 'Could not read the program’s configuration.',
      consequence:
        'Everything downstream depends on it — the epoch number, the floor, the payout schedule — so none of it is shown.',
      error,
    });
  }
}

/**
 * What the clocks say when the program's config never loaded.
 *
 * `loadChainConfig` has four ways out — no account, a mint mismatch, a decode
 * failure, an RPC failure — and every one of them leaves the epoch window
 * unknown. Rather than remembering to say so at each `return`, the caller
 * checks once: if there is no window, nothing that depends on one is left
 * sitting on "reading…" pretending it is still trying.
 */
function clocksWithoutAWindow() {
  const now = Math.floor(Date.now() / 1000);

  el('daily-clock').textContent =
    'Unknown — when this epoch closes comes from the program’s config, which was not read.';

  // The hourly clock is not downstream of the chain config at all: it reports
  // whether provisional standings have been published, and the honest answer
  // to that is the same whether or not an RPC answered.
  el('hourly-clock').textContent = hourlyState({ now, lastSampleAt: null }).label;

  renderClockCard(null, now);
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
    unavailable: poolLamports == null ? 'the pool balance could not be read' : null,
  });

  const missing =
    config.creatorVault == null
      ? 'The creator vault is not configured, so there is nothing to compare the pool against.'
      : 'Both balances have to load before they can be compared. One of them did not.';

  bars(el('card-pool-chart'), {
    series: [
      { label: 'Pool', value: poolLamports, display: sol(poolLamports) },
      { label: 'Accrued', value: vaultLamports, display: sol(vaultLamports), secondary: true },
    ],
    empty:
      poolLamports == null || vaultLamports == null
        ? missing
        : 'Both accounts are empty. Nothing has accrued to split yet.',
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
    value: `${settled.length} settled`,
    source: SOURCES.chain,
  });

  sparkline(el('card-history-chart'), {
    values: settled.map((e) => e.claimedLamports),
    label: `Distributed per epoch across ${settled.length} settled epochs, oldest first.`,
    empty:
      settled.length === 0
        ? 'No epoch has settled yet. The first settles at the first 00:00 UTC after launch.'
        : 'One epoch has settled. A single point is not a trend, so nothing is drawn yet.',
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
          : 'closed',
    source: SOURCES.derived,
    unavailable: state.window == null ? 'the epoch window is not known yet' : null,
  });

  progressRail(el('card-clock-chart'), {
    window: state.window,
    now,
    challengeSeconds: chainConfig?.challengeSeconds ?? null,
    empty: 'The epoch window comes from the program’s config, which has not been read.',
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
    field(node, { value: null, unavailable: 'can’t reach chain' });
    console.error('pool balance', error);
  }

  const vaultNode = el('vault-balance');
  if (config.creatorVault == null) {
    field(vaultNode, { value: null, unavailable: 'creator vault not configured' });
  } else {
    try {
      vaultLamports = await lamportsOf(state.connection, config.creatorVault);
      field(vaultNode, { value: `${formatSol(vaultLamports)} SOL`, source: SOURCES.chain });
    } catch (error) {
      field(vaultNode, { value: null, unavailable: 'can’t reach chain' });
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
    field(el('card-history-value'), { value: null, unavailable: 'the current epoch is not known' });
    chartState(el('card-history-chart'), 'Which epochs to read comes from the program’s config, which has not been read.', {
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
      what: 'Could not read the epoch history.',
      consequence: 'The table below may be incomplete. Every epoch is still readable on chain directly.',
      error,
    });
    field(el('card-history-value'), { value: null, unavailable: 'the epoch accounts could not be read' });
    chartState(el('card-history-chart'), 'The epoch history could not be read, so there is nothing to plot.', {
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
        what: 'The program’s configuration has not loaded.',
        consequence: 'Without genesis_ts and min_hold from chain, any answer here would be guessed.',
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
