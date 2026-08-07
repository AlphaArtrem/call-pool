// The crank's posting step — routing, and the read-back that makes a silent
// non-post impossible.
//
// The bug these exist for, demonstrated on live devnet 2026-08-06:
//
//   CRANK EXIT=0
//   written to …/epoch-42/post-root.unsigned.txt
//   *** NO ROOT ON CHAIN ***
//
// `crank.mjs` appended `--keypair` only if it had been given one. With
// `snapshot_key` set to a Squads vault there is no keypair to give — that is
// what a multisig *is* — so `post-root.mjs` wrote a base64 file and exited 0,
// and the crank read that exit code as a settled epoch. In the exact
// configuration mainnet runs in, it would have reported a settlement every day
// while posting nothing.
//
// Two properties are tested here, and the second is the one that matters:
// routing (the multisig gets `cosign.mjs`), and that a run which did not land a
// root fails **however** it failed to land it. The first fixes an instance; the
// second kills the class, because it trusts nothing but the chain.
//
// Nothing here touches a network: the chain is a function argument, and the
// clock is injected so a wait can be tested without spending one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { confirmPosted, postStep } from '../crank.mjs';
import { parseArgs as postRootArgs } from '../post-root.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MULTISIG = '2oWqaqVHVqr3rhJ85iaMoP5AuZpCr33sg4XFhBtqxp7V';
const RPC = 'https://api.devnet.solana.com';

/** Run a script offline and report how it exited. Argument errors need no RPC. */
function runScript(script, args) {
  const result = spawnSync('node', [resolve(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// ── routing ────────────────────────────────────────────────────────────────

test('a multisig posts through cosign.mjs, with this host\'s member key', () => {
  const step = postStep({ epoch: 42, rpc: RPC, keypair: '/etc/callpool/signerA.json', multisig: MULTISIG });

  assert.equal(step.script, 'cosign.mjs', 'post-root.mjs cannot sign for a vault');
  assert.deepEqual(step.args, [
    '--epoch', '42',
    '--rpc', RPC,
    '--multisig', MULTISIG,
    '--keypair', '/etc/callpool/signerA.json',
    '--execute', '--yes',
  ]);
});

test('both hosts pass --execute, so whichever meets the threshold sends it', () => {
  const step = postStep({ epoch: 42, rpc: RPC, keypair: '/etc/callpool/signerB.json', multisig: MULTISIG });
  assert.ok(step.args.includes('--execute'));
});

test('a single signer still posts directly', () => {
  const step = postStep({ epoch: 7, rpc: RPC, keypair: '/etc/callpool/snapshot.json' });
  assert.equal(step.script, 'post-root.mjs');
  assert.deepEqual(step.args, ['--epoch', '7', '--rpc', RPC, '--keypair', '/etc/callpool/snapshot.json', '--yes']);
});

test('no key at all is refused rather than routed anywhere', () => {
  assert.throws(() => postStep({ epoch: 7, rpc: RPC }), /cannot settle/);
});

// ── the read-back ──────────────────────────────────────────────────────────

test('a posting step that exited 0 without landing a root fails the run', async () => {
  // Precisely the devnet reproduction: the child was happy, the chain is empty.
  await assert.rejects(
    () => confirmPosted(async () => null, { epoch: 42, awaitSeconds: 0 }),
    (error) => /NO ROOT ON CHAIN/.test(error.message) && /settled nothing/.test(error.message),
  );
});

test('the multisig failure names the thing an operator should go and look at', async () => {
  await assert.rejects(
    () => confirmPosted(async () => null, { epoch: 42, awaitSeconds: 0, multisig: MULTISIG }),
    /approval threshold/,
  );
});

test('a root that is already there is returned without waiting', async () => {
  const account = { root: Buffer.alloc(32, 3), postedTs: 1_000 };
  const found = await confirmPosted(async () => account, { epoch: 42, awaitSeconds: 600 });
  assert.equal(found, account);
});

test('it waits for the second signer, and succeeds when the root lands late', async () => {
  // A fake clock, so the wait costs nothing: every sleep advances it.
  let clock = 0;
  const slept = [];
  const sleepFn = async (seconds) => {
    slept.push(seconds);
    clock += seconds * 1000;
  };

  let reads = 0;
  const account = { root: Buffer.alloc(32, 9), postedTs: 2_000 };
  // Signer B approves on its own timer — nothing is on chain for three polls.
  const readEpoch = async () => (++reads > 3 ? account : null);

  const found = await confirmPosted(readEpoch, {
    epoch: 42,
    awaitSeconds: 600,
    multisig: MULTISIG,
    sleepFn,
    nowFn: () => clock,
  });

  assert.equal(found, account);
  assert.equal(reads, 4, 'it polled until the root appeared');
  assert.ok(slept.length > 0 && slept.every((s) => s > 0), 'and it actually waited between polls');
});

test('the wait ends, and a root that never lands is still a failure', async () => {
  let clock = 0;
  const sleepFn = async (seconds) => {
    clock += seconds * 1000;
  };

  await assert.rejects(
    () =>
      confirmPosted(async () => null, {
        epoch: 42,
        awaitSeconds: 60,
        multisig: MULTISIG,
        sleepFn,
        nowFn: () => clock,
      }),
    /NO ROOT ON CHAIN after 60s/,
  );
  assert.ok(clock >= 60_000, 'it waited the deadline out before giving up');
});

// ── the two scripts refuse to start in a state that could not post ─────────

test('post-root.mjs refuses to emit an unsigned file just because --keypair was forgotten', () => {
  assert.throws(() => postRootArgs(['--epoch', '1']), /--unsigned was not asked for/);

  // Asked for on purpose it is still a supported mode — the manual path where a
  // human carries the base64 to the signers themselves.
  assert.equal(postRootArgs(['--epoch', '1', '--unsigned']).unsigned, true);
  assert.equal(postRootArgs(['--epoch', '1', '--keypair', '/etc/callpool/snapshot.json']).keypair,
    '/etc/callpool/snapshot.json');
});

test('the refusal is an exit code, not just a thrown object', () => {
  const { status, output } = runScript('post-root.mjs', ['--epoch', '1']);
  assert.notEqual(status, 0, 'this is the exit code the crank used to believe meant "posted"');
  assert.match(output, /--unsigned/);
});

test('crank.mjs refuses to run with no way to sign', () => {
  const { status, output } = runScript('crank.mjs', ['--epoch', '1']);
  assert.notEqual(status, 0);
  assert.match(output, /--keypair <PATH> is required/);
});
