// scripts/lib/runbook.mjs — the commands that go in an alert.
//
// An alert that says "epoch 12 has no root" tells you a fact you can already
// see. What you actually need at 3 a.m. is the exact line to paste into a
// laptop terminal, so this builds them: look first, then fix, then settle one
// epoch by hand if the fix did not take.
//
// Two constraints shape every command here.
//
//   * **Runnable from the laptop, not from the box.** Each one is a full `ssh`
//     invocation naming the identity file and host, because the person reading
//     the alert is on their phone and will paste it into a terminal that has no
//     context. A command that assumes you are already logged in is a command
//     that needs a second command first.
//   * **No secret in the text.** The crank needs its RPC URL and that URL has
//     the provider key in its path, so nothing here inlines it: the commands
//     source `/etc/callpool/signer.env` on the box instead. The alerter redacts
//     as a backstop, but the right fix is not to put it there at all.
//
// Hosts and paths come from the environment so a mainnet deployment can point
// these at different machines without touching the code.
//
// ⚠️ The defaults below are the **launch layout** (MAINNET-HANDOFF §3): box A
// runs the crank and signer A, box B runs the co-signer. They were the reverse
// until 2026-08-07, matching an earlier rehearsal, and that is not a cosmetic
// difference — an alert is read on a phone during an outage, and remediation
// that names the wrong machine sends the reader to a healthy box to look for a
// dead service. It cost exactly that during the 2026-08-07 rehearsal: the alert
// said "the crank stopped on box B" while the crank was fine on box A and the
// real fault was a firewall.
//
// Set the environment variables explicitly in each unit rather than relying on
// these. A default that happens to be right is one deployment away from being
// silently wrong again.

/** Where the crank runs, where the watchdog runs, and how to reach each. */
export function topology(env = process.env) {
  return {
    crank: {
      host: env.CALLPOOL_CRANK_HOST ?? 'root@31.97.11.4',
      key: env.CALLPOOL_CRANK_SSH_KEY ?? '~/.ssh/hostinger',
      unit: env.CALLPOOL_CRANK_UNIT ?? 'callpool-rehearsal',
      label: env.CALLPOOL_CRANK_LABEL ?? 'box A',
    },
    cosign: {
      host: env.CALLPOOL_COSIGN_HOST ?? 'root@155.138.236.181',
      key: env.CALLPOOL_COSIGN_SSH_KEY ?? '~/.ssh/vultr',
      unit: env.CALLPOOL_COSIGN_UNIT ?? 'callpool-cosign',
      label: env.CALLPOOL_COSIGN_LABEL ?? 'box B',
    },
    repo: env.CALLPOOL_REPO_PATH ?? '/srv/callpool',
    programId: env.CALLPOOL_PROGRAM_ID ?? '',
    snapshotsDir: env.CALLPOOL_SNAPSHOTS_DIR ?? 'epochs/devnet/snapshots',
    payer: env.CALLPOOL_PAYER_KEYPAIR ?? '/etc/callpool/devnet-payer.json',
    multisig: env.CALLPOOL_MULTISIG ?? '',
    signer: env.CALLPOOL_SIGNER_KEYPAIR ?? '/etc/callpool/signerA.json',
    // Where the crank publishes epoch inputs for the co-signer to re-derive.
    publishPort: env.CALLPOOL_PUBLISH_PORT ?? '8100',
    // The Solana CLI, materialised outside `/root` so the service user can
    // execute it. The installer's own location cannot be used — see checkVault.
    solanaBin: env.CALLPOOL_SOLANA_BIN ?? '/opt/solana-cli/bin',
    // Which cluster the remediation commands should ask about. `mainnet-beta`
    // is the default because that is what a wrong answer costs most on.
    cluster: env.CALLPOOL_CLUSTER ?? 'mainnet-beta',
  };
}

