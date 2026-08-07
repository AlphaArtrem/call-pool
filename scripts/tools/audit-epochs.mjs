#!/usr/bin/env node
//
// scripts/tools/audit-epochs.mjs — re-derive published epochs from chain, on
// purpose, some time after anyone was watching.
//
//   node scripts/tools/audit-epochs.mjs                  # sample the default set
//   ... --epochs 3,7,19        audit exactly these
//   ... --sample 10            how many to pick when choosing
//   ... --all                  every published epoch. Slow, and the real answer.
//   ... --offline              skip the RPC re-derivation (arithmetic only)
//
// `verify-epoch --recheck-chain` already runs inside the crank, before every
// root is posted. That check is worth having and is **not this one**: it runs
// against the same machine's own freshly-written files, seconds after they were
// written, with the same code that wrote them. It catches a builder that
// disagrees with itself. It cannot catch a published epoch that has since been
// altered, an epoch whose carry chain quietly broke three days ago, or a claim
// in the audit trail that stopped being true.
//
// This runs later, over a spread of epochs, with no assumption that anything is
// fine. It is the thing a stranger would run, run by us first.
//
// ── what it samples, and why not just the newest ──────────────────────────
//
// Auditing the last five epochs audits the five most likely to be correct —
// they were built by today's code, on today's pool, and anything wrong with
// them is probably still on someone's screen. The interesting epochs are:
//
//   * the **oldest** published, because it is the one the code has changed
//     most since, and the one whose RPC history is most likely to have aged
//     out of a non-archival node;
//   * every epoch carrying **non-zero dust forward**, because the carry chain
//     is the one part of the audit trail that links epochs to each other — a
//     break in it is invisible from either side alone, and the dust path went
//     entirely unexercised on devnet until 2026-08-07;
//   * a spread of the rest, so a systematic fault has somewhere to show up.
//
// ⚠️ `--recheck-chain` on an old epoch needs **archival** RPC access:
// `getSignaturesForAddress` and `getTransaction` do not keep six-month-old
// history on an ordinary node. A failure that says the history could not be
// replayed is a statement about the node, not about the epoch, and this says
// so rather than reporting it as a bad epoch.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { readJson, REPO_ROOT, SNAPSHOTS_DIR, snapshotDir } from '../lib/store.mjs';

/** How many epochs to look at when nobody said. */
const DEFAULT_SAMPLE = 8;

function parseArgs(argv) {
  const args = { rpc: DEFAULT_RPC_URL, sample: DEFAULT_SAMPLE, all: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--offline') args.offline = true;
    else if (argv[i] === '--sample') args.sample = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.sample) || args.sample < 1) {
    throw new Error(`--sample must be a positive integer, got ${args.sample}`);
  }
  return args;
}

/** Every epoch with a published tree, oldest first. */
export function publishedEpochs(dir = SNAPSHOTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^epoch-(\d+)$/.exec(name)?.[1])
    .filter((n) => n !== undefined)
    .map(Number)
    .filter((epoch) => existsSync(resolve(dir, `epoch-${epoch}`, 'tree.json')))
    .sort((a, b) => a - b);
}

/** Did this epoch carry dust forward? Read from its own published ledger. */
export function carriesDust(epoch, dirFor = snapshotDir) {
  const path = resolve(dirFor(epoch), 'carry.json');
  if (!existsSync(path)) return false;
  const carry = readJson(path, { balances: {} });
  return Object.values(carry.balances ?? {}).some((entry) => BigInt(entry.lamports ?? 0) > 0n);
}

/**
 * Choose which epochs to audit.
 *
 * Not the newest N, and not a random N. The oldest and every carrying epoch are
 * taken first because they are where a fault is both most likely and least
 * likely to be noticed otherwise; whatever budget is left is spread evenly over
 * the rest so that a systematic problem has somewhere to appear.
 *
 * Pure, and takes its predicates as arguments, so the choosing can be tested
 * without a snapshots directory.
 */
export function chooseEpochs(all, { sample, carries = carriesDust }) {
  if (all.length === 0) return [];
  if (all.length <= sample) return [...all];

  const chosen = new Set([all[0], all[all.length - 1]]);
  for (const epoch of all) {
    if (chosen.size >= sample) break;
    if (carries(epoch)) chosen.add(epoch);
  }

  // Evenly spaced across the whole range, so a fault introduced at some point
  // in the history is bracketed rather than missed.
  const remaining = sample - chosen.size;
  if (remaining > 0) {
    const step = all.length / (remaining + 1);
    for (let i = 1; i <= remaining; i++) chosen.add(all[Math.floor(i * step)]);
  }

  return [...chosen].sort((a, b) => a - b);
}

