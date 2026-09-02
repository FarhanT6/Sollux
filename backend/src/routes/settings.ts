import { Router } from 'express';
import { db } from '../config/db';
import { attachDbUser } from '../middleware/requireAuth';

/**
 * Account-level preferences.
 *
 * Currently: what counts towards operating cost. Held per account rather than
 * in the browser because it changes reported figures rather than just how one
 * screen renders, and it has to agree wherever those figures are computed.
 */
const router = Router();
router.use(attachDbUser);

const SELECT = {
  includePenaltiesInOperating: true,
  includePaymentPlanInOperating: true,
} as const;

router.get('/', async (req, res, next) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.dbUserId! }, select: SELECT });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    const { includePenaltiesInOperating, includePaymentPlanInOperating } = req.body ?? {};
    const updated = await db.user.update({
      where: { id: req.dbUserId! },
      data: {
        ...(typeof includePenaltiesInOperating === 'boolean' && { includePenaltiesInOperating }),
        ...(typeof includePaymentPlanInOperating === 'boolean' && { includePaymentPlanInOperating }),
      },
      select: SELECT,
    });
    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
