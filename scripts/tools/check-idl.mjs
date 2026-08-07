#!/usr/bin/env node
//
// scripts/tools/check-idl.mjs — pin the hand-built instructions to the program.
//
//   node scripts/tools/check-idl.mjs target/idl/callpool.json
//
// `scripts/lib/program.mjs` encodes Anchor instructions by hand, deliberately:
// it is what lets a stranger reproduce an epoch with `web3.js` and nothing
// else. The cost of that choice is a second copy of the account layout, in a
// different language, that no compiler ever compares with the first.
//
// The failure it invites is not a crash. Swap two accounts in a Rust struct and
// the JS still builds a transaction, still signs it, still sends it — and
// Anchor rejects it at runtime with a constraint error that names neither
// change. Or worse, both accounts satisfy each other's constraints and it
// simply does the wrong thing. `verify.sh` already asserts that the *set* of
// instructions has not changed; this asserts that their *shapes* have not.
//
// Checked per instruction: the discriminator, the account count, the order of
// account names, and which of them sign.
//
// **Writability is checked in one direction only.** An account the IDL calls
// read-only may still be marked writable by the client — the fee payer always
// is, and Anchor enforces `mut` requirements rather than their absence. What
// must never happen is the reverse: an account the program will write to,
// passed as read-only, fails at runtime for a reason the message does not give.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PublicKey } from '@solana/web3.js';

import {
  claimIx, createPoolIx, initializeIx, postEpochRootIx, sweepWsolIx,
} from '../lib/program.mjs';

const SOME = new PublicKey('4yoTWJ4Hdxy8kRiiA2CJ4netQGkDhvmnbvLeQS4CKYsn');
const MINT = new PublicKey('CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK').toBase58();

/**
 * One representative instruction per builder, with the account names the IDL
 * uses in the order the Rust struct declares them.
 *
 * The names are written out rather than derived so that a *rename* in the
 * program is caught too — a renamed account is usually a repurposed one.
 */
const BUILDERS = {
  create_pool: {
    build: () => createPoolIx({ payer: SOME }),
    accounts: ['payer', 'pool', 'system_program'],
  },
  initialize: {
    build: () =>
      initializeIx({
        payer: SOME, mint: MINT, genesisTs: 1_754_265_600, epochSeconds: 86_400,
        minHold: 100_000_000_000n, challengeSeconds: 86_400, snapshotKey: SOME,
      }),
    accounts: ['payer', 'config', 'pool', 'mint', 'system_program'],
  },
  post_epoch_root: {
    build: () =>
      postEpochRootIx({
        snapshotKey: SOME, mint: MINT, epoch: 1, root: Buffer.alloc(32, 7),
        leafCount: 3, allocate: 2_499_104_119n,
      }),
    accounts: ['snapshot_key', 'config', 'pool', 'epoch_account', 'system_program'],
  },
  claim: {
    build: () =>
      claimIx({
        submitter: SOME, mint: MINT, recipient: SOME, recipientTokenAccount: SOME,
        epoch: 1, index: 0, amount: 1n, proof: [],
      }),
    accounts: [
      'submitter', 'config', 'pool', 'epoch_account', 'recipient', 'mint',
      'recipient_token_account', 'token_program', 'system_program',
    ],
  },
  sweep_wsol: {
    build: () => sweepWsolIx({ caller: SOME }),
    accounts: [
      'caller', 'config', 'pool', 'wsol_mint', 'pool_wsol', 'token_program',
      'associated_token_program',
    ],
  },
};

/**
 * On chain, with no client builder — deliberately, and recorded rather than
 * silently absent.
 *
 * `close_epoch` reclaims an epoch's unclaimed lamports into the pool after the
 * claim deadline, and it is permissionless. Nothing in this repository sends it
 * yet, because no epoch has been open long enough for it to be legal. When one
 * is, it needs a builder here and an entry above — and this list is what makes
 * that a decision somebody took rather than something nobody noticed.
 */
const UNBUILT = {
  close_epoch: 'permissionless, and not reachable until an epoch passes its claim deadline',
};

/**
 * Compare one builder against the IDL.
 *
 * Returns problems rather than throwing, so a run reports every mismatch at
 * once. Finding the second one after fixing the first is a slow way to learn
 * that a struct was reordered.
 */
export function checkInstruction(name, idlIx, { build, accounts }) {
  const problems = [];
  if (!build) return [`${name}: no client builder — it exists on chain and cannot be sent from here`];

  const ix = build();

  if (!Buffer.from(idlIx.discriminator).equals(ix.data.subarray(0, 8))) {
    problems.push(
      `${name}: discriminator is ${JSON.stringify([...ix.data.subarray(0, 8)])}, ` +
        `the program's is ${JSON.stringify(idlIx.discriminator)}`,
    );
  }

  const idlNames = idlIx.accounts.map((a) => a.name);
  if (idlNames.length !== ix.keys.length) {
    problems.push(`${name}: ${ix.keys.length} accounts passed, the program declares ${idlNames.length}`);
  }
  if (JSON.stringify(idlNames) !== JSON.stringify(accounts)) {
    problems.push(
      `${name}: the account list changed\n` +
        `    program  ${idlNames.join(', ')}\n` +
        `    expected ${accounts.join(', ')}`,
    );
  }

  for (let i = 0; i < Math.min(idlIx.accounts.length, ix.keys.length); i++) {
    const declared = idlIx.accounts[i];
    const passed = ix.keys[i];
    if (!!declared.signer !== passed.isSigner) {
      problems.push(
        `${name}: account ${i} (${declared.name}) — program says signer=${!!declared.signer}, ` +
          `client passes ${passed.isSigner}`,
      );
    }
    // One direction only: see the header. A `mut` account passed read-only is
    // a runtime failure; the reverse is the fee payer and is fine.
    if (declared.writable && !passed.isWritable) {
      problems.push(
        `${name}: account ${i} (${declared.name}) is written by the program but passed read-only`,
      );
    }
  }

  return problems;
}

function main() {
  const path = resolve(process.argv[2] ?? 'target/idl/callpool.json');
  const idl = JSON.parse(readFileSync(path, 'utf8'));

  const problems = [];
  for (const [name, spec] of Object.entries(BUILDERS)) {
    const idlIx = idl.instructions.find((i) => i.name === name);
    if (!idlIx) {
      problems.push(`${name}: not in the IDL — the instruction was renamed or removed`);
      continue;
    }
    problems.push(...checkInstruction(name, idlIx, spec));
  }

  // The other direction: an instruction the program has that nothing here knows
  // how to build, and that nobody has written down a reason for.
  for (const idlIx of idl.instructions) {
    if (!BUILDERS[idlIx.name] && !UNBUILT[idlIx.name]) {
      problems.push(
        `${idlIx.name}: the program has it, nothing here builds it, and no reason is recorded`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) between the program and its JS client:\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  console.log(
    `  ok  ${Object.keys(BUILDERS).length} instruction layouts match the IDL` +
      ` (${Object.keys(UNBUILT).join(', ')} intentionally unbuilt)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
