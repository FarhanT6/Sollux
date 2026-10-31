/**
 * Transaction Match Service
 *
 * Syncs Plaid transactions for bank accounts the user has opted into
 * watching and sorts them into two candidate queues:
 *  - Incoming: Zelle/Venmo/PayPal/Cash App/Apple Cash-style credits,
 *    fuzzy-matched against active tenants (rent payments).
 *  - Outgoing: hardware-store purchases and utility bill payments,
 *    matched against properties/utility accounts.
 *
 * Plaid's /transactions/sync cursor is scoped per Item (one access
 * token), not per account — an Item can cover several of the user's
 * accounts, only some of which may be watched, and for different
 * reasons. So every sync pass fetches the whole Item once and checks
 * each added transaction against whichever watch flags that specific
 * account has, rather than running separate passes that would each
 * advance (and partially consume) the same shared cursor.
 */
import { plaidClient } from '../config/plaid';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';
import { recordRentPayment } from './rentPaymentService';
import { findTwin, findLoggedPayment, sureOfTenant, periodFor, descriptorMemo } from './p2pPaymentEmails';
import { findLoanCandidates, confidentLoan, logLoanPaymentFromTransaction } from './loanPaymentMatcher';

// ─── Incoming (rent via P2P) ──────────────────────────────────────────────

type Channel =
  | 'ZELLE' | 'VENMO' | 'PAYPAL' | 'CASH_APP' | 'APPLE_CASH'
  | 'CHECK' | 'ACH' | 'DEPOSIT' | 'OTHER';

// Ordered — the first pattern to match wins, so the specific P2P brands are
// tested before the generic deposit wording that often accompanies them.
const CHANNEL_PATTERNS: [RegExp, Channel][] = [
  [/zelle/i, 'ZELLE'],
  [/venmo/i, 'VENMO'],
  [/paypal/i, 'PAYPAL'],
  [/cash ?app|square cash|sq \*cash/i, 'CASH_APP'],
  [/apple cash|apple pay cash/i, 'APPLE_CASH'],
  [/\bche?ck\b|\bchk\b|e-?check/i, 'CHECK'],
  [/\bach\b|direct\s*dep|dir\s*dep|electronic\s*dep/i, 'ACH'],
  [/mobile\s*dep|remote\s*dep|branch\s*dep|counter\s*credit|teller|\bdeposit\b/i, 'DEPOSIT'],
];

// Brand-name channels carry the payer's name in the descriptor, so a credit on
// a watched account is worth queueing on the strength of the channel alone.
// Bank channels don't — "MOBILE DEPOSIT" says nothing about who paid — so those
// need corroboration from a tenant name or a rent amount before they earn a
// place in the review queue, or every payroll deposit and transfer would land
// there too.
const SELF_IDENTIFYING: Channel[] = ['ZELLE', 'VENMO', 'PAYPAL', 'CASH_APP', 'APPLE_CASH'];

// What to record when one of these is applied as a rent payment.
export const CHANNEL_TO_METHOD: Record<Channel, string> = {
  ZELLE: 'ZELLE',
  VENMO: 'VENMO',
  PAYPAL: 'PAYPAL',
  CASH_APP: 'CASH_APP',
  APPLE_CASH: 'APPLE_CASH',
  CHECK: 'CHECK',
  ACH: 'ACH',
  DEPOSIT: 'BANK_DEPOSIT',
  OTHER: 'OTHER',
};

export function detectChannel(name: string): Channel | null {
  for (const [re, channel] of CHANNEL_PATTERNS) {
    if (re.test(name)) return channel;
  }
  return null;
}

