#!/usr/bin/env node
//
// scripts/tools/watchdog.mjs — the thing that notices nothing happened.
//
// Every other check in this repository fires when something goes wrong. This
// one fires when nothing goes right, which is the failure that actually kills a
// coin: the crank stops, no error is raised because no code ran, fees keep
// accruing, holders keep calling, and from outside it is indistinguishable from
// a rug. Phase 09 §9.3.
//
//   node scripts/tools/watchdog.mjs --grace 900
//   ... --min-vault 0.05   alert when the vault cannot fund many more epochs
//   ... --heartbeat 86400  how often to say "still alive" when all is well
//   ... --once             check and exit (this is what a timer runs)
//
// **Run it somewhere else.** A watchdog on the machine it watches dies with
// that machine, silently, which is the exact scenario it exists for. On this
// deployment the crank is on box B and this belongs on box A.
//
// It reads only public chain state — no keys, no snapshot directory, no
// filesystem the crank touches. That is deliberate: it should be able to tell
// you the crank is dead without depending on anything the crank maintains.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { fetchConfig, fetchEpoch } from '../lib/program.mjs';
import { alert } from '../lib/alert.mjs';
import { REPO_ROOT } from '../lib/store.mjs';

/** How long after an epoch closes before an unposted root is a problem. */
const DEFAULT_GRACE_SECONDS = 900;

/** Re-send a standing alert this often, so a problem left unfixed keeps nagging. */
const DEFAULT_REPEAT_SECONDS = 3600;

/** Say "still alive" this often when there is nothing wrong. */
const DEFAULT_HEARTBEAT_SECONDS = 86_400;

/** Epochs to look back over. Beyond this, an unsettled epoch is history. */
const DEFAULT_LOOKBACK = 50;

function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    grace: DEFAULT_GRACE_SECONDS,
    repeat: DEFAULT_REPEAT_SECONDS,
    heartbeat: DEFAULT_HEARTBEAT_SECONDS,
    lookback: DEFAULT_LOOKBACK,
    minVault: 0.05,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--grace') args.grace = Number(argv[++i]);
    else if (argv[i] === '--repeat') args.repeat = Number(argv[++i]);
    else if (argv[i] === '--heartbeat') args.heartbeat = Number(argv[++i]);
    else if (argv[i] === '--lookback') args.lookback = Number(argv[++i]);
    else if (argv[i] === '--min-vault') args.minVault = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

/** When epoch `n`'s window closes. */
export const epochEnd = (epoch, { genesisTs, epochSeconds }) =>
  Number(genesisTs) + (epoch + 1) * Number(epochSeconds);

/** The epoch running at `now`. */
export const epochAt = (now, { genesisTs, epochSeconds }) =>
  Math.floor((now - Number(genesisTs)) / Number(epochSeconds));

/**
 * Epochs that closed long enough ago to have been settled, and were not.
 *
 * The grace period is what separates "late" from "dead". A multisig settlement
 * needs the second host's timer to come round, so a root that is four minutes
 * old is normal and one that is twenty minutes old is not.
 */
export async function overdueEpochs({ now, config, lookback, graceSeconds, hasRoot }) {
  const current = epochAt(now, config);
  const oldest = Math.max(0, current - lookback);
  const overdue = [];
  for (let epoch = oldest; epoch < current; epoch++) {
    const closedAt = epochEnd(epoch, config);
    if (now - closedAt < graceSeconds) continue;
    if (!(await hasRoot(epoch))) overdue.push({ epoch, closedAt, lateBy: now - closedAt });
  }
  return overdue;
}

/**
 * Epochs that allocated money and have paid out none of it.
 *
 * Deliberately "none", not "less than allocated". A shortfall is normal and
 * expected: `claim` refuses a holder who has sold below the floor (§4.5), so a
 * healthy epoch routinely ends with some lamports unclaimed. Alerting on that
 * would fire most days and teach everyone to ignore it.
 *
 * Zero claimed against a non-zero allocation is different — it means the
 * airdrop never ran, or failed for every leaf. That is the condition worth
 * waking someone for, and it is visible from chain state alone, which is why
 * the watchdog can catch it without trusting anything the crank maintains.
 */
export async function unpaidEpochs({ now, config, lookback, graceSeconds, readEpoch }) {
  const current = epochAt(now, config);
  const oldest = Math.max(0, current - lookback);
  const unpaid = [];
  for (let epoch = oldest; epoch < current; epoch++) {
    const account = await readEpoch(epoch);
    if (!account) continue; // no root at all — that is overdueEpochs' business
    const claimsOpenedAt = account.postedTs + Number(config.challengeSeconds);
    if (now - claimsOpenedAt < graceSeconds) continue;
    if (account.poolLamports > 0n && account.claimedLamports === 0n) {
      unpaid.push({ epoch, allocated: account.poolLamports, since: now - claimsOpenedAt });
    }
  }
  return unpaid;
}

