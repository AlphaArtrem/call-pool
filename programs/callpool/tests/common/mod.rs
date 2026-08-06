//! Shared harness for the litesvm tests.
//!
//! Everything runs in-process against the real compiled program, so
//! `cargo build-sbf` must have produced `target/deploy/callpool.so` first.
//! `scripts/verify.sh` does both in the right order.

#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_instruction},
    system_program, AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use callpool::{Config, Epoch, CONFIG_SEED, EPOCH_SEED, POOL_SEED};

pub mod spl;
pub use spl::associated_token_address as ata;

/// The secret whose public key is `callpool::INITIALIZER`.
///
/// Committed on purpose: `INITIALIZER` is a compile-time constant, so the tests
/// can only exercise it by holding the matching secret. This key is a throwaway
/// that has never held anything and never will — and the constant it matches is
/// itself a placeholder that must be replaced before the program is built for
/// deployment.
pub const INITIALIZER_SECRET: [u8; 64] = [
    105, 226, 63, 116, 234, 125, 73, 176, 142, 175, 21, 4, 37, 144, 68, 157, 19, 254, 112, 218,
    200, 131, 244, 246, 45, 30, 170, 84, 102, 21, 191, 203, 18, 241, 34, 32, 212, 91, 58, 68, 178,
    182, 84, 60, 199, 200, 246, 191, 222, 107, 123, 158, 185, 188, 33, 12, 117, 253, 203, 167, 26,
    112, 34, 0,
];

/// The keypair matching the program's `INITIALIZER` constant.
///
/// **`CALLPOOL_TEST_INITIALIZER=<path-to-keypair.json>` overrides it**, and a
/// deployment build needs that. `INITIALIZER` is a compile-time constant, so
/// replacing it for launch — which is mandatory — makes every fixture here fail
/// at `initialize`, and `verify.sh` runs these tests. The alternative would be
/// committing the launch secret to fix the tests, which is obviously worse than
/// the problem.
///
/// So the real key stays in a file the build machine already has (it has to
/// sign `initialize` anyway) and never enters the repository. Without the
/// variable this is the committed throwaway, which is what every ordinary run
/// and every CI run uses.
pub fn initializer_keypair() -> Keypair {
    match std::env::var("CALLPOOL_TEST_INITIALIZER") {
        Ok(path) => {
            let bytes: Vec<u8> = serde_json::from_str(
                &std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("CALLPOOL_TEST_INITIALIZER={path}: {e}")),
            )
            .unwrap_or_else(|e| panic!("CALLPOOL_TEST_INITIALIZER={path} is not a keypair: {e}"));
            Keypair::try_from(&bytes[..])
                .unwrap_or_else(|e| panic!("CALLPOOL_TEST_INITIALIZER={path}: {e}"))
        }
        Err(_) => Keypair::try_from(&INITIALIZER_SECRET[..]).unwrap(),
    }
}

pub const DECIMALS: u8 = 6;
/// 100,000 tokens at 6 decimals — the floor, in raw units (L4/L12).
pub const MIN_HOLD: u64 = 100_000 * 1_000_000;
pub const EPOCH_SECONDS: u32 = 86_400;
pub const CHALLENGE_SECONDS: u32 = 86_400;
/// One billion tokens at 6 decimals — a pump.fun mint's whole supply, minted at
/// creation. `min_hold` above this would mean nobody can ever be eligible.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
/// A UTC midnight, so the on-chain epoch index and a UTC calendar day agree.
pub const GENESIS_TS: i64 = 1_785_801_600;

pub struct Fixture {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub initializer: Keypair,
    pub snapshot: Keypair,
    pub mint: Keypair,
    pub config: Pubkey,
    pub pool: Pubkey,
}

