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

## Updating the site

Push to `main`, then on the box:

```bash
# what is about to arrive — read it before pulling. The box has been two
# commits behind before, and "git pull said Already up to date" is not the
# same sentence as "the box is running what I just pushed".
sudo -u callpool git -C /srv/callpool log --oneline HEAD..origin/main

sudo -u callpool git -C /srv/callpool pull --ff-only
```

**A restart is only needed if the server itself changed** — `serve-site.mjs`,
`scripts/lib/rpc-proxy.mjs` or `scripts/lib/site-paths.mjs`. Static site files
are read per request. When it is needed:

```bash
sudo systemctl restart callpool-site
sudo systemctl status callpool-site --no-pager | head -5
```

Then verify from a machine that is not the box, **asserting content and not
status codes**. A 200 proves the edge answered; it does not prove it answered
with the version you pushed, and a stale cache or a wrong root returns 200 all
day:

```bash
# the commit that is actually serving: grep for something only the new
# version contains, rather than trusting the status line
curl -s https://callpool.fun/site/ | grep -c 'Paid out so far'      # ≥ 1
curl -s https://callpool.fun/scripts/lib/carry.mjs | grep -c splitCarry  # ≥ 1

# the allowlist still holds after the pull
for p in .env .git/config .callout-auth package.json docs/DECISIONS-LOCKED.md; do
  printf '%s → %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://callpool.fun/$p")"
done                                                                # all 404

# the proxy still proxies, and still says nothing to other origins
curl -s https://callpool.fun/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["11111111111111111111111111111111"]}'
curl -sI https://callpool.fun/rpc | grep -i access-control          # expect nothing
```

Section 5's full check is the one to run after anything larger than a content
edit.

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

## The hourly sampler, and why it is the odd one out

`callpool-sample-standings.{service,timer}` publishes `provisional.json` — the
provisional standings the site's hourly card and per-wallet estimate read. It
runs hourly, offset 180s so it lands after the callout poll rather than racing
it.

It breaks two conventions the other units share, both deliberately:

- **`Persistent=false`.** Every other timer here catches up after a reboot,
  because a missed run is a missed input that decides money. This one's output
  is an estimate of an hour that has already passed, and republishing it with a
  fresh timestamp would be worse than the gap.
- **It holds no key.** It only reads chain. `signer.env` is mounted for
  `SOLANA_RPC_URL` alone — and it must be the crank's own provider, not the
  visitor-facing proxy, which refuses the account reads it needs.

**Nothing settles from what it writes.** The payout is recomputed from scratch
at 00:00 UTC whether or not this has ever run. What it can do is mislead: the
site keeps showing the last sample it fetched, and a stale estimate looks
exactly like a fresh one. That is why `watchdog.mjs` checks the file's age
(`--sample-stale`, default 2h) — it is the only failure in the system whose
symptom is a page that looks completely healthy.

## The callout API key needs no configuration

There is deliberately nothing to set. `x-api-key` for `api.coin-communities.xyz`
is the public client key pump.fun ships to every visitor of `pump.fun/callouts`
— not a secret, but *theirs*, with no API that hands it out and no notice when
it changes. A rotation used to mean an hourly poll returning 401 until someone
noticed and pasted a new value onto two boxes.

`scripts/lib/callout-key.mjs` reads it out of pump.fun's own bundle, anchored on
the `https://api.coin-communities.xyz` base URL that appears in the same
`configureApi` call, and caches it in `epochs/callout-key.json`. It re-derives
**only when the API actually returns 401 or 403**, because that is the one
trustworthy signal that the key rotated — a timer would download 2.5 MB of
someone else's JavaScript every hour to learn what a single rejection says for
free. A recovered rotation still sends a Telegram alert: a change in a system we
depend on should not pass silently just because it was survivable.

Two things worth knowing before changing any of it:

- **The bundle is never executed.** It is fetched as text and matched with
  regexes — no `eval`, no `import()`, no `new Function`. Running pump.fun's
  bundle to extract the key would give their CDN arbitrary code execution inside
  the crank.
- **A derived key is validated against the live API before it is cached.** A key
  that parses but does not work turns a loud failure into a confusing one.

Set `CALLOUT_API_KEY` to pin a specific key and disable the derivation entirely
— useful when testing against a known one. A pinned key is never overwritten; if
the API rejects it, the poll says so and stops rather than arguing with an
explicit choice.

## Replacing INITIALIZER for a deployment build

`INITIALIZER` is a compile-time constant and the only address that may call
`initialize`, which writes every immutable parameter. The committed value is a
throwaway **whose secret is public** — anyone reading this repository has it —
so replacing it is mandatory before a deployment build.

The trap, found by rehearsing this on devnet rather than on launch day: changing
the constant **breaks `cargo test`**, because the litesvm fixtures call
`initialize` and hold the matching secret. Fixing that by committing the launch
secret would be far worse than the problem. So the fixture takes the key from
the environment instead, and the secret stays in the file the build machine
already needs in order to sign `initialize` at all.

```bash
# 1. Generate the launch key. Write the seed phrase down offline.
solana-keygen new -o ~/.config/solana/callpool-initializer.json
INIT=$(solana address -k ~/.config/solana/callpool-initializer.json)

# 2. Replace the constant in programs/callpool/src/lib.rs
#    pub const INITIALIZER: Pubkey = pubkey!("<INIT>");

# 3. Rebuild BOTH bytecode targets. `anchor build` is not one of them.
rm -f target/deploy/callpool.so
cargo build-sbf --manifest-path programs/callpool/Cargo.toml
cargo build-sbf --manifest-path programs/callpool/Cargo.toml --arch v3 \
  --sbf-out-dir target/sbf-v3

# 4. The deployment gate. Both variables are required:
#    EXPECTED_INITIALIZER pins the constant in the source,
#    CALLPOOL_TEST_INITIALIZER lets the litesvm fixtures sign as it.
EXPECTED_INITIALIZER=$INIT \
CALLPOOL_TEST_INITIALIZER=~/.config/solana/callpool-initializer.json \
  ./scripts/verify.sh
```

Step 4 must print `ok  INITIALIZER == <INIT>` rather than the placeholder
warning. It also **fails** if the constant and `EXPECTED_INITIALIZER` disagree,
which is the check that catches editing the wrong line.

Fund the key with about 0.05 SOL: it pays rent for the Config account
(~0.0016) and the transaction fee. After `initialize` it has no power at all —
there is no admin path — so it does not need protecting afterwards, only until
launch. Until then, whoever holds it can bind the coin with a wrong mint,
snapshot key or floor, permanently.

Phase 08 §8.5 reads the value back off chain before the coin is created.
