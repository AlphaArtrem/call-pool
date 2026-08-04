//! CALLPOOL — merkle-gated SOL distribution for pump.fun creator fees.
//!
//! The program holds lamports and verifies merkle proofs. That is all it does.
//! It never holds, moves, or is approved for anyone's tokens; it has no mint,
//! freeze or delegate authority; and it CPIs into pump.fun nowhere.
//!
//! **There is no admin path.** No pause, no withdraw, no parameter change, no
//! upgrade of anything after `initialize`. Every parameter written by
//! `initialize` is permanent, and the accepted cost is that a bug is permanent
//! too — Phase 04 §4.2, and standing rule 3 in the tracker.
//!
//! Six instructions. If a seventh ever appears, that is the thing to be
//! suspicious of (`scripts/verify.sh` asserts the count).
//!
//! The defects from adversarial review (Phase 04 §4.8) are fixed here and each
//! fix is marked `D1`…`D7` at its site, because every one of them is permanent
//! once deployed.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface,
};

pub mod merkle;

declare_id!("ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7");

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const EPOCH_SEED: &[u8] = b"epoch";

/// The only address permitted to call `initialize`.
///
/// **A compile-time constant, not a runtime authority.** `create_pool` is
/// permissionless and used to record its payer as the initializer, which was a
/// front-runnable race: anyone watching the chain between deployment and our
/// own call could have become the sole party able to set `snapshot_key`, on a
/// pool address identical either way. A constant cannot be front-run, stolen or
/// transferred, so it costs nothing against the no-admin-path rule.
///
/// ⚠️ **PLACEHOLDER — this is a throwaway test key whose secret is committed in
/// `tests/common/mod.rs`.** It must be replaced with the real launch address
/// before the program is built for deployment, and `scripts/verify.sh` fails
/// the build until it is. Phase 08 §8.5 verifies it reads back correctly on
/// chain before the coin is created.
pub const INITIALIZER: Pubkey = pubkey!("2GwbgxTu35NbWCsMwimQX8AjsVSxDsP5UvJoCdybQWtf");

/// Unclaimed lamports return to the pool after this many epochs (Decision 27).
pub const CLAIM_DEADLINE_EPOCHS: u64 = 30;

/// Upper bound on a single epoch's leaf count.
///
/// `leaf_count` is chosen by the snapshot signer and sizes an account the
/// signer pays rent for, so it needs a ceiling that is not "whatever fits in a
/// u32". The real ceiling is structural: every eligible wallet holds at least
/// the floor, so at a 0.01% floor at most 10,000 wallets can qualify at once
/// (Phase 05 §5.11). This is set to twice that. The headroom was originally
/// there so L12's unsettled 0.005% reading would fit; L13 settled the floor at
/// 0.01%, and the headroom stays because a slack ceiling on an unupgradeable
/// program costs nothing and a tight one cannot be loosened.
pub const MAX_LEAF_COUNT: u32 = 20_000;

/// Guards against a `min_hold` written in whole tokens instead of raw units.
///
/// The documented footgun (Phase 04 §4.1): at 6 decimals, writing `100_000`
/// rather than `100_000_000_000` sets the floor to a tenth of a token,
/// silently and forever. Requiring at least one whole token does not pin the
/// value — it only catches the fat finger.
pub fn min_raw_floor(decimals: u8) -> u64 {
    10u64.pow(decimals as u32)
}

#[program]
pub mod callpool {
    use super::*;

    /// Create the pool PDA. Permissionless, once.
    ///
    /// Separate from `initialize` so the pool address exists — and can be
    /// pasted into pump.fun's creator-rewards dialog — **before the coin does**.
    /// pump.fun rejects uninitialized fee recipients, and a mint-derived PDA
    /// could not satisfy that ordering (Phase 04 §4.2).
    ///
    /// The gap between this and `initialize` is safe for the money (the pool is
    /// a plain lamport account and fees accrue into it regardless) and safe for
    /// the parameters (only `INITIALIZER` can set them).
    pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
        // Created by hand rather than by Anchor's `init`, because the pool must
        // stay owned by the System Program with zero data: it is a bare lamport
        // account, and `system_program::transfer` refuses to move lamports out
        // of an account the System Program does not own. Anchor's `init` cannot
        // express that, so the CPI is written out.
        let pool = &ctx.accounts.pool;
        require!(pool.lamports() == 0, CallpoolError::PoolAlreadyExists);

