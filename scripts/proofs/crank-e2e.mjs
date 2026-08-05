#!/usr/bin/env node
//
// Phase 06 proof 13 — a full epoch, end to end, against a live chain.
//
// Deploys the program, creates the pool, binds a coin, gives two wallets
// tokens, feeds a fixture callout file, and then runs the **real crank
// scripts** — snapshot, verify-epoch, post-root, airdrop — as separate
// processes, exactly as a scheduler would.
//
//   "Two holders, one calls and holds, one calls and dumps; the crank builds
//    the root from a fixture callout file; assert the dumper's payout is zero
//    and the holder is airdropped without doing anything."
//
// The callouts come from a **fixture**, not the live API, so a pump.fun outage
// never blocks the test suite. The live feed is proven separately (Phase 02
// §2.5).
//
// Epochs here are 60 seconds rather than a day. That is not a shortcut around
// the rule — `initialize` still refuses a genesis that is not aligned to an
// epoch boundary — it is the only way to watch a full settle-and-pay cycle
// without waiting a calendar day, and it exercises the same code paths.
//
// Usage:
//   solana-test-validator --reset          # in another terminal
//   node scripts/proofs/crank-e2e.mjs --rpc http://127.0.0.1:8899

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { connect } from '../lib/rpc.mjs';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from '@solana/spl-token';

import { MINT_DECIMALS, MIN_HOLD_RAW } from '../lib/config.mjs';
import {
  createPoolIx,
  fetchConfig,
  fetchEpoch,
  initializeIx,
  poolPda,
  PROGRAM_ID,
  windowForEpoch,
} from '../lib/program.mjs';
import { REPO_ROOT, snapshotDir, STORE_PATH, writeStore } from '../lib/store.mjs';

const EPOCH_SECONDS = 60;
const CHALLENGE_SECONDS = 5;
const TOKENS = (n) => BigInt(n) * 10n ** BigInt(MINT_DECIMALS);

/** Public key `2Gwbg…QWtf`, the placeholder INITIALIZER baked into the binary. */
const INITIALIZER_SECRET = Uint8Array.from([
  105, 226, 63, 116, 234, 125, 73, 176, 142, 175, 21, 4, 37, 144, 68, 157, 19, 254, 112, 218, 200,
  131, 244, 246, 45, 30, 170, 84, 102, 21, 191, 203, 18, 241, 34, 32, 212, 91, 58, 68, 178, 182, 84,
  60, 199, 200, 246, 191, 222, 107, 123, 158, 185, 188, 33, 12, 117, 253, 203, 167, 26, 112, 34, 0,
]);

const results = [];
let failures = 0;

function check(what, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  results.push({ what, actual: String(actual), expected: String(expected), ok });
  console.log(
    `  ${ok ? '✔' : '✘'} ${what.padEnd(56)}${String(actual).padStart(18)}` +
      (ok ? '' : `  expected ${expected}`),
  );
}

