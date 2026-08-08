#!/usr/bin/env node
//
// scripts/tools/holders-above-floor.mjs — the candidate list L5's fallback
// needs, and which nothing could produce until now.
//
// pump's callout feed returns only the newest 50 records. When all 50 fall
// inside the window we cannot know whether there were more, so `snapshot.mjs`
// stops trusting the feed and asks pump **per wallet** instead — for every
// wallet that could possibly be eligible. That is L5, and it is the difference
// between settling late and publishing a caller list that is quietly short.
//
// It has always required `--holders <file>`, and **no tool wrote that file**.
// The safety net existed with no way to arm it: on a busy day settlement would
// refuse, `settle-outstanding` would stop at the first failure — correctly —
// and every later epoch would be blocked behind it. Which is precisely the
// wedge everything else this session removed.
//
//   node scripts/tools/holders-above-floor.mjs --rpc <RPC> --out epochs/holders.json
//
// **Be generous, not precise.** This is a *candidate* list: including a wallet
// that turns out to be ineligible costs one API call, while missing one costs
// that person their day. So every account above the floor is included and
// eligibility is decided later, from the ATA, by the snapshot.
//
// It uses `getProgramAccounts`, which providers bill hardest for and which the
// site's RPC proxy refuses outright. That is fine here: the crank talks to its
// own provider directly, and this runs once per settlement, not per visitor.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { PublicKey } from '@solana/web3.js';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { tokenProgramForMint } from '../lib/chain.mjs';
import { fetchConfig } from '../lib/program.mjs';
import { REPO_ROOT } from '../lib/store.mjs';

/**
 * Where `mint`, `owner` and `amount` sit in a token account.
 *
 * SPL Token's layout, and **Token-2022 keeps the same first 165 bytes** and
 * appends extensions after them — so these offsets hold for both and a
 * `dataSize` filter would silently drop every account that has an extension.
 * `create_v2` coins are Token-2022 (G6), so that would drop the real holders.
 */
const MINT_OFFSET = 0;
const OWNER_OFFSET = 32;
const AMOUNT_OFFSET = 64;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, out: 'epochs/holders.json' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Owners holding at least `minHoldRaw`, deduplicated.
 *
 * Pure, so the offsets and the boundary are tested rather than eyeballed — a
 * wrong offset here produces a plausible-looking list of the wrong addresses,
 * which is the failure that would be hardest to notice.
 *
 * @param {{account: {data: Buffer|Uint8Array}}[]} accounts  as getProgramAccounts returns
 * @param {bigint} minHoldRaw
 * @returns {string[]}
 */
export function ownersAboveFloor(accounts, minHoldRaw) {
  const owners = new Set();
  for (const { account } of accounts) {
    const data = Buffer.from(account.data);
    // Anything shorter than the base layout is not a token account.
    if (data.length < AMOUNT_OFFSET + 8) continue;
    const amount = data.readBigUInt64LE(AMOUNT_OFFSET);
    // `>=` because the floor is inclusive: holding exactly the minimum counts.
    if (amount < minHoldRaw) continue;
    owners.add(new PublicKey(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)).toBase58());
  }
  return [...owners];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const mint = config.mint;
  const tokenProgram = await tokenProgramForMint(connection, mint);

  console.log(`\nCALLPOOL — holders above the floor\n`);
  console.log(`mint          ${mint.toBase58()}`);
  console.log(`token program ${tokenProgram.toBase58()}   (asked the chain, never assumed — G6)`);
  console.log(`floor         ${config.minHold} raw units`);

  const accounts = await connection.getProgramAccounts(tokenProgram, {
    // No `dataSize` filter, deliberately: Token-2022 accounts carrying an
    // extension are longer than 165 bytes and would be dropped by one.
    filters: [{ memcmp: { offset: MINT_OFFSET, bytes: mint.toBase58() } }],
  });

  const owners = ownersAboveFloor(accounts, config.minHold);
  console.log(`accounts      ${accounts.length} for this mint`);
  console.log(`above floor   ${owners.length} owner(s)`);

  const out = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(owners, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
  console.log('Pass it to a settlement that hit a truncated feed:');
  console.log(`  node scripts/snapshot.mjs --epoch <N> --holders ${args.out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nHOLDERS ABOVE FLOOR FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
