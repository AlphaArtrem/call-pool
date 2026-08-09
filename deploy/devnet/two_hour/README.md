# devnet — the two-hour profile (30-minute epochs)

The long-clock devnet run. Four epochs in two hours, a sampler every five
minutes, and the coin graduated **last**.

## What is in here, and what is not

Only the files whose contents change with the clock. Everything else is shared
and lives one or two levels up — copying identical bytes into three profiles is
how they drift apart.

| file | why it is profile-specific |
|---|---|
| `profile.env` | `epoch_seconds` and `challenge_seconds`, which `initialize` writes **permanently** |
| `callpool-crank.timer` | fires at `:00:20` and `:30:20` — one tick per epoch, offset past the boundary |
| `callpool-crank.service` | `--await-root 400` must exceed the 300s challenge window |
| `callpool-watchdog.service` | `--grace`, `--stale-after` and `--sample-stale` are all clock-relative |
| `callpool-sample-standings.timer` | every 5 minutes → 6 samples per epoch |
| `callpool-cosign.timer` | every 60s — box B's half of the 2-of-2 |

Shared, from `deploy/`: `callpool-publish.service`, `callpool-site.service`,
`callpool-cosign.service`, `callpool-trade.service` + `callpool-trade-loop.sh`,
`Caddyfile`.

## Install

Box A (crank, publisher, sampler, trading):

```bash
install -m 0644 deploy/devnet/two_hour/callpool-crank.{service,timer} /etc/systemd/system/
install -m 0644 deploy/devnet/two_hour/callpool-sample-standings.timer /etc/systemd/system/
install -m 0644 deploy/mainnet/callpool-sample-standings.service /etc/systemd/system/
install -m 0644 deploy/callpool-publish.service /etc/systemd/system/
install -m 0755 deploy/callpool-trade-loop.sh /usr/local/bin/callpool-trade-loop
install -m 0644 deploy/callpool-trade.service /etc/systemd/system/
systemctl daemon-reload
```

Box B (co-signer, watchdog):

```bash
install -m 0644 deploy/callpool-cosign.service /etc/systemd/system/
install -m 0644 deploy/devnet/two_hour/callpool-cosign.timer /etc/systemd/system/
install -m 0644 deploy/devnet/two_hour/callpool-watchdog.{service,timer} /etc/systemd/system/
systemctl daemon-reload
```

## The order that matters

`initialize` starts the clock, and **everything after it is an epoch that must
settle**. So the cast is bought first, while there is no clock running:

1. fresh program keypair → patch `declare_id!` → `cargo-build-sbf` →
   **`git checkout programs/` immediately** → ship the `.so` and the keypair to
   box A as `target/deploy/callpool-keypair.json`
2. `CALLPOOL_PROGRAM_ID` on **both** boxes
3. `solana program deploy` — via `https://api.devnet.solana.com`
4. `deploy-devnet.mjs --stop-after-pool`
5. `mk-pump-coin.mjs` — short `--name`/`--symbol`
6. `mk-pump-cast.mjs --count 60 --scenario-sol 0.02`, then confirm
   `readCurveState().complete` is **still false**
7. `scenario-driver.mjs --assign`
8. fund signer A and signer B (~0.5 each); start `callpool-publish`
9. **now** `initialize`, mid-epoch — see the timing rule below
10. `holders-above-floor.mjs --out epochs/devnet/holders.json`, then the timers
11. start `callpool-trade.service` and leave it running for the whole window
12. four epochs; then verify, **then** graduate, then recover

### Initializing on the right second

Three constraints hold at once and only one is obvious:

- **not on a boundary** — the cluster clock lags wallclock, so a boundary-timed
  initialize takes the boundary just crossed, and epoch 0 can never be settled;
- **in the future** — same failure;
- **less than one epoch ahead** — the program rejects it outright.

Early-to-mid epoch satisfies all three. And note `preflight-initialize.mjs`
checks a genesis **you** compute while `deploy-devnet.mjs` computes its **own**
from chain time — passing preflight is not proof the value it writes is the one
you checked.

## What four epochs cannot prove

Two hours at 30-minute epochs is **four epochs**, and three matrix rows are out
of reach. Report them as unproven; do not let four epochs read as twelve
epochs' worth of evidence.

| row | why it needs longer |
|---|---|
| **B12** | the lockout *expiring* — 7 whole epochs is 3.5 hours. Run 3 proved the lockout **fires**; nothing has ever proved it **lifts**. |
| **D3** | dust accumulating across epochs until it clears the threshold |
| **D9** | a crank stopped for 2+ epochs then catching up — costs half the run |

The `one_hour` profile reaches all three, because seven 5-minute epochs is 35
minutes. **If the gate needs B12, run that profile too** — the two are
complementary rather than alternatives.
