// The throwaway `INITIALIZER` key, for devnet and local validators only.
//
// `INITIALIZER` is a **compile-time constant** in the program, so the only way
// to test or rehearse `initialize` is to hold the matching secret — which is
// why this secret is committed here and in
// `programs/callpool/tests/common/mod.rs`. It is a worthless key and it is
// public: anyone reading this repository has it.
//
// ⚠️ It must be replaced before any deployment build. `scripts/verify.sh`
// warns until `EXPECTED_INITIALIZER` is set. A mainnet binary carrying this
// constant can be initialized by a stranger, once, with whatever parameters
// they like — and every one of them is immutable afterwards.
//
// It lives here rather than in `scripts/lib/` deliberately: nothing the crank,
// the verifier or the website runs should be able to reach a private key, and
// `scripts/tools/` is where the devnet-only tooling lives.

import { Keypair } from '@solana/web3.js';

/** Public key `2Gwbg…QWtf`, the placeholder INITIALIZER baked into the binary. */
const INITIALIZER_SECRET = Uint8Array.from([
  105, 226, 63, 116, 234, 125, 73, 176, 142, 175, 21, 4, 37, 144, 68, 157, 19, 254, 112, 218, 200,
  131, 244, 246, 45, 30, 170, 84, 102, 21, 191, 203, 18, 241, 34, 32, 212, 91, 58, 68, 178, 182, 84,
  60, 199, 200, 246, 191, 222, 107, 123, 158, 185, 188, 33, 12, 117, 253, 203, 167, 26, 112, 34, 0,
]);

/** The keypair the program's `INITIALIZER` constant names. Devnet only. */
export function throwawayInitializer() {
  return Keypair.fromSecretKey(INITIALIZER_SECRET);
}
