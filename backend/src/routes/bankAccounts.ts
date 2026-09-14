import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();
router.use(attachDbUser);

function toNum(d: Decimal | null | undefined): number {
  return d ? parseFloat(d.toString()) : 0;
}

function serialize(a: any) {
  const latest = a.balances?.[0];
  return {
    id: a.id,
    name: a.name,
    last4: a.last4,
    bank: a.bank,
    ownerLabel: a.ownerLabel,
    cardNetwork: a.cardNetwork,
    cardExpiry: a.cardExpiry,
    accountType: a.accountType,
    isActive: a.isActive,
    sortOrder: a.sortOrder,
    notes: a.notes,
    watchForRentPayments: a.watchForRentPayments,
    watchForExpenses: a.watchForExpenses,
    plaidAccountId: a.plaidAccountId,
    balance: toNum(latest?.balance),
    available: latest?.available != null ? toNum(latest.available) : undefined,
    creditLimit: latest?.creditLimit != null ? toNum(latest.creditLimit) : undefined,
    asOfDate: latest?.asOfDate ?? undefined,
  };
}

function serializePending(p: any) {
  return {
    id: p.id,
    bankAccountId: p.bankAccountId,
    amount: toNum(p.amount),
    description: p.description,
    kind: p.kind,
    expectedDate: p.expectedDate ?? null,
    loanId: p.loanId ?? null,
    loan: p.loan ? { id: p.loan.id, lender: p.loan.lender } : undefined,
    cleared: p.cleared,
    clearedAt: p.clearedAt ?? null,
    notes: p.notes ?? null,
    createdAt: p.createdAt,
  };
}

const PENDING_KINDS = ['CHECK', 'SCHEDULED', 'TRANSFER', 'CARD', 'OTHER'] as const;

// ── Pending outflows ────────────────────────────────────────────────────────
// Money already committed from an account that the bank has not taken yet —
// a check in the mail, a payment scheduled on a lender's site. The bank's
// balance still shows it; the pay planner subtracts it.

// GET /api/bank-accounts/pending — every uncleared outflow (cleared=1 for all)
router.get('/pending', async (req, res, next) => {
  try {
    const includeCleared = req.query.cleared === '1';
    const rows = await db.pendingOutflow.findMany({
      where: { userId: req.dbUserId!, ...(includeCleared ? {} : { cleared: false }) },
      include: { loan: { select: { id: true, lender: true } } },
      orderBy: [{ cleared: 'asc' }, { expectedDate: 'asc' }, { createdAt: 'desc' }],
      take: includeCleared ? 200 : undefined,
    });
    res.json(rows.map(serializePending));
  } catch (err) { next(err); }
});

// POST /api/bank-accounts/:id/pending — record money committed from this account
router.post('/:id/pending', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    const { amount, description, kind, expectedDate, loanId, notes } = req.body;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
    if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });
    if (loanId) {
      const loan = await db.loan.findFirst({ where: { id: loanId, userId: req.dbUserId! } });
      if (!loan) return res.status(404).json({ error: 'Loan not found' });
    }
    const row = await db.pendingOutflow.create({
      data: {
        userId: req.dbUserId!,
        bankAccountId: acct.id,
        amount: amt,
        description: String(description).trim(),
        kind: PENDING_KINDS.includes(kind) ? kind : 'OTHER',
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        loanId: loanId || null,
        notes: notes || null,
      },
      include: { loan: { select: { id: true, lender: true } } },
    });
    res.status(201).json(serializePending(row));
  } catch (err) { next(err); }
});

// PATCH /api/bank-accounts/pending/:pid — edit, or mark cleared / uncleared
router.patch('/pending/:pid', async (req, res, next) => {
  try {
    const existing = await db.pendingOutflow.findFirst({ where: { id: req.params.pid, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { amount, description, kind, expectedDate, cleared, notes, bankAccountId } = req.body;
    if (bankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: bankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    const row = await db.pendingOutflow.update({
      where: { id: existing.id },
      data: {
        ...(amount !== undefined ? { amount: Number(amount) } : {}),
        ...(description !== undefined ? { description: String(description).trim() } : {}),
        ...(kind !== undefined ? { kind: PENDING_KINDS.includes(kind) ? kind : 'OTHER' } : {}),
        ...(expectedDate !== undefined ? { expectedDate: expectedDate ? new Date(expectedDate) : null } : {}),
        ...(notes !== undefined ? { notes: notes || null } : {}),
        ...(bankAccountId ? { bankAccountId } : {}),
        ...(cleared !== undefined ? { cleared: !!cleared, clearedAt: cleared ? new Date() : null } : {}),
      },
      include: { loan: { select: { id: true, lender: true } } },
    });
    res.json(serializePending(row));
  } catch (err) { next(err); }
});

// DELETE /api/bank-accounts/pending/:pid
router.delete('/pending/:pid', async (req, res, next) => {
  try {
    const existing = await db.pendingOutflow.findFirst({ where: { id: req.params.pid, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.pendingOutflow.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

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
    res.json(accounts.map(serialize));
  } catch (err) { next(err); }
});

// POST /api/bank-accounts
router.post('/', async (req, res, next) => {
  try {
    const { name, last4, bank, ownerLabel, cardNetwork, cardExpiry, accountType, sortOrder, notes } = req.body;
    const account = await db.bankAccount.create({
      data: { userId: req.dbUserId!, name, last4, bank, ownerLabel, cardNetwork, cardExpiry, accountType, sortOrder: sortOrder ?? 0, notes },
      include: { balances: { orderBy: { asOfDate: 'desc' }, take: 1 } },
    });
    res.status(201).json(serialize(account));
  } catch (err) { next(err); }
});

// PATCH /api/bank-accounts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const acct = await db.bankAccount.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!acct) return res.status(404).json({ error: 'Not found' });
    const { name, last4, bank, ownerLabel, cardNetwork, cardExpiry, accountType, isActive, sortOrder, notes, watchForRentPayments, watchForExpenses } = req.body;
    const updated = await db.bankAccount.update({
      where: { id: acct.id },
      data: { name, last4, bank, ownerLabel, cardNetwork, cardExpiry, accountType, isActive, sortOrder, notes, watchForRentPayments, watchForExpenses },
      include: { balances: { orderBy: { asOfDate: 'desc' }, take: 1 } },
    });
    res.json(serialize(updated));
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
