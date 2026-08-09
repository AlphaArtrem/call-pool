#!/usr/bin/env node
//
// scripts/tools/drain-cast.mjs — get the cast's SOL back to the payer.
//
//   node scripts/tools/drain-cast.mjs --payer /etc/callpool/devnet-payer.json
//   ... --dry-run                # say what it would move, send nothing
//   ... --keep steady,fader      # leave these wallets alone
//
// **Devnet only**, checked by genesis hash before anything is sent.
//
// The other half of recovery. `pump-trade.mjs --sell all` turns a wallet's
// tokens back into SOL one wallet at a time — that part is reused as is, since
// a second implementation of a sell is a second set of ways to lose money — and
// this collects what is left afterwards: the sale proceeds, the unspent gas,
// and the rent sitting under an emptied token account.
//
// Why the rent is worth the extra instruction: an ATA holds ~0.002 SOL and a
// 64-wallet cast is therefore ~0.13 SOL, which is more than a rehearsal epoch
// costs to run. Closing it is also the honest end state — the account has no
// further purpose once the balance is zero.
//
// **A wallet that still holds tokens is skipped, loudly.** Draining it would
// strand the tokens somewhere with no lamports to sell them with, which is the
// same shape of mistake as run 1's funding-before-keys bug: recoverable value
// made unrecoverable by doing the steps in the wrong order. Sell first.

import { readdirSync } from 'node:fs';

import { createCloseAccountInstruction } from '@solana/spl-token';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { associatedTokenAddress, currentBalanceRaw, tokenProgramForMint } from '../lib/chain.mjs';
import { assertNotMainnet, KEYS_DIR, loadKeypair, readManifest } from './devnet.mjs';

/**
 * Below this, a transfer is not worth the transaction. Leave it.
 *
 * Small, because the payer signs and therefore pays: what a wallet gives up is
 * its whole balance, not its balance less a fee.
 */