/** `ssh -i <key> <host> '<remote>'` — quoted so it survives a paste. */
export function ssh({ host, key }, remote) {
  return `ssh -i ${key} ${host} '${remote.replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment a crank script needs, assembled on the box.
 *
 * `set -a` exports whatever `signer.env` defines — which is where the RPC URL
 * lives — so the key is never in the message. `sudo -u callpool` matters: files
 * written as root under `epochs/` are files the service cannot rewrite later,
 * and that failure surfaces hours afterwards as a permission error nobody
 * connects to a manual fix.
 */
export function onBox(t, command) {
  return (
    `cd ${t.repo} && set -a && . /etc/callpool/signer.env && set +a && ` +
    `sudo -u callpool env SOLANA_RPC_URL="$SOLANA_RPC_URL" ` +
    `CALLPOOL_PROGRAM_ID=${t.programId} CALLPOOL_SNAPSHOTS_DIR=${t.snapshotsDir} ` +
    command
  );
}

/** Read the last of a unit's log — always the first thing to do. */
export const readLog = (target, lines = 60) =>
  ssh(target, `journalctl -u ${target.unit} -n ${lines} --no-pager`);

/** Is it even running? */
export const unitStatus = (target) =>
  ssh(target, `systemctl status ${target.unit} --no-pager | head -20`);

/** Kick it. */
export const restartUnit = (target) =>
  ssh(target, `systemctl restart ${target.unit} && sleep 3 && systemctl is-active ${target.unit}`);

/**
 * Can the co-signer actually fetch the crank's published epoch inputs?
 *
 * The 2-of-3 is completed by a *different machine*, which means there is a
 * network path between two hosts that has to stay open — and unlike a dead
 * service, a blocked path leaves both units looking perfectly healthy. The
 * crank builds, proposes and self-approves without ever needing the second
 * host, so the symptom is "no root on chain" while every log reads normal.
 *
 * Run from the co-signer, because that is the direction that has to work; a
 * check from anywhere else can pass while the one path that matters is shut.
 */
export function reachability(t) {
  const url = `http://${t.crank.host.replace(/^.*@/, '')}:${t.publishPort}/`;
  return ssh(
    t.cosign,
    `curl -s -m 10 -o /dev/null -w 'inputs from ${t.crank.label}: HTTP %{http_code}\\n' ${url} ` +
      `|| echo 'UNREACHABLE — the co-signer cannot fetch the epoch inputs'`,
  );
}

/**
 * Rebuild a stale epoch, then settle it.
 *
 * The recovery for a backlog, and it is not the same action as restarting a
 * service. Every unsettled epoch is built against the pool as it stood at build
 * time, so N epochs waiting behind a blockage each allocate nearly the whole
 * pool. Clearing the blockage settles the first and drains it; the rest then
 * allocate more than exists and the co-signer refuses them — correctly, and
 * forever, because nothing re-derives them on its own.
 *
 * Removing the published directory is what forces the re-derivation. It is safe
 * precisely because the epoch has no root on chain: nothing has been promised to
 * anyone, so there is no audit trail to damage. Once a root IS posted the
 * directory is evidence and this command must not be used on it.
 */
export function rebuildEpoch(t, epoch) {
  return ssh(
    t.crank,
    onBox(
      t,
      `bash -c 'rm -rf ${t.snapshotsDir}/epoch-${epoch} && ` +
        `node scripts/crank.mjs --epoch ${epoch} ` +
        `${t.multisig ? `--multisig ${t.multisig} ` : ''}--keypair ${t.signer} ` +
        `--store ${t.snapshotsDir.replace(/\/snapshots$/, '')}/callout-store.json'`,
    ),
  );
}

/** Settle one specific epoch by hand, through the multisig. */
export function settleEpoch(t, epoch) {
  return ssh(
    t.crank,
    onBox(
      t,
      `node scripts/crank.mjs --epoch ${epoch} ` +
        `${t.multisig ? `--multisig ${t.multisig} ` : ''}--keypair ${t.signer} ` +
        `--store ${t.snapshotsDir.replace(/\/snapshots$/, '')}/callout-store.json`,
    ),
  );
}

/** Pay one specific epoch. Safe to re-run: claims are write-once on chain. */
export function payEpoch(t, epoch) {
  return ssh(
    t.crank,
    onBox(t, `node scripts/airdrop.mjs --epoch ${epoch} --keypair ${t.payer}`),
  );
}

/**
 * What the vault holds, and where to send more.
 *
 * Two things here were wrong until the alert was first made to fire, on
 * 2026-08-07, and both would have shown up only during the outage they exist
 * for — which is the whole failure mode F8 named:
 *
 *   * **The CLI path.** The installer puts binaries under `/root` at mode 700
 *     and symlinks `active_release` back into it, so the path this built could
 *     not be executed by anyone but root (F16). The working copy is a
 *     `cp -rL` materialisation outside root's home.
 *   * **`--url devnet`, hardcoded.** On mainnet that reports the devnet balance
 *     of a mainnet address — which is zero, always, and looks exactly like the
 *     emergency the alert was sent about. A command that answers confidently
 *     and wrongly is worse than no command.
 *
 * The cluster is derived rather than configured: the alert already knows the
 * RPC it read the balance from, and asking an operator to keep a second copy
 * of that in sync is how it drifts again.
 */
export const checkVault = (t, address, cluster = t.cluster) =>
  ssh(t.crank, `${t.solanaBin}/solana balance ${address} --url ${cluster}`);
