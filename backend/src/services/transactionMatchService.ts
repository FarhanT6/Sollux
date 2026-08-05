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

// ─── Incoming (rent via P2P) ──────────────────────────────────────────────

type Channel = 'ZELLE' | 'VENMO' | 'PAYPAL' | 'CASH_APP' | 'APPLE_CASH' | 'OTHER';

const CHANNEL_PATTERNS: [RegExp, Channel][] = [
  [/zelle/i, 'ZELLE'],
  [/venmo/i, 'VENMO'],
  [/paypal/i, 'PAYPAL'],
  [/cash ?app|square cash|sq \*cash/i, 'CASH_APP'],
  [/apple cash|apple pay cash/i, 'APPLE_CASH'],
];

function detectChannel(name: string): Channel | null {
  for (const [re, channel] of CHANNEL_PATTERNS) {
    if (re.test(name)) return channel;
  }
  return null;
}

// Strips the payment-app boilerplate off a transaction name to get at the
// human name, e.g. "ZELLE FROM JOHN SMITH" -> "JOHN SMITH", "VENMO PAYMENT J SMITH" -> "J SMITH"
function extractCounterpartyName(name: string): string {
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

/** Fuzzy-match a counterparty name against a user's active tenants. Returns the lease id on a confident single match. */
async function matchLease(counterpartyName: string, userId: string): Promise<string | null> {
  const words = normalizeWords(counterpartyName);
  if (words.length === 0) return null;

  const activeLeases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    include: { leaseTenants: { include: { tenant: true } } },
  });

  const matches = activeLeases.filter(lease =>
    lease.leaseTenants.some(lt => {
      const tenantWords = normalizeWords(lt.tenant.fullName);
      if (tenantWords.length === 0) return false;
      const overlap = tenantWords.filter(w => words.includes(w)).length;
      // Require at least one strong word match (e.g. last name) and decent overlap
      return overlap >= 1 && overlap / tenantWords.length >= 0.5;
    })
  );

  return matches.length === 1 ? matches[0].id : null;
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
    include: { accounts: { where: { isActive: true, OR: [{ watchForRentPayments: true }, { watchForExpenses: true }] } } },
  });
  if (!plaidItem || plaidItem.accounts.length === 0) return { added: 0 };

  const bankAccountByPlaidId = new Map(plaidItem.accounts.map(a => [a.plaidAccountId, a]));

  const accessToken = decrypt(plaidItem.accessTokenEnc);
  let cursor = plaidItem.plaidTxCursor ?? undefined;
  let added = 0;
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({ access_token: accessToken, cursor });

    for (const tx of resp.data.added) {
      const bankAccount = bankAccountByPlaidId.get(tx.account_id);
      if (!bankAccount) continue;
      const name = tx.merchant_name || tx.name;

      // Plaid: negative amount = money moving INTO the account (a credit).
      if (bankAccount.watchForRentPayments && tx.amount < 0) {
        const channel = detectChannel(name);
        if (channel) {
          const counterparty = extractCounterpartyName(name);
          const matchedLeaseId = await matchLease(counterparty, plaidItem.userId);
          await db.incomingTransaction.upsert({
            where: { plaidTransactionId: tx.transaction_id },
            update: {},
            create: {
              userId: plaidItem.userId,
              bankAccountId: bankAccount.id,
              plaidTransactionId: tx.transaction_id,
              amount: Math.abs(tx.amount),
              date: new Date(tx.date),
              name,
              channel,
              matchedLeaseId,
              status: matchedLeaseId ? 'SUGGESTED' : 'UNMATCHED',
            },
          });
          added += 1;
          continue;
        }
      }

      // Positive amount = money moving OUT of the account (a debit/purchase).
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
      accounts: { some: { isActive: true, OR: [{ watchForRentPayments: true }, { watchForExpenses: true }] } },
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
