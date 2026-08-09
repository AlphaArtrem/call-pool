// The cast builder — who gets built, in what order, and what a resume keeps.
//
// The tool itself buys coin on devnet and cannot be tested here. What can be,
// and what the sixty-wallet run actually depends on, is the bookkeeping around
// the buying: a roster that drops the four named roles breaks three other
// tools, a batcher that loses its last group leaves a funded wallet nobody
// holds the key to, and a resume that misjudges "already built" either
// re-spends SOL the faucets cannot replace or skips a wallet that never bought.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';

const { roster, fundingBatches, alreadyBuilt, repairFromChain, GAS_SOL } = await import('../tools/mk-pump-cast.mjs');

// ── the roster ─────────────────────────────────────────────────────────────

test('the four named roles are built even when no scenario wallets are asked for', () => {
  // `mock-callouts.mjs` keys fader's silence off the string, `mock-sale.mjs`
  // takes `--wallet dumper`, and `dry-run-loop.mjs` scripts both. Losing these
  // names breaks all three without touching them.
  const names = roster({ count: 0 }).map((m) => m.name);
  assert.deepEqual(names, ['steady', 'fader', 'dumper', 'minnow']);
});

test('scenario wallets are added after the named roles, never instead of them', () => {
  const names = roster({ count: 3 }).map((m) => m.name);
  assert.deepEqual(names, ['steady', 'fader', 'dumper', 'minnow', 'w01', 'w02', 'w03']);
});

test('scenario names sort in the order they were made', () => {
  // `w2` before `w10` under a string sort would shuffle the driver's row
  // assignment between runs, which is how a matrix row silently changes wallet.
  const scenario = roster({ count: 12 }).filter((m) => m.scenario).map((m) => m.name);
  assert.deepEqual([...scenario].sort(), scenario);
  assert.equal(scenario[1], 'w02');
  assert.equal(scenario[11], 'w12');
});

test('minnow is the only role that wants to be under the floor', () => {
  const below = roster({ count: 60 }).filter((m) => !m.wantAboveFloor).map((m) => m.name);
  assert.deepEqual(below, ['minnow']);
});

test('sixty scenario wallets is the size the matrix actually needs', () => {
  // D1 wants 60 eligible in one epoch, to prove 12 airdrop transactions at
  // CLAIMS_PER_TX = 5.
  const scenario = roster({ count: 60 }).filter((m) => m.scenario);
  assert.equal(scenario.length, 60);
  assert.equal(Math.ceil(scenario.length / 5), 12);
});

test('--no-legacy builds scenario wallets alone', () => {
  const names = roster({ count: 2, noLegacy: true }).map((m) => m.name);
  assert.deepEqual(names, ['w01', 'w02']);
});

test('the scenario buy size is overridable and does not touch the named roles', () => {
  const all = roster({ count: 1, scenarioSol: 0.5 });
  assert.equal(all.find((m) => m.name === 'w01').sol, 0.5);
  assert.equal(all.find((m) => m.name === 'minnow').sol, 0.0015);
});

test('the roster hands out fresh objects, so a --sol override cannot leak between runs', () => {
  const first = roster({ count: 0 });
  first[0].sol = 99;
  assert.notEqual(roster({ count: 0 })[0].sol, 99);
});

// ── funding batches ────────────────────────────────────────────────────────

test('every member lands in exactly one batch', () => {
  const members = roster({ count: 60 });
  const batched = fundingBatches(members).flat();
  assert.equal(batched.length, members.length);
  assert.deepEqual(batched.map((m) => m.name), members.map((m) => m.name));
});

test('a partial final batch is kept, not dropped', () => {
  // 64 members at 15 per transaction is four full batches and a remainder of
  // four. Losing the remainder funds nobody and is invisible until the buy.
  const batches = fundingBatches(roster({ count: 60 }), 15);
  assert.equal(batches.length, 5);
  assert.equal(batches.at(-1).length, 4);
});

test('a roster smaller than one batch is a single batch', () => {
  assert.equal(fundingBatches(roster({ count: 0 }), 15).length, 1);
});

test('an empty roster produces no transactions at all', () => {
  assert.deepEqual(fundingBatches([], 15), []);
});

// ── resume ─────────────────────────────────────────────────────────────────

test('a wallet holding coin is done', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '500000000000' }], 'w01'), true);
});

test('a funded wallet whose buy failed is NOT done — that is the case resume is for', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '0' }], 'w01'), false);
  assert.equal(alreadyBuilt([{ name: 'w01' }], 'w01'), false);
});

test('a wallet the manifest has never heard of is not done', () => {
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '1' }], 'w02'), false);
  assert.equal(alreadyBuilt(undefined, 'w01'), false);
  assert.equal(alreadyBuilt([], 'w01'), false);
});

test('balances are compared as BigInt, not as Numbers', () => {
  // A raw balance well past 2^53. Read as a Number this still tests truthy, so
  // the bug would hide here and surface as a precision error somewhere else.
  assert.equal(alreadyBuilt([{ name: 'w01', rawTokens: '9007199254740993' }], 'w01'), true);
});

// ── the ordering rule that cost 5.03 SOL ───────────────────────────────────

test('gas covers a graduated buy, which pays for two ATAs and not one', () => {
  // 0.02 was sized for the bonding curve. The AMM path wraps SOL through its
  // own account as well as creating the token account, and exhausted it:
  // `Transfer: insufficient lamports 603240, need 2039280` (2026-08-08).
  const ATA_RENT = 0.00204;
  assert.ok(
    GAS_SOL >= 2 * ATA_RENT + 0.01,
    `gas is ${GAS_SOL}; it must cover two ATAs plus fee and slippage headroom`,
  );
});

