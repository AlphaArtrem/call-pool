#!/usr/bin/env node
//
// scripts/tools/tamper-test.mjs — hand the co-signer a lie and watch it refuse.
//
// The 2026-08-07 rehearsal never ran this, and it is the gap that mattered:
// signer B was observed **succeeding** at byte-comparison for every epoch, and
// refusing fifteen epochs on a *different* check. "It always agreed" and "it
// verifies" are the same observation until something false is put in front of
// it.
//
//   node scripts/tools/tamper-test.mjs --epoch 12 --multisig <ADDRESS>
//   ... --base http://<crank host>:8100   # fetch the published inputs first
//   ... --keep                            # leave the corrupted copy in place
//
// **This needs no signing key and cannot sign anything.** It drives
// `cosign.mjs --dry-run`, which runs the reproduction *before* it looks at
// whether it was asked to sign — so a refusal happens with no key present and
// an acceptance approves nothing. That is what makes this safe to run against
// the live crank host rather than only in a rehearsal.
//
// What it does, in order:
//
//   1. copy the epoch's published directory aside, untouched
//   2. run cosign --dry-run on the honest copy — it MUST accept, or the test
//      proves nothing about the tamper
//   3. corrupt tree.json — one extra leaf, paying an address that called out
//      for nothing
//   4. run cosign --dry-run again — it MUST refuse
//   5. put the honest directory back
//
// Step 2 is not ceremony. A co-signer that refuses everything — a wrong
// --multisig, an unreachable RPC, a stale directory — also "refuses the
// tamper", and would pass a test that only checked step 4. The pair is the
// evidence; either half alone is not.
//
// ⚠️ The corrupted directory is written into the real `snapshots/` tree,
// because that is where `cosign.mjs` reads from and pointing it elsewhere would
// test a different code path than the one that runs in production. The original
// is restored on the way out, including after a failure. If this is interrupted
// hard, restore it by hand from `<dir>.honest` — the path is printed on entry.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { REPO_ROOT, snapshotDir } from '../lib/store.mjs';
import { fetchEpochInputs } from './cosign-remote.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') args.keep = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.epoch === undefined) throw new Error('--epoch N is required');
  if (!args.multisig) throw new Error('--multisig <ADDRESS> is required — cosign.mjs checks it against the config');
  return args;
}

/**
 * Run the co-signer exactly as the timer runs it, minus the ability to sign.
 *
 * `--dry-run` is not a weaker check. `cosign.mjs` reproduces the epoch and
 * compares the proposal before it reads whether it was given a key, so the
 * decision under test is the same decision — it simply stops before acting on
 * it.
 */
export function runCosign({ epoch, rpc, multisig }) {
  const result = spawnSync(
    'node',
    [resolve(REPO_ROOT, 'scripts/cosign.mjs'), '--epoch', String(epoch), '--rpc', rpc,
      '--multisig', multisig, '--dry-run'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * The corruption: one extra leaf, paying an address nobody has ever seen.
 *
 * Deliberately the crudest possible attack. If the co-signer misses this one
 * there is no point testing a subtle one, and a random keypair makes the payee
 * unmistakably not a wallet that called out — nobody can argue it was owed.
 */
export function corruptTree(dir, payee = Keypair.generate().publicKey.toBase58()) {
  const path = resolve(dir, 'tree.json');
  const tree = JSON.parse(readFileSync(path, 'utf8'));
  const tampered = {
    ...tree,
    leafCount: tree.leafCount + 1,
    leaves: [...tree.leaves, { index: tree.leaves.length, owner: payee, amount: '1000000000', proof: [] }],
  };
  writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
  return payee;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = Number(args.epoch);
  const dir = snapshotDir(epoch);
  const honest = `${dir}.honest`;

  console.log('\nCALLPOOL — tamper test\n');
  console.log(`epoch      ${epoch}`);
  console.log(`directory  ${dir}`);

  if (args.base) {
    console.log(`fetching   ${args.base}`);
    await fetchEpochInputs({ base: args.base, epoch });
  }
  if (!existsSync(resolve(dir, 'tree.json'))) {
    throw new Error(
      `no published snapshot at ${dir}. Pass --base <URL> to fetch it from the crank host, ` +
        'or run this on a host that already has it.',
    );
  }

  // Kept outside the try: if the copy itself fails there is nothing to restore
  // and the finally below must not delete a directory it never saved.
  if (existsSync(honest)) rmSync(honest, { recursive: true });
  cpSync(dir, honest, { recursive: true });
  console.log(`backup     ${honest}\n`);

  let verdict = 1;
  try {
    // ── 1. the control ─────────────────────────────────────────────────────
    console.log('── the honest snapshot ────────────────────────────────────────');
    const before = runCosign({ epoch, rpc: args.rpc, multisig: args.multisig });
    if (before.status !== 0) {
      console.log(before.output);
      throw new Error(
        'the co-signer refused the HONEST snapshot, so this test can prove nothing about the ' +
          'tampered one. Something else is wrong — a wrong --multisig, an unreachable RPC, a ' +
          'stale directory, or an epoch that already has a root. Fix that first.',
      );
    }
    console.log('✔ accepted, as it must be for the rest of this to mean anything\n');

    // ── 2. the tamper ──────────────────────────────────────────────────────
    const payee = corruptTree(dir);
    console.log('── one extra leaf, paying an address that called out for nothing ──');
    console.log(`payee      ${payee}`);
    console.log('amount     1000000000 lamports\n');

    const after = runCosign({ epoch, rpc: args.rpc, multisig: args.multisig });
    console.log(after.output);

    if (after.status === 0) {
      console.log(
        '🔴 THE CO-SIGNER ACCEPTED A TAMPERED SNAPSHOT.\n\n' +
          '   The 2-of-3 is a 1-of-3 wearing a costume: whoever owns the crank host owns both\n' +
          '   approvals. Do not launch. Do not deploy. This is the failure the second signer\n' +
          '   exists to prevent, and it is not working.\n',
      );
    } else {
      console.log(
        '✅ REFUSED.\n\n' +
          '   The co-signer reproduced the epoch from its published inputs, got a different\n' +
          '   root, and declined — with no key involved and nothing signed. "It independently\n' +
          '   re-derives" is now an observation rather than a claim.\n',
      );
      verdict = 0;
    }
  } finally {
    // Restore even on the throw above. A tampered directory left behind in the
    // published tree is a corrupted audit trail and a co-signer that refuses
    // this epoch forever, and neither says why.
    rmSync(dir, { recursive: true, force: true });
    cpSync(honest, dir, { recursive: true });
    if (!args.keep) rmSync(honest, { recursive: true, force: true });
    console.log(`restored   ${dir}${args.keep ? ` (backup kept at ${honest})` : ''}\n`);
  }

  process.exitCode = verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nTAMPER TEST FAILED TO RUN: ${error.message}\n`);
    process.exitCode = 1;
  });
}
