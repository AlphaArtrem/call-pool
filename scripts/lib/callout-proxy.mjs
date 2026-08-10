// The `/callouts` relay: the one pump.fun request a browser cannot make.
//
// The wallet panel was designed to ask pump.fun's callout API directly from
// the visitor's browser (§7.8), so the answer would not depend on us. Launch
// day (2026-08-10) proved that impossible: the API answers **403 to any
// request whose `Origin` is not pump.fun**, and a browser always sends the
// page's origin on a cross-site fetch. Measured directly — same URL, same
// key: `Origin: https://callpool.fun` → 403, `Origin: https://pump.fun` →
// 200, no Origin (a server) → 200. So the check goes through this relay on
// the site's own origin, which strips nothing and adds nothing beyond what
// the browser already sent — minus the Origin pump refuses.
//
// It stays a verification tool by being a *dumb* relay: exactly one upstream
// path shape is forwarded (the by-wallet callout listing), GET only, with the
// browser's own derived key passed through. The server holds no callout
// credential and cannot enrich or filter the body it returns — and the check
// remains advisory either way: settlement pays from the published snapshots,
// which are re-derivable without trusting this host.

export const CALLOUT_PROXY_PREFIX = '/callouts';
export const CALLOUT_UPSTREAM_ORIGIN = 'https://api.coin-communities.xyz';
export const CALLOUT_UPSTREAM_TIMEOUT_MS = 15_000;

const WALLET_PATH = /^\/api\/v1\/users\/by-wallet\/[1-9A-HJ-NP-Za-km-z]{32,44}\/callouts$/;
const KEY_SHAPE = /^cc_[0-9a-f]{64}$/;
const LIMIT_SHAPE = /^[0-9]{1,3}$/;

/**
 * The upstream URL for a relay request, or null when the route is not ours to
 * forward. Null for a matching prefix with a bad tail as well — the caller
 * 404s those rather than letting this become a general pump.fun forwarder.
 */
export function calloutUpstreamUrl(rawUrl) {
  const [route, query = ''] = String(rawUrl ?? '').split('?');
  if (!route.startsWith(`${CALLOUT_PROXY_PREFIX}/`)) return null;
  const path = route.slice(CALLOUT_PROXY_PREFIX.length);
  if (!WALLET_PATH.test(path)) return null;

  // The only query parameter the panel sends. Rebuilt rather than forwarded,
  // so nothing else can ride along.
  const limit = new URLSearchParams(query).get('limit');
  const suffix = limit != null && LIMIT_SHAPE.test(limit) ? `?limit=${limit}` : '';
  return `${CALLOUT_UPSTREAM_ORIGIN}${path}${suffix}`;
}

/** Forward one request. The caller has already matched the prefix. */
export async function handleCalloutProxy(req, res, { fetchImpl = fetch, log = () => {} } = {}) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('GET only\n');
    return;
  }
  const upstream = calloutUpstreamUrl(req.url);
  if (!upstream) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not a relayed callout path\n');
    return;
  }

  const apiKey = req.headers['x-api-key'];
  const headers = { accept: 'application/json' };
  if (typeof apiKey === 'string' && KEY_SHAPE.test(apiKey)) headers['x-api-key'] = apiKey;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALLOUT_UPSTREAM_TIMEOUT_MS);
    const answer = await fetchImpl(upstream, { headers, signal: controller.signal });
    clearTimeout(timer);
    const body = await answer.text();
    res
      .writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(body);
  } catch (err) {
    // The relay's failure is presented as an upstream failure, which it is;
    // the page's copy already treats "no answer" honestly.
    log(`callout relay: upstream failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'text/plain' }).end('pump.fun did not answer\n');
  }
}
