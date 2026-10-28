/** GET /api/finance/overview?year=&propertyId= — lib/financeOverview.ts. */
import { Router } from 'express';
import { z } from 'zod';
import { attachDbUser } from '../middleware/requireAuth';
import { buildOverview } from '../lib/financeOverview';

const router = Router();
router.use(attachDbUser);

router.get('/overview', async (req, res, next) => {
  try {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100), propertyId: z.string().optional() }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'Give the year.' });
    res.json(await buildOverview(req.dbUserId!, q.data.year, q.data.propertyId));
  } catch (err) { next(err); }
});

export default router;
