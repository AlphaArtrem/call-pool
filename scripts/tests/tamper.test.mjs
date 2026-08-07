// The tamper test: does signer B actually refuse a snapshot it did not derive?
//
// This is the one safety claim the 2026-08-07 rehearsal left unverified. Signer
// B was observed **succeeding** at byte-comparison hundreds of times, and
// refusing fifteen epochs on a *different* check — allocation against pool
// balance. Neither is evidence for the sentence the whole design rests on:
//
//   "the co-signer independently re-derives, so agreeing means it built these
//    bytes itself"
//
// A signer that only ever agrees is indistinguishable from a rubber stamp until
// the day it is handed something false. So each test below is one thing a
// hostile crank host would actually try, and the assertion is that it is caught
// — by name, at the layer that catches it.
//
// The threat model is precise: **box A is owned**. The attacker can rewrite
// every file under `snapshots/epoch-N/` before publishing it, and can propose
// whatever they like to the multisig. What they cannot do is change the chain,
// and that is the asymmetry every refusal here rests on.
//
// The end-to-end refusal — `cosign.mjs` exiting non-zero on a live host — is
// `scripts/tools/tamper-test.mjs`, which needs a cluster. What is testable
// without one is every decision that refusal is made of, plus the child-process
// exit code that carries it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Keypair } from '@solana/web3.js';

import { emptyCarry } from '../lib/carry.mjs';
import { countable } from '../lib/callouts.mjs';
import { MIN_HOLD_RAW } from '../lib/config.mjs';
import { buildEpoch } from '../lib/epoch-build.mjs';
import { windowForDay } from '../lib/epoch.mjs';
import { verifyOffline } from '../lib/verify.mjs';
import { corruptTree } from '../tools/tamper-test.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const DAY = '2026-08-04';
const W = windowForDay(DAY);
const AVAILABLE = 90n * 1_000_000_000n;
const BIG = MIN_HOLD_RAW * 10n;

const wallet = (i) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => i)).publicKey.toBase58();

/** The attacker's own wallet: eligible for nothing, and wanting to be paid. */
const ATTACKER = wallet(99);

let calloutSeq = 0;
const callout = (address, hoursIntoDay, overrides = {}) => ({
  id: `callout-${(calloutSeq += 1)}`,
  walletAddress: address,
  tokenAddress: 'MINT',
  createdAt: new Date((W.start + hoursIntoDay * 3600) * 1000).toISOString(),
  isSpam: false,
  isHarmful: false,
  deletedAt: null,
  ...overrides,
});

const storeOf = (records) => Object.fromEntries(records.map((r) => [r.id, r]));
const holdsOf = (entries) =>
  new Map(entries.map(([address, hold, locked = false]) => [address, { hold, locked }]));

/**
 * One honest epoch, published the way the crank publishes it.
 *
 * Every test starts here and then corrupts exactly one thing, so a failure
 * names the corruption rather than a setup mistake.
 */
function publishHonestEpoch() {
  const records = [callout(wallet(1), 1), callout(wallet(2), 2), callout(wallet(3), 3)];
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([
      [wallet(1), BIG],
      [wallet(2), 2n * BIG],
      [wallet(3), 3n * BIG],
    ]),
    available: AVAILABLE,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const dir = resolve(mkdtempSync(resolve(tmpdir(), 'callpool-tamper-')), 'epoch-0');
  mkdirSync(dir, { recursive: true });
  const json = (name, value) =>
    writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);

  json('callouts.json', {
    mint: 'MINT',
    window: W,
    capturedAt: W.end,
    truncated: false,
    usedFallback: false,
    counted: records.filter(countable),
    excluded: records.filter((r) => !countable(r)),
  });
  json(
    'balances.json',
    Object.fromEntries(
      built.rows.map((r) => [
        r.wallet,
        { tokenAccount: `ata-${r.wallet}`, hold: r.hold.toString(), locked: r.locked, windowEvents: [], lockoutDecreases: [] },
      ]),
    ),
  );
  json('pool.json', { available: AVAILABLE.toString() });
  json('carry.json', built.carry);
  json('tree.json', {
    epoch: 0,
    root: built.root.toString('hex'),
    leafCount: built.leafCount,
    allocate: built.allocate.toString(),
    leaves: built.tree.map((l) => ({
      index: l.index,
      owner: l.owner,
      amount: l.amount.toString(),
      proof: l.proof.map((n) => n.toString('hex')),
    })),
  });

  return { dir, built, records };
}

