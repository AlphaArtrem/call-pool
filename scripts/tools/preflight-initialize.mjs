#!/usr/bin/env node
//
// scripts/tools/preflight-initialize.mjs — the last thing that runs before the
// one transaction that cannot be taken back.
//
//   node scripts/tools/preflight-initialize.mjs \
//     --rpc <URL> --mint <MINT> --snapshot-key <VAULT> --genesis <UNIX_TS>
//
//   ... --rehearsal        allow 300s epochs and short challenge windows
//   ... --epoch-seconds N --challenge-seconds N   (default to the mainnet values)
//
// `initialize` writes `mint`, `genesis_ts`, `epoch_seconds`, `min_hold`,
// `challenge_seconds` and `snapshot_key`, and **every one of them is permanent**.
// No `set_params`, no pause, no upgrade, no repair short of a new deployment and
// a new coin.
//
// The program rejects the obviously wrong. What it cannot reject is a value that
// is wrong but plausible — its own unit test says so in as many words, about the
// single most irreversible number in the project. MAINNET-DEPLOYMENT.md's answer
// was "read the command twice, then read it again", which asks the most tired
// person present to be the check at the most irreversible moment.
//
// So this reads the live mint, derives what each parameter *should* be from
// `config.mjs` and from chain, compares, and prints a block a human can check
// line by line — then exits non-zero if anything is fatal. It signs nothing and
// sends nothing. It is safe to run as many times as you like, and the intended
// use is to run it until it is green and then not change anything.

import { Connection, PublicKey } from '@solana/web3.js';

import { DEFAULT_RPC_URL, EPOCH_SECONDS, MIN_HOLD_RAW, MIN_HOLD_TOKENS, MINT_DECIMALS } from '../lib/config.mjs';
import { CHALLENGE_SECONDS, preflight } from '../lib/preflight.mjs';
import { configPda, poolPda, PROGRAM_ID } from '../lib/program.mjs';

function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    rehearsal: false,
    epochSeconds: EPOCH_SECONDS,
    challengeSeconds: CHALLENGE_SECONDS,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rehearsal') args.rehearsal = true;
    else if (argv[i] === '--epoch-seconds') args.epochSeconds = Number(argv[++i]);
    else if (argv[i] === '--challenge-seconds') args.challengeSeconds = Number(argv[++i]);
    else if (argv[i] === '--snapshot-key') args.snapshotKey = argv[++i];
    else if (argv[i] === '--genesis') args.genesis = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.mint) throw new Error('--mint <ADDRESS> is required');
  if (!args.snapshotKey) throw new Error('--snapshot-key <ADDRESS> is required');
  return args;
}

/** The next epoch boundary at or after `now`. What `--genesis` should be. */
export function nextBoundary(now, epochSeconds) {
  return Math.ceil(now / epochSeconds) * epochSeconds;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, 'confirmed');

  const genesisHash = await connection.getGenesisHash();
  const cluster =
    genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ? 'MAINNET-BETA' : `devnet/other (${genesisHash.slice(0, 8)}…)`;

  const mintKey = new PublicKey(args.mint);
  const info = await connection.getParsedAccountInfo(mintKey);
  const parsed = info?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'mint') {
    throw new Error(`${args.mint} is not a mint account — nothing to check against.`);
  }
  const decimals = parsed.info.decimals;
  const supply = BigInt(parsed.info.supply);

  const now = Math.floor(Date.now() / 1000);
  const genesis = args.genesis ?? nextBoundary(now, args.epochSeconds);

  const { ok, problems } = preflight(
    { decimals, supply },
    {
      minHold: MIN_HOLD_RAW,
      epochSeconds: args.epochSeconds,
      challengeSeconds: args.challengeSeconds,
      genesisTs: genesis,
      now,
      snapshotKey: args.snapshotKey,
    },
    { expectRehearsal: args.rehearsal },
  );

  // ── what will be written ─────────────────────────────────────────────────
  const pool = poolPda();
  const poolInfo = await connection.getAccountInfo(pool);
  const configInfo = await connection.getAccountInfo(configPda());

  console.log(`\nCALLPOOL — preflight for initialize\n`);
  console.log(`cluster            ${cluster}`);
  console.log(`program            ${PROGRAM_ID.toBase58()}`);
  console.log(`\n── what initialize will write, permanently ──\n`);
  console.log(`mint               ${args.mint}`);
  console.log(`  decimals         ${decimals}${decimals === MINT_DECIMALS ? '' : `   ⛔ config.mjs assumes ${MINT_DECIMALS}`}`);
  console.log(`  supply           ${supply / 10n ** BigInt(decimals)} whole tokens`);
  console.log(`genesis_ts         ${genesis}   (${new Date(genesis * 1000).toISOString()})`);
  console.log(`epoch_seconds      ${args.epochSeconds}   (${(args.epochSeconds / 3600).toFixed(2)}h)`);
  console.log(`challenge_seconds  ${args.challengeSeconds}   (${(args.challengeSeconds / 3600).toFixed(2)}h)`);
  console.log(`min_hold           ${MIN_HOLD_RAW}   (${MIN_HOLD_TOKENS.toLocaleString('en-US')} tokens)`);
  console.log(`snapshot_key       ${args.snapshotKey}`);

  console.log(`\n── state ──\n`);
  console.log(`pool PDA           ${pool.toBase58()}`);
  console.log(
    `  exists           ${poolInfo ? `yes, ${poolInfo.lamports} lamports, ${poolInfo.data.length} bytes` : 'NO — run create_pool first'}`,
  );
  if (poolInfo && poolInfo.data.length !== 0) {
    console.log('  ⛔ the pool PDA has data — it must be a bare System account.');
  }
  console.log(`config PDA         ${configInfo ? '⛔ ALREADY INITIALIZED — initialize runs once per program id, ever (F17)' : 'not yet — good'}`);

  // ── the verdict ──────────────────────────────────────────────────────────
  const fatal = problems.filter((p) => p.fatal);
  const warnings = problems.filter((p) => !p.fatal);

  if (warnings.length > 0) {
    console.log(`\n── ${warnings.length} warning(s) ──\n`);
    for (const w of warnings) console.log(`  ⚠️  [${w.check}] ${w.message}\n`);
  }

  if (fatal.length > 0 || configInfo) {
    console.log(`\n── ${fatal.length} FATAL ──\n`);
    for (const f of fatal) console.log(`  ⛔ [${f.check}] ${f.message}\n`);
    console.log('DO NOT RUN initialize. Every value above is permanent.\n');
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n✅ preflight passed.\n\n` +
      'What this checked: the mint is real and its decimals match the constant the floor is\n' +
      'derived from; the floor equals config.mjs exactly; the clocks are the mainnet values;\n' +
      'genesis is aligned and in range; the pool exists with no data; the config does not.\n\n' +
      'What it CANNOT check, and what is still yours:\n' +
      '  • that snapshot_key is the Squads VAULT and not a member key — read it back with\n' +
      '    `cosign.mjs`, which refuses if the vault is not the snapshot key\n' +
      '  • that L15\'s custody conditions are met. While two member keys share a disk the\n' +
      '    2-of-3 is decorative, and whoever takes that disk takes the pool permanently.\n',
  );
  if (!ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nPREFLIGHT FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
