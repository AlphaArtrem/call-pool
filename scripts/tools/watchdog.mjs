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
//   ... --stale-after 900  past this, an overdue epoch needs a rebuild, not a
//                          restart. Defaults to grace + one epoch.
//   ... --once             check and exit (this is what a timer runs)
//
// An unsettled epoch is one of three things and they want opposite remedies,
// so they are counted and alerted separately rather than summed — see
// `classifyOverdue`. Summing them meant one outage pinned the total non-zero
// forever, and a number that can never reach zero is a number nobody reads.
//
// **Run it somewhere else.** A watchdog on the machine it watches dies with
// that machine, silently, which is the exact scenario it exists for. On the
// launch layout the crank is on box A, so this belongs on box B.
//
// It reads only public chain state — no keys, no snapshot directory, no
// filesystem the crank touches. That is deliberate: it should be able to tell
// you the crank is dead without depending on anything the crank maintains.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { connect } from '../lib/rpc.mjs';
import { DEFAULT_RPC_URL } from '../lib/config.mjs';
import { PROGRAM_ID, configPda, fetchConfig, fetchEpoch } from '../lib/program.mjs';
import { alert } from '../lib/alert.mjs';
import { iso } from '../lib/epoch.mjs';
import {
  checkVault, payEpoch, readLog, restartUnit, settleEpoch, topology, unitStatus,
  reachability, rebuildEpoch,
} from '../lib/runbook.mjs';
import { REPO_ROOT, SNAPSHOTS_DIR } from '../lib/store.mjs';

/** How long after an epoch closes before an unposted root is a problem. */
const DEFAULT_GRACE_SECONDS = 900;

/** Re-send a standing alert this often, so a problem left unfixed keeps nagging. */
const DEFAULT_REPEAT_SECONDS = 3600;

/** Say "still alive" this often when there is nothing wrong. */
const DEFAULT_HEARTBEAT_SECONDS = 86_400;

/** Epochs to look back over. Beyond this, an unsettled epoch is history. */
const DEFAULT_LOOKBACK = 50;

/**
 * How old the site's estimate may get before the sampler counts as stopped.
 *
 * Two hours: the sampler is hourly, so one missed run is slack for a slow
 * chain read or a reboot, and two is a pattern. Tighter than that would page
 * on ordinary jitter, which is how an alerting channel gets muted.
 */
const DEFAULT_SAMPLE_STALE_SECONDS = 7_200;

