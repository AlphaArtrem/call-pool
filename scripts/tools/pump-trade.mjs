#!/usr/bin/env node
//
// scripts/tools/pump-trade.mjs — buy and sell the rehearsal coin.
//
//   node scripts/tools/pump-trade.mjs --buy 0.1  --keypair <WALLET> --rpc <RPC>
//   node scripts/tools/pump-trade.mjs --sell all --keypair <WALLET> --rpc <RPC>
//   node scripts/tools/pump-trade.mjs --sell 50% --keypair <WALLET>
//
// **Devnet only** — `assertNotMainnet`, by genesis hash, before anything is sent.
//
// Three jobs, and each is a thing the rehearsal cannot prove without it:
//
//   * **Generate real creator fees.** The pool only grows if somebody trades.
//     A rehearsal where nothing is bought proves the empty-epoch path and
//     little else, and step 0 sweeping zero is indistinguishable from step 0
//     being broken.
//   * **Fire the lockout deliberately.** `--sell` is how a wallet becomes
//     locked for the next 7 epochs. L18's test needs exactly this beside an LP
//     deposit, because selling and depositing send the coin to the *same
//     account* and the whole ruling turns on telling them apart.
//   * **Get the SOL back afterwards.** F18: ~3.2 SOL was recovered by selling
//     the gate-test coins back into their curves. The faucets are dry, so this
//     is the recovery route, not a convenience.
//
// Nothing pump's SDK builds is signed here. `tools/sweep` returns base58 and
// base64, and the instructions are rebuilt with this repository's own web3.

import { LAMPORTS_PER_SOL, ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { associatedTokenAddress, currentBalanceRaw, tokenProgramForMint } from '../lib/chain.mjs';
import { assertNotMainnet, loadKeypair, readManifest } from './devnet.mjs';
import { instructionFrom } from './mk-pump-coin.mjs';

const COMPUTE_UNIT_LIMIT = 400_000;
const PUMP_FEES = '../../tools/sweep/pump-fees.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.buy && !args.sell) throw new Error('pass --buy <SOL> or --sell <AMOUNT|all|N%>');
  if (args.buy && args.sell) throw new Error('--buy and --sell are separate runs');
  if (!args.keypair) throw new Error('--keypair <PATH> is required');
  return args;
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;

/**
 * How many raw units `--sell` means, given what the wallet holds.
 *
 * `all` and `N%` exist because the interesting quantity is almost never a
 * number someone has to look up — "sell everything" is the recovery path and
 * "sell some" is the lockout trigger.
 */
export function resolveSellAmount(spec, balance) {
  if (spec === 'all') return balance;
  const percent = String(spec).match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) {
    const fraction = Number(percent[1]);
    if (fraction <= 0 || fraction > 100) throw new Error(`--sell ${spec} is out of range`);
    return (balance * BigInt(Math.round(fraction * 100))) / 10_000n;
  }
  const raw = BigInt(spec);
  if (raw > balance) {
    throw new Error(`--sell ${spec} exceeds the balance of ${balance} raw units`);
  }
  return raw;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'pump-trade.mjs');

  const manifest = readManifest();
  const mint = args.mint ?? manifest.mint ?? manifest.pumpCoin?.mint;
  if (!mint) throw new Error('no mint in the manifest and no --mint given');

  const wallet = loadKeypair(args.keypair);
  const pump = await import(PUMP_FEES);

  const tokenProgram = await tokenProgramForMint(connection, mint);
  const ata = associatedTokenAddress(wallet.publicKey, mint, tokenProgram);

  const solBefore = await connection.getBalance(wallet.publicKey);
  const tokensBefore = await currentBalanceRaw(connection, ata);

  console.log(`\nCALLPOOL — trade ${mint}\n`);
  console.log(`wallet     ${wallet.publicKey.toBase58()}`);
  console.log(`holds      ${tokensBefore} raw units, ${sol(solBefore)}`);

  let built;
  if (args.buy) {
    const lamports = BigInt(Math.round(Number(args.buy) * LAMPORTS_PER_SOL));
    console.log(`action     BUY ${sol(lamports)}`);
    built = await pump.buildBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), lamports.toString());
    console.log(`expecting  ~${built.tokenAmount} raw units`);
  } else {
    const amount = resolveSellAmount(args.sell, tokensBefore);
    if (amount <= 0n) throw new Error('nothing to sell — the wallet holds no tokens');
    console.log(`action     SELL ${amount} raw units`);
    console.log('           ⚠️  this fires the 7-epoch lockout for this wallet (L1/L6)');
    built = await pump.buildSellInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString());
    console.log(`expecting  ~${sol(built.solAmount)} back`);
  }

  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ...built.instructions.map(instructionFrom),
    ),
    [wallet],
    { commitment: 'confirmed' },
  );

  const solAfter = await connection.getBalance(wallet.publicKey);
  const tokensAfter = await currentBalanceRaw(connection, ata);

  console.log(`\nsent       ${signature}`);
  console.log(`tokens     ${tokensBefore} → ${tokensAfter}`);
  console.log(`sol        ${sol(solBefore)} → ${sol(solAfter)}`);

  // The delta is the only honest statement, same rule as the sweep. A
  // transaction that lands and moves nothing is a real outcome, not a success.
  const moved = tokensAfter - tokensBefore;
  console.log(
    moved === 0n
      ? '\n⚠️  the token balance did not move. The transaction landed; something still went wrong.\n'
      : `\n${moved > 0n ? 'bought' : 'sold'} ${moved > 0n ? moved : -moved} raw units\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nTRADE FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
