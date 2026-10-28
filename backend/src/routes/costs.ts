/**
 * The cost ledger (lib/costLedger.ts): what each property cost, by type and
 * month — charged in the month due, paid in the month the money left.
 */
import { Router } from 'express';
import { z } from 'zod';
import { attachDbUser } from '../middleware/requireAuth';
import { buildLedger } from '../lib/costLedger';

const router = Router();
router.use(attachDbUser);

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

// GET /api/costs?from=YYYY-MM&to=YYYY-MM&propertyId=
router.get('/', async (req, res, next) => {
  try {
    const q = z.object({ from: Month, to: Month, propertyId: z.string().optional() }).parse(req.query);
    if (q.from > q.to) return res.status(400).json({ error: 'The start month is after the end month.' });
    const [fy, fm] = q.from.split('-').map(Number); const [ty, tm] = q.to.split('-').map(Number);
    if ((ty - fy) * 12 + (tm - fm) > 35) return res.status(400).json({ error: 'Choose three years or less.' });
    res.json(await buildLedger(req.dbUserId!, q.from, q.to, q.propertyId));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Give the months as YYYY-MM.' });
    next(err);
  }
});

export default router;
