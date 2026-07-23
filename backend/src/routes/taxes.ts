import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const TaxSchema = z.object({
  propertyId: z.string(),
  taxYear: z.string().min(1),
  assessedValue: z.number().optional().nullable(),
  annualTaxAmount: z.number().positive(),
  installment1Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Due: z.string().transform(s => new Date(s)).optional().nullable(),
  installment1Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  installment2Paid: z.string().transform(s => new Date(s)).optional().nullable(),
  status: z.enum(['UNPAID','PAID','PARTIALLY_PAID','DELINQUENT']).default('UNPAID'),
  notes: z.string().optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const taxes = await db.taxAssessment.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: [{ taxYear: 'desc' }],
    });
    res.json(taxes);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = TaxSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const tax = await db.taxAssessment.create({ data });
    res.status(201).json(tax);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = TaxSchema.partial().parse(req.body);
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    const tax = await db.taxAssessment.update({ where: { id: req.params.id }, data });
    res.json(tax);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.taxAssessment.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Tax assessment not found' });
    await db.taxAssessment.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
