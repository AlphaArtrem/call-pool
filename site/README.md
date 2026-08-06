# site/

The public page. Static HTML, no build step, one pinned dependency.

Phase 07's job for it, verbatim: **let a holder confirm, in under 60 seconds
and without trusting us, that the epoch they were paid for was computed the way
this page says it was.**

## Running it locally

```bash
node scripts/serve-site.mjs
```

Then open <http://127.0.0.1:8099/site/>.

**Opening `index.html` by double-clicking it will not work.** ES modules cannot
load over `file://`, so the page renders nothing. That is the only reason a
server is involved.

Copy `config.local.example.js` to `config.local.js` first — it is gitignored,
and without it the page renders an explicit "not configured" state rather than
defaulting to anything.

## Why the deploy root is the repository root, not `site/`

The page imports `../../scripts/lib/*.mjs` directly:

| Imported | Why it is not copied |
|---|---|
| `config.mjs` | The floor. A second copy is how the number the site shows and the number the program enforces eventually disagree. |
| `timeline.mjs` | `hold`, `locked`, and `extractBalanceEvent` — the arithmetic that decides money. A visitor's browser runs the same code the settlement job runs. |
| `epoch.mjs` | Epoch boundaries and the lockout window. |
| `callouts.mjs` | `countable` and the window test, so "does this callout count?" is answered here exactly as it is at settlement. |

So the host is pointed at the repository root, with `/` rewritten to
`/site/index.html`. Every asset path in the page is root-absolute for that
reason, and `/snapshots/` — the audit trail linked from the epoch table — is
served from the same root.

The domain is **callpool.fun** (registered 2026-08-05), so on the live host:

| URL | Serves |
|---|---|
| `https://callpool.fun/` | `site/index.html` |
| `https://callpool.fun/site/app.css`, `/site/js/…`, `/scripts/lib/…` | the page and the modules it imports |
| `https://callpool.fun/snapshots/epoch-N/` | one settled day's working, linked from the epoch table |

Nothing in the config names the domain — `snapshotsBase` is the relative
`/snapshots`, so the same files work on localhost and in production. The RPC key
is not in the page at all; it sits behind the same-origin `/rpc` proxy. See
"Before launch, and on launch day".

**In production the host does not serve the repository root.** `serve-site.mjs`
does, which is right for a dev server and wrong on the public internet: the
repository root is where `.env`, `.callout-auth`, `.git/` and any stray signing
key live. The live edge serves an allowlist of `site/`, `scripts/lib/` and
`snapshots/`, and only `/rpc` reaches Node — see
[`deploy/`](../deploy/README.md).

This is also why `scripts/` being public is a feature: the verification tile
under "Every day, on the record" tells people to run those exact files.

## Layout

```
index.html                the whole page — seven sections
app.css                   pump.fun's palette, light/dark, one accent
config.local.example.js   copy to config.local.js (gitignored)

js/
  app.js         wiring, and the floor check against chain
  config.js      config resolution; anything unset stays null
  base58.js      no dependency, but tested against web3.js
  program.js     Config and Epoch decoders — no dependency
  addresses.js   PDAs and ATAs — the ONLY module needing web3.js
  chain.js       RPC reads
  timeline …     NOT here. Imported from scripts/lib/
  standing.js    every §7.8 state, pure and tested
  clocks.js      the two clocks, pure and tested
  graphs.js      the card-chart arithmetic, pure and tested
  paging.js      which slice of the history is on screen, pure and tested
  history.js     which epochs are read, and what they add up to — pure and tested
  position.js    the address calculator
  epochs.js      the audit-trail table
  ui.js          render primitives: the source badge, and the charts
  topbar.js      theme toggle, cluster indicator, social links

vendor/          pinned @solana/web3.js — see vendor/README.md
```

Served by `scripts/serve-site.mjs`, which is also where `/rpc` lives — the
same-origin proxy that holds the provider key so this directory never has to.
Its screening is `scripts/lib/rpc-proxy.mjs`.

`standing.js`, `clocks.js`, `graphs.js`, `program.js`, `base58.js` and
`config.js` are pure and dependency-free on purpose:
`scripts/tests/site.test.mjs` exercises them in Node, so the copy a holder
reads when they are locked out is asserted rather than hoped for.

## How the page is ordered

Seven sections, in the order a first-time reader needs them, and each one
answers its question in plain words before any machinery appears:

