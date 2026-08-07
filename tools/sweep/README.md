# tools/sweep

**A separate npm package, on purpose.** It holds `@pump-fun/pump-sdk` and
nothing else of substance.

```bash
cd tools/sweep && npm ci
```

## Why it is not part of the repository

The root `package-lock.json` is committed for the same reason `Cargo.lock` is.
From the root `.gitignore`:

> the scripts it pins hold the snapshot key in memory and sign with it, so
> their dependency versions have to be as fixed as the deployed binary's

`post-root.mjs` and `cosign.mjs` are those scripts. Naming `@pump-fun/pump-sdk`
in the root manifest would add `@coral-xyz/anchor`, `@pump-fun/pump-swap-sdk`,
`@pump-fun/agent-payments-sdk` and `bn.js` to that surface **on every host that
runs `npm ci`** — including box B, whose only job is to be the second signer and
which has no reason to own pump's dependency tree at all.

Running the sweep in its own process was necessary and not sufficient. A process
boundary decides what is resident at runtime; a manifest decides what gets
installed. Both had to move.

## The contract

`pump-fees.mjs` exports two functions and **returns no web3 objects**:

| | |
|---|---|
| `readDistributable(rpcUrl, mint)` | `{ minimumRequired, distributableFees, canDistribute, isGraduated }` — amounts as decimal strings |
| `buildDistributeInstructions(rpcUrl, mint)` | `{ instructions, isGraduated }` — each instruction a base58 programId, base58 account keys, base64 data |
| `available()` | whether the SDK is installed here |

Everything crossing back is a string, a boolean or base64 bytes.
`scripts/sweep.mjs` rebuilds the instructions with the **repository's** pinned
`@solana/web3.js`.

That is load-bearing, not ceremony. This package resolves its own nested copy of
web3.js — `tests/pump-fees.test.mjs` asserts that it does — so two module
instances exist and `instanceof` fails between them. Any object handed across
structurally would be interoperating by luck.

It also buys a sentence worth having: **no object built by pump's SDK is ever
signed.** It is rebuilt from bytes first, by code in the audited tree.

## The tests here, and why they are not in the main suite

`tests/pump-addresses.test.mjs` checks `scripts/lib/pump-addresses.mjs` — the
main tree's web3-only re-implementation of pump's PDA derivations — against
pump's own SDK. That is the oracle for **L18's LP mint**, and L18 is the ruling
that separates a liquidity deposit from a sale.

It lives here because putting it in `scripts/tests/` would have imported the SDK
from the main suite and put it back in the root lockfile through the back door.

`scripts/verify.sh` runs these tests when this package is installed, and
**fails a deployment build when it is not**.

## On the hosts

Only the crank host needs this. The co-signer never sweeps, and the whole point
is that it never installs any of it.

```bash
cd /srv/callpool/tools/sweep && sudo -u callpool npm ci
```

A host without it is not broken: `scripts/sweep.mjs` reports a fault naming this
command, the wSOL half of the sweep still runs, and the crank settles the epoch
regardless — unswept fees roll forward.
