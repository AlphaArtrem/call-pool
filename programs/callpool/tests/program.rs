//! The named devnet proofs from Phase 06, run in-process against the real
//! compiled program.
//!
//! These are not a substitute for the devnet rows — a signature on a public
//! cluster is what Phase 06 §6.1 asks for — but every one of them is a
//! behaviour that must hold before a devnet run is worth spending on, and
//! several (7, 8, 9, 15, 16, 17, 18, 21) are cheaper to pin down here first.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const ONE_SOL: u64 = 1_000_000_000;

/// Post a one-leaf root for `epoch` paying `amount` to `recipient`, warp past
/// the challenge window, and hand back the proof.
fn single_leaf_epoch(
    f: &mut Fixture,
    epoch: u64,
    recipient: Pubkey,
    amount: u64,
    allocate: u64,
) -> Vec<[u8; 32]> {
    let payouts = vec![(recipient, amount)];
    let (_, levels) = build_tree(&payouts, epoch);
    f.advance_past_epoch(epoch);
    f.post_root(epoch, root_of(&levels), 1, allocate).unwrap();
    f.set_time(GENESIS_TS + (epoch as i64 + 1) * EPOCH_SECONDS as i64 + CHALLENGE_SECONDS as i64 + 2);
    proof_for(&levels, 0)
}

// ── the product working ────────────────────────────────────────────────────

#[test]
fn proof_13_a_full_epoch_pays_a_holder_who_does_nothing() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);

    let holder = f.holder(MIN_HOLD);
    let before = f.svm.get_balance(&holder.pubkey()).unwrap();

    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), 3 * ONE_SOL, 3 * ONE_SOL);
    // Submitted by someone else entirely — the holder never signs anything.
    f.claim(0, 0, 3 * ONE_SOL, proof, holder.pubkey()).unwrap();

    assert_eq!(f.svm.get_balance(&holder.pubkey()).unwrap(), before + 3 * ONE_SOL);
    assert_eq!(f.epoch_state(0).claimed_lamports, 3 * ONE_SOL);
    assert_eq!(f.config_state().outstanding, 0);
    f.assert_invariants(&[0], "after a full epoch");
}

// ── proof 7 — the pool is computed, not supplied ───────────────────────────

#[test]
fn proof_7_post_epoch_root_computes_the_pool_itself() {
    let mut f = Fixture::new();
    f.fund_pool(2 * ONE_SOL);
    f.advance_past_epoch(0);

    // Asking for more than the pool holds is refused outright, rather than
    // recorded and paid out first-come-first-served.
    assert!(
        f.post_root(0, [7u8; 32], 1, 100 * ONE_SOL).is_err(),
        "an inflated allocation must be refused",
    );

    // What the pool can actually back is its balance minus rent.
    let available = f.pool_lamports() - f.rent_minimum();
    f.post_root(0, [7u8; 32], 1, available).unwrap();
    assert_eq!(f.epoch_state(0).pool_lamports, available);
    assert_eq!(f.config_state().outstanding, available);
    f.assert_invariants(&[0], "after posting the full available balance");
}

#[test]
fn the_pool_can_never_be_drained_below_its_rent() {
    let mut f = Fixture::new();
    f.fund_pool(ONE_SOL);
    f.advance_past_epoch(0);

    let available = f.pool_lamports() - f.rent_minimum();
    assert!(f.post_root(0, [1u8; 32], 1, available + 1).is_err());
    f.post_root(0, [1u8; 32], 1, available).unwrap();
    assert!(f.pool_lamports() >= f.rent_minimum());
}

// ── proof 8 — a root naming a non-holder cannot be claimed ─────────────────

#[test]
fn proof_8_a_root_naming_a_non_holder_cannot_be_claimed() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);

    // An address with a token account but nothing in it.
    let outsider = Keypair::new();
    f.svm.airdrop(&outsider.pubkey(), ONE_SOL).unwrap();
    f.give_tokens(&outsider.pubkey(), 0);

    let proof = single_leaf_epoch(&mut f, 0, outsider.pubkey(), ONE_SOL, ONE_SOL);
    assert!(f.claim(0, 0, ONE_SOL, proof.clone(), outsider.pubkey()).is_err());

    // And the honest limit of that, stated in Phase 05 §5.5: buying the floor
    // clears it. This is a toll, not a barrier, and the test says so.
    let mint = f.mint.pubkey();
    let payer = f.payer.insecure_clone();
    let top_up = common::spl::mint_to(&mint, &ata(&outsider.pubkey(), &mint), &payer.pubkey(), MIN_HOLD);
    f.send(&[top_up], &[&payer]).unwrap();
    f.claim(0, 0, ONE_SOL, proof, outsider.pubkey()).unwrap();
}

