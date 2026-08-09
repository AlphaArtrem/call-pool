#!/usr/bin/env node
//
// scripts/tools/mk-pump-cast.mjs — the wallets a real-coin rehearsal needs.
//
//   node scripts/tools/mk-pump-cast.mjs --keypair <FUNDED> --rpc <DEVNET_RPC>
//   ... --count 60                    # scenario wallets, on top of the 4 roles
//   ... --only minnow --sol 0.0002    # redo one wallet with a different buy size
//   ... --resume                      # keep everyone who already holds tokens
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
// ## Two populations, and why they are different
//
// **The four named roles** are the rows the website renders differently, and
// three other tools address them *by name*: `mock-callouts.mjs` keys `fader`'s
// silence off the string, `mock-sale.mjs --wallet dumper`, and
// `dry-run-loop.mjs` scripts both. They are not scenery and they are not
// renameable.
//
//   steady   buys and holds. Calls out every epoch. The baseline earner.
//   fader    buys and holds. Calls out, then stops — a call does not carry over.
//   dumper   buys, calls out, then SELLS. Hold collapses and the lockout fires.
//   minnow   buys a little — below the floor. Calls out and earns nothing.
//
// **The scenario wallets** (`w01`…`wNN`) are new, and exist because the final
// devnet test needs ~60 of them: scenario D1 alone wants 60 eligible wallets in
// one epoch to prove the tree batches into 12 airdrop transactions. They are
// deliberately anonymous. The scenario driver (§3.3) assigns each one a matrix
// row and drives it there — a wallet named `b7` here would be a second, weaker
// source of truth about what b7 is, and the two would drift.
//
// ## What it does not decide
//
// Exact balances. The matrix wants figures like "exactly 100,000" and "99,999",
// and no buy on a curve lands on a round number. Every wallet here is bought up
// to a workable balance and **measured**; the driver transfers the excess away
// to hit the target. That split is deliberate: this tool is about acquiring the
// coin, and acquiring it is the part that costs SOL and cannot be undone.

import { LAMPORTS_PER_SOL, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL, MIN_HOLD_RAW, MIN_HOLD_TOKENS, MINT_DECIMALS } from '../lib/config.mjs';
import { associatedTokenAddress, currentBalanceRaw, tokenProgramForMint } from '../lib/chain.mjs';
import { assertNotMainnet, KEYS_DIR, loadKeypair, readManifest, writeKeypair, writeManifest } from './devnet.mjs';
import { instructionFrom } from './mk-pump-coin.mjs';
import { settledBalance } from './pump-trade.mjs';

const COMPUTE_UNIT_LIMIT = 400_000;
const PUMP_FEES = '../../tools/sweep/pump-fees.mjs';

/**
 * Who buys what, and why.
 *
 * `sol` is a first guess at landing either side of the floor. It is checked
 * against the balance that actually arrives, never trusted.
 */
const NAMED_ROLES = [
  { name: 'steady', sol: 0.30, wantAboveFloor: true, role: 'calls out every epoch, never sells — the baseline earner' },
  { name: 'fader', sol: 0.20, wantAboveFloor: true, role: 'calls out, then stops — proves a call does not carry over' },
  { name: 'dumper', sol: 0.25, wantAboveFloor: true, role: 'calls out, then sells — hold collapses and the lockout fires' },
  { name: 'minnow', sol: 0.0015, wantAboveFloor: false, role: 'below the floor; calls out and earns nothing' },
];

/**
 * SOL each wallet keeps for its own fees. It has to be able to sell.
 *
 * Raised from 0.02 after the AMM path exhausted it on 2026-08-08:
 * `Transfer: insufficient lamports 603240, need 2039280` inside the associated
 * token program. A graduated buy pays for **two** ATAs — the wSOL account it
 * wraps through and the token account it receives into — where the bonding
 * curve pays for one, and the slippage allowance is spent from the same
 * balance. 0.05 covers both with room for a sell later.
 */
export const GAS_SOL = 0.05;

/**
 * What a scenario wallet spends by default.
 *
 * Sized well clear of the floor rather than close to it. A curve reprices on
 * every buy, so the sixtieth wallet pays materially more per token than the
 * first; a size chosen to *just* clear the floor for wallet 1 puts the tail of
 * the cast underneath it, and a scenario wallet that cannot hold above the
 * floor cannot play most of the matrix. Overshooting costs devnet SOL, which
 * the run has. Undershooting costs a re-run of the whole cast, which it does
 * not — the faucets are dry (F18).
 */
const SCENARIO_SOL = 0.03;

