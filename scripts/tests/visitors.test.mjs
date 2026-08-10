// Tests for scripts/lib/visitors.mjs — the visitor rollup.
//
// The fixtures are shaped like the lines actually in box A's journal, because
// every bug this file is guarding against was found by reading them: requests
// for other people's domains arriving on our port, 404 scanner floods, and a
// stream of `/` hits from agents that never fetch an asset.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSelfDeclaredNonBrowser,
  mergeHistory,
  parseAccessLine,
  rollUpDays,
  utcDay,
} from '../lib/visitors.mjs';

/** 2026-08-09T12:00:00Z and 2026-08-10T12:00:00Z. */
const DAY1 = 1786305600;
const DAY2 = 1786392000;

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function line({ ts = DAY1, uri = '/', status = 200, ip = '1.2.3.4', ua = CHROME, host = 'callpool.fun' }) {
  return JSON.stringify({
    level: 'info',
    ts,
    logger: 'http.log.access.log0',
    msg: 'handled request',
    request: { remote_ip: ip, client_ip: ip, host, uri, headers: { 'User-Agent': [ua] } },
    status,
  });
}

test('a request for someone else\'s domain is not our traffic', () => {
  // The box answers on its bare IP, so scanners walking address ranges land in
  // the same Caddy log under the same unit. Counting them would make the
  // visitor number a measure of the internet, not of the site.
  assert.equal(parseAccessLine(line({ host: 'someone-elses-domain.example' })), null);
  assert.equal(parseAccessLine(line({ host: '203.0.113.10' })), null);
  assert.notEqual(parseAccessLine(line({ host: 'www.callpool.fun' })), null);
  assert.notEqual(parseAccessLine(line({ host: 'callpool.fun:443' })), null);
});

test('non-request journal lines are ignored, not thrown on', () => {
  assert.equal(parseAccessLine('Aug 09 05:47 caddy[6004]: serving initial configuration'), null);
  assert.equal(parseAccessLine('{"level":"info","msg":"serving initial configuration"}'), null);
  assert.equal(parseAccessLine('{"msg":"handled request",'), null, 'a truncated line must not throw');
  assert.equal(parseAccessLine(''), null);
});

test('the query string is not part of the path', () => {
  assert.equal(parseAccessLine(line({ uri: '/?utm_source=x#frag' })).path, '/');
});

test('pageviews count requests, visitors count ip+ua pairs', () => {
  const [day] = rollUpDays([
    line({ ip: '1.1.1.1' }),
    line({ ip: '1.1.1.1' }),   // same person reloading
    line({ ip: '2.2.2.2' }),
    line({ uri: '/site/', ip: '3.3.3.3' }),
    line({ uri: '/site/index.html', ip: '3.3.3.3' }), // same person, other spelling
  ]);
  assert.equal(day.pageviews, 5);
  assert.equal(day.visitors, 3);
});

