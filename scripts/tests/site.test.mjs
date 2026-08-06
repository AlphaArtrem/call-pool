// Tests for site/ — the parts of the website that decide what a visitor is
// told.
//
// Three things are pinned here, and each exists because getting it wrong
// produces a plausible wrong number rather than an error:
//
//   1. **The two account decoders agree.** site/js/program.js decodes Config
//      and Epoch a second time, on DataView instead of Buffer, because
//      scripts/lib/program.mjs cannot load in a browser. Same bytes in, same
//      fields out — asserted, not assumed. This is the D6 pattern applied to
//      the website.
//   2. **Every §7.8 state is reachable and says the right thing.** The table in
//      Phase 07 is a promise about what the page says when someone is locked
//      out or below the floor, and a promise nothing asserts is a draft.
//   3. **The vendored web3.js is the installed one.** A stale vendor file is
//      a silent fork of the library every address on the page is derived with.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  decodeConfig as decodeConfigNode,
  decodeEpoch as decodeEpochNode,
  epochPda as epochPdaNode,
} from '../lib/program.mjs';
import { DUST_THRESHOLD_LAMPORTS, LOCKOUT_EPOCHS, MIN_HOLD_RAW } from '../lib/config.mjs';
import { REPO_ROOT } from '../lib/store.mjs';

import { PublicKey } from '@solana/web3.js';

import {
  decodeConfig as decodeConfigSite,
  decodeEpoch as decodeEpochSite,
  bitmapIsSized,
  isZeroRoot,
  isClaimed,
} from '../../site/js/program.js';
import { decodeBase58, encodeBase58 } from '../../site/js/base58.js';
import { standingFor, formatSol, formatTokens, countdown, utcTime } from '../../site/js/standing.js';
import * as clocksModule from '../../site/js/clocks.js';
import { dailyState, epochAt, firstRecordNote, freshnessNote, hourlyState, windowFor } from '../../site/js/clocks.js';
import { siteConfig, snapshotUrl, explorerUrl, resolveCluster } from '../../site/js/config.js';
import { barSeries, epochProgress, sparkPath } from '../../site/js/graphs.js';
import { pageOf, PAGE_SIZE } from '../../site/js/paging.js';
import { epochIndices, totalClaimed } from '../../site/js/history.js';

// ── fixtures ───────────────────────────────────────────────────────────────

const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);

