// Everything that talks to an RPC. Kept apart from timeline.mjs so the
// arithmetic can be tested without a network and the network code has nothing
// to get subtly wrong about the arithmetic.

import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { TimelineError } from './timeline.mjs';

/**
 * Which token program owns this mint.
 *
 * pump.fun's `create` produces SPL Token mints and `create_v2` produces
 * Token-2022 mints (Phase 06 §6.5 note 4), and the two derive different
 * associated token addresses. Detecting it beats hardcoding either.
 *
 * @returns {Promise<PublicKey>}
 */
export async function tokenProgramForMint(connection, mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new TimelineError(`mint account not found: ${mint}`);

  const owner = info.owner;
  if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) return owner;
  throw new TimelineError(`mint is not owned by a token program: ${mint}`, {
    owner: owner.toBase58(),
  });
}

/**
 * The one token account that counts (L6): the wallet's associated token
 * account for the mint. Tokens sitting in any other account do not count
 * toward `hold`, and the site has to say so.
 */
export function associatedTokenAddress(owner, mint, tokenProgram) {
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    /* allowOwnerOffCurve */ false,
    tokenProgram,
  );
}

/** Current raw balance of a token account, or 0n if it does not exist. */
export async function currentBalanceRaw(connection, account) {
  const info = await connection.getParsedAccountInfo(new PublicKey(account));
  const parsed = info?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'account') return 0n;
  return BigInt(parsed.info.tokenAmount.amount);
}

async function withRetry(label, fn, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Public endpoints rate-limit aggressively; back off rather than
      // returning a partial history, which is the one failure that produces a
      // wrong `hold` instead of an obvious error.
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** i));
    }
  }
  throw new TimelineError(`${label} failed after ${attempts} attempts: ${lastError?.message}`, {
    cause: lastError,
  });
}

/**
 * Every signature that touched `account`, newest first, back to `since`.
 *
 * Fetches one page past the cutoff so the caller has the transaction that set
 * the balance *before* the window — which is what seeds the timeline when
 * nothing happened during the window itself.
 *
 * @param {number} since  unix seconds
 */
export async function signaturesSince(connection, account, since) {
  const address = new PublicKey(account);
  const collected = [];
  let before;

  for (;;) {
    const page = await withRetry('getSignaturesForAddress', () =>
      connection.getSignaturesForAddress(address, { limit: 1000, before }),
    );
    if (page.length === 0) break;

    collected.push(...page);
    before = page[page.length - 1].signature;

    // Stop once we hold at least one confirmed transaction older than the
    // cutoff: that one is the seed, and everything before it is irrelevant.
    const oldest = page[page.length - 1].blockTime;
    if (oldest != null && oldest < since) break;
  }

  return collected;
}

/**
 * Pull the balance changes for one token account out of parsed transactions.
 *
 * @returns {import('./timeline.mjs').BalanceEvent[]} oldest first
 */
export async function balanceEventsFor(connection, account, since, { chunkSize = 25 } = {}) {
  const accountKey = new PublicKey(account).toBase58();
  const signatures = await signaturesSince(connection, account, since);

  // getSignaturesForAddress returns newest first; the timeline is oldest first,
  // and within a slot the confirmation order is the order that matters.
  const ordered = [...signatures].reverse();
  const events = [];

  for (let i = 0; i < ordered.length; i += chunkSize) {
    const chunk = ordered.slice(i, i + chunkSize);
    const parsed = await withRetry('getParsedTransactions', () =>
      connection.getParsedTransactions(
        chunk.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      ),
    );

    for (let j = 0; j < chunk.length; j++) {
      const tx = parsed[j];
      if (!tx) {
        throw new TimelineError(
          'RPC returned no transaction for a signature it had just listed — history is incomplete',
          { signature: chunk[j].signature },
        );
      }
      // A failed transaction moves nothing, so it cannot change the balance
      // and must not appear as a step in the timeline.
      if (tx.meta?.err) continue;

      const event = extractBalanceEvent(tx, accountKey, chunk[j].signature);
      if (event) events.push(event);
    }
  }

  return events;
}

/**
 * One transaction → at most one balance event for the account we care about.
 *
 * Exported for the tests: this is where the SPL-token response shape gets
 * turned into two integers, and the two absence cases are easy to get wrong.
 * An account missing from `preTokenBalances` was created by this transaction
 * (balance was 0 before); missing from `postTokenBalances` means it was closed
 * (balance is 0 after).
 */
export function extractBalanceEvent(tx, accountKey, signature) {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((k) => (k.pubkey?.toBase58?.() ?? String(k.pubkey)) === accountKey);
  if (index === -1) return null;

  const find = (list) => (list ?? []).find((b) => b.accountIndex === index);
  const pre = find(tx.meta?.preTokenBalances);
  const post = find(tx.meta?.postTokenBalances);
  if (!pre && !post) return null; // touched the account without moving tokens

  const preRaw = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
  const postRaw = post ? BigInt(post.uiTokenAmount.amount) : 0n;
  if (preRaw === postRaw) return null; // no step in a piecewise-constant timeline

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    pre: preRaw,
    post: postRaw,
  };
}
