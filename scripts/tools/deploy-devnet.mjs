#!/usr/bin/env node
//
// scripts/tools/deploy-devnet.mjs — a whole deployment, for the dry run.
//
// Builds the deployable binary, deploys it, creates a coin, runs `create_pool`
// and `initialize`, funds a stand-in creator vault, hands tokens to a small
// cast of wallets, and writes `epochs/devnet/deployment.json` — the manifest
// every other tool in the dry run reads its addresses from.
//
// Usage:
//   node scripts/tools/deploy-devnet.mjs --keypair <FUNDED_DEVNET_KEY>
//   ... --epoch-seconds 300 --challenge-seconds 60     # the dry run's clocks
//   ... --rpc https://api.devnet.solana.com
//   ... --skip-build                                   # reuse target/sbf-v3
//   ... --skip-deploy             # the program is already on this cluster
//   ... --snapshot-key <VAULT>    # a multisig vault instead of a fresh keypair
//   ... --initializer <PATH>      # when INITIALIZER is not the throwaway
//
// ⚠️ **Devnet only, and it checks.** `initialize` is signed by the throwaway
// `INITIALIZER` whose secret is committed in this repository, every argument it
// writes is immutable forever, and there is no admin path — a mainnet
// deployment initialized with 300-second epochs is a coin that pays every five
// minutes for the rest of its life. The cluster is verified by genesis hash
// before anything is sent.
//
// Two things the local-validator path does not have to handle:
//
//   * **The v3 bytecode.** agave refuses an SBPF v0 executable, so what gets
//     deployed is built into `target/sbf-v3/`, never `target/deploy/`.
//   * **No airdrops.** The devnet faucet is unreliable, so the payer must
//     already hold SOL. Everything else is funded from it by transfer.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { connect } from '../lib/rpc.mjs';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

import {
  DEFAULT_RPC_URL,
  MINT_DECIMALS,
  MIN_HOLD_RAW,
  MIN_HOLD_TOKENS,
  TOTAL_SUPPLY_TOKENS,
} from '../lib/config.mjs';
import {
  configPda,
  createPoolIx,
  epochIndexFor,
  fetchConfig,
  initializeIx,
  poolPda,
  PROGRAM_ID,
} from '../lib/program.mjs';
import { redactSecrets } from '../lib/alert.mjs';
import { REPO_ROOT } from '../lib/store.mjs';
import {
  assertNotMainnet,
  KEYS_DIR,
  loadKeypair,
  MANIFEST_PATH,
  readManifest,
  writeKeypair,
  writeManifest,
} from './devnet.mjs';
import { throwawayInitializer } from './initializer.mjs';

/**
 * The cast, and why each one is here.
 *
 * These are the four rows the website renders differently, so the rehearsal is
 * only worth running if all four exist. `mock-callouts.mjs` drives them by
 * name; the balances are what makes each role possible, not the role itself.
 */
const CAST = [
  { name: 'steady', tokens: 500_000n, role: 'calls out every epoch, never sells — the baseline earner' },
  { name: 'fader', tokens: 300_000n, role: 'calls out, then stops — proves a call does not carry over' },
  { name: 'dumper', tokens: 400_000n, role: 'calls out, then sells — hold collapses and the lockout fires' },
  { name: 'minnow', tokens: 50_000n, role: 'below the floor; calls out and earns nothing' },
];

const raw = (tokens) => tokens * 10n ** BigInt(MINT_DECIMALS);

