import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { encryptOptional, decryptOptional } from '../crypto/encrypt';
import { scrapeQueue } from '../workers/queues';

const router = Router();
router.use(attachDbUser);

const UtilitySchema = z.object({
  propertyId: z.string(),
  providerName: z.string().min(1),
  providerSlug: z.string().min(1),
  accountNumber: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  loginUrl: z.string().url().optional(),
  category: z.enum(['ELECTRIC', 'GAS', 'WATER', 'SEWER', 'TRASH', 'SOLAR',
    'INTERNET', 'PHONE', 'INSURANCE', 'HOA', 'TAXES', 'OTHER']),
  notes: z.string().optional(),
});

// GET /api/utilities?propertyId=xxx
router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;

    // Verify property belongs to user
    const where: any = {};
    if (propertyId) {
      const property = await db.property.findFirst({
        where: { id: String(propertyId), userId: req.dbUserId! },
      });
      if (!property) return res.status(404).json({ error: 'Property not found' });
      where.propertyId = String(propertyId);
    } else {
      // All utilities across all user properties
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! },
        select: { id: true },
      });
      where.propertyId = { in: userProperties.map(p => p.id) };
    }

    const accounts = await db.utilityAccount.findMany({
      where,
      include: {
        statements: { orderBy: { statementDate: 'desc' }, take: 1 },
        payments: { orderBy: { paymentDate: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Never return encrypted credential fields
    const sanitized = accounts.map(({ accountNumberEnc, usernameEnc, passwordEnc, ...rest }) => rest);
    res.json(sanitized);
  } catch (err) {
    next(err);
  }
});

// POST /api/utilities — add new account (encrypts credentials)
router.post('/', async (req, res, next) => {
  try {
    const { propertyId, username, password, accountNumber, ...rest } = UtilitySchema.parse(req.body);

    // Verify property belongs to user
    const property = await db.property.findFirst({
      where: { id: propertyId, userId: req.dbUserId! },
    });
    if (!property) return res.status(403).json({ error: 'Property not found' });

    const account = await db.utilityAccount.create({
      data: {
        propertyId,
        ...rest,
        // Store only last 4 of account number for display
        accountNumber: accountNumber ? `****${accountNumber.slice(-4)}` : null,
        accountNumberEnc: encryptOptional(accountNumber),
        usernameEnc: encryptOptional(username),
        passwordEnc: encryptOptional(password),
      },
    });

    // Queue initial scrape
    await scrapeQueue.add('scrape', { utilityAccountId: account.id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 120000 },
    });

    res.status(201).json(account);
  } catch (err) {
    next(err);
  }
});

// GET /api/utilities/:id — single utility account detail
router.get('/:id', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      include: {
        property: { select: { id: true, address: true, nickname: true, city: true, state: true } },
        statements: { orderBy: { statementDate: 'desc' }, take: 24 },
        payments: { orderBy: { paymentDate: 'desc' }, take: 200 },
      },
    });
    if (!account) return res.status(404).json({ error: 'Not found' });
    const { accountNumberEnc, usernameEnc, passwordEnc, ...rest } = account;
    res.json(rest);
  } catch (err) { next(err); }
});

// POST /api/utilities/:id/sync — trigger manual scrape
router.post('/:id/sync', async (req, res, next) => {
  try {
    const account = await db.utilityAccount.findFirst({
      where: {
        id: req.params.id,
        property: { userId: req.dbUserId! },
      },
    });
    if (!account) return res.status(404).json({ error: 'Utility account not found' });

    const job = await scrapeQueue.add('scrape', { utilityAccountId: account.id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 120000 },
    });

    res.json({ jobId: job.id, message: 'Sync queued' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/utilities/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { username, password, accountNumber, ...rest } = UtilitySchema.partial().parse(req.body);

    const existing = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!existing) return res.status(404).json({ error: 'Utility account not found' });

    const updated = await db.utilityAccount.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(accountNumber !== undefined && {
          accountNumber: `****${accountNumber.slice(-4)}`,
          accountNumberEnc: encryptOptional(accountNumber),
        }),
        ...(username !== undefined && { usernameEnc: encryptOptional(username) }),
        ...(password !== undefined && { passwordEnc: encryptOptional(password) }),
      },
    });

    const { accountNumberEnc, usernameEnc, passwordEnc, ...sanitized } = updated;
    res.json(sanitized);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/utilities/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.utilityAccount.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    await db.utilityAccount.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
