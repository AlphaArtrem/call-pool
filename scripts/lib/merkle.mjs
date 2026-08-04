// The merkle tree, builder side. Phase 05 §5.7.
//
// The program verifies; this builds. The two are pinned to each other by the
// vectors in programs/callpool/tests/vectors.json, which both test suites read
// — that is defect D6. Promote-vs-duplicate on odd levels produces different
// roots from identical data, so without a pinned answer two honest builders
// disagree on most epochs and "recompute it yourself" quietly stops working.
//
//   leaf = sha256( 0x00 || index_le(4) || owner(32) || epoch_le(8) || amount_le(8) )
//   node = sha256( 0x01 || min(a, b) || max(a, b) )
//
// Fix this format before the first epoch and never change it: a leaf format
// change invalidates every published verifier and every proof already handed
// out.

import { createHash } from 'node:crypto';

import { PublicKey } from '@solana/web3.js';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** One leaf: position `index` in epoch `epoch` pays `amount` lamports to `owner`. */
export function leafHash(index, owner, epoch, amount) {
  return sha256(
    LEAF_PREFIX,
    u32le(index),
    new PublicKey(owner).toBuffer(),
    u64le(epoch),
    u64le(amount),
  );
}

/**
 * One internal node. Children are sorted, so a proof is a plain list of
 * siblings with no direction bits.
 */
export function nodeHash(a, b) {
  return Buffer.compare(a, b) <= 0 ? sha256(NODE_PREFIX, a, b) : sha256(NODE_PREFIX, b, a);
}

/** One level of the tree. An unpaired node is **promoted unchanged** (D6). */
function nextLevel(level) {
  const next = [];
  let i = 0;
  for (; i + 1 < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
  if (i < level.length) next.push(level[i]);
  return next;
}

/**
 * Sort payouts into the canonical leaf order and assign indices.
 *
 * Sorted by owner, so two people building the tree independently get identical
 * roots *and* identical indices — the index is the position the epoch's claim
 * bitmap marks, so it has to be stable, dense and zero-based.
 *
 * @param {Array<{ owner: string, amount: bigint|number|string }>} payouts
 * @returns {Array<{ index: number, owner: string, amount: bigint }>}
 */
export function canonicalLeaves(payouts) {
  const seen = new Set();
  for (const p of payouts) {
    if (seen.has(p.owner)) {
      throw new Error(`duplicate owner in the tree: ${p.owner} — one leaf per wallet per epoch`);
    }
    seen.add(p.owner);
  }

  return [...payouts]
    .sort((a, b) =>
      Buffer.compare(new PublicKey(a.owner).toBuffer(), new PublicKey(b.owner).toBuffer()),
    )
    .map((p, index) => ({ index, owner: p.owner, amount: BigInt(p.amount) }));
}

/**
 * Build an epoch's tree.
 *
 * An empty epoch is a real case, not an error: nobody calls out on some days,
 * and a root is still posted for every epoch including empty ones (L3/D7). The
 * root for no leaves is 32 zero bytes, which is what `post_epoch_root(n, [0;
 * 32], 0, 0)` writes.
 *
 * @returns {{ root: Buffer, leaves: Array, levels: Buffer[][] }}
 */
export function buildTree(payouts, epoch) {
  const leaves = canonicalLeaves(payouts);
  if (leaves.length === 0) {
    return { root: Buffer.alloc(32), leaves, levels: [[]] };
  }

  const levels = [leaves.map((l) => leafHash(l.index, l.owner, epoch, l.amount))];
  while (levels[levels.length - 1].length > 1) {
    levels.push(nextLevel(levels[levels.length - 1]));
  }
  return { root: levels[levels.length - 1][0], leaves, levels };
}

/**
 * The sibling list proving `index` belongs to the tree.
 *
 * A promoted node has no sibling at that level, so nothing is pushed — which is
 * why the proof length varies between leaves of the same tree and why the
 * verifier must not check it against a fixed depth.
 */
export function buildProof(levels, index) {
  const proof = [];
  let position = index;
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth];
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    position = Math.floor(position / 2);
  }
  return proof;
}

/** The same walk the program does, for checking a tree before it is posted. */
export function verifyProof(proof, root, leaf) {
  let computed = leaf;
  for (const sibling of proof) computed = nodeHash(computed, sibling);
  return Buffer.compare(computed, root) === 0;
}