function sh(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${process.env.HOME}/.solana/solana-release/bin:${process.env.PATH}` },
  });
  if (!quiet) process.stdout.write(result.stdout ?? '');
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout ?? '';
}

const crank = (script, args) => sh('node', [resolve(REPO_ROOT, 'scripts', script), ...args]);

async function waitUntil(connection, target) {
  for (;;) {
    const slot = await connection.getSlot('confirmed');
    const now = await connection.getBlockTime(slot);
    if (now != null && now >= target) return now;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const rpcIndex = argv.indexOf('--rpc');
  const rpc = rpcIndex === -1 ? 'http://127.0.0.1:8899' : argv[rpcIndex + 1];
  const connection = connect(rpc);

  console.log('\nCALLPOOL — proof 13, the crank end to end');
  console.log(`cluster   ${rpc}`);
  console.log(`program   ${PROGRAM_ID.toBase58()}\n`);

  // ── deploy ───────────────────────────────────────────────────────────────
  // The payer is deterministic so that it is also the program's upgrade
  // authority on every run: a fresh keypair each time would make the second
  // run fail to redeploy. Worthless key, local validator only.
  const payer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const initializer = Keypair.fromSecretKey(INITIALIZER_SECRET);
  const snapshotKey = Keypair.generate();

  for (const key of [payer, initializer, snapshotKey]) {
    const signature = await connection.requestAirdrop(key.publicKey, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) });
  }

  // ⚠️ Two bytecode targets, from one source. agave 4.1's runtime refuses an
  // SBPF v0 executable ("sbpf_version required by the executable ... not
  // enabled"), while litesvm 0.10 refuses a v3 one. So the in-process suite
  // runs v0 and anything actually deployed is v3, built here into its own
  // directory so the two can never be confused. Same Rust, different codegen —
  // and a real reason the on-chain proofs are not redundant with the fast ones.
  const deployKey = resolve(REPO_ROOT, 'target/deploy/callpool-keypair.json');
  const payerPath = resolve(REPO_ROOT, 'target/deploy/e2e-payer.json');
  writeFileSync(payerPath, JSON.stringify([...payer.secretKey]));

  console.log('building the deployable artifact (SBPF v3)…');
  sh('cargo-build-sbf', [
    '--manifest-path', resolve(REPO_ROOT, 'programs/callpool/Cargo.toml'),
    '--arch', 'v3',
    '--sbf-out-dir', resolve(REPO_ROOT, 'target/sbf-v3'),
  ], { quiet: true });

  sh('solana', [
    'program', 'deploy',
    resolve(REPO_ROOT, 'target/sbf-v3/callpool.so'),
    '--program-id', deployKey,
    '--keypair', payerPath,
    '--url', rpc,
  ], { quiet: true });
  console.log('deployed\n');

  // ── the coin, and the two holders ────────────────────────────────────────
  const mint = await createMint(connection, payer, payer.publicKey, null, MINT_DECIMALS);
  const holder = Keypair.generate(); // calls out and holds
  const dumper = Keypair.generate(); // calls out and sells
  const sink = Keypair.generate();

  const ataFor = async (owner) =>
    (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner.publicKey)).address;
  const holderAta = await ataFor(holder);
  const dumperAta = await ataFor(dumper);
  const sinkAta = await ataFor(sink);

  await mintTo(connection, payer, mint, holderAta, payer, TOKENS(500_000));
  await mintTo(connection, payer, mint, dumperAta, payer, TOKENS(500_000));

  // ── create_pool + initialize ─────────────────────────────────────────────
  // Both run exactly once per deployment, by design — there is no re-initialize
  // and no set_params. So this rehearsal needs a fresh ledger, and saying so
  // beats a confusing PoolAlreadyExists three steps later.
  if (await connection.getAccountInfo(poolPda())) {
    throw new Error(
      'the pool already exists on this cluster — `initialize` runs once and there is ' +
        'no way to undo it. Restart the validator with `solana-test-validator --reset` ' +
        'and run this again.',
    );
  }

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(createPoolIx({ payer: payer.publicKey })),
    [payer],
  );

  const slot = await connection.getSlot('confirmed');
  const chainNow = await connection.getBlockTime(slot);
  const genesisTs = Math.floor(chainNow / EPOCH_SECONDS) * EPOCH_SECONDS;

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      initializeIx({
        payer: initializer.publicKey,
        mint,
        genesisTs,
        epochSeconds: EPOCH_SECONDS,
        minHold: MIN_HOLD_RAW,
        challengeSeconds: CHALLENGE_SECONDS,
        snapshotKey: snapshotKey.publicKey,
      }),
    ),
    [initializer],
  );

  const config = await fetchConfig(connection);
  check('min_hold on chain is the raw-unit floor', config.minHold, MIN_HOLD_RAW);
  check('genesis is aligned to an epoch boundary', genesisTs % EPOCH_SECONDS, 0);
  console.log(`\nmint      ${mint.toBase58()}`);
  console.log(`pool      ${poolPda().toBase58()}`);
  console.log(`genesis   ${new Date(genesisTs * 1000).toISOString()} (${EPOCH_SECONDS}s epochs)\n`);

  // Creator fees, standing in for a pump.fun sweep.
  const fundSig = await connection.requestAirdrop(poolPda(), 9 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: fundSig, ...(await connection.getLatestBlockhash()) });

  // ── settle epoch 1, during which both wallets held from the first instant ──
  const target = windowForEpoch(config, 1);
  console.log(`waiting for epoch 1 to open (${new Date(target.start * 1000).toISOString()})…`);
  await waitUntil(connection, target.start + 2);

  // Mid-epoch, the dumper sells. `hold` must collapse to the trough, and the
  // lockout must fire — this is the behaviour the whole design exists for.
  await transfer(connection, payer, dumperAta, sinkAta, dumper, TOKENS(499_950));

  console.log('waiting for epoch 1 to close…');
  await waitUntil(connection, target.end + 2);

  // ── the fixture callout file ─────────────────────────────────────────────
  const at = (offset) => new Date((target.start + offset) * 1000).toISOString();
  const record = (id, wallet, offset) => ({
    id,
    walletAddress: wallet,
    tokenAddress: mint.toBase58(),
    createdAt: at(offset),
    isSpam: false,
    isHarmful: false,
    deletedAt: null,
    firstSeenAt: target.start + offset,
    lastSeenAt: target.start + offset,
  });

  writeStore({
    mint: mint.toBase58(),
    updatedAt: target.end,
    truncations: [],
    callouts: {
      'fixture-holder': record('fixture-holder', holder.publicKey.toBase58(), 5),
      'fixture-dumper': record('fixture-dumper', dumper.publicKey.toBase58(), 6),
    },
  });

  // ── the crank, as separate processes ─────────────────────────────────────
  rmSync(snapshotDir(1), { recursive: true, force: true });
  mkdirSync(resolve(REPO_ROOT, 'snapshots'), { recursive: true });

  console.log('\n── snapshot ─────────────────────────────────────────────────');
  crank('snapshot.mjs', ['--epoch', '1', '--rpc', rpc]);

  const tree = JSON.parse(readFileSync(resolve(snapshotDir(1), 'tree.json'), 'utf8'));
  check('leaves in the tree', tree.leafCount, 1);
  check('the paid wallet is the holder', tree.leaves[0]?.owner, holder.publicKey.toBase58());

  const csv = readFileSync(resolve(snapshotDir(1), 'payouts.csv'), 'utf8');
  const dumperRow = csv.split('\n').find((line) => line.includes(dumper.publicKey.toBase58()));
  check('the dumper appears in payouts.csv', Boolean(dumperRow), true);
  check('the dumper is paid nothing', dumperRow?.trim().endsWith(',0,0'), true);

  console.log('\n── verify-epoch, before the root is posted ──────────────────');
  crank('verify-epoch.mjs', ['--epoch', '1', '--rpc', rpc, '--recheck-chain', '--allow-unposted']);

  console.log('\n── post-root ────────────────────────────────────────────────');
  const snapshotPath = resolve(REPO_ROOT, 'target/deploy/e2e-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify([...snapshotKey.secretKey]));
  crank('post-root.mjs', ['--epoch', '1', '--rpc', rpc, '--keypair', snapshotPath, '--yes']);

  const onChain = await fetchEpoch(connection, mint, 1);
  check('the on-chain root is the published root', onChain.root.toString('hex'), tree.root);
  check('the on-chain allocation is what the tree pays', onChain.poolLamports, tree.allocate);

  console.log('\n── verify-epoch, as a stranger auditing the published epoch ──');
  crank('verify-epoch.mjs', ['--epoch', '1', '--rpc', rpc, '--recheck-chain']);
  check('a stranger reproduces the posted root', true, true);

  console.log('\n── airdrop ──────────────────────────────────────────────────');
  const before = await connection.getBalance(holder.publicKey);
  await waitUntil(connection, onChain.postedTs + CHALLENGE_SECONDS + 2);
  crank('airdrop.mjs', ['--epoch', '1', '--rpc', rpc, '--keypair', payerPath]);

  const after = await connection.getBalance(holder.publicKey);
  check('the holder was paid without signing anything', after - before, Number(tree.allocate));
  const settled = await fetchEpoch(connection, mint, 1);
  check('the epoch is fully claimed', settled.claimedLamports, tree.allocate);
  check('outstanding returns to zero', (await fetchConfig(connection)).outstanding, 0n);

  // ── the empty epoch ──────────────────────────────────────────────────────
  // L3/D7: a root is posted for every epoch, and its window shuts for good.
  console.log('\n── an epoch nobody called in ─────────────────────────────────');
  writeStore({ mint: mint.toBase58(), updatedAt: target.end, truncations: [], callouts: {} });
  const epoch2 = windowForEpoch(config, 2);
  await waitUntil(connection, epoch2.end + 2);
  crank('snapshot.mjs', ['--epoch', '2', '--rpc', rpc]);
  crank('post-root.mjs', ['--epoch', '2', '--rpc', rpc, '--keypair', snapshotPath, '--yes']);

  const empty = await fetchEpoch(connection, mint, 2);
  check('an empty epoch posts a zeroed root', empty.root.toString('hex'), '0'.repeat(64));
  check('and allocates nothing, so the fees roll forward', empty.poolLamports, 0n);

  // ── evidence ─────────────────────────────────────────────────────────────
  writeFileSync(
    resolve(REPO_ROOT, 'proofs/crank-e2e.json'),
    `${JSON.stringify(
      {
        cluster: rpc,
        ranAt: new Date().toISOString(),
        program: PROGRAM_ID.toBase58(),
        mint: mint.toBase58(),
        pool: poolPda().toBase58(),
        epochSeconds: EPOCH_SECONDS,
        genesisTs,
        holder: holder.publicKey.toBase58(),
        dumper: dumper.publicKey.toBase58(),
        root: tree.root,
        allocate: tree.allocate,
        assertions: results,
        passed: failures === 0,
      },
      null,
      2,
    )}\n`,
  );

  rmSync(payerPath, { force: true });
  rmSync(snapshotPath, { force: true });
  rmSync(STORE_PATH, { force: true });
  // `snapshots/` is the audit trail for the real coin. A rehearsal against a
  // throwaway local validator has no business living there, so it cleans up
  // after itself and leaves only proofs/crank-e2e.json as the record.
  rmSync(snapshotDir(1), { recursive: true, force: true });
  rmSync(snapshotDir(2), { recursive: true, force: true });

  console.log(`\n${results.length - failures}/${results.length} assertions passed\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
