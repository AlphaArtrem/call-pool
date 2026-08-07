// The watchdog, and the redaction on the way out of it.
//
// This is the component that fires when *nothing* happened, so the things worth
// pinning are the ones that would quietly turn it off: a grace period that
// calls a dead crank "late", a dedupe that never repeats a standing problem, a
// dedupe that repeats it every minute until the channel is muted, and — the one
// with real consequences — an alert carrying the RPC key into a chat log.

import test from 'node:test';
import assert from 'node:assert/strict';

import { alert, clamp, composeHtml, redactSecrets } from '../lib/alert.mjs';
import { payEpoch, readLog, restartUnit, settleEpoch, topology, unitStatus } from '../lib/runbook.mjs';
import { epochAt, epochEnd, forgetResolved, minutes, overdueEpochs, recordAlert, shouldAlert, unpaidEpochs } from '../tools/watchdog.mjs';

const CONFIG = { genesisTs: 1_000, epochSeconds: 300 };

// ── redaction ──────────────────────────────────────────────────────────────

test('an API key in a URL path is redacted, and the host is kept', () => {
  // The live shape: Ankr puts the key in the path, so redacting query strings
  // alone would have sent it in full.
  const message = 'rpc https://rpc.ankr.com/solana_devnet/0031609f9fed053302d47e49c790d048fc';
  const out = redactSecrets(message);

  assert.ok(!out.includes('0031609f'), 'the key must not survive');
  assert.ok(out.includes('rpc.ankr.com'), 'which provider failed is most of the diagnosis');
  assert.equal(out, 'rpc https://rpc.ankr.com/…');
});

test('every URL in a multi-line crank error is redacted, not just the first', () => {
  const out = redactSecrets(
    '$ node scripts/crank.mjs --rpc https://rpc.ankr.com/solana_devnet/SECRET1\n' +
      'CRANK FAILED at https://api.mainnet-beta.solana.com/v1/SECRET2',
  );
  assert.ok(!out.includes('SECRET1'));
  assert.ok(!out.includes('SECRET2'));
});

test('bare key=value pairs are redacted too', () => {
  assert.match(redactSecrets('api_key=abc123'), /api_key=…/);
  assert.match(redactSecrets('token: sk-live-9999'), /token: …/);
});

test('a bare host with no path is left alone', () => {
  assert.equal(redactSecrets('reached https://api.telegram.org'), 'reached https://api.telegram.org');
});

test('roots and signatures survive — they are not secrets', () => {
  const root = '3a7e25078f423089d9e998f59ce675ea7a4e8070f71e941edb64ae75f7260f65';
  assert.ok(redactSecrets(`root ${root}`).includes(root));
});

test('an over-long message is trimmed and says how much it lost', () => {
  const out = clamp('x'.repeat(5000), 100);
  assert.equal(out.length, 100 + '\n… (4900 more characters)'.length);
  assert.match(out, /4900 more characters/);
});

// ── never breaking the caller ──────────────────────────────────────────────

test('an unconfigured alerter prints and reports undelivered, rather than throwing', async () => {
  const printed = [];
  const delivered = await alert('something', { env: {}, log: (t) => printed.push(t) });
  assert.equal(delivered, false);
  assert.match(printed[0], /not configured/);
  assert.match(printed[0], /something/);
});

test('a telegram outage does not throw into a settlement', async () => {
  const printed = [];
  const delivered = await alert('epoch 5 unposted', {
    env: { CALLPOOL_TELEGRAM_TOKEN: 't', CALLPOOL_TELEGRAM_CHAT: '1' },
    fetchFn: async () => {
      throw new Error('fetch failed');
    },
    log: (t) => printed.push(t),
  });
  assert.equal(delivered, false, 'reported, not raised — a payout must not depend on Telegram');
  assert.match(printed[0], /alert FAILED/);
});

test('a telegram error body is never echoed — it contains the bot token', async () => {
  const printed = [];
  await alert('x', {
    env: { CALLPOOL_TELEGRAM_TOKEN: 'SECRETTOKEN', CALLPOOL_TELEGRAM_CHAT: '1' },
    fetchFn: async () => ({ ok: false, status: 401, text: async () => 'bot SECRETTOKEN is invalid' }),
    log: (t) => printed.push(t),
  });
  assert.ok(!printed.join('').includes('SECRETTOKEN'));
  assert.match(printed[0], /401/);
});

test('the message body is redacted before it is sent, not after', async () => {
  let sent;
  await alert('rpc https://rpc.ankr.com/devnet/KEY123', {
    env: { CALLPOOL_TELEGRAM_TOKEN: 't', CALLPOOL_TELEGRAM_CHAT: '1' },
    fetchFn: async (_url, init) => {
      sent = JSON.parse(init.body).text;
      return { ok: true, status: 200 };
    },
  });
  assert.ok(!sent.includes('KEY123'));
});

