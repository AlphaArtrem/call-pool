// L16 — supplying liquidity is not selling, and selling is still selling.
//
// The dangerous version of this feature is one line away from the correct one.
// Depositing into the coin's pump.fun pool and selling into it send the tokens
// to the **same account** — the bonding curve before graduation, the AMM pool
// after it — so the obvious implementation, "exempt a decrease whose
// counterparty is a known pool", exempts selling. That is not a bug in the
// exemption; it is the removal of the mechanic.
//
// What separates them is what comes back: a deposit mints the pool's LP tokens
// to the depositor, a sale does not, and LP tokens cannot be had without
// depositing. So most of this file is about the cases that must STILL lock
// somebody out, because those are the ones a wrong implementation gets wrong
// silently and in the direction that costs money.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCKOUT_EPOCHS } from '../lib/config.mjs';
import { lockoutWindow, windowForDay } from '../lib/epoch.mjs';
import { lpMint } from '../lib/pump-addresses.mjs';
import { computeLocked, extractBalanceEvent, isLpDeposit } from '../lib/timeline.mjs';

const W = windowForDay('2026-08-04');
const LOCK = lockoutWindow(W, LOCKOUT_EPOCHS);

const MINT = 'CXuAgy9E2Ynjrx9sPNSqpGg4asxm34Rrq78hoMShPAAK';
const LP = lpMint(MINT).toBase58();
const OTHER_LP = lpMint('9uAzrjSJBBYKwzQdHBSWrcdEVfwA6MbNjT1DbsT7TFFf').toBase58();

const HOLDER = 'HoLDeR11111111111111111111111111111111111111';
const ATA = 'AtA111111111111111111111111111111111111111111';
const POOL = 'PooL11111111111111111111111111111111111111111';

const amount = (n) => ({ amount: String(n), decimals: 6 });

/**
 * A parsed transaction in which the holder's coin balance moves, and some set
 * of other token balances move alongside it.
 *
 * `others` is where the difference between a sale and a deposit lives, so it is
 * spelled out per test rather than hidden in a helper flag.
 */
function tx({ pre, post, others = [], blockTime = LOCK.start + 3600 }) {
  const coin = (index, value) => ({
    accountIndex: index, mint: MINT, owner: HOLDER, uiTokenAmount: amount(value),
  });
  return {
    slot: 100,
    blockTime,
    meta: {
      err: null,
      preTokenBalances: [
        ...(pre == null ? [] : [coin(0, pre)]),
        ...others.filter((o) => o.pre != null).map((o) => ({
          accountIndex: o.index, mint: o.mint, owner: o.owner, uiTokenAmount: amount(o.pre),
        })),
      ],
      postTokenBalances: [
        ...(post == null ? [] : [coin(0, post)]),
        ...others.filter((o) => o.post != null).map((o) => ({
          accountIndex: o.index, mint: o.mint, owner: o.owner, uiTokenAmount: amount(o.post),
        })),
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: ATA }, { pubkey: POOL }] } },
  };
}

const event = (t) => extractBalanceEvent(t, ATA, 'sig', { lpMint: LP });

/** A deposit: the coin leaves, LP tokens of this pool arrive. */
const deposit = (from, to) =>
  tx({ pre: from, post: to, others: [{ index: 2, mint: LP, owner: HOLDER, pre: null, post: 5_000 }] });

/** A sale: the coin leaves and nothing of this pool's LP mint comes back. */
const sale = (from, to) => tx({ pre: from, post: to });

// ── the thing that must not break ──────────────────────────────────────────

test('a plain sale is still a sale', () => {
  assert.equal(event(sale(1_000, 400)).lpDeposit, false);
  assert.equal(computeLocked([event(sale(1_000, 400))], LOCK).locked, true);
});

test('selling everything is still a sale', () => {
  assert.equal(computeLocked([event(sale(1_000, 0))], LOCK).locked, true);
});

test('a transfer to a second wallet you own is still a sale (L6, proof 19)', () => {
  // No LP mint anywhere: the destination is irrelevant and always was.
  const moved = tx({
    pre: 1_000, post: 0,
    others: [{ index: 2, mint: MINT, owner: 'SecondWallet1111111111111111111111111111111', pre: 0, post: 1_000 }],
  });
  assert.equal(event(moved).lpDeposit, false);
  assert.equal(computeLocked([event(moved)], LOCK).locked, true);
});

test('LP tokens of a DIFFERENT coin\'s pool do not exempt a sale', () => {
  // Selling this coin in the same transaction as depositing another one.
  const laundered = tx({
    pre: 1_000, post: 0,
    others: [{ index: 2, mint: OTHER_LP, owner: HOLDER, pre: null, post: 5_000 }],
  });
  assert.equal(event(laundered).lpDeposit, false);
  assert.equal(computeLocked([event(laundered)], LOCK).locked, true);
});

