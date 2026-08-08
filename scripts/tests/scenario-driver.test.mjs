// The matrix as data — assignment, timing, and what each row does.
//
// The driver's chain calls cannot be tested here. What can be, and what a
// rehearsal silently depends on, is the bookkeeping: a row assigned to the
// wrong wallet asserts against a history that belongs to someone else, and a
// plan out of time order fires actions late — which writes a balance history
// no row in §5 describes, and therefore looks like a result rather than a
// failure.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { SCENARIOS, T, actionOf, assignWallets, planFor, requiredWallets } = await import(
  '../tools/scenario-driver.mjs'
);

const WINDOW = { start: 1_767_225_600, end: 1_767_225_600 + 600 };

const scenarioCast = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `w${String(i + 1).padStart(2, '0')}`,
    scenario: true,
  }));

const withNamedRoles = (n) => [
  { name: 'steady', scenario: false },
  { name: 'dumper', scenario: false },
  ...scenarioCast(n),
];

// ── which wallets the matrix needs ─────────────────────────────────────────

test('a row acting twice is one wallet, not two', () => {
  // B6 and B6b are one wallet's morning and afternoon. Counting them twice
  // would over-request the cast and break the two-step rows apart.
  const wallets = requiredWallets();
  assert.equal(new Set(wallets).size, wallets.length);
  assert.ok(wallets.includes('B6'));
  assert.ok(!wallets.includes('B6b'));
});

test('every scenario resolves to a wallet in the assignment', () => {
  const assignment = assignWallets(scenarioCast(40));
  for (const s of SCENARIOS) {
    assert.ok(assignment[s.id2 ?? s.id], `${s.id} has no wallet`);
  }
});

// ── assignment ─────────────────────────────────────────────────────────────

test('the named roles are never assigned a matrix row', () => {
  // `dumper` sells on dry-run-loop's schedule; a row pointing at it would be
  // two scripts fighting over one balance.
  const assignment = assignWallets(withNamedRoles(40));
  const used = new Set(Object.values(assignment));
  assert.ok(!used.has('steady'));
  assert.ok(!used.has('dumper'));
});

test('assignment is stable across calls', () => {
  // Re-assigning mid-run leaves B3's seven-epoch lockout on a wallet nobody is
  // looking at, and asserts against one that was never locked.
  const cast = scenarioCast(40);
  assert.deepEqual(assignWallets(cast), assignWallets(cast));
});

test('assignment does not depend on the order the cast happens to be listed in', () => {
  const cast = scenarioCast(40);
  const shuffled = [...cast].reverse();
  assert.deepEqual(assignWallets(cast), assignWallets(shuffled));
});

test('one wallet per row, never shared', () => {
  const assignment = assignWallets(scenarioCast(40));
  const wallets = Object.values(assignment);
  assert.equal(new Set(wallets).size, wallets.length);
});

test('too small a cast is refused, with the command that fixes it', () => {
  assert.throws(() => assignWallets(scenarioCast(3)), /mk-pump-cast\.mjs --count/);
});

// ── timing ─────────────────────────────────────────────────────────────────

test('the plan is in time order', () => {
  const plan = planFor({ window: WINDOW, assignment: assignWallets(scenarioCast(40)) });
  const times = plan.map((s) => s.at);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
});

test('fractions become absolute times inside the window', () => {
  const plan = planFor({ window: WINDOW, assignment: assignWallets(scenarioCast(40)) });
  for (const step of plan) {
    assert.ok(step.at >= WINDOW.start && step.at < WINDOW.end, `${step.id} is outside the window`);
  }
});

test('the same table drives a 600s rehearsal and an 86,400s day', () => {
  // This is why rows say "25% in" rather than a timestamp.
  const assignment = assignWallets(scenarioCast(40));
  const short = planFor({ window: WINDOW, assignment });
  const day = planFor({
    window: { start: WINDOW.start, end: WINDOW.start + 86_400 },
    assignment,
  });
  assert.deepEqual(short.map((s) => s.id), day.map((s) => s.id));
  const a4short = short.find((s) => s.id === 'A4');
  const a4day = day.find((s) => s.id === 'A4');
  assert.equal(a4short.at - WINDOW.start, 150, '25% of 600s');
  assert.equal(a4day.at - WINDOW.start, 21_600, '25% of a day');
});

test('a two-step row keeps its steps in order and on one wallet', () => {
  const plan = planFor({ window: WINDOW, assignment: assignWallets(scenarioCast(40)) });
  const b6 = plan.filter((s) => (s.id2 ?? s.id) === 'B6');
  assert.equal(b6.length, 2);
  assert.ok(b6[0].at < b6[1].at, 'the trim happens before the buy-back');
  assert.equal(b6[0].wallet, b6[1].wallet);
});

// ── what each row does ─────────────────────────────────────────────────────

test('B9 and B10 transfer, they do not sell', () => {
  // The rows exist to prove there is no netting across wallets, which a sale
  // cannot demonstrate no matter where the balance lands.
  for (const id of ['B9', 'B10']) {
    const row = SCENARIOS.find((s) => s.id === id);
    assert.equal(row.transferToOwn, true);
    assert.equal(actionOf(row), 'transfer-out');
  }
});

test('a buy is a buy and a top-up is labelled as one', () => {
  assert.equal(actionOf(SCENARIOS.find((s) => s.id === 'A4')), 'buy');
  assert.equal(actionOf(SCENARIOS.find((s) => s.id === 'A8')), 'top-up');
});

test('the floor rows sit exactly either side of it', () => {
  assert.equal(SCENARIOS.find((s) => s.id === 'A2').target, T(100_000));
  assert.equal(SCENARIOS.find((s) => s.id === 'A3').target, T(99_999));
  assert.equal(SCENARIOS.find((s) => s.id === 'B2').target, T(100_000));
  assert.equal(SCENARIOS.find((s) => s.id === 'B3').target, T(99_999));
});

test('B5 sells to nothing, which is a target of zero and not a missing target', () => {
  const b5 = SCENARIOS.find((s) => s.id === 'B5');
  assert.equal(b5.target, 0n);
  assert.equal(actionOf(b5), 'sell-to', 'a 0n target must not read as "no target"');
});

test('every row carries the sentence it is asserted against', () => {
  for (const s of SCENARIOS) assert.ok(s.expect?.length > 10, `${s.id} has no expectation`);
});
