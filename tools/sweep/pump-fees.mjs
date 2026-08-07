// pump.fun's fee instructions, as plain data.
//
// This module exists to keep `@pump-fun/pump-sdk` — and with it
// `@coral-xyz/anchor`, `@pump-fun/pump-swap-sdk`, `@pump-fun/agent-payments-sdk`
// and `bn.js` — **out of the repository root's `package-lock.json`**.
//
// That lockfile is committed for the same reason `Cargo.lock` is: `post-root.mjs`
// and `cosign.mjs` hold the snapshot key in memory and sign with it, so their
// dependency versions have to be as fixed as the deployed binary's. Naming the
// SDK there would put four more packages into the signing path's surface, on
// every host that runs `npm ci` — including box B, whose only job is to be the
// *second* signer and which has no business owning pump's dependency tree.
//
// Running the sweep in its own process was not enough on its own. The process
// boundary is about what is resident at runtime; this is about what `npm ci`
// installs, which is a different question with a different answer.
//
// ── the contract ───────────────────────────────────────────────────────────
//
// **Nothing this module returns was constructed by the SDK.** Every value that
// crosses back is a base58 string, a decimal string, a boolean, or base64
// bytes. The caller rebuilds instructions from those primitives with its own
// `@solana/web3.js`.
//
// That is not ceremony. This package resolves its own nested copy of web3.js
// (whatever the SDK pins), and the caller resolves the repository's pinned copy
// — two different module instances, so `instanceof` fails between them and any
// object handed across would be interoperating by luck. Passing primitives
// makes the boundary explicit and gives a property worth stating: **no object
// built by pump's SDK is ever signed.** It is rebuilt from bytes first, by code
// in the audited tree.
//
// ⚠️ `require()`, not `import`. The SDK's transitive
// `@pump-fun/agent-payments-sdk` emits invalid ESM (`export{W: BONDING_CURVE_SEED,…}`)
// and throws a SyntaxError under `import` on Node 22 (F19). CJS interop works
// and exposes the whole fee surface.

import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/** The SDK, or a sentence rather than a MODULE_NOT_FOUND stack. */
function sdk() {
  try {
    return require_('@pump-fun/pump-sdk');
  } catch (error) {
    throw new Error(
      '@pump-fun/pump-sdk is not installed in tools/sweep. It is deliberately NOT a ' +
        'dependency of the repository root — run `npm ci` in tools/sweep on this host.\n' +
        `  (${error.message})`,
    );
  }
}

/** web3.js as *this* package resolves it. Never handed to the caller. */
function web3() {
  return require_('@solana/web3.js');
}

/**
 * The SDK's online client, against its own Connection.
 *
 * Note the parentheses. `new sdk().OnlinePumpSdk(conn)` parses as
 * `(new sdk()).OnlinePumpSdk(conn)` — it constructs the *module namespace* and
 * then calls the class as a function, which fails with "Class constructor
 * OnlinePumpSdk cannot be invoked without 'new'". Caught by a live run, not by
 * a unit test, because nothing offline exercises this line.
 *
 * The Connection is built here, from this package's own web3, and never leaves.
 * Handing the caller's Connection to the SDK would put an object from the
 * repository's web3 copy into code running against this one.
 */
const online = (rpcUrl) => {
  const { Connection } = web3();
  const { OnlinePumpSdk } = sdk();
  return new OnlinePumpSdk(new Connection(rpcUrl, 'confirmed'));
};

/**
 * Strip a web3 instruction down to primitives.
 *
 * Base64 rather than a Buffer because a Buffer from this package's Node is the
 * same class either side — but the point is a boundary that is obviously
 * data, and one that would survive being written to a pipe if this ever becomes
 * a subprocess rather than a dynamic import.
 */
const plain = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: Boolean(k.isSigner),
    isWritable: Boolean(k.isWritable),
  })),
  data: Buffer.from(ix.data).toString('base64'),
});

/**
 * What pump will and will not distribute for this coin, right now.
 *
 * Amounts are decimal **strings**: they are BN inside the SDK and BigInt in the
 * caller, and a Number in between would silently lose precision above 2^53.
 *
 * ⚠️ `canDistribute: false` has two causes that are indistinguishable from
 * here. The accrued fee is genuinely below `minimumRequired`, **or the SDK's
 * own simulation errored and it returned zeroes rather than raising.** The
 * caller must not read either as "there is nothing there" — only the pool's
 * balance before and after settles that.
 *
 * @param {string} rpcUrl
 * @param {string} mint  base58
 */
