// scripts/lib/visitors.mjs — counting the people who came, from the log we
// already keep, without keeping anything about them.
//
// The Caddyfile ends with `log { output stderr }`, so every request to
// callpool.fun is already a JSON line in journald carrying the client IP, the
// User-Agent and the path. That is a complete visitor record. The only thing
// missing was something that turns it into a number and throws the
// identifiers away — which is what this does, and why the site still loads
// nothing from anyone else's server.
//
// ## Why there is no salt, and no stored hash
//
// The privacy-preserving analytics services hash `ip + user-agent` under a
// salt they rotate at midnight, because they persist one row per visitor and
// need those rows to be unlinkable afterwards. **We persist no rows.** A day
// is aggregated in a single pass, the identifiers live in a `Set` for the
// duration of that pass, and what reaches disk is `{"date":…,"visitors":41}`.
// A salt would be machinery guarding a file that does not exist.
//
// The cost of that choice is real and worth stating: distinct counts cannot be
// merged. Summing seven days over-counts anyone who came twice, and there is
// no way to recover a true weekly figure later, because the raw journal ages
// out. Daily uniques is the number this can honestly produce.
//
// ## Three numbers, because one of them lies
//
// Measured over the first 28 hours of live traffic, **60% of the requests for
// `/` never fetched a single asset afterwards** — scanners that read the
// markup and leave, plus one Pixel-6 User-Agent that hit the root 36 times.
// So:
//
// | field | what it is | trust |
// |---|---|---|
// | `pageviews` | requests for the page, everything included | traffic, not people |
// | `visitors` | distinct ip+UA on the page, obvious bot agents removed | an upper bound |
// | `rendered` | distinct ip+UA that also fetched `/site/app.css` | a browser actually drew the page |
//
// `rendered` is the honest headcount. A stylesheet is not fetched by curl, by
// a WordPress scanner, or by anything reading markup for links, and the page
// has exactly one — so the request is close to proof that a browser laid the
// page out. It undercounts by whatever browsers arrive with the file already
// in cache, which `Cache-Control: max-age=300` caps at five minutes; a second
// visit later the same day revalidates and logs a 304, which still counts.

/**
 * The only hosts whose traffic is ours.
 *
 * **Not optional, and not defensive.** The box answers on its bare IP, so it
 * collects a steady stream of requests carrying *other people's* domains in
 * the Host header — 76 of them across nine unrelated domains on the first day,
 * all scanners walking address ranges. Those land in the same Caddy log under
 * the same unit. Count them and the "visitor" number is measuring the
 * internet's background radiation.
 */
const OUR_HOSTS = new Set(['callpool.fun', 'www.callpool.fun']);

/** Paths that mean "someone asked for the page", after query and fragment. */
const PAGE_PATHS = new Set(['/', '/site/', '/site/index.html']);

/**
 * The one asset whose fetch means a browser is laying the page out.
 *
 * The stylesheet rather than a script: `app.js` is a module and the page has
 * a dozen of them, so any of them would do, but the CSS is requested by the
 * parser before the module graph resolves and is the single most reliable
 * line to appear.
 */
const RENDER_ASSET = '/site/app.css';

/**
 * User-Agent fragments that identify a non-browser outright.
 *
 * This list only removes the agents that *admit* what they are. It is not a
 * bot filter and must not be relied on as one — the scanners that matter send
 * a copied Chrome string. That is precisely why `rendered` exists and why
 * `visitors` is documented as an upper bound rather than a count.
 */
const SELF_DECLARED_NON_BROWSER = [
  'curl/', 'wget', 'python', 'aiohttp', 'httpx', 'axios', 'okhttp', 'go-http',
  'java/', 'libwww', 'perl', 'ruby', 'headlesschrome', 'phantomjs',
  'bot', 'spider', 'crawler', 'scanner', 'monitor', 'uptime', 'probe',
];

