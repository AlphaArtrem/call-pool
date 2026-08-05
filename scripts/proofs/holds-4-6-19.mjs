#!/usr/bin/env node
//
// Phase 06 proofs 4, 6 and 19 — `scripts/holds.mjs` against real chain history.
//
// The standard in Phase 06 §6.1 is that an argument gets replaced by a
// transaction. The offline tests in scripts/tests/ prove the arithmetic; this
// proves that real transactions, fetched over a real RPC and parsed out of
// real `preTokenBalances`, reach that arithmetic in the shape it expects.
//
//   proof 4   a wallet buys, sells half, rebuys → hold is the trough, not the
//             closing balance and not the maximum
//   proof 6   a wallet that transacted only *before* the epoch shows a flat,
//             non-zero timeline — not zero
//   proof 19  sending tokens to a second wallet the same person owns collapses
//             hold and sets the lockout, with no netting (L6)
//
// Each proof builds its own history, so nothing here depends on finding a
// pre-existing wallet. Epoch windows are passed explicitly rather than as
// calendar days, so a full buy/sell/rebuy cycle can be proven in seconds
// instead of waiting for a real midnight; the calendar arithmetic itself is
// covered offline.
//
// Usage:
//   solana-test-validator --reset            # or point --rpc at devnet
//   node scripts/proofs/holds-4-6-19.mjs --rpc http://127.0.0.1:8899
//
// Writes proofs/holds-4-6-19.json as the evidence trail for Phase 06 §6.3.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from '@solana/spl-token';

import { EPOCH_SECONDS, MINT_DECIMALS } from '../lib/config.mjs';
import { iso } from '../lib/epoch.mjs';
import { holdsFor } from '../holds.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCALE = 10n ** BigInt(MINT_DECIMALS);
const T = (n) => BigInt(n) * SCALE;
const tokens = (raw) => (raw / SCALE).toLocaleString('en-US');

const results = [];
let failures = 0;

function check(proof, what, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  results.push({ proof, what, actual: String(actual), expected: String(expected), ok });
  console.log(
    `  ${ok ? '✔' : '✘'} ${what.padEnd(52)}${String(actual).padStart(16)}` +
      (ok ? '' : `   expected ${expected}`),
  );
}

