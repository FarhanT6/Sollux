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
        statement: { select: { statementDate: true, amountDue: true } },
      },
    });

    res.json(payments);
  } catch (err) {
    next(err);
  }
});

// POST /api/payments — manual payment entry
router.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      utilityAccountId: z.string(),
      statementId: z.string().optional(),
      amount: z.number().positive(),
      paymentDate: z.string().datetime(),
      confirmationNumber: z.string().optional(),
      paymentMethod: z.string().optional(),
      notes: z.string().optional(),
    });

    const data = schema.parse(req.body);

    const account = await db.utilityAccount.findFirst({
      where: { id: data.utilityAccountId, property: { userId: req.dbUserId! } },
    });
    if (!account) return res.status(404).json({ error: 'Utility account not found' });

    const payment = await db.payment.create({
      data: {
        ...data,
        paymentDate: new Date(data.paymentDate),
        status: 'PAID',
      },
    });

    res.status(201).json(payment);
  } catch (err) {
    next(err);
  }
});

export default router;