/** Anchor's account discriminator, built the same way program.mjs builds it. */
function disc(name) {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function configBytes({ genesisTs = 1_767_225_600, minHold = MIN_HOLD_RAW, outstanding = 42n } = {}) {
  const b = Buffer.alloc(106);
  disc('Config').copy(b, 0);
  KEY_A.copy(b, 8); // mint
  b.writeBigInt64LE(BigInt(genesisTs), 40);
  b.writeUInt32LE(86_400, 48);
  b.writeBigUInt64LE(minHold, 52);
  b.writeUInt32LE(86_400, 60);
  KEY_B.copy(b, 64); // snapshot key
  b.writeBigUInt64LE(outstanding, 96);
  b[104] = 254; // bump
  b[105] = 253; // pool bump
  return b;
}

function epochBytes({ index = 12, leafCount = 9, bits = null, closed = false, root = null } = {}) {
  const bitmap = bits ?? Buffer.alloc(Math.ceil(leafCount / 8), 0b0000_0101);
  const b = Buffer.alloc(8 + 8 + 32 + 8 + 8 + 8 + 4 + 1 + 4 + bitmap.length);
  let o = 0;
  disc('Epoch').copy(b, o);
  o += 8;
  b.writeBigUInt64LE(BigInt(index), o);
  o += 8;
  (root ?? Buffer.alloc(32, 3)).copy(b, o);
  o += 32;
  b.writeBigUInt64LE(5_000_000_000n, o); // pool lamports
  o += 8;
  b.writeBigUInt64LE(1_250_000_000n, o); // claimed lamports
  o += 8;
  b.writeBigInt64LE(1_767_312_000n, o); // posted ts
  o += 8;
  b.writeUInt32LE(leafCount, o);
  o += 4;
  b[o] = closed ? 1 : 0;
  o += 1;
  b.writeUInt32LE(bitmap.length, o);
  o += 4;
  bitmap.copy(b, o);
  return b;
}

// ── 1. the two decoders agree ──────────────────────────────────────────────

test('site and crank decode Config to the same fields', async () => {
  const bytes = configBytes();
  const node = decodeConfigNode(bytes);
  const site = await decodeConfigSite(new Uint8Array(bytes));

  assert.equal(site.mint, node.mint.toBase58());
  assert.equal(site.genesisTs, node.genesisTs);
  assert.equal(site.epochSeconds, node.epochSeconds);
  assert.equal(site.minHold, node.minHold);
  assert.equal(site.challengeSeconds, node.challengeSeconds);
  assert.equal(site.snapshotKey, node.snapshotKey.toBase58());
  assert.equal(site.outstanding, node.outstanding);
  assert.equal(site.bump, node.bump);
  assert.equal(site.poolBump, node.poolBump);
});

test('site and crank decode Epoch to the same fields', async () => {
  const bytes = epochBytes();
  const node = decodeEpochNode(bytes);
  const site = await decodeEpochSite(new Uint8Array(bytes));

  assert.equal(site.index, node.index);
  assert.deepEqual([...site.root], [...node.root]);
  assert.equal(site.poolLamports, node.poolLamports);
  assert.equal(site.claimedLamports, node.claimedLamports);
  assert.equal(site.postedTs, node.postedTs);
  assert.equal(site.leafCount, node.leafCount);
  assert.equal(site.closed, node.closed);
  assert.deepEqual([...site.claimedBits], [...node.claimedBits]);
});

test('site and crank agree on which leaves are claimed', async () => {
  const bytes = epochBytes();
  const node = decodeEpochNode(bytes);
  const site = await decodeEpochSite(new Uint8Array(bytes));

  for (let i = 0; i < 9; i++) {
    assert.equal(isClaimed(site, i), isClaimed(node, i), `leaf ${i}`);
  }
});

test('site and crank derive the same epoch address, in the same argument order', async () => {
  // `addresses.js` is the one site module that reaches web3.js through a
  // browser global, which is why nothing else here imports it. Handing it the
  // real library under the name the page uses is enough, and keeps the two PDA
  // derivations checkable against each other rather than by eye.
  globalThis.solanaWeb3 ??= await import('@solana/web3.js');
  const { epochPda: epochPdaSite } = await import('../../site/js/addresses.js');

  // Two implementations of one PDA. Every argument is a base58 string, so a
  // swapped pair raises nothing at all — it derives a real-looking address for
  // the wrong account, and the row silently reads as "never posted". The
  // argument orders disagreed until the site was standardised on the scripts'.
  const mint = new PublicKey('Cg1hswfyVfnFaKHSEVyNdFWEj1bmnZoA8ZnWLVbApump').toBase58();
  const programId = new PublicKey('ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7').toBase58();

  for (const epoch of [0, 1, 7, 130, 4_294_967_296]) {
    assert.equal(
      epochPdaSite(mint, epoch, programId).toBase58(),
      epochPdaNode(mint, epoch, programId).toBase58(),
      `epoch ${epoch}`,
    );
  }
});

test('the site refuses to decode an account of the wrong type', async () => {
  await assert.rejects(() => decodeConfigSite(new Uint8Array(epochBytes())), /not a Config/);
  await assert.rejects(() => decodeEpochSite(new Uint8Array(configBytes())), /not an? Epoch/);
});

test('an undersized bitmap is detectable from the epoch account alone (D2)', async () => {
  const honest = await decodeEpochSite(new Uint8Array(epochBytes({ leafCount: 9 })));
  assert.equal(bitmapIsSized(honest), true);

  // A root claiming 9 leaves with room for 8 strands the ninth, permanently.
  const stranded = await decodeEpochSite(
    new Uint8Array(epochBytes({ leafCount: 9, bits: Buffer.alloc(1) })),
  );
  assert.equal(bitmapIsSized(stranded), false);
});

test('a zeroed root is recognised as the nobody-called-out epoch', async () => {
  const empty = await decodeEpochSite(
    new Uint8Array(epochBytes({ leafCount: 0, bits: Buffer.alloc(0), root: Buffer.alloc(32) })),
  );
  assert.equal(isZeroRoot(empty), true);
});

// ── 2. the §7.8 states ─────────────────────────────────────────────────────

const WINDOW = { start: 1_767_225_600, end: 1_767_312_000, epoch: 0 };
const NOW = WINDOW.start + 3600;

function facts(overrides = {}) {
  return {
    now: NOW,
    window: WINDOW,
    minHoldRaw: MIN_HOLD_RAW,
    currentRaw: MIN_HOLD_RAW * 2n,
    holdRaw: MIN_HOLD_RAW * 2n,
    callout: { checked: true, lastAt: NOW - 600, activeInWindow: true },
    lockout: { locked: false, lastDecreaseAt: null, liftsAt: null },
    ...overrides,
  };
}

test('a wallet holding nothing is told so, and told what the minimum is', () => {
  const s = standingFor(facts({ currentRaw: 0n, holdRaw: 0n }));
  assert.equal(s.state, 'not-a-holder');
  assert.equal(s.eligible, false);
  assert.match(s.detail.join(' '), /100,000 CALLPOOL/);
});

test('below the floor names the condition and explains it is the minimum, not the balance now', () => {
  const s = standingFor(facts({ holdRaw: MIN_HOLD_RAW - 1n }));
  assert.equal(s.state, 'below-floor');
  assert.equal(s.eligible, false);
  assert.match(s.detail.join(' '), /lowest balance/i);
});

test('lockout is reported before the floor, so a locked wallet is never told to buy more', () => {
  // Both conditions fail at once. Telling someone to buy while they are locked
  // out costs them money and changes nothing (L1), so lockout must win.
  const s = standingFor(
    facts({
      holdRaw: 0n,
      currentRaw: 1n,
      lockout: { locked: true, lastDecreaseAt: NOW - 86_400, liftsAt: WINDOW.start + 7 * 86_400 },
    }),
  );
  assert.equal(s.state, 'locked-out');
  assert.match(s.detail.join(' '), /another wallet you own counts as selling/i);
  assert.match(s.detail.join(' '), /Buying back does not shorten it/i);
  assert.doesNotMatch(s.detail.join(' '), /buy more/i);
});

test('the lockout message states the exact date it lifts', () => {
  const liftsAt = WINDOW.start + LOCKOUT_EPOCHS * 86_400;
  const s = standingFor(
    facts({ lockout: { locked: true, lastDecreaseAt: NOW - 86_400, liftsAt } }),
  );
  assert.match(s.detail.join(' '), /2026-01-08/);
});

test('no callout today is actionable, and mentions updates as well as new callouts', () => {
  const s = standingFor(
    facts({ callout: { checked: true, lastAt: WINDOW.start - 86_400, activeInWindow: false } }),
  );
  assert.equal(s.state, 'no-activity');
  assert.match(s.detail.join(' '), /post an update/i);
  assert.match(s.detail.join(' '), /do not carry over/i);
});

test('a failed callout lookup is never rendered as "no callout"', () => {
  const s = standingFor(facts({ callout: { checked: false, lastAt: null, activeInWindow: false } }));
  assert.equal(s.state, 'callout-unknown');
  assert.equal(s.eligible, null, 'unknown is not the same as ineligible');
});

test('an eligible wallet is told the number is a projection and needs no action', () => {
  const s = standingFor(facts());
  assert.equal(s.state, 'eligible');
  assert.equal(s.eligible, true);
  assert.match(s.detail.join(' '), /projection/i);
  assert.match(s.detail.join(' '), /no wallet to connect/i);
});

test('unfetched balances render as pending, never as zero', () => {
  const s = standingFor(facts({ currentRaw: null, holdRaw: null }));
  assert.equal(s.state, 'pending');
  assert.equal(s.eligible, null);
});

test('a settled, paid epoch reports the amount and that no action was needed', () => {
  const s = standingFor(
    facts({
      settlement: {
        posted: true,
        claimed: true,
        amountLamports: 1_500_000_000n,
        signature: 'sig',
        challengeEndsAt: NOW - 10,
      },
    }),
  );
  assert.equal(s.state, 'paid');
  assert.match(s.headline, /1\.5 SOL/);
  assert.match(s.detail.join(' '), /No action was required/i);
});

test('inside the challenge window the page says nobody can stop a bad root', () => {
  const s = standingFor(
    facts({
      settlement: {
        posted: true,
        claimed: false,
        amountLamports: 2_000_000_000n,
        challengeEndsAt: NOW + 3600,
      },
    }),
  );
  assert.equal(s.state, 'challenge-window');
  assert.match(s.detail.join(' '), /nobody can stop it/i);
  assert.doesNotMatch(s.detail.join(' '), /trustless/i);
});

test('dust below the send threshold is carried, and said to be carried, not lost', () => {
  const s = standingFor(
    facts({
      settlement: {
        posted: true,
        claimed: false,
        amountLamports: DUST_THRESHOLD_LAMPORTS - 1n,
        carriedLamports: DUST_THRESHOLD_LAMPORTS - 1n,
        challengeEndsAt: NOW - 10,
      },
    }),
  );
  assert.equal(s.state, 'withheld-dust');
  assert.match(s.detail.join(' '), /not forfeiting/i);
});

test('an expired epoch is shown rather than silently vanished', () => {
  const s = standingFor(
    facts({ settlement: { posted: true, claimed: false, expired: true, amountLamports: 1n } }),
  );
  assert.equal(s.state, 'expired');
  assert.match(s.detail.join(' '), /never quietly vanish/i);
});

test('a pending payout explains that submitting cannot redirect the money', () => {
  const s = standingFor(
    facts({
      settlement: {
        posted: true,
        claimed: false,
        amountLamports: 500_000_000n,
        challengeEndsAt: NOW - 10,
      },
    }),
  );
  assert.equal(s.state, 'payout-pending');
  assert.match(s.detail.join(' '), /cannot redirect/i);
});

test('no state anywhere quotes a dollar figure, a price, or a yield (L4, L9)', () => {
  const cases = [
    facts({ currentRaw: 0n, holdRaw: 0n }),
    facts({ holdRaw: MIN_HOLD_RAW - 1n }),
    facts({ lockout: { locked: true, lastDecreaseAt: NOW, liftsAt: NOW + 100 } }),
    facts({ callout: { checked: true, lastAt: null, activeInWindow: false } }),
    facts(),
  ];
  for (const c of cases) {
    const s = standingFor(c);
    const text = `${s.headline} ${s.detail.join(' ')}`;
    assert.doesNotMatch(text, /\$/, `no dollar sign in ${s.state}`);
    assert.doesNotMatch(text, /\bAPY\b|\byield\b|\bAPR\b/i, `no yield framing in ${s.state}`);
  }
});

// ── 3. the two clocks ──────────────────────────────────────────────────────

test('every hourly state carries the provisional flag', () => {
  const base = { now: NOW, lastSampleAt: NOW - 600 };
  for (const state of [
    hourlyState(base),
    hourlyState({ ...base, calculating: true }),
    hourlyState({ now: NOW, lastSampleAt: NOW - 8000 }),
    hourlyState({ now: NOW, lastSampleAt: null }),
  ]) {
    assert.equal(state.provisional, true, `${state.state} must be provisional`);
  }
});

test('an hourly refresh more than an hour late is reported as stalled, not as fresh', () => {
  const fresh = hourlyState({ now: NOW, lastSampleAt: NOW - 600 });
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.stale, false);

  const stalled = hourlyState({ now: NOW, lastSampleAt: NOW - 3 * 3600 });
  assert.equal(stalled.state, 'stalled');
  assert.equal(stalled.stale, true);
  assert.match(stalled.label, /behind schedule/);
});

