// What `deploy-devnet.mjs` must not destroy when it runs a second time.
//
// The tool rebuilds `deployment.json` from scratch on every invocation, which is
// correct for the values it owns — program id, genesis, clocks — and wrong for
// the ones other tools wrote. On 2026-08-09 the `initialize` step erased a cast
// of sixty-four wallets that had just been bought with real SOL, and the
// eighteen matrix rows assigned against them, because the final devnet test's
// ordering deliberately puts both BEFORE initialize: the clock starts there, and
// every epoch after it must settle.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { carryForward } = await import('../tools/deploy-devnet.mjs');

test('an adopted coin keeps the cast that was bought before initialize ran', () => {
  const previous = { cast: [{ name: 'w01' }, { name: 'w02' }] };
  assert.deepEqual(carryForward(previous, { adopted: true }).cast, previous.cast);
});

test('the synthetic path replaces the cast, because there it mints its own', () => {
  // Without `--mint` this tool creates the coin and hands tokens out itself, so
  // its cast is the authoritative one and carrying an old one would describe
  // wallets holding a coin that no longer exists.
  const previous = { cast: [{ name: 'w01' }] };
  assert.equal(carryForward(previous, { adopted: false }).cast, undefined);
});

test('assigned matrix rows survive on either path', () => {
  // `--assign` writes the row→wallet mapping once and every later invocation
  // reads it. Losing it mid-run gives one row's history to a different wallet,
  // which is the failure the driver's own comments call out.
  //
  // The key is `scenarioAssignment`. The first version of this carry named it
  // `scenarios`, which nothing writes — so it carried a field that never
  // existed and silently dropped the real one. Read the writer, do not guess
  // the reader.
  const previous = { scenarioAssignment: { A2: 'w01', B3: 'w11' } };
  assert.deepEqual(
    carryForward(previous, { adopted: true }).scenarioAssignment,
    previous.scenarioAssignment,
  );
  assert.deepEqual(
    carryForward(previous, { adopted: false }).scenarioAssignment,
    previous.scenarioAssignment,
  );
});

test('the carried key is the one scenario-driver actually writes', async () => {
  // Pins the two files together. A rename on either side breaks this rather
  // than silently carrying nothing.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const driver = readFileSync(resolve(REPO_ROOT, 'scripts/tools/scenario-driver.mjs'), 'utf8');

  const written = /manifest\.([A-Za-z]+) = assignment/.exec(driver);
  assert.ok(written, 'scenario-driver should assign onto a named manifest field');
  assert.equal(written[1], 'scenarioAssignment');
  assert.deepEqual(
    Object.keys(carryForward({ [written[1]]: { A2: 'w01' } }, { adopted: true })),
    [written[1]],
  );
});

test('an empty cast is not carried, so a first run stays clean', () => {
  assert.deepEqual(carryForward({ cast: [] }, { adopted: true }), {});
});

test('a manifest with neither key carries nothing rather than throwing', () => {
  // The first deployment on a fresh box reads a manifest that has no cast and
  // no scenarios, and a throw here would block the run it is meant to protect.
  assert.deepEqual(carryForward({}, { adopted: true }), {});
  assert.deepEqual(carryForward(undefined, { adopted: true }), {});
});

// ── --stop-after-pool must leave something behind (2026-08-09) ─────────────
//
// The flag exists so the coin and its cast can be built BEFORE `initialize`
// starts the clock — the ordering the final devnet test settled on, because
// every epoch after initialize is one that must settle. It returned without
// writing a manifest, so on a clean box the next tool failed with "no devnet
// deployment" and the only way to produce one was to run the `initialize` the
// flag exists to defer.
//
// Three runs missed it because each inherited the previous run's stale
// manifest — right shape, wrong addresses. Only a genuinely fresh box showed it.

test('the tool reads a missing manifest as empty only when asked', async () => {
  const { readManifest } = await import('../tools/devnet.mjs');
  const missing = '/nonexistent/callpool/deployment.json';

  assert.deepEqual(readManifest(missing, { optional: true }), {});
  assert.throws(() => readManifest(missing), /no devnet deployment/);
});

test('stop-after-pool writes the addresses the cast builder needs', async () => {
  // Asserted against the source: the branch returns early, and what matters is
  // that it persists the manifest before it does.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { REPO_ROOT } = await import('../lib/store.mjs');
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/tools/deploy-devnet.mjs'), 'utf8');

  const branch = source.slice(source.indexOf('if (args.stopAfterPool)'));
  const body = branch.slice(0, branch.indexOf('\n  }'));

  assert.match(body, /writeManifest\(/, 'the branch must write a manifest before returning');
  for (const field of ['programId', 'pool', 'payer']) {
    assert.match(body, new RegExp(field), `the manifest needs ${field} for the cast to be buildable`);
  }
  // The clock is not known yet and a placeholder would be read as fact.
  assert.doesNotMatch(body, /genesisTs:/, 'genesis does not exist until initialize runs');
});
