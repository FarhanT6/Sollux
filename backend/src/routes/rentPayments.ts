import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';
import { recordRentPayment, repriceRentPayment } from '../services/rentPaymentService';
import { CREDIT_REASONS, CREDIT_REASON, type CreditReason } from '../lib/rentCredits';

const router = Router();
router.use(attachDbUser);

const RentPaymentSchema = z.object({
  leaseId: z.string(),
  periodDate: z.string().transform(s => new Date(s)),
  amount: z.number().positive(),
  // Omit to let the server split the payment: this period's rent first, then
  // any excess against the outstanding balance. Pass a number to override.
  appliedToArrears: z.number().optional(),
  paidDate: z.string().transform(s => new Date(s)),
  method: z.enum([
    'CASH','CHECK','ZELLE','ACH','MONEY_ORDER','CARD',
    'VENMO','PAYPAL','CASH_APP','APPLE_CASH','BANK_DEPOSIT','SECTION_8','RENTAL_ASSISTANCE','CREDIT','OTHER',
  ]).default('OTHER'),
  // A credit toward rent (method CREDIT): what it was for, and whether to record the
  // property expense the tenant paid (on by default for repairs, materials, bills).
  creditFor: z.enum(CREDIT_REASONS).optional().nullable(),
  recordExpense: z.boolean().optional(),
  // PENDING = approved/committed but not yet disbursed. Assistance programs
  // routinely sit here for weeks.
  status: z.enum(['PENDING','RECEIVED']).default('RECEIVED'),
  expectedDate: z.union([z.string(), z.null()])
    .transform(v => (v == null || v === '' ? null : new Date(v))).optional(),
  // Which of the owner's accounts received it. Required in practice for
  // BANK_DEPOSIT, optional for anything else.
  bankAccountId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  // Where this payment goes first: this month's rent, or the balance owed
  // from earlier months. null = the tenant's setting. HISTORY: kept as a
  // record only — the back-rent balance is not touched, now or at month end.
  applyTo: z.enum(['CURRENT', 'ARREARS', 'HISTORY']).optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { leaseId, propertyId } = req.query;
    const payments = await db.rentPayment.findMany({
      where: {
        lease: {
          unit: { property: { userId: req.dbUserId! } },
          ...(leaseId ? { id: leaseId as string } : {}),
          ...(propertyId ? { unit: { propertyId: propertyId as string } } : {}),
        },
      },
      include: {
        lease: { include: { unit: { include: { property: { select: { id: true, address: true, nickname: true } } } } } },
        bankAccount: { select: { id: true, name: true, bank: true, last4: true, accountType: true, ownerLabel: true, cardNetwork: true } },
      },
      orderBy: { paidDate: 'desc' },
    });
    res.json(payments);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = RentPaymentSchema.parse(req.body);
    const lease = await db.lease.findFirst({ where: { id: data.leaseId, unit: { property: { userId: req.dbUserId! } } } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });

    // Never take a bank account id on trust — it would let one account attach
    // a payment to another account's bank record.
    if (data.bankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }
    // A credit: no money received. What it was for decides whether it is income and
    // whether the tenant paid a property cost, recorded as that property's expense.
    let credit: { creditFor: string; expenseId: string | null; notIncome: boolean } | null = null;
    if (data.method === 'CREDIT') {
      if (!data.creditFor) return res.status(400).json({ error: 'Say what the credit was for.' });
      if (!data.notes?.trim()) return res.status(400).json({ error: 'Describe what the credit was for (e.g. "replaced the water heater").' });
      const reason = CREDIT_REASON[data.creditFor as CreditReason];
      let expenseId: string | null = null;
      if (reason.expense && data.recordExpense !== false) {
        const full = await db.lease.findUnique({ where: { id: lease.id }, select: { unit: { select: { propertyId: true, unitLabel: true } }, leaseTenants: { select: { tenant: { select: { fullName: true } } }, take: 1 } } });
        const who = full?.leaseTenants[0]?.tenant.fullName ?? 'the tenant';
        const expense = await db.expense.create({
          data: {
            userId: req.dbUserId!, propertyId: full!.unit.propertyId, category: reason.expense, amount: data.amount, date: data.paidDate,
            vendor: `Paid by tenant (${who})`, description: `${data.notes.trim()} — paid by ${who}${full?.unit.unitLabel ? `, ${full.unit.unitLabel}` : ''}, credited against rent`,
          },
        });
        expenseId = expense.id;
      }
      credit = { creditFor: data.creditFor, expenseId, notIncome: !reason.income };
    }
    const payment = await recordRentPayment({
      ...(credit ?? {}),
      leaseId: data.leaseId,
      periodDate: data.periodDate,
      amount: data.amount,
      paidDate: data.paidDate,
      method: data.method,
      // A credit settles rent now; there is no money to wait for.
      status: data.method === 'CREDIT' ? 'RECEIVED' : data.status,
      expectedDate: data.expectedDate,
      bankAccountId: data.bankAccountId,
      notes: data.notes,
      appliedToArrears: data.appliedToArrears,
      applyTo: data.applyTo ?? null,
    });
    res.status(201).json(payment);
  } catch (err) { next(err); }
});

