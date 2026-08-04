//! Phase 04 §4.6 — the three invariants, under randomized sequences.
//!
//! ```text
//! 1.  pool.lamports         >= config.outstanding + rent_exempt_minimum(pool)
//! 2.  config.outstanding    == Σ over OPEN epochs (pool_lamports − claimed_lamports)
//! 3.  epoch.claimed_lamports <= epoch.pool_lamports
//! ```
//!
//! The first is the one that matters: **only `claim` moves lamports out of the
//! pool, and only up to what an epoch was allocated.** The other two are what
//! make the first checkable without trusting the program's own accounting.
//!
//! Sequences are generated from a fixed seed list rather than a random one, so
//! a failure is reproducible: the seed is in the test name's output.

mod common;

use common::*;
use solana_signer::Signer;

const ONE_SOL: u64 = 1_000_000_000;

/// xorshift64*. A dependency-free PRNG — the tests need reproducible spread,
/// not statistical quality.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }

    fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
}

fn run_sequence(seed: u64) {
    let mut rng = Rng(seed);
    let mut f = Fixture::new();
    f.fund_pool(500 * ONE_SOL);

    // A fixed cast of holders, all above the floor, reused across epochs — the
    // realistic shape, since eligibility is a daily property of the same wallets.
    let holders: Vec<_> = (0..4).map(|_| f.holder(MIN_HOLD)).collect();

    let epochs = 6u64;
    let mut posted: Vec<u64> = Vec::new();
    let mut last_posted_ts = GENESIS_TS;

    for epoch in 0..epochs {
        // Some epochs have nobody eligible. That is a real case, not an edge
        // one, and a zeroed root is still posted for it (L3/D7).
        let empty = rng.chance(4);
        let leaf_count = if empty { 0 } else { 1 + rng.below(holders.len() as u64) as usize };

        let payouts: Vec<_> = holders[..leaf_count]
            .iter()
            .map(|h| (h.pubkey(), ONE_SOL / 4 + rng.below(2 * ONE_SOL)))
            .collect();
        let (_, levels) = build_tree(&payouts, epoch);
        let total: u64 = payouts.iter().map(|(_, a)| a).sum();

        // Mostly allocate exactly what the tree pays — the honest case, and
        // what carry-forward is for. Sometimes under-allocate, which is always
        // harmless, and sometimes over-allocate the tree relative to the
        // allocation, which is bounded rather than prevented (proof 9).
        let allocate = match rng.below(4) {
            0 => total / 2,
            1 => total + rng.below(ONE_SOL),
            _ => total,
        };

        f.advance_past_epoch(epoch);
        let available = f.pool_lamports().saturating_sub(f.rent_minimum())
            - f.config_state().outstanding;
        let allocate = allocate.min(available);

        f.post_root(epoch, root_of(&levels), leaf_count as u32, allocate)
            .unwrap_or_else(|e| panic!("seed {seed}: posting epoch {epoch} failed: {e:?}"));
        posted.push(epoch);
        last_posted_ts = f.epoch_state(epoch).posted_ts;
        f.assert_invariants(&posted, &format!("seed {seed}: after posting epoch {epoch}"));

        // Claims, in a random order, some of them skipped entirely — which is
        // exactly what a partly-failed airdrop looks like.
        f.set_time(last_posted_ts + CHALLENGE_SECONDS as i64 + 1);
        let ordered = canonical(&payouts);
        let mut indices: Vec<usize> = (0..ordered.len()).collect();
        for i in (1..indices.len()).rev() {
            indices.swap(i, rng.below(i as u64 + 1) as usize);
        }

        for index in indices {
            if rng.chance(5) {
                continue; // never delivered — the claim page's whole reason to exist
            }
            let (recipient, amount) = ordered[index];
            // Success or failure both have to leave the invariants standing: a
            // claim beyond the allocation is refused, not partially applied.
            let _ = f.claim(epoch, index as u32, amount, proof_for(&levels, index), recipient);
            f.assert_invariants(
                &posted,
                &format!("seed {seed}: after claiming {index} of epoch {epoch}"),
            );
        }
    }

    // Past the 30-epoch deadline, close a subset. `close_epoch` is
    // permissionless, so it also gets called twice on purpose.
    f.set_time(last_posted_ts + (CLAIM_DEADLINE_EPOCHS + 1) as i64 * EPOCH_SECONDS as i64);
    for epoch in 0..epochs {
        if rng.chance(3) {
            continue;
        }
        f.close_epoch(epoch)
            .unwrap_or_else(|e| panic!("seed {seed}: closing epoch {epoch} failed: {e:?}"));
        f.assert_invariants(&posted, &format!("seed {seed}: after closing epoch {epoch}"));

        let _ = f.close_epoch(epoch); // D1 — must fail, must change nothing
        f.assert_invariants(&posted, &format!("seed {seed}: after re-closing epoch {epoch}"));
    }

    // Every lamport is accounted for: whatever was never claimed is back in the
    // pool and free to allocate again, and nothing has leaked out.
    let config = f.config_state();
    assert!(
        f.pool_lamports() >= config.outstanding + f.rent_minimum(),
        "seed {seed}: final invariant 1",
    );
}