/**
 * How many funding transfers to put in one transaction.
 *
 * Sixty wallets funded one transaction at a time is sixty confirmations before
 * the first buy. A transfer instruction is small and the cap here is the 1232-
 * byte transaction limit; fifteen is comfortably inside it with room for the
 * fee payer's signature and leaves the failure granular enough to diagnose.
 */
const FUND_BATCH = 15;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, count: 0, resume: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume') args.resume = true;
    else if (argv[i] === '--no-legacy') args.noLegacy = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.keypair) throw new Error('--keypair <PATH> is required');
  args.count = Number(args.count ?? 0);
  if (!Number.isInteger(args.count) || args.count < 0) {
    throw new Error(`--count must be a non-negative integer, got ${args.count}`);
  }
  return args;
}

const tokens = (raw) => Number(raw) / 10 ** MINT_DECIMALS;

/**
 * The full roster this invocation intends to build.
 *
 * Pure, and exported, because the composition rules are the part worth pinning:
 * the named roles must survive `--count`, `--count` must not renumber an
 * existing cast on resume, and the scenario names must sort in the order they
 * were made (`w02` before `w10`) or the driver's row assignment shuffles
 * between runs.
 */
export function roster({ count, noLegacy = false, scenarioSol = SCENARIO_SOL }) {
  const named = noLegacy ? [] : NAMED_ROLES.map((m) => ({ ...m }));
  const scenario = [];
  for (let i = 1; i <= count; i++) {
    scenario.push({
      name: `w${String(i).padStart(2, '0')}`,
      sol: scenarioSol,
      wantAboveFloor: true,
      role: 'scenario wallet — the driver assigns its matrix row',
      scenario: true,
    });
  }
  return [...named, ...scenario];
}

/**
 * Split transfers into transaction-sized groups.
 *
 * Separate from the sending so the batching is testable without a chain: an
 * off-by-one that silently drops the last wallet would show up as one member
 * of a sixty-wallet cast owning no SOL, three minutes into a run that has
 * already spent most of it.
 */
export function fundingBatches(members, size = FUND_BATCH) {
  const out = [];
  for (let i = 0; i < members.length; i += size) out.push(members.slice(i, i + size));
  return out;
}

/**
 * Is this member already built and holding coin?
 *
 * Sixty wallets is roughly a hundred and twenty transactions, and a run that
 * dies at wallet forty-seven must not start again from wallet one — the SOL
 * spent on the first forty-six is not recoverable from a devnet faucet. A
 * member counts as done only if it holds something: a funded wallet whose buy
 * failed is not done, and is exactly the case `--resume` exists for.
 */
export function alreadyBuilt(existing, name) {
  const member = (existing ?? []).find((m) => m.name === name);
  if (!member) return false;
  return BigInt(member.rawTokens ?? '0') > 0n;
}

/** The manifest stores token accounts as base58 strings; the chain wants a key. */
const readTokenAccount = (connection, address) => currentBalanceRaw(connection, new PublicKey(address));

/**
 * Correct the manifest's zeros against the chain, in place.
 *
 * A record that says zero is either a buy that never landed or a read that was
 * answered by a lagging node, and those two look identical in the file while
 * costing very different things to get wrong. Only the chain can tell them
 * apart, so only wallets the manifest calls empty are checked — everyone else
 * already has a balance no stale read could have invented.
 *
 * Returns the names it corrected, and mutates `existing` so a caller that has
 * already captured the array sees the repair too.
 */