// ── the stale post-confirm read (2026-08-09) ───────────────────────────────
//
// Run 3's cast reported fifteen of sixty-four wallets as holding nothing,
// seconds after buys that had each landed millions of tokens. Nothing threw:
// `sendAndConfirmTransaction` confirmed, and the balance read that followed was
// answered by a node behind the one that confirmed. The zeros went into the
// manifest as fact — and `scenario-driver --assign` reads the manifest, so the
// matrix would have been computed against holdings that never existed.
//
// Two defences, tested here: the manifest gets repaired from the chain, and a
// resume never re-buys a wallet the chain says is already holding.

test('a manifest zero that the chain contradicts is repaired, not believed', async () => {
  const existing = [
    { name: 'w01', tokenAccount: 'ATA1', rawTokens: '0', tokens: '0', aboveFloor: false },
  ];
  const repaired = await repairFromChain(null, existing, { read: async () => 8_580_607_519_619n });

  assert.deepEqual(repaired, ['w01']);
  assert.equal(existing[0].rawTokens, '8580607519619');
  assert.equal(existing[0].aboveFloor, true);
  // Raw units are 10^6 per token here, so the human figure must be divided down
  // rather than copied — a manifest that reports raw units as tokens reads as a
  // wallet a million times richer than it is.
  assert.equal(existing[0].tokens, '8580607');
});

test('a wallet that really is empty stays empty — the repair is not a rescue', async () => {
  // A buy that genuinely never landed must stay visible, or `--resume` skips
  // the one wallet it exists to rebuild.
  const existing = [{ name: 'w02', tokenAccount: 'ATA2', rawTokens: '0' }];
  const repaired = await repairFromChain(null, existing, { read: async () => 0n });

  assert.deepEqual(repaired, []);
  assert.equal(alreadyBuilt(existing, 'w02'), false);
});

test('the repair only asks the chain about wallets the manifest calls empty', async () => {
  // A balance already on file cannot have been invented by a stale read, and
  // sixty needless reads is how a run meets a rate limit it did not have to.
  const asked = [];
  const existing = [
    { name: 'w01', tokenAccount: 'ATA1', rawTokens: '500000000000' },
    { name: 'w02', tokenAccount: 'ATA2', rawTokens: '0' },
  ];
  await repairFromChain(null, existing, {
    read: async (_connection, ata) => {
      asked.push(String(ata));
      return 0n;
    },
  });

  assert.deepEqual(asked, ['ATA2']);
});

test('a record with no token account is left alone rather than crashing the resume', async () => {
  // A crash between funding and the first buy leaves exactly this shape, and a
  // resume that throws here strands every wallet after it.
  const existing = [{ name: 'w01', rawTokens: '0' }];
  const repaired = await repairFromChain(null, existing, {
    read: async () => {
      throw new Error('should never be asked');
    },
  });

  assert.deepEqual(repaired, []);
});

test('after the repair, resume treats the corrected wallet as already built', async () => {
  // The whole point: `alreadyBuilt` is what decides who gets re-bought, so the
  // repair has to land somewhere `alreadyBuilt` can see it.
  const existing = [{ name: 'w01', tokenAccount: 'ATA1', rawTokens: '0' }];
  assert.equal(alreadyBuilt(existing, 'w01'), false);

  await repairFromChain(null, existing, { read: async () => 5_136_591_930_424n });

  assert.equal(alreadyBuilt(existing, 'w01'), true);
});

// ── the curve can fill up mid-build (2026-08-09, run 5) ────────────────────
//
// Every buy pushes the bonding curve toward completion, and completion is
// graduation: the curve then refuses with `BondingCurveComplete` (0x1775) and
// the AMM is the only venue — which on devnet may never exist, because pump has
// never been observed migrating a devnet coin (G12).
//
// Run 5 completed the curve on its sixty-fourth wallet and learned about it
// from the failure, leaving a coin that could neither be bought on nor
// graduated away from. The matrix needs nine buy and top-up steps, so that
// deployment was dead.
//
// The sizing lesson is in the numbers: run 2 measured ~3.9 SOL to complete the
// curve, run 5 completed at ~2.8. A cast sized against a remembered figure is
// sized against the wrong coin.

test('the builder checks the curve before each buy, not only after the last', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../tools/mk-pump-cast.mjs'),
    'utf8',
  );

  const loop = source.slice(source.indexOf('for (const member of wanted)'));
  const beforeBuy = loop.slice(0, loop.indexOf('buildBuyInstructions'));

  assert.match(
    beforeBuy,
    /readCurveState/,
    'the loop must ask the chain whether the curve is still open before spending',
  );
  assert.match(
    beforeBuy,
    /writeManifest/,
    'the wallets already built must be persisted before the build stops',
  );
});

test('a completed curve stops the build rather than letting it fail per wallet', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../tools/mk-pump-cast.mjs'),
    'utf8',
  );

  // The instruction has to name the only thing that works: a fresh coin. A
  // `--resume` against a completed curve cannot succeed, and suggesting it
  // would send the operator round the loop that just failed.
  const stop = source.slice(source.indexOf('the bonding curve completed before'));
  const message = stop.slice(0, stop.indexOf('process.exitCode'));

  assert.match(message, /FRESH coin/, 'the fix is a new coin, and the message must say so');
  assert.match(message, /Lower --scenario-sol/, 'and that the cast must be sized smaller');
});
