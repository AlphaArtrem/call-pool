# devnet — the two-hour profile (10-minute epochs)

**The profile that can prove B12.** Twelve epochs in two hours.

## Why nine

`LOCKOUT_EPOCHS` is 7. A wallet that sells in epoch 0 is locked across epochs
1–7 and earns again at **epoch 8** — and epoch 8 has to close and settle before
anyone can see it. That is nine epochs, 0 through 8.

**Eight epochs is one short and proves nothing new** — an 80-minute run at this
clock reaches epoch 7 and shows only what runs 3 and 4 already showed, that the
lockout *fires*. Nine epochs is the floor. **Twelve — two hours — is the
target**, because three spare epochs let the run absorb a bad one without losing
B12 along with it.

> A previous `two_hour` profile ran 30-minute epochs and got four epochs out of
> the same two hours. It was retired: same wall-clock cost, and it could reach
> **none** of B12, D3 or D9. If a slow-clock run is ever wanted again, take the
> epoch length from `CALLPOOL_EPOCH_SECONDS` and re-derive every timer from it —
> do not resurrect the old file.

| row | what it needs | reachable here |
|---|---|---|
| **B12** — the lockout expiring | 9 epochs | ✅ with 3 to spare |
| **D3** — dust accumulating until it clears the threshold | several epochs | ✅ |
| **D9** — a crank stopped 2+ epochs, then catching up oldest-first | 3+ epochs to spare | ✅ |

The `one_hour` profile reaches them too, at 5-minute epochs, but leaves very
little room inside an epoch to drive the matrix — the driver spreads 23 steps
across the window, and at 300s several land within seconds of each other. **10
minutes is the compromise that gives both**: enough epochs for the lockout, and
enough room inside each one to drive the matrix honestly.

## The clock

| | |
|---|---|
| `epoch_seconds` | **600** — permanent, written by `initialize` |
| `challenge_seconds` | **120** |
| crank | `*:0/10:20` — once per epoch, 20s past the boundary |
| `--await-root` | **200**, comfortably past the 120s challenge window |
| sampler | every 2 minutes — 5 per epoch |
| watchdog | `--grace 180 --stale-after 780 --sample-stale 600` |
| airdrop | every 5 minutes at `:40`, never racing the crank at `:20` |

## Driving B12 deliberately

It does not happen by itself. The sale has to be in **epoch 0** or the
arithmetic runs off the end of the run:

1. Drive the B-group in epoch 0 (`scenario-driver --epoch 0`) so B3/B4/B5/B7
   all end below the floor.
2. Epochs 1–7: confirm each reads `locked=true, eligible=false`. Give them a
   callout every epoch — **a locked wallet that does not call out proves
   nothing**, because absence from the tree would be explained by the missing
   callout rather than the lockout.
3. **Epoch 8: they must read `locked=false` and be paid again.** That is B12,
   and it is the row this profile exists for.

## Install

See [`../one_hour/README.md`](../one_hour/README.md) for the install commands —
they are identical but for the directory. The full deploy sequence, including
the initialize-timing rule, is in [the gate document](../../../docs/FINAL-DEVNET-TEST.md).
