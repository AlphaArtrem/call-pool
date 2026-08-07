// The gate in front of the one irreversible transaction.
//
// Every test here is a value that is *plausible* — the wrong-but-believable
// kind the program deliberately accepts and its own unit test calls out. The
// obviously-wrong cases are already refused on chain and are not this module's
// job.

import assert from 'node:assert/strict';
import test from 'node:test';

import { EPOCH_SECONDS, MIN_HOLD_RAW, MIN_HOLD_TOKENS, MINT_DECIMALS } from '../lib/config.mjs';
import { CHALLENGE_SECONDS, checkMint, checkParameters, minRawFloor, preflight } from '../lib/preflight.mjs';
import { nextBoundary } from '../tools/preflight-initialize.mjs';

const NOW = 1_800_000_000 - (1_800_000_000 % EPOCH_SECONDS);

const GOOD_MINT = {
  decimals: MINT_DECIMALS,
  supply: 1_000_000_000n * 10n ** BigInt(MINT_DECIMALS),
};

const GOOD_PARAMS = {
  minHold: MIN_HOLD_RAW,
  epochSeconds: EPOCH_SECONDS,
  challengeSeconds: CHALLENGE_SECONDS,
  genesisTs: NOW,
  now: NOW,
  snapshotKey: 'VauLtAddre55',
};

const fatalChecks = (problems) => problems.filter((p) => p.fatal).map((p) => p.check);

// ── the happy path ─────────────────────────────────────────────────────────

test('the intended mainnet parameters pass', () => {
  const { ok, problems } = preflight(GOOD_MINT, GOOD_PARAMS);
  assert.equal(ok, true, JSON.stringify(problems, null, 2));
  assert.deepEqual(fatalChecks(problems), []);
});

// ── the decimals footgun, which multiplies the floor ────────────────────────

test('a mint with different decimals than config.mjs assumes is FATAL', () => {
  // The live case this guards: config.mjs says "pump.fun mints use 6" and
  // carries its own VERIFY note. A 9-decimal mint would have the floor written
  // 1,000× too small, permanently, and every other line of the preflight would
  // still look correct.
  const problems = checkMint({ ...GOOD_MINT, decimals: 9 });
  assert.ok(fatalChecks(problems).includes('decimals'));
  assert.match(problems[0].message, /Fix MINT_DECIMALS/);
});

test('the decimals check fires even when the raw floor is otherwise self-consistent', () => {
  const { ok } = preflight({ decimals: 9, supply: 1_000_000_000n * 10n ** 9n }, GOOD_PARAMS);
  assert.equal(ok, false);
});

// ── the plausible-but-wrong floor ──────────────────────────────────────────

test('a floor of 1,000 tokens — the value lib.rs admits it cannot catch — is FATAL here', () => {
  // programs/callpool/src/lib.rs:
  //   assert!(1_000_000_000u64 >= min_raw_floor(6), "1,000 tokens passes — wrong, but plausible");
  const wrong = 1_000n * 10n ** BigInt(MINT_DECIMALS);
  assert.ok(wrong >= minRawFloor(MINT_DECIMALS), 'the on-chain guard accepts it');

  const problems = checkParameters({ ...GOOD_PARAMS, minHold: wrong });
  assert.ok(fatalChecks(problems).includes('min_hold'), 'this module must not');
});

test('the rejected 50,000-token alternative is refused, not quietly accepted', () => {
  // L13 recorded 0.005% as a rejected alternative rather than an open option.
  const problems = checkParameters({
    ...GOOD_PARAMS,
    minHold: 50_000n * 10n ** BigInt(MINT_DECIMALS),
  });
  assert.ok(fatalChecks(problems).includes('min_hold'));
});

test('the correct floor is exactly what config.mjs computes', () => {
  assert.equal(MIN_HOLD_RAW, MIN_HOLD_TOKENS * 10n ** BigInt(MINT_DECIMALS));
  assert.deepEqual(fatalChecks(checkParameters(GOOD_PARAMS)), []);
});

// ── rehearsal clocks reaching mainnet ──────────────────────────────────────