        let bump = ctx.bumps.pool;
        let seeds: &[&[u8]] = &[POOL_SEED, &[bump]];
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: pool.to_account_info(),
                },
                &[seeds],
            ),
            Rent::get()?.minimum_balance(0),
            0,
            &system_program::ID,
        )?;

        emit!(PoolCreated {
            pool: pool.key(),
            payer: ctx.accounts.payer.key(),
        });
        Ok(())
    }

    /// Bind the coin and start the epoch clock. Once, by `INITIALIZER`.
    ///
    /// Every argument here is immutable afterwards. There is no `set_params`,
    /// no `set_snapshot_key`, and losing the snapshot authority freezes
    /// distributions forever — which is why it is a 2-of-3 multisig (L3).
    pub fn initialize(
        ctx: Context<Initialize>,
        genesis_ts: i64,
        epoch_seconds: u32,
        min_hold: u64,
        challenge_seconds: u32,
        snapshot_key: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.payer.key(),
            INITIALIZER,
            CallpoolError::NotInitializer
        );
        require!(epoch_seconds > 0, CallpoolError::InvalidParameter);
        require!(snapshot_key != Pubkey::default(), CallpoolError::InvalidParameter);

        // `min_hold` is in RAW units. See `min_raw_floor` for what this catches
        // and, just as importantly, what it does not.
        require!(
            min_hold >= min_raw_floor(ctx.accounts.mint.decimals),
            CallpoolError::MinHoldLooksLikeWholeTokens
        );

        // Epoch 0 must start on an epoch boundary in absolute time, so the
        // on-chain epoch index and the crank's UTC calendar day are the same
        // thing. With `epoch_seconds = 86_400` this means a UTC midnight.
        //
        // Phase 04 §4.2 had `genesis_ts` set to whatever time `initialize`
        // landed. That would put every epoch boundary at an arbitrary time of
        // day while the snapshot settles UTC days, and the index-to-date
        // mapping the whole audit trail depends on would not line up.
        let now = Clock::get()?.unix_timestamp;
        require!(
            genesis_ts.rem_euclid(epoch_seconds as i64) == 0,
            CallpoolError::GenesisNotAligned
        );
        require!(
            (genesis_ts - now).abs() <= epoch_seconds as i64,
            CallpoolError::GenesisOutOfRange
        );

        let config = &mut ctx.accounts.config;
        config.mint = ctx.accounts.mint.key();
        config.genesis_ts = genesis_ts;
        config.epoch_seconds = epoch_seconds;
        config.min_hold = min_hold;
        config.challenge_seconds = challenge_seconds;
        config.snapshot_key = snapshot_key;
        config.outstanding = 0;
        config.bump = ctx.bumps.config;
        config.pool_bump = ctx.bumps.pool;

        emit!(Initialized {
            mint: config.mint,
            decimals: ctx.accounts.mint.decimals,
            genesis_ts,
            epoch_seconds,
            min_hold,
            challenge_seconds,
            snapshot_key,
        });
        Ok(())
    }

    /// Post one epoch's merkle root. `snapshot_key` only.
    ///
    /// The signer chooses 32 bytes, a bitmap length and an allocation capped by
    /// the pool's own balance. They cannot exceed `available`, allocate from a
    /// different epoch, post twice, or post early. What they *can* do is
    /// documented honestly in Phase 05 §5.5 — this is not a trustless step and
    /// the site must not claim it is.
    ///
    /// **A root is posted for every epoch, including empty ones** —
    /// `post_epoch_root(n, [0; 32], 0, 0)` (D7 / L3). Skipping an epoch leaves
    /// its posting window open forever, and a backlog of open windows is a
    /// stored-up liability a stolen key drains in one sitting.
    pub fn post_epoch_root(
        ctx: Context<PostEpochRoot>,
        epoch: u64,
        root: [u8; 32],
        leaf_count: u32,
        allocate: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        // D3 — the config must be initialized before an epoch can be posted.
        // Structurally unreachable now that `Config` is created by `initialize`
        // rather than by `create_pool`, since Anchor cannot deserialize an
        // account that does not exist. Kept because it is free and because the
        // program has no upgrade path if that structure ever changes.
        require!(config.mint != Pubkey::default(), CallpoolError::NotInitialized);
        require!(leaf_count <= MAX_LEAF_COUNT, CallpoolError::LeafCountTooLarge);

        let now = Clock::get()?.unix_timestamp;
        let epoch_end = config
            .genesis_ts
            .checked_add(
                (epoch.checked_add(1).ok_or(CallpoolError::MathOverflow)? as i64)
                    .checked_mul(config.epoch_seconds as i64)
                    .ok_or(CallpoolError::MathOverflow)?,
            )
            .ok_or(CallpoolError::MathOverflow)?;
        require!(now >= epoch_end, CallpoolError::EpochNotEnded);

        // `pool_lamports` is computed here, never supplied. A signer who asks
        // for more than the pool holds is refused rather than trusted.
        let rent_minimum = Rent::get()?.minimum_balance(0);
        let available = ctx
            .accounts
            .pool
            .lamports()
            .saturating_sub(rent_minimum)
            .saturating_sub(config.outstanding);
        require!(allocate <= available, CallpoolError::AllocationExceedsPool);

        let epoch_account = &mut ctx.accounts.epoch_account;
        epoch_account.index = epoch;
        epoch_account.root = root;
        epoch_account.pool_lamports = allocate;
        epoch_account.claimed_lamports = 0;
        epoch_account.posted_ts = now;
        // D2 — stored on chain, so an undersized bitmap is visible to anyone
        // checking the epoch rather than only to whoever built the tree.
        epoch_account.leaf_count = leaf_count;
        epoch_account.closed = false;
        epoch_account.claimed_bits = vec![0u8; leaf_count.div_ceil(8) as usize];

        config.outstanding = config
            .outstanding
            .checked_add(allocate)
            .ok_or(CallpoolError::MathOverflow)?;

        emit!(EpochRootPosted {
            epoch,
            root,
            leaf_count,
            allocated: allocate,
            posted_ts: now,
        });
        Ok(())
    }

    /// Pay one leaf. **Requires no signature from the recipient.**
    ///
    /// The payee is fixed inside the merkle leaf, so submitting this cannot
    /// redirect the money — which means anyone can submit it on someone else's
    /// behalf, and that is exactly how rewards are delivered (L8). The payout
    /// bot is a submitter, not an authority. A holder tired of waiting can run
    /// the same instruction from the published proof.
    pub fn claim(
        ctx: Context<Claim>,
        epoch: u64,
        index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let epoch_account = &mut ctx.accounts.epoch_account;
        let now = Clock::get()?.unix_timestamp;

        require!(
            now >= epoch_account.posted_ts + config.challenge_seconds as i64,
            CallpoolError::ChallengeWindowOpen
        );
        require!(!epoch_account.closed, CallpoolError::EpochClosed);

        // D2 — without this, a correct-looking root posted with a tiny bitmap
        // permanently strands every leaf above it while still looking valid to
        // a verifier that only checks the root.
        require!(index < epoch_account.leaf_count, CallpoolError::IndexOutOfRange);
        require!(!bit_is_set(&epoch_account.claimed_bits, index), CallpoolError::AlreadyClaimed);

        // Eligibility, not security (L3). A bad root can only name addresses
        // that currently hold `min_hold`, which is worth one purchase of the
        // floor, resold immediately and reused every epoch. The real bound is
        // in Phase 05 §5.5. This is read from the RECIPIENT's associated token
        // account — never the submitter's — which is the same single account
        // the off-chain `hold` reads (L6).
        require!(
            ctx.accounts.recipient_token_account.amount >= config.min_hold,
            CallpoolError::BelowMinHold
        );

        let leaf = merkle::leaf_hash(index, &ctx.accounts.recipient.key(), epoch, amount);
        require!(
            merkle::verify(&proof, &epoch_account.root, leaf),
            CallpoolError::InvalidProof
        );

        // Bounds an over-allocated root to that epoch's money. It degrades to
        // first-come-first-served within the epoch, which is bad and bounded —
        // detecting over-allocation is the challenge window's job, because on
        // chain it is only contained, not prevented.
        let claimed_after = epoch_account
            .claimed_lamports
            .checked_add(amount)
            .ok_or(CallpoolError::MathOverflow)?;
        require!(
            claimed_after <= epoch_account.pool_lamports,
            CallpoolError::EpochOverclaimed
        );

        set_bit(&mut epoch_account.claimed_bits, index);
        epoch_account.claimed_lamports = claimed_after;

        let config = &mut ctx.accounts.config;
        config.outstanding = config
            .outstanding
            .checked_sub(amount)
            .ok_or(CallpoolError::MathOverflow)?;

        let pool_bump = config.pool_bump;
        let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::Transfer {
                    from: ctx.accounts.pool.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(Claimed {
            epoch,
            index,
            recipient: ctx.accounts.recipient.key(),
            amount,
        });
        Ok(())
    }

    /// Return an epoch's unclaimed lamports to the pool. Permissionless, after
    /// the 30-epoch claim deadline.
    ///
    /// **It does not close the `Epoch` account and never reclaims its rent.**
    /// 365 accounts a year at 0.0015–0.0023 SOL is 0.55–0.85 SOL/yr, and that
    /// buys permanent on-chain verifiability of every root — which is the whole
    /// audit story. Phase 04 §4.5 floats renaming this `finalize_epoch` for
    /// exactly that reason; the name is kept because four other documents, the
    /// launch runbook and devnet proof 15 all reference `close_epoch`, and doc
    /// drift on an unupgradeable program is the worse hazard.
    pub fn close_epoch(ctx: Context<CloseEpoch>, epoch: u64) -> Result<()> {
        let epoch_account = &mut ctx.accounts.epoch_account;

        // D1 — this instruction is permissionless. Without the guard anyone
        // calls it twice, `config.outstanding` underflows, and invariant 1
        // stops protecting the pool.
        require!(!epoch_account.closed, CallpoolError::EpochClosed);

        let config = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        let deadline = epoch_account.posted_ts
            + (CLAIM_DEADLINE_EPOCHS as i64) * (config.epoch_seconds as i64);
        require!(now >= deadline, CallpoolError::ClaimDeadlineNotReached);

        let unclaimed = epoch_account
            .pool_lamports
            .checked_sub(epoch_account.claimed_lamports)
            .ok_or(CallpoolError::MathOverflow)?;
        epoch_account.closed = true;
        config.outstanding = config
            .outstanding
            .checked_sub(unclaimed)
            .ok_or(CallpoolError::MathOverflow)?;

        // No lamports move: the pool PDA already holds them. Closing only
        // releases the accounting claim on them.
        emit!(EpochClosed {
            epoch,
            returned: unclaimed,
        });
        Ok(())
    }

    /// Unwrap the pool's wSOL into the pool. Permissionless.
    ///
    /// Post-graduation creator fees arrive as wrapped SOL in an ATA rather than
    /// as lamports, and unwrapping needs `close_account` signed by the owner —
    /// which is the pool PDA. Both the wrapped balance and the account's rent
    /// land in the pool, and both are pure inflows, so no invariant needs extra
    /// arithmetic.
    ///
    /// D4 — the accounts are constrained to **the native SOL mint** and to an
    /// ATA **owned by the pool**. Without both, this would be a "close any
    /// token account owned by the pool" instruction.
    ///
    /// D5 is a crank obligation, not a program one: this cannot recreate the
    /// ATA (the System Program will not move lamports out of an account it does
    /// not own), so the crank recreates it immediately after sweeping. Devnet
    /// proof 12b covers graduate → distribute → sweep → distribute.
    pub fn sweep_wsol(ctx: Context<SweepWsol>) -> Result<()> {
        let amount = ctx.accounts.pool_wsol.amount;
        let before = ctx.accounts.pool.lamports();

        let pool_bump = ctx.accounts.config.pool_bump;
        let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.pool_wsol.to_account_info(),
                destination: ctx.accounts.pool.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ))?;

        emit!(WsolSwept {
            unwrapped: amount,
            pool_lamports_before: before,
        });
        Ok(())
    }
}

