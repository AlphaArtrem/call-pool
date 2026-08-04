#!/usr/bin/env bash
#
# scripts/verify.sh — everything that must be true before the program is worth
# deploying, in one command.
#
# Phase 06 §6.4. The checks that are not just "the tests pass" are the point:
# an instruction appearing silently, a token authority creeping in, or the
# INITIALIZER constant still holding the throwaway test key are all permanent
# once the program is deployed, and all three are cheap to catch here.
#
#   ./scripts/verify.sh                       # build + all tests + structure
#   EXPECTED_INITIALIZER=<pubkey> ./scripts/verify.sh   # also pin the constant
#
# Set EXPECTED_INITIALIZER before a deployment build. Without it the script
# says so loudly and keeps going, because during development the placeholder is
# correct and blocking on it would just teach everyone to skip the script.

set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.solana/solana-release/bin:$PATH"

PROGRAM_SRC="programs/callpool/src"
IDL="target/idl/callpool.json"
ANCHOR_BIN="${ANCHOR_BIN:-$HOME/.avm/bin/anchor-1.1.2}"

fail() { printf '\n\033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
pass() { printf '\033[32m  ok\033[0m  %s\n' "$1"; }
warn() { printf '\033[33mwarn\033[0m  %s\n' "$1"; }

echo
echo "CALLPOOL — verify"
echo

# ── build ──────────────────────────────────────────────────────────────────
# The litesvm tests load target/deploy/callpool.so, so the SBF build has to
# come first or they test a stale binary.
echo "building the program"
cargo build-sbf --manifest-path programs/callpool/Cargo.toml >/dev/null
pass "cargo build-sbf"

mkdir -p target/idl
"$ANCHOR_BIN" idl build -o "$IDL" >/dev/null 2>&1 || fail "anchor idl build"
pass "IDL generated"

# ── tests ──────────────────────────────────────────────────────────────────
echo
echo "running tests"
cargo test --quiet 2>&1 | grep -E "test result|FAILED" || true
cargo test --quiet >/dev/null || fail "cargo test"
pass "rust: unit, merkle, program and invariant tests"

npm test --silent 2>&1 | grep -E "^. (tests|pass|fail) " || true
npm test --silent >/dev/null 2>&1 || fail "npm test"
pass "js: timeline, merkle, program-client and crank tests"

# ── structure ──────────────────────────────────────────────────────────────
echo
echo "checking the program's shape"

# Exactly six instructions. A seventh appearing silently is precisely what this
# check exists to catch (Phase 04 §4.3).
EXPECTED_IX="claim,close_epoch,create_pool,initialize,post_epoch_root,sweep_wsol"
ACTUAL_IX=$(node -p "require('./$IDL').instructions.map(i=>i.name).sort().join(',')")
[ "$ACTUAL_IX" = "$EXPECTED_IX" ] || fail "instruction set changed:
  expected  $EXPECTED_IX
  actual    $ACTUAL_IX"
pass "exactly six instructions, unchanged"

# The checks below read *code*, not prose. Comments in this program discuss the
# authorities it deliberately does not take, so a naive grep matches its own
# documentation.
code() { grep -rn --include=*.rs "" "$PROGRAM_SRC" | grep -vE ":[[:space:]]*//"; }

# No token authority anywhere. The program reads token accounts and closes its
# own wSOL ATA; it must never mint, burn, transfer, approve or reassign.
FORBIDDEN="mint_to|::burn|set_authority|::approve|freeze_account|thaw_account|transfer_checked|token_interface::transfer"
if code | grep -E "$FORBIDDEN" >/dev/null; then
  code | grep -E "$FORBIDDEN"
  fail "the program appears to take a token authority"
fi
pass "no token authority: no mint, burn, transfer, approve or set_authority"

# No admin path (standing rule 3). Read from the IDL rather than the source:
# the instruction set is what an admin path would have to appear in, and the
# source has plenty of legitimate helpers whose names start with `set_`.
if node -p "require('./$IDL').instructions.map(i=>i.name).join(',')" |
   grep -qE "set_|update_|pause|withdraw|upgrade|migrate|rescue"; then
  node -p "require('./$IDL').instructions.map(i=>i.name).join(', ')"
  fail "an admin-shaped instruction has appeared"
fi
pass "no admin path: no set_*, pause, withdraw or upgrade instruction"

# No CPI into pump.fun. The program deliberately touches it nowhere.
if code | grep -iE "pump" >/dev/null; then
  code | grep -iE "pump"
  fail "the program references pump.fun in code — it must CPI there nowhere"
fi
pass "no reference to pump.fun in code"

# The merkle vectors pin the Rust verifier and the JS builder together (D6).
# Regenerating them without meaning to would silently un-pin the two.
if ! git diff --quiet -- programs/callpool/tests/vectors.json 2>/dev/null; then
  fail "programs/callpool/tests/vectors.json has uncommitted changes — the leaf
  format must not change after the first epoch"
fi
pass "merkle vectors unchanged"

# ── the immutable constants ────────────────────────────────────────────────
echo
echo "checking the constants that cannot be changed after deployment"

INITIALIZER=$(grep -oE 'pubkey!\("[^"]+"\)' "$PROGRAM_SRC/lib.rs" | head -1 | sed 's/pubkey!("//;s/")//')
if [ -n "${EXPECTED_INITIALIZER:-}" ]; then
  [ "$INITIALIZER" = "$EXPECTED_INITIALIZER" ] || fail "INITIALIZER is $INITIALIZER, expected $EXPECTED_INITIALIZER"
  pass "INITIALIZER == $INITIALIZER"
else
  warn "EXPECTED_INITIALIZER not set — INITIALIZER is currently $INITIALIZER"
  warn "  This is a throwaway test key. It MUST be replaced before a deployment build."
fi

node --input-type=module -e "
import { MIN_HOLD_RAW, MIN_HOLD_TOKENS, MINT_DECIMALS } from './scripts/lib/config.mjs';
const expected = MIN_HOLD_TOKENS * 10n ** BigInt(MINT_DECIMALS);
if (MIN_HOLD_RAW !== expected) {
  console.error('MIN_HOLD_RAW does not match MIN_HOLD_TOKENS x 10^decimals');
  process.exit(1);
}
console.log('  ok  floor: ' + MIN_HOLD_TOKENS.toLocaleString('en-US') + ' tokens = ' + MIN_HOLD_RAW + ' raw units at ' + MINT_DECIMALS + ' decimals');
" || fail "the floor is inconsistent between whole tokens and raw units"

echo
warn "The floor still carries L12's open discrepancy: 0.01% is \$1,000 at a \$10M"
warn "  cap, and the instruction that set it also said \$500 (which is 0.005%)."
warn "  Settle it before initialize — Phase 08 has the stop-line."

echo
printf '\033[32mverify passed\033[0m\n\n'
