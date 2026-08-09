# Callpool

A pump.fun coin that routes 90% of its creator fee to the holders who call it
out — settled **daily, paid in SOL**, sized by how much they held and for how
much of the day, and never by the callout itself.

```
sustained(w) = the LOWEST balance w held while holding anything that day
hold(w)      = the smallest balance w still holds for the rest of the day,
               at each moment, averaged across the whole day
locked(w)    = w's balance ended BELOW the floor at any point in the last
               7 whole days — supplying liquidity to this coin's own
               pump.fun pool is the one exception
active(w)    = a callout OR a callout update by w in the last 24 h
eligible(w)  = active(w) AND sustained(w) >= 100,000 CALLPOOL AND NOT locked(w)
weight(w)    = hold(w)
payout(w)    = divisible · weight(w) / Σ weight     airdropped daily, in SOL
```

`sustained` decides **if** you are paid; `hold` decides **how much**. They are
the same number for a wallet that held all day, and they differ for one that
bought partway through — which is the point: 500,000 tokens bought at 20:00 UTC
clears the floor on what it sustained, and is paid on 4/24 of it. Checking the
floor against the prorated number instead would exclude exactly the holders the
rule exists to include. `divisible` is the pool less rent, less what earlier
epochs still owe, and less the carry already promised.

The floor is **100,000 tokens — 0.01% of the supply**, written on chain once and
never changed. There is no dollar threshold and no price feed anywhere in the
system.

**The callout makes you eligible. The holding sizes the payment.** That one
separation is the entire anti-gaming design, and everything below follows from
it.

**There is no staking and nothing to opt into.** Nothing is locked, nothing is
registered, and your tokens stay liquid and sellable at every moment. Eligibility
is computed from public chain history and pump.fun's callout feed whether or not
you ever visit the site.

**You do not have to collect anything.** Each day's shares are **airdropped**
once the challenge window closes. The site shows what you hold, what you called,
whether you are locked out and what you were paid — **no wallet connection
needed to see any of it**, and none needed to be paid. A claim page exists as a
fallback if a payout ever fails to land; the destination is fixed on chain, so
nothing about connecting can redirect it.

Two penalties, decided separately. **Any decrease collapses that day's weight**,
because a sale at 18:00 caps every earlier hour at the lower balance too —
trimming costs you the day even when it is not a sale. **Dropping below the floor
additionally locks the next seven days**, and buying back does not shorten it.
Staying at or above the floor is not a lockout. **Sending your tokens anywhere is
judged exactly like selling** — including to another wallet you own, since there
is no netting and no exemption for housekeeping. **A first-time buyer is not
penalised**: they are paid from their first day, prorated by the part of it they
held.

Shares below the fee it would cost to send them are **withheld, not forfeited**:
they are carried forward and paid on the next day the address is eligible, once
the running total clears the threshold. Under daily settlement this is the
ordinary case. Carry expires after 30 days and returns to the pool, and adding to
it does not restart that clock.

**Status: built, tested, and deployed nowhere.** The program, the settlement
crank, the verifier and the website are all here and all pass their tests. **No
transaction has been signed on any public cluster, and no coin exists.** Every
parameter above is still a one-line edit until `initialize` is called, and it is
immutable the moment it is. Treat every number here as a statement of intent
until a mainnet transaction says otherwise.

---

## Why the split between eligibility and size

Pay *per callout* and the cheapest way to earn is a hundred wallets holding a
dollar each. Pay *per token held through the day*, gated on a callout, and
every one of those attacks costs more than it returns.

Everything below falls out of two choices: **what you keep for the rest of the
day, not the balance at any instant** — a snapshot has a moment you can time, a
suffix minimum does not — and **a 7-day lockout on dropping below the floor**,
so dumping costs a week rather than a day.