// ── accounts ───────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Set by `initialize`, after the coin exists. Zero means uninitialized.
    pub mint: Pubkey,
    /// Epoch 0 starts here. Aligned to an epoch boundary in absolute time.
    pub genesis_ts: i64,
    pub epoch_seconds: u32,
    /// THE eligibility floor, in RAW units — identical on chain and off (L4/L12).
    pub min_hold: u64,
    pub challenge_seconds: u32,
    /// A 2-of-3 multisig vault (L3). May post roots and nothing else.
    pub snapshot_key: Pubkey,
    /// Lamports allocated to open epochs and not yet claimed.
    pub outstanding: u64,
    pub bump: u8,
    pub pool_bump: u8,
}

#[account]
pub struct Epoch {
    pub index: u64,
    pub root: [u8; 32],
    /// Derived on chain from the pool's own balance, never supplied.
    pub pool_lamports: u64,
    pub claimed_lamports: u64,
    pub posted_ts: i64,
    /// Stored so a verifier can spot an undersized bitmap (D2).
    pub leaf_count: u32,
    pub closed: bool,
    /// One bit per leaf, sized at post time.
    pub claimed_bits: Vec<u8>,
}

impl Epoch {
    /// Discriminator + fixed fields + the vec's length prefix + the bitmap.
    pub fn space(leaf_count: u32) -> usize {
        8 + 8 + 32 + 8 + 8 + 8 + 4 + 1 + 4 + leaf_count.div_ceil(8) as usize
    }
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// A bare lamport account with no data. This is the address named as a
    /// pump.fun fee shareholder, and it is seeded on a constant rather than on
    /// the mint so it exists before the coin does.
    ///
    /// `UncheckedAccount` because it does not exist yet — the handler creates
    /// it and the seeds constraint pins which address it may be.
    /// CHECK: constrained by seeds; created as a zero-data System account.
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: SystemAccount<'info>,
    /// Read for its `decimals` and pinned into the config. Taken as an account
    /// rather than an argument so it cannot name a mint that does not exist.
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64, root: [u8; 32], leaf_count: u32)]
pub struct PostEpochRoot<'info> {
    #[account(mut, address = config.snapshot_key @ CallpoolError::NotSnapshotKey)]
    pub snapshot_key: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: SystemAccount<'info>,
    /// `init` is what makes an epoch postable exactly once.
    #[account(
        init,
        payer = snapshot_key,
        space = Epoch::space(leaf_count),
        seeds = [EPOCH_SEED, config.mint.as_ref(), &epoch.to_le_bytes()],
        bump
    )]
    pub epoch_account: Account<'info, Epoch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct Claim<'info> {
    /// Anyone. The payout bot, a holder, a stranger — it changes nothing,
    /// because the destination is fixed inside the leaf.
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, config.mint.as_ref(), &epoch.to_le_bytes()],
        bump
    )]
    pub epoch_account: Account<'info, Epoch>,
    /// The address named in the leaf. Not a signer, by design (L8).
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    #[account(address = config.mint @ CallpoolError::WrongMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// The recipient's associated token account for the mint — the same single
    /// account the off-chain `hold` reads (L6), constrained on both mint and
    /// owner so the submitter's own balance can never stand in for it.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CloseEpoch<'info> {
    /// Permissionless — hence D1.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, config.mint.as_ref(), &epoch.to_le_bytes()],
        bump
    )]
    pub epoch_account: Account<'info, Epoch>,
}