/**
 * Has this alert gone quiet long enough to be worth repeating?
 *
 * Without this the watchdog sends the same line every tick and is muted within
 * the hour — an alerting channel nobody reads is worse than none, because it
 * looks like coverage.
 */
export function shouldAlert(state, key, now, repeatSeconds) {
  const last = state.alerted?.[key];
  return last == null || now - last >= repeatSeconds;
}

/** Remember that this alert was sent, so the next tick stays quiet. */
export function recordAlert(state, key, now) {
  return { ...state, alerted: { ...(state.alerted ?? {}), [key]: now } };
}

/** Drop remembered alerts for problems that have since cleared. */
export function forgetResolved(state, liveKeys) {
  const kept = Object.fromEntries(
    Object.entries(state.alerted ?? {}).filter(([key]) => liveKeys.includes(key)),
  );
  return { ...state, alerted: kept };
}

const readState = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const writeState = (path, state) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
};

async function check(args) {
  const statePath = args.state
    ? resolve(args.state)
    : resolve(REPO_ROOT, 'epochs/watchdog-state.json');

  const connection = connect(args.rpc);
  const config = await fetchConfig(connection);
  const mint = config.mint.toBase58();
  const now = Math.floor(Date.now() / 1000);

  let state = readState(statePath);
  const hasRoot = async (epoch) => (await fetchEpoch(connection, mint, epoch)) != null;

  const overdue = await overdueEpochs({
    now,
    config,
    lookback: args.lookback,
    graceSeconds: args.grace,
    hasRoot,
  });

  const unpaid = await unpaidEpochs({
    now,
    config,
    lookback: args.lookback,
    graceSeconds: args.grace,
    readEpoch: (epoch) => fetchEpoch(connection, mint, epoch),
  });

  const vaultLamports = await connection.getBalance(config.snapshotKey);
  const vaultSol = vaultLamports / 1e9;

  const problems = [];
  const keys = [];

  if (overdue.length > 0) {
    const key = `overdue-${overdue[0].epoch}`;
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const list = overdue
        .slice(0, 10)
        .map((o) => `  epoch ${o.epoch} — closed ${Math.round(o.lateBy / 60)} min ago, no root`)
        .join('\n');
      problems.push(
        `🔴 CALLPOOL — ${overdue.length} epoch(s) closed with NO ROOT ON CHAIN\n\n${list}\n\n` +
          'Fees are accruing and nobody is being paid. Check the crank on box B and the ' +
          'co-signer on box A. Roots can still be posted for these epochs — nothing is lost yet.',
      );
      state = recordAlert(state, key, now);
    }
  }

  if (unpaid.length > 0) {
    const key = `unpaid-${unpaid[0].epoch}`;
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const list = unpaid
        .slice(0, 10)
        .map((u) => `  epoch ${u.epoch} — ${u.allocated} lamports, none claimed, ${Math.round(u.since / 60)} min past the window`)
        .join('\n');
      problems.push(
        `🔴 CALLPOOL — ${unpaid.length} settled epoch(s) with NOTHING paid out\n\n${list}\n\n` +
          'The root is posted but the airdrop never landed. Re-running airdrop.mjs for these ' +
          'epochs is safe — claims are write-once on chain, so nobody can be paid twice.',
      );
      state = recordAlert(state, key, now);
    }
  }

  if (vaultSol < args.minVault) {
    const key = 'vault-low';
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      problems.push(
        `🟠 CALLPOOL — the multisig vault is low: ${vaultSol.toFixed(4)} SOL\n\n` +
          `${config.snapshotKey.toBase58()}\n\nIt pays rent for every epoch account it creates ` +
          '(~0.00146 SOL each). An unfunded vault stops the crank exactly as dead as a lost key.',
      );
      state = recordAlert(state, key, now);
    }
  }

  // A problem that has cleared should be able to fire again if it comes back.
  state = forgetResolved(state, keys);

  for (const text of problems) await alert(text);

  const quiet =
    problems.length === 0 && overdue.length === 0 && unpaid.length === 0 && vaultSol >= args.minVault;
  if (quiet && now - (state.lastHeartbeat ?? 0) >= args.heartbeat) {
    const current = epochAt(now, config);
    await alert(
      `🟢 CALLPOOL — still settling.\n\nepoch ${current} in progress, everything through ` +
        `${current - 1} has a root.\nvault ${vaultSol.toFixed(4)} SOL`,
    );
    state = { ...state, lastHeartbeat: now };
  }

  writeState(statePath, state);

  console.log(
    `watchdog: epoch ${epochAt(now, config)}, ${overdue.length} overdue, ${unpaid.length} unpaid, ` +
      `vault ${vaultSol.toFixed(4)} SOL, ${problems.length} alert(s) sent`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await check(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    // The watchdog failing is itself worth knowing about — a silent watchdog is
    // the same shape of problem as a silent crank.
    console.error(`\nWATCHDOG FAILED: ${error.message}\n`);
    await alert(`⚠️ CALLPOOL — the watchdog itself failed:\n\n${error.message}`);
    process.exitCode = 1;
  });
}
