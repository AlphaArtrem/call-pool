//! Minimal SPL Token and Associated Token Account instruction builders.
//!
//! Hand-rolled rather than pulled from the `spl-token` crate on purpose: that
//! crate resolves a different version of the pubkey type than anchor-lang 1.1.2
//! does, and reconciling the two in a test harness buys nothing. These three
//! encodings are stable, tiny, and used only to set up fixtures — the program
//! under test never encodes a token instruction itself.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    system_program,
};

/// SPL Token's packed `Mint` length.
pub const MINT_LEN: usize = 82;

pub fn token_program_id() -> Pubkey {
    anchor_spl::token::ID
}

pub fn associated_token_program_id() -> Pubkey {
    anchor_spl::associated_token::ID
}

/// The wallet's associated token account for a mint — the one account that
/// counts, on both sides of the system (L6).
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            wallet.as_ref(),
            token_program_id().as_ref(),
            mint.as_ref(),
        ],
        &associated_token_program_id(),
    )
    .0
}

/// `InitializeMint2` — tag 20. Unlike `InitializeMint` it needs no rent sysvar.
pub fn initialize_mint2(mint: &Pubkey, authority: &Pubkey, decimals: u8) -> Instruction {
    let mut data = Vec::with_capacity(35);
    data.push(20);
    data.push(decimals);
    data.extend_from_slice(authority.as_ref());
    data.push(0); // COption::None — no freeze authority, ever

    Instruction {
        program_id: token_program_id(),
        accounts: vec![AccountMeta::new(*mint, false)],
        data,
    }
}

/// `MintTo` — tag 7.
pub fn mint_to(mint: &Pubkey, destination: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(7);
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: token_program_id(),
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Associated Token Account program `Create` — discriminator 0.
pub fn create_associated_token_account(
    funder: &Pubkey,
    wallet: &Pubkey,
    mint: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: associated_token_program_id(),
        accounts: vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new(associated_token_address(wallet, mint), false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vec![0],
    }
}
