// Shared plumbing for the devnet dry run: where its files live, and the guard
// that keeps them off mainnet.
//
// The dry run's whole risk is that a test parameter — a 5-minute epoch, a
// fabricated callout, a stand-in creator vault — survives it. Two things follow
// from that and both are enforced here rather than remembered:
//
//   1. **Everything the dry run writes lives under `epochs/devnet/`**, which is
//      gitignored, and never in `snapshots/` (the public audit trail) or in
//      `epochs/callout-store.json` (the real store the mainnet crank reads).
//   2. **Every tool that writes checks the cluster first**, by genesis hash and
//      not by the shape of a URL. A provider's devnet endpoint need not have
//      "devnet" in it, and a mainnet endpoint need not say so either.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import { readJson, REPO_ROOT, writeJson } from '../lib/store.mjs';

/** Everything the dry run writes. Gitignored — see .gitignore. */
export const DEVNET_DIR = resolve(REPO_ROOT, 'epochs/devnet');

/** What `deploy-devnet.mjs` wrote: addresses, parameters and the cast. */
export const MANIFEST_PATH = resolve(DEVNET_DIR, 'deployment.json');

/**
 * The dry run's callout store, deliberately **not** `STORE_PATH`.
 *
 * `epochs/callout-store.json` is the one file the production crank reads. A
 * fabricated record reaching it would be settled as real, so the mock tool
 * writes here and `snapshot.mjs --store` is pointed at it explicitly.
 */
export const DEVNET_STORE_PATH = resolve(DEVNET_DIR, 'callout-store.json');

/** Where throwaway secrets go. Worthless keys, but keys — never committed. */
export const KEYS_DIR = resolve(DEVNET_DIR, 'keys');

/** Solana's mainnet-beta genesis hash. The one cluster nothing here may touch. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/**
 * Refuse to run against mainnet, cheaply and before any RPC call.
 *
 * A first pass only: a mainnet endpoint behind a provider's hostname does not
 * have to say "mainnet". `assertNotMainnet` is the one that actually decides.
 */
export function looksLikeMainnet(rpcUrl) {
  return /mainnet/i.test(String(rpcUrl));
}

/**
 * Refuse to run against mainnet, by asking the chain which chain it is.
 *
 * The genesis hash is the cluster's identity and cannot be faked by a URL, so
 * this is the check that matters. Every tool under `scripts/tools/` calls it
 * before it writes anything.
 */
export async function assertNotMainnet(connection, what) {
  const endpoint = connection.rpcEndpoint;
  if (looksLikeMainnet(endpoint)) {
    throw new Error(`${what} refuses to run against ${endpoint} — that URL names mainnet.`);
  }

  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS_HASH) {
    throw new Error(
      `${what} refuses to run: ${endpoint} is mainnet-beta (genesis ${genesis}). ` +
        'Everything this tool writes is fabricated rehearsal data.',
    );
  }
  return genesis;
}

export function readManifest(path = MANIFEST_PATH) {
  const manifest = readJson(path, null);
  if (manifest == null) {
    throw new Error(
      `no devnet deployment at ${path}. Run scripts/tools/deploy-devnet.mjs first — ` +
        'every tool in the dry run reads its addresses from that file.',
    );
  }
  return manifest;
}

export function writeManifest(manifest, path = MANIFEST_PATH) {
  writeJson(path, manifest);
}

/** A Solana CLI keypair file — a JSON array of secret-key bytes. */
export function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(path), 'utf8'))));
}

export function writeKeypair(path, keypair) {
  writeJson(path, [...keypair.secretKey]);
  return path;
}
