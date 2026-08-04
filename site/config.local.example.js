// Copy to `config.local.js` (gitignored) and fill in.
//
// Nothing here is a secret. The real file is untracked because it holds a
// keyed RPC URL, and a keyed URL in a committed file is a keyed URL in
// everyone's browser cache.
//
// ⚠️ Phase 07 §7.3: NEVER ship a keyed RPC URL in client-side JS at all.
// `config.local.js` is still client-side — it is fetched by the browser like
// any other script. Point `rpc` at a **proxy you control**, or at a key that is
// domain-locked and scoped to read-only methods. The file being gitignored
// protects the repo, not the user.
//
// Anything omitted renders as "not configured" rather than as a number from
// somewhere else. That is the §7.4 rule and it is enforced in js/config.js.
window.CALLPOOL_SITE_CONFIG = {
  // "devnet" | "mainnet". Overridable per-visit with ?cluster=devnet.
  // Default stays devnet until the mainnet deploy (Phase 07 §7.5).
  cluster: 'devnet',

  devnet: {
    // Read-only RPC. Public endpoints rate-limit and WILL fail under launch
    // traffic (Decision 11) — the page degrades to "can't reach chain" rather
    // than showing a stale number, but that is a bad launch day.
    rpc: 'https://api.devnet.solana.com',

    // The coin. Until it exists, leave empty: every number that depends on it
    // renders as pending, and the page says why.
    mint: '',

    // Deployed program id. Must match `declare_id!` in programs/callpool.
    programId: 'ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7',

    // Where the published epoch directories live — the audit trail linked from
    // section 4. A path on this host, or an absolute URL. Trailing slash
    // optional. Each epoch is <snapshotsBase>/epoch-<n>/.
    snapshotsBase: '/snapshots',

    // pump.fun's public client key, for the in-browser by-wallet callout
    // lookup (§7.8). Not a secret — it ships in pump.fun's own bundle — but it
    // is theirs and it rotates. Extract it by loading pump.fun/callouts and
    // grepping the same-origin scripts for "coin-communities"; see
    // docs/phase-02 §2.9. Without it the callout row reads "cannot check"
    // instead of guessing, and every chain-sourced number still works.
    calloutApiKey: '',

    // The transaction that set the 90/10 fee split, for §7.7. Until it is
    // pasted here, that section shows the split as unverified rather than
    // asserting a number it cannot source.
    feeShareTx: '',

    // pump.fun's creator vault for this coin. Fees accrue here between epoch
    // runs, and §7.3 requires it be shown NEXT TO the pool, not folded in.
    creatorVault: '',
  },

  mainnet: {
    rpc: 'https://api.mainnet-beta.solana.com',
    mint: '',
    programId: 'ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7',
    snapshotsBase: '/snapshots',
    calloutApiKey: '',
    feeShareTx: '',
    creatorVault: '',
  },
};
