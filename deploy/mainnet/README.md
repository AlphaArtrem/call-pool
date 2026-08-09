# mainnet — the real clock (24-hour epochs)

The units that run the live coin. Everything here assumes `epoch_seconds =
86400` and a 24-hour challenge window, both written permanently by `initialize`.

| file | when it fires |
|---|---|
| `callpool-crank.service` / `.timer` | `00:02 UTC` daily — settle yesterday, then pay |
| `callpool-airdrop.service` / `.timer` | `06:20`, `12:20`, `18:20 UTC` — pay anything the crank left unpaid |
| `callpool-poll-callouts.service` / `.timer` | keeps the callout store current |
| `callpool-sample-standings.service` / `.timer` | hourly — the site's "estimated today" |

Shared, from `deploy/`: `callpool-publish.service`, `callpool-site.service`,
`callpool-cosign.service` + `.timer`, `callpool-watchdog.service` + `.timer`,
`Caddyfile`.

## What must NOT be installed here

**`callpool-trade.service`.** It buys and sells the coin on a schedule to make
creator fees accrue, which is a rehearsal prop. On mainnet the fees come from
real holders trading a real coin, and running it here would be market-making
with the payer's SOL.

## Before deploying

Read [`docs/MAINNET-DEPLOYMENT.md`](../../docs/MAINNET-DEPLOYMENT.md) — the keys
were generated 2026-08-08 and must never be regenerated, and four of the steps
are irreversible.

**The devnet gate in `docs/FINAL-DEVNET-TEST.md` blocks this.** It has not
passed. Runs 1, 2 and 3 each found bugs in the machinery around the mechanic
rather than in the program, and the last of them was still finding them at six.

## The two settings a devnet profile changes and this one must not

- **`--stale-after` / `--grace`** are mainnet-sized here (3600 / 14400). Those
  are correct for a 24-hour epoch and would hide a dead crank for a whole run on
  any devnet clock — which is exactly what happened in run 2.
- **The sampler is hourly.** A devnet profile samples every few minutes because
  its epochs are minutes long; at 24-hour epochs hourly is 24 samples a day.