// The page re-reads chain data every minute and keeps the last figures it
// actually read when a re-read fails. That is the right trade — a blank helps
// nobody — but it means a stopped page looks exactly like a working one unless
// it says otherwise, which is the §7.4 failure this pins down.

test('a successful refresh says nothing at all', () => {
  const note = freshnessNote({ readAt: NOW, failedAt: null });
  assert.equal(note.stale, false);
  assert.equal(note.label, null, 'nothing to say while the figures are live');
});

test('a failed refresh names the time the figures on screen were read', () => {
  const note = freshnessNote({ readAt: NOW - 300, failedAt: NOW });
  assert.equal(note.stale, true);
  assert.match(note.label, /not updating/);
  assert.ok(
    note.label.includes(utcTime(NOW - 300)),
    `expected the label to name ${utcTime(NOW - 300)}, got: ${note.label}`,
  );
});

test('failing before anything was ever read does not claim a reading time', () => {
  const note = freshnessNote({ readAt: null, failedAt: NOW });
  assert.equal(note.stale, true);
  assert.match(note.label, /nothing above has been read yet/);
  assert.ok(!/\d\d:\d\d/.test(note.label), 'no timestamp, because there is no reading to date');
});

test('the daily clock walks running → settling → challenge → payable', () => {
  const window = windowFor(WINDOW.start, 0);
  const challengeSeconds = 86_400;

  assert.equal(dailyState({ now: window.start + 10, window }).state, 'running');
  assert.equal(dailyState({ now: window.end + 10, window }).state, 'settling');

  const settledAt = window.end + 60;
  assert.equal(
    dailyState({ now: settledAt + 10, window, settledAt, challengeSeconds }).state,
    'challenge',
  );
  assert.equal(
    dailyState({ now: settledAt + challengeSeconds + 10, window, settledAt, challengeSeconds })
      .state,
    'payable',
  );
});

