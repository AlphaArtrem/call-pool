#!/usr/bin/env node
//
// scripts/tools/mock-sale.mjs — make one of the cast wallets sell.
//
// The lockout is the mechanic's whole load-bearing rule and the only way to see
// it is for a wallet to actually move tokens out. This is that, on demand:
//
//   node scripts/tools/mock-sale.mjs --wallet dumper
//   node scripts/tools/mock-sale.mjs --wallet dumper --tokens 1
//   node scripts/tools/mock-sale.mjs --wallet steady --buy 200000
//
// A sale here is a transfer out, and that is the entire definition (L6): the
// destination is irrelevant, self-transfers count, and rebuying does not
// shorten anything. `--buy` mints tokens back so a wallet can be walked all the
// way round the cycle — eligible → sells → locked out → eligible again — which
// is what the website's wallet check is for.

import { connect } from '../lib/rpc.mjs';
import { getOrCreateAssociatedTokenAccount, mintTo, transfer } from '@solana/spl-token';

import { DEFAULT_RPC_URL, MINT_DECIMALS } from '../lib/config.mjs';
import { fetchConfig } from '../lib/program.mjs';
import { assertNotMainnet, loadKeypair, readManifest } from './devnet.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!args.wallet) throw new Error('--wallet <NAME> is required — one of the names in the manifest');
  return args;
}

const raw = (tokens) => BigInt(tokens) * 10n ** BigInt(MINT_DECIMALS);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = connect(args.rpc);
  await assertNotMainnet(connection, 'mock-sale.mjs');

  const manifest = readManifest();
  const member = manifest.cast.find((m) => m.name === args.wallet);
  if (!member) {
    throw new Error(
      `no cast member named ${args.wallet}. The manifest has: ` +
        manifest.cast.map((m) => m.name).join(', '),
    );
  }

  const config = await fetchConfig(connection);
  const mint = config.mint;
  const payer = loadKeypair(manifest.payer.keypair);
  const wallet = loadKeypair(member.keypair);

  const before = BigInt((await connection.getTokenAccountBalance(
    (await getOrCreateAssociatedTokenAccount(connection, payer, mint, wallet.publicKey)).address,
  )).value.amount);

  if (args.buy) {
    // Minted rather than bought from anyone: there is no market on devnet, and
    // an increase is an increase as far as every rule here is concerned.
    const amount = raw(args.buy);
    const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, wallet.publicKey))
      .address;
    const signature = await mintTo(connection, payer, mint, ata, payer, amount);
    console.log(`\n${member.name} bought ${Number(args.buy).toLocaleString('en-US')} tokens`);
    console.log(`  ${before} → ${before + amount} raw`);
    console.log(`  ${signature}\n`);
    console.log('Buying does not clear a lockout, and it does not repair today’s trough.\n');
    return;
  }

  // Default: sell almost everything, which is what makes the collapse to the
  // trough and the lockout both visible in one move.
  const amount = args.tokens === undefined ? (before * 999n) / 1000n : raw(args.tokens);
  if (amount <= 0n || amount > before) {
    throw new Error(`${member.name} holds ${before} raw units; cannot send ${amount}`);
  }

  const source = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, wallet.publicKey))
    .address;
  const sink = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey))
    .address;
  const signature = await transfer(connection, payer, source, sink, wallet, amount);

  console.log(`\n${member.name} sold ${amount} raw units`);
  console.log(`  ${before} → ${before - amount} raw`);
  console.log(`  ${signature}`);
  console.log(
    `\nFrom now until 7 epochs after this one closes, ${member.name} earns nothing — and ` +
      'today’s hold is already the trough, so today is lost regardless.\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
