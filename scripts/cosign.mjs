#!/usr/bin/env node
//
// scripts/cosign.mjs — post a root through the 2-of-3 multisig (§5.5a).
//
// `config.snapshot_key` is not a keypair. It is the **vault address of a Squads
// multisig**, and `post_epoch_root` is executed *through* that multisig, which
// signs as the vault. The program knows nothing about any of this: its
// `signer == config.snapshot_key` check is unchanged and the instruction set
// stays at six.
//
//   signer A   automated, host 1   ─┐  normal operation: A proposes, B approves,
//   signer B   automated, host 2   ─┘  and whoever is second executes
//   signer C   cold, offline          recovery only; never runs this
//
// Usage:
//   node scripts/cosign.mjs --epoch 12 --keypair <MEMBER> --multisig <ADDRESS>
//   ... --execute            # also execute once the threshold is met
//   ... --dry-run            # verify and print, sign nothing
//   ... --callout-store <PATH>   # corroborate callers against our own capture
//
// **This script's job is to refuse.** An automated co-signer that approves
// whatever it is handed is a 1-of-3 wearing a costume: an attacker who owns
// host 1 proposes a root paying themselves, and host 2 rubber-stamps it. So
// before it approves anything it (a) reproduces the epoch from its own
// published inputs with `verify-epoch.mjs --recheck-chain`, (b) rebuilds the
// instruction byte for byte and compares it with what the proposal actually
// contains, and (c) with `--callout-store`, checks the epoch's credited callers
// against its OWN independent capture of pump.fun's feed. Any check failing is
// a refusal, loudly, with the transaction left unapproved for a human.
//
// The second check is the one that matters most and the easy one to skip. A
// proposal is a blob in someone else's account; "it is for epoch 12" is not
// something you can read off it safely. The only safe statement is "the bytes
// in this proposal are the bytes I derived myself".
//
// The third exists because (a) and (b) together still trust box A about one
// thing. Reproducing an epoch proves the root follows from the published
// inputs; it cannot prove the inputs are real. `callouts.json` is the single
// value in this system that no amount of chain reading can check (§5.1), so an
// attacker owning box A could fabricate a capture naming wallets they control —
// each holding `min_hold`, which is buyable — and the epoch would reproduce
// perfectly and recheck perfectly against chain. `--callout-store` points this
// at a feed capture box B polled itself, and a wallet credited here but never
// seen there is a refusal. See `lib/corroborate.mjs` for what that can and
// cannot say; it is not a total defence and the limits are written down.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
// Namespace import: the package is CJS and exposes no default export, so
// `import multisig from` silently yields undefined under ESM interop.
import * as multisig from '@sqds/multisig';

import { connect } from './lib/rpc.mjs';
import { DEFAULT_RPC_URL } from './lib/config.mjs';
import { corroborateCallouts } from './lib/corroborate.mjs';
import { fetchConfig, fetchEpoch, poolAvailable, postEpochRootIx } from './lib/program.mjs';
import { readJson, REPO_ROOT, snapshotDir } from './lib/store.mjs';

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, execute: false, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') args.execute = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--yes') args.yes = true;
    // Named explicitly: the generic branch below would store this as
    // `callout-store`, and the corroboration would then silently never run —
    // which is the one failure mode this check must not have.
    else if (argv[i] === '--callout-store') args.calloutStore = argv[++i];
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (args.epoch === undefined) throw new Error('--epoch N is required');
  if (!args.multisig) {
    throw new Error(
      '--multisig <ADDRESS> is required. It is checked against the on-chain ' +
        'config: this refuses to run if its vault is not the snapshot key.',
    );
  }
  if (!args.keypair && !args.dryRun) throw new Error('--keypair <PATH> is required');
  return args;
}

const loadKeypair = (path) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

/**
 * Read the root this epoch's published snapshot claims.
 *
 * From the directory, not from chain and not from an argument — the whole point
 * is that this signer derives the instruction from the same public inputs a
 * stranger would, so that agreeing with the proposer means something.
 */
function publishedRoot(dir) {
  const text = readFileSync(resolve(dir, 'root.txt'), 'utf8');
  const field = (name) => {
    const match = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (!match) throw new Error(`root.txt has no ${name}`);
    return match[1].trim();
  };
  return {
    root: Buffer.from(field('root'), 'hex'),
    leafCount: Number(field('leaf_count')),
    allocate: BigInt(field('allocate')),
  };
}

