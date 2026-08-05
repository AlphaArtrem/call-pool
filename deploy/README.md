# Deploying box A — the site and the RPC proxy

Box A is the public host: it serves callpool.fun and holds the mainnet provider
key behind `/rpc`. Later it also runs the crank and automated signer A; that is
a separate unit under a separate user, and it is **not** part of this runbook.

Nothing here is secret. The one secret — the provider URL, which carries its key
in the path — lives in `/etc/callpool/site.env`, root-owned and `0600`, outside
any directory a web server is pointed at.

## What runs

```
internet ──TLS──▶ Caddy ──┬── site/  scripts/lib/  snapshots/   from disk
                          └── /rpc ──▶ node serve-site.mjs ──▶ provider
                                       (127.0.0.1:8099)
```

`scripts/lib/` is in that list because the page imports it directly — the
browser runs the same `timeline.mjs` the settlement job runs, which is why the
deploy root is the repository root and not `site/`. Drop it from the allowlist
and the page loads, then dies on its first import.

Caddy is in front for two reasons, and the second is the one that matters.
`serve-site.mjs` speaks no TLS, so something must. And `serve-site.mjs` resolves
**any** path under the repository root: its containment check stops traversal
*above* the root and permits everything below it. That is correct for a dev
server and wrong for the public internet, because the repository root is exactly
where the dangerous files sit — `.env`, `.callout-auth`, `.git/`,
`epochs/callout-store.json`, and any signing key left next to the scripts after
a crank command. Being gitignored keeps those out of the repository and does
nothing to keep them out of a browser.

So Caddy serves an allowlist of three trees — `site/`, `scripts/lib/` and
`snapshots/` — answers 404 to everything else, and only `/rpc` reaches Node.

## Prerequisites

- Ubuntu 22.04 or 24.04, root SSH.
- `callpool.fun` and `www.callpool.fun` A records pointed at the box's IPv4.
  **Do this first** — Caddy gets its certificate on first start and will retry
  noisily until DNS resolves.
- Node ≥ 20 (`package.json` engines).

## 1. User, directory, checkout

```bash
adduser --system --group --home /srv/callpool callpool
git clone https://github.com/AlphaArtrem/call-pool.git /srv/callpool
cd /srv/callpool && npm ci --omit=dev
chown -R callpool:callpool /srv/callpool
```

`config.local.js` is gitignored, so it is not in the clone. Copy the example and
edit it — nothing in it is secret any more, because the key moved to the server:

```bash
cp /srv/callpool/site/config.local.example.js /srv/callpool/site/config.local.js
```

Leave `programId` empty until `initialize` has landed. That is what makes the
page say "the coin has not launched yet", and it says it **without making an RPC
call at all** — which is the property that keeps it honest while there is
nothing deployed.

## 2. The provider key

```bash
mkdir -p /etc/callpool
printf 'CALLPOOL_RPC_URL_MAINNET=%s\n' 'https://<provider>/<key>' > /etc/callpool/site.env
chmod 0600 /etc/callpool/site.env
chown root:root /etc/callpool/site.env
```

Do **not** set `CALLPOOL_RPC_URL_DEVNET`. On a production host that route then
answers 503 with a plain reason, which is what you want: the rehearsal's traffic
must never run through the mainnet key.

`CALLPOOL_RPC_URL_MAINNET` is not `SOLANA_RPC_URL`. The second is what the crank
scripts read, it is a different key, and it belongs to the crank's unit — not
this file. They will both exist on this box eventually, which is exactly when
that distinction gets tripped over.

## 3. The service

```bash
install -m 0644 deploy/callpool-site.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now callpool-site
systemctl status callpool-site
```

Check it came up bound to loopback only:

```bash
ss -tlnp | grep 8099        # expect 127.0.0.1:8099, never 0.0.0.0
```

## 4. Caddy

```bash
apt install -y caddy
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Validate before reloading, every time. A syntax error in that file takes the
site down, and it is the kind of error that only shows up on reload.

## 5. Verify — from a machine that is not the box

A deployment nobody checked from outside is a deployment nobody has.

```bash
# the page, and the modules it imports — the second one is the easy thing to
# forget in an allowlist, and it fails at runtime rather than at deploy time
curl -sI https://callpool.fun/site/ | head -1                    # 200
curl -sI https://callpool.fun/scripts/lib/timeline.mjs | head -1  # 200
curl -s  https://callpool.fun/ -o /dev/null -w '%{http_code}\n'  # 302 → /site/

# the allowlist: every one of these must be 404, not 200
for p in .env .git/config .callout-auth epochs/callout-store.json package.json; do
  printf '%s → %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://callpool.fun/$p")"
done

# the proxy: an allowed method answers, a refused one does not
curl -s https://callpool.fun/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["11111111111111111111111111111111"]}'

curl -s https://callpool.fun/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":[]}'   # refused

# no CORS header, so no other site's browser can use the proxy
curl -sI https://callpool.fun/rpc | grep -i access-control   # expect nothing
```

Then open the page in a browser and confirm it renders the "has not launched"
state rather than "The page failed to load" — the second means `rpc` did not
resolve to an absolute URL before web3.js saw it, and it throws inside `main()`.

## 6. Restrict the provider key — by IP, not by domain

Once the box is up and you have its egress address:

```bash
curl -s https://api.ipify.org        # run ON the box: its outbound address
```

Put that in the provider's IP allowlist. **Do not set a domain restriction** —
`rpc-proxy.mjs` forwards none of the caller's headers, so nothing reaching the
provider carries a `Referer` for a domain rule to match, and turning one on
fails every request the site makes. See `site/README.md` for the full reasoning.

Verify from somewhere that is not the box: the raw provider URL should be
refused there and work from here.

```bash
# from your laptop, using the provider URL — expect a rejection
curl -s <provider-url> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

A restriction nobody tested is a restriction nobody has.

## Still to come on this box

The crank and automated signer A, as their own systemd unit and timer, under
their own user, with their own `SOLANA_RPC_URL`. The signing key goes in
`/etc/callpool/`, never under `/srv/callpool` — that directory is a web root.
Signer B lives on a different provider entirely; two automated signers on one
host is a 2-of-3 multisig wearing a costume.
