#!/usr/bin/env node
//
// scripts/tools/mock-callouts.mjs — callout records, without pump.fun.
//
// **The seam is the store, not the API.** `snapshot.mjs` never calls pump.fun:
// it reads a callout store off disk and takes the records inside the window.
// `poll-callouts.mjs` is the only thing that talks to the network, and its
// whole job is to write that file. So mocking callouts means writing the store,
// and no mock HTTP server is needed for the path that decides money.
//
// Records are merged with the **real** `mergeById`, so `firstSeenAt` and
// `lastSeenAt` behave here exactly as they do in production — including the
// retroactive-flag case, which is the one that is otherwise invisible.
//
// Usage — run it once per epoch, from the dry-run loop or a `watch`:
//   node scripts/tools/mock-callouts.mjs
//   node scripts/tools/mock-callouts.mjs --spam steady   # flag it before settlement
//   node scripts/tools/mock-callouts.mjs --silent        # an epoch nobody called in
//   node scripts/tools/mock-callouts.mjs --only steady,minnow
//
// Driving the 50-record cap, which is what the final devnet test is for:
//   ... --count 49              # C3 — just under; the normal path
//   ... --count 50              # C4 — TRUNCATED. The boundary is inclusive.
//   ... --count 49 --before 1   # C5 — 50 written, one outside; NOT truncated
//   ... --count 60              # C6 — well over
//   ... --before 1 --after 1    # C10/C11 — near-misses at each edge
//
// Updates — the L2 path, which nothing staged until 2026-08-09 (C9):
//   ... --updates 5             # 5 callers also update their own callout
//   ... --updates 3 --update-age 27301
//                               # the parent is dated BEFORE the window and only
//                               # the update lands in it, so the update alone
//                               # earns the epoch. 27,301s is the real median
//                               # delay measured across five live coins.
//
// Records are written in the **full mainnet shape** (29 fields), not the seven
// the settlement happens to read — see `capture-callouts.mjs` for where that
// shape was measured and why a seven-field rehearsal was proving too little.
//
// ⚠️ It proves **our settlement** and nothing whatsoever about pump.fun's API.
// Devnet proofs 1, 1b, 2, 2b, 3, 12b and 22 still need the real feed on devnet,
// and they are the ones that gate launch.

import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';

import { FEED_CAP, mergeById, recordsInWindow } from '../lib/callouts.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { iso } from '../lib/epoch.mjs';
import { epochIndexFor, fetchConfig, windowForEpoch } from '../lib/program.mjs';
import { readStore, STORE_PATH, writeStore } from '../lib/store.mjs';
import { shapedRecord, shapedUpdate } from './capture-callouts.mjs';
import { assertNotMainnet, DEVNET_STORE_PATH, readManifest } from './devnet.mjs';

/**
 * Which cast members call out in a given epoch, counting from the first.
 *
 * `fader` is the whole point of this table: activity does not carry over, so a
 * wallet that called out yesterday and holds the same tokens today must earn
 * nothing today. Nothing else in the rehearsal produces that row.
 */
function callsOut(name, epochsIn, fadeAfter) {
  if (name === 'fader') return epochsIn < fadeAfter;
  return true;
}