function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    'epoch-seconds': '300',
    'challenge-seconds': '60',
    'vault-sol': '2',
    skipBuild: false,
    skipDeploy: false,
    stopAfterPool: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-build') args.skipBuild = true;
    else if (argv[i] === '--skip-deploy') args.skipDeploy = true;
    // Named explicitly — the generic branch would store it as `stop-after-pool`
    // and the flag would silently never fire.
    else if (argv[i] === '--stop-after-pool') args.stopAfterPool = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair) {
    throw new Error(
      '--keypair <PATH> is required: a funded devnet key that pays for the deployment. ' +
        'This tool never asks the faucet — it was returning errors on 2026-08-04 and a ' +
        'half-funded deploy is worse than none.',
    );
  }
  return {
    ...args,
    epochSeconds: Number(args['epoch-seconds']),
    challengeSeconds: Number(args['challenge-seconds']),
    vaultLamports: BigInt(Math.round(Number(args['vault-sol']) * LAMPORTS_PER_SOL)),
  };
}

function sh(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.solana/solana-release/bin:${process.env.PATH}`,
    },
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command} is not on PATH. The Solana tools live in ~/.solana/solana-release/bin ` +
        'on this machine and are not there by default.',
    );
  }
  if (result.status !== 0) {
    // Redacted, both halves. `--url` carries the provider key as a PATH
    // segment, so echoing the argv verbatim publishes it — and this message
    // lands in journald when the deploy runs under systemd, and in a terminal
    // scrollback either way. 16a6449 fixed the `cluster` line that printed it
    // on the happy path and left this one, which only fires on the bad day when
    // the output is most likely to be pasted into a chat.
    //
    // The child's own stderr goes through the same filter: `solana program
    // deploy` echoes the failing command back, key included.
    process.stderr.write(redactSecrets(result.stderr ?? ''));
    throw new Error(
      `${command} ${redactSecrets(commandArgs.join(' '))} exited ${result.status}`,
    );
  }
  return result.stdout ?? '';
}

async function send(connection, instructions, signers) {
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

/** Move SOL from the payer. Devnet has no working faucet, so this is the tap. */
async function fund(connection, payer, to, lamports) {
  return send(
    connection,
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Number(lamports),
      }),
    ],
    [payer],
  );
}

/**
 * What a re-run must not destroy.
 *
 * This tool rebuilds the manifest from scratch every time, which is right for
 * the values it owns and wrong for the ones it does not. Adopting a real coin
 * (`--mint`) means the cast was **bought before this ran** — that is the whole
 * point of the ordering the final devnet test settled on, because `initialize`
 * starts the clock and everything after it is an epoch that must settle.
 * `mk-pump-cast.mjs` owns `cast`; `scenario-driver --assign` owns
 * `scenarioAssignment`,
 * and says plainly that re-assigning mid-run would hand one row's history to a
 * different wallet.
 *
 * On 2026-08-09 the rebuild threw both away: sixty-four funded wallets holding
 * real coin, and eighteen assigned matrix rows, erased by the step that comes
 * *after* them. Nothing on chain was lost — the keypairs are on disk and the
 * tokens stayed where they were — but the file that knows what those wallets
 * ARE was, and the driver's next call failed with "no cast in the manifest".
 *
 * `cast` is carried only on the adopted path: on the synthetic path this tool
 * mints its own cast, and that one is authoritative.
 */
