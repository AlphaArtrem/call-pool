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
`/snapshots`, so the same files work on localhost and in production. The one
place the domain does matter is the RPC key, which has to be locked to it or
proxied through it; see "Before launch, and on launch day".

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
  position.js    the address calculator
  epochs.js      the audit-trail table
  ui.js          render primitives: the source badge, and the charts
  topbar.js      theme toggle, cluster switch, social links

vendor/          pinned @solana/web3.js — see vendor/README.md
```

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
   The other three limitations are still on the page in full.
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
  Both halves, and only the first is solved.

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

  One of these has to be true before the URL goes in:

  1. **A proxy you control** — the page calls `https://callpool.fun/rpc` and the
     key lives server-side where a browser cannot reach it. `rpc: '/rpc'` in the
     config, same-origin, no CORS involved. This is the option that does not
     depend on the provider offering anything.
  2. **A key restricted to `callpool.fun`** in the provider's dashboard, scoped
     read-only. The key is still visible; it just stops being usable by anyone
     else. Verify the restriction by calling it from another origin *before*
     trusting it — today that call returns `*`, so the restriction is not on.

  Use a **separate key per cluster** either way. One key currently serves both
  devnet and mainnet, so exposing the page's key would burn the rehearsal's too.

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

1. Deploy the program and run `initialize`. Until this lands, nothing else here
   changes anything.
2. Set **`rpc`** to the proxy path or the domain-locked key, and **`programId`**
   to `declare_id!` from `programs/callpool`. These two go in together and in
   that order — `programId` is the switch that starts the RPC calls, so setting
   it while `rpc` is still the 403 endpoint turns the page from "not launched
   yet" into "can't reach Solana", which is a worse thing to be showing on
   launch day. Everything below is refinement on top of a working page.
3. Set **`creatorVault`** to pump.fun's creator vault for the coin. Until it is
   set, the "fees not yet swept in" figure reads *not set on this page yet* and
   the pool-vs-accrued chart refuses to draw — deliberately, it is rule 9.
4. Set **`calloutApiKey`** (Phase 02 §2.9). Without it the wallet check's
   callout row reads *could not check*; every chain-sourced number still works.
5. Set **`feeShareTx`** once the fee-share transaction exists. Until then the
   90/10 split is marked **unverified**, which is correct rather than cautious —
   the split is set by pump.fun's instruction and the browser cannot read it
   back from an account.
6. Leave **`mint`** empty unless you want the cross-check. It is read from the
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
