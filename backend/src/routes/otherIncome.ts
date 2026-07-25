import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

// GET /api/other-income?year=2026&month=7
router.get('/', async (req, res, next) => {
  try {
    const { year, month } = req.query as { year?: string; month?: string };
    let dateFilter = {};
    if (year && month) {
      const y = parseInt(year), m = parseInt(month);
      const start = new Date(y, m - 1, 1);
      const end   = new Date(y, m, 0, 23, 59, 59);
      dateFilter = { receivedDate: { gte: start, lte: end } };
    }
    const records = await db.otherIncome.findMany({
      where: { userId: req.dbUserId!, ...dateFilter },
      orderBy: { receivedDate: 'desc' },
    });
    res.json(records);
  } catch (err) { next(err); }
});

// POST /api/other-income
router.post('/', async (req, res, next) => {
  try {
    const { category, description, amount, receivedDate, method, isRecurring, notes } = req.body;
    const record = await db.otherIncome.create({
      data: {
        userId: req.dbUserId!,
        category,
        description,
        amount,
        receivedDate: new Date(receivedDate),
        method,
        isRecurring: isRecurring ?? false,
        notes,
      },
    });
    res.status(201).json(record);
  } catch (err) { next(err); }
});

// PATCH /api/other-income/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const rec = await db.otherIncome.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    const { category, description, amount, receivedDate, method, isRecurring, notes } = req.body;
    const updated = await db.otherIncome.update({
      where: { id: rec.id },
      data: {
        category,
        description,
        amount,
        receivedDate: receivedDate ? new Date(receivedDate) : undefined,
        method,
        isRecurring,
        notes,
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/other-income/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const rec = await db.otherIncome.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!rec) return res.status(404).json({ error: 'Not found' });
    await db.otherIncome.delete({ where: { id: rec.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
