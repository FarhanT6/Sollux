import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const UnitSchema = z.object({
  propertyId: z.string(),
  unitLabel: z.string().min(1),
  bedrooms: z.number().optional(),
  bathrooms: z.number().optional(),
  sqft: z.number().int().optional(),
  notes: z.string().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const units = await db.unit.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: { leases: { where: { status: 'ACTIVE' }, include: { leaseTenants: { include: { tenant: true } } } } },
      orderBy: [{ propertyId: 'asc' }, { unitLabel: 'asc' }],
    });
    res.json(units);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = UnitSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const unit = await db.unit.create({ data });
    res.status(201).json(unit);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = UnitSchema.partial().parse(req.body);
    const existing = await db.unit.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Unit not found' });
    const unit = await db.unit.update({ where: { id: req.params.id }, data });
    res.json(unit);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.unit.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Unit not found' });
    await db.unit.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
