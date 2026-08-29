import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/payments?propertyId=xxx&utilityAccountId=xxx
router.get('/', async (req, res, next) => {
  try {
    const { propertyId, utilityAccountId } = req.query;
    const where: any = {};

    if (utilityAccountId) {
      const account = await db.utilityAccount.findFirst({
        where: { id: String(utilityAccountId), property: { userId: req.dbUserId! } },
      });
      if (!account) return res.status(404).json({ error: 'Not found' });
      where.utilityAccountId = String(utilityAccountId);
    } else if (propertyId) {
      const property = await db.property.findFirst({
        where: { id: String(propertyId), userId: req.dbUserId! },
      });
      if (!property) return res.status(404).json({ error: 'Not found' });
      where.utilityAccount = { propertyId: String(propertyId) };
    } else {
      const userProperties = await db.property.findMany({
        where: { userId: req.dbUserId! },
        select: { id: true },
      });
      where.utilityAccount = { propertyId: { in: userProperties.map(p => p.id) } };
    }

    const payments = await db.payment.findMany({
      where,
      orderBy: { paymentDate: 'desc' },
      take: 200,
      include: {
        utilityAccount: {
          select: {
            propertyId: true,
            providerName: true,
            category: true,
            property: { select: { id: true, address: true, nickname: true } },
          },
        },
        statement: { select: { statementDate: true, amountDue: true, dueDate: true } },
        bankAccount: { select: { id: true, name: true, bank: true, last4: true } },
      },
    });

    res.json(payments);
  } catch (err) {
    next(err);
  }
});

const PaymentSchema = z.object({
  utilityAccountId: z.string(),
  statementId: z.string().optional().nullable(),
  amount: z.number().positive(),
  // Accepts a plain date ("2026-08-17") as well as a full ISO timestamp — the
  // old .datetime() rule rejected what a <input type="date"> sends.
  paymentDate: z.string(),
  confirmationNumber: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  // PENDING covers a payment that is scheduled or in flight; it is money
  // committed but not yet out of the account.
  status: z.enum(['PAID', 'PENDING', 'FAILED', 'PARTIAL']).default('PAID'),
  bankAccountId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/**
 * Keep Statement.amountPaid in step with the payments recorded against it.
 * A statement is "paid" because payments exist, so that column is derived from
 * them rather than maintained by hand in two places. FAILED payments don't
 * count; PENDING ones don't either, since the money hasn't moved.
 *
 * Note this overrides an amountPaid that came from a scraper or PDF import
 * once you log a payment against that statement — the payment record is the
 * more specific claim.
 */
async function syncStatementPaid(statementId: string | null | undefined) {
  if (!statementId) return;
  const agg = await db.payment.aggregate({
    where: { statementId, status: { in: ['PAID', 'PARTIAL'] } },
    _sum: { amount: true },
  });
  const total = agg._sum.amount;
  await db.statement.update({
    where: { id: statementId },
    data: { amountPaid: total ?? null },
  });
}

// Ownership check shared by every write path.
async function ownAccount(userId: string, utilityAccountId: string) {
  return db.utilityAccount.findFirst({
    where: { id: utilityAccountId, property: { userId } }, select: { id: true },
  });
}

// POST /api/payments — record a payment against a utility account, optionally
// against one specific statement.
router.post('/', async (req, res, next) => {
  try {
    const data = PaymentSchema.parse(req.body);

    const account = await ownAccount(req.dbUserId!, data.utilityAccountId);
    if (!account) return res.status(404).json({ error: 'Utility account not found' });

    // A statement can only be paid through its own account.
    if (data.statementId) {
      const stmt = await db.statement.findFirst({
        where: { id: data.statementId, utilityAccountId: data.utilityAccountId },
        select: { id: true },
      });
      if (!stmt) return res.status(404).json({ error: 'Statement not found on this account' });
    }
    if (data.bankAccountId) {
      const bank = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!bank) return res.status(404).json({ error: 'Bank account not found' });
    }

    const payment = await db.payment.create({
      data: { ...data, paymentDate: new Date(data.paymentDate) },
      include: { bankAccount: { select: { id: true, name: true, bank: true, last4: true } } },
    });
    await syncStatementPaid(data.statementId);

    res.status(201).json(payment);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/payments/:id — correct a recorded payment, or mark a pending one paid.
router.patch('/:id', async (req, res, next) => {
  try {
    const data = PaymentSchema.partial().parse(req.body);
    const existing = await db.payment.findFirst({
      where: { id: req.params.id, utilityAccount: { property: { userId: req.dbUserId! } } },
    });
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    if (data.utilityAccountId && data.utilityAccountId !== existing.utilityAccountId) {
      const account = await ownAccount(req.dbUserId!, data.utilityAccountId);
      if (!account) return res.status(404).json({ error: 'Utility account not found' });
    }
    if (data.bankAccountId) {
      const bank = await db.bankAccount.findFirst({ where: { id: data.bankAccountId, userId: req.dbUserId! } });
      if (!bank) return res.status(404).json({ error: 'Bank account not found' });
    }
    const utilityAccountId = data.utilityAccountId ?? existing.utilityAccountId;
    if (data.statementId) {
      const stmt = await db.statement.findFirst({
        where: { id: data.statementId, utilityAccountId }, select: { id: true },
      });
      if (!stmt) return res.status(404).json({ error: 'Statement not found on this account' });
    }

    const payment = await db.payment.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(data.paymentDate ? { paymentDate: new Date(data.paymentDate) } : {}),
      },
      include: { bankAccount: { select: { id: true, name: true, bank: true, last4: true } } },
    });

    // Both statements need recomputing when a payment moves between them.
    await syncStatementPaid(existing.statementId);
    if (data.statementId !== undefined && data.statementId !== existing.statementId) {
      await syncStatementPaid(data.statementId);
    }

    res.json(payment);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.payment.findFirst({
      where: { id: req.params.id, utilityAccount: { property: { userId: req.dbUserId! } } },
    });
    if (!existing) return res.status(404).json({ error: 'Payment not found' });
    await db.payment.delete({ where: { id: existing.id } });
    // Removing the last payment leaves the statement unpaid again.
    await syncStatementPaid(existing.statementId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
