import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const PropertySchema = z.object({
  nickname: z.string().optional(),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(2).max(2),
  zip: z.string().min(5),
  type: z.enum(['PRIMARY', 'RENTAL', 'INVESTMENT', 'COMMERCIAL']),
});

// GET /api/properties — list all for user
router.get('/', async (req, res, next) => {
  try {
    const properties = await db.property.findMany({
      where: { userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          select: {
            id: true,
            providerName: true,
            category: true,
            lastSyncStatus: true,
            lastSyncedAt: true,
            statements: {
              orderBy: { statementDate: 'desc' },
              take: 1,
              select: { amountDue: true, dueDate: true },
            },
          },
        },
        _count: { select: { insights: { where: { isRead: false } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(properties);
  } catch (err) {
    next(err);
  }
});

// GET /api/properties/:id
router.get('/:id', async (req, res, next) => {
  try {
    const property = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
      include: {
        utilityAccounts: {
          include: {
            statements: { orderBy: { statementDate: 'desc' }, take: 6 },
            payments: { orderBy: { paymentDate: 'desc' }, take: 6 },
          },
        },
        insights: {
          where: { isDismissed: false },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!property) return res.status(404).json({ error: 'Property not found' });
    res.json(property);
  } catch (err) {
    next(err);
  }
});

// POST /api/properties
router.post('/', async (req, res, next) => {
  try {
    const data = PropertySchema.parse(req.body);
    const property = await db.property.create({
      data: { ...data, userId: req.dbUserId! },
    });
    res.status(201).json(property);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/properties/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const data = PropertySchema.partial().parse(req.body);
    const existing = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!existing) return res.status(404).json({ error: 'Property not found' });

    const updated = await db.property.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/properties/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.property.findFirst({
      where: { id: req.params.id, userId: req.dbUserId! },
    });
    if (!existing) return res.status(404).json({ error: 'Property not found' });

    await db.property.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
