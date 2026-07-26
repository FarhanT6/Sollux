import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/bank-accounts
router.get('/', async (req, res, next) => {
  try {
    const accounts = await db.bankAccount.findMany({
      where: { userId: req.dbUserId!, isActive: true },
      include: {
        balances: {
          orderBy: { asOfDate: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(accounts);
  } catch (err) { next(err); }
});

// POST /api/bank-accounts
router.post('/', async (req, res, next) => {
  try {
    const { name, last4, bank, accountType, sortOrder, notes } = req.body;
    const account = await db.bankAccount.create({
      data: { userId: req.dbUserId!, name, last4, bank, accountType, sortOrder: sortOrder ?? 0, notes },
    });
    res.status(201).json(account);
  } catch (err) { next(err); }
});

// PATCH /api/bank-accounts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    const { name, last4, bank, accountType, isActive, sortOrder, notes } = req.body;
    const updated = await db.bankAccount.update({
      where: { id: acct.id },
      data: { name, last4, bank, accountType, isActive, sortOrder, notes },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/bank-accounts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    await db.bankAccount.delete({ where: { id: acct.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/bank-accounts/:id/balance  — record a balance snapshot
router.post('/:id/balance', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    const { balance, creditLimit, asOfDate, notes } = req.body;
    // Always truncate to midnight UTC — one snapshot per account per day
    const dateKey = asOfDate ? new Date(asOfDate) : new Date();
    dateKey.setUTCHours(0, 0, 0, 0);
    const snapshot = await db.bankBalance.upsert({
      where: { bankAccountId_asOfDate: { bankAccountId: acct.id, asOfDate: dateKey } },
      update: { balance, creditLimit: creditLimit ?? null, notes, source: 'manual' },
      create: {
        bankAccountId: acct.id,
        balance,
        creditLimit:   creditLimit ?? null,
        asOfDate:      dateKey,
        source:        'manual',
        notes,
      },
    });
    res.status(201).json(snapshot);
  } catch (err) { next(err); }
});

// GET /api/bank-accounts/:id/balances — history
router.get('/:id/balances', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    const balances = await db.bankBalance.findMany({
      where: { bankAccountId: acct.id },
      orderBy: { asOfDate: 'desc' },
      take: 90,
    });
    res.json(balances);
  } catch (err) { next(err); }
});

export default router;