test('a 300-second epoch is FATAL unless --rehearsal was asked for', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, epochSeconds: 300, genesisTs: NOW, now: NOW });
  assert.ok(fatalChecks(problems).includes('epoch_seconds'));
});

test('a 60-second challenge window is FATAL unless --rehearsal was asked for', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, challengeSeconds: 60 });
  assert.ok(fatalChecks(problems).includes('challenge_seconds'));
});

test('--rehearsal allows the short clocks and still checks everything else', () => {
  const problems = checkParameters(
    { ...GOOD_PARAMS, epochSeconds: 300, challengeSeconds: 60, genesisTs: NOW, now: NOW },
    { expectRehearsal: true },
  );
  assert.deepEqual(fatalChecks(problems), [], 'short clocks are fine in a rehearsal');

  const stillChecked = checkParameters(
    { ...GOOD_PARAMS, epochSeconds: 300, challengeSeconds: 60, minHold: 1n, genesisTs: NOW, now: NOW },
    { expectRehearsal: true },
  );
  assert.ok(fatalChecks(stillChecked).includes('min_hold'), 'the floor is not relaxed by --rehearsal');
});

test('defaulting to the mainnet expectation is the safe direction', () => {
  // Forgetting `--rehearsal` on a rehearsal produces a loud, harmless refusal.
  // Forgetting the reverse would write 300 seconds onto mainnet forever.
  const problems = checkParameters({ ...GOOD_PARAMS, epochSeconds: 300 });
  assert.ok(problems.some((p) => p.fatal));
});

// ── genesis ────────────────────────────────────────────────────────────────

test('an unaligned genesis is FATAL', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, genesisTs: NOW + 1 });
  assert.ok(fatalChecks(problems).includes('genesis_ts'));
});

test('a genesis more than one epoch away is FATAL', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, genesisTs: NOW + 3 * EPOCH_SECONDS });
  assert.ok(fatalChecks(problems).includes('genesis_ts'));
});

test('a genesis in the past warns about the unsettleable epoch 0 but does not block', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, genesisTs: NOW - EPOCH_SECONDS, now: NOW });
  const warnings = problems.filter((p) => !p.fatal);
  assert.ok(warnings.some((w) => w.check === 'genesis_ts'), 'F20 is said out loud');
  assert.deepEqual(fatalChecks(problems), [], 'costing one epoch is not worth refusing over');
});

test('nextBoundary lands on the next epoch boundary, and is a no-op when already on one', () => {
  assert.equal(nextBoundary(NOW, EPOCH_SECONDS), NOW);
  assert.equal(nextBoundary(NOW + 1, EPOCH_SECONDS), NOW + EPOCH_SECONDS);
  assert.equal(nextBoundary(NOW + EPOCH_SECONDS - 1, EPOCH_SECONDS), NOW + EPOCH_SECONDS);
});

// ── supply ─────────────────────────────────────────────────────────────────

test('a mint whose supply is not the billion the floor is a fraction of is FATAL', () => {
  const problems = checkMint({ decimals: MINT_DECIMALS, supply: 500_000_000n * 10n ** BigInt(MINT_DECIMALS) });
  assert.ok(fatalChecks(problems).includes('supply'));
});

// ── the snapshot key ───────────────────────────────────────────────────────

test('an unset or default snapshot key is FATAL', () => {
  assert.ok(fatalChecks(checkParameters({ ...GOOD_PARAMS, snapshotKey: '' })).includes('snapshot_key'));
  assert.ok(
    fatalChecks(checkParameters({ ...GOOD_PARAMS, snapshotKey: '11111111111111111111111111111111' }))
      .includes('snapshot_key'),
  );
});

// ── the program's own bounds, restated ─────────────────────────────────────

test('a challenge window outlasting the claim deadline is FATAL', () => {
  const problems = checkParameters(
    { ...GOOD_PARAMS, challengeSeconds: 31 * EPOCH_SECONDS },
    { expectRehearsal: true },
  );
  assert.ok(fatalChecks(problems).includes('challenge_seconds'));
});

test('a zero challenge window is FATAL', () => {
  const problems = checkParameters({ ...GOOD_PARAMS, challengeSeconds: 0 }, { expectRehearsal: true });
  assert.ok(fatalChecks(problems).includes('challenge_seconds'));
});