| Attack | Why it fails |
|---|---|
| Buy a dollar, call out, collect | The floor is 100,000 tokens — 0.01% of the supply. A dust position is not eligible at all, and at most 10,000 wallets can ever qualify at once. |
| Call out, let followers buy, sell into them | Hit twice: the sale caps every earlier hour of that day at the lower balance, **and** if it lands below the floor the wallet is locked out for the next 7 days. |
| Call, sell, rebuy, call again | A sale below the floor locks the wallet out for 7 days, and buying back does not shorten it. Calling out during those 7 days earns nothing. |
| Split a bag across 50 wallets, 50 callouts | Weight is **linear**, so 50 wallets of size *h* earn exactly what one wallet of size *50h* earns. Any concave weight function would pay sybils a premium; this one pays them nothing extra. Each wallet must clear the floor on its own. |
| Buy an hour before the day closes | Weight is scaled by the part of the day you held, so an hour is worth an hour — about 1/24 of the balance, not the whole of it. |
| Wash-trade to inflate the fee pool | You pay the full pump.fun trading fee to recover a fraction of the creator fee. It loses money by construction. |

Every row above is asserted, not argued: the rules are implemented in
[`scripts/lib/timeline.mjs`](scripts/lib/timeline.mjs) and
[`scripts/lib/epoch-build.mjs`](scripts/lib/epoch-build.mjs), and
[`scripts/tests/`](scripts/tests/) holds each one to it — including linearity,
which is the property that makes splitting a bag across wallets pointless.

---

## The one thing you have to trust, stated first

**Callouts are not on chain.** There is no callout instruction in any pump.fun
program. The published IDLs — `pump`, `pump_amm`, `pump_fees` — contain nothing
resembling one, and pump.fun's own docs repo has no page for the feature. A
callout is a row in pump.fun's database that fires a push notification to your
followers.

So the honest description of this design is:

> **Payouts are on chain. The trigger is not, and cannot be.**

Something has to tell the chain who called out. That something is an off-chain
snapshot, and it is the one part of this system a holder must either trust or
check for themselves. The design's job is to make checking cheap and to make
trusting cost as little as possible:

- The snapshot is **published raw** alongside every epoch, with the script that
  turns it into the on-chain merkle root. Anyone can recompute the root.
- There is a **challenge window** between posting a root and money moving.
- The key that posts each epoch's results is a **2-of-3 multisig**, and it can
  do exactly one thing: post a root. It has no power over your tokens, no power
  over any parameter, and no way to pause or withdraw anything.

Note the asymmetry that makes this workable: **balances are on chain and
callouts are not.** Anyone with an RPC can replay the transfers and recompute
every `hold` and every weight exactly. Only the caller list has to be taken on
trust — and keeping that list at exactly one item is the whole game.

**Said plainly, because the alternative is worse:** if that key were stolen, the
thief could take the pool and future fees, because there is no key rotation and
no admin path to stop them. What they could never do is touch your tokens or
change the rules. That bound is not rounded in our favour: it is a repeatable
capability, not a one-off, for as long as the key is out.

The callout feed **has been read**, and every record it returns carries the
caller's Solana address — which is what makes the caller list checkable per
wallet rather than only in aggregate. The client is
[`scripts/lib/callouts.mjs`](scripts/lib/callouts.mjs), and it is deliberately
the smallest thing in the repository: fetch, merge, and say plainly when the
answer is incomplete.

---

## What is on chain and what is not

| | On chain | Off chain |
|---|---|---|
| Fee accrual to the pool | ✅ pump.fun creator fee → pool PDA | |
| Triggering the fee payout | ✅ `distribute_creator_fees`, zero signers | |
| Balance history — every `hold` | ✅ token transfers, replayable by anyone | |
| The parameters the rule uses | ✅ written once, immutable | |
| Payment | ✅ merkle claim against a funded PDA, no recipient signature | |
| Your callout, checked live | ✅ queried from pump.fun **in your browser**, not via us | |
| Weight arithmetic | | ➖ computed off chain, **reproducible from chain** |
| **Who called out** | | ❌ pump.fun API snapshot — **the only trusted input** |

Nothing in the right-hand column can move money on its own. The middle row is
computed rather than trusted: a stranger re-running the published script on
public chain data must get the same root, byte for byte, or something is wrong.

---

## Fee routing

**90% of the creator fee goes to the caller pool. 10% pays for infrastructure.**

```
9,000 bps  →  pool PDA      rewards for holders who called
1,000 bps  →  ops           paid RPC, hosting, the crank, the domain
```

