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

interface UtilityMatch { utilityAccountId: string; propertyId: string; providerName: string }

/** Fuzzy-match a merchant name against the user's utility accounts by provider name. */
async function matchUtilityAccount(merchantName: string, userId: string): Promise<UtilityMatch | null> {
  const words = normalizeWords(merchantName);
  if (words.length === 0) return null;

  const accounts = await db.utilityAccount.findMany({
    where: { property: { userId }, isActive: true },
    select: { id: true, propertyId: true, providerName: true },
  });

  const matches = accounts.filter(a => {
    const providerWords = normalizeWords(a.providerName);
    if (providerWords.length === 0) return false;
    const overlap = providerWords.filter(w => words.includes(w)).length;
    return overlap >= 1 && overlap / providerWords.length >= 0.5;
  });

  return matches.length === 1
    ? { utilityAccountId: matches[0].id, propertyId: matches[0].propertyId, providerName: matches[0].providerName }
    : null;
}

interface ExpenseMatch {
  matchType: 'HARDWARE' | 'UTILITY';
  propertyId: string | null;
  utilityAccountId: string | null;
  category: string | null;
  statementId: string | null;
}

async function detectExpenseMatch(name: string, userId: string): Promise<ExpenseMatch | null> {
  if (HARDWARE_STORE_PATTERN.test(name)) {
    return { matchType: 'HARDWARE', propertyId: null, utilityAccountId: null, category: 'REPAIRS_MAINTENANCE', statementId: null };
  }

  const utilityMatch = await matchUtilityAccount(name, userId);
  if (utilityMatch) {
    // Prefer marking an existing open statement paid over creating a
    // duplicate Expense — utility Statement amounts already feed the
    // Budget as operating expenses, so double-logging would inflate it.
    const openStatement = await db.statement.findFirst({
      where: { utilityAccountId: utilityMatch.utilityAccountId, amountPaid: null },
      orderBy: { statementDate: 'desc' },
    });
    return {
      matchType: 'UTILITY',
      propertyId: utilityMatch.propertyId,
      utilityAccountId: utilityMatch.utilityAccountId,
      category: 'UTILITIES',
      statementId: openStatement?.id ?? null,
    };
  }

  return null;
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
        const match = await detectExpenseMatch(name, plaidItem.userId);
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