test('epoch indexing matches the on-chain genesis, not the local calendar', () => {
  const genesis = WINDOW.start;
  assert.equal(epochAt(genesis, genesis), 0);
  assert.equal(epochAt(genesis, genesis + 86_399), 0);
  assert.equal(epochAt(genesis, genesis + 86_400), 1);
  assert.equal(windowFor(genesis, 3).start, genesis + 3 * 86_400);
});

// ── formatting ─────────────────────────────────────────────────────────────

test('lamports render exactly, with no rounding in either direction', () => {
  assert.equal(formatSol(0n), '0');
  assert.equal(formatSol(1n), '0.000000001');
  assert.equal(formatSol(1_000_000_000n), '1');
  assert.equal(formatSol(1_500_000_000n), '1.5');
  assert.equal(formatSol(999_999_999n), '0.999999999');
});

test('token amounts render at the mint’s decimals', () => {
  assert.equal(formatTokens(100_000_000_000n, 6), '100,000');
  assert.equal(formatTokens(1n, 6), '0.000001');
  assert.equal(formatTokens(0n, 6), '0');
});

test('countdowns are exact, never "soon", and always tick', () => {
  // Seconds at every scale: the page updates this once a second, and a figure
  // that only moves once a minute reads as static text somebody typed.
  assert.equal(countdown(49_320), '13h 42m 00s');
  assert.equal(countdown(49_321), '13h 42m 01s');
  assert.equal(countdown(125), '2m 05s');
  assert.equal(countdown(-1), '—');
});

