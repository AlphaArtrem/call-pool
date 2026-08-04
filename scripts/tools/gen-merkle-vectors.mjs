#!/usr/bin/env node
//
// Regenerate programs/callpool/tests/vectors.json — the shared merkle test
// vectors that pin the JS builder and the Rust verifier to each other (D6).
//
// Run this only when the leaf format is *intended* to change, which after the
// first epoch is never: a leaf format change invalidates every published
// verifier and every proof already handed out. If a normal code change makes
// the vectors fail, the change is wrong, not the vectors.
//
//   node scripts/tools/gen-merkle-vectors.mjs

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair } from '@solana/web3.js';

import { buildProof, buildTree, verifyProof } from '../lib/merkle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Deterministic owners: seed byte i repeated, so both sides can restate them. */
function owner(i) {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => i)).publicKey.toBase58();
}

// Sizes chosen to cover the shapes that break a tree: one leaf (root is the
// leaf), two (a single pair), and every odd size where promote-vs-duplicate
// diverges.
const CASES = [
  { name: 'single leaf', epoch: 0, count: 1 },
  { name: 'one pair', epoch: 1, count: 2 },
  { name: 'odd — one promotion', epoch: 2, count: 3 },
  { name: 'odd — promotion at two levels', epoch: 7, count: 5 },
  { name: 'odd — seven', epoch: 12, count: 7 },
  { name: 'power of two', epoch: 30, count: 8 },
  { name: 'odd — nine, deepest promotion', epoch: 99, count: 9 },
  { name: 'a realistic epoch', epoch: 365, count: 17 },
];

const cases = CASES.map(({ name, epoch, count }) => {
  const payouts = Array.from({ length: count }, (_, i) => ({
    owner: owner(i + 1),
    amount: BigInt(1_000_000 + i * 137),
  }));

  const { root, leaves, levels } = buildTree(payouts, epoch);

  // Never publish a vector without checking every leaf against it — a wrong
  // fixture would pin both implementations to the same wrong answer.
  for (const leaf of leaves) {
    const proof = buildProof(levels, leaf.index);
    if (!verifyProof(proof, root, levels[0][leaf.index])) {
      throw new Error(`${name}: leaf ${leaf.index} does not verify against its own root`);
    }
  }

  return {
    name,
    epoch,
    root: root.toString('hex'),
    leaves: leaves.map((l) => ({
      index: l.index,
      owner: l.owner,
      amount: l.amount.toString(),
      proof: buildProof(levels, l.index).map((p) => p.toString('hex')),
    })),
  };
});

const out = resolve(ROOT, 'programs/callpool/tests/vectors.json');
writeFileSync(
  out,
  `${JSON.stringify(
    {
      note:
        'Shared merkle vectors. Read by scripts/tests/merkle.test.mjs and by ' +
        'programs/callpool/src/merkle.rs. Regenerate only with ' +
        'scripts/tools/gen-merkle-vectors.mjs, and only if the leaf format is ' +
        'intended to change — which after epoch 1 is never.',
      format: {
        leaf: 'sha256(0x00 || index_le(4) || owner(32) || epoch_le(8) || amount_le(8))',
        node: 'sha256(0x01 || min(a,b) || max(a,b))',
        oddLevels: 'promote the unpaired node unchanged (D6)',
        leafOrder: 'sorted by owner pubkey bytes; index is the position in that order',
      },
      cases,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${cases.length} cases to ${out}`);
