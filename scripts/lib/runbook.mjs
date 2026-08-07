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

/** Where the crank runs, where the watchdog runs, and how to reach each. */
export function topology(env = process.env) {
  return {
    crank: {
      host: env.CALLPOOL_CRANK_HOST ?? 'root@155.138.236.181',
      key: env.CALLPOOL_CRANK_SSH_KEY ?? '~/.ssh/vultr',
      unit: env.CALLPOOL_CRANK_UNIT ?? 'callpool-rehearsal',
      label: env.CALLPOOL_CRANK_LABEL ?? 'box B',
    },
    cosign: {
      host: env.CALLPOOL_COSIGN_HOST ?? 'root@31.97.11.4',
      key: env.CALLPOOL_COSIGN_SSH_KEY ?? '~/.ssh/hostinger',
      unit: env.CALLPOOL_COSIGN_UNIT ?? 'callpool-cosign',
      label: env.CALLPOOL_COSIGN_LABEL ?? 'box A',
    },
    repo: env.CALLPOOL_REPO_PATH ?? '/srv/callpool',
    programId: env.CALLPOOL_PROGRAM_ID ?? '',
    snapshotsDir: env.CALLPOOL_SNAPSHOTS_DIR ?? 'epochs/devnet/snapshots',
    payer: env.CALLPOOL_PAYER_KEYPAIR ?? '/etc/callpool/devnet-payer.json',
    multisig: env.CALLPOOL_MULTISIG ?? '',
    signer: env.CALLPOOL_SIGNER_KEYPAIR ?? '/etc/callpool/signerA.json',
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

/** What the vault holds, and where to send more. */
export const checkVault = (t, address) =>
  ssh(t.crank, `${t.repo}/../.local/share/solana/install/active_release/bin/solana balance ${address} --url devnet`);