export async function readDistributable(rpcUrl, mint) {
  const { PublicKey } = web3();
  const result = await online(rpcUrl).getMinimumDistributableFee(new PublicKey(mint));
  return {
    minimumRequired: result.minimumRequired.toString(),
    distributableFees: result.distributableFees.toString(),
    canDistribute: Boolean(result.canDistribute),
    isGraduated: Boolean(result.isGraduated),
  };
}

/**
 * The instructions that move this coin's creator fees to its shareholders.
 *
 * Permissionless — `distribute_creator_fees` carries no signer at all, proven
 * on devnet 2026-08-07 with a wallet that was neither the creator nor a
 * shareholder (G2). Whoever sends these pays gas and holds no authority.
 *
 * On a graduated coin the SDK prefixes `transferCreatorFeesToPump`, which pulls
 * the AMM's wrapped-SOL fees into pump's creator vault first. That is why this
 * returns a list rather than one instruction, and why the order matters.
 *
 * @returns {Promise<{instructions: Array, isGraduated: boolean}>} primitives only
 */
export async function buildDistributeInstructions(rpcUrl, mint) {
  const { PublicKey } = web3();
  const built = await online(rpcUrl).buildDistributeCreatorFeesInstructions(new PublicKey(mint));
  return {
    instructions: built.instructions.map(plain),
    isGraduated: Boolean(built.isGraduated),
  };
}

// ── creating and trading a devnet coin ─────────────────────────────────────
//
// Everything below exists for **the rehearsal only**, and every consumer is
// guarded by `assertNotMainnet` on the far side of the boundary. It is here
// rather than in `scripts/` for the same reason the fee half is: the SDK must
// stay out of the root lockfile that pins the scripts holding the snapshot key.
//
// The rehearsal needs a real pump.fun coin because three things have never run
// live and none of them can run without one — step 0's real
// `distribute_creator_fees`, `sweep_wsol`, and L18's LP discrimination. A
// synthetic `createMint` re-proves the parts that already work.
//
// The same contract as above holds: **primitives out, nothing signed here.**

const bn = (value) => {
  const BN = require_('bn.js');
  return new BN(String(value));
};

/**
 * Which token program owns this mint. **Not always SPL Token.**
 *
 * pump's `create` produces SPL Token mints and `create_v2` produces Token-2022
 * ones, and the two derive *different* associated token addresses. The SDK's
 * fetch helpers default to SPL Token, so on a `create_v2` coin a sell fails with
 * "Associated token account not found" for a wallet that is visibly holding the
 * token — measured 2026-08-07, on a wallet with 101,885,000,753,712 raw units.
 *
 * Buys hid it: `fetchBuyState` tolerates a missing ATA because a first-time
 * buyer legitimately has none, so the wrong program looked like a new account
 * and the instruction created the right one anyway. Only the sell path, which
 * must find an existing balance, actually breaks — which is the path the lockout
 * test depends on.
 *
 * `scripts/lib/chain.mjs` has always detected this for the crank. This is the
 * same question asked on the SDK side of the boundary.
 */
async function tokenProgramFor(connection, mint) {
  const { PublicKey } = web3();
  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint account not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022)) return TOKEN_2022;
  if (info.owner.equals(TOKEN)) return TOKEN;
  throw new Error(`${mint.toBase58()} is not owned by a token program (${info.owner.toBase58()})`);
}

