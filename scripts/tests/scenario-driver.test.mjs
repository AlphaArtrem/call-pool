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

const { SCENARIOS, T, actionOf, assignWallets, planFor, requiredWallets, underfundedSteps } = await import(
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

// ── affordability, checked before the window rather than during it (2026-08-09)
//
// `mk-pump-cast` funds each scenario wallet with GAS_SOL (0.05) and spends part
// of it immediately on the initial buy and two ATAs. Three A-rows then ask for a
// 0.05 SOL buy, which the gas allowance was never going to cover — and because
// the rows fire at fixed fractions of a five-minute epoch, the discovery came as
// `custom program error: 0x1` at the exact moment A4 was due, taking twenty-one
// later rows down with it.

const LAMPORTS = 1_000_000_000;

test('a wallet holding only its leftover gas cannot afford a 0.05 SOL buy', () => {
  // 0.046 SOL is what a scenario wallet actually holds after the cast has run.
  const plan = [{ id: 'A4', wallet: 'w03', buy: 0.05 }];
  const balances = new Map([['w03', 0.046 * LAMPORTS]]);

  const short = underfundedSteps(plan, { balances });
  assert.equal(short.length, 1);
  assert.equal(short[0].id, 'A4');
});

test('the reserve is counted, so a balance that only just covers the buy is still short', () => {
  // Covering the buy exactly leaves nothing for the signature fee or ATA rent,
  // and the transaction fails for a reason the arithmetic said would not happen.
  const plan = [{ id: 'A4', wallet: 'w03', buy: 0.05 }];
  const balances = new Map([['w03', 0.05 * LAMPORTS]]);

  assert.equal(underfundedSteps(plan, { balances }).length, 1);
});

test('a properly funded wallet reports nothing', () => {
  const plan = [{ id: 'A4', wallet: 'w03', buy: 0.05 }];
  const balances = new Map([['w03', 0.2 * LAMPORTS]]);

  assert.deepEqual(underfundedSteps(plan, { balances }), []);
});

test('rows that do not buy are never called underfunded', () => {
  // Sells and transfers pay only a signature fee, and flagging them would bury
  // the three rows that genuinely cannot run under twenty that can.
  const plan = [
    { id: 'A2', wallet: 'w01', target: 1n },
    { id: 'B9', wallet: 'w17', target: 1n, transferToOwn: true },
  ];
  assert.deepEqual(underfundedSteps(plan, { balances: new Map() }), []);
});

test('a wallet with no balance recorded is treated as empty, not as fine', () => {
  // An unreadable or missing balance must fail loudly toward "top this up",
  // never silently toward "this will work".
  const plan = [{ id: 'A4', wallet: 'w03', buy: 0.05 }];
  assert.equal(underfundedSteps(plan, { balances: new Map() }).length, 1);
});

test('every buy row in the real matrix is checked, not just the first', () => {
  // A4, A5 and A6 all buy 0.05 and all three were unaffordable; a check that
  // stopped at the first would have hidden two of them.
  const plan = SCENARIOS.filter((s) => s.buy !== undefined).map((s) => ({ ...s, wallet: 'w03' }));
  const balances = new Map([['w03', 0]]);

  assert.equal(underfundedSteps(plan, { balances }).length, plan.length);
});

// ── the two rows that prove L22 had never run (2026-08-09) ─────────────────
//
// `main` holds the mint as a base58 string (`config.mint.toBase58()`), and
// `associatedTokenAddress` coerces it, so every sell, buy and top-up worked.
// `transferTokens` handed the same string straight to spl-token's instruction
// builders, which do not coerce — and the error surfaces from inside
// `Transaction.add` as `x.pubkey.toBase58 is not a function`, naming neither
// the mint nor the argument. B9 and B10 are the only rows that reach that
// helper, so the two rows that exist to prove "a transfer is not a sale" — the
// newest ruling in the system — had failed every time they were driven.

test('the transfer rows are the only ones that build instructions directly', () => {
  // If a third row ever takes this path, the coercion has to be checked there
  // too — this test is what will say so.
  const transferRows = SCENARIOS.filter((s) => s.transferToOwn).map((s) => s.id);
  assert.deepEqual(transferRows, ['B9', 'B10']);
});

test('transferTokens coerces the mint rather than trusting its caller', async () => {
  // Asserted against the source: the helper sends a real transaction, and what
  // matters is that no base58 string reaches an instruction builder.
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../tools/scenario-driver.mjs'),
    'utf8',
  );
  const helper = source.slice(source.indexOf('async function transferTokens'));
  const body = helper.slice(0, helper.indexOf('\n}\n'));

  assert.match(body, /new PublicKey\(mint\)/, 'the mint must be coerced before use');
  assert.doesNotMatch(
    body,
    /recipient,\s*mint,\s*tokenProgram/,
    'the raw string mint must not reach an spl-token instruction builder',
  );
});