// ── configuration: nothing is invented ─────────────────────────────────────

test('an unconfigured site resolves every field to null, never to a default', () => {
  const config = siteConfig(undefined, '');
  assert.equal(config.configured, false);
  assert.equal(config.rpc, null);
  assert.equal(config.mint, null);
  assert.equal(config.snapshotsBase, null);
  assert.equal(snapshotUrl(config, 4), null);
  assert.equal(explorerUrl(config, 'address', null), null);
});

// `rpc: '/rpc'` is the shape the config wants — "the proxy on this origin",
// with no host named, so one file works on localhost and on callpool.fun. It
// has to become absolute before web3.js sees it: `Connection` parses its
// endpoint with `new URL()` and throws on a relative path, and that throw
// happens inside main(), so the page renders "The page failed to load" instead
// of any state it was designed to show. Caught in a browser, not in review.
test('a same-origin rpc path is resolved against the page before web3.js sees it', () => {
  const withLocation = (href, fn) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'location');
    const previous = globalThis.location;
    globalThis.location = { href, search: '' };
    try {
      return fn();
    } finally {
      if (had) globalThis.location = previous;
      else delete globalThis.location;
    }
  };

  const resolved = withLocation('https://callpool.fun/site/', () =>
    siteConfig({ cluster: 'mainnet', mainnet: { rpc: '/rpc' } }, ''),
  );
  assert.equal(resolved.rpc, 'https://callpool.fun/rpc');
  assert.doesNotThrow(() => new URL(resolved.rpc), 'web3.js will parse this');

  // An absolute endpoint is left exactly as configured.
  const absolute = withLocation('https://callpool.fun/site/', () =>
    siteConfig({ cluster: 'mainnet', mainnet: { rpc: 'https://provider.example/key' } }, ''),
  );
  assert.equal(absolute.rpc, 'https://provider.example/key');

  // And unset stays unset — never a default, never a guess.
  assert.equal(siteConfig({ cluster: 'mainnet', mainnet: {} }, '').rpc, null);
});

test('blank strings in config are unset, not empty values', () => {
  const config = siteConfig({ cluster: 'devnet', devnet: { rpc: '   ', mint: '' } }, '');
  assert.equal(config.rpc, null);
  assert.equal(config.mint, null);
});

// Mainnet is the default and the fallback, as of 2026-08-05. A devnet page is
// real chain reads of activity we generated ourselves, so it is reachable only
// by asking for it explicitly — never by a typo, an empty query string or a
// missing config file. The failure direction is a page saying the coin has not
// launched, which is safe; the other direction is a rehearsal read as a record.
test('?cluster= is the only way to leave mainnet, and anything unrecognised stays on it', () => {
  assert.equal(resolveCluster('?cluster=devnet'), 'devnet', 'asked for explicitly');
  assert.equal(resolveCluster('?cluster=mainnet'), 'mainnet');
  assert.equal(resolveCluster('?cluster=pretend'), 'mainnet', 'a typo must not reach devnet');
  assert.equal(resolveCluster('?cluster='), 'mainnet');
  assert.equal(resolveCluster(''), 'mainnet');
});

test('an unconfigured page resolves to mainnet, not to whatever was last built', () => {
  // No config.local.js at all — the state a fresh checkout and a misdeployed
  // host are both in.
  assert.equal(siteConfig(undefined, '').cluster, 'mainnet');
});

test('snapshot links land on the epoch directory regardless of trailing slashes', () => {
  const config = siteConfig(
    { cluster: 'devnet', devnet: { snapshotsBase: '/snapshots///' } },
    '',
  );
  assert.equal(snapshotUrl(config, 7), '/snapshots/epoch-7/');
  assert.equal(snapshotUrl(config, 7, 'tree.json'), '/snapshots/epoch-7/tree.json');
});

test('devnet explorer links pin the cluster, so they cannot resolve to mainnet', () => {
  const devnet = siteConfig({ cluster: 'devnet', devnet: {} }, '');
  assert.match(explorerUrl(devnet, 'address', 'abc'), /cluster=devnet/);
});