/**
 * Which cast members produce a record, and when each one is dated.
 *
 * Pure, and exported, because the 50-record boundary is the owner's headline
 * ask and landing on it exactly is fiddly enough to be worth asserting without
 * a chain. Two things make it subtle:
 *
 * **`snapshot.mjs` measures truncation on records it has already filtered to
 * the window.** `isTruncated` also tests that the oldest record is not older
 * than the window start, but after that filter it always is — so at the
 * settlement end the rule degenerates to `count >= FEED_CAP`. The oldest-record
 * half of the test only bites in `poll-callouts.mjs`, which sees the raw feed.
 * That is why `before` here is what produces C5: a record dated outside the
 * window is dropped by the filter and the in-window count falls to 49.
 *
 * **The boundary is inclusive.** Exactly 50 in-window records IS truncated.
 *
 * @param {number} count  how many in-window records to write. Defaults to the
 *   whole selection, which is the ordinary per-epoch behaviour.
 * @param {number} before  extra records dated before the window opens — they
 *   must not count, and they are what turns 50 into "50 with one outside".
 * @param {number} after  extra records dated after it closes. Same, at the
 *   other end (C11).
 * @param {number} updates  how many of the in-window callers also post an
 *   update to their own callout (L2 / C9). See `stageUpdates` below.
 * @param {number} updateAgeSeconds  when > 0, the callout being updated is
 *   dated this far BEFORE the window and only the update lands inside it —
 *   the case that earns the window on the update alone.
 */
export function selectRecords({
  cast, epoch, mint, window, createdAt, epochsIn, fadeAfter,
  only = null, silent = false, count = null, before = 0, after = 0,
  updates = 0, updateAgeSeconds = 0,
}) {
  if (silent) return [];

  const eligible = cast.filter((member) =>
    only ? only.has(member.name) : callsOut(member.name, epochsIn, fadeAfter),
  );

  const wanted = count == null ? eligible.length : count;
  if (wanted > eligible.length) {
    throw new Error(
      `--count ${wanted} needs ${wanted} callers but only ${eligible.length} are available ` +
        `in this epoch. Build a bigger cast (mk-pump-cast.mjs --count) or lower it.`,
    );
  }
  // Each record comes from a distinct wallet, so the out-of-window ones need
  // callers of their own. Reusing an in-window wallet would write a second
  // record for someone already counted, which changes nothing observable and
  // would make a failed near-miss test look like a passing one.
  if (wanted + before + after > eligible.length) {
    throw new Error(
      `${wanted} in-window + ${before} before + ${after} after needs ` +
        `${wanted + before + after} distinct callers, and only ${eligible.length} are available.`,
    );
  }

  const record = (member, at, index) =>
    shapedRecord({
      // Stable per wallet per epoch, so re-running inside the same window
      // merges rather than duplicating — and `firstSeenAt` keeps the first
      // sighting, exactly as the hourly poll does. The suffix keeps an
      // out-of-window record from colliding with the same wallet's real one.
      id: `mock-${epoch}-${member.name}${at === createdAt ? '' : `-${at < window.start ? 'pre' : 'post'}`}`,
      walletAddress: member.address,
      tokenAddress: mint,
      createdAt: new Date(at * 1000).toISOString(),
      index,
    });

  const inWindow = eligible.slice(0, wanted).map((m, i) => record(m, createdAt, i));

  // Dated a minute outside on each side. Far enough that no rounding pulls
  // them back in, close enough that they are obviously meant to be near-misses.
  const outside = [
    ...eligible.slice(wanted, wanted + before).map((m, i) => record(m, window.start - 60, wanted + i)),
    ...eligible
      .slice(wanted + before, wanted + before + after)
      .map((m, i) => record(m, window.end + 60, wanted + before + i)),
  ];

  const staged = [...inWindow, ...outside];
  if (updates <= 0) return staged;

  return [...staged, ...stageUpdates({ callers: eligible, epoch, mint, window, createdAt, updates, updateAgeSeconds, staged })];
}

/**
 * Author updates on their own callouts — the L2 path, and C9.
 *
 * **Nothing in this repository has ever staged one.** Until now `mock-callouts`
 * wrote callouts only, so `parentCalloutId`/`isUpdate` records existed in
 * production and in the unit tests and nowhere in between — C9 was listed in
 * the gate matrix as unobserved and was, in fact, unstageable.
 *
 * Measured on five live coins 2026-08-09: **30% of callouts carry an update**,
 * 2.42 on average, up to 29 on one — so an epoch with none is the unusual one.
 *
 * `updateAgeSeconds` is the case that matters most and the one an optimisation
 * would break. The real median delay between a callout and its update is ~7.6
 * hours, which at a ten-minute epoch is forty-five epochs later: the callout is
 * long outside the window and **the update alone earns it**. Set it and the
 * parent is dated before the window, so a settlement that only looks at
 * callouts credits nobody and a correct one credits the author.
 */
