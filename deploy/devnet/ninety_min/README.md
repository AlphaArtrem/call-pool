# devnet — the ninety-minute profile (10-minute epochs)

**The profile that can prove B12.** Nine epochs, and nine is not a round number
by accident.

## Why nine

`LOCKOUT_EPOCHS` is 7. A wallet that sells in epoch 0 is locked across epochs
1–7 and earns again at **epoch 8** — and epoch 8 has to close and settle before
anyone can see it. That is nine epochs, 0 through 8.

**Eight epochs is one short and proves nothing new.** An 80-minute run at this
clock reaches epoch 7 and shows only what runs 3 and 4 already showed: that the
lockout *fires*. Ninety minutes is the floor; **100 minutes (ten epochs) is the
sensible target**, because it lets the run absorb one bad epoch without losing
B12 along with it.

| row | what it needs | reachable here |
|---|---|---|
| **B12** — the lockout expiring | 9 epochs | ✅ 90 min |
| **D3** — dust accumulating until it clears the threshold | several epochs | ✅ |
| **D9** — a crank stopped 2+ epochs, then catching up oldest-first | 3+ epochs to spare | ✅ |

The `two_hour` profile reaches none of these: four 30-minute epochs is 3.5 hours
short of the lockout. The `one_hour` profile reaches them at 5-minute epochs,
but leaves very little room inside an epoch to drive the matrix — 10 minutes is
the compromise that gives both.

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

Same sequence as [`../two_hour/README.md`](../two_hour/README.md), substituting
this directory — including the initialize-timing rule, which is clock-
independent and worth re-reading before every run.
