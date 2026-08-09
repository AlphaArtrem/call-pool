// The deploy profiles — that each one's clock is internally consistent.
//
// `deploy/` is split by clock (devnet/one_hour, devnet/two_hour, mainnet)
// because the timings are what changes between a rehearsal and the real coin,
// and every way of getting them wrong is silent. Run 2 ran a devnet epoch with
// mainnet's `--stale-after`, and the watchdog hid a dead crank for three
// epochs while reporting normally.
//
// The relationships pinned here are the ones where a wrong number produces a
// run that looks healthy and proves nothing.
//
// Nothing here touches a network or a chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPO_ROOT } from '../lib/store.mjs';

const DEPLOY = resolve(REPO_ROOT, 'deploy');
const DEVNET_PROFILES = ['devnet/one_hour', 'devnet/two_hour'];

const read = (...parts) => readFileSync(resolve(DEPLOY, ...parts), 'utf8');

/** The `KEY=value` pairs from a profile.env, ignoring its commentary. */
function profileEnv(dir) {
  const env = {};
  for (const line of read(dir, 'profile.env').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** A systemd unit's ExecStart, joined across its line continuations. */
const execStart = (dir, unit) => {
  const source = read(dir, unit);
  const start = source.indexOf('ExecStart=');
  const line = source.slice(start).split('\n');
  const parts = [];
  for (const l of line) {
    parts.push(l.replace(/\\$/, ''));
    if (!l.trimEnd().endsWith('\\')) break;
  }
  return parts.join(' ');
};

const flag = (command, name) => {
  const match = new RegExp(`--${name}\\s+(\\S+)`).exec(command);
  return match ? Number(match[1]) : null;
};

test('every profile declares the two values initialize writes permanently', () => {
  // There is no `set_params` and no admin path. A run deployed with the wrong
  // epoch length is a coin that pays on the wrong clock for the rest of its
  // life, and the only repair is a new program and a new coin.
  for (const dir of DEVNET_PROFILES) {
    const env = profileEnv(dir);
    assert.ok(Number(env.CALLPOOL_EPOCH_SECONDS) > 0, `${dir} epoch_seconds`);
    assert.ok(Number(env.CALLPOOL_CHALLENGE_SECONDS) > 0, `${dir} challenge_seconds`);
  }
});

test('the crank waits longer for a root than its own challenge window', () => {
  // `--await-root` waits the challenge window out in-process. Set it below the
  // window and the crank gives up before the root can be posted — every epoch
  // lands unpaid, and it reads as a multisig problem rather than a timeout.
  for (const dir of DEVNET_PROFILES) {
    const challenge = Number(profileEnv(dir).CALLPOOL_CHALLENGE_SECONDS);
    const awaitRoot = flag(execStart(dir, 'callpool-crank.service'), 'await-root');

    assert.ok(
      awaitRoot > challenge,
      `${dir}: --await-root ${awaitRoot} must exceed challenge_seconds ${challenge}`,
    );
  }
});

test('stale-after is at least one whole epoch past grace', () => {
  // The documented rule, and the line between "late, the next tick fixes it"
  // and "stale, it needs a rebuild". Too low and every epoch pages while it is
  // still settling normally; too high and a dead crank is invisible.
  for (const dir of DEVNET_PROFILES) {
    const epoch = Number(profileEnv(dir).CALLPOOL_EPOCH_SECONDS);
    const command = execStart(dir, 'callpool-watchdog.service');
    const grace = flag(command, 'grace');
    const stale = flag(command, 'stale-after');

    assert.ok(
      stale >= grace + epoch,
      `${dir}: --stale-after ${stale} should be at least grace ${grace} + one epoch ${epoch}`,
    );
  }
});

test('a devnet profile never inherits the mainnet watchdog sizing', () => {
  // Run 2's actual failure: mainnet's numbers on a five-minute epoch.
  const mainnet = execStart('mainnet', 'callpool-watchdog.service');
  for (const dir of DEVNET_PROFILES) {
    const command = execStart(dir, 'callpool-watchdog.service');
    assert.notEqual(flag(command, 'stale-after'), flag(mainnet, 'stale-after'), dir);
  }
});

test('every devnet profile sets --sample-stale, because its default cannot fire', () => {
  // A separate flag from --stale-after: it is the SAMPLER's staleness. The
  // 7200s default is sized for hourly sampling, so on any devnet clock it never
  // fires and F9 — the stopped-sampler alert — becomes untestable.
  for (const dir of DEVNET_PROFILES) {
    const sampleStale = flag(execStart(dir, 'callpool-watchdog.service'), 'sample-stale');
    assert.ok(sampleStale !== null, `${dir} must set --sample-stale explicitly`);
    assert.ok(sampleStale < 7200, `${dir}: --sample-stale ${sampleStale} must be under the 7200s default`);
  }
});

test('the sampler runs more than once per epoch, or it samples nothing', () => {
  // A sampler that fires once per epoch races the epoch boundary and is subject
  // to MIN_ELAPSED_SECONDS at the start, so it can easily produce no sample at
  // all for an epoch.
  const seconds = (timer) => {
    const match = /OnCalendar=\*:0\/(\d+)/.exec(timer);
    return match ? Number(match[1]) * 60 : null;
  };
  for (const dir of DEVNET_PROFILES) {
    const interval = seconds(read(dir, 'callpool-sample-standings.timer'));
    const epoch = Number(profileEnv(dir).CALLPOOL_EPOCH_SECONDS);

    assert.ok(interval !== null, `${dir} sampler timer should use an OnCalendar interval`);
    assert.ok(interval < epoch, `${dir}: sampler every ${interval}s must be shorter than a ${epoch}s epoch`);
  }
});

test('the crank fires once per epoch, offset past the boundary', () => {
  // On the boundary exactly and it races the epoch it is meant to settle.
  for (const dir of DEVNET_PROFILES) {
    const timer = read(dir, 'callpool-crank.timer');
    const match = /OnCalendar=\*:0\/(\d+):(\d+)/.exec(timer);

    assert.ok(match, `${dir} crank timer should fire on a minute interval with an offset`);
    assert.equal(
      Number(match[1]) * 60,
      Number(profileEnv(dir).CALLPOOL_EPOCH_SECONDS),
      `${dir}: the crank should tick once per epoch`,
    );
    assert.ok(Number(match[2]) > 0, `${dir}: the crank must be offset past the boundary, not on it`);
  }
});

test('the trade loop is devnet-only and mainnet says so', () => {
  // It buys and sells the coin on a schedule to make creator fees accrue. On
  // mainnet that is market-making with the payer's SOL.
  assert.ok(existsSync(resolve(DEPLOY, 'callpool-trade.service')));
  assert.match(read('mainnet', 'README.md'), /callpool-trade\.service/);
  assert.match(read('mainnet', 'README.md'), /NOT be installed/i);
});

// ── a unit that names a key path is not shared (2026-08-09) ────────────────
//
// `deploy/callpool-cosign.service` sat at the top level looking shared. It was
// a mainnet unit: it named `/etc/callpool/mainnet-signer-b.json`, pointed
// `--callout-store` at the mainnet path, and took `--base` from an environment
// variable only the mainnet box sets. Box B had been hand-patched with the
// devnet values for three runs and nobody compared the running unit to the file.
//
// Installing the repo version over that patch produced a co-signer that failed
// every 60 seconds with `--base <URL> is required`, so run 4's epoch 0 sat at
// 1-of-2 until the crank gave up at 400s — the F13 failure, reached from a
// direction the checklist did not cover.

test('no devnet profile unit references a mainnet key or path', () => {
  for (const dir of DEVNET_PROFILES) {
    for (const unit of ['callpool-cosign.service', 'callpool-crank.service', 'callpool-airdrop.service']) {
      const source = read(dir, unit);
      const exec = source.slice(source.indexOf('ExecStart='));
      assert.doesNotMatch(
        exec,
        /mainnet-(payer|signer)/,
        `${dir}/${unit} names a mainnet key — devnet and mainnet units are not interchangeable`,
      );
    }
  }
});

test('every co-signer unit passes --base, which is required and has no default', () => {
  for (const dir of [...DEVNET_PROFILES, 'mainnet']) {
    assert.match(
      execStart(dir, 'callpool-cosign.service'),
      /--base\s+\S/,
      `${dir}: cosign-remote refuses to start without --base`,
    );
  }
});

test('the devnet co-signer signs with the devnet key', () => {
  for (const dir of DEVNET_PROFILES) {
    assert.match(execStart(dir, 'callpool-cosign.service'), /\/etc\/callpool\/signerB\.json/, dir);
  }
});

test('every profile has an airdrop timer, because the crank can die after posting', () => {
  // `--and-pay` covers the happy path. The case this exists for is the crank
  // exiting between posting a root and paying it — run 4's epoch 0. Once
  // settled, the epoch is no longer *outstanding*, so `settle-outstanding` will
  // never revisit it and it stays unpaid forever.
  for (const dir of [...DEVNET_PROFILES, 'mainnet']) {
    assert.ok(
      existsSync(resolve(DEPLOY, dir, 'callpool-airdrop.timer')),
      `${dir} needs an airdrop timer as the settled-but-unpaid safety net`,
    );
  }
});

test('the devnet airdrop retries in minutes, not three times a day', () => {
  // Mainnet epochs are days, so 06/12/18 UTC is fine there. A devnet run is
  // over in hours — an unpaid epoch has to be picked up within the run or the
  // run ends with it unpaid.
  for (const dir of DEVNET_PROFILES) {
    const match = /OnCalendar=\*:0\/(\d+):(\d+)/.exec(read(dir, 'callpool-airdrop.timer'));
    assert.ok(match, `${dir}: the devnet airdrop should run on a minute interval`);
    assert.ok(Number(match[1]) <= 10, `${dir}: every ${match[1]} minutes is too slow for a devnet run`);
    assert.notEqual(
      match[2],
      /OnCalendar=\*:0\/\d+:(\d+)/.exec(read(dir, 'callpool-crank.timer'))?.[1],
      `${dir}: the airdrop must not fire on the same second as the crank`,
    );
  }
});

// ── the lockout arithmetic a run has to satisfy to prove B12 ───────────────
//
// `LOCKOUT_EPOCHS` is 7, so a wallet selling in epoch 0 is locked across 1-7
// and earns again at epoch 8 — which must itself close and settle. Nine epochs.
//
// An 80-minute run at 10-minute epochs reaches epoch 7 and shows only what runs
// 3 and 4 already showed: that the lockout fires. This test exists so the
// off-by-one is caught in the profile rather than discovered at the end of a
// run that cannot be repeated cheaply.

test('a profile either reaches the lockout or declares that it cannot', () => {
  // Read from `CALLPOOL_UNREACHABLE_ROWS`, not from the README's prose. The
  // first version of this test parsed English and flagged the two_hour profile
  // for mentioning B12 — which it does, to say it cannot reach it. A claim a
  // test depends on has to be machine-readable.
  const NEEDED = 9; // sell in epoch 0, locked 1-7, earning again at 8

  for (const dir of DEVNET_PROFILES) {
    const env = profileEnv(dir);
    const epochs = Number(env.CALLPOOL_RUN_EPOCHS);
    const declaredUnreachable = (env.CALLPOOL_UNREACHABLE_ROWS ?? '').split(',').filter(Boolean);

    if (epochs >= NEEDED) {
      assert.ok(
        !declaredUnreachable.includes('B12'),
        `${dir} has ${epochs} epochs, enough for B12, but declares it unreachable`,
      );
    } else {
      assert.ok(
        declaredUnreachable.includes('B12'),
        `${dir} has only ${epochs} epochs and must declare B12 unreachable — ` +
          'four epochs must never be reported as twelve epochs of evidence',
      );
    }
  }
});

test('the declared run length and epoch count agree with each other', () => {
  for (const dir of DEVNET_PROFILES) {
    const env = profileEnv(dir);
    assert.equal(
      Number(env.CALLPOOL_RUN_SECONDS),
      Number(env.CALLPOOL_RUN_EPOCHS) * Number(env.CALLPOOL_EPOCH_SECONDS),
      `${dir}: RUN_SECONDS should be exactly RUN_EPOCHS × EPOCH_SECONDS`,
    );
  }
});
