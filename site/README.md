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

This is also why `scripts/` being public is a feature: section 7 of the page
tells people to run those exact files.

## Layout

```
index.html                the whole page — all eight sections
app.css                   system fonts, one accent, light/dark
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
  position.js    the address calculator
  epochs.js      the audit-trail table
  ui.js          render primitives, including the source badge

vendor/          pinned @solana/web3.js — see vendor/README.md
```

`standing.js`, `clocks.js`, `program.js`, `base58.js` and `config.js` are pure
and dependency-free on purpose: `scripts/tests/site.test.mjs` exercises them in
Node, so the copy a holder reads when they are locked out is asserted rather
than hoped for.

## The rules this page is under

These are not style preferences. Each one is a ruling, and relaxing one
quietly is the failure mode.

1. **Never render a number that cannot be sourced.** Everything goes through
   `field()` in `ui.js`, which cannot be called without naming its source and
   renders a state — not a blank — when the value is null.
2. **Say where every number came from.** Four badges: `chain`, `snapshot`,
   `pump.fun`, `computed here`. A page that renders trusted and trustless data
   in the same style trains people not to notice which is which.
3. **No prices, no dollar figures, no yield, no APY** (L4, L9). The floor is a
   token count. A test asserts no `standing.js` state can emit a `$`.
4. **"Attested", never "trustless"**, about the caller set.
5. **Phase 05 §5.5's exact stolen-key wording**, not the old "worst case is one
   week" sentence, which described a one-shot bound for a repeatable capability.
6. **Decision 9's sentence is on the page**: if pump.fun removes callouts,
   everything earned stays claimable.
7. **No wallet connection, for anything.** Every number resolves from a pasted
   address.
8. **A wrong number is worse than no number.** Every failure path says what
   could not be reached and what that means.

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

Not yet run against devnet or mainnet.