#[test]
fn a_holder_one_unit_below_the_floor_is_refused() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD - 1);
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, ONE_SOL);
    assert!(f.claim(0, 0, ONE_SOL, proof, holder.pubkey()).is_err());
}

// ── proof 9 — an over-allocated root is bounded ────────────────────────────

#[test]
fn proof_9_an_over_allocated_root_stops_at_the_allocation() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);

    let a = f.holder(MIN_HOLD);
    let b = f.holder(MIN_HOLD);
    // A tree paying 4 SOL in total, against an epoch allocated only 5 SOL...
    // then a third leaf pushes the total past it.
    let payouts = vec![
        (a.pubkey(), 4 * ONE_SOL),
        (b.pubkey(), 4 * ONE_SOL),
    ];
    let (_, levels) = build_tree(&payouts, 0);
    f.advance_past_epoch(0);
    f.post_root(0, root_of(&levels), 2, 5 * ONE_SOL).unwrap();
    f.set_time(GENESIS_TS + EPOCH_SECONDS as i64 + CHALLENGE_SECONDS as i64 + 2);

    let ordered = canonical(&payouts);
    f.claim(0, 0, ordered[0].1, proof_for(&levels, 0), ordered[0].0).unwrap();
    // The second claim would take the epoch past what it was allocated.
    assert!(f
        .claim(0, 1, ordered[1].1, proof_for(&levels, 1), ordered[1].0)
        .is_err());

    f.assert_invariants(&[0], "after an over-allocated root");
    assert!(f.epoch_state(0).claimed_lamports <= f.epoch_state(0).pool_lamports);
}

// ── proof 10, 11 — the bitmap ──────────────────────────────────────────────

#[test]
fn proof_10_a_leaf_cannot_be_claimed_twice() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, 2 * ONE_SOL);

    f.claim(0, 0, ONE_SOL, proof.clone(), holder.pubkey()).unwrap();
    assert!(f.claim(0, 0, ONE_SOL, proof, holder.pubkey()).is_err());
    assert_eq!(f.epoch_state(0).claimed_lamports, ONE_SOL);
}

#[test]
fn proof_11_epochs_claim_in_any_order() {
    let mut f = Fixture::new();
    f.fund_pool(20 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);

    // Post three epochs, then claim the last one first — the bitmap has no
    // ordering requirement, which is what lets the airdrop bot batch freely.
    let mut proofs = Vec::new();
    for epoch in 0..3u64 {
        let payouts = vec![(holder.pubkey(), ONE_SOL)];
        let (_, levels) = build_tree(&payouts, epoch);
        f.advance_past_epoch(epoch);
        f.post_root(epoch, root_of(&levels), 1, ONE_SOL).unwrap();
        proofs.push(proof_for(&levels, 0));
    }
    f.set_time(GENESIS_TS + 3 * EPOCH_SECONDS as i64 + CHALLENGE_SECONDS as i64 + 2);

    for epoch in [2u64, 0, 1] {
        f.claim(epoch, 0, ONE_SOL, proofs[epoch as usize].clone(), holder.pubkey())
            .unwrap();
    }
    f.assert_invariants(&[0, 1, 2], "after out-of-order claims");
    assert_eq!(f.config_state().outstanding, 0);
}

// ── the challenge window ───────────────────────────────────────────────────

#[test]
fn a_claim_inside_the_challenge_window_is_refused() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);

    let payouts = vec![(holder.pubkey(), ONE_SOL)];
    let (_, levels) = build_tree(&payouts, 0);
    f.advance_past_epoch(0);
    f.post_root(0, root_of(&levels), 1, ONE_SOL).unwrap();

    // One second before the window closes.
    let posted = f.epoch_state(0).posted_ts;
    f.set_time(posted + CHALLENGE_SECONDS as i64 - 1);
    assert!(f.claim(0, 0, ONE_SOL, proof_for(&levels, 0), holder.pubkey()).is_err());

    f.set_time(posted + CHALLENGE_SECONDS as i64);
    f.claim(0, 0, ONE_SOL, proof_for(&levels, 0), holder.pubkey()).unwrap();
}

