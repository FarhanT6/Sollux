import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const ExpenseFields = z.object({
  propertyId: z.string().optional().nullable(),
  category: z.enum(['UTILITIES','REPAIRS_MAINTENANCE','LANDSCAPING','PROPERTY_MANAGEMENT','LEGAL','INSURANCE','PROPERTY_TAX','HOA','MORTGAGE_DEBT_SERVICE','CAPITAL_IMPROVEMENT','SUPPLIES','TRAVEL','ADVERTISING','OTHER']),
  amount: z.number().positive(),
  date: z.string().transform(s => new Date(s)),
  vendor: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isCapEx: z.boolean().default(false),
  isPersonal: z.boolean().default(false),
  documentUrl: z.string().optional().nullable(),
});
const ExpenseSchema = ExpenseFields.refine(data => data.propertyId || data.isPersonal, {
  message: 'propertyId is required unless the expense is marked personal',
  path: ['propertyId'],
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isCapEx, isPersonal, category } = req.query;
    const expenses = await db.expense.findMany({
      where: {
        userId: req.dbUserId!,
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(isCapEx !== undefined ? { isCapEx: isCapEx === 'true' } : {}),
        ...(isPersonal !== undefined ? { isPersonal: isPersonal === 'true' } : {}),
        ...(category ? { category: category as any } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { date: 'desc' },
    });

    // Utility bills are operating expenses too, but they live in the
    // Statement/UtilityAccount tables (scraped/imported), not the Expense
    // table — merge them in read-only so they show up alongside manually
    // logged expenses instead of being invisible to the operating
    // statement. isCapEx/isPersonal/category filters exclude them the same
    // way they'd exclude a real UTILITIES expense row, since that's what
    // they represent.
    const includeUtilities = isCapEx !== 'true' && isPersonal !== 'true' && (!category || category === 'UTILITIES');
    const utilityExpenses = includeUtilities ? await db.statement.findMany({
      where: {
        amountDue: { not: null },
        utilityAccount: {
          property: { userId: req.dbUserId! },
          ...(propertyId ? { propertyId: propertyId as string } : {}),
        },
      },
      include: { utilityAccount: { include: { property: { select: { id: true, address: true, nickname: true } } } } },
      orderBy: { statementDate: 'desc' },
    }) : [];

    const utilityRows = utilityExpenses.map(s => ({
      id: `stmt_${s.id}`,
      propertyId: s.utilityAccount.propertyId,
      utilityAccountId: s.utilityAccountId,
      property: s.utilityAccount.property,
      category: 'UTILITIES' as const,
      amount: s.amountDue,
      date: (s.dueDate ?? s.statementDate).toISOString(),
      vendor: s.utilityAccount.providerName,
      description: `${s.utilityAccount.category} bill`,
      isCapEx: false,
      isPersonal: false,
      documentUrl: s.pdfUrl,
      createdAt: s.createdAt,
      source: 'utility' as const,
      editable: false,
    }));

    const merged = [...expenses.map(e => ({ ...e, source: 'manual' as const, editable: true })), ...utilityRows]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json(merged);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = ExpenseSchema.parse(req.body);
    if (data.propertyId) {
      const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!property) return res.status(404).json({ error: 'Property not found' });
    }
    const expense = await db.expense.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(expense);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = ExpenseFields.partial().parse(req.body);
    const existing = await db.expense.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    if (data.propertyId) {
      const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
      if (!property) return res.status(404).json({ error: 'Property not found' });
    }
    const expense = await db.expense.update({ where: { id: req.params.id }, data });
    res.json(expense);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.expense.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    await db.expense.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
