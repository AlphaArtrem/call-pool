# site/vendor

Pinned third-party code, committed rather than fetched.

Phase 07 §7.5 is explicit that this is a security decision, not a stylistic
one: **nothing that builds or signs a transaction may be fetched from a third
party at runtime.** A CDN `<script>` tag is a standing permission for whoever
controls that CDN to replace the page's JavaScript, and drainer injections
through exactly that path are routine.

| File | What | Version | Source |
|---|---|---|---|
| `solana-web3.esm.js` | `@solana/web3.js` browser ESM build | **1.98.4** | `node_modules/@solana/web3.js/lib/index.browser.esm.js` |

## Why this one dependency exists at all

The site derives addresses it must not get wrong — the config and pool PDAs,
and a pasted wallet's associated token account. Getting an ATA wrong means
reading a *different account's* balance history and rendering a confident
wrong `hold`, which §7.4 forbids more strongly than it forbids a missing
number.

Deriving those addresses correctly needs program-address derivation, which
needs an ed25519 on-curve check. The alternatives were hand-rolling that
arithmetic (new, unaudited crypto for a number people's money depends on) or
guessing which of a wallet's token accounts is the associated one. Reusing the
library this repo already depends on, already pins in `package-lock.json`, and
already runs every proof against is the smallest correct answer.

It is used for **reads and address derivation only.** The site builds no
transactions and connects no wallet — see `site/README.md`.

## Refreshing it

```bash
cp node_modules/@solana/web3.js/lib/index.browser.esm.js site/vendor/solana-web3.esm.js
```

Update the version in the table above when you do, and re-run
`npm test` — `scripts/tests/site.test.mjs` asserts the vendored copy matches
the installed package byte for byte, so a stale vendor file fails the suite
rather than drifting silently.
