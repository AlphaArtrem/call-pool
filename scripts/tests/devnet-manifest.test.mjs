// The devnet manifest survives being moved to another machine.
//
// Written after the dry run was moved from a laptop to the signer box on
// 2026-08-05 and every tool failed with `ENOENT /Users/…`: the manifest had
// recorded absolute paths for six keypairs that lived inside the repository, so
// a directory copy carried the keys but not the ability to find them.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';

import { readManifest, writeManifest } from '../tools/devnet.mjs';
import { readJson, REPO_ROOT } from '../lib/store.mjs';

function withTempManifest(run) {
  const dir = mkdtempSync(join(tmpdir(), 'callpool-manifest-'));
  try {
    return run(join(dir, 'deployment.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const manifestWith = (paths) => ({
  cluster: 'https://example.invalid',
  programId: 'Prog1111111111111111111111111111111111111111',
  payer: { address: 'Pay', keypair: paths.payer },
  snapshotKey: { address: 'Snap', keypair: paths.snapshot },
  creatorVault: { address: 'Vault', keypair: paths.vault },
  cast: [{ name: 'steady', address: 'Steady', keypair: paths.steady }],
});

test('keys inside the repository are stored relative, so the manifest travels', () => {
  withTempManifest((path) => {
    writeManifest(
      manifestWith({
        payer: '/etc/callpool/devnet-payer.json',
        snapshot: resolve(REPO_ROOT, 'epochs/devnet/keys/snapshot-key.json'),
        vault: resolve(REPO_ROOT, 'epochs/devnet/keys/creator-vault.json'),
        steady: resolve(REPO_ROOT, 'epochs/devnet/keys/steady.json'),
      }),
      path,
    );

    const raw = readJson(path, null);

    assert.equal(raw.snapshotKey.keypair, 'epochs/devnet/keys/snapshot-key.json');
    assert.equal(raw.creatorVault.keypair, 'epochs/devnet/keys/creator-vault.json');
    assert.equal(raw.cast[0].keypair, 'epochs/devnet/keys/steady.json');
    assert.ok(
      !JSON.stringify(raw).includes(REPO_ROOT),
      'no repo-internal key may record the machine it was created on',
    );
  });
});

test('a key outside the repository stays absolute — there is nothing portable to say', () => {
  withTempManifest((path) => {
    writeManifest(
      manifestWith({
        payer: '/etc/callpool/devnet-payer.json',
        snapshot: resolve(REPO_ROOT, 'epochs/devnet/keys/snapshot-key.json'),
        vault: resolve(REPO_ROOT, 'epochs/devnet/keys/creator-vault.json'),
        steady: resolve(REPO_ROOT, 'epochs/devnet/keys/steady.json'),
      }),
      path,
    );

    assert.equal(readJson(path, null).payer.keypair, '/etc/callpool/devnet-payer.json');
  });
});

test('reading resolves the relative paths back against this repository', () => {
  withTempManifest((path) => {
    writeManifest(
      manifestWith({
        payer: '/etc/callpool/devnet-payer.json',
        snapshot: resolve(REPO_ROOT, 'epochs/devnet/keys/snapshot-key.json'),
        vault: resolve(REPO_ROOT, 'epochs/devnet/keys/creator-vault.json'),
        steady: resolve(REPO_ROOT, 'epochs/devnet/keys/steady.json'),
      }),
      path,
    );

    const manifest = readManifest(path);

    for (const entry of [manifest.snapshotKey, manifest.creatorVault, manifest.cast[0]]) {
      assert.ok(isAbsolute(entry.keypair), 'consumers still get an absolute path');
      assert.ok(entry.keypair.startsWith(REPO_ROOT), 'resolved against this checkout');
    }
    assert.equal(manifest.snapshotKey.keypair, resolve(REPO_ROOT, 'epochs/devnet/keys/snapshot-key.json'));
  });
});

// The regression itself: a manifest written on one machine, read on another.
test('a manifest written elsewhere still resolves here — the ENOENT that started this', () => {
  withTempManifest((path) => {
    writeManifest(
      manifestWith({
        payer: '/etc/callpool/devnet-payer.json',
        snapshot: '/Users/someone/Desktop/callpool/epochs/devnet/keys/snapshot-key.json',
        vault: resolve(REPO_ROOT, 'epochs/devnet/keys/creator-vault.json'),
        steady: resolve(REPO_ROOT, 'epochs/devnet/keys/steady.json'),
      }),
      path,
    );

    // A path from a foreign checkout is outside this REPO_ROOT, so it is kept
    // verbatim rather than silently rewritten into a file that does not exist —
    // wrong-and-loud beats wrong-and-quiet. What matters is that the keys this
    // repository does own resolve here.
    const manifest = readManifest(path);
    assert.equal(manifest.creatorVault.keypair, resolve(REPO_ROOT, 'epochs/devnet/keys/creator-vault.json'));
    assert.equal(manifest.cast[0].keypair, resolve(REPO_ROOT, 'epochs/devnet/keys/steady.json'));
  });
});