export function carryForward(previous, { adopted } = {}) {
  const carried = {};
  if (adopted && (previous?.cast ?? []).length > 0) carried.cast = previous.cast;
  if (previous?.scenarioAssignment) carried.scenarioAssignment = previous.scenarioAssignment;
  return carried;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);

  console.log('\nCALLPOOL — devnet deployment for the dry run\n');

  // Before anything is built, let alone sent.
  const genesisHash = await assertNotMainnet(connection, 'deploy-devnet.mjs');
  // Redacted: the provider key is a path segment, and this line lands in
  // journald when the deploy runs under systemd.
  console.log(`cluster   ${redactSecrets(args.rpc)}`);
  console.log(`genesis   ${genesisHash}`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`epochs    ${args.epochSeconds}s, challenge window ${args.challengeSeconds}s\n`);

  if (!Number.isInteger(args.epochSeconds) || args.epochSeconds <= 0) {
    throw new Error(`--epoch-seconds must be a positive integer, got ${args['epoch-seconds']}`);
  }

  const payer = loadKeypair(args.keypair);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`payer     ${payer.publicKey.toBase58()}  ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 4 * LAMPORTS_PER_SOL) {
    throw new Error(
      `the payer holds ${balance / LAMPORTS_PER_SOL} SOL. A program deploy plus the mint, ` +
        'the accounts and the stand-in vault needs about 4. Fund it and run this again — ' +
        'a deploy that runs out halfway leaves a buffer account to recover.',
    );
  }

  // `create_pool` and `initialize` each run exactly once per deployment, and
  // there is no undo. Saying so here beats a confusing on-chain failure later.
  const existingConfig = await connection.getAccountInfo(configPda());
  if (existingConfig) {
    const config = await fetchConfig(connection);
    console.log('\nThis program is ALREADY initialized on this cluster:\n');
    console.log(`  mint             ${config.mint.toBase58()}`);
    console.log(`  epoch_seconds    ${config.epochSeconds}`);
    console.log(`  challenge_seconds ${config.challengeSeconds}`);
    console.log(`  genesis_ts       ${new Date(config.genesisTs * 1000).toISOString()}`);
    console.log(`  snapshot_key     ${config.snapshotKey.toBase58()}`);
    console.log(
      '\n`initialize` writes every parameter once and has no admin path, so this cannot ' +
        'be re-run. To rehearse different clocks, deploy under a different program id ' +
        '(CALLPOOL_PROGRAM_ID) or use a fresh local validator.',
    );
    // If the manifest is still here the deployment is usable as it stands, and
    // the rest of the dry run can carry on.
    try {
      readManifest();
      console.log(`\n${MANIFEST_PATH} still describes it, so the dry run can continue.\n`);
      return;
    } catch {
      throw new Error(
        `the program is initialized but ${MANIFEST_PATH} is gone, so the snapshot key's ` +
          'secret is lost. Without it no root can ever be posted for this deployment.',
      );
    }
  }

  mkdirSync(KEYS_DIR, { recursive: true });

  // ── the binary ───────────────────────────────────────────────────────────
  if (!args.skipBuild) {
    console.log('\nbuilding the deployable artifact (SBPF v3)…');
    sh('cargo-build-sbf', [
      '--manifest-path', resolve(REPO_ROOT, 'programs/callpool/Cargo.toml'),
      '--arch', 'v3',
      '--sbf-out-dir', resolve(REPO_ROOT, 'target/sbf-v3'),
    ]);
  }

  const programKeypairPath = resolve(REPO_ROOT, 'target/deploy/callpool-keypair.json');
  const programKeypair = loadKeypair(programKeypairPath);
  if (!programKeypair.publicKey.equals(PROGRAM_ID)) {
    throw new Error(
      `${programKeypairPath} is ${programKeypair.publicKey.toBase58()}, but the scripts and ` +
        `declare_id! expect ${PROGRAM_ID.toBase58()}. Deploying would produce a program ` +
        'nothing else in this repository can address.',
    );
  }

  // Resuming a half-finished run. The public devnet endpoint rate-limits a
  // 235 KB upload hard enough that the deploy lands and the steps after it
  // 429 — at which point re-uploading costs another ~2 SOL and re-rolls the
  // same dice. `--skip-deploy` picks up from the coin instead.
  const deployed = await connection.getAccountInfo(PROGRAM_ID);
  if (args.skipDeploy && deployed?.executable) {
    console.log('skipping deploy — the program is already on this cluster\n');
  } else {
  // Which bytecode to upload.
  //
  // `target/sbf-v3/` exists because agave once refused an SBPF v0 executable.
  // It is not unconditionally right: the arch the *builder* emits has to be one
  // the *deployer's* loader accepts, and those are two different machines here —
  // the program is built on a workstation and deployed from a box, because
  // neither box has a Rust toolchain and the RPC key is IP-allowlisted to them.
  //
  // Measured 2026-08-07: cargo-build-sbf 4.1.0 on the workstation against
  // solana-cli 2.1.14 on box A gives `ELF error: Offset or value is out of
  // bounds` for the v3 build, while the default-arch build deploys cleanly. A
  // newer builder emits something an older loader cannot read, and the error
  // names neither version.
  //
  // So it is a flag with a default rather than a hardcoded path, and the failure
  // says what to try. Whichever is used, `declare_id!` is baked into both.
  const programSo = resolve(REPO_ROOT, args['program-so'] ?? 'target/sbf-v3/callpool.so');
  if (!existsSync(programSo)) {
    throw new Error(
      `${programSo} does not exist. Build it, or point --program-so at the one you have ` +
        '(target/deploy/callpool.so is the default-arch build).',
    );
  }
  console.log(`deploying… ${relative(REPO_ROOT, programSo)}`);
  try {
    sh('solana', [
      'program', 'deploy',
      programSo,
      '--program-id', programKeypairPath,
      '--keypair', resolve(args.keypair),
      '--url', args.rpc,
    ]);
  } catch (error) {
    if (/ELF error/i.test(error.message) || /ELF error/i.test(String(error))) {
      throw new Error(
        `${error.message}\n\n` +
          '  This is almost always a builder/loader version skew, not a broken program.\n' +
          `  The deploying host's loader cannot read the arch the build emitted.\n` +
          '  Try the other build:  --program-so target/deploy/callpool.so\n' +
          '  and compare `cargo-build-sbf --version` where it was built against\n' +
          '  `solana --version` where it is being deployed from.',
      );
    }
    throw error;
  }
  console.log('deployed\n');
  }

  // ── create_pool ──────────────────────────────────────────────────────────
  // Before the coin, not after, and that ordering is the whole reason the pool
  // is seeded on a CONSTANT rather than on the mint (§4.2): its address has to
  // exist so it can be named as a fee recipient at coin creation. A synthetic
  // mint does not care, but a real pump.fun coin is created *with* its
  // fee-sharing config (F6) and cannot name a pool that does not exist yet.
  //
  // Harmless to run first in either path: the pool is a bare lamport account
  // and fees accrue into it whether or not `initialize` has happened.
  const poolExists = await connection.getAccountInfo(poolPda());
  if (poolExists) {
    console.log(`pool      ${poolPda().toBase58()}   (already created)`);
  } else {
    await send(connection, [createPoolIx({ payer: payer.publicKey })], [payer]);
    console.log(`pool      ${poolPda().toBase58()}   created`);
  }

  // `--stop-after-pool` is how the real-coin path gets its turn. The pump coin
  // must be created between `create_pool` and `initialize`, because
  // `initialize` binds `config.mint` permanently and there is no second attempt:
  //
  //   1. deploy-devnet.mjs --stop-after-pool
  //   2. mk-pump-coin.mjs                       ← the real coin + fee split
  //   3. deploy-devnet.mjs --skip-build --skip-deploy --mint <MINT>
  if (args.stopAfterPool) {
    // Write the manifest before returning.
    //
    // Everything downstream — `mk-pump-coin`, `mk-pump-cast`, `pump-trade` —
    // opens `deployment.json` for its addresses, and this flag exists precisely
    // so the coin and its cast can be built **before** `initialize` starts the
    // clock. Returning without a manifest makes that order impossible on a
    // clean box: the next tool fails with "no devnet deployment", and the only
    // way to get one is to run the `initialize` this flag exists to defer.
    //
    // It went unnoticed through three runs because each inherited the previous
    // run's stale manifest, which had the right shape and the wrong addresses.
    // A genuinely fresh box is what surfaced it.
    //
    // No `mint`, no `genesisTs`, no `snapshotKey` — none of them exist yet, and
    // writing placeholders would be worse than omitting them.
    writeManifest({
      ...readManifest(MANIFEST_PATH, { optional: true }),
      cluster: args.rpc,
      genesisHash,
      deployedAt: new Date().toISOString(),
      programId: PROGRAM_ID.toBase58(),
      pool: poolPda().toBase58(),
      epochSeconds: args.epochSeconds,
      challengeSeconds: args.challengeSeconds,
      minHoldRaw: MIN_HOLD_RAW.toString(),
      payer: { address: payer.publicKey.toBase58(), keypair: resolve(args.keypair) },
      stoppedAfterPool: true,
    });

    console.log(
      '\n--stop-after-pool: the program is deployed and the pool exists.\n\n' +
        `wrote ${relative(REPO_ROOT, MANIFEST_PATH)} — the coin and the cast can be built now.\n\n` +
        'Next, create the coin and then finish the deployment against it:\n' +
        `  node scripts/tools/mk-pump-coin.mjs --keypair ${args.keypair} --rpc <RPC>\n` +
        '  node scripts/tools/deploy-devnet.mjs --skip-build --skip-deploy \\\n' +
        `    --keypair ${args.keypair} --mint <MINT> --snapshot-key <VAULT> …\n`,
    );
    return;
  }

  // ── the coin ─────────────────────────────────────────────────────────────
  // `--mint <ADDRESS>` adopts a coin that already exists — which on this
  // cluster means a real pump.fun coin from `mk-pump-coin.mjs`. Its supply
  // lives on the bonding curve and is bought, not minted, so the synthetic
  // cast is skipped entirely: there is no mint authority to hand tokens out
  // with, and pretending otherwise would produce balances no trade explains.
  const adopted = args.mint ? new PublicKey(args.mint) : null;
  const cast = [];

  let mint;
  if (adopted) {
    const info = await connection.getParsedAccountInfo(adopted);
    const parsed = info?.value?.data?.parsed;
    if (!parsed || parsed.type !== 'mint') {
      throw new Error(`--mint ${args.mint} is not a mint account on this cluster.`);
    }
    if (parsed.info.decimals !== MINT_DECIMALS) {
      throw new Error(
        `--mint ${args.mint} has ${parsed.info.decimals} decimals but config.mjs assumes ` +
          `${MINT_DECIMALS}. The floor is derived from that constant, so initialize would ` +
          'write a floor wrong by orders of magnitude — permanently.',
      );
    }
    mint = adopted;
    console.log(`mint      ${mint.toBase58()}   (adopted — real coin, supply on its curve)`);
    console.log('cast      skipped: tokens are bought from the curve, not minted');
  } else {
    // The mint authority is kept rather than revoked: this is a rehearsal, and
    // being able to top a wallet up is worth more here than matching pump.fun's
    // post-launch authority state, which nothing in this system reads.
    mint = await createMint(connection, payer, payer.publicKey, null, MINT_DECIMALS);
    console.log(`mint      ${mint.toBase58()}   (synthetic)`);

    let distributed = 0n;
    for (const member of CAST) {
      const wallet = Keypair.generate();
      const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, wallet.publicKey))
        .address;
      await mintTo(connection, payer, mint, ata, payer, raw(member.tokens));
      distributed += member.tokens;

      // A little SOL each: signing their own sale costs a fee, and a wallet that
      // cannot sell cannot rehearse the lockout.
      await fund(connection, payer, wallet.publicKey, BigInt(0.01 * LAMPORTS_PER_SOL));

      const keypairPath = writeKeypair(resolve(KEYS_DIR, `${member.name}.json`), wallet);
      cast.push({
        name: member.name,
        role: member.role,
        address: wallet.publicKey.toBase58(),
        tokenAccount: ata.toBase58(),
        tokens: member.tokens.toString(),
        aboveFloor: member.tokens >= MIN_HOLD_TOKENS,
        keypair: keypairPath,
      });
      console.log(
        `  ${member.name.padEnd(8)} ${wallet.publicKey.toBase58()}  ` +
          `${member.tokens.toLocaleString('en-US')} tokens` +
          `${member.tokens >= MIN_HOLD_TOKENS ? '' : '  (below the floor, on purpose)'}`,
      );
    }

    // The rest of the supply, so the mint's totals match config.mjs rather than
    // only the part handed out.
    const treasury = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey))
      .address;
    await mintTo(connection, payer, mint, treasury, payer, raw(TOTAL_SUPPLY_TOKENS - distributed));
  }

  // ── initialize ───────────────────────────────────────────────────────────

  // `--initializer <PATH>` for a build whose INITIALIZER constant is not the
  // committed throwaway — which is every deployment build, and is what the
  // launch rehearsal exercises. Defaults to the throwaway so the ordinary
  // devnet path is unchanged.
  const initializer = args.initializer
    ? loadKeypair(args.initializer)
    : throwawayInitializer();
  console.log(`initializer ${initializer.publicKey.toBase58()}${args.initializer ? '' : '   (committed throwaway)'}`);
  await fund(connection, payer, initializer.publicKey, BigInt(0.05 * LAMPORTS_PER_SOL));

  // `--snapshot-key <ADDRESS>` binds the config to an address we do not hold —
  // a Squads vault, which is what mainnet does (§5.5a). The rehearsal then has
  // no snapshot keypair at all, and `post-root.mjs` can only go through
  // `cosign.mjs`, which is precisely the path worth proving before launch.
  const externalSnapshotKey = args['snapshot-key']
    ? new PublicKey(args['snapshot-key'])
    : null;

  const snapshotKey = externalSnapshotKey ? null : Keypair.generate();
  const snapshotKeyPath = snapshotKey
    ? writeKeypair(resolve(KEYS_DIR, 'snapshot-key.json'), snapshotKey)
    : null;
  const snapshotKeyAddress = externalSnapshotKey ?? snapshotKey.publicKey;
  if (snapshotKey) {
    await fund(connection, payer, snapshotKey.publicKey, BigInt(0.5 * LAMPORTS_PER_SOL));
  }

  const slot = await connection.getSlot('confirmed');
  const chainNow = await connection.getBlockTime(slot);
  // The NEXT boundary, not the current one.
  //
  // Flooring put genesis in the past, which meant epoch 0 always began before
  // `initialize` ran. Nothing polled the callout feed for that window, so epoch
  // 0 had no inputs and could never be settled (F20) — and because the carry
  // chain refuses to skip a predecessor, **epoch 1 then could not settle
  // either** without a manual `--carry-reset`. Measured on 2026-08-07: even
  // starting deliberately on a clean 5-minute boundary hits this, because
  // `initialize` cannot land at the same instant as the boundary it names.
  //
  // On a daily clock that is launch day: the first crank fails, the first
  // settlement needs a human, and the runbook does not mention it.
  //
  // Ceiling instead costs up to one epoch of waiting before epoch 0 opens, and
  // buys an epoch 0 that has inputs, settles normally, and starts the carry
  // chain where it should start. `initialize` accepts a genesis up to one whole
  // epoch either side of now, so this is inside what the program allows.
  const genesisTs = Math.ceil(chainNow / args.epochSeconds) * args.epochSeconds;

  await send(
    connection,
    [
      initializeIx({
        payer: initializer.publicKey,
        mint,
        genesisTs,
        epochSeconds: args.epochSeconds,
        minHold: MIN_HOLD_RAW,
        challengeSeconds: args.challengeSeconds,
        snapshotKey: snapshotKeyAddress,
      }),
    ],
    [initializer],
  );

  const config = await fetchConfig(connection);
  if (config.minHold !== MIN_HOLD_RAW) {
    throw new Error(
      `the on-chain floor is ${config.minHold} but config.mjs says ${MIN_HOLD_RAW}. ` +
        'That is devnet proof 20 failing at the only moment it can be fixed.',
    );
  }

  // ── the stand-in creator vault ───────────────────────────────────────────
  // There is no pump.fun creator vault on devnet, so fees accrue in a plain
  // account the loop sweeps into the pool. It is a stand-in for the sweep, and
  // it proves nothing about pump.fun's instruction layouts — devnet proofs 1, 3
  // and 12b are still the only things that do.
  const vault = Keypair.generate();
  const vaultPath = writeKeypair(resolve(KEYS_DIR, 'creator-vault.json'), vault);
  await fund(connection, payer, vault.publicKey, args.vaultLamports);

  const startEpoch = epochIndexFor(
    Math.ceil((chainNow + 1) / args.epochSeconds) * args.epochSeconds,
    config,
  );

  // What other tools have already written into the manifest, and which this one
  // has no business discarding.
  const carried = carryForward(readManifest(MANIFEST_PATH, { optional: true }), { adopted: Boolean(adopted) });

  const manifest = {
    cluster: args.rpc,
    genesisHash,
    deployedAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    pool: poolPda().toBase58(),
    genesisTs,
    epochSeconds: args.epochSeconds,
    challengeSeconds: args.challengeSeconds,
    minHoldRaw: MIN_HOLD_RAW.toString(),
    // The first epoch that starts after this deployment existed. Earlier ones
    // are windows nobody could have called out in, so the loop starts here.
    startEpoch,
    payer: { address: payer.publicKey.toBase58(), keypair: resolve(args.keypair) },
    snapshotKey: { address: snapshotKeyAddress.toBase58(), keypair: snapshotKeyPath },
    creatorVault: { address: vault.publicKey.toBase58(), keypair: vaultPath },
    cast,
    ...carried,
  };
  writeManifest(manifest);

  if (carried.cast) {
    console.log(`cast      ${carried.cast.length} wallet(s) carried forward from the existing manifest`);
  }
  if (carried.scenarioAssignment) {
    console.log(
      `scenarios ${Object.keys(carried.scenarioAssignment).length} matrix row(s) carried forward`,
    );
  }

  console.log(`\npool      ${poolPda().toBase58()}`);
  console.log(`vault     ${vault.publicKey.toBase58()}  (stand-in for pump.fun's creator vault)`);
  console.log(`snapshot  ${snapshotKeyAddress.toBase58()}${snapshotKeyPath ? '' : '   (external — a multisig vault; no keypair here)'}`);
  console.log(`genesis   ${new Date(genesisTs * 1000).toISOString()}`);
  console.log(`epoch 0   started ${chainNow - genesisTs}s ago; the loop starts at epoch ${startEpoch}`);
  console.log(`\nwrote ${MANIFEST_PATH}`);
  console.log(`keys in ${KEYS_DIR} — worthless, and gitignored\n`);

  console.log('─'.repeat(72));
  console.log('Paste into site/config.local.js, under devnet:\n');
  // NOT `args.rpc`. `config.local.js` is fetched by every visitor, and a
  // provider URL carries its key in the path — pasting it here would publish
  // the key to every browser that loads the page, which is the exact failure
  // `scripts/lib/rpc-proxy.mjs` exists to prevent. The page calls a
  // same-origin path and `serve-site.mjs` forwards it using the URL in
  // CALLPOOL_RPC_URL_DEVNET, which stays on the server.
  console.log(`    rpc: '/rpc/devnet',`);
  console.log(`    mint: '${mint.toBase58()}',`);
  console.log(`    programId: '${PROGRAM_ID.toBase58()}',`);
  console.log(`    snapshotsBase: '/epochs/devnet/snapshots',`);
  console.log(`    creatorVault: '${vault.publicKey.toBase58()}',`);
  console.log(`    calloutApiKey: '',   // unset on purpose — see DEVNET-DRY-RUN.md`);
  console.log(`    feeShareTx: '',      // no fee-share transaction exists on devnet`);
  console.log('─'.repeat(72));
  console.log('\nNext:  node scripts/tools/dry-run-loop.mjs\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nDEPLOY FAILED: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
