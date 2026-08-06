# The audit trail

**Empty until launch.** One directory appears here per settled day —
`epoch-0/`, `epoch-1/`, and so on — starting with the first full UTC day after
the coin launches.

Each `epoch-N/` holds everything an epoch was computed from, published *before*
its merkle root is posted on chain, so the challenge window has something to
challenge. Nothing here is a summary: `callouts.json` is the raw feed response,
because the public feed only ever returns the newest 50 records and this is the
only surviving copy.

Any of it can be reproduced by a stranger with no keys, reading only the files
in the directory and the code published beside them:

```bash
node snapshots/epoch-7/build.mjs            # rebuild the tree and the root
node scripts/verify-epoch.mjs --epoch 7 --recheck-chain
```

If a directory and the chain ever disagree, **the chain is right** and the
directory is evidence of what we claimed. That is the whole point of publishing
the inputs rather than the answers.
