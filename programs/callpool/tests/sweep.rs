//! Phase 06 proof 12 — `sweep_wsol`, and the D4 constraints on it.
//!
//! Post-graduation creator fees arrive as **wrapped SOL in an ATA**, not as
//! lamports, and unwrapping needs `close_account` signed by the account's
//! owner — which is the pool PDA. Both the wrapped balance and the account's
//! rent land in the pool; both are pure inflows, so no invariant needs extra
//! arithmetic.
//!
//! D4 is the reason the account constraints are worth testing on their own:
//! without pinning **both** the native mint and the pool as authority, this
//! becomes a "close any token account owned by the pool" instruction.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_instruction,
    },
    system_program, InstructionData, ToAccountMetas,
};
use common::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

const ONE_SOL: u64 = 1_000_000_000;
const TOKEN_ACCOUNT_LEN: usize = 165;

/// SPL Token's native mint. Wrapped SOL and nothing else.
fn native_mint() -> Pubkey {
    anchor_spl::token::spl_token::native_mint::ID
}

/// Place the native mint account, which a fresh LiteSVM does not carry.
///
/// Packed `Mint`: COption mint_authority (4 + 32) | supply (8) | decimals (1)
/// | is_initialized (1) | COption freeze_authority (4 + 32) = 82 bytes. The
/// native mint has no authorities, so only decimals and the init flag are set.
fn install_native_mint(f: &mut Fixture) {
    let mut data = vec![0u8; spl::MINT_LEN];
    data[44] = 9; // decimals
    data[45] = 1; // is_initialized

    f.svm
        .set_account(
            native_mint(),
            Account {
                lamports: f.svm.minimum_balance_for_rent_exemption(spl::MINT_LEN),
                data,
                owner: spl::token_program_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

/// `SyncNative` — tag 17. Sets a wrapped account's amount from its lamports.
fn sync_native(account: &Pubkey) -> Instruction {
    Instruction {
        program_id: spl::token_program_id(),
        accounts: vec![AccountMeta::new(*account, false)],
        data: vec![17],
    }
}

/// `InitializeAccount3` — tag 18. Used only to build a *non*-ATA token account.
fn initialize_account3(account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: spl::token_program_id(),
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
        ],
        data,
    }
}

/// Create the pool's wSOL ATA and wrap `lamports` into it.
fn wrap_into_pool_ata(f: &mut Fixture, lamports: u64) -> Pubkey {
    let payer = f.payer.insecure_clone();
    let pool = f.pool;
    let account = ata(&pool, &native_mint());

    let create = spl::create_associated_token_account(&payer.pubkey(), &pool, &native_mint());
    f.send(&[create], &[&payer]).unwrap();

    let fund = system_instruction::transfer(&payer.pubkey(), &account, lamports);
    f.send(&[fund, sync_native(&account)], &[&payer]).unwrap();
    account
}

fn sweep(f: &mut Fixture, wsol_mint: Pubkey, pool_wsol: Pubkey) -> litesvm::types::TransactionResult {
    let payer = f.payer.insecure_clone();
    let ix = Instruction::new_with_bytes(
        callpool::ID,
        &callpool::instruction::SweepWsol {}.data(),
        callpool::accounts::SweepWsol {
            caller: payer.pubkey(),
            config: f.config,
            pool: f.pool,
            wsol_mint,
            pool_wsol,
            token_program: spl::token_program_id(),
            associated_token_program: spl::associated_token_program_id(),
        }
        .to_account_metas(None),
    );
    f.send(&[ix], &[&payer])
}

#[test]
fn proof_12_sweep_lands_both_the_wrapped_balance_and_the_rent_in_the_pool() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);
    f.fund_pool(ONE_SOL);

    let account = wrap_into_pool_ata(&mut f, 3 * ONE_SOL);
    let account_lamports = f.svm.get_balance(&account).unwrap();
    let pool_before = f.pool_lamports();

    // The rent is part of what comes back, so the expected gain is the whole
    // account balance, not just the wrapped amount.
    assert!(account_lamports > 3 * ONE_SOL, "rent sits on top of the wrapped SOL");

    sweep(&mut f, native_mint(), account).unwrap();

    assert_eq!(f.pool_lamports(), pool_before + account_lamports);
    assert!(f.svm.get_account(&account).is_none_or(|a| a.lamports == 0));
    f.assert_invariants(&[], "after sweeping wSOL");
}

