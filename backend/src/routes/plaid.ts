import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  Products,
  CountryCode,
  AccountType,
  AccountSubtype,
} from 'plaid';
import { plaidClient } from '../config/plaid';
import { db } from '../config/db';
import { encrypt, decrypt } from '../crypto/encrypt';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();

// Webhook endpoint has no auth — must come before attachDbUser
router.post('/webhook', async (req: Request, res: Response) => {
  const { webhook_type, webhook_code, item_id, error } = req.body;
  if (webhook_type === 'ITEM' && (webhook_code === 'ERROR' || webhook_code === 'PENDING_EXPIRATION')) {
    await db.plaidItem.updateMany({
      where: { plaidItemId: item_id },
      data: { isActive: false },
    }).catch(() => {});
    console.warn(`[Plaid] Item ${item_id} deactivated — code: ${webhook_code}, error: ${JSON.stringify(error)}`);
  }
  res.json({ ok: true });
});

router.use(attachDbUser);

// POST /api/plaid/link-token — create a Link token for the frontend
router.post('/link-token', async (req: Request, res: Response, next) => {
  try {
    const userId = req.dbUserId!;
    const resp = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Sollux',
      products: [Products.Auth, Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook:      process.env.PLAID_WEBHOOK_URL  ?? undefined,
      redirect_uri: process.env.PLAID_REDIRECT_URI ?? undefined,
    });
    res.json({ link_token: resp.data.link_token });
  } catch (err: any) {
    const plaidErr = err?.response?.data;
    if (plaidErr) console.error('[Plaid] link-token error:', JSON.stringify(plaidErr));
    next(err);
  }
});

// POST /api/plaid/exchange-token — exchange public_token, create PlaidItem + BankAccounts
router.post('/exchange-token', async (req: Request, res: Response, next) => {
  try {
    const userId = req.dbUserId!;
    const { public_token, metadata } = req.body as {
      public_token: string;
      metadata: {
        institution: { institution_id: string; name: string };
        accounts: Array<{
          id: string;
          name: string;
          mask: string | null;
          type: string;
          subtype: string;
        }>;
      };
    };

    // Exchange for access token
    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = exchange.data;

    // Soft-reactivate if this item was previously disconnected
    const existingItem = await db.plaidItem.findUnique({ where: { plaidItemId: item_id } });
    let plaidItem: Awaited<ReturnType<typeof db.plaidItem.create>>;

    if (existingItem) {
      plaidItem = await db.plaidItem.update({
        where: { id: existingItem.id },
        data: {
          accessTokenEnc:  encrypt(access_token),
          institutionName: metadata.institution.name,
          isActive:        true,
          lastSyncedAt:    null,
        },
      });
    } else {
      plaidItem = await db.plaidItem.create({
        data: {
          userId,
          plaidItemId:     item_id,
          accessTokenEnc:  encrypt(access_token),
          institutionId:   metadata.institution.institution_id,
          institutionName: metadata.institution.name,
        },
      });
    }

    // Map Plaid account type → BankAccountType
    function mapType(type: string, subtype: string): string {
      if (type === AccountType.Depository) {
        return subtype === AccountSubtype.Savings ? 'SAVINGS' : 'CHECKING';
      }
      if (type === AccountType.Credit) return 'CREDIT_CARD';
      return 'CHECKING';
    }

    // Upsert BankAccount for each connected account
    const accounts = await Promise.all(
      metadata.accounts.map(async (acct) => {
        const existing = await db.bankAccount.findFirst({
          where: { plaidAccountId: acct.id },
        });
        if (existing) {
          return db.bankAccount.update({
            where: { id: existing.id },
            data: { plaidItemId: plaidItem.id, isActive: true },
          });
        }
        return db.bankAccount.create({
          data: {
            userId,
            plaidItemId:    plaidItem.id,
            plaidAccountId: acct.id,
            name:           acct.name,
            last4:          acct.mask ?? undefined,
            bank:           metadata.institution.name,
            accountType:    mapType(acct.type, acct.subtype) as any,
          },
        });
      })
    );

    // Fetch and store today's balances immediately
    await syncBalancesForItem(plaidItem.id, access_token);

    res.status(201).json({
      item: { ...plaidItem, accessTokenEnc: undefined },
      accounts,
    });
  } catch (err) { next(err); }
});

// GET /api/plaid/items — list connected items with accounts + latest balance
router.get('/items', async (req: Request, res: Response, next) => {
  try {
    const items = await db.plaidItem.findMany({
      where: { userId: req.dbUserId!, isActive: true },
      include: {
        accounts: {
          where: { isActive: true },
          include: {
            balances: { orderBy: { asOfDate: 'desc' }, take: 1 },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    // Strip encrypted tokens from response
    res.json(items.map(i => ({ ...i, accessTokenEnc: undefined })));
  } catch (err) { next(err); }
});

// DELETE /api/plaid/items/:id — disconnect a bank connection
router.delete('/items/:id', async (req: Request, res: Response, next) => {
  try {
    const item = await db.plaidItem.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });

    try {
      const accessToken = decrypt(item.accessTokenEnc);
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch {
      // If Plaid returns an error (token already invalid), continue with local cleanup
    }

    await db.plaidItem.update({
      where: { id: item.id },
      data: { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/plaid/sync — manually refresh all balances
router.post('/sync', async (req: Request, res: Response, next) => {
  try {
    const items = await db.plaidItem.findMany({
      where: { userId: req.dbUserId!, isActive: true },
    });
    const results = await Promise.allSettled(
      items.map(item => syncBalancesForItem(item.id, decrypt(item.accessTokenEnc)))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ synced: items.length - failed, failed });
  } catch (err) { next(err); }
});

// ── Shared sync helper ─────────────────────────────────────────────────────────

export async function syncBalancesForItem(plaidItemId: string, accessToken: string) {
  const resp = await plaidClient.accountsBalanceGet({ access_token: accessToken });

  // Midnight UTC = canonical date key for dedup
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const acct of resp.data.accounts) {
    const bankAccount = await db.bankAccount.findFirst({
      where: { plaidAccountId: acct.account_id },
    });
    if (!bankAccount || acct.balances.current == null) continue;

    await db.bankBalance.upsert({
      where: { bankAccountId_asOfDate: { bankAccountId: bankAccount.id, asOfDate: today } },
      update: {
        balance:     acct.balances.current,
        available:   acct.balances.available,
        creditLimit: acct.balances.limit,
        source:      'plaid',
      },
      create: {
        bankAccountId: bankAccount.id,
        balance:       acct.balances.current,
        available:     acct.balances.available,
        creditLimit:   acct.balances.limit,
        asOfDate:      today,
        source:        'plaid',
      },
    });
  }

  await db.plaidItem.update({
    where: { id: plaidItemId },
    data: { lastSyncedAt: new Date() },
  });
}

export default router;
