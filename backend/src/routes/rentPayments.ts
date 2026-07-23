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
  appliedToArrears: z.number().default(0),
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
    const payment = await db.rentPayment.create({ data });
    // Reduce arrearsBalance by appliedToArrears
    if (data.appliedToArrears > 0) {
      await db.lease.update({
        where: { id: data.leaseId },
        data: { arrearsBalance: { decrement: data.appliedToArrears } },
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
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
