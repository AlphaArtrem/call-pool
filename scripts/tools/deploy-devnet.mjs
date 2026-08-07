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
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

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
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-build') args.skipBuild = true;
    else if (argv[i] === '--skip-deploy') args.skipDeploy = true;
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
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}`);
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
  console.log('deploying…');
  sh('solana', [
    'program', 'deploy',
    resolve(REPO_ROOT, 'target/sbf-v3/callpool.so'),
    '--program-id', programKeypairPath,
    '--keypair', resolve(args.keypair),
    '--url', args.rpc,
  ]);
  console.log('deployed\n');
  }

  // ── the coin ─────────────────────────────────────────────────────────────
  // The mint authority is kept rather than revoked: this is a rehearsal, and
  // being able to top a wallet up is worth more here than matching pump.fun's
  // post-launch authority state, which nothing in this system reads.
  const mint = await createMint(connection, payer, payer.publicKey, null, MINT_DECIMALS);
  console.log(`mint      ${mint.toBase58()}`);

  const cast = [];
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

  // ── create_pool + initialize ─────────────────────────────────────────────
  await send(connection, [createPoolIx({ payer: payer.publicKey })], [payer]);

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
  const genesisTs = Math.floor(chainNow / args.epochSeconds) * args.epochSeconds;

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
  };
  writeManifest(manifest);

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