/** Reproduce the epoch independently. A non-zero exit is a refusal to sign. */
function reproduce(epoch, rpc) {
  console.log(`\n── reproducing epoch ${epoch} before signing anything ──\n`);
  const result = spawnSync(
    'node',
    [
      resolve(REPO_ROOT, 'scripts/verify-epoch.mjs'),
      '--epoch', String(epoch),
      '--rpc', rpc,
      '--recheck-chain',
      '--allow-unposted',
    ],
    { stdio: 'inherit', cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(
      `epoch ${epoch} does not reproduce from its published inputs — NOT signing. ` +
        'This is the co-signer doing its job; do not override it.',
    );
  }
}

/**
 * Refuse an epoch directory that belongs to a different coin.
 *
 * Cheap, and it closes the one way a *correct* epoch can still be the wrong
 * one. Everything else here asks "does this reproduce?"; nothing asked "is this
 * ours?", and epoch directories are named by index, which every deployment
 * reuses from 0.
 */
export function assertSameCoin(epoch, mint, dir = snapshotDir(epoch)) {
  const callouts = readJson(resolve(dir, 'callouts.json'));
  if (callouts.mint && callouts.mint !== mint) {
    throw new Error(
      `epoch ${epoch}'s published inputs are for ${callouts.mint}, but this program is bound to ` +
        `${mint} — NOT signing.\n` +
        '  An epoch directory left over from an earlier deployment sits at the same path this\n' +
        '  one wants, because epochs are named by index and every deployment counts from 0.\n' +
        '  Delete the stale directory; do not settle it.',
    );
  }
}

/**
 * Check the epoch's credited callers against our own capture of the feed.
 *
 * The third refusal, and the only one that looks outside what box A published.
 * Skipped when no store is configured — but skipped *loudly*, because a check
 * that quietly does nothing is worse than one that was never written: it makes
 * the topology look stronger than it is on every log line that omits it.
 *
 * A refusal here is expected to be transient. Box B polls every minute and this
 * runs every minute, so the usual cause — a store that has not yet caught up
 * past the window's end — clears itself on the next tick without anyone being
 * woken up.
 */
function corroborate(epoch, storePath) {
  if (!storePath) {
    console.log(
      '\ncallouts     NOT CORROBORATED — no --callout-store given.\n' +
        '             This signer is checking that the root follows from box A\'s inputs, not\n' +
        '             that those inputs are real. callouts.json cannot be re-derived from chain,\n' +
        '             so without an independent capture a compromised box A can fabricate\n' +
        '             callers and this will approve them. Point --callout-store at a store this\n' +
        '             host polled itself.',
    );
    return;
  }

  const published = readJson(resolve(snapshotDir(epoch), 'callouts.json'));
  const ownStore = readJson(resolve(storePath), { mint: null, updatedAt: 0, callouts: {} });

  if (ownStore.mint && published.mint && ownStore.mint !== published.mint) {
    throw new Error(
      `this host's callout store holds records for ${ownStore.mint}, but epoch ${epoch} is for ` +
        `${published.mint}. Corroborating one coin's callers against another's capture would ` +
        'be worse than not corroborating at all — NOT signing.',
    );
  }

  const result = corroborateCallouts({
    published,
    ownStore,
    window: published.window,
  });

  console.log(
    `\ncallouts     ${result.credited.length} credited, ` +
      `${result.credited.length - result.unverified.length} corroborated by this host's own poll` +
      `${result.truncated ? ' (feed was TRUNCATED here — check degraded)' : ''}`,
  );
  if (result.missed.length > 0) {
    // Not a refusal. Box A holding more than we do is the ordinary shape of a
    // poll race, and the direction that costs a caller their day rather than
    // paying an attacker. Worth printing so a persistent pattern is visible.
    console.log(
      `             note: ${result.missed.length} wallet(s) we saw are NOT credited — ` +
        `${result.missed.slice(0, 5).join(', ')}${result.missed.length > 5 ? ', …' : ''}`,
    );
  }

  if (!result.ok) {
    throw new Error(
      `epoch ${epoch} credits callers this host cannot corroborate — NOT signing.\n` +
        `  ${result.reason}\n` +
        (result.unverified.length > 0
          ? `  unverified: ${result.unverified.slice(0, 10).join(', ')}` +
            `${result.unverified.length > 10 ? `, … (${result.unverified.length} total)` : ''}\n`
          : '') +
        '  If this host\'s poll is simply behind, the next tick clears it on its own. If it\n' +
        '  persists, box A is claiming callouts pump.fun did not show this host — do not\n' +
        '  override it, and do not "fix" it by pointing --callout-store at box A\'s store.',
    );
  }
  if (result.reason) console.log(`             ⚠️  ${result.reason}`);
}

/** Block until the multisig account itself reports the new transaction index. */
async function waitForIndex(connection, multisigPda, index, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    if (Number(account.transactionIndex) >= index) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the multisig never reached transaction index ${index}`);
}

/** Byte-for-byte comparison of an instruction against the one we derived. */
function sameInstruction(a, b) {
  return (
    a.programId.equals(b.programId) &&
    a.data.length === b.data.length &&
    Buffer.from(a.data).equals(Buffer.from(b.data)) &&
    a.keys.length === b.keys.length &&
    a.keys.every(
      (k, i) =>
        k.pubkey.equals(b.keys[i].pubkey) &&
        k.isSigner === b.keys[i].isSigner &&
        k.isWritable === b.keys[i].isWritable,
    )
  );
}

/**
 * Find an existing proposal carrying exactly our instruction.
 *
 * Walks back from the multisig's current index rather than trusting an index
 * passed in. A stale or attacker-chosen index is how you end up approving the
 * wrong transaction with a correct-looking epoch number beside it.
 */
async function findProposal(connection, multisigPda, multisigAccount, expectedIx, vault) {
  const current = Number(multisigAccount.transactionIndex);
  const floor = Math.max(1, current - 50);

  for (let index = current; index >= floor; index--) {
    const [txPda] = multisig.getTransactionPda({ multisigPda, index: BigInt(index) });
    let vaultTx;
    try {
      vaultTx = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, txPda);
    } catch {
      continue; // closed or never created
    }

    const message = vaultTx.message;
    if (message.instructions.length !== 1) continue;

    const inner = message.instructions[0];
    const accountKeys = message.accountKeys;
    const decoded = {
      programId: accountKeys[inner.programIdIndex],
      keys: [...inner.accountIndexes].map((keyIndex) => ({
        pubkey: accountKeys[keyIndex],
        isSigner: multisig.utils.isSignerIndex(message, keyIndex),
        isWritable: multisig.utils.isStaticWritableIndex(message, keyIndex),
      })),
      data: Buffer.from(inner.data),
    };

    if (sameInstruction(decoded, expectedIx)) return { index, txPda, vaultTx };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epoch = Number(args.epoch);
  const connection = connect(args.rpc);

  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const multisigPda = new PublicKey(args.multisig);

  // The multisig is only the right one if its vault IS the snapshot key. Taking
  // the address on trust would let a wrong --multisig quietly build a proposal
  // that could never execute — or, worse, one that could.
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  if (!vault.equals(config.snapshotKey)) {
    throw new Error(
      `multisig ${args.multisig} has vault ${vault.toBase58()}, but the on-chain ` +
        `snapshot key is ${config.snapshotKey.toBase58()}. Wrong multisig, or wrong vault index.`,
    );
  }

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const threshold = multisigAccount.threshold;
  const members = multisigAccount.members.map((m) => m.key.toBase58());

  console.log(`\nCALLPOOL — co-sign post_epoch_root, epoch ${epoch}\n`);
  console.log(`multisig     ${multisigPda.toBase58()}`);
  console.log(`vault        ${vault.toBase58()}   (= config.snapshot_key ✓)`);
  console.log(`threshold    ${threshold} of ${members.length}`);

  if (await fetchEpoch(connection, mint, epoch)) {
    console.log(`\nepoch ${epoch} already has a root on chain. Nothing to do.\n`);
    return;
  }

  // ── the three refusals ───────────────────────────────────────────────────
  //
  // Before any of them: is this directory even about the coin we are bound to?
  //
  // `snapshots/epoch-N/` is addressed by index alone, so a directory left behind
  // by an EARLIER deployment sits at exactly the path this run wants — same
  // name, plausible contents, different coin. Measured 2026-08-07: a previous
  // rehearsal's `epoch-2` was still published, the co-signer fetched it, and
  // spent the epoch refusing a stale snapshot instead of settling the real one.
  //
  // It refused, because the allocation could not be honoured — but that was
  // luck, not design. Two deployments of the same coin, or a rerun after a wipe,
  // would produce a directory that reproduces perfectly and pays the wrong
  // people. The mint is in the epoch's own inputs; compare it.
  assertSameCoin(epoch, mint);
  reproduce(epoch, args.rpc);
  corroborate(epoch, args.calloutStore);

  const { root, leafCount, allocate } = publishedRoot(snapshotDir(epoch));
  const pool = await poolAvailable(connection, config);
  if (allocate > pool.available) {
    // Almost always a **stale snapshot**, not a corrupt one, and the difference
    // decides the recovery. Every unsettled epoch is built against the pool as
    // it stood at build time, so a backlog produces snapshots that each claim
    // nearly the same money. When the blockage clears, the first one settles,
    // drains the pool, and every later one becomes unsatisfiable — through no
    // fault of its own and with nothing wrong with the services.
    //
    // Restarting anything is therefore the wrong move: the fix is to re-run the
    // crank for this epoch, which rebuilds the snapshot against current pool
    // state and proposes bytes that can actually be honoured. Said here because
    // this is where the operator is standing when they need to know it.
    throw new Error(
      `epoch ${epoch} allocates ${allocate} but only ${pool.available} is available — NOT signing.\n` +
        '  This is what a STALE snapshot looks like. It is built from the pool as it stood\n' +
        '  when it was built, and a later epoch has since been paid out of that same pool.\n' +
        `  Recovery is to REBUILD, not to restart: re-run the crank for epoch ${epoch} so the\n` +
        '  snapshot is derived against the pool as it stands now.',
    );
  }

  // The vault is `post_epoch_root`'s `payer`: it funds the rent for every Epoch
  // account it creates, about 0.00146 SOL each and never reclaimed until
  // `close_epoch`. A vault with no SOL fails deep inside the multisig's CPI as
  // `custom program error: 0x1`, which the SDK helpfully decodes against an
  // unrelated program's error table and reports as "Account is already
  // initialized". Checking here costs one RPC call and saves that hunt.
  const vaultBalance = await connection.getBalance(vault);
  const EPOCH_RENT = 1_461_600;
  if (vaultBalance < EPOCH_RENT * 2) {
    throw new Error(
      `the multisig vault ${vault.toBase58()} holds ${vaultBalance} lamports.\n` +
        `Each epoch costs about ${EPOCH_RENT} in rent for its Epoch account, paid by the vault ` +
        'because it is the snapshot key. Fund it — on mainnet budget roughly 0.6 SOL a year ' +
        'plus transaction fees, and alert when it runs low: an unfunded vault stops the crank ' +
        'exactly as dead as a lost key.',
    );
  }
  console.log(`vault SOL    ${vaultBalance / 1e9} (rent per epoch ≈ ${EPOCH_RENT / 1e9})`);

  const expectedIx = postEpochRootIx({
    snapshotKey: vault,
    mint,
    epoch,
    root,
    leafCount,
    allocate,
  });

  console.log(`root         ${root.toString('hex')}`);
  console.log(`leaf_count   ${leafCount}`);
  console.log(`allocate     ${allocate} of ${pool.available} available\n`);

  const existing = await findProposal(connection, multisigPda, multisigAccount, expectedIx, vault);

  if (args.dryRun) {
    console.log(
      existing
        ? `--dry-run: proposal at index ${existing.index} matches byte for byte. Nothing signed.\n`
        : '--dry-run: no matching proposal yet; this run would create one. Nothing signed.\n',
    );
    return;
  }

  const member = loadKeypair(args.keypair);
  if (!members.includes(member.publicKey.toBase58())) {
    throw new Error(
      `${member.publicKey.toBase58()} is not a member of this multisig. Members: ${members.join(', ')}`,
    );
  }

  if (!args.yes) {
    console.log('This approves a root that can never be replaced. Re-run with --yes.\n');
    return;
  }

  let index;
  if (existing) {
    index = existing.index;
    console.log(`proposal     index ${index}, and its bytes are the bytes derived here ✓`);
  } else {
    index = Number(multisigAccount.transactionIndex) + 1;
    console.log(`proposal     none matched — creating index ${index}`);

    const message = new TransactionMessage({
      payerKey: vault,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [expectedIx],
    });

    // ── both signers may propose, so both may propose at once ──────────────
    //
    // Every member runs this same command on its own timer, and either can be
    // first. Between the `findProposal` scan above and this create, the other
    // host can take the index — and then this fails with
    // `AnchorError#ConstraintSeeds`, because the PDA for that index already
    // exists.
    //
    // Measured 2026-08-07: box B's minute timer created index 5, box A's crank
    // collided a second later, and the crank exited "no root was posted". Epoch
    // 4 then sat at **1-of-2 forever** — the proposal existed and was approved
    // by exactly one member, and neither host was going to revisit it. That is
    // the same stuck-at-one-approval symptom the runbook attributes to a
    // firewall, reached by a completely different route and with every service
    // healthy.
    //
    // Losing the race is not an error. The other host built the same bytes from
    // the same published inputs — and if it did not, the re-scan below will not
    // match and this refuses exactly as it should. So: look again, and approve
    // what is there.
    let createSig = null;
    try {
      createSig = await multisig.rpc.vaultTransactionCreate({
        connection,
        feePayer: member,
        multisigPda,
        transactionIndex: BigInt(index),
        creator: member.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: message,
        memo: `callpool post_epoch_root epoch ${epoch}`,
      });
    } catch (error) {
      const raced = /ConstraintSeeds|already in use|InvalidTransactionIndex/i.test(
        `${error.message}${error.logs?.join(' ') ?? ''}`,
      );
      if (!raced) throw error;

      console.log(`proposal     index ${index} was taken while we were building it — re-scanning`);
      const fresh = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
      const now = await findProposal(connection, multisigPda, fresh, expectedIx, vault);
      if (!now) {
        throw new Error(
          `index ${index} is taken, but no proposal on this multisig carries the bytes derived ` +
            `here for epoch ${epoch} — NOT signing.\n` +
            '  Another member proposed something this host did not derive. That is the case the ' +
            'byte comparison exists for; do not approve it by hand to clear the queue.',
        );
      }
      index = now.index;
      console.log(`proposal     index ${index}, and its bytes are the bytes derived here ✓`);
    }

    if (createSig) {
      // `proposalCreate` refuses an index the multisig has not reached yet, and
      // the SDK's send does not wait for the account to reflect it. Without this
      // the propose leg fails with `InvalidTransactionIndex` on a fast local
      // validator and, intermittently, on a real one.
      await connection.confirmTransaction(createSig, 'confirmed');
      await waitForIndex(connection, multisigPda, index);
    }
  }

  // The vault transaction and its proposal are two accounts created by two
  // instructions, so a run that dies between them leaves a transaction with no
  // proposal — which is exactly what a retry finds. Ensure it separately rather
  // than inferring it from the transaction's existence.
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: BigInt(index) });
  let proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda).catch(
    () => null,
  );

  if (!proposal) {
    console.log(`proposal     account missing for index ${index} — creating it`);
    const proposalSig = await multisig.rpc.proposalCreate({
      connection,
      feePayer: member,
      multisigPda,
      transactionIndex: BigInt(index),
      creator: member,
    });
    await connection.confirmTransaction(proposalSig, 'confirmed');
    proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  }

  const already = proposal.approved.map((k) => k.toBase58());

  if (already.includes(member.publicKey.toBase58())) {
    console.log(`approved     already, by this member (${already.length}/${threshold})`);
  } else {
    const approveSig = await multisig.rpc.proposalApprove({
      connection,
      feePayer: member,
      multisigPda,
      transactionIndex: BigInt(index),
      member,
    });
    // Confirm before re-reading, or the count below is the count from before
    // this approval — which reads as "waiting for more" on the run that just
    // met the threshold, and would strand the root unposted.
    await connection.confirmTransaction(approveSig, 'confirmed');
  }

  const after = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  const approvals = after.approved.length;
  console.log(`approved     ${approvals}/${threshold}  [${after.approved.map((k) => k.toBase58().slice(0, 8)).join(', ')}]`);

  if (approvals < threshold) {
    console.log(`\nWaiting for ${threshold - approvals} more approval(s). The other host runs this same command.\n`);
    return;
  }

  if (!args.execute) {
    console.log(`\nThreshold met (${approvals}/${threshold}). Re-run with --execute to send it.\n`);
    return;
  }

  const signature = await multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex: BigInt(index),
    member: member.publicKey,
    signers: [member],
  });
  console.log(`\nposted: ${signature}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\n${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

export { sameInstruction, publishedRoot };