The 10% is an infrastructure line, not a founder's cut. It funds a paid RPC, a
host that isn't a laptop, a domain — and the gas for **airdropping every
holder's reward to them daily, so nobody has to claim anything.** The failure
that actually kills a mechanism like this is the crank quietly stopping because
nobody is paying for it. It also only becomes real money if the coin does real
volume: at $1M of weekly volume the whole creator fee is around $500, so this
line is roughly $50 a week against a bill that is larger than that. **If this
coin does nothing, we are paid nothing and the crank comes out of pocket
anyway.**

**The split is permanent the moment it is written**, and not because we promise
it. pump.fun's `update_fee_shares_v2` sets `admin_revoked = true` as part of the
same instruction that sets the shares, so the write revokes its own authority —
*"this instruction can only effectively be used once per `sharing_config`"*, in
their words. There is no second write, no repair path, and no window in which we
hold the ability to change it.

The pool address is seeded on a constant, so it exists before the coin does and
can simply be pasted into pump.fun's own creator-rewards dialog:

```
callpool  create_pool          pool address published
pump.fun  → Create             90% → pool address
                               10% → creator wallet
                               permanent the instant it is confirmed
callpool  initialize(mint)     binds the coin, starts the epoch clock
```

Fees do **not** arrive per trade. `buy_v2` and `sell_v2` write to pump's own
`creator_vault` PDA and never touch the `creator` account, so a sweep call is
always required — there is no setting that streams fees directly on each trade.

The saving grace is that the sweep takes **zero signer accounts**. Anyone can
push accrued fees into the pool and nobody can withhold them, so this is a
liveness dependency and never a trust one: if our crank stops, the fees sit
safely in pump's vault until any holder moves them. That property is inherited
from pump.fun, not invented here.

The pool address is derived from a constant rather than from the mint —
[`poolPda`](scripts/lib/program.mjs) — precisely so it exists before the coin
does and can be named at creation time.

---

## The program

Six instructions, no admin path, no pause, no withdraw. It never touches your
tokens — it holds lamports and verifies merkle proofs:

```rust
create_pool()                                  // permissionless; the address given to pump.fun
initialize(mint, params)                       // once, after the coin exists
post_epoch_root(epoch, root, n, allocate)      // snapshot key; pool size derived on chain
claim(epoch, i, amount, proof)                 // merkle claim; NO recipient signature
close_epoch(epoch)                             // unpaid lamports roll back into the pool
sweep_wsol()                                   // post-graduation fees arrive wrapped
```

`claim` requires **no signature from the recipient** and the destination is
fixed inside the merkle leaf, so anyone can submit it for anyone. That is how
the daily airdrop works — and it means a holder who ever distrusts our bot can
send the same instruction themselves from the published proof.

The invariant every one of them must preserve:

```
pool.lamports  >=  outstanding + rent_exempt_minimum
```

`claim` is the only instruction that moves lamports out of the pool.
`post_epoch_root` writes a 32-byte root and a bitmap length — it does **not**
set the pool size, which is computed on chain from the pool's own balance.

There are no user accounts and no user rent. Nothing to opt into, nothing to
exit.

The program is [`programs/callpool/src/lib.rs`](programs/callpool/src/lib.rs) —
six instructions, no admin path, no token authority. `scripts/verify.sh`
asserts all three of those structurally, so a seventh instruction or a
`set_anything` fails the build rather than a review.

---

## The site

Static HTML, no build step, no npm tree, reading chain state directly in the
browser. Its job is not to sell: it is to let a holder confirm, without
trusting us, that the epoch they were paid for was computed the way this page
says it was. Every number it shows is either read from an RPC or recomputed
locally from a published snapshot — never served as a fact.

How it is built, the rules it is under, and what is deliberately not built:
[`site/README.md`](site/README.md).

---

## What is in here