test('LP tokens minted to somebody ELSE do not exempt a sale', () => {
  // The obvious way to try to buy an exemption: have the pool credit LP tokens
  // to an address that is not the seller.
  const elsewhere = tx({
    pre: 1_000, post: 0,
    others: [{ index: 2, mint: LP, owner: 'NotTheHolder11111111111111111111111111111111', pre: null, post: 5_000 }],
  });
  assert.equal(event(elsewhere).lpDeposit, false);
  assert.equal(computeLocked([event(elsewhere)], LOCK).locked, true);
});

test('an LP balance the wallet already had does not exempt a later sale', () => {
  // Strictly an increase. A holder who supplied liquidity last month and sells
  // today is selling today, and a balance they held all along must not say
  // otherwise.
  const held = tx({
    pre: 1_000, post: 0,
    others: [{ index: 2, mint: LP, owner: HOLDER, pre: 5_000, post: 5_000 }],
  });
  assert.equal(event(held).lpDeposit, false);
  assert.equal(computeLocked([event(held)], LOCK).locked, true);
});

test('an LP balance that DECREASED does not exempt a sale', () => {
  // Withdrawing liquidity and selling in one transaction is a sale.
  const withdrawAndSell = tx({
    pre: 1_000, post: 0,
    others: [{ index: 2, mint: LP, owner: HOLDER, pre: 5_000, post: 1_000 }],
  });
  assert.equal(event(withdrawAndSell).lpDeposit, false);
  assert.equal(computeLocked([event(withdrawAndSell)], LOCK).locked, true);
});

test('with no LP mint supplied, nothing is ever exempt', () => {
  // The default. Every caller that has not been taught about L16 keeps the old
  // behaviour exactly, rather than silently exempting on a null comparison.
  const e = extractBalanceEvent(deposit(1_000, 0), ATA, 'sig');
  assert.equal(e.lpDeposit, undefined);
  assert.equal(computeLocked([e], LOCK).locked, true);
});

// ── the thing L16 actually changes ────────────────────────────────────────

test('supplying liquidity to this coin\'s pool is not a lockout', () => {
  const e = event(deposit(1_000, 0));
  assert.equal(e.lpDeposit, true);

  const lock = computeLocked([e], LOCK);
  assert.equal(lock.locked, false, 'a week\'s exclusion for making the coin tradeable');
  assert.deepEqual(lock.decreases, []);
  assert.equal(lock.lpDeposits.length, 1, 'exempted, and still visible');
});

test('a partial deposit is not a lockout either', () => {
  assert.equal(computeLocked([event(deposit(1_000, 600))], LOCK).locked, false);
});

test('one deposit does not launder a separate sale', () => {
  // Two transactions, and only one of them is exempt. The wallet is locked out
  // for the sale, exactly as if the deposit had never happened.
  const events = [
    event(deposit(1_000, 400)),
    event(tx({ pre: 400, post: 0, blockTime: LOCK.start + 7_200 })),
  ];
  const lock = computeLocked(events, LOCK);
  assert.equal(lock.locked, true);
  assert.equal(lock.decreases.length, 1);
  assert.equal(lock.lpDeposits.length, 1);
});

test('the exemption does not reach outside the lockout window', () => {
  // A deposit before the window is not in `decreases` or `lpDeposits` at all —
  // the window filter runs first, and this pins that ordering.
  const old = event(deposit(1_000, 0));
  old.blockTime = LOCK.start - 60;
  const lock = computeLocked([old], LOCK);
  assert.deepEqual(lock.decreases, []);
  assert.deepEqual(lock.lpDeposits, []);
});

// ── hold is untouched, which is the whole scope of the decision ───────────

test('an LP\'d wallet still holds nothing, and still earns nothing', () => {
  // L16 removes the PENALTY, not the exclusion. This is the line the site copy
  // has to say out loud, and it is a property of the code rather than a
  // promise: `computeHold` was not changed, so a wallet whose tokens are in the
  // pool has hold ~0 for those epochs and is below the floor.
  const e = event(deposit(1_000, 0));
  assert.equal(e.post, 0n, 'the tokens are in the pool, not in the wallet');
});

// ── the discriminator itself ──────────────────────────────────────────────

test('isLpDeposit is about this wallet and this pool, and nothing else', () => {
  const t = deposit(1_000, 0);
  assert.equal(isLpDeposit(t, HOLDER, LP), true);
  assert.equal(isLpDeposit(t, HOLDER, OTHER_LP), false, 'a different coin\'s pool');
  assert.equal(isLpDeposit(t, 'SomebodyElse111111111111111111111111111111', LP), false);
});

test('a transaction with no token balances at all is not a deposit', () => {
  assert.equal(isLpDeposit({ meta: {} }, HOLDER, LP), false);
  assert.equal(isLpDeposit({}, HOLDER, LP), false);
});