#[test]
fn an_epoch_cannot_be_posted_before_it_has_ended() {
    let mut f = Fixture::new();
    f.fund_pool(ONE_SOL);
    // One second before epoch 0 ends.
    f.set_time(GENESIS_TS + EPOCH_SECONDS as i64 - 1);
    assert!(f.post_root(0, [1u8; 32], 1, 0).is_err());
    f.set_time(GENESIS_TS + EPOCH_SECONDS as i64);
    f.post_root(0, [1u8; 32], 1, 0).unwrap();
}

// ── proof 15 (D1) — close_epoch is idempotent ──────────────────────────────

#[test]
fn proof_15_close_epoch_is_idempotent_and_does_not_underflow_outstanding() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    f.advance_past_epoch(0);
    f.post_root(0, [3u8; 32], 1, 4 * ONE_SOL).unwrap();

    let posted = f.epoch_state(0).posted_ts;
    f.set_time(posted + 30 * EPOCH_SECONDS as i64);

    f.close_epoch(0).unwrap();
    assert_eq!(f.config_state().outstanding, 0);
    assert!(f.epoch_state(0).closed);

    // Permissionless. Without D1, this second call underflows `outstanding`
    // and invariant 1 stops protecting the pool.
    assert!(f.close_epoch(0).is_err());
    assert_eq!(f.config_state().outstanding, 0);
    f.assert_invariants(&[0], "after a double close");
}

#[test]
fn close_epoch_before_the_deadline_is_refused() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    f.advance_past_epoch(0);
    f.post_root(0, [3u8; 32], 1, ONE_SOL).unwrap();

    let posted = f.epoch_state(0).posted_ts;
    f.set_time(posted + 30 * EPOCH_SECONDS as i64 - 1);
    assert!(f.close_epoch(0).is_err());
    f.set_time(posted + 30 * EPOCH_SECONDS as i64);
    f.close_epoch(0).unwrap();
}

#[test]
fn a_closed_epoch_cannot_be_claimed() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, ONE_SOL);

    let posted = f.epoch_state(0).posted_ts;
    f.set_time(posted + 30 * EPOCH_SECONDS as i64);
    f.close_epoch(0).unwrap();
    assert!(f.claim(0, 0, ONE_SOL, proof, holder.pubkey()).is_err());
}

// ── proof 16 (D2) — a bounded index ────────────────────────────────────────

#[test]
fn proof_16_an_index_outside_the_tree_is_rejected() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);

    // A root posted with leaf_count = 1. Index 9 is outside it, and without
    // D2 the bitmap read would silently return "unclaimed" for it.
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, ONE_SOL);
    assert!(f.claim(0, 9, ONE_SOL, proof.clone(), holder.pubkey()).is_err());
    assert!(f.claim(0, 1, ONE_SOL, proof.clone(), holder.pubkey()).is_err());
    f.claim(0, 0, ONE_SOL, proof, holder.pubkey()).unwrap();
}

#[test]
fn a_leaf_count_above_the_ceiling_is_refused() {
    let mut f = Fixture::new();
    f.fund_pool(ONE_SOL);
    f.advance_past_epoch(0);
    assert!(f.post_root(0, [1u8; 32], callpool::MAX_LEAF_COUNT + 1, 0).is_err());
}

// ── proof 17 — INITIALIZER, and D3 ─────────────────────────────────────────

#[test]
fn proof_17_initialize_refuses_a_stranger() {
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();

    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), 100 * ONE_SOL).unwrap();
    assert!(
        f.initialize_as(&stranger, MIN_HOLD, GENESIS_TS).is_err(),
        "only the compile-time INITIALIZER may bind the coin",
    );

    let initializer = f.initializer.insecure_clone();
    f.initialize_as(&initializer, MIN_HOLD, GENESIS_TS).unwrap();
    assert_eq!(f.config_state().snapshot_key, f.snapshot.pubkey());
}

#[test]
fn proof_17b_no_root_can_be_posted_before_initialize() {
    // D3. The guard inside the handler is now structurally unreachable, because
    // `Config` is created by `initialize` rather than by `create_pool` — so
    // this asserts the property, not the specific error.
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    f.set_time(GENESIS_TS + 2 * EPOCH_SECONDS as i64);
    assert!(f.post_root(0, [1u8; 32], 1, 0).is_err());
}

#[test]
fn initialize_runs_exactly_once() {
    let mut f = Fixture::new();
    assert!(f.initialize(MIN_HOLD).is_err(), "there is no set_params, and no re-initialize");
}