#[derive(Accounts)]
pub struct SweepWsol<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: SystemAccount<'info>,
    /// D4 — native SOL only.
    #[account(address = anchor_spl::token::spl_token::native_mint::ID @ CallpoolError::WrongMint)]
    pub wsol_mint: InterfaceAccount<'info, Mint>,
    /// D4 — and only an ATA the pool itself owns.
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub pool_wsol: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ── bitmap ─────────────────────────────────────────────────────────────────

pub fn bit_is_set(bits: &[u8], index: u32) -> bool {
    let byte = (index / 8) as usize;
    match bits.get(byte) {
        Some(b) => b & (1u8 << (index % 8)) != 0,
        None => false,
    }
}

pub fn set_bit(bits: &mut [u8], index: u32) {
    let byte = (index / 8) as usize;
    if let Some(b) = bits.get_mut(byte) {
        *b |= 1u8 << (index % 8);
    }
}

// ── events ─────────────────────────────────────────────────────────────────
// Every state change emits one. The site and the snapshot builder both read
// them, and an epoch that cannot be reconstructed from logs is an epoch nobody
// can audit (§4.7).

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub payer: Pubkey,
}

#[event]
pub struct Initialized {
    pub mint: Pubkey,
    pub decimals: u8,
    pub genesis_ts: i64,
    pub epoch_seconds: u32,
    pub min_hold: u64,
    pub challenge_seconds: u32,
    pub snapshot_key: Pubkey,
}