// ── noticing that nothing happened ─────────────────────────────────────────

test('epoch arithmetic matches the program\'s', () => {
  assert.equal(epochAt(1_000, CONFIG), 0);
  assert.equal(epochAt(1_301, CONFIG), 1);
  assert.equal(epochEnd(0, CONFIG), 1_300, 'epoch 0 closes when epoch 1 starts');
  assert.equal(epochEnd(5, CONFIG), 2_800);
});

test('a root that is merely late is not an alert', async () => {
  // Epoch 0 closed 100s ago; the second signer's timer has not come round yet.
  const now = epochEnd(0, CONFIG) + 100;
  const overdue = await overdueEpochs({
    now, config: CONFIG, lookback: 50, graceSeconds: 900, hasRoot: async () => false,
  });
  assert.deepEqual(overdue, [], 'inside the grace period, silence is normal');
});

test('a root still missing past the grace period is an alert', async () => {
  const now = epochEnd(0, CONFIG) + 1_000;
  const overdue = await overdueEpochs({
    now, config: CONFIG, lookback: 50, graceSeconds: 900, hasRoot: async () => false,
  });
  assert.equal(overdue.length >= 1, true);
  assert.equal(overdue[0].epoch, 0);
  assert.equal(overdue[0].lateBy, 1_000);
});

test('the epoch in progress is never overdue — it has not closed', async () => {
  const now = 1_000 + 300 * 4 + 10; // early in epoch 4
  const overdue = await overdueEpochs({
    now, config: CONFIG, lookback: 50, graceSeconds: 0, hasRoot: async (e) => e < 4,
  });
  assert.deepEqual(overdue.map((o) => o.epoch), []);
});

test('settled epochs are silent, unsettled ones are named', async () => {
  const now = 1_000 + 300 * 10;
  const settled = new Set([0, 1, 3, 4, 5, 6, 7, 8, 9]);
  const overdue = await overdueEpochs({
    now, config: CONFIG, lookback: 50, graceSeconds: 0, hasRoot: async (e) => settled.has(e),
  });
  assert.deepEqual(overdue.map((o) => o.epoch), [2]);
});

// ── not becoming noise ─────────────────────────────────────────────────────

test('a standing problem repeats, but only after the repeat interval', () => {
  let state = {};
  assert.equal(shouldAlert(state, 'overdue-5', 1_000, 3_600), true, 'the first one always fires');

  state = recordAlert(state, 'overdue-5', 1_000);
  assert.equal(shouldAlert(state, 'overdue-5', 1_100, 3_600), false, 'not every tick — that is how a channel gets muted');
  assert.equal(shouldAlert(state, 'overdue-5', 4_600, 3_600), true, 'but a problem left unfixed keeps nagging');
});

test('a resolved problem is forgotten, so its return fires immediately', () => {
  let state = recordAlert({}, 'overdue-5', 1_000);
  state = recordAlert(state, 'vault-low', 1_000);

  state = forgetResolved(state, ['vault-low']);
  assert.equal(shouldAlert(state, 'overdue-5', 1_100, 3_600), true, 'epoch 5 settled; if it recurs, say so at once');
  assert.equal(shouldAlert(state, 'vault-low', 1_100, 3_600), false, 'the vault is still low, stay quiet');
});

// ── settled but never paid ─────────────────────────────────────────────────

const epochAccount = (postedTs, allocated, claimed) => ({
  postedTs,
  poolLamports: BigInt(allocated),
  claimedLamports: BigInt(claimed),
});

test('a partial shortfall is silence — holders who sold are refused by design', async () => {
  // 900 of 1000 claimed: one holder sold before claiming, which §4.5 refuses on
  // purpose. Alerting here would fire most days and train everyone to ignore it.
  const now = 1_000 + 300 * 10;
  const unpaid = await unpaidEpochs({
    now, config: { ...CONFIG, challengeSeconds: 60 }, lookback: 50, graceSeconds: 600,
    readEpoch: async () => epochAccount(1_000, 1_000, 900),
  });
  assert.deepEqual(unpaid, []);
});

test('allocated money with nothing claimed is an alert — the airdrop never ran', async () => {
  const now = 1_000 + 300 * 10;
  const unpaid = await unpaidEpochs({
    now, config: { ...CONFIG, challengeSeconds: 60 }, lookback: 50, graceSeconds: 600,
    readEpoch: async (e) => (e === 3 ? epochAccount(1_000, 5_000, 0) : epochAccount(1_000, 1_000, 1_000)),
  });
  assert.equal(unpaid.length, 1);
  assert.equal(unpaid[0].epoch, 3);
  assert.equal(unpaid[0].allocated, 5_000n);
});

