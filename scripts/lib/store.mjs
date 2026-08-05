// The rolling callout store on disk, and the snapshot directory layout.
//
// The store is the crank's memory between hourly polls. It is deliberately a
// plain JSON file of **raw API records**: an epoch whose callout file has been
// summarised, filtered or prettified has destroyed its own evidence, and the
// public feed only ever returns the newest 50, so our capture is the only
// surviving copy (Phase 05 §5.10).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where the hourly poll accumulates. Working state, not the audit trail. */
export const STORE_PATH = resolve(REPO_ROOT, 'epochs/callout-store.json');

/**
 * The audit trail. Committed, and never rewritten once published.
 *
 * `CALLPOOL_SNAPSHOTS_DIR` redirects it, and exists for exactly one reason: the
 * devnet dry run settles fabricated epochs through the real scripts, and a fake
 * epoch left in the published audit trail is worse than no audit trail. The
 * dry-run tooling sets it for every child process it spawns; nothing else does,
 * and production must never set it.
 *
 * A path, not a parameter — none of the immutable values live here. The rule
 * against environment overrides applies to `config.mjs`, where an override
 * would be a second source of truth for the floor.
 */
export const SNAPSHOTS_DIR = resolve(
  REPO_ROOT,
  process.env.CALLPOOL_SNAPSHOTS_DIR ?? 'snapshots',
);

export function snapshotDir(epoch) {
  return resolve(SNAPSHOTS_DIR, `epoch-${epoch}`);
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    if (fallback !== null) return fallback;
    throw new Error(`missing file: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readStore(path = STORE_PATH) {
  return readJson(path, { mint: null, updatedAt: null, callouts: {} });
}

export function writeStore(store, path = STORE_PATH) {
  writeJson(path, store);
}
