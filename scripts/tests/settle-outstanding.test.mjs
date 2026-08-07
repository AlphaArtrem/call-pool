// The catch-up tool — what it settles, in what order, and what it refuses.
//
// The bug this tool exists for: crank.mjs settles one epoch per invocation and
// the carry chain refuses to skip a predecessor, so one transient failure
// wedged every later epoch forever. The properties worth pinning are therefore
// ordering (oldest first), the stop-on-failure rule (a later epoch must never
// be built against a carry ledger that does not exist), the cap, and the
// refusal to accept --carry-reset at all.
//
// Nothing here touches a network or a chain: `runCrank` is an argument.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseArgs, crankArgs, settleOutstanding } = await import('../tools/settle-outstanding.mjs');

// ── the loop ───────────────────────────────────────────────────────────────

test('epochs are cranked oldest first, in the order given', async () => {
  const ran = [];
  const { settled, remaining } = await settleOutstanding({
    epochs: [3, 4, 7],
    max: 5,
    runCrank: (epoch) => (ran.push(epoch), { status: 0 }),
    log: () => {},
  });
  assert.deepEqual(ran, [3, 4, 7]);
  assert.deepEqual(settled, [3, 4, 7]);
  assert.equal(remaining, 0);
});

test('a failure stops the run — later epochs are never attempted', async () => {
  // Epoch 5 needs epoch 4's carry ledger. Continuing past a failed 4 would
  // either fail identically or, worse, settle 5 against a predecessor that
  // never existed. Skipping is what produces a silent hole in the audit trail.
  const ran = [];
  await assert.rejects(
    () =>
      settleOutstanding({
        epochs: [3, 4, 5],
        max: 5,
        runCrank: (epoch) => (ran.push(epoch), { status: epoch === 4 ? 1 : 0 }),
        log: () => {},
      }),
    /epoch 4/,
  );
  assert.deepEqual(ran, [3, 4], 'epoch 5 was not attempted after 4 failed');
});

test('the cap bounds one tick, and the rest are reported as remaining', async () => {
  const ran = [];
  const { settled, remaining } = await settleOutstanding({
    epochs: [1, 2, 3, 4, 5, 6, 7],
    max: 3,
    runCrank: (epoch) => (ran.push(epoch), { status: 0 }),
    log: () => {},
  });
  assert.deepEqual(ran, [1, 2, 3], 'the oldest three, not an arbitrary three');
  assert.deepEqual(settled, [1, 2, 3]);
  assert.equal(remaining, 4);
});

test('nothing outstanding settles nothing and runs nothing', async () => {
  const ran = [];
  const { settled, remaining } = await settleOutstanding({
    epochs: [],
    max: 5,
    runCrank: (epoch) => (ran.push(epoch), { status: 0 }),
    log: () => {},
  });
  assert.deepEqual(ran, []);
  assert.deepEqual(settled, []);
  assert.equal(remaining, 0);
});

// ── the crank invocation ───────────────────────────────────────────────────

test('the crank gets the same arguments the timer used, with only the epoch varying', () => {
  const args = parseArgs([
    '--multisig', 'MSIG', '--keypair', '/k/a.json', '--payer', '/k/gas.json',
    '--and-pay', '--await-root', '200', '--store', 'epochs/devnet/callout-store.json',
  ]);
  const argv = crankArgs(9, args);
  assert.deepEqual(argv, [
    '--epoch', '9',
    '--rpc', args.rpc,
    '--keypair', '/k/a.json',
    '--multisig', 'MSIG',
    '--payer', '/k/gas.json',
    '--store', 'epochs/devnet/callout-store.json',
    '--await-root', '200',
    '--and-pay',
  ]);
});

test('optional arguments that were not given are not forwarded', () => {
  const argv = crankArgs(2, parseArgs(['--keypair', '/k/snap.json']));
  assert.deepEqual(argv, ['--epoch', '2', '--rpc', parseArgs(['--keypair', 'x']).rpc, '--keypair', '/k/snap.json']);
  assert.ok(!argv.includes('--multisig'));
  assert.ok(!argv.includes('--and-pay'));
});

// ── refusals ───────────────────────────────────────────────────────────────

test('--carry-reset is refused outright — forfeiting carried dust is a human decision', () => {
  assert.throws(
    () => parseArgs(['--keypair', '/k/a.json', '--carry-reset']),
    /refused here by design/,
  );
});

test('a run with no key to sign with is refused before it starts', () => {
  assert.throws(() => parseArgs([]), /--keypair/);
  assert.doesNotThrow(() => parseArgs(['--dry-run']));
});

test('the cap and the lookback must be positive integers', () => {
  assert.throws(() => parseArgs(['--keypair', 'k', '--max', '0']), /--max/);
  assert.throws(() => parseArgs(['--keypair', 'k', '--lookback', 'soon']), /--lookback/);
  assert.equal(parseArgs(['--keypair', 'k', '--max', '2']).max, 2);
});
