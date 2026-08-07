#!/usr/bin/env node
//
// scripts/tools/mk-multisig.mjs — create the 2-of-3 for a rehearsal.
//
// The layout from §5.5a: signers A and B automated on two hosts, C cold. This
// creates the Squads multisig holding those three as members with a threshold
// of 2, and prints the **vault address** — which is what
// `deploy-devnet.mjs --snapshot-key` binds into the config, and what
// `initialize` will be given on mainnet.
//
// Usage:
//   node scripts/tools/mk-multisig.mjs --payer <KEY> \
//        --members <A_PUBKEY,B_PUBKEY,C_PUBKEY> --rpc http://127.0.0.1:8899
//
// **Members are addresses, and a keypair file is accepted only as a
// convenience.** Creating a multisig needs the members' public keys and nothing
// else — no member signs its own creation. Requiring three secret files forced
// all three onto one machine for the length of the command, which is precisely
// the arrangement a 2-of-3 exists to prevent and precisely what L15 records as
// the accepted-but-expiring risk. Passing pubkeys means signer B's secret can
// stay on box B and C's can stay offline, which is what mainnet has to do.
//
// ⚠️ Rehearsal tooling. **Devnet or a local validator only, and it checks.**
// The real mainnet multisig should be created through the Squads UI by the
// people who will hold the keys, so that no single machine ever sees more than
// one member's secret — which is the entire point of a 2-of-3. This exists to
// prove the *path*, not to hold real funds.

import { readFileSync } from 'node:fs';

import { existsSync } from 'node:fs';

import { Keypair, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { assertNotMainnet } from './devnet.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, threshold: '2' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.payer) throw new Error('--payer <PATH> is required');
  if (!args.members) throw new Error('--members <A.json,B.json,C.json> is required');
  return args;
}

const load = (path) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

/**
 * A member, from an address or from a keypair file.
 *
 * The file form stays because a local-validator run generates three keys and
 * has them all to hand anyway. The address form is what a real deployment uses,
 * and it is the one that lets each secret stay where it belongs.
 */
export function memberPubkey(spec) {
  const trimmed = spec.trim();
  if (trimmed.endsWith('.json') || existsSync(trimmed)) return load(trimmed).publicKey;
  try {
    return new PublicKey(trimmed);
  } catch {
    throw new Error(
      `--members entry ${JSON.stringify(trimmed)} is neither a base58 address nor a ` +
        'readable keypair file.',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mk-multisig.mjs');

  const payer = load(args.payer);
  const members = args.members.split(',').map(memberPubkey);
  const threshold = Number(args.threshold);

  const unique = new Set(members.map((k) => k.toBase58()));
  if (unique.size !== members.length) {
    throw new Error(
      `${members.length} members but only ${unique.size} distinct addresses. A multisig with a ` +
        'repeated member has a lower real threshold than it claims.',
    );
  }

  if (members.length < threshold) {
    throw new Error(`threshold ${threshold} needs at least that many members`);
  }

  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda,
  );

  await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator: payer,
    multisigPda,
    configAuthority: null,
    timeLock: 0,
    threshold,
    rentCollector: null,
    treasury: programConfig.treasury,
    members: members.map((k) => ({
      key: k,
      permissions: multisig.types.Permissions.all(),
    })),
    sendOptions: { skipPreflight: true },
  });

  // Squads confirms the create before the account is readable at some RPCs.
  await new Promise((r) => setTimeout(r, 1500));

  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });

  console.log('\nCALLPOOL — rehearsal multisig created\n');
  console.log(`multisig   ${multisigPda.toBase58()}`);
  console.log(`vault      ${vault.toBase58()}`);
  console.log(`threshold  ${account.threshold} of ${account.members.length}`);
  for (const [i, m] of account.members.entries()) {
    console.log(`  member ${i}  ${m.key.toBase58()}`);
  }
  console.log('\nNext:');
  console.log(`  node scripts/tools/deploy-devnet.mjs --snapshot-key ${vault.toBase58()} …`);
  console.log(`  node scripts/cosign.mjs --epoch N --multisig ${multisigPda.toBase58()} --keypair <member>\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
