// Everything the page reads from an RPC.
//
// Deliberately the browser twin of scripts/lib/chain.mjs — same reads, same
// ordering, same refusal to guess. It exists because chain.mjs imports
// `@solana/spl-token`, which does not load in a browser.
//
// The part that would actually be dangerous to duplicate — turning a parsed
// transaction into a balance step — is NOT duplicated. `extractBalanceEvent`
// is imported from scripts/lib/timeline.mjs: the same function, in the same
// file, that the crank calls at settlement.
//
// Phase 07 §7.3's rule for this layer: a wrong number is worse than no number.
// Every read either succeeds or throws; nothing here falls back to a plausible
// value, and the renderer is responsible for showing the failure.

import { extractBalanceEvent, TimelineError } from '../../scripts/lib/timeline.mjs';

import { PublicKey, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './addresses.js';

/**
 * Which token program owns this mint.
 *
 * pump.fun's `create` produces SPL Token mints and `create_v2` produces
 * Token-2022 mints, and the two derive DIFFERENT associated token addresses
 * (Phase 06 §6.5 note 4). Detecting it beats hardcoding either — hardcoding
 * the wrong one derives a real-looking address that holds nothing, and the
 * page would confidently report a zero balance.
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
 * Every token account this wallet holds for the mint, so the page can say when
 * there is more than one.
 *
 * Tokens parked outside the associated account earn nothing, and someone who
 * has done that by accident deserves to be told which account is being read
 * rather than left to wonder why their balance looks wrong.
 */
export async function allTokenAccounts(connection, owner, mint, tokenProgram) {
  const response = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    mint: new PublicKey(mint),
    programId: new PublicKey(tokenProgram),
  });
  return response.value.map((entry) => ({
    address: entry.pubkey.toBase58(),
    amount: BigInt(entry.account.data.parsed.info.tokenAmount.amount),
  }));
}

/** Current raw balance of a token account, or 0n if it does not exist. */
export async function currentBalanceRaw(connection, account) {
  const info = await connection.getParsedAccountInfo(new PublicKey(account));
  const parsed = info?.value?.data?.parsed;
  if (!parsed || parsed.type !== 'account') return 0n;
  return BigInt(parsed.info.tokenAmount.amount);
}

/** Lamport balance of a bare account — the pool, the creator vault. */
export async function lamportsOf(connection, address) {
  return BigInt(await connection.getBalance(new PublicKey(address)));
}

/**
 * Signatures back to `since`, newest-first pages, stopping one transaction
 * past the cutoff so the timeline has a seed.
 *
 * `pageLimit` is smaller than the crank's 1000 on purpose: this runs on a
 * phone against a shared endpoint while someone waits, and the wallets the
 * page looks up have days of history, not months.
 */
export async function signaturesSince(connection, account, since, { pageLimit = 200 } = {}) {
  const address = new PublicKey(account);
  const collected = [];
  let before;

  for (;;) {
    const page = await connection.getSignaturesForAddress(address, { limit: pageLimit, before });
    if (page.length === 0) break;
    collected.push(...page);
    before = page[page.length - 1].signature;

    const oldest = page[page.length - 1].blockTime;
    if (oldest != null && oldest < since) break;
  }

  return collected;
}

/**
 * The balance events for one token account, oldest first.
 *
 * Same shape and same ordering rule as the crank's version: newest-first
 * signatures reversed, failed transactions skipped because they moved nothing,
 * and a listed signature the RPC then refuses to return treated as **an
 * incomplete history rather than an absent transaction**. That last one is
 * Phase 05 §5.6's "most likely real bug", and on this page it is the
 * difference between "we can't show you this" and a wrong number.
 */
export async function balanceEventsFor(connection, account, since, { chunkSize = 25 } = {}) {
  const accountKey = new PublicKey(account).toBase58();
  const signatures = await signaturesSince(connection, account, since);
  const ordered = [...signatures].reverse();
  const events = [];

  for (let i = 0; i < ordered.length; i += chunkSize) {
    const chunk = ordered.slice(i, i + chunkSize);
    const parsed = await connection.getParsedTransactions(
      chunk.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 },
    );

    for (let j = 0; j < chunk.length; j++) {
      const tx = parsed[j];
      if (!tx) {
        throw new TimelineError(
          'the RPC returned no transaction for a signature it had just listed — this history is incomplete',
          { signature: chunk[j].signature },
        );
      }
      if (tx.meta?.err) continue;
      const event = extractBalanceEvent(tx, accountKey, chunk[j].signature);
      if (event) events.push(event);
    }
  }

  return events;
}

/**
 * Fetch several accounts at once, preserving order and keeping nulls.
 *
 * A null means "no such account", which for an epoch means it was never
 * posted — a real, displayable state, not an error.
 */
export async function multipleAccounts(connection, addresses) {
  if (addresses.length === 0) return [];
  const out = [];
  // getMultipleAccounts caps at 100 addresses per call.
  for (let i = 0; i < addresses.length; i += 100) {
    const slice = addresses.slice(i, i + 100).map((a) => new PublicKey(a));
    const infos = await connection.getMultipleAccountsInfo(slice);
    out.push(...infos.map((info) => (info ? new Uint8Array(info.data) : null)));
  }
  return out;
}