/**
 * Create the coin with its fee split already locked, in one transaction.
 *
 * F6, proven on devnet: `create` + `createFeeSharingConfig` + `updateFeeShares`
 * fit in a single transaction. Bundling them is not a nicety — it closes F5's
 * window, where any fee accruing before the config exists is **not
 * distributable through it** and can only be moved by the creator's own
 * `collect_creator_fee`. On a 5-minute epoch that window is most of an epoch.
 *
 * Two things bite here and both cost a run to find:
 *
 *   * **`currentShareholders` is `[creator]`, never `[]`.**
 *     `createFeeSharingConfig` seeds the config with the creator as sole
 *     shareholder, and `updateFeeShares` requires the current list to match
 *     exactly. Passing an empty array fails `NotEnoughRemainingAccounts` (6013)
 *     — and it fails at *send* time, after the mint keypair is already spent.
 *   * **The dev-buy cannot be in this bundle, and cannot be built with it
 *     either.** With it the transaction is 1485 bytes against a 1232-byte
 *     limit — but the deeper reason is that `createFeeSharingConfig` MOVES the
 *     creator vault. A buy built from pre-create state names the old vault and
 *     fails simulation with `ConstraintSeeds` (2006) on `creator_vault`, an
 *     error that mentions neither fee sharing nor ordering. So the dev buy is
 *     not returned here at all: call `buildBuyInstructions` after the create
 *     transaction has confirmed.
 *
 * ⚠️ `updateFeeShares` sets `admin_revoked` (F7). **There is no second
 * attempt**, on devnet or anywhere. The shares passed here are final.
 *
 * @param {string} rpcUrl
 * @param {object} args
 * @param {string} args.mint      base58 of the new mint (its keypair signs)
 * @param {string} args.creator   base58 — also the payer and the authority
 * @param {string} args.name
 * @param {string} args.symbol
 * @param {string} args.uri
 * @param {Array<{address: string, shareBps: number}>} args.shareholders
 * @returns {Promise<{create: Array}>} primitives only. No dev buy — see above.
 */
export async function buildCreateCoinInstructions(rpcUrl, args) {
  const { PublicKey } = web3();
  const { PumpSdk } = sdk();
  const offline = new PumpSdk();
  const client = online(rpcUrl);

  const mint = new PublicKey(args.mint);
  const creator = new PublicKey(args.creator);
  const global = await client.fetchGlobal();

  const totalBps = args.shareholders.reduce((sum, s) => sum + s.shareBps, 0);
  if (totalBps !== 10_000) {
    throw new Error(
      `shares must total 10000 bps, got ${totalBps}. pump rejects anything else, and ` +
        'updateFeeShares is one-shot (F7) — there is no second attempt at this.',
    );
  }

  // `createV2AndBuyV2Instructions` returns create + buy together. Only the
  // create half is kept; the buy half is discarded rather than returned,
  // because it is built against pre-config state and would name the wrong
  // creator vault. See the note above.
  const createAndBuy = await offline.createV2AndBuyV2Instructions({
    global,
    mint,
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    creator,
    user: creator,
    amount: bn(0),
    quoteAmount: bn(0),
    mayhemMode: false,
  });

  const [createIx] = createAndBuy;

  const configIx = await offline.createFeeSharingConfig({ creator, mint, pool: null });
  const sharesIx = await offline.updateFeeShares({
    authority: creator,
    mint,
    // Seeded as [creator] by createFeeSharingConfig — see above. This is the
    // single line that fails with 6013 if it is written the obvious way.
    currentShareholders: [creator],
    newShareholders: args.shareholders.map((s) => ({
      address: new PublicKey(s.address),
      shareBps: s.shareBps,
    })),
  });

  return {
    create: [createIx, configIx, sharesIx].map(plain),

  };
}

/**
 * Buy the coin on its bonding curve. What actually generates creator fees.
 *
 * A rehearsal where nothing is bought proves the empty-epoch path and little
 * else: the pool only grows if real fees accrue, and fees only accrue on trades.
 *
 * @param {string|number|bigint} quoteLamports  SOL to spend
 */
export async function buildBuyInstructions(rpcUrl, mint, user, quoteLamports, slippageBps = 500) {
  const { PublicKey } = web3();
  const { PumpSdk, getBuyTokenAmountFromSolAmount } = sdk();
  const offline = new PumpSdk();
  const client = online(rpcUrl);

  const mintKey = new PublicKey(mint);
  const userKey = new PublicKey(user);
  const conn = new (web3().Connection)(rpcUrl, 'confirmed');
  const tokenProgram = await tokenProgramFor(conn, mintKey);
  const global = await client.fetchGlobal();
  const feeConfig = await client.fetchFeeConfig();
  const state = await client.fetchBuyState(mintKey, userKey, tokenProgram);
  const quoteAmount = bn(quoteLamports);

  // How many tokens that SOL buys at the curve's current point. Passed as the
  // `amount` so slippage is measured against a real expectation rather than 0.
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount: quoteAmount,
  });

  const instructions = await offline.buyV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint: mintKey,
    user: userKey,
    amount,
    quoteAmount,
    slippage: slippageBps / 100,
    tokenProgram,
  });
  return { instructions: instructions.map(plain), tokenAmount: amount.toString() };
}