impl Fixture {
    /// A booted program with a mint, a created pool and a config. Nothing is
    /// funded into the pool yet — each test decides that.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            callpool::ID,
            include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/callpool.so")),
        )
        .unwrap();

        let payer = Keypair::new();
        let initializer = initializer_keypair();
        let snapshot = Keypair::new();
        let mint = Keypair::new();

        for key in [&payer, &initializer, &snapshot] {
            svm.airdrop(&key.pubkey(), 1_000 * 1_000_000_000).unwrap();
        }
        set_clock(&mut svm, GENESIS_TS);

        let config = Pubkey::find_program_address(&[CONFIG_SEED], &callpool::ID).0;
        let pool = Pubkey::find_program_address(&[POOL_SEED], &callpool::ID).0;

        let mut fixture = Self {
            svm,
            payer,
            initializer,
            snapshot,
            mint,
            config,
            pool,
        };
        fixture.create_mint();
        fixture.create_pool().unwrap();
        fixture.initialize(MIN_HOLD).unwrap();
        fixture
    }

    /// The same, minus `initialize` — for the tests that need an unbound program.
    pub fn uninitialized() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            callpool::ID,
            include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/callpool.so")),
        )
        .unwrap();

        let payer = Keypair::new();
        let initializer = initializer_keypair();
        let snapshot = Keypair::new();
        let mint = Keypair::new();
        for key in [&payer, &initializer, &snapshot] {
            svm.airdrop(&key.pubkey(), 1_000 * 1_000_000_000).unwrap();
        }
        set_clock(&mut svm, GENESIS_TS);

        let config = Pubkey::find_program_address(&[CONFIG_SEED], &callpool::ID).0;
        let pool = Pubkey::find_program_address(&[POOL_SEED], &callpool::ID).0;
        let mut fixture = Self {
            svm,
            payer,
            initializer,
            snapshot,
            mint,
            config,
            pool,
        };
        fixture.create_mint();
        fixture
    }

    // ── transactions ───────────────────────────────────────────────────────

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        // A fresh blockhash for every send. Several tests deliberately retry an
        // instruction that just failed, and without this the retry has an
        // identical signature and is rejected as already processed — which
        // would look exactly like the program refusing it.
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    fn create_mint(&mut self) {
        let rent = self.svm.minimum_balance_for_rent_exemption(spl::MINT_LEN);
        let create = system_instruction::create_account(
            &self.payer.pubkey(),
            &self.mint.pubkey(),
            rent,
            spl::MINT_LEN as u64,
            &spl::token_program_id(),
        );
        let init = spl::initialize_mint2(&self.mint.pubkey(), &self.payer.pubkey(), DECIMALS);
        let mint = self.mint.insecure_clone();
        let payer = self.payer.insecure_clone();
        self.send(&[create, init], &[&payer, &mint]).unwrap();

        // A pump.fun mint is fully minted at creation, so by the time anyone can
        // call `initialize` the supply is real. The fixture used to leave it at
        // zero, which made `initialize` see a state that cannot occur on the
        // chain this program is written for — and left `min_hold > supply`
        // untestable. Held by the payer; no test reads its balance.
        let treasury = ata(&payer.pubkey(), &self.mint.pubkey());
        let create_ata =
            spl::create_associated_token_account(&payer.pubkey(), &payer.pubkey(), &self.mint.pubkey());
        let mint_to =
            spl::mint_to(&self.mint.pubkey(), &treasury, &payer.pubkey(), TOTAL_SUPPLY);
        self.send(&[create_ata, mint_to], &[&payer]).unwrap();
    }

    pub fn create_pool(&mut self) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let ix = Instruction::new_with_bytes(
            callpool::ID,
            &callpool::instruction::CreatePool {}.data(),
            callpool::accounts::CreatePool {
                payer: payer.pubkey(),
                pool: self.pool,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[&payer])
    }

    pub fn initialize(&mut self, min_hold: u64) -> TransactionResult {
        self.initialize_as(&self.initializer.insecure_clone(), min_hold, GENESIS_TS)
    }

    pub fn initialize_as(
        &mut self,
        payer: &Keypair,
        min_hold: u64,
        genesis_ts: i64,
    ) -> TransactionResult {
        self.initialize_full(payer, min_hold, genesis_ts, EPOCH_SECONDS, CHALLENGE_SECONDS)
    }

    /// Every immutable parameter, spelled out — for the tests that exist to
    /// check what `initialize` refuses to make permanent.
    pub fn initialize_full(
        &mut self,
        payer: &Keypair,
        min_hold: u64,
        genesis_ts: i64,
        epoch_seconds: u32,
        challenge_seconds: u32,
    ) -> TransactionResult {
        let ix = Instruction::new_with_bytes(
            callpool::ID,
            &callpool::instruction::Initialize {
                genesis_ts,
                epoch_seconds,
                min_hold,
                challenge_seconds,
                snapshot_key: self.snapshot.pubkey(),
            }
            .data(),
            callpool::accounts::Initialize {
                payer: payer.pubkey(),
                config: self.config,
                pool: self.pool,
                mint: self.mint.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[payer])
    }

    pub fn post_root(
        &mut self,
        epoch: u64,
        root: [u8; 32],
        leaf_count: u32,
        allocate: u64,
    ) -> TransactionResult {
        self.post_root_as(&self.snapshot.insecure_clone(), epoch, root, leaf_count, allocate)
    }

    pub fn post_root_as(
        &mut self,
        signer: &Keypair,
        epoch: u64,
        root: [u8; 32],
        leaf_count: u32,
        allocate: u64,
    ) -> TransactionResult {
        let ix = Instruction::new_with_bytes(
            callpool::ID,
            &callpool::instruction::PostEpochRoot {
                epoch,
                root,
                leaf_count,
                allocate,
            }
            .data(),
            callpool::accounts::PostEpochRoot {
                snapshot_key: signer.pubkey(),
                config: self.config,
                pool: self.pool,
                epoch_account: self.epoch_pda(epoch),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[signer])
    }

    /// Submit a claim. `recipient` is the address named in the leaf; the
    /// submitter is always someone else, which is the point of L8.
    pub fn claim(
        &mut self,
        epoch: u64,
        index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
        recipient: Pubkey,
    ) -> TransactionResult {
        self.claim_with_token_account(
            epoch,
            index,
            amount,
            proof,
            recipient,
            ata(&recipient, &self.mint.pubkey()),
        )
    }

    pub fn claim_with_token_account(
        &mut self,
        epoch: u64,
        index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
        recipient: Pubkey,
        token_account: Pubkey,
    ) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let ix = Instruction::new_with_bytes(
            callpool::ID,
            &callpool::instruction::Claim {
                epoch,
                index,
                amount,
                proof,
            }
            .data(),
            callpool::accounts::Claim {
                submitter: payer.pubkey(),
                config: self.config,
                pool: self.pool,
                epoch_account: self.epoch_pda(epoch),
                recipient,
                mint: self.mint.pubkey(),
                recipient_token_account: token_account,
                token_program: spl::token_program_id(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[&payer])
    }

    pub fn close_epoch(&mut self, epoch: u64) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        let ix = Instruction::new_with_bytes(
            callpool::ID,
            &callpool::instruction::CloseEpoch { epoch }.data(),
            callpool::accounts::CloseEpoch {
                caller: payer.pubkey(),
                config: self.config,
                epoch_account: self.epoch_pda(epoch),
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[&payer])
    }

    // ── helpers ────────────────────────────────────────────────────────────

    pub fn epoch_pda(&self, epoch: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[EPOCH_SEED, self.mint.pubkey().as_ref(), &epoch.to_le_bytes()],
            &callpool::ID,
        )
        .0
    }

    /// A wallet holding `tokens` raw units in its ATA, ready to be paid.
    pub fn holder(&mut self, tokens: u64) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
        self.give_tokens(&wallet.pubkey(), tokens);
        wallet
    }

    pub fn give_tokens(&mut self, owner: &Pubkey, tokens: u64) {
        let payer = self.payer.insecure_clone();
        let create = spl::create_associated_token_account(&payer.pubkey(), owner, &self.mint.pubkey());
        let mint_to = spl::mint_to(
            &self.mint.pubkey(),
            &ata(owner, &self.mint.pubkey()),
            &payer.pubkey(),
            tokens,
        );
        if tokens == 0 {
            self.send(&[create], &[&payer]).unwrap();
        } else {
            self.send(&[create, mint_to], &[&payer]).unwrap();
        }
    }

    /// Drop lamports into the pool, standing in for a pump.fun fee sweep.
    pub fn fund_pool(&mut self, lamports: u64) {
        self.svm.airdrop(&self.pool, lamports).unwrap();
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        set_clock(&mut self.svm, unix_timestamp);
    }

    /// Move to a point safely inside epoch `epoch + 1`, so `epoch` can be posted.
    pub fn advance_past_epoch(&mut self, epoch: u64) {
        self.set_time(GENESIS_TS + (epoch as i64 + 1) * EPOCH_SECONDS as i64 + 1);
    }

    pub fn config_state(&self) -> Config {
        let account = self.svm.get_account(&self.config).unwrap();
        Config::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn epoch_state(&self, epoch: u64) -> Epoch {
        let account = self.svm.get_account(&self.epoch_pda(epoch)).unwrap();
        Epoch::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn pool_lamports(&self) -> u64 {
        self.svm.get_balance(&self.pool).unwrap_or(0)
    }

    pub fn rent_minimum(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(0)
    }

    /// The three §4.6 invariants, checked as a set.
    ///
    /// `open_epochs` is every epoch index posted so far; the caller tracks it
    /// because the program has no way to enumerate them.
    pub fn assert_invariants(&self, posted: &[u64], context: &str) {
        let config = self.config_state();

        assert!(
            self.pool_lamports() >= config.outstanding + self.rent_minimum(),
            "{context}: invariant 1 — pool {} < outstanding {} + rent {}",
            self.pool_lamports(),
            config.outstanding,
            self.rent_minimum(),
        );

        let mut sum_open = 0u64;
        for epoch in posted {
            let e = self.epoch_state(*epoch);
            assert!(
                e.claimed_lamports <= e.pool_lamports,
                "{context}: invariant 3 — epoch {epoch} claimed {} > allocated {}",
                e.claimed_lamports,
                e.pool_lamports,
            );
            if !e.closed {
                sum_open += e.pool_lamports - e.claimed_lamports;
            }
        }
        assert_eq!(
            config.outstanding, sum_open,
            "{context}: invariant 2 — outstanding does not match the open epochs",
        );
    }
}

pub fn set_clock(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: anchor_lang::solana_program::clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

// ── merkle, builder side ───────────────────────────────────────────────────
// Deliberately a *separate* implementation from `callpool::merkle`, which only
// verifies. Both are pinned to `tests/vectors.json`, so a bug would have to be
// made identically in three places to go unnoticed (D6).

pub fn build_tree(payouts: &[(Pubkey, u64)], epoch: u64) -> (Vec<[u8; 32]>, Vec<Vec<[u8; 32]>>) {
    let mut sorted = payouts.to_vec();
    sorted.sort_by_key(|(owner, _)| owner.to_bytes());

    let leaves: Vec<[u8; 32]> = sorted
        .iter()
        .enumerate()
        .map(|(i, (owner, amount))| callpool::merkle::leaf_hash(i as u32, owner, epoch, *amount))
        .collect();

    let mut levels = vec![leaves.clone()];
    while levels.last().unwrap().len() > 1 {
        let level = levels.last().unwrap();
        let mut next = Vec::new();
        let mut i = 0;
        while i + 1 < level.len() {
            next.push(callpool::merkle::node_hash(&level[i], &level[i + 1]));
            i += 2;
        }
        if i < level.len() {
            next.push(level[i]); // promoted unchanged (D6)
        }
        levels.push(next);
    }
    (leaves, levels)
}

pub fn root_of(levels: &[Vec<[u8; 32]>]) -> [u8; 32] {
    levels
        .last()
        .and_then(|l| l.first().copied())
        .unwrap_or([0u8; 32])
}

pub fn proof_for(levels: &[Vec<[u8; 32]>], mut index: usize) -> Vec<[u8; 32]> {
    let mut proof = Vec::new();
    for level in &levels[..levels.len().saturating_sub(1)] {
        let sibling = if index % 2 == 0 { index + 1 } else { index - 1 };
        if sibling < level.len() {
            proof.push(level[sibling]);
        }
        index /= 2;
    }
    proof
}

/// Canonical leaf order: sorted by owner, index assigned in that order.
pub fn canonical(payouts: &[(Pubkey, u64)]) -> Vec<(Pubkey, u64)> {
    let mut sorted = payouts.to_vec();
    sorted.sort_by_key(|(owner, _)| owner.to_bytes());
    sorted
}