test('two people behind one IP are two visitors, one person on two devices is two', () => {
  // ip+ua is the whole identity, so this cuts both ways and neither direction
  // is a bug to be fixed — it is the accuracy the trade buys.
  const [day] = rollUpDays([
    line({ ip: '9.9.9.9', ua: CHROME }),
    line({ ip: '9.9.9.9', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/605.1.15' }),
  ]);
  assert.equal(day.visitors, 2);
});

test('rendered counts only those who fetched the stylesheet', () => {
  const [day] = rollUpDays([
    line({ ip: '1.1.1.1' }),
    line({ ip: '1.1.1.1', uri: '/site/app.css' }),
    line({ ip: '2.2.2.2' }),                          // read the markup and left
    line({ ip: '3.3.3.3' }),
    line({ ip: '3.3.3.3', uri: '/site/app.css', status: 304 }), // revalidated, still a person
  ]);
  assert.equal(day.visitors, 3);
  assert.equal(day.rendered, 2, 'the visitor who fetched nothing else did not render the page');
  assert.equal(day.addresses, 2);
});

test('refused requests show nobody anything', () => {
  // 639 of the first day's 1880 requests were 404s for paths this site has
  // never had — /wp-admin/install.php and friends.
  const [day] = rollUpDays([
    line({ uri: '/wp-admin/install.php', status: 404, ip: '5.5.5.5' }),
    line({ uri: '/', status: 200, ip: '6.6.6.6' }),
  ]);
  assert.equal(day.pageviews, 1);
  assert.equal(day.visitors, 1);
});

test('agents that admit they are not browsers are counted apart', () => {
  const [day] = rollUpDays([
    line({ ip: '1.1.1.1', ua: 'curl/8.18.0' }),
    line({ ip: '2.2.2.2', ua: 'Python/3.10 aiohttp/3.13.0' }),
    line({ ip: '3.3.3.3', ua: '' }),
    line({ ip: '4.4.4.4', ua: CHROME }),
  ]);
  assert.equal(day.pageviews, 4, 'they are still traffic');
  assert.equal(day.botPageviews, 3);
  assert.equal(day.visitors, 1, 'but they are not people');
});

test('a non-browser is never counted as having rendered the page', () => {
  const [day] = rollUpDays([
    line({ ip: '1.1.1.1', ua: 'curl/8.7.1' }),
    line({ ip: '1.1.1.1', ua: 'curl/8.7.1', uri: '/site/app.css' }),
  ]);
  assert.equal(day.rendered, 0);
  assert.equal(day.addresses, 0);
});

test('self-declared non-browsers are matched case-insensitively', () => {
  assert.equal(isSelfDeclaredNonBrowser('curl/8.7.1'), true);
  assert.equal(isSelfDeclaredNonBrowser('SomeBot/2.0 (+http://example.test)'), true);
  assert.equal(isSelfDeclaredNonBrowser('Mozilla/5.0 ... HeadlessChrome/146.0.0.0 ...'), true);
  assert.equal(isSelfDeclaredNonBrowser(''), true, 'no UA at all is never a browser');
  assert.equal(isSelfDeclaredNonBrowser(CHROME), false);
});

test('days are split on the UTC boundary, whatever the box thinks the time is', () => {
  assert.equal(utcDay(DAY1), '2026-08-09');
  const rows = rollUpDays([line({ ts: DAY1 }), line({ ts: DAY2 }), line({ ts: DAY2 })]);
  assert.deepEqual(rows.map((r) => r.date), ['2026-08-09', '2026-08-10']);
  assert.deepEqual(rows.map((r) => r.pageviews), [1, 2]);
});

test('re-running a day replaces its record and never adds to it', () => {
  // This is what makes the hourly timer safe: today is a partial count that
  // improves, and yesterday is re-derived from the same journal onto the same
  // number. Adding would double every figure on the second run.
  const stored = [
    { date: '2026-08-09', pageviews: 73, visitors: 28, rendered: 12, addresses: 10, botPageviews: 45 },
    { date: '2026-08-10', pageviews: 50, visitors: 20, rendered: 11, addresses: 10, botPageviews: 30 },
  ];
  const fresh = [
    { date: '2026-08-10', pageviews: 106, visitors: 41, rendered: 25, addresses: 22, botPageviews: 65 },
  ];
  assert.deepEqual(mergeHistory(stored, fresh), [stored[0], fresh[0]]);
});

test('a day the journal no longer covers is kept, not dropped', () => {
  // journald lost three and a half days of launch-week traffic once already.
  // After that, this file is the only place those days still exist, and a
  // rollup that cannot see them must leave them alone.
  const stored = [{ date: '2026-08-05', pageviews: 9, visitors: 4, rendered: 3, addresses: 3, botPageviews: 5 }];
  const merged = mergeHistory(stored, [
    { date: '2026-08-10', pageviews: 1, visitors: 1, rendered: 1, addresses: 1, botPageviews: 0 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], stored[0]);
});

test('the rollup returns counts and no identifiers', () => {
  // The privacy claim in one assertion: nothing that reaches a caller — and so
  // nothing that reaches disk — can name anyone.
  const [day] = rollUpDays([line({ ip: '203.0.113.7' }), line({ ip: '203.0.113.7', uri: '/site/app.css' })]);
  const serialised = JSON.stringify(day);
  assert.equal(serialised.includes('203.0.113.7'), false);
  assert.equal(serialised.includes('Chrome'), false);
  assert.deepEqual(
    Object.keys(day).sort(),
    ['addresses', 'botPageviews', 'date', 'pageviews', 'rendered', 'visitors'],
  );
});