#[test]
fn initialize_refuses_a_min_hold_that_looks_like_whole_tokens() {
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    let initializer = f.initializer.insecure_clone();
    // 100_000 raw units at 6 decimals is a tenth of a token — the documented
    // footgun, and permanent if it lands.
    assert!(f.initialize_as(&initializer, 100_000, GENESIS_TS).is_err());
    f.initialize_as(&initializer, MIN_HOLD, GENESIS_TS).unwrap();
}

#[test]
fn initialize_refuses_a_genesis_that_is_not_a_utc_midnight() {
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    let initializer = f.initializer.insecure_clone();

    // Off by an hour: the on-chain epoch index would stop matching the UTC day
    // the snapshot settles, and every published epoch directory would be
    // labelled with a date it does not cover.
    assert!(f.initialize_as(&initializer, MIN_HOLD, GENESIS_TS + 3_600).is_err());
    // And a genesis far from now is refused even if it is aligned.
    assert!(f
        .initialize_as(&initializer, MIN_HOLD, GENESIS_TS - 30 * EPOCH_SECONDS as i64)
        .is_err());
    f.initialize_as(&initializer, MIN_HOLD, GENESIS_TS).unwrap();
}

#[test]
fn initialize_refuses_a_challenge_window_that_cannot_work() {
    // `challenge_seconds` is immutable and was the one `initialize` argument
    // with no validation at all. L14 fixed the value at 24 h, so this can be a
    // range rather than a recommendation.
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    let initializer = f.initializer.insecure_clone();

    // Zero: no challenge window, forever. The audit trail's whole claim is that
    // there is a period in which a wrong root can be disputed.
    assert!(f
        .initialize_full(&initializer, MIN_HOLD, GENESIS_TS, EPOCH_SECONDS, 0)
        .is_err());

    // Longer than the claim deadline: `close_epoch` could reclaim the money
    // before claims even opened. u32::MAX is ~136 years of frozen claims.
    let past_deadline = (callpool::CLAIM_DEADLINE_EPOCHS as u32 + 1) * EPOCH_SECONDS;
    assert!(f
        .initialize_full(&initializer, MIN_HOLD, GENESIS_TS, EPOCH_SECONDS, past_deadline)
        .is_err());
    assert!(f
        .initialize_full(&initializer, MIN_HOLD, GENESIS_TS, EPOCH_SECONDS, u32::MAX)
        .is_err());

    // Mainnet's shape is accepted.
    f.initialize_full(&initializer, MIN_HOLD, GENESIS_TS, EPOCH_SECONDS, CHALLENGE_SECONDS)
        .unwrap();
    assert_eq!(f.config_state().challenge_seconds, CHALLENGE_SECONDS);
}

#[test]
fn initialize_accepts_a_rehearsal_challenge_window() {
    // A dry run legitimately uses short epochs and a short window. The guard is
    // a range for exactly this reason — pinning it to 86,400 would make every
    // rehearsal impossible while proving nothing extra about mainnet.
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    let initializer = f.initializer.insecure_clone();

    // 300-second epochs, a 60-second window. GENESIS_TS is a UTC midnight, so
    // it is aligned to any epoch length that divides a day.
    f.initialize_full(&initializer, MIN_HOLD, GENESIS_TS, 300, 60).unwrap();
    assert_eq!(f.config_state().challenge_seconds, 60);
}

#[test]
fn initialize_refuses_a_floor_no_one_could_ever_meet() {
    // The upper-bound twin of the whole-tokens footgun: a floor above the total
    // supply means nobody is ever eligible, permanently, and the pool only ever
    // accumulates.
    let mut f = Fixture::uninitialized();
    f.create_pool().unwrap();
    let initializer = f.initializer.insecure_clone();

    assert!(f.initialize_as(&initializer, TOTAL_SUPPLY + 1, GENESIS_TS).is_err());
    f.initialize_as(&initializer, TOTAL_SUPPLY, GENESIS_TS).unwrap();
}

// ── proof 18 (D7 / L3) — empty epochs ──────────────────────────────────────

#[test]
fn proof_18_an_empty_epoch_posts_a_zeroed_root_and_closes_its_window() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    f.advance_past_epoch(0);

    f.post_root(0, [0u8; 32], 0, 0).unwrap();
    let epoch = f.epoch_state(0);
    assert_eq!(epoch.root, [0u8; 32]);
    assert_eq!(epoch.leaf_count, 0);
    assert_eq!(epoch.pool_lamports, 0);
    assert!(epoch.claimed_bits.is_empty());
    assert_eq!(f.config_state().outstanding, 0, "an empty epoch allocates nothing");

    // The window is now shut for good. Without this, a stolen key could come
    // back later and drain the whole backlog of skipped epochs in one sitting.
    assert!(f.post_root(0, [9u8; 32], 5, 5 * ONE_SOL).is_err());

    // The fees simply roll into the next epoch.
    f.advance_past_epoch(1);
    let available = f.pool_lamports() - f.rent_minimum();
    f.post_root(1, [1u8; 32], 1, available).unwrap();
    assert_eq!(f.epoch_state(1).pool_lamports, available);
}

