// The airdrop timer — which epochs it pays, and the one rule it does NOT
// share with settlement.
//
// Settlement is a chain and stops at the first failure. Airdrops are
// independent and must not: stopping early strands money that was ready to
// send. Everything else here is a refusal — paying early, paying twice, or
// paying after the claim deadline has handed the remainder back to the pool.
//
// Nothing touches a chain: `readEpoch` and `runAirdrop` are both arguments.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseArgs, payableEpochs, payOutstanding, CLAIM_DEADLINE_EPOCHS } = await import(
  '../tools/pay-outstanding.mjs'
);

const CONFIG = { epochSeconds: 86_400, challengeSeconds: 86_400 };
const DAY = 86_400;

/** An epoch account as the chain would hand it back. */
const account = ({ postedTs, allocated = 1_000n, claimed = 0n }) => ({
  postedTs,
  poolLamports: allocated,
  claimedLamports: claimed,
});

const chain = (byEpoch) => async (epoch) => byEpoch[epoch] ?? null;

test('an epoch is payable once its challenge window has closed', async () => {
  const posted = 1_000_000;
  const now = posted + DAY + 120; // window closed 120s ago
  const epochs = await payableEpochs({
    now, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({ 3: account({ postedTs: posted }) }),
  });
  assert.deepEqual(epochs.map((e) => e.epoch), [3]);
});

test('an epoch inside its challenge window is not paid — the program would refuse', async () => {
  const posted = 1_000_000;
  const epochs = await payableEpochs({
    now: posted + DAY - 10, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({ 3: account({ postedTs: posted }) }),
  });
  assert.deepEqual(epochs, []);
});

test('the grace period keeps a tick from being early by the cluster clock', async () => {
  // `claim` compares against the cluster's clock, not ours. Firing the instant
  // the window closes comes back ChallengeWindowOpen, which reads as a fault.
  const posted = 1_000_000;
  const justClosed = posted + DAY + 1;
  const readEpoch = chain({ 3: account({ postedTs: posted }) });

  assert.deepEqual(
    await payableEpochs({ now: justClosed, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG, readEpoch }),
    [],
    'one second past the window is still too early',
  );
  assert.equal(
    (await payableEpochs({ now: posted + DAY + 61, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG, readEpoch })).length,
    1,
  );
});

test('a fully claimed epoch is left alone', async () => {
  const posted = 1_000_000;
  const epochs = await payableEpochs({
    now: posted + DAY + 120, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({ 3: account({ postedTs: posted, allocated: 1_000n, claimed: 1_000n }) }),
  });
  assert.deepEqual(epochs, []);
});

test('a PARTLY claimed epoch is still payable', async () => {
  // The case a fully-unpaid check would miss: some leaves landed, some did
  // not, and the ones that did not are still owed.
  const posted = 1_000_000;
  const epochs = await payableEpochs({
    now: posted + DAY + 120, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({ 3: account({ postedTs: posted, allocated: 1_000n, claimed: 400n }) }),
  });
  assert.deepEqual(epochs.map((e) => e.epoch), [3]);
});

test('an epoch past the claim deadline is not paid — the remainder is the pool’s again', async () => {
  const posted = 1_000_000;
  const past = posted + CLAIM_DEADLINE_EPOCHS * DAY;
  const readEpoch = chain({ 3: account({ postedTs: posted }) });

  assert.deepEqual(
    await payableEpochs({ now: past, current: 40, lookback: 40, graceSeconds: 60, config: CONFIG, readEpoch }),
    [],
  );
  assert.equal(
    (await payableEpochs({ now: past - 10, current: 40, lookback: 40, graceSeconds: 60, config: CONFIG, readEpoch })).length,
    1,
    'a moment before the deadline it is still ours to send',
  );
});

test('an unsettled epoch is not this tool’s business', async () => {
  const epochs = await payableEpochs({
    now: 9_999_999, current: 5, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({}),
  });
  assert.deepEqual(epochs, []);
});

test('payable epochs come back oldest first — the deadline is what expires', async () => {
  const posted = 1_000_000;
  const now = posted + DAY + 500;
  const epochs = await payableEpochs({
    now, current: 9, lookback: 40, graceSeconds: 60, config: CONFIG,
    readEpoch: chain({
      2: account({ postedTs: posted }),
      5: account({ postedTs: posted }),
      7: account({ postedTs: posted }),
    }),
  });
  assert.deepEqual(epochs.map((e) => e.epoch), [2, 5, 7]);
});

