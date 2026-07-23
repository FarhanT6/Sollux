import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const PolicySchema = z.object({
  propertyId: z.string(),
  carrier: z.string().min(1),
  policyNumber: z.string().optional().nullable(),
  policyType: z.enum(['PROPERTY','LIABILITY','FLOOD','UMBRELLA','OTHER']).default('PROPERTY'),
  premiumAmount: z.number().positive(),
  premiumFrequency: z.enum(['MONTHLY','ANNUAL','SEMI_ANNUAL']).default('ANNUAL'),
  effectiveDate: z.string().transform(s => new Date(s)).optional().nullable(),
  expirationDate: z.string().transform(s => new Date(s)).optional().nullable(),
  documentUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isPersonal: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, isPersonal, isActive } = req.query;
    const policies = await db.insurancePolicy.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
        ...(isPersonal !== undefined ? { isPersonal: isPersonal === 'true' } : {}),
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { carrier: 'asc' },
    });
    res.json(policies);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = PolicySchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const policy = await db.insurancePolicy.create({ data });
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = PolicySchema.partial().parse(req.body);
    const existing = await db.insurancePolicy.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Policy not found' });
    const policy = await db.insurancePolicy.update({ where: { id: req.params.id }, data });
    res.json(policy);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.insurancePolicy.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Policy not found' });
    await db.insurancePolicy.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