#[test]
fn nothing_can_be_claimed_from_an_empty_epoch() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);
    f.advance_past_epoch(0);
    f.post_root(0, [0u8; 32], 0, 0).unwrap();
    f.set_time(GENESIS_TS + EPOCH_SECONDS as i64 + CHALLENGE_SECONDS as i64 + 2);

    // leaf_count is 0, so D2's bound rejects every index there is.
    assert!(f.claim(0, 0, ONE_SOL, vec![], holder.pubkey()).is_err());
}

// ── proof 21 — the bot cannot redirect a payment ───────────────────────────

#[test]
fn proof_21_the_submitter_cannot_redirect_a_payment() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);

    let holder = f.holder(MIN_HOLD);
    let thief = f.holder(MIN_HOLD); // holds enough to pass the floor check
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), 2 * ONE_SOL, 2 * ONE_SOL);

    // The bot submits the leaf's amount and proof, but names itself as the
    // destination. The leaf hashes the recipient, so the proof stops matching.
    assert!(f.claim(0, 0, 2 * ONE_SOL, proof.clone(), thief.pubkey()).is_err());
    assert_eq!(f.epoch_state(0).claimed_lamports, 0);

    f.claim(0, 0, 2 * ONE_SOL, proof, holder.pubkey()).unwrap();
}

#[test]
fn the_submitters_own_token_balance_cannot_stand_in_for_the_recipients() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);

    let holder = f.holder(0); // named in the leaf, holds nothing
    let rich = f.holder(MIN_HOLD * 10);
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, ONE_SOL);

    // Passing someone else's fat token account is rejected by the ATA
    // constraint, not merely by the balance check.
    let borrowed = ata(&rich.pubkey(), &f.mint.pubkey());
    assert!(f
        .claim_with_token_account(0, 0, ONE_SOL, proof, holder.pubkey(), borrowed)
        .is_err());
}

#[test]
fn a_forged_amount_does_not_verify() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    let holder = f.holder(MIN_HOLD);
    let proof = single_leaf_epoch(&mut f, 0, holder.pubkey(), ONE_SOL, 5 * ONE_SOL);

    assert!(f.claim(0, 0, 5 * ONE_SOL, proof.clone(), holder.pubkey()).is_err());
    f.claim(0, 0, ONE_SOL, proof, holder.pubkey()).unwrap();
}

// ── the snapshot key ───────────────────────────────────────────────────────

#[test]
fn only_the_snapshot_key_can_post_a_root() {
    let mut f = Fixture::new();
    f.fund_pool(ONE_SOL);
    f.advance_past_epoch(0);

    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), 100 * ONE_SOL).unwrap();
    assert!(f.post_root_as(&stranger, 0, [1u8; 32], 1, 0).is_err());

    let snapshot = f.snapshot.insecure_clone();
    f.post_root_as(&snapshot, 0, [1u8; 32], 1, 0).unwrap();
}

#[test]
fn an_epoch_that_already_has_a_root_cannot_be_reposted() {
    let mut f = Fixture::new();
    f.fund_pool(10 * ONE_SOL);
    f.advance_past_epoch(0);
    f.post_root(0, [1u8; 32], 1, ONE_SOL).unwrap();
    // Not even by the honest key: whoever posts first wins, which is stated
    // plainly in Phase 05 §5.5 rather than hidden.
    assert!(f.post_root(0, [2u8; 32], 1, ONE_SOL).is_err());
}

// ── create_pool ────────────────────────────────────────────────────────────

#[test]
fn create_pool_is_permissionless_but_runs_only_once() {
    let mut f = Fixture::uninitialized();
    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), 100 * ONE_SOL).unwrap();

    // Anyone may create it — the address is identical either way, and with
    // INITIALIZER as a compile-time constant, front-running it buys nothing.
    let payer = f.payer.insecure_clone();
    f.payer = stranger;
    f.create_pool().unwrap();
    f.payer = payer;

    assert!(f.create_pool().is_err());
    assert!(f.pool_lamports() >= f.rent_minimum());
}