// ── the vendored library is the installed one ──────────────────────────────

test('site/vendor/solana-web3.min.js matches the installed @solana/web3.js', () => {
  const vendored = readFileSync(resolve(REPO_ROOT, 'site/vendor/solana-web3.min.js'));
  const installed = readFileSync(
    resolve(REPO_ROOT, 'node_modules/@solana/web3.js/lib/index.iife.min.js'),
  );
  assert.equal(
    vendored.equals(installed),
    true,
    'the vendored copy has drifted from the pinned dependency — re-copy it (see site/vendor/README.md)',
  );
});

// ── base58: no dependency, but not without an oracle ───────────────────────

test('base58 round-trips every byte pattern the decoders will meet', () => {
  for (let i = 0; i < 200; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Force a leading zero into a share of the cases: a pubkey starting with
    // 0x00 renders one character short if the leading-zero rule is missed, and
    // the result is a different, entirely plausible-looking address.
    if (i % 4 === 0) bytes[0] = 0;
    if (i % 8 === 0) bytes[1] = 0;

    const encoded = encodeBase58(bytes);
    assert.equal(encoded, new PublicKey(bytes).toBase58(), 'must match web3.js exactly');
    assert.deepEqual([...decodeBase58(encoded)], [...bytes], 'must round-trip');
  }
});

test('base58 handles the all-zero key, the case a naive implementation drops', () => {
  const zeros = new Uint8Array(32);
  assert.equal(encodeBase58(zeros), new PublicKey(zeros).toBase58());
  assert.equal(encodeBase58(zeros).length, 32);
});

test('base58 refuses characters outside the alphabet rather than guessing', () => {
  assert.throws(() => decodeBase58('0OIl'), /not base58/);
});

test('the epoch boundary is described from the window, not asserted as midnight', () => {
  const { boundaryLabel } = clocksModule;

  // Launch parameters: 86,400-second epochs aligned to midnight.
  assert.equal(boundaryLabel({ start: 1_767_225_600, end: 1_767_312_000 }), '00:00 UTC');

  // A rehearsal deployment on 60-second epochs must not announce a midnight
  // boundary every minute. It says the actual time instead.
  assert.equal(boundaryLabel({ start: 1_767_225_600, end: 1_767_225_660 }), '2026-01-01 00:01 UTC');
});

// ── the card charts refuse rather than draw ────────────────────────────────
//
// §7.4 says never render a number that cannot be sourced. A chart is a number:
// an empty axis is a claim that we looked and found nothing, and a bar drawn
// at zero because the balance never loaded is a claim that the balance is
// zero. Every function in site/js/graphs.js returns null instead, and the
// helpers in ui.js turn null into a sentence. These tests hold that line,
// because it is the one a redesign drops first.

test('a bar chart refuses to draw when any value is missing', () => {
  const partial = barSeries([
    { label: 'Pool', value: 5_000_000n, display: '0.005 SOL' },
    { label: 'Accrued', value: null, display: 'not read' },
  ]);
  assert.equal(partial, null);
});

test('a bar chart refuses when everything is zero, rather than drawing empty tracks', () => {
  // Three empty tracks look identical to three tracks that failed to load.
  assert.equal(
    barSeries([
      { label: 'Pool', value: 0n, display: '0 SOL' },
      { label: 'Accrued', value: 0n, display: '0 SOL' },
    ]),
    null,
  );
});

test('bars are scaled against the largest value in the set, from BigInt lamports', () => {
  const rows = barSeries([
    { label: 'Pool', value: 4_000_000_000n, display: '4 SOL' },
    { label: 'Accrued', value: 1_000_000_000n, display: '1 SOL', secondary: true },
  ]);
  assert.equal(rows[0].ratio, 1);
  assert.equal(rows[1].ratio, 0.25);
  assert.equal(rows[1].secondary, true);
  // The display string is carried through untouched — the bar never invents
  // its own formatting of a number formatted elsewhere.
  assert.equal(rows[0].display, '4 SOL');
});

test('a sparkline refuses below two points, because one point is not a trend', () => {
  assert.equal(sparkPath([]), null);
  assert.equal(sparkPath([42n]), null);
  assert.notEqual(sparkPath([42n, 43n]), null);
});

test('a sparkline refuses a series with a hole in it', () => {
  assert.equal(sparkPath([1n, null, 3n]), null);
});

test('a flat series is drawn at its own level, not pinned to a floor', () => {
  // Three identical epochs are a real shape and must not read as "zero".
  const flat = sparkPath([2n, 2n, 2n], { width: 220, height: 56, pad: 4 });
  assert.match(flat.line, /^M4 4 L110 4 L216 4$/);
});