const read = (dir, name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
const write = (dir, name, value) =>
  writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);

/** Reproduce the published directory the way the co-signer does. */
const reproduce = (dir) => verifyOffline(dir, { minHold: MIN_HOLD_RAW });

/** Assert a refusal, and that its wording points at the corruption. */
function refuses(result, pattern) {
  assert.equal(result.ok, false, 'the co-signer accepted a tampered snapshot');
  assert.ok(
    result.problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got ${JSON.stringify(result.problems, null, 2)}`,
  );
}

// ── the control ────────────────────────────────────────────────────────────

test('the honest epoch reproduces — otherwise every test below proves nothing', () => {
  const { dir } = publishHonestEpoch();
  const result = reproduce(dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

// ── tampering with the tree ────────────────────────────────────────────────

test('a root swapped for one the inputs do not produce is refused', () => {
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  write(dir, 'tree.json', { ...tree, root: 'ab'.repeat(32) });

  refuses(reproduce(dir), /root mismatch/);
});

test('one flipped bit in the root is refused — not just a wholesale swap', () => {
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  const flipped = Buffer.from(tree.root, 'hex');
  flipped[31] ^= 0x01;
  write(dir, 'tree.json', { ...tree, root: flipped.toString('hex') });

  refuses(reproduce(dir), /root mismatch/);
});

test('an extra leaf paying the attacker is refused, and names them', () => {
  // The attack in its plainest form: append yourself to the payout list.
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  write(dir, 'tree.json', {
    ...tree,
    leafCount: tree.leafCount + 1,
    leaves: [...tree.leaves, { index: tree.leaves.length, owner: ATTACKER, amount: '1000000000', proof: [] }],
  });

  refuses(reproduce(dir), new RegExp(`${ATTACKER}.*not eligible`));
});

test('redirecting an existing leaf to the attacker is refused', () => {
  // Subtler: pay the right amount to the wrong person. The totals still add up.
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  const victim = tree.leaves[0];
  write(dir, 'tree.json', {
    ...tree,
    leaves: [{ ...victim, owner: ATTACKER }, ...tree.leaves.slice(1)],
  });

  const result = reproduce(dir);
  refuses(result, new RegExp(`${ATTACKER}.*not eligible`));
  // And the person who was robbed is named too, not silently dropped.
  assert.ok(result.problems.some((p) => p.includes(victim.owner) && /no published leaf/.test(p)));
});

test('inflating one payout is refused and names the wallet', () => {
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  const victim = tree.leaves[0];
  write(dir, 'tree.json', {
    ...tree,
    leaves: [{ ...victim, amount: (BigInt(victim.amount) * 2n).toString() }, ...tree.leaves.slice(1)],
  });

  refuses(reproduce(dir), new RegExp(victim.owner));
});

test('reordering the leaves is refused — the index is part of the leaf', () => {
  // Indexes are what the on-chain claimed-bitmap is keyed on, so a silent
  // reorder would let one leaf be claimed twice under two different indexes.
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  const [a, b, ...rest] = tree.leaves;
  write(dir, 'tree.json', { ...tree, leaves: [{ ...b, index: a.index }, { ...a, index: b.index }, ...rest] });

  refuses(reproduce(dir), /published index/);
});

test('an undersized leafCount is refused — it would strand every leaf above it', () => {
  // D2. The bitmap is sized from leaf_count at post time, and a leaf whose
  // index falls outside it can never be marked claimed.
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  write(dir, 'tree.json', { ...tree, leafCount: 1 });

  refuses(reproduce(dir), /leaf_count mismatch/);
});

test('claiming a larger allocation than the tree pays is refused', () => {
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  write(dir, 'tree.json', { ...tree, allocate: (BigInt(tree.allocate) + 1_000_000_000n).toString() });

  refuses(reproduce(dir), /allocate mismatch/);
});

// ── tampering with the inputs the tree was built from ──────────────────────

test('a fabricated balance is refused, because the tree no longer matches it', () => {
  // Half an attack: inflate the attacker's hold but leave the tree alone. The
  // published inputs now produce a different root than the published one.
  const { dir } = publishHonestEpoch();
  const balances = read(dir, 'balances.json');
  const [first] = Object.keys(balances);
  write(dir, 'balances.json', {
    ...balances,
    [first]: { ...balances[first], hold: (BigInt(balances[first].hold) * 100n).toString() },
  });

  refuses(reproduce(dir), /root mismatch|published .* recomputed/);
});

test('a pool inflated to justify a bigger allocation is refused', () => {
  const { dir } = publishHonestEpoch();
  const pool = read(dir, 'pool.json');
  write(dir, 'pool.json', { ...pool, available: (AVAILABLE * 10n).toString() });

  refuses(reproduce(dir), /allocate mismatch|root mismatch/);
});

test('a carry ledger rewritten to owe the attacker is refused', () => {
  const { dir } = publishHonestEpoch();
  const carry = read(dir, 'carry.json');
  write(dir, 'carry.json', {
    ...carry,
    balances: { ...carry.balances, [ATTACKER]: { lamports: '5000000000', sinceEpoch: 0 } },
  });

  refuses(reproduce(dir), /carry balances do not match/);
});

// ── the whole snapshot rebuilt to be self-consistent ──────────────────────

test('a consistently rebuilt snapshot survives the offline check — chain is what catches it', () => {
  // The attack that offline reproduction genuinely cannot catch: inflate a
  // balance AND rebuild the tree from it, so the published files agree with
  // each other perfectly. Nothing is internally wrong.
  //
  // This test asserts the *limit*, deliberately. Believing offline reproduction
  // covers this is how a signer ends up approving a fabricated snapshot, and
  // the thing that actually catches it is `recheckChain` re-deriving every
  // balance from an RPC — which is why `cosign.mjs` passes `--recheck-chain`
  // and why removing that flag would quietly gut the co-signer.
  const records = [callout(wallet(1), 1), callout(ATTACKER, 2)];
  const built = buildEpoch({
    epoch: 0,
    window: W,
    calloutStore: storeOf(records),
    holds: holdsOf([
      [wallet(1), BIG],
      [ATTACKER, 1000n * BIG], // the lie
    ]),
    available: AVAILABLE,
    previousCarry: emptyCarry(),
    minHold: MIN_HOLD_RAW,
  });

  const dir = resolve(mkdtempSync(resolve(tmpdir(), 'callpool-tamper-')), 'epoch-0');
  mkdirSync(dir, { recursive: true });
  const json = (name, value) => writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  json('callouts.json', {
    mint: 'MINT', window: W, capturedAt: W.end, truncated: false, usedFallback: false,
    counted: records, excluded: [],
  });
  json('balances.json', Object.fromEntries(built.rows.map((r) => [
    r.wallet,
    { tokenAccount: `ata-${r.wallet}`, hold: r.hold.toString(), locked: r.locked, windowEvents: [], lockoutDecreases: [] },
  ])));
  json('pool.json', { available: AVAILABLE.toString() });
  json('carry.json', built.carry);
  json('tree.json', {
    epoch: 0, root: built.root.toString('hex'), leafCount: built.leafCount, allocate: built.allocate.toString(),
    leaves: built.tree.map((l) => ({ index: l.index, owner: l.owner, amount: l.amount.toString(), proof: l.proof.map((n) => n.toString('hex')) })),
  });

  assert.equal(reproduce(dir).ok, true, 'a self-consistent lie is self-consistent — this is the point');

  // And the attacker is paid, in the published tree, which is what makes the
  // on-chain recheck load-bearing rather than belt-and-braces.
  const paid = read(dir, 'tree.json').leaves.find((l) => l.owner === ATTACKER);
  assert.ok(paid && BigInt(paid.amount) > 0n);
});

test('the callout feed is the declared trust boundary, and it is exactly one file', () => {
  // §5.1. Everything else in the directory is re-derivable from public chain
  // history; `callouts.json` is not, because pump.fun's feed returns only the
  // newest 50 records and our capture is the only surviving copy.
  //
  // Pinned here so that "the trust boundary is one API" stays a true sentence.
  // If a second unverifiable input is ever added, this test is where it has to
  // be argued for — and the website says "one trusted input" today.
  const { dir } = publishHonestEpoch();
  const callouts = read(dir, 'callouts.json');
  write(dir, 'callouts.json', {
    ...callouts,
    counted: [...callouts.counted, callout(ATTACKER, 4)],
  });

  // Inserting a callout alone does not even get as far as a root comparison:
  // the wallet has no row in balances.json, and an active wallet with no
  // computed hold is refused outright rather than treated as holding nothing.
  // A thrown reproduce is still a refusal — `cosign.mjs` reads an exit code.
  assert.throws(() => reproduce(dir), /no hold computed for active wallet/);

  // With a matching balance supplied, it reaches the root and fails there.
  const balances = read(dir, 'balances.json');
  write(dir, 'balances.json', {
    ...balances,
    [ATTACKER]: { tokenAccount: `ata-${ATTACKER}`, hold: BIG.toString(), locked: false, windowEvents: [], lockoutDecreases: [] },
  });
  refuses(reproduce(dir), /root mismatch|not eligible/);

  // And an attacker who also rebuilds the tree is NOT caught here — that is the
  // trust boundary itself, covered by the test above. What keeps it honest is
  // that a holder can always check their own row against pump.fun's own feed.
});

// ── the refusal as the co-signer actually receives it ──────────────────────
//
// `cosign.mjs` does not call `verifyOffline`. It spawns `verify-epoch.mjs` and
// throws on a non-zero exit — so the exit code is the refusal, and a reproducer
// that found problems and still exited 0 would be a co-signer that signs
// anything. Tested as a real child process, because that is what it is.

function runVerifyEpoch(dir) {
  const result = spawnSync('node', [resolve(REPO_ROOT, 'scripts/verify-epoch.mjs'), '--dir', dir, '--offline'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('verify-epoch exits 0 on an honest epoch', () => {
  const { dir } = publishHonestEpoch();
  const { status, output } = runVerifyEpoch(dir);
  assert.equal(status, 0, output);
  assert.match(output, /reproduced/);
});

test('verify-epoch exits NON-ZERO on a tampered one — this is the refusal', () => {
  const { dir } = publishHonestEpoch();
  const tree = read(dir, 'tree.json');
  write(dir, 'tree.json', {
    ...tree,
    leaves: [...tree.leaves, { index: tree.leaves.length, owner: ATTACKER, amount: '1000000000', proof: [] }],
  });

  const { status, output } = runVerifyEpoch(dir);
  assert.notEqual(status, 0, 'a non-zero exit is the only thing cosign.mjs reads');
  assert.match(output, /NOT reproduced/);
  assert.match(output, new RegExp(ATTACKER));
});

// ── the corruption the live tool uses ──────────────────────────────────────
//
// `scripts/tools/tamper-test.mjs` is the on-host version: it drives the real
// `cosign.mjs` against a real published epoch, which needs a cluster. The one
// part of it that can be pinned here is that its corruption is genuinely
// corrupt — a tamper tool whose tamper is a no-op reports a pass forever.

test('the live tool\'s corruption is caught by the same reproduction', () => {
  const { dir } = publishHonestEpoch();
  const payee = corruptTree(dir);

  refuses(reproduce(dir), new RegExp(`${payee}.*not eligible`));
  assert.notEqual(runVerifyEpoch(dir).status, 0);
});

test('the corruption pays somebody, rather than quietly changing nothing', () => {
  const { dir } = publishHonestEpoch();
  const honest = read(dir, 'tree.json');
  const payee = corruptTree(dir);
  const tampered = read(dir, 'tree.json');

  assert.equal(tampered.leaves.length, honest.leaves.length + 1);
  assert.equal(tampered.leafCount, honest.leafCount + 1);
  const added = tampered.leaves.at(-1);
  assert.equal(added.owner, payee);
  assert.ok(BigInt(added.amount) > 0n);
});