test('an empty epoch allocates nothing and is not unpaid', async () => {
  // L3/D7: an epoch nobody called in still gets a zeroed root. Zero claimed
  // against zero allocated is correct, not a missed payout.
  const now = 1_000 + 300 * 10;
  const unpaid = await unpaidEpochs({
    now, config: { ...CONFIG, challengeSeconds: 60 }, lookback: 50, graceSeconds: 600,
    readEpoch: async () => epochAccount(1_000, 0, 0),
  });
  assert.deepEqual(unpaid, []);
});

test('an epoch still inside its challenge window is not yet unpaid', async () => {
  const now = 5_000;
  const unpaid = await unpaidEpochs({
    now, config: { ...CONFIG, challengeSeconds: 60 }, lookback: 50, graceSeconds: 600,
    readEpoch: async () => epochAccount(4_900, 1_000, 0),
  });
  assert.deepEqual(unpaid, [], 'claims have barely opened — nobody is late');
});

test('an epoch with no root at all is left to the overdue check', async () => {
  const now = 1_000 + 300 * 10;
  const unpaid = await unpaidEpochs({
    now, config: { ...CONFIG, challengeSeconds: 60 }, lookback: 50, graceSeconds: 600,
    readEpoch: async () => null,
  });
  assert.deepEqual(unpaid, [], 'one problem, one alert — not two for the same epoch');
});

// ── the alert has to be actionable, and paste-safe ─────────────────────────
//
// An alert that says "epoch 12 has no root" states a fact the reader can
// already see. What they need at 3 a.m. is a line to paste into a laptop
// terminal — which means a full ssh invocation, no assumed login, and nothing
// Telegram will refuse to render.

test('a shell command survives Telegram HTML — && would otherwise reject the message', () => {
  // An unescaped `&&` makes Telegram return 400 and the alert never arrives,
  // which is a worse failure than an ugly one.
  const body = composeHtml('crank is down', [
    { what: 'restart it', command: "ssh -i ~/.ssh/vultr root@1.2.3.4 'cd /srv && systemctl restart x'" },
  ]);
  assert.match(body, /&amp;&amp;/, 'ampersands are escaped');
  assert.ok(!/(?<!&amp;)&(?!amp;|lt;|gt;)/.test(body), 'no bare ampersand survives');
  assert.match(body, /<pre>.*<\/pre>/s, 'commands are tap-to-copy blocks');
});

test('angle brackets in a command are escaped, not swallowed', () => {
  const body = composeHtml('x', [{ what: '', command: 'node a.mjs > /tmp/out 2>&1' }]);
  assert.match(body, /&gt;/);
  assert.ok(!body.includes('> /tmp'), 'a raw > would be read as a tag');
});

test('a command carrying a secret is still redacted inside its block', () => {
  const body = composeHtml('x', [
    { what: '', command: 'node crank.mjs --rpc https://rpc.ankr.com/devnet/KEY999' },
  ]);
  assert.ok(!body.includes('KEY999'), 'redaction applies to commands, not only prose');
});

test('every remediation command is runnable from a laptop, not from the box', () => {
  const t = topology({
    CALLPOOL_CRANK_HOST: 'root@1.2.3.4',
    CALLPOOL_CRANK_SSH_KEY: '~/.ssh/vultr',
    CALLPOOL_PROGRAM_ID: 'PROG',
    CALLPOOL_MULTISIG: 'MS',
  });

  for (const command of [
    readLog(t.crank), unitStatus(t.crank), restartUnit(t.crank),
    settleEpoch(t, 12), payEpoch(t, 12),
  ]) {
    assert.match(command, /^ssh -i \S+ \S+ '/, `not laptop-runnable: ${command}`);
    assert.ok(!command.includes('https://'), 'no RPC URL inline — it is sourced on the box');
  }
});

test('the settle and pay commands name the epoch they were sent about', () => {
  const t = topology({ CALLPOOL_PROGRAM_ID: 'PROG', CALLPOOL_MULTISIG: 'MS' });
  assert.match(settleEpoch(t, 12), /--epoch 12\b/);
  assert.match(settleEpoch(t, 12), /--multisig MS\b/);
  assert.match(payEpoch(t, 12), /airdrop\.mjs --epoch 12\b/);
});

test('work on the box runs as the service user, not as root', () => {
  // Files written as root under epochs/ are files the service cannot rewrite,
  // and that surfaces hours later as a permission error nobody connects to a
  // manual fix.
  const t = topology({ CALLPOOL_PROGRAM_ID: 'PROG' });
  assert.match(payEpoch(t, 3), /sudo -u callpool/);
  assert.match(settleEpoch(t, 3), /sudo -u callpool/);
});

test('durations read like a person wrote them', () => {
  assert.equal(minutes(45), '45s');
  assert.equal(minutes(600), '10 min');
  assert.equal(minutes(7200), '2h 0m');
});