#[event]
pub struct EpochRootPosted {
    pub epoch: u64,
    pub root: [u8; 32],
    pub leaf_count: u32,
    pub allocated: u64,
    pub posted_ts: i64,
}

#[event]
pub struct Claimed {
    pub epoch: u64,
    pub index: u32,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochClosed {
    pub epoch: u64,
    pub returned: u64,
}

#[event]
pub struct WsolSwept {
    pub unwrapped: u64,
    pub pool_lamports_before: u64,
}

// ── errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum CallpoolError {
    #[msg("only the compile-time INITIALIZER may call initialize")]
    NotInitializer,
    #[msg("only the snapshot key may post an epoch root")]
    NotSnapshotKey,
    #[msg("the config has not been initialized")]
    NotInitialized,
    #[msg("parameter is out of range")]
    InvalidParameter,
    #[msg("min_hold is below one whole token — it looks like whole tokens, not raw units")]
    MinHoldLooksLikeWholeTokens,
    #[msg("genesis_ts is not aligned to an epoch boundary")]
    GenesisNotAligned,
    #[msg("genesis_ts is more than one epoch away from now")]
    GenesisOutOfRange,
    #[msg("this epoch has not ended yet")]
    EpochNotEnded,
    #[msg("leaf_count exceeds the maximum eligible set")]
    LeafCountTooLarge,
    #[msg("allocation exceeds the pool's available balance")]
    AllocationExceedsPool,
    #[msg("the challenge window has not closed")]
    ChallengeWindowOpen,
    #[msg("this epoch is closed")]
    EpochClosed,
    #[msg("leaf index is outside this epoch's tree")]
    IndexOutOfRange,
    #[msg("this leaf has already been claimed")]
    AlreadyClaimed,
    #[msg("the recipient holds less than min_hold")]
    BelowMinHold,
    #[msg("merkle proof does not reproduce the epoch root")]
    InvalidProof,
    #[msg("claim would exceed this epoch's allocation")]
    EpochOverclaimed,
    #[msg("the claim deadline has not been reached")]
    ClaimDeadlineNotReached,
    #[msg("wrong mint")]
    WrongMint,
    #[msg("the pool PDA already exists")]
    PoolAlreadyExists,
    #[msg("arithmetic overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmap_sets_and_reads_one_bit_at_a_time() {
        let mut bits = vec![0u8; 2];
        for i in 0..16u32 {
            assert!(!bit_is_set(&bits, i));
        }
        set_bit(&mut bits, 0);
        set_bit(&mut bits, 7);
        set_bit(&mut bits, 8);
        set_bit(&mut bits, 15);
        for i in 0..16u32 {
            let expected = matches!(i, 0 | 7 | 8 | 15);
            assert_eq!(bit_is_set(&bits, i), expected, "bit {i}");
        }
    }

    #[test]
    fn bitmap_reads_out_of_range_as_unclaimed_and_writes_nothing() {
        // `claim` bounds the index separately (D2); this only has to be safe,
        // not meaningful, when handed an index past the end.
        let mut bits = vec![0u8; 1];
        assert!(!bit_is_set(&bits, 64));
        set_bit(&mut bits, 64);
        assert_eq!(bits, vec![0u8]);
    }

    #[test]
    fn epoch_space_matches_the_bitmap_it_has_to_hold() {
        // 8 discriminator + 8 index + 32 root + 8 pool + 8 claimed + 8 posted_ts
        // + 4 leaf_count + 1 closed + 4 vec length prefix = 81 fixed bytes.
        const FIXED: usize = 81;
        assert_eq!(Epoch::space(0), FIXED);
        assert_eq!(Epoch::space(1), FIXED + 1);
        assert_eq!(Epoch::space(8), FIXED + 1, "8 leaves still fit in one byte");
        assert_eq!(Epoch::space(9), FIXED + 2);
        // The structural ceiling: 20,000 leaves is a 2,500-byte bitmap, well
        // inside what one account can hold.
        assert_eq!(Epoch::space(MAX_LEAF_COUNT), FIXED + 2_500);
    }

    #[test]
    fn min_hold_guard_catches_the_decimals_footgun() {
        assert_eq!(min_raw_floor(6), 1_000_000);
        assert_eq!(min_raw_floor(0), 1);

        // The intended floor at 6 decimals: 100,000 tokens in raw units.
        assert!(100_000_000_000u64 >= min_raw_floor(6), "the correct value is accepted");

        // The documented footgun: writing the whole-token figure would set the
        // floor to a tenth of a token, silently and forever. Refused.
        assert!(100_000u64 < min_raw_floor(6), "whole tokens are refused");

        // What the guard does NOT catch, and this is the honest limit of it: a
        // value that is wrong but still above one whole token. Only reading the
        // parameters aloud before `initialize` catches that (Phase 08).
        assert!(1_000_000_000u64 >= min_raw_floor(6), "1,000 tokens passes — wrong, but plausible");
    }
}