// PATCH /:id — correct a logged payment, or mark pending money received.
// Any change to amount, period or status changes how much of it should pay down
// arrears, so the balance is re-derived rather than left as it was.
router.patch('/:id', async (req, res, next) => {
  try {
    const data = RentPaymentSchema.partial().parse(req.body);
    const existing = await db.rentPayment.findFirst({
      where: { id: req.params.id, lease: { unit: { property: { userId: req.dbUserId! } } } },
    });
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    // Moving a payment to another lease is only allowed onto a lease the
    // requester owns.
    if (data.leaseId && data.leaseId !== existing.leaseId) {
      const lease = await db.lease.findFirst({
        where: { id: data.leaseId, unit: { property: { userId: req.dbUserId! } } },
      });
      if (!lease) return res.status(404).json({ error: 'Lease not found' });
    }
    if (data.bankAccountId) {
      const acct = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!acct) return res.status(404).json({ error: 'Bank account not found' });
    }

    const leaseId = data.leaseId ?? existing.leaseId;
    const periodDate = data.periodDate ?? existing.periodDate;
    const amount = data.amount ?? Number(existing.amount);
    const status = data.status ?? (existing.status as 'PENDING' | 'RECEIVED');

    const split = await repriceRentPayment(existing.id, {
      leaseId, periodDate, amount, status, appliedToArrears: data.appliedToArrears, applyTo: data.applyTo,
    });

    // Money that just arrived should carry a real receipt date, not the date it
    // was first expected.
    const paidDate = data.paidDate
      ?? (existing.status === 'PENDING' && status === 'RECEIVED' ? new Date() : existing.paidDate);

    const payment = await db.rentPayment.update({
      where: { id: existing.id },
      data: {
        leaseId, periodDate, amount, status, paidDate, appliedToArrears: split.toArrears, settledRolledRent: split.settledRolled,
        ...(data.method !== undefined ? { method: data.method } : {}),
        ...(data.expectedDate !== undefined ? { expectedDate: data.expectedDate } : {}),
        ...(data.bankAccountId !== undefined ? { bankAccountId: data.bankAccountId } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.applyTo !== undefined ? { applyTo: data.applyTo } : {}),
        ...(data.creditFor !== undefined && existing.method === 'CREDIT' ? { creditFor: data.creditFor, notIncome: data.creditFor ? !CREDIT_REASON[data.creditFor as CreditReason].income : existing.notIncome } : {}),
      },
      include: { bankAccount: { select: { id: true, name: true, bank: true, last4: true, accountType: true, ownerLabel: true, cardNetwork: true } } },
    });
    // The expense recorded with a credit follows its amount and date.
    if (existing.expenseId && (amount !== Number(existing.amount) || data.paidDate)) {
      await db.expense.updateMany({ where: { id: existing.expenseId, userId: req.dbUserId! }, data: { amount, ...(data.paidDate ? { date: data.paidDate } : {}) } });
    }
    res.json(payment);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.rentPayment.findFirst({
      where: { id: req.params.id, lease: { unit: { property: { userId: req.dbUserId! } } } },
    });
    if (!existing) return res.status(404).json({ error: 'Payment not found' });
    await db.rentPayment.delete({ where: { id: req.params.id } });
    // A credit's property expense goes with it.
    if (existing.expenseId) await db.expense.deleteMany({ where: { id: existing.expenseId, userId: req.dbUserId! } });
    // Put back whatever this payment knocked off the balance, or deleting a
    // mistaken payment would permanently understate what the tenant owes.
    const restored = Number(existing.appliedToArrears) + Number(existing.settledRolledRent);
    if (restored > 0) {
      await db.lease.update({
        where: { id: existing.leaseId },
        data: { arrearsBalance: { increment: restored } },
      });
    }

    // If a bank transaction created this payment, send it back to the review
    // queue, unmatched. Otherwise deleting a wrongly auto-logged payment would
    // strand the transaction as APPLIED, pointing at a payment that no longer
    // exists. Unmatched, not Suggested: Sync now applies Suggested rows it is
    // sure of, and would log a deleted duplicate straight back.
    await db.incomingTransaction.updateMany({
      where: { rentPaymentId: existing.id },
      data: { status: 'UNMATCHED', matchedLeaseId: null, rentPaymentId: null },
    });

    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