| Path | What it is |
|---|---|
| [`programs/callpool/`](programs/callpool/) | The program. Six instructions, and the merkle verifier. |
| [`programs/callpool/tests/`](programs/callpool/tests/) | 49 Rust tests against the real binary, including property tests for the invariants. |
| [`scripts/holds.mjs`](scripts/holds.mjs) | `hold(w, d)` and `locked(w, d)` for one wallet, from chain history. The whole mechanic reduces to this. |
| [`scripts/snapshot.mjs`](scripts/snapshot.mjs) | One epoch's inputs, weights and merkle tree → `snapshots/epoch-N/`. Touches no key. |
| [`scripts/post-root.mjs`](scripts/post-root.mjs) | The only script that signs anything. |
| [`scripts/airdrop.mjs`](scripts/airdrop.mjs) | Pays every leaf. Anyone can run it — the destination is inside the leaf. |
| [`scripts/verify-epoch.mjs`](scripts/verify-epoch.mjs) | **The reproducer.** Recompute any published epoch, offline or against an RPC. |
| [`scripts/crank.mjs`](scripts/crank.mjs) | The four above, in order, for one epoch. |
| [`scripts/verify.sh`](scripts/verify.sh) | Build, every test, and the structural assertions about the program's shape. |
| [`site/`](site/) | The website. No build step, one pinned dependency — [`site/README.md`](site/README.md). |
| [`scripts/serve-site.mjs`](scripts/serve-site.mjs) | Serves the site, and `/rpc` — the same-origin proxy that holds the RPC provider key so the page never carries one. Screening in [`scripts/lib/rpc-proxy.mjs`](scripts/lib/rpc-proxy.mjs): six read-only methods, rate limited, and no CORS. |
| [`snapshots/`](snapshots/) | The audit trail. One directory per settled day, each reproducible by a stranger. |

**The planning documents are not published.** Comments and commit messages
refer to them in shorthand — *Phase 05 §5.3*, *L12*, *D7* — and those are
pointers into private working material, not files in this repository. Nothing
in them is needed to check the system: the audit trail is `snapshots/` and the
code that recomputes it, and both are here in full. Where a comment says *why*,
the reasoning is in the comment itself.

---

## Honest limits

**The pool is a share of a share.** Creator fees on pump.fun were measured at
**30 bps of bonding-curve volume and 5 bps of AMM volume** (`VERIFY` — pump.fun
changes these). Callers receive whatever fraction of that the permanent split
assigns them. A coin doing $1M of post-graduation volume in a week generates
roughly $500 of creator fee in total, and the caller pool is a slice of that.
**Say the arithmetic out loud in public copy rather than letting people imagine
a larger number.**

**The snapshot is a trusted input.** It is bounded, published, challengeable,
and reproducible — but it is trust, and calling it anything else would be a
lie. Anyone who tells you a callout-reward scheme is fully trustless has not
checked whether callouts are on chain.

**The challenge window is a warning, not a brake.** There is no pause and no
dispute process by design, so the 24 hours before money moves are time for
anyone to find a bad root and say so — not time for anyone to stop it.

**Going below the floor costs you 7 days.** Any decrease that lands under it, to
any destination, including a wallet you own yourself. Buying back does not
shorten it. This is deliberately blunt and it will catch people out. Trimming
while staying at or above the floor is not a lockout — but it still collapses
that day's weight to the balance you trimmed to, which catches people out just
as often.

**The minimum is 0.01% of the supply**, which rises in dollar terms as the coin
does. At a $10M market cap it is about $1,000. It is written on chain once and
cannot be changed.

**No yield is promised, and none should be inferred.** The pool is whatever the
creator fee produced in the last 24 hours, divided among whoever qualified. Some
days that is small.

**pump.fun can reassign a coin's fee recipient.** `set_creator` and
`admin_set_creator` are controlled by pump.fun. Nothing deployed here prevents
it.

**pump.fun can change or remove callouts.** The feature shipped in January 2026
and is undocumented for developers. If the feed goes away, the eligibility gate
goes away with it, and the fallback — pay holders with no callout gate — has to
be a decision made in advance, not improvised.

**Smart contracts carry risk, including undiscovered bugs.** There is no admin
key, so nothing can be paused, reversed, or recovered.

**This is a memecoin.** It is not an investment, and nothing here is financial
advice.

---

## License

Apache-2.0
