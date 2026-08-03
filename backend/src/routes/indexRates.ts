import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

const router = Router();
router.use(attachDbUser);

const IndexRateSchema = z.object({
  indexName: z.string().min(1).default('PRIME'),
  rate: z.number(),
  effectiveDate: z.string().transform(s => new Date(s)),
  notes: z.string().optional().nullable(),
});

// GET /api/index-rates?indexName=PRIME — history, most recent first
router.get('/', async (req, res, next) => {
  try {
    const { indexName } = req.query;
    const rates = await db.indexRate.findMany({
      where: { userId: req.dbUserId!, ...(indexName ? { indexName: indexName as string } : {}) },
      orderBy: { effectiveDate: 'desc' },
    });
    res.json(rates);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const data = IndexRateSchema.parse(req.body);
    const rate = await db.indexRate.create({ data: { ...data, userId: req.dbUserId! } });
    res.status(201).json(rate);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db.indexRate.findFirst({ where: { id: req.params.id, userId: req.dbUserId! } });
    if (!existing) return res.status(404).json({ error: 'Rate entry not found' });
    await db.indexRate.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
