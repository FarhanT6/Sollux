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

// Unit labels are entered by hand ("2", "10", "Unit 488.5", "Main House"), so
// plain string sorting puts 10 before 2. Compare leading numbers numerically
// and fall back to text, which keeps a numbered building in the order a person
// would walk it.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

router.get('/', async (req, res, next) => {
  try {
    const { propertyId, history } = req.query;
    const units = await db.unit.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: history === 'true'
        // Every tenancy the unit has ever had, newest first — the occupancy
        // history. Without this the list only ever knows who is there now.
        ? {
            property: { select: { id: true, address: true, nickname: true } },
            leases: {
              include: {
                leaseTenants: { include: { tenant: true } },
                rentPayments: { where: { status: 'RECEIVED' }, select: { amount: true } },
              },
              orderBy: { startDate: 'desc' },
            },
          }
        : { leases: { where: { status: 'ACTIVE' }, include: { leaseTenants: { include: { tenant: true } } } } },
      orderBy: [{ propertyId: 'asc' }],
    });
    units.sort((a, b) => collator.compare(a.unitLabel, b.unitLabel));
    res.json(units);
  } catch (err) { next(err); }
});

// GET /api/units/:id — one unit with its full occupancy history.
router.get('/:id', async (req, res, next) => {
  try {
    const unit = await db.unit.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      include: {
        property: { select: { id: true, address: true, nickname: true } },
        leases: {
          include: {
            leaseTenants: { include: { tenant: true } },
            rentPayments: { orderBy: { paidDate: 'desc' } },
          },
          orderBy: { startDate: 'desc' },
        },
      },
    });
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    res.json(unit);
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
    const existing = await db.unit.findFirst({
      where: { id: req.params.id, property: { userId: req.dbUserId! } },
      include: { _count: { select: { leases: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Unit not found' });
    await db.unit.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