/** Block until the cluster's own clock has passed `target` (unix seconds). */
async function waitForClusterTime(connection, target) {
  for (;;) {
    const slot = await connection.getSlot('confirmed');
    const now = await connection.getBlockTime(slot);
    if (now != null && now >= target) return now;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The cluster's recorded blockTime for a transaction — never the local clock. */
async function blockTimeOf(connection, signature) {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.blockTime) throw new Error(`no blockTime for ${signature}`);
  return tx.blockTime;
}

/** A window one epoch long, starting strictly after the given transaction. */
async function windowAfter(connection, signature) {
  const start = (await blockTimeOf(connection, signature)) + 1;
  await waitForClusterTime(connection, start);
  return { start, end: start + EPOCH_SECONDS };
}

async function fund(connection, keypair, sol = 2) {
  const signature = await connection.requestAirdrop(keypair.publicKey, sol * LAMPORTS_PER_SOL);
  const blockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
}

async function main() {
  const argv = process.argv.slice(2);
  const rpcIndex = argv.indexOf('--rpc');
  const rpc = rpcIndex === -1 ? 'http://127.0.0.1:8899' : argv[rpcIndex + 1];

  const connection = new Connection(rpc, 'confirmed');
  const version = await connection.getVersion();
  console.log(`\nCALLPOOL — Phase 06 proofs 4, 6 and 19`);
  console.log(`cluster   ${rpc}  (solana-core ${version['solana-core']})\n`);

  const payer = Keypair.generate();
  await fund(connection, payer, 10);

  const mint = await createMint(connection, payer, payer.publicKey, null, MINT_DECIMALS);
  console.log(`mint      ${mint.toBase58()}  (${MINT_DECIMALS} decimals)\n`);

  const ataFor = async (owner) =>
    (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner.publicKey)).address;

  const signatures = {};

  // ── proof 4 ──────────────────────────────────────────────────────────────
  // Buy, call, sell half, rebuy. `hold` must be the trough.
  console.log('proof 4 — hold is the true minimum, not the close and not the max');

  const alice = Keypair.generate();
  const aliceAta = await ataFor(alice);
  const sink = Keypair.generate();
  const sinkAta = await ataFor(sink);

  // Opening position, established *before* the epoch so the window has
  // something to be seeded from.
  signatures.p4_open = await mintTo(
    connection, payer, mint, aliceAta, payer, T(1_000_000),
  );
  const window4 = await windowAfter(connection, signatures.p4_open);

  signatures.p4_sell = await transfer(
    connection, payer, aliceAta, sinkAta, alice, T(500_000),
  );
  signatures.p4_rebuy = await mintTo(
    connection, payer, mint, aliceAta, payer, T(700_000),
  );

  const r4 = await holdsFor(connection, {
    wallet: alice.publicKey.toBase58(),
    mint: mint.toBase58(),
    window: window4,
  });

  check(4, 'opening balance (seeded from before the epoch)', r4.opening, T(1_000_000));
  check(4, 'maximum reached during the epoch', r4.maximum, T(1_200_000));
  check(4, 'closing balance', r4.closing, T(1_200_000));
  check(4, 'hold — the trough', r4.hold, T(500_000));
  check(4, 'balance changes replayed inside the epoch', BigInt(r4.windowEvents.length), 2n);

  // ── proof 6 ──────────────────────────────────────────────────────────────
  // A wallet that transacted only before the epoch. The naive implementation
  // reads an empty window as a zero balance and pays the most loyal holders
  // nothing.
  console.log('\nproof 6 — a wallet with no in-epoch activity keeps its carried balance');

  const bob = Keypair.generate();
  const bobAta = await ataFor(bob);
  signatures.p6_buy = await mintTo(connection, payer, mint, bobAta, payer, T(250_000));

  const window6 = await windowAfter(connection, signatures.p6_buy);
  const r6 = await holdsFor(connection, {
    wallet: bob.publicKey.toBase58(),
    mint: mint.toBase58(),
    window: window6,
  });

  check(6, 'transfers during the epoch', BigInt(r6.windowEvents.length), 0n);
  check(6, 'hold — the carried balance, not zero', r6.hold, T(250_000));
  check(6, 'opening equals closing (a flat timeline)', r6.opening, r6.closing);

  // The mirror image, and it must NOT be repaired: an epoch that *contains*
  // the first purchase pays nothing, because the wallet held nothing at the
  // open. That is Decision 23's new-buyer rule falling out of `hold` with no
  // special case — they earn after their first full epoch.
  const buyTime = await blockTimeOf(connection, signatures.p6_buy);
  const r6New = await holdsFor(connection, {
    wallet: bob.publicKey.toBase58(),
    mint: mint.toBase58(),
    window: { start: buyTime - 60, end: buyTime - 60 + EPOCH_SECONDS },
  });
  check(6, 'a first-time buyer earns nothing for the epoch they bought in', r6New.hold, 0n);

  // ── proof 19 ─────────────────────────────────────────────────────────────
  // L6: any transfer out is a sale, including to another wallet you own.
  console.log('\nproof 19 — moving tokens to your own second wallet is a sale');

  const carol = Keypair.generate();
  const carolAta = await ataFor(carol);
  const carolSecond = Keypair.generate(); // the same person's other wallet
  const carolSecondAta = await ataFor(carolSecond);

  signatures.p19_buy = await mintTo(connection, payer, mint, carolAta, payer, T(1_000_000));
  const window19 = await windowAfter(connection, signatures.p19_buy);

  signatures.p19_selfTransfer = await transfer(
    connection, payer, carolAta, carolSecondAta, carol, T(300_000),
  );

  const r19 = await holdsFor(connection, {
    wallet: carol.publicKey.toBase58(),
    mint: mint.toBase58(),
    window: window19,
  });

  check(19, 'hold collapses to the post-transfer balance', r19.hold, T(700_000));
  check(19, 'no netting — the 300,000 in the second wallet does not count', r19.closing, T(700_000));

  const secondBalance = BigInt(
    (await connection.getTokenAccountBalance(carolSecondAta)).value.amount,
  );
  check(19, 'the tokens do still exist, in the other account', secondBalance, T(300_000));

  // The sale inside the epoch is paid for by the minimum collapsing, so it
  // must not *also* set the lockout for that same epoch — that would make the
  // penalty 8 days rather than 7. See LOCKOUT_EPOCHS in lib/config.mjs.
  check(19, 'locked for the epoch containing the sale', r19.locked, false);

  const later = { start: window19.start + EPOCH_SECONDS, end: window19.start + 2 * EPOCH_SECONDS };
  const r19Next = await holdsFor(connection, {
    wallet: carol.publicKey.toBase58(),
    mint: mint.toBase58(),
    window: later,
  });
  check(19, 'locked for the following epoch', r19Next.locked, true);
  check(19, 'the lockout names the transaction that caused it',
    r19Next.lockoutDecreases[0]?.signature, signatures.p19_selfTransfer);

  // ── evidence ─────────────────────────────────────────────────────────────
  const evidence = {
    cluster: rpc,
    solanaCore: version['solana-core'],
    ranAt: new Date().toISOString(),
    mint: mint.toBase58(),
    decimals: MINT_DECIMALS,
    wallets: {
      alice: alice.publicKey.toBase58(),
      bob: bob.publicKey.toBase58(),
      carol: carol.publicKey.toBase58(),
      carolSecondWallet: carolSecond.publicKey.toBase58(),
    },
    windows: {
      proof4: { ...window4, human: `${iso(window4.start)} → ${iso(window4.end)}` },
      proof6: { ...window6, human: `${iso(window6.start)} → ${iso(window6.end)}` },
      proof19: { ...window19, human: `${iso(window19.start)} → ${iso(window19.end)}` },
    },
    signatures,
    assertions: results,
    passed: failures === 0,
  };

  mkdirSync(resolve(ROOT, 'proofs'), { recursive: true });
  const out = resolve(ROOT, 'proofs/holds-4-6-19.json');
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`\n${results.length - failures}/${results.length} assertions passed`);
  console.log(`evidence  ${out}`);
  console.log(`hold values: proof 4 = ${tokens(r4.hold)}, proof 6 = ${tokens(r6.hold)}, proof 19 = ${tokens(r19.hold)}\n`);

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