#[test]
fn sweep_is_permissionless() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);
    f.fund_pool(ONE_SOL);
    let account = wrap_into_pool_ata(&mut f, ONE_SOL);

    // Anyone can crank it. Nothing of ours sits in the fee path, so this is a
    // liveness dependency and never a trust one.
    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), 10 * ONE_SOL).unwrap();
    f.payer = stranger;

    sweep(&mut f, native_mint(), account).unwrap();
}

#[test]
fn d4_sweep_refuses_a_mint_that_is_not_wrapped_sol() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);

    // The coin's own mint, and a token account for it owned by the pool. If
    // `wsol_mint` were not pinned, this would be a "close any token account
    // owned by the pool" instruction — including one holding real tokens.
    let payer = f.payer.insecure_clone();
    let pool = f.pool;
    let mint = f.mint.pubkey();
    let create = spl::create_associated_token_account(&payer.pubkey(), &pool, &mint);
    f.send(&[create], &[&payer]).unwrap();

    let pool_token_account = ata(&pool, &mint);
    assert!(
        sweep(&mut f, mint, pool_token_account).is_err(),
        "only the native mint may be swept",
    );
}

#[test]
fn d4_sweep_refuses_an_account_the_pool_does_not_own() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);
    f.fund_pool(ONE_SOL);

    // A wSOL ATA belonging to someone else entirely.
    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), 10 * ONE_SOL).unwrap();
    let payer = f.payer.insecure_clone();
    let create =
        spl::create_associated_token_account(&payer.pubkey(), &stranger.pubkey(), &native_mint());
    f.send(&[create], &[&payer]).unwrap();

    assert!(
        sweep(&mut f, native_mint(), ata(&stranger.pubkey(), &native_mint())).is_err(),
        "the pool must be the account's authority",
    );
}

#[test]
fn d4_sweep_refuses_a_wsol_account_that_is_not_the_pools_ata() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);
    f.fund_pool(ONE_SOL);

    // A wSOL account owned by the pool but at an arbitrary address. The
    // `associated_token::*` constraints pin the derivation as well as the
    // authority, so an auxiliary account cannot be substituted.
    let payer = f.payer.insecure_clone();
    let pool = f.pool;
    let aux = Keypair::new();
    let rent = f.svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &aux.pubkey(),
        rent + ONE_SOL,
        TOKEN_ACCOUNT_LEN as u64,
        &spl::token_program_id(),
    );
    let init = initialize_account3(&aux.pubkey(), &native_mint(), &pool);
    f.send(&[create, init], &[&payer, &aux]).unwrap();

    assert!(sweep(&mut f, native_mint(), aux.pubkey()).is_err());
}

#[test]
fn sweeping_leaves_the_pool_able_to_allocate_the_new_lamports() {
    let mut f = Fixture::new();
    install_native_mint(&mut f);
    f.fund_pool(ONE_SOL);
    let account = wrap_into_pool_ata(&mut f, 5 * ONE_SOL);

    sweep(&mut f, native_mint(), account).unwrap();

    // The swept SOL is ordinary pool balance: the next root can allocate it,
    // which is the whole reason step 0 of the crank precedes step 5.
    f.advance_past_epoch(0);
    let available = f.pool_lamports() - f.rent_minimum();
    assert!(available > 5 * ONE_SOL);
    f.post_root(0, [1u8; 32], 1, available).unwrap();
    assert_eq!(f.epoch_state(0).pool_lamports, available);
    f.assert_invariants(&[0], "after allocating swept lamports");
}

/// The pool address must not depend on the mint — it has to exist before the
/// coin does, so it can be pasted into pump.fun's creator-rewards dialog.
#[test]
fn the_pool_pda_is_seeded_on_a_constant_not_on_the_mint() {
    let expected = Pubkey::find_program_address(&[callpool::POOL_SEED], &callpool::ID).0;
    let f = Fixture::new();
    assert_eq!(f.pool, expected);
    // Derivable with no knowledge of the mint at all.
    assert_ne!(f.pool, Pubkey::find_program_address(&[callpool::POOL_SEED, f.mint.pubkey().as_ref()], &callpool::ID).0);
    assert_eq!(f.svm.get_account(&f.pool).unwrap().owner, system_program::ID);
}