export function stageUpdates({ callers, epoch, mint, window, createdAt, updates, updateAgeSeconds = 0, staged = [] }) {
  const chosen = callers.slice(0, updates);
  if (chosen.length < updates) {
    throw new Error(
      `--updates ${updates} needs ${updates} callers and only ${chosen.length} are available.`,
    );
  }

  const out = [];
  const byWallet = new Map(staged.map((r) => [r.walletAddress, r]));

  for (const [i, member] of chosen.entries()) {
    let parent = byWallet.get(member.address);

    if (updateAgeSeconds > 0) {
      // Re-date the parent outside the window (or create one there), so only
      // the update falls inside it. A distinct id, because this is a different
      // callout from the in-window one and must not merge with it.
      parent = shapedRecord({
        id: `mock-${epoch}-${member.name}-parent`,
        walletAddress: member.address,
        tokenAddress: mint,
        createdAt: new Date((window.start - updateAgeSeconds) * 1000).toISOString(),
        index: i,
      });
      out.push(parent);
    }

    if (!parent) {
      throw new Error(
        `${member.name} has no callout in epoch ${epoch} to update. Stage the callouts ` +
          'first, or pass --update-age to date the parent before the window.',
      );
    }

    out.push(
      shapedUpdate({
        id: `mock-${epoch}-${member.name}-update`,
        parentCalloutId: parent.id,
        walletAddress: member.address,
        tokenAddress: mint,
        // Inside the window regardless of where the parent sits — that is the
        // whole point of the row.
        createdAt: new Date((createdAt + 1) * 1000).toISOString(),
        index: i,
      }),
    );
  }
  return out;
}

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, silent: false, 'fade-after': '3' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--silent') args.silent = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mock-callouts.mjs');

  const manifest = readManifest();
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();

  // Belt and braces on top of the cluster check: the production store is one
  // file at one path, and a fabricated record reaching it would be settled as
  // real. Naming the path is not enough — this refuses it outright.
  const storePath = args.store ? resolve(process.cwd(), args.store) : DEVNET_STORE_PATH;
  if (storePath === STORE_PATH) {
    throw new Error(
      `${STORE_PATH} is the store the production crank settles from. Fabricated records ` +
        'must never reach it. Write somewhere under epochs/devnet/ instead.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const epoch = args.epoch === undefined ? epochIndexFor(alignedNow(now, config), config) : Number(args.epoch);
  const window = windowForEpoch(config, epoch);

  console.log(`\nCALLPOOL — mock callouts for epoch ${epoch}`);
  console.log(`window    ${iso(window.start)} → ${iso(window.end)}`);
  console.log(`store     ${storePath}`);

  // `recordsInWindow` filters on `createdAt`, so a record written outside the
  // window it is meant for simply vanishes at settlement — silently, which is
  // the worst way for a rehearsal to be wrong.
  const createdAt = now >= window.start && now < window.end ? now : window.start + 1;
  if (createdAt !== now) {
    console.log(`note      epoch ${epoch} is not the open one; dating records at its start`);
  }

  const store = readStore(storePath);
  const epochsIn = epoch - manifest.startEpoch;
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const records = selectRecords({
    cast: manifest.cast,
    epoch,
    mint,
    window,
    createdAt,
    epochsIn,
    fadeAfter: Number(args['fade-after']),
    only,
    silent: args.silent,
    count: args.count === undefined ? null : Number(args.count),
    before: args.before === undefined ? 0 : Number(args.before),
    after: args.after === undefined ? 0 : Number(args.after),
    updates: args.updates === undefined ? 0 : Number(args.updates),
    updateAgeSeconds: args['update-age'] === undefined ? 0 : Number(args['update-age']),
  });

  const inWindowCount = records.filter((r) => {
    const at = Math.floor(Date.parse(r.createdAt) / 1000);
    return at >= window.start && at < window.end;
  }).length;
  if (inWindowCount >= FEED_CAP) {
    console.log(
      `truncation ${inWindowCount} records in the window — at or over the ${FEED_CAP} cap, so ` +
        'settlement will REFUSE without --holders (C4/C6/C8)',
    );
  }

  // The --before trap (S3.10), reached from a new direction: an --update-age
  // parent is a record dated BEFORE this window, and if it lands inside a
  // staged epoch's window it changes THAT epoch's count — silently, which on a
  // cap-boundary row like C4 turns "exactly 50" into 51 and destroys the row.
  // 27,301s (the measured median) is 45 epochs back at this clock and lands
  // before genesis; a small value does not. Say where each one lands.
  for (const r of records) {
    const at = Math.floor(Date.parse(r.createdAt) / 1000);
    if (at >= window.start || !r.id.endsWith('-parent')) continue;
    const landsIn = Math.floor((at - config.genesisTs) / config.epochSeconds);
    if (landsIn >= 0) {
      console.log(
        `⚠️ WARNING  ${r.id} is dated inside epoch ${landsIn}'s window and will be COUNTED\n` +
          `            there. If epoch ${landsIn} is staged at a cap boundary (C4), this breaks\n` +
          '            it — raise --update-age until the parent predates genesis.',
      );
    } else {
      console.log(`note      ${r.id} predates genesis (harmless — belongs to no epoch)`);
    }
  }

  // Retroactive moderation (L7): the flag lands on a record already in the
  // store, before settlement, and the wallet moves from `counted` to `excluded`
  // in the published callouts.json. The flags are a third party's, mutable and
  // retroactive — that is disclosed rather than solved, and this is the only
  // way to see it happen.
  if (args.spam) {
    const member = manifest.cast.find((m) => m.name === args.spam);
    if (!member) throw new Error(`no cast member named ${args.spam} in the manifest`);
    const index = records.findIndex((r) => r.walletAddress === member.address);
    const existing = recordsInWindow(store.callouts ?? {}, window).find(
      (r) => r.walletAddress === member.address,
    );
    const target = index === -1 ? existing : records[index];
    if (!target) {
      throw new Error(
        `${args.spam} has no callout in epoch ${epoch} to flag. Run this without --spam first, ` +
          'so there is a clean record for the flag to land on.',
      );
    }
    const flagged = { ...target, isSpam: true };
    if (index === -1) records.push(flagged);
    else records[index] = flagged;
    console.log(`spam      ${args.spam}'s record is flagged — it must move to "excluded"`);
  }

  const merged = mergeById(store.callouts ?? {}, records, now);
  writeStore(
    {
      mint,
      updatedAt: now,
      // The poll records truncation events here. The mock feed has no 50-record
      // cap, so this stays empty — and the truncation fallback is therefore NOT
      // exercised by the dry run. Phase 02 §2.6 is proved against the real feed.
      truncations: store.truncations ?? [],
      callouts: merged,
    },
    storePath,
  );

  const inWindow = recordsInWindow(merged, window);
  console.log(
    `wrote     ${records.length} record(s); ${inWindow.length} now in this window, ` +
      `${Object.keys(merged).length} in the store\n`,
  );
  for (const record of inWindow) {
    const who = manifest.cast.find((m) => m.address === record.walletAddress);
    console.log(
      `  ${(who?.name ?? '?').padEnd(8)} ${record.walletAddress}  ${record.createdAt}` +
        `${record.isSpam ? '  SPAM — excluded' : ''}`,
    );
  }
  console.log('');
}

/** The start of whichever epoch `now` falls in, as an aligned timestamp. */
function alignedNow(now, config) {
  return now - ((now - config.genesisTs) % config.epochSeconds);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
