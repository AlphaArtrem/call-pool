//! The merkle leaf and node format, per Phase 05 §5.7.
//!
//! Fixed before the first epoch and never changed: a leaf format change
//! invalidates every published verifier and every proof already handed out.
//!
//! ```text
//! leaf = sha256( 0x00 || index_le(4) || owner(32) || epoch_le(8) || amount_le(8) )
//! node = sha256( 0x01 || min(a, b) || max(a, b) )
//! ```
//!
//! Two properties are load-bearing and neither is decorative:
//!
//! * **Domain separation.** The `0x00` / `0x01` prefixes stop an internal node
//!   being reinterpreted as a leaf, which is the standard second-preimage
//!   attack on a plain sha256 tree.
//! * **Sorted pairs.** Hashing `min || max` means a proof needs no direction
//!   bits, so a proof is just a list of siblings.
//!
//! The *builder* side lives in `scripts/lib/merkle.mjs`, and the two are pinned
//! to each other by shared test vectors (D6) — see `tests/vectors.json`.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub const LEAF_PREFIX: &[u8] = &[0x00];
pub const NODE_PREFIX: &[u8] = &[0x01];

/// One leaf: "in epoch `epoch`, position `index` pays `amount` lamports to `owner`".
///
/// `index` is a dense zero-based position, not an identifier — it is what the
/// epoch's claim bitmap marks, so it must match the tree exactly.
pub fn leaf_hash(index: u32, owner: &Pubkey, epoch: u64, amount: u64) -> [u8; 32] {
    hashv(&[
        LEAF_PREFIX,
        &index.to_le_bytes(),
        owner.as_ref(),
        &epoch.to_le_bytes(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

/// One internal node. Children are sorted so proofs carry no direction bits.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b {
        hashv(&[NODE_PREFIX, a, b]).to_bytes()
    } else {
        hashv(&[NODE_PREFIX, b, a]).to_bytes()
    }
}

/// Walk a proof from a leaf to a root.
///
/// Returns true only if the walk lands exactly on `root`. There is deliberately
/// no length check against the tree depth: `index < leaf_count` is enforced
/// separately (D2), and a proof of the wrong length simply fails to reproduce
/// the root.
pub fn verify(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for sibling in proof {
        computed = node_hash(&computed, sibling);
    }
    computed == *root
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a root the way `scripts/lib/merkle.mjs` does — pairing left to
    /// right and **promoting an unpaired node unchanged** rather than
    /// duplicating it (D6). Promote-vs-duplicate produces different roots from
    /// identical data, so two honest builders would disagree on any level with
    /// an odd node count, which is most of them.
    fn build_root(mut level: Vec<[u8; 32]>) -> [u8; 32] {
        if level.is_empty() {
            return [0u8; 32];
        }
        while level.len() > 1 {
            let mut next = Vec::with_capacity(level.len().div_ceil(2));
            let mut i = 0;
            while i + 1 < level.len() {
                next.push(node_hash(&level[i], &level[i + 1]));
                i += 2;
            }
            if i < level.len() {
                next.push(level[i]); // promoted unchanged
            }
            level = next;
        }
        level[0]
    }

    fn build_proof(level: &[[u8; 32]], mut index: usize) -> Vec<[u8; 32]> {
        let mut proof = Vec::new();
        let mut level = level.to_vec();
        while level.len() > 1 {
            let sibling = if index % 2 == 0 { index + 1 } else { index - 1 };
            if sibling < level.len() {
                proof.push(level[sibling]);
            }
            let mut next = Vec::new();
            let mut i = 0;
            while i + 1 < level.len() {
                next.push(node_hash(&level[i], &level[i + 1]));
                i += 2;
            }
            if i < level.len() {
                next.push(level[i]);
            }
            index /= 2;
            level = next;
        }
        proof
    }

    fn leaves(n: u32, epoch: u64) -> Vec<[u8; 32]> {
        (0..n)
            .map(|i| leaf_hash(i, &Pubkey::new_from_array([i as u8; 32]), epoch, 1_000 + i as u64))
            .collect()
    }

    #[test]
    fn every_leaf_verifies_at_every_tree_size() {
        // Odd sizes are the ones that would expose a promote-vs-duplicate
        // mismatch, so sweep rather than spot-check.
        for n in 1u32..=33 {
            let level = leaves(n, 7);
            let root = build_root(level.clone());
            for i in 0..n as usize {
                let proof = build_proof(&level, i);
                assert!(
                    verify(&proof, &root, level[i]),
                    "leaf {i} of {n} failed to verify"
                );
            }
        }
    }

    #[test]
    fn a_leaf_from_another_tree_does_not_verify() {
        let level = leaves(8, 7);
        let root = build_root(level.clone());
        let proof = build_proof(&level, 3);

        // Same position, different epoch — the epoch is inside the leaf, so an
        // old proof cannot be replayed against a new root.
        let other = leaf_hash(3, &Pubkey::new_from_array([3u8; 32]), 8, 1_003);
        assert!(!verify(&proof, &root, other));
    }

    #[test]
    fn changing_the_amount_invalidates_the_proof() {
        let level = leaves(5, 1);
        let root = build_root(level.clone());
        let proof = build_proof(&level, 2);
        let inflated = leaf_hash(2, &Pubkey::new_from_array([2u8; 32]), 1, 999_999);
        assert!(!verify(&proof, &root, inflated));
    }

    #[test]
    fn leaves_and_nodes_are_domain_separated() {
        // Without the 0x00/0x01 prefixes an internal node could be presented as
        // a leaf. Assert the two hashes of the same bytes differ.
        let a = [1u8; 32];
        let b = [2u8; 32];
        let as_node = node_hash(&a, &b);
        let undomained = hashv(&[&a, &b]).to_bytes();
        assert_ne!(as_node, undomained);
    }

    #[test]
    fn sibling_order_does_not_change_a_node() {
        let a = [9u8; 32];
        let b = [4u8; 32];
        assert_eq!(node_hash(&a, &b), node_hash(&b, &a));
    }

    /// The vectors committed in `tests/vectors.json` and reproduced by
    /// `scripts/lib/merkle.mjs`. If this test and the JS test ever disagree,
    /// the published verifier and the crank have drifted — which is D6.
    #[test]
    fn matches_the_shared_test_vectors() {
        let raw = include_str!("../tests/vectors.json");
        let vectors: serde_json::Value = serde_json::from_str(raw).unwrap();

        for case in vectors["cases"].as_array().unwrap() {
            let epoch = case["epoch"].as_u64().unwrap();
            let mut level = Vec::new();
            for leaf in case["leaves"].as_array().unwrap() {
                let owner: Pubkey = leaf["owner"].as_str().unwrap().parse().unwrap();
                let index = leaf["index"].as_u64().unwrap() as u32;
                let amount: u64 = leaf["amount"].as_str().unwrap().parse().unwrap();
                level.push(leaf_hash(index, &owner, epoch, amount));
            }
            let expected = hex_to_32(case["root"].as_str().unwrap());
            assert_eq!(
                build_root(level),
                expected,
                "root mismatch for case {}",
                case["name"]
            );
        }
    }

    fn hex_to_32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
}