/**
 * Sell tokens back into the bonding curve.
 *
 * Two uses, and the second is why this is not optional. It is how a rehearsal
 * wallet **triggers the lockout** deliberately — L18's test needs a wallet that
 * sells in the same epoch as one that supplies liquidity, because selling and
 * depositing send the coin to the same account and the whole ruling turns on
 * telling them apart. And it is how the devnet SOL comes back afterwards: F18
 * recovered ~3.2 SOL selling the gate-test coins back, which matters because
 * the faucets are dry.
 *
 * @param {string|number|bigint} tokenAmount  raw units
 */
export async function buildSellInstructions(rpcUrl, mint, user, tokenAmount, slippageBps = 500) {
  const { PublicKey } = web3();
  const { PumpSdk, getSellSolAmountFromTokenAmount } = sdk();
  const offline = new PumpSdk();
  const client = online(rpcUrl);

  const mintKey = new PublicKey(mint);
  const userKey = new PublicKey(user);
  const conn = new (web3().Connection)(rpcUrl, 'confirmed');
  const tokenProgram = await tokenProgramFor(conn, mintKey);
  const global = await client.fetchGlobal();
  const feeConfig = await client.fetchFeeConfig();
  const state = await client.fetchSellState(mintKey, userKey, tokenProgram);
  const amount = bn(tokenAmount);

  const quoteAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount,
  });

  const instructions = await offline.sellV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    mint: mintKey,
    user: userKey,
    amount,
    quoteAmount,
    slippage: slippageBps / 100,
    tokenProgram,
  });
  return { instructions: instructions.map(plain), solAmount: quoteAmount.toString() };
}

/** Has the coin graduated to the AMM? Decides whether L18 can be tested at all. */
export async function readCurveState(rpcUrl, mint) {
  const { PublicKey } = web3();
  const { PumpSdk } = sdk();
  const client = online(rpcUrl);
  const mintKey = new PublicKey(mint);
  const info = await client.fetchBuyState(mintKey, new PublicKey(mint)).catch(() => null);
  if (!info) return { exists: false, complete: false };
  return {
    exists: true,
    complete: Boolean(info.bondingCurve.complete),
    realSolReserves: info.bondingCurve.realSolReserves?.toString() ?? '0',
    tokenTotalSupply: info.bondingCurve.tokenTotalSupply?.toString() ?? '0',
  };
}

// Exported for `tests/pump-fees.test.mjs`. The serialisation IS the contract,
// so it is tested directly rather than inferred from a live RPC round trip.
export const plainForTest = plain;
export const amountForTest = (bn) => bn.toString();

/** Is the SDK actually installed here? Lets the caller say so before failing. */
export function available() {
  try {
    sdk();
    return true;
  } catch {
    return false;
  }
}

// ── after graduation: the AMM ──────────────────────────────────────────────
//
// Everything above this line talks to the bonding curve. Once a coin graduates
// the curve is closed — `sellV2` fails with `BondingCurveComplete` (6005) — and
// trading moves to PumpSwap. Two of CALLPOOL's never-verified behaviours only
// exist on this side:
//
//   * `sweep_wsol`. Post-graduation creator fees arrive as **wrapped SOL** in an
//     ATA owned by the pool, and wSOL cannot be unwrapped in place. Nothing
//     accrues there until the AMM has taken fees.
//   * **L18.** The LP mint does not exist before graduation, so an LP deposit
//     cannot be made and `isLpDeposit` cannot be exercised against a real one.
//
// `@pump-fun/pump-swap-sdk` is already a transitive dependency of the fee SDK,
// so this adds no package. The same boundary applies: primitives out, and
// nothing the SDK built is ever signed.

/** The AMM SDK pair, against this package's own Connection. */
const amm = (rpcUrl) => {
  const { Connection } = web3();
  const swap = require_('@pump-fun/pump-swap-sdk');
  const connection = new Connection(rpcUrl, 'confirmed');
  return {
    swap,
    online: new swap.OnlinePumpAmmSdk(connection),
    offline: new swap.PumpAmmSdk(),
    connection,
  };
};

