// Decoding the CALLPOOL program's accounts in a browser. Reads only —
// nothing here builds a transaction, and nothing here needs a dependency.
//
// This is a second decoder for accounts that `scripts/lib/program.mjs`
// already decodes, and the duplication is deliberate rather than lazy.
// `program.mjs` is built on `node:crypto`'s synchronous hashing and on
// `Buffer`, neither of which exists in a browser; porting it would mean
// rewriting the module that builds the transaction which moves money, in order
// to render a web page. The cost is accepted the same way D6 accepts having a
// Rust merkle verifier and a JS one:
//
//   **`scripts/tests/site.test.mjs` decodes the same bytes with both and
//   asserts field-for-field agreement.** If these two ever drift, the suite
//   fails rather than the site rendering a plausible wrong number.
//
// The arithmetic that decides money — `hold`, `locked`, epoch windows, the
// floor — is NOT duplicated. Those are imported from scripts/lib/ directly.
//
// Address *derivation* is not here either: it needs an ed25519 on-curve check
// and therefore web3.js, and it lives in addresses.js so that this file, and
// the tests that exercise it, stay dependency-free.

import { pubkeyAt } from './base58.js';

/**
 * Anchor's discriminator: the first 8 bytes of sha256 over a namespaced name.
 *
 * Async because `crypto.subtle` is. The alternative — hardcoding the eight
 * bytes — would leave a magic constant that no longer traces to the name it
 * came from, which is exactly the sort of thing that survives a rename.
 */
export async function discriminator(namespace, name) {
  const bytes = new TextEncoder().encode(`${namespace}:${name}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hash).subarray(0, 8);
}

export class AccountDecodeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'AccountDecodeError';
    this.detail = detail;
  }
}

async function expectDiscriminator(bytes, name) {
  const expected = await discriminator('account', name);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== expected[i]) {
      throw new AccountDecodeError(`account is not a ${name}`, { name });
    }
  }
}

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * `Config` — the immutable parameters, as the chain actually holds them.
 *
 * Offsets are written out rather than accumulated, matching `program.mjs` and
 * for the same reason: a decoder that silently reads one field late produces a
 * plausible wrong number rather than an error.
 */
export async function decodeConfig(bytes) {
  await expectDiscriminator(bytes, 'Config');
  const v = view(bytes);
  return {
    mint: pubkeyAt(bytes, 8),
    genesisTs: Number(v.getBigInt64(40, true)),
    epochSeconds: v.getUint32(48, true),
    minHold: v.getBigUint64(52, true),
    challengeSeconds: v.getUint32(60, true),
    snapshotKey: pubkeyAt(bytes, 64),
    outstanding: v.getBigUint64(96, true),
    bump: bytes[104],
    poolBump: bytes[105],
  };
}

/** `Epoch` — one settled day: its root, its pool, and who has been paid. */
export async function decodeEpoch(bytes) {
  await expectDiscriminator(bytes, 'Epoch');
  const v = view(bytes);
  let o = 8;

  const index = Number(v.getBigUint64(o, true));
  o += 8;
  const root = bytes.subarray(o, o + 32);
  o += 32;
  const poolLamports = v.getBigUint64(o, true);
  o += 8;
  const claimedLamports = v.getBigUint64(o, true);
  o += 8;
  const postedTs = Number(v.getBigInt64(o, true));
  o += 8;
  const leafCount = v.getUint32(o, true);
  o += 4;
  const closed = bytes[o] === 1;
  o += 1;
  const bitsLen = v.getUint32(o, true);
  o += 4;
  const claimedBits = bytes.subarray(o, o + bitsLen);

  return { index, root, poolLamports, claimedLamports, postedTs, leafCount, closed, claimedBits };
}

/** Has leaf `index` been paid? Mirrors the program's bitmap read exactly. */
export function isClaimed(epoch, index) {
  const byte = epoch.claimedBits[Math.floor(index / 8)];
  return byte === undefined ? false : (byte & (1 << index % 8)) !== 0;
}

/**
 * D2's check, run in the visitor's browser rather than taken on trust.
 *
 * `leaf_count` is chosen by the snapshot signer, and a correct-looking root
 * posted with an undersized bitmap makes every leaf above it permanently
 * unclaimable (Phase 05 §5.5). The program stores `leaf_count` so this is
 * *visible*; making it visible is only worth anything if something looks.
 */
export function bitmapIsSized(epoch) {
  return epoch.claimedBits.length >= Math.ceil(epoch.leafCount / 8);
}

/** All-zero root — the empty epoch nobody called on (Phase 04 §4.4). */
export function isZeroRoot(epoch) {
  return epoch.root.every((b) => b === 0);
}

export function rootHex(epoch) {
  return [...epoch.root].map((b) => b.toString(16).padStart(2, '0')).join('');
}