function parseArgs(argv) {
  const args = {
    rpc: DEFAULT_RPC_URL,
    grace: DEFAULT_GRACE_SECONDS,
    repeat: DEFAULT_REPEAT_SECONDS,
    heartbeat: DEFAULT_HEARTBEAT_SECONDS,
    lookback: DEFAULT_LOOKBACK,
    minVault: 0.05,
    sampleStale: DEFAULT_SAMPLE_STALE_SECONDS,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--grace') args.grace = Number(argv[++i]);
    else if (argv[i] === '--repeat') args.repeat = Number(argv[++i]);
    else if (argv[i] === '--heartbeat') args.heartbeat = Number(argv[++i]);
    else if (argv[i] === '--lookback') args.lookback = Number(argv[++i]);
    // Named explicitly: the generic branch below would store this as
    // `stale-after`, and the default would silently apply forever.
    else if (argv[i] === '--stale-after') args.staleAfter = Number(argv[++i]);
    // Same trap as `--stale-after`: the generic branch would store this under
    // `sample-stale` and leave the default quietly in force.
    else if (argv[i] === '--sample-stale') args.sampleStale = Number(argv[++i]);
    else if (argv[i] === '--min-vault') args.minVault = Number(argv[++i]);
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return args;
}

/** A duration a person can read at a glance, not 4980 seconds. */
export function minutes(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h}h ${Math.round((seconds - h * 3600) / 60)}m`;
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
 * Split the overdue epochs into the three things they can actually be.
 *
 * Summing them was the bug. One outage pins the total non-zero forever — a
 * stale epoch waits on a manual rebuild, and epoch 0 can never settle at all
 * when the deploy landed inside its window (F20) — so the number only ever
 * grows, "0 overdue" stops being reachable, and a count nobody can ever clear
 * is a count everybody learns to ignore. Worse, the three want opposite
 * remedies, and the 🔴 alert's first instruction is to restart services:
 *
 *   late        recent. Every ordinary cause is still live — a slow co-signer
 *               tick, a restart mid-flight, an RPC blip — so looking and
 *               restarting is the right first move, and waiting may fix it.
 *   stale       the services have had a full epoch to recover on their own and
 *               have not. Restarting does nothing: the snapshot was built
 *               against a pool that has since been drained past it (F10), and
 *               only `rebuildEpoch` re-derives it. Needs a person.
 *   impossible  no inputs were ever captured, so there is nothing to rebuild
 *               *from*. Worth saying once. Never worth saying twice, and never
 *               worth keeping the headline count off zero.
 *
 * The line between late and stale is one whole epoch past the grace period,
 * because that is exactly how long it takes for "it will sort itself out on the
 * next tick" to stop being true.
 *
 * `impossible` is decided by the caller — it needs a fact about when the
 * program was initialized that no amount of arithmetic here can supply.
 */
export function classifyOverdue(overdue, { staleAfterSeconds, impossible = [] }) {
  const buckets = { late: [], stale: [], impossible: [] };
  for (const entry of overdue) {
    if (impossible.includes(entry.epoch)) buckets.impossible.push(entry);
    else if (entry.lateBy >= staleAfterSeconds) buckets.stale.push(entry);
    else buckets.late.push(entry);
  }
  return buckets;
}

/**
 * Which epochs could never have been settled, because they predate the program.
 *
 * `initialize` accepts a genesis up to one whole epoch either side of the
 * moment it runs (`GenesisOutOfRange`), so a deploy that lands mid-epoch sets
 * epoch 0 to have started *before* the program existed. Nothing was polling the
 * callout feed for that window and nothing ever will be — the epoch has no
 * inputs, cannot be rebuilt, and will sit in the overdue count until it falls
 * out of the lookback weeks later. F20.
 *
 * Only epoch 0 can be in this state: every later epoch begins after
 * `initialize` has already run. So the question is a single comparison, and the
 * only hard part is knowing when `initialize` landed — which is the oldest
 * transaction the config account ever had.
 *
 * The answer never changes, so it is cached by the caller and this is asked
 * once in the lifetime of a deployment.
 */
export function impossibleEpochs({ config, initializedAt }) {
  if (initializedAt == null) return [];
  return initializedAt > Number(config.genesisTs) ? [0] : [];
}

/**
 * When `initialize` ran, read from the config account's own history.
 *
 * The config is written by `initialize` and then by every `post_epoch_root`, so
 * its oldest signature is the initialization. Paged backwards to the end, which
 * is one request per thousand epochs — on a daily clock, one request for the
 * first three years.
 *
 * Returns null rather than throwing if the history cannot be walked. A watchdog
 * that dies because it could not classify an epoch it was only going to mention
 * once has traded a cosmetic problem for a real one.
 */
export async function initializedAt(connection, configAddress) {
  try {
    let before;
    let oldest = null;
    for (;;) {
      const page = await connection.getSignaturesForAddress(configAddress, { limit: 1000, before });
      if (page.length === 0) break;
      oldest = page[page.length - 1];
      before = oldest.signature;
      if (page.length < 1000) break;
    }
    return oldest?.blockTime ?? null;
  } catch {
    return null;
  }
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
 * Is the site's published estimate older than the site will admit?
 *
 * **This is the only failure here whose symptom is a page that looks fine.**
 * Every other check covers something that stops visibly — an unposted root, an
 * unpaid epoch, an empty vault. A stopped sampler leaves `provisional.json`
 * exactly where it was, and the tile keeps rendering a confident-looking
 * figure from it. The page does carry its own staleness warning, but that only
 * helps a visitor who is already looking; nobody operating the system finds
 * out unless something says so.
 *
 * Pure, and separate from the file read, so the boundary is tested rather than
 * eyeballed — an off-by-one here means either constant noise or silence.
 *
 * @returns {{reason: string, ageSeconds: number|null}|null} null when healthy.
 */
export function staleSample({ now, sample, staleAfterSeconds }) {
  if (sample == null) return { reason: 'missing', ageSeconds: null };

  const sampledAt = Number(sample.sampledAt);
  // A file that exists but cannot be read for a time is worse than none: the
  // site would fall back cleanly on a missing file, and this one it will try
  // to use.
  if (!Number.isFinite(sampledAt) || sampledAt <= 0) {
    return { reason: 'unreadable', ageSeconds: null };
  }

  const ageSeconds = now - sampledAt;
  if (ageSeconds < staleAfterSeconds) return null;
  return { reason: 'stale', ageSeconds };
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

  const t = topology();
  let state = readState(statePath);
  const hasRoot = async (epoch) => (await fetchEpoch(connection, mint, epoch)) != null;

  const overdue = await overdueEpochs({
    now,
    config,
    lookback: args.lookback,
    graceSeconds: args.grace,
    hasRoot,
  });

  // Asked until it answers, then remembered forever: the answer is a fact about
  // a deployment that already happened and cannot change. Only a real timestamp
  // is cached — a failed history walk retries on the next tick rather than
  // disabling this permanently over one bad RPC minute.
  if (overdue.length > 0 && state.initializedAt == null) {
    const at = await initializedAt(connection, configPda());
    if (at != null) state = { ...state, initializedAt: at };
  }
  const impossible = impossibleEpochs({ config, initializedAt: state.initializedAt ?? null });

  const buckets = classifyOverdue(overdue, {
    staleAfterSeconds: args.staleAfter ?? args.grace + Number(config.epochSeconds),
    impossible,
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

  // Text and its remediation commands travel together — an alert that arrives
  // without the command to fix it is half an alert.
  const problems = [];
  const addProblem = (text, options = {}) => problems.push({ text, options });
  const keys = [];

  if (buckets.late.length > 0) {
    const key = `overdue-${buckets.late[0].epoch}`;
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const oldest = buckets.late[0];
      const list = buckets.late
        .slice(0, 8)
        .map((o) => `  epoch ${o.epoch}  closed ${iso(o.closedAt)}  (${minutes(o.lateBy)} ago)`)
        .join('\n');

      addProblem(
        `🔴 CALLPOOL — ${buckets.late.length} epoch(s) closed with NO ROOT ON CHAIN\n\n` +
          `${list}${buckets.late.length > 8 ? `\n  … and ${buckets.late.length - 8} more` : ''}\n\n` +
          `oldest late by   ${minutes(oldest.lateBy)}\n` +
          `program          ${PROGRAM_ID.toBase58()}\n` +
          `epoch clock      ${config.epochSeconds}s, challenge ${config.challengeSeconds}s\n` +
          `vault            ${vaultSol.toFixed(4)} SOL\n\n` +
          'MEANING: fees are accruing and nobody is being paid. Nothing is lost yet — a root ' +
          'can still be posted for any of these, and the money stays in the pool until it is.\n\n' +
          `LIKELY CAUSE, in order:\n` +
          `  1. ${t.cosign.label} cannot reach ${t.crank.label}'s published inputs, so the ` +
          `co-signer never approves and the 2-of-3 never reaches threshold\n` +
          `  2. the crank stopped on ${t.crank.label}\n` +
          `  3. the co-signer's timer stopped on ${t.cosign.label}\n` +
          `  4. the vault ran out of SOL for epoch rent (it holds ${vaultSol.toFixed(4)})\n` +
          `  5. the RPC provider is failing\n\n` +
          'NOTE: an epoch stuck at 1-of-2 looks exactly like a dead crank from here — the ' +
          'crank builds, proposes and self-approves before it ever needs the second host. ' +
          'Check reachability before restarting anything.\n\n' +
          'AND IF THIS IS A BACKLOG: once the first epoch settles it drains the pool, and ' +
          'every epoch built behind the blockage then allocates more than exists. The ' +
          'co-signer refuses those forever and no restart helps — they have to be REBUILT ' +
          'against current pool state. Command 7.\n\n' +
          'RUN THESE, in order — look before restarting:',
        {
          commands: [
            // Reachability first. This is the check that was missing on
            // 2026-08-07: every epoch was built, proposed and approved 1-of-2
            // correctly, and the only fault was a firewall between the hosts.
            // Restarting healthy services would have proved nothing.
            { what: `1 — can ${t.cosign.label} reach ${t.crank.label}'s published inputs?`,
              command: reachability(t) },
            { what: `2 — is the crank alive on ${t.crank.label}?`, command: unitStatus(t.crank) },
            { what: '3 — what did it last say?', command: readLog(t.crank) },
            { what: `4 — is the co-signer alive on ${t.cosign.label}?`, command: readLog(t.cosign, 40) },
            { what: '5 — restart both, crank last so a proposal exists to approve', command:
                `${restartUnit(t.cosign)} ; ${restartUnit(t.crank)}` },
            { what: `6 — if that did not take, settle epoch ${oldest.epoch} by hand`, command:
                settleEpoch(t, oldest.epoch) },
            // Last, because it is the only destructive one — and the only one
            // that works when the epochs are stale rather than the services
            // dead. A backlog behind a cleared blockage lands here every time.
            { what: `7 — if it refuses as "allocates more than is available", REBUILD epoch ${oldest.epoch}`,
              command: rebuildEpoch(t, oldest.epoch) },
          ],
        },
      );
      state = recordAlert(state, key, now);
    }
  }

  // Stale is a different alert because it has a different cure. The 🔴 above
  // says "look, then restart"; here restarting is the one thing that provably
  // does nothing, and saying it anyway is how an operator spends an hour
  // bouncing healthy services. Still repeats — it needs a person, and it will
  // not clear on its own.
  if (buckets.stale.length > 0) {
    const key = `stale-${buckets.stale[0].epoch}`;
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const oldest = buckets.stale[0];
      const list = buckets.stale
        .slice(0, 8)
        .map((o) => `  epoch ${o.epoch}  closed ${iso(o.closedAt)}  (${minutes(o.lateBy)} ago)`)
        .join('\n');

      addProblem(
        `🟠 CALLPOOL — ${buckets.stale.length} epoch(s) are STALE and need rebuilding\n\n` +
          `${list}${buckets.stale.length > 8 ? `\n  … and ${buckets.stale.length - 8} more` : ''}\n\n` +
          `oldest late by   ${minutes(oldest.lateBy)}\n` +
          `program          ${PROGRAM_ID.toBase58()}\n\n` +
          'MEANING: these closed more than a full epoch ago and still have no root. Whatever ' +
          'stopped them has had a complete cycle to recover on its own and has not, so this ' +
          'is no longer a service that needs a kick.\n\n' +
          'The usual cause is a cleared backlog. Every unsettled epoch was built against the ' +
          'pool as it stood at build time, so N epochs waiting behind a blockage each claim ' +
          'nearly the same money; when the blockage clears the first settles, drains the pool, ' +
          'and the rest allocate more than exists. The co-signer refuses those correctly and ' +
          'forever, and nothing re-derives them by itself.\n\n' +
          '⚠️ REBUILD THEM IN ORDER, OLDEST FIRST. Dust carries forward per wallet, so a gap ' +
          'in the chain makes every later epoch unbuildable — and do NOT reach for ' +
          '--carry-reset to skip one, because that forfeits real balances owed to real ' +
          'wallets. One at a time, in sequence.\n\n' +
          'Removing the published directory is safe here and only here: these epochs have no ' +
          'root, so nothing was promised to anyone and there is no audit trail to damage.',
        {
          commands: [
            { what: `1 — rebuild the OLDEST stale epoch (${oldest.epoch}) and settle it`,
              command: rebuildEpoch(t, oldest.epoch) },
            { what: '2 — watch it land', command: readLog(t.crank, 40) },
            { what: '3 — then the next one, and only then', command:
                rebuildEpoch(t, oldest.epoch + 1) },
          ],
        },
      );
      state = recordAlert(state, key, now);
    }
  }

  // Said once in the lifetime of a deployment, and then never again. There is
  // nothing to fix — the inputs for this window were never captured and cannot
  // be — so a repeating alert would be a permanent false alarm, and a permanent
  // contribution to a count that can never reach zero.
  //
  // Deliberately NOT in `keys`: `forgetResolved` would drop the record on the
  // next quiet tick and the alert would fire again forever.
  const announced = state.impossibleAnnounced ?? [];
  const unannounced = buckets.impossible.filter((o) => !announced.includes(o.epoch));
  if (unannounced.length > 0) {
    addProblem(
      `⚪️ CALLPOOL — epoch ${unannounced.map((o) => o.epoch).join(', ')} can never be settled\n\n` +
        `genesis          ${iso(Number(config.genesisTs))}\n` +
        `initialized      ${state.initializedAt ? iso(state.initializedAt) : 'unknown'}\n` +
        `program          ${PROGRAM_ID.toBase58()}\n\n` +
        'MEANING: the deploy landed inside this epoch\'s window, so the callout feed was never ' +
        'polled for it. There are no inputs, there is nothing to rebuild from, and no command ' +
        'fixes it.\n\n' +
        'NOTHING TO DO. This is said once and then dropped from the overdue count, so that ' +
        '"0 overdue" stays a number that means something. To avoid it next time, start the ' +
        'deploy on an epoch boundary.',
    );
    state = { ...state, impossibleAnnounced: [...announced, ...unannounced.map((o) => o.epoch)] };
  }

  if (unpaid.length > 0) {
    const key = `unpaid-${unpaid[0].epoch}`;
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const list = unpaid
        .slice(0, 10)
        .map((u) => `  epoch ${u.epoch} — ${u.allocated} lamports, none claimed, ${Math.round(u.since / 60)} min past the window`)
        .join('\n');
      addProblem(
        `🔴 CALLPOOL — ${unpaid.length} settled epoch(s) with NOTHING paid out\n\n${list}\n\n` +
          `program          ${PROGRAM_ID.toBase58()}\n\n` +
          'MEANING: the root is posted and correct, but the airdrop never landed — so the ' +
          'money is allocated and sitting in the pool with nobody holding it.\n\n' +
          'SAFE TO RE-RUN: claims are write-once on chain. The program refuses a second claim ' +
          'on the same leaf, so re-running the airdrop can never pay anyone twice — it pays ' +
          'only what is still outstanding.\n\n' +
          'A holder who sold below the floor since the snapshot is refused by design (§4.5) ' +
          'and will still show as unpaid. That is the mechanic working, not a failure.',
        {
          commands: [
            { what: `1 — pay epoch ${unpaid[0].epoch} again`, command: payEpoch(t, unpaid[0].epoch) },
            { what: '2 — if it fails, read why', command: readLog(t.crank, 40) },
          ],
        },
      );
      state = recordAlert(state, key, now);
    }
  }

  // The site's estimate. Checked last because it is the only thing here that
  // costs nobody any money when it breaks — and reported anyway, because it is
  // the only thing here that breaks without looking broken.
  const samplePath = resolve(SNAPSHOTS_DIR, 'provisional.json');
  const sample = existsSync(samplePath)
    ? JSON.parse(readFileSync(samplePath, 'utf8'))
    : null;
  const sampleProblem = staleSample({ now, sample, staleAfterSeconds: args.sampleStale });

  if (sampleProblem) {
    const key = 'sample-stale';
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const age =
        sampleProblem.ageSeconds == null ? 'never written' : `${minutes(sampleProblem.ageSeconds)} old`;
      addProblem(
        `🟡 CALLPOOL — the site's hourly estimate has stopped updating\n\n` +
          `file    ${samplePath}\n` +
          `state   ${sampleProblem.reason} (${age})\n` +
          `expected  a fresh sample every hour\n\n` +
          'MEANING: `sample-standings.mjs` publishes the provisional standings the wallet ' +
          'panel estimates from. Nothing settles from that file and no money is at risk — ' +
          'the payout is computed from scratch at 00:00 UTC either way.\n\n' +
          'What it does cost is trust. The page keeps showing the last figure it fetched, ' +
          'and to a visitor a stale estimate looks exactly like a fresh one. The page does ' +
          'label a sample older than 90 minutes, so this is visible to anyone reading ' +
          'closely — but nobody running the system finds out unless this alert does it.\n\n' +
          'FIX: restart the timer. If it fails on start, the cause is almost always the ' +
          'same as any other chain read failing — check the RPC before anything else.',
        {
          commands: [
            { what: '1 — why the last run stopped', command: readLog({ ...t.crank, unit: 'callpool-sample-standings' }, 40) },
            { what: '2 — start it again', command: restartUnit({ ...t.crank, unit: 'callpool-sample-standings' }) },
          ],
        },
      );
      state = recordAlert(state, key, now);
    }
  }

  if (vaultSol < args.minVault) {
    const key = 'vault-low';
    keys.push(key);
    if (shouldAlert(state, key, now, args.repeat)) {
      const epochsLeft = Math.floor(vaultLamports / 1_461_600);
      addProblem(
        `🟠 CALLPOOL — the multisig vault is running low\n\n` +
          `balance          ${vaultSol.toFixed(4)} SOL\n` +
          `address          ${config.snapshotKey.toBase58()}\n` +
          `rent per epoch   0.0014616 SOL\n` +
          `epochs left      ~${epochsLeft} (about ${minutes(epochsLeft * Number(config.epochSeconds))})\n\n` +
          'MEANING: the vault is the payer for every Epoch account the crank creates. When it ' +
          'empties, the crank stops settling — exactly as dead as a lost key, and with the same ' +
          'symptom as every other cause, so fix it before it gets there.\n\n' +
          'FIX: send SOL to the address above from any wallet. Nothing else needs restarting.',
        {
          commands: [
            { what: '1 — confirm the balance yourself', command: checkVault(t, config.snapshotKey.toBase58()) },
            { what: '2 — after funding, check the crank picked up again', command: readLog(t.crank, 30) },
          ],
        },
      );
      state = recordAlert(state, key, now);
    }
  }

  // A problem that has cleared should be able to fire again if it comes back.
  state = forgetResolved(state, keys);

  for (const { text, options } of problems) await alert(text, options);

  // **`impossible` is deliberately absent from this.** That is the self-heal:
  // an epoch nobody can ever settle must not hold the heartbeat off forever,
  // or the one signal that says "everything is fine" can never be sent again
  // and the daily green message quietly stops arriving.
  const quiet =
    problems.length === 0 &&
    buckets.late.length === 0 &&
    buckets.stale.length === 0 &&
    unpaid.length === 0 &&
    vaultSol >= args.minVault;

  if (quiet && now - (state.lastHeartbeat ?? 0) >= args.heartbeat) {
    const current = epochAt(now, config);
    const unsettleable = buckets.impossible.map((o) => o.epoch);
    await alert(
      `🟢 CALLPOOL — still settling.\n\n` +
        `epoch            ${current} in progress\n` +
        `settled through  ${current - 1}, every root posted\n` +
        `vault            ${vaultSol.toFixed(4)} SOL (~${Math.floor(vaultLamports / 1_461_600)} epochs)\n` +
        `program          ${PROGRAM_ID.toBase58()}\n` +
        // Named rather than hidden. It is excluded from the counts, and an
        // exclusion nobody is told about is indistinguishable from a bug.
        (unsettleable.length > 0
          ? `excluded         epoch ${unsettleable.join(', ')} — predates the program, no inputs exist\n`
          : '') +
        '\nNothing needs doing. This arrives once a day so that silence means something.',
      { commands: [{ what: 'the run, if you want to look', command: readLog(t.crank, 40) }] },
    );
    state = { ...state, lastHeartbeat: now };
  }

  writeState(statePath, state);

  // Three numbers, not one total. Whoever reads this line — in journald, in a
  // dashboard, at a glance — needs to know which of them wants a person, and
  // "8 overdue" answers that question wrongly whichever way it is read.
  console.log(
    `watchdog: epoch ${epochAt(now, config)}, ${buckets.late.length} late, ` +
      `${buckets.stale.length} stale, ${buckets.impossible.length} unsettleable, ` +
      `${unpaid.length} unpaid, vault ${vaultSol.toFixed(4)} SOL, ` +
      `${problems.length} alert(s) sent`,
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
