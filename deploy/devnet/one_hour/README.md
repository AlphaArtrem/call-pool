# devnet — the one-hour profile (5-minute epochs)

The shakedown run. Twelve epochs in an hour, which is what §5's matrix was
written for, and short enough to re-run the same afternoon when it finds
something. Run 3 used this profile and found six bugs.

## What is in here

Only the clock-dependent files; the rest are shared from `deploy/`.

| file | value |
|---|---|
| `profile.env` | `epoch_seconds=300`, `challenge_seconds=60` — **permanent once written** |
| `callpool-crank.timer` | `*:0/5:20` — one tick per epoch, 20s past the boundary |
| `callpool-crank.service` | `--await-root 200`, `--holders`, `--lookback 50 --max 15` |
| `callpool-watchdog.service` | `--grace 120 --stale-after 420 --sample-stale 600` |
| `callpool-sample-standings.timer` | every 2 minutes |
| `callpool-cosign.timer` | every 60s |

## Why these numbers

- **`--await-root 200`** comfortably clears the 60s challenge window.
- **`--holders`** is what lets a *truncated* feed settle at all (C7). Without it
  the crank refuses — correctly, C8 — and that refusal blocks every later epoch
  behind it, because `settle-outstanding` stops at the first failure.
- **`--max 15`** clears a full twelve-epoch backlog in a single tick. Run 2's
  default of 5 could not, and inherited a backlog it never caught up with.
- **`--stale-after 420`** is `grace + one epoch`, which is the documented rule.
  The mainnet default of 14400 would hide a dead crank for the entire run.
- **`--sample-stale 600`** is a *different flag* from `--stale-after` — it is the
  sampler's own staleness. Its 7200s default is sized for hourly sampling and
  would never fire in an hour, leaving **F9 untestable**.

## What this profile reaches that `two_hour` does not

**B12 — the lockout expiring.** `LOCKOUT_EPOCHS` is 7, so a wallet that sells in
epoch 1 must be earning again by epoch 9. At 5-minute epochs that is 45 minutes
and fits; at 30-minute epochs it is 3.5 hours and does not. **D3** (dust
accumulating across several epochs) and **D9** (a stopped crank catching up)
have the same shape.

Run 3 proved the lockout **fires**. Nothing has yet proved it **lifts**, and
this is the profile that can.

## Install

Identical to the two-hour profile's instructions, substituting this directory.
See [`../two_hour/README.md`](../two_hour/README.md) for the full sequence,
including the initialize-timing rule — that part is clock-independent and worth
reading before either run.
