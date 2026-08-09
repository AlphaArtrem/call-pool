#!/bin/sh
# Keep real creator fees accruing for the rehearsal.
#
# Two things this must not do, both learned the expensive way:
#
# 1. **No secrets in argv.** The previous version invoked
#    `sudo -u callpool env SOLANA_RPC_URL="$SOLANA_RPC_URL" ...`, and sudo logs
#    its argv — the same leak that burned run 1's credentials (§S2.2), in a
#    wrapper that fix missed because it lives here rather than in /root. The
#    child reads signer.env itself; nothing secret crosses a command line.
#
# 2. **It must not graduate the coin.** A buy-only loop walks the bonding curve
#    to completion — 0.15 SOL every 90s finishes it in about twenty minutes —
#    and run 3 deliberately graduates LAST, after the matrix is banked. So it
#    alternates a buy with a sell sized to match it (~10% of the position at 0.05 SOL a buy): creator fees accrue on
#    both sides, and the curve stays roughly where it is instead of climbing.
as_callpool() {
  sudo -u callpool sh -c 'set -a; . /etc/callpool/signer.env; set +a; cd /srv/callpool; exec "$@"' trade "$@"
}

SIZE="${CALLPOOL_TRADE_SOL:-0.05}"

while true; do
  as_callpool node scripts/tools/pump-trade.mjs --buy "$SIZE" \
    --keypair /etc/callpool/devnet-payer.json 2>&1 | grep -E "^tokens|^sold|^bought" || echo "buy failed"
  sleep 45
  as_callpool node scripts/tools/pump-trade.mjs --sell 10% \
    --keypair /etc/callpool/devnet-payer.json 2>&1 | grep -E "^tokens|^sold|^bought" || echo "sell failed"
  sleep 45
done
