#!/usr/bin/env bash
# Day-0 manual honor — RUN BY THE OWNER. Requires the ops keypair.
# Usage: bash pay-day0.sh <OPS_KEYPAIR_PATH> <RPC_URL>
set -euo pipefail
OPS="$1"; RPC="$2"
S=~/.solana/solana-release/bin/solana
send() {
  echo "→ $1  $2 SOL"
  "$S" transfer "$1" "$2" --keypair "$OPS" --url "$RPC" --allow-unfunded-recipient --commitment confirmed | tail -1
}
send 3tZjjqhpobQdLjv2LFCE5GsFaAc68CTrJAseT3HDcTu8 0.004684961
send 4BnSjhDsYp7v1f5jS4MagpuUX9m7ZCgyJVdjtB8rZ566 0.053675655
send 59ranMtENQe3EcvyrqmsH5nXnNRHrw9bFMXmWrdEhoJy 0.012783611
send 6YmUEwLGo2RtkumfC71JMNJWANb9NRnd6FcAZihoEFX1 0.217727885
send 6ZXuayKTFWJtvsEnZEK1xzhW5AfVKL7hrqoP1u5j9Ntp 0.019831611
send 7nB56jAXaU6qdQcDCH4MvPbztoemeZvAGpworbEHnPKW 0.007707094
send CQWhotHc9uuYw2yEiQUdXNp7MJpXcQsmdw47tBkiJHP 0.126380062
send Ce1sJF4jw83sAwqpmZJRLXPSnEfdSWQSi6xNiJxxUtnh 0.004076494
send EgDfgw7GVMaPRGLnTuNkNyrUDsPGjfjPrXvE7KpN6Avk 0.002733292
send FNbdWS1t6GcYBbbgKsp3xj5F3WhUbSPbh7qoYhVYGDZP 0.163319663
send HvwYgXU8gUM3oQkV5TsiXgekpsb549TZgTjTJaRCCjm7 0.003306304
send M9tnpvN3ZepP9NwpbG5QPGhBETtkY5Ld14efLNY5JnS 0.232404946
send WzkifGBqEXbb53M4pLg9cnfEdPtBqtS5ZeJ1Pk2gxtX 0.005616749
echo "day-0 honor complete: 13 wallet(s)"