test('a sparkline spans the box it is given, oldest point first', () => {
  const path = sparkPath([0n, 10n], { width: 100, height: 50, pad: 5 });
  // Lowest value at the bottom of the usable box, highest at the top.
  assert.match(path.line, /^M5 45 L95 5$/);
  assert.equal(path.last.x, 95);
  // The area closes to the bottom edge so the fill cannot float.
  assert.match(path.area, /L5 50 Z$/);
});

test('epoch progress refuses until the on-chain window has been read', () => {
  assert.equal(epochProgress({ window: null, now: 1_767_225_600 }), null);
  assert.equal(epochProgress({ window: WINDOW, now: Number.NaN }), null);
});

test('epoch progress is measured against the window length, not against a day', () => {
  // A rehearsal deployment on 60-second epochs is 50% through after 30
  // seconds. Measuring against 86,400 would draw a bar that never moves.
  const short = { start: 1_767_225_600, end: 1_767_225_660, epoch: 3 };
  assert.equal(epochProgress({ window: short, now: short.start + 30 }).elapsed, 0.5);
});

test('a closed epoch shows a full bar, never an overflowing one', () => {
  const past = epochProgress({ window: WINDOW, now: WINDOW.end + 99_999 });
  assert.equal(past.elapsed, 1);
  assert.equal(past.remaining, 0);
});

test('the challenge window is drawn relative to the epoch it follows', () => {
  const progress = epochProgress({
    window: WINDOW,
    now: WINDOW.start,
    challengeSeconds: 86_400,
  });
  assert.equal(progress.challengeShare, 1);
  assert.equal(epochProgress({ window: WINDOW, now: WINDOW.start }).challengeShare, 0);
});


// ── the audit trail's pager ────────────────────────────────────────────────
//
// Ten days a page. The clamping is the part worth asserting: the table
// re-reads every minute, so the row count can shrink under a reader sitting on
// the last page, and the wrong answer there is an empty table — which reads as
// "there is no history".

const days = (n) => Array.from({ length: n }, (_, i) => ({ index: n - i }));

test('a page is ten days', () => {
  assert.equal(PAGE_SIZE, 10);
  assert.equal(pageOf(days(30), 0).rows.length, 10);
});

test('pages walk forward through the list, newest first', () => {
  const items = days(30);
  assert.deepEqual(pageOf(items, 0).rows, items.slice(0, 10));
  assert.deepEqual(pageOf(items, 1).rows, items.slice(10, 20));
  assert.deepEqual(pageOf(items, 2).rows, items.slice(20, 30));
});

test('the position is 1-based and inclusive, because a person reads it', () => {
  const view = pageOf(days(30), 1);
  assert.equal(view.first, 11);
  assert.equal(view.last, 20);
  assert.equal(view.count, 30);
  assert.equal(view.totalPages, 3);
});

test('a short last page reports its real end, not a round number', () => {
  const view = pageOf(days(25), 2);
  assert.equal(view.rows.length, 5);
  assert.equal(view.first, 21);
  assert.equal(view.last, 25);
});

test('a page past the end clamps to the last real page, never to nothing', () => {
  const view = pageOf(days(30), 99);
  assert.equal(view.page, 2);
  assert.equal(view.rows.length, 10, 'an empty table would read as "no history"');
});

test('the row count shrinking under a reader clamps them back, still with rows', () => {
  // On page 2 of 3, then a refresh returns fewer epochs.
  const view = pageOf(days(12), 2);
  assert.equal(view.page, 1);
  assert.equal(view.rows.length, 2);
  assert.ok(view.rows.length > 0);
});

test('a negative or nonsense page is page one', () => {
  assert.equal(pageOf(days(30), -5).page, 0);
  assert.equal(pageOf(days(30), Number.NaN).page, 0);
});

test('one page needs no controls', () => {
  assert.equal(pageOf(days(10), 0).needed, false, 'exactly one full page');
  assert.equal(pageOf(days(3), 0).needed, false);
  assert.equal(pageOf(days(11), 0).needed, true, 'one row over is two pages');
});

test('an empty history is one page, no controls, and no phantom row numbers', () => {
  const view = pageOf([], 0);
  assert.deepEqual(view.rows, []);
  assert.equal(view.totalPages, 1);
  assert.equal(view.needed, false);
  assert.equal(view.first, 0);
  assert.equal(view.last, 0);
});

// ── what "so far" covers ───────────────────────────────────────────────────