export async function repairFromChain(connection, existing, { read = readTokenAccount } = {}) {
  const repaired = [];
  for (const record of existing ?? []) {
    if (BigInt(record.rawTokens ?? '0') > 0n || !record.tokenAccount) continue;
    const held = await read(connection, record.tokenAccount);
    if (held <= 0n) continue;
    record.rawTokens = held.toString();
    record.tokens = (held / 10n ** BigInt(MINT_DECIMALS)).toString();
    record.aboveFloor = held >= MIN_HOLD_RAW;
    repaired.push(record.name);
  }
  return repaired;
}

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

  // Which venue, read from chain and never assumed. This is the gap that broke
  // the tool: it only ever spoke the bonding curve, so against a graduated coin
  // every buy failed with BondingCurveComplete (6005) — and failed *after* the
  // transaction was built and the wallet was already funded. Same fix as G11b
  // in `pump-trade.mjs`, which this should have shared from the start.
  const ammPool = await pump.readAmmPool(args.rpc, mint);
  const graduated = ammPool.exists;

  console.log(`\nCALLPOOL — build the cast by buying ${mint}\n`);
  console.log(`venue      ${graduated ? 'AMM (graduated)' : 'bonding curve'}`);
  if (graduated) console.log(`pool       ${ammPool.pool}`);
  console.log(`floor      ${MIN_HOLD_TOKENS.toLocaleString('en-US')} tokens (${MIN_HOLD_RAW} raw)`);

  const all = roster({
    count: args.count,
    noLegacy: args.noLegacy,
    scenarioSol: args.scenarioSol ? Number(args.scenarioSol) : SCENARIO_SOL,
  });

  // `--only` re-does a subset, keeping everyone else exactly as they are. The
  // floor check below is a first guess against a curve that reprices on every
  // buy, so getting a role's size wrong is expected — and rebuying the whole
  // cast to fix one of them costs SOL the dry faucets cannot replace (F18).
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  let wanted = only ? all.filter((m) => only.has(m.name)) : all;
  if (only && wanted.length !== only.size) {
    const known = all.map((m) => m.name).join(', ');
    throw new Error(`--only names a wallet not in this roster: ${[...only].join(', ')}\nroster: ${known}`);
  }

  const existing = manifest.cast ?? [];

  // Repair the manifest from the chain BEFORE anything reads it to decide who
  // still needs building.
  //
  // `alreadyBuilt` trusts `rawTokens`, and that figure can be wrong in the one
  // direction that costs money: a stale post-confirm read records 0 for a wallet
  // that is holding — fifteen of sixty-four on 2026-08-09, every one of them
  // millions of tokens above the floor. Resuming on that figure re-buys a wallet
  // that already bought, which spends SOL the faucet will not replace and leaves
  // a balance at twice the size the matrix was sized for. So ask the chain about
  // anyone the manifest calls empty, and believe the chain.
  const repaired = args.resume ? await repairFromChain(connection, existing) : [];
  if (repaired.length > 0) {
    manifest.cast = existing;
    writeManifest(manifest);
    console.log(
      `repaired   ${repaired.length} wallet(s) the manifest called empty are holding on chain: ` +
        `${repaired.join(', ')}\n           re-read rather than re-bought`,
    );
  }

  const kept = only
    ? existing.filter((m) => !only.has(m.name))
    : args.resume
      ? existing.filter((m) => alreadyBuilt(existing, m.name))
      : [];

  if (args.resume && !only) {
    const done = wanted.filter((m) => alreadyBuilt(existing, m.name));
    wanted = wanted.filter((m) => !alreadyBuilt(existing, m.name));
    console.log(`resume     ${done.length} already holding, ${wanted.length} to build`);
  }

  if (wanted.length === 0) {
    console.log('\nNothing to do — every wallet in the roster already holds coin.\n');
    return;
  }

  // `--sol` overrides the guess, and only when a single wallet is being redone.
  // Applying one size to a whole roster silently would undo the per-role sizing
  // that puts `minnow` under the floor.
  if (args.sol) {
    if (wanted.length !== 1) {
      throw new Error('--sol changes one wallet\'s buy size, so it needs --only <name>');
    }
    wanted[0].sol = Number(args.sol);
  }

  const gas = args.gas ? Number(args.gas) : GAS_SOL;
  const totalSol = wanted.reduce((sum, m) => sum + m.sol + gas, 0);
  const payerSol = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`wallets    ${wanted.length} to build`);
  console.log(`budget     ~${totalSol.toFixed(4)} SOL of ${payerSol.toFixed(4)} available\n`);
  if (payerSol < totalSol) {
    throw new Error(
      `the payer holds ${payerSol.toFixed(4)} SOL and this needs ~${totalSol.toFixed(4)}. ` +
        'Fund it first — a run that dies halfway leaves the SOL in wallets you then have to sweep.',
    );
  }

  // ── persist every secret BEFORE a single lamport moves ───────────────────
  // Funding first and writing the keypair after the buy stranded **5.03 SOL
  // across 64 wallets** on 2026-08-08: all five funding batches landed, the
  // first AMM buy failed, the process exited, and every secret was still only
  // in memory. The wallets are funded and permanently unreachable.
  //
  // The ordering rule is therefore absolute: a key that controls money exists
  // on disk before the money does. `--resume` only works because of this.
  const wallets = new Map();
  for (const member of wanted) {
    const keypair = Keypair.generate();
    member.keypairPath = writeKeypair(resolve(KEYS_DIR, `${member.name}.json`), keypair);
    wallets.set(member.name, keypair);
  }
  console.log(`keys       ${wanted.length} written to ${KEYS_DIR} before funding\n`);

  // ── fund, in batches ─────────────────────────────────────────────────────
  for (const [index, batch] of fundingBatches(wanted).entries()) {
    const tx = new Transaction();
    for (const member of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: wallets.get(member.name).publicKey,
          lamports: Math.round((member.sol + gas) * LAMPORTS_PER_SOL),
        }),
      );
    }
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log(`funded     batch ${index + 1}: ${batch.map((m) => m.name).join(', ')}`);
  }
  console.log('');

  // ── buy, one wallet at a time ────────────────────────────────────────────
  // Sequential on purpose. Each buy moves the price for the next, and the whole
  // value of this tool is that the balance it records is the one that actually
  // arrived — which cannot be known for a transaction still in flight.
  const cast = [...kept];
  const problems = [];

  for (const member of wanted) {
    const wallet = wallets.get(member.name);
    const spend = BigInt(Math.round(member.sol * LAMPORTS_PER_SOL));

    // Has the curve filled up under us?
    //
    // Every buy pushes the bonding curve toward completion, and completion is
    // **graduation** — after it, the curve refuses with `BondingCurveComplete`
    // (6005 / 0x1775) and the AMM is the only venue. On devnet pump may never
    // migrate (G12), so there is then no venue at all and the run is over: the
    // matrix needs nine buy and top-up steps it can no longer perform.
    //
    // Run 5 completed the curve on its **sixty-fourth** wallet and only found
    // out from the failure. Checking first turns a dead deployment into a
    // stopped build with sixty-three usable wallets and a clear instruction.
    //
    // The threshold is lower than it looks: run 2 measured ~3.9 SOL to
    // complete, run 5 completed at ~2.8. Do not size a cast against a
    // remembered figure — ask the chain.
    if (!graduated) {
      const curve = await pump.readCurveState(args.rpc, mint);
      if (curve.complete) {
        console.log(
          `\n🛑 the bonding curve completed before ${member.name} was built.\n\n` +
            `   ${cast.length} wallet(s) are built and recorded; the rest cannot buy, because a\n` +
            '   completed curve refuses every buy and the AMM pool exists only once pump\n' +
            '   migrates — which on devnet it may never do.\n\n' +
            '   Lower --scenario-sol and build a FRESH coin. Re-running against this one\n' +
            '   cannot work.\n',
        );
        manifest.cast = cast;
        writeManifest(manifest);
        process.exitCode = 1;
        return;
      }
    }

    const buy = graduated
      ? await pump.buildAmmBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), spend.toString())
      : await pump.buildBuyInstructions(args.rpc, mint, wallet.publicKey.toBase58(), spend.toString());

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
    //
    // Read it through `settledBalance`, not `currentBalanceRaw`. The buy above
    // is *confirmed*, but the read that follows can be answered by a node behind
    // the one that confirmed — and on 2026-08-09 that reported **fifteen of
    // sixty-four** wallets as holding nothing, seconds after buys that had in
    // fact landed millions of tokens each. The manifest recorded those zeros as
    // fact, and the scenario driver assigns roles from the manifest, so the
    // whole matrix would have been computed against holdings that were never
    // real. A fresh wallet holds nothing before its buy, so `before` is 0n and
    // any non-zero answer is the settled one.
    const ata = associatedTokenAddress(wallet.publicKey, mint, tokenProgram);
    const held = await settledBalance(connection, ata, 0n);
    const aboveFloor = held >= MIN_HOLD_RAW;

    if (aboveFloor !== member.wantAboveFloor) {
      problems.push(
        `${member.name} wanted ${member.wantAboveFloor ? 'above' : 'below'} the floor but holds ` +
          `${tokens(held).toLocaleString('en-US')} tokens — adjust its --sol and re-run, or the ` +
          'role it is named for is not the role it will play.',
      );
    }

    const keypairPath = member.keypairPath;
    cast.push({
      name: member.name,
      role: member.role,
      scenario: member.scenario === true,
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

    // Written after every buy, not once at the end. A crash at wallet forty
    // must leave thirty-nine recorded and recoverable with `--resume`; the
    // alternative is forty funded wallets nothing knows the keys of.
    manifest.cast = cast;
    writeManifest(manifest);
  }

  console.log('\nmanifest   cast written to epochs/devnet/deployment.json');

  const distributable = await pump.readDistributable(args.rpc, mint);
  console.log(
    `\nfees       ${distributable.distributableFees} accrued against a minimum of ` +
      `${distributable.minimumRequired}` +
      `${distributable.canDistribute ? '  — distributable now' : '  — not yet distributable'}`,
  );

  if (problems.length > 0) {
    console.log(`\n⚠️  ${problems.length} wallet(s) landed on the wrong side of the floor:\n`);
    for (const p of problems) console.log(`  • ${p}`);
    console.log('\nEveryone else is recorded. Re-run with --only <name> --sol <amount>.\n');
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
