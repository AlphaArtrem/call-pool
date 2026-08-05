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
  // **Mainnet, always, on anything published.** The cluster switch was taken
  // out of the top bar on 2026-08-05: a devnet page shows real chain reads of
  // activity we generated ourselves, which is the most convincing wrong
  // impression this site can give. `?cluster=devnet` still works and is now an
  // internal tool for pointing the page at a rehearsal deployment.
  cluster: 'mainnet',

  // The two icon links in the top bar. Cluster-independent: an account and a
  // repository do not move between devnet and mainnet.
  //
  // Omit either one and it renders as a disabled chip saying it is not
  // published yet, which is the §7.4 rule applied to a link: a URL typed into
  // the markup ahead of time is a URL nobody checked, and a dead link in the
  // header of a page whose whole claim is "check everything" costs more than
  // an empty slot.
  links: {
    x: 'https://x.com/AlphaArtrem/status/2084662737830056073',
    github: 'https://github.com/AlphaArtrem/call-pool',
  },

  mainnet: {
    // Same-origin, and that is the whole point.
    //
    // A provider endpoint is mandatory — `api.mainnet-beta.solana.com` answers
    // a browser with `403 Access forbidden`, measured 2026-08-05, and that is
    // not a rate limit — and a provider endpoint carries a key in its URL.
    // This file is fetched by every visitor, so a keyed URL here is a published
    // key.
    //
    // So the page calls `/rpc` on its own origin, `scripts/serve-site.mjs`
    // forwards it, and the key lives in `CALLPOOL_RPC_URL` on the server. That
    // proxy is a narrow allowlist of the six read-only methods this site uses
    // rather than a forwarder — see scripts/lib/rpc-proxy.mjs, because an open
    // forwarder is exactly as abusable as a leaked key.
    //
    // A full provider URL still works here if you would rather point straight
    // at one. Only do that with a key restricted to your domain.
    rpc: '/rpc',

    // The deployed program. **Leave empty until `initialize` has landed.**
    //
    // Empty is what makes the pre-launch page say "the coin has not launched
    // yet" — and it says it without calling an RPC at all, which is the
    // property that matters while there is no working endpoint above. Setting
    // it early would instead make the page try to read a program that is not
    // there and report whatever the RPC said, which pre-launch is noise.
    //
    // At launch: paste `declare_id!` from programs/callpool here. Nothing else
    // on this page has to change for the live numbers to appear.
    programId: '',

    // The coin. Read from the program's own Config account, so this is only a
    // cross-check: if the two disagree the page stops rather than render
    // another coin's history. Safe to leave empty.
    mint: '',

    // Where the published epoch directories live — the audit trail linked from
    // the record section. A path on this host, or an absolute URL. Trailing
    // slash optional. Each epoch is <snapshotsBase>/epoch-<n>/.
    snapshotsBase: '/snapshots',

    // pump.fun's public client key, for the in-browser by-wallet callout
    // lookup (§7.8). Not a secret — it ships in pump.fun's own bundle — but it
    // is theirs and it rotates. Extract it by loading pump.fun/callouts and
    // grepping the same-origin scripts for "coin-communities". Without it the
    // callout row reads "cannot check" instead of guessing, and every
    // chain-sourced number still works.
    calloutApiKey: '',

    // The transaction that set the 90/10 fee split, for §7.7. Until it is
    // pasted here, that section shows the split as unverified rather than
    // asserting a number it cannot source.
    feeShareTx: '',

    // pump.fun's creator vault for this coin. Fees accrue here between epoch
    // runs, and §7.3 requires it be shown NEXT TO the pool, not folded in.
    // Only knowable once the coin exists.
    creatorVault: '',
  },

  // ── internal only ────────────────────────────────────────────────────────
  // Reached with ?cluster=devnet and never linked from the page. This is how a
  // rehearsal deployment is looked at; `scripts/tools/deploy-devnet.mjs` prints
  // the block to paste here. Nothing published should ever resolve to it.
  devnet: {
    // Its own route and its own key — see CALLPOOL_RPC_URL_DEVNET.
    rpc: '/rpc/devnet',
    mint: '',
    programId: 'ANMpzZvKMeGYBSCKsfg6u7eT1axDJuDSgbazDaXJ3WA7',
    snapshotsBase: '/epochs/devnet/snapshots',
    calloutApiKey: '',
    feeShareTx: '',
    creatorVault: '',
  },
};
