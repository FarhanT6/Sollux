import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

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
  method: z.enum(['CASH','CHECK','ZELLE','ACH','MONEY_ORDER','CARD','OTHER']).default('OTHER'),
  notes: z.string().optional().nullable(),
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
      include: { lease: { include: { unit: { include: { property: { select: { id: true, address: true, nickname: true } } } } } } },
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
    // Split the payment unless the caller was explicit. A tenant who owes back
    // rent usually pays one lump sum: it covers this period's rent first, and
    // whatever is left pays down the balance. Without this the excess was
    // simply dropped — the month showed as covered but arrears never moved.
    let appliedToArrears = data.appliedToArrears;
    if (appliedToArrears == null) {
      const period = data.periodDate;
      const periodEnd = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1));
      const priorForPeriod = await db.rentPayment.aggregate({
        where: { leaseId: data.leaseId, periodDate: { gte: period, lt: periodEnd } },
        _sum: { amount: true },
      });
      const alreadyPaid = Number(priorForPeriod._sum.amount ?? 0);
      const rentStillDue = Math.max(0, Number(lease.rentAmount) - alreadyPaid);
      const excess = Math.max(0, data.amount - rentStillDue);
      // Never drive the balance negative — an overpayment beyond what is owed
      // is a credit, not something to subtract past zero.
      appliedToArrears = Math.min(excess, Number(lease.arrearsBalance));
    }

    const payment = await db.rentPayment.create({ data: { ...data, appliedToArrears } });
    if (appliedToArrears > 0) {
      await db.lease.update({
        where: { id: data.leaseId },
        data: { arrearsBalance: { decrement: appliedToArrears } },
      });
    }
    res.status(201).json(payment);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.rentPayment.findFirst({
      where: { id: req.params.id, lease: { unit: { property: { userId: req.dbUserId! } } } },
    });
    if (!existing) return res.status(404).json({ error: 'Payment not found' });
    await db.rentPayment.delete({ where: { id: req.params.id } });
    // Put back whatever this payment knocked off the balance, or deleting a
    // mistaken payment would permanently understate what the tenant owes.
    const restored = Number(existing.appliedToArrears);
    if (restored > 0) {
      await db.lease.update({
        where: { id: existing.leaseId },
        data: { arrearsBalance: { increment: restored } },
      });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
