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
//   CALLOUT_API_KEY=... node scripts/poll-callouts.mjs --mint <MINT>
//   ... --day 2026-08-04     # which window to judge truncation against
//
// Exits non-zero on an API failure, so a scheduler alerts. Phase 09 §9.3 wants
// the alert on the *absence* of a successful poll, not only on errors — that is
// the runner's job, not this script's.

import { apiKeyFromEnv, CalloutError, mergeById, pollMint } from './lib/callouts.mjs';
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

export async function pollOnce({ mint, window, store, apiKey, baseUrl, fetchImpl, now }) {
  const observedAt = now ?? Math.floor(Date.now() / 1000);
  const { records, truncated, feedSize } = await pollMint(mint, window, {
    apiKey,
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
  const previous = readStore();

  if (previous.mint && previous.mint !== args.mint) {
    throw new Error(
      `the store holds callouts for ${previous.mint}, not ${args.mint} — ` +
        'point --mint at the right coin or start a new store',
    );
  }

  const result = await pollOnce({
    mint: args.mint,
    window,
    store: previous,
    apiKey: apiKeyFromEnv(),
    baseUrl: args.baseUrl,
  });
  writeStore(result.store);

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
  console.log(`store: ${STORE_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      error instanceof CalloutError ? `\nCALLOUT API: ${error.message}` : `\n${error.stack}`,
    );
    process.exitCode = 1;
  });
}