// Strips the payment-app boilerplate off a transaction name to get at the
// human name, e.g. "ZELLE FROM JOHN SMITH" -> "JOHN SMITH", "VENMO PAYMENT J SMITH" -> "J SMITH"
export function extractCounterpartyName(name: string): string {
  return name
    .replace(/zelle|venmo|paypal|cash ?app|square cash|sq \*cash|apple cash|apple pay cash/gi, '')
    .replace(/\bfrom\b|\bpayment\b|\btransfer\b|\bmoney\b|\breceived\b|\bdes:?\b|\bindn:?\b/gi, '')
    .replace(/[*#0-9]{4,}/g, '')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 1);
}

export interface LeaseMatch {
  leaseId: string;
  /** True when the descriptor matched a payer name the owner entered by hand. */
  viaAlias: boolean;
  /** True when every word of the tenant's (or alias's) name is in the payer name. */
  exact: boolean;
}

/**
 * Fuzzy-match a counterparty name against a user's active tenants, and against
 * the payer names they listed for each lease. Returns a match only when exactly
 * one lease fits — two tenants sharing a surname must stay ambiguous.
 */
export async function matchLease(counterpartyName: string, userId: string): Promise<LeaseMatch | null> {
  const words = normalizeWords(counterpartyName);
  if (words.length === 0) return null;

  const activeLeases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    include: { leaseTenants: { include: { tenant: true } }, paymentAliases: true },
  });

  const fits = (candidate: string) => {
    const candidateWords = normalizeWords(candidate);
    if (candidateWords.length === 0) return false;
    const overlap = candidateWords.filter(w => words.includes(w)).length;
    // At least one strong word (e.g. a surname) plus decent overall overlap.
    return overlap >= 1 && overlap / candidateWords.length >= 0.5;
  };

  // An alias is something the owner typed specifically to be recognised, so it
  // is the stronger signal and is tested first.
  const whole = (candidate: string) => normalizeWords(candidate).every(w => words.includes(w));
  const aliasMatches = activeLeases.filter(l => l.paymentAliases.some(a => fits(a.name)));
  if (aliasMatches.length === 1) return { leaseId: aliasMatches[0].id, viaAlias: true, exact: aliasMatches[0].paymentAliases.some(a => whole(a.name)) };
  if (aliasMatches.length > 1) return null;

  const tenantMatches = activeLeases.filter(l => l.leaseTenants.some(lt => fits(lt.tenant.fullName)));
  return tenantMatches.length === 1
    ? { leaseId: tenantMatches[0].id, viaAlias: false, exact: tenantMatches[0].leaseTenants.some(lt => whole(lt.tenant.fullName)) }
    : null;
}

/**
 * Match on amount alone, for deposits whose descriptor names no one. A credit
 * equal to exactly one active lease's rent is a strong signal; if two leases
 * share that rent there is no way to tell them apart, so it stays unmatched
 * rather than guessing wrong.
 */
export async function matchLeaseByAmount(amount: number, userId: string): Promise<string | null> {
  const leases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    select: { id: true, rentAmount: true },
  });
  const exact = leases.filter(l => Math.abs(Number(l.rentAmount) - amount) < 0.005);
  return exact.length === 1 ? exact[0].id : null;
}

// ─── Outgoing (hardware-store expenses, utility payments) ────────────────

const HARDWARE_STORE_PATTERN = /home depot|lowe'?s|ace hardware|menards|harbor freight|tractor supply|floor\s*(&|and)\s*decor|sherwin.?williams/i;

// When the same provider (e.g. SDGE) has accounts on more than one
// property, a bank descriptor alone can't say which one a payment is for
// — so candidates are cross-referenced against every unpaid statement's
// amount. A candidate within this many dollars of the payment is
// considered plausible; the property is used as the "does exactly one
// property have a plausible statement" check.
const UTILITY_MATCH_TOLERANCE = 20;

export interface UtilityCandidate {
  utilityAccountId: string;
  propertyId: string;
  propertyLabel: string;
  providerName: string;
  statementId: string;
  statementDate: Date;
  amountDue: number;
  diff: number;
  withinTolerance: boolean;
}

/**
 * Every unpaid statement on a provider-name-matched utility account,
 * annotated with how close its amount is to the payment. Returned
 * regardless of tolerance (sorted closest-first) so a manual reviewer
 * always has something to pick from, even for an odd/partial payment.
 */
