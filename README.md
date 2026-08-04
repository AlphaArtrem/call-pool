# callpool

A pump.fun coin that routes 90% of its creator fee to the holders who call it
out — settled **daily, paid in SOL**, sized by what they held continuously
through the day, and never by the callout itself.

```
hold(w)     = the MINIMUM balance w held at any point that day
locked(w)   = w's balance decreased at any point in the last 7 days
active(w)   = a callout OR a callout update by w in the last 24 h
eligible(w) = active(w)  AND  hold(w) >= 100,000 CALLPOOL  AND  NOT locked(w)
weight(w)   = hold(w)
payout(w)   = pool · weight(w) / Σ weight     airdropped daily, in SOL
```

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

Selling costs you two things: that day's reward, because the minimum you held
collapses — and the next seven days, because any decrease locks you out. Buying
back does not shorten it. **Sending your tokens anywhere counts as selling**,
including to another wallet you own — there is no netting and no exemption for
housekeeping. **A first-time buyer is not penalised**: hold through one full day
and you are paid, which is roughly 24 hours from your first buy.

**Status: nothing is built, nothing is deployed, nothing is proven.** This repo
currently contains a plan and this file. Treat every number in it as a
placeholder until a devnet transaction says otherwise.

---

## Why the split between eligibility and size

Pay *per callout* and the cheapest way to earn is a hundred wallets holding a
dollar each. Pay *per token held through the day*, gated on a callout, and
every one of those attacks costs more than it returns.

Everything below falls out of two choices: **the minimum balance over the day,
not the balance at any instant** — a snapshot has a moment you can time, a
minimum does not — and **a 7-day lockout on any decrease**, so dumping costs a
week rather than a day.

| Attack | Why it fails |
|---|---|
| Buy a dollar, call out, collect | The floor is 100,000 tokens — 0.01% of the supply. A dust position is not eligible at all, and at most 10,000 wallets can ever qualify at once. |
| Call out, let followers buy, sell into them | Hit twice: that day's minimum collapses, **and** the wallet is locked out for the next 7 days. |
| Call, sell, rebuy, call again | The sale locks the wallet out for 7 days, and buying back does not shorten it. Calling out during those 7 days earns nothing. |
| Split a bag across 50 wallets, 50 callouts | Weight is **linear**, so 50 wallets of size *h* earn exactly what one wallet of size *50h* earns. Any concave weight function would pay sybils a premium; this one pays them nothing extra. Each wallet must clear the floor on its own. |
| Buy an hour before the day closes | The minimum includes every hour you held nothing. Weight is zero. |
| Wash-trade to inflate the fee pool | You pay the full pump.fun trading fee to recover a fraction of the creator fee. It loses money by construction. |

The full derivation, the worked examples, and the attacks this **does not**
stop — including what splitting a bag across wallets *does* buy you — are in
[`docs/phase-01-mechanic-spec.md`](docs/phase-01-mechanic-spec.md).

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
change the rules. The full bound, with nothing rounded in our favour, is in
[`docs/phase-05-epoch-oracle-audit.md`](docs/phase-05-epoch-oracle-audit.md).

The callout feed **has been read** and every record carries the caller's Solana
address — see [`docs/phase-02-callout-data-source.md`](docs/phase-02-callout-data-source.md).

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

Details and the ordering constraints in
[`docs/phase-03-fee-routing.md`](docs/phase-03-fee-routing.md).

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

Full spec in [`docs/phase-04-program.md`](docs/phase-04-program.md).

---

## The site

Static HTML, no build step, no npm tree, reading chain state directly in the
browser. Its job is not to sell: it is to let a holder confirm, without
trusting us, that the epoch they were paid for was computed the way this page
says it was. Every number it shows is either read from an RPC or recomputed
locally from a published snapshot — never served as a fact.

Spec in [`docs/phase-07-website.md`](docs/phase-07-website.md).

---

## Plan

| # | Phase | Doc |
|---|---|---|
| — | **Locked decisions — read before changing the mechanic** | [`DECISIONS-LOCKED`](docs/DECISIONS-LOCKED.md) |
| 01 | Mechanic & anti-gaming spec | [`phase-01`](docs/phase-01-mechanic-spec.md) |
| 02 | Callout data source — ✅ resolved | [`phase-02`](docs/phase-02-callout-data-source.md) |
| 03 | Fee routing & the permanent split | [`phase-03`](docs/phase-03-fee-routing.md) |
| 04 | The program | [`phase-04`](docs/phase-04-program.md) |
| 05 | Epochs, snapshots, and the audit trail | [`phase-05`](docs/phase-05-epoch-oracle-audit.md) |
| 06 | Devnet proofs | [`phase-06`](docs/phase-06-devnet-proofs.md) |
| 07 | Website | [`phase-07`](docs/phase-07-website.md) |
| 08 | Launch runbook | [`phase-08`](docs/phase-08-launch-runbook.md) |
| 09 | Post-launch & keeping the crank alive | [`phase-09`](docs/phase-09-post-launch.md) |

Status, findings, and open decisions: [`docs/00-TRACKER.md`](docs/00-TRACKER.md).

> `docs/` is gitignored as private working material, matching the reference
> project's convention. The audit trail holders read is the website and the
> published epoch snapshots — not this plan. Remove the `docs/` line from
> `.gitignore` if you want the plan public too.

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

**Selling or sending any tokens costs you 7 days.** Any decrease, however small,
to any destination, including a wallet you own yourself. Buying back does not
shorten it. This is deliberately blunt and it will catch people out.

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
