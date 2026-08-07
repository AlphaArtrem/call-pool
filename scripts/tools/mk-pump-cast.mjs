#!/usr/bin/env node
//
// scripts/tools/mk-pump-cast.mjs — the wallets a real-coin rehearsal needs.
//
//   node scripts/tools/mk-pump-cast.mjs --keypair <FUNDED> --rpc <DEVNET_RPC>
//   ... --only minnow --sol 0.0002    # redo one role with a different buy size
//
// **Devnet only**, checked by genesis hash before anything is sent.
//
// `deploy-devnet.mjs` builds its cast by minting to fresh wallets. That is not
// available for a real pump.fun coin: the supply lives on the bonding curve and
// there is no mint authority to hand it out with. So the cast **buys**, which is
// the same act a real holder performs — and it is the only thing that makes
// creator fees accrue, which is what step 0 exists to sweep. A rehearsal where
// nothing is bought proves the empty-epoch path and little else.
//
// The roles are the four rows the website renders differently, and the rehearsal
// is only worth running if all four exist:
//
//   steady   buys and holds. Calls out every epoch. The baseline earner.
//   fader    buys and holds. Calls out, then stops — a call does not carry over.
//   dumper   buys, calls out, then SELLS. Hold collapses and the lockout fires.
//   minnow   buys a little — below the floor. Calls out and earns nothing.
//
// The buy sizes are chosen to put minnow under the floor and the rest over it,
// but a bonding curve prices each buy against the last, so what a wallet
// actually receives is **measured after the fact** rather than assumed. If the
// curve moved enough that a role landed on the wrong side of the floor, this
// says so instead of writing a manifest that quietly describes something else.

import { LAMPORTS_PER_SOL, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL, MIN_HOLD_RAW, MIN_HOLD_TOKENS, MINT_DECIMALS } from '../lib/config.mjs';
import { associatedTokenAddress, currentBalanceRaw, tokenProgramForMint } from '../lib/chain.mjs';
import { assertNotMainnet, KEYS_DIR, loadKeypair, readManifest, writeKeypair, writeManifest } from './devnet.mjs';
import { instructionFrom } from './mk-pump-coin.mjs';

const COMPUTE_UNIT_LIMIT = 400_000;
const PUMP_FEES = '../../tools/sweep/pump-fees.mjs';

/**
 * Who buys what, and why.
 *
 * `sol` is a first guess at landing either side of the floor. It is checked
 * against the balance that actually arrives, never trusted.
 */
const CAST = [
  { name: 'steady', sol: 0.30, wantAboveFloor: true, role: 'calls out every epoch, never sells — the baseline earner' },
  { name: 'fader', sol: 0.20, wantAboveFloor: true, role: 'calls out, then stops — proves a call does not carry over' },
  { name: 'dumper', sol: 0.25, wantAboveFloor: true, role: 'calls out, then sells — hold collapses and the lockout fires' },
  { name: 'minnow', sol: 0.0015, wantAboveFloor: false, role: 'below the floor; calls out and earns nothing' },
];

/** SOL each wallet keeps for its own fees. It has to be able to sell. */
const GAS_SOL = 0.02;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair) throw new Error('--keypair <PATH> is required');
  return args;
}

const tokens = (raw) => Number(raw) / 10 ** MINT_DECIMALS;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mk-pump-cast.mjs');

  const manifest = readManifest();
  const mint = args.mint ?? manifest.mint;
  if (!mint) throw new Error('no mint in the manifest and no --mint given');

  const payer = loadKeypair(args.keypair);
  const pump = await import(PUMP_FEES);
  const tokenProgram = await tokenProgramForMint(connection, mint);

  console.log(`\nCALLPOOL — build the cast by buying ${mint}\n`);
  console.log(`floor      ${MIN_HOLD_TOKENS.toLocaleString('en-US')} tokens (${MIN_HOLD_RAW} raw)\n`);

  // `--only` re-does a subset, keeping everyone else exactly as they are. The
  // floor check below is a first guess against a curve that reprices on every
  // buy, so getting a role's size wrong is expected — and rebuying the whole
  // cast to fix one of them costs SOL the dry faucets cannot replace (F18).
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const wanted = only ? CAST.filter((m) => only.has(m.name)) : CAST;
  if (only && wanted.length !== only.size) {
    throw new Error(`--only names a role that does not exist: ${[...only].join(', ')}`);
  }

  const cast = only ? (manifest.cast ?? []).filter((m) => !only.has(m.name)) : [];
  const problems = [];

  for (const member of wanted) {
    // `--sol` overrides the guess when redoing a single role.
    if (args.sol && wanted.length === 1) member.sol = Number(args.sol);
    const wallet = Keypair.generate();
    const lamports = BigInt(Math.round((member.sol + GAS_SOL) * LAMPORTS_PER_SOL));

    // Fund first — the wallet signs its own buy, and later its own sale.
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Number(lamports),
        }),
      ),
      [payer],
      { commitment: 'confirmed' },
    );

    const spend = BigInt(Math.round(member.sol * LAMPORTS_PER_SOL));
    const buy = await pump.buildBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), spend.toString());
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...buy.instructions.map(instructionFrom),
      ),
      [wallet],
      { commitment: 'confirmed' },
    );

    // What actually arrived. The curve prices each buy against the last, so the
    // only honest number is the one on chain afterwards.
    const ata = associatedTokenAddress(wallet.publicKey, mint, tokenProgram);
    const held = await currentBalanceRaw(connection, ata);
    const aboveFloor = held >= MIN_HOLD_RAW;

    if (aboveFloor !== member.wantAboveFloor) {
      problems.push(
        `${member.name} wanted ${member.wantAboveFloor ? 'above' : 'below'} the floor but holds ` +
          `${tokens(held).toLocaleString('en-US')} tokens — adjust its --sol and re-run, or the ` +
          'role it is named for is not the role it will play.',
      );
    }

    const keypairPath = writeKeypair(resolve(KEYS_DIR, `${member.name}.json`), wallet);
    cast.push({
      name: member.name,
      role: member.role,
      address: wallet.publicKey.toBase58(),
      tokenAccount: ata.toBase58(),
      tokens: (held / 10n ** BigInt(MINT_DECIMALS)).toString(),
      rawTokens: held.toString(),
      aboveFloor,
      boughtFor: member.sol,
      keypair: keypairPath,
      signature,
    });

    console.log(
      `  ${member.name.padEnd(8)} ${wallet.publicKey.toBase58()}  ` +
        `${tokens(held).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)} tokens` +
        `${aboveFloor ? '' : '  (below the floor)'}`,
    );
  }

  manifest.cast = cast;
  writeManifest(manifest);
  console.log('\nmanifest   cast written to epochs/devnet/deployment.json');

  const distributable = await pump.readDistributable(args.rpc, mint);
  console.log(
    `\nfees       ${distributable.distributableFees} accrued against a minimum of ` +
      `${distributable.minimumRequired}` +
      `${distributable.canDistribute ? '  — distributable now' : '  — not yet distributable'}`,
  );

  if (problems.length > 0) {
    console.log(`\n⚠️  ${problems.length} role(s) landed on the wrong side of the floor:\n`);
    for (const p of problems) console.log(`  • ${p}`);
    console.log('');
    process.exitCode = 1;
    return;
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nMK-PUMP-CAST FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
