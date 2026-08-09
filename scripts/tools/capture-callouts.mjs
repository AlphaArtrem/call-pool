#!/usr/bin/env node
//
// scripts/tools/capture-callouts.mjs — measure the real callout feed, and
// distil its SHAPE into something the rehearsal can be built from.
//
//   node scripts/tools/capture-callouts.mjs --mints <MINT>,<MINT>,…
//   ... --out epochs/devnet/callout-shape.json    # measurements + the staging profile
//   ... --raw /tmp/capture.json                   # the unanonymised capture, for eyeballing
//
// The profile is **evidence, not configuration**. `mock-callouts.mjs` takes an
// explicit `--updates N`, because the gate matrix needs staging that is
// deterministic and re-runnable; the profile is how you know what N is
// realistic. `shapedRecord` / `shapedUpdate` here are what it stages *with*,
// and those are the parts that must not drift from the live shape.
//
// ## Why this exists
//
// Every rehearsal so far has settled against records with **seven fields**
// (`id`, `walletAddress`, `tokenAddress`, `createdAt`, and the three L7 flags),
// no updates, and no truncation that was not hand-staged. A real mainnet
// callout carries **twenty-nine** fields and updates are ordinary: measured
// 2026-08-09 across five live coins, 220 callouts carried 161 author updates,
// and one coin had 83 updates against 50 callouts.
//
// So the rehearsal has been proving the settlement against a record shape that
// does not exist. This reads the real thing — through the repo's own
// `fetchMintCallouts` / `fetchCalloutUpdates`, so what is measured is exactly
// what production will call — and writes a profile that `mock-callouts.mjs`
// stages from.
//
// ## What it deliberately does NOT keep
//
// The capture is other people's writing, usernames, avatars and X profiles.
// None of it decides a payout, and none of it belongs in this repository or on
// a rehearsal box. **The profile keeps structure and statistics; it keeps no
// person.** Content is synthesised, identity fields are regenerated, and the
// wallet addresses are dropped entirely — `mock-callouts.mjs` supplies the
// rehearsal's own cast instead.
//
// Pass `--raw` to keep the unanonymised capture for a one-off look. Write it to
// a temporary directory, not into the tree.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  FEED_CAP,
  fetchCalloutUpdates,
  fetchMintCallouts,
  isTruncated,
} from '../lib/callouts.mjs';
import { createCalloutKeySource } from '../lib/callout-key.mjs';

/** Space requests slightly; the API showed no rate limiting at 40 sequential. */
const REQUEST_SPACING_MS = 60;