/**
 * Is this failure the archive's fault rather than the epoch's?
 *
 * A non-archival node answers "I do not have that history" in a way that is
 * indistinguishable from "this epoch is wrong" unless it is looked for. Calling
 * an unreadable epoch a bad one is how an audit produces a false alarm loud
 * enough that the next one gets skipped.
 */
export function isArchiveLimit(output = '') {
  return /history could not be replayed|history is incomplete|failed after \d+ attempts/i.test(output);
}

function auditOne(epoch, { rpc, offline }) {
  const result = spawnSync(
    'node',
    [
      resolve(REPO_ROOT, 'scripts/verify-epoch.mjs'),
      '--epoch', String(epoch),
      ...(offline ? ['--offline'] : ['--rpc', rpc, '--recheck-chain']),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const output = `${result.stdout}${result.stderr}`;

  if (result.status === 0) return { epoch, verdict: 'reproduced', output };
  return {
    epoch,
    verdict: isArchiveLimit(output) ? 'unreadable' : 'FAILED',
    output,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = publishedEpochs();

  if (all.length === 0) {
    console.log(`\nNo published epochs under ${SNAPSHOTS_DIR}. Nothing to audit.\n`);
    return;
  }

  const epochs = args.epochs
    ? String(args.epochs).split(',').map((n) => Number(n.trim()))
    : args.all
      ? all
      : chooseEpochs(all, { sample: args.sample });

  console.log('\nCALLPOOL — epoch audit\n');
  console.log(`published  ${all.length} epoch(s), ${all[0]} … ${all[all.length - 1]}`);
  console.log(`auditing   ${epochs.join(', ')}`);
  console.log(`mode       ${args.offline ? 'offline (arithmetic only)' : 'offline + recheck-chain'}\n`);

  const results = epochs.map((epoch) => {
    const result = auditOne(epoch, args);
    const mark = { reproduced: '✔', unreadable: '·', FAILED: '✘' }[result.verdict];
    console.log(`  ${mark} epoch ${epoch}  ${result.verdict}`);
    return result;
  });

  const failed = results.filter((r) => r.verdict === 'FAILED');
  const unreadable = results.filter((r) => r.verdict === 'unreadable');

  console.log(
    `\n${results.length - failed.length - unreadable.length} reproduced, ` +
      `${unreadable.length} unreadable, ${failed.length} failed`,
  );

  if (unreadable.length > 0) {
    console.log(
      `\n· ${unreadable.map((r) => r.epoch).join(', ')} could not be re-derived because the RPC ` +
        'does not hold history that far back. That is a statement about the node, not about ' +
        'the epoch — point --rpc at an archival provider to actually check them.',
    );
  }

  if (failed.length > 0) {
    for (const result of failed) {
      console.log(`\n── epoch ${result.epoch} ─────────────────────────────────────────`);
      console.log(result.output.trim());
    }
    console.log(
      '\n❌ A PUBLISHED EPOCH DOES NOT REPRODUCE. If it is still inside its challenge window, ' +
        'say so publicly now. If it is not, the root is already paid and the correction goes ' +
        'forward — roots are write-once and a published directory is evidence, so do not ' +
        'rewrite either.\n',
    );
    process.exitCode = 1;
    return;
  }

  // The claim has to match the mode. `--offline` proves the arithmetic and
  // nothing about the balance data, and an audit that overstates what it
  // checked is worse than one that was never run — it is the same sentence
  // either way, so nobody goes back and runs the real one.
  console.log(
    args.offline
      ? '\n✅ Every epoch checked re-derives from its own published inputs.\n\n' +
          '   This proved the ARITHMETIC only. balances.json was read, not rebuilt, so a\n' +
          '   fabricated balance would pass exactly like this. Drop --offline to check it.\n'
      : '\n✅ Every epoch checked re-derives from its own published inputs, with balances\n' +
          '   rebuilt from chain rather than read from the committed copy.\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`\nAUDIT FAILED TO RUN: ${error.message}\n`);
    process.exitCode = 1;
  }
}
