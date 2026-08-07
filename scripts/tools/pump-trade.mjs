#!/usr/bin/env node
//
// scripts/tools/pump-trade.mjs — buy and sell the rehearsal coin.
//
//   node scripts/tools/pump-trade.mjs --buy 0.1  --keypair <WALLET> --rpc <RPC>
//   node scripts/tools/pump-trade.mjs --sell all --keypair <WALLET> --rpc <RPC>
//   node scripts/tools/pump-trade.mjs --sell 50% --keypair <WALLET>
//   node scripts/tools/pump-trade.mjs --lp-deposit 50% --keypair <WALLET>   # L18
//
// **The bonding curve and the AMM are different programs, and this picks.** Once
// a coin graduates the curve is closed: a sell against it fails with
// `BondingCurveComplete` (6005), which is what happened mid-rehearsal and left
// the lockout untested. Which side we are on is read from chain rather than
// remembered, because graduation happens on somebody else's schedule.
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
  const actions = ['buy', 'sell', 'lp-deposit', 'lp-withdraw'].filter((a) => args[a] !== undefined);
  if (actions.length === 0) {
    throw new Error(
      'pass --buy <SOL>, --sell <AMOUNT|all|N%>, --lp-deposit <AMOUNT|all|N%>, or --lp-withdraw all',
    );
  }
  if (actions.length > 1) throw new Error(`${actions.join(' and ')} are separate runs`);
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

  // Which venue. Read from chain, never assumed: the AMM pool account exists
  // only after graduation, and graduation happens on pump's schedule rather
  // than ours. Getting this wrong is not subtle — the curve refuses with
  // BondingCurveComplete — but it refuses *after* the transaction is built.
  const ammPool = await pump.readAmmPool(args.rpc, mint);
  const venue = ammPool.exists ? 'AMM (graduated)' : 'bonding curve';
  console.log(`venue      ${venue}`);
  if (ammPool.exists) console.log(`pool       ${ammPool.pool}`);

  let built;
  if (args.buy !== undefined) {
    const lamports = BigInt(Math.round(Number(args.buy) * LAMPORTS_PER_SOL));
    console.log(`action     BUY ${sol(lamports)}`);
    built = ammPool.exists
      ? await pump.buildAmmBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), lamports.toString())
      : await pump.buildBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), lamports.toString());
    if (built.tokenAmount) console.log(`expecting  ~${built.tokenAmount} raw units`);
  } else if (args.sell !== undefined) {
    const amount = resolveSellAmount(args.sell, tokensBefore);
    if (amount <= 0n) throw new Error('nothing to sell — the wallet holds no tokens');
    console.log(`action     SELL ${amount} raw units`);
    console.log('           ⚠️  this fires the 7-epoch lockout for this wallet (L1/L6)');
    built = ammPool.exists
      ? await pump.buildAmmSellInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString())
      : await pump.buildSellInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString());
    if (built.solAmount) console.log(`expecting  ~${sol(built.solAmount)} back`);
  } else if (args['lp-withdraw'] !== undefined) {
    // Recovery. SOL parked in a rehearsal LP position is SOL the dry devnet
    // faucets cannot replace, so getting it back is deliberate work (F18).
    if (!ammPool.exists) throw new Error('no pool exists, so there is no LP position to withdraw');
    const lp = await pump.readLpBalance(args.rpc, mint, wallet.publicKey.toBase58());
    const amount = resolveSellAmount(args['lp-withdraw'], BigInt(lp.amount));
    if (amount <= 0n) throw new Error(`this wallet holds no LP tokens (${lp.ata})`);
    console.log(`action     LP WITHDRAW ${amount} of ${lp.amount} LP tokens`);
    built = await pump.buildLpWithdrawInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString());
  } else {
    // ── L18 ────────────────────────────────────────────────────────────────
    // The case the whole ruling turns on. This empties the wallet's token
    // balance exactly as a sale does, and sends the coin to the same account.
    // What must distinguish it is that LP tokens come back.
    if (!ammPool.exists) {
      throw new Error(
        'the coin has not graduated, so there is no pool to deposit into and no LP mint. ' +
          'L18 cannot be exercised before graduation — that is the ruling\'s own scope.',
      );
    }
    const amount = resolveSellAmount(args['lp-deposit'], tokensBefore);
    if (amount <= 0n) throw new Error('nothing to deposit — the wallet holds no tokens');
    console.log(`action     LP DEPOSIT ${amount} raw units`);
    console.log(`lp mint    ${ammPool.lpMint}`);
    console.log('           this must NOT fire the lockout (L18) — the wallet gets LP tokens back');
    built = await pump.buildLpDepositInstructions(args.rpc, mint, wallet.publicKey.toBase58(), amount.toString());
    console.log(`lp tokens  ~${built.lpToken} expected back`);
    console.log(`sol side   ~${sol(built.quote)} also required — a pool is two-sided`);
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