/** True for an agent that has told us it is not a person. */
export function isSelfDeclaredNonBrowser(userAgent) {
  if (!userAgent) return true; // no UA at all is never a browser
  const low = userAgent.toLowerCase();
  return SELF_DECLARED_NON_BROWSER.some((fragment) => low.includes(fragment));
}

/** The UTC date a Caddy `ts` (float epoch seconds) falls in. */
export function utcDay(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * One parsed access-log line, or `null` for anything that is not one.
 *
 * journald carries Caddy's own startup and certificate chatter on the same
 * unit, and those lines are JSON too — `msg` is what separates a request from
 * "serving initial configuration". Anything unparseable is dropped silently
 * rather than thrown on: a single truncated line in a rotated journal must not
 * cost the whole day's count.
 */
export function parseAccessLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (entry.msg !== 'handled request') return null;
  const request = entry.request ?? {};
  const host = String(request.host ?? '').split(':')[0].toLowerCase();
  if (!OUR_HOSTS.has(host)) return null;
  if (typeof entry.ts !== 'number') return null;

  return {
    ts: entry.ts,
    path: String(request.uri ?? '').split('?')[0].split('#')[0],
    status: entry.status ?? 0,
    // `client_ip` is what Caddy resolved after trusted-proxy handling;
    // `remote_ip` is the socket. Prefer the first, fall back to the second.
    ip: request.client_ip || request.remote_ip || '',
    userAgent: (request.headers?.['User-Agent'] ?? [''])[0] ?? '',
  };
}

/**
 * Aggregate access-log lines into one record per UTC day.
 *
 * The identifier sets are local to this call and are never returned. Callers
 * get counts, which is the whole point — see the header.
 *
 * @param {Iterable<string>} lines raw journal lines, in any order
 * @returns {Array<{date: string, pageviews: number, visitors: number,
 *   rendered: number, addresses: number, botPageviews: number}>} ascending by date
 */
export function rollUpDays(lines) {
  /** @type {Map<string, {views: number, botViews: number, seen: Set<string>, drew: Set<string>, ips: Set<string>}>} */
  const days = new Map();
  const dayOf = (date) => {
    let d = days.get(date);
    if (!d) {
      d = { views: 0, botViews: 0, seen: new Set(), drew: new Set(), ips: new Set() };
      days.set(date, d);
    }
    return d;
  };

  for (const line of lines) {
    const hit = parseAccessLine(line);
    if (!hit) continue;
    // 4xx and 5xx are the scanners' whole diet — 639 of the first day's 1880
    // requests were 404s for paths this site has never had. A request that was
    // refused did not show anybody anything.
    if (hit.status >= 400) continue;

    const day = dayOf(utcDay(hit.ts));
    const identity = `${hit.ip}\n${hit.userAgent}`;
    const nonBrowser = isSelfDeclaredNonBrowser(hit.userAgent);

    if (PAGE_PATHS.has(hit.path)) {
      day.views += 1;
      if (nonBrowser) day.botViews += 1;
      else day.seen.add(identity);
    } else if (hit.path === RENDER_ASSET && !nonBrowser) {
      day.drew.add(identity);
      day.ips.add(hit.ip);
    }
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, d]) => ({
      date,
      pageviews: d.views,
      visitors: d.seen.size,
      rendered: d.drew.size,
      addresses: d.ips.size,
      botPageviews: d.botViews,
    }));
}

/**
 * Merge freshly rolled-up days into the stored history.
 *
 * A day present in `fresh` replaces the stored one outright rather than being
 * added to it. That is what makes the job safe to run every hour and safe to
 * run twice: today's record is a partial count that gets better, and
 * yesterday's is re-derived from the same journal and lands on the same
 * number. Adding would double every figure on the second run.
 *
 * Days only in the stored history are kept untouched — they are the days whose
 * journal has since aged out, and this file is the only place they still exist.
 */
export function mergeHistory(stored, fresh) {
  const byDate = new Map(stored.map((row) => [row.date, row]));
  for (const row of fresh) byDate.set(row.date, row);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
