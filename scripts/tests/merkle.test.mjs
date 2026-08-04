// The builder half of the merkle tree, and the vectors that pin it to the
// program's verifier (D6).
//
// programs/callpool/src/merkle.rs reads the same vectors.json. If these two
// suites ever disagree, the crank and every published verifier have drifted,
// and every proof handed out under the old format is worthless.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import {
  buildProof,
  buildTree,
  canonicalLeaves,
  leafHash,
  nodeHash,
  verifyProof,
} from '../lib/merkle.mjs';

const VECTORS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../programs/callpool/tests/vectors.json'), 'utf8'),
);

const owner = (i) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => i)).publicKey.toBase58();

const payouts = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ owner: owner(i + from), amount: 1_000n + BigInt(i) }));

test('the committed vectors still reproduce, byte for byte', () => {
  assert.equal(VECTORS.cases.length, 8);

  for (const c of VECTORS.cases) {
    const { root, levels } = buildTree(
      c.leaves.map((l) => ({ owner: l.owner, amount: l.amount })),
      c.epoch,
    );
    assert.equal(root.toString('hex'), c.root, `root drifted for "${c.name}"`);

    for (const leaf of c.leaves) {
      const built = buildProof(levels, leaf.index);
      assert.deepEqual(
        built.map((p) => p.toString('hex')),
        leaf.proof,
        `proof drifted for leaf ${leaf.index} of "${c.name}"`,
      );
      assert.ok(verifyProof(built, root, levels[0][leaf.index]));
    }
  }
});

test('every leaf verifies at every tree size up to 33', () => {
  // Odd sizes are where promote-vs-duplicate would diverge, so sweep rather
  // than spot-check.
  for (let n = 1; n <= 33; n++) {
    const { root, leaves, levels } = buildTree(payouts(n), 5);
    for (const leaf of leaves) {
      assert.ok(
        verifyProof(buildProof(levels, leaf.index), root, levels[0][leaf.index]),
        `leaf ${leaf.index} of ${n} failed`,
      );
    }
  }
});

test('leaf order is canonical — the same set builds the same tree in any input order', () => {
  const set = payouts(9);
  const forwards = buildTree(set, 3);
  const backwards = buildTree([...set].reverse(), 3);
  const shuffled = buildTree([...set].sort(() => 0.5 - Math.random()), 3);

  assert.equal(forwards.root.toString('hex'), backwards.root.toString('hex'));
  assert.equal(forwards.root.toString('hex'), shuffled.root.toString('hex'));
  assert.deepEqual(
    forwards.leaves.map((l) => l.owner),
    shuffled.leaves.map((l) => l.owner),
    'indices must be identical too — the bitmap marks positions, not identities',
  );
});

test('indices are dense and zero-based', () => {
  const { leaves } = buildTree(payouts(6), 1);
  assert.deepEqual(leaves.map((l) => l.index), [0, 1, 2, 3, 4, 5]);
});

test('an empty epoch is a zeroed root, not an error', () => {
  // Nobody calls out on some days. A root is still posted for every epoch
  // (L3/D7), and this is the value post_epoch_root writes.
  const { root, leaves } = buildTree([], 42);
  assert.equal(root.toString('hex'), '0'.repeat(64));
  assert.equal(leaves.length, 0);
});

test('two wallets cannot share a leaf', () => {
  const dup = [
    { owner: owner(1), amount: 10n },
    { owner: owner(1), amount: 20n },
  ];
  assert.throws(() => canonicalLeaves(dup), /duplicate owner/);
});

test('the epoch is inside the leaf, so a proof cannot be replayed on another epoch', () => {
  const set = payouts(8);
  const a = buildTree(set, 10);
  const b = buildTree(set, 11);
  assert.notEqual(a.root.toString('hex'), b.root.toString('hex'));
  assert.ok(!verifyProof(buildProof(a.levels, 3), b.root, b.levels[0][3]));
});

test('inflating an amount invalidates the proof', () => {
  const { root, levels } = buildTree(payouts(5), 2);
  const proof = buildProof(levels, 2);
  const inflated = leafHash(2, owner(3), 2, 999_999_999n);
  assert.ok(!verifyProof(proof, root, inflated));
});

test('leaves and nodes are domain separated', () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  // A node of two hashes must not collide with any leaf preimage.
  assert.notEqual(nodeHash(a, b).toString('hex'), leafHash(0, owner(1), 0, 0n).toString('hex'));
});

test('sibling order does not change a node', () => {
  const a = Buffer.alloc(32, 9);
  const b = Buffer.alloc(32, 4);
  assert.equal(nodeHash(a, b).toString('hex'), nodeHash(b, a).toString('hex'));
});

test('a promoted node contributes no sibling to the proof', () => {
  // Three leaves: leaf 2 is promoted at the first level, so its proof is one
  // element shorter than leaf 0's. A verifier that checks proof length against
  // a fixed depth would reject it.
  const { levels } = buildTree(payouts(3), 1);
  assert.equal(buildProof(levels, 0).length, 2);
  assert.equal(buildProof(levels, 2).length, 1);
});
