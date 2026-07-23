import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const ImprovementSchema = z.object({
  propertyId: z.string(),
  description: z.string().min(1),
  category: z.string().optional().nullable(),
  cost: z.number().positive(),
  contractor: z.string().optional().nullable(),
  startDate: z.string().transform(s => new Date(s)).optional().nullable(),
  completionDate: z.string().transform(s => new Date(s)).optional().nullable(),
  documentUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const { propertyId } = req.query;
    const improvements = await db.improvement.findMany({
      where: {
        property: { userId: req.dbUserId! },
        ...(propertyId ? { propertyId: propertyId as string } : {}),
      },
      include: { property: { select: { id: true, address: true, nickname: true } } },
      orderBy: { completionDate: 'desc' },
    });
    res.json(improvements);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = ImprovementSchema.parse(req.body);
    const property = await db.property.findFirst({ where: { id: data.propertyId, userId: req.dbUserId! } });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const improvement = await db.improvement.create({ data });
    res.status(201).json(improvement);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const data = ImprovementSchema.partial().parse(req.body);
    const existing = await db.improvement.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Improvement not found' });
    const improvement = await db.improvement.update({ where: { id: req.params.id }, data });
    res.json(improvement);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.improvement.findFirst({ where: { id: req.params.id, property: { userId: req.dbUserId! } } });
    if (!existing) return res.status(404).json({ error: 'Improvement not found' });
    await db.improvement.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
