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
// ⚠️ It proves **our settlement** and nothing whatsoever about pump.fun's API.
// Devnet proofs 1, 1b, 2, 2b, 3, 12b and 22 still need the real feed on devnet,
// and they are the ones that gate launch.

import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';

import { mergeById, recordsInWindow } from '../lib/callouts.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { iso } from '../lib/epoch.mjs';
import { epochIndexFor, fetchConfig, windowForEpoch } from '../lib/program.mjs';
import { readStore, STORE_PATH, writeStore } from '../lib/store.mjs';
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

  const records = [];
  if (!args.silent) {
    for (const member of manifest.cast) {
      if (only ? !only.has(member.name) : !callsOut(member.name, epochsIn, Number(args['fade-after']))) {
        continue;
      }
      records.push({
        // Stable per wallet per epoch, so re-running inside the same window
        // merges rather than duplicating — and `firstSeenAt` keeps the first
        // sighting, exactly as the hourly poll does.
        id: `mock-${epoch}-${member.name}`,
        walletAddress: member.address,
        tokenAddress: mint,
        createdAt: new Date(createdAt * 1000).toISOString(),
        isSpam: false,
        isHarmful: false,
        deletedAt: null,
      });
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
