/**
 * Transaction Match Service
 *
 * Syncs Plaid transactions for bank accounts the user has opted into
 * watching, filters for Zelle/Venmo/PayPal/Cash App/Apple Cash-style
 * incoming (credit) transfers, and fuzzy-matches the counterparty name
 * against active tenants so a rent payment can be confirmed with one
 * click instead of typed in by hand.
 */
import { plaidClient } from '../config/plaid';
import { db } from '../config/db';
import { decrypt } from '../crypto/encrypt';

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

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Fuzzy-match a counterparty name against a user's active tenants. Returns the lease id on a confident single match. */
async function matchLease(counterpartyName: string, userId: string): Promise<string | null> {
  const normalized = normalizeName(counterpartyName);
  if (!normalized || normalized.length < 3) return null;
  const words = normalized.split(' ').filter(w => w.length > 1);
  if (words.length === 0) return null;

  const activeLeases = await db.lease.findMany({
    where: { status: 'ACTIVE', unit: { property: { userId } } },
    include: { leaseTenants: { include: { tenant: true } } },
  });

  const matches = activeLeases.filter(lease =>
    lease.leaseTenants.some(lt => {
      const tenantWords = normalizeName(lt.tenant.fullName).split(' ').filter(w => w.length > 1);
      if (tenantWords.length === 0) return false;
      const overlap = tenantWords.filter(w => words.includes(w)).length;
      // Require at least one strong word match (e.g. last name) and decent overlap
      return overlap >= 1 && overlap / tenantWords.length >= 0.5;
    })
  );

  return matches.length === 1 ? matches[0].id : null;
}

// The /transactions/sync cursor is scoped to the whole Plaid Item (one
// access token), not to an individual account — an Item can cover several
// of the user's accounts, only some of which may be watched for rent. So
// we always sync the full Item and then filter to watched accounts here.
export async function syncTransactionsForItem(plaidItemId: string) {
  const plaidItem = await db.plaidItem.findUnique({
    where: { id: plaidItemId },
    include: { accounts: { where: { watchForRentPayments: true, isActive: true } } },
  });
  if (!plaidItem || plaidItem.accounts.length === 0) return { added: 0 };

  const watchedAccountIds = new Set(plaidItem.accounts.map(a => a.plaidAccountId).filter(Boolean) as string[]);
  const bankAccountByPlaidId = new Map(plaidItem.accounts.map(a => [a.plaidAccountId, a]));

  const accessToken = decrypt(plaidItem.accessTokenEnc);
  let cursor = plaidItem.plaidTxCursor ?? undefined;
  let added = 0;
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({ access_token: accessToken, cursor });

    for (const tx of resp.data.added) {
      if (!watchedAccountIds.has(tx.account_id)) continue;
      // Plaid: negative amount = money moving into the account.
      if (tx.amount >= 0) continue;
      const name = tx.merchant_name || tx.name;
      const channel = detectChannel(name);
      if (!channel) continue;

      const bankAccount = bankAccountByPlaidId.get(tx.account_id)!;
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
    }

    cursor = resp.data.next_cursor;
    hasMore = resp.data.has_more;
  }

  await db.plaidItem.update({ where: { id: plaidItem.id }, data: { plaidTxCursor: cursor } });
  return { added };
}

export async function syncAllWatchedAccounts(userId: string) {
  const items = await db.plaidItem.findMany({
    where: { userId, isActive: true, accounts: { some: { watchForRentPayments: true, isActive: true } } },
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