| | |
|---|---|
| **How it works** | three steps, the minimum, the lockout, what counts as selling |
| **Where the fees go** | 90/10 |
| **Check your wallet** | the calculator |
| **When you get paid** | the two clocks, and why they are not the same thing |
| **The pool right now** | the live figures and the three card charts |
| **Every day, on the record** | the audit trail |
| **What this is not** | the risks |

**The order is the owner's, revised 2026-08-05**, and it replaces an earlier
one from the same day that led with the calculator. Explanation first now: a
visitor arriving before launch cannot check a wallet or read a live figure at
all, so leading with either meant leading with "not launched yet" three times
over. What the page can always do is explain the deal and say where the money
comes from, and those are now the first two sections.

Both orderings are the owner's call rather than a default, so neither is a
thing to "restore" on instinct. The nav lists sections in page order and must
keep doing so.

The technical layer sits inside `<details class="tech">` tiles — the exact
rule and the attack table, the addresses, the four verification commands, the
founder's-fee argument, and each of the four risk statements. **Everything is
a fold, never a deletion.** One exception in each direction: the memecoin
warning at the top of "What this is not" is never collapsed, and "what counts
as selling" is not a tile at all — it is three cards in "How it works",
because it is the rule people lose money to.

The headline countdown ticks once a second, and `countdown()` shows seconds at
every scale for that reason. It is driven from the on-chain window, so it
survives the rollover — when the clock passes the boundary the epoch index
moves, the window moves with it and the daily record reloads, rather than a
page left open overnight counting down to a moment that has already gone.

## The look

pump.fun's palette, borrowed deliberately, with its habits left behind.

Every dark-theme colour in `app.css` is a literal pump.fun design token, read
out of the stylesheets they serve rather than remembered — the file lists each
one against the token it came from. pump.fun ships no light theme, so the light
values are taken from the same ramps. Where a token would have failed WCAG AA
on the background it sits on, the next value on that ramp is used instead and
the swap is noted inline.

Both themes are reachable two ways and they must not fight: the
`prefers-color-scheme` media query is the OS preference, and
`:root[data-theme="…"]` is the toggle, which wins in **both** directions. A
stylesheet that themes only through the media query has a toggle that appears
to do nothing for half its visitors.

Inter is named in the font stack because it is pump.fun's typeface. It is never
fetched. A webfont link is a third-party request on every page load, on a page
whose whole claim is that nothing it renders passed through anyone else's
server.

### The visual layer (added 2026-08-05, owner-requested)

A second visual pass added imagery on top of the palette. All of it is inline
SVG in the page's own CSS variables — nothing is fetched, nothing is raster,
and everything re-tints with the theme:

- **The hero illustration** is the favicon's mark blown up (same
  stroke-to-radius proportion, so the tab icon and the hero read as one shape),
  with coins on dashed orbits around it. It is `aria-hidden`, it plots no data,
  and it must stay that way: the moment it encodes a number, rules 1, 2 and 9
  apply to it and it stops being decoration.