export async function findUtilityCandidates(merchantName: string, amount: number, userId: string): Promise<UtilityCandidate[]> {
  const words = normalizeWords(merchantName);
  if (words.length === 0) return [];

  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true },
    select: {
      id: true, propertyId: true, providerName: true,
      property: { select: { address: true, nickname: true } },
      statements: {
        where: { amountPaid: null, amountDue: { not: null } },
        select: { id: true, statementDate: true, amountDue: true },
      },
    },
  });

  const providerMatches = accounts.filter(a => {
    const providerWords = normalizeWords(a.providerName);
    if (providerWords.length === 0) return false;
    const overlap = providerWords.filter(w => words.includes(w)).length;
    return overlap >= 1 && overlap / providerWords.length >= 0.5;
  });

  const candidates: UtilityCandidate[] = [];
  for (const acct of providerMatches) {
    for (const stmt of acct.statements) {
      const amountDue = Number(stmt.amountDue);
      const diff = Math.abs(amountDue - amount);
      candidates.push({
        utilityAccountId: acct.id,
        propertyId: acct.propertyId,
        propertyLabel: acct.property.nickname || acct.property.address,
        providerName: acct.providerName,
        statementId: stmt.id,
        statementDate: stmt.statementDate,
        amountDue,
        diff,
        withinTolerance: diff <= UTILITY_MATCH_TOLERANCE,
      });
    }
  }

  return candidates.sort((a, b) => a.diff - b.diff);
}

interface ExpenseMatch {
  matchType: 'HARDWARE' | 'UTILITY';
  propertyId: string | null;
  utilityAccountId: string | null;
  category: string | null;
  statementId: string | null;
}

async function detectExpenseMatch(name: string, amount: number, userId: string): Promise<ExpenseMatch | null> {
  if (HARDWARE_STORE_PATTERN.test(name)) {
    return { matchType: 'HARDWARE', propertyId: null, utilityAccountId: null, category: 'REPAIRS_MAINTENANCE', statementId: null };
  }

  const candidates = await findUtilityCandidates(name, amount, userId);
  if (candidates.length === 0) return null; // no provider-name match at all — not a utility payment

  const plausible = candidates.filter(c => c.withinTolerance);
  const distinctAccounts = new Set(plausible.map(c => c.utilityAccountId));

  if (distinctAccounts.size === 1) {
    // Exactly one property has a statement in the right ballpark — within
    // that property, pay down the OLDEST unpaid statement first (real
    // arrears get caught up in order), not just whichever amount is closest.
    const winner = plausible.reduce((oldest, c) => c.statementDate < oldest.statementDate ? c : oldest);
    return {
      matchType: 'UTILITY',
      propertyId: winner.propertyId,
      utilityAccountId: winner.utilityAccountId,
      category: 'UTILITIES',
      statementId: winner.statementId,
    };
  }

  // Either no statement is close enough, or more than one property's
  // account has one — genuinely ambiguous. Flag it as a utility payment
  // so the review UI offers the candidate picker, but leave the specific
  // property/statement for a human to confirm.
  return { matchType: 'UTILITY', propertyId: null, utilityAccountId: null, category: 'UTILITIES', statementId: null };
}

// ─── Sync ──────────────────────────────────────────────────────────────────

