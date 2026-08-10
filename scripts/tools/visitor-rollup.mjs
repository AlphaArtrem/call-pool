#!/usr/bin/env node
//
// scripts/tools/visitor-rollup.mjs — how many people came, computed from our
// own access log, with no third party involved and nothing about anyone kept.
//
//   node scripts/tools/visitor-rollup.mjs              # roll up, then print
//   node scripts/tools/visitor-rollup.mjs --days 7     # re-derive a week
//   node scripts/tools/visitor-rollup.mjs --print      # read the file, run nothing
//   journalctl -u caddy -o cat | node scripts/tools/visitor-rollup.mjs --stdin
//
// The page loads no analytics script, sets no cookie and asks no consent,
// which is the same reason `connect-src 'self'` is in the Caddyfile: nothing a
// visitor's browser does here reaches anyone but us. That property is worth
// more than a dashboard, so the counting happens entirely on the server, from
// a log we were keeping anyway. See `scripts/lib/visitors.mjs` for what the
// three numbers mean and which of them to believe.
//
// ## This runs on box A and nowhere else
//
// The journal is on the machine that served the requests. There is no central
// log, and adding one to count visitors would be a much larger thing than the
// thing it measures.
//
// ## The failure that is silent, and the reason for the timer
//
// **journald is the clock, and it is shorter than you think.** Caddy has been
// up since 2026-08-05 10:52 UTC; the oldest access line in the journal on
// 2026-08-10 was from 08-09 05:52. Three and a half days of launch-week
// traffic are simply gone — not rotated for size (35 MB of a 1 GB cap) but
// lost when the journal was reinitialised. Nothing reported an error, because
// from journald's point of view nothing went wrong.
//
// So this job's real purpose is to get each day out of the journal and into a
// file before that happens again, and `epochs/visitors.jsonl` is authoritative
// for every day the journal no longer covers — which is why `mergeHistory`
// never drops a stored day it cannot re-derive.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { REPO_ROOT } from '../lib/store.mjs';
import { mergeHistory, rollUpDays } from '../lib/visitors.mjs';

/** Working state, not audit trail: gitignored, and outside Caddy's allowlist. */
const DEFAULT_OUT = 'epochs/visitors.jsonl';

/**
 * How many days back to re-derive by default.
 *
 * Two, not one. The job runs hourly, so it must cover today (a partial count
 * that improves through the day) *and* yesterday (which only becomes final
 * after the last hour of it has passed). One day would leave yesterday's
 * record frozen at whatever the 23:00 run saw.
 */
const DEFAULT_DAYS = 2;

function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, out: DEFAULT_OUT, unit: 'caddy', print: false, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--print') args.print = true;
    else if (flag === '--stdin') args.stdin = true;
    else if (flag.startsWith('--')) args[flag.slice(2)] = argv[++i];
    else throw new Error(`unexpected argument: ${flag}`);
  }
  args.days = Number(args.days);
  if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error(`--days must be a positive integer, got ${args.days}`);
  }
  return args;
}

/**
 * Read the journal for one unit, back `days` days.
 *
 * `TZ=UTC` is load-bearing: `journalctl --since` parses its argument in the
 * *local* timezone, and every date this tool reasons about is UTC. On a box
 * set to anything but UTC the window would silently slide by the offset and
 * clip the edges of the first and last day.
 *
 * `-o cat` prints the message text only. Any other output format wraps each
 * line in a syslog prefix, and `parseAccessLine` requires the line to start
 * with `{`, so it would drop every record and report zero visitors — a
 * failure that looks exactly like a quiet day.
 */
function readJournal(unit, days) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'journalctl',
      ['-u', unit, '--no-pager', '-o', 'cat', '--since', `${days} days ago`],
      { env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (cause) => reject(new Error(`could not run journalctl: ${cause.message}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`journalctl exited ${code}: ${err.trim()}`));
      else resolvePromise(out.split('\n'));
    });
  });
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let out = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { out += chunk; });
    process.stdin.on('end', () => resolvePromise(out.split('\n')));
    process.stdin.on('error', reject);
  });
}

export function readHistory(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeHistory(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

/**
 * The table, and the totals line that needs a caveat printed next to it.
 *
 * `visitors` and `rendered` are distinct counts *within a day*. They cannot be
 * summed into a true total — a person who came on two days is two rows — so
 * the total is labelled "visits", which is what a sum of daily uniques
 * actually is.
 */
function report(rows) {
  if (rows.length === 0) {
    console.log('no days recorded yet');
    return;
  }
  console.log('date         pageviews   visitors   rendered   distinct IPs   bot pageviews');
  for (const r of rows) {
    console.log(
      `${r.date}   ${String(r.pageviews).padStart(9)}  ${String(r.visitors).padStart(9)}  ` +
      `${String(r.rendered).padStart(9)}  ${String(r.addresses).padStart(13)}  ` +
      `${String(r.botPageviews).padStart(14)}`,
    );
  }
  const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
  console.log(
    `\n${rows.length} day(s), ${rows[0].date} → ${rows[rows.length - 1].date}: ` +
    `${sum('pageviews')} pageviews, ${sum('rendered')} browser visits.`,
  );
  console.log(
    'The last figure sums daily uniques, so anyone who returned on another day\n' +
    'is counted again. There is no stored identifier to deduplicate across days,\n' +
    'and that is the deliberate trade — see scripts/lib/visitors.mjs.',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(REPO_ROOT, args.out);

  if (args.print) {
    report(readHistory(file));
    return;
  }

  const lines = args.stdin ? await readStdin() : await readJournal(args.unit, args.days);
  const merged = mergeHistory(readHistory(file), rollUpDays(lines));
  writeHistory(file, merged);
  report(merged);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