// ── the loop ───────────────────────────────────────────────────────────────

test('a failure does NOT stop the run — airdrops are independent', async () => {
  // The opposite of settle-outstanding, deliberately. Epoch 6's leaves have
  // nothing to do with epoch 5's, so stopping here would strand money that was
  // ready to send.
  const ran = [];
  const { paid, failed } = await payOutstanding({
    epochs: [{ epoch: 4 }, { epoch: 5 }, { epoch: 6 }],
    max: 5,
    runAirdrop: (e) => (ran.push(e), { status: e === 5 ? 1 : 0 }),
    log: () => {},
  });
  assert.deepEqual(ran, [4, 5, 6], 'every epoch was attempted');
  assert.deepEqual(paid, [4, 6]);
  assert.deepEqual(failed, [5]);
});

test('the cap bounds one tick and reports the remainder', async () => {
  const ran = [];
  const { paid, remaining } = await payOutstanding({
    epochs: [1, 2, 3, 4, 5].map((epoch) => ({ epoch })),
    max: 2,
    runAirdrop: (e) => (ran.push(e), { status: 0 }),
    log: () => {},
  });
  assert.deepEqual(ran, [1, 2]);
  assert.deepEqual(paid, [1, 2]);
  assert.equal(remaining, 3);
});

test('nothing payable runs nothing', async () => {
  const ran = [];
  const { paid, failed } = await payOutstanding({
    epochs: [], max: 5, runAirdrop: (e) => (ran.push(e), { status: 0 }), log: () => {},
  });
  assert.deepEqual(ran, []);
  assert.deepEqual(paid, []);
  assert.deepEqual(failed, []);
});

// ── refusals ───────────────────────────────────────────────────────────────

test('a run with no submitting wallet is refused before it starts', () => {
  assert.throws(() => parseArgs([]), /--keypair/);
  assert.doesNotThrow(() => parseArgs(['--dry-run']));
});

test('the bounds must be sane', () => {
  assert.throws(() => parseArgs(['--keypair', 'k', '--max', '0']), /--max/);
  assert.throws(() => parseArgs(['--keypair', 'k', '--lookback', 'lots']), /--lookback/);
  assert.throws(() => parseArgs(['--keypair', 'k', '--grace', '-1']), /--grace/);
  assert.equal(parseArgs(['--keypair', 'k', '--grace', '0']).grace, 0);
});

// ── the holder candidate list (L5's fallback) ──────────────────────────────
//
// A wrong offset here produces a plausible-looking list of the wrong
// addresses, which is the hardest kind of wrong to notice.

const { ownersAboveFloor } = await import('../tools/holders-above-floor.mjs');

/** A token account as the chain lays it out: mint(32) owner(32) amount(8). */
function tokenAccount(owner32, amount, extraBytes = 0) {
  const data = Buffer.alloc(165 + extraBytes);
  Buffer.alloc(32, 1).copy(data, 0);        // mint
  Buffer.alloc(32, owner32).copy(data, 32); // owner
  data.writeBigUInt64LE(amount, 64);        // amount
  return { account: { data } };
}

test('owners at or above the floor are included; the floor is inclusive', () => {
  const owners = ownersAboveFloor(
    [tokenAccount(7, 100n), tokenAccount(8, 99n), tokenAccount(9, 101n)],
    100n,
  );
  assert.equal(owners.length, 2, 'exactly the account at the floor and the one above it');
});

test('Token-2022 accounts with extensions are not dropped', () => {
  // The bug a `dataSize: 165` filter would cause: create_v2 coins are
  // Token-2022 (G6), and an account carrying an extension is longer than the
  // base layout. Dropping those would drop the real holders.
  assert.equal(ownersAboveFloor([tokenAccount(7, 500n, 83)], 100n).length, 1);
});

test('one owner with several accounts appears once', () => {
  assert.equal(ownersAboveFloor([tokenAccount(7, 500n), tokenAccount(7, 600n)], 100n).length, 1);
});

test('data too short to be a token account is skipped, not guessed at', () => {
  assert.deepEqual(ownersAboveFloor([{ account: { data: Buffer.alloc(40) } }], 1n), []);
});
