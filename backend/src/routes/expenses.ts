import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const ExpenseSchema = z.object({
  propertyId: z.string(),
  category: z.enum(['UTILITIES','REPAIRS_MAINTENANCE','LANDSCAPING','PROPERTY_MANAGEMENT','LEGAL','INSURANCE','PROPERTY_TAX','HOA','MORTGAGE_DEBT_SERVICE','CAPITAL_IMPROVEMENT','SUPPLIES','TRAVEL','ADVERTISING','OTHER']),
  amount: z.number().positive(),
  date: z.string().transform(s => new Date(s)),
  vendor: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isCapEx: z.boolean().default(false),
  isPersonal: z.boolean().default(false),
  documentUrl: z.string().optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isCapEx, isPersonal, category } = req.query;
    const expenses = await db.expense.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(isCapEx !== undefined ? { isCapEx: isCapEx === 'true' } : {}),
        ...(isPersonal !== undefined ? { isPersonal: isPersonal === 'true' } : {}),
        ...(category ? { category: category as any } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { date: 'desc' },
    });
    res.json(expenses);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = ExpenseSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const expense = await db.expense.create({ data });
    res.status(201).json(expense);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = ExpenseSchema.partial().parse(req.body);
    const existing = await db.expense.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    const expense = await db.expense.update({ where: { id: req.params.id }, data });
    res.json(expense);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.expense.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    await db.expense.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