const DUST = 5_000n;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, 'dry-run': false, keep: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args['dry-run'] = true;
    // Named explicitly — the generic branch below would swallow the NEXT
    // argument as this flag's value and silently leave the flag unset.
    else if (argv[i] === '--tokens-are-unsellable') args.tokensAreUnsellable = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.payer) throw new Error('--payer <keypair.json> is required — it is where the SOL goes');
  return args;
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)}`;

/** Every cast key on disk, by name, in a stable order. */
export function castNames(dir = KEYS_DIR, { readdir = readdirSync } = {}) {
  return readdir(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/**
 * What to do with one wallet, decided before anything is sent.
 *
 * Split out from the sending so the decision is testable on its own: the rule
 * that a token holder is never drained is the one that protects real value, and
 * it should not need a cluster to check.
 */
export function planFor({ name, lamports, tokens, keep, tokensAreUnsellable = false }) {
  if (keep.includes(name)) return { action: 'skip', why: 'kept by --keep' };
  // `--tokens-are-unsellable` is for the one case where "sell first" is not
  // advice but an impossibility: a **completed bonding curve with no AMM pool**.
  // A complete curve refuses every buy AND every sell, and the AMM exists only
  // once pump migrates — which on devnet has never been observed (G12).
  //
  // The tokens are already unrecoverable there, and leaving the gas beside them
  // recovers nothing while costing the payer real SOL: run 5 stranded ~3.2 SOL
  // across sixty-three wallets exactly this way.
  //
  // Named for its consequence rather than for what it enables, so it cannot be
  // reached for casually. **Confirm `readCurveState().complete` is true and
  // `readAmmPool().exists` is false first** — anywhere else it does precisely
  // the damage this guard exists to prevent.
  if (tokens > 0n && !tokensAreUnsellable) {
    return { action: 'skip', why: `still holds ${tokens} raw units — sell first (pump-trade --sell all)` };
  }
  if (lamports <= DUST) return { action: 'skip', why: `${sol(lamports)} SOL is dust` };
  // Everything, to the lamport. **A system account may end at zero or at the
  // rent-exempt minimum, and at nothing in between** — leaving a fee behind put
  // all 64 wallets at ~10,000 lamports and every transaction was rejected with
  // "insufficient funds for rent" (2026-08-08). The payer signs and pays, which
  // it can afford and which is the only way the wallet reaches exactly zero.
  return { action: 'drain', lamports };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'drain-cast.mjs');

  const manifest = readManifest();
  const mint = args.mint ?? manifest.mint ?? manifest.pumpCoin?.mint;
  if (!mint) throw new Error('no mint in the manifest and no --mint given');

  const payer = loadKeypair(args.payer);
  const keep = args.keep ? args.keep.split(',').map((s) => s.trim()) : [];
  const tokenProgram = await tokenProgramForMint(connection, mint);

  console.log(`\nCALLPOOL — drain the cast into ${payer.publicKey.toBase58()}\n`);
  if (args['dry-run']) console.log('DRY RUN — nothing will be sent\n');

  let recovered = 0n;
  let drained = 0;
  const skipped = [];

  for (const name of castNames()) {
    const wallet = loadKeypair(`${KEYS_DIR}/${name}.json`);
    if (wallet.publicKey.equals(payer.publicKey)) continue;

    const lamports = BigInt(await connection.getBalance(wallet.publicKey));
    const ata = associatedTokenAddress(wallet.publicKey, mint, tokenProgram);
    const tokens = await currentBalanceRaw(connection, ata);
    const plan = planFor({ name, lamports, tokens, keep, tokensAreUnsellable: args.tokensAreUnsellable });

    if (plan.action === 'skip') {
      skipped.push(`${name.padEnd(16)} ${plan.why}`);
      continue;
    }

    // The close comes first in the same transaction: it releases the ATA's rent
    // into the wallet, and the transfer that follows sweeps it out again. Two
    // transactions would leave that rent behind on any failure between them.
    const tx = new Transaction();
    // The ATA is closed to reclaim its rent — but **only when it is empty**.
    // `close_account` fails with `NonNativeHasBalance` (0xb) on an account that
    // still holds tokens, and under `--tokens-are-unsellable` it always does.
    // Attempting it there fails the whole transaction and recovers nothing,
    // which is how run 5 first "recovered" 0.08 SOL of an available 3.2.
    //
    // So the rent stays stranded with the tokens, and the wallet's own SOL —
    // by far the larger part — still comes back.
    const ataInfo = await connection.getAccountInfo(ata);
    const closeable = ataInfo != null && tokens === 0n;
    if (closeable) {
      tx.add(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], tokenProgram));
    }
    // The close credits the wallet before the transfer reads it, so the rent it
    // releases has to be part of the amount moved or it stays behind.
    const moving = plan.lamports + BigInt(closeable ? (ataInfo?.lamports ?? 0) : 0);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: payer.publicKey,
        lamports: moving,
      }),
    );
    tx.feePayer = payer.publicKey;

    if (args['dry-run']) {
      console.log(`${name.padEnd(16)} would send ${sol(moving)} SOL${closeable ? ' (incl. ATA rent)' : ''}`);
      recovered += moving;
      drained += 1;
      continue;
    }

    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [payer, wallet], { commitment: 'confirmed' });
      console.log(`${name.padEnd(16)} sent ${sol(moving)} SOL   ${signature}`);
      recovered += moving;
      drained += 1;
    } catch (error) {
      // One wallet failing is not a reason to abandon the other sixty-three;
      // this is a recovery, and every wallet it does reach is money back. The
      // failure is named and counted so the run cannot look complete.
      skipped.push(`${name.padEnd(16)} FAILED: ${error.message}`);
    }
  }

  console.log(`\ndrained ${drained} wallet(s), ${sol(recovered)} SOL${args['dry-run'] ? ' (dry run)' : ''}`);
  if (skipped.length > 0) {
    console.log(`\nnot drained (${skipped.length}):`);
    for (const line of skipped) console.log(`  ${line}`);
  }
  if (skipped.some((line) => line.includes('FAILED'))) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\ndrain-cast: ${error.message}`);
    process.exitCode = 1;
  });
}