- **The hero is three siblings — copy, art, actions — in that source order**,
  and the grid rearranges them at each width. Above 46rem it is two equal
  halves: **the mark spans both rows on the left**, the copy and the buttons
  stack down the right, with `align-self: end` / `align-self: start` keeping
  the two right-hand items together when the taller column stretches the rows.
  Below 46rem **the mark leads** — `order: -1` — and the words and the buttons
  follow it as one block, with a wider gap under the mark than between the two
  of them so the pair reads as belonging together. **Nothing overlaps anything
  at any width** (owner, 2026-08-05, after trying it both ways: the buttons
  over the mark's bottom, then the words over its top).
- **`order`, not markup order.** The mark is lifted to the top of the phone
  layout with `order: -1` rather than by moving it in the HTML, because the
  markup order is the one a screen reader follows and the words should still
  come first there. It costs nothing: the art is `aria-hidden` and is not in
  the accessibility tree at all.
- **One breakpoint for the whole hero, and it is 46rem because that is where
  `.hero-actions` stops spanning the column.** Split them and there is a band
  where the mark is centred and the buttons are not.
- **The art's phone-only `order` and spacing are cancelled for the two-column
  layout in a media query that sits AFTER the base rule**, not in the earlier
  hero block. Same specificity, so only source order wins; cancelling it
  earlier silently does nothing.
- **`.hero-art`'s overlap margin is cancelled for the two-column layout in a
  media query that sits AFTER the base rule**, not in the earlier hero block.
  Same specificity, so only source order wins; cancelling it earlier silently
  does nothing and the mark hangs 24px low on a laptop.
- **Section and card icons** are line icons in chips, `aria-hidden`, with the
  heading beside each one carrying the meaning. The "what counts as selling"
  cards use the warning tint; everything else uses the accent.
- **Every section head is a 2×2 grid** (owner, 2026-08-05):

  |  |  |
  |---|---|
  | *icon* | **Where the fees go** |
  | THE SPLIT | Every trade on pump.fun pays a creator fee… |

  The label sharing a row with the sentence is what closed the dead space the
  old layout left — the heading stack was taller than the sentence beside it,
  so every section ended with a column of nothing. `.section-title` wraps the
  icon and the heading so they hold one line on a phone, and is dissolved with
  **`display: contents`** above 46rem so its two children become items of the
  section-head grid; that is what puts the icon in the label column and the
  heading on the same left edge as the sentence. The wrapper carries no role,
  label or semantics, so dissolving it removes nothing from the accessibility
  tree. The label column is a **fixed 10rem, not `max-content`** — with
  `max-content` each section's rail is its own longest label and the page loses
  its left edge; the longest label today ("your wallet") measures ~8.7rem.
- **The section label renders at 1.0625rem, not the 11px `.eyebrow` size**,
  because `.section-head p` beats `.eyebrow` on specificity. That is now
  deliberate and commented: a section label is a heading-scale thing. The
  hero's eyebrow, which is not inside a section head, keeps the 11px.
- **The glows** behind the hero are the accent and info colours at low opacity.
  The overhang is eaten by `overflow-x: clip` on `body` — clip, not hidden,
  because clip cannot create a scroll container.
- **The hero mark moves**, and the `prefers-reduced-motion` block disables all
  of it along with every transition. Three things, all sped up on the owner's
  ask (2026-08-05): the coins bob (2.2s), the sparks twinkle on opacity (1.5s),
  and the orbits **march their dash pattern** (1.6s and 1.1s, one reversed).
  The orbits travel rather than rotate for a reason — the outer ellipse has
  210 units of radius about a centre 210 units down a 400-unit viewBox, so a
  quarter turn puts it outside the viewport and an SVG clips to its viewport by
  default. The dash offset is a whole number of the 12-unit dash period so the
  loop has no seam.
- **Nothing in the artwork may animate `transform` while it is positioned by a
  `transform` attribute.** A CSS transform *replaces* the attribute rather than
  composing with it. The three sparks are placed with `transform="translate(…)"`
  and were briefly given the coins' `translateY` float — which collapsed all
  three onto the origin, where they rendered as one stray green mark in the
  corner of the mark. They animate opacity only now. If a spark ever needs to
  move, wrap it in a `<g>` that carries the placement and animate the inner
  path.
- **`--on-pumpfun` is the one colour not read out of pump.fun's stylesheets.**
  It is text *on* their decorative orange, which they never do; the values are
  the darkest and lightest stops (orange-950 / orange-50) of the same Tailwind
  ramp their orange comes from, noted inline in `app.css`.

### The contract strip and the trade button (added 2026-08-05)

The mint sits in a strip directly under the top bar with its copy button and an
explorer link, and the hero carries the **Trade on pump.fun** button. The page
already warns that address confusion is how people lose money during a launch;
the strip is that warning acted on — the address people copy comes from the
same resolved config, and later the same on-chain Config, as every other number
here.

- Both surfaces are rendered by **one function** (`renderTrade` in
  `js/app.js`), at the same two moments `mint-address` in the fold is
  rendered: from config on load, from the chain's own mint once it is read.
  They can never disagree with each other or with the fold.
- **Before launch the button is a disabled chip** and the address slot says
  `not launched yet` with no copy button, because there is nothing to copy —
  §7.4 applied to a link, exactly like the top-bar social links. The strip
  does not appear at launch from nowhere; the slot it fills is always visible.
- **The mint-mismatch state disables trading.** If `config.local.js` and the
  on-chain Config disagree, the page stops offering the trade link rather than
  inviting a buy of an address it just said it cannot vouch for.
- The strip is **not sticky**: with the bar and the nav it would be three
  stacked sticky rows on a phone.
- The button wears pump.fun's decorative orange — the colour that already
  means "pump.fun" in the source badges — with `--on-pumpfun` for the label.

**The strip held a second trade button for a few hours and the owner removed
it** (2026-08-05). Two controls on one narrow row is what pushed the button
onto a second line on a phone, and the strip has one job: carry the address and
let it be copied. So `.ca-row` is `flex-wrap: nowrap` and **the address is the
only thing that shrinks** — `min-width: 0` down the chain lets it ellipsise, so
a desktop shows all 44 characters, a phone shows the leading run people check
against the pinned post, and the label and the copy button hold their line at
every width down to 320px. Do not put a second control back in this row; the
hero is where an action belongs.

## The rules this page is under

These are not style preferences. Each one is a ruling, and relaxing one
quietly is the failure mode.

1. **Never render a number that cannot be sourced.** Everything goes through
   `field()` in `ui.js`, which cannot be called without naming its source and
   renders a state — not a blank — when the value is null.
2. **Say where every number came from.** Four badges: `chain`, `snapshot`,
   `pump.fun`, `computed here`. A page that renders trusted and trustless data
   in the same style trains people not to notice which is which. Four, not
   five: a number that would need a fifth badge is a number this page has not
   earned the right to draw.
3. **No prices, no dollar figures, no yield, no APY** (L4, L9). The floor is a
   token count. A test asserts no `standing.js` state can emit a `$`.
4. **"Attested", never "trustless"**, about the caller set.
5. **Nothing about our key architecture is on the page.** Phase 05 §5.5's
   stolen-key paragraph shipped until 2026-08-05 and the owner removed it:
   naming the custody model tells an attacker what to attack, and the exact
   wording named it. The rule it replaces is narrower and still binding —
   *when a limitation is described, describe it precisely rather than
   flatteringly*; the old paragraph existed because an earlier "worst case is
   one week" sentence described a one-shot bound for a repeatable capability.
   The other two limitations are still on the page in full.
6. **Decision 9's sentence is on the page**: if pump.fun removes callouts,
   everything earned stays claimable.
7. **No wallet connection, for anything.** Every number resolves from a pasted
   address.
8. **A wrong number is worse than no number.** Every failure path says what
   could not be reached and what that means.
9. **A chart is a number**, and rules 1, 2 and 8 apply to it unchanged. Every
   card chart carries a badge, and every one refuses to draw rather than show
   an empty axis: an empty axis is a claim that we looked and found nothing,
   and a bar sitting at zero because a balance never loaded is a claim that the
   balance is zero. The refusing happens in `graphs.js`, in the pure layer, so
   a test can hold it there — `ui.js` only turns a refusal into a sentence.
10. **Plain words first; the technical version one click away.** Rule 8 says
    every failure has to say what happened — it does not say the visitor has to
    read a PDA to find out. A state is written for someone deciding whether to
    worry (`not launched yet`, `can't reach Solana`), and the RPC message or
    the missing account address goes inside a `Technical detail` fold. The
    three states live together in `UNAVAILABLE` in `app.js` so no call site
    invents its own wording, and "Unknown" is not one of them: it is honest and
    it tells a reader nothing they can act on.
11. **A figure that has stopped updating says so.** The page re-reads chain data
    every minute, and a value is replaced **only on success** — a figure that
    blanks to "reading…" once a minute reads as broken, and a re-read that fails
    is not evidence that the pool is empty, so the last figure that was actually
    read stays on screen. The cost of that is that a stopped page looks exactly
    like a working one, which is rule 8 in a different disguise, so the moment a
    refresh fails the page names the time the figures were read and says they
    are not moving. The sentence is `freshnessNote` in `clocks.js` — pure, and
    tested — and the one refresh path is `refresh()` in `app.js`, which the
    minute timer and the day rollover both go through.
12. **Anything published is mainnet.** Set 2026-08-05. A devnet page renders
    *real chain reads of activity we generated ourselves* — the figures are true
    about devnet and mean nothing about money — and "4.19 SOL paid out so far"
    is read as a track record whatever a chip in the corner says. So the cluster
    switch is gone from the top bar, `resolveCluster` defaults **and falls back**
    to mainnet, and a typo or an empty query string lands on mainnet rather than
    on a rehearsal. `?cluster=devnet` still resolves and is now an internal tool
    for looking at a rehearsal deployment; whenever it is in use the top bar
    carries a `devnet · internal` chip, because internal or not, nobody should
    have to read a URL to know which chain they are looking at.

## Before launch, and on launch day

Set 2026-08-05, when the page was pointed at mainnet only. **Nothing in this
list is a code change** — the page is finished; this is configuration and the
order it has to happen in.

### What the page does right now

`programId` is unset, so the page takes the "has not launched" branch and says
so in every live slot: the pool, the vault, the day number, the total paid, the
floor read from chain, the countdown, all three cards, and the epoch table. **It
makes no RPC call at all in this state**, which is what keeps it honest while
there is no working endpoint (see below). Everything that does not depend on a
chain — the three steps, the exact rule, the lockout, what counts as selling,
the 90/10 split, the risks — renders in full and is final.

### Blocking, before anything is published

- **An RPC endpoint that works in a browser, and a way to ship it safely.**
  Both halves, and **both are now solved** — this needs configuring, not
  building. Skip to "On launch day" unless you want the reasoning.

  `api.mainnet-beta.solana.com` answers a browser request with **`403 Access
  forbidden`** — measured 2026-08-05, and it is not a rate limit; Solana does
  not serve that endpoint to browsers at all. So a provider is required, which
  is O3.

  A paid provider endpoint has been obtained and works from a browser. **It is
  not in the mainnet config, on purpose.** The key is in the URL path, and
  `config.local.js` is fetched by every visitor like any other script — being
  gitignored keeps a key out of the repository and does nothing to keep it out
  of a browser. Measured on the same day: that endpoint answers
  `access-control-allow-origin: *`, so the key is **not domain-locked** and
  anyone who lifts it off the page can spend the quota from anywhere.

  **So the key is not in the page at all.** Each cluster is configured with a
  same-origin path — `/rpc` for mainnet, `/rpc/devnet` for the rehearsal — and
  `scripts/serve-site.mjs` forwards each to its own provider URL,
  `CALLPOOL_RPC_URL_MAINNET` and `CALLPOOL_RPC_URL_DEVNET`. Nothing in
  `config.local.js` is secret any more, which also retires the "never `scp` that
  file" hazard.

  **One key per cluster, and one route each**, because a single key serving both
  means one exposure burns both — and because the mainnet key is the one that
  will carry a restriction, which is impossible to reason about if the
  rehearsal's traffic also runs through it. A production host leaves
  `CALLPOOL_RPC_URL_DEVNET` unset and that route then serves nothing.
  (`CALLPOOL_RPC_URL` still works as an alias for the mainnet one.)

  A forwarder would only move the problem — anyone can `curl` an open one — so
  `scripts/lib/rpc-proxy.mjs` is a **narrow allowlist of the six read-only
  methods this site calls**, derived from `site/js/` and the vendored web3.js
  rather than guessed:

  | | |
  |---|---|
  | Allowed | `getAccountInfo`, `getMultipleAccounts`, `getBalance`, `getSignaturesForAddress`, `getTransaction`, `getTokenAccountsByOwner` |
  | Refused | everything else, notably `sendTransaction` (a spam relay we pay for) and `getProgramAccounts` (the scan providers bill hardest for) |
  | Bounded | batches ≤ 32, bodies ≤ 64 KB, upstream timeout 15 s |
  | Limited | a token bucket per client — 60 requests, refilling at 1/s |
  | Quiet | no `access-control-allow-origin`, so no other site's browser can use it; refusal reasons go to the log, never to the caller; the provider's error body is never passed through, because it can name the endpoint |

  Verified against the live provider: all six methods return 200 through it,
  `sendTransaction` / `getProgramAccounts` / `requestAirdrop` / oversized
  batches / id-less notifications are refused, and every call the real vendored
  web3.js makes passes the allowlist.

  **Done 2026-08-05: the mainnet key is restricted by IP** to the egress
  addresses of the host running `serve-site.mjs`, and verified the only way that
  means anything — the same `getBalance`, with the same key, from two places:

  | From | Result |
  |---|---|
  | A laptop, straight to the provider | refused, on the grounds of the source address |
  | Through `https://callpool.fun/rpc` | **200**, with a live slot |

  (The provider's wording is not quoted here for the same reason
  `rpc-proxy.mjs` never passes its error body to a caller: it can name the
  endpoint, and the endpoint is the key.)

  **Both** of the host's egress addresses are on the list, IPv4 and IPv6. A
  dual-stack box picks either without announcing it, and Node's `fetch` will use
  IPv6 whenever the provider's hostname has an AAAA record — so authorising only
  the v4 leaves a site that works until the day it doesn't. Do not tidy the v6
  entry away on the grounds that nothing seems to use it.

  **Do not set a domain restriction on this key.** A provider's "allowed
  domains" is an allowlist on the `Referer` (or `Origin`) header of the incoming
  request, and since the key moved behind the proxy nothing sends one: the proxy
  builds a fresh server-to-server request and forwards none of the caller's
  headers, deliberately. Turning a domain restriction on would fail *every*
  request the site makes and the page would render "can't reach Solana". It
  would also protect nothing if the key did leak — a header is one `curl` flag,
  so a `Referer` allowlist is only worth anything when a browser you trust to
  set it truthfully is the thing making the call, which was the architecture
  before the proxy and is not the architecture now.

  **The restriction that fits a server-held key is an IP allowlist**, set to the
  egress addresses of the host running `serve-site.mjs` — it needs no header, and
  someone holding a leaked key cannot source traffic from your host. Providers
  name it variously ("Allowlist IPs", "allowed IPs", endpoint security). A host
  with no stable egress address — most serverless platforms — cannot use one, and
  then the proxy's method allowlist and token bucket are the whole of the defence
  rather than a second layer.

  None of this applies to the crank. `snapshot.mjs`, `post-root.mjs`,
  `airdrop.mjs` and `verify-epoch.mjs` read `SOLANA_RPC_URL` from the
  environment and run on a machine you control, which is the right home for a
  keyed URL:

  ```bash
  export SOLANA_RPC_URL='https://<provider>/<key>'
  ```
- ~~**`links.x` and `links.github`.**~~ Both set 2026-08-05: `github` to the
  repository, `x` to the announcement post. They are the first things anyone
  clicks, so re-check them the day you publish — an announcement post can be
  deleted, and the top bar has no way to know.

### On launch day, in this order

0. **Install from the committed lockfile on whichever host runs the crank.**

   ```bash
   npm ci --ignore-scripts
   ```

   `package-lock.json` is in the repository for the same reason `Cargo.lock` is:
   the scripts it pins hold the snapshot key in memory and sign with it, so
   their dependency versions have to be as fixed as the deployed binary's.
   `npm install` resolves `^1.95.4` to whatever is newest that day — on the
   devnet box it silently picked web3.js 1.98.4 — and the December 2024
   `@solana/web3.js` compromise is exactly that threat model. `npm ci` installs
   the locked tree and fails rather than changing it. `--ignore-scripts` because
   nothing here needs a postinstall hook.

   The site host needs none of this: `serve-site.mjs` is `node:` builtins only.

1. Deploy the program and run `initialize`. Until this lands, nothing else here
   changes anything.
2. **Start the server with the provider URL**, and confirm the boot line says
   `/rpc → …` rather than `NOT CONFIGURED`:

   ```bash
   CALLPOOL_TRUST_PROXY=1 CALLPOOL_RPC_URL_MAINNET='https://<provider>/<mainnet-key>' node scripts/serve-site.mjs
   ```

   Leave `CALLPOOL_RPC_URL_DEVNET` unset in production — `/rpc/devnet` then
   serves nothing, which is what it should do on a public host.

   It binds 127.0.0.1 and speaks no TLS, so it belongs behind whatever
   terminates HTTPS for callpool.fun. `CALLPOOL_TRUST_PROXY=1` is what makes the
   rate limiter read the real client from `X-Forwarded-For`; without it every
   visitor shares one bucket. Do not set it if nothing trustworthy is in front,
   because then the caller picks their own limiter key.

3. Set **`programId`** to `declare_id!` from `programs/callpool`. This is the
   switch: the moment it is set the page reads chain and the live numbers
   appear. Do it *after* step 2 — `programId` is what starts the RPC calls, so
   setting it against a proxy with no upstream turns the page from "not launched
   yet" into "can't reach Solana", which is a worse thing to be showing on
   launch day. Everything below is refinement on top of a working page.
4. Set **`creatorVault`** to pump.fun's creator vault for the coin. Until it is
   set, the "fees not yet swept in" figure reads *not set on this page yet* and
   the pool-vs-accrued chart refuses to draw — deliberately, it is rule 9.
5. Set **`calloutApiKey`** (Phase 02 §2.9). Without it the wallet check's
   callout row reads *could not check*; every chain-sourced number still works.
6. Set **`feeShareTx`** once the fee-share transaction exists. Until then the
   90/10 split is marked **unverified**, which is correct rather than cautious —
   the split is set by pump.fun's instruction and the browser cannot read it
   back from an account.
7. Leave **`mint`** empty unless you want the cross-check. It is read from the
   program's own Config; if the two disagree the page stops rather than render
   another coin's history under this one's name.

### What must not happen

- **Do not publish anything that resolves to devnet.** The cluster switch was
  removed from the top bar for this reason and `?cluster=devnet` is internal.
  See rule 12.
- **Do not put a keyed RPC URL in `config.local.js` and call it protected.** It
  is gitignored, which protects the repository, not the visitor — the file is
  fetched by every browser that loads the page.
- **Do not copy the local `config.local.js` to the web host.** It carries the
  paid devnet key for the dry run and is written for localhost. The host gets
  its own, and the two are not the same file. This is the most likely way the
  key actually leaks: not a mistake in the code, a `scp -r` of the directory.

## What is not built yet

- **The provisional hourly counter has no data source.** The two-clock UI, the
  stalled state and the provisional badge are all built and tested, but nothing
  publishes hourly standings yet, so the counter honestly reads *"No
  provisional standings published yet."* Wiring it up means having the hourly
  poller write a small file the page can read.
- **The fallback claim button.** Rewards are airdropped (L8), so this is the
  path for a payout that fails to land. It needs a wallet adapter, which
  §7.5 says must be vendored and pinned and audited as its own thing. Until
  then the payout-pending state explains that anyone can submit the claim and
  that the destination is fixed on chain, which is true and does not require
  shipping a signing surface.
- **Permalink verification** (§7.8's last four rows). Needs the callout API key
  configured; the states are specified but not implemented.
- **Live fee-share reading** (§7.7). The split is stated and the transaction
  slot is there, but until `feeShareTx` is configured the page marks the 90/10
  split **unverified** rather than asserting it.
- **A 90/10 donut in section 5**, deliberately. It would be the prettiest
  object on the page and the only one with nothing behind it: the split is set
  by pump.fun's instruction, not by our program, so the browser cannot read it
  back from an account the way it reads the floor. Drawing it would have needed
  a fifth source badge for "we wrote this and you cannot check it here", which
  is exactly the badge rule 2 exists to prevent. When `feeShareTx` names the
  transaction that set it, the honest chart becomes possible — until then the
  sentence and the unverified row are the honest rendering.
- **The GitHub link in the top bar.** `links.github` is unset because the repo
  has no remote yet, so the icon renders as a disabled chip saying the source
  is not published. Set it in `config.local.js` when the remote exists.

## Verified against a real chain

On 2026-08-05, against a local `solana-test-validator` running the Phase 06
rehearsal deployment: the pool balance, the epoch index derived from the
on-chain genesis, the mint read from the program's own config, the epoch table
(including a zeroed empty-epoch root and unposted epochs), and the address
calculator — which derived the right associated token account and computed
`hold` with the real `timeline.mjs`.

**The floor check passed**: the on-chain `min_hold` matched what the page
renders, and the mismatch banner stayed hidden. That is the browser half of
devnet proof 20.

Re-run after the visual pass, on a fresh rehearsal deployment (60-second
epochs, three posted epochs, one of them the zero-root empty epoch): all four
hero metrics, the epoch table, the address calculator, and all three card
charts — the pool/accrued bars, the per-epoch sparkline, and the epoch rail,
which sized itself from the 60-second window rather than assuming a day. The
floor check passed again. The theme toggle was checked in both directions,
including the case the OS already prefers the theme being toggled away from.

Re-run again after the minute refresh was added, against the dry-run deployment
(`scripts/tools/deploy-devnet.mjs`, 60-second epochs, eleven epochs settled by
`dry-run-loop.mjs`). Over roughly twenty minutes with the page left open and
never reloaded: every hero figure and the epoch table tracked the chain, the
per-day sparkline **started drawing** the moment a second epoch had been settled
*and paid*, the table gained a zero-root row reading "nobody called out that
day" and a `not posted` row for the epoch deliberately skipped, and the floor
check passed throughout.

Then the validator was stopped mid-session to exercise rule 11. Every figure
stayed on screen with its badge, all three charts stayed drawn, and the page
added, in amber: *"Could not reach Solana just now, so the figures above are
from 2026-08-05 06:33 UTC and are not updating. Reloading usually fixes it."*
Nothing blanked. No console errors at any point except the expected fetch
failures, which are logged deliberately.

Not yet run against devnet or mainnet.