const CLAIM_DEADLINE_EPOCHS: u64 = callpool::CLAIM_DEADLINE_EPOCHS;

#[test]
fn invariants_hold_under_randomized_post_claim_close_sequences() {
    // Twelve independent sequences. Each runs six epochs with random leaf
    // counts, random allocations, shuffled and partly-skipped claims, and
    // random closes — asserting all three invariants after every single
    // instruction, not just at the end.
    for seed in [
        1u64, 7, 42, 99, 1_234, 8_675_309, 0xDEAD_BEEF, 0xC0FF_EE00, 31_337, 2_026_08_04, 555,
        777_777,
    ] {
        run_sequence(seed);
    }
}

#[test]
fn outstanding_returns_to_zero_when_every_leaf_is_claimed() {
    let mut f = Fixture::new();
    f.fund_pool(100 * ONE_SOL);
    let holders: Vec<_> = (0..3).map(|_| f.holder(MIN_HOLD)).collect();

    let payouts: Vec<_> = holders.iter().map(|h| (h.pubkey(), 2 * ONE_SOL)).collect();
    let (_, levels) = build_tree(&payouts, 0);
    f.advance_past_epoch(0);
    f.post_root(0, root_of(&levels), 3, 6 * ONE_SOL).unwrap();
    assert_eq!(f.config_state().outstanding, 6 * ONE_SOL);

    f.set_time(f.epoch_state(0).posted_ts + CHALLENGE_SECONDS as i64 + 1);
    for (index, (recipient, amount)) in canonical(&payouts).into_iter().enumerate() {
        f.claim(0, index as u32, amount, proof_for(&levels, index), recipient)
            .unwrap();
    }

    assert_eq!(f.config_state().outstanding, 0);
    assert_eq!(f.epoch_state(0).claimed_lamports, 6 * ONE_SOL);
    f.assert_invariants(&[0], "after a fully claimed epoch");
}

#[test]
fn unclaimed_lamports_become_allocatable_again_after_close() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    f.advance_past_epoch(0);

    let available_before = f.pool_lamports() - f.rent_minimum();
    f.post_root(0, [1u8; 32], 1, 5 * ONE_SOL).unwrap();
    assert_eq!(f.config_state().outstanding, 5 * ONE_SOL);

    f.set_time(f.epoch_state(0).posted_ts + 31 * EPOCH_SECONDS as i64);
    f.close_epoch(0).unwrap();
    assert_eq!(f.config_state().outstanding, 0);

    // The whole pool is spendable again — nothing was burned by the round trip.
    f.advance_past_epoch(1);
    f.set_time(f.epoch_state(0).posted_ts + 31 * EPOCH_SECONDS as i64);
    f.post_root(1, [2u8; 32], 1, available_before).unwrap();
    assert_eq!(f.epoch_state(1).pool_lamports, available_before);
    f.assert_invariants(&[0, 1], "after reallocating a closed epoch's lamports");
}