/** The coin's canonical AMM pool, and whether it exists yet. */
export async function readAmmPool(rpcUrl, mint) {
  const { PublicKey } = web3();
  const { swap, connection } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const info = await connection.getAccountInfo(pool);
  return {
    pool: pool.toBase58(),
    lpMint: swap.lpMintPda(pool).toBase58(),
    exists: info != null,
  };
}

/**
 * Buy on the AMM. What generates creator fees after graduation.
 *
 * `buyQuoteInput` takes the SOL to spend, which is the same shape as the
 * bonding-curve buy above, so callers do not have to think about which side of
 * graduation they are on beyond choosing the function.
 */
export async function buildAmmBuyInstructions(rpcUrl, mint, user, quoteLamports, slippageBps = 500) {
  const { PublicKey } = web3();
  const { swap, online, offline } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const state = await online.swapSolanaState(pool, new PublicKey(user));
  const instructions = await offline.buyQuoteInput(state, bn(quoteLamports), slippageBps / 100);
  return { instructions: instructions.map(plain), pool: pool.toBase58() };
}

/**
 * Sell on the AMM. How a wallet triggers the lockout after graduation.
 *
 * This is the half that matters for L18's test: a sale and an LP deposit send
 * the coin to the *same* pool, so the pair has to be produced from the same
 * place to show that the discriminator tells them apart.
 */
export async function buildAmmSellInstructions(rpcUrl, mint, user, baseAmount, slippageBps = 500) {
  const { PublicKey } = web3();
  const { swap, online, offline } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const state = await online.swapSolanaState(pool, new PublicKey(user));
  const instructions = await offline.sellBaseInput(state, bn(baseAmount), slippageBps / 100);
  return { instructions: instructions.map(plain), pool: pool.toBase58() };
}

/**
 * Deposit into the coin's canonical pool — **the L18 case.**
 *
 * The wallet's token balance goes to zero exactly as a sale would, and the coin
 * goes to the same account. What separates them is that this mints the pool's LP
 * tokens back to the depositor, which is what `isLpDeposit` looks for.
 *
 * `depositBaseInput` computes the matching quote side and the LP amount from the
 * base amount, so the caller supplies only what it is putting in. The deposit
 * needs SOL as well as tokens — it is a two-sided pool — and the returned
 * `quote` says how much.
 */
export async function buildLpDepositInstructions(rpcUrl, mint, user, baseAmount, slippageBps = 500) {
  const { PublicKey } = web3();
  const { swap, online, offline } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const state = await online.liquiditySolanaState(pool, new PublicKey(user));
  const quoted = offline.depositBaseInput(state, bn(baseAmount), slippageBps / 100);
  const instructions = await offline.depositInstructions(state, quoted.lpToken, slippageBps / 100);
  return {
    instructions: instructions.map(plain),
    pool: pool.toBase58(),
    lpMint: swap.lpMintPda(pool).toBase58(),
    lpToken: quoted.lpToken.toString(),
    quote: quoted.quote?.toString() ?? quoted.maxQuote?.toString() ?? '0',
  };
}

/**
 * Withdraw a wallet's whole LP position back into tokens and SOL.
 *
 * The other half of `buildLpDepositInstructions`, and the reason it exists is
 * recovery rather than symmetry: devnet faucets are dry (F18), so SOL parked in
 * a rehearsal LP position is SOL that has to be got back deliberately.
 *
 * Takes the LP amount to burn — `readLpBalance` supplies it for "all of it".
 */
export async function buildLpWithdrawInstructions(rpcUrl, mint, user, lpAmount, slippageBps = 500) {
  const { PublicKey } = web3();
  const { swap, online, offline } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const state = await online.liquiditySolanaState(pool, new PublicKey(user));
  const instructions = await offline.withdrawInstructions(state, bn(lpAmount), slippageBps / 100);
  return { instructions: instructions.map(plain), pool: pool.toBase58() };
}

/** How many LP tokens this wallet holds for the coin's canonical pool. */
export async function readLpBalance(rpcUrl, mint, user) {
  const { PublicKey } = web3();
  const { swap, connection } = amm(rpcUrl);
  const pool = swap.canonicalPumpPoolPda(new PublicKey(mint));
  const lpMint = swap.lpMintPda(pool);
  const ata = swap.lpMintAta(lpMint, new PublicKey(user));
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  return { lpMint: lpMint.toBase58(), ata: ata.toBase58(), amount: info?.value?.amount ?? '0' };
}