export async function syncTransactionsForItem(plaidItemId: string) {
  const plaidItem = await db.plaidItem.findUnique({
    where: { id: plaidItemId },
    // Accounts a loan is paid from are read too, so an autopay shows up in the loan tracker.
    include: { accounts: { where: { isActive: true, OR: [{ watchForRentPayments: true }, { watchForExpenses: true }, { loansPaidFrom: { some: { isActive: true } } }] }, include: { _count: { select: { loansPaidFrom: true } } } } },
  });
  if (!plaidItem || plaidItem.accounts.length === 0) return { added: 0 };

  const bankAccountByPlaidId = new Map(plaidItem.accounts.map(a => [a.plaidAccountId, a]));

  const accessToken = decrypt(plaidItem.accessTokenEnc);
  let cursor = plaidItem.plaidTxCursor ?? undefined;
  let added = 0;
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({ access_token: accessToken, cursor });

    // A transfer is reported twice: pending, then posted under a new id
    // (pending_transaction_id points back), and the pending one is then
    // listed as removed. Both were kept and both logged as rent, so one $1,000
    // Zelle read as two. Pending ones wait until they post; a posted one takes
    // over a row stored from its pending self; removed ones not yet logged go.
    const removedIds = resp.data.removed.map(r => r.transaction_id).filter((id): id is string => !!id);
    if (removedIds.length) {
      await db.incomingTransaction.deleteMany({ where: { plaidTransactionId: { in: removedIds }, status: { not: 'APPLIED' } } });
      await db.outgoingTransaction.deleteMany({ where: { plaidTransactionId: { in: removedIds }, status: { not: 'APPLIED' } } });
    }

    for (const tx of resp.data.added) {
      const bankAccount = bankAccountByPlaidId.get(tx.account_id);
      if (!bankAccount) continue;
      if (tx.pending) continue;
      if (tx.pending_transaction_id) {
        const fromPending = await db.incomingTransaction.findUnique({ where: { plaidTransactionId: tx.pending_transaction_id }, select: { id: true } });
        if (fromPending) { await db.incomingTransaction.update({ where: { id: fromPending.id }, data: { plaidTransactionId: tx.transaction_id } }); continue; }
        const outPending = await db.outgoingTransaction.findUnique({ where: { plaidTransactionId: tx.pending_transaction_id }, select: { id: true } });
        if (outPending) { await db.outgoingTransaction.update({ where: { id: outPending.id }, data: { plaidTransactionId: tx.transaction_id } }); continue; }
      }
      const name = tx.merchant_name || tx.name;

      // Plaid: negative amount = money moving INTO the account (a credit).
      if (bankAccount.watchForRentPayments && tx.amount < 0) {
        const channel = detectChannel(name);
        if (channel) {
          // Already seen — /transactions/sync can replay, and applying twice
          // would double-credit the tenant.
          const seen = await db.incomingTransaction.findUnique({
            where: { plaidTransactionId: tx.transaction_id }, select: { id: true },
          });
          if (seen) continue;

          const amount = Math.abs(tx.amount);
          // Already read from the Zelle / Venmo email: the bank feed adds the
          // account it landed in, not a second payment.
          const fromEmail = await findTwin(plaidItem.userId, amount, new Date(tx.date), 'email', bankAccount.id, /\bREF\s*#?\s*(\S+)/i.exec(name)?.[1] ?? null);
          if (fromEmail) {
            if (!fromEmail.bankAccountId) await db.incomingTransaction.update({ where: { id: fromEmail.id }, data: { bankAccountId: bankAccount.id } });
            continue;
          }
          const counterparty = extractCounterpartyName(name);
          // Name first — it identifies the payer. Fall back to the rent amount,
          // which is all a bare "MOBILE DEPOSIT" gives us to go on.
          const nameMatch = await matchLease(counterparty, plaidItem.userId);
          const matchedLeaseId = nameMatch?.leaseId ?? await matchLeaseByAmount(amount, plaidItem.userId);

          // A bank-channel credit we can't tie to a tenant is far more likely
          // to be payroll or a transfer than rent, so leave it out entirely.
          if (!matchedLeaseId && !SELF_IDENTIFYING.includes(channel)) continue;

          const created = await db.incomingTransaction.create({
            data: {
              userId: plaidItem.userId,
              bankAccountId: bankAccount.id,
              plaidTransactionId: tx.transaction_id,
              amount,
              date: new Date(tx.date),
              name,
              channel,
              matchedLeaseId,
              status: matchedLeaseId ? 'SUGGESTED' : 'UNMATCHED',
            },
          });
          added += 1;

          // Logged without asking on the same rule as a payment email
          // (sureOfTenant): the tenant's name or a saved payer name, for an
          // amount they plausibly owe. Anything less certain waits for review,
          // because a wrongly applied payment moves a balance.
          const logged = nameMatch ? await findLoggedPayment(nameMatch.leaseId, amount, new Date(tx.date), { source: 'bank', reference: /\bREF\s*#?\s*(\S+)/i.exec(name)?.[1] ?? null }) : null;
          const lease = nameMatch ? await db.lease.findUnique({ where: { id: nameMatch.leaseId }, select: { rentAmount: true, arrearsBalance: true } }) : null;
          if (logged) {
            await db.incomingTransaction.update({ where: { id: created.id }, data: { status: 'APPLIED', rentPaymentId: logged.id } });
          } else if (nameMatch && sureOfTenant(nameMatch, lease, amount, descriptorMemo(name))) {
            const payment = await recordRentPayment({
              leaseId: nameMatch.leaseId,
              // "OCTOBER RENT 2026" sent Sep 30 is October's rent.
              periodDate: periodFor(new Date(tx.date), descriptorMemo(name)),
              amount,
              paidDate: new Date(tx.date),
              method: (CHANNEL_TO_METHOD[channel] ?? 'OTHER') as any,
              bankAccountId: bankAccount.id,
              notes: `Auto-logged — "${name}" ${nameMatch.viaAlias ? 'matches an expected payer name' : 'names the tenant'}`,
            });
            await db.incomingTransaction.update({
              where: { id: created.id },
              data: { status: 'APPLIED', rentPaymentId: payment.id },
            });
          }
          continue;
        }
      }

      // Positive amount = money moving OUT of the account. A loan payment first:
      // it goes to the loan tracker, logged on its own when the match is sure.
      if ((bankAccount.watchForExpenses || bankAccount._count.loansPaidFrom > 0) && tx.amount > 0) {
        const cands = await findLoanCandidates(name, tx.amount, plaidItem.userId, bankAccount.id);
        if (cands.length) {
          const seen = await db.outgoingTransaction.findUnique({ where: { plaidTransactionId: tx.transaction_id }, select: { id: true } });
          if (seen) continue;
          const sure = confidentLoan(cands);
          const pick = sure ?? cands[0];
          const created = await db.outgoingTransaction.create({
            data: {
              userId: plaidItem.userId, bankAccountId: bankAccount.id, plaidTransactionId: tx.transaction_id,
              amount: tx.amount, date: new Date(tx.date), name, matchType: 'LOAN', loanId: pick.loanId, propertyId: pick.propertyId,
              category: null, status: 'SUGGESTED',
            },
          });
          if (sure) {
            const paymentId = await logLoanPaymentFromTransaction(created, sure.loanId, plaidItem.userId);
            await db.outgoingTransaction.update({ where: { id: created.id }, data: { status: 'APPLIED', appliedType: 'LOAN_PAYMENT', appliedId: paymentId } });
          }
          added += 1;
          continue;
        }
      }
      if (bankAccount.watchForExpenses && tx.amount > 0) {
        const match = await detectExpenseMatch(name, tx.amount, plaidItem.userId);
        if (match) {
          await db.outgoingTransaction.upsert({
            where: { plaidTransactionId: tx.transaction_id },
            update: {},
            create: {
              userId: plaidItem.userId,
              bankAccountId: bankAccount.id,
              plaidTransactionId: tx.transaction_id,
              amount: tx.amount,
              date: new Date(tx.date),
              name,
              matchType: match.matchType,
              propertyId: match.propertyId,
              utilityAccountId: match.utilityAccountId,
              category: match.category,
              statementId: match.statementId,
              status: match.propertyId ? 'SUGGESTED' : 'UNMATCHED',
            },
          });
          added += 1;
        }
      }
    }

    cursor = resp.data.next_cursor;
    hasMore = resp.data.has_more;
  }

  await db.plaidItem.update({ where: { id: plaidItem.id }, data: { plaidTxCursor: cursor } });
  return { added };
}

export async function syncAllWatchedAccounts(userId: string) {
  const items = await db.plaidItem.findMany({
    where: {
      userId, isActive: true,
      accounts: { some: { isActive: true, OR: [{ watchForRentPayments: true }, { watchForExpenses: true }, { loansPaidFrom: { some: { isActive: true } } }] } },
    },
  });
  let totalAdded = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      const { added } = await syncTransactionsForItem(item.id);
      totalAdded += added;
    } catch (err) {
      errors.push(`${item.institutionName}: ${err instanceof Error ? err.message : 'sync failed'}`);
    }
  }
  return { itemsSynced: items.length - errors.length, added: totalAdded, errors };
}
