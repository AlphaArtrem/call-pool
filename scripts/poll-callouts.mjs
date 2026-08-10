#!/usr/bin/env node
//
// scripts/poll-callouts.mjs — step 1 of the crank, run hourly.
//
// One HTTP request for the per-mint feed, plus one per recent callout for its
// updates, merged by `id` into a rolling store. It is the cheapest part of the
// whole system and the part that must not be skipped: the public feed caps at
// 50 records with no pagination, and about 13 throwaway accounts posting every
// six hours can keep that window permanently full for free (Phase 02 §2.6).
// Twenty-four polls a day is what turns a 50-record window into a complete day.
//
// It records truncation rather than reacting to it. Reacting is settlement's
// job, because the fallback needs the holder list and that is a chain read.
//
// Usage:
//   node scripts/poll-callouts.mjs --mint <MINT>
//   ... --day 2026-08-04     # which window to judge truncation against
//   ... --store /tmp/probe.json   # somewhere other than the production store
//
// **Use `--store` for any probe.** The production store is the one file
// settlement reads, and it holds exactly one coin: polling a different mint into
// it makes every later poll throw `the store holds callouts for X, not Y`. That
// is the right behaviour, and it is why MAINNET-PREP's P2 probes a stranger's
// coin into a scratch file rather than the real one.
//
// No key needs to be supplied. pump.fun's public callout key is derived from
// their own bundle and cached (`lib/callout-key.mjs`), and re-derived when the
// API rejects it — which is the only reliable signal that it rotated. Setting
// `CALLOUT_API_KEY` pins a key instead and disables the derivation, which is
// what you want when you are testing against a specific one.
//
// Exits non-zero on an API failure, so a scheduler alerts. Phase 09 §9.3 wants
// the alert on the *absence* of a successful poll, not only on errors — that is
// the runner's job, not this script's.

import { resolve } from 'node:path';

import { alert } from './lib/alert.mjs';
import { CalloutError, mergeById, pollMint } from './lib/callouts.mjs';
import { createCalloutKeySource } from './lib/callout-key.mjs';
import { LOCKOUT_EPOCHS } from './lib/config.mjs';
import { iso, windowForDay } from './lib/epoch.mjs';
import { readStore, STORE_PATH, writeStore } from './lib/store.mjs';

/**
 * How long a truncation record is worth keeping.
 *
 * A truncation matters while the epoch it happened in can still affect a
 * settlement, and the lockout reaches back `LOCKOUT_EPOCHS`. Two days of slack
 * on top so nothing in flight is ever pruned.
 */
export const TRUNCATION_RETENTION_DAYS = LOCKOUT_EPOCHS + 2;

/**
 * Drop truncation records too old to bear on any epoch still being settled.
 *
 * The callout store beside this is append-only on purpose — a record that
 * vanishes from the public feed has to survive in ours. The truncation log is
 * the opposite: operational noise, written every hour the feed is full, and it
 * grew forever. Unlike the callouts, nothing reproduces from it.
 */
export function pruneTruncations(truncations, observedAt) {
  const cutoff = observedAt - TRUNCATION_RETENTION_DAYS * 86_400;
  return (truncations ?? []).filter((entry) => entry.observedAt >= cutoff);
}

/**
 * Which store this poll reads and writes.
 *
 * `--store` was parsed and then ignored: every poll used the production store
 * whatever it was told. MAINNET-PREP's P2 probe says to point it at a scratch
 * file and poll **a stranger's coin** — so following the instructions wrote
 * someone else's callouts into the one file settlement reads, and the mint
 * guard in `main` then refuses every later poll. Loud rather than silent, and
 * survivable, but it fires on launch day at the step that must run FIRST,
 * before genesis.
 *
 * Exported so the choice is testable: `main` needs the network and a real
 * store, and a test that grepped for `writeStore(store, path)` would prove only
 * that the text appears — the empty check that shipped the L23 crash.
 */
export function resolveStorePath(store, cwd = process.cwd()) {
  return store ? resolve(cwd, store) : STORE_PATH;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.mint) throw new Error('--mint is required');
  args.day ??= new Date().toISOString().slice(0, 10);
  return args;
}

export async function pollOnce({ mint, window, store, apiKey, keySource, baseUrl, fetchImpl, now }) {
  const observedAt = now ?? Math.floor(Date.now() / 1000);
  const { records, truncated, feedSize } = await pollMint(mint, window, {
    apiKey,
    keySource,
    baseUrl,
    fetchImpl,
  });

  const callouts = mergeById(store.callouts ?? {}, records, observedAt);
  const truncations = pruneTruncations(store.truncations, observedAt);
  if (truncated) truncations.push({ observedAt, day: window.day, feedSize });

  return {
    store: { mint, updatedAt: observedAt, callouts, truncations },
    added: Object.keys(callouts).length - Object.keys(store.callouts ?? {}).length,
    seen: records.length,
    truncated,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const window = windowForDay(args.day);
  const storePath = resolveStorePath(args.store);
  const previous = readStore(storePath);

  if (previous.mint && previous.mint !== args.mint) {
    throw new Error(
      `the store holds callouts for ${previous.mint}, not ${args.mint} — ` +
        'point --mint at the right coin or start a new store',
    );
  }

  // No `apiKey` — the source resolves it, from the environment if an operator
  // pinned one and by deriving it from pump.fun's bundle if not. A rotation
  // mid-run is recovered from inside `get()` and alerted here.
  const result = await pollOnce({
    mint: args.mint,
    window,
    store: previous,
    keySource: createCalloutKeySource({
      mint: args.mint,
      log: console.log,
      onRotate: ({ previous: was, next, via }) =>
        alert(
          `pump.fun rotated the public callout key.\n\n` +
            `The poll recovered on its own: the new key was derived from ` +
            `pump.fun's bundle (via ${via}) and accepted by the API, so no ` +
            `epoch was settled with an empty caller list.\n\n` +
            `was ${was} → now ${next}\n\n` +
            `Nothing to do. This is here because a change in someone else's ` +
            `system that we depend on should never pass silently.`,
        ),
    }),
    baseUrl: args.baseUrl,
  });
  writeStore(result.store, storePath);

  const total = Object.keys(result.store.callouts).length;
  console.log(
    `polled ${args.mint} at ${iso(result.store.updatedAt)}: ` +
      `${result.seen} records seen, ${result.added} new, ${total} in the store`,
  );
  if (result.truncated) {
    // Not fatal here. It is fatal at settlement if the fallback cannot run.
    console.warn(
      `⚠️  the feed is TRUNCATED for ${args.day}: 50 records and the oldest is ` +
        'still inside the window. Settlement must use the per-wallet fallback (L5).',
    );
  }
  console.log(`store: ${storePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      error instanceof CalloutError ? `\nCALLOUT API: ${error.message}` : `\n${error.stack}`,
    );
    process.exitCode = 1;
  });
}