test('the history covers every day, not the last thirty', () => {
  assert.deepEqual(epochIndices(0), [0], 'day one is one row');
  assert.deepEqual(epochIndices(4), [4, 3, 2, 1, 0], 'newest first');

  // The dry run reached epoch 130. A 30-epoch fetch would have started at 101.
  const all = epochIndices(130);
  assert.equal(all.length, 131, 'every epoch since genesis');
  assert.equal(all[0], 130);
  assert.equal(all.at(-1), 0, 'including the first day');
});

test('"paid out so far" adds up every day, not just the ones on screen', () => {
  // 40 epochs of 1 SOL each. Summing only the newest 30 gives 30 — and the
  // caption under this number promises every past day.
  const epochs = Array.from({ length: 40 }, (_, i) => ({
    index: 39 - i,
    posted: true,
    claimedLamports: 1_000_000_000n,
  }));

  assert.equal(totalClaimed(epochs), 40_000_000_000n);
  assert.notEqual(totalClaimed(epochs), 30_000_000_000n, 'a 30-epoch window would undercount');
});

test('an unposted day contributes nothing and breaks nothing', () => {
  const epochs = [
    { index: 2, posted: true, claimedLamports: 5n },
    { index: 1, posted: false },
    { index: 0, posted: true, claimedLamports: 7n },
  ];
  assert.equal(totalClaimed(epochs), 12n);
});

// ── the daily record before there is a record ──────────────────────────────
//
// "No days yet" leaves a reader wondering whether the page is broken, whether
// they are early, or whether something went wrong. All three are answerable.

const DAY = 86_400;

test('before launch it says the record starts when the coin does', () => {
  const note = firstRecordNote({ now: 1_760_000_000, window: null });
  assert.match(note, /launches/);
  assert.doesNotMatch(note, /NaN|undefined|Invalid/);
});

test('on day one it names the boundary and how far off it is', () => {
  const start = 1_760_000_000 - (1_760_000_000 % DAY);
  const window = { start, end: start + DAY };
  const note = firstRecordNote({ now: start + 3600, window });

  assert.match(note, /still running/);
  assert.match(note, /00:00 UTC/, 'a real day closes at midnight, so say so');
  assert.doesNotMatch(note, /NaN|undefined|Invalid/);
});

// The wording must not promise 24 hours. Days close on the epoch boundary and
// launch happens somewhere inside the first one — launch at 22:00 UTC and the
// first day closes two hours later. Promising a day and delivering in two hours
// is harmless; the reverse is not.
test('the wait is measured to the boundary, not asserted as 24 hours', () => {
  const start = 1_760_000_000 - (1_760_000_000 % DAY);
  const window = { start, end: start + DAY };

  // The risk is telling a reader "24 hours after launch" as though it were the
  // rule. Launch at 22:00 UTC and the first day closes two hours later — the
  // page must say two hours, because that is what is true.
  assert.match(
    firstRecordNote({ now: start + DAY - 7200, window }),
    /about 2 hours from now/,
    'a coin launched late in the day settles its first day the same night',
  );

  // Saying "about 24 hours" one minute in is not the same claim — it is
  // measured, and it is correct.
  assert.match(firstRecordNote({ now: start + 60, window }), /about 24 hours from now/);
});

test('between the day closing and the root landing it says so, not nothing', () => {
  const start = 1_760_000_000 - (1_760_000_000 % DAY);
  const window = { start, end: start + DAY };
  const note = firstRecordNote({ now: start + DAY + 30, window });

  assert.match(note, /just closed/);
  assert.match(note, /settled/);
});

test('a short rehearsal epoch reports its real end, not a fictional midnight', () => {
  const window = { start: 1_760_000_000, end: 1_760_000_300 };
  const note = firstRecordNote({ now: 1_760_000_100, window });
  assert.doesNotMatch(note, /00:00 UTC/, '300s epochs do not end at midnight');
});

test('the wait is said the way a person would say it, not as a stopwatch', () => {
  const start = 1_760_000_000 - (1_760_000_000 % DAY);
  const window = { start, end: start + DAY };

  assert.match(firstRecordNote({ now: start + 3600, window }), /about 23 hours from now/);
  assert.match(firstRecordNote({ now: start + DAY - 300, window }), /about 5 minutes from now/);
  assert.match(firstRecordNote({ now: start + DAY - 30, window }), /any moment now/);

  // No stopwatch readings in a sentence that begins with "about".
  for (const offset of [3600, DAY - 3540, DAY - 300]) {
    assert.doesNotMatch(firstRecordNote({ now: start + offset, window }), /\d+m \d+s/);
  }
});

test('an hour is "an hour", not "1 hours"', () => {
  const start = 1_760_000_000 - (1_760_000_000 % DAY);
  const window = { start, end: start + DAY };
  assert.match(firstRecordNote({ now: start + DAY - 3600, window }), /about an hour from now/);
});