function parseArgs(argv) {
  const args = { out: 'epochs/devnet/callout-shape.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.mints) throw new Error('--mints <MINT>[,<MINT>…] is required');
  return args;
}

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * Fetch one coin's feed and every callout's updates.
 *
 * The updates loop is the expensive half — one request per callout — and it is
 * the half that matters, because it is the only way to see how common updates
 * actually are. Guessing that number is what produced a rehearsal with none.
 */
export async function captureMint(mint, { keySource, log = () => {} }) {
  const feed = await fetchMintCallouts(mint, { keySource });
  const updates = {};
  for (const callout of feed) {
    const own = await fetchCalloutUpdates(mint, callout.id, { keySource });
    if (own.length > 0) updates[callout.id] = own;
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }
  log(`${mint}  ${feed.length} callouts, ${Object.values(updates).flat().length} updates`);
  return { mint, feed, updates };
}

/**
 * What the capture says about the feed, as facts rather than impressions.
 *
 * Every figure here has been wrong in this project at least once by being
 * assumed instead of measured — the cap, the truncation frequency, whether a
 * wallet can call the same coin twice, whether `replyCount` can be trusted.
 */
export function measure(coins, { windowSeconds = 86_400, now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = [];
  let multiCallers = 0;
  let replyCountDiverged = 0;
  let flagged = 0;
  let records = 0;

  for (const { mint, feed, updates } of coins) {
    const times = feed.map((r) => seconds(r.createdAt)).filter(Number.isFinite);
    const window = { start: now - windowSeconds, end: now };
    const seen = new Set();
    for (const r of feed) {
      records++;
      if (seen.has(r.walletAddress)) multiCallers++;
      seen.add(r.walletAddress);
      if ((updates[r.id] ?? []).length !== r.replyCount) replyCountDiverged++;
      if (r.isSpam || r.isHarmful || r.deletedAt) flagged++;
    }
    rows.push({
      mint,
      feedSize: feed.length,
      atCap: feed.length >= FEED_CAP,
      truncatedOverWindow: isTruncated(feed, window),
      spanHours: times.length ? Number(((Math.max(...times) - Math.min(...times)) / 3600).toFixed(1)) : 0,
      calloutsWithUpdates: Object.keys(updates).length,
      totalUpdates: Object.values(updates).flat().length,
    });
  }

  return {
    coins: rows,
    records,
    multiCallers,
    replyCountDiverged,
    flaggedInTheWild: flagged,
    atCap: rows.filter((r) => r.atCap).length,
    truncated: rows.filter((r) => r.truncatedOverWindow).length,
  };
}

/**
 * One synthetic record in the real record's shape.
 *
 * Every field the live API returns is present, with a value of the right type —
 * because the point is that settlement, the mock API and the trust-boundary
 * test all meet the shape they will meet in production. The fields that decide
 * money (`walletAddress`, `tokenAddress`, `createdAt`, the L7 flags) are left
 * for the caller to fill; everything else is filled here and is scenery.
 *
 * `mentions` and `mentionedUserIds` are kept as empty arrays rather than
 * dropped: they are arrays in every observed record, and a consumer that does
 * `record.mentions.length` should not start throwing the first time it meets a
 * real one.
 */
export function shapedRecord({ id, walletAddress, tokenAddress, createdAt, index = 0 }) {
  return {
    id,
    communityId: PLACEHOLDER_COMMUNITY,
    userId: randomUUID(),
    businessId: PLACEHOLDER_BUSINESS,
    username: `rehearsal_${String(index).padStart(3, '0')}`,
    displayName: `Rehearsal Caller ${index}`,
    profileImageUrl: null,
    content: `Rehearsal callout ${index}. Synthetic content — no real post is reproduced here.`,
    mediaUrl: null,
    likeCount: 0,
    liked: false,
    createdAt,
    multiplier: 1,
    maxMultiplier: 1,
    maxMultiplierAt: createdAt,
    calloutPrice: 0,
    calloutMarketCap: 0,
    isSpam: false,
    isHarmful: false,
    userTwitterUrl: null,
    followerCount: 0,
    replyCount: 0,
    tokenAddress,
    walletAddress,
    source: null,
    deletedAt: null,
    deletedReason: null,
    mentionedUserIds: [],
    mentions: [],
  };
}

/** The same, for an author's update on their own callout (L2). */
export function shapedUpdate({ id, parentCalloutId, walletAddress, tokenAddress, createdAt, index = 0 }) {
  const base = shapedRecord({ id, walletAddress, tokenAddress, createdAt, index });
  // The update record's own field set, as measured: it has no callout-specific
  // pricing fields and it carries the two parent pointers plus `isUpdate`.
  const {
    multiplier, maxMultiplier, maxMultiplierAt, calloutPrice, calloutMarketCap, businessId,
    ...shared
  } = base;
  return {
    ...shared,
    content: `Rehearsal update ${index}. Synthetic content.`,
    parentMessageId: null,
    parentCalloutId,
    isUpdate: true,
  };
}

const PLACEHOLDER_COMMUNITY = '00000000-0000-4000-8000-000000000001';
const PLACEHOLDER_BUSINESS = '00000000-0000-4000-8000-000000000002';

/**
 * The staging profile: how often people update, and how long after.
 *
 * Derived from the capture rather than invented, because "how many callouts
 * carry an update" is exactly the sort of number that gets guessed at zero and
 * then never tested. Offsets are clamped to the observed range so a staged
 * update lands somewhere a real one plausibly would.
 */
export function profileFrom(coins) {
  let callouts = 0;
  let withUpdates = 0;
  const perCallout = [];
  const offsets = [];

  for (const { feed, updates } of coins) {
    const byId = Object.fromEntries(feed.map((r) => [r.id, r]));
    for (const r of feed) {
      callouts++;
      const own = updates[r.id] ?? [];
      if (own.length === 0) continue;
      withUpdates++;
      perCallout.push(own.length);
      for (const u of own) {
        const delta = seconds(u.createdAt) - seconds(byId[r.id].createdAt);
        if (Number.isFinite(delta) && delta >= 0) offsets.push(delta);
      }
    }
  }

  const sorted = [...offsets].sort((a, b) => a - b);
  return {
    callouts,
    calloutsWithUpdates: withUpdates,
    updateRate: callouts ? Number((withUpdates / callouts).toFixed(3)) : 0,
    updatesPerUpdatedCallout: {
      min: perCallout.length ? Math.min(...perCallout) : 0,
      max: perCallout.length ? Math.max(...perCallout) : 0,
      mean: perCallout.length
        ? Number((perCallout.reduce((a, b) => a + b, 0) / perCallout.length).toFixed(2))
        : 0,
    },
    updateDelaySeconds: {
      min: sorted[0] ?? 0,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mints = args.mints.split(',').map((s) => s.trim()).filter(Boolean);
  const keySource = createCalloutKeySource({ mint: mints[0], log: console.log });

  console.log(`\nCALLPOOL — capturing the live callout feed for ${mints.length} coin(s)\n`);

  const coins = [];
  for (const mint of mints) {
    coins.push(await captureMint(mint, { keySource, log: (line) => console.log(`  ${line}`) }));
  }

  const stats = measure(coins);
  const profile = profileFrom(coins);

  console.log(`\n── what the feed actually looks like ──\n`);
  for (const row of stats.coins) {
    console.log(
      `  ${row.mint}\n` +
        `    ${row.feedSize} records${row.atCap ? ' (AT THE CAP)' : ''}, ` +
        `spanning ${row.spanHours}h, truncated over 24h: ${row.truncatedOverWindow}\n` +
        `    ${row.calloutsWithUpdates} callouts carry ${row.totalUpdates} updates`,
    );
  }
  console.log(
    `\n  ${stats.atCap}/${stats.coins.length} coins at the ${FEED_CAP}-record cap; ` +
      `${stats.truncated}/${stats.coins.length} truncated over a 24h window.\n` +
      `  ${stats.records} records, ${stats.multiCallers} wallet(s) calling the same coin twice.\n` +
      `  replyCount disagreed with the updates fetched ${stats.replyCountDiverged} time(s) — ` +
      'it is not a completeness check.\n' +
      `  ${stats.flaggedInTheWild} record(s) carried a moderation flag. L7's path is NOT ` +
      'exercised by real data;\n  the rehearsal has to inject it (mock-callouts --spam).',
  );

  const out = resolve(process.cwd(), args.out);
  writeFileSync(out, `${JSON.stringify({ capturedAt: Math.floor(Date.now() / 1000), mints, stats, profile }, null, 2)}\n`);
  console.log(`\nprofile   ${out}`);
  console.log('          structure and statistics only — no captured content, no real wallet.');

  if (args.raw) {
    const rawPath = resolve(process.cwd(), args.raw);
    writeFileSync(rawPath, `${JSON.stringify({ capturedAt: Math.floor(Date.now() / 1000), coins }, null, 2)}\n`);
    console.log(`raw       ${rawPath}  ⚠️ real people's posts — keep it out of the tree`);
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